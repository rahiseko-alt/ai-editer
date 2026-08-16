#!/usr/bin/env node
// done-gate：「最初に決めた合格基準に、機械判定で実際に合格するまでは done にできない」を
// 機械で強制するCIゲート。
//
// 背景（2026-08-10）：CIが緑・criteria/verify本文が凍結されていても、それは「実装者が自分で
// 書いたテストに、自分の実装が通った」という自己申告の domain を出ない（本人採点）。
// verify-criteria-freeze.mjs は criteria の"文章"（text/verify/verifyCmd）が無断で書き換え
// られていないことは保証するが、「その文章どおりの厳密さでverifyCmdが実際に書かれ、かつ
// 今この瞬間に本当に合格しているか」までは見ていなかった。
//
// この仕組みが閉じるもの：ある葉が「今回のPRで新規に doing/todo → done へ遷移する」とき、
// その葉の全criteriaに verifyCmd（凍結対象。verify-criteria-freeze.mjs が本文として保護する）
// が設定されていることを必須化し、CI がその verifyCmd を実際に実行して exit code 0 になる
// ことを要求する。「テストを書いた」という自己申告ではなく、「このPRのコミットで今まさに
// 実行して合格した」という事実そのものを done の条件にする。
//
// この仕組みが閉じないもの（正直な限界）：verifyCmd の中身が criteria.text の要求を本当に
// 厳密に検証しているか（例えば境界値を突いているか、対照実験があるか）は、コマンドの
// exit code だけからは判定できない。ここは引き続き人間（basis-reviewer / independent-verifier）
// の役目であり、この仕組みは「その手前の、明らかな自己採点（テストを書かず／書いたが
// 実行していない／実行したら実は落ちる）」を機械で閉じるためのもの。
//
// 実行方法：BASE_REF / HEAD_REF を環境変数で渡す（verify-criteria-freeze.mjs と同じ規約）。
// BASE_REF 未指定ならスキップ（ローカル作業ツリーでの単発実行や、比較対象が無い状況を許容）。

import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { extractRoadmapJson, flattenById, isMissingPathError } from "./verify-criteria-freeze.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const ROADMAP_REL_PATH = "docs/roadmap.html";
const roadmapAbsPath = resolve(REPO_ROOT, ROADMAP_REL_PATH);

/**
 * @typedef {{ id: string, index: number, reason: "missing-verifycmd" }
 *   | { id: string, index: number, reason: "verify-failed", cmd: string, code: number, output: string }} DoneGateViolation
 */

// ---- 純粋関数（テスト対象。git/fs/子プロセスに依存しない） -----------------------------

/**
 * 葉ノード（子を持たない state ノード）かつ status:"done" かどうか。
 * @param {any} node
 * @returns {boolean}
 */
export function isDoneLeaf(node) {
  if (!node || typeof node !== "object") return false;
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  return !hasChildren && node.kind === "state" && node.status === "done";
}

/**
 * BASE/HEAD の roadmap JSON を比較し、「今回のPRで新規に done へ遷移した葉」を返す。
 * BASEに存在しない（新規追加された葉が一発でdoneになった場合を含む）か、
 * BASEでは done でなかった葉が対象。BASEで既に done だった葉（過去に受理済み）は
 * 今回のPRでは対象外にする＝過去に受理済みの葉へ遡って verifyCmd 必須化を強制しない
 * （既存ツリーを壊さないための移行措置。新規に done 化する葉から適用が始まる）。
 * @param {any} baseRoadmap
 * @param {any} headRoadmap
 * @returns {Array<{ id: string, node: any }>}
 */
export function findNewlyDoneLeaves(baseRoadmap, headRoadmap) {
  const baseMap = flattenById(baseRoadmap?.nodes || []);
  const headMap = flattenById(headRoadmap?.nodes || []);
  const result = [];
  for (const [id, headNode] of headMap) {
    if (!isDoneLeaf(headNode)) continue;
    const baseNode = baseMap.get(id);
    const wasDoneInBase = baseNode ? isDoneLeaf(baseNode) : false;
    if (!wasDoneInBase) result.push({ id, node: headNode });
  }
  return result;
}

/**
 * 新規にdoneへ遷移した葉のうち、criteriaにverifyCmdが無いものを違反として返す。
 * @param {Array<{ id: string, node: any }>} newlyDone
 * @returns {DoneGateViolation[]}
 */
export function findMissingVerifyCmdViolations(newlyDone) {
  /** @type {DoneGateViolation[]} */
  const violations = [];
  for (const { id, node } of newlyDone) {
    (node.criteria || []).forEach((/** @type {any} */ c, /** @type {number} */ index) => {
      const cmd = c?.verifyCmd;
      if (typeof cmd !== "string" || cmd.trim() === "") {
        violations.push({ id, index, reason: "missing-verifycmd" });
      }
    });
  }
  return violations;
}

/**
 * newlyDone の各criteriaのverifyCmdを実行し、失敗したものを違反として返す。
 * runCmd: (cmd: string) => { code: number, output: string } を注入する
 * （実行部分をI/Oから分離し、テストでは実際にプロセスを起動せずロジックだけ検証できるようにする）。
 * @param {Array<{ id: string, node: any }>} newlyDone
 * @param {(cmd: string) => { code: number, output: string }} runCmd
 * @returns {DoneGateViolation[]}
 */
export function runVerifyCommands(newlyDone, runCmd) {
  /** @type {DoneGateViolation[]} */
  const violations = [];
  for (const { id, node } of newlyDone) {
    (node.criteria || []).forEach((/** @type {any} */ c, /** @type {number} */ index) => {
      const cmd = typeof c?.verifyCmd === "string" ? c.verifyCmd.trim() : "";
      if (!cmd) return; // missing-verifycmd 側で既に報告済みなので二重報告しない
      const { code, output } = runCmd(cmd);
      if (code !== 0) {
        violations.push({ id, index, reason: "verify-failed", cmd, code, output });
      }
    });
  }
  return violations;
}

/**
 * 違反1件を人間可読な日本語メッセージへ整形する。
 * @param {DoneGateViolation} v
 * @returns {string}
 */
export function formatDoneGateViolation(v) {
  if (v.reason === "missing-verifycmd") {
    return (
      `${v.id}: 今回のPRで新規に done へ遷移していますが、criteria[${v.index}] に verifyCmd が` +
      `設定されていません。done化には、CIが実際に実行して合否を判定できるコマンド` +
      `（例: "node video-shorts/tests/foo.mjs"）を verifyCmd に書くことが必須です。`
    );
  }
  const tail = (v.output || "").split("\n").slice(-20).join("\n");
  return (
    `${v.id}: criteria[${v.index}] の verifyCmd が実際には失敗しています（exit ${v.code}）。\n` +
    `    コマンド: ${v.cmd}\n` +
    `    出力の末尾:\n${tail
      .split("\n")
      .map((l) => "      " + l)
      .join("\n")}`
  );
}

// ---- git/fs/子プロセス依存の入出力（CLI実行時のみ使う） --------------------------------

/**
 * @param {string} [ref]
 * @returns {string}
 */
function readRoadmapAt(ref) {
  if (!ref) return readFileSync(roadmapAbsPath, "utf8");
  // maxBuffer: 既定の 1MiB を docs/roadmap.html が超えたため明示する
  // （verify-criteria-freeze.mjs と同じ理由。2026-08-16）。
  return execFileSync("git", ["show", `${ref}:${ROADMAP_REL_PATH}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * @param {string} cmd
 * @returns {{ code: number, output: string }}
 */
function realRunCmd(cmd) {
  try {
    const output = execSync(cmd, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
      timeout: 20 * 60 * 1000, // 20分。実機ffmpeg/opencvを使う検証も想定して長めに取る。
    });
    return { code: 0, output };
  } catch (e) {
    const err = /** @type {any} */ (e);
    const output = `${err?.stdout || ""}\n${err?.stderr || ""}`.trim();
    return { code: typeof err?.status === "number" ? err.status : 1, output };
  }
}

function main() {
  const BASE_REF = process.env.BASE_REF || "";
  const HEAD_REF = process.env.HEAD_REF || "";

  if (!BASE_REF) {
    console.log("BASE_REF未指定のためスキップ");
    return;
  }

  let baseHtml;
  try {
    baseHtml = readRoadmapAt(BASE_REF);
  } catch (e) {
    if (!isMissingPathError(e)) throw e;
    console.log(`BASE(${BASE_REF})に ${ROADMAP_REL_PATH} が存在しないためスキップ（新規リポジトリ等）`);
    return;
  }
  const headHtml = readRoadmapAt(HEAD_REF || undefined);

  const baseData = extractRoadmapJson(baseHtml);
  const headData = extractRoadmapJson(headHtml);

  const newlyDone = findNewlyDoneLeaves(baseData, headData);
  if (newlyDone.length === 0) {
    console.log("✓ done-gate: 今回のPRで新規に done へ遷移した葉なし（対象外）");
    return;
  }

  console.log(`done-gate: 今回のPRで新規に done へ遷移した葉 ${newlyDone.length} 件を検査します: ${newlyDone.map((x) => x.id).join(", ")}`);

  const missing = findMissingVerifyCmdViolations(newlyDone);
  if (missing.length > 0) {
    console.error("✗ done-gate: verifyCmd 未設定を検出");
    for (const v of missing) console.error("  - " + formatDoneGateViolation(v));
    process.exit(1);
  }

  const failed = runVerifyCommands(newlyDone, realRunCmd);
  if (failed.length > 0) {
    console.error("✗ done-gate: verifyCmd の実行に失敗した項目を検出（done の条件を満たしていません）");
    for (const v of failed) console.error("  - " + formatDoneGateViolation(v));
    process.exit(1);
  }

  console.log(`✓ done-gate: OK（新規に done 化した${newlyDone.length}件すべて、verifyCmdを実行して合格を確認）`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
