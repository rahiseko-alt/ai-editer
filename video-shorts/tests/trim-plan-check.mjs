// 無音と言い淀みの詰め方の検証 — G-EDIT-TRIM-A / B / C（決め方の部分）
//
// ここで測るのは「どこを切るか」の計算だけ。出来上がった動画の尺と、その中で声が鳴っている
// 位置は tests/trim-duration-check.mjs が製品経路（planTrim → renderClip）で測る。
// A の合格条件（4.733秒＝71コマ ほか）はそちらに書いてある。
//
// 【素材の全長について】凍結素材 calibration.flac の実測長は 11.402812秒 で、区間表の
// 最終区間の終わり 11.403秒 と一致する。区間表の説明値 audio.duration_sec（11.903）は
// 実ファイルと 0.500秒 食い違う人手の値なので、判定には使わない
// （2026-08-08 の失敗記録「凍結した合格ラインの数値が、凍結素材では誰も満たせない値だった」）。
// 末尾の無音は存在しないので、「末尾の余韻を残す」性質は素材の長さを仮に伸ばして確かめる。
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
const segs = cal.segments;
// 素材の全長は、説明値ではなく区間表の最終区間の終わりを正とする（上のコメント参照）。
const DURATION = segs[segs.length - 1].end;   // 11.403

// 文字起こしが返す形（words[]）へ写す。区間表は設計値なので、これが正。
const words = segs.map((s) => ({ w: s.text, start: s.start, end: s.end }));

t("素材: 区間表の中身が凍結どおり（8区間・フィラー4件・最終区間の終わり11.403秒）", () => {
  assert.strictEqual(segs.length, 8);
  assert.strictEqual(segs.filter((s) => s.kind === "filler").length, 4);
  assert.strictEqual(DURATION, 11.403);
});

t("素材: 説明値 duration_sec(11.903) は実素材と 0.500秒 違う（判定には使わない）", () => {
  // 凍結しておくと、黙って直されたり別の値に化けたときに気づける。
  assert.strictEqual(cal.audio.duration_sec, 11.903);
  assert.ok(Math.abs(cal.audio.duration_sec - DURATION - 0.5) < 1e-9);
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

// ── A: 尺の計算（コマ境界へ揃える前の、決め方だけの値）──────
// 4.703 = 11.403 − 無音3.500 − 言い淀み3.200。素材のコマ数/秒を渡していないので
// コマ境界への丸めは掛からない。丸めを含んだ出荷経路の値（15fps で 4.733秒）は
// tests/trim-duration-check.mjs が実物で測る。
const EXPECTED = 4.703;
t(`A: 通常設定での残り時間が ${EXPECTED} 秒になる（丸め前）`, () => {
  const plan = planTrim(words, { duration: DURATION });
  assert.ok(Math.abs(plan.keptSeconds - EXPECTED) <= 0.01,
    `残り=${plan.keptSeconds} 秒（期待 ${EXPECTED} ±0.01）`);
});

t("A: 末尾の余韻は詰めない（凍結素材には末尾の無音が無いので、0.5秒あるものとして確かめる）", () => {
  // 凍結素材は最終区間の終わりでちょうど終わっている（末尾の無音は存在しない）。
  // 「末尾の余韻を残す」は planTrim の性質なので、素材の長さだけを仮に 0.5秒 伸ばして測る。
  const withTail = DURATION + 0.5;
  const plan = planTrim(words, { duration: withTail });
  const last = plan.keep[plan.keep.length - 1];
  assert.ok(Math.abs(last.end - withTail) < 1e-6, `末尾が ${last.end} で素材の終わり(${withTail})と違う`);
  assert.ok(Math.abs(plan.keptSeconds - (EXPECTED + 0.5)) <= 0.01,
    `末尾の余韻0.5秒が残っていない（残り=${plan.keptSeconds} 秒）`);
});

// ── 対照: 無音カットと言い淀みカットの寄与を分けて測る ────────
// 「両者の短縮量の差が無音カットの寄与」を、決め方の側で確かめる。
t(`対照A: 言い淀みだけを切ると ${(DURATION - 3.2).toFixed(3)} 秒（無音3.500秒は残る）`, () => {
  const plan = planTrim(words, { duration: DURATION, cutSilence: false });
  assert.ok(Math.abs(plan.keptSeconds - (DURATION - 3.2)) <= 0.01,
    `残り=${plan.keptSeconds} 秒（期待 ${(DURATION - 3.2).toFixed(3)} ±0.01）`);
});

t(`対照A: 無音だけを切ると ${(DURATION - 3.5).toFixed(3)} 秒（言い淀み3.200秒は残る）`, () => {
  const plan = planTrim(words, { duration: DURATION, cutFillers: false });
  assert.ok(Math.abs(plan.keptSeconds - (DURATION - 3.5)) <= 0.01,
    `残り=${plan.keptSeconds} 秒（期待 ${(DURATION - 3.5).toFixed(3)} ±0.01）`);
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
  assert.ok(!(Math.abs(kept - EXPECTED) <= 0.01),
    "何も切っていないのに期待の尺と一致すると判定された");
});

t("対照: 言い淀みの一覧が空なら B の検査は落ちる", () => {
  assert.ok(FILLERS.length > 0, "言い淀みの一覧が空");
  const anyFiller = segs.filter((x) => x.kind === "filler").some((s) => isFiller(s.text));
  assert.ok(anyFiller, "一覧が素材の言い淀みを1つも拾えていない");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
