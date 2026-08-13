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
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DAY_SECONDS = 24 * 60 * 60;
const GIGABYTE = 1024 * 1024 * 1024;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RM_WORKER_SCRIPT = path.join(HERE, "rm-job-dir-worker.mjs");

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

/** 既定の削除実装(このプロセス内で直接 fs.rmSync する・従来どおりの挙動)。 */
function defaultRemoveDir(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/**
 * AUD-P1-15: 削除処理を「このプロセスとは別のOSプロセス」で行う版。
 *
 * docs/audits/adversarial-review-2026-08-13.md #15: Node.js v24.13.0のWindows環境で、
 * OneDrive配下・日本語を含む実パス上の再帰的な fs.rmSync() が、終了コード
 * -1073740791 のネイティブクラッシュでプロセスごと落ちることが実地で確認された。
 * これはJSの try/catch では捕まえられない種類の異常終了で、呼び出し元でどれだけ
 * 丁寧にtry/catchしてもそのtry/catchごとプロセスが消し飛ぶため無力になる
 * (このファイル内の try/catch は「捕まえられる例外」にしか効かない)。
 *
 * 削除を子プロセス(rm-job-dir-worker.mjs)へ切り出すことで、そのプロセスが
 * ネイティブクラッシュしても死ぬのはワーカーだけになり、呼び出し元(サーバー本体)は
 * 子プロセスの異常終了(シグナル・非0終了コード)として観測できる普通のJSエラーに
 * 変換して受け取れる(=サーバー本体は継続稼働できる)。
 *
 * ⚠ このプロセス分離は「サーバー本体を巻き込まない」ことは保証するが、Windows実機・
 * 実OneDrive・実日本語パスでの実地検証はこのLinux開発環境では行えていない
 * (詳細は AGENTS.md 及び本leafの最終報告を参照)。
 */
export function removeDirViaChildProcess(p, { execPath = process.execPath, scriptPath = RM_WORKER_SCRIPT, timeoutMs = 30_000 } = {}) {
  const result = spawnSync(execPath, [scriptPath, p], {
    timeout: timeoutMs,
    windowsHide: true,
    encoding: "utf-8",
  });
  if (result.error) throw result.error; // spawn自体の失敗(ENOENT等)
  if (result.signal) {
    throw new Error(
      `削除ワーカーがシグナル ${result.signal} で終了しました(ネイティブクラッシュ等の可能性があります)。パス: ${p}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `削除ワーカーが異常終了しました(code=${result.status})。パス: ${p} stderr: ${(result.stderr || "").toString().slice(0, 300)}`
    );
  }
}

/**
 * roots配下の直下ディレクトリ(=各ジョブ)のうち、最終更新から ttlSeconds 秒を過ぎたものを
 * 削除する。
 * @param {string[]} roots 例: [WORK_ROOT, OUT_ROOT]
 * @param {number} ttlSeconds
 * @param {number} nowMs 現在時刻。テストで実時間を待たずに検証できるよう呼び出し側が渡す
 *   （Date.now() を既定値にすると、テストが実時間の経過を待つ必要が出てしまう）。
 * @param {Iterable<string>} [excludeJobIds] 掃除対象から除外するジョブID一覧
 *   （実行中/待機中のジョブ。pipeline-runner.mjs の startJob() はジョブをキューへ積んだ
 *   直後・最初の工程が state.json を書く前から jobs Map へ登録するため、ディレクトリの
 *   mtimeだけで判定すると「作成直後でまだ何も書き込まれていない実行中ジョブ」を
 *   「放置された古いジョブ」と誤認して消してしまう。呼び出し側が実行中/待機中の
 *   ジョブID一覧を渡し、ここでは無条件にスキップする）。
 * @param {(p: string) => void} [removeDir] 実際の削除を行う関数(差し替え可能・テスト/
 *   AUD-P1-15用)。既定はこのプロセス内で直接 fs.rmSync する従来どおりの実装。
 *   server/index.mjs は本番運用時に removeDirViaChildProcess を渡し、削除を子プロセスへ
 *   隔離する(ネイティブクラッシュがサーバー本体へ波及しないようにするため)。
 * @returns {{root:string, jobId:string}[]} 削除したジョブ
 */
export function sweepExpiredJobs(roots, ttlSeconds, nowMs, excludeJobIds = [], removeDir = defaultRemoveDir) {
  const exclude = excludeJobIds instanceof Set ? excludeJobIds : new Set(excludeJobIds);
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
      if (exclude.has(ent.name)) continue; // 実行中/待機中のジョブは掃除対象から外す
      const p = path.join(root, ent.name);
      const ageMs = nowMs - dirMtimeMs(p);
      if (ageMs > ttlSeconds * 1000) {
        // CodeRabbit指摘: fs.rmSync は EACCES/EPERM 等で例外を投げうるが、無条件で
        // removed へ push していたため「削除できたことになっているが実は残っている」
        // 状態を報告してしまっていた。1件の削除失敗が他のディレクトリの掃除を止めないよう
        // try/catchで個別に包み、実際に削除できたものだけを removed へ積む。
        // AUD-P1-15: removeDir が(隔離した子プロセス経由で)投げる「異常終了」も、
        // ここで同じ try/catch が受け止め、他のディレクトリの掃除を止めずに続行する。
        try {
          removeDir(p);
          removed.push({ root, jobId: ent.name });
        } catch (e) {
          process.stderr.write(
            `[job-lifecycle] TTL超過ジョブの削除に失敗しました(次回以降に再試行します): ${p} ${e?.message ?? e}\n`
          );
        }
      }
    }
  }
  return removed;
}
