"""顔モザイクを画面から使えることの実機検証（G-EDIT-MOSAIC-UI）。

ロードマップの素材R（親ノード G-EDITOR の detail で凍結）を合成し、
モザイク工程 src/apply-mosaic-stage.mjs を実際に走らせて出来上がりの絵で判定する。

判定は「設定値がサブプロセスへ渡ったか」ではなく出来上がりの絵で行う。
また「モザイクを掛けたら顔が0件」だけでは、検出器がこの素材の素顔を元々検出できない場合に
モザイク処理をしなくても合格してしまうため、**掛けていない側で30/30検出できること**を
対照として先に確認する。

実行: python3 tests/mosaic-ui-check.py   (全PASSで exit 0)
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "src"))

from face_mosaic import create_detector, detect_faces  # noqa: E402

FIXTURE = os.path.join(HERE, "fixtures", "face-one.png")
STAGE_MJS = os.path.join(ROOT, "src", "apply-mosaic-stage.mjs")

# 素材R（G-EDITOR の detail で凍結した合成手順）
W, H, FPS, SECONDS = 1280, 720, 15, 2
FRAMES = FPS * SECONDS          # 30 コマ。全数測定するので短く固定する
BG = (128, 128, 128)            # 黒以外の既知色
FACE_RATIO = 0.30               # 顔の高さ ＝ 映像高さの30%
FACE_NEIGHBORHOOD = 3.0         # 「顔の周り」＝顔枠の縦横3.0倍（実装が隠す範囲の実測 約2.4倍に余裕を見た値）

fail = 0


def check(cond, msg):
    global fail
    print(f"{'PASS' if cond else 'FAIL'} {msg}")
    if not cond:
        fail += 1
    return cond


def build_material_r(path):
    """素材R を合成する。全コマ同一の絵・無音・15fps・2秒。"""
    face = cv2.imread(FIXTURE, cv2.IMREAD_COLOR)
    if face is None:
        raise RuntimeError(f"固定素材を読めません: {FIXTURE}")
    scale = (H * FACE_RATIO) / face.shape[0]
    face = cv2.resize(face, (max(1, int(face.shape[1] * scale)), max(1, int(face.shape[0] * scale))))
    frame = np.full((H, W, 3), BG, dtype=np.uint8)
    y = (H - face.shape[0]) // 2
    x = (W - face.shape[1]) // 2
    frame[y:y + face.shape[0], x:x + face.shape[1]] = face

    writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
    for _ in range(FRAMES):
        writer.write(frame)
    writer.release()
    return frame


def read_frames(path):
    cap = cv2.VideoCapture(path)
    out = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        out.append(f)
    cap.release()
    return out


def faces_per_frame(frames, detector):
    return [len(detect_faces(f, detector)) for f in frames]


def main():
    work = tempfile.mkdtemp(prefix="vs-mosaic-ui-")
    out_dir = os.path.join(work, "output", "job1")
    stash_dir = os.path.join(work, "work", "job1", "pre-mosaic")
    os.makedirs(out_dir, exist_ok=True)

    try:
        clip = os.path.join(out_dir, "short-01-test.mp4")
        build_material_r(clip)
        check(os.path.exists(clip), "素材R（1人・16:9・15fps・2秒）を合成した")

        plain = read_frames(clip)
        check(len(plain) == FRAMES, f"素材Rが{FRAMES}コマである(実={len(plain)})")

        det = create_detector(W, H)

        # ── 対照（G-EDIT-MOSAIC-UI-B も兼ねる） ──────────────────
        # モザイクを掛けていない入力で素顔が全コマ検出できることを先に確認する。
        # これが無いと、検出器がこの素材の素顔を元々検出できない場合に
        # モザイク処理をしなくても「0件」で合格してしまう。
        before = faces_per_frame(plain, det)
        hit_before = sum(1 for n in before if n > 0)
        check(hit_before == FRAMES,
              f"対照: モザイク無しでは素顔が {hit_before}/{FRAMES} コマで検出できる")

        # ── モザイク工程を実行 ────────────────────────────────
        cand = {
            "id": "job1", "mode": "topic", "generated": 1, "digest": None,
            "candidates": [{"file": os.path.basename(clip), "path": clip}],
        }
        with open(os.path.join(out_dir, "candidates.json"), "w", encoding="utf-8") as f:
            json.dump(cand, f, ensure_ascii=False)

        r = subprocess.run(["node", STAGE_MJS, out_dir, stash_dir],
                           capture_output=True, text=True)
        if not check(r.returncode == 0, "モザイク工程が正常終了する"):
            print("      " + (r.stderr or "")[-800:])
            return

        masked_name = "short-01-test-mosaic.mp4"
        masked = os.path.join(out_dir, masked_name)
        check(os.path.exists(masked), "モザイク版の動画が生成された")

        # ── A: 出力から素顔が消えている ───────────────────────
        after = read_frames(masked)
        check(len(after) == FRAMES, f"モザイク版も{FRAMES}コマである(実={len(after)})")
        hit_after = sum(1 for n in faces_per_frame(after, create_detector(W, H)) if n > 0)
        check(hit_after == 0,
              f"A: モザイク版で素顔が検出されるコマが 0/{FRAMES}（実={hit_after}）")

        # ── C: 顔以外の絵と寸法・コマ数が元のまま ─────────────
        same_size = after and after[0].shape == plain[0].shape
        check(bool(same_size), "C: 解像度が入力と一致する")
        # 「顔の周り」を除いた領域を比べる。実装は顔枠に余白を付け、さらに検出の間隔中は
        # コマ間で枠を保持するため、隠される範囲は検出枠より大きくなる。実測(2026-08-08)では
        # 検出枠の約2.4倍だったので、顔中心から縦横3.0倍の矩形を「顔の周り」と定める。
        # この矩形は画面全体の8%程度なので、出力が真っ黒・別の絵・引き伸ばしのいずれでも
        # 残り92%に差が出て落ちる。再エンコード誤差を見込んで階調差4まで許す。
        boxes = detect_faces(plain[0], det)
        mask = np.ones((H, W), dtype=bool)
        for (bx, by, bw, bh) in boxes:
            cx, cy = bx + bw / 2, by + bh / 2
            hw, hh = bw * FACE_NEIGHBORHOOD / 2, bh * FACE_NEIGHBORHOOD / 2
            x0, y0 = max(0, int(cx - hw)), max(0, int(cy - hh))
            x1, y1 = min(W, int(cx + hw)), min(H, int(cy + hh))
            mask[y0:y1, x0:x1] = False
        worst = 0
        if same_size:
            for a, b in zip(plain, after):
                d = cv2.absdiff(a, b).max(axis=2)
                worst = max(worst, int(d[mask].max()))
        check(same_size and worst <= 4,
              f"C: 顔の周り(顔枠の3.0倍)を除いた画素が入力と一致する（最大差={worst}、許容4）")

        # ── D: 素顔が候補一覧に出てこない ─────────────────────
        with open(os.path.join(out_dir, "candidates.json"), encoding="utf-8") as f:
            after_cand = json.load(f)
        listed = [c["file"] for c in after_cand["candidates"]]
        check(listed == [masked_name], f"D: 候補一覧がモザイク版だけを指す（実={listed}）")

        # ── E / F: 素顔の実体が成果物フォルダに残らない ────────
        # 実体が output/<id>/ の外にあるので、名前を直接指定するAPI(/api/clips/:id/:file)も
        # 到達できない（このAPIは output/<id>/ の下しか配信しないため）。
        left = sorted(os.listdir(out_dir))
        check(os.path.basename(clip) not in left,
              f"F: 成果物フォルダに素顔のファイルが残っていない（実={left}）")
        check(os.path.exists(os.path.join(stash_dir, os.path.basename(clip))),
              "F: 素顔のファイルは成果物フォルダの外へ退避されている")

    finally:
        shutil.rmtree(work, ignore_errors=True)

    print(f"\n--- {'ALL PASS' if fail == 0 else str(fail) + ' FAIL'} ---")
    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()
