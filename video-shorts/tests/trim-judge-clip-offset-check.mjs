// tests/trim-judge-clip-offset-check.mjs
// G-EDIT-TRIM2-CLIP-FILLER / G-EDIT-TRIM2-CLIP-SILENCE
//
// 【何を見るか】素材の先頭以外から切り出したクリップでも、「間を詰める」のAIの判断が
// 正しい語・正しい間に当たること。
//
// 【なぜ要るか】判断（src/trim-judge.mjs）は「素材全体」の添字と絶対時刻で持っているのに、
// planTrim（src/trim-plan.mjs）は「クリップ相対」の添字と時刻で動く。この2つの時間軸を
// 橋渡ししていなかったため、2026-08-16 時点で次の2つが壊れていた（どちらも実測で再現済み）。
//   ① 言い淀み: クリップ相対の添字で素材全体の語を引くので、素材で最初に出た同じ字面の
//      判定が使われる。先頭の「あの」が言い淀みなら、後半の「あの資料を」まで消える。
//   ② 間: cutGaps は素材の絶対時刻で持つのに、planTrim はクリップ相対の時刻で聞くため、
//      先頭以外のクリップでは常に「詰めない」が返る＝「間を詰める」が丸ごと効かない。
//
// 【対照について】対照は「作り物」ではなく、**直す前の実装そのもの**を使う。
// loadTrimJudge() の戻り値は素材の先頭（オフセット0）用の判断で、これは直す前と同じ挙動。
// 先頭以外のクリップにそれを使うと落ちる、という形で検出力を示す。
//
// 実行: node tests/trim-judge-clip-offset-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTrimJudge } from "../src/trim-judge.mjs";
import { planTrim } from "../src/trim-plan.mjs";
import { wordsInRange } from "../src/srt-builder.mjs";

let pass = 0,
  fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n      ${e.stack || e.message}`);
  }
}

// ── 固定素材 ────────────────────────────────────────────────
// 同じ字面「あの」を2か所に置く。index 0 は言い淀み、index 4 は指示語（残すべき）。
// index 3「えー」の後に 4〜6秒の間があり、AI はそこを「詰めてよい」と判断している。
const WORDS = [
  { w: "あの", start: 0, end: 1 }, // 0: 言い淀み
  { w: "資料", start: 1, end: 2 },
  { w: "を", start: 2, end: 3 },
  { w: "えー", start: 3, end: 4 }, // 3: 言い淀み。この後 4〜6秒が間
  { w: "あの", start: 6, end: 7 }, // 4: 指示語（残すべき）
  { w: "話", start: 7, end: 8 },
];
const JUDGE_JSON = { fillers: [0, 3], cutGaps: [3] };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trim-clip-"));
fs.writeFileSync(path.join(tmp, "trim-judge.json"), JSON.stringify(JUDGE_JSON), "utf-8");
const judge = loadTrimJudge(tmp, WORDS);
assert.ok(judge, "判断が読み込めない");

/** 素材の [from,to] を切り出したクリップを planTrim へ通す。 */
function planClip(from, to, useOffset, opts = {}) {
  const rel = wordsInRange(WORDS, from, to);
  const j = useOffset ? judge.forClip(from) : judge; // false = 直す前と同じ呼び方
  return { rel, plan: planTrim(rel, { duration: to - from, judge: j, ...opts }) };
}

/** クリップ相対の [s,e] が keep に丸ごと残っているか。 */
function isKept(keep, s, e) {
  return keep.some((k) => k.start <= s + 1e-6 && k.end >= e - 1e-6);
}

/* ══════ ① 2本目以降のクリップでも、消してよい言い淀みだけが消える ══════ */

t("CLIP-FILLER: 素材の6〜8秒を切り出しても、指示語「あの」が残る", () => {
  const { rel, plan } = planClip(6, 8, true, { cutSilence: false });
  console.log(`  [実測] 語=${JSON.stringify(rel.map((w) => w.w))} keep=${JSON.stringify(plan.keep)}`);
  assert.ok(
    isKept(plan.keep, 0, 1),
    `指示語「あの」（クリップ相対 0〜1秒）が消えている: keep=${JSON.stringify(plan.keep)}`,
  );
});

t("CLIP-FILLER 対照: クリップの開始位置を教えないと、その指示語が消える（直す前の実装）", () => {
  const { plan } = planClip(6, 8, false, { cutSilence: false });
  console.log(`  [実測] 直す前: keep=${JSON.stringify(plan.keep)}`);
  assert.ok(
    !isKept(plan.keep, 0, 1),
    `直す前の呼び方でも指示語が残っており、この検査に見分ける力が無い: keep=${JSON.stringify(plan.keep)}`,
  );
});

t("CLIP-FILLER: 本物の言い淀みは、2本目以降のクリップでもちゃんと消える", () => {
  // 素材の 3〜8秒。先頭の「えー」(素材 index 3) は言い淀みなので消えるはず。
  const { rel, plan } = planClip(3, 8, true, { cutSilence: false });
  console.log(`  [実測] 語=${JSON.stringify(rel.map((w) => w.w))} keep=${JSON.stringify(plan.keep)}`);
  assert.ok(
    !isKept(plan.keep, 0, 1),
    `言い淀み「えー」（クリップ相対 0〜1秒）が残っている: keep=${JSON.stringify(plan.keep)}`,
  );
  assert.ok(isKept(plan.keep, 3, 4), `指示語「あの」（同 3〜4秒）が消えている`);
});

/* ══════ ② 2本目以降のクリップでも、詰めてよい間が詰まる ══════ */

t("CLIP-SILENCE: 素材の3〜8秒を切り出しても、AIが詰めてよいと言った間が詰まる", () => {
  // 言い淀みは消さない設定にして、詰まった秒数が「間」だけから来ることを確かめる。
  const { plan } = planClip(3, 8, true, { cutFillers: false });
  console.log(`  [実測] cutSeconds=${plan.cutSeconds} cuts=${JSON.stringify(plan.cuts)}`);
  assert.ok(plan.cutSeconds > 0, `間が1秒も詰まっていない: cutSeconds=${plan.cutSeconds}`);
  assert.ok(
    plan.cuts.some((c) => c.start >= 1 - 1e-6 && c.end <= 3 + 1e-6),
    `詰めた場所が、AIが指した間（クリップ相対 1〜3秒）と違う: ${JSON.stringify(plan.cuts)}`,
  );
});

t("CLIP-SILENCE 対照: クリップの開始位置を教えないと、その間が1秒も詰まらない（直す前の実装）", () => {
  const { plan } = planClip(3, 8, false, { cutFillers: false });
  console.log(`  [実測] 直す前: cutSeconds=${plan.cutSeconds}`);
  assert.strictEqual(
    plan.cutSeconds,
    0,
    `直す前の呼び方でも間が詰まっており、この検査に見分ける力が無い: cutSeconds=${plan.cutSeconds}`,
  );
});

t("CLIP-SILENCE: 素材の先頭から始まるクリップは、これまでどおり詰まる（後方互換）", () => {
  // オフセット0のクリップでは、直す前と直したあとで結果が変わらないこと。
  const withOffset = planClip(0, 8, true, { cutFillers: false }).plan;
  const without = planClip(0, 8, false, { cutFillers: false }).plan;
  console.log(`  [実測] offset付き=${withOffset.cutSeconds}s / 従来=${without.cutSeconds}s`);
  assert.strictEqual(withOffset.cutSeconds, without.cutSeconds, "先頭のクリップで挙動が変わっている");
  assert.ok(withOffset.cutSeconds > 0, "先頭のクリップで間が詰まっていない");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n合計: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
