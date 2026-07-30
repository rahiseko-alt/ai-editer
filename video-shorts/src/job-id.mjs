// src/job-id.mjs — ジョブID生成（副作用なし・CLI/サーバー共通）。
// CLI(pipeline.mjs)は配布物に含まれるが server/ は含まれないため、両方から使う ID 生成は
// 配布対象の src/ 側に置く（配布物の CLI が server/ に依存しないようにする）。

import path from "node:path";
import crypto from "node:crypto";

/**
 * ファイル名から人間に読めるジョブIDを作る（読みやすさのための prefix。一意性の担保ではない）。
 */
export function makeJobIdPrefix(filename) {
  return path
    .basename(filename)
    .replace(/\.[^.]+$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-");
}

// P1-4-A: suffixは128bit(16byte)の暗号乱数。ジョブIDは成果物の取得キーにもなるため、
// 総当たりが非現実的な強度(業界一般的なセキュアトークンと同水準)を持たせる。
const JOB_ID_SUFFIX_BYTES = 16;

/**
 * P1-3/P1-4-A/P1-8: 同名ファイルを別々に処理しても衝突せず(P1-3=サーバー / P1-8=CLI)、かつ
 * 他人のジョブIDを推測できない(P1-4-A)よう、ファイル名由来のprefixに128bitの暗号乱数suffixを
 * 付けて一意化する（workDir/outputDir/inputPathがジョブごとに必ず別になる）。
 */
export function makeUniqueJobId(filename) {
  const prefix = makeJobIdPrefix(filename) || "job";
  const suffix = crypto.randomBytes(JOB_ID_SUFFIX_BYTES).toString("hex");
  return `${prefix}-${suffix}`;
}
