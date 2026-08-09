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


def product_chain(keep, opts=None):
    """出荷経路の buildTrimFilters が組む式を、そのまま受け取る（検査は式を写さない）"""
    js = (
        'import("%s/src/trim-plan.mjs").then(m=>{'
        'const f=m.buildTrimFilters(%s,%s);'
        'console.log(JSON.stringify({c:f.chain}));});'
    ) % (ROOT, json.dumps(keep), json.dumps(opts or {}))
    got = subprocess.run(["node", "-e", js], stdout=subprocess.PIPE, check=True,
                         encoding="utf-8").stdout
    return json.loads(got)["c"]


def encode(src, chain, out, shortest=False):
    args = [
        "ffmpeg", "-y", "-v", "error", "-i", src,
        "-filter_complex", chain,
        "-map", "[tvout]", "-map", "[taout]",
        # 出荷経路（renderClip）と同じ。区間ごとの端数を継ぎ目で清算した結果、
        # 1コマ未満の穴が空いたときに複製で埋める。
        "-fps_mode", "cfr",
        "-c:v", "libx264rgb", "-qp", "0", "-pix_fmt", "bgr24",
        "-c:a", "pcm_s16le",
    ]
    if shortest:
        args.append("-shortest")
    args.append(out)
    subprocess.run(args, check=True)


def render(src, keep, out, shortest=False, opts=None):
    """【対照専用】keep 区間だけを残して詰める。揃えない場合と -shortest の比較に使う。"""
    encode(src, product_chain(keep, opts), out, shortest)


def old_style_chain(spans, fps_rational, sample_rate):
    """【対照専用】この直しの前の形（秒で切る＋concat を映像用と音声用の2本に分ける）を手で組む。

    製品の式を写しているのではない。「製品がこうしていたら落ちる」を示すための偽物。
    2本に分けると、区間ごとの端数が継ぎ目で清算されずに積み上がる
    （libavfilter/avf_concat.c の find_next_delta_ts は、セグメント内の全ストリームの
      終端 pts の**最大**を取って共有する。ストリームが片方しか無ければ共有する相手がいない）。
    さらに秒で切ると、映像は「pts が [s,e) に入るコマ」の選択・音声は標本ちょうどの切り出しに
    なるため、区間ごとに最大1コマぶん長さが食い違う。その差が継ぎ目の数だけ積み上がる。
    """
    n = len(spans)
    v = f"[0:v]fps=fps={fps_rational},split={n}" + "".join(f"[sv{i}]" for i in range(n)) + ";"
    v += ";".join(f"[sv{i}]trim=start={sp['start']:.6f}:end={sp['end']:.6f},"
                  f"setpts=PTS-STARTPTS[tv{i}]" for i, sp in enumerate(spans))
    v += ";" + "".join(f"[tv{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[tvout]"
    a = ";".join(f"[0:a]atrim=start={sp['start']:.6f}:end={sp['end']:.6f},"
                 f"asetpts=PTS-STARTPTS[ta{i}]" for i, sp in enumerate(spans))
    a += ";" + "".join(f"[ta{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1[taout]"
    return v + ";" + a


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
          'console.log(JSON.stringify(m.toFrameSpans(%s, %d))));') % (ROOT, json.dumps(raw), FPS)
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

    # 残す区間をコマ番号へ写す toFrameSpans も、素材が15fpsしか無いので
    # 「15 で決め打ちして丸める」実装が素通りする（snapStart と同じ穴）。
    # ここも コマ数/秒 を3種振って、リテラルの期待値と突き合わせる。
    # 入力の区間: [0.02,0.44] は端が半端 / [1.00,1.03] は写すと 0 コマ（1コマへ広げる規則が効く）
    #             / [2.44,3.71] は両端とも半端。
    SNAP_SPANS = [{"start": 0.02, "end": 0.44},
                  {"start": 1.00, "end": 1.03},
                  {"start": 2.44, "end": 3.71}]
    # 期待値はコマ番号で書く（秒は startFrame/fps なので、コマ番号が正しければ秒も決まる）。
    # 実装から導かず、ここにリテラルで置く。
    #   15fps: 0.02*15=0.3→0 / 0.44*15=6.6→7 ｜ 1.00*15=15 / 1.03*15=15.45→15→0コマなので16
    #          ｜ 2.44*15=36.6→37 / 3.71*15=55.65→56
    #   24fps: 0.48→0 / 10.56→11 ｜ 24 / 24.72→25 ｜ 58.56→59 / 89.04→89
    #   29.97fps(=30000/1001): 0.5994→1 / 13.19→13 ｜ 29.97→30 / 30.87→31 ｜ 73.13→73 / 111.19→111
    SNAP_SPANS_EXPECT = [
        [[0, 7], [15, 16], [37, 56]],
        [[0, 11], [24, 25], [59, 89]],
        [[1, 13], [30, 31], [73, 111]],
    ]
    js = ('import("%s/src/trim-plan.mjs").then(m=>'
          'console.log(JSON.stringify(%s.map(f=>m.toFrameSpans(%s, f)))));'
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
            if [g.get("startFrame"), g.get("endFrame")] != w:
                span_off.append((SNAP_FPS[i], [g.get("startFrame"), g.get("endFrame")], w))
            # 秒の側も、コマ番号 / コマ数/秒 と一致していること（両方を持つので食い違いうる）
            elif (abs(g["start"] - w[0] / SNAP_FPS[i]) >= 1e-9
                  or abs(g["end"] - w[1] / SNAP_FPS[i]) >= 1e-9):
                span_off.append((SNAP_FPS[i], "秒とコマ番号が食い違う", [g["start"], g["end"]], w))
    check(not span_off,
          f"残す区間が、どのコマ数/秒でもそのコマ数/秒のコマ番号へ写る"
          f"（コマ数/秒 を無視する実装を落とす）（9区間中 外れ {len(span_off)} 件 / 先頭3件={span_off[:3]}）")
    # 0コマになる区間を落としてしまう実装（＝言い淀みの合間の短い発話が消える）を落とす。
    # 期待値は上のリテラル（[15,16] など）に含まれているが、「消えないこと」を独立に言う。
    tiny_rows = [rows[1] for rows in snapped_spans]
    check(all(r.get("endFrame") - r.get("startFrame") == 1 for r in tiny_rows),
          f"写すと0コマになる区間は、落とさずちょうど1コマへ広げる"
          f"（実 {[[r.get('startFrame'), r.get('endFrame')] for r in tiny_rows]}）")

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

    # ── 1コマの区間がちょうど1コマ出ること ──────────────────────
    # 言い淀みの合間に挟まった短い発話は、写すと1コマの区間になる。
    # trim=start_frame=a:end_frame=a+1 は到着したコマを数えるだけなので、構成上かならず1コマ出る。
    # （旧実装は秒で切っていたため、1コマの区間で映像が落ち、音だけ残ってずれた。
    #   その対策の「最短2コマへ広げる」は、短い発話を引き伸ばす副作用があった。）
    js = ('import("%s/src/trim-plan.mjs").then(m=>{'
          'const raw=[];for(let k=0;k<10;k++)raw.push({start:k*0.2,end:k*0.2+1/%d});'
          'const sn=m.toFrameSpans(raw,%d);'
          'console.log(JSON.stringify({spans:sn}));});'
          ) % (ROOT, FPS, FPS)
    got = json.loads(subprocess.run(["node", "-e", js], stdout=subprocess.PIPE,
                                    check=True, encoding="utf-8").stdout)
    tiny = os.path.join(tmp, "tiny.mkv")
    render(src, got["spans"], tiny, opts={"fpsRational": "%d/1" % FPS,
                                          "sampleRate": SAMPLE_RATE})
    n = len(read_frames(tiny))
    # 期待値は実装から計算せず、ここに数字で書く。1コマ区間10個 → 10コマ。
    EXPECT_SPANS = 10
    EXPECT_FRAMES_PER_SPAN = 1
    EXPECT_TOTAL = EXPECT_SPANS * EXPECT_FRAMES_PER_SPAN
    check(n == EXPECT_TOTAL,
          f"1コマの区間が10個なら、出力もちょうど10コマ（期待 {EXPECT_TOTAL} コマ / 実 {n} コマ）")
    per = [sp["endFrame"] - sp["startFrame"] for sp in got["spans"]]
    check(per == [EXPECT_FRAMES_PER_SPAN] * EXPECT_SPANS,
          f"1コマの区間が、水増しされずちょうど1コマのままである（実 {per}）")
    tiny_marks = [read_marker(fr) for fr in read_frames(tiny)]
    check(tiny_marks == [k * 3 for k in range(EXPECT_SPANS)],
          f"その10コマが、素材の 0,3,6,… コマ目そのものである（実 {tiny_marks}）")

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

    # ── 区間の数を増やしても、ずれが積み上がらないこと ──────────────
    # 【なぜこれが要るか】この直しの前は、継ぎ目1つにつき一定量ずつずれが足し算されていた。
    # 区間が少ないうちは1コマ未満なので、上の判定（最大ずれ0コマ）を通ってしまう。
    # 積み上がるかどうかは「区間の数を振って、ずれが数に比例するか」を見ないと分からない。
    # 実測（旧実装・15fps・区間長 29/30秒・開始オフセット 1/30秒・区間ピッチ 1.0 秒）:
    #   2個 -66.7ms / 5個 -166.7ms / 10個 -333.3ms / 20個 -666.7ms / 50個 -1666.7ms /
    #   100個 -3333.3ms（＝1区間あたり 33.3ms＝半コマ。完全に比例）。
    #
    # ここでは 10秒の素材に区間を詰め込んで N を振る。
    # 区間: 開始 k*0.2 + 半コマ / 長さ 1.5 コマ（＝端がコマの格子に載らない・長さも半端）。
    # 素材は 150 コマなので N=40 まで置ける。
    DRIFT_PITCH = 0.2
    DRIFT_LEN = 1.5 / FPS
    DRIFT_OFFSET = 0.5 / FPS

    def drift_spans(n):
        return [{"start": round(k * DRIFT_PITCH + DRIFT_OFFSET, 6),
                 "end": round(k * DRIFT_PITCH + DRIFT_OFFSET + DRIFT_LEN, 6)}
                for k in range(n)]

    drift_rows = []
    for n_spans in (10, 20, 40):
        o = os.path.join(tmp, f"drift-{n_spans}.mkv")
        # 秒の区間をそのまま出荷経路の式へ渡す（コマ番号への写しは製品の中で起きる）。
        render(src, drift_spans(n_spans), o,
               opts={"fpsRational": "%d/1" % FPS, "sampleRate": SAMPLE_RATE})
        prs = measure(o)
        bad_n = sum(1 for v, a in prs if a is None or v != a)
        a_span = audio_span_frames(o)
        drift_rows.append((n_spans, len(prs), a_span, bad_n))
        check(bad_n == 0 and abs(a_span - len(prs)) <= 1.0,
              f"区間 {n_spans} 個でも、全コマで絵と音が一致する"
              f"（映像 {len(prs)} コマ / 音 {a_span:.2f} コマぶん / 食い違い {bad_n} コマ）")
    # 「N に比例して増える」ことが無いのを、数の並びとしても押さえる。
    check(all(r[3] == 0 for r in drift_rows),
          f"区間の数を 10→20→40 と増やしても食い違いが増えない"
          f"（実 {[(r[0], r[3]) for r in drift_rows]}）")

    # 対照: この直しの前の形（秒で切る＋concat を2本に分ける）だと、同じ区間で落ちること。
    # これが落ちなければ、上の全PASSは「何も直っていなくても出る緑」になる。
    old_out = os.path.join(tmp, "drift-oldstyle-40.mkv")
    encode(src, old_style_chain(drift_spans(40), "%d/1" % FPS, SAMPLE_RATE), old_out)
    old_pairs = measure(old_out)
    old_bad = sum(1 for v, a in old_pairs if a is None or v != a)
    old_gap = worst_gap(old_pairs)
    check(old_bad > 0,
          f"対照: 秒で切って concat を2本に分けた式なら、同じ区間40個で落ちる"
          f"（映像 {len(old_pairs)} コマ / 音 {audio_span_frames(old_out):.2f} コマぶん / "
          f"食い違い {old_bad} コマ / 最大ずれ {old_gap} コマ）")
    # 「ずれが区間の数に比例して積み上がる」ことも、対照の側で示す（1コマ未満で止まらない）。
    old_out10 = os.path.join(tmp, "drift-oldstyle-10.mkv")
    encode(src, old_style_chain(drift_spans(10), "%d/1" % FPS, SAMPLE_RATE), old_out10)
    d10 = len(read_frames(old_out10)) - audio_span_frames(old_out10)
    d40 = len(read_frames(old_out)) - audio_span_frames(old_out)
    check(d40 > d10 + 1.0,
          f"対照: 旧い形では、区間を増やすほど映像と音の長さの差が広がる"
          f"（10個で {d10:.2f} コマ / 40個で {d40:.2f} コマ）")

    print(f"\n--- {PASS} PASS / {FAIL} FAIL ---")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
