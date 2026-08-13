// 待ち行列に上限があることの検証 — AUD-P2-20b
//
// 旧実装は待ち行列(groq経路のconcurrencyGate内部キュー・local経路のlocalQueue)に上限が無く、
// 投入され続けると際限なく伸びた(監査指摘)。server/pipeline-runner.mjs の startJob() は
// 待ち行列がVS_MAX_QUEUE_LENGTH(既定20)に達していれば、キューへ積む前に"queue_full"を
// 返して新規投入自体を拒否するようになった。server/index.mjs はこれを429で返す。
//
// 【なぜHTTP経由ではなく直接importか】mosaic-job-wiring-check.mjs等と同じ作法。
// startJob()を直接呼び、戻り値そのもの("queue_full"かどうか)とqueueWaitingCount()
// (待ち行列の実測長)を直接検査できるため、実サーバーを起動するより確実・高速。
//
// 実行: node tests/job-queue-cap-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const WORK_ROOT = path.join(ROOT, "work");
const FAKE_HANGING_PYTHON = path.join(HERE, "helpers", "fake-hanging-python.mjs");

// pipeline-runner.mjsはモジュール読み込み時に一度だけ env を読むため、importより前に設定する。
// GROQ_API_KEYを与えてgroq経路(concurrencyGate)を強制的に選ばせ、実行本数の上限を1本に絞って
// 「実行スロットが埋まっている(=待ち行列に積まれるだけで実行されない)」状況を安定して作る。
process.env.GROQ_API_KEY = "dummy-key-for-gate-selection-only";
process.env.VS_MAX_CONCURRENT_JOBS = "1";
process.env.VS_MAX_QUEUE_LENGTH = "2";

const { startJob, subscribeJob, unsubscribeJob, cancelJob, queueWaitingCount, resolveMaxQueueLength } =
  await import("../server/pipeline-runner.mjs");

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

// ── resolveMaxQueueLength: env解決の純粋関数 ────────────────────────────
{
  assert.strictEqual(resolveMaxQueueLength("5"), 5);
  assert.strictEqual(resolveMaxQueueLength("0"), 20, "0以下は既定へ落ちていない");
  assert.strictEqual(resolveMaxQueueLength("abc"), 20, "非数は既定へ落ちていない");
  report("resolveMaxQueueLength: 正の数値はそのまま、0以下・非数は既定(20)へ", true);
}

function installFakeHangingPython() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fake-hang-queue-cap-"));
  const exe = path.join(binDir, "python");
  fs.copyFileSync(FAKE_HANGING_PYTHON, exe);
  fs.chmodSync(exe, 0o755);
  return binDir;
}

function waitForTerminal(jobId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const push = (line) => {
      if (/^event:\s*(done|error|cancelled|timeout)/m.test(line)) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribeJob(jobId, push);
        resolve(line);
      }
    };
    subscribeJob(jobId, push, () => {});
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribeJob(jobId, push);
      reject(new Error(`jobId=${jobId} が制限時間内に終端しなかった`));
    }, timeoutMs);
  });
}

const binDir = installFakeHangingPython();
const originalPath = process.env.PATH;
process.env.PATH = [binDir, originalPath].join(path.delimiter);

const allJobIds = [];
function newJobId(label) {
  const id = `queue-cap-${label}-${crypto.randomBytes(4).toString("hex")}`;
  allJobIds.push(id);
  return id;
}

try {
  // ── job1: 実行スロット(1本)を占有する(ハングする偽pythonでstage tに留まる) ──
  const job1 = newJobId("running");
  const started1 = startJob(job1, path.join(WORK_ROOT, job1, "input.mp4"), { sub: "none", cut: "topic", size: "9:16" });
  report("前提: 1本目(実行枠を占有する側)は受理される", started1 === true, `started1=${JSON.stringify(started1)}`);

  // イベントループを回し、job1が実際に実行スロットへ入る(待ち行列0のまま実行中)のを待つ。
  await new Promise((r) => setTimeout(r, 300));
  report("前提: 実行スロット(1本)が埋まっているので、待ち行列はまだ0", queueWaitingCount() === 0, `waiting=${queueWaitingCount()}`);

  // ── job2・job3: 待ち行列(上限2)を満杯にする ────────────────────────
  const job2 = newJobId("queued-1");
  const job3 = newJobId("queued-2");
  const started2 = startJob(job2, path.join(WORK_ROOT, job2, "input.mp4"), { sub: "none", cut: "topic", size: "9:16" });
  const started3 = startJob(job3, path.join(WORK_ROOT, job3, "input.mp4"), { sub: "none", cut: "topic", size: "9:16" });
  report(
    "前提: 待ち行列の上限(2)ちょうどまでは受理される",
    started2 === true && started3 === true,
    `started2=${JSON.stringify(started2)} started3=${JSON.stringify(started3)}`
  );
  report("前提: 待ち行列が実際に上限(2)まで埋まった", queueWaitingCount() === 2, `waiting=${queueWaitingCount()}`);

  // ── AUD-P2-20b: 上限を超える4本目は拒否される ────────────────────────
  const job4 = newJobId("rejected");
  const started4 = startJob(job4, path.join(WORK_ROOT, job4, "input.mp4"), { sub: "none", cut: "topic", size: "9:16" });
  report(
    'AUD-P2-20b: 待ち行列が上限に達している状態での4本目は"queue_full"として拒否される',
    started4 === "queue_full",
    `started4=${JSON.stringify(started4)}`
  );
  report(
    "AUD-P2-20b: 拒否された4本目はjobs Map/待ち行列のどちらにも積まれていない(待ち行列長は2のまま=上限を超えない)",
    queueWaitingCount() === 2,
    `waiting=${queueWaitingCount()}`
  );

  // ── 対照: 実行スロットが空けば、通常どおり受理される(恒久拒否ではない) ──────
  // job1・job2・job3をすべてキャンセルして実行スロット・待ち行列を空ける。
  // job2/job3はまだ子プロセスを持たない(待ち行列で順番待ち中)状態でもcancelJob()が
  // 効くことも同時に確認する(AUD-P1-11aの効果範囲)。
  for (const id of [job1, job2, job3]) {
    const r = cancelJob(id);
    report(`後始末: ${id} のキャンセルが受理される(実行中/待機中どちらでも)`, r.ok === true, JSON.stringify(r));
  }
  await Promise.all([job1, job2, job3].map((id) => waitForTerminal(id)));
  report("後始末事後: 待ち行列がすべて解消し0に戻る", queueWaitingCount() === 0, `waiting=${queueWaitingCount()}`);

  const job5 = newJobId("after-drain");
  const started5 = startJob(job5, path.join(WORK_ROOT, job5, "input.mp4"), { sub: "none", cut: "topic", size: "9:16" });
  report(
    "対照: 待ち行列が空けば、上限に達していた直後でも新規ジョブは通常どおり受理される(恒久拒否ではない)",
    started5 === true,
    `started5=${JSON.stringify(started5)}`
  );
  const cancelJob5 = cancelJob(job5);
  await waitForTerminal(job5);
  report("後始末: 5本目も片付いた", cancelJob5.ok === true);
} finally {
  process.env.PATH = originalPath;
  fs.rmSync(binDir, { recursive: true, force: true });
  for (const id of allJobIds) fs.rmSync(path.join(WORK_ROOT, id), { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
