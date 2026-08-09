"""詰めても絵と音がずれないことの検証 — 軌道修正 C-3

【守る受入事実】無音や言い淀みを詰めたあとも、出力の各コマの「絵」と、同じ時刻に鳴っている
「音」が、元の素材で同じ時刻にあったものであること。＝口の動きと声がずれないこと。

【なぜ「尺の差」で測らないか】一度書いた受入基準「出力の映像と音声の尺の差が1コマ未満」は
検証で却下された。壊れたコードに -shortest を1個足すだけで差 0.7ms となり合格するが、
末尾を切り落としただけで時間軸の中の累積ずれは残る。「一切詰めない」偽物も差 60.0ms で合格した。
既存の src/av-verify.mjs も v:0/a:0 の start_time しか見ないので、この累積ずれには原理的に盲目。

【この検査の測り方】素材の各コマに「そのコマの番号」を絵として焼き、同時に、そのコマの間だけ
「番号で決まる高さの音」を鳴らす。つまり絵と音の両方が、元のコマ番号を持っている。
詰めたあとの出力について、コマごとに
  絵から読んだ番号 と 音の高さから読んだ番号 が一致するか
を全コマで確かめる。末尾の合計ではなく各コマで測るので、-shortest では合格できない。

【素材】このファイルが合成する（コミットしない）。合成手順は下の定数で数値として確定してある。
可逆（libx264rgb -qp 0）で書き、読み戻して1画素一致を確かめてから使う。

実行: python3 tests/trim-sync-check.py   (全PASSで exit 0)
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

# ── 素材の作り（数値で確定させる）──────────────────────────────
W, H = 320, 180
FPS = 15                  # コマ数/秒。コマ周期 = 1/15 秒
N_FRAMES = 150            # 10 秒ぶん
SAMPLE_RATE = 48000
BASE_HZ = 400             # コマ0 の音の高さ
STEP_HZ = 100             # コマが1つ進むごとに上がる高さ
# 100 Hz にする理由: 音の高さを測る窓は半コマぶん（48000/15/2 = 1600 標本）で、
# その分解能は 48000/1600 = 30 Hz。コマ間隔がこれに近いと隣り合うコマを見分けられず、
# 実装が正しくても ±1 コマの食い違いが出る（20 Hz のとき実際に出た）。
# 30 Hz の3倍以上離す。最高でも 400+100*149 = 15300 Hz で、24000 Hz の上限に収まる。
MARKER_CELL = 8           # 目印1ビットの大きさ（画素）
MARKER_BITS = 16

PASS = 0
FAIL = 0


def check(ok, msg):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS {msg}")
    else:
        FAIL += 1
        print(f"FAIL {msg}")


def stamp(frame, n):
    """左上にコマ番号 n を16ビットの白黒の升目として焼く（tests/mosaic-ui-check.py と同じ形）"""
    for i in range(MARKER_BITS):
        bit = (n >> (MARKER_BITS - 1 - i)) & 1
        x = i * MARKER_CELL
        frame[0:MARKER_CELL, x:x + MARKER_CELL] = 255 if bit else 0
    return frame


def read_marker(frame):
    n = 0
    for i in range(MARKER_BITS):
        x = i * MARKER_CELL
        cell = frame[0:MARKER_CELL, x:x + MARKER_CELL]
        n = (n << 1) | (1 if float(cell.mean()) > 128 else 0)
    return n


def frame_hz(n):
    """コマ n の間に鳴らす音の高さ"""
    return BASE_HZ + STEP_HZ * n


def build_material(path):
    """コマ番号を絵と音の両方に持たせた素材を作る"""
    raw_v = path + ".rawv"
    raw_a = path + ".raw"
    with open(raw_v, "wb") as f:
        for n in range(N_FRAMES):
            # 背景はコマごとに少し変える（全部同じ絵だと、並べ替えを画素比較で検出できないため）
            frame = np.full((H, W, 3), (n * 7) % 200, dtype=np.uint8)
            f.write(stamp(frame, n).tobytes())

    # 音: コマ n の区間だけ frame_hz(n) の正弦波。位相を継いで不連続なノイズを避ける。
    samples = []
    phase = 0.0
    per_frame = SAMPLE_RATE // FPS
    for n in range(N_FRAMES):
        hz = frame_hz(n)
        t = np.arange(per_frame)
        ph = phase + 2 * np.pi * hz * t / SAMPLE_RATE
        samples.append(np.sin(ph))
        phase = ph[-1] + 2 * np.pi * hz / SAMPLE_RATE
    pcm = (np.concatenate(samples) * 20000).astype("<i2")
    with open(raw_a, "wb") as f:
        f.write(pcm.tobytes())

    subprocess.run([
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", raw_v,
        "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", raw_a,
        # 可逆。圧縮でコマ番号の升目がにじむと、読み取りが崩れる
        "-c:v", "libx264rgb", "-qp", "0", "-pix_fmt", "bgr24",
        "-c:a", "pcm_s16le",
        path,
    ], check=True)
    os.remove(raw_v)
    os.remove(raw_a)


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


def read_pcm(path):
    raw = subprocess.run([
        "ffmpeg", "-v", "error", "-i", path,
        "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-",
    ], stdout=subprocess.PIPE, check=True).stdout
    return np.frombuffer(raw, dtype="<i2").astype(np.float64)


def hz_at(pcm, t0, t1):
    """[t0,t1) 秒の区間で一番強い周波数を返す"""
    a = int(t0 * SAMPLE_RATE)
    b = int(t1 * SAMPLE_RATE)
    seg = pcm[a:b]
    if len(seg) < 64:
        return None
    win = seg * np.hanning(len(seg))
    spec = np.abs(np.fft.rfft(win))
    freqs = np.fft.rfftfreq(len(win), 1.0 / SAMPLE_RATE)
    return float(freqs[int(np.argmax(spec))])


def hz_to_frame(hz):
    return int(round((hz - BASE_HZ) / STEP_HZ))


def render_product(src, start, end, out):
    """出荷経路そのもの（pipeline.mjs の renderSegment）を呼んで作る。

    【この検査は式を1つも写さない】開始をコマの境目へ揃えるのも、詰める区間を決めるのも、
    字幕の時刻を写すのも、焼くのも、すべて renderSegment の中で起きる。検査が渡すのは
    「素材・切り出す秒・語」だけで、揃え方は一切知らない。
    以前は検査が自分で `tp.snapStart(...)` を呼んで renderClip へ渡していたため、
    出荷経路（pipeline.mjs）の揃えを消しても検査が自前の写しで揃えてしまい、緑のままだった。
    実測（2026-08-08、independent-verifier）: pipeline.mjs の
    `const segStart = snapStart(seg.start, srcFps);` を `const segStart = seg.start;` に
    しても 19 PASS / 0 FAIL だった。

    start はわざとコマの境目でない時刻を渡す。製品は -ss で入力シークするので、
    そこが揃っていないとコマ格子ごとずれる。
    """
    js = """
import('%s/pipeline.mjs').then(async (pl) => {
  const rv = await import('%s/src/render-vertical.mjs');
  const size = await rv.probeSize('%s');
  const start = %s, end = %s;
  // 区間の中の語（ここでは「1秒ごとに0.7秒しゃべる」を模す）。時刻は素材の上の絶対秒で、
  // 製品と同じく renderSegment の中で区間の頭からの相対秒へ写される。
  const words = [];
  for (let k = 0; start + k * 1.0 + 0.7 <= end; k++) {
    words.push({ w: 'あ', start: start + k * 1.0, end: start + k * 1.0 + 0.7 });
  }
  const r = await pl.renderSegment({
    input: '%s',
    seg: { start, end, duration: end - start, hook: 'x' },
    words,
    srcFps: size.fps, srcW: size.width, srcH: size.height,
    orientation: 'portrait', trim: true, subtitle: null,
    output: '%s', onLog: () => {},
  });
  console.log(JSON.stringify({ fps: size.fps, spans: r.keep.length, segStart: r.segStart,
    cutSeconds: r.cutSeconds, keep: r.keep }));
});
""" % (ROOT, ROOT, src, start, end, src, out)
    got = subprocess.run(["node", "-e", js], stdout=subprocess.PIPE, check=True,
                         encoding="utf-8").stdout
    return json.loads(got)


def render(src, keep, out, shortest=False):
    """【対照専用】keep 区間だけを残して詰める。揃えない場合と -shortest の比較に使う。"""
    js = (
        'import("%s/src/trim-plan.mjs").then(m=>{'
        'const f=m.buildTrimFilters(%s);'
        'console.log(JSON.stringify({v:f.videoChain,a:f.audioChain}));});'
    ) % (ROOT, json.dumps(keep))
    got = subprocess.run(["node", "-e", js], stdout=subprocess.PIPE, check=True,
                         encoding="utf-8").stdout
    f = json.loads(got)
    args = [
        "ffmpeg", "-y", "-v", "error", "-i", src,
        "-filter_complex", f["v"] + ";" + f["a"],
        "-map", "[tvout]", "-map", "[taout]",
        "-c:v", "libx264rgb", "-qp", "0", "-pix_fmt", "bgr24",
        "-c:a", "pcm_s16le",
    ]
    if shortest:
        args.append("-shortest")
    args.append(out)
    subprocess.run(args, check=True)


def measure(out, y_offset=0):
    """出力の映像のコマ1つにつき1件、(絵から読んだ番号, 音から読んだ番号) を返す

    音が読めなかったコマは (絵の番号, None) を返す。**読み飛ばさない。**
    以前はここで `continue` していたため、「全コマで一致」の"全コマ"が
    「出力の映像のコマ全部」ではなく「音がまだ残っていたコマだけ」に縮んでいた。
    実測（2026-08-08、independent-verifier）: buildTrimFilters の音声側を先頭3区間しか
    concat しない実装にすると、映像 6.133秒/92コマ に対し音が 2.197秒しか無い動画になるのに
    19 PASS / 0 FAIL だった。歯止めは `len(pairs) > 30` という、出力のコマ数と無関係な固定値だけで、
    実装が音の範囲を縮めてもこの閾値の下へ落ちなかった。

    y_offset: 縦化で上に足された黒帯の高さ。製品経路の出力は 9:16 へ pad されるので、
    目印の位置がそのぶん下がる。
    """
    frames = read_frames(out)
    pcm = read_pcm(out)
    pairs = []
    for i, fr in enumerate(frames):
        v = read_marker(fr[y_offset:, :])
        # そのコマが映っている時間の真ん中あたりで音を測る（端は継ぎ目のフェードが掛かる）
        t0 = i / FPS + 0.25 / FPS
        t1 = i / FPS + 0.75 / FPS
        hz = hz_at(pcm, t0, t1)
        pairs.append((v, None if hz is None else hz_to_frame(hz)))
    return pairs


def silent_frames(pairs):
    """音が読めなかったコマの位置。1つでもあれば「絵と音が一致」を問う前提が欠けている。"""
    return [i for i, (_, a) in enumerate(pairs) if a is None]


def audio_span_frames(path):
    """その動画の音の長さを「コマ何個ぶんか」で返す（映像のコマ数と突き合わせるため）"""
    return len(read_pcm(path)) / (SAMPLE_RATE / FPS)


def worst_gap(pairs):
    """絵と音のコマ番号の最大の食い違い。音が読めなかったコマは無限大として扱う
    （読み飛ばすと、音が消えた区間が「一致した」ことになってしまう）。"""
    if any(a is None for _, a in pairs):
        return float("inf")
    return max((abs(v - a) for v, a in pairs), default=0)


def main():
    tmp = tempfile.mkdtemp(prefix="vs-trimsync-")
    src = os.path.join(tmp, "material.mkv")
    build_material(src)

    # ── 素材そのものが前提を満たしているか（対照）──────────────
    frames = read_frames(src)
    check(len(frames) == N_FRAMES, f"対照: 素材のコマ数が {N_FRAMES}（実 {len(frames)}）")
    nums = [read_marker(f) for f in frames]
    check(nums == list(range(N_FRAMES)),
          f"対照: 素材のコマ番号が 0..{N_FRAMES - 1} の順に読める（実の先頭5件={nums[:5]}）")
    pcm = read_pcm(src)
    got = [hz_to_frame(hz_at(pcm, n / FPS + 0.25 / FPS, n / FPS + 0.75 / FPS))
           for n in range(0, N_FRAMES, 10)]
    check(got == list(range(0, N_FRAMES, 10)),
          f"対照: 素材の音からも同じコマ番号が読める（実={got}）")

    # ── 本体: コマ境界へ揃えた区間で詰める ──────────────────────
    # 端をわざと半端な時刻（半コマぶんずらした位置）に置く。揃えないとここでずれる。
    raw = []
    for k in range(10):
        s = k * 1.0 + 0.5 / FPS
        raw.append({"start": round(s, 6), "end": round(s + 29 / 30, 6)})

    js = ('import("%s/src/trim-plan.mjs").then(m=>'
          'console.log(JSON.stringify(m.snapToFrames(%s, %d))));') % (ROOT, json.dumps(raw), FPS)
    snapped = json.loads(subprocess.run(["node", "-e", js], stdout=subprocess.PIPE,
                                        check=True, encoding="utf-8").stdout)

    out = os.path.join(tmp, "trimmed.mkv")
    render(src, snapped, out)
    pairs = measure(out)
    # 「測れたコマ数」を固定値と比べない。固定値だと、実装が音の範囲を縮めても
    # その閾値の下へ落ちないので素通りする（旧: len(pairs) > 50）。
    # 測る対象は「出力の映像のコマ全部」なので、映像のコマ数と等号で結ぶ。
    quiet = silent_frames(pairs)
    check(not quiet,
          f"詰めた出力の映像 {len(pairs)} コマ全部について音を測れた"
          f"（音が無いコマ {len(quiet)} 個 / 先頭={quiet[:3]}）")
    a_span = audio_span_frames(out)
    check(abs(a_span - len(pairs)) <= 1.0,
          f"詰めた出力の音の長さが映像の長さと合っている"
          f"（映像 {len(pairs)} コマ / 音 {a_span:.2f} コマぶん / 許容 1 コマ）")
    bad = [(i, v, a) for i, (v, a) in enumerate(pairs) if v != a]
    check(worst_gap(pairs) == 0,
          f"揃えた区間で詰めれば、全コマで絵と音が同じコマ番号を指す"
          f"（最大ずれ {worst_gap(pairs)} コマ / 食い違い {len(bad)} 件）")

    # ── 本体: 製品と同じ経路で作った出力を測る ────────────────────
    # planTrim が区間を決め、renderClip が -ss で切り出して 9:16 へ焼く。出力設定も製品のまま。
    # 開始秒はわざとコマの境目でない 0.02 秒にする（製品の seg.start は LLM が選ぶ任意の秒）。
    prod = os.path.join(tmp, "product.mp4")
    info = render_product(src, 1.02, 9.0, prod)
    check(info["fps"] is not None, f"製品経路が素材のコマ数/秒を取れている（実 {info['fps']}）")
    check(info["spans"] >= 5, f"製品経路が複数の区間に詰めている（実 {info['spans']} 区間）")
    # 「一切詰めない」実装でも通ってしまわないよう、実際に短くなったことを確かめる。
    # 却下された旧基準は、まさに詰めない偽物が合格していた。
    # ここは「計画」ではなく「出来上がった動画」を測る。
    # 以前は plan.cutSeconds を見ていたため、renderClip が keep を丸ごと無視しても
    # 「詰めている」と表示されて全緑だった（2026-08-08、independent-verifier の指摘）。

    pf = read_frames(prod)
    check(len(pf) > 0, "製品経路の出力にコマがある")

    # 【成果物を、計画した区間と突き合わせる】
    # 総尺の比較では足りない。「全コマで絵と音が一致」は、継ぎ目が1つも無い動画では
    # 自動的に成立してしまう（空虚に真）。実際、一切詰めずに -t を縮めるだけの偽物が
    # 全件 PASS した（2026-08-08、independent-verifier の指摘）。
    # そこで、出力の目印列が「計画した区間のコマ番号を順につないだもの」と
    # 完全に一致することを見る。これ1つで、尺・継ぎ目の有無・継ぎ目の位置・同期が同時に決まる。
    # 縦化で上下に黒帯が付くので、目印の位置が下がる。素材の高さから帯の高さを出す。
    y_off = (pf[0].shape[0] - H) // 2 if pf and pf[0].shape[0] > H else 0
    base = round(info["segStart"] * FPS)
    expected = []
    for sp in info["keep"]:
        a = base + round(sp["start"] * FPS)
        b = base + round(sp["end"] * FPS)
        expected.extend(range(a, b))
    got_marks = [read_marker(fr[y_off:, :]) for fr in pf]
    check(len(info["keep"]) >= 5,
          f"計画が複数の区間に分かれている（実 {len(info['keep'])} 区間）")
    check(got_marks == expected,
          f"出力の各コマが、計画した区間のコマそのものである"
          f"（期待 {len(expected)} コマ / 実 {len(got_marks)} コマ / "
          f"先頭の食い違い {next((i for i,(a,b) in enumerate(zip(got_marks,expected)) if a!=b), None)}）")
    # 継ぎ目（コマ番号の飛び）が実際に存在すること。無ければ何も詰めていない。
    seams = sum(1 for i in range(1, len(got_marks)) if got_marks[i] != got_marks[i-1] + 1)
    check(seams >= 4, f"出力に継ぎ目が実在する（実 {seams} 箇所）")

    # snapStart を1点だけで通すと、「その1点を格子上へ写す」だけの実装（定数を返す等）が通る
    # （2026-08-08、independent-verifier の指摘。return 1 でも全緑だった）。
    # さらに、素材が 15fps しか無いので **コマ数/秒 を振らないと** 「15 で決め打ちして丸める」
    # 実装まで通る（実測: `return Math.round(start * 15) / 15;` でも 19 PASS だった）。
    # そこで 開始4値 × コマ数/秒3種（15 / 24 / 30000/1001 = 29.97）の 12 点で確かめる。
    # 期待値は実装から導かず、下にリテラルで書く（実装の定数を import すると、
    # 定数を変えれば基準も一緒に動く自己参照になる）。
    # どの積も x.5 から離れているので、丸めの向き（半分を上げるか下げるか）に依存しない。
    SNAP_STARTS = [0.02, 1.02, 2.44, 3.71]
    SNAP_FPS = [15.0, 24.0, 30000.0 / 1001.0]
    SNAP_EXPECT = [
        # 15fps: 0/15, 15/15, 37/15, 56/15
        [0.0, 1.0, 2.466666666666667, 3.7333333333333334],
        # 24fps: 0/24, 24/24, 59/24, 89/24
        [0.0, 1.0, 2.4583333333333335, 3.7083333333333335],
        # 29.97fps(=30000/1001): 1*1001/30000, 31*1001/30000, 73*1001/30000, 111*1001/30000
        [0.03336666666666667, 1.0343666666666667, 2.435766666666667, 3.7037],
    ]
    js = ('import("%s/src/trim-plan.mjs").then(m=>'
          'console.log(JSON.stringify(%s.map(f=>%s.map(v=>m.snapStart(v,f))))));'
          ) % (ROOT, json.dumps(SNAP_FPS), json.dumps(SNAP_STARTS))
    snapped_starts = json.loads(subprocess.run(["node", "-e", js], stdout=subprocess.PIPE,
                                               check=True, encoding="utf-8").stdout)
    off = [(SNAP_FPS[i], SNAP_STARTS[j], snapped_starts[i][j], SNAP_EXPECT[i][j])
           for i in range(len(SNAP_FPS)) for j in range(len(SNAP_STARTS))
           if abs(snapped_starts[i][j] - SNAP_EXPECT[i][j]) >= 1e-9]
    check(not off,
          f"切り出し開始が、どの開始秒でも・どのコマ数/秒でもコマの境目へ写る"
          f"（12点中 外れ {len(off)} 点 / 先頭3件={off[:3]}）")
    # 対照: コマ数/秒 を無視する実装（15 決め打ち等）を落とす。
    # 同じ開始秒でもコマ数/秒 が違えば写り先は違う値になるはず。
    col = [snapped_starts[i][2] for i in range(len(SNAP_FPS))]   # start=2.44 の3通り
    check(len(set(col)) == len(SNAP_FPS),
          f"対照: 同じ開始秒でも、コマ数/秒 が違えば写り先が違う"
          f"（コマ数/秒 を無視する実装を落とす）（start=2.44 → 実 {col}）")
    check(len(set(snapped_starts[0])) == len(SNAP_STARTS),
          f"開始が値ごとに違う結果になる（定数を返す実装を落とす）（実 {snapped_starts[0]}）")

    # 残す区間の端を揃える snapToFrames も、素材が15fpsしか無いので
    # 「15 で決め打ちして丸める」実装が素通りする（snapStart と同じ穴）。
    # ここも コマ数/秒 を3種振って、リテラルの期待値と突き合わせる。
    # 入力の区間: [0.02,0.44] は端が半端 / [1.00,1.03] は丸めると1コマ未満（後ろへ広げる規則が効く）
    #             / [2.44,3.71] は両端とも半端。
    SNAP_SPANS = [{"start": 0.02, "end": 0.44},
                  {"start": 1.00, "end": 1.03},
                  {"start": 2.44, "end": 3.71}]
    SNAP_SPANS_EXPECT = [
        # 15fps: 端を最寄りのコマへ→ [0/15,7/15] [15/15,15/15]→1コマ未満なので[15/15,17/15] [37/15,56/15]
        [[0.0, 0.4666666666666667], [1.0, 1.1333333333333333],
         [2.466666666666667, 3.7333333333333334]],
        # 24fps: [0/24,11/24] [24/24,25/24]→1コマなので[24/24,26/24] [59/24,89/24]
        [[0.0, 0.4583333333333333], [1.0, 1.0833333333333333],
         [2.4583333333333335, 3.7083333333333335]],
        # 29.97fps(=30000/1001): [1,13]*1001/30000 / [30,31]→1コマなので[30,32]*1001/30000 /
        #                        [73,111]*1001/30000
        [[0.03336666666666667, 0.4337666666666667], [1.001, 1.0677333333333334],
         [2.435766666666667, 3.7037]],
    ]
    js = ('import("%s/src/trim-plan.mjs").then(m=>'
          'console.log(JSON.stringify(%s.map(f=>m.snapToFrames(%s, f)))));'
          ) % (ROOT, json.dumps(SNAP_FPS), json.dumps(SNAP_SPANS))
    snapped_spans = json.loads(subprocess.run(["node", "-e", js], stdout=subprocess.PIPE,
                                              check=True, encoding="utf-8").stdout)
    span_off = []
    for i, want_rows in enumerate(SNAP_SPANS_EXPECT):
        got_rows = snapped_spans[i]
        if len(got_rows) != len(want_rows):
            span_off.append((SNAP_FPS[i], "区間数", len(got_rows), len(want_rows)))
            continue
        for g, w in zip(got_rows, want_rows):
            if abs(g["start"] - w[0]) >= 1e-9 or abs(g["end"] - w[1]) >= 1e-9:
                span_off.append((SNAP_FPS[i], [g["start"], g["end"]], w))
    check(not span_off,
          f"残す区間の端も、どのコマ数/秒でもそのコマ数/秒のコマの境目へ写る"
          f"（コマ数/秒 を無視する実装を落とす）（9区間中 外れ {len(span_off)} 件 / 先頭3件={span_off[:3]}）")
    ppairs = measure(prod, y_offset=y_off)
    pbad = [(i, v, a) for i, (v, a) in enumerate(ppairs) if v != a]
    # 「測れたコマ数」の歯止めを固定値（旧: > 30）にすると、出力のコマ数と無関係なので
    # 実装が音の範囲を縮めても素通りする。実測: 音を先頭3区間しか concat しない実装で、
    # 映像 92 コマに対し音 33 コマぶんしか無いのに 19 PASS だった（2026-08-08）。
    pquiet = silent_frames(ppairs)
    check(len(ppairs) == len(pf),
          f"測ったコマ数が、出力の映像のコマ数と一致する"
          f"（映像 {len(pf)} コマ / 測った {len(ppairs)} コマ）")
    check(not pquiet,
          f"製品経路の出力の映像 {len(ppairs)} コマ全部について音を測れた"
          f"（音が無いコマ {len(pquiet)} 個 / 先頭={pquiet[:3]}）")
    pa_span = audio_span_frames(prod)
    check(abs(pa_span - len(ppairs)) <= 1.0,
          f"製品経路の出力の音の長さが映像の長さと合っている"
          f"（映像 {len(ppairs)} コマ / 音 {pa_span:.2f} コマぶん / 許容 1 コマ）")
    check(worst_gap(ppairs) == 0,
          f"製品と同じ経路・同じ出力設定でも、全コマで絵と音が同じコマ番号を指す"
          f"（最大ずれ {worst_gap(ppairs)} コマ / 食い違い {len(pbad)} 件 先頭3件={pbad[:3]}）")

    # ── 1コマ区間で映像が落ちないこと ──────────────────────────
    # 揃えた結果ちょうど1コマになる区間を ffmpeg へ渡すと、映像のコマが落ちる。
    # 実測(15fps・1コマ区間10個): 映像は10コマ出るはずが2コマしか出ず、音だけ残ってずれた。
    # 言い淀みの合間に挟まった短い発話がこの形になるので、実素材で起きる。
    js = ('import("%s/src/trim-plan.mjs").then(m=>{'
          'const raw=[];for(let k=0;k<10;k++)raw.push({start:k*0.2,end:k*0.2+1/%d});'
          'const sn=m.snapToFrames(raw,%d);'
          'console.log(JSON.stringify({spans:sn,frames:sn.reduce((a,s)=>a+Math.round((s.end-s.start)*%d),0)}));});'
          ) % (ROOT, FPS, FPS, FPS)
    got = json.loads(subprocess.run(["node", "-e", js], stdout=subprocess.PIPE,
                                    check=True, encoding="utf-8").stdout)
    tiny = os.path.join(tmp, "tiny.mkv")
    render(src, got["spans"], tiny)
    n = len(read_frames(tiny))
    # 期待値は実装から計算せず、ここに数字で書く。
    # 実装の MIN_KEEP_FRAMES から導くと、その値を変えても基準が一緒に動いて落ちなくなる
    # （2026-08-08、independent-verifier の指摘。6 に変えても全緑だった）。
    # 1コマ区間10個 × 最短2コマ = 20コマ。
    EXPECT_SPANS = 10
    EXPECT_FRAMES_PER_SPAN = 2
    EXPECT_TOTAL = EXPECT_SPANS * EXPECT_FRAMES_PER_SPAN
    check(n == EXPECT_TOTAL,
          f"1コマになる区間があっても、映像のコマが落ちない（期待 {EXPECT_TOTAL} コマ / 実 {n} コマ）")
    per = [round((sp["end"] - sp["start"]) * FPS) for sp in got["spans"]]
    check(per == [EXPECT_FRAMES_PER_SPAN] * EXPECT_SPANS,
          f"残す区間がちょうど2コマへ広げられている（実 {per}）")

    # ── 対照: 揃えないと落ちること ──────────────────────────────
    out2 = os.path.join(tmp, "unsnapped.mkv")
    render(src, raw, out2)
    pairs2 = measure(out2)
    gap2 = worst_gap(pairs2)
    check(gap2 > 0,
          f"対照: コマ境界へ揃えない区間なら、この判定は落ちる（最大ずれ {gap2} コマ）")

    # ── 対照: -shortest を足しただけの偽物でも落ちること ────────
    # 却下された受入基準「尺の差が1コマ未満」は、これで合格してしまっていた。
    out3 = os.path.join(tmp, "shortest.mkv")
    render(src, raw, out3, shortest=True)
    pairs3 = measure(out3)
    gap3 = worst_gap(pairs3)
    check(gap3 > 0,
          f"対照: -shortest を足しただけの実装でも、この判定は落ちる（最大ずれ {gap3} コマ）")

    print(f"\n--- {PASS} PASS / {FAIL} FAIL ---")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
