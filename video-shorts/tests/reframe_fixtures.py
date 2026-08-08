"""縦型切り抜きの検証素材 — G-EDIT-REFRAME の素材R / 素材N / 素材M

動画はコミットできない（`.gitignore` が `*.mp4` を除外している）ため、
リポジトリに入っている public domain の静止画から、**決められた数値どおりに合成**する。
数値をここに書き切ることで、実装後に都合のよい素材を選ぶ余地を無くしている。

素材の作り方（凍結。ロードマップの G-EDIT-REFRAME の detail と同じ内容）:

  共通
    ・寸法 1920x1080（16:9）、30コマ、30fps。
    ・背景 BACKGROUND: 青=横位置に比例、緑=縦位置に比例、赤=64px 角の市松（30 と 230）。
      一様な背景にしないのは、黒帯の判定と「入力の絵が保たれているか」の判定に
      位置が一意に定まる模様が要るため。
    ・貼り付けは最近傍拡大（INTER_NEAREST）。拡大方法で顔の大きさが変わらないようにする。

  素材R（1人・顔が画面の約31%）
    ・face-one.png を3倍（642x720）にして y=180 に貼る。
    ・横位置 x は 1119 から 159 へ 30コマで等間隔に動かす（顔の中心が 1437 → 477）。
    ・画面の中央に固定で切り抜く実装を落とすため、顔は横中央に置かない。
    ・実測: 顔の高さは画面の 30.8〜32.4%。黒帯方式へ落とすと 10.0% になる（15% の境界の下）。

  素材N（顔なし）
    ・背景だけ。ただしコマごとに横へ 8px ずつずらす（30コマで 232px 動く）。
      静止画のままだと、1コマ目を全編に貼り付けるだけの壊れ方を誰も検出できない。
    ・実測: 顔検出は0件。

  素材M（3人）
    ・face-one.png / face-two.png の右半分（x=269..483／Aldrin）/ face-other.png を
      それぞれ2倍にして y=300、x=160 / 760 / 1360 に貼る。
    ・実測: 顔検出は3件。
"""

import os
import subprocess
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURE_DIR = os.path.join(HERE, "fixtures")

WIDTH = 1920
HEIGHT = 1080
FRAMES = 30
FPS = 30

# 素材の元になる静止画。中身が変われば合成結果も変わるので SHA-256 で固定する。
STILL_SHA = {
    "face-one.png": "c06fe35d4f8482b49a514ca56812105064fedc7d61976b44542137f30ad51a7e",
    "face-two.png": "6da3832aa9dd5cddad9f6894f5261c57789902e1b1b6964963fa25d269f14962",
    "face-other.png": "085b180755c743c9719c20b28ba2b08598803f98894a6c268ae7420f4416a2e6",
}

# 素材R の顔の動き（貼り付け位置 x）
R_PASTE_Y = 180
R_SCALE = 3
R_X_FROM = 1119
R_X_TO = 159

# 素材M の貼り付け
M_PASTE_Y = 300
M_SCALE = 2
M_PASTE_X = (160, 760, 1360)


def verify_stills():
    """元の静止画が凍結どおりか確かめる。違えば合成結果も変わるので、その場で落とす。"""
    import hashlib

    for name, want in STILL_SHA.items():
        p = os.path.join(FIXTURE_DIR, name)
        got = hashlib.sha256(open(p, "rb").read()).hexdigest()
        if got != want:
            raise AssertionError(f"素材の元画像が変わっている: {name}\n  期待 {want}\n  実際 {got}")


def background(w=WIDTH, h=HEIGHT):
    """位置が一意に定まる決定的な模様。"""
    yy, xx = np.mgrid[0:h, 0:w]
    b = ((xx * 255) // (w - 1)).astype(np.uint8)
    g = ((yy * 255) // (h - 1)).astype(np.uint8)
    r = (((xx // 64) + (yy // 64)) % 2 * 200 + 30).astype(np.uint8)
    return np.dstack([b, g, r])


def _paste(canvas, img, x, y):
    canvas[y:y + img.shape[0], x:x + img.shape[1]] = img


def _scaled(name, factor, crop=None):
    img = cv2.imread(os.path.join(FIXTURE_DIR, name))
    if img is None:
        raise FileNotFoundError(os.path.join(FIXTURE_DIR, name))
    if crop is not None:
        img = img[:, crop[0]:crop[1]]
    return cv2.resize(img, (img.shape[1] * factor, img.shape[0] * factor),
                      interpolation=cv2.INTER_NEAREST)


def frames_R():
    """素材R: 1人の顔が右から左へ動く。"""
    verify_stills()
    bg = background()
    face = _scaled("face-one.png", R_SCALE)
    out = []
    for i in range(FRAMES):
        x = round(R_X_FROM + (R_X_TO - R_X_FROM) * i / (FRAMES - 1))
        f = bg.copy()
        _paste(f, face, x, R_PASTE_Y)
        out.append(f)
    return out


N_SHIFT_PER_FRAME = 8


def frames_N():
    """素材N: 顔が写らない。コマごとに絵が動く（コマ固着を検出できるようにするため）。"""
    bg = background(WIDTH + N_SHIFT_PER_FRAME * FRAMES, HEIGHT)
    return [bg[:, i * N_SHIFT_PER_FRAME:i * N_SHIFT_PER_FRAME + WIDTH].copy()
            for i in range(FRAMES)]


def frames_M():
    """素材M: 3人が横に並ぶ。"""
    verify_stills()
    bg = background()
    faces = [
        _scaled("face-one.png", M_SCALE),
        _scaled("face-two.png", M_SCALE, crop=(269, 483)),
        _scaled("face-other.png", M_SCALE),
    ]
    f = bg.copy()
    for img, x in zip(faces, M_PASTE_X):
        _paste(f, img, x, M_PASTE_Y)
    return [f.copy() for _ in range(FRAMES)]


def write_lossless(frames, path):
    """可逆で書き出す。非可逆だと符号化器の版で画素が変わり、合格ラインの根拠が版に依存する。

    （顔モザイクで mp4v を使って実際にそうなったため、同じ書き出し方を使う）
    """
    h, w = frames[0].shape[:2]
    proc = subprocess.Popen([
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(FPS), "-i", "-",
        "-c:v", "libx264rgb", "-qp", "0", "-pix_fmt", "bgr24", path,
    ], stdin=subprocess.PIPE)
    for f in frames:
        proc.stdin.write(f.tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError(f"素材の書き出しに失敗しました: {path}")
    return path


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


def build(kind, path):
    """素材を作って path へ書き出し、読み戻して元と1画素も違わないことを確かめる。"""
    frames = {"R": frames_R, "N": frames_N, "M": frames_M}[kind]()
    write_lossless(frames, path)
    back = read_frames(path)
    if len(back) != len(frames):
        raise AssertionError(f"素材{kind}: 書き出しでコマ数が変わった（{len(frames)} → {len(back)}）")
    for i, (a, b) in enumerate(zip(frames, back)):
        if not np.array_equal(a, b):
            raise AssertionError(f"素材{kind}: 書き出しが可逆でない（コマ {i} が一致しない）")
    return frames


if __name__ == "__main__":
    import tempfile
    sys.path.insert(0, os.path.join(ROOT, "src"))
    from face_mosaic import detect_faces  # noqa: E402

    with tempfile.TemporaryDirectory() as d:
        for kind, want in (("R", 1), ("N", 0), ("M", 3)):
            frames = build(kind, os.path.join(d, f"{kind}.mp4"))
            counts = [len(detect_faces(f)) for f in frames]
            print(f"素材{kind}: {len(frames)}コマ 検出件数={sorted(set(counts))} (期待 {want})")
