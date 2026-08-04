"""出来上がった動画に顔モザイクを焼く（ロードマップ M-4-F / M-4-G）。

    python src/apply_mosaic_cli.py <入力mp4> <出力mp4> [--target 顔画像] [--strength 強め|普通|弱め]

レンダリング済みのクリップを受け取り、顔を隠した動画を書き出す。音声は無変換でコピーする。
`--target` に顔画像を渡すと、その人だけ `--strength` の強さで隠し、他の人は既定の強さになる。

「設定は聞かれたのに出来た動画には掛かっていない」を防ぐための、実際に効く経路。
SKILL.md の手順7（レンダリング）の後に呼ばれる。
"""

import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from face_mosaic import (  # noqa: E402
    BLOCK_RATIO_DEFAULT,
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


def probe(path):
    """幅・高さ・fps を取る。取れなければ理由の分かる例外にする。"""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate",
         "-of", "default=nw=1", path],
        capture_output=True, text=True,
    ).stdout
    info = dict(l.split("=", 1) for l in out.strip().split("\n") if "=" in l)
    if "width" not in info or "height" not in info:
        raise RuntimeError(f"動画の情報を取得できませんでした: {path}")
    num, den = info.get("r_frame_rate", "30/1").split("/")
    return int(info["width"]), int(info["height"]), float(num) / float(den)


def run(input_path, output_path, target=None, strength="普通"):
    """入力動画の顔を隠して出力動画に書き出す。"""
    width, height, fps = probe(input_path)
    people = [register_person(target, name="target")] if target else []
    ratio_for = {"target": STRENGTH.get(strength, BLOCK_RATIO_DEFAULT)} if people else None

    dec = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", input_path, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE, bufsize=width * height * 3 * 4,
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
    chunk = []
    try:
        while True:
            buf = dec.stdout.read(size)
            if len(buf) < size:
                break
            # bytearray にすると書き換え可能になり、複製を省いてそのまま焼ける
            chunk.append(np.frombuffer(bytearray(buf), np.uint8).reshape(height, width, 3))
            if len(chunk) >= CHUNK_FRAMES:
                total += _flush(chunk, enc, people, ratio_for)
                chunk = []
        if chunk:
            total += _flush(chunk, enc, people, ratio_for)
    finally:
        enc.stdin.close()
        enc.wait()
        dec.wait()

    if dec.returncode != 0:
        raise RuntimeError(f"入力動画の読み出しに失敗しました（終了コード {dec.returncode}）: {input_path}")
    if enc.returncode != 0:
        raise RuntimeError(f"出力動画の書き出しに失敗しました（終了コード {enc.returncode}）: {output_path}")
    if total == 0:
        raise RuntimeError(f"入力動画から1コマも読み出せませんでした: {input_path}")
    return total


def _flush(chunk, enc, people, ratio_for):
    """1かたまりぶんを焼いてエンコーダへ流す。複製は省く（渡したコマをそのまま書き換える）。"""
    out, _tracker = mosaic_frames(chunk, people=people, ratio_for=ratio_for, copy_frames=False)
    for frame in out:
        enc.stdin.write(frame.tobytes())
    return len(out)


def main(argv):
    if len(argv) < 3:
        sys.stderr.write(__doc__)
        return 2
    input_path, output_path = argv[1], argv[2]
    target = None
    strength = "普通"
    if "--target" in argv:
        i = argv.index("--target")
        if i + 1 >= len(argv):
            sys.stderr.write("[ERROR] --target には顔画像のパスを指定してください。\n")
            return 2
        target = argv[i + 1]
    if "--strength" in argv:
        i = argv.index("--strength")
        if i + 1 >= len(argv) or argv[i + 1] not in STRENGTH:
            sys.stderr.write(
                f"[ERROR] --strength には {' / '.join(STRENGTH)} のいずれかを指定してください。\n"
            )
            return 2
        strength = argv[i + 1]

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
