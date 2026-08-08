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
import resource
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "src"))

import apply_mosaic_cli  # noqa: E402
import face_mosaic  # noqa: E402
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
# 尺の一致とみなす差（秒）。素材の1コマ(1/15＝0.067秒)や音声の1パケット(1024/48000＝0.021秒)
# より十分小さく、コマ1つぶんのずれでも検出できる値として置く。
DURATION_TOLERANCE_SEC = 0.005
# コマ番号の目印（素材R-M）。1ビット＝8x8画素の升目を横16個＝128x8画素の帯を画面左上に置く。
MARKER_CELL_PX = 8
MARKER_BITS = 16
# 葉I の素材の長さ。実装の区切り(CHUNK_FRAMES)と先読み(LOOKAHEAD_FRAMES)を実行時に読み、
# それを必ず超える長さにする。直書きすると、メモリ調整で CHUNK_FRAMES を上げた瞬間に
# 区切りをまたがなくなり、何も試していないのに緑のままになる。
# 実クリップ(話題ごとで数分、ダイジェストは既定3分)は必ずこの区切りを超えるので、
# 短い素材だけで測ると「納品物が実際に通る道」を一度も測らないことになる。
I_FRAMES = apply_mosaic_cli.CHUNK_FRAMES + apply_mosaic_cli.LOOKAHEAD_FRAMES + 34
# 素材R-M には「顔が一瞬見つからない区間」を2か所置く（顔画像を90度回して検出させない）。
# 1つ目は真ん中＝この測り方が「隠された」を検出できることを示す対照。
# 2つ目は区切りのちょうど直後＝実装は区切りごとに追従をやり直すため、保持が切れて
# 素顔が出うる場所。全コマ検出できる絵だけで測ると、この経路を永久に測れない。
# 見失いの長さは実装の「保持の予算」から導く。保持は hold_frames 回ぶんの検出を
# 我慢する仕組みで、検出は detect_every コマおきなので、予算はコマ数で
# hold_frames × detect_every ＝ 24 コマ。ここまでは隠し続けられなければならない。
# 短い見失い（6コマ）だけで測ると、境目で保持が縮んでいても気づけない
# （実測: 6コマと18コマは通り、24コマで初めて区切りの所だけ素顔が3コマ出た）。
HOLD_BUDGET = face_mosaic.HOLD_FRAMES_DEFAULT * face_mosaic.DETECT_EVERY_DEFAULT
# 対照の位置も直書きしない。区切りの値を小さくすると、直書きの位置と区切りの位置が
# 重なって対照が黙って対照でなくなる。
GAP_MID = (apply_mosaic_cli.CHUNK_FRAMES // 2,
           apply_mosaic_cli.CHUNK_FRAMES // 2 + HOLD_BUDGET)
GAP_EDGE = (apply_mosaic_cli.CHUNK_FRAMES, apply_mosaic_cli.CHUNK_FRAMES + HOLD_BUDGET)
# 「隠された」の判定。1画素でも変われば合格にすると、顔の端を少し塗っただけの実装でも
# 通ってしまう。顔の矩形のうち、どれだけの広さが塗り替わったかで見る。
# 顔の矩形全体の「平均の階調差」で見る。1画素の最大値だと、顔の端を少し塗っただけの
# 実装でも通ってしまう。平均なら、塗られた広さが足りなければ下がる。
# 実測(2026-08-08): 誰も塗らない場所5.00 / 正しく隠されている9.57 /
# 追従を持ち越さない2.86 / 持ち越しが不完全3.76。両側の実測の中ほどに置く。
MASKED_MEAN_MIN = 7.5
# 素材R-P（縦型 9:16）。画面の既定は 9:16 で、この製品の主力もこちら。
# render-vertical.mjs は 1280x720 を scale=1080:1920:force_original_aspect_ratio=decrease で
# 1080x607 へ縮めて上下に黒帯を足すので、顔の高さは 216px → 182px（画面の9.5%）になる。
# 横型より検出の取りこぼし側に寄る独立の条件なので、別に測る。
PW, PH = 1080, 1920
# 縮め方・帯の入れ方は自前で計算せず、製品と同じ ffmpeg のフィルタをそのまま通す。
# 自前で計算すると (a)算術が合わない（607＋656＋656＝1919）(b)縮小の補間方法が
# 製品（ffmpeg 既定の bicubic）と違う（cv2 の INTER_AREA）ため、
# 輪郭の出方＝顔の見つけやすさが変わり、この葉の存在理由そのものが崩れる。
P_FILTER = ("scale=1080:1920:force_original_aspect_ratio=decrease,"
            "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black")

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


def stamp_marker(frame, n):
    """左上に、コマ番号 n を16bitの白黒模様として焼く（1ビット＝8x8画素の升目）。

    最上位ビットが左端の升目。1は白(255,255,255)、0は黒(0,0,0)。
    顔は画面中央にあるので、この領域はモザイクの対象にならない。
    """
    for i in range(MARKER_BITS):
        bit = (n >> (MARKER_BITS - 1 - i)) & 1
        x = i * MARKER_CELL_PX
        frame[0:MARKER_CELL_PX, x:x + MARKER_CELL_PX] = 255 if bit else 0
    return frame


def read_marker(frame):
    """stamp_marker で焼いた模様からコマ番号を読み戻す。升目の平均が128超なら1。"""
    n = 0
    for i in range(MARKER_BITS):
        x = i * MARKER_CELL_PX
        cell = frame[0:MARKER_CELL_PX, x:x + MARKER_CELL_PX]
        n = (n << 1) | (1 if float(cell.mean()) > 128 else 0)
    return n


def rotated_face():
    """検出されない向きにした顔（＝一瞬顔を見失う場面を作るため）。"""
    face = cv2.imread(FIXTURE, cv2.IMREAD_COLOR)
    scale = (H * FACE_RATIO) / face.shape[0]
    face = cv2.resize(face, (max(1, int(face.shape[1] * scale)), max(1, int(face.shape[0] * scale))))
    return cv2.rotate(face, cv2.ROTATE_90_CLOCKWISE)


def gap_rect():
    """回した顔を置く矩形（画面中央）。ここの画素で「隠されたか」を測る。"""
    rot = rotated_face()
    y = (H - rot.shape[0]) // 2
    x = (W - rot.shape[1]) // 2
    return y, y + rot.shape[0], x, x + rot.shape[1]


def build_material_r(path, audio=False, markers=False, frames=None, gaps=None):
    """素材R を合成する。全コマ同一の絵・15fps・2秒。

    書き出しは libx264rgb の可逆（-qp 0 / bgr24）で行う。cv2.VideoWriter の "mp4v" は
    非可逆で、素材そのものが符号化器の実装差で変わってしまうため使わない
    （素材が版で変わると、下で測るノイズの床も版で変わり、合格ラインの根拠が崩れる）。
    audio=True: 左440Hz・右880Hz・48000Hz・2秒のステレオ正弦波を AAC で足す（＝素材R-A、葉G用）。
      左右で違う音にするのは、左右が入れ替わる壊れ方を検出できるようにするため。
    markers=True: コマ番号の白黒模様を左上に焼く（＝素材R-M、葉I用）。
      全コマ同じ絵だと、コマの並びがずれても画素比較では原理的に見えないため。
    """
    n = FRAMES if frames is None else frames
    frame = compose_frame()
    gap_frame = None
    if gaps:
        rot = rotated_face()
        gap_frame = np.full((H, W, 3), BG, dtype=np.uint8)
        gy = (H - rot.shape[0]) // 2
        gx = (W - rot.shape[1]) // 2
        gap_frame[gy:gy + rot.shape[0], gx:gx + rot.shape[1]] = rot
    cmd = ["ffmpeg", "-y", "-v", "error",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-"]
    if audio:
        cmd += ["-f", "lavfi", "-i",
                f"aevalsrc=sin(2*PI*440*t)|sin(2*PI*880*t):s=48000:d={n / FPS:.6f}",
                "-c:a", "aac", "-b:a", "128k"]
    cmd += ["-c:v", "libx264rgb", "-qp", "0", "-pix_fmt", "bgr24", path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for i in range(n):
        src = frame
        if gaps and any(a <= i < b for a, b in gaps):
            src = gap_frame
        p.stdin.write((stamp_marker(src.copy(), i) if markers else src).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError(f"素材Rの書き出しに失敗しました: {path}")
    return frame


def build_material_p(path):
    """素材R-P を合成する。素材Rの絵を、製品と同じフィルタで 1080x1920 の縦型にする。"""
    frame = compose_frame()
    p = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
         "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-vf", P_FILTER,
         "-c:v", "libx264rgb", "-qp", "0", "-pix_fmt", "bgr24", path],
        stdin=subprocess.PIPE)
    for _ in range(FRAMES):
        p.stdin.write(frame.tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError(f"素材R-Pの書き出しに失敗しました: {path}")
    return frame


def probe_stream(path, selector):
    """ffprobe で1本のストリームの fps・尺・コマ数・頭出し位置・チャンネル数を取る。"""
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", selector,
                        "-show_entries",
                        "stream=r_frame_rate,duration,nb_frames,start_time,channels,sample_rate",
                        "-of", "default=nw=1", path], capture_output=True, text=True)
    return dict(l.split("=", 1) for l in r.stdout.strip().split("\n") if "=" in l)


def read_audio_pcm(path):
    """音声を 16bit の生データとして取り出す。無音なら空。

    チャンネル数・サンプリング周波数は入力のまま（-ac / -ar を指定しない）。
    モノラルへ混ぜてしまうと、左右の入れ替えやステレオのモノラル化が
    同じバイト列になり、判定器がチャンネルの違いに対して盲目になる。
    """
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-f", "s16le", "-"],
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


def judge_faces(frame, size):
    """素顔が写っているかを判定する。必ず縮小していない原寸の絵に掛ける。

    凍結すべきは「検出器をどの大きさで作るか」ではない。face_mosaic.detect_faces_raw は
    毎回 setInputSize を渡された画像の実寸で上書きするので、作るときの大きさは結果を
    決めない。決めるのは **渡す絵** である。実測(2026-08-08, opencv 5.0.0):
    90度回した顔は、原寸の絵なら1件、960x540へ INTER_NEAREST で間引いた絵なら0件、
    同じ960x540でも INTER_LINEAR / INTER_AREA なら1件。
    つまり失われる原因は「幅960」ではなく「間引き方」である。
    製品の実装は速さのため INTER_NEAREST で縮めてから検出するので、判定側で同じことを
    すると「実装が見落とす顔は判定も見落とす」ことになる。判定は原寸の絵に掛ける。

    size は素材の (幅, 高さ)。渡された絵がそれと違えば、縮小した絵を渡している。
    黙って0件と数えるのが一番危ないので、その場で落とす。
    """
    w, h = size
    if frame.shape[1] != w or frame.shape[0] != h:
        raise RuntimeError(
            f"判定は原寸の絵に掛けること（素材={w}x{h} 渡された絵="
            f"{frame.shape[1]}x{frame.shape[0]}）")
    return detect_faces(frame, create_detector(w, h))


def faces_per_frame(frames, size):
    """素顔が見えるコマ数を数える。判定は judge_faces（原寸の絵）に一本化する。"""
    return [len(judge_faces(f, size)) for f in frames]


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


        # ── 対照 ────────────────────────────────────────────
        # 葉B（画面でモザイク無しを選ぶと素顔のまま出る）は兼ねない。
        # 葉Bは素材TVを画面から流した出力を見るもので、ここで見ているのは
        # 「工程を通していない素材Rに素顔が写っていること」でしかない。
        # モザイクを掛けていない入力で素顔が全コマ検出できることを先に確認する。
        # これが無いと、検出器がこの素材の素顔を元々検出できない場合に
        # モザイク処理をしなくても「0件」で合格してしまう。
        before = faces_per_frame(plain_src, (W, H))
        hit_before = sum(1 for n in before if n > 0)
        check(hit_before == FRAMES,
              f"対照: モザイク無しでは素顔が {hit_before}/{FRAMES} コマで検出できる")

        # ── モザイク工程を実行 ────────────────────────────────
        # ダイジェスト（「分数で切る」を選んだときに客へ渡る連結動画）も同じジョブに含める。
        # ダイジェストは素顔のクリップを連結して作られ、モザイク工程だけが最後の砦になる。
        # ここを対象に含めないと、ダイジェストにだけモザイクを掛けない実装でも全部緑になる。
        digest_clip = os.path.join(out_dir, "digest-job1.mp4")
        build_material_r(digest_clip)
        cand = {
            "id": "job1", "mode": "topic", "generated": 1,
            "digest": {"file": os.path.basename(digest_clip), "path": digest_clip},
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
        hit_after = sum(1 for n in faces_per_frame(after, (W, H)) if n > 0)
        check(hit_after == 0,
              f"A: モザイク版で素顔が検出されるコマが 0/{FRAMES}（実={hit_after}）")

        # ── C: 顔以外の絵と寸法・コマ数が元のまま ─────────────
        same_size = after and after[0].shape == plain[0].shape
        check(bool(same_size), "C: 解像度が入力と一致する")
        # 「顔の周り」（顔枠+72px）を除いた領域を、同じエンコーダを通した基準と比べる。
        # 除外矩形は 225x247 ＝ 画面の約6.0%。残り94%に差が出れば落ちる。
        boxes = judge_faces(plain_src[0], (W, H))
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

        # (2) 除外幅の境界を4辺すべてで固定する。
        #     除外は mask と同じ式で「顔枠の各辺から72px の手前まで」なので、
        #     各辺のちょうど外側1列（1行）が「見えていなければならない最初の画素」。
        #     ここに汚しを置くと、その辺を1pxでも広げた瞬間に隠れて対照が落ちる。
        #     1辺だけだと、他の3辺を黙って広げられる（面積の上限に当たるまで気づけない）。
        #     幅を持たせても駄目で、1px広げたときに汚しの残りが見えてしまい固定できない。
        bx, by, bw, bh = boxes[0]
        left, top = int(bx), int(by)
        right, bottom = int(bx + bw), int(by + bh)
        cx, cy = int(bx + bw / 2), int(by + bh / 2)
        sides = [
            ("右", (slice(cy - 4, cy + 4), slice(right + MARGIN_PROBE_PX, right + MARGIN_PROBE_PX + 1))),
            ("左", (slice(cy - 4, cy + 4), slice(left - MARGIN_PROBE_PX - 1, left - MARGIN_PROBE_PX))),
            ("下", (slice(bottom + MARGIN_PROBE_PX, bottom + MARGIN_PROBE_PX + 1), slice(cx - 4, cx + 4))),
            ("上", (slice(top - MARGIN_PROBE_PX - 1, top - MARGIN_PROBE_PX), slice(cx - 4, cx + 4))),
        ]
        for name, sel in sides:
            rows, cols = sel
            inside = 0 <= rows.start and rows.stop <= H and 0 <= cols.start and cols.stop <= W
            if not check(inside, f"対照C: {name}辺の探り位置が画面内にある（実={rows},{cols}）"):
                continue
            near = []
            for f in plain:
                g = f.copy()
                g[rows, cols] = 255
                near.append(g)
            check(worst_diff(plain, near, mask) > PIXEL_TOLERANCE,
                  f"対照C: {name}辺の顔枠+{MARGIN_PROBE_PX}px（除外の外側の1列目）の汚しは落ちる"
                  f"（{name}側の見ない範囲を{MARGIN_PROBE_PX}pxより広げられないことを固定する）")

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
        digest_masked = "digest-job1-mosaic.mp4"
        check((after_cand.get("digest") or {}).get("file") == digest_masked,
              f"D: ダイジェストもモザイク版を指す（実={(after_cand.get('digest') or {}).get('file')}）")

        # ── A/F をダイジェストにも要求する ──────────────────────
        dg_out = os.path.join(out_dir, digest_masked)
        if check(os.path.exists(dg_out), "ダイジェストのモザイク版が生成された"):
            dg_frames = read_frames(dg_out)
            dg_hit = sum(1 for n in faces_per_frame(dg_frames, (W, H)) if n > 0)
            check(dg_hit == 0,
                  f"A: ダイジェストでも素顔が検出されるコマが 0/{FRAMES}（実={dg_hit}）")

        # ── E / F: 素顔の実体が成果物フォルダに残らない ────────
        # 実体が output/<id>/ の外にあるので、名前を直接指定するAPI(/api/clips/:id/:file)も
        # 到達できない（このAPIは output/<id>/ の下しか配信しないため）。
        left = sorted(os.listdir(out_dir))
        check(os.path.basename(clip) not in left,
              f"F: 成果物フォルダに素顔のファイルが残っていない（実={left}）")
        check(os.path.exists(os.path.join(stash_dir, os.path.basename(clip))),
              "F: 素顔のファイルは成果物フォルダの外へ退避されている")
        check(os.path.basename(digest_clip) not in left,
              f"F: ダイジェストの素顔も成果物フォルダに残っていない（実={left}）")
        check(os.path.exists(os.path.join(stash_dir, os.path.basename(digest_clip))),
              "F: ダイジェストの素顔も成果物フォルダの外へ退避されている")

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
            aout_probe = probe_stream(g_out, "a:0")
            check(ain.get("channels") == "2",
                  f"対照G: 素材R-Aがステレオである（実={ain.get('channels')}ch）")
            check(aout_probe.get("channels") == ain.get("channels")
                  and aout_probe.get("sample_rate") == ain.get("sample_rate"),
                  f"G: 音のチャンネル数とサンプリング周波数が入力と一致する"
                  f"（入力={ain.get('channels')}ch/{ain.get('sample_rate')}Hz"
                  f" 出力={aout_probe.get('channels')}ch/{aout_probe.get('sample_rate')}Hz）")

            # ── H: 尺と速さが元のまま（音と絵がずれない） ──────────
            # 音のバイト列が一致していても、映像側だけ別のfpsで書き戻されると
            # 絵が早送り／スローになり、音とずれた動画が出来上がる。実装の probe() は
            # r_frame_rate を報告しない素材を無言で 30fps 扱いにする経路を持つので、
            # 「音が同じ」「画素が同じ」とは独立に落ちうる受入事実として別に測る。
            vout, aout = probe_stream(g_out, "v:0"), probe_stream(g_out, "a:0")
            # 尺が読めなかったのを 0 とみなすと「どちらも0秒で一致」で素通りする。先に読めたことを見る。
            readable = True
            for label, d in (("入力の映像", vin), ("入力の音", ain), ("出力の映像", vout), ("出力の音", aout)):
                got = d.get("duration")
                ok = got not in (None, "", "N/A")
                readable = readable and ok
                check(ok, f"対照H: {label}の尺が読み取れた（実={got}）")
            check(vin.get("r_frame_rate") not in (None, "", "0/0")
                  and vout.get("r_frame_rate") == vin.get("r_frame_rate"),
                  f"H: 映像のfpsが入力と一致する（入力={vin.get('r_frame_rate')} 出力={vout.get('r_frame_rate')}）")
            if readable:
                vi, vo = float(vin["duration"]), float(vout["duration"])
                ai, ao = float(ain["duration"]), float(aout["duration"])
                check(abs(vi - vo) < DURATION_TOLERANCE_SEC,
                      f"H: 映像の尺が入力と一致する（入力={vi:.3f}秒 出力={vo:.3f}秒）")
                check(abs(ai - ao) < DURATION_TOLERANCE_SEC,
                      f"H: 音の尺が入力と一致する（入力={ai:.3f}秒 出力={ao:.3f}秒）")
                # 「出力の映像と音がそろっている」ではなく「映像と音のずれが入力から変わっていない」を見る。
                # 前者だと、映像が音より少し長い普通の素材（ロードマップの素材TVは0.030秒長い）で、
                # 何もずらしていない正しい実装まで落ちてしまう。工程が足したずれだけを測る。
                check(abs((vo - ao) - (vi - ai)) < DURATION_TOLERANCE_SEC,
                      f"H: 映像と音の尺の差が入力から変わらない"
                      f"（入力={vi - ai:+.3f}秒 出力={vo - ao:+.3f}秒）")
        else:
            print("      " + (r3.stderr or "")[-800:])

        # ── I: 絵が時間軸のどこに載っているかが変わらない ──────────
        # H は尺と速さしか見ない。コマ数も fps も尺も音のバイト列も保存したまま、
        # 絵だけを丸ごと数コマ遅らせることができ、その場合 A〜H は全部緑のまま
        # 口の動きと音がずれた動画が出来上がる。素材Rは全コマ同じ絵なので、
        # 葉Cの画素比較でもこのずれは原理的に見えない。コマ番号の目印を焼いた
        # 素材R-M で、出力の各コマが入力の同じ位置のコマであることを直接測る。
        i_dir = os.path.join(work, "output", "job4")
        os.makedirs(i_dir, exist_ok=True)
        i_clip = os.path.join(i_dir, "d.mp4")
        # 素材の長さは実装の区切りから導く。実クリップ（話題ごとで数分、ダイジェストは既定3分）は
        # 必ず区切りをまたぐので、短い素材だけで測ると納品物が通る道を一度も測らないことになる。
        check(I_FRAMES > apply_mosaic_cli.CHUNK_FRAMES + apply_mosaic_cli.LOOKAHEAD_FRAMES,
              f"対照I: 素材R-M が区切りをまたぐ長さである"
              f"（{I_FRAMES}コマ > 区切り{apply_mosaic_cli.CHUNK_FRAMES}"
              f"＋先読み{apply_mosaic_cli.LOOKAHEAD_FRAMES}）")
        build_material_r(i_clip, audio=True, markers=True, frames=I_FRAMES,
                         gaps=[GAP_MID, GAP_EDGE])
        # 「隠されたか」を測る基準（モザイク工程と同じ符号化を一度通したもの）
        i_base = os.path.join(work, "i-baseline.mp4")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", i_clip,
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                        "-pix_fmt", "yuv420p", i_base], check=True)
        i_src = read_frames(i_clip)
        i_vin, i_ain = probe_stream(i_clip, "v:0"), probe_stream(i_clip, "a:0")
        check([read_marker(f) for f in i_src] == list(range(I_FRAMES)),
              f"対照I: 素材R-M のコマ番号が 0..{I_FRAMES - 1} の順に読み取れる")
        json.dump({"id": "job4", "digest": None,
                   "candidates": [{"file": "d.mp4", "path": i_clip}]},
                  open(os.path.join(i_dir, "candidates.json"), "w", encoding="utf-8"))
        r4 = subprocess.run(["node", STAGE_MJS, i_dir, os.path.join(work, "work", "job4", "pre-mosaic")],
                            capture_output=True, text=True)
        if check(r4.returncode == 0, "目印付きの素材でもモザイク工程が正常終了する"):
            i_out = os.path.join(i_dir, "d-mosaic.mp4")
            got = [read_marker(f) for f in read_frames(i_out)]
            ordered = got == list(range(I_FRAMES))
            check(ordered,
                  f"I: 出力の各コマが入力と同じ順・同じ位置にある（実の先頭5件={got[:5]} 件数={len(got)}）")
            # 「並びが崩れていないこと」を合格条件にする以上、崩れているときに落ちる対照が要る。
            dropped = got[:5] + got[6:]
            check(dropped != list(range(I_FRAMES)), "対照I: 1コマ抜けた列なら、この判定は落ちる")
            swapped = list(got)
            if len(swapped) > 11:
                swapped[10], swapped[11] = swapped[11], swapped[10]
            check(swapped != list(range(I_FRAMES)),
                  "対照I: 隣り合う2コマが入れ替わった列なら、この判定は落ちる")
            # 葉A を、区切りをまたぐ長さでも測る。素材TV(179コマ)も素材R(30コマ)も
            # 区切り(300)+先読み(6) に届かないため、区切りの手前だけ顔を隠さない実装でも
            # 素顔が0件と出てしまう（実測: 340コマ中300コマに素顔が写るのに全項目が緑だった）。
            # 対照: この素材は「顔が写っていれば写っていると言える」ものであること。
            # 見失う区間は顔を90度回してあるが、原寸の判定では回した顔も検出できる
            # （製品の実装は速さのため間引いて縮めるので見失う＝そこが測りたい場面）。
            # これが無いと、48コマぶんが常に判定不能のまま「素顔0件」で緑になる。
            i_frames = read_frames(i_out)
            src_hit = sum(1 for n in faces_per_frame(i_src, (W, H)) if n > 0)
            check(src_hit == I_FRAMES,
                  f"対照A: モザイク無しの素材R-M では素顔が {src_hit}/{I_FRAMES} コマで検出できる")
            i_hit = sum(1 for n in faces_per_frame(i_frames, (W, H)) if n > 0)
            check(i_hit == 0,
                  f"A: 区切りをまたぐ長さ({I_FRAMES}コマ)でも素顔が検出されるコマが 0/{I_FRAMES}"
                  f"（実={i_hit}）")

            # ── N: 区切りの境目でも顔の追従が途切れない ──────────
            # 実装は長い動画を区切って処理する。区切りごとに追従をやり直すと、
            # 「検出が途切れた区間を直前の位置で埋める」保持が境目で必ず切れ、
            # 境目の直後で顔を見失ったコマに素顔が出る（実測: 区切り直後の3コマが
            # 未加工のまま出力された。差20＝圧縮ノイズだけ）。
            i_plain = read_frames(i_base)
            r0, r1, c0, c1 = gap_rect()

            def gap_weakest(rng):
                """区間のうち「一番隠れていないコマ」で、顔の矩形が塗り替わった割合。

                (1) 区間については最大ではなく最小を取る。最大を取ると、区間の一部が
                    隠れていれば通ってしまう（追従の持ち越しを外した実装では、区切り直後の
                    先頭3コマが未加工・残りが加工済みで、最大を見ると素通りした）。
                (2) コマの中は「一番差の大きい1画素」ではなく「塗り替わった画素の割合」で見る。
                    1画素で判定すると、顔の端を少し塗っただけの実装でも通ってしまう。
                """
                weakest = 255.0
                for k in rng:
                    d = cv2.absdiff(i_plain[k], i_frames[k]).max(axis=2)[r0:r1, c0:c1]
                    weakest = min(weakest, float(d.mean()))
                return weakest

            # 低い側の対照: 「顔がそのまま写っている」状態の値を、同じ矩形・同じ式で測る。
            # 無地の背景で測ってはいけない。符号化ノイズの出方が顔の絵とは別物で、
            # 実測でも無地は5.00なのに、実際の不合格側（追従を持ち越さない実装）は2.86と
            # もっと低く、対照が失敗の側を挟めていなかった。
            # ここでは可逆の素材そのもの（＝モザイクを一切掛けていない絵）と基準を比べる。
            # 差はどちらも符号化ぶんだけなので、これが「塗っていないとき」の値になる。
            unmasked = 0.0
            for k in range(*GAP_EDGE):
                d = cv2.absdiff(i_src[k], i_plain[k]).max(axis=2)[r0:r1, c0:c1]
                unmasked = max(unmasked, float(d.mean()))
            check(unmasked < MASKED_MEAN_MIN,
                  f"対照N: 顔がそのまま写っている状態の平均差は下限より小さい"
                  f"（実={unmasked:.2f} < {MASKED_MEAN_MIN}）")

            mid = gap_weakest(range(*GAP_MID))
            check(mid >= MASKED_MEAN_MIN,
                  f"対照N: 真ん中で顔を見失う区間{GAP_MID}は隠されている"
                  f"（一番隠れていないコマの平均差={mid:.2f}、下限{MASKED_MEAN_MIN}）")
            edge = gap_weakest(range(*GAP_EDGE))
            check(edge >= MASKED_MEAN_MIN,
                  f"N: 区切りの直後{GAP_EDGE}で顔を見失っても隠されている"
                  f"（一番隠れていないコマの平均差={edge:.2f}、下限{MASKED_MEAN_MIN}）")

            i_vout, i_aout = probe_stream(i_out, "v:0"), probe_stream(i_out, "a:0")
            si, so = i_vin.get("start_time"), i_vout.get("start_time")
            check(si is not None and si == so,
                  f"I: 映像の頭出し位置が入力と一致する（入力={si} 出力={so}）")
            ti, to = i_ain.get("start_time"), i_aout.get("start_time")
            check(ti is not None and ti == to,
                  f"I: 音の頭出し位置が入力と一致する（入力={ti} 出力={to}）")
        else:
            print("      " + (r4.stderr or "")[-800:])

        # ── M: 既定の縦型(9:16)でも素顔が消える ────────────────
        # 画面の既定は 9:16 で、この製品の主力もこちら。縦型は顔が小さくなる
        # （画面高さの30%→9.5%）ぶん検出の取りこぼし側に寄るので、横型とは別に測る。
        m_dir = os.path.join(work, "output", "job5")
        os.makedirs(m_dir, exist_ok=True)
        m_clip = os.path.join(m_dir, "p.mp4")
        build_material_p(m_clip)
        m_src = read_frames(m_clip)
        m_before = sum(1 for n in faces_per_frame(m_src, (PW, PH)) if n > 0)
        check(m_before == FRAMES,
              f"対照M: 縦型でもモザイク無しなら素顔が {m_before}/{FRAMES} コマで検出できる")
        json.dump({"id": "job5", "digest": None,
                   "candidates": [{"file": "p.mp4", "path": m_clip}]},
                  open(os.path.join(m_dir, "candidates.json"), "w", encoding="utf-8"))
        r5 = subprocess.run(["node", STAGE_MJS, m_dir, os.path.join(work, "work", "job5", "pre-mosaic")],
                            capture_output=True, text=True)
        if check(r5.returncode == 0, "縦型の素材でもモザイク工程が正常終了する"):
            m_after = read_frames(os.path.join(m_dir, "p-mosaic.mp4"))
            m_hit = sum(1 for n in faces_per_frame(m_after, (PW, PH)) if n > 0)
            check(m_hit == 0, f"M: 縦型(9:16)でも素顔が検出されるコマが 0/{FRAMES}（実={m_hit}）")
            check(m_after and m_after[0].shape[:2] == (PH, PW),
                  f"対照M: 出力が縦型のまま（1080x1920）である"
                  f"（実={m_after[0].shape[:2] if m_after else None}）")
        else:
            print("      " + (r5.stderr or "")[-800:])

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
        check(r2.returncode != 0, "K: 途中で失敗したら工程全体が失敗として終わる")
        left2 = sorted(os.listdir(f_dir))
        masked_left = [n for n in left2 if n.endswith("-mosaic.mp4")]
        check(masked_left == [],
              f"J: 失敗時に作りかけのモザイク版が成果物フォルダに残らない（実={masked_left}）")
        check("a.mp4" in left2 and "b.mp4" in left2,
              f"J: 失敗時は素顔だけの状態に戻る＝素顔と加工済みが混在しない（実={left2}）")

        # 書き込みが途中で止まった場合（容量不足に相当）も同じであること。
        # 失敗した「その1本」の書きかけは made へ積まれないので、made だけを後始末の
        # 対象にすると壊れた -mosaic が素顔の隣に残る。納品は -mosaic の方をコピーする
        # 案内なので、壊れたファイルをそのまま渡す経路になる。
        j3_dir = os.path.join(work, "output", "job7")
        os.makedirs(j3_dir, exist_ok=True)
        build_material_r(os.path.join(j3_dir, "s.mp4"))
        json.dump({"id": "job7", "digest": None,
                   "candidates": [{"file": "s.mp4", "path": os.path.join(j3_dir, "s.mp4")}]},
                  open(os.path.join(j3_dir, "candidates.json"), "w", encoding="utf-8"))
        # 対照: この上限の下では書きかけの -mosaic が実際に出来ることを先に示す。
        # 何も作られずに失敗しただけでも「残らない」は達成できてしまい、
        # 後始末が効いているのかを見分けられない。工程を通さず直接焼いて確かめる。
        ctl_dir = os.path.join(work, "ctl")
        os.makedirs(ctl_dir, exist_ok=True)
        ctl_src = os.path.join(ctl_dir, "s.mp4")
        shutil.copy(os.path.join(j3_dir, "s.mp4"), ctl_src)
        ctl_out = os.path.join(ctl_dir, "s-mosaic.mp4")
        subprocess.run([sys.executable, os.path.join(ROOT, "src", "apply_mosaic_cli.py"),
                        ctl_src, ctl_out], capture_output=True, text=True,
                       preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (8192, 8192)))
        check(os.path.exists(ctl_out),
              "対照J: 書き込みの上限の下では、書きかけの -mosaic が実際に出来る")

        r7 = subprocess.run(
            ["node", STAGE_MJS, j3_dir, os.path.join(work, "work", "job7", "pre-mosaic")],
            capture_output=True, text=True,
            preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (8192, 8192)))
        check(r7.returncode != 0, "K: 書き込みが途中で止まっても工程は失敗として終わる")
        left4 = sorted(os.listdir(j3_dir))
        check([n for n in left4 if n.endswith("-mosaic.mp4")] == [],
              f"J: 書きかけの -mosaic が成果物フォルダに残らない（実={left4}）")
        check("s.mp4" in left4,
              f"J: 書き込みが途中で止まっても素顔は成果物フォルダに残る（実={left4}）")

        # 途中で切れた動画を渡した場合。読み出し側の ffmpeg は警告を出しながら
        # 終了コード0を返すことがあり、終了コードだけを見ていると「短くなった動画」を
        # 成功として書き出してしまう（実測: 4.000秒の入力に対し出力1.867秒）。
        j4_dir = os.path.join(work, "output", "job8")
        os.makedirs(j4_dir, exist_ok=True)
        # 切り詰めの元は、製品がレンダリングで書き出すのと同じ設定にする
        # （可逆で書いた素材だと別の理由で落ちてしまい、この経路を測れない）。
        whole_src = os.path.join(work, "whole-src.mp4")
        build_material_r(whole_src)
        whole = os.path.join(work, "whole.mp4")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", whole_src,
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                        "-pix_fmt", "yuv420p", "-movflags", "+faststart", whole], check=True)
        with open(whole, "rb") as f:
            raw = f.read()
        truncated = os.path.join(j4_dir, "t.mp4")
        with open(truncated, "wb") as f:
            f.write(raw[: len(raw) * 95 // 100])     # 末尾5%を落とす
        # 対照: この切り詰め方が「読み出し側は終了コード0を返すのに、実際は
        # 最後まで読めていない」状態になっていることを先に確かめる。ここが
        # 終了コード0でなくなると、別の防波堤で落ちるだけになり、
        # この葉が狙っている「黙って短い動画を成功として出す」経路を測れなくなる。
        probe_r = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", truncated, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
            capture_output=True)
        got_frames = len(probe_r.stdout) // (W * H * 3)
        check(probe_r.returncode == 0 and probe_r.stderr.strip() and got_frames < FRAMES,
              f"対照K: 切り詰めた動画は読み出し側が終了コード0のまま最後まで読めない"
              f"（rc={probe_r.returncode} コマ={got_frames}/{FRAMES}）")
        json.dump({"id": "job8", "digest": None,
                   "candidates": [{"file": "t.mp4", "path": truncated}]},
                  open(os.path.join(j4_dir, "candidates.json"), "w", encoding="utf-8"))
        r8 = subprocess.run(["node", STAGE_MJS, j4_dir, os.path.join(work, "work", "job8", "pre-mosaic")],
                            capture_output=True, text=True)
        check(r8.returncode != 0, "K: 途中で切れた動画は成功にせず、失敗として終わる")
        left5 = sorted(os.listdir(j4_dir))
        check([n for n in left5 if n.endswith("-mosaic.mp4")] == [],
              f"J: 途中で切れた動画でも -mosaic が残らない（実={left5}）")
        check("t.mp4" in left5,
              f"J: 途中で切れた動画でも素顔は成果物フォルダに残る（実={left5}）")

        # 第2段（素顔を退避する所）で失敗した場合も同じであること。
        # 第1段だけを守っていると、退避の途中で落ちたときに
        # 「1本目＝退避済み／2本目＝素顔と加工済みが両方」という混在が残る。
        # 退避先に同名のフォルダを置いて、2本目の移動だけを必ず失敗させる。
        j2_dir = os.path.join(work, "output", "job6")
        os.makedirs(j2_dir, exist_ok=True)
        for name in ("x.mp4", "y.mp4"):
            build_material_r(os.path.join(j2_dir, name))
        json.dump({"id": "job6", "digest": None,
                   "candidates": [{"file": "x.mp4", "path": os.path.join(j2_dir, "x.mp4")},
                                  {"file": "y.mp4", "path": os.path.join(j2_dir, "y.mp4")}]},
                  open(os.path.join(j2_dir, "candidates.json"), "w", encoding="utf-8"))
        j2_stash = os.path.join(work, "work", "job6", "pre-mosaic")
        os.makedirs(os.path.join(j2_stash, "y.mp4"), exist_ok=True)   # 移動先を塞ぐ
        with open(os.path.join(j2_stash, "y.mp4", "blocker"), "w") as f:
            f.write("x")
        r6 = subprocess.run(["node", STAGE_MJS, j2_dir, j2_stash], capture_output=True, text=True)
        check(r6.returncode != 0, "K: 退避の途中で失敗しても工程全体が失敗として終わる")
        left3 = sorted(os.listdir(j2_dir))
        check([n for n in left3 if n.endswith("-mosaic.mp4")] == [],
              f"J: 退避の途中で失敗しても、顔を隠した版が成果物フォルダに残らない（実={left3}）")
        check("x.mp4" in left3 and "y.mp4" in left3,
              f"J: 退避の途中で失敗しても、素顔は全部そろって成果物フォルダに戻る（実={left3}）")

    finally:
        shutil.rmtree(work, ignore_errors=True)

    print(f"\n--- {'ALL PASS' if fail == 0 else str(fail) + ' FAIL'} ---")
    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()
