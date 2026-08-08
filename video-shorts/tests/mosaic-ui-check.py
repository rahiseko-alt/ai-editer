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

# ── 葉Cの合格ラインは、実測した「床」ひとつから2つの規則で導く ────────────
# 床＝モザイクを掛けると符号化のビット配分が変わるため、顔から十分離れた所にも消えずに
# 残る階調差。ubuntu-24.04 / ffmpeg 6.1.1 での実測(2026-08-08)は 5 で、顔枠+72px より
# 外ではどこまで離れても 5 のまま下がらなかった。
NOISE_FLOOR = 5
# 規則1: 除外幅 ＝ ノイズが床まで減衰する最小の8px刻み。許容とは無関係に、
#        「モザイクの影響が及ぶ距離」だけで決める。実測: +56px→12, +64px→7, +72px→5。
#        ノイズの届く距離は顔の大きさではなく符号化ブロックで決まるため、倍率ではなく px。
FACE_MARGIN_PX = 72
# 規則2: 許容 ＝ 床の2倍。2倍は ffmpeg/x264 の版差ぶんの余裕（CI は ubuntu-24.04 に固定
#        しているが、手元の開発機は別の版を使うため）。安全側の水増しはこの1か所だけに置く。
PIXEL_TOLERANCE = NOISE_FLOOR * 2   # = 10
# 上の2つの数字が後から自由に緩められないよう、境界を絶対値で固定する対照に使う。
# ここを PIXEL_TOLERANCE から導出すると、許容を変えたときに対照も一緒に動いて意味を失う。
TOLERANCE_PASSES_AT = 10        # 階調差10ちょうどは通らなければならない
TOLERANCE_FAILS_AT = 11         # 階調差11は落ちなければならない
# 顔枠+72px の位置は除外の外側の1列目（除外は bx+bw+FACE_MARGIN_PX の手前まで）。
# ここに汚しを置くと、除外幅を73px以上に広げた瞬間に隠れて対照が落ちる＝72pxを上から固定する。
# 73にすると74px以上でしか落ちず、1pxぶん後から緩める余地が残る。
MARGIN_PROBE_PX = 72
# 見ないことにする面積の上下限（画面に対する割合）。mask は実行時に検出した顔枠から作るので、
# 顔検出（OpenCV）の版が変わって枠が大きくなると、免除される面積も黙って広がる。
# ubuntu-24.04 / opencv 5.0.0 での実測は 225x247 ＝ 6.03%。
EXCLUDED_AREA_MAX_PCT = 8.0     # これ以上広いと「見ない範囲」が広がりすぎている
EXCLUDED_AREA_MIN_PCT = 4.0     # これ以下だと顔枠が縮んでいる（実装が隠す範囲を覆えない）

fail = 0


def check(cond, msg):
    global fail
    print(f"{'PASS' if cond else 'FAIL'} {msg}")
    if not cond:
        fail += 1
    return cond


def compose_frame():
    """素材Rの1コマを合成する（符号化前の、数値で確定した絵）。"""
    face = cv2.imread(FIXTURE, cv2.IMREAD_COLOR)
    if face is None:
        raise RuntimeError(f"固定素材を読めません: {FIXTURE}")
    scale = (H * FACE_RATIO) / face.shape[0]
    face = cv2.resize(face, (max(1, int(face.shape[1] * scale)), max(1, int(face.shape[0] * scale))))
    frame = np.full((H, W, 3), BG, dtype=np.uint8)
    y = (H - face.shape[0]) // 2
    x = (W - face.shape[1]) // 2
    frame[y:y + face.shape[0], x:x + face.shape[1]] = face
    return frame


def build_material_r(path, audio=False):
    """素材R を合成する。全コマ同一の絵・15fps・2秒。

    書き出しは libx264rgb の可逆（-qp 0 / bgr24）で行う。cv2.VideoWriter の "mp4v" は
    非可逆で、素材そのものが符号化器の実装差で変わってしまうため使わない
    （素材が版で変わると、下で測るノイズの床も版で変わり、合格ラインの根拠が崩れる）。
    audio=True のときは 440Hz・48000Hz・2秒の正弦波を AAC で足す（葉G用）。
    """
    frame = compose_frame()
    cmd = ["ffmpeg", "-y", "-v", "error",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-"]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={SECONDS}",
                "-c:a", "aac", "-b:a", "128k"]
    cmd += ["-c:v", "libx264rgb", "-qp", "0", "-pix_fmt", "bgr24", path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for _ in range(FRAMES):
        p.stdin.write(frame.tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError(f"素材Rの書き出しに失敗しました: {path}")
    return frame


def probe_stream(path, selector):
    """ffprobe で1本のストリームの fps・尺・コマ数を取る。"""
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", selector,
                        "-show_entries", "stream=r_frame_rate,duration,nb_frames",
                        "-of", "default=nw=1", path], capture_output=True, text=True)
    return dict(l.split("=", 1) for l in r.stdout.strip().split("\n") if "=" in l)


def read_audio_pcm(path):
    """音声を 16bit・48000Hz・モノラルの生データとして取り出す。無音なら空。"""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn",
                        "-f", "s16le", "-ac", "1", "-ar", "48000", "-"],
                       capture_output=True)
    return r.stdout if r.returncode == 0 else b""


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
    # 合格ラインは ubuntu-24.04 / ffmpeg 6.1.1 での実測に基づく。実際に使った版を記録に残す。
    ver = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout
    print(f"[INFO] {ver.splitlines()[0] if ver else 'ffmpeg 不明'}")
    # 顔検出の版でも「見ないことにする範囲」が変わる。ffmpeg と同じく記録に残す。
    print(f"[INFO] opencv {cv2.__version__}")

    work = tempfile.mkdtemp(prefix="vs-mosaic-ui-")
    out_dir = os.path.join(work, "output", "job1")
    stash_dir = os.path.join(work, "work", "job1", "pre-mosaic")
    os.makedirs(out_dir, exist_ok=True)

    try:
        clip = os.path.join(out_dir, "short-01-test.mp4")
        composed = build_material_r(clip)
        check(os.path.exists(clip), "素材R（1人・16:9・15fps・2秒）を合成した")

        plain_src = read_frames(clip)
        check(len(plain_src) == FRAMES, f"素材Rが{FRAMES}コマである(実={len(plain_src)})")
        # 素材Rが可逆であることを機械で押さえる。ここが非可逆に戻ると、素材そのものが
        # 符号化器の版で変わり、下で測るノイズの床（＝合格ラインの土台）が黙って崩れる。
        exact = all(np.array_equal(f, composed) for f in plain_src)
        check(exact, "素材Rを読み戻したコマが、合成した絵と1画素も違わない（可逆であること）")

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
        # 「顔の周り」（顔枠+72px）を除いた領域を、同じエンコーダを通した基準と比べる。
        # 除外矩形は 225x247 ＝ 画面の約6.0%。残り94%に差が出れば落ちる。
        boxes = detect_faces(plain_src[0], det)
        mask = outside_face_mask(boxes)
        excluded_pct = float((~mask).sum()) / (W * H) * 100
        check(EXCLUDED_AREA_MIN_PCT <= excluded_pct <= EXCLUDED_AREA_MAX_PCT,
              f"C: 見ないことにする面積が画面の{EXCLUDED_AREA_MIN_PCT}〜{EXCLUDED_AREA_MAX_PCT}%に収まる"
              f"（実={excluded_pct:.2f}%）")
        worst = worst_diff(plain, after, mask) if same_size else 255
        check(same_size and worst <= PIXEL_TOLERANCE,
              f"C: 顔の周り(顔枠+{FACE_MARGIN_PX}px)を除いた画素が基準と一致する"
              f"（最大差={worst}、許容{PIXEL_TOLERANCE}）")

        # ── C の対照 ────────────────────────────────────────────
        # 許容を床(5)の2倍まで緩め、画面の6%を検査から外しているので、
        # 「緩めすぎて何も検出しない検査」になっていないことを機械で押さえる。
        # 対照の数字は PIXEL_TOLERANCE / FACE_MARGIN_PX から導出しない（絶対値で書く）。
        # 導出すると、後から許容や除外幅を緩めたときに対照も一緒に動いて素通ししてしまう。
        black = [np.zeros_like(f) for f in plain]
        check(worst_diff(plain, black, mask) > PIXEL_TOLERANCE,
              "対照C: 出力が真っ黒なら、この判定は落ちる")

        # (1) 許容の境界を上下から固定する。10は通り、11は落ちる。
        #     許容を厳しくすると前者が、緩めると後者が落ちるので、10という数字が動かせない。
        at_line = [cv2.add(f, TOLERANCE_PASSES_AT) for f in plain]
        check(worst_diff(plain, at_line, mask) <= PIXEL_TOLERANCE,
              f"対照C: 画面全体が{TOLERANCE_PASSES_AT}段階ずれるところまでは通る"
              f"（許容がこれより厳しくないことを固定する）")
        over_line = [cv2.add(f, TOLERANCE_FAILS_AT) for f in plain]
        check(worst_diff(plain, over_line, mask) > PIXEL_TOLERANCE,
              f"対照C: 画面全体が{TOLERANCE_FAILS_AT}段階ずれたら落ちる"
              f"（許容がこれより緩くないことを固定する）")

        # (2) 除外幅の境界を固定する。顔枠+73px の位置に置いた小さな汚しは落ちなければならない。
        #     除外幅を72pxより広げるとこの汚しが除外の中に入り、検出できなくなって落ちる。
        bx, by, bw, bh = boxes[0]
        # 除外の右端は int(bx+bw)+FACE_MARGIN_PX の手前まで（mask と同じ式）。
        # よって int(bx+bw)+72 が「除外の外側の1列目」。汚しはこの1列だけに置く。
        # 幅を持たせると、除外を1px広げても汚しの残りが見えてしまい、72pxを固定できない。
        px = min(W - 1, int(bx + bw) + MARGIN_PROBE_PX)
        py = max(0, int(by + bh / 2) - 4)
        near = []
        for f in plain:
            g = f.copy()
            g[py:py + 8, px:px + 1] = 255
            near.append(g)
        check(worst_diff(plain, near, mask) > PIXEL_TOLERANCE,
              f"対照C: 顔枠+{MARGIN_PROBE_PX}px の1列（除外の外側の1列目）の汚しは落ちる"
              f"（見ないことにする範囲を{MARGIN_PROBE_PX}pxより広げられないことを固定する）")

        # (3) 顔から遠い隅も見ていることを示す。
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

        # ── G: モザイクを掛けても音がそのまま残る ──────────────
        # 素材Rは無音なので、A〜F だけでは音が消える・別物になる壊れ方を一切検出できない。
        # 音付きの素材で、入力と出力の音が同一であることを別の受入事実として押さえる。
        g_dir = os.path.join(work, "output", "job3")
        os.makedirs(g_dir, exist_ok=True)
        g_clip = os.path.join(g_dir, "c.mp4")
        build_material_r(g_clip, audio=True)
        src_pcm = read_audio_pcm(g_clip)
        check(len(src_pcm) > 0, f"対照G: 音付きの素材に音が入っている（実={len(src_pcm)}バイト）")
        # 工程は素顔のファイルを成果物フォルダの外へ移すので、入力側の情報は先に取っておく。
        vin, ain = probe_stream(g_clip, "v:0"), probe_stream(g_clip, "a:0")
        json.dump({"id": "job3", "digest": None,
                   "candidates": [{"file": "c.mp4", "path": g_clip}]},
                  open(os.path.join(g_dir, "candidates.json"), "w", encoding="utf-8"))
        r3 = subprocess.run(["node", STAGE_MJS, g_dir, os.path.join(work, "work", "job3", "pre-mosaic")],
                            capture_output=True, text=True)
        if check(r3.returncode == 0, "音付きの素材でもモザイク工程が正常終了する"):
            g_out = os.path.join(g_dir, "c-mosaic.mp4")
            out_pcm = read_audio_pcm(g_out)
            check(len(out_pcm) > 0, f"G: モザイク版に音が残っている（実={len(out_pcm)}バイト）")
            check(out_pcm == src_pcm,
                  f"G: モザイク版の音が入力と一致する（入力={len(src_pcm)} 出力={len(out_pcm)}バイト）")

            # ── H: 尺と速さが元のまま（音と絵がずれない） ──────────
            # 音のバイト列が一致していても、映像側だけ別のfpsで書き戻されると
            # 絵が早送り／スローになり、音とずれた動画が出来上がる。実装の probe() は
            # r_frame_rate を報告しない素材を無言で 30fps 扱いにする経路を持つので、
            # 「音が同じ」「画素が同じ」とは独立に落ちうる受入事実として別に測る。
            vout, aout = probe_stream(g_out, "v:0"), probe_stream(g_out, "a:0")
            check(vin.get("r_frame_rate") is not None and vout.get("r_frame_rate") == vin.get("r_frame_rate"),
                  f"H: 映像のfpsが入力と一致する（入力={vin.get('r_frame_rate')} 出力={vout.get('r_frame_rate')}）")
            vi, vo = float(vin.get("duration", 0)), float(vout.get("duration", 0))
            check(abs(vi - vo) < 0.005,
                  f"H: 映像の尺が入力と一致する（入力={vi:.3f}秒 出力={vo:.3f}秒）")
            ai, ao = float(ain.get("duration", 0)), float(aout.get("duration", 0))
            check(abs(ai - ao) < 0.005,
                  f"H: 音の尺が入力と一致する（入力={ai:.3f}秒 出力={ao:.3f}秒）")
            check(abs(vo - ao) < 0.005,
                  f"H: 出力の映像と音の尺がそろっている（映像={vo:.3f}秒 音={ao:.3f}秒）")
        else:
            print("      " + (r3.stderr or "")[-800:])

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
