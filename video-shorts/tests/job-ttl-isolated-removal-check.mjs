// TTL掃除の削除処理をプロセス隔離すること — AUD-P1-15(ベストエフォート対応)
//
// docs/audits/adversarial-review-2026-08-13.md #15: Node.js v24.13.0のWindows環境で、
// OneDrive配下・日本語を含む実パス上で fs.rmSync() を再帰実行すると、終了コード
// -1073740791 のネイティブクラッシュでプロセスごと落ちることが実地監査で確認された。
// これはJSの try/catch では捕まえられない種類の異常終了。
//
// ⚠ このテストが検証できるのは「削除を子プロセスへ隔離する仕組みが機能すること」
// 「(隔離した/しなかった)削除処理が投げる"捕捉可能な"例外に対して掃除処理が
// サーバー本体を道連れにせず継続すること」までである。実際のネイティブクラッシュ
// (JSのtry/catchで検出不可能な種類の異常終了)は、Windows実機+実OneDrive+実日本語パス
// でしか再現できず、このLinux環境では再現も検証もできない。この限界は最終報告に
// 明記し、「本物のネイティブクラッシュに対する耐性」は検証済みと主張しない。
//
// 実行: node tests/job-ttl-isolated-removal-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sweepExpiredJobs, removeDirViaChildProcess } from "../server/job-lifecycle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n      ${e.stack || e.message}`);
  }
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vs-isolated-rm-"));
}

// ── ①removeDirViaChildProcess単体: 正常系(実際に子プロセス経由で削除できる) ──
t("①removeDirViaChildProcessは実際に子プロセスを起動してディレクトリを削除する", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "file.txt"), "x", "utf-8");
  assert.strictEqual(fs.existsSync(dir), true, "前提: 削除対象がまだ存在する");
  removeDirViaChildProcess(dir);
  assert.strictEqual(fs.existsSync(dir), false, "子プロセス経由の削除後もディレクトリが残っている");
});

t("①removeDirViaChildProcessは存在しないパスでも(force相当で)例外を投げない", () => {
  const dir = path.join(os.tmpdir(), "vs-isolated-rm-does-not-exist-" + Date.now());
  assert.doesNotThrow(() => removeDirViaChildProcess(dir));
});

// ── ②removeDirViaChildProcess: 子プロセスが「捕捉可能な形で」異常終了した場合 ──
// 実際のネイティブクラッシュ(セグフォルト等)はこのLinux環境では意図的に再現できない
// (再現できても環境依存で不安定)。ここでは「子プロセスがシグナルで死んだ/非0で終了した」
// という、呼び出し元(親プロセス)から見て観測できる形の異常終了を模する。
// これは「プロセス境界の外側で何が起きても、親からは"普通のJSエラーとして"観測できる」
// という、このアーキテクチャの核心の主張を検証する。
{
  const crashingWorker = path.join(HERE, "helpers", "fake-crashing-rm-worker.mjs");

  t("②子プロセスがシグナルで異常終了した場合、removeDirViaChildProcessは(プロセスを巻き込まず)例外を投げる", () => {
    const dir = freshDir();
    assert.throws(
      () => removeDirViaChildProcess(dir, { scriptPath: crashingWorker }),
      /シグナル|signal/i,
      "シグナル終了が検出できていない"
    );
    // 呼び出し元(このテストプロセス自体)は例外を投げられただけで、生きたまま次のassertへ進めている
    // ことそのものが「サーバー本体を巻き込まない」ことの実演になっている。
  });

  t("③この検査には検出能力がある: 子プロセスが正常終了(0)した場合は例外を投げない(誤検知しない)", () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, "file.txt"), "x", "utf-8");
    // 通常のワーカー(正常系)を使えば、同じ検査コードが「異常終了ではない」と正しく判定できることを示す。
    assert.doesNotThrow(() => removeDirViaChildProcess(dir));
  });
}

// ── ④sweepExpiredJobs: removeDirが(隔離された子プロセス由来の)例外を投げても、
//    他のTTL超過ディレクトリの掃除を止めず、呼び出し元(サーバー本体)へも例外が
//    伝播しない(=「サーバー全体を落とさない」という受入事実そのもの) ──
t("④removeDirが例外を投げても sweepExpiredJobs 自体は例外を外へ投げず、他のディレクトリの掃除は続行する", () => {
  const root = freshDir();
  const crashDir = path.join(root, "crash-job");
  const okDir = path.join(root, "ok-job");
  fs.mkdirSync(crashDir);
  fs.mkdirSync(okDir);
  const old = (Date.now() - 5000) / 1000;
  for (const d of [crashDir, okDir]) fs.utimesSync(d, old, old);

  let removed;
  assert.doesNotThrow(() => {
    removed = sweepExpiredJobs([root], 2, Date.now(), [], (p) => {
      if (p === crashDir) {
        // AUD-P1-15を模す: 「捕捉可能な形の異常終了」をJSエラーとして投げる
        // (removeDirViaChildProcessが実際にネイティブクラッシュを検出した場合と同じ形)。
        throw new Error("削除ワーカーがシグナル SIGSEGV で終了しました(ネイティブクラッシュ等の可能性があります)");
      }
      fs.rmSync(p, { recursive: true, force: true });
    });
  }, "removeDirの例外がsweepExpiredJobsの外まで伝播してしまった(サーバー本体を落とす経路)");

  assert.strictEqual(fs.existsSync(crashDir), true, "削除に失敗したはずのディレクトリが実際には消えている");
  assert.strictEqual(fs.existsSync(okDir), false, "削除に失敗した1件のせいで、他の正常な削除まで止まっている");
  assert.deepStrictEqual(removed.map((r) => r.jobId), ["ok-job"], "removedの中身が期待と違う");
});

// ── ⑤既定(removeDir省略)では従来どおり fs.rmSync が直接使われる(回帰なし) ──
t("⑤removeDirを省略した場合は従来どおりの直接fs.rmSyncで削除できる(既定動作の回帰なし)", () => {
  const root = freshDir();
  const dir = path.join(root, "legacy-path-job");
  fs.mkdirSync(dir);
  const old = (Date.now() - 5000) / 1000;
  fs.utimesSync(dir, old, old);
  const removed = sweepExpiredJobs([root], 2, Date.now());
  assert.strictEqual(fs.existsSync(dir), false, "既定の削除実装で削除されていない");
  assert.deepStrictEqual(removed.map((r) => r.jobId), ["legacy-path-job"]);
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
