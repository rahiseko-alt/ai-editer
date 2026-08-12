"""言い淀みが消え、語は残っていることの検証 — G-EDIT-TRIM-B / G-EDIT-TRIM-C

【守る受入事実】
B: 詰めた出力に、calibration.json のフィラー区間(index 0,2,4,6)の音声が含まれていない。
C: 詰めた出力に、calibration.json の語区間(index 1,3,5,7)の音声がすべて含まれている。

【なぜ「等長窓を滑らせるDTW」から「部分開始・部分終了(subsequence)DTW」へ変えたか(反証(1)是正)】
旧方式は、探す側(query)と同じ長さの窓を探される側(target)に一定ホップで滑らせ、各位置での
系列長正規化DTW距離の最小値を採用していた。この方式は「窓の長さ=queryの長さ」を固定するため、
フィラーの一部だけが残った(例: 後半だけ削られ90%が残った)出力では、その部分残置区間の実際の
長さがqueryより短く、どの窓位置を取っても残置区間+隣接する別内容が混ざってしまい、DTWの整合が
乱れて距離が押し上がる。旧方式を実装して実測したところ、正しく除去できた場合の距離
(14.84〜17.30、この探り値はcommitされたコードからは再現できない旧verify文言からの転記であり、
本入替えでは使わない)と、90%残置(10.97〜15.45)/75%残置(17.09〜17.49)がいずれも「しきい値
10.022を上回る=含まれない」判定になり、大部分が残っているフィラーを検出できなかった。

本redesignでは、query(探す側=フィラー/語の参照MFCC)をtarget(探される側=出力音声のMFCC全体)に
対して「開始位置・終了位置を固定しないDTW」(subsequence DTW / open begin-end DTW、
Müller "Fundamentals of Music Processing" 4章の定式)で照合する。境界条件:
  D[0,j] = C[0,j]  (queryの先頭フレームはtargetのどこから始まってもよい)
  D[i,0] = C[i,0] + D[i-1,0]  (i>0。target先頭に強制的に詰まった経路は通常コストが高くなる)
  D[i,j] = C[i,j] + min(D[i-1,j], D[i,j-1], D[i-1,j-1])
  距離 = min_j D[N-1,j] / N  (queryの全フレームを使い切ることを要求しつつ、終了位置は自由)
query全体を使い切ることを要求するため、フィラーの一部だけが残っていても、残りのqueryフレームは
targetの別内容(次の語や無音)へ強制的に整合させられ、そこでコストが積み上がる。等長窓方式のように
「窓ぴったりに収まる断片」を探す必要がなく、部分残置を「queryの一部だけしか良く整合しない」という
形で直接測れる。

【言語規約】このリポジトリの慣行(FFT・配列演算はPython+numpy、実装コードを直接呼ぶ経路の実行は
Node)に従い、MFCC抽出・DTWの数値計算はここ(Python)に置く。判定対象の出力音声(「正しい実装」)は
tests/trim-filler-audio-helper.mjs が本物の buildTrimFilters(trim-plan.mjs)を呼んで作る
(このスクリプトはTrimの決定ロジックを一切再実装しない)。

実行: cd video-shorts && python3 tests/trim-filler-match-check.py   (全PASSで exit 0)
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURE_DIR = os.path.join(HERE, "fixtures", "trim-calibration")
FLAC = os.path.join(FIXTURE_DIR, "calibration.flac")
CAL_JSON = os.path.join(FIXTURE_DIR, "calibration.json")
FLAC_SHA = "9590ab1d5c3b084e999bb434cf4e6a6c7c13778a20b30d85cde1088b4ffe9165"
CAL_SHA = "9cb743c2f9ff730e223c7f8cfc3879faa3f366593f6233cb79e6efe83625dc58"

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


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


# ── MFCC(numpyのみ。scipy/librosa等の新規依存は追加しない) ──────────────
WIN_SEC = 0.025
HOP_SEC = 0.010
N_MFCC = 13
N_FILTERS = 26


def _hz_to_mel(hz):
    return 2595.0 * np.log10(1.0 + hz / 700.0)


def _mel_to_hz(mel):
    return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)


def _mel_filterbank(n_filters, n_fft, sr, fmin=0.0, fmax=None):
    fmax = fmax or sr / 2.0
    mel_pts = np.linspace(_hz_to_mel(fmin), _hz_to_mel(fmax), n_filters + 2)
    hz_pts = _mel_to_hz(mel_pts)
    bin_pts = np.floor((n_fft + 1) * hz_pts / sr).astype(int)
    fbank = np.zeros((n_filters, n_fft // 2 + 1))
    for m in range(1, n_filters + 1):
        f_lo, f_mid, f_hi = bin_pts[m - 1], bin_pts[m], bin_pts[m + 1]
        if f_mid > f_lo:
            for k in range(f_lo, f_mid):
                fbank[m - 1, k] = (k - f_lo) / (f_mid - f_lo)
        if f_hi > f_mid:
            for k in range(f_mid, f_hi):
                fbank[m - 1, k] = (f_hi - k) / (f_hi - f_mid)
    return fbank


def _dct2(x):
    """type-II DCT（正規化なし）。scipy不要でnumpyのみで実装。x: (n_frames, n_filters)"""
    n_filters = x.shape[1]
    n = np.arange(n_filters)
    k = n.reshape(-1, 1)
    basis = np.cos(np.pi / n_filters * (n + 0.5) * k)  # (n_filters, n_filters)
    return x @ basis.T


def mfcc(signal, sr, win_sec=WIN_SEC, hop_sec=HOP_SEC, n_mfcc=N_MFCC, n_filters=N_FILTERS, preemph=0.97):
    win = int(round(win_sec * sr))
    hop = int(round(hop_sec * sr))
    n_fft = 1
    while n_fft < win:
        n_fft *= 2
    emphasized = np.append(signal[0], signal[1:] - preemph * signal[:-1])
    n_frames = 1 + (len(emphasized) - win) // hop if len(emphasized) >= win else 0
    if n_frames <= 0:
        return np.zeros((0, n_mfcc))
    idx = np.arange(win)[None, :] + hop * np.arange(n_frames)[:, None]
    frames = emphasized[idx] * np.hamming(win)[None, :]
    spec = np.fft.rfft(frames, n=n_fft)
    power = (np.abs(spec) ** 2) / n_fft
    fbank = _mel_filterbank(n_filters, n_fft, sr)
    mel_energy = power @ fbank.T
    mel_energy = np.where(mel_energy <= 0, np.finfo(float).eps, mel_energy)
    log_energy = np.log(mel_energy)
    coeffs = _dct2(log_energy)
    return coeffs[:, :n_mfcc]


# ── subsequence DTW(開始・終了ともtarget側は自由。反証(1)是正の核心) ──────
def subsequence_dtw_distance(query, target):
    """query(N,d) が target(M,d) のどこかに部分列として含まれている度合い。
    小さいほど「含まれている」。queryの全フレームを使い切ることを要求し、
    target側の開始・終了位置は固定しない。戻り値はqueryの長さで正規化した距離。"""
    n, m = len(query), len(target)
    if n == 0 or m == 0:
        return float("inf")
    diff = query[:, None, :] - target[None, :, :]
    c = np.sqrt(np.sum(diff * diff, axis=2))  # (n, m)
    d = np.empty((n, m))
    d[0, :] = c[0, :]
    for i in range(1, n):
        prev = d[i - 1]
        row = np.empty(m)
        row[0] = c[i, 0] + prev[0]
        # d[i,j] = c[i,j] + min(prev[j], row[j-1], prev[j-1])  (row[j-1]への逐次依存のためforward loop)
        a = np.minimum(prev[1:], prev[:-1])  # min(prev[j], prev[j-1]) for j=1..m-1  -> shape (m-1,)
        cij = c[i, 1:]
        for j in range(1, m):
            row[j] = cij[j - 1] + min(a[j - 1], row[j - 1])
        d[i, :] = row
    return float(d[n - 1, :].min()) / n


def ffmpeg(args):
    subprocess.run(["ffmpeg", "-y", "-v", "error", *args], check=True)


def ffprobe_sr(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=sample_rate", "-of", "default=nw=1:nk=1", path],
        check=True, capture_output=True, text=True,
    )
    return int(out.stdout.strip())


def decode_pcm(path, sr):
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-map", "a:0", "-ar", str(sr), "-ac", "1",
         "-f", "f64le", "-acodec", "pcm_f64le", "pipe:1"],
        check=True, capture_output=True,
    )
    return np.frombuffer(out.stdout, dtype="<f8").copy()


def extract_segment_aac(src, start_sample, end_sample, out_path):
    """calibration.flacの1区間だけを切り出し、AAC 192kbpsで単独ファイルへ再エンコードする
    (校正(i)(ii)用。実際の判定対象=結合済み出力とは別の、孤立した単一区間音声)。"""
    ffmpeg(["-i", src, "-filter_complex",
            f"[0:a]atrim=start_sample={start_sample}:end_sample={end_sample},asetpts=PTS-STARTPTS[o]",
            "-map", "[o]", "-c:a", "aac", "-b:a", "192k", out_path])


def main():
    work = tempfile.mkdtemp(prefix="vs-fillermatch-")

    check(sha256(FLAC) == FLAC_SHA, "素材: 音声が凍結どおり（SHA-256が一致する）")
    check(sha256(CAL_JSON) == CAL_SHA, "素材: 区間表が凍結どおり（SHA-256が一致する）")

    with open(CAL_JSON, encoding="utf-8") as f:
        cal = json.load(f)
    sr = cal["audio"]["sample_rate"]
    segs = cal["segments"]

    # ── 各区間の参照MFCCを、元のcalibration.flacから直接切り出して作る(AAC再エンコードなし) ──
    raw = decode_pcm(FLAC, sr)
    ref_mfcc = {}
    for s in segs:
        clip = raw[s["start_sample"]:s["end_sample"]]
        ref_mfcc[s["index"]] = mfcc(clip, sr)

    filler_idx = [s["index"] for s in segs if s["kind"] == "filler"]
    word_idx = [s["index"] for s in segs if s["kind"] == "word"]
    check(filler_idx == [0, 2, 4, 6], f"素材: フィラー区間のindexが凍結どおり {filler_idx}")
    check(word_idx == [1, 3, 5, 7], f"素材: 語区間のindexが凍結どおり {word_idx}")

    # ── 校正(i): 同一区間をAAC再エンコードした対の距離(identity_pairs_for_i) ──────
    identity_dists = []
    for i in cal["identity_pairs_for_i"]:
        s = segs[i]
        out_path = os.path.join(work, f"id_{i}.m4a")
        extract_segment_aac(FLAC, s["start_sample"], s["end_sample"], out_path)
        sr_out = ffprobe_sr(out_path)
        target = mfcc(decode_pcm(out_path, sr_out), sr_out)
        dist = subsequence_dtw_distance(ref_mfcc[i], target)
        identity_dists.append(dist)
    ceiling = max(identity_dists)
    print(f"[校正(i)] 同一区間・AAC再エンコード対の距離: "
          f"{[round(v, 3) for v in identity_dists]} / max={ceiling:.3f}")

    # ── 校正(ii): 異なる語同士の対の距離(different_word_pairs_for_ii) ──────────
    different_dists = []
    seg_aac_cache = {}
    for i, j in cal["different_word_pairs_for_ii"]:
        if j not in seg_aac_cache:
            s = segs[j]
            out_path = os.path.join(work, f"diff_{j}.m4a")
            extract_segment_aac(FLAC, s["start_sample"], s["end_sample"], out_path)
            sr_out = ffprobe_sr(out_path)
            seg_aac_cache[j] = mfcc(decode_pcm(out_path, sr_out), sr_out)
        dist = subsequence_dtw_distance(ref_mfcc[i], seg_aac_cache[j])
        different_dists.append(dist)
    floor = min(different_dists)
    print(f"[校正(ii)] 異なる語同士の対の距離: min={floor:.3f} "
          f"(全{len(different_dists)}件、最大={max(different_dists):.3f})")

    check(ceiling < floor,
          f"校正: 同一区間の距離上限({ceiling:.3f})が異なる語の距離下限({floor:.3f})を下回り分離できる")

    threshold = (ceiling + floor) / 2
    print(f"[しきい値] ({ceiling:.3f} + {floor:.3f}) / 2 = {threshold:.3f}")

    # ── 判定対象: 本物のbuildTrimFiltersを通した正しい出力(素材TAの出力) ──────
    correct_out = os.path.join(work, "correct.m4a")
    subprocess.run(
        ["node", os.path.join(HERE, "trim-filler-audio-helper.mjs"), correct_out],
        check=True, cwd=ROOT, capture_output=True, text=True,
    )
    sr_correct = ffprobe_sr(correct_out)
    target_correct = mfcc(decode_pcm(correct_out, sr_correct), sr_correct)

    filler_dists = {i: subsequence_dtw_distance(ref_mfcc[i], target_correct) for i in filler_idx}
    word_dists = {i: subsequence_dtw_distance(ref_mfcc[i], target_correct) for i in word_idx}
    print(f"[正しい出力] フィラー距離: { {k: round(v, 3) for k, v in filler_dists.items()} }")
    print(f"[正しい出力] 語距離: { {k: round(v, 3) for k, v in word_dists.items()} }")

    for i in filler_idx:
        check(filler_dists[i] > threshold,
              f"B: フィラー区間(index{i} {segs[i]['text']})の音声が出力に含まれていない"
              f"(距離{filler_dists[i]:.3f} > しきい値{threshold:.3f})")
    for i in word_idx:
        check(word_dists[i] < threshold,
              f"C: 語区間(index{i} {segs[i]['text']})の音声が出力に含まれている"
              f"(距離{word_dists[i]:.3f} < しきい値{threshold:.3f})")

    # ── 反証(1)是正: 部分残置(半端カット)を検出できることの対照(有るときに有ると言える) ──
    # フィラーの一部だけが削られた偽物(先頭r%だけ残し後半を削る)を作り、r=25/50/75/90%のいずれでも
    # 「まだ含まれている」(距離<しきい値)と判定できることを確かめる。r=0%(=正しい実装。上で確認済み)
    # との対比で、旧方式(等長窓スライドDTW)が見逃していた半端カットを新方式が拾えることを実証する。
    def build_partial_residue_output(filler_index, retain_fraction, out_path):
        """calibration.json の word 区間(1,3,5,7)に、filler_indexの区間を先頭retain_fractionだけ
        残した断片を正しい位置へ挿入して連結する(fillerを完全には切らない壊れた実装を模す)。"""
        order = [1, 3, 5, 7]
        earlier = [w for w in order if w < filler_index]
        pos = order.index(max(earlier)) + 1 if earlier else 0
        chain = order[:pos] + [("partial", filler_index, retain_fraction)] + order[pos:]

        NATIVE_SR = sr
        parts = []
        for item in chain:
            if isinstance(item, tuple):
                _, fi, frac = item
                s = segs[fi]
                length = s["end_sample"] - s["start_sample"]
                start = s["start_sample"]
                end = start + max(1, round(length * frac))
            else:
                s = segs[item]
                start, end = s["start_sample"], s["end_sample"]
            parts.append((start, end))

        n = len(parts)
        a_head = f"[0:a]aresample={NATIVE_SR},asplit={n}" + "".join(f"[sa{k}]" for k in range(n)) + ";"
        a_body = []
        for k, (start, end) in enumerate(parts):
            length = end - start
            fade = min(round(0.005 * NATIVE_SR), length // 4)
            fade_in = "" if k == 0 or fade < 1 else f",afade=t=in:ss=0:ns={fade}"
            fade_out = "" if k == n - 1 or fade < 1 else f",afade=t=out:ss={length - fade}:ns={fade}"
            a_body.append(
                f"[sa{k}]atrim=start_sample={start}:end_sample={end},asetpts=PTS-STARTPTS{fade_in}{fade_out}[ta{k}]"
            )
        pairs = "".join(f"[ta{k}]" for k in range(n))
        filt = a_head + ";".join(a_body) + f";{pairs}concat=n={n}:v=0:a=1[out]"
        ffmpeg(["-i", FLAC, "-filter_complex", filt, "-map", "[out]", "-c:a", "aac", "-b:a", "192k", out_path])

    # 是正対象の反証(1)自体が実測していた残置率は90%/75%（旧方式でこの2水準が誤って合格していた）。
    # ここではその2水準を、旧方式の欠陥が起きた2件のフィラーとは別に、この新素材の2件のフィラー
    # (index0=最短级、index6=最長級)で再現する。25%/50%は別途探った結果、フィラーによって
    # 検出できる場合とできない場合があり(filler0の50%は検出できるがfiller6の50%はできない。
    # 詳細はdetail参照)、この葉の受入事実として断定できる範囲を90%/75%に絞る。
    for filler_index in (0, 6):
        for retain_pct in (75, 90):
            out_path = os.path.join(work, f"partial_{filler_index}_{retain_pct}.m4a")
            build_partial_residue_output(filler_index, retain_pct / 100.0, out_path)
            sr_p = ffprobe_sr(out_path)
            target_p = mfcc(decode_pcm(out_path, sr_p), sr_p)
            dist = subsequence_dtw_distance(ref_mfcc[filler_index], target_p)
            check(dist < threshold,
                  f"対照: フィラー(index{filler_index} {segs[filler_index]['text']})の"
                  f"{retain_pct}%だけを残した半端カットは「まだ含まれている」と判定される"
                  f"(距離{dist:.3f} < しきい値{threshold:.3f}。反証(1)是正の実証)")

    # ── 対照: 何も詰めない(全8区間が残る)偽実装は、フィラーが「まだ含まれている」と正しく判定される ──
    passthrough_out = os.path.join(work, "passthrough.m4a")
    ffmpeg(["-i", FLAC, "-map", "a:0", "-c:a", "aac", "-b:a", "192k", passthrough_out])
    sr_pt = ffprobe_sr(passthrough_out)
    target_pt = mfcc(decode_pcm(passthrough_out, sr_pt), sr_pt)
    for i in filler_idx:
        dist = subsequence_dtw_distance(ref_mfcc[i], target_pt)
        check(dist < threshold,
              f"対照: 何も詰めない偽実装は、フィラー(index{i} {segs[i]['text']})が"
              f"「まだ含まれている」と判定される(距離{dist:.3f} < しきい値{threshold:.3f})")

    print(f"\n--- {PASS} PASS / {FAIL} FAIL ---")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
