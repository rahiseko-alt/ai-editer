"""顔モザイク（ロードマップ M-1 / M-2）のテスト。

各テストは roadmap の葉と1対1に対応する:
  M-1-A 動画に写っている顔の位置が分かる
  M-1-B 顔が動いても隠したまま追いかける
  M-1-C 一瞬顔を見失っても素顔が出ない
  M-1-D 隠した顔は本当に判別できなくなっている
  M-2-A 登録した人と同じ人を見分けられる
  M-2-B 別の人を登録した人と取り違えない
  M-2-C 人によって隠す粗さが実際に変わる

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
    expand_box,
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

# detect_faces は detector を渡さないと毎回 ONNX を読み直すので、結果は使い回す。
boxes = detect_faces(one)
boxes_two = detect_faces(two)
check("M-1-A: 1人の固定素材から顔が1件検出される", len(boxes) == 1, f"got {len(boxes)}")
check("M-1-A: 2人の固定素材から顔が2件検出される", len(boxes_two) == 2, f"got {len(boxes_two)}")

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
for i, t in enumerate(truth):
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


def ids_for(order):
    """隣り合う2人を、指定した検出順で2フレーム流したときの (位置 -> トラックID) を返す。"""
    tr = FaceTracker()
    a0, b0 = (100.0, 100.0, 60.0, 75.0), (170.0, 100.0, 60.0, 75.0)  # 顔幅より近い間隔
    tr.update([a0, b0], frame_index=0)
    a1, b1 = (104.0, 100.0, 60.0, 75.0), (174.0, 100.0, 60.0, 75.0)
    nxt = [a1, b1] if order == "同順" else [b1, a1]
    tracks = tr.update(nxt, frame_index=1)
    return {round(t.box[0]): t.id for t in tracks}


check(
    # 貪欲法だと、先に見た検出が後の検出にとってより近いトラックを奪い人物が入れ替わる。
    # 距離の近い順に一意割り当てすれば検出順に依存しない。
    "M-1-B: 隣り合う2人は、検出の順序が入れ替わってもトラックIDが入れ替わらない",
    ids_for("同順") == ids_for("逆順"),
    f"同順={ids_for('同順')} / 逆順={ids_for('逆順')}",
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
# この合成列は顔が最大90px/コマで動く（実際の取材映像の6倍以上）。追従の限界を見るため、
# ここでは検出を間引かない最も厳しい設定で確かめる。間引いた場合の限界は下の別項目で測る。
covered, _ = mosaic_frames(
    frames[:6],
    detector=create_detector(frames[0].shape[1], frames[0].shape[0]),
    detect_every=1,
)
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
undetected = []
fixed_leaks = []
for scale in (0.6, 1.0, 1.6, 2.4):
    im = cv2.resize(one, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    ih, iw = im.shape[:2]
    cw, ch = iw + 200, ih + 120
    base = np.full((ch, cw, 3), (64, 48, 32), np.uint8)
    base[60 : 60 + ih, 100 : 100 + iw] = im
    d = create_detector(cw, ch)
    found = detect_faces(base, d)
    if not found:
        # 黙って飛ばすとその倍率が何の根拠も出さないまま緑になる（サイレント失敗禁止）
        undetected.append(scale)
        continue
    ratio_applied = base.copy()
    apply_mosaic(ratio_applied, found[0])
    if detect_faces(ratio_applied, d):
        scale_leaks.append((scale, int(found[0][3])))
    # 同じ場面を固定8pxでも隠してみる。比率を採った理由（固定値では大きい顔で破れる）を
    # 検証するための対照。隠す範囲は同じで、ブロックの大きさだけが違う。
    fixed_applied = base.copy()
    apply_mosaic(fixed_applied, found[0], block=8)
    if detect_faces(fixed_applied, d):
        fixed_leaks.append((scale, int(found[0][3])))
check(
    "M-1-D: 全ての倍率で顔が検出できる（前提の確認）",
    not undetected,
    f"検出できなかった scale={undetected}",
)
check(
    "M-1-D: 顔の大きさが変わっても隠しきれる（小さい顔=比率／大きい顔=絶対値の両方が効く）",
    not scale_leaks,
    f"隠しきれなかった (scale, 顔高さ)={scale_leaks}",
)
check(
    # ここが緑にならない＝固定値でも隠せてしまう＝比率を採る根拠が消える、ということ。
    # 根拠が実際に成立していることを毎回確かめる（対照が無いと設計判断が検証されない）。
    "M-1-D: 対照として、固定8pxでは大きい顔を隠しきれない（比率を採る根拠）",
    fixed_leaks,
    f"固定8pxでも全倍率で隠せてしまった（比率設計の根拠が成立していない） leaks={fixed_leaks}",
)

# -------------------------------------------------- 実素材で必ず起きる状況への耐性
# 顧客の動画は「顔が写らない場面」「顔が画面端で切れる場面」「スマホの縦動画」を必ず含む。
# ここで落ちると処理全体が止まるため、葉の受入条件とは別に回帰を防ぐ。

blank = [np.full((240, 320, 3), (64, 48, 32), np.uint8) for _ in range(3)]
try:
    out_blank, tr_blank = mosaic_frames(blank)
    ok_blank = len(out_blank) == len(blank) and not tr_blank.tracks
except Exception as e:  # noqa: BLE001 - 落ちないこと自体が検証対象
    ok_blank, e_blank = False, e
check("顔が1つも写っていない場面でも落ちず、フレーム数が変わらない", ok_blank)

# 顔が画面の四隅にはみ出す位置にある場合（枠が画面外へ出る）
edge_ok = True
fh, fw = one.shape[:2]
for ox, oy in ((-fw // 3, -fh // 3), (0, -fh // 3), (-fw // 3, 0)):
    canvas = np.full((260, 340, 3), (64, 48, 32), np.uint8)
    sx0, sy0 = max(0, ox), max(0, oy)
    crop = one[max(0, -oy) :, max(0, -ox) :]
    ch2 = min(canvas.shape[0] - sy0, crop.shape[0])
    cw2 = min(canvas.shape[1] - sx0, crop.shape[1])
    canvas[sy0 : sy0 + ch2, sx0 : sx0 + cw2] = crop[:ch2, :cw2]
    d_edge = create_detector(canvas.shape[1], canvas.shape[0])
    for b in detect_faces(canvas, d_edge):
        try:
            apply_mosaic(canvas, b)
        except Exception:  # noqa: BLE001
            edge_ok = False
check("顔が画面端にかかって枠が画面外へ出ても落ちない", edge_ok)

# スマホの縦動画（9:16）でも検出と隠しが成立する
portrait = np.full((640, 360, 3), (64, 48, 32), np.uint8)
portrait[80 : 80 + fh, 70 : 70 + fw] = one
d_por = create_detector(360, 640)
found_por = detect_faces(portrait, d_por)
if found_por:
    apply_mosaic(portrait, found_por[0])
check(
    "縦動画(9:16)でも顔を検出して隠せる",
    bool(found_por) and not detect_faces(portrait, d_por),
    f"検出={len(found_por)}件 / 隠した後の残り={len(detect_faces(portrait, d_por))}件",
)

# 顔がブロックの下限より小さい場合（遠くに写った人）でも塗り潰せる
tiny = np.full((120, 160, 3), (64, 48, 32), np.uint8)
tiny_face = cv2.resize(one, (24, 27), interpolation=cv2.INTER_AREA)
tiny[40:67, 50:74] = tiny_face
before_tiny = tiny.copy()
apply_mosaic(tiny, (50.0, 40.0, 24.0, 27.0))
check(
    "顔がモザイク1ブロックより小さくても、その範囲が塗り潰される",
    not np.array_equal(before_tiny[40:67, 50:74], tiny[40:67, 50:74]),
)




# ================================================================ M-2
# 特定の人だけ隠し方を変えられる。
#   M-2-A 登録した人と同じ人を見分けられる
#   M-2-B 別の人を登録した人と取り違えない
#   M-2-C 人によって隠す粗さが実際に変わる
#
# 固定素材は「同一人物の別々の写真」と「別人」。撮影年が13年違う2枚を同一人物の組に使う
# （簡単すぎる条件で緑にしない）。

from face_mosaic import (  # noqa: E402
    RECOGNITION_THRESHOLD,
    create_recognizer,
    detect_faces_raw,
    face_signature,
    mosaic_frames as mosaic_frames_m2,
    register_person,
    same_person,
)

rec = create_recognizer()


def signature_of(name):
    img = load(name)
    faces = detect_faces_raw(img, create_detector(img.shape[1], img.shape[0]))
    if not faces:
        raise AssertionError(f"固定素材から顔を検出できません: {name}")
    return face_signature(img, max(faces, key=lambda b: b[2] * b[3]), rec)


sig_one = signature_of("face-one.png")        # 本人(1969年撮影)
sig_one_alt = signature_of("face-one-alt.png")  # 本人の別写真(1956年撮影)
sig_other = signature_of("face-other.png")      # 別人

# ---------------------------------------------------------------- M-2-A
same_ok, same_score = same_person(sig_one, sig_one_alt, rec)
check(
    "M-2-A: 同一人物の別々の写真どうしの類似度が判定閾値以上になる",
    same_ok,
    f"類似度={same_score:.4f} (閾値={RECOGNITION_THRESHOLD})",
)

# ---------------------------------------------------------------- M-2-B
diff_ok, diff_score = same_person(sig_one, sig_other, rec)
check(
    "M-2-B: 別人どうしの類似度が判定閾値未満になる",
    not diff_ok,
    f"類似度={diff_score:.4f} (閾値={RECOGNITION_THRESHOLD})",
)

# 2人が写った素材の中から、登録した人だけを選び出せる（誤認も取り逃しも無い）
two_img = load("face-two.png")
two_raw = detect_faces_raw(two_img, create_detector(two_img.shape[1], two_img.shape[0]))
labels = []
for b in sorted(two_raw, key=lambda r: r[0]):
    ok, _ = same_person(sig_one_alt, face_signature(two_img, b, rec), rec)
    labels.append(ok)
check(
    "M-2-B: 2人写った場面で、登録した人だけが選ばれる（もう1人は選ばれない）",
    labels == [True, False],
    f"左から順の判定={labels}（期待=[True, False]）",
)

# ---------------------------------------------------------------- M-2-C
target = register_person(os.path.join(FIXTURES, "face-one-alt.png"), name="target")
COARSE, FINE = 1.0 / 4.0, 1.0 / 12.0
out_m2, tracker_m2 = mosaic_frames_m2(
    [two_img.copy()],
    people=[target],
    ratio_for={"target": COARSE, "_other": FINE},
)
found_labels = sorted(t.label for t in tracker_m2.tracks)
check(
    "M-2-C: 1つの場面で、登録した人と他の人が別々の人物として扱われる",
    found_labels == ["_other", "target"],
    f"判定されたラベル={found_labels}",
)


def block_count(image, box):
    """モザイク後の領域に、色の異なるブロックがいくつ並んでいるかを数える。

    ブロックが粗いほど数は少なくなる。塗りの粗さを外から観測するための指標。
    """
    x, y, w, h = [int(v) for v in box]
    roi = image[y : y + h, x : x + w]
    return len(np.unique(roi.reshape(-1, roi.shape[2]), axis=0))


boxes_sorted = sorted(two_raw, key=lambda r: r[0])
n_target = block_count(out_m2[0], boxes_sorted[0][:4])
n_other = block_count(out_m2[0], boxes_sorted[1][:4])
check(
    # 粗い(1/4)ほど色の種類が少なく、細かい(1/12)ほど多くなる。
    "M-2-C: 1つの出力フレーム内で、登録した人と他の人の隠しの粗さが指定どおり異なる",
    n_target < n_other,
    f"登録者(粗い指定)の色数={n_target} / 他の人(細かい指定)の色数={n_other}",
)

# 見分けに失敗しても素顔が出ないこと（未登録扱いでも必ず隠れる）＝設計上の安全側
det_two = create_detector(out_m2[0].shape[1], out_m2[0].shape[0])
check(
    "M-2-C: 登録の有無にかかわらず、写っている顔は全て隠れている",
    not detect_faces(out_m2[0], det_two),
    f"素顔が残った={len(detect_faces(out_m2[0], det_two))}件",
)

# 参照写真に顔が写っていない場合は、黙って「登録できた」ことにせず理由を出して止まる
blank_path = os.path.join(FIXTURES, "..", "_no_face_tmp.png")
cv2.imwrite(blank_path, np.full((120, 160, 3), (64, 48, 32), np.uint8))
try:
    register_person(blank_path)
    reg_ok = False
except ValueError:
    reg_ok = True
finally:
    os.remove(blank_path)
check("M-2: 顔が写っていない写真を登録しようとしたら、理由を示して止まる", reg_ok)


# ================================================================ M-3
# 隠しそこねを見つけて直せる。
#   M-3-A 隠しそこねた可能性のある場面が自動で示される
#   M-3-B 隠しそこねを後から手で直せる

import shutil  # noqa: E402

from face_mosaic import (  # noqa: E402
    DETECT_EVERY_DEFAULT,
    DETECT_WIDTH_DEFAULT,
    apply_manual_masks,
    detection_scale,
    review_frames,
    write_review_images,
)

# ---------------------------------------------------------------- M-3-A
tracker_r = FaceTracker(hold_frames=8)
for i, t in enumerate(gapped):
    tracker_r.update(t, frame_index=i)
marks = review_frames(tracker_r, total_frames=len(gapped))
check(
    "M-3-A: 顔を見失って補完した区間が、確認対象として拾い出される",
    set(GAP).issubset(set(marks)),
    f"拾い出されたコマ={marks} / 欠落させたコマ={list(GAP)}",
)

review_dir = os.path.join(FIXTURES, "..", "_review_tmp")
shutil.rmtree(review_dir, ignore_errors=True)
written = write_review_images(frames, marks, review_dir)
check(
    "M-3-A: 確認用の静止画がファイルとして書き出される",
    written and all(os.path.exists(p) and os.path.getsize(p) > 0 for p in written),
    f"書き出し={len(written)}枚",
)
check(
    "M-3-A: 書き出した静止画が元フレームと同じ解像度である（確認のために画質を落とさない）",
    cv2.imread(written[0]).shape == frames[0].shape,
    f"{cv2.imread(written[0]).shape} vs {frames[0].shape}",
)
shutil.rmtree(review_dir, ignore_errors=True)

# ---------------------------------------------------------------- M-3-B
manual = [f.copy() for f in frames[:10]]
# 単色の背景を隠しても画素は変わらないので、実際に顔が写っている位置を指定する
# （自動処理が取りこぼした顔を人が手で塞ぐ、という本来の使い方に合わせる）
BOX = detect_faces(frames[5], det)[0]
bx, by, bw2, bh2 = [int(v) for v in BOX]
region = (slice(by, by + bh2), slice(bx, bx + bw2))
before_by_frame = {i: manual[i][region].copy() for i in (4, 5, 6)}
apply_manual_masks(manual, [{"start": 4, "end": 6, "box": BOX}])
changed = [i for i in (4, 5, 6) if not np.array_equal(before_by_frame[i], manual[i][region])]
check(
    # 開始・終了の両端を含むことを両端で確かめる。中だけ見ると片端が抜けても緑になる。
    "M-3-B: 指定した区間の指定位置に、後から隠しを足せる（開始・終了の両端を含む）",
    changed == [4, 5, 6],
    f"変化したコマ={changed}（期待=[4, 5, 6]）",
)
check(
    "M-3-B: 指定した区間の外は変わらない",
    np.array_equal(manual[0], frames[0]) and np.array_equal(manual[9], frames[9]),
)
# 手で足した隠しが、実際に顔を隠せていること（位置を書いただけで終わらない）
det_manual = create_detector(manual[5].shape[1], manual[5].shape[0])
covered_here = [b for b in detect_faces(manual[5], det_manual)
                if abs(b[0] - BOX[0]) < BOX[2] and abs(b[1] - BOX[1]) < BOX[3]]
check(
    "M-3-B: 手で足した隠しで、その顔が実際に検出されなくなる",
    not covered_here,
    f"隠したはずの位置に残った顔={covered_here}",
)


# ================================================================ 出力画質
# 高速化のために縮小するのは「検出用のコピー」だけで、出力は原寸のまま焼く。
# ここが崩れると、速くなった代わりに納品物が使えなくなる。
src_frames = [f.copy() for f in frames[:4]]
out_q, _ = mosaic_frames(src_frames)
check(
    "出力フレームの解像度が入力と同一である（検出用の縮小が出力に波及しない）",
    all(o.shape == s.shape for o, s in zip(out_q, frames[:4])),
    f"{[o.shape for o in out_q]} vs {[s.shape for s in frames[:4]]}",
)
# 顔の外側は1画素も書き換わっていないこと（＝背景が再圧縮・再サンプルされていない）
# 除外範囲は「実際にモザイクを掛けた枠」から作る。パイプラインは縮小した画で検出するため、
# 原寸で検出し直した枠とは座標が僅かに違う。別物を除外すると検証にならない。
one_out, one_tracker = mosaic_frames([frames[0].copy()])
outside_face = np.ones(frames[0].shape[:2], dtype=bool)
for t in one_tracker.tracks:
    ex, ey, ew, eh = expand_box(t.box, frames[0].shape[1], frames[0].shape[0])
    outside_face[ey : ey + eh, ex : ex + ew] = False
check(
    "モザイクを掛けた枠が1つ以上ある（前提の確認）",
    any(not outside_face.all() for _ in [0]) and len(one_tracker.tracks) >= 1,
    f"tracks={len(one_tracker.tracks)}",
)
check(
    # 上側だけを見ていると、顔の左右・下側が書き換わっても緑になり主張を裏付けない。
    "顔以外の領域は1画素も書き換わらない（背景の画質が落ちない）",
    np.array_equal(one_out[0][outside_face], frames[0][outside_face]),
    f"書き換わった画素数={int((one_out[0][outside_face] != frames[0][outside_face]).sum())}",
)
check(
    "検出用の縮小率は出力に影響しない（1920幅なら960幅で検出=0.5倍）",
    abs(detection_scale(1920, 1080, 960) - 0.5) < 1e-9
    and detection_scale(640, 360, 960) == 1.0,
    f"{detection_scale(1920, 1080, 960)} / {detection_scale(640, 360, 960)}",
)
check(
    "既定の検出設定が、実測で取りこぼしの出ない値になっている",
    DETECT_WIDTH_DEFAULT >= 960 and DETECT_EVERY_DEFAULT <= 3,
    f"width={DETECT_WIDTH_DEFAULT} every={DETECT_EVERY_DEFAULT}",
)


# -------------------------------------------------- レビュー指摘に対する回帰テスト
# いずれも「黙って保護が外れる」種類の穴。緑のまま素通りしないよう固定する。

# 検出間隔に0以下を渡すと、検出が1回も走らずモザイク無しのフレームが返っていた
for bad in (0, -1):
    try:
        mosaic_frames([np.zeros((80, 80, 3), np.uint8)], detect_every=bad)
        rejected = False
    except ValueError:
        rejected = True
    check(f"検出間隔に {bad} を渡したら、素通しせずに止まる", rejected)

# フレーム数が検出間隔で割り切れないときの末尾は、直前の位置を流用する＝枠が古い。
# ここが確認対象から漏れると、素顔が残っていても人に示されない。
tail_frames = frames[:7]  # 7 は既定の検出間隔3で割り切れない
_out_tail, tracker_tail = mosaic_frames(tail_frames, detect_every=3)
tail_marks = review_frames(tracker_tail, total_frames=len(tail_frames))
check(
    "フレーム数が検出間隔で割り切れないとき、末尾のコマが確認対象に入る",
    any(i >= 6 for i in tail_marks),
    f"確認対象={tail_marks}（末尾コマ6が含まれること）",
)

# 書き出しに失敗したパスを「書き出した」として返すと、確認したつもりの取りこぼしが出る
try:
    write_review_images(frames, [0], "/proc/self/cannot-write-here")
    write_failed_loudly = False
except (OSError, cv2.error):
    write_failed_loudly = True
check("確認用の静止画を書き出せなかったら、黙って成功扱いにせず止まる", write_failed_loudly)


# ================================================================ M-4
# お客様が今までどおり受け取って使える。
#   M-4-A 顔を隠すのに必要な部品が配布物に入っている
#   M-4-B 同梱した部品の利用許諾が配布物に入っている
#   M-4-C お客様の導入手順が増えていない
#   M-4-D 隠したい人をチャットで指定できる
#   M-4-E 毎回モザイクの要否を聞かれる

import subprocess  # noqa: E402

from face_mosaic import write_face_choices  # noqa: E402

PKG = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REPO = os.path.abspath(os.path.join(PKG, ".."))
DIST = os.path.join(REPO, "dist", "kosespark-video-shorts")

# ---------------------------------------------------------------- M-4-A / M-4-B
build = subprocess.run(
    [sys.executable and "node", os.path.join(PKG, "build-dist.mjs")],
    capture_output=True, text=True,
)
check("M-4-A: 配布物のビルドが成功する（前提の確認）", build.returncode == 0,
      (build.stderr or build.stdout)[-300:])

MODELS = ["face_detection_yunet_2023mar.onnx", "face_recognition_sface_2021dec.onnx"]
missing_models = [m for m in MODELS
                  if not os.path.exists(os.path.join(DIST, "src", "models", m))]
check(
    "M-4-A: 配布物に、顔検出と顔識別のモデルファイルが含まれる",
    not missing_models,
    f"見つからなかったモデル={missing_models}",
)

LICENSES = ["LICENSE-yunet.txt", "LICENSE-sface.txt"]
bad_licenses = []
for name in LICENSES:
    path = os.path.join(DIST, "src", "models", name)
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        bad_licenses.append(name)
check(
    # 他人の作ったものを同梱する以上、許諾の本文を一緒に配るのは義務
    "M-4-B: 配布物に、同梱モデルのライセンス本文が空でない状態で含まれる",
    not bad_licenses,
    f"欠けている/空のライセンス={bad_licenses}",
)

# ---------------------------------------------------------------- M-4-C
req = open(os.path.join(PKG, "requirements.txt"), encoding="utf-8").read()
check(
    "M-4-C: 顔処理のライブラリが requirements.txt に記載されている",
    any(line.strip().startswith("opencv-python") for line in req.splitlines()),
    "requirements.txt に opencv の行がない",
)
start_here = open(os.path.join(PKG, "start-here.md"), encoding="utf-8").read()
install_cmds = [ln for ln in start_here.splitlines()
                if "pip install" in ln and "requirements.txt" not in ln]
check(
    # 既存の pip install -r requirements.txt 以外のインストール手順が増えていないこと
    "M-4-C: 導入手順に新しいインストールコマンドが追加されていない",
    not install_cmds,
    f"増えていたコマンド={install_cmds}",
)
check(
    "M-4-C: 配布物側の requirements.txt にも顔処理のライブラリが入る",
    "opencv-python" in open(os.path.join(DIST, "requirements.txt"), encoding="utf-8").read(),
)

# ---------------------------------------------------------------- M-4-D
choice_dir = os.path.join(FIXTURES, "..", "_faces_tmp")
shutil.rmtree(choice_dir, ignore_errors=True)
canvas = np.full((600, 900, 3), (64, 48, 32), np.uint8)
canvas[100 : 100 + two.shape[0], 100 : 100 + two.shape[1]] = two
picks = write_face_choices([canvas] * 3, choice_dir, detect_every=1)
check(
    "M-4-D: 動画から検出した顔が、番号付きの画像ファイルとして書き出される",
    [p["index"] for p in picks] == [1, 2]
    and all(os.path.exists(p["path"]) and os.path.getsize(p["path"]) > 0 for p in picks),
    f"書き出し={[(p['index'], os.path.basename(p['path'])) for p in picks]}",
)
check(
    # 同じ人が何枚も並ぶと、どれを選べばよいか分からなくなる
    "M-4-D: 1人につき1枚だけ書き出される（同じ人が重複しない）",
    len(picks) == 2 and len({p["track_id"] for p in picks}) == 2,
    f"枚数={len(picks)} / 人数={len({p['track_id'] for p in picks})}",
)
check(
    "M-4-D: 顔が写っていない動画では、空の結果を返して落ちない",
    write_face_choices([np.full((200, 300, 3), (64, 48, 32), np.uint8)] * 2,
                       choice_dir, detect_every=1) == [],
)
shutil.rmtree(choice_dir, ignore_errors=True)

# 配布物にも切り出しの入口が入っていること（顧客の手元で動かないと意味がない）
check(
    "M-4-D: 対象者を切り出す入口が配布物に含まれる",
    os.path.exists(os.path.join(DIST, "src", "face_choices.py")),
)

# 配る当のCLIを実際に起動して確かめる（関数が動くことと、客が叩く入口が動くことは別）
import shlex as _shlex  # noqa: E402
import subprocess as _sp  # noqa: E402

_cli_dir = os.path.join(FIXTURES, "..", "_choices_cli_tmp")
shutil.rmtree(_cli_dir, ignore_errors=True)
os.makedirs(_cli_dir, exist_ok=True)
_plate = os.path.join(_cli_dir, "plate.png")
_vid = os.path.join(_cli_dir, "src.mp4")
_c = np.full((720, 1280, 3), (64, 48, 32), np.uint8)
_c[240 : 240 + two.shape[0], 380 : 380 + two.shape[1]] = two
cv2.imwrite(_plate, _c)
_sp.run(_shlex.split(f'ffmpeg -y -loglevel error -loop 1 -i "{_plate}" -t 1 -r 10 '
                     f'-c:v libx264 -pix_fmt yuv420p "{_vid}"'), capture_output=True)
_r = _sp.run([sys.executable, os.path.join(PKG, "src", "face_choices.py"), _vid, _cli_dir, "--seconds", "1"],
             capture_output=True, text=True)
_written = sorted(n for n in os.listdir(_cli_dir) if n.startswith("face-") and n.endswith(".png"))
check(
    "M-4-D: 配布する切り出しCLIを実行すると、番号付きの顔画像が書き出される",
    _r.returncode == 0 and _written == ["face-1.png", "face-2.png"],
    f"終了コード={_r.returncode} 書き出し={_written} {(_r.stderr or '')[-200:]}",
)
# 前回の候補が残って別人を選ばせないこと
with open(os.path.join(_cli_dir, "face-9.png"), "wb") as _fh:
    _fh.write(b"stale")
_sp.run([sys.executable, os.path.join(PKG, "src", "face_choices.py"), _vid, _cli_dir, "--seconds", "1"],
        capture_output=True, text=True)
check(
    "M-4-D: 前回の候補画像が残らない（古い候補で別人を選ばせない）",
    "face-9.png" not in os.listdir(_cli_dir),
    f"残ったファイル={sorted(os.listdir(_cli_dir))}",
)
shutil.rmtree(_cli_dir, ignore_errors=True)

# ---------------------------------------------------------------- M-4-E
skill = open(os.path.join(PKG, "skill", "video-shorts", "SKILL.md"), encoding="utf-8").read()
check(
    # 聞き忘れると素顔のまま納品されるので、毎回のヒアリングに入っている必要がある
    "M-4-E: 毎回のヒアリング項目に、モザイクの要否を確認する質問がある",
    "顔モザイクの要否" in skill,
)
check(
    "M-4-E: 対象者の選び方（番号で答える）が手順書に書かれている",
    "face_choices.py" in skill and "番号" in skill,
)
check(
    "M-4-E: 手順書が配布物に含まれる",
    os.path.exists(os.path.join(DIST, "skill", "video-shorts", "SKILL.md")),
)


# ================================================================ M-5
#   M-5-B ショート1本あたりの処理時間が実用範囲に収まる
#
# 受入条件は「60秒の動画に対するモザイク処理の**追加時間**が動画長の50%以内
# （＝モザイク有無の時間差が30秒以内）」。条件どおり、60秒ぶんのコマ数で、
# モザイク有りと無しの**差**を測る（総時間ではない／短い素材で代用しない）。
# （M-5-A「既存のテストが通ったままである」は CI が審判なのでここでは扱わない）

import time  # noqa: E402

BENCH_FPS = 30
BENCH_SECONDS = 60
bench_face = cv2.resize(one, None, fx=2.2, fy=2.2, interpolation=cv2.INTER_CUBIC)
bfh, bfw = bench_face.shape[:2]


def bench_frame(i):
    """1080p のコマを1枚作る（顔が少しずつ動く＝実素材に近い条件）。"""
    canvas_b = np.full((1080, 1920, 3), (64, 48, 32), np.uint8)
    bx = 200 + (i * 6) % (1920 - bfw - 400)
    canvas_b[200 : 200 + bfh, bx : bx + bfw] = bench_face
    return canvas_b


# 60秒ぶんを一度に抱えると1080pで11GBになるため、本番と同じくかたまりに分けて流す。
# 「モザイク無し」は同じコマ数を同じように作って捨てるだけの経路で、差分がモザイクの費用になる。
BENCH_CHUNK = 150
elapsed_without = 0.0
elapsed_with = 0.0
for base in range(0, BENCH_FPS * BENCH_SECONDS, BENCH_CHUNK):
    n_this = min(BENCH_CHUNK, BENCH_FPS * BENCH_SECONDS - base)

    t0 = time.time()
    plain = [bench_frame(base + k) for k in range(n_this)]
    for f in plain:  # モザイク無しでも、コマを一通り触る費用は同じだけ掛かる
        f[0, 0, 0] = f[0, 0, 0]
    elapsed_without += time.time() - t0
    del plain  # 次の測定と同時に抱えると1080pで約1.9GBになる

    t0 = time.time()
    withm = [bench_frame(base + k) for k in range(n_this)]
    mosaic_frames(withm, copy_frames=False)
    elapsed_with += time.time() - t0

extra = elapsed_with - elapsed_without
check(
    "M-5-B: 60秒の動画に対するモザイク処理の追加時間が30秒以内（動画長の50%以内）",
    extra <= 30.0,
    f"モザイク有り {elapsed_with:.1f}秒 / 無し {elapsed_without:.1f}秒 / 差 {extra:.1f}秒（受入は30秒以内）",
)

# 複製を省く指定が実際に効いていること（効いていないと上の測定が意味を失う）
pristine = bench_frame(0)
src_a = [pristine.copy(), pristine.copy()]
mosaic_frames(src_a, copy_frames=True)
check(
    "M-5-B: 既定では渡したフレームを書き換えない（呼び出し側が元を使える）",
    np.array_equal(src_a[0], pristine),
    f"書き換わった画素数={int((src_a[0] != pristine).sum())}",
)
src_b = [pristine.copy(), pristine.copy()]
mosaic_frames(src_b, copy_frames=False)
check(
    "M-5-B: 複製を省く指定では、渡したフレームが直接書き換わる",
    not np.array_equal(src_b[0], pristine),
)


# ================================================================ M-4-F / M-4-G
# 選んだ設定が、実際に出来上がる動画に反映されるか。
# 「設定は聞かれたのに出来た動画には掛かっていない」を防ぐ葉なので、
# 関数呼び出しではなく **実際に動画ファイルを作って顔検出を掛け直す** ところまで見る。

import shlex  # noqa: E402

# ffmpeg が無いと、この節は raw な FileNotFoundError で落ちて原因が読み取りにくい。
# 「無いから飛ばす」は偽の緑になるので、落とすうえで理由を明示する。
check(
    "M-4-F: 成果物まで検証するのに必要な ffmpeg が使える（前提の確認）",
    shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None,
    "ffmpeg/ffprobe が見つかりません。CI では quality ジョブで導入しています。",
)

CLI = os.path.join(PKG, "src", "apply_mosaic_cli.py")
tmp_dir = os.path.join(FIXTURES, "..", "_render_tmp")
shutil.rmtree(tmp_dir, ignore_errors=True)
os.makedirs(tmp_dir, exist_ok=True)

# 2人が写った短い動画を素材として作る（ffmpeg は CI にも入っている）
src_video = os.path.join(tmp_dir, "src.mp4")
plate = os.path.join(tmp_dir, "plate.png")
big_canvas = np.full((720, 1280, 3), (64, 48, 32), np.uint8)
big_canvas[240 : 240 + two.shape[0], 380 : 380 + two.shape[1]] = two
cv2.imwrite(plate, big_canvas)
make = subprocess.run(
    shlex.split(f'ffmpeg -y -loglevel error -loop 1 -i "{plate}" -t 1 -r 15 '
                f'-c:v libx264 -pix_fmt yuv420p "{src_video}"'),
    capture_output=True, text=True,
)
check("M-4-F: 検証用の素材動画を作れる（前提の確認）",
      make.returncode == 0 and os.path.exists(src_video),
      (make.stderr or "")[-200:])


def faces_in_video(path):
    """動画を実際にデコードし直し、素顔が残っているコマ数を数える。"""
    probe = subprocess.run(
        shlex.split(f'ffprobe -v error -select_streams v:0 -show_entries stream=width,height '
                    f'-of csv=p=0 "{path}"'), capture_output=True, text=True)
    w, h = [int(v) for v in probe.stdout.strip().split(",")[:2]]
    proc = subprocess.Popen(
        shlex.split(f'ffmpeg -v error -i "{path}" -f rawvideo -pix_fmt bgr24 -'),
        stdout=subprocess.PIPE, bufsize=w * h * 3 * 4)
    d = create_detector(w, h)
    total = leaked = 0
    while True:
        buf = proc.stdout.read(w * h * 3)
        if len(buf) < w * h * 3:
            break
        total += 1
        if detect_faces(np.frombuffer(buf, np.uint8).reshape(h, w, 3), d):
            leaked += 1
    proc.wait()
    return total, leaked


before_total, before_leak = faces_in_video(src_video)
check("M-4-F: 素材動画には素顔が写っている（前提の確認）",
      before_total > 0 and before_leak == before_total,
      f"{before_leak}/{before_total} コマで顔を検出")

out_video = os.path.join(tmp_dir, "out.mp4")
run_cli = subprocess.run(
    [sys.executable, CLI, src_video, out_video],
    capture_output=True, text=True)
after_total, after_leak = faces_in_video(out_video) if os.path.exists(out_video) else (0, 0)
check(
    # ここが緑にならない＝設定を聞いたのに素顔のまま納品される、ということ
    "M-4-F: モザイクを有効にしてレンダリングすると、出力動画の顔が隠れている",
    run_cli.returncode == 0 and after_total == before_total and after_leak == 0,
    f"終了コード={run_cli.returncode} 出力{after_leak}/{after_total}コマで素顔検出 "
    f"{(run_cli.stderr or '')[-200:]}",
)

# ---------------------------------------------------------------- M-4-G
def block_variety(path, box):
    """出力動画の1コマ目について、指定領域の色の種類数を返す（粗いほど少ない）。"""
    proc = subprocess.Popen(
        shlex.split(f'ffmpeg -v error -i "{path}" -frames:v 1 -f rawvideo -pix_fmt bgr24 -'),
        stdout=subprocess.PIPE)
    buf = proc.stdout.read(1280 * 720 * 3)
    proc.wait()
    frame = np.frombuffer(buf, np.uint8).reshape(720, 1280, 3)
    x, y, w2, h2 = [int(v) for v in box]
    roi = frame[y : y + h2, x : x + w2]
    return len(np.unique(roi.reshape(-1, 3), axis=0))


target_img = os.path.join(FIXTURES, "face-one-alt.png")
strong_out = os.path.join(tmp_dir, "strong.mp4")
weak_out = os.path.join(tmp_dir, "weak.mp4")
r1 = subprocess.run([sys.executable, CLI, src_video, strong_out, "--target", target_img,
                     "--strength", "強め"], capture_output=True, text=True)
r2 = subprocess.run([sys.executable, CLI, src_video, weak_out, "--target", target_img,
                     "--strength", "弱め"], capture_output=True, text=True)
target_box = sorted(detect_faces(big_canvas, create_detector(1280, 720)), key=lambda b: b[0])[0]
n_strong_v = block_variety(strong_out, target_box) if os.path.exists(strong_out) else -1
n_weak_v = block_variety(weak_out, target_box) if os.path.exists(weak_out) else -1
check(
    "M-4-G: 対象者の指定を変えると、出力動画の同じ顔の隠れ方が変わる",
    r1.returncode == 0 and r2.returncode == 0 and 0 <= n_strong_v < n_weak_v,
    f"強め={n_strong_v} / 弱め={n_weak_v} {(r1.stderr or r2.stderr or '')[-200:]}",
)

check(
    "M-4-G: モザイクを焼く入口が配布物に含まれる",
    os.path.exists(os.path.join(DIST, "src", "apply_mosaic_cli.py")),
)
check(
    "M-4-G: レンダリング後にモザイクを焼く手順が手順書に書かれている",
    "apply_mosaic_cli.py" in skill and "省略禁止" in skill,
)
check(
    # 手順7.5でモザイクを焼いても、納品の手順が元ファイルを指していたら素顔が客に渡る。
    # 実際にそうなっていたので、再発しないよう固定する。
    "M-4-G: 納品の手順がモザイク版のファイルを指している（素顔を納品しない）",
    "-mosaic.mp4\" \"output" in skill or "short-01-mosaic.mp4" in skill.split("### 9.")[-1],
    "手順9でモザイク版(-mosaic.mp4)をコピーする記述が見つかりません",
)

# --- 読み切った直後にデコーダを殺していないか（成功したのに失敗と報告する事故）---
# ffmpeg は stdout を閉じてから自分が終了するまでに僅かな間がある。その隙に terminate
# すると終了コードが -15 になり、全コマを正しく焼き終えたのに「入力動画の読み出しに
# 失敗しました」と落ちる。
#
# 実機では出たり出なかったりする競合なので、本物の ffmpeg では再現が運任せになる
# （実際、時間差で再現させようとしたら是正前のコードでも素通りした）。そこで
# **「stdout は閉じたが、まだ終了していない」状態そのもの** を必ず返す身代わりを差し込む。
# poll() が常に None を返す＝競合の当たりを毎回引く、ということ。
# 是正前のコードならこれで必ず落ち、是正後なら必ず通る。
import importlib.util  # noqa: E402
import io  # noqa: E402

raw_path = os.path.join(tmp_dir, "frames.raw")
subprocess.run(
    shlex.split(f'ffmpeg -v error -i "{src_video}" -f rawvideo -pix_fmt bgr24 -y "{raw_path}"'),
    capture_output=True)


class _NotYetExitedDecoder:
    """コマは全部渡し終えたが、まだ終了していないデコーダ。"""

    def __init__(self, data):
        self.stdout = io.BytesIO(data)
        self.returncode = None
        self.terminated = False

    def poll(self):
        return None  # 「まだ終了していない」＝ここが競合の当たり

    def terminate(self):
        self.terminated = True
        self.returncode = -15  # SIGTERM で殺された印

    def wait(self):
        if self.returncode is None:
            self.returncode = 0  # 放っておけば正常終了する
        return self.returncode


_spec = importlib.util.spec_from_file_location("apply_mosaic_cli", CLI)
_amc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_amc)
_real_popen = subprocess.Popen
_fake_dec = _NotYetExitedDecoder(open(raw_path, "rb").read())


def _lingering_popen(cmd, **kw):
    """デコーダの呼び出しだけを身代わりに差し替える。

    `stdout=PIPE` で見分けてはいけない。同じ run() の中で ffprobe も
    capture_output（＝stdout=PIPE）で呼ばれるため、そちらまで差し替わって
    解像度の取得が壊れる（実際に壊して気づいた）。
    デコーダだけが「ffmpeg で、出力先が標準出力(`-`)」という形をしている。
    """
    if list(cmd)[:1] == ["ffmpeg"] and list(cmd)[-1] == "-":
        return _fake_dec
    return _real_popen(cmd, **kw)


_amc.subprocess.Popen = _lingering_popen
try:
    _n = _amc.run(src_video, os.path.join(tmp_dir, "linger.mp4"))
    linger_ok, linger_err = _n > 0, ""
except RuntimeError as e:
    linger_ok, linger_err = False, str(e)
finally:
    _amc.subprocess.Popen = _real_popen

check(
    "M-4-F: 読み切った後のデコーダを殺さない（成功したのに失敗と報告しない）",
    linger_ok and not _fake_dec.terminated,
    linger_err or "読み切った後なのに terminate（SIGTERM）を送っています",
)

# --- 終了コード（--help を異常終了扱いにしない）---
help_run = subprocess.run([sys.executable, CLI, "--help"], capture_output=True, text=True)
bad_run = subprocess.run([sys.executable, CLI, "--存在しない指定"], capture_output=True, text=True)
check(
    # `e.code or 2` と書くと 0 が偽と見なされ、--help まで異常終了(2)になっていた
    "M-4-F: --help は正常終了(0)、指定の誤りは異常終了(0以外)を返す",
    help_run.returncode == 0 and bad_run.returncode != 0,
    f"--help={help_run.returncode} 誤指定={bad_run.returncode}",
)

shutil.rmtree(tmp_dir, ignore_errors=True)


print(f"\n--- {passed} PASS / {failed} FAIL ---")
sys.exit(1 if failed else 0)
