// 詰めたあとも字幕のタイミングが実際の発声とずれない — G-EDIT-TRIM-E
//
// ── なぜ比較相手を .ass から音声へ変えたか（軌道修正C-7 反証(8)の是正）───────────
// 旧verifyは「焼き込みに使った .ass の各行表示時刻の中央フレームをOCRで読み、その行の文字が
// 読み取れること」を合格条件にしていた。だが .ass は remapWords（この葉が検証したい対象そのもの）
// の出力から生成され、ffmpeg が焼くのも同じ .ass なので、remapWords がどう間違っても両辺に
// 同じ誤りが乗る恒真式になっていた。実測: 正しい remap 結果を一律 +0.5秒 ずらした .ass で焼いても、
// 旧条件は4行中4行が合格した（本テストの「対照A」で同じ実験を再現し、FAILすることを確かめる）。
// 是正として、比較相手を**出力音声そのもの**に変える。出力音声から測る発話開始時刻は、
// remapWords からも keep スパンの再計算からも導かない（keep から逆算すると remapWords の
// 累積オフセット計算を写すだけになり、恒真式が移動するだけ。pipeline.mjs:186-192 に同型の
// 失敗が記録済み）。RMSエンベロープで十分検出できる（ASR・MFCC/DTW 不要）。
//
// ── なぜ「表示終了+0.2秒後は読めない」条件を廃止したか（反証(9)の是正）───────────
// 出荷既定のkaraokeスタイル（src/subtitle-styles.mjs: DEFAULT_SUBTITLE_STYLE="karaoke"）は、
// 1語ごとに Dialogue イベントを出すが、**そのテキストは常に行全体**で、現在語だけ色を変える
// だけの実装（src/srt-builder.mjs:104-122 karaokeEvents）。したがって「表示終了」後も次のイベントで
// 同じ行がそのまま出続けるのは実装のバグではなく構造上の必然で、正しい実装でも4行中2行が
// 不合格になっていた（実測済み）。加えて最後の行は常にクリップ終端で終わるため、+0.2秒後の
// フレームがどのスタイルでも存在しない。よってこの条件は廃止し、受入事実を
// 「字幕の表示開始が、その語が実際に発声される時刻と一致する」の1つに絞る
// （AGENTS.md「1葉＝1事実」。件数の一致は同じ結果の構成手段であり独立した受入事実ではない）。
//
// ── 素材（凍結。他のTRIM葉と同じ計算・同じ数値を使う）────────────────────────
// 音声は calibration.flac（そのまま。区間は加工しない）、映像はこの検査が合成する
// black:s=320x180:r=15（絵の中身は判定に使わない）。TRIM-A の「素材TA」と全く同じ作りで、
// 実測長は 11.052517秒（＝最終区間の終わり。末尾の無音は存在しない。2026-08-12 軌道修正C-7
// 反証(2)(3)是正でcalibration.flac/jsonを作り直したため、PR-1時点の値11.402812から更新した）。
//
// ── 発話開始検出の道具（数値で確定させる。実装後に選べる余地を残さない）────────────
// 10ms窓のRMSを求め、クリップ全体のRMSピークの5%を閾値に「鳴っている」と判定する。
// 150ms未満の谷は同じ塊として結合してから、塊の先頭を発話開始時刻とする。
// 結合ギャップが無いと「ありがとう」「よろしく」が内部の低エネルギー点で2つに割れ、
// 4語のはずが6区間に分裂する（実測済み）。閾値をクリップごとのピーク相対にするのは、
// 詰めたあとの音量が継ぎ目フェード（SEAM_FADE_SEC）の影響で語ごとに微妙に違うため。
//
// ── 許容誤差 TOL_SEC の決め方（2026-08-12 basis-reviewerの指摘で是正）────────────
// 当初±0.3秒（旧ASR比較時代の値を根拠なく流用）で凍結しようとしたが、basis-reviewerが
// 「字幕が一律+0.10〜+0.29秒ずれる偽物」を実際に当てたところ、いずれも検出できない
// （偽の緑）ことが発覚した。RMS法そのものの実測誤差（正しい実装・同一条件で3回再実行し
// 毎回同じ値。決定的なffmpegエンコードのため揺らがない）は最大0.038秒。TOL_SEC=0.08秒は
// その約2.1倍の余裕を取りつつ、+0.10秒以上のバイアスを確実に検出する（対照C参照）。
//
// ── 経路 ────────────────────────────────────────────────────
// pipeline.mjs と同じ順で製品の実体を呼ぶ: probeSize → planTrim → remapWords → buildAss →
// renderClip（buildTrimFilters を内部で使い、音声を実際に切って繋ぐ）。字幕の焼き込みは
// 映像側のフィルタ（ass=...）だけに掛かり、音声は [taout]（buildTrimFilters の出力）を
// そのまま map するので、字幕の内容は出力音声に一切影響しない。ASR・Claude 呼び出しは
// 通さず、語は凍結済み calibration.json の設計値をそのまま使う
// （2026-08-12 是正・軌道修正C-7反証(13)と同じ考え方）。
//
// 実行: node tests/trim-caption-sync-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { planTrim, remapWords, snapStart } from "../src/trim-plan.mjs";
import { probeSize, renderClip, computeCanvas } from "../src/render-vertical.mjs";
import { buildAss } from "../src/srt-builder.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "fixtures", "trim-calibration");
const FLAC = path.join(FIXTURE_DIR, "calibration.flac");
const CAL_JSON = path.join(FIXTURE_DIR, "calibration.json");
const FLAC_SHA = "9590ab1d5c3b084e999bb434cf4e6a6c7c13778a20b30d85cde1088b4ffe9165";
const CAL_SHA = "9cb743c2f9ff730e223c7f8cfc3879faa3f366593f6233cb79e6efe83625dc58";

const SR = 22050;                 // 凍結素材の標本化周波数
const FPS = 15;                   // 合成する映像のコマ数/秒（TRIM-A の素材TAと同じ）
const VIDEO_W = 320, VIDEO_H = 180;
// 素材TAの実測長。2026-08-12 軌道修正C-7反証(2)(3)是正でcalibration.flac/jsonを作り直した
// (index6をあのー→なんか、index7をこんにちは→はいへ差し替え)ため、旧値11.403から更新した。
const TA_DUR = 11.053;

// ── 発話開始検出の数値（凍結）───────────────────────────────────
const ONSET_WIN = 0.010;          // 10ms窓
const ONSET_THR_RATIO = 0.05;     // クリップ内RMSピークの5%を閾値
const ONSET_MERGE_GAP = 0.150;    // 150ms未満の谷は同じ塊として結合
// 許容誤差。旧verifyの±0.3秒（音声認識の単語時刻誤差を根拠にした値）は、比較相手を
// 音声認識からRMS法へ変えたあとは根拠が失効しており、そのまま流用すると「字幕が一律
// 0.1〜0.29秒ずれる」という壊れ方を見逃す穴になっていた（2026-08-12 basis-reviewerの指摘で
// 実測発覚：バイアス+0.10〜+0.29秒のいずれでも旧許容±0.3秒の下では0/4件しか検出できなかった）。
// RMS法そのものの実測誤差（正しい実装・同一条件で3回再実行し毎回同じ値）は最大0.038秒
// （固定パラメータのffmpegエンコードは決定的なため揺らがない）。0.08秒はその約2.1倍の余裕を
// 取りつつ、実測でバイアス+0.10秒以上を確実に検出する（+0.08秒で最初の語が検出境界、
// +0.10秒では4語中2語以上が確実に許容超過）。
const TOL_SEC = 0.08;

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

/** 音声を22050Hzモノラルの生の標本として読む */
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

/**
 * 発話開始時刻の一覧を返す。ONSET_* の数値だけで決まる（実装から導かない）。
 * remapWords も keep スパンの再計算も一切使わない＝この葉が検証したい対象と完全に独立。
 */
function detectOnsets(samples) {
  const win = Math.round(SR * ONSET_WIN);
  const rms = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) { const v = samples[j] / 32768; sum += v * v; }
    rms.push(Math.sqrt(sum / win));
  }
  const peak = rms.reduce((m, v) => Math.max(m, v), 0) || 1e-9;
  const thr = peak * ONSET_THR_RATIO;
  const raw = [];
  let st = null;
  for (let k = 0; k < rms.length; k++) {
    const loud = rms[k] > thr;
    if (loud && st === null) st = k;
    if (!loud && st !== null) { raw.push([st * win / SR, k * win / SR]); st = null; }
  }
  if (st !== null) raw.push([st * win / SR, rms.length * win / SR]);
  const merged = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < ONSET_MERGE_GAP) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  return merged.map((g) => g[0]);
}

/** .ass の Dialogue Start 時刻（h:mm:ss.cs）を秒へ */
function parseAssStarts(assText) {
  const out = [];
  for (const line of assText.split("\n")) {
    const m = line.match(/^Dialogue: \d+,(\d+):(\d\d):(\d\d)\.(\d\d),/);
    if (!m) continue;
    const [, h, mi, s, cs] = m.map(Number);
    out.push(h * 3600 + mi * 60 + s + cs / 100);
  }
  return out;
}

/**
 * 合格条件そのもの。満たさない点を文章で返す（空なら合格）。
 * イベント数が食い違えば（語が脱落・重複すれば）即座に不合格にする。
 */
function judge(assStarts, onsets) {
  const bad = [];
  if (assStarts.length !== onsets.length) {
    bad.push(`字幕イベント数 ${assStarts.length} と発話区間数 ${onsets.length} が食い違う`);
    return bad;
  }
  for (let i = 0; i < assStarts.length; i++) {
    const diff = Math.abs(assStarts[i] - onsets[i]);
    if (!(diff <= TOL_SEC)) {
      bad.push(`語${i + 1}: 字幕開始 ${assStarts[i].toFixed(3)}秒 / 発話開始 ${onsets[i].toFixed(3)}秒`
        + `（差 ${diff.toFixed(3)}秒 > 許容 ${TOL_SEC}秒）`);
    }
  }
  return bad;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "vs-capsync-"));

try {
  t("素材: 音声が凍結どおり（SHA-256 が一致する）", () => {
    assert.strictEqual(sha256(FLAC), FLAC_SHA);
  });
  t("素材: 区間表が凍結どおり（SHA-256 が一致する）", () => {
    assert.strictEqual(sha256(CAL_JSON), CAL_SHA);
  });

  const cal = JSON.parse(fs.readFileSync(CAL_JSON, "utf-8"));
  const segs = cal.segments;
  const words = segs.map((s) => ({ w: s.text, start: s.start, end: s.end }));

  // 素材TA（TRIM-Aと同一の作り）。音声は calibration.flac そのまま、映像はこの検査が合成する。
  const TA = path.join(work, "ta.mkv");
  ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=${VIDEO_W}x${VIDEO_H}:r=${FPS}`,
    "-i", FLAC, "-t", "12.0",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "flac", TA]);

  const size = await probeSize(TA);
  t(`製品経路が素材のコマ数/秒を ${FPS} と読む`, () => {
    assert.strictEqual(size.fps, FPS, `実=${size.fps}`);
  });

  // ── 製品経路で詰め、字幕を写す（pipeline.mjs と同じ順）──────────────────
  // 【2026-08-17 虎の巻 §4-1 による変更】言い淀みの判断は AI（judge）がする。
  // 「なんか」は「何か」にもなるため、judge が無いと固定の一覧では消さなくなった
  // （docs/編集についての虎の巻.md §4-1・§8-H）。この素材の index6 が「なんか」で、
  // judge を渡さないと残り、この検査が見ている「残った4語だけが字幕へ写る」が測れない。
  // 期待値を5語へ緩めるのではなく、AI が素材の言い淀み4区間をすべて言い淀みと
  // 判断した状態を渡す。cutSilence は渡さない（長さの閾値より優先されてしまうため）。
  const fillerIdx = new Set(segs.map((x, i) => (x.kind === "filler" ? i : -1)).filter((i) => i >= 0));
  const plan = planTrim(words, {
    duration: TA_DUR, fps: size.fps,
    judge: { isFiller: (index) => fillerIdx.has(index) },
  });
  const assWords = remapWords(words, plan.keep);
  t("前提: 残った語（言い淀みを除いた4語）だけが字幕へ写る", () => {
    assert.strictEqual(assWords.length, 4, `実=${JSON.stringify(assWords)}`);
  });

  const canvas = computeCanvas("portrait", size.width, size.height);
  const startAt = snapStart(0, size.fps);

  async function renderWithWords(label, wordsForAss) {
    const assPath = path.join(work, `${label}.ass`);
    const assText = buildAss(wordsForAss, null, plan.keptSeconds,
      { style: "karaoke", width: canvas.w, height: canvas.h });
    fs.writeFileSync(assPath, assText, "utf-8");
    const outPath = path.join(work, `${label}.mp4`);
    await renderClip({
      input: TA, start: startAt, end: TA_DUR, assPath, output: outPath,
      orientation: "portrait", srcW: size.width, srcH: size.height, keep: plan.keep,
    });
    return { assText, outPath };
  }

  // ── 本番: 正しく写した字幕で焼く ─────────────────────────────────
  const correct = await renderWithWords("correct", assWords);
  const correctOnsets = detectOnsets(readPcm(correct.outPath));
  t(`対照: 出力音声から発話開始が凍結どおり ${assWords.length} 区間読める`
    + `（結合ギャップが効いていないと6区間に分裂する）`, () => {
    assert.strictEqual(correctOnsets.length, assWords.length, `実=${JSON.stringify(correctOnsets)}`);
  });

  const correctStarts = parseAssStarts(correct.assText);
  t(`正しい実装: 字幕の表示開始が、実際の発話開始と±${TOL_SEC}秒以内で一致する（4語すべて）`, () => {
    const bad = judge(correctStarts, correctOnsets);
    assert.strictEqual(bad.length, 0, bad.join(" / "));
  });

  // ── 対照A（軌道修正C-7反証(8)の再現）: 字幕を一律+0.5秒ずらした偽物は不合格になる ──
  // 音声は完全に同じ(keepが同じなのでbuildTrimFiltersの出力は変わらない)。字幕の時刻だけが
  // 壊れている状態を、実際にレンダリングして確かめる（テスト専用の製品オプションは足さない）。
  const shifted = assWords.map((w) => ({ ...w, start: w.start + 0.5, end: w.end + 0.5 }));
  const shiftedRender = await renderWithWords("shift05", shifted);
  const shiftedStarts = parseAssStarts(shiftedRender.assText);
  t("対照A: 字幕を一律+0.5秒ずらした偽物は、4語すべてで許容誤差を超えて検出される"
    + "（旧verifyはこの偽物を4行中4行合格させていた＝恒真式が解消したことの証明）", () => {
    const bad = judge(shiftedStarts, correctOnsets);
    assert.strictEqual(bad.length, 4, `検出できたのは${bad.length}/4件: ${bad.join(" / ")}`);
  });

  // ── 対照B: 語が1つ脱落した字幕は、件数不一致として検出される ────────────────
  const dropped = assWords.slice(1); // 1語目「こんにちは」が脱落した想定
  t("対照B: 語が1つ脱落した字幕は、発話区間数との食い違いとして検出される", () => {
    const bad = judge(parseAssStarts(
      buildAss(dropped, null, plan.keptSeconds, { style: "karaoke", width: canvas.w, height: canvas.h })
    ), correctOnsets);
    assert.strictEqual(bad.length, 1, `実=${JSON.stringify(bad)}`);
    assert.ok(/食い違う/.test(bad[0]), bad[0]);
  });

  // ── 対照C（2026-08-12 basis-reviewerの指摘で追加）: 字幕が一律+0.10秒ずれる偽物も検出される ──
  // 許容誤差を緩く取りすぎると「字幕全体が一定量だけ遅れて/早まって出る」という、視聴者が
  // 気づくレベルの不具合を見逃す。実測: +0.10秒のバイアスは対照A(+0.5秒)よりずっと小さいが、
  // TOL_SEC=0.08秒の下では4語中2語以上が確実に許容を超える(このテストが実際に確かめる)。
  const bias010 = assWords.map((w) => ({ ...w, start: w.start + 0.10, end: w.end + 0.10 }));
  const bias010Render = await renderWithWords("bias010", bias010);
  t("対照C: 字幕を一律+0.10秒ずらした偽物も、許容誤差を超えて検出される"
    + "（許容誤差を緩く取りすぎて偽の緑を作っていないことの証明）", () => {
    const bad = judge(parseAssStarts(bias010Render.assText), correctOnsets);
    assert.ok(bad.length >= 1, `1件も検出できなかった（許容誤差が緩すぎる）`);
  });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail > 0 ? 1 : 0);
