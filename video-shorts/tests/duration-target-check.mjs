// 尺の指示(--duration-min)の検証 — M4 (User Goal「尺を指示でき、それが出来上がりに出る」)
//
// 実素材(10分17秒=617.0秒のインタビュー)を「話題毎」で処理すると、無音境界スナップ後の
// 区間が [179.0秒, 429.9秒] の2本になっていた(実測: video-shorts/work/horiguchi-*/timing.json
// と candidates.json、docs/roadmap.html meta.handoff 2026-08-14)。指示口が無かったため
// 429.9秒(7分10秒)の本がそのまま出るしかなかった。
//
// この検査は、その実測された2本の区間を入力に、
//   (a) "3分くらいで"/"1分くらいで" の指示でそれぞれ2本以上に分かれる
//   (b) 3分指定の尺の中央値が1分指定の2倍以上
//   (c) 各本が指定値の±30%以内に収まる
//   (d) 指示しない(おまかせ)場合、1本が素材全体(617.0秒)の1/3を超えない
// を、実測値そのものを使って確認する。あわせて pipeline.mjs の配線(--duration-minが
// 実際にresolveTargetDuration/capSegmentDurationへ渡っていること)も確認する。
//
// 実行: node tests/duration-target-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTargetDuration, capSegmentDuration } from "../src/snap-boundaries.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── 実測データ(2026-08-14、実素材10分17秒を処理した実際の出力) ────────────
// 語は0.4秒間隔の連続発話として合成する(区切り位置探索に使う。実transcriptは非公開)。
const TOTAL_DURATION_SEC = 617.0;
const words = [];
for (let t = 0; t < TOTAL_DURATION_SEC; t += 0.4) words.push({ w: "x", start: t, end: t + 0.35 });

// mergeShortSegments/snapToSilence 適用後、実際にこの2本になっていた(実測)。
const REAL_MERGED_SEGMENTS = [
  { start: 0.0, end: 179.0, duration: 179.0, hook: "減量完了、緊張ゼロ", keepText: "", confidence: 1 },
  { start: 185.3, end: 615.2, duration: 429.9, hook: "見てほしいのは打撃", keepText: "", confidence: 1 },
];

// ── (1) resolveTargetDuration の解決順・境界 ──────────────────────────────
check("3分指定は floor=126秒・ceil=234秒(180の±30%)", (() => {
  const t = resolveTargetDuration("3");
  return t && Math.abs(t.floorSec - 126) < 0.01 && Math.abs(t.ceilSec - 234) < 0.01;
})());
check("1分指定は floor=42秒・ceil=78秒(60の±30%)", (() => {
  const t = resolveTargetDuration("1");
  return t && Math.abs(t.floorSec - 42) < 0.01 && Math.abs(t.ceilSec - 78) < 0.01;
})());
check("未指定・0以下・数値でない値は null(おまかせ)", (
  resolveTargetDuration(undefined) === null
  && resolveTargetDuration("0") === null
  && resolveTargetDuration("-1") === null
  && resolveTargetDuration("abc") === null
));
check(
  "対照: 3分指定と1分指定の範囲は重ならない(常に同じ長さを返す実装なら両方に収まってしまう)",
  resolveTargetDuration("3").floorSec > resolveTargetDuration("1").ceilSec,
);

// ── (2)(3) 実測区間に対する分割(a)(b)(c) ───────────────────────────────
const target3 = resolveTargetDuration("3");
const capped3 = capSegmentDuration(REAL_MERGED_SEGMENTS, target3.ceilSec, words);
const target1 = resolveTargetDuration("1");
const capped1 = capSegmentDuration(REAL_MERGED_SEGMENTS, target1.ceilSec, words);

check(
  "(a) 3分指定: 実測区間(179.0秒・429.9秒)を分割した結果、2本以上になる",
  capped3.length >= 2,
  `実 ${capped3.length}本: ${capped3.map((s) => s.duration.toFixed(1)).join(",")}`,
);
check(
  "(a) 1分指定: 同じ実測区間を分割した結果、2本以上になる",
  capped1.length >= 2,
  `実 ${capped1.length}本: ${capped1.map((s) => s.duration.toFixed(1)).join(",")}`,
);

const med3 = median(capped3.map((s) => s.duration));
const med1 = median(capped1.map((s) => s.duration));
check(
  "(b) 3分指定の尺の中央値が、1分指定の中央値の2倍以上",
  med3 >= med1 * 2,
  `中央値 3分指定=${med3.toFixed(1)}秒 / 1分指定=${med1.toFixed(1)}秒 (比 ${(med3 / med1).toFixed(2)})`,
);

check(
  "(c) 3分指定: 分割した各本が指定値180秒の±30%(126〜234秒)以内に収まる",
  capped3.every((s) => s.duration >= target3.floorSec - 0.5 && s.duration <= target3.ceilSec + 0.5),
  capped3.map((s) => s.duration.toFixed(1)).join(","),
);
check(
  "(c) 1分指定: 分割した各本が指定値60秒の±30%(42〜78秒)以内に収まる",
  capped1.every((s) => s.duration >= target1.floorSec - 0.5 && s.duration <= target1.ceilSec + 0.5),
  capped1.map((s) => s.duration.toFixed(1)).join(","),
);

// 対照: 常に同じ長さ(例: 90秒)を返す実装なら、3分指定(126〜234秒)にも
// 1分指定(42〜78秒)にも収まらない＝この検査で両方落ちる形になっている。
check(
  "対照: 常に90秒を返す実装なら、3分指定(126〜234秒)の範囲外なので落ちる",
  !(90 >= target3.floorSec && 90 <= target3.ceilSec),
);
check(
  "対照: 常に90秒を返す実装なら、1分指定(42〜78秒)の範囲外なので落ちる",
  !(90 >= target1.floorSec && 90 <= target1.ceilSec),
);

// ── (4) おまかせ(未指定)：1本が素材全体の1/3を超えない ───────────────────
const ceilAuto = TOTAL_DURATION_SEC / 3;
const cappedAuto = capSegmentDuration(REAL_MERGED_SEGMENTS, ceilAuto, words);
check(
  "(d) おまかせ: 実測区間(429.9秒)を含めても、分割後は1本も素材全体(617.0秒)の1/3を超えない",
  cappedAuto.every((s) => s.duration <= ceilAuto + 0.5),
  `上限=${ceilAuto.toFixed(1)}秒 / 実 ${cappedAuto.map((s) => s.duration.toFixed(1)).join(",")}`,
);
check(
  "対照: 上限を適用しない(実測どおりの429.9秒のまま)なら、この検査は落ちる",
  !(429.9 <= ceilAuto),
  `429.9秒 vs 上限${ceilAuto.toFixed(1)}秒`,
);

// ── (5) 分割しても語(区切り位置)が保たれる ──────────────────────────────
check(
  "分割後の区間は、元の区間の範囲[start,end]を過不足なく覆う(区間が消えない・重複しない)",
  (() => {
    for (const orig of REAL_MERGED_SEGMENTS) {
      const pieces = capped3.filter((s) => s.start >= orig.start - 0.01 && s.end <= orig.end + 0.01);
      if (pieces.length === 0) continue;
      const sorted = [...pieces].sort((a, b) => a.start - b.start);
      if (Math.abs(sorted[0].start - orig.start) > 0.01) return false;
      if (Math.abs(sorted[sorted.length - 1].end - orig.end) > 0.01) return false;
      for (let i = 1; i < sorted.length; i++) {
        if (Math.abs(sorted[i].start - sorted[i - 1].end) > 0.01) return false; // 隙間・重複が無い
      }
    }
    return true;
  })(),
);

// ── (6) pipeline.mjs の配線確認 ─────────────────────────────────────────
const src = fs.readFileSync(path.join(ROOT, "..", "pipeline.mjs"), "utf-8");
check(
  "pipeline.mjs が --duration-min をコマンドラインから読んでいる",
  /flagValue\(rest,\s*"--duration-min"/.test(src),
);
check(
  "読んだ値が cmdRender の durationMin として渡されている",
  /durationMin:\s*flagValue\(rest,\s*"--duration-min"/.test(src),
);
check(
  "cmdRender が durationMin を resolveTargetDuration へ渡している",
  /resolveTargetDuration\(durationMin\)/.test(src),
);
check(
  "cmdRender が capSegmentDuration を実際に呼んでいる(上限の適用)",
  /capSegmentDuration\(resolved,\s*ceilSec/.test(src),
);
check(
  "使い方(usage)に --duration-min が案内されている",
  src.includes("--duration-min"),
);

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
