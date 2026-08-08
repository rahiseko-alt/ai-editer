"""video-shorts [6] 顔モザイク — 顔を検出し、動いても追従したままモザイクで隠す。

ロードマップ M-1（顔を自動で見つけて隠せる）の実装。

設計上の必須事項（着手前の実機検証で実際に踏んだ落とし穴。roadmap の M-1-B / M-1-D 参照）:
  - フレーム間の対応付けは **トラックID** で行う。検出順で対応付けて補間すると、
    人物の並びが入れ替わった瞬間に枠が別人へ飛び、素顔が露出する。
  - モザイクの粗さは **固定px ではなく顔サイズに対する比** で決める。顔の高さ250pxに対し
    ブロック8px以下では顔検出も本人識別も通ってしまう（実測: 類似度0.76〜0.95）。

顔検出は YuNet（MIT・src/models/ に同梱）を opencv-python 同梱の cv2.FaceDetectorYN で使う。
PyTorch や onnxruntime は不要。
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass, field

try:
    import cv2
except ImportError:  # 客の環境で未導入のとき、スタックトレースではなく直せる指示を出す
    sys.stderr.write(
        "[ERROR] opencv 未インストール。`pip install -r requirements.txt` を実行してください"
        "（顔モザイクに必要です。`pip` が無ければ `pip3` / `python -m pip` を試してください）。\n"
    )
    sys.exit(3)

import numpy as np

_MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")
MODEL_PATH = os.path.join(_MODELS_DIR, "face_detection_yunet_2023mar.onnx")
RECOGNIZER_PATH = os.path.join(_MODELS_DIR, "face_recognition_sface_2021dec.onnx")

# 検出のしきい値。低くすると拾いすぎ、高くすると横顔を落とす。
SCORE_THRESHOLD = 0.6
NMS_THRESHOLD = 0.3

# 同一人物と判定するコサイン類似度のしきい値（SFace の配布元が推奨する値）。
# 公有画像での実測は、同一人物(撮影年が13年違う2枚)で0.63、別人どうしで0.18〜0.25。
# 判定を緩める（下げる）と別人を対象者と誤認しやすくなり、隠すべきでない人に強いモザイクが
# かかる。逆に上げすぎると対象者を取り逃す。取り逃しはプライバシー事故に直結するため、
# 迷う場合はしきい値を下げるのではなく「未登録の人にも既定のモザイクをかける」で守る。
RECOGNITION_THRESHOLD = 0.363

# 1つのトラックにつき何回まで照合するか。毎フレーム照合しても結論はほとんど変わらないのに
# 費用だけ増えるため、数回の多数決で確定させる（実測: 60秒の動画で照合7秒 -> 0.13秒）。
RECOGNITION_VOTES = 3

# 顔の高さに対するモザイク1ブロックの比と、絶対値の下限。
#
# 「顔として検出されなくなる最小ブロック」を実測すると、比率だけでも絶対値だけでも足りない:
#     顔高さ  65px -> 最小  7px（顔高さの 1/9）
#     顔高さ 111px -> 最小  9px（顔高さの 1/12）
#     顔高さ 181px -> 最小 10px（顔高さの 1/18）
#     顔高さ 290px -> 最小 10px（顔高さの 1/29）
# 小さい顔ほど必要な「比」が大きくなり、大きい顔では絶対値が 10px 前後で頭打ちになる。
# よって ratio と最小px の両方を効かせる（max を取る）。
# ratio=1/8 は最も厳しい 1/9 に余裕を持たせた値。BLOCK_MIN_PX=12 は絶対値側の 10px に余裕を足した値。
#
# なお上表は「機械が顔として検出できなくなる」境界であって「人が本人と分からなくなる」境界ではない。
# 大きく写った顔ほど比を効かせて粗くするのは、人の目に対する保護を優先しているため。
BLOCK_RATIO_DEFAULT = 1.0 / 8.0
BLOCK_MIN_PX = 12
# 隠す矩形を顔枠より広げる比（髪・顎・輪郭を含めるため）。
MARGIN_RATIO = 0.18

# 検出だけを行うときの横幅。**出力の解像度・画質はこの値に関係なく一切落ちない**
# （縮小するのは検出用のコピーだけで、モザイクは原寸のフレームに焼く）。
#
# ただし縮小すると「小さく写った顔を取りこぼす」。1080p素材での実測:
#     検出幅1920 -> 顔高さ 20px まで検出できる / 60秒の検出に 111.8秒
#     検出幅1280 -> 顔高さ 25px まで          / 55.5秒
#     検出幅 960 -> 顔高さ 30px まで          / 30.3秒
#     検出幅 640 -> 顔高さ 45px まで          / 13.4秒
#     検出幅 480 -> 顔高さ 65px まで          /  8.3秒
#     検出幅 320 -> 顔高さ 95px まで          /  4.2秒
# 既定は 960。1080p で顔高さ30px は画面高の約2.8%（かなり遠くの通行人相当）で、
# ここを下回る顔まで隠したい素材では detect_width を上げる。速度と保護のつまみ。
DETECT_WIDTH_DEFAULT = 960
# 何フレームおきに検出するか。間は直前と次の検出をトラックIDで対応付けて補間する。
# 顔高さ245pxで動きの速さを変えて素顔が出るコマを実測した結果:
#     3px/コマ・8px/コマ・15px/コマ -> 間引き1〜5のいずれでも 0/40コマ
#    30px/コマ(1秒で画面をほぼ横断する速さ) -> 間引き5でだけ 1/40コマ
# 実際の取材映像は15px/コマ以下に収まるため、既定3でも取りこぼしは出ない。
DETECT_EVERY_DEFAULT = 3

# 検出が途切れたとき、直前の位置で隠しを継続する最大フレーム数。
# 横を向いた・手で顔を触った程度の一瞬の欠落を埋める。
HOLD_FRAMES_DEFAULT = 8
# 同一トラックとみなす中心距離の上限（顔の幅で正規化した値）。
MATCH_DISTANCE_RATIO = 1.5


@dataclass
class Track:
    """1人ぶんの追跡状態。id はフレームをまたいで不変（＝補間の対応付けに使う正）。"""

    id: int
    box: tuple[float, float, float, float]
    missed: int = 0
    seen: bool = False
    label: str = "_other"
    votes: dict[str, int] = field(default_factory=dict)


def create_detector(width: int, height: int, model_path: str = MODEL_PATH):
    """YuNet 検出器を作る。model_path が無ければ理由の分かる例外にする（サイレント失敗禁止）。"""
    if not os.path.exists(model_path):
        raise FileNotFoundError(
            f"顔検出モデルが見つかりません: {model_path}\n"
            "配布物に同梱されているはずのファイルです。src/models/ を確認してください。"
        )
    det = cv2.FaceDetectorYN.create(model_path, "", (width, height), SCORE_THRESHOLD, NMS_THRESHOLD, 5000)
    det.setInputSize((width, height))
    return det


def detect_faces_raw(image, detector=None):
    """YuNet の生の検出行を返す。矩形に加えて目・鼻・口の位置を含む。

    顔の向きを揃えてから照合する（alignCrop）のに特徴点が要るので、識別ではこちらを使う。
    """
    h, w = image.shape[:2]
    det = detector if detector is not None else create_detector(w, h)
    det.setInputSize((w, h))
    _, faces = det.detect(image)
    return [] if faces is None else list(faces)


def detect_faces(image, detector=None) -> list[tuple[float, float, float, float]]:
    """画像から顔の矩形 (x, y, w, h) を返す。検出ゼロなら空リスト。"""
    return [
        (float(b[0]), float(b[1]), float(b[2]), float(b[3]))
        for b in detect_faces_raw(image, detector)
    ]


def create_recognizer(model_path: str = RECOGNIZER_PATH):
    """SFace 識別器を作る。model_path が無ければ理由の分かる例外にする。"""
    if not os.path.exists(model_path):
        raise FileNotFoundError(
            f"顔識別モデルが見つかりません: {model_path}\n"
            "配布物に同梱されているはずのファイルです。src/models/ を確認してください。"
        )
    return cv2.FaceRecognizerSF.create(model_path, "")


def face_signature(image, raw_face, recognizer=None):
    """1つの顔から、人物を見分けるための特徴（128次元）を取り出す。"""
    rec = recognizer if recognizer is not None else create_recognizer()
    return rec.feature(rec.alignCrop(image, np.asarray(raw_face, dtype=np.float32))).copy()


def same_person(sig_a, sig_b, recognizer=None, threshold: float = RECOGNITION_THRESHOLD):
    """2つの顔の特徴が同一人物かを返す。(判定, 類似度) の組。"""
    rec = recognizer if recognizer is not None else create_recognizer()
    score = rec.match(sig_a, sig_b, cv2.FaceRecognizerSF_FR_COSINE)
    return score >= threshold, float(score)


def register_person(image_path, name="target", detector=None, recognizer=None):
    """隠したい人の写真1枚から、その人を見分けるための特徴を作る。

    顔が写っていなければ理由の分かる例外にする（黙って「登録できた」ことにしない）。
    """
    image = cv2.imread(image_path)
    if image is None:
        raise FileNotFoundError(f"参照する顔写真が読めません: {image_path}")
    h, w = image.shape[:2]
    det = detector if detector is not None else create_detector(w, h)
    faces = detect_faces_raw(image, det)
    if not faces:
        raise ValueError(
            f"参照写真から顔を見つけられませんでした: {image_path}\n"
            "正面を向いていて、顔が大きく写っている写真を使ってください。"
        )
    biggest = max(faces, key=lambda b: b[2] * b[3])
    return {"name": name, "signature": face_signature(image, biggest, recognizer)}


def block_size_for(face_h: float, ratio: float = BLOCK_RATIO_DEFAULT) -> int:
    """顔の高さから、隠すのに十分なモザイク1ブロックの大きさ(px)を決める。

    固定pxにすると、顔が大きく写った場面で保護が破れる（M-1-D）。
    """
    return max(BLOCK_MIN_PX, int(round(face_h * ratio)))


def expand_box(box, frame_w: int, frame_h: int, margin: float = MARGIN_RATIO):
    """顔枠を輪郭ぶん広げ、画面外へはみ出さないよう丸める。"""
    x, y, w, h = box
    # 縦横それぞれの辺から広げる。顔枠は横より縦が長いので、幅由来の余白を上下にも
    # 使うと縦方向の拡張率が足りず、髪と顎が枠から出る。
    mx = w * margin
    my = h * margin
    x0 = max(0, round(x - mx))
    y0 = max(0, round(y - my))
    x1 = min(frame_w, round(x + w + mx))
    y1 = min(frame_h, round(y + h + my))
    return x0, y0, max(0, x1 - x0), max(0, y1 - y0)


def apply_mosaic(frame, box, block: int | None = None, ratio: float = BLOCK_RATIO_DEFAULT):
    """frame の矩形 box をモザイクで塗りつぶす（frame を破壊的に更新して返す）。"""
    fh, fw = frame.shape[:2]
    x, y, w, h = expand_box(box, fw, fh)
    if w < 2 or h < 2:
        return frame
    blk = block if block is not None else block_size_for(box[3], ratio)
    roi = frame[y : y + h, x : x + w]
    small = cv2.resize(
        roi, (max(1, w // blk), max(1, h // blk)), interpolation=cv2.INTER_AREA
    )
    frame[y : y + h, x : x + w] = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    return frame


class FaceTracker:
    """検出結果をトラックIDへ束ね、検出が途切れた区間を直前の位置で埋める。

    「検出漏れフレームで素顔が出る」を防ぐのが役目（M-1-C）。IoU ではなく顔幅で正規化した
    中心距離で対応付ける（小さく速く動く顔で IoU が 0 になりトラックが切れるため）。
    """

    def __init__(self, hold_frames: int = HOLD_FRAMES_DEFAULT):
        self.hold_frames = hold_frames
        self.tracks: list[Track] = []
        self._next_id = 0
        # 検出が無くて保持で埋めたフレーム番号（確認用静止画の抽出に使う ＝ M-3-A の入力）
        self.held_frames: list[int] = []

    def update(self, boxes, frame_index: int = 0) -> list[Track]:
        """1フレームぶんの検出を取り込み、そのフレームで隠すべきトラック一覧を返す。"""
        for t in self.tracks:
            t.seen = False

        # 検出を順番に見て「空いている中で一番近いトラック」へ割り当てる貪欲法は、
        # 先に処理された検出が、後の検出にとってより近いトラックを奪いうる。
        # 探索半径は顔幅1.5個ぶんなので隣り合った2人は互いの半径に入り、これが起きると
        # 人物が入れ替わる ＝ M-1-B が防ごうとしている当の失敗そのものになる。
        # そこで全ての(検出, トラック)の距離を先に出し、近い順に一意割り当てする。
        # こうすると結果が検出の順序に依存しない。
        pairs = []
        for bi, b in enumerate(boxes):
            cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
            for t in self.tracks:
                tx, ty = t.box[0] + t.box[2] / 2, t.box[1] + t.box[3] / 2
                d = ((cx - tx) ** 2 + (cy - ty) ** 2) ** 0.5 / max(b[2], 1.0)
                if d < MATCH_DISTANCE_RATIO:
                    pairs.append((d, bi, t))
        matched: dict[int, Track] = {}
        for _d, bi, t in sorted(pairs, key=lambda p: p[0]):
            if bi in matched or t.seen:
                continue
            t.seen = True
            matched[bi] = t

        # 入力した検出が、どのトラックに割り当てられたか（入力と同じ並び）。
        # 識別のとき「この顔は誰のトラックか」を位置の突き合わせで推測せずに済むようにする。
        self.last_assignment = []
        for bi, b in enumerate(boxes):
            t = matched.get(bi)
            if t is None:
                self._next_id += 1
                t = Track(id=self._next_id, box=tuple(b))
                t.seen = True
                self.tracks.append(t)
            t.box = tuple(b)
            t.missed = 0
            self.last_assignment.append(t)

        held = False
        for t in self.tracks:
            if not t.seen:
                t.missed += 1
                held = True
        if held:
            self.held_frames.append(frame_index)

        # 保持の上限を超えたトラックは捨てる（居なくなった人を永久に隠し続けない）
        self.tracks = [t for t in self.tracks if t.missed <= self.hold_frames]
        return list(self.tracks)


def interpolate(prev_rows, next_rows, weight: float):
    """2つのキーフレーム間を補間する。対応付けは必ずトラックIDで行う（M-1-B）。

    prev_rows / next_rows は {track_id: (x, y, w, h)}。片側にしか無いトラックは
    そのままの位置で出す（消えかけ・現れかけの顔を取りこぼさない）。
    """
    out: dict[int, tuple[float, float, float, float]] = {}
    for tid, a in prev_rows.items():
        b = next_rows.get(tid)
        if b is None:
            out[tid] = a
        else:
            out[tid] = tuple(a[k] * (1.0 - weight) + b[k] * weight for k in range(4))
    for tid, b in next_rows.items():
        if tid not in prev_rows:
            out[tid] = b
    return out


def mosaic_frames(frames, hold_frames: int = HOLD_FRAMES_DEFAULT, ratio: float = BLOCK_RATIO_DEFAULT,
                  detector=None, block_for=None, people=None, ratio_for=None, recognizer=None,
                  detect_every: int = DETECT_EVERY_DEFAULT, detect_width: int = DETECT_WIDTH_DEFAULT,
                  copy_frames: bool = True, tracker=None):
    """フレーム列を順に処理し、顔を追従モザイクで隠したフレーム列を返す。

    copy_frames=False にすると、渡されたフレームを直接書き換えて複製を省く。
    1080pのフレーム複製は1枚あたり6.2MBの memcpy で、実測では処理時間の9割を占める
    （10秒の素材で 複製15.3秒 / 検出1.5秒 / モザイク描画0.14秒）。動画から読み出した
    フレームをそのまま捨てる経路では複製が純粋な無駄なので False にする。
    呼び出し側が元のフレームを後で使う場合は True のままにすること。

    people に register_person() の結果を並べると、その人だけ隠し方を変えられる（M-2）。
    ratio_for は {人物名: 比} で、登録していない人には既定の比を使う。
    未登録の人にも必ず既定のモザイクはかかる（＝見分けに失敗しても素顔は出ない）。

    block_for(track) を渡すと、ブロックサイズを直接差し替えられる（ratio_for より優先）。
    """
    if detect_every < 1:
        # 0以下だと検出が1回も走らず、モザイクの掛かっていないフレームがそのまま返る。
        # 黙って素通しするのは最悪の失敗なので、ここで止める。
        raise ValueError(f"detect_every は1以上にしてください（受け取った値: {detect_every}）")

    # tracker を渡すと、直前の呼び出しの追従状態を引き継ぐ。長い動画を区切って
    # 処理する呼び出し側（apply_mosaic_cli）で必須。毎回作り直すと、区切りの境目で
    # 「検出が途切れた区間を直前の位置で埋める」保持が必ず切れ、境目の直後で検出が
    # 落ちたコマに素顔が出る（実測: 区切り直後の3コマが未加工のまま出力された）。
    tracker = tracker if tracker is not None else FaceTracker(hold_frames=hold_frames)
    people = people or []
    ratio_for = ratio_for or {}
    rec = recognizer
    if people and rec is None:
        rec = create_recognizer()
    labels_by_id: dict[int, str] = {}

    frames = list(frames)
    if not frames:
        return [], tracker
    fh, fw = frames[0].shape[:2]
    det = detector
    scale = 1.0
    if det is None:
        scale = detection_scale(fw, fh, detect_width)
        det = create_detector(max(1, int(fw * scale)), max(1, int(fh * scale)))

    # --- 1周目: 数フレームおきにだけ検出し、各トラックの位置と人物を出す ---
    # 単一のパスで済ませようとすると「次の検出」が未来にあるため補間できず、最初の区間で
    # 枠が直前の位置に取り残されて素顔が出る。先に位置を出し切ってから焼く。
    keys: dict[int, dict[int, tuple[float, float, float, float]]] = {}
    for i in range(0, len(frames), detect_every):
        work = frames[i]
        # 検出だけ縮小した画で行い、結果を原寸へ戻す（出力の解像度は落とさない）
        small = work if scale == 1.0 else cv2.resize(
            work, (max(1, int(fw * scale)), max(1, int(fh * scale))), interpolation=cv2.INTER_NEAREST
        )
        raw = detect_faces_raw(small, det)
        boxes = [
            (float(b[0]) / scale, float(b[1]) / scale, float(b[2]) / scale, float(b[3]) / scale)
            for b in raw
        ]
        tracker.update(boxes, frame_index=i)

        # 誰かを見分ける必要があるときだけ照合する。トラックごとに数回だけ数えて確定させ、
        # 毎フレーム照合しない（結論は変わらないのに費用だけ増えるため）。
        if people:
            for b, tgt in zip(raw, tracker.last_assignment):
                if sum(tgt.votes.values()) >= RECOGNITION_VOTES:
                    continue
                try:
                    sig = face_signature(small, b, rec)
                except cv2.error:
                    continue  # 向きが取れない等で特徴を作れない顔は、次の検出で見直す
                label = "_other"
                for p in people:
                    matched_person, _score = same_person(p["signature"], sig, rec)
                    if matched_person:
                        label = p["name"]
                        break
                tgt.votes[label] = tgt.votes.get(label, 0) + 1
                tgt.label = max(tgt.votes, key=tgt.votes.get)

        keys[i] = {t.id: t.box for t in tracker.tracks}
        for t in tracker.tracks:
            labels_by_id[t.id] = t.label

    # --- 2周目: 全フレームへ焼く。検出していない間はトラックIDで対応付けて補間する ---
    out = []
    for i, frame in enumerate(frames):
        work = frame.copy() if copy_frames else frame
        k0 = (i // detect_every) * detect_every
        a = keys.get(k0, {})
        b = keys.get(k0 + detect_every)
        if b is None:
            # フレーム数が detect_every で割り切れないときの末尾。次の検出が無いので
            # 直前の位置を流用する＝枠が古い。ここは素顔が残りうるので確認対象に入れる。
            draw = a
            if a and i > k0:
                tracker.held_frames.append(i)
        else:
            draw = interpolate(a, b, (i - k0) / detect_every)
        for tid, box in draw.items():
            if block_for is not None:
                apply_mosaic(work, box, block=block_for(tid), ratio=ratio)
            else:
                apply_mosaic(work, box, ratio=ratio_for.get(labels_by_id.get(tid, "_other"), ratio))
        out.append(work)
    return out, tracker


def detection_scale(frame_w: int, frame_h: int, detect_width: int = DETECT_WIDTH_DEFAULT) -> float:
    """検出だけを行う縮小率。既に十分小さい画はそのまま使う（拡大はしない）。"""
    if detect_width <= 0 or frame_w <= detect_width:
        return 1.0
    return detect_width / float(frame_w)


def review_frames(tracker, total_frames: int, margin: int = 2) -> list[int]:
    """人が確認すべきコマ番号を返す（M-3-A）。

    「検出が途切れて直前の位置で埋めたコマ」＝隠しそこねている可能性が最も高い場面。
    全編を目視させるのは現実的でないので、機械が既に把握しているここだけを提示する。
    前後 margin コマも含めるのは、途切れの入り口と出口が実際にずれやすいため。
    """
    marked = set()
    for i in set(tracker.held_frames):
        for k in range(i - margin, i + margin + 1):
            if 0 <= k < total_frames:
                marked.add(k)
    return sorted(marked)


def write_review_images(frames, indices, out_dir, prefix="review"):
    """確認用の静止画を書き出す（M-3-A）。書き出したパスを返す。"""
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for i in indices:
        if not (0 <= i < len(frames)):
            continue
        path = os.path.join(out_dir, f"{prefix}-{i:06d}.png")
        if not cv2.imwrite(path, frames[i]):
            # imwrite は失敗しても例外を出さず False を返す。書けていないパスを
            # 「書き出した」として返すと、確認したつもりの取りこぼしが生まれる。
            raise OSError(f"確認用の静止画を書き出せませんでした: {path}")
        written.append(path)
    return written


def apply_manual_masks(frames, masks, ratio: float = BLOCK_RATIO_DEFAULT):
    """手で指定した隠しを、指定コマの範囲へ後から足す（M-3-B）。

    masks は {"start": 開始コマ, "end": 終了コマ(含む), "box": (x, y, w, h)} の並び。
    自動処理が取りこぼした場面を、作り直さずに塞ぐための経路。
    """
    for m in masks:
        start = max(0, int(m["start"]))
        end = min(len(frames) - 1, int(m["end"]))
        box = tuple(float(v) for v in m["box"])
        for i in range(start, end + 1):
            apply_mosaic(frames[i], box, block=m.get("block"), ratio=m.get("ratio", ratio))
    return frames


def write_face_choices(frames, out_dir, detect_every: int = DETECT_EVERY_DEFAULT,
                       detect_width: int = DETECT_WIDTH_DEFAULT, margin: float = 0.5):
    """動画に写っている人を1人ずつ切り出し、番号付きの画像として書き出す（M-4-D）。

    画面（GUI）は作らない方針なので、対象者の指定はこの画像をチャットで見てもらい
    「2番の人」と番号で答えてもらう形にする。出力は work/<id>/faces/ を想定。

    1人につき1枚（最も大きく写っているコマ）だけ出す。同じ人が何枚も並ぶと、
    どれを選べばよいか分からなくなるため。戻り値は [{"index", "path", "track_id"}]。
    """
    frames = list(frames)
    if not frames:
        return []
    fh, fw = frames[0].shape[:2]
    scale = detection_scale(fw, fh, detect_width)
    det = create_detector(max(1, int(fw * scale)), max(1, int(fh * scale)))
    tracker = FaceTracker()

    best: dict[int, tuple[float, int, tuple[float, float, float, float]]] = {}
    for i in range(0, len(frames), max(1, detect_every)):
        work = frames[i]
        small = work if scale == 1.0 else cv2.resize(
            work, (max(1, int(fw * scale)), max(1, int(fh * scale))), interpolation=cv2.INTER_NEAREST
        )
        boxes = [
            (float(b[0]) / scale, float(b[1]) / scale, float(b[2]) / scale, float(b[3]) / scale)
            for b in detect_faces_raw(small, det)
        ]
        tracker.update(boxes, frame_index=i)
        for t in tracker.tracks:
            area = t.box[2] * t.box[3]
            if t.id not in best or area > best[t.id][0]:
                best[t.id] = (area, i, t.box)

    os.makedirs(out_dir, exist_ok=True)
    # 前回の候補が残っていると、今回いない人まで一覧に並び、別の動画の人を選ばせてしまう。
    # この関数が付ける名前(face-<番号>.png)だけを消し、他のファイルには触らない。
    for name in os.listdir(out_dir):
        if re.fullmatch(r"face-\d+\.png", name):
            os.remove(os.path.join(out_dir, name))

    out = []
    # 大きく写っている人から順に番号を振る（手前の人＝指定したい人であることが多い）
    for n, (tid, (_area, frame_i, box)) in enumerate(
        sorted(best.items(), key=lambda kv: -kv[1][0]), start=1
    ):
        x, y, w, h = expand_box(box, fw, fh, margin=margin)
        if w < 2 or h < 2:
            continue
        path = os.path.join(out_dir, f"face-{n}.png")
        if not cv2.imwrite(path, frames[frame_i][y : y + h, x : x + w]):
            raise OSError(f"顔の切り出し画像を書き出せませんでした: {path}")
        out.append({"index": n, "path": path, "track_id": tid})
    return out
