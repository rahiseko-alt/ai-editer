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

# 「顔の周り」＝顔枠の外側にこの画素数だけ余白を取った矩形。比較から除外する。
# 実装が隠すのは expand_box(MARGIN_RATIO=0.18) により検出枠の1.36倍（112x139。実測）だが、
# 隠した所の境目には x264 の圧縮ノイズがそこからさらに滲む。実測(2026-08-08)では
# 差が4を超えた画素は顔枠から最大68px（左57/右59/上63/下68）までで、+64px の外は最大5、
# +80px の外は最大4だった。ノイズの届く距離は顔の大きさではなく符号化ブロックで決まるので、
# 顔枠の「倍率」ではなく px の余白で定める。
FACE_MARGIN_PX = 80
# 許容する階調差。モザイクを掛けると符号化のビット配分が変わり、画面全体に最大4の差が薄く出る
# （実測）。版差を見て8まで許すが、緩めすぎて壊れを見逃していないことは下の3つの対照で示す。
PIXEL_TOLERANCE = 8

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


def outside_face_mask(boxes):
    """顔枠＋余白（＝比較から除く「顔の周り」）を False にした真偽マップを返す。"""
    mask = np.ones((H, W), dtype=bool)
    for (bx, by, bw, bh) in boxes:
        x0, y0 = max(0, int(bx) - FACE_MARGIN_PX), max(0, int(by) - FACE_MARGIN_PX)
        x1 = min(W, int(bx + bw) + FACE_MARGIN_PX)
        y1 = min(H, int(by + bh) + FACE_MARGIN_PX)
        mask[y0:y1, x0:x1] = False
    return mask


def worst_diff(ref, test, mask):
    """「顔の周り」を除いた画素の、全コマを通じた最大の階調差。"""
    worst = 0
    for a, b in zip(ref, test):
        d = cv2.absdiff(a, b).max(axis=2)
        worst = max(worst, int(d[mask].max()))
    return worst


def main():
    work = tempfile.mkdtemp(prefix="vs-mosaic-ui-")
    out_dir = os.path.join(work, "output", "job1")
    stash_dir = os.path.join(work, "work", "job1", "pre-mosaic")
    os.makedirs(out_dir, exist_ok=True)

    try:
        clip = os.path.join(out_dir, "short-01-test.mp4")
        build_material_r(clip)
        check(os.path.exists(clip), "素材R（1人・16:9・15fps・2秒）を合成した")

        plain_src = read_frames(clip)
        check(len(plain_src) == FRAMES, f"素材Rが{FRAMES}コマである(実={len(plain_src)})")

        # 比較の基準は、モザイク工程と同じエンコーダを一度通した動画にする。
        # 素材Rそのものと比べると、モザイクの境目に出る x264 の圧縮ノイズが
        # 顔から離れた場所まで滲み、実装が正しくても差分として出てしまう
        # （それを避けようと除外範囲を広げるのは、原因と違う場所を緩めることになる）。
        baseline = os.path.join(work, "baseline.mp4")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", clip,
                        "-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
                        "-pix_fmt", "yuv420p", baseline], check=True)
        plain = read_frames(baseline)
        check(len(plain) == FRAMES, f"基準(同じエンコーダを通した素材R)が{FRAMES}コマである(実={len(plain)})")

        det = create_detector(W, H)

        # ── 対照（G-EDIT-MOSAIC-UI-B も兼ねる） ──────────────────
        # モザイクを掛けていない入力で素顔が全コマ検出できることを先に確認する。
        # これが無いと、検出器がこの素材の素顔を元々検出できない場合に
        # モザイク処理をしなくても「0件」で合格してしまう。
        before = faces_per_frame(plain_src, det)
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
        # 「顔の周り」（顔枠＋80px）を除いた領域を、同じエンコーダを通した基準と比べる。
        # 除外矩形は 241x263 ＝ 画面の約6.9%。残り93%に差が出れば落ちる。
        boxes = detect_faces(plain_src[0], det)
        mask = outside_face_mask(boxes)
        worst = worst_diff(plain, after, mask) if same_size else 255
        check(same_size and worst <= PIXEL_TOLERANCE,
              f"C: 顔の周り(顔枠+{FACE_MARGIN_PX}px)を除いた画素が基準と一致する"
              f"（最大差={worst}、許容{PIXEL_TOLERANCE}）")

        # ── C の対照: この判定が「壊れ」を実際に検出できることを示す ──────
        # 許容を8まで緩めているので、緩めすぎて素通しになっていないことを、
        # わざと壊した3種類の絵で確かめる（どれも許容を超えなければならない）。
        black = [np.zeros_like(f) for f in plain]
        check(worst_diff(plain, black, mask) > PIXEL_TOLERANCE,
              "対照C: 出力が真っ黒なら、この判定は落ちる")

        brighter = [cv2.add(f, PIXEL_TOLERANCE + 1) for f in plain]
        check(worst_diff(plain, brighter, mask) > PIXEL_TOLERANCE,
              f"対照C: 画面全体が{PIXEL_TOLERANCE + 1}段階明るいだけでも、この判定は落ちる")

        # 顔から離れた隅に別の絵が紛れ込んだ場合。除外矩形の外もちゃんと見ていることを示す。
        stained = []
        for f in plain:
            g = f.copy()
            g[20:60, 20:60] = 255
            stained.append(g)
        check(worst_diff(plain, stained, mask) > PIXEL_TOLERANCE,
              "対照C: 顔から離れた隅に別の絵が入っても、この判定は落ちる")

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

        # ── 途中で失敗したときに素顔と加工済みを混在させない ──
        # 1本ずつ確定する作りだと、2本目で失敗したとき「1本目＝加工済み／2本目＝素顔」が
        # 成果物フォルダに並び、candidates.json も書き換わらないまま素顔を指す。
        # これは葉Fが防ごうとしている状況そのもの（人の注意力頼み）なので、
        # 全部そろってから確定していることを機械で押さえる。
        f_dir = os.path.join(work, "output", "job2")
        os.makedirs(f_dir, exist_ok=True)
        ok_clip = os.path.join(f_dir, "a.mp4")
        build_material_r(ok_clip)
        with open(os.path.join(f_dir, "b.mp4"), "wb") as f:
            f.write(b"not a video")   # 2本目は必ず失敗する
        json.dump(
            {"id": "job2", "digest": None,
             "candidates": [{"file": "a.mp4", "path": ok_clip},
                            {"file": "b.mp4", "path": os.path.join(f_dir, "b.mp4")}]},
            open(os.path.join(f_dir, "candidates.json"), "w", encoding="utf-8"),
        )
        r2 = subprocess.run(["node", STAGE_MJS, f_dir, os.path.join(work, "work", "job2", "pre-mosaic")],
                            capture_output=True, text=True)
        check(r2.returncode != 0, "途中で失敗したら工程全体が失敗として終わる")
        left2 = sorted(os.listdir(f_dir))
        masked_left = [n for n in left2 if n.endswith("-mosaic.mp4")]
        check(masked_left == [],
              f"失敗時に作りかけのモザイク版が残らない（実={masked_left}）")
        check("a.mp4" in left2 and "b.mp4" in left2,
              f"失敗時は素顔だけの状態に戻る＝混在しない（実={left2}）")

    finally:
        shutil.rmtree(work, ignore_errors=True)

    print(f"\n--- {'ALL PASS' if fail == 0 else str(fail) + ' FAIL'} ---")
    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()
