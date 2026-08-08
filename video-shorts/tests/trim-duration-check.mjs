// 詰めたあとの尺の実測 — G-EDIT-TRIM-A（尺の部分）
//
// A の合格条件は「素材TVを出荷される通常設定で処理した出力の音声の尺が 5.203秒 ±0.1秒」。
// 決め方（どこを切るか）は tests/trim-plan-check.mjs で測る。ここでは実際に ffmpeg で切って、
// 出来上がった音声の尺を ffprobe で測る。
//
// 素材は凍結済みの calibration.flac / calibration.json だけを使い、SHA-256 の一致を毎回確かめる。
// 別の素材や別の区間は持ち込まない（分離しやすい区間を後から選べると、合否を自分に有利にできる）。
//
// 実行: node tests/trim-duration-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildTrimFilters, planTrim } from "../src/trim-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "fixtures", "trim-calibration");
const FLAC = path.join(FIXTURE_DIR, "calibration.flac");
const CAL_JSON = path.join(FIXTURE_DIR, "calibration.json");
const FLAC_SHA = "edb077722b770d109d2568e0f0332ae5af42efa5625dd4ffc39ad51513fec800";
const CAL_SHA = "6f29d6e6222cfd74ace2a62608ba1e8ed54c0852cc841a8506ac51ad69470058";

const EXPECTED = 5.203;      // 11.903 − 無音3.5 − 言い淀み3.200
const TOLERANCE = 0.1;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.message}`); }
}

function sha256(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function audioDuration(p) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=duration", "-of", "default=nw=1:nk=1", p,
  ], { encoding: "utf-8" });
  return Number(out.trim());
}

/** 残す区間だけを取り出してつないだ音声を作る */
function renderTrimmed(input, keep, output) {
  const f = buildTrimFilters(keep);
  assert.ok(f, "残す区間が空");
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-i", input,
    "-filter_complex", f.audioChain, "-map", "[taout]",
    "-c:a", "aac", "-b:a", "192k", output,
  ]);
  return output;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "vs-trim-"));

try {
  // ── 素材が凍結どおりであること ────────────────────────────
  t("素材: 音声が凍結どおり（SHA-256 が一致する）", () => {
    assert.strictEqual(sha256(FLAC), FLAC_SHA);
  });
  t("素材: 区間表が凍結どおり（SHA-256 が一致する）", () => {
    assert.strictEqual(sha256(CAL_JSON), CAL_SHA);
  });

  const cal = JSON.parse(fs.readFileSync(CAL_JSON, "utf-8"));
  const DURATION = cal.audio.duration_sec;
  const words = cal.segments.map((s) => ({ w: s.text, start: s.start, end: s.end }));

  t(`対照: 詰める前の音声が ${DURATION} 秒である`, () => {
    const d = audioDuration(FLAC);
    assert.ok(Math.abs(d - DURATION) <= 0.02, `実=${d} 秒`);
  });

  // ── A: 通常設定で詰めた尺 ────────────────────────────────
  const plan = planTrim(words, { duration: DURATION });
  const outNormal = renderTrimmed(FLAC, plan.keep, path.join(work, "normal.m4a"));
  t(`A: 通常設定で詰めた音声の尺が ${EXPECTED} 秒（±${TOLERANCE}）`, () => {
    const d = audioDuration(outNormal);
    assert.ok(Math.abs(d - EXPECTED) <= TOLERANCE,
      `実=${d.toFixed(3)} 秒（期待 ${EXPECTED} ±${TOLERANCE}）`);
  });

  // ── 対照: 無音カットと言い淀みカットの寄与を分けて測る ────
  // これが無いと、単に音声を削る実装でも A が合格してしまう。
  const planFillerOnly = planTrim(words, { duration: DURATION, cutSilence: false });
  const outFillerOnly = renderTrimmed(FLAC, planFillerOnly.keep, path.join(work, "filler.m4a"));
  const EXPECT_FILLER_ONLY = DURATION - 3.2;   // 8.703
  t(`対照A: 言い淀みだけ詰めると ${EXPECT_FILLER_ONLY.toFixed(3)} 秒（±${TOLERANCE}）`, () => {
    const d = audioDuration(outFillerOnly);
    assert.ok(Math.abs(d - EXPECT_FILLER_ONLY) <= TOLERANCE, `実=${d.toFixed(3)} 秒`);
  });

  const planSilenceOnly = planTrim(words, { duration: DURATION, cutFillers: false });
  const outSilenceOnly = renderTrimmed(FLAC, planSilenceOnly.keep, path.join(work, "silence.m4a"));
  const EXPECT_SILENCE_ONLY = DURATION - 3.5;  // 8.403
  t(`対照A: 無音だけ詰めると ${EXPECT_SILENCE_ONLY.toFixed(3)} 秒（±${TOLERANCE}）`, () => {
    const d = audioDuration(outSilenceOnly);
    assert.ok(Math.abs(d - EXPECT_SILENCE_ONLY) <= TOLERANCE, `実=${d.toFixed(3)} 秒`);
  });

  t("対照A: 無音カットの寄与が 3.500 秒（±0.15）", () => {
    // 両者の短縮量の差が、無音カットの寄与にあたる（A の verify が求めている確認）。
    const dFiller = audioDuration(outFillerOnly);
    const dNormal = audioDuration(outNormal);
    const contribution = dFiller - dNormal;
    assert.ok(Math.abs(contribution - 3.5) <= 0.15,
      `実=${contribution.toFixed(3)} 秒（期待 3.500 ±0.15）`);
  });

  // ── 対照: 何も詰めない設定なら縮まない ────────────────────
  const planNone = planTrim(words, { duration: DURATION, cutSilence: false, cutFillers: false });
  const outNone = renderTrimmed(FLAC, planNone.keep, path.join(work, "none.m4a"));
  t(`対照A: 何も詰めない設定なら ${DURATION} 秒のまま（±${TOLERANCE}）`, () => {
    const d = audioDuration(outNone);
    assert.ok(Math.abs(d - DURATION) <= TOLERANCE, `実=${d.toFixed(3)} 秒`);
  });

  // ── 対照: 区間の数だけ尺が余る組み方でないこと ────────────
  // select で組むと音声1コマ(約46ms)の端数が区間の数だけ積み上がる（実測で確認済み）。
  // 区間を細かく割っても合計が変わらないことで、その組み方でないことを示す。
  t("対照A: 残す区間を細かく割っても、合計の尺は変わらない", () => {
    const coarse = [{ start: 1.0, end: 3.0 }];
    const fine = [
      { start: 1.0, end: 1.5 }, { start: 1.5, end: 2.0 },
      { start: 2.0, end: 2.5 }, { start: 2.5, end: 3.0 },
    ];
    const a = audioDuration(renderTrimmed(FLAC, coarse, path.join(work, "coarse.m4a")));
    const b = audioDuration(renderTrimmed(FLAC, fine, path.join(work, "fine.m4a")));
    assert.ok(Math.abs(a - b) <= 0.03,
      `1区間=${a.toFixed(3)}秒 と 4区間=${b.toFixed(3)}秒 が違う（端数が積み上がっている）`);
  });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
