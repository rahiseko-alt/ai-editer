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


def render(src, keep, out, shortest=False):
    """keep 区間だけを残して詰める。製品と同じ buildTrimFilters を使う。"""
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


def measure(out):
    """出力の各コマについて (絵から読んだ番号, 音から読んだ番号) を返す"""
    frames = read_frames(out)
    pcm = read_pcm(out)
    pairs = []
    for i, fr in enumerate(frames):
        v = read_marker(fr)
        # そのコマが映っている時間の真ん中あたりで音を測る（端は継ぎ目のフェードが掛かる）
        t0 = i / FPS + 0.25 / FPS
        t1 = i / FPS + 0.75 / FPS
        hz = hz_at(pcm, t0, t1)
        if hz is None:
            continue
        pairs.append((v, hz_to_frame(hz)))
    return pairs


def worst_gap(pairs):
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
    check(len(pairs) > 50, f"詰めた出力から十分な数のコマを測れた（実 {len(pairs)} コマ）")
    gap = worst_gap(pairs)
    # 合格ライン: 全コマで、絵から読んだ番号と音から読んだ番号の差が 0 コマ。
    # 1コマ（1/15秒＝66.7ms）ずれた時点で口の動きと声のずれとして見える。
    bad = [(i, v, a) for i, (v, a) in enumerate(pairs) if v != a]
    check(gap == 0,
          f"詰めたあとも、全コマで絵と音が同じコマ番号を指す（最大ずれ {gap} コマ / "
          f"食い違い {len(bad)} 件 先頭3件={bad[:3]}）")

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
