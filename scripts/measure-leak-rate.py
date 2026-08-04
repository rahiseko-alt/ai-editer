"""実素材で「素顔が残ったコマ」の割合を測る（ロードマップ M-5-C の verify）。

    python3 scripts/measure-leak-rate.py [--seconds N] [--start N] [--url URL]

なぜこの形なのか
----------------
M-5-C は「実素材での見落とし率が分かっている」という葉で、evidence は外部事実でなければ
ならない。以前は手元にあった第三者の映像で測っていたが、その素材はリポジトリにも CI にも
置けず、誰も再現できなかった（＝自己申告と変わらない）ので撤回した。

そこでこの計測は、**パブリックドメインの実写映像**（NASA の宇宙飛行士インタビュー・
Wikimedia Commons 経由）を実行時に取得して使う。合成した試験素材ではなく実際に人が
話している映像なので「実素材」の条件を満たし、かつ誰でも・CI でも同じ結果を再現できる。

測り方は、関数を直接叩くのではなく **お客様が通るのと同じ経路**（`apply_mosaic_cli.run`）で
mp4 を書き出し、その **出来上がった mp4 を復号し直して** 顔検出を掛ける。エンコードまで
含めた「実際に納品されるファイル」を見るため、途中経過ではなく成果物の事実になる。

空振りの 0% を防ぐ
------------------
顔が1つも写っていない素材を測れば見落とし率は必ず 0% になり、何も確かめたことにならない。
そのため「元素材に顔が写っていたコマ」も数え、写っていなければ計測失敗として落とす。
"""

import argparse
import os
import subprocess
import sys

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "video-shorts", "src"))

from face_mosaic import create_detector, detect_faces  # noqa: E402
import apply_mosaic_cli  # noqa: E402

# NASA 撮影のパブリックドメイン映像（Wikimedia Commons）。
# 1920x1080・実写・正面の顔が写っている宇宙飛行士のインタビュー。
# NASA の著作物は原則パブリックドメインで、取得・改変・再配布に制限が無い。
DEFAULT_URL = (
    "https://upload.wikimedia.org/wikipedia/commons/f/f0/"
    "NASA_Astronaut_Anne_McClain_Talks_with_Fox13_News%2C_Seattle_%E2%80%93_"
    "March_31%2C_2025_%28iss072m260901634%29.webm"
)
DEFAULT_LABEL = (
    "NASA Astronaut Anne McClain Talks with Fox13 News, Seattle – March 31, 2025 "
    "(iss072m260901634).webm / NASA / public domain / via Wikimedia Commons"
)
# 同じ素材の中に、性質の違う場面が入っている。良い数字が出る場面だけを選ぶと
# 計測が意味を失うので、**代表的な場面と苦手な場面の両方**を必ず測る。
SEGMENTS = {
    "interview": {
        "start": 120.0,
        "label": "インタビュー（想定される使い方に近い場面）",
        "note": "顔1人・高さ約160px・正面固定。この機能が本来対象とする映り。",
    },
    "crowd": {
        "start": 0.0,
        "label": "管制室の引き画（苦手な場面）",
        "note": "遠くの人が多数写り、顔の高さが18〜27pxしかない。検出の下限を下回る大きさ。",
    },
}
# Wikimedia は User-Agent の無いアクセスを弾くことがあるため名乗る
USER_AGENT = "ai-editer-roadmap-M-5-C-measurement/1.0 (https://github.com/rahiseko-alt/ai-editer)"


def fetch(url, start, seconds, dest):
    """素材の一部だけを取り出して手元の mp4 にする（全編を落とさない）。"""
    cmd = ["ffmpeg", "-v", "error", "-y", "-user_agent", USER_AGENT]
    if start:
        cmd += ["-ss", str(start)]
    cmd += ["-i", url, "-t", str(seconds),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-an", dest]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(dest):
        raise RuntimeError(f"素材を取得できませんでした（終了コード {proc.returncode}）\n{proc.stderr[-500:]}")


def count_frames_with_face(path):
    """動画を1コマずつ復号し、顔が検出できたコマ数を数える（全コマを抱えない）。"""
    width, height, _fps = apply_mosaic_cli.probe(path)
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE, bufsize=width * height * 3 * 4,
    )
    det = create_detector(width, height)
    size = width * height * 3
    total = with_face = faces = 0
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            total += 1
            found = detect_faces(np.frombuffer(buf, np.uint8).reshape(height, width, 3), det)
            if found:
                with_face += 1
                faces += len(found)
    finally:
        proc.stdout.close()
        proc.wait()
    if proc.returncode != 0:
        # 短い読み取りは「最後まで読んだ」と「途中で壊れた」の両方で起きる。
        # 区別せずに数え上げを返すと、**途中までしか見ていない結果**を
        # 「見落とし率」として記録してしまう。計測は途中経過を出さずに落とす。
        raise RuntimeError(f"動画の復号に失敗しました（終了コード {proc.returncode}）: {path}")
    return total, with_face, faces


def commit_sha():
    """計測時のコミット。どの状態のコードで測ったかを結果に残す。"""
    proc = subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"],
                          capture_output=True, text=True)
    return proc.stdout.strip() or "(不明)"


def measure_one(url, seg_key, seconds, work):
    """1区間を測って結果を返す。測れなければ None。"""
    seg = SEGMENTS[seg_key]
    src = os.path.join(work, f"{seg_key}-source.mp4")
    out = os.path.join(work, f"{seg_key}-mosaicked.mp4")

    print(f"--- {seg_key}: {seg['label']} ---")
    print(f"    {seg['note']}")
    print(f"    区間: {seg['start']}秒から{seconds}秒ぶん")

    print("    [1/4] 素材を取得…")
    fetch(url, seg["start"], seconds, src)
    width, height, fps = apply_mosaic_cli.probe(src)
    print(f"          {width}x{height} {fps:.2f}fps")

    print("    [2/4] 元素材の顔を数える…")
    src_total, src_with_face, src_faces = count_frames_with_face(src)
    print(f"          {src_with_face}/{src_total} コマ（延べ{src_faces}人）")
    if src_with_face == 0:
        # 顔が無い素材で測れば見落とし率は必ず0%になる。それは計測ではない。
        print("    FAIL: 元素材から顔が1つも検出できませんでした。")
        print("          この素材で測る『見落とし0%』は空振りであり、証拠になりません。")
        return None

    print("    [3/4] お客様と同じ経路でモザイクを焼く…")
    burned = apply_mosaic_cli.run(src, out)
    print(f"          {burned}コマ")

    print("    [4/4] 出来上がりを復号し直して素顔を数える…")
    out_total, out_with_face, out_faces = count_frames_with_face(out)
    rate = out_with_face / out_total * 100 if out_total else 0.0
    print(f"    → 素顔が残ったコマ {out_with_face}/{out_total} ({rate:.2f}%) 延べ{out_faces}人")
    print()
    return {
        "key": seg_key, "label": seg["label"], "rate": rate,
        "src_with_face": src_with_face, "src_total": src_total, "src_faces": src_faces,
        "out_with_face": out_with_face, "out_total": out_total, "out_faces": out_faces,
    }


def build_parser():
    """引数の受け口。ワークフローとの食い違いをテストから検査できるよう関数に出す。"""
    parser = argparse.ArgumentParser(
        prog="measure-leak-rate.py",
        description="実素材で素顔が残ったコマの割合を測る（M-5-C）",
    )
    parser.add_argument("--url", default=DEFAULT_URL, help="実素材の取得元URL")
    parser.add_argument("--label", default=DEFAULT_LABEL, help="結果に記録する素材名")
    parser.add_argument("--seconds", type=float, default=20.0, help="1区間あたりの長さ（秒）")
    parser.add_argument("--case", default="all", choices=["all"] + list(SEGMENTS),
                        help="測る区間")
    parser.add_argument("--work", default=None, help="作業フォルダ")
    return parser


def main(argv):
    args = build_parser().parse_args(argv[1:])

    work = args.work or os.path.join(REPO, "_m5c_work")
    os.makedirs(work, exist_ok=True)
    sha = commit_sha()

    print("=== M-5-C 実素材での見落とし率 計測 ===")
    print(f"素材   : {args.label}")
    print(f"取得元 : {args.url}")
    print(f"commit : {sha}")
    print()

    keys = list(SEGMENTS) if args.case == "all" else [args.case]
    results = []
    for key in keys:
        r = measure_one(args.url, key, args.seconds, work)
        if r is None:
            return 1
        results.append(r)

    print("=== 結果まとめ ===")
    print(f"素材: {args.label}")
    print(f"commit: {sha}")
    for r in results:
        print(f"  [{r['key']}] {r['label']}")
        print(f"      元素材で顔が写っていたコマ : {r['src_with_face']}/{r['src_total']} "
              f"（延べ{r['src_faces']}人）")
        print(f"      出力に素顔が残ったコマ     : {r['out_with_face']}/{r['out_total']} "
              f"= 見落とし率 {r['rate']:.2f}%（延べ{r['out_faces']}人）")
    print()
    print("※ 見落としの判定は、モザイクを掛けるときより厳しい条件（原寸での顔検出）で行っている。")
    print("   モザイク側は速度のため幅960に縮めて探すため、小さすぎる顔は掛からずに残る。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
