"""納品フォルダに素顔が紛れ込まないことの検査ツール兼テスト（ロードマップ M-4-H）。

M-4-H の指摘: CLI経路（pipeline.mjs + apply_mosaic_cli.py）は、モザイクを焼いた後も
output/<id>/ に素顔（short-01.mp4）とモザイク版（short-01-mosaic.mp4）が常時併存する。
SKILL.md 手順9は「客へ渡す最終フォルダ（output/<id>/採用/）にどちらをコピーするか」を
人（AIエージェント）の手順遵守だけに委ねており、機械的な歯止めが無い。

このファイルは2つの役目を持つ:

  1. 検査ツール（scan_delivery_folder / main_cli）
     納品フォルダ（例: output/<id>/採用/）に置かれた動画ファイル全てへ、
     face_mosaic.py の検出ロジックをそのまま再利用して顔検出を掛け直す。
     1コマでも顔が検出されたら、そのフォルダは納品してはいけない。
     単体でも `python3 delivery-face-scan-check.py <フォルダ>` として使える。

  2. セルフテスト（引数なしで実行した場合）
     SKILL.md 手順9のコピー操作をそのまま再現する deliver_clip() を使って、
     (a) 素顔を混入させたケース（間違えてモザイク無しをコピー）→ 検査が FAIL を返すこと
     (b) モザイク版だけを置いた対照ケース → 検査が PASS を返すこと
     の両方を、実際に動画ファイルを作って顔検出器にかけ直すところまで確認する。

実行: python3 tests/delivery-face-scan-check.py        (セルフテスト・全PASSでexit 0)
      python3 tests/delivery-face-scan-check.py <dir>  (検査ツールとして実フォルダを検査)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)  # video-shorts/
FIXTURES = os.path.join(HERE, "fixtures")

sys.path.insert(0, os.path.join(PKG, "src"))
from face_mosaic import create_detector, detect_faces  # noqa: E402

CLI = os.path.join(PKG, "src", "apply_mosaic_cli.py")

# 検査対象とする拡張子。SKILL.md の納品物は mp4 だが、他の動画コンテナが紛れても
# 黙って見逃さないよう一通り含める。
VIDEO_EXTENSIONS = (".mp4", ".mov", ".m4v", ".mkv", ".webm")


# ================================================================
# 1. 検査ツール本体
# ================================================================

def iter_frames(path):
    """動画ファイルをコマ単位で読み出す。"""
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError(f"動画を開けません: {path}")
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            yield frame
    finally:
        cap.release()


def scan_video_file(path):
    """1本の動画ファイルへ face_mosaic の検出をそのまま掛け直す。

    戻り値: (総コマ数, 素顔が検出されたコマ数)。
    検出器は face_mosaic.create_detector / detect_faces をそのまま再利用する
    （モザイク処理側と同じ検出ロジックで検査することが、この検査の前提）。
    """
    det = None
    total = 0
    leaked = 0
    for frame in iter_frames(path):
        if det is None:
            h, w = frame.shape[:2]
            det = create_detector(w, h)
        total += 1
        if detect_faces(frame, det):
            leaked += 1
    return total, leaked


def scan_delivery_folder(folder):
    """納品フォルダ直下の動画ファイル全てを検査する。

    戻り値: {ファイル名: (総コマ数, 素顔が検出されたコマ数)}（ファイル名の昇順）。
    サブフォルダは見ない（SKILL.md 手順9の「採用」フォルダはコピーのみでフラット）。
    """
    results = {}
    for name in sorted(os.listdir(folder)):
        path = os.path.join(folder, name)
        if not os.path.isfile(path):
            continue
        if not name.lower().endswith(VIDEO_EXTENSIONS):
            continue
        results[name] = scan_video_file(path)
    return results


def report(results):
    """検査結果を表示する。1件でも素顔が検出されていれば True を返す（＝納品NG）。"""
    any_leak = False
    for name, (total, leaked) in sorted(results.items()):
        if leaked > 0:
            any_leak = True
            print(f"FAIL {name}: 素顔が {leaked}/{total} コマで検出されました（納品してはいけません）")
        else:
            print(f"PASS {name}: 素顔は検出されませんでした（{total}コマ）")
    return any_leak


def main_cli(folder):
    if not os.path.isdir(folder):
        print(f"[ERROR] フォルダが見つかりません: {folder}", file=sys.stderr)
        return 2
    results = scan_delivery_folder(folder)
    if not results:
        print(f"[WARN] 動画ファイルが見つかりません: {folder}")
        return 0
    any_leak = report(results)
    if any_leak:
        print("\n--- NG: 素顔を含むファイルがあります。納品しないでください ---")
    else:
        print("\n--- OK: 検出された素顔はありません ---")
    return 1 if any_leak else 0


# ================================================================
# 2. SKILL.md 手順9（納品コピー）の再現
# ================================================================

def deliver_clip(output_dir, delivery_dir, stem, use_mosaic):
    """SKILL.md 手順9のコピー操作をそのまま再現する。

    use_mosaic=True  : 「手順7.5でモザイクを焼いた場合」の記載どおり `<stem>-mosaic.mp4` をコピーする。
    use_mosaic=False : 「モザイクを使わなかった場合」の記載どおり `<stem>.mp4`（無加工）をコピーする。
    このテストでは意図的に use_mosaic=False を「モザイクを焼いたのに、番号からモザイク版へ
    読み替えるのを忘れて元ファイルをコピーしてしまった」誤りの再現に使う。
    """
    os.makedirs(delivery_dir, exist_ok=True)
    src_name = f"{stem}-mosaic.mp4" if use_mosaic else f"{stem}.mp4"
    src_path = os.path.join(output_dir, src_name)
    if not os.path.exists(src_path):
        raise FileNotFoundError(f"コピー元が見つかりません: {src_path}")
    shutil.copy(src_path, os.path.join(delivery_dir, src_name))


# ================================================================
# 3. セルフテスト
# ================================================================

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


def build_plain_clip(path, w=640, h=480, seconds=1, fps=10):
    """顔がはっきり写った短い動画を作る（SKILL.md 手順7のレンダリング結果を模す）。"""
    face = cv2.imread(os.path.join(FIXTURES, "face-one.png"), cv2.IMREAD_COLOR)
    if face is None:
        raise FileNotFoundError("固定素材 face-one.png が読めません")
    scale = (h * 0.5) / face.shape[0]
    face = cv2.resize(face, (max(1, int(face.shape[1] * scale)), max(1, int(face.shape[0] * scale))))
    frame = np.full((h, w, 3), (64, 48, 32), dtype=np.uint8)
    y = (h - face.shape[0]) // 2
    x = (w - face.shape[1]) // 2
    frame[y:y + face.shape[0], x:x + face.shape[1]] = face
    plate = path + ".plate.png"
    cv2.imwrite(plate, frame)
    try:
        r = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", plate,
             "-t", str(seconds), "-r", str(fps), "-c:v", "libx264", "-pix_fmt", "yuv420p", path],
            capture_output=True, text=True,
        )
        if r.returncode != 0 or not os.path.exists(path):
            raise RuntimeError(f"素材動画の書き出しに失敗しました: {(r.stderr or '')[-300:]}")
    finally:
        os.remove(plate)


def main_selftest():
    check(
        "前提: ffmpeg/ffprobe が使える",
        shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None,
        "ffmpeg/ffprobe が見つかりません。",
    )

    work = os.path.join(HERE, "_delivery_face_scan_tmp")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)

    try:
        # --- SKILL.md 手順7/7.5相当: 出力フォルダに素顔版とモザイク版を作る ---
        # 実際の運用（M-4-H が指摘する状況）と同じく、モザイク版を焼いた後も
        # 素顔版は output/<id>/ に残り続ける。
        output_dir = os.path.join(work, "output", "job1")
        os.makedirs(output_dir, exist_ok=True)
        stem = "short-01"
        plain_path = os.path.join(output_dir, f"{stem}.mp4")
        mosaic_path = os.path.join(output_dir, f"{stem}-mosaic.mp4")
        build_plain_clip(plain_path)
        check("前提: 素顔版の動画を作れる", os.path.exists(plain_path))

        run_cli = subprocess.run(
            [sys.executable, CLI, plain_path, mosaic_path], capture_output=True, text=True
        )
        check(
            "前提: apply_mosaic_cli.py がモザイク版を作れる",
            run_cli.returncode == 0 and os.path.exists(mosaic_path),
            (run_cli.stderr or "")[-300:],
        )

        # --- 検出器自体が今回の素材で機能することの対照（有るとき有ると言えること） ---
        plain_total, plain_leaked = scan_video_file(plain_path)
        check(
            "対照: モザイクを掛けていない素顔版は、全コマで顔が検出される"
            "（この検査が『検出できていないだけ』で通っていないことの確認）",
            plain_total > 0 and plain_leaked == plain_total,
            f"{plain_leaked}/{plain_total} コマで検出",
        )

        mosaic_total, mosaic_leaked = scan_video_file(mosaic_path)
        check(
            "前提: モザイク版単体は素顔が検出されない",
            mosaic_total > 0 and mosaic_leaked == 0,
            f"{mosaic_leaked}/{mosaic_total} コマで検出",
        )

        # ------------------------------------------------------------
        # ケースA（混入・異常系）: SKILL.md 手順9で、モザイク版へ読み替えるのを
        # 忘れて素顔版をそのまま「採用」フォルダへコピーしてしまったケース。
        # ------------------------------------------------------------
        mistake_dir = os.path.join(work, "output", "job1", "採用_mistake")
        deliver_clip(output_dir, mistake_dir, stem, use_mosaic=False)
        check(
            "ケースA(混入): 納品フォルダに素顔版だけが置かれている（テスト前提の確認）",
            sorted(os.listdir(mistake_dir)) == [f"{stem}.mp4"],
            f"実際={sorted(os.listdir(mistake_dir))}",
        )

        mistake_results = scan_delivery_folder(mistake_dir)
        mistake_leak = report(mistake_results)
        check(
            "ケースA(混入): 検査ツールが『間違えて素顔をコピーしたケース』を検出できる（FAIL判定）",
            mistake_leak is True,
            f"scan_delivery_folder の判定結果={mistake_results}",
        )
        check(
            "ケースA(混入): 検査ツールのCLI終了コードも異常（1）を返す",
            main_cli(mistake_dir) == 1,
        )

        # ------------------------------------------------------------
        # ケースB（対照・正常系）: SKILL.md 手順9どおり、モザイク版だけを
        # 「採用」フォルダへコピーしたケース。検査は通らなければならない。
        # ------------------------------------------------------------
        ok_dir = os.path.join(work, "output", "job1", "採用_ok")
        deliver_clip(output_dir, ok_dir, stem, use_mosaic=True)
        check(
            "ケースB(対照): 納品フォルダにモザイク版だけが置かれている（テスト前提の確認）",
            sorted(os.listdir(ok_dir)) == [f"{stem}-mosaic.mp4"],
            f"実際={sorted(os.listdir(ok_dir))}",
        )

        ok_results = scan_delivery_folder(ok_dir)
        ok_leak = report(ok_results)
        check(
            "ケースB(対照): モザイク版だけを置いたケースでは検査が通る（PASS判定）",
            ok_leak is False,
            f"scan_delivery_folder の判定結果={ok_results}",
        )
        check(
            "ケースB(対照): 検査ツールのCLI終了コードも正常（0）を返す",
            main_cli(ok_dir) == 0,
        )

        # ------------------------------------------------------------
        # 検査ツールが「フォルダに置かれている実物」だけを見ており、
        # ファイル名（-mosaic の有無）で判定していないことの確認。
        # ファイル名の文字列一致だけで判定するツールは、モザイク版のファイルを
        # 素顔版にリネームして混入させる事故を見逃す（SKILL.md の遵守が前提の
        # 元の問題と同じ穴が、検査ツール側に開くのを防ぐ）。
        # ------------------------------------------------------------
        renamed_dir = os.path.join(work, "output", "job1", "採用_renamed")
        os.makedirs(renamed_dir, exist_ok=True)
        # 素顔版の中身を、モザイク版と紛らわしい名前でコピーする
        shutil.copy(plain_path, os.path.join(renamed_dir, f"{stem}-mosaic.mp4"))
        renamed_results = scan_delivery_folder(renamed_dir)
        renamed_leak = report(renamed_results)
        check(
            "回帰防止: ファイル名が『-mosaic.mp4』でも、中身が素顔なら検査は落ちる"
            "（ファイル名ではなく実際の画素を見ていることの確認）",
            renamed_leak is True,
            f"scan_delivery_folder の判定結果={renamed_results}",
        )

    finally:
        shutil.rmtree(work, ignore_errors=True)

    print(f"\n--- {passed} PASS / {failed} FAIL ---")
    return 1 if failed else 0


if __name__ == "__main__":
    if len(sys.argv) > 1:
        sys.exit(main_cli(sys.argv[1]))
    sys.exit(main_selftest())
