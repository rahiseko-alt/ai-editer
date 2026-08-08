"""出来上がった動画に顔モザイクを焼く（ロードマップ M-4-F / M-4-G）。

    python src/apply_mosaic_cli.py <入力mp4> <出力mp4> [--target 顔画像] [--strength 強め|普通|弱め]

レンダリング済みのクリップを受け取り、顔を隠した動画を書き出す。音声は無変換でコピーする。
`--target` に顔画像を渡すと、その人だけ `--strength` の強さで隠し、他の人は既定の強さになる。

「設定は聞かれたのに出来た動画には掛かっていない」を防ぐための、実際に効く経路。
SKILL.md の手順7（レンダリング）の後に呼ばれる。
"""

import argparse
import math
import os
import subprocess
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from face_mosaic import (  # noqa: E402
    BLOCK_RATIO_DEFAULT,
    DETECT_EVERY_DEFAULT,
    mosaic_frames,
    register_person,
)

# 「強め/普通/弱め」を、顔の高さに対するブロックの比へ対応づける。
# 数字はユーザーに見せない（非エンジニアに 1/5 と言っても伝わらない）。
STRENGTH = {
    "強め": 1.0 / 5.0,
    "普通": BLOCK_RATIO_DEFAULT,
    "弱め": 1.0 / 11.0,
}
CHUNK_FRAMES = 300  # 一度に抱えるコマ数（1080pで約1.8GB を超えないようにする）
# 次のかたまりの先頭を数コマ先読みしてから焼く。
# 先読みが無いと、かたまりの末尾は「次の検出」が存在せず直前の位置を流用することになり、
# (a) 枠が古いまま焼かれる (b) 確認が要るコマとして記録され、確認リストが実際には
# 問題の無いコマで埋まる。実測でも毎かたまり2コマ（1.7%）が機械的に記録されていた。
# 検出間隔ぶん先を読めば、かたまり末尾に「次の検出」が必ず存在する。
# 間隔を変えたときに追随させるため、値を直書きせず導出する。
LOOKAHEAD_FRAMES = max(2, DETECT_EVERY_DEFAULT * 2)


def probe(path):
    """幅・高さ・fps を取る。取れなければ理由の分かる例外にする。"""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate",
         "-of", "default=nw=1", path],
        capture_output=True, text=True,
    ).stdout
    info = dict(line.split("=", 1) for line in out.strip().split("\n") if "=" in line)
    if "width" not in info or "height" not in info:
        raise RuntimeError(f"動画の情報を取得できませんでした: {path}")
    num, den = info.get("r_frame_rate", "30/1").split("/")
    # r_frame_rate は 0/0 になる素材がある。そのまま割ると ZeroDivisionError で
    # トレースバックが客に出るし、0 のまま ffmpeg -r 0 に渡ることにもなる。
    fps = float(num) / float(den) if float(den) else 0.0
    if not math.isfinite(fps) or fps <= 0:
        raise RuntimeError(f"動画のフレームレートを取得できませんでした: {path}")
    return int(info["width"]), int(info["height"]), fps


def run(input_path, output_path, target=None, strength="普通"):
    """入力動画の顔を隠して出力動画に書き出す。"""
    width, height, fps = probe(input_path)
    people = [register_person(target, name="target")] if target else []
    ratio_for = {"target": STRENGTH.get(strength, BLOCK_RATIO_DEFAULT)} if people else None

    # 読み出し側の警告を捨てない。途中で切れた mp4 を渡すと ffmpeg は
    # "partial file" / "Decoding error" を出しながら終了コード0を返すため、
    # 終了コードだけを見ていると「短くなった動画」を成功として書き出してしまう
    # （実測: 4.000秒の入力に対し出力1.867秒／28コマで、素顔は退避され短い動画が納品された）。
    # パイプで受けると埋まって止まりうるので一時ファイルへ落とし、終了後に読む。
    dec_err = tempfile.TemporaryFile()
    dec = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", input_path, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE, stderr=dec_err, bufsize=width * height * 3 * 4,
    )
    enc = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}", "-r", str(fps), "-i", "-",
         # 音声は入力からそのまま持ってきて無変換でコピーする（劣化させない）
         "-i", input_path, "-map", "0:v", "-map", "1:a?", "-c:a", "copy",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
         "-movflags", "+faststart", output_path],
        stdin=subprocess.PIPE,
    )

    size = width * height * 3
    total = 0
    pending = []
    # 追従状態は区切りをまたいで持ち越す（毎回作り直すと境目で保持が切れる）
    tracker = None
    # 読み切ったのか、例外で抜けたのかを区別する。区別しないと、下の後始末で
    # 「正常に読み終えた ffmpeg」まで terminate してしまう（下のコメント参照）。
    reached_eof = False
    try:
        while True:
            buf = dec.stdout.read(size)
            if len(buf) < size:
                reached_eof = True
                break
            # bytearray にすると書き換え可能になり、複製を省いてそのまま焼ける
            pending.append(np.frombuffer(bytearray(buf), np.uint8).reshape(height, width, 3))
            if len(pending) >= CHUNK_FRAMES + LOOKAHEAD_FRAMES:
                # 先読みぶんは次のかたまりでも使うので、焼かれる前に控えておく
                carry = [f.copy() for f in pending[CHUNK_FRAMES : CHUNK_FRAMES + LOOKAHEAD_FRAMES]]
                out, tracker = mosaic_frames(
                    pending[: CHUNK_FRAMES + LOOKAHEAD_FRAMES],
                    people=people, ratio_for=ratio_for, copy_frames=False, tracker=tracker,
                    # 次の呼び出しへ重ねて渡すコマ（先読み）の手前の状態を受け取る。
                    # 最後まで進んだ状態を受け取ると、重なったコマの検出が2回取り込まれ、
                    # 顔を見失った回数が二重に数えられて保持が境目で短くなる。
                    carry_from=CHUNK_FRAMES,
                )
                for frame in out[:CHUNK_FRAMES]:
                    enc.stdin.write(frame.tobytes())
                total += CHUNK_FRAMES
                pending = carry + pending[CHUNK_FRAMES + LOOKAHEAD_FRAMES :]
        if pending:
            total += _flush(pending, enc, people, ratio_for, tracker)
    finally:
        try:
            enc.stdin.close()
        except BrokenPipeError:
            pass  # エンコーダが先に落ちている場合。下の returncode 検査で拾う
        enc.wait()
        if not reached_eof and dec.poll() is None:
            # 読み残しがあると ffmpeg はパイプへの書き込みで止まり wait() が返らない。
            # 例外で途中終了したときに、ここで永久に固まらないよう先に止める。
            #
            # 逆に、読み切った(reached_eof)ときに止めてはいけない。ffmpeg は stdout を
            # 閉じてから終了するまでに僅かな間があり、その隙に poll() が None のまま
            # terminate すると returncode が -15 になる。全コマを正しく焼き終えたのに
            # 下の検査が「入力動画の読み出しに失敗しました」と誤って落とすことになる。
            # 読み切った側は、書き込む先がもう無いので固まらない＝黙って待てばよい。
            dec.terminate()
        dec.stdout.close()
        dec.wait()

    dec_err.seek(0)
    dec_msg = dec_err.read().decode("utf-8", "replace").strip()
    dec_err.close()
    if dec.returncode != 0:
        raise RuntimeError(f"入力動画の読み出しに失敗しました（終了コード {dec.returncode}）: {input_path}")
    if dec_msg:
        # -v error は正常な入力では何も出さない。何か出ている＝読み切れていない。
        raise RuntimeError(f"入力動画を最後まで読み出せませんでした: {input_path}\n{dec_msg[-800:]}")
    if enc.returncode != 0:
        raise RuntimeError(f"出力動画の書き出しに失敗しました（終了コード {enc.returncode}）: {output_path}")
    if total == 0:
        raise RuntimeError(f"入力動画から1コマも読み出せませんでした: {input_path}")
    return total


def _flush(chunk, enc, people, ratio_for, tracker=None):
    """1かたまりぶんを焼いてエンコーダへ流す。複製は省く（渡したコマをそのまま書き換える）。"""
    out, _tracker = mosaic_frames(chunk, people=people, ratio_for=ratio_for,
                                  copy_frames=False, tracker=tracker)
    for frame in out:
        enc.stdin.write(frame.tobytes())
    return len(out)


def main(argv):
    parser = argparse.ArgumentParser(
        prog="apply_mosaic_cli.py",
        description="出来上がった動画に顔モザイクを焼く",
    )
    parser.add_argument("input_path", help="入力mp4")
    parser.add_argument("output_path", help="出力mp4")
    parser.add_argument("--target", help="他の人と強さを変えたい方の顔画像")
    parser.add_argument("--strength", choices=list(STRENGTH), default="普通",
                        help="--target の方に使う強さ")
    try:
        args = parser.parse_args(argv[1:])
    except SystemExit as e:
        # argparse は --help でも SystemExit(0) を投げる。`e.code or 2` と書くと
        # 0 が偽と見なされて 2 になり、`--help` が異常終了扱いになってしまう。
        # argparse が決めた終了コードをそのまま返す（不明なときだけ 2）。
        return 2 if e.code is None else int(e.code)
    input_path, output_path = args.input_path, args.output_path
    target, strength = args.target, args.strength

    if not os.path.exists(input_path):
        sys.stderr.write(f"[ERROR] 入力動画が見つかりません: {input_path}\n")
        return 1
    if target and not os.path.exists(target):
        sys.stderr.write(f"[ERROR] 対象者の顔画像が見つかりません: {target}\n")
        return 1

    try:
        n = run(input_path, output_path, target=target, strength=strength)
    except (OSError, RuntimeError, ValueError) as e:
        sys.stderr.write(f"[ERROR] {e}\n")
        return 1

    who = f"（{os.path.basename(target)} の方を「{strength}」で）" if target else ""
    print(f"[OK] {n}コマに顔モザイクを焼きました{who} → {output_path}")
    print("出来上がりを再生して、隠しそこねが無いか必ずご確認ください。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
