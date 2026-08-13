// 完了ジョブがメモリに溜まり続けないことの検証 — AUD-P2-20a
//
// 旧実装は、終端(done/error/cancelled/timeout)に達したジョブをjobs Map(メモリ上の状態管理)
// から一切削除しておらず、稼働し続けるサーバーへ継続的にジョブが投入されると、終わった
// ジョブの記録がメモリに際限なく溜まり続けていた(監査指摘)。
//
// server/pipeline-runner.mjs の reclaimTerminalJobs() は、終端到達から
// VS_JOB_RETENTION_SECONDS(既定10分)を過ぎたジョブをjobs Mapから削除する。
// このテストではその保持期間を1秒まで短く設定し、実時間を長く待たずに検証する。
//
// 【なぜHTTP経由ではなく直接importか】GC対象のjobs Mapはpipeline-runner.mjs内部の
// プライベートな状態で、実サーバーを1プロセス起動してHTTP越しに見ても「メモリから
// 消えたか」は観測できない(SSE再接続はAUD-P2-16によりstate.jsonからの復元にフォール
// バックするため、メモリに残っているかどうかで応答が変わらない＝これはP2-16との良い
// 協調だが、このテストの観測手段としては使えない)。tests/mosaic-job-wiring-check.mjs等と
// 同じ作法で、startJob()を直接importして呼び、hasJobInMemory()/jobsMapSize()で
// メモリの中身を直接検査する。
//
// 【なぜ「無音」を使って高速に完了させるか】文字起こし結果が0件(no_speech)だと、
// pipeline-runner.mjsはselect/render(実ffmpeg)を一切経由せず即座にerror終端になる。
// 大量のジョブを現実的な時間で終端させるのに都合がよい(かつ本物の終端到達経路を通る)。
//
// 実行: node tests/job-memory-reclaim-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const WORK_ROOT = path.join(ROOT, "work");

// pipeline-runner.mjsはモジュール読み込み時に一度だけ env を読むため、importより前に設定する。
process.env.VS_JOB_RETENTION_SECONDS = "1"; // 実時間を長く待たずに検証するための短い保持期間

const { startJob, subscribeJob, unsubscribeJob, hasJobInMemory, jobsMapSize, reclaimTerminalJobs, resolveJobRetentionMs } =
  await import("../server/pipeline-runner.mjs");

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

// ── resolveJobRetentionMs: env解決の純粋関数 ────────────────────────────
{
  assert.strictEqual(resolveJobRetentionMs("30"), 30_000, "秒→msの変換が違う");
  assert.strictEqual(resolveJobRetentionMs("0"), 10 * 60 * 1000, "0以下は既定へ落ちていない");
  assert.strictEqual(resolveJobRetentionMs("abc"), 10 * 60 * 1000, "非数は既定へ落ちていない");
  report("resolveJobRetentionMs: 正の数値は秒→ms変換、0以下・非数は既定(600000ms)へ", true);
}

/** PATH の先頭に、文字起こし結果を「無音(0件)」に固定する偽pythonを差し込む。 */
function installFakeSilentPython() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fake-silent-python-"));
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, "python");
  fs.writeFileSync(
    exe,
    `#!/usr/bin/env node\n` +
      `const fs = require("fs");\n` +
      `const transcriptPath = process.argv[4];\n` +
      `fs.writeFileSync(transcriptPath, JSON.stringify({ language: "ja", duration: 1, words: [], segments: [] }));\n`
  );
  fs.chmodSync(exe, 0o755);
  return { binDir, home };
}

/** startJob()が発火するSSEを終端(done/error/cancelled/timeout)まで待つ。 */
function waitForTerminal(jobId, timeoutMs = 15000) {
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
    const close = () => {};
    subscribeJob(jobId, push, close);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribeJob(jobId, push);
      reject(new Error(`jobId=${jobId} が制限時間内に終端しなかった`));
    }, timeoutMs);
  });
}

const fakePython = installFakeSilentPython();
const originalPath = process.env.PATH;
process.env.PATH = [fakePython.binDir, originalPath].join(path.delimiter);

const N = 20; // 「~20本」の受入事実(HTTP経由のレート制限はこの直接呼び出し経路には掛からない)
const jobIds = [];
try {
  for (let i = 0; i < N; i++) {
    const jobId = `mem-reclaim-${i}-${crypto.randomBytes(4).toString("hex")}`;
    jobIds.push(jobId);
    const inputAbsPath = path.join(WORK_ROOT, jobId, "input.mp4");
    const started = startJob(jobId, inputAbsPath, { sub: "none", cut: "topic", size: "9:16" });
    assert.strictEqual(started, true, `前提: startJobが受理される(jobId=${jobId})`);
  }
  report(`前提: ${N}本のジョブをすべて受理できた(直接呼び出しはHTTPレート制限の対象外)`, true);

  await Promise.all(jobIds.map((id) => waitForTerminal(id)));
  report(`前提: ${N}本すべてが実際に終端(error=無音)まで到達した`, true);

  const sizeBeforeReclaim = jobsMapSize();
  report(
    `①保持期間(1秒)経過前は、jobs Mapに${N}本すべてがまだ残っている(即座には消えない)`,
    jobIds.every((id) => hasJobInMemory(id)) && sizeBeforeReclaim >= N,
    `size=${sizeBeforeReclaim}`
  );

  // 保持期間(1秒)を過ぎるまで待つ。
  await new Promise((r) => setTimeout(r, 1300));

  // 定期実行(60秒間隔)を待たず、reclaimTerminalJobs()を直接呼んで確定的に検証する。
  const removed = reclaimTerminalJobs();
  report(
    `②AUD-P2-20a: 保持期間(1秒)経過後、reclaimTerminalJobs()が${N}本すべてを回収する`,
    removed.length === N && jobIds.every((id) => removed.includes(id)),
    `removed.length=${removed.length}`
  );
  report(
    "②AUD-P2-20a: 回収後、jobs Mapに投入した分がもう残っていない(hasJobInMemoryがfalse)",
    jobIds.every((id) => !hasJobInMemory(id)),
    `残存=${jobIds.filter((id) => hasJobInMemory(id)).join(",")}`
  );

  // ── 対照: 保持期間内の新しいジョブは巻き込まれず削除されない ────────────
  const freshId = `mem-reclaim-fresh-${crypto.randomBytes(4).toString("hex")}`;
  jobIds.push(freshId);
  const freshInput = path.join(WORK_ROOT, freshId, "input.mp4");
  assert.strictEqual(startJob(freshId, freshInput, { sub: "none", cut: "topic", size: "9:16" }), true);
  await waitForTerminal(freshId);
  const removedAgain = reclaimTerminalJobs(); // まだ保持期間(1秒)内のはず
  report(
    "③対照: 終端直後(保持期間内)のジョブは、即座にreclaimTerminalJobsを呼んでも回収されない",
    !removedAgain.includes(freshId) && hasJobInMemory(freshId),
    `removedAgain=${JSON.stringify(removedAgain)}`
  );
  await new Promise((r) => setTimeout(r, 1300));
  const removedFresh = reclaimTerminalJobs();
  report(
    "③対照事後: 保持期間を過ぎれば、その後発ジョブも同様に回収される(特別扱いされていない)",
    removedFresh.includes(freshId) && !hasJobInMemory(freshId)
  );
} finally {
  process.env.PATH = originalPath;
  fs.rmSync(fakePython.home, { recursive: true, force: true });
  for (const id of jobIds) fs.rmSync(path.join(WORK_ROOT, id), { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
