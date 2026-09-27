// video-shorts tests/filler-cut.mjs — 言い淀み除去が、語の途中の1文字を切らないこと。
// 実行: node tests/filler-cut.mjs

import assert from "node:assert/strict";

import { planFillerCuts } from "../src/filler-cut.mjs";

/** 文字列を Groq 風に「1文字ずつの語」にする。gapAfter[文字位置] で、その文字の後ろの隙間を広げる。 */
function charWords(text, t0, gapAfter = {}) {
  const words = [];
  let t = t0;
  [...text].forEach((c, i) => {
    words.push({ w: c, start: +t.toFixed(3), end: +(t + 0.09).toFixed(3) });
    t += 0.09 + (gapAfter[i] ?? 0.01);
  });
  return words;
}

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`NG  ${name}\n    ${err.message}`);
  }
}

test("「くれちゃうんです」の「ん」を、前後に無音の誤検出があっても切らない", () => {
  // 2026-08-19 に「きれいに切り分けてくれちゃうんです」が「切ります」のように崩れた件の、有力な原因の再現。
  // 「う」「ん」の後ろに 0.2 秒の隙間を置き、その隙間を silencedetect が無音と誤検出した状態を作る。
  const text = "きれいに切り分けてくれちゃうんです";
  const iU = [...text].lastIndexOf("う");
  const iN = [...text].indexOf("ん");
  const words = charWords(text, 1.0, { [iU]: 0.2, [iN]: 0.2 });
  const silences = [
    { start: 0, end: 0.95 },
    { start: words[iN - 1].end + 0.005, end: words[iN].start - 0.005 },
    { start: words[iN].end + 0.005, end: words[iN + 1].start - 0.005 },
    { start: words.at(-1).end + 0.01, end: words.at(-1).end + 0.8 },
  ];
  const plan = planFillerCuts(words, silences);
  assert.deepEqual(plan.cuts, [], `切ってしまった: ${JSON.stringify(plan.cuts)}`);
});

test("文と文の間に独立した「えー」は切る", () => {
  const words = [];
  const silences = [];
  let t = 0.5;
  for (const s of [["今日は", "話を", "します"], ["えー"], ["まず", "見ます"]]) {
    for (const w of s) {
      words.push({ w, start: +t.toFixed(3), end: +(t + 0.4).toFixed(3) });
      t += 0.45;
    }
    silences.push({ start: +(t - 0.05).toFixed(3), end: +(t + 0.6).toFixed(3) });
    t += 0.7;
  }
  const plan = planFillerCuts(words, silences);
  assert.equal(plan.cuts.length, 1, JSON.stringify(plan));
  assert.equal(plan.cuts[0].word, "えー");
});

if (failed) {
  console.error(`${failed} 件失敗`);
  process.exitCode = 1;
} else {
  console.log("2 件すべて通過");
}
