"""コマ数/秒が一定でない素材でも、詰めたあと絵と音がずれないことの検証 — G-EDIT-TRIM-G

【守る受入事実】コマ数/秒が一定でない素材（可変フレームレート＝VFR。画面録画で普通に出る）でも、
無音や言い淀みを詰めた出力の各コマについて、そこに映っている絵が、
「同じ時刻に鳴っている音の時点で、素材に映っていた絵」と同じであること。
＝口の動きと声がずれないこと。

【なぜ既存の tests/trim-sync-check.py（葉F）では足りないか】
葉Fの素材はコマが等間隔に並んでいる。`trim=start=s:end=e` は「pts が [s,e) に入るコマを通す」だけで、
その区間の中に何コマ在るかは素材次第なので、等間隔の素材では (e-s)*fps コマがそのまま出る。
ところが画面録画は動きの無い間コマを間引くため、同じ (e-s) 秒でもコマ数が減る。
`setpts=PTS-STARTPTS` が区間の頭の欠けを畳み、`concat` が前の区間の実長の直後に繋ぐので、
映像だけが短くなる。一方 `atrim` は (e-s) 秒ちょうど切る。差は継ぎ目の数だけ積み上がる。
端をコマの境目へ揃える snapToFrames は、コマの「在る場所」が格子に乗っていないので原理的に効かない。

【この検査の測り方】素材の各コマに「そのコマの番号」を絵として焼き、同時に、そのコマの間だけ
「番号で決まる高さの音」を鳴らす（葉Fと同じ方式）。そのうえで**映像だけ**を不規則に間引いて
可変フレームレートの素材を作る（音はバイト単位でそのまま）。
出力の各コマについて
  ・絵から読んだ番号 が、期待する番号と一致するか
  ・音の高さから読んだ番号 が、期待する番号と一致するか
  ・絵から読んだ番号 が、「音が指す時点で素材に映っていた絵」の番号と一致するか
を全コマで確かめる。

【期待値の作り方（製品コードを一切使わない）】
間引いたあと生き残ったコマの番号 S は、`ffprobe -show_packets` の pts_time だけから作る
（pts_time × コマ数/秒 を四捨五入。復号しない）。
可変フレームレートの素材では、時刻 k/fps に「映っている」のは
  そのコマ番号 k 以下で最大の生存コマ ＝ last_survivor(k)
である（間引かれた所は直前のコマが映ったままになる）。
残す区間は検査がリテラルで決めるので、期待するコマ列は S と区間だけから決まり、
製品の probeSize / snapToFrames / planTrim を一度も呼ばずに作れる。

実行: python3 tests/trim-vfr-sync-check.py   (全PASSで exit 0)
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

# ── 素材の作り（数値で確定させる。コミットしないのでここが唯一の正）───────────
W, H = 320, 180
FPS = 15                  # 素材が名乗るコマ数/秒（r_frame_rate）。コマ周期 = 1/15 秒
FPS_RATIONAL = "15/1"     # 分数の姿。fps フィルタへはこの形で渡る
N_FRAMES = 150            # 10 秒ぶん
SAMPLE_RATE = 48000
BASE_HZ = 400             # コマ0 の音の高さ
STEP_HZ = 100             # コマが1つ進むごとに上がる高さ
# 100 Hz にする理由（葉Fと同じ）: 音の高さを測る窓は半コマぶん（48000/15/2 = 1600 標本）で、
# その分解能は 48000/1600 = 30 Hz。コマ間隔がこれに近いと隣り合うコマを見分けられない。
# 30 Hz の3倍以上離す。最高でも 400+100*149 = 15300 Hz で、24000 Hz の上限に収まる。
MARKER_CELL = 8           # 目印1ビットの大きさ（画素）
MARKER_BITS = 16

# 映像を間引く規則。7で割った余りが3 / 11で割った余りが5 / 5で割った余りが1 のコマを捨てる。
# 3つの周期が互いに素なので、捨てる位置が周期的に揃わず、間隔が 1〜4 コマぶんに散らばる。
DECIMATE = "not(eq(mod(n\\,7)\\,3)+eq(mod(n\\,11)\\,5)+eq(mod(n\\,5)\\,1))"

# 残す区間（検査がリテラルで決める。製品の planTrim は使わない）。
# 1.0 秒ごとに 12 コマ（0.8 秒）ずつ残す＝継ぎ目が9箇所できる。
#
# 12 コマ（0.8 秒）にする理由: 区間の端を、容器が表せる時刻ちょうどに置くため。
# Matroska 由来の時刻は1ミリ秒刻みなので、14コマ（0.933333 秒）を端にすると、
# 素材のコマは 0.933 ミリ秒側へ丸められて区間の内側に残り、区間あたり1コマ余分に通る。
# するとコマ数/秒が一定の素材でも「前置なし」が正しくなくなり（実測: 140コマ中126コマで
# 絵が音とずれた）、退行の有無を測る土台にならない。0.8 秒＝800ミリ秒ちょうどなら
# 端が刻みに乗るので、前置なしの出来上がりが正しい＝恒等かどうかを測れる。
# （なおその実測は、前置がコマ数/秒の一定な素材でも「刻みに乗らない端」を救うことを示す。
#  ただしこの葉が受け入れるのは可変フレームレートの側なので、ここでは条件にしない。）
SPAN_COUNT = 10
SPAN_FRAMES = 12
SPAN_PITCH_SEC = 1.0
EXPECT_OUT_FRAMES = 120   # SPAN_COUNT * SPAN_FRAMES。実装からは導かず、ここに数字で書く。

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


# ── 素材の合成 ──────────────────────────────────────────────────

def stamp(frame, n):
    """左上にコマ番号 n を16ビットの白黒の升目として焼く"""
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
    return BASE_HZ + STEP_HZ * n


def build_materials(tmp):
    """(1) コマ数/秒が一定の素材 (2) 映像だけ不規則に間引いた素材 を作る。

    どちらも可逆（libx264rgb -qp 0）で書く。非可逆だと目印の升目がにじんで読み取りが崩れ、
    合格ラインの根拠が符号化器の版に依存する（docs/failures.md 2026-08-08）。

    容器は「まず Matroska で書き、そのまま mp4 へ入れ直す」。理由は2つあり、どちらも
    この検査の検出力に直結する。
      ・Matroska の時刻の刻みは1ミリ秒なので、コマは k/15 秒ちょうどではなく 0.067 / 0.133 …
        のように最大0.5ミリ秒ずれた位置に載る。実際の画面録画（OBS の既定は mkv）と同じ形で、
        fps フィルタの丸め方の誤り（round=down 等）がここで初めて表に出る。
      ・mp4 は avg_frame_rate を実際のコマ数から出すので、間引いた素材では
        r_frame_rate（15/1）と avg_frame_rate（約9.4）が食い違う。
        「揃える目標に avg_frame_rate を使う」誤りを、この検査の中で落とせる。
    """
    cfr_mkv = os.path.join(tmp, "cfr.mkv")
    vfr_mkv = os.path.join(tmp, "vfr.mkv")
    cfr = os.path.join(tmp, "cfr.mp4")
    vfr = os.path.join(tmp, "vfr.mp4")
    raw_v = os.path.join(tmp, "frames.rawv")
    raw_a = os.path.join(tmp, "tone.raw")

    with open(raw_v, "wb") as f:
        for n in range(N_FRAMES):
            frame = np.full((H, W, 3), (n * 7) % 200, dtype=np.uint8)
            f.write(stamp(frame, n).tobytes())

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
        "-c:v", "libx264rgb", "-qp", "0", "-pix_fmt", "bgr24", "-c:a", "pcm_s16le",
        cfr_mkv,
    ], check=True)

    # 映像だけ間引く。-fps_mode passthrough が必須（無いと ffmpeg が等間隔へ戻してしまう）。
    # 音は -c:a copy でそのまま運ぶ＝素材の中では絵と音の対応が壊れていない。
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-i", cfr_mkv,
        "-vf", f"select='{DECIMATE}'",
        "-fps_mode", "passthrough",
        "-c:v", "libx264rgb", "-qp", "0", "-pix_fmt", "bgr24", "-c:a", "copy",
        vfr_mkv,
    ], check=True)

    for src, dst in ((cfr_mkv, cfr), (vfr_mkv, vfr)):
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src, "-c", "copy", dst], check=True)

    os.remove(raw_v)
    os.remove(raw_a)
    return cfr, vfr


# ── 素材を読む（復号しない道 / する道）─────────────────────────────

def packet_pts(path):
    """映像パケットの時刻。復号しないので長い素材でも一瞬で終わる。"""
    out = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "packet=pts_time", "-of", "csv=p=0", path,
    ], stdout=subprocess.PIPE, check=True, encoding="utf-8").stdout
    return [float(x) for x in out.split() if x.strip()]


def stream_rates(path):
    out = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate,avg_frame_rate",
        "-of", "csv=p=0", path,
    ], stdout=subprocess.PIPE, check=True, encoding="utf-8").stdout.strip()
    r, a = out.split(",")[:2]
    return r, a


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


def read_marks(path, y_offset=0):
    return [read_marker(fr[y_offset:, :]) for fr in read_frames(path)]


def read_pcm(path):
    raw = subprocess.run([
        "ffmpeg", "-v", "error", "-i", path,
        "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-",
    ], stdout=subprocess.PIPE, check=True).stdout
    return np.frombuffer(raw, dtype="<i2").astype(np.float64)


def hz_at(pcm, t0, t1):
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


def audio_marks(path, n_frames):
    """出力の映像コマ i（i/FPS 秒に映る）と同じ時刻に鳴っている音のコマ番号。

    音が読めなかったコマは None を返す。**読み飛ばさない。**
    読み飛ばすと「全コマで一致」の"全コマ"が「音がまだ残っていたコマだけ」に縮み、
    音の範囲を縮める実装が素通りする（葉Fで実際に起きた穴）。
    """
    pcm = read_pcm(path)
    out = []
    for i in range(n_frames):
        # コマが映っている時間の真ん中あたりで測る（端は継ぎ目のフェードが掛かる）
        hz = hz_at(pcm, i / FPS + 0.25 / FPS, i / FPS + 0.75 / FPS)
        out.append(None if hz is None else hz_to_frame(hz))
    return out


def audio_span_frames(path):
    return len(read_pcm(path)) / (SAMPLE_RATE / FPS)


# ── 期待値を作る（製品コードを1行も呼ばない）───────────────────────

def survivors(path):
    """間引いたあと生き残ったコマ番号。ffprobe の pts だけから作る。"""
    return sorted(int(round(t * FPS)) for t in packet_pts(path))


def make_last_survivor(surv):
    """時刻 k/FPS に画面へ映っているコマの番号（間引かれた所は直前のコマが残る）"""
    s = set(surv)
    lo = min(s)

    def last(k):
        while k not in s and k > lo:
            k -= 1
        return k
    return last


def plan_frames():
    """残す区間を「素材のコマ番号の列」として展開する（リテラルの区間から）"""
    out = []
    for k in range(SPAN_COUNT):
        a = int(round(k * SPAN_PITCH_SEC * FPS))
        out.extend(range(a, a + SPAN_FRAMES))
    return out


def spans_literal():
    return [{"start": round(k * SPAN_PITCH_SEC, 6),
             "end": round(k * SPAN_PITCH_SEC + SPAN_FRAMES / FPS, 6)}
            for k in range(SPAN_COUNT)]


# ── 出荷される式で焼く / 対照用に手で式を組んで焼く ────────────────

def product_chain(spans, fps_rational):
    """出荷経路の buildTrimFilters が組む式を、そのまま受け取る（検査は式を写さない）"""
    opts = {"sampleRate": SAMPLE_RATE}
    if fps_rational:
        opts["fpsRational"] = fps_rational
    js = ('import("%s/src/trim-plan.mjs").then(m=>{'
          'const f=m.buildTrimFilters(%s,%s);'
          'console.log(JSON.stringify({c:f.chain}));});'
          ) % (ROOT, json.dumps(spans), json.dumps(opts))
    got = subprocess.run(["node", "-e", js], stdout=subprocess.PIPE, check=True,
                         encoding="utf-8").stdout
    return json.loads(got)["c"]


def encode(src, chain, out, shortest=False):
    args = [
        "ffmpeg", "-y", "-v", "error", "-i", src,
        "-filter_complex", chain,
        "-map", "[tvout]", "-map", "[taout]",
        # 出荷経路（renderClip）と同じ
        "-fps_mode", "cfr",
        "-c:v", "libx264rgb", "-qp", "0", "-pix_fmt", "bgr24",
        "-c:a", "pcm_s16le",
    ]
    if shortest:
        args.append("-shortest")
    args.append(out)
    subprocess.run(args, check=True)


def control_chain(spans, head):
    """【対照専用】映像側の前置だけを差し替えた式を、検査が手で組む。

    製品の式を写しているのではなく、「製品がこうしていたら落ちる」を示すための偽物。
    判定に使う式（product_chain）とは別物であることに注意。
    切る位置は製品と同じ「コマ番号・標本番号」にし、**揃える前置だけ**を変える。
    こうしないと「秒で切ったから落ちた」のか「前置が誤りだから落ちた」のか分からない。
    """
    n = len(spans)
    cuts = [{"a": int(round(s["start"] * FPS)), "b": int(round(s["end"] * FPS))} for s in spans]
    pre = (f"[0:v]{head},split={n}" if head else f"[0:v]split={n}") \
        + "".join(f"[sv{i}]" for i in range(n)) + ";"
    v = pre + ";".join(
        f"[sv{i}]trim=start_frame={c['a']}:end_frame={c['b']},setpts=PTS-STARTPTS[tv{i}]"
        for i, c in enumerate(cuts))
    a = f"[0:a]aresample={SAMPLE_RATE},asplit={n}" \
        + "".join(f"[sa{i}]" for i in range(n)) + ";"
    a += ";".join(
        f"[sa{i}]atrim=start_sample={c['a'] * SAMPLE_RATE // FPS}:"
        f"end_sample={c['b'] * SAMPLE_RATE // FPS},asetpts=PTS-STARTPTS[ta{i}]"
        for i, c in enumerate(cuts))
    tail = "".join(f"[tv{i}][ta{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[tvout][taout]"
    return v + ";" + a + ";" + tail


def render_product_path(src, start, end, out):
    """出荷経路そのもの（pipeline.mjs の renderSegment）を呼んで作る。

    検査が渡すのは「素材・切り出す秒・語」だけ。コマ数/秒の取り方（probeSize）も、
    詰め方（planTrim）も、焼き方（renderClip → buildTrimFilters）も製品の中で起きる。
    ここを通さないと、probeSize が分数を返しても renderClip がそれを捨てる実装を捕まえられない。
    切り出しの開始は 0 秒にする。半端な秒から切り出したときの入力シークの挙動は葉F の担当で、
    この葉の受入事実（コマ数/秒が一定でない素材で絵と音がずれない）とは別の事実だから。
    """
    js = """
import('%s/pipeline.mjs').then(async (pl) => {
  const rv = await import('%s/src/render-vertical.mjs');
  const size = await rv.probeSize('%s');
  const start = %s, end = %s;
  // 1秒ごとに0.6秒しゃべる＝語と語の間は0.4秒。
  // 2026-08-16: もとは 0.7秒 しゃべる＝間 0.3秒 だった。マスター指示「発言の後にだけ、
  // 余韻を0.3秒存在させる」により、0.3秒 以下の間は余韻で使い切って詰める余地が無くなり、
  // 1区間も詰まらなくなった（この検査は「複数の区間に詰めている」ことが前提）。
  // 間を 0.4秒 にして、余韻 0.3秒 を残したうえで 0.1秒 が詰まる形へ直した。
  const words = [];
  for (let k = 0; start + k * 1.0 + 0.6 <= end; k++) {
    words.push({ w: 'あ', start: start + k * 1.0, end: start + k * 1.0 + 0.6 });
  }
  const r = await pl.renderSegment({
    input: '%s',
    seg: { start, end, duration: end - start, hook: 'x' },
    words,
    srcFps: size.fps, srcFpsRational: size.fpsRational,
    srcW: size.width, srcH: size.height,
    orientation: 'portrait', trim: true, subtitle: null,
    output: '%s', onLog: () => {},
  });
  console.log(JSON.stringify({ fps: size.fps, fpsRational: size.fpsRational,
    segStart: r.segStart, keep: r.keep }));
});
""" % (ROOT, ROOT, src, start, end, src, out)
    got = subprocess.run(["node", "-e", js], stdout=subprocess.PIPE, check=True,
                         encoding="utf-8").stdout
    return json.loads(got)


def judge(out, expect_source_frames, last_survivor, y_offset=0, label=""):
    """出力を測って (食い違いの件数, 説明) を返す。判定の中身はここ1箇所に集約する。

    expect_source_frames: 出力の各コマが「素材のどの時点」であるべきかの列（リテラルの区間から作る）
    last_survivor:        その時点に画面へ映っていたコマ番号を返す関数（ffprobe の pts から作る）
    """
    marks = read_marks(out, y_offset)
    a_marks = audio_marks(out, len(marks))
    exp_marks = [last_survivor(k) for k in expect_source_frames]
    res = {
        "n_video": len(marks),
        "n_expect": len(exp_marks),
        "marks": marks,
        "audio": a_marks,
        "expect_marks": exp_marks,
        "expect_src": expect_source_frames,
        "silent": [i for i, a in enumerate(a_marks) if a is None],
        "audio_span": audio_span_frames(out),
        "label": label,
    }
    res["mark_bad"] = [(i, g, e) for i, (g, e) in enumerate(zip(marks, exp_marks)) if g != e]
    res["audio_bad"] = [(i, a, e) for i, (a, e) in enumerate(zip(a_marks, expect_source_frames))
                        if a != e]
    # 中心の判定: 絵が「音の指す時点で映っていたもの」か。音が読めなければ食い違いとして数える。
    res["sync_bad"] = [(i, g, a) for i, (g, a) in enumerate(zip(marks, a_marks))
                       if a is None or g != last_survivor(a)]
    res["ok"] = (len(marks) == len(exp_marks) and not res["mark_bad"]
                 and not res["audio_bad"] and not res["sync_bad"] and not res["silent"])
    return res


def seam_count(marks):
    """コマ番号が「1つ進む」以外の動き方をした箇所＝継ぎ目"""
    return sum(1 for i in range(1, len(marks)) if marks[i] != marks[i - 1] + 1)


def main():
    tmp = tempfile.mkdtemp(prefix="vs-trimvfr-")
    cfr, vfr = build_materials(tmp)
    spans = spans_literal()
    plan = plan_frames()

    # ── 対照: 素材そのものが前提を満たしているか ────────────────────
    # ここが崩れると、以降の「全コマで一致」が空虚に真になる。
    cfr_marks = read_marks(cfr)
    check(cfr_marks == list(range(N_FRAMES)),
          f"対照: 一定の素材のコマ番号が 0..{N_FRAMES - 1} の順に読める"
          f"（実 {len(cfr_marks)} コマ / 先頭5件={cfr_marks[:5]}）")
    cfr_pcm = read_pcm(cfr)
    got_a = [hz_to_frame(hz_at(cfr_pcm, n / FPS + 0.25 / FPS, n / FPS + 0.75 / FPS))
             for n in range(0, N_FRAMES, 10)]
    check(got_a == list(range(0, N_FRAMES, 10)),
          f"対照: 一定の素材の音からも同じコマ番号が読める（実={got_a}）")

    # 【この葉の要】素材が本当にコマ数/秒の一定でない素材であること。
    # 事故で一定の素材になると、この葉の受入事実は何も測っていないのに全部緑になる。
    vpts = packet_pts(vfr)
    gaps = [vpts[i + 1] - vpts[i] for i in range(len(vpts) - 1)]
    irregular = [g for g in gaps if abs(g - 1.0 / FPS) > 0.002]
    check(len(irregular) >= 12,
          f"対照: 間引いた素材のコマ間隔が本当に不揃い"
          f"（コマ周期 {1 / FPS:.4f}s から 2ms 超ずれた間隔 {len(irregular)} 箇所 / 全 {len(gaps)} 箇所・12箇所以上必要）")
    surv = survivors(vfr)
    check(len(surv) < N_FRAMES - 40,
          f"対照: 間引いた素材から実際にコマが減っている"
          f"（{N_FRAMES} → {len(surv)} コマ / 40コマ超の欠けが必要）")
    vfr_marks = read_marks(vfr)
    check(vfr_marks == surv,
          f"対照: 間引いた素材の絵が pts の示すコマと一致する"
          f"（期待の先頭6件={surv[:6]} / 実の先頭6件={vfr_marks[:6]}）"
          "＝期待値を pts だけから作ってよいことの根拠")
    # 判定に r_frame_rate と avg_frame_rate の乖離を使わないことの根拠（実測で両方 15/1 になる
    # 容器がある）。ここでは食い違うが、上の「不揃い」判定はこれに依存していない。
    r_rate, a_rate = stream_rates(vfr)
    check(r_rate == FPS_RATIONAL,
          f"対照: 間引いた素材の r_frame_rate は {FPS_RATIONAL} のまま（実 {r_rate}）")
    check(a_rate != r_rate,
          f"対照: この容器では avg_frame_rate が r_frame_rate と食い違う"
          f"（r={r_rate} / avg={a_rate}）＝avg を目標にする誤りをこの検査で落とせる")
    # 音は間引きの影響を受けていない＝素材の中では絵と音の対応が壊れていない
    check(abs(audio_span_frames(vfr) - N_FRAMES) <= 1.0,
          f"対照: 間引いても音は素材のまま残っている"
          f"（{audio_span_frames(vfr):.2f} コマぶん / 期待 {N_FRAMES}）")

    last = make_last_survivor(surv)
    dup = sum(1 for i in range(1, len(plan)) if last(plan[i]) == last(plan[i - 1]))
    check(dup > 0,
          f"対照: 期待するコマ列に「直前のコマが映ったまま」の箇所が実在する"
          f"（{dup} 箇所）＝一定の素材と同じ問題に退化していない")

    # ── 中心の判定: 出荷される式で、間引いた素材を詰める ──────────────
    out = os.path.join(tmp, "vfr-trimmed.mkv")
    encode(vfr, product_chain(spans, FPS_RATIONAL), out)
    r = judge(out, plan, last, label="vfr")
    check(r["n_video"] == EXPECT_OUT_FRAMES,
          f"詰めた出力の映像が {EXPECT_OUT_FRAMES} コマ（実 {r['n_video']} コマ）"
          f"＝{SPAN_COUNT} 区間 × {SPAN_FRAMES} コマ")
    check(not r["silent"],
          f"詰めた出力の映像 {r['n_video']} コマ全部について音を測れた"
          f"（音が無いコマ {len(r['silent'])} 個 / 先頭={r['silent'][:3]}）")
    check(abs(r["audio_span"] - r["n_video"]) <= 1.0,
          f"詰めた出力の音の長さが映像の長さと合っている"
          f"（映像 {r['n_video']} コマ / 音 {r['audio_span']:.2f} コマぶん / 許容 1 コマ）")
    check(not r["mark_bad"],
          f"出力の各コマの絵が、計画した区間のその時点に映っていた絵である"
          f"（食い違い {len(r['mark_bad'])} 件 / 先頭3件={r['mark_bad'][:3]}）")
    check(not r["audio_bad"],
          f"出力の各コマの音が、計画した区間のその時点の音である"
          f"（食い違い {len(r['audio_bad'])} 件 / 先頭3件={r['audio_bad'][:3]}）")
    check(not r["sync_bad"],
          f"【中心】全コマで、絵が「同じ時刻に鳴っている音の時点で映っていた絵」と一致する"
          f"（食い違い {len(r['sync_bad'])} 件 / 先頭3件={r['sync_bad'][:3]}）")
    seams = seam_count(r["marks"])
    check(seams >= 4,
          f"出力に継ぎ目が実在する（実 {seams} 箇所）＝継ぎ目0本の動画で自動的に成立していない")

    # ── 退行なし: コマ数/秒が一定の素材では、前置しても結果が変わらない ────
    cfr_plain = os.path.join(tmp, "cfr-plain.mkv")
    cfr_fixed = os.path.join(tmp, "cfr-fixed.mkv")
    encode(cfr, product_chain(spans, None), cfr_plain)
    encode(cfr, product_chain(spans, FPS_RATIONAL), cfr_fixed)
    cfr_last = make_last_survivor(survivors(cfr))
    rp = judge(cfr_plain, plan, cfr_last, label="cfr-plain")
    rf = judge(cfr_fixed, plan, cfr_last, label="cfr-fixed")
    check(rp["ok"] and rp["n_video"] == EXPECT_OUT_FRAMES,
          f"対照: 一定の素材は前置なしでも正しい（{rp['n_video']} コマ / "
          f"絵 {len(rp['mark_bad'])} 件・音 {len(rp['audio_bad'])} 件の食い違い）")
    check(rf["marks"] == rp["marks"] and rf["n_video"] == EXPECT_OUT_FRAMES,
          f"一定の素材では前置しても出来上がりが1コマも変わらない（恒等）"
          f"（前置なし {rp['n_video']} コマ / 前置あり {rf['n_video']} コマ / "
          f"絵の食い違い {sum(1 for a, b in zip(rf['marks'], rp['marks']) if a != b)} 件）")
    check(not rf["sync_bad"],
          f"一定の素材でも、全コマで絵と音が一致したままである"
          f"（食い違い {len(rf['sync_bad'])} 件）＝この直しが既存の素材を壊していない")

    # ── 出荷経路（probeSize → planTrim → renderClip → buildTrimFilters）────
    prod = os.path.join(tmp, "product.mp4")
    info = render_product_path(vfr, 0.0, 9.0, prod)
    check(info["fpsRational"] == FPS_RATIONAL,
          f"出荷経路が素材のコマ数/秒を分数のまま取れている"
          f"（期待 {FPS_RATIONAL} / 実 {info['fpsRational']}）")
    check(len(info["keep"]) >= 5,
          f"出荷経路が複数の区間に詰めている（実 {len(info['keep'])} 区間）")
    pf = read_frames(prod)
    check(len(pf) > 0, "出荷経路の出力にコマがある")
    y_off = (pf[0].shape[0] - H) // 2 if pf and pf[0].shape[0] > H else 0
    base = int(round(info["segStart"] * FPS))
    prod_plan = []
    for sp in info["keep"]:
        prod_plan.extend(range(base + int(round(sp["start"] * FPS)),
                               base + int(round(sp["end"] * FPS))))
    pr = judge(prod, prod_plan, last, y_offset=y_off, label="product")
    check(pr["n_video"] == pr["n_expect"],
          f"出荷経路の出力のコマ数が、詰めた計画のコマ数と一致する"
          f"（計画 {pr['n_expect']} コマ / 実 {pr['n_video']} コマ）")
    check(not pr["silent"],
          f"出荷経路の出力の映像 {pr['n_video']} コマ全部について音を測れた"
          f"（音が無いコマ {len(pr['silent'])} 個 / 先頭={pr['silent'][:3]}）")
    check(not pr["mark_bad"],
          f"出荷経路の出力の各コマの絵が、計画した区間のその時点に映っていた絵である"
          f"（食い違い {len(pr['mark_bad'])} 件 / 先頭3件={pr['mark_bad'][:3]}）")
    check(not pr["sync_bad"],
          f"【中心・出荷経路】出荷どおりの設定（mp4 / libx264 / aac / 9:16）でも、"
          f"全コマで絵と音が一致する（食い違い {len(pr['sync_bad'])} 件 / 先頭3件={pr['sync_bad'][:3]}）")
    check(seam_count(pr["marks"]) >= 4,
          f"出荷経路の出力にも継ぎ目が実在する（実 {seam_count(pr['marks'])} 箇所）")

    # ── 対照（変異）: 直しを外した／間違えた実装が、この判定で落ちること ────
    # ここが1件でも通ると、上の全PASSは「何も直っていなくても出る緑」になる。
    bad_none = os.path.join(tmp, "mut-none.mkv")
    encode(vfr, product_chain(spans, None), bad_none)
    rn = judge(bad_none, plan, last, label="mut-none")
    check(not rn["ok"],
          f"対照: 前置を外すと落ちる"
          f"（映像 {rn['n_video']} コマ / 期待 {EXPECT_OUT_FRAMES} コマ、"
          f"絵の食い違い {len(rn['mark_bad'])} 件・絵と音の食い違い {len(rn['sync_bad'])} 件）")

    bad_short = os.path.join(tmp, "mut-shortest.mkv")
    encode(vfr, product_chain(spans, None), bad_short, shortest=True)
    rs = judge(bad_short, plan, last, label="mut-shortest")
    check(not rs["ok"],
          f"対照: 前置の代わりに -shortest を足しただけでも落ちる"
          f"（映像 {rs['n_video']} コマ / 絵と音の食い違い {len(rs['sync_bad'])} 件）")

    bad_avg = os.path.join(tmp, "mut-avg.mkv")
    encode(vfr, control_chain(spans, f"fps=fps={a_rate}"), bad_avg)
    ra_ = judge(bad_avg, plan, last, label="mut-avg")
    check(not ra_["ok"],
          f"対照: 揃える目標を avg_frame_rate（{a_rate}）にすると落ちる"
          f"（映像 {ra_['n_video']} コマ / 期待 {EXPECT_OUT_FRAMES} コマ、"
          f"絵の食い違い {len(ra_['mark_bad'])} 件）")

    bad_round = os.path.join(tmp, "mut-round.mkv")
    encode(vfr, control_chain(spans, f"fps=fps={FPS_RATIONAL}:round=down"), bad_round)
    rr = judge(bad_round, plan, last, label="mut-round")
    check(not rr["ok"],
          f"対照: 揃えるときの丸めを round=down にすると落ちる"
          f"（映像 {rr['n_video']} コマ＝正しい数のまま、絵の食い違い {len(rr['mark_bad'])} 件）"
          "＝コマ数だけ数えていると見えない誤り")

    bad_round_cfr = os.path.join(tmp, "mut-round-cfr.mkv")
    encode(cfr, control_chain(spans, f"fps=fps={FPS_RATIONAL}:round=down"), bad_round_cfr)
    rrc = judge(bad_round_cfr, plan, cfr_last, label="mut-round-cfr")
    check(not rrc["ok"],
          f"対照: round=down は一定の素材まで壊す"
          f"（映像 {rrc['n_video']} コマ、絵の食い違い {len(rrc['mark_bad'])} 件）"
          "＝退行の向きでも落とせている")

    # ── 分数のまま渡ること ────────────────────────────────────────
    # 30000/1001 を 29.97 へ丸めると約1万秒に1コマずれるが、CI に載る長さでは測れない。
    # そこで「式へ何が入ったか」で押さえる。期待値は実装から取らずリテラルで書く。
    ntsc = product_chain(spans, "30000/1001")
    check("fps=fps=30000/1001," in ntsc,
          f"コマ数/秒が分数のまま式へ入る（実の先頭60字={ntsc[:60]}）")
    check("29.97" not in ntsc,
          f"小数へ丸めた値が式へ入らない（29.97 が式に現れない）")
    check(ntsc.count("fps=fps=") == 1 and ntsc.count(",split=") == 1
          and ntsc.count("aresample=") == 1 and ntsc.count("asplit=") == 1,
          f"前置は split / asplit で1回だけ（fps の出現 {ntsc.count('fps=fps=')} 回 / "
          f"split の出現 {ntsc.count(',split=')} 回 / aresample の出現 {ntsc.count('aresample=')} 回 / "
          f"asplit の出現 {ntsc.count('asplit=')} 回）＝区間の数だけ重複しない")
    # 映像と音声を1本の concat で繋いでいること。2本に分けると、区間ごとの端数が
    # 継ぎ目で清算されず、区間の数だけ積み上がる（tests/trim-sync-check.py が実測で押さえる）。
    check(ntsc.count("concat=") == 1 and "concat=n=10:v=1:a=1[tvout][taout]" in ntsc,
          f"映像と音声を1本の concat で繋ぐ（concat の出現 {ntsc.count('concat=')} 回 / "
          f"末尾={ntsc[-60:]}）")
    # 秒がフィルタ式に現れないこと（＝コマ番号・標本番号で切っている）。
    check("trim=start_frame=" in ntsc and "trim=start=" not in ntsc
          and "atrim=start_sample=" in ntsc and "atrim=start=" not in ntsc,
          f"切る位置がコマ番号・標本番号で書かれている（秒で書かれていない）"
          f"（実の一部={ntsc[ntsc.index('[sv0]'):ntsc.index('[sv0]') + 70]}）")
    # 分数の形をしていない値は前置しない（式が壊れるのを防ぐ）
    plainv = product_chain(spans, "29.97")
    check("fps=fps=" not in plainv,
          "分数の形でない値は前置に使わない（従来どおりの動きへ落ちる）")

    print(f"\n--- {PASS} PASS / {FAIL} FAIL ---")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
