// 無音と言い淀みの詰め方の検証 — G-EDIT-TRIM-A / B / C（決め方の部分）
//
// A の合格条件は「素材TVを通常設定で処理した出力の音声の尺が 5.203秒 ±0.1秒」。
// ここで測るのは、その尺を決める「どこを切るか」の計算。実際に切った出力の尺は、
// レンダリングを繋いだあとに測る。
//
// 素材は凍結済みの tests/fixtures/trim-calibration/calibration.json だけを使う。
// 別の区間を持ち込まない（分離しやすい区間を後から選べると、合否を自分に有利にできるため）。
//
// 実行: node tests/trim-plan-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FILLERS, isFiller, normalizeWord, planTrim } from "../src/trim-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "fixtures", "trim-calibration");
const CAL_JSON = path.join(FIXTURE_DIR, "calibration.json");
const CAL_SHA = "6f29d6e6222cfd74ace2a62608ba1e8ed54c0852cc841a8506ac51ad69470058";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.message}`); }
}

// ── 素材が凍結どおりであること ──────────────────────────────
const calRaw = fs.readFileSync(CAL_JSON);
t("素材: 区間表が凍結どおり（SHA-256 が一致する）", () => {
  const got = crypto.createHash("sha256").update(calRaw).digest("hex");
  assert.strictEqual(got, CAL_SHA, `区間表が変わっている（実=${got}）`);
});

const cal = JSON.parse(calRaw.toString("utf-8"));
const DURATION = cal.audio.duration_sec;      // 11.903
const segs = cal.segments;

// 文字起こしが返す形（words[]）へ写す。区間表は設計値なので、これが正。
const words = segs.map((s) => ({ w: s.text, start: s.start, end: s.end }));

t("素材: 区間表の中身が凍結どおり（8区間・フィラー4件・全長11.903秒）", () => {
  assert.strictEqual(segs.length, 8);
  assert.strictEqual(segs.filter((s) => s.kind === "filler").length, 4);
  assert.strictEqual(DURATION, 11.903);
});

// ── 言い淀みの見分け ────────────────────────────────────────
t("B: 区間表のフィラー4件がすべて言い淀みと判定される", () => {
  for (const s of segs.filter((x) => x.kind === "filler")) {
    assert.ok(isFiller(s.text), `言い淀みと判定されない: ${s.text}`);
  }
});

t("C: 区間表の語4件は言い淀みと判定されない（必要な話を消さない）", () => {
  for (const s of segs.filter((x) => x.kind === "word")) {
    assert.ok(!isFiller(s.text), `語なのに言い淀みと判定された: ${s.text}`);
  }
});

t("B: 伸ばし棒や句読点の揺れを吸収する", () => {
  for (const s of ["あのー", "あの", "あのー、", "あの。", " あのー "]) {
    assert.ok(isFiller(s), `言い淀みと判定されない: ${JSON.stringify(s)}`);
  }
  assert.strictEqual(normalizeWord("あのー、"), "あの");
});

t("C: 似ているが別の語は切らない", () => {
  for (const s of ["あのひと", "そのとき", "まあまあ", "なんかいも", ""]) {
    assert.ok(!isFiller(s), `切ってはいけない語を切った: ${JSON.stringify(s)}`);
  }
});

// ── A: 尺の計算 ────────────────────────────────────────────
const EXPECTED = 5.203;   // 11.903 − 無音3.5 − 言い淀み3.200
t(`A: 通常設定での残り時間が ${EXPECTED} 秒になる`, () => {
  const plan = planTrim(words, { duration: DURATION });
  assert.ok(Math.abs(plan.keptSeconds - EXPECTED) <= 0.1,
    `残り=${plan.keptSeconds} 秒（期待 ${EXPECTED} ±0.1）`);
});

t("A: 末尾の余韻(0.5秒)は詰めない", () => {
  const plan = planTrim(words, { duration: DURATION });
  const last = plan.keep[plan.keep.length - 1];
  assert.ok(Math.abs(last.end - DURATION) < 1e-6, `末尾が ${last.end} で素材の終わり(${DURATION})と違う`);
  const lastWordEnd = segs[segs.length - 1].end;
  assert.ok(Math.abs(last.end - lastWordEnd - 0.5) <= 0.01,
    `末尾の余韻が0.5秒でない（実=${(last.end - lastWordEnd).toFixed(3)}秒）`);
});

// ── 対照: 無音カットと言い淀みカットの寄与を分けて測る ────────
// A の verify が求めている「両者の短縮量の差が無音カットの寄与」を、決め方の側で確かめる。
t("対照A: 言い淀みだけを切ると 8.403 秒（無音3.5秒は残る）", () => {
  const plan = planTrim(words, { duration: DURATION, cutSilence: false });
  assert.ok(Math.abs(plan.keptSeconds - (DURATION - 3.2)) <= 0.1,
    `残り=${plan.keptSeconds} 秒（期待 ${(DURATION - 3.2).toFixed(3)} ±0.1）`);
});

t("対照A: 無音だけを切ると 8.403 秒（言い淀み3.200秒は残る）", () => {
  const plan = planTrim(words, { duration: DURATION, cutFillers: false });
  assert.ok(Math.abs(plan.keptSeconds - (DURATION - 3.5)) <= 0.1,
    `残り=${plan.keptSeconds} 秒（期待 ${(DURATION - 3.5).toFixed(3)} ±0.1）`);
});

t("対照A: 何も切らない設定なら全長のまま（＝単に削る実装ではない）", () => {
  const plan = planTrim(words, { duration: DURATION, cutSilence: false, cutFillers: false });
  assert.ok(Math.abs(plan.keptSeconds - DURATION) <= 0.001,
    `残り=${plan.keptSeconds} 秒（期待 ${DURATION}）`);
});

// ── C: 残す区間に、語がすべて含まれていること ────────────────
t("C: 言い淀みでない4語が、すべて残す区間に丸ごと入っている", () => {
  const plan = planTrim(words, { duration: DURATION });
  for (const s of segs.filter((x) => x.kind === "word")) {
    const covered = plan.keep.some((k) => k.start <= s.start + 1e-6 && k.end >= s.end - 1e-6);
    assert.ok(covered, `語が残っていない: ${s.text}（${s.start}〜${s.end}）`);
  }
});

t("B: 言い淀み4区間は、残す区間のどこにも入っていない", () => {
  const plan = planTrim(words, { duration: DURATION });
  for (const s of segs.filter((x) => x.kind === "filler")) {
    const overlapped = plan.keep.some((k) => k.end > s.start + 1e-6 && k.start < s.end - 1e-6);
    assert.ok(!overlapped, `言い淀みが残っている: ${s.text}（${s.start}〜${s.end}）`);
  }
});

// ── 切る区間の整合 ──────────────────────────────────────────
t("残す区間と切る区間が重ならず、合わせて全長になる", () => {
  const plan = planTrim(words, { duration: DURATION });
  for (const k of plan.keep) {
    for (const c of plan.cuts) {
      assert.ok(!(k.end > c.start + 1e-6 && k.start < c.end - 1e-6),
        `重なっている: 残す ${k.start}〜${k.end} と 切る ${c.start}〜${c.end}`);
    }
  }
  const total = plan.keptSeconds + plan.cuts.reduce((a, c) => a + (c.end - c.start), 0);
  assert.ok(Math.abs(total - DURATION) <= 0.01, `合計 ${total} が全長 ${DURATION} と違う`);
});

t("残す区間は時刻の順に並び、重なりが無い", () => {
  const plan = planTrim(words, { duration: DURATION });
  for (let i = 1; i < plan.keep.length; i++) {
    assert.ok(plan.keep[i].start >= plan.keep[i - 1].end - 1e-6,
      `順序か重なりがおかしい: ${JSON.stringify(plan.keep.slice(i - 1, i + 1))}`);
  }
});

// ── 壊れた入力で落ちない ────────────────────────────────────
t("語が無くても落ちない", () => {
  assert.deepStrictEqual(planTrim([], { duration: 3 }).keep, [{ start: 0, end: 3 }]);
});

t("時刻が壊れた語は無視する（落ちない）", () => {
  const plan = planTrim([
    { w: "こんにちは", start: 0, end: 1 },
    { w: "こわれ", start: 2, end: 1 },
    { w: null, start: 3, end: 4 },
  ], { duration: 5 });
  assert.ok(plan.keptSeconds > 0);
});

// ── 対照: この検査が「詰めていない実装」を見つけられること ────
t("対照: 何も切らない実装なら A の検査は落ちる", () => {
  const kept = DURATION;   // 何も切らなかった場合
  assert.ok(!(Math.abs(kept - EXPECTED) <= 0.1),
    "何も切っていないのに期待の尺と一致すると判定された");
});

t("対照: 言い淀みの一覧が空なら B の検査は落ちる", () => {
  assert.ok(FILLERS.length > 0, "言い淀みの一覧が空");
  const anyFiller = segs.filter((x) => x.kind === "filler").some((s) => isFiller(s.text));
  assert.ok(anyFiller, "一覧が素材の言い淀みを1つも拾えていない");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
