// server/job-params.mjs — POST /api/jobs のクエリパラメータ検証（副作用なし・単体テスト用に分離）。
// サポートする設定契約（P0-5）: UIが送りうる値のみを許可し、それ以外は既定値へフォールバックする。

import path from "node:path";
import crypto from "node:crypto";

const SUPPORTED_CUTS = new Set(["topic", "minutes"]);
const SUPPORTED_SIZES = new Set(["9:16", "16:9"]);

/** クエリパラメータ(URLSearchParams)を検証済みのジョブ設定へ正規化する */
export function parseJobParams(searchParams) {
  const sub = searchParams.get("sub") === "on" ? "on" : "none";
  const cutRaw = searchParams.get("cut") ?? "topic";
  const cut = SUPPORTED_CUTS.has(cutRaw) ? cutRaw : "topic";
  const sizeRaw = searchParams.get("size") ?? "9:16";
  const size = SUPPORTED_SIZES.has(sizeRaw) ? sizeRaw : "9:16";
  const cutMinRaw = Number(searchParams.get("cutMin"));
  const cutMin = Number.isFinite(cutMinRaw) && cutMinRaw >= 1 && cutMinRaw <= 60 ? cutMinRaw : 3;
  const name = searchParams.get("name") ?? "upload.mp4";
  return { sub, cut, size, cutMin, name };
}

/**
 * ファイル名から人間に読めるジョブIDを作る（読みやすさのための prefix。一意性の担保ではない）。
 * pipeline.mjs cmdInit と同じ命名規則。
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
 * P1-3/P1-4-A: 同名ファイルを同時にアップロードしても衝突せず(P1-3)、かつ他人のジョブIDを
 * 推測できない(P1-4-A)よう、ファイル名由来のprefixに128bitの暗号乱数suffixを付けて一意化する
 * （workDir/inputPathがジョブごとに必ず別になる）。
 */
export function makeUniqueJobId(filename) {
  const prefix = makeJobIdPrefix(filename) || "job";
  const suffix = crypto.randomBytes(JOB_ID_SUFFIX_BYTES).toString("hex");
  return `${prefix}-${suffix}`;
}
