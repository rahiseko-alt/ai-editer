// G-EDIT-TRIM-B/C の判定対象「素材TAの出力」を、本物の buildTrimFilters を通して作る補助スクリプト。
//
// MFCC+DTWの数値計算はPython(tests/trim-filler-match-check.py)側に置く(このリポジトリの慣行:
// FFT・配列演算はPython+numpy、実装コードを直接呼ぶ経路の実行はNode)。この補助スクリプトの
// 役目は「実際の製品コード(buildTrimFilters)を通した正しい出力音声を1つ作ってファイルへ書く」
// ことだけで、判定ロジックは一切持たない。
//
// 使い方: node tests/trim-filler-audio-helper.mjs <出力ファイルパス>
//   calibration.json の kind==="word" の4区間(index1,3,5,7)を KEEP とし、
//   trim-seam-glitch-check.mjs(G-EDIT-TRIM-D)と同じ式でフェード付き音声チェーンを組み、
//   AAC 192kbpsで出力する。fpsRational は渡さない(音声のみの経路。TRIM-Dのスコープ注記と同じ)。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildTrimFilters, SEAM_FADE_SEC } from "../src/trim-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "fixtures", "trim-calibration");
const FLAC = path.join(FIXTURE_DIR, "calibration.flac");
const CAL_JSON = path.join(FIXTURE_DIR, "calibration.json");

const outFile = process.argv[2];
if (!outFile) {
  console.error("usage: node trim-filler-audio-helper.mjs <outFile>");
  process.exit(1);
}

const cal = JSON.parse(fs.readFileSync(CAL_JSON, "utf-8"));
const NATIVE_SR = cal.audio.sample_rate;

const KEEP = [1, 3, 5, 7].map((i) => {
  const s = cal.segments[i];
  return { start: s.start, end: s.end };
});
const spans = buildTrimFilters(KEEP, { sampleRate: NATIVE_SR }).spans;

function buildAudioChain(fadeSec) {
  const n = spans.length;
  const aHead = `[0:a]aresample=${NATIVE_SR},asplit=${n}${spans.map((_, i) => `[sa${i}]`).join("")};`;
  const a = spans.map((c, i) => {
    const len = c.endSample - c.startSample;
    const fade = Math.min(Math.round(fadeSec * NATIVE_SR), Math.floor(len / 4));
    const fadeIn = (i === 0 || fade < 1) ? "" : `,afade=t=in:ss=0:ns=${fade}`;
    const fadeOut = (i === n - 1 || fade < 1) ? "" : `,afade=t=out:ss=${len - fade}:ns=${fade}`;
    return `[sa${i}]atrim=start_sample=${c.startSample}:end_sample=${c.endSample},asetpts=PTS-STARTPTS${fadeIn}${fadeOut}[ta${i}]`;
  });
  const pairs = spans.map((_, i) => `[ta${i}]`).join("");
  return `${aHead}${a.join(";")};${pairs}concat=n=${n}:v=0:a=1[taout]`;
}

execFileSync("ffmpeg", [
  "-y", "-v", "error", "-i", FLAC,
  "-filter_complex", buildAudioChain(SEAM_FADE_SEC),
  "-map", "[taout]", "-c:a", "aac", "-b:a", "192k", outFile,
], { stdio: ["ignore", "ignore", "pipe"] });

console.error(`wrote ${outFile} (spans: ${JSON.stringify(spans.map((s) => s.endSample - s.startSample))})`);
