// 同時実行数の上限の検証 — P2-4-C
//
// server/pipeline-runner.mjs の Groq(クラウド)経路は、修正前は同時に何本でも実行していた。
// 大量投入は外部APIのレート制限や端末リソースを使い切りうるため、createConcurrencyGate() で
// 同時実行数へ上限を設け、超過分は拒否せずFIFOで順番待ちにする。
// 実ジョブ(spawn/ffmpeg等)を伴わない純粋なスケジューラとして切り出してあるので、
// 疑似タスク(setTimeoutベース)で実行順序と同時実行数の上限を直接測る。
//
// ①偽物が壊れる/③壊したものを当てて落ちることの確認: 「上限を掛けない」ナイーブな実行
// (Promise.all的に即時実行するだけ)を同じ入力に当てると、同時実行数の実測が上限を超えて
// しまうことを対照として示す。
// ②正しい実装の値を測る: createConcurrencyGate(N) に N+α 本のタスクを投入し、
// 同時に走った本数の最大値が常に N 以下であること・全タスクが最終的に1回ずつ実行される
// こと（拒否ではなくキューイング）を実測する。
//
// 実行: node tests/job-concurrency-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import { createConcurrencyGate, resolveMaxConcurrentJobs } from "../server/pipeline-runner.mjs";

let pass = 0, fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n      ${e.stack || e.message}`);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 疑似ジョブ: 実行中フラグを立ててから少し待ち、実行された回数・同時実行数を記録して返す */
function makeTracker() {
  let current = 0;
  let maxConcurrent = 0;
  const startedOrder = [];
  const runCounts = new Map();
  function task(id, ms = 30) {
    return async () => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      startedOrder.push(id);
      runCounts.set(id, (runCounts.get(id) || 0) + 1);
      await sleep(ms);
      current--;
    };
  }
  return { task, get maxConcurrent() { return maxConcurrent; }, startedOrder, runCounts };
}

// ── resolveMaxConcurrentJobs: env解決の純粋関数 ─────────────────
t("resolveMaxConcurrentJobs: 既定は3、envに正の整数があればそれを使う、不正値は既定へ", () => {
  assert.strictEqual(resolveMaxConcurrentJobs(undefined), 3);
  assert.strictEqual(resolveMaxConcurrentJobs("5"), 5);
  assert.strictEqual(resolveMaxConcurrentJobs("1"), 1);
  assert.strictEqual(resolveMaxConcurrentJobs("0"), 3);   // 0本は不正 → 既定へ
  assert.strictEqual(resolveMaxConcurrentJobs("-2"), 3);  // 負数は不正 → 既定へ
  assert.strictEqual(resolveMaxConcurrentJobs("abc"), 3); // 数値でない → 既定へ
  assert.strictEqual(resolveMaxConcurrentJobs("2.7"), 2); // 小数は切り捨て
});

// ── ②: createConcurrencyGate(2) に5本投入し、同時実行数が2を超えないことを実測 ──
await t("②同時実行数の上限(=2)を超えて走ることはなく、5本すべてが1回ずつ実行される", async () => {
  const gate = createConcurrencyGate(2);
  const tr = makeTracker();
  const N = 5;
  const promises = [];
  for (let i = 0; i < N; i++) {
    promises.push(new Promise((resolve) => {
      gate.run(async () => {
        await tr.task(i, 40)();
        resolve();
      });
    }));
  }
  await Promise.all(promises);
  assert.ok(tr.maxConcurrent <= 2, `同時実行数の上限を超えた: maxConcurrent=${tr.maxConcurrent}`);
  assert.strictEqual(tr.maxConcurrent, 2, `上限2まで使い切って並列実行されるはずが maxConcurrent=${tr.maxConcurrent}`);
  assert.strictEqual(tr.startedOrder.length, N, "拒否されたタスクがある(キューイングされるはずが実行されなかった)");
  for (let i = 0; i < N; i++) assert.strictEqual(tr.runCounts.get(i), 1, `id=${i} が1回ちょうど実行されていない`);
});

await t("②上限=1なら常に直列（同時実行数の最大値は1）", async () => {
  const gate = createConcurrencyGate(1);
  const tr = makeTracker();
  const N = 4;
  const promises = [];
  for (let i = 0; i < N; i++) {
    promises.push(new Promise((resolve) => {
      gate.run(async () => { await tr.task(i, 15)(); resolve(); });
    }));
  }
  await Promise.all(promises);
  assert.strictEqual(tr.maxConcurrent, 1, `上限1のはずが maxConcurrent=${tr.maxConcurrent}`);
  assert.strictEqual(tr.startedOrder.length, N);
});

// ── ①/③: 上限を掛けない「偽物」実行だと、同時実行数が上限を超えてしまう ──
await t("①対照: 上限を掛けずに即時実行する実装だと、同時実行数が上限を超えてしまう", async () => {
  const tr = makeTracker();
  const N = 5;
  // createConcurrencyGate を使わず、素朴に「届いた順にそのまま実行する」旧来の実装を模す
  // (server/pipeline-runner.mjs の Groq経路が修正前にやっていたのと同型)。
  const promises = [];
  for (let i = 0; i < N; i++) promises.push(tr.task(i, 20)());
  await Promise.all(promises);
  assert.ok(tr.maxConcurrent > 2, `対照のはずなのに同時実行数が上限相当(2)を超えなかった: ${tr.maxConcurrent}`);
  assert.strictEqual(tr.maxConcurrent, N, "対照は上限が無いので全数が同時に走るはず");
});

await t("③この検査には検出能力がある: 上限が効いていないゲート(max=Infinity)を「上限内」判定に通すと実際に落ちる", async () => {
  const brokenGate = createConcurrencyGate(Infinity); // 「上限が無い」壊れた設定を模す
  const tr = makeTracker();
  const N = 5;
  const promises = [];
  for (let i = 0; i < N; i++) {
    promises.push(new Promise((resolve) => {
      brokenGate.run(async () => { await tr.task(i, 20)(); resolve(); });
    }));
  }
  await Promise.all(promises);
  assert.throws(() => {
    assert.ok(tr.maxConcurrent <= 2, `同時実行数の上限を超えた: maxConcurrent=${tr.maxConcurrent}`);
  }, /.*/, "上限が効いていないのに「上限内」判定を通ってしまった(検出できていない)");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
