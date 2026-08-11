// tests/ci-gate-hook-propagation-check.mjs — G-DELIVERY-CIGATE の機械検証。
//
// 【何を確かめるか】.github/workflows/ci.yml の gate(ci-green) ジョブが
// (a) needs に hook-session-start を含むこと（=このジョブの結果を待つ）
// (b) needs['hook-session-start'].result が success 以外なら、gateステップ自身が
//     exit 1 して落ちる（=session-startフックが壊れたらci-greenも赤くなる）
// を、.github/workflows/ci.yml から「今まさに書かれている」テキストを直接読み取って検証する。
// ハードコードした期待値と比較するのではなく、ci.ymlの実物からgate.needsの配列とgateステップの
// run:スクリプトを抽出し、そのスクリプトをNode側で(quality,smoke,hook-session-start)の
// 3つのneeds結果を差し替えながら実際にbashで実行し、終了コードを確認する。
// これにより、ci.ymlの該当ロジックが将来書き換わって壊れても、このテストが検知する。
//
// 【この仕組みが閉じないもの】GitHub Actionsランナー上での実際のジョブ依存関係解決
// （needsの値がジョブの実行結果から本当に埋め込まれるか）はGitHub側の機能であり、
// ローカル実行では検証できない。ここで検証するのは「gateステップに書かれた条件分岐の
// ロジックが、hook-session-startの失敗を正しくci-greenの失敗へ伝播させるか」。
//
// 実行: node tests/ci-gate-hook-propagation-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(path.dirname(HERE));
const CI_YML_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

const ymlText = fs.readFileSync(CI_YML_PATH, "utf8");

// ---- gate: ジョブブロックを切り出す（次の トップレベルキー か EOF まで） ----
const gateBlockMatch = ymlText.match(/\n {2}gate:\n([\s\S]*?)(?:\n {2}[a-zA-Z][\w-]*:\n|$)/);
assert.ok(gateBlockMatch, "ci.ymlに 'gate:' ジョブブロックが見つかりません");
const gateBlock = gateBlockMatch[1];

// ---- needs: [...] を抽出 ----
const needsMatch = gateBlock.match(/needs:\s*\[([^\]]*)\]/);
assert.ok(needsMatch, "gateジョブに needs: [...] が見つかりません");
const needsList = needsMatch[1].split(",").map((s) => s.trim());

report(
  "G-DELIVERY-CIGATE: gate.needsにhook-session-startが含まれる",
  needsList.includes("hook-session-start"),
  `needs=${JSON.stringify(needsList)}`,
);

// ---- gateステップの run: | スクリプト本文を抽出 ----
// "run: |" の次行から、それより浅いインデントの行(次のキー)が現れるまでを本文とみなす。
const runMatch = gateBlock.match(/run:\s*\|\n([\s\S]*)$/);
assert.ok(runMatch, "gateステップの run: | スクリプトが見つかりません");
const rawRunBody = runMatch[1];
// インデントを揃える（先頭行のインデント幅を基準に全行から差し引く）
const lines = rawRunBody.split("\n");
const indentOf = (l) => (l.match(/^ */)?.[0].length ?? 0);
const nonEmpty = lines.filter((l) => l.trim() !== "");
const baseIndent = nonEmpty.length > 0 ? Math.min(...nonEmpty.map(indentOf)) : 0;
const scriptLines = [];
for (const l of lines) {
  if (l.trim() === "" && scriptLines.length === lines.filter((x) => x.trim() !== "").length) break;
  scriptLines.push(l.slice(baseIndent));
}
const rawScript = scriptLines.join("\n").trimEnd();

assert.ok(
  rawScript.includes("needs.quality.result") &&
    rawScript.includes("needs.smoke.result") &&
    rawScript.includes("needs['hook-session-start'].result"),
  "gateステップのスクリプトに期待する3ジョブのneeds参照が見つかりません(ci.ymlが変わった可能性)",
);

/**
 * ci.ymlのrun:スクリプト本文中の ${{ needs.X.result }} / ${{ needs['X'].result }} を、
 * GitHub Actionsが実際に行う文字列置換と同じ形で、渡された結果値へ置き換える。
 * @param {{quality: string, smoke: string, hookSessionStart: string}} results
 * @returns {string}
 */
function renderScript(results) {
  return rawScript
    .replaceAll("${{ needs.quality.result }}", results.quality)
    .replaceAll("${{ needs.smoke.result }}", results.smoke)
    .replaceAll("${{ needs['hook-session-start'].result }}", results.hookSessionStart);
}

/**
 * 置換後のbashスクリプトを実行し、終了コードを返す。
 * @param {string} script
 * @returns {number}
 */
function runBash(script) {
  try {
    execFileSync("bash", ["-c", script], { stdio: "pipe" });
    return 0;
  } catch (e) {
    return typeof e.status === "number" ? e.status : 1;
  }
}

const cases = [
  { name: "全ジョブsuccess", results: { quality: "success", smoke: "success", hookSessionStart: "success" }, expectExit: 0 },
  { name: "hook-session-startのみ失敗", results: { quality: "success", smoke: "success", hookSessionStart: "failure" }, expectExit: 1 },
  { name: "hook-session-startのみスキップ", results: { quality: "success", smoke: "success", hookSessionStart: "skipped" }, expectExit: 1 },
  { name: "qualityが失敗", results: { quality: "failure", smoke: "success", hookSessionStart: "success" }, expectExit: 1 },
  { name: "smokeが失敗", results: { quality: "success", smoke: "failure", hookSessionStart: "success" }, expectExit: 1 },
];

for (const c of cases) {
  const script = renderScript(c.results);
  const exitCode = runBash(script);
  report(
    `G-DELIVERY-CIGATE: gateステップのロジック(${c.name})はexit ${c.expectExit}になる`,
    exitCode === c.expectExit,
    `got exit ${exitCode}, results=${JSON.stringify(c.results)}`,
  );
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exitCode = fail > 0 ? 1 : 0;
