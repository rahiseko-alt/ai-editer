// video-shorts tests/editorial.mjs — 編集案の検査・旧形式の変換・EDL への変換・承認の照合。
// 実行: node tests/editorial.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { approvalProblem, writeApproval } from "../src/editorial/approval.mjs";
import { snapRanges } from "../src/editorial/boundary.mjs";
import { keepToPlan, renderScript, validatePlan } from "../src/editorial/plan-schema.mjs";
import { resolveEdl } from "../src/editorial/resolve-edl.mjs";
import { planFillerCuts, subtractCuts } from "../src/filler-cut.mjs";
import { groupIntoPhrases } from "../src/script/phrases.mjs";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 合成の文字起こし: 文が5つ、文と文の間に実測無音、途中に母音性フィラー「えー」を1つ。
const words = [];
const silences = [];
{
  let t = 0.5;
  const sentences = [
    ["今日は", "動画", "編集の", "話を", "します"],
    ["えー"],
    ["まず", "素材を", "全部", "見ます"],
    ["次に", "使う", "ところを", "決めます"],
    ["最後に", "書き出します"],
  ];
  for (const s of sentences) {
    for (const w of s) {
      words.push({ w, start: +t.toFixed(3), end: +(t + 0.4).toFixed(3) });
      t += 0.45;
    }
    silences.push({ start: +(t - 0.05).toFixed(3), end: +(t + 0.6).toFixed(3) });
    t += 0.7;
  }
}
const units = groupIntoPhrases(words, silences).map((u, i) => ({ i, start: +u.start.toFixed(3), end: +u.end.toFixed(3), w: u.w }));

test("正しい編集案は通る", () => {
  const plan = { version: 1, segments: [{ fromUnit: 0, toUnit: 1 }, { fromUnit: 2, toUnit: 2, role: "BODY" }] };
  assert.deepEqual(validatePlan(plan, units.length), []);
});

test("編集案に時刻が書かれていたら止める", () => {
  const plan = { version: 1, segments: [{ fromUnit: 0, toUnit: 1, start: 1.2 }] };
  const errs = validatePlan(plan, units.length);
  assert.ok(errs.some((e) => e.includes("時刻（start）")), errs.join("\n"));
});

test("範囲外・逆順・重複を止める", () => {
  const n = units.length;
  assert.ok(validatePlan({ version: 1, segments: [{ fromUnit: 0, toUnit: n }] }, n).length > 0);
  assert.ok(validatePlan({ version: 1, segments: [{ fromUnit: 2, toUnit: 1 }] }, n).length > 0);
  const dup = validatePlan({ version: 1, segments: [{ fromUnit: 0, toUnit: 2 }, { fromUnit: 2, toUnit: 3 }] }, n);
  assert.ok(dup.some((e) => e.includes("両方に入っています")), dup.join("\n"));
  assert.ok(validatePlan({ version: 1, segments: [] }, n).length > 0);
});

test("旧形式の keep.json を同じ意味の編集案に直す", () => {
  const plan = keepToPlan({ keep: [[3, 1], [4, 4]], applied: ["a", ""], notApplied: ["b"] });
  assert.deepEqual(plan.segments, [{ fromUnit: 1, toUnit: 3 }, { fromUnit: 4, toUnit: 4 }]);
  assert.deepEqual(plan.applied, ["a"]);
  assert.deepEqual(plan.notApplied, ["b"]);
});

test("EDL の区間は、以前の render と同じ計算結果になる", () => {
  // 1つ目の区間は途中に「えー」を含む＝言い淀み除去で2つに割れる（除去の経路も比べる）。
  const keep = [[0, 6], [units.length - 2, units.length - 1]];
  // 以前の renderMain の計算（2026-09-26 時点の main と同じ手順）
  const legacyRaw = keep.map(([a, b]) => ({ start: units[Math.min(a, b)].start, end: units[Math.max(a, b)].end }));
  let legacy = snapRanges(legacyRaw, silences, groupIntoPhrases(words, silences));
  const filler = planFillerCuts(words, silences);
  legacy = subtractCuts(legacy, filler.cuts);
  assert.equal(legacy.length, 3, "対照: 言い淀み除去で1つ目の区間が割れていない＝このテストは除去の経路を比べていない");

  const edl = resolveEdl({ plan: keepToPlan({ keep }), units, silences, words, source: "x.mp4" });
  assert.deepEqual(edl.ranges.map(({ start, end }) => ({ start, end })), legacy);
  assert.equal(edl.version, 2);
});

test("並べ替えた編集案は、その順番のまま EDL になる", () => {
  const last = units.length - 1;
  const edl = resolveEdl({
    plan: { version: 1, segments: [{ fromUnit: last, toUnit: last, role: "HOOK" }, { fromUnit: 0, toUnit: 0 }] },
    units, silences, words, source: "x.mp4",
  });
  assert.equal(edl.ranges[0].segment, 0);
  assert.equal(edl.ranges[0].role, "HOOK");
  assert.ok(edl.ranges[0].start > edl.ranges[edl.ranges.length - 1].start);
});

test("--no-snap / --no-filler は、文節の時刻そのままの区間を出す", () => {
  const plan = { version: 1, segments: [{ fromUnit: 0, toUnit: units.length - 1 }] };
  const edl = resolveEdl({ plan, units, silences, words, source: "x.mp4", noSnap: true, noFiller: true });
  assert.deepEqual(edl.ranges.map(({ start, end }) => ({ start, end })), [{ start: units[0].start, end: units[units.length - 1].end }]);
});

test("台本案は採用した文節の本文を順番どおりに並べる", () => {
  const text = renderScript({ version: 1, segments: [{ fromUnit: 1, toUnit: 1 }, { fromUnit: 0, toUnit: 0, reason: "r" }] }, units);
  assert.ok(text.indexOf(units[1].w) < text.indexOf(units[0].w));
  assert.ok(text.includes("理由: r"));
});

test("承認は、承認した時点の編集案と1文字でも違えば無効", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-approval-"));
  try {
    const file = path.join(dir, "editorial_plan.json");
    const text = '{"version":1,"segments":[{"fromUnit":0,"toUnit":1}]}';
    assert.match(approvalProblem(dir, file, text), /承認されていません/);
    writeApproval(dir, file, text);
    assert.equal(approvalProblem(dir, file, text), null);
    assert.match(approvalProblem(dir, file, text.replace('"toUnit":1', '"toUnit":2')), /書き換えられています/);
    assert.match(approvalProblem(dir, path.join(dir, "keep.json"), text), /もう一度承認/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`NG  ${name}\n    ${err.message.split("\n").join("\n    ")}`);
  }
}
if (failed) {
  console.error(`${failed} 件失敗`);
  process.exitCode = 1;
} else {
  console.log(`${tests.length} 件すべて通過`);
}
