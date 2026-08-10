"""G-EDIT-REFRAME の検証素材(RF-R / RF-N / RF-M)そのものの自己検査。

2026-08-08 basis-reviewer 反証(11): 元画像のSHA-256照合・合成の可逆性の確認が
pnpm test にも CI にも登録されておらず、tests/reframe_fixtures.py を直接
`python3` 実行したときしか走らなかった(face-one.png 等が差し替わっても CI は赤にならない)。
このファイルを pnpm test の並びに登録することで、それを機械強制する。

確認する内容(いずれも「素材そのもの」についての事実。G-EDIT-REFRAME の各葉が
検証する「実装の振る舞い」とは独立):
  (1) 元画像3枚(face-one.png / face-two.png / face-other.png)のSHA-256が凍結どおりである。
  (2) RF-R / RF-N / RF-M を合成し、書き出し(libx264rgb -qp 0 可逆)→読み戻しで
      1画素も違わない(合成手順が非可逆にすり替わっていないこと)。
  (3) RF-R / RF-N / RF-M の顔検出件数が、凍結どおり(1件 / 0件 / 3件、全30コマ)である
      (fixture のジオメトリが崩れていないことの安価な回帰チェック)。
  (4) 音声付き版(RF-R-A)についても、映像コマの可逆性が(2)と同じく成り立つ。
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import reframe_fixtures as rf  # noqa: E402
from face_mosaic import create_detector, detect_faces  # noqa: E402

passed = 0
failed = 0


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS {name}")
    else:
        failed += 1
        print(f"FAIL {name} {extra}")


# ---------------------------------------------------------------- (1)
try:
    rf.verify_stills()
    check("素材の元画像3枚のSHA-256が凍結どおりである", True)
except AssertionError as e:
    check("素材の元画像3枚のSHA-256が凍結どおりである", False, str(e))

# ---------------------------------------------------------------- (2)(3)
EXPECTED_COUNTS = {"R": 1, "N": 0, "M": 3}

with tempfile.TemporaryDirectory() as d:
    det = create_detector(rf.WIDTH, rf.HEIGHT)
    for kind, want in EXPECTED_COUNTS.items():
        path = os.path.join(d, f"{kind}.mp4")
        try:
            frames = rf.build(kind, path)
            check(f"RF-{kind}: 書き出し→読み戻しが可逆(1画素も違わない)", True)
        except AssertionError as e:
            check(f"RF-{kind}: 書き出し→読み戻しが可逆(1画素も違わない)", False, str(e))
            continue

        counts = [len(detect_faces(f, det)) for f in frames]
        check(
            f"RF-{kind}: 全{rf.FRAMES}コマの顔検出件数が{want}件で揃っている",
            all(c == want for c in counts),
            f"実際={sorted(set(counts))}",
        )

    # ---------------------------------------------------------------- (4)
    audio_path = os.path.join(d, "R-A.mp4")
    try:
        rf.build_with_audio("R", audio_path)
        check("RF-R-A: 音声付き版でも映像コマの可逆性が成り立つ", True)
    except AssertionError as e:
        check("RF-R-A: 音声付き版でも映像コマの可逆性が成り立つ", False, str(e))


print(f"\n--- {passed} PASS / {failed} FAIL ---")
sys.exit(1 if failed else 0)
