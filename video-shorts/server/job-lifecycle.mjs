// server/job-lifecycle.mjs — ジョブの寿命管理（P2-4-A/B）
//
// work/ と output/ は使いっぱなしにすると際限なく溜まり、ディスクを食い潰す
// （客のPC上でローカル動作するツールのため、放っておくと客のディスクを圧迫する）。
//   A: 古いジョブ(TTL超過)を自動削除する
//   B: 保存容量に上限を設け、超過時は新規保存を拒否する
// のうち A/B をここに置く（C=同時実行数の上限は pipeline-runner.mjs の実行キューと一体なので
// そちらに置く）。既定値の決定(env読み)と判定ロジックは副作用の無い純粋関数として切り出し、
// 単体テストできるようにする。実ファイルへの副作用(削除・サイズ計測)を伴う関数は末尾にまとめる。

import fs from "node:fs";
import path from "node:path";

const DAY_SECONDS = 24 * 60 * 60;
const GIGABYTE = 1024 * 1024 * 1024;

/** TTL(秒)。既定24時間。VS_JOB_TTL_SECONDS で上書き（正の有限数のみ。それ以外は既定へ）。 */
export function resolveTtlSeconds(envValue = process.env.VS_JOB_TTL_SECONDS) {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : DAY_SECONDS;
}

/** 保存容量の上限(バイト)。既定10GB。VS_STORAGE_QUOTA_BYTES で上書き（正の有限数のみ）。 */
export function resolveQuotaBytes(envValue = process.env.VS_STORAGE_QUOTA_BYTES) {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : 10 * GIGABYTE;
}

/** dir配下のファイルサイズ合計(再帰・バイト)。存在しない/読めない場合は0として扱う。 */
function dirSizeBytes(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  let total = 0;
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) total += dirSizeBytes(p);
    else if (ent.isFile()) {
      try { total += fs.statSync(p).size; } catch (_) { /* 消えかけのファイルは無視 */ }
    }
  }
  return total;
}

/** roots(work/output等)配下の合計使用量(バイト)を返す。 */
export function computeUsedBytes(roots) {
  return roots.reduce((sum, r) => sum + dirSizeBytes(r), 0);
}

/**
 * 新規保存を受け付けてよいか。使用量がすでに上限に達している(以上)なら拒否する。
 * 書き始めてから溢れるのを待つと、途中まで書いた分が無駄になる（本文を受け取る前に
 * 判定する＝server/index.mjs 側で呼ぶ想定）。
 */
export function hasQuotaAvailable(usedBytes, quotaBytes) {
  return usedBytes < quotaBytes;
}

/** dir配下(自分自身含む)の最終更新時刻(mtimeMs)の最大値。中のファイルが新しく更新されて
 *  いればそちらを採用する（ジョブ実行中に中身が更新され続ける間はTTL計算の基準が
 *  「最後に触られてから」になる。ディレクトリ自体のmtimeだけを見ると、作成後に中の
 *  ファイルだけ更新されたケースを拾い損ねる）。 */
function dirMtimeMs(dir) {
  let latest = 0;
  try { latest = fs.statSync(dir).mtimeMs; } catch (_) { return 0; }
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return latest; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    let m = 0;
    if (ent.isDirectory()) m = dirMtimeMs(p);
    else { try { m = fs.statSync(p).mtimeMs; } catch (_) { m = 0; } }
    if (m > latest) latest = m;
  }
  return latest;
}

/**
 * roots配下の直下ディレクトリ(=各ジョブ)のうち、最終更新から ttlSeconds 秒を過ぎたものを
 * 削除する。
 * @param {string[]} roots 例: [WORK_ROOT, OUT_ROOT]
 * @param {number} ttlSeconds
 * @param {number} nowMs 現在時刻。テストで実時間を待たずに検証できるよう呼び出し側が渡す
 *   （Date.now() を既定値にすると、テストが実時間の経過を待つ必要が出てしまう）。
 * @returns {{root:string, jobId:string}[]} 削除したジョブ
 */
export function sweepExpiredJobs(roots, ttlSeconds, nowMs) {
  const removed = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (_) {
      continue; // root自体が無ければ掃除対象も無い
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const p = path.join(root, ent.name);
      const ageMs = nowMs - dirMtimeMs(p);
      if (ageMs > ttlSeconds * 1000) {
        fs.rmSync(p, { recursive: true, force: true });
        removed.push({ root, jobId: ent.name });
      }
    }
  }
  return removed;
}
