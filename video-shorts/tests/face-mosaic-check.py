"""顔モザイク（ロードマップ M-1）のテスト。

各テストは roadmap の葉と1対1に対応する:
  M-1-A 動画に写っている顔の位置が分かる
  M-1-B 顔が動いても隠したまま追いかける
  M-1-C 一瞬顔を見失っても素顔が出ない
  M-1-D 隠した顔は本当に判別できなくなっている

固定素材は tests/fixtures/（NASA の public domain 写真から顔部分を切り出したもの）。
動画ファイルは .gitignore 対象のためコミットせず、動きのある場面はテスト内で
静止画を移動させて合成する（＝素材が無くても同じ結果が再現できる）。
"""

import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from face_mosaic import (  # noqa: E402
    FaceTracker,
    apply_mosaic,
    block_size_for,
    create_detector,
    detect_faces,
    interpolate,
    mosaic_frames,
)

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
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


def load(name):
    p = os.path.join(FIXTURES, name)
    im = cv2.imread(p)
    if im is None:
        raise FileNotFoundError(f"固定素材が読めません: {p}")
    return im


# ---------------------------------------------------------------- M-1-A
# 「写っている人数と同じ数の顔位置が返る」
one = load("face-one.png")
two = load("face-two.png")

check("M-1-A: 1人の固定素材から顔が1件検出される", len(detect_faces(one)) == 1, f"got {len(detect_faces(one))}")
check("M-1-A: 2人の固定素材から顔が2件検出される", len(detect_faces(two)) == 2, f"got {len(detect_faces(two))}")

boxes = detect_faces(one)
x, y, w, h = boxes[0]
check(
    "M-1-A: 返る顔位置が画像内に収まった正の矩形である",
    0 <= x < one.shape[1] and 0 <= y < one.shape[0] and w > 0 and h > 0,
    f"got {boxes[0]}",
)


# ---------------------------------------------------------------- M-1-B
# 「顔が移動する動画で、全フレームの隠し枠が実際の顔位置に重なっている」
def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    return inter / (aw * ah + bw * bh - inter + 1e-9)


def moving_sequence(face_img, n=24, canvas=(720, 480)):
    """顔画像を正弦軌道で動かしたフレーム列と、各フレームの貼り付け位置を返す。"""
    W, H = canvas
    fh, fw = face_img.shape[:2]
    frames, positions = [], []
    for i in range(n):
        t = i / n
        px = int(40 + (W - fw - 80) * (0.5 + 0.5 * np.sin(2 * np.pi * t)))
        py = int(30 + (H - fh - 60) * (0.5 + 0.5 * np.cos(2 * np.pi * t)))
        cv = np.full((H, W, 3), (64, 48, 32), np.uint8)
        cv[py : py + fh, px : px + fw] = face_img
        frames.append(cv)
        positions.append((px, py))
    return frames, positions


frames, _ = moving_sequence(one)
det = create_detector(frames[0].shape[1], frames[0].shape[0])

truth = [detect_faces(f, det) for f in frames]
check(
    "M-1-B: 移動する顔が全フレームで検出できる（前提の確認）",
    all(len(t) == 1 for t in truth),
    f"検出できなかったフレーム={[i for i, t in enumerate(truth) if len(t) != 1]}",
)

tracker = FaceTracker()
overlaps = []
for i, (f, t) in enumerate(zip(frames, truth)):
    tracks = tracker.update(t, frame_index=i)
    if t:
        best = max((iou(tr.box, t[0]) for tr in tracks), default=0.0)
        overlaps.append(best)
check(
    "M-1-B: 全フレームで隠し枠が実際の顔位置と重なる（IoU>=0.5）",
    overlaps and min(overlaps) >= 0.5,
    f"min IoU={min(overlaps) if overlaps else 'n/a'}",
)

check(
    "M-1-B: 1人しか写っていない列でトラックが1本に保たれる（別人扱いで作り直されない）",
    len(tracker.tracks) == 1,
    f"tracks={len(tracker.tracks)}",
)

# 補間はトラックIDで対応付ける。検出順が入れ替わっても枠が別人へ飛ばない。
prev_rows = {1: (0.0, 0.0, 10.0, 10.0), 2: (100.0, 0.0, 10.0, 10.0)}
next_rows = {2: (110.0, 0.0, 10.0, 10.0), 1: (10.0, 0.0, 10.0, 10.0)}  # 順序を反転
mid = interpolate(prev_rows, next_rows, 0.5)
check(
    "M-1-B: キーフレーム間の順序が入れ替わってもIDごとに補間される（枠が別人へ飛ばない）",
    abs(mid[1][0] - 5.0) < 1e-6 and abs(mid[2][0] - 105.0) < 1e-6,
    f"got {mid}",
)


# ---------------------------------------------------------------- M-1-C
# 「顔検出が途切れたコマでも、直前の位置で隠しが継続する」
gapped = [list(t) for t in truth]
GAP = range(8, 13)  # 5フレームぶん検出を人為的に欠落させる
for i in GAP:
    gapped[i] = []

tracker2 = FaceTracker(hold_frames=8)
held_ok = True
for i, t in enumerate(gapped):
    tracks = tracker2.update(t, frame_index=i)
    if i in GAP and len(tracks) == 0:
        held_ok = False
check("M-1-C: 検出が欠落したコマにも隠し枠が出力される", held_ok)

check(
    "M-1-C: 欠落したコマが「保持で埋めた」として記録される（確認対象の抽出に使う）",
    set(GAP).issubset(set(tracker2.held_frames)),
    f"held={tracker2.held_frames}",
)

tracker3 = FaceTracker(hold_frames=2)
for i in range(3):
    tracker3.update(truth[0], frame_index=i)
for i in range(3, 12):
    tracker3.update([], frame_index=i)
check(
    "M-1-C: 保持の上限を超えたら隠しをやめる（居なくなった人を永久に隠さない）",
    len(tracker3.tracks) == 0,
    f"tracks={len(tracker3.tracks)}",
)


# ---------------------------------------------------------------- M-1-D
# 「出力の顔部分を顔検出器にかけても顔として検出されない」
covered, _ = mosaic_frames(frames[:6], detector=create_detector(frames[0].shape[1], frames[0].shape[0]))
recheck = create_detector(covered[0].shape[1], covered[0].shape[0])
leaks = [i for i, f in enumerate(covered) if len(detect_faces(f, recheck)) > 0]
check("M-1-D: モザイク後のフレームから顔が検出されない", not leaks, f"素顔が残ったフレーム={leaks}")

# ブロックの大きさが顔サイズに追随する（固定pxだと大きい顔で保護が破れる）
check(
    "M-1-D: 下限より上では、顔が大きいほどモザイクが粗くなる",
    block_size_for(400) > block_size_for(200) > block_size_for(120),
    f"{block_size_for(400)} / {block_size_for(200)} / {block_size_for(120)}",
)

check(
    "M-1-D: 顔が大きくなるほどブロックが小さくなることはない（単調非減少）",
    all(block_size_for(a) <= block_size_for(b) for a, b in zip(range(20, 400, 20), range(40, 420, 20))),
)

check(
    "M-1-D: 小さく写った顔でもブロックが潰れない（絶対値の下限が効く）",
    block_size_for(1) >= 12,
    f"got {block_size_for(1)}",
)

# 顔の大きさを変えても隠しきれることを、実際に検出器で確かめる。
# 「比率だけ」「絶対値だけ」では隠しきれない大きさがあるため、両方効いていることの回帰防止。
scale_leaks = []
for scale in (0.6, 1.0, 1.6, 2.4):
    im = cv2.resize(one, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    ih, iw = im.shape[:2]
    cw, ch = iw + 200, ih + 120
    cv_frame = np.full((ch, cw, 3), (64, 48, 32), np.uint8)
    cv_frame[60 : 60 + ih, 100 : 100 + iw] = im
    d = create_detector(cw, ch)
    found = detect_faces(cv_frame, d)
    if not found:
        continue
    apply_mosaic(cv_frame, found[0], )
    if detect_faces(cv_frame, d):
        scale_leaks.append((scale, int(found[0][3])))
check(
    "M-1-D: 顔の大きさが変わっても隠しきれる（小さい顔=比率／大きい顔=絶対値の両方が効く）",
    not scale_leaks,
    f"隠しきれなかった (scale, 顔高さ)={scale_leaks}",
)

# 固定8pxでは顔が判別可能なまま残ることを、実際に検出器で確かめる（この比較が
# 「顔サイズ比で持つ」という設計判断の根拠。roadmap M-1-D の detail 参照）
weak = one.copy()
apply_mosaic(weak, detect_faces(one)[0], block=8)
strong = one.copy()
apply_mosaic(strong, detect_faces(one)[0])
det_small = create_detector(one.shape[1], one.shape[0])
check(
    "M-1-D: 顔サイズ比で決めた粗さは、固定8pxより確実に隠せている",
    len(detect_faces(strong, det_small)) == 0,
    f"強={len(detect_faces(strong, det_small))}件 / 固定8px={len(detect_faces(weak, det_small))}件",
)


print(f"\n--- {passed} PASS / {failed} FAIL ---")
sys.exit(1 if failed else 0)
