// 保存容量の上限(クォータ)の検証 — P2-4-B
//
// server/job-lifecycle.mjs の computeUsedBytes()/hasQuotaAvailable() が、work/output配下の
// 使用量を実測し、上限(既定10GB・VS_STORAGE_QUOTA_BYTESで上書き可)に達していれば新規保存を
// 拒否できるようにする（実際の拒否はserver/index.mjsのhandlePostJobsで行うが、その判断根拠
// となる純粋関数をここで検証する）。
//
// ①偽物が壊れる/③壊したものを当てて落ちることの確認: 使用量を常に0とみなす(容量計測を
// しない)偽実装を同じ状況に当てると、上限を超えていても「まだ空きがある」と誤判定して
// しまうことを対照として示す。
// ②正しい実装の値を測る: 小さいクォータを設定した状態で、上限を超える量のファイルを
// 実際に作り、computeUsedBytes()の実測値・hasQuotaAvailable()の判定を確認する。
//
// 実行: node tests/job-quota-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveQuotaBytes, computeUsedBytes, hasQuotaAvailable } from "../server/job-lifecycle.mjs";

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "vs-quota-"));
}
function writeFileOfSize(p, bytes) {
  fs.writeFileSync(p, Buffer.alloc(bytes, "x"));
}

// ── resolveQuotaBytes: env解決の純粋関数 ────────────────────────
// CodeRabbit指摘: resolveQuotaBytes(undefined) は引数省略と同じ扱いになり、実行環境に
// VS_STORAGE_QUOTA_BYTES が設定されていると「既定へ落ちる」経路が本物のenv値を見てしまう。
// 既定値の検証中だけ、この環境変数を明示的に退避・削除してから確認し、必ず元へ戻す。
t("resolveQuotaBytes: 既定は10GB、envに正の数値があればそれを使う、不正値は既定へ", () => {
  const hadEnv = Object.prototype.hasOwnProperty.call(process.env, "VS_STORAGE_QUOTA_BYTES");
  const savedEnv = process.env.VS_STORAGE_QUOTA_BYTES;
  delete process.env.VS_STORAGE_QUOTA_BYTES;
  try {
    assert.strictEqual(resolveQuotaBytes(undefined), 10 * 1024 * 1024 * 1024);
    assert.strictEqual(resolveQuotaBytes("1000"), 1000);
    assert.strictEqual(resolveQuotaBytes("0"), 10 * 1024 * 1024 * 1024);
    assert.strictEqual(resolveQuotaBytes("-1"), 10 * 1024 * 1024 * 1024);
    assert.strictEqual(resolveQuotaBytes("nan"), 10 * 1024 * 1024 * 1024);
  } finally {
    if (hadEnv) process.env.VS_STORAGE_QUOTA_BYTES = savedEnv;
    else delete process.env.VS_STORAGE_QUOTA_BYTES;
  }
});

// ── ②: 小さいクォータで実測 ──────────────────────────────────
t("②computeUsedBytes: work/output配下(ネスト含む)の実ファイルサイズ合計を正しく数える", () => {
  const workRoot = freshRoot();
  const outRoot = freshRoot();
  const jobDir = path.join(workRoot, "job-a");
  fs.mkdirSync(jobDir);
  writeFileOfSize(path.join(jobDir, "input.mp4"), 3000);
  writeFileOfSize(path.join(jobDir, "state.json"), 200);
  const outJobDir = path.join(outRoot, "job-a");
  fs.mkdirSync(outJobDir);
  writeFileOfSize(path.join(outJobDir, "clip.mp4"), 4000);

  const used = computeUsedBytes([workRoot, outRoot]);
  assert.strictEqual(used, 3000 + 200 + 4000);
});

t("②境界: クォータちょうどでは「空きなし」・ちょうど手前では「空きあり」", () => {
  assert.strictEqual(hasQuotaAvailable(10_000, 10_000), false, "使用量=上限は空き無しのはず(境界含む)");
  assert.strictEqual(hasQuotaAvailable(9_999, 10_000), true, "使用量<上限は空きありのはず");
  assert.strictEqual(hasQuotaAvailable(10_001, 10_000), false, "使用量>上限は空き無しのはず");
});

t("②クォータを超過した状態を実ファイルで作ると、hasQuotaAvailableがfalseになる(拒否対象)", () => {
  const workRoot = freshRoot();
  const jobDir = path.join(workRoot, "job-a");
  fs.mkdirSync(jobDir);
  writeFileOfSize(path.join(jobDir, "input.mp4"), 12_000); // 上限(10,000)を超える

  const quotaBytes = 10_000;
  const used = computeUsedBytes([workRoot]);
  assert.strictEqual(used, 12_000);
  assert.strictEqual(hasQuotaAvailable(used, quotaBytes), false, "上限超過なのに保存OK判定になった");
});

t("②クォータ内なら、hasQuotaAvailableがtrueになる(受付対象)", () => {
  const workRoot = freshRoot();
  const jobDir = path.join(workRoot, "job-a");
  fs.mkdirSync(jobDir);
  writeFileOfSize(path.join(jobDir, "input.mp4"), 3_000); // 上限(10,000)未満

  const quotaBytes = 10_000;
  const used = computeUsedBytes([workRoot]);
  assert.strictEqual(hasQuotaAvailable(used, quotaBytes), true, "上限内なのに保存NG判定になった");
});

// ── ①/③: 使用量を常に0とみなす偽実装だと、超過を見逃す ────────────
t("①対照: 使用量を計測しない(常に0とみなす)偽実装だと、実際は超過していても空きありと誤判定する", () => {
  const workRoot = freshRoot();
  const jobDir = path.join(workRoot, "job-a");
  fs.mkdirSync(jobDir);
  writeFileOfSize(path.join(jobDir, "input.mp4"), 12_000); // 実際は上限(10,000)を超えている

  const fakeUsed = 0; // 計測しない偽実装が返す値を模す
  assert.strictEqual(hasQuotaAvailable(fakeUsed, 10_000), true, "対照のはずなのに拒否判定になった");
});

t("③この検査には検出能力がある: 偽の使用量(0)を「拒否されるはず」判定に通すと実際に落ちる", () => {
  assert.throws(() => {
    const fakeUsed = 0;
    assert.strictEqual(hasQuotaAvailable(fakeUsed, 10_000), false, "上限超過なのに保存OK判定になった");
  }, /上限超過なのに保存OK判定になった/, "計測していない偽の値が「拒否される」判定を通ってしまった(検出できていない)");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
