// 古いジョブの自動削除(TTL)の検証 — P2-4-A
//
// server/job-lifecycle.mjs の sweepExpiredJobs() が、work/output配下のジョブ用ディレクトリ
// のうち最終更新からTTL(既定24時間・VS_JOB_TTL_SECONDSで上書き可)を過ぎたものを削除する。
//
// ①偽物が壊れる/③壊したものを当てて落ちることの確認: 「何もしない」実装(削除しない)を
// 同じ状況に当てると、TTL超過後もジョブが残ったままになることを対照として示す。
// ②正しい実装の値を測る: TTLを短く設定した状態で疑似ジョブを作り(mtimeを直接ずらして
// 実時間の経過を待たずに再現)、TTL経過後に実際にディレクトリが削除されること・
// TTL内のものは残ることを実測する。
//
// 実行: node tests/job-ttl-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTtlSeconds, sweepExpiredJobs } from "../server/job-lifecycle.mjs";

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

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vs-ttl-"));
}
function makeJobDir(root, jobId, mtimeMs) {
  const dir = path.join(root, jobId);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "state.json"), "{}", "utf-8");
  fs.utimesSync(dir, mtimeMs / 1000, mtimeMs / 1000);
  // ディレクトリ自身のmtimeは中身のファイル作成で更新されるOS/FSがあるため、
  // ファイル側のmtimeも明示的に揃える(dirMtimeMsは中身の最大値を見るため)。
  fs.utimesSync(path.join(dir, "state.json"), mtimeMs / 1000, mtimeMs / 1000);
  return dir;
}

// ── resolveTtlSeconds: env解決の純粋関数 ────────────────────────
t("resolveTtlSeconds: 既定は24時間(86400秒)、envに正の数値があればそれを使う、不正値は既定へ", () => {
  assert.strictEqual(resolveTtlSeconds(undefined), 24 * 60 * 60);
  assert.strictEqual(resolveTtlSeconds("10"), 10);
  assert.strictEqual(resolveTtlSeconds("0"), 24 * 60 * 60);
  assert.strictEqual(resolveTtlSeconds("-5"), 24 * 60 * 60);
  assert.strictEqual(resolveTtlSeconds("abc"), 24 * 60 * 60);
});

// ── ②: 短いTTLでの実測 ──────────────────────────────────────
t("②TTL(2秒)を過ぎたジョブは削除され、TTL内のジョブは残る", () => {
  const root = freshRoot();
  const now = Date.now();
  const oldDir = makeJobDir(root, "old-job", now - 5000);   // 5秒前 → TTL2秒を超過
  const freshDir = makeJobDir(root, "fresh-job", now - 500); // 0.5秒前 → TTL内

  const removed = sweepExpiredJobs([root], 2, now);

  assert.strictEqual(fs.existsSync(oldDir), false, "TTLを過ぎたジョブが残っている");
  assert.strictEqual(fs.existsSync(freshDir), true, "TTL内のジョブまで消えている");
  assert.deepStrictEqual(removed.map((r) => r.jobId).sort(), ["old-job"]);
});

t("②work/outputの2rootsをまたいで掃除できる", () => {
  const workRoot = freshRoot();
  const outRoot = freshRoot();
  const now = Date.now();
  const oldWork = makeJobDir(workRoot, "job-a", now - 5000);
  const oldOut = makeJobDir(outRoot, "job-a", now - 5000);

  const removed = sweepExpiredJobs([workRoot, outRoot], 2, now);

  assert.strictEqual(fs.existsSync(oldWork), false);
  assert.strictEqual(fs.existsSync(oldOut), false);
  assert.strictEqual(removed.length, 2);
});

t("②境界: TTLちょうどでは削除しない(超過のときだけ削除)", () => {
  const root = freshRoot();
  const now = 1_000_000_000; // 固定の基準時刻でテストする
  const dir = makeJobDir(root, "boundary-job", now - 2000); // ちょうど2秒前
  const removed = sweepExpiredJobs([root], 2, now); // TTL=2秒 → ageMs(2000) > 2000 は false
  assert.strictEqual(fs.existsSync(dir), true, "TTLちょうどなのに削除されてしまった");
  assert.deepStrictEqual(removed, []);
});

// ── ①/③: 「何もしない」実装だとTTL超過分が残ったままになる ─────────
t("①対照: 何もしない実装(削除しない)だと、TTL超過後もジョブが残ったままになる", () => {
  const root = freshRoot();
  const now = Date.now();
  const oldDir = makeJobDir(root, "old-job", now - 5000);
  const doNothingRemoved = []; // 何も削除しない偽実装の戻り値を模す
  assert.strictEqual(fs.existsSync(oldDir), true, "対照のはずなのに消えている");
  assert.deepStrictEqual(doNothingRemoved, []);
});

t("③この検査には検出能力がある: 「何もしない」結果を「削除された」判定に通すと実際に落ちる", () => {
  const root = freshRoot();
  const now = Date.now();
  const oldDir = makeJobDir(root, "old-job", now - 5000);
  // sweepExpiredJobs を呼ばない(=何もしない)まま、②と同じ「消えているはず」判定にかける
  assert.throws(() => {
    assert.strictEqual(fs.existsSync(oldDir), false, "TTLを過ぎたジョブが残っている");
  }, /TTLを過ぎたジョブが残っている/, "何もしていないのに「削除された」判定を通ってしまった(検出できていない)");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
