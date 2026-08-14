// 「1区間の最小尺」を利用者が指定できることの検査。
// 実行: node tests/min-sec-option-check.mjs   (全PASSで exit 0)
//
// 背景（2026-08-14 実素材の初回処理・docs/failures.md）:
// 既定180秒のままだと「話題毎」でAIが選んだ区間が3分未満のとき隣と強制結合され、
// 実素材(10分17秒のインタビュー)では4区間が2本(うち1本7分10秒)になり、ショート動画に
// ならなかった。env(TOPIC_MIN_SEC)でしか変えられず、CLI からは指定できなかった。
// この検査は「利用者が --min-sec で実際に長さを変えられる」ことを守る。
//
// 何を測るか:
//   (1) resolveMinSec の優先順（CLI > env > 既定）と、不正値を次の優先度へ落とす挙動
//   (2) その値が mergeShortSegments の結果を実際に変えること（＝指定が効いている）
//   (3) pipeline.mjs の render が --min-sec を実際に受け取って渡していること（配線）

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveMinSec,
  DEFAULT_MIN_SEC,
  mergeShortSegments,
} from "../src/snap-boundaries.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name} ${extra}`);
  }
};

// ---------------------------------------------------------------- (1) 優先順
check(
  "既定: 何も指定しなければ180秒",
  resolveMinSec(undefined, undefined) === 180 && DEFAULT_MIN_SEC === 180,
  `実 ${resolveMinSec(undefined, undefined)}`,
);
check(
  "env だけ指定すれば env が効く",
  resolveMinSec(undefined, "45") === 45,
  `実 ${resolveMinSec(undefined, "45")}`,
);
check(
  "CLI と env の両方があれば CLI が勝つ",
  resolveMinSec("30", "45") === 30,
  `実 ${resolveMinSec("30", "45")}`,
);
check(
  "CLI が数値として読めなければ env へ落ちる",
  resolveMinSec("abc", "45") === 45,
  `実 ${resolveMinSec("abc", "45")}`,
);
check(
  "CLI が0以下なら env へ落ちる（黙って結合無効にしない）",
  resolveMinSec("0", "45") === 45 && resolveMinSec("-5", "45") === 45,
  `実 ${resolveMinSec("0", "45")} / ${resolveMinSec("-5", "45")}`,
);
check(
  "CLI も env も不正なら既定180秒へ落ちる",
  resolveMinSec("abc", "-1") === 180,
  `実 ${resolveMinSec("abc", "-1")}`,
);

// ---------------------------------------------------------------- (2) 実際に効くか
// 実素材で起きたのと同じ形（AIが選んだ4区間・いずれも180秒未満・隙間は3秒以内）を作る。
// 期待値は実装から導かずリテラルで書く。
const SEGS = [
  { start: 0, end: 60, duration: 60, hook: "A", keepText: "a", confidence: 1 },
  { start: 61, end: 130, duration: 69, hook: "B", keepText: "b", confidence: 1 },
  { start: 131, end: 200, duration: 69, hook: "C", keepText: "c", confidence: 1 },
  { start: 201, end: 280, duration: 79, hook: "D", keepText: "d", confidence: 1 },
];

const merged180 = mergeShortSegments(SEGS, resolveMinSec(undefined, undefined), 3);
check(
  "既定180秒だと、4区間が2本以下へ結合されてしまう（実素材で起きた症状の再現）",
  merged180.length <= 2,
  `実 ${merged180.length} 本 / 各尺 ${merged180.map((s) => s.duration).join(",")}`,
);

const merged60 = mergeShortSegments(SEGS, resolveMinSec("60", undefined), 3);
check(
  "--min-sec 60 を指定すると、結合されず4区間がそのまま4本で残る",
  merged60.length === 4,
  `実 ${merged60.length} 本 / 各尺 ${merged60.map((s) => s.duration).join(",")}`,
);

check(
  "対照: 指定の有無で本数が実際に変わる（指定が素通りしていない）",
  merged180.length !== merged60.length,
  `既定 ${merged180.length} 本 / 指定 ${merged60.length} 本`,
);

// 1本あたりの尺も、指定した下限を満たしつつ短くなっていること。
check(
  "--min-sec 60 のとき、各本の尺が60秒以上かつ180秒未満に収まる",
  merged60.every((s) => s.duration >= 60 && s.duration < 180),
  `実 ${merged60.map((s) => s.duration).join(",")}`,
);

// ---------------------------------------------------------------- (3) 配線
// pipeline.mjs が --min-sec を実際に読んで cmdRender へ渡し、cmdRender がそれを
// resolveMinSec へ渡していること。ここが切れていると (1)(2) が全部緑でも
// 利用者からは何も変えられない（実素材で起きたのがまさにこの形）。
const src = fs.readFileSync(path.join(ROOT, "..", "pipeline.mjs"), "utf-8");
check(
  "pipeline.mjs が --min-sec をコマンドラインから読んでいる",
  /flagValue\(rest,\s*"--min-sec"/.test(src),
  "--min-sec の読み取りが見つからない",
);
check(
  "読んだ値が cmdRender の minSec として渡されている",
  /minSec:\s*flagValue\(rest,\s*"--min-sec"/.test(src),
  "cmdRender への受け渡しが見つからない",
);
check(
  "cmdRender が minSec を resolveMinSec へ渡している",
  /resolveMinSec\(minSec,\s*process\.env\.TOPIC_MIN_SEC\)/.test(src),
  "resolveMinSec への受け渡しが見つからない",
);
check(
  "使い方（usage）に --min-sec が案内されている",
  src.includes("--min-sec"),
  "usage に案内が無い",
);

// 対照: 上の3つの正規表現が「無いときに無いと言える」ことを示す。
// 配線を消した文字列に対して、同じ検査が実際に落ちることを確かめる。
const brokenSrc = src
  .replace(/minSec:\s*flagValue\(rest,\s*"--min-sec",\s*undefined\),?\n?/g, "")
  .replace(/resolveMinSec\(minSec,\s*process\.env\.TOPIC_MIN_SEC\)/g, "resolveMinSec(undefined, process.env.TOPIC_MIN_SEC)");
check(
  "対照: 配線を外した版では、上の配線検査が実際に落ちる",
  !/minSec:\s*flagValue\(rest,\s*"--min-sec"/.test(brokenSrc)
    && !/resolveMinSec\(minSec,\s*process\.env\.TOPIC_MIN_SEC\)/.test(brokenSrc),
  "壊した版でも検査が通ってしまう＝この検査は配線を守れていない",
);

// resolveMinSec 自体が素通りしていないことの対照（恒等関数に置き換えると落ちる形か）。
assert.strictEqual(typeof resolveMinSec, "function");
check(
  "対照: resolveMinSec が入力によらず同じ値を返す実装なら、優先順の検査が落ちる",
  resolveMinSec("30", "45") !== resolveMinSec(undefined, undefined),
  "CLI 指定時と既定時が同じ値になっている",
);

console.log(`\n--- ${passed} PASS / ${failed} FAIL ---`);
process.exit(failed === 0 ? 0 : 1);
