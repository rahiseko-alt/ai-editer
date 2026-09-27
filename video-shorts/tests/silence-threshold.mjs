// video-shorts tests/silence-threshold.mjs — 無音検出の閾値を素材の環境音から決める。
// 実行: node tests/silence-threshold.mjs
// 分布は 2026-09-27 に実素材で測った 50ms 窓のピーク値（p10/p50）を再現したもの。

import assert from "node:assert/strict";

import { BASE_SILENCE_DB, chooseSilenceThresholdDb } from "../src/editorial/silence-threshold.mjs";

/** 下位 noiseShare の窓が noiseDb、残りが speechDb の分布を作る。 */
function dist(noiseDb, speechDb, noiseShare = 0.3, n = 1000) {
  return Array.from({ length: n }, (_, i) => (i < n * noiseShare ? noiseDb : speechDb));
}

const cases = [
  ["静かな素材は今までどおり -30dB", () => {
    assert.equal(chooseSilenceThresholdDb(dist(-60, -12)), BASE_SILENCE_DB);
  }],
  ["無音（-inf）が混ざっていても今までどおり", () => {
    assert.equal(chooseSilenceThresholdDb([...dist(-Infinity, -12, 0.2), -65, -70]), BASE_SILENCE_DB);
  }],
  ["騒がしい素材は環境音の少し上まで上げる（会見場: 環境音 -24dB）", () => {
    const t = chooseSilenceThresholdDb(dist(-24, -17));
    assert.equal(t, -22);
    // 対照: 固定 -30dB では環境音（-24dB）を一度も下回らない＝無音が0件になる
    assert.ok(-24 > BASE_SILENCE_DB);
  }],
  ["話し声との差が小さいときは、話し声を無音とみなさない（中間より上にしない）", () => {
    const t = chooseSilenceThresholdDb(dist(-20, -19));
    assert.ok(t < -19 && t >= -20, `閾値 ${t}`);
  }],
  ["測れなかったときは今までどおり", () => {
    assert.equal(chooseSilenceThresholdDb([]), BASE_SILENCE_DB);
  }],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`NG  ${name}\n    ${err.message}`);
  }
}
if (failed) {
  console.log(`${failed} 件失敗`);
  process.exit(1);
}
console.log(`${cases.length} 件すべて通過`);
