"""縦型切り抜き(REFRAME)のCLIエントリポイント。

    python3 src/reframe_cli.py <入力mp4> <出力mp4>

入力(16:9想定)を、顔を追跡してクロップした縦型(9:16)動画に変換して書き出す。
1〜2人検出時はクロップ、0人または3人以上検出時は letterbox 方式(render-vertical.mjsと
同じフィルタ)へ自動で切り替える。音声は入力から無変換コピーする。

ロードマップ G-EDIT-REFRAME の実装本体は src/reframe.py。ここは入出力チェックと
エラーメッセージだけを担う薄いラッパー(apply_mosaic_cli.py と同じ形)。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from reframe import reframe  # noqa: E402


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("使い方: python3 reframe_cli.py <入力mp4> <出力mp4>\n")
        return 2
    input_path, output_path = argv[1], argv[2]

    if not os.path.exists(input_path):
        sys.stderr.write(f"[ERROR] 入力動画が見つかりません: {input_path}\n")
        return 1

    try:
        info = reframe(input_path, output_path)
    except (OSError, RuntimeError, ValueError) as e:
        sys.stderr.write(f"[ERROR] {e}\n")
        return 1

    modes = ["crop" if 1 <= c <= 2 else "letterbox" for c in info["modes"]]
    n_crop = modes.count("crop")
    n_letterbox = modes.count("letterbox")
    print(
        f"[OK] {len(modes)}コマを縦型へ変換しました "
        f"(crop={n_crop}コマ / letterbox={n_letterbox}コマ, クロップ幅={info['crop_width']}px) "
        f"→ {output_path}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
