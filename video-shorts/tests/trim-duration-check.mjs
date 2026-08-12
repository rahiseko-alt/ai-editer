// 詰めたあとの尺の実測 — G-EDIT-TRIM-A
//
// ── 対応ノード ────────────────────────────────────────────────
// docs/roadmap.html の G-EDIT-TRIM-A（区間の中の長い無音が、詰めたぶんだけ尺に反映される）。
//
// ── 合格条件（criteria の引用。2026-08-12 軌道修正C-7反証(2)(3)是正で素材を作り直した）──
// 「『間を詰める』を選んだ経路で処理した出力が、素材から《0.20秒以上の無音》と《言い淀み》
//   だけを取り除いてつないだものになっている。素材TA（凍結素材そのまま・長い間隙）では
//   音声(a:0)の尺が 4.267秒（64コマ＝64/15秒）、素材TA-S（同じ語・同じ言い淀みを 0.10秒＝
//   しきい値未満の間隙で並べ直したもの）では 4.933秒（74コマ）になり、どちらも出力の中で
//   声が鳴っている区間の位置が、凍結した位置と一致する。両者の『詰めた量』の差 3.466秒 が、
//   長い無音を詰めた寄与にあたる。」
//
// ── なぜこの測り方か ──────────────────────────────────────────
// (1) なぜ尺だけで判定しないか
//     「尺が期待どおり」は、末尾を切り落としただけの実装でも成立する（空虚に真）。
//     実際、この検査の変異実験 M2（一切詰めずに -t を 4.267秒 にするだけ）は尺の判定を通る。
//     そこで、出力の中で「声が鳴っている区間」の開始・終了時刻の列も測り、凍結した位置と
//     突き合わせる。尺・継ぎ目の位置・詰めた場所が同時に決まり、部分的に満たす偽物が作れない。
//     （同じ型の穴を6回掘った記録が docs/failures.md 2026-08-08 にある。）
// (2) なぜ素材を2つ使うか
//     出力の尺は、間隙の長さを変えても「語だけが残る」実装では変わらない。長い間隙の素材
//     だけでは「0.20秒以上の無音を詰めた」ことを一度も検証できない。しきい値未満（0.10秒）の
//     間隙に置き換えた素材TA-S を同じ設定で通し、間隙が残ることまで見て初めて、
//     「長い無音を詰めた量」が独立に決まる。
//     これは製品の設定を切り替える対照ではない（cutSilence:false のようなテスト専用の
//     切り替えは使わない）。設定は同じままで、入力だけを差し替える。
// (3) なぜ fps を凍結するか
//     planTrim は残す区間の端をコマの境目へ揃える（G-EDIT-TRIM-F）。素材のコマ数/秒が
//     変わると期待値も変わり、fps が取れない素材では揃えが素通りして別の数字になる。
//     素材TA/TA-S は 15fps で合成し、コマ数/秒は製品の probeSize（＝pipeline.mjs が使うのと
//     同じ実体）から取る。期待値は実装から導かず、下に数字で書く。
// (4) なぜ文字起こしを通さないか
//     製品の words は音声認識の出力で、実行ごとに変わりうる。ここで受け入れるのは
//     「詰め方と切り方」であって「認識器が言い淀みをその表記で出すこと」ではない。
//     語の時刻は凍結済みの calibration.json（設計値）を使い、認識器は通さない。
//     認識器を通す経路の受入は、この葉の対象外（別葉・未着手）。
//
// ── 実行方法 ─────────────────────────────────────────────────
//   cd video-shorts && node tests/trim-duration-check.mjs   (全PASSで exit 0)
//   ffmpeg / ffprobe が要る。素材は毎回この検査が合成する（コミットしない）。

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { planTrim, snapStart } from "../src/trim-plan.mjs";
import { probeSize, renderClip } from "../src/render-vertical.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "fixtures", "trim-calibration");
const FLAC = path.join(FIXTURE_DIR, "calibration.flac");
const CAL_JSON = path.join(FIXTURE_DIR, "calibration.json");
const FLAC_SHA = "9590ab1d5c3b084e999bb434cf4e6a6c7c13778a20b30d85cde1088b4ffe9165";
const CAL_SHA = "9cb743c2f9ff730e223c7f8cfc3879faa3f366593f6233cb79e6efe83625dc58";

// ── 素材の作り（数値で確定させる）──────────────────────────────
const SR = 22050;              // 凍結素材の標本化周波数
const FPS = 15;                // 合成する映像のコマ数/秒。コマ周期 = 1/15 秒
const VIDEO_W = 320, VIDEO_H = 180;   // 絵の中身は判定に使わない（測るのは a:0）。安く作るための寸法
const TAS_GAP = 0.10;          // 素材TA-S の間隙（秒）。DEFAULT_MIN_SILENCE=0.20 より短い＝詰まらない

// 素材TA の全長。凍結素材の最終区間の終わりと一致する（末尾の無音は存在しない）。
// 2026-08-12 軌道修正C-7反証(2)(3)是正で素材を作り直したため、この値も作り直した
// （旧11.403 → 新11.053。index6を「あのー」→「なんか」、index7を「こんにちは」→「はい」へ
// 差し替えたことで全長が変わった。index0〜5は変更していないため、その区間の位置は不変）。
const TA_DUR = 11.053;
// 素材TA-S の全長。8区間を 0.10秒 の間隙で並べた設計値（下の TAS_SEGMENTS の末尾と一致する）。
const TAS_DUR = 8.253;

// 素材TA-S の設計時刻（区間の長さは calibration.json のまま、間隙だけ 0.10秒 にした）。
// 実装から計算せず、ここに数字で書く（製品経路を実際に通し、下記の判定と同じ道具で実測して確定した。
// 2026-08-12 素材作り直しにより再計算。index0〜5の時刻は旧素材と同じ）。
const TAS_SEGMENTS = [
  [0.000, 0.813], [0.913, 2.171], [2.271, 3.058], [3.158, 4.215],
  [4.315, 5.128], [5.228, 6.358], [6.458, 7.381], [7.481, 8.253],
];

// ── 声を読む道具（数値で確定させる）────────────────────────────
// 10ms ごとに窓の中の最大振幅を見て、フルスケールの 2% を超えていれば「鳴っている」。
// 凍結素材は語と語の間が完全な無音（振幅0）なので、この単純な読み方で発話の位置が確定する。
// 手順は「0.10秒 未満の塊を捨てる → 残った塊のうち間隔 0.10秒 未満のものをつなぐ」。
// 先に切れ端を捨てるのは、区間の端をコマ境界へ丸めたときに継ぎ目へ数十ミリ秒だけ残る
// 隣の語の出だしを拾わないため（実測の切れ端は 0.012〜0.023秒、本物の発話の最小の塊は 0.190秒。
// 0.10秒 はその中間にあり、どちらへも 4倍以上の余裕がある）。
const RMS_WIN = 0.010, RMS_THR = 0.02, MERGE_GAP = 0.100, MIN_RUN = 0.100;

// ── 凍結した期待値 ─────────────────────────────────────────
// 2026-08-12 軌道修正C-7反証(2)(3)是正で素材を作り直した（index6「あのー」→「なんか」・
// index7「こんにちは」→「はい」）。以下はすべて、新素材で実際に製品経路
// (probeSize→snapStart→planTrim→renderClip)を通して実測した値であり、手計算ではない
// （2026-08-12 basis-reviewerの指摘で、この葉とは別件だが「探り済みの記録を自分で
// 再実行せず転記した」失敗があったため、この葉ではすべて実行結果をそのまま書いている。
// 詳細はdocs/failures.md 2026-08-12参照）。index0〜5に由来する数値は、当然ながら
// 旧素材の値（コメント併記）と一致する。
//
// 【残すべき区間】calibration.json の kind==="word" の4区間。言い淀み(kind==="filler")と、
// 語と語の間の 0.5秒 の無音（0.20秒以上なので詰める対象）を取り除くと、これだけが残る。
// 【コマ境界への丸め】端を「秒×15 を四捨五入して 15 で割る」規則で丸める（G-EDIT-TRIM-F）。
//   1.313×15=19.695→20 / 2.571×15=38.565→39   → 19コマ（旧素材と同じ）
//   4.358×15=65.370→65 / 5.415×15=81.225→81   → 16コマ（旧素材と同じ）
//   7.228×15=108.42→108 / 8.358×15=125.37→125 → 17コマ（旧素材と同じ）
//  10.281×15=154.215→154 /11.053×15=165.795→166→ 12コマ（新: 語「はい」ぶん短い）
//   合計 64コマ = 64/15 = 4.266667 秒
const TA_KEEP_FRAMES = [[20, 39], [65, 81], [108, 125], [154, 166]];
const TA_EXPECT_SEC = 64 / 15;

// 素材TA-S は間隙 0.10秒 が詰まらないので、間隙ごと1つにつながった4区間が残る。
//   0.813×15=12.195→12 / 2.271×15=34.065→34   → 22コマ（旧素材と同じ）
//   3.058×15=45.870→46 / 4.315×15=64.725→65   → 19コマ（旧素材と同じ）
//   5.128×15=76.920→77 / 6.458×15=96.870→97   → 20コマ（旧素材と同じ）
//   7.381×15=110.715→111 / 8.253×15=123.795→124 → 13コマ（新: 語「はい」ぶん短い）
//   合計 74コマ = 74/15 = 4.933333 秒
const TAS_KEEP_FRAMES = [[12, 34], [46, 65], [77, 97], [111, 124]];
const TAS_EXPECT_SEC = 74 / 15;

// 【素材の中で声が鳴っている位置】上の道具で凍結素材を読んだ値。素材が凍結どおりであることの
// 対照でもあり、「無音が有るときに有ると言える」ことの証明でもある（8個読めなければ、
// 出力に無音が無いという判定は何も見ていないことになる）。
const TA_SRC_GROUPS = [
  [0.000, 0.431], [1.353, 2.185], [3.067, 3.468], [4.350, 5.031],
  [5.913, 6.344], [7.226, 7.978], [8.850, 9.401], [10.293, 10.664],
];
// 素材TA-S は同じ区間を並べ直したものなので、各区間の頭出し時刻ぶんだけ前へ寄る。
const TAS_SRC_GROUPS = [
  [0.000, 0.431], [0.952, 1.784], [2.265, 2.676], [3.157, 3.829],
  [4.310, 4.741], [5.222, 5.974], [6.455, 6.996], [7.497, 7.868],
];

// 【出力の中で声が鳴っている位置】残す区間へ落として、前へ詰めた位置。
const TA_EXPECT_GROUPS = [
  [0.020, 0.852], [1.283, 1.964], [2.355, 3.107], [3.498, 3.869],
];
const TAS_EXPECT_GROUPS = [
  [0.150, 0.982], [1.554, 2.235], [2.826, 3.578], [4.169, 4.530],
];

// 【長い無音を詰めた寄与】TAで詰めた量(TA_DUR−出力尺) − TA-Sで詰めた量(TAS_DUR−出力尺)。
// 実測: TAは6.800秒詰め、TA-Sは3.334秒詰め、差3.466秒。
// 設計上の無音は 0.5秒×7＝3.500秒 で、差 0.034秒はコマ境界へ丸めたぶん（旧素材と同水準）。
const SILENCE_CONTRIB = 3.466;

// 【許容幅】
// ・尺 TOL_SEC=0.025秒。出力は 22050Hz・aac で、a:0 の duration は標本の数でほぼそのまま出る
//   （実測 duration_ts=104363 に対し期待 104370。食い違いは 7標本＝0.0003秒）。
//   0.025秒 はその約80倍の余裕を取りつつ、コマ周期 1/15=0.067秒 の半分（0.033秒）より小さいので、
//   コマが1つ増減した実装は必ず落ちる。
// ・位置 TOL_POS=0.030秒。読み取りの刻みが 0.010秒 で、実測の食い違いは最大 0.006秒。
//   その5倍を取った。半コマ（0.033秒）より小さいので、区間を1コマずらした実装は落ちる。
const TOL_SEC = 0.025;
const TOL_POS = 0.030;
const TOL_CONTRIB = 0.050;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.message}`); }
}

function sha256(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: ["ignore", "ignore", "pipe"] });
}

function probeEntry(file, stream, entry) {
  return execFileSync("ffprobe", [
    "-v", "error", "-select_streams", stream,
    "-show_entries", `stream=${entry}`, "-of", "default=nw=1:nk=1", file,
  ], { encoding: "utf-8" }).trim();
}

const audioDuration = (p) => Number(probeEntry(p, "a:0", "duration"));
const videoFrames = (p) => Number(probeEntry(p, "v:0", "nb_frames"));

/** 音声を 22050Hz モノラルの生の標本として読む */
function readPcm(file) {
  const buf = execFileSync("ffmpeg", [
    "-v", "error", "-i", file, "-map", "a:0",
    "-f", "s16le", "-ac", "1", "-ar", String(SR), "-",
  ], { maxBuffer: 1 << 28 });
  const n = buf.length >> 1;
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = buf.readInt16LE(i * 2);
  return a;
}

/** 声が鳴っている区間（秒）の一覧。上の RMS_* の数値だけで決まる */
function voiceGroups(samples) {
  const win = Math.round(SR * RMS_WIN);
  const loud = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let m = 0;
    for (let j = i; j < i + win; j++) { const v = Math.abs(samples[j]) / 32768; if (v > m) m = v; }
    loud.push(m > RMS_THR);
  }
  const raw = [];
  let st = null;
  for (let k = 0; k < loud.length; k++) {
    if (loud[k] && st === null) st = k;
    if (!loud[k] && st !== null) { raw.push([st * win / SR, k * win / SR]); st = null; }
  }
  if (st !== null) raw.push([st * win / SR, loud.length * win / SR]);
  const kept = raw.filter((r) => r[1] - r[0] >= MIN_RUN);
  const merged = [];
  for (const r of kept) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < MERGE_GAP) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

const fmtGroups = (g) => JSON.stringify(g.map((r) => r.map((v) => +v.toFixed(3))));

/**
 * 合格条件そのもの。満たさない点を文章で返す（空なら合格）。
 * 変異実験は、壊した成果物をこの同じ関数へ通して「空でない」ことを見る。
 */
function judge(out, expectSec, expectFrames, expectGroups) {
  const bad = [];
  const d = audioDuration(out);
  if (!(Math.abs(d - expectSec) <= TOL_SEC)) {
    bad.push(`尺 ${d.toFixed(3)}秒（期待 ${expectSec.toFixed(3)} ±${TOL_SEC}）`);
  }
  const nf = videoFrames(out);
  if (nf !== expectFrames) bad.push(`コマ数 ${nf}（期待 ${expectFrames}）`);
  const got = voiceGroups(readPcm(out));
  if (got.length !== expectGroups.length) {
    bad.push(`声の区間が ${got.length} 個（期待 ${expectGroups.length}）: ${fmtGroups(got)}`);
  } else {
    for (let i = 0; i < got.length; i++) {
      for (const k of [0, 1]) {
        if (!(Math.abs(got[i][k] - expectGroups[i][k]) <= TOL_POS)) {
          bad.push(`声の区間${i + 1}の${k === 0 ? "頭" : "尻"} ${got[i][k].toFixed(3)}秒`
            + `（期待 ${expectGroups[i][k].toFixed(3)} ±${TOL_POS}）`);
        }
      }
    }
  }
  return bad;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "vs-trimdur-"));

try {
  // ── 素材が凍結どおりであること ────────────────────────────
  t("素材: 音声が凍結どおり（SHA-256 が一致する）", () => {
    assert.strictEqual(sha256(FLAC), FLAC_SHA);
  });
  t("素材: 区間表が凍結どおり（SHA-256 が一致する）", () => {
    assert.strictEqual(sha256(CAL_JSON), CAL_SHA);
  });

  const cal = JSON.parse(fs.readFileSync(CAL_JSON, "utf-8"));
  const segs = cal.segments;

  // 説明書きの数値を、素材そのもので検算する（2026-08-08 の失敗の再発防止）。
  t(`検算: 凍結素材の実測長が ${TA_DUR} 秒（＝最終区間の終わり。末尾の無音は存在しない）`, () => {
    const d = audioDuration(FLAC);
    assert.ok(Math.abs(d - TA_DUR) <= 0.002, `実=${d} 秒`);
    assert.strictEqual(segs[segs.length - 1].end, TA_DUR);
  });
  t("素材: duration_sec は実測値そのもの（2026-08-12 作り直した新素材には旧素材にあった0.500秒の食い違いが無い）", () => {
    // ここで凍結しておくと、黙って直されたり別の値に化けたときに気づける。
    assert.strictEqual(cal.audio.duration_sec, 11.052517);
    assert.ok(Math.abs(cal.audio.duration_sec - TA_DUR) < 0.001);
  });

  // ── 素材を作る ────────────────────────────────────────────
  // 素材TA: 凍結素材の音声そのまま + 15fps の映像（絵の中身は判定に使わない）。
  // 映像を音声より長くするのは、映像側で音声が切れないようにするため。
  const TA = path.join(work, "ta.mkv");
  ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=${VIDEO_W}x${VIDEO_H}:r=${FPS}`,
    "-i", FLAC, "-t", "12.0",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "flac", TA]);

  // 素材TA-S: 同じ8区間を、間隙 0.10秒 で並べ直したもの。
  // 区間の切り出しは calibration.json の start_sample/end_sample（整数標本）を使う。
  const segFiles = segs.map((s) => {
    const o = path.join(work, `seg${s.index}.wav`);
    ffmpeg(["-i", FLAC,
      "-af", `atrim=start_sample=${s.start_sample}:end_sample=${s.end_sample},asetpts=PTS-STARTPTS`,
      "-c:a", "pcm_s16le", o]);
    return o;
  });
  const gapFile = path.join(work, "gap.wav");
  ffmpeg(["-f", "lavfi", "-i", `anullsrc=r=${SR}:cl=mono`, "-t", String(TAS_GAP), "-c:a", "pcm_s16le", gapFile]);
  const parts = [];
  segFiles.forEach((f, i) => { if (i) parts.push(gapFile); parts.push(f); });
  const listFile = path.join(work, "list.txt");
  fs.writeFileSync(listFile, parts.map((p) => `file '${p}'`).join("\n"));
  const tasAudio = path.join(work, "tas.wav");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c:a", "pcm_s16le", tasAudio]);
  const TAS = path.join(work, "tas.mkv");
  ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=${VIDEO_W}x${VIDEO_H}:r=${FPS}`,
    "-i", tasAudio, "-t", "9.0",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "flac", TAS]);

  t(`素材TA-S: 合成した全長が ${TAS_DUR} 秒（8区間 + 0.10秒×7）`, () => {
    const d = audioDuration(tasAudio);
    assert.ok(Math.abs(d - TAS_DUR) <= 0.002, `実=${d} 秒`);
  });

  // ── 対照: 声を読む道具が、有るものを有ると言えること ────────
  // 「出力に長い無音が残っていない」を合格条件にする以上、無音／発話を読み分けられることを
  // 先に示す必要がある（AGENTS.md「有るとき有ると言える対照」）。
  t(`対照: 素材TA から声の区間が凍結どおり ${TA_SRC_GROUPS.length} 個読める`, () => {
    const got = voiceGroups(readPcm(TA));
    assert.strictEqual(got.length, TA_SRC_GROUPS.length, `実=${fmtGroups(got)}`);
    for (let i = 0; i < got.length; i++) {
      for (const k of [0, 1]) {
        assert.ok(Math.abs(got[i][k] - TA_SRC_GROUPS[i][k]) <= TOL_POS,
          `区間${i + 1} が ${fmtGroups([got[i]])}（凍結 ${fmtGroups([TA_SRC_GROUPS[i]])}）`);
      }
    }
  });
  t(`対照: 素材TA-S から声の区間が凍結どおり ${TAS_SRC_GROUPS.length} 個読める`, () => {
    const got = voiceGroups(readPcm(TAS));
    assert.strictEqual(got.length, TAS_SRC_GROUPS.length, `実=${fmtGroups(got)}`);
    for (let i = 0; i < got.length; i++) {
      for (const k of [0, 1]) {
        assert.ok(Math.abs(got[i][k] - TAS_SRC_GROUPS[i][k]) <= TOL_POS,
          `区間${i + 1} が ${fmtGroups([got[i]])}（凍結 ${fmtGroups([TAS_SRC_GROUPS[i]])}）`);
      }
    }
  });

  // ── 製品経路で詰める ──────────────────────────────────────
  // pipeline.mjs と同じ順で呼ぶ: probeSize でコマ数/秒 → snapStart で切り出し開始を揃える
  // → planTrim で残す区間を決める → renderClip が出荷どおりの設定で焼く。
  const wordsTA = segs.map((s) => ({ w: s.text, start: s.start, end: s.end }));
  const wordsTAS = segs.map((s, i) => ({ w: s.text, start: TAS_SEGMENTS[i][0], end: TAS_SEGMENTS[i][1] }));

  const sizeTA = await probeSize(TA);
  const sizeTAS = await probeSize(TAS);
  t(`製品経路が素材のコマ数/秒を ${FPS} と読む（読めないと揃えが素通りして別の数字になる）`, () => {
    assert.strictEqual(sizeTA.fps, FPS, `素材TA=${sizeTA.fps}`);
    assert.strictEqual(sizeTAS.fps, FPS, `素材TA-S=${sizeTAS.fps}`);
  });

  async function runProduct(input, size, words, duration, out, opts = {}) {
    const plan = planTrim(words, { duration, fps: opts.noFps ? undefined : size.fps, ...opts.planOpts });
    const start = snapStart(0, size.fps);
    await renderClip({
      input, start, end: duration, output: out, orientation: "portrait",
      srcW: size.width, srcH: size.height,
      keep: opts.keep === null ? null : (opts.keep || plan.keep),
    });
    return plan;
  }

  const outTA = path.join(work, "ta-trimmed.mp4");
  const planTA = await runProduct(TA, sizeTA, wordsTA, TA_DUR, outTA);
  const outTAS = path.join(work, "tas-trimmed.mp4");
  const planTAS = await runProduct(TAS, sizeTAS, wordsTAS, TAS_DUR, outTAS);

  const framesOf = (plan) => plan.keep.map((s) => [Math.round(s.start * FPS), Math.round(s.end * FPS)]);

  t("素材TA: 残す区間が、凍結したコマ番号のとおりである", () => {
    assert.deepStrictEqual(framesOf(planTA), TA_KEEP_FRAMES);
  });
  t("素材TA-S: 残す区間が、凍結したコマ番号のとおりである（0.10秒の間隙は詰まらない）", () => {
    assert.deepStrictEqual(framesOf(planTAS), TAS_KEEP_FRAMES);
  });

  t(`A: 素材TA の出力が、長い無音と言い淀みだけを取り除いたものになっている（${TA_EXPECT_SEC.toFixed(3)}秒・64コマ）`, () => {
    const bad = judge(outTA, TA_EXPECT_SEC, 64, TA_EXPECT_GROUPS);
    assert.strictEqual(bad.length, 0, bad.join(" / "));
  });
  t(`A: 素材TA-S の出力が、言い淀みだけを取り除いたものになっている（${TAS_EXPECT_SEC.toFixed(3)}秒・74コマ）`, () => {
    const bad = judge(outTAS, TAS_EXPECT_SEC, 74, TAS_EXPECT_GROUPS);
    assert.strictEqual(bad.length, 0, bad.join(" / "));
  });

  t(`A: 長い無音を詰めた寄与が ${SILENCE_CONTRIB} 秒として現れる`, () => {
    const cutTA = TA_DUR - audioDuration(outTA);
    const cutTAS = TAS_DUR - audioDuration(outTAS);
    const contrib = cutTA - cutTAS;
    assert.ok(Math.abs(contrib - SILENCE_CONTRIB) <= TOL_CONTRIB,
      `実=${contrib.toFixed(3)} 秒（TA は ${cutTA.toFixed(3)} 秒 / TA-S は ${cutTAS.toFixed(3)} 秒 詰めた）`);
  });

  // ── 変異実験 ──────────────────────────────────────────────
  // 心臓部を壊した実装で、上と同じ judge() が落ちることを、この検査自身に示させる。
  // 「緑になった理由が測り方の中に埋め込まれている」状態でないことの確認（docs/failures.md 参照）。

  const mutTA = {};
  // M1: 一切詰めない（keep を渡さない）
  mutTA.none = path.join(work, "m1-none.mp4");
  await runProduct(TA, sizeTA, wordsTA, TA_DUR, mutTA.none, { keep: null });
  // M2: 一切詰めず、-t を期待の尺にするだけ（＝末尾を切るだけ）。尺は合ってしまう。
  mutTA.tail = path.join(work, "m2-tail.mp4");
  await renderClip({
    input: TA, start: 0, end: TA_EXPECT_SEC, output: mutTA.tail, orientation: "portrait",
    srcW: sizeTA.width, srcH: sizeTA.height, keep: null,
  });
  // M3: 尺もコマ数も合うが、残す場所が違う（言い淀みのほうを残した実装）。
  //     4つの言い淀み区間の開始コマ(0/46/89/133。calibration.jsonのindex0/2/4/6の開始秒×15を
  //     四捨五入した値)から、対応する正解区間(TA_KEEP_FRAMES)と同じ幅(19/16/17/12コマ)だけ
  //     取る。コマ番号で [0,19] [46,62] [89,106] [133,145] ＝ 19+16+17+12 ＝ 64コマ ＝ 4.267秒
  //     （正解と合計コマ数が完全に一致するよう幅をそろえた。2026-08-12素材作り直しにより、
  //     フィラー区間そのものの幅の合計(12+12+12+14=50コマ)は正解の合計と一致しなくなったため、
  //     「同じ合計・違う場所」という変異の意図を保つために幅をそろえ直した）。
  //     中身は言い淀み4区間から始まる範囲になる。尺だけを見る判定はこれを通してしまう。
  mutTA.wrongPlace = path.join(work, "m3-wrongplace.mp4");
  await runProduct(TA, sizeTA, wordsTA, TA_DUR, mutTA.wrongPlace, {
    keep: [[0, 19], [46, 62], [89, 106], [133, 145]].map(([a, b]) => ({ start: a / FPS, end: b / FPS })),
  });
  // M4: コマ境界へ揃えない（fps が取れなかったのと同じ状態）
  mutTA.nofps = path.join(work, "m4-nofps.mp4");
  await runProduct(TA, sizeTA, wordsTA, TA_DUR, mutTA.nofps, { noFps: true });
  // M5: しきい値を無視して、どんなに短い無音も詰める（素材TA-S で効く）
  const mutTAS_all = path.join(work, "m5-allsilence.mp4");
  await runProduct(TAS, sizeTAS, wordsTAS, TAS_DUR, mutTAS_all, { planOpts: { minSilence: 0 } });

  t("変異: 一切詰めない実装は落ちる（尺も声の位置も合わない）", () => {
    const bad = judge(mutTA.none, TA_EXPECT_SEC, 64, TA_EXPECT_GROUPS);
    assert.ok(bad.length > 0, "一切詰めていないのに合格した");
  });
  t("変異: 末尾を切るだけの実装は落ちる（尺は合うが、声の位置が合わない）", () => {
    // これが「尺だけでは判定できない」ことの実証。尺の判定だけなら通ってしまう。
    const d = audioDuration(mutTA.tail);
    assert.ok(Math.abs(d - TA_EXPECT_SEC) <= TOL_SEC,
      `この変異は尺が合っている前提の実験だが、実=${d.toFixed(3)}秒だった`);
    const bad = judge(mutTA.tail, TA_EXPECT_SEC, 64, TA_EXPECT_GROUPS);
    assert.ok(bad.length > 0, "末尾を切っただけなのに合格した");
  });
  t("変異: 尺もコマ数も合うが残す場所が違う実装は落ちる（言い淀みのほうを残した実装）", () => {
    const d = audioDuration(mutTA.wrongPlace);
    assert.ok(Math.abs(d - TA_EXPECT_SEC) <= TOL_SEC,
      `この変異は尺が合っている前提の実験だが、実=${d.toFixed(3)}秒だった`);
    assert.strictEqual(videoFrames(mutTA.wrongPlace), 64, "この変異はコマ数も合っている前提");
    const bad = judge(mutTA.wrongPlace, TA_EXPECT_SEC, 64, TA_EXPECT_GROUPS);
    assert.ok(bad.length > 0, "残す場所が違うのに合格した");
  });
  t("変異: コマ境界へ揃えない実装は落ちる（＝fps を凍結する必要があることの実証）", () => {
    const bad = judge(mutTA.nofps, TA_EXPECT_SEC, 64, TA_EXPECT_GROUPS);
    assert.ok(bad.length > 0, "揃えなくても合格した＝fps を凍結する意味が無い");
  });
  t("変異: しきい値未満の無音まで詰める実装は落ちる（素材TA-S で効く）", () => {
    const bad = judge(mutTAS_all, TAS_EXPECT_SEC, 74, TAS_EXPECT_GROUPS);
    assert.ok(bad.length > 0, "0.10秒の間隙まで詰めたのに合格した");
  });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
