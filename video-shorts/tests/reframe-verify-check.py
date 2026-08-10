"""G-EDIT-REFRAME の凍結済み11 leaf(A/B/D/D2/E/G/G2/G3/H/H2/H3)を、実際に src/reframe.py を
動かして検証する。各 verify テキストの手順(素材・しきい値・対照実装との比較)をそのまま
自動テストとして実装したもの(このリポジトリの規律により、evidence は外部事実のみが
認められるため、手で確かめただけでは証拠にならない → CI で毎回機械的に再現する)。

対照(letterbox化・decoy-pan・引き伸ばし・中央固定クロップ・真っ黒・1コマ目固着・
音声を落とす・左右チャンネル入替え・モノラル混合)も、このファイルの中で実際に生成し、
「対照は不合格になる」ところまで確認する(生成せず「たぶん不合格のはず」で済ませない)。

各 leaf の frozen な criteria/verify の正確な文言は docs/roadmap.html の
G-EDIT-REFRAME-A / -B / -D / -D2 / -E / -G / -G2 / -G3 / -H / -H2 / -H3 を見ること。
ここではそれをそのまま検証コードへ落とす(criteria/verify 自体は書き換えない)。
"""

import json
import os
import subprocess
import sys
import tempfile

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "src"))

import reframe  # noqa: E402
import reframe_fixtures as rf  # noqa: E402
from face_mosaic import FaceTracker, create_detector, detect_faces  # noqa: E402

passed = 0
failed = 0
results = []  # ("leaf-name", 実測メモ)


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS {name}  {detail}")
    else:
        failed += 1
        print(f"FAIL {name}  {detail}")


# ---------------------------------------------------------------- 共通ヘルパー

TARGET_W, TARGET_H = reframe.TARGET_W, reframe.TARGET_H
ENCODE_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]


def run_ffmpeg(args):
    proc = subprocess.run(["ffmpeg", "-y", "-v", "error", *args], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg失敗: {' '.join(args)}\n{proc.stderr[-2000:]}")


def read_frames(path):
    return reframe.read_frames(path)


def frame_size(path):
    frames = read_frames(path)
    h, w = frames[0].shape[:2]
    return w, h


def luma(frame):
    b = frame[:, :, 0].astype(np.float64)
    g = frame[:, :, 1].astype(np.float64)
    r = frame[:, :, 2].astype(np.float64)
    return 0.114 * b + 0.587 * g + 0.299 * r


def black_bands(frame, y_thresh=24, row_ratio=0.98):
    """外側から連続する近黒行の高さ(上端・下端)を返す。A/D と同じ定義(BT.601 Y<=24, 98%以上)。"""
    y = luma(frame)
    near_black_row = (y <= y_thresh).mean(axis=1) >= row_ratio
    top = 0
    for v in near_black_row:
        if v:
            top += 1
        else:
            break
    bot = 0
    for v in near_black_row[::-1]:
        if v:
            bot += 1
        else:
            break
    return top, bot


def mean_abs_diff(a, b):
    return float(np.abs(a.astype(np.int16) - b.astype(np.int16)).mean())


def per_frame_diffs(frames_a, frames_b):
    return [mean_abs_diff(a, b) for a, b in zip(frames_a, frames_b)]


def build_letterbox_reference(src_path, ref_path):
    """製品と同じ letterbox フィルタを、可逆(libx264rgb -qp 0)で書き出したもの(D2/Eの参照)。"""
    run_ffmpeg([
        "-i", src_path,
        "-vf", reframe.letterbox_filter(TARGET_W, TARGET_H),
        "-c:v", "libx264rgb", "-qp", "0", "-pix_fmt", "bgr24",
        ref_path,
    ])


def ffprobe_audio(path):
    """音声ストリームの本数・長さ・チャンネル数を返す。"""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a",
         "-show_entries", "stream=codec_name,channels,duration",
         "-of", "json", path],
        capture_output=True, text=True,
    ).stdout
    data = json.loads(out)
    return data.get("streams", [])


def channel_pcm(path, channel_index, sr=48000):
    args = [
        "ffmpeg", "-v", "error", "-i", path,
        "-af", f"pan=mono|c0=c{channel_index}",
        "-f", "f32le", "-ar", str(sr), "-",
    ]
    out = subprocess.run(args, capture_output=True).stdout
    return np.frombuffer(out, dtype=np.float32)


def dominant_freq(samples, sr=48000):
    n = len(samples)
    if n == 0:
        return None
    spec = np.abs(np.fft.rfft(samples))
    freqs = np.fft.rfftfreq(n, d=1.0 / sr)
    return float(freqs[int(np.argmax(spec))])


def build_decoy_pan(src_path, out_path, crop_w, cx_start, cx_end, n_frames, in_w, in_h):
    """顔を一切見ず、始点と終点だけを直線で結んだ決め打ちパン(fixture detailの定義どおり)。"""
    cx_values = [cx_start + (cx_end - cx_start) * i / (n_frames - 1) for i in range(n_frames)]
    x_expr = reframe._crop_x_expr(cx_values, in_w, crop_w)
    vf = f"crop={crop_w}:{in_h}:{x_expr}:0,scale={TARGET_W}:{TARGET_H},setsar=1"
    reframe._extract_segment(src_path, 0, n_frames, vf, out_path)


def build_always_centroid(src_path, out_path, crop_w):
    """人数を無視して、常に検出した全顔の重心へ追従し続ける実装(E の対照)。"""
    frames = read_frames(src_path)
    in_h, in_w = frames[0].shape[:2]
    det = create_detector(in_w, in_h)
    tracker = FaceTracker(hold_frames=reframe.HOLD_FRAMES)
    cx_values = []
    for i, f in enumerate(frames):
        boxes = detect_faces(f, det)
        tracks = tracker.update(boxes, frame_index=i)
        if tracks:
            centers = [t.box[0] + t.box[2] / 2.0 for t in tracks]
            cx_values.append(sum(centers) / len(centers))
        else:
            cx_values.append(in_w / 2.0)
    x_expr = reframe._crop_x_expr(cx_values, in_w, crop_w)
    vf = f"crop={crop_w}:{in_h}:{x_expr}:0,scale={TARGET_W}:{TARGET_H},setsar=1"
    reframe._extract_segment(src_path, 0, len(frames), vf, out_path)


tmpdir_obj = tempfile.TemporaryDirectory(prefix="reframe-verify-")
D = tmpdir_obj.name


def p(name):
    return os.path.join(D, name)


print(f"作業ディレクトリ: {D}")

# ---------------------------------------------------------------- 素材の準備
rf.verify_stills()
frames_R = rf.build("R", p("RF-R.mp4"))
frames_N = rf.build("N", p("RF-N.mp4"))
frames_M = rf.build("M", p("RF-M.mp4"))
rf.build_with_audio("R", p("RF-R-A.mp4"))
rf.build_with_audio("N", p("RF-N-A.mp4"))
rf.build_with_audio("M", p("RF-M-A.mp4"))

CROP_W = reframe.crop_width_for(rf.HEIGHT)
check("前提: クロップ幅は1080x9/16を偶数に丸めた608px", CROP_W == 608, f"実際={CROP_W}")

# 本実装で縦型へ変換する(A/B/D/D2/Eで共通に使う出力)
reframe.reframe(p("RF-R.mp4"), p("RF-R-out.mp4"))
reframe.reframe(p("RF-N.mp4"), p("RF-N-out.mp4"))
reframe.reframe(p("RF-M.mp4"), p("RF-M-out.mp4"))
reframe.reframe(p("RF-R-A.mp4"), p("RF-R-A-out.mp4"))
reframe.reframe(p("RF-N-A.mp4"), p("RF-N-A-out.mp4"))
reframe.reframe(p("RF-M-A.mp4"), p("RF-M-A-out.mp4"))

frames_R_out = read_frames(p("RF-R-out.mp4"))
frames_N_out = read_frames(p("RF-N-out.mp4"))
frames_M_out = read_frames(p("RF-M-out.mp4"))

# ================================================================== 葉A
print("\n=== G-EDIT-REFRAME-A: 縦型の出力に、上下の黒帯が出ない ===")
w, h = frame_size(p("RF-R-out.mp4"))
check("A: 出力解像度が9:16(1080x1920)", (w, h) == (TARGET_W, TARGET_H), f"実際={w}x{h}")

bands = [black_bands(f) for f in frames_R_out]
tops = [t for t, _ in bands]
bots = [b for _, b in bands]
max_top_pct = max(tops) / TARGET_H * 100
max_bot_pct = max(bots) / TARGET_H * 100
check(
    "A: 全30フレームで上端の黒帯が画面高さの2%未満",
    all(t / TARGET_H < 0.02 for t in tops),
    f"上端最大={max(tops)}px({max_top_pct:.2f}%)",
)
check(
    "A: 全30フレームで下端の黒帯が画面高さの2%未満",
    all(b / TARGET_H < 0.02 for b in bots),
    f"下端最大={max(bots)}px({max_bot_pct:.2f}%)",
)

# 対照: letterbox方式(切り抜きをしない)。656px相当(約34%)の黒帯が出て不合格になること。
run_ffmpeg([
    "-i", p("RF-R.mp4"), "-vf", reframe.letterbox_filter(TARGET_W, TARGET_H),
    *ENCODE_ARGS, p("RF-R-letterbox.mp4"),
])
lb_frames = read_frames(p("RF-R-letterbox.mp4"))
lb_bands = [black_bands(f) for f in lb_frames]
lb_top = max(t for t, _ in lb_bands)
lb_bot = max(b for _, b in lb_bands)
check(
    "A対照(letterbox方式): 上下の黒帯が画面高さの約34%(656px相当)検出され不合格になる",
    lb_top / TARGET_H >= 0.02 and lb_bot / TARGET_H >= 0.02,
    f"上端={lb_top}px({lb_top/TARGET_H*100:.1f}%) 下端={lb_bot}px({lb_bot/TARGET_H*100:.1f}%)",
)

# ================================================================== 葉B
print("\n=== G-EDIT-REFRAME-B: 顔が、画面に対して十分な大きさで写る ===")
w, h = frame_size(p("RF-R-out.mp4"))
check("B: 出力解像度が9:16(1080x1920)", (w, h) == (TARGET_W, TARGET_H), f"実際={w}x{h}")

det_out = create_detector(TARGET_W, TARGET_H)
face_pcts = []
for f in frames_R_out:
    boxes = detect_faces(f, det_out)
    if not boxes:
        face_pcts.append(0.0)
    else:
        face_pcts.append(max(b[3] for b in boxes) / TARGET_H * 100)
ok_frames = sum(1 for pct in face_pcts if pct >= 15.0)
check(
    "B: 顔の高さが画面高さの15%以上であるフレームが30/30",
    ok_frames == 30,
    f"{ok_frames}/30コマ 合格。実測範囲={min(face_pcts):.1f}%〜{max(face_pcts):.1f}%",
)

# 対照: 決め打ちパン(fixture detail: cx(0)とcx(29)を直線で結んだだけの窓移動)。
# 部分遮蔽区間(i=16,17,18)または追従が外れる区間で不合格になることを確認する。
cx0 = rf.R_CX_BREAKPOINTS[0][1]
cx_last = rf.R_CX_BREAKPOINTS[-1][1]
build_decoy_pan(p("RF-R.mp4"), p("RF-R-decoy.mp4"), CROP_W, cx0, cx_last, rf.FRAMES, rf.WIDTH, rf.HEIGHT)
decoy_frames = read_frames(p("RF-R-decoy.mp4"))
decoy_pcts = []
for f in decoy_frames:
    boxes = detect_faces(f, det_out)
    decoy_pcts.append(0.0 if not boxes else max(b[3] for b in boxes) / TARGET_H * 100)
decoy_ok = sum(1 for pct in decoy_pcts if pct >= 15.0)
check(
    "B対照(決め打ちパン): 30/30を満たせず不合格になる",
    decoy_ok < 30,
    f"{decoy_ok}/30コマのみ合格(部分遮蔽i=16,17,18周辺で崩れる想定)。範囲={min(decoy_pcts):.1f}%〜{max(decoy_pcts):.1f}%",
)

# ================================================================== 葉D
print("\n=== G-EDIT-REFRAME-D: 顔が写らない素材でも、絵が壊れずに出てくる ===")
w, h = frame_size(p("RF-N-out.mp4"))
check("D: 出力解像度が9:16(1080x1920)", (w, h) == (TARGET_W, TARGET_H), f"実際={w}x{h}")

n_bands = [black_bands(f) for f in frames_N_out]
n_has_band = [(t / TARGET_H >= 0.10) or (b / TARGET_H >= 0.10) for t, b in n_bands]
check(
    "D: 全30フレームで上端または下端に画面高さ10%以上の黒帯が存在する",
    all(n_has_band),
    f"実測(top,bot)px範囲: top={min(t for t,_ in n_bands)}〜{max(t for t,_ in n_bands)} "
    f"bot={min(b for _,b in n_bands)}〜{max(b for _,b in n_bands)}",
)

# 対照: 全画面へ引き伸ばす実装(黒帯0px)
run_ffmpeg(["-i", p("RF-N.mp4"), "-vf", f"scale={TARGET_W}:{TARGET_H},setsar=1", *ENCODE_ARGS, p("RF-N-stretch.mp4")])
stretch_frames = read_frames(p("RF-N-stretch.mp4"))
stretch_bands = [black_bands(f) for f in stretch_frames]
stretch_has_band = [(t / TARGET_H >= 0.10) or (b / TARGET_H >= 0.10) for t, b in stretch_bands]
check(
    "D対照(引き伸ばし): 黒帯が無く不合格になる",
    not any(stretch_has_band),
    f"top最大={max(t for t,_ in stretch_bands)}px bot最大={max(b for _,b in stretch_bands)}px",
)

# ================================================================== 葉D2
print("\n=== G-EDIT-REFRAME-D2: 縦型に直しても、風景の絵そのものは変わらない ===")
build_letterbox_reference(p("RF-N.mp4"), p("RF-N-ref.mp4"))
ref_N = read_frames(p("RF-N-ref.mp4"))
d2_diffs = per_frame_diffs(frames_N_out, ref_N)
check(
    "D2: letterbox参照との各フレームごとの平均絶対差が全30フレームで3.0以下",
    all(d <= 3.0 for d in d2_diffs),
    f"実測範囲={min(d2_diffs):.4f}〜{max(d2_diffs):.4f}",
)

# 対照4種(いずれも3.0を超えて不合格になることを確認)
# (1) 引き伸ばし
diffs_stretch = per_frame_diffs(stretch_frames, ref_N)
check("D2対照(引き伸ばし): 3.0を超えて不合格", max(diffs_stretch) > 3.0, f"最大={max(diffs_stretch):.3f}")

# (2) 中央固定のクロップ(絵が欠ける。顔追跡なし)
center_x = (rf.WIDTH - CROP_W) // 2
run_ffmpeg([
    "-i", p("RF-N.mp4"),
    "-vf", f"crop={CROP_W}:{rf.HEIGHT}:{center_x}:0,scale={TARGET_W}:{TARGET_H},setsar=1",
    *ENCODE_ARGS, p("RF-N-centercrop.mp4"),
])
centercrop_frames = read_frames(p("RF-N-centercrop.mp4"))
diffs_centercrop = per_frame_diffs(centercrop_frames, ref_N)
check("D2対照(中央固定クロップ): 3.0を超えて不合格", max(diffs_centercrop) > 3.0, f"最大={max(diffs_centercrop):.3f}")

# (3) 真っ黒
run_ffmpeg(["-f", "lavfi", "-i", f"color=c=black:s={TARGET_W}x{TARGET_H}:d=1:r=30", *ENCODE_ARGS, p("RF-N-black.mp4")])
black_frames = read_frames(p("RF-N-black.mp4"))[:30]
diffs_black = per_frame_diffs(black_frames, ref_N)
check("D2対照(真っ黒): 3.0を超えて不合格", max(diffs_black) > 3.0, f"最大={max(diffs_black):.3f}")

# (4) 1コマ目固着(全編を1コマ目に固定)
frozen_frames = [frames_N[0]] * rf.FRAMES
rf.write_lossless(frozen_frames, p("RF-N-frozen-src.mp4"))
run_ffmpeg(["-i", p("RF-N-frozen-src.mp4"), "-vf", reframe.letterbox_filter(TARGET_W, TARGET_H), *ENCODE_ARGS, p("RF-N-frozen.mp4")])
frozen_out = read_frames(p("RF-N-frozen.mp4"))
diffs_frozen = per_frame_diffs(frozen_out, ref_N)
check("D2対照(1コマ目固着): 3.0を超えて不合格", max(diffs_frozen) > 3.0, f"最大={max(diffs_frozen):.3f}")

# ================================================================== 葉E
print("\n=== G-EDIT-REFRAME-E: 大勢が写って追いきれないときも、絵が壊れずに出てくる ===")
w, h = frame_size(p("RF-M-out.mp4"))
check("E: 出力解像度が9:16(1080x1920)", (w, h) == (TARGET_W, TARGET_H), f"実際={w}x{h}")

build_letterbox_reference(p("RF-M.mp4"), p("RF-M-ref.mp4"))
ref_M = read_frames(p("RF-M-ref.mp4"))
e_diffs = per_frame_diffs(frames_M_out, ref_M)
check(
    "E: letterbox参照との各フレームごとの平均絶対差が全30フレームで3.0以下(3人以上は常に黒帯)",
    all(d <= 3.0 for d in e_diffs),
    f"実測範囲={min(e_diffs):.4f}〜{max(e_diffs):.4f}",
)

# 対照: 人数を無視して常に検出した顔の重心へ追従し続ける実装
build_always_centroid(p("RF-M.mp4"), p("RF-M-centroid.mp4"), CROP_W)
centroid_frames = read_frames(p("RF-M-centroid.mp4"))
diffs_centroid = per_frame_diffs(centroid_frames, ref_M)
check(
    "E対照(常に重心へ追従): 大きく不合格になる",
    max(diffs_centroid) > 3.0,
    f"最大={max(diffs_centroid):.3f}",
)

# ================================================================== 葉G/G2/G3(音声の存在)
print("\n=== G-EDIT-REFRAME-G/G2/G3: 音が消えない(存在+長さ1.000秒±0.05秒) ===")
AUDIO_CASES = [
    ("G", "RF-R-A", "追跡成功パス"),
    ("G2", "RF-N-A", "黒帯フォールバック(顔0人)"),
    ("G3", "RF-M-A", "黒帯フォールバック(3人以上)"),
]
for leaf, kind, label in AUDIO_CASES:
    out_path = p(f"{kind}-out.mp4")
    streams = ffprobe_audio(out_path)
    ok = len(streams) >= 1 and abs(float(streams[0]["duration"]) - 1.000) <= 0.05
    dur = streams[0]["duration"] if streams else "N/A"
    check(f"{leaf}({label}): 音声ストリームが存在し長さ1.000秒±0.05秒", ok, f"streams={len(streams)} duration={dur}")

    # 対照: 音声を落とす(-an相当)実装
    dropped = p(f"{kind}-dropped.mp4")
    run_ffmpeg(["-i", out_path, "-c:v", "copy", "-an", dropped])
    dropped_streams = ffprobe_audio(dropped)
    check(f"{leaf}対照(音声を落とす): 音声ストリームが0本になり不合格", len(dropped_streams) == 0, f"streams={len(dropped_streams)}")

# ================================================================== 葉H/H2/H3(左右チャンネル)
print("\n=== G-EDIT-REFRAME-H/H2/H3: 左右の音が入れ替わらない(左440Hz・右880Hz) ===")
H_CASES = [
    ("H", "RF-R-A", "追跡成功パス"),
    ("H2", "RF-N-A", "黒帯フォールバック(顔0人)"),
    ("H3", "RF-M-A", "黒帯フォールバック(3人以上)"),
]
for leaf, kind, label in H_CASES:
    out_path = p(f"{kind}-out.mp4")
    left = channel_pcm(out_path, 0)
    right = channel_pcm(out_path, 1)
    fl = dominant_freq(left)
    fr = dominant_freq(right)
    ok = fl is not None and fr is not None and abs(fl - 440) <= 5 and abs(fr - 880) <= 5
    check(f"{leaf}({label}): 左440Hz±5Hz・右880Hz±5Hzの両方を満たす", ok, f"左={fl:.2f}Hz 右={fr:.2f}Hz")

    # 対照1: 左右チャンネルを入れ替えた実装
    swapped = p(f"{kind}-swapped.mp4")
    run_ffmpeg(["-i", out_path, "-c:v", "copy", "-af", "pan=stereo|c0=c1|c1=c0", "-c:a", "aac", "-b:a", "128k", swapped])
    fl_s = dominant_freq(channel_pcm(swapped, 0))
    fr_s = dominant_freq(channel_pcm(swapped, 1))
    swap_ok = fl_s is not None and fr_s is not None and abs(fl_s - 440) <= 5 and abs(fr_s - 880) <= 5
    check(f"{leaf}対照(左右入替え): 不合格になる", not swap_ok, f"左={fl_s:.2f}Hz 右={fr_s:.2f}Hz")

    # 対照2: 左右をモノラルへ混合した実装
    mono = p(f"{kind}-mono.mp4")
    run_ffmpeg([
        "-i", out_path, "-c:v", "copy",
        "-af", "pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1",
        "-c:a", "aac", "-b:a", "128k", mono,
    ])
    fl_m = dominant_freq(channel_pcm(mono, 0))
    fr_m = dominant_freq(channel_pcm(mono, 1))
    mono_ok = fl_m is not None and fr_m is not None and abs(fl_m - 440) <= 5 and abs(fr_m - 880) <= 5
    check(f"{leaf}対照(モノラル混合): 不合格になる", not mono_ok, f"左={fl_m:.2f}Hz 右={fr_m:.2f}Hz")

# ------------------------------------------------------------------------
tmpdir_obj.cleanup()
print(f"\n--- {passed} PASS / {failed} FAIL ---")
sys.exit(1 if failed else 0)
