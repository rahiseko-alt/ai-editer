"""動画に写っている人を1人ずつ切り出し、番号付きの画像として書き出す（ロードマップ M-4-D）。

    python src/face_choices.py <動画パス> <出力フォルダ> [--seconds N]

画面（GUI）は作らない方針なので、対象者の指定はここで出した画像をユーザーに見てもらい
「2番の人」と番号で答えてもらう形にする。SKILL.md の手順3.5 から呼ばれる。

先頭 --seconds 秒（既定60秒）だけを走査する。登場人物を洗い出すのが目的で、全編を
走査しても結果はほとんど変わらないのに時間だけ掛かるため。
"""

import math
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from face_mosaic import write_face_choices  # noqa: E402

DEFAULT_SECONDS = 60


def probe_size(path):
    """ffprobe で映像の幅・高さを取る。取れなければ理由の分かる例外にする。"""
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
        capture_output=True, text=True,
    )
    line = proc.stdout.strip().split("\n")[0] if proc.stdout.strip() else ""
    parts = [p for p in line.split(",") if p.strip().isdigit()]
    if len(parts) < 2:
        raise RuntimeError(
            f"動画の解像度を取得できませんでした: {path}\n"
            f"ffprobe の出力: {proc.stdout.strip() or proc.stderr.strip()}"
        )
    return int(parts[0]), int(parts[1])


def read_frames(path, seconds, width, height, stride=5):
    """先頭 seconds 秒を stride コマおきに読み込む（登場人物の洗い出しには十分）。"""
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-t", str(seconds), "-i", path,
         "-vf", f"select=not(mod(n\\,{stride}))", "-vsync", "0",
         "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE, bufsize=width * height * 3 * 4,
    )
    size = width * height * 3
    frames = []
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        frames.append(np.frombuffer(buf, np.uint8).reshape(height, width, 3))
    proc.wait()
    if proc.returncode != 0:
        # 途中で失敗したコマ列で「○人見つかりました」と報告すると、実際には
        # 走査できていない区間の人物が抜け落ちたまま先へ進んでしまう。
        raise RuntimeError(
            f"ffmpeg が異常終了しました（終了コード {proc.returncode}）: {path}\n"
            "動画が壊れていないか、ffmpeg が正しく入っているかを確認してください。"
        )
    return frames


def main(argv):
    if len(argv) < 3:
        sys.stderr.write(__doc__)
        return 2
    video, out_dir = argv[1], argv[2]
    seconds = DEFAULT_SECONDS
    if "--seconds" in argv:
        index = argv.index("--seconds")
        if index + 1 >= len(argv):
            sys.stderr.write("[ERROR] --seconds には秒数を指定してください。\n")
            return 2
        try:
            seconds = float(argv[index + 1])
        except ValueError:
            sys.stderr.write(f"[ERROR] --seconds には数値を指定してください: {argv[index + 1]}\n")
            return 2
        if not math.isfinite(seconds) or seconds <= 0:
            sys.stderr.write(f"[ERROR] --seconds には0より大きい有限の数を指定してください: {seconds}\n")
            return 2

    if not os.path.exists(video):
        sys.stderr.write(f"[ERROR] 動画が見つかりません: {video}\n")
        return 1

    try:
        width, height = probe_size(video)
        frames = read_frames(video, seconds, width, height)
    except (OSError, RuntimeError) as e:
        # 客は非エンジニア。スタックトレースではなく、何をすればよいかを出す。
        sys.stderr.write(f"[ERROR] {e}\n")
        return 1
    if not frames:
        sys.stderr.write(
            f"[ERROR] 動画からコマを読み出せませんでした: {video}\n"
            "ffmpeg が入っているか、動画が壊れていないかを確認してください。\n"
        )
        return 1

    try:
        found = write_face_choices(frames, out_dir, detect_every=1)
    except (OSError, RuntimeError) as e:
        sys.stderr.write(f"[ERROR] {e}\n")
        return 1
    if not found:
        # 「顔が写っていない」は正常な結果なので、エラーではなくそう伝える
        print("[OK] この動画からは顔が見つかりませんでした（モザイクの対象者はいません）。")
        return 0

    print(f"[OK] {len(found)}人を切り出しました → {out_dir}")
    for f in found:
        print(f"  {f['index']}番: {f['path']}")
    print("フォルダを開いて、他の方と違う強さで隠したい方がいれば番号でお答えください。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
