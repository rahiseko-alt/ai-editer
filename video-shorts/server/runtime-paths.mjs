// server/runtime-paths.mjs — `.runtime/`（リポジトリ直下、video-shorts の外）の場所とジョブID検証を一箇所に集約する。
//
// なぜ video-shorts の外か: UI とメインの Claude セッション（本サーバーの外で動く別プロセス）の
// 橋渡し用フォルダを、特定のUI実装・特定のプロダクトに紐付けないため（発注時の決定事項）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url)); // video-shorts/server
const VIDEO_SHORTS_DIR = path.resolve(SERVER_DIR, ".."); // video-shorts
const REPO_ROOT = path.resolve(VIDEO_SHORTS_DIR, ".."); // リポジトリ直下（AI-editer）
const RUNTIME_ROOT = path.join(REPO_ROOT, ".runtime");

// ジョブIDは自サーバーが crypto.randomUUID() で発行した値のみを受け付ける（UUID v4想定の一般形）。
// これに一致しない値はパス組み立てへ一切渡さない。
export const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidJobId(id) {
  return typeof id === "string" && JOB_ID_RE.test(id);
}

export function runtimeRoot() {
  return RUNTIME_ROOT;
}

export function chatInboxPath() {
  return path.join(RUNTIME_ROOT, "chat-inbox.jsonl");
}

export function resultsPath() {
  return path.join(RUNTIME_ROOT, "results.jsonl");
}

export function uploadsRootDir() {
  return path.join(RUNTIME_ROOT, "uploads");
}

export function outputsRootDir() {
  return path.join(RUNTIME_ROOT, "outputs");
}

export function workRootDir() {
  return path.join(RUNTIME_ROOT, "work");
}

/**
 * work/<jobId>/ の絶対パスを返す（edit-job.mjs が文字起こし等の中間ファイルを置く場所と同じ規約）。
 * jobId は自サーバー発行のUUID形式であることを検証する。
 */
export function workJobDir(jobId) {
  if (!isValidJobId(jobId)) {
    throw new Error(`不正な jobId です: ${JSON.stringify(jobId)}`);
  }
  return path.join(workRootDir(), jobId);
}

/**
 * uploads/<jobId>/ の絶対パスを返す。jobId は自サーバー発行のUUID形式であることを検証する
 * （呼び出し側で確認済みでも、パス組み立ての直前に必ずここでも検証する）。
 */
export function uploadsJobDir(jobId) {
  if (!isValidJobId(jobId)) {
    throw new Error(`不正な jobId です: ${JSON.stringify(jobId)}`);
  }
  return path.join(uploadsRootDir(), jobId);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * ディレクトリを再帰削除する（fs.rmSync の recursive オプションは使わない）。
 * このマシンの Node は v24 系で、Node 24 の Windows 環境では OneDrive 配下・日本語パス上の
 * fs.rmSync() 再帰削除がネイティブクラッシュを起こす既知の問題が本リポジトリで実地確認済み
 * （AGENTS.md 記載、video-shorts の engines 上限が Node<24 なのも同じ理由）。
 * このサーバーは engines 制約の外（開発機の生 Node）で動くため、念のため手動再帰で回避する。
 */
export function removeDirRecursive(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return; // 存在しない/読めない場合は何もしない（ベストエフォートの掃除のため）
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeDirRecursive(p);
    } else {
      try {
        fs.unlinkSync(p);
      } catch (_err) {
        // ベストエフォート
      }
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch (_err) {
    // ベストエフォート
  }
}

/**
 * jsonl ファイルへ1行追記する。JSON.stringify() を通すため、instruction 中に生の改行や
 * 引用符が含まれていても \n / \" にエスケープされ、1行の形式が壊れない。
 */
export function appendJsonLine(filePath, obj) {
  ensureDir(path.dirname(filePath));
  const line = `${JSON.stringify(obj)}\n`;
  fs.appendFileSync(filePath, line, "utf-8");
}
