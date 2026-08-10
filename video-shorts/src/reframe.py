"""video-shorts REFRAME — 話している人を追いかけて縦型(9:16)へ切り抜く。

ロードマップ G-EDIT-REFRAME の実装。1〜2人が写っているときは顔を追跡してクロップし、
0人（顔が写らない）または3人以上（追いきれない）のときは、現行の letterbox 方式
（render-vertical.mjs と同じ scale+pad フィルタ）へ自動で切り替える。

設計方針（詳細は docs/roadmap.html の G-EDIT-REFRAME detail / basis-reviewer 反証を参照）:
  - 顔検出は face_mosaic.py の cv2.FaceDetectorYN（SCORE_THRESHOLD=0.6, NMS_THRESHOLD=0.3）を
    そのまま使う（create_detector() 経由。値をここで再定義しない＝ドリフト防止）。
  - 「何人写っているか」は、瞬間の検出数ではなく face_mosaic.FaceTracker で保持(hold)した
    あとのトラック数で判定する。瞬間的な検出漏れ（部分遮蔽など）で 0 人と誤判定し
    letterbox へ落ちてしまうのを防ぐため。hold_frames は face_mosaic の既定(8)を使う（3以上）。
  - 1本の動画を「crop区間」と「letterbox区間」に分割し、区間ごとに別々の ffmpeg 呼び出しで
    書き出してから concat する。letterbox区間は render-vertical.mjs とまったく同じフィルタ文字列
    (scale=...:force_original_aspect_ratio=decrease,pad=...) をそのまま使う。これにより
    letterbox区間の絵は、独自に Python(cv2) で再実装する場合に比べて、製品と同じ
    ffmpeg フィルタの出力に忠実になる（G-EDIT-REFRAME-D2 のしきい値3.0を安全に満たすため）。
  - crop区間は ffmpeg の crop フィルタに、フレーム番号(n)に応じたx位置の式を渡して
    フレームごとに追従させる（Python側のcv2処理を経由しない＝製品と同じffmpeg処理のみで完結）。
  - 音声は最後に元の入力から `-map 1:a? -c:a copy` で無変換コピーする（劣化・チャンネル
    入替えを避けるため。apply_mosaic_cli.py と同じ考え方）。
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile

import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from face_mosaic import (  # noqa: E402
    FaceTracker,
    HOLD_FRAMES_DEFAULT,
    create_detector,
    detect_faces,
)

# 縦型出力の解像度（render-vertical.mjs の ORIENT.portrait と同じ）。
TARGET_W = 1080
TARGET_H = 1920

# 何人までクロップし続けるか。これを超える、または0人のときは letterbox へ落ちる。
# RF-M(3人固定)はこの葉の合否には値そのものを反証できない(roadmap G-EDIT-REFRAME-E参照)ため、
# 「2人まで」は暫定値として置く(下限側の保証はG-EDIT-REFRAME-C=今回スコープ外が担う)。
MAX_TRACKED_FACES = 2

# 検出が途切れた区間を直前の位置で保持するフレーム数。face_mosaic の既定(8)を流用する
# （このリポジトリの規律により、3以上という要件を独自の値で再定義せず、既存資産をそのまま使う）。
HOLD_FRAMES = HOLD_FRAMES_DEFAULT


def crop_width_for(height: int) -> int:
    """入力の高さから、9:16のクロップ幅を偶数に丸めて求める。

    例: 1080 -> 1080*9/16=607.5 -> 608px（h264は偶数幅が必須）。
    """
    w = height * 9.0 / 16.0
    even = int(round(w / 2.0)) * 2
    return max(2, even)


def probe_video(path: str):
    """幅・高さ・フレーム数を取る。取れなければ理由の分かる例外にする。"""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,nb_read_frames",
         "-count_frames", "-of", "default=nw=1", path],
        capture_output=True, text=True,
    ).stdout
    info = dict(line.split("=", 1) for line in out.strip().split("\n") if "=" in line)
    if "width" not in info or "height" not in info:
        raise RuntimeError(f"動画の情報を取得できませんでした: {path}")
    return int(info["width"]), int(info["height"])


def read_frames(path: str):
    """全フレームを cv2 で読み込む（顔検出専用。書き出しは常に ffmpeg 側で行う）。"""
    cap = cv2.VideoCapture(path)
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    cap.release()
    return frames


def analyze_tracks(frames, hold_frames: int = HOLD_FRAMES, max_tracked: int = MAX_TRACKED_FACES):
    """各フレームについて、保持後のトラック数と、クロップに使う中心x座標を返す。

    「何人写っているか」は瞬間の検出数ではなく、FaceTracker で保持したあとの
    トラック数で判定する（部分遮蔽で一瞬検出が途切れても、保持中は数え続ける）。

    戻り値: [{"count": int, "cx": float|None}, ...]（cx は 1〜max_tracked 人のときだけ値を持つ）
    """
    out = []
    if not frames:
        return out
    h, w = frames[0].shape[:2]
    det = create_detector(w, h)
    tracker = FaceTracker(hold_frames=hold_frames)
    for i, f in enumerate(frames):
        boxes = detect_faces(f, det)
        tracks = tracker.update(boxes, frame_index=i)
        count = len(tracks)
        cx = None
        if 1 <= count <= max_tracked:
            centers = [t.box[0] + t.box[2] / 2.0 for t in tracks]
            cx = sum(centers) / len(centers)
        out.append({"count": count, "cx": cx})
    return out


def build_segments(analysis):
    """フレームごとの解析結果を、連続する crop区間 / letterbox区間 に分割する。

    戻り値: [(start_frame, end_frame_exclusive, "crop"|"letterbox"), ...]
    """
    segments = []
    mode = None
    start = 0
    for i, a in enumerate(analysis):
        m = "crop" if a["cx"] is not None else "letterbox"
        if mode is None:
            mode, start = m, i
        elif m != mode:
            segments.append((start, i, mode))
            mode, start = m, i
    if mode is not None:
        segments.append((start, len(analysis), mode))
    return segments


def _crop_x_expr(cx_values, in_w: int, crop_w: int) -> str:
    """区間内の各フレーム(相対フレーム番号 n=0..)のクロップ左端xを求める ffmpeg 式を作る。

    ffmpeg の crop フィルタでは `n` はそのフィルタに入ってきたフレームの通し番号
    (0始まり)を指す。trim で区間を切り出したあとに crop を掛けるので、n は
    その区間内で 0 から数え直される。

    注意(未確定・backlog): この実装は区間内のフレーム数だけ if(eq(n,k),...) を
    ネストするため、区間が数千フレームを超えるような長尺のクロップ区間では
    フィルタ文字列が非常に長くなる。今回のスコープ(30フレームの検証素材)では
    問題にならないが、フルパイプライン統合時は区間をチャンクに分割するなどの
    対策が必要になりうる(今回のスコープ外)。
    """
    max_x = max(0, in_w - crop_w)
    xs = []
    for cx in cx_values:
        x = int(round(cx - crop_w / 2.0))
        x = max(0, min(max_x, x))
        xs.append(x)
    if len(set(xs)) == 1:
        return str(xs[0])
    expr = str(xs[-1])
    for n in range(len(xs) - 2, -1, -1):
        expr = f"if(eq(n\\,{n})\\,{xs[n]}\\,{expr})"
    return expr


def letterbox_filter(w: int = TARGET_W, h: int = TARGET_H) -> str:
    """render-vertical.mjs の letterbox フィルタ列と同一の文字列を返す（流用・改変禁止）。"""
    return (
        f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1"
    )


def _run_ffmpeg(args):
    proc = subprocess.run(["ffmpeg", "-y", "-v", "error", *args], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg 失敗（終了コード {proc.returncode}）: {' '.join(args)}\n{proc.stderr[-2000:]}"
        )


def _extract_segment(input_path: str, start: int, end: int, vf: str, out_path: str):
    _run_ffmpeg([
        "-i", input_path,
        "-vf", f"trim=start_frame={start}:end_frame={end},setpts=PTS-STARTPTS,{vf}",
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        out_path,
    ])


def reframe(
    input_path: str,
    output_path: str,
    target_w: int = TARGET_W,
    target_h: int = TARGET_H,
    hold_frames: int = HOLD_FRAMES,
    max_tracked: int = MAX_TRACKED_FACES,
):
    """入力動画(16:9想定)を、顔を追跡してクロップした縦型(9:16)動画へ変換する。

    1〜2人検出時はクロップ、0人または3人以上検出時は letterbox 方式へ自動で切り替える。
    音声は入力から無変換コピーする。戻り値は診断情報の dict。
    """
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"入力動画が見つかりません: {input_path}")

    frames = read_frames(input_path)
    if not frames:
        raise RuntimeError(f"入力動画から1コマも読み出せませんでした: {input_path}")
    in_h, in_w = frames[0].shape[:2]
    crop_w = crop_width_for(in_h)

    analysis = analyze_tracks(frames, hold_frames=hold_frames, max_tracked=max_tracked)
    segments = build_segments(analysis)
    del frames  # 以降は ffmpeg 側が入力ファイルを直接読み直す

    with tempfile.TemporaryDirectory() as tmp:
        seg_paths = []
        for idx, (start, end, mode) in enumerate(segments):
            seg_path = os.path.join(tmp, f"seg-{idx:03d}.mp4")
            if mode == "crop":
                cx_values = [analysis[i]["cx"] for i in range(start, end)]
                x_expr = _crop_x_expr(cx_values, in_w, crop_w)
                vf = f"crop={crop_w}:{in_h}:{x_expr}:0,scale={target_w}:{target_h},setsar=1"
            else:
                vf = letterbox_filter(target_w, target_h)
            _extract_segment(input_path, start, end, vf, seg_path)
            seg_paths.append(seg_path)

        if len(seg_paths) == 1:
            concat_path = seg_paths[0]
        else:
            list_path = os.path.join(tmp, "list.txt")
            with open(list_path, "w") as fh:
                for p in seg_paths:
                    fh.write(f"file '{p}'\n")
            concat_path = os.path.join(tmp, "concat.mp4")
            _run_ffmpeg([
                "-f", "concat", "-safe", "0", "-i", list_path,
                "-c", "copy", concat_path,
            ])

        # 音声は元の入力から無変換コピーする（劣化・チャンネル入替えを避けるため）。
        _run_ffmpeg([
            "-i", concat_path, "-i", input_path,
            "-map", "0:v", "-map", "1:a?",
            "-c:v", "copy", "-c:a", "copy",
            "-movflags", "+faststart",
            output_path,
        ])

    return {
        "segments": segments,
        "crop_width": crop_w,
        "input_size": (in_w, in_h),
        "modes": [a["count"] for a in analysis],
    }
