"""縦型切り抜きの検証素材 — G-EDIT-REFRAME の RF-R / RF-N / RF-M

動画はコミットできない（`.gitignore` が `*.mp4` を除外している）ため、
リポジトリに入っている public domain の静止画から、**決められた数値どおりに合成**する。
数値をここに書き切ることで、実装後に都合のよい素材を選ぶ余地を無くしている。

【命名について】ここで作る素材は RF-R / RF-N / RF-M と呼ぶ（1920x1080・30fps・30コマ・動く）。
G-EDITOR の detail が凍結している「素材R/N/M」（1280x720・15fps・2秒・静止、
G-EDIT-MOSAIC-UI 等が使用中）とは中身が異なる別物であり、名前の衝突を避けるため接頭辞 RF- を付ける
（2026-08-08 basis-reviewer 反証(3)。tests/mosaic-ui-check.py の build_material_r 等は G-EDITOR 側の
旧定義を実装したもので、本ファイルとは無関係）。

素材の作り方（凍結。ロードマップの G-EDIT-REFRAME の detail と同じ内容にすること）:

  共通
    ・寸法 1920x1080（16:9）、30コマ、30fps。
    ・背景 BACKGROUND: 青=横位置に比例、緑=縦位置に比例、赤=64px 角の市松（30 と 230）。
      一様な背景にしないのは、黒帯の判定と「入力の絵が保たれているか」の判定に
      位置が一意に定まる模様が要るため。
    ・貼り付けは最近傍拡大（INTER_NEAREST）。拡大方法で顔の大きさが変わらないようにする。
    ・音声を付ける版(RF-R-A / RF-N-A / RF-M-A)は、左440Hz・右880Hz・48000Hz・1.000秒
      （＝FRAMES/FPS）のステレオ正弦波を AAC 128kbps で足す(G-EDITOR の素材R-Aと同じ作り方)。
      左右で違う音にするのは、左右が入れ替わる壊れ方・モノラル化する壊れ方を検出できるようにするため。

  RF-R（1人・顔が画面の約31%。2026-08-10 basis-reviewer 反証(2)是正で動きを刷新）
    ・face-one.png を3倍（642x720）にして y=180 に貼る。
    ・横位置(顔中心 cx)は、速度変化・向きの反転を含む4区間の折れ線で動かす
      （実測: 顔を一切見ない「始点と終点だけを直線で結ぶ決め打ちパン」は、この折れ線と
      大きく乖離する区間で検出そのものが0件になり、30コマ中6コマ(i=6..11)が不合格になる。
      2026-08-08時点の等速直線1本の動きでは、この決め打ちが30/30で合格していた）:
        i= 0..9  (フェーズ1・速い): cx 1440 -> 540  (-100.0px/コマ)
        i=10..14 (フェーズ2・反転・やや速い): cx 540 -> 840  (+75.0px/コマ)
        i=15..19 (フェーズ3・遮蔽区間・ほぼ静止): cx 840 -> 780  (-15.0px/コマ)
        i=20..29 (フェーズ4・遅い): cx 780 -> 480  (-33.3px/コマ)
      区間の境目(i=9/10, i=14/15, i=19/20)は同じcxで接続し、位置が瞬間移動しない。
    ・遮蔽: i=16,17,18 の3コマは、貼り付けた顔画像の右側45%(289px)を、
      同じ位置の背景模様で覆う(「手前を横切る物体」を模す。全遮蔽にしないのは、
      全遮蔽だと入力そのものから顔が消え、どんな実装でも検出できなくなり
      葉Bの「30/30コマで顔が写る」を誰も満たせなくなるため)。
    ・実測(2026-08-10、cv2.FaceDetectorYN・SCORE_THRESHOLD=0.6・NMS_THRESHOLD=0.3、
      検出矩形の高さ=顔の高さ、と定義して計測。クロップ幅は 608px(=1080×9/16 の丸め)を
      仮定したプロトタイプでの数値。実装が採る実際のクロップ幅はこの葉の合否には影響しない):
        入力フレームでの検出: 30/30コマで1件(遮蔽コマ含む)。
        素朴な「検出+保持(hold)」プロトタイプで9:16へ追従クロップした場合:
          顔の高さは画面の 27.5〜30.9%（30/30コマで15%を上回る。遮蔽3コマも含めて全コマ合格）。
        黒帯方式(letterbox)へ落とすと 9.3〜10.1%（15%の境界の下）。
        決め打ちパン(cx(0)とcx(29)を直線で結んだだけの窓移動)では、i=6..11 の6コマで
          窓が顔の範囲から完全に外れ検出0件(不合格)、それ以外の24コマは20.3〜30.6%。

  RF-N（顔なし。2026-08-10 basis-reviewer 反証(4)(5)是正で移動量としきい値を刷新）
    ・背景だけ。コマごとに横へ N_SHIFT_PER_FRAME=16px ずつずらす(30コマで464px動く。
      2026-08-08時点は8px/コマで、1コマ固着(2.792)と2コマ固着(5.455)の間に
      旧しきい値4.0が落ちており、1コマ遅延の壊れ方(実測最大3.772)が誤って合格していた)。
    ・実測(製品と同じ設定 -c:v libx264 -preset veryfast -crf 20 -bf 0 -pix_fmt yuv420p で
      実際にletterbox+エンコードし、可逆参照との画面全体の平均絶対差(8bit階調・各フレームの
      最大値)を比較): 正しい実装(letterbox実エンコードそのもの) 最大1.466 / 1コマ遅延(最も
      紛らわしい壊れ方) 最大6.347 / 2コマ遅延 最大11.615 / 3コマ遅延 最大16.902 /
      全編1コマ目固着 最大26.077。新しいしきい値3.0は、正しい実装(1.466)といちばん近い
      壊れ方(1コマ遅延・6.347)の間に、どちらからも約2倍の余裕を持って置いた
      （幾何平均は√(1.466×6.347)≈3.05）。半分の解像度に落として戻す劣化(幾何は壊れない
      画質劣化)は最大1.619で、この測り方では捕まえられない(意図した限界。幾何が壊れる系だけを
      捕まえる)。

  RF-M（3人。2026-08-10 basis-reviewer 反証(7)是正で全コマ静止をやめた）
    ・face-one.png / face-two.png の右半分（x=269..483／Aldrin）/ face-other.png をそれぞれ
      2倍にして y=300 付近、x=160 / 760 / 1360 付近に貼る。
    ・背景は RF-N と同じ16px/コマの横移動。3人の顔もそれぞれ振幅40px・周期の異なる
      正弦運動で左右に(2人目は上下にも)小さく動かす(2026-08-08時点は30コマ全て
      完全同一画像で、隣接コマ差が0.000だったため「絵が保たれているか」を
      原理的に測れなかった)。
    ・実測: 全30コマで顔検出はちょうど3件(退場させる案は採らなかった。3件のまま
      動かし続けることで、G-EDIT-REFRAME-E が要求する「MAX_TRACKED_FACES=2を超えるので
      常に黒帯方式へ落ちる」という前提が全コマで崩れないようにするため)。
      隣接コマの平均絶対差(生画素)は 15.9〜20.6 で、静止コマは無い。
    ・G-EDIT-REFRAME-D2 と同じ測り方・同じしきい値3.0での実測(製品と同じエンコード設定):
      正しい実装(letterbox実エンコードそのもの) 最大1.368 / 1コマ遅延 最大7.074 /
      全編1コマ目固着 最大22.426。RF-N と同様、正しい実装としきい値、しきい値といちばん
      近い壊れ方(1コマ遅延)の双方に十分な余裕がある。
"""

import math
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
AUDIO_DURATION = FRAMES / FPS  # 1.000秒

# 素材の元になる静止画。中身が変われば合成結果も変わるので SHA-256 で固定する。
STILL_SHA = {
    "face-one.png": "c06fe35d4f8482b49a514ca56812105064fedc7d61976b44542137f30ad51a7e",
    "face-two.png": "6da3832aa9dd5cddad9f6894f5261c57789902e1b1b6964963fa25d269f14962",
    "face-other.png": "085b180755c743c9719c20b28ba2b08598803f98894a6c268ae7420f4416a2e6",
}

# RF-R の顔の動き（貼り付け位置）
R_PASTE_Y = 180
R_SCALE = 3
# 顔中心x(cx)の折れ線。(フレーム番号, cx) の区間ごとに等間隔で直線補間する。
R_CX_BREAKPOINTS = [
    (0, 1440),
    (9, 540),
    (10, 540),
    (14, 840),
    (15, 840),
    (19, 780),
    (20, 780),
    (29, 480),
]
# 遮蔽コマ(部分遮蔽・顔画像の右側を隠す)
R_OCCLUDED_FRAMES = (16, 17, 18)
R_OCCLUDE_RATIO = 0.45  # 顔画像の右側何割を隠すか

# RF-N の移動量
N_SHIFT_PER_FRAME = 16

# RF-M の貼り付けと動き
M_PASTE_Y = 300
M_SCALE = 2
M_BASE_X = (160, 760, 1360)
M_BG_SHIFT = N_SHIFT_PER_FRAME  # RF-N と同じ量にして一貫させる
# (振幅px, 周期コマ, 位相) を人物ごとに変える。2人目だけ縦方向にも振れる。
M_OSC = {
    0: {"x": (40, 15, 0.0)},
    1: {"x": (40, 12, 1.0), "y": (20, 10, 0.5)},
    2: {"x": (40, 18, 2.0)},
}


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


def _r_center_x(i):
    """RF-R の顔中心x(cx)を、区間ごとの折れ線から求める。"""
    pts = R_CX_BREAKPOINTS
    for (f0, x0), (f1, x1) in zip(pts, pts[1:]):
        if f0 <= i <= f1:
            if f1 == f0:
                return float(x0)
            return x0 + (x1 - x0) * (i - f0) / (f1 - f0)
    raise ValueError(f"frame {i} が R_CX_BREAKPOINTS の範囲外です")


def frames_R():
    """RF-R: 1人の顔が、速度変化・向きの反転・部分遮蔽をともなって動く。"""
    verify_stills()
    bg = background()
    face_base = _scaled("face-one.png", R_SCALE)
    fh, fw = face_base.shape[:2]
    cut = round(fw * R_OCCLUDE_RATIO)
    out = []
    for i in range(FRAMES):
        cx = _r_center_x(i)
        x = round(cx - fw / 2)
        f = bg.copy()
        face = face_base.copy()
        if i in R_OCCLUDED_FRAMES:
            # 顔の右側を、その位置の背景模様で覆う(手前を横切る物体を模す)。
            face[:, fw - cut:] = bg[R_PASTE_Y:R_PASTE_Y + fh, x + fw - cut:x + fw]
        _paste(f, face, x, R_PASTE_Y)
        out.append(f)
    return out


def frames_N():
    """RF-N: 顔が写らない。コマごとに絵が動く（コマ固着を検出できるようにするため）。"""
    bg = background(WIDTH + N_SHIFT_PER_FRAME * FRAMES, HEIGHT)
    return [bg[:, i * N_SHIFT_PER_FRAME:i * N_SHIFT_PER_FRAME + WIDTH].copy()
            for i in range(FRAMES)]


def _osc(base, amp, period, phase, i):
    return base + amp * math.sin(2 * math.pi * (i / period) + phase)


def frames_M():
    """RF-M: 3人が横に並び、それぞれ小さく動く。背景も RF-N と同じ量で流れる。"""
    verify_stills()
    wide_bg = background(WIDTH + M_BG_SHIFT * FRAMES, HEIGHT)
    faces = [
        _scaled("face-one.png", M_SCALE),
        _scaled("face-two.png", M_SCALE, crop=(269, 483)),
        _scaled("face-other.png", M_SCALE),
    ]
    out = []
    for i in range(FRAMES):
        f = wide_bg[:, i * M_BG_SHIFT:i * M_BG_SHIFT + WIDTH].copy()
        for idx, (img, base_x) in enumerate(zip(faces, M_BASE_X)):
            osc = M_OSC[idx]
            x = round(_osc(base_x, *osc["x"], i))
            y = M_PASTE_Y
            if "y" in osc:
                y = round(M_PASTE_Y + _osc(0, *osc["y"], i))
            _paste(f, img, x, y)
        out.append(f)
    return out


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


def write_lossless_with_audio(frames, path, duration=AUDIO_DURATION):
    """可逆な映像(RF-R/N/M と同じ)に、左440Hz・右880Hzのステレオ音声を足して書き出す。

    映像は libx264rgb -qp 0 で可逆、音声は AAC(合成音源そのものが決定的なので、
    音声側は非可逆でも「左右どちらの周波数が支配的か」を測るぶんには影響しない)。
    2026-08-08 basis-reviewer 反証(9)（凍結素材が無音のため、実装が音声を落としても
    A/B/D/E が全部緑のままだった）を塞ぐための音声付き版(RF-R-A / RF-N-A / RF-M-A)。
    """
    h, w = frames[0].shape[:2]
    proc = subprocess.Popen([
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(FPS), "-i", "-",
        "-f", "lavfi", "-i", f"aevalsrc=sin(2*PI*440*t)|sin(2*PI*880*t):s=48000:d={duration}",
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264rgb", "-qp", "0", "-pix_fmt", "bgr24",
        "-c:a", "aac", "-b:a", "128k", "-shortest",
        path,
    ], stdin=subprocess.PIPE)
    for f in frames:
        proc.stdin.write(f.tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError(f"音声付き素材の書き出しに失敗しました: {path}")
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


_FRAME_BUILDERS = {"R": frames_R, "N": frames_N, "M": frames_M}


def build(kind, path):
    """素材を作って path へ書き出し、読み戻して元と1画素も違わないことを確かめる。"""
    frames = _FRAME_BUILDERS[kind]()
    write_lossless(frames, path)
    back = read_frames(path)
    if len(back) != len(frames):
        raise AssertionError(f"素材{kind}: 書き出しでコマ数が変わった（{len(frames)} → {len(back)}）")
    for i, (a, b) in enumerate(zip(frames, back)):
        if not np.array_equal(a, b):
            raise AssertionError(f"素材{kind}: 書き出しが可逆でない（コマ {i} が一致しない）")
    return frames


def build_with_audio(kind, path):
    """音声付き版(RF-{kind}-A)を作って path へ書き出し、映像コマは build() と同じく可逆性を確かめる。

    音声そのものの内容確認(左右の支配周波数など)は呼び出し側の責務とする
    (どこまでの許容差で見るかは、それを使う葉のverifyが決める)。
    """
    frames = _FRAME_BUILDERS[kind]()
    write_lossless_with_audio(frames, path)
    back = read_frames(path)
    if len(back) != len(frames):
        raise AssertionError(f"素材{kind}-A: 書き出しでコマ数が変わった（{len(frames)} → {len(back)}）")
    for i, (a, b) in enumerate(zip(frames, back)):
        if not np.array_equal(a, b):
            raise AssertionError(f"素材{kind}-A: 書き出しが可逆でない（コマ {i} が一致しない）")
    return frames


if __name__ == "__main__":
    import tempfile
    sys.path.insert(0, os.path.join(ROOT, "src"))
    from face_mosaic import detect_faces  # noqa: E402

    with tempfile.TemporaryDirectory() as d:
        for kind, want in (("R", 1), ("N", 0), ("M", 3)):
            frames = build(kind, os.path.join(d, f"{kind}.mp4"))
            counts = [len(detect_faces(f)) for f in frames]
            print(f"RF-{kind}: {len(frames)}コマ 検出件数={sorted(set(counts))} (期待 {want})")
