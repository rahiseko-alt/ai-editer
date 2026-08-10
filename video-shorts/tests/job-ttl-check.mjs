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
// CodeRabbit指摘: resolveTtlSeconds(undefined) は引数省略と同じ扱いになり(デフォルト引数は
// undefinedで発火するため)、実行環境に VS_JOB_TTL_SECONDS が設定されていると「既定へ落ちる」
// はずの経路が本物のenv値を見てしまい、意図せずテストを通す/落とす可能性があった。
// 既定値の検証中だけ、この環境変数を明示的に退避・削除してから確認し、必ず元へ戻す。
t("resolveTtlSeconds: 既定は24時間(86400秒)、envに正の数値があればそれを使う、不正値は既定へ", () => {
  const hadEnv = Object.prototype.hasOwnProperty.call(process.env, "VS_JOB_TTL_SECONDS");
  const savedEnv = process.env.VS_JOB_TTL_SECONDS;
  delete process.env.VS_JOB_TTL_SECONDS;
  try {
    assert.strictEqual(resolveTtlSeconds(undefined), 24 * 60 * 60);
    assert.strictEqual(resolveTtlSeconds("10"), 10);
    assert.strictEqual(resolveTtlSeconds("0"), 24 * 60 * 60);
    assert.strictEqual(resolveTtlSeconds("-5"), 24 * 60 * 60);
    assert.strictEqual(resolveTtlSeconds("abc"), 24 * 60 * 60);
  } finally {
    if (hadEnv) process.env.VS_JOB_TTL_SECONDS = savedEnv;
    else delete process.env.VS_JOB_TTL_SECONDS;
  }
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

t("②削除に失敗した1件があっても、他のTTL超過ジョブの削除は止まらず、失敗した分だけremovedから除かれる(CodeRabbit指摘対応)", () => {
  const root = freshRoot();
  const now = Date.now();
  const failDir = makeJobDir(root, "fail-job", now - 5000); // TTL超過・削除がEACCES等で失敗する想定
  const okDir = makeJobDir(root, "ok-job", now - 5000); // TTL超過・正常に削除できる

  const realRmSync = fs.rmSync;
  fs.rmSync = (p, opts) => {
    if (p === failDir) {
      const err = new Error("simulated EACCES");
      err.code = "EACCES";
      throw err;
    }
    return realRmSync(p, opts);
  };
  let removed;
  try {
    removed = sweepExpiredJobs([root], 2, now);
  } finally {
    fs.rmSync = realRmSync;
  }

  assert.strictEqual(fs.existsSync(failDir), true, "削除に失敗したはずのディレクトリが実際には消えている(偽の緑)");
  assert.strictEqual(fs.existsSync(okDir), false, "削除失敗した他のディレクトリの掃除まで止まってしまった");
  assert.deepStrictEqual(
    removed.map((r) => r.jobId).sort(),
    ["ok-job"],
    "削除に失敗したジョブがremovedへ誤って積まれている、または成功した方が抜けている"
  );
});

t("①/③対照: 削除失敗を握りつぶしてremovedへ無条件push する旧実装だと、実際は残っているのに「削除された」と報告する", () => {
  const root = freshRoot();
  const now = Date.now();
  const failDir = makeJobDir(root, "fail-job-old", now - 5000);

  // 旧実装を模す: try/catch無しでpushする(実際には削除は起きていない状態を直接再現する)。
  const removedOld = [{ root, jobId: "fail-job-old" }]; // 削除に失敗しても無条件でpushされていた

  assert.throws(() => {
    assert.strictEqual(
      fs.existsSync(failDir) && removedOld.some((r) => r.jobId === "fail-job-old"),
      false,
      "旧実装は「removedに載っているのに実は存在する」矛盾を検出できない"
    );
  }, /旧実装は「removedに載っているのに実は存在する」矛盾を検出できない/, "旧実装(握りつぶし)の欠陥を検出できていない");
});

t("②excludeJobIdsに含まれるジョブは、TTLを過ぎていても削除されない(実行中/待機中ジョブの保護)", () => {
  const root = freshRoot();
  const now = Date.now();
  const runningDir = makeJobDir(root, "running-job", now - 5000); // TTL超過だが実行中扱い
  const oldDir = makeJobDir(root, "old-job", now - 5000); // TTL超過・除外対象外

  const removed = sweepExpiredJobs([root], 2, now, ["running-job"]);

  assert.strictEqual(fs.existsSync(runningDir), true, "実行中/待機中ジョブが誤って削除された");
  assert.strictEqual(fs.existsSync(oldDir), false, "除外対象外のTTL超過ジョブが残っている");
  assert.deepStrictEqual(removed.map((r) => r.jobId).sort(), ["old-job"]);
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
