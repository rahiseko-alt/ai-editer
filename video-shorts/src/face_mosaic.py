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
from dataclasses import dataclass, field

import cv2
import numpy as np

MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "face_detection_yunet_2023mar.onnx")

# 検出のしきい値。低くすると拾いすぎ、高くすると横顔を落とす。
SCORE_THRESHOLD = 0.6
NMS_THRESHOLD = 0.3

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


def detect_faces(image, detector=None) -> list[tuple[float, float, float, float]]:
    """画像から顔の矩形 (x, y, w, h) を返す。検出ゼロなら空リスト。"""
    h, w = image.shape[:2]
    det = detector if detector is not None else create_detector(w, h)
    det.setInputSize((w, h))
    _, faces = det.detect(image)
    if faces is None:
        return []
    return [(float(b[0]), float(b[1]), float(b[2]), float(b[3])) for b in faces]


def block_size_for(face_h: float, ratio: float = BLOCK_RATIO_DEFAULT) -> int:
    """顔の高さから、隠すのに十分なモザイク1ブロックの大きさ(px)を決める。

    固定pxにすると、顔が大きく写った場面で保護が破れる（M-1-D）。
    """
    return max(BLOCK_MIN_PX, int(round(face_h * ratio)))


def expand_box(box, frame_w: int, frame_h: int, margin: float = MARGIN_RATIO):
    """顔枠を輪郭ぶん広げ、画面外へはみ出さないよう丸める。"""
    x, y, w, h = box
    m = w * margin
    x0 = max(0, int(round(x - m)))
    y0 = max(0, int(round(y - m)))
    x1 = min(frame_w, int(round(x + w + m)))
    y1 = min(frame_h, int(round(y + h + m)))
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

        for b in boxes:
            cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
            best, best_d = None, MATCH_DISTANCE_RATIO
            for t in self.tracks:
                if t.seen:
                    continue
                tx, ty = t.box[0] + t.box[2] / 2, t.box[1] + t.box[3] / 2
                d = ((cx - tx) ** 2 + (cy - ty) ** 2) ** 0.5 / max(b[2], 1.0)
                if d < best_d:
                    best, best_d = t, d
            if best is None:
                self._next_id += 1
                best = Track(id=self._next_id, box=tuple(b))
                self.tracks.append(best)
            best.box = tuple(b)
            best.seen = True
            best.missed = 0

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
                  detector=None, block_for=None):
    """フレーム列を順に処理し、顔を追従モザイクで隠したフレーム列を返す。

    block_for(track) を渡すと、トラックごとにブロックサイズを差し替えられる（M-2 で使う）。
    """
    tracker = FaceTracker(hold_frames=hold_frames)
    out = []
    det = detector
    for i, frame in enumerate(frames):
        work = frame.copy()
        if det is None:
            det = create_detector(work.shape[1], work.shape[0])
        boxes = detect_faces(work, det)
        for t in tracker.update(boxes, frame_index=i):
            blk = block_for(t) if block_for is not None else None
            apply_mosaic(work, t.box, block=blk, ratio=ratio)
        out.append(work)
    return out, tracker
