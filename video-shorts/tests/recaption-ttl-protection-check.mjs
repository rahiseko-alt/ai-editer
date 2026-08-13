// 焼き直し(recaption)実行中/実行待ちのジョブがTTL掃除で消えないことの検証 — AUD-P1-03a/03b
//
// server/job-lifecycle.mjs の sweepExpiredJobs() は、pipeline-runner.mjs の activeJobIds() が
// 返す一覧を「実行中/待機中なので掃除しない」除外リストとして受け取る。旧実装の activeJobIds()
// は本編ジョブ(jobs Map・RUNNING_STAGES)しか見ておらず、焼き直し専用の管理(recaptioningJobs Set)
// を無視していた。そのため、TTLを過ぎたジョブが「焼き直し実行中」または「焼き直し待ち
// (concurrencyGateで順番待ち)」の間に定期掃除が走ると、work/output配下のディレクトリごと
// 削除されてしまい、実行中/待機中の焼き直しが入出力ファイルを失って壊れる。
//
// AUD-P1-03a: 焼き直し「実行中」でも掃除で消えない。
// AUD-P1-03b: 焼き直し「実行待ち(共有ゲートが埋まっていて順番待ち)」でも掃除で消えない。
//
// 実行: node tests/recaption-ttl-protection-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// concurrencyGateのサイズをこのテストで制御するため、import前に固定する
// (pipeline-runner.mjsはモジュール読み込み時に一度だけ resolveMaxConcurrentJobs() を評価する)。
process.env.VS_MAX_CONCURRENT_JOBS = "1";

const { activeJobIds, beginRecaption, endRecaption, runGated } = await import("../server/pipeline-runner.mjs");
const { sweepExpiredJobs } = await import("../server/job-lifecycle.mjs");

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vs-recaption-ttl-"));
}
function makeOldJobDir(root, jobId, ageMs) {
  const dir = path.join(root, jobId);
  fs.mkdirSync(dir);
  const t = (Date.now() - ageMs) / 1000;
  fs.writeFileSync(path.join(dir, "state.json"), "{}", "utf-8");
  fs.utimesSync(dir, t, t);
  fs.utimesSync(path.join(dir, "state.json"), t, t);
  return dir;
}

// ── AUD-P1-03a: 焼き直し実行中はTTL掃除で消えない ──────────────────────
{
  const root = freshRoot();
  const jobId = "recap-running-job";
  const dir = makeOldJobDir(root, jobId, 5000); // TTL(2秒)超過

  assert.strictEqual(beginRecaption(jobId), true, "前提: beginRecaptionが受理される");
  try {
    report(
      "AUD-P1-03a前提: activeJobIds()が焼き直し実行中のジョブIDを含む",
      activeJobIds().includes(jobId),
      `activeJobIds=${JSON.stringify(activeJobIds())}`
    );

    const removed = sweepExpiredJobs([root], 2, Date.now(), activeJobIds());
    report(
      "AUD-P1-03a: 焼き直し実行中(recaptioningJobsに登録済み)のジョブはTTL超過でも掃除で消えない",
      fs.existsSync(dir) && !removed.some((r) => r.jobId === jobId),
      `exists=${fs.existsSync(dir)} removed=${JSON.stringify(removed)}`
    );
  } finally {
    endRecaption(jobId);
  }

  // 焼き直しが終わった後は、通常どおりTTL掃除の対象に戻ることも確認する(回帰防止)。
  const removedAfter = sweepExpiredJobs([root], 2, Date.now(), activeJobIds());
  report(
    "AUD-P1-03a事後: 焼き直しが終わればTTL超過ジョブは通常どおり掃除される(保護が永続しない)",
    !fs.existsSync(dir) && removedAfter.some((r) => r.jobId === jobId),
    `exists=${fs.existsSync(dir)}`
  );
}

// ── AUD-P1-03b: 焼き直し実行待ち(共有ゲート満杯)もTTL掃除で消えない ──────────
{
  const root = freshRoot();
  const jobId = "recap-waiting-job";
  const dir = makeOldJobDir(root, jobId, 5000); // TTL(2秒)超過

  // VS_MAX_CONCURRENT_JOBS=1 のゲートを、解放しない1本のダミー実行で埋める。
  let releaseBlocker;
  const blockerGate = new Promise((resolve) => { releaseBlocker = resolve; });
  const blockerDone = runGated(() => blockerGate);

  assert.strictEqual(beginRecaption(jobId), true, "前提: beginRecaptionが受理される");
  // ゲートが1本で埋まっているため、このrunGatedはすぐには実行されずキューで待つ。
  let targetRan = false;
  const targetDone = runGated(() => {
    targetRan = true;
    return Promise.resolve();
  }).finally(() => endRecaption(jobId));

  try {
    // イベントループを1周させ、targetのrunGatedがキューへ積まれた状態を安定させる。
    await new Promise((r) => setTimeout(r, 50));
    report(
      "AUD-P1-03b前提: ゲートが埋まっているため焼き直しはまだ実行されていない(待機中)",
      !targetRan
    );
    report(
      "AUD-P1-03b前提: activeJobIds()が焼き直し待ちのジョブIDを含む",
      activeJobIds().includes(jobId),
      `activeJobIds=${JSON.stringify(activeJobIds())}`
    );

    const removed = sweepExpiredJobs([root], 2, Date.now(), activeJobIds());
    report(
      "AUD-P1-03b: 焼き直し待ち(共有ゲートで順番待ち)のジョブはTTL超過でも掃除で消えない",
      fs.existsSync(dir) && !removed.some((r) => r.jobId === jobId),
      `exists=${fs.existsSync(dir)} removed=${JSON.stringify(removed)}`
    );
  } finally {
    releaseBlocker();
    await blockerDone;
    await targetDone;
  }

  report(
    "AUD-P1-03b前提事後: ゲート解放後は待っていた焼き直しが実際に実行された",
    targetRan
  );

  const removedAfter = sweepExpiredJobs([root], 2, Date.now(), activeJobIds());
  report(
    "AUD-P1-03b事後: 焼き直しが終わればTTL超過ジョブは通常どおり掃除される(保護が永続しない)",
    !fs.existsSync(dir) && removedAfter.some((r) => r.jobId === jobId),
    `exists=${fs.existsSync(dir)}`
  );
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
