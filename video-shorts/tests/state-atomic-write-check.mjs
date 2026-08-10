// state.json の原子書き込みの検証 — P2-1
//
// state.json は書き込み中にプロセスが強制終了すると、直接最終pathへ truncate 書込みする
// 実装だと open(O_TRUNC) の時点でファイルが0バイトへ切り詰められてしまい、書き終える前に
// 落ちると元の内容ごと失われる（以後 JSON.parse できず、ジョブが再開できなくなる）。
// src/atomic-json.mjs の writeJsonAtomically は「同じディレクトリの一時ファイルへ書く→
// fsync→rename」の作法でこれを避ける（caption-store.mjs の writeEditsAtomically と同じ作法）。
//
// このテストは実プロセスを実際に SIGKILL して確かめる（AGENTS.md が「理想」とする方式）。
// - ②（正しい実装の値を測る）: fs.renameSync を横取りし、「tmpへの書込み+fsyncは完了・
//   renameはまだ呼ばれていない」その瞬間で親へ通知させ、親がその時点でSIGKILLする。
//   renameが未着手なら最終pathは一切触られていないはずなので、元の state.json が壊れず
//   読めることを確認する。
// - 対照（①偽物が壊れる／③壊したものを当てて落ちることを確認）: 「rename を使わず直接
//   最終pathへ truncate 書込みする」旧実装を模した子プロセスで同じ手順を踏み、
//   open(O_TRUNC) 直後にSIGKILLされると実際に元の内容が失われる（0バイトに壊れる）ことを
//   示す。さらに、この壊れ方を「良い実装」用の検査（renameが起きていない＝内容が残っている
//   はず、という assertion）に通すと実際に落ちることも確認し、この検査に検出能力があることを示す。
//
// 実行: node tests/state-atomic-write-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const ATOMIC_MODULE = path.join(ROOT, "src", "atomic-json.mjs");

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

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vs-state-atomic-"));
}

const ORIGINAL_STATE = { id: "job-original", stage: "rendered", marker: "ORIGINAL" };

/**
 * 与えたスクリプト本文を子プロセスとして fork し、"ready" メッセージが届いた瞬間に
 * SIGKILL する。子プロセスの exit を待ってから戻る。
 */
function runAndKillAtReady(scriptSrc, args) {
  const dir = freshDir();
  const scriptPath = path.join(dir, "child.mjs");
  fs.writeFileSync(scriptPath, scriptSrc, "utf-8");
  return new Promise((resolve, reject) => {
    const child = fork(scriptPath, args, { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) {}
      reject(new Error(`子プロセスが ready を送らないままタイムアウトした。stderr=${stderr}`));
    }, 10000);
    child.once("message", (msg) => {
      if (msg !== "ready") return;
      clearTimeout(timer);
      child.kill("SIGKILL");
      child.once("exit", () => resolve());
    });
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// ── ②: 良い実装（writeJsonAtomically）を実プロセスkillで実測 ──────────────
await t("②atomic実装: renameを試みる直前に強制終了しても、元のstate.jsonは無事に読める(実測)", async () => {
  const dir = freshDir();
  const statePath = path.join(dir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(ORIGINAL_STATE, null, 2), "utf-8");

  const childScript = `
import fs from "node:fs";
import { writeJsonAtomically } from ${JSON.stringify(ATOMIC_MODULE)};
const statePath = process.argv[2];
const realRename = fs.renameSync;
fs.renameSync = (...args) => {
  process.send("ready", () => {
    const until = Date.now() + 8000;
    while (Date.now() < until) {} // 親にSIGKILLされる想定。ここへ来たら親側の不備。
    realRename(...args);
  });
};
writeJsonAtomically(statePath, { id: "job-original", stage: "rendered", marker: "NEW_SHOULD_NOT_LAND" });
`;
  await runAndKillAtReady(childScript, [statePath]);

  // renameが未着手のはずなので、元のJSONがそのまま壊れず読める
  const after = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  assert.deepStrictEqual(after, ORIGINAL_STATE, "renameが実行されてしまった、またはstate.jsonが壊れた");
});

// ── ①/③: 偽物（直接truncate書込み）を同じ手順にかけると壊れる ──────────
await t("①対照: renameを使わず直接truncate書込みする実装は、強制終了すると元の内容が失われる", async () => {
  const dir = freshDir();
  const statePath = path.join(dir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(ORIGINAL_STATE, null, 2), "utf-8");

  const childScript = `
import fs from "node:fs";
const statePath = process.argv[2];
// 「rename を使わず直接 truncate 書込みする」旧実装を模す（P2-1修正前の writeState と同型）。
const fd = fs.openSync(statePath, "w"); // "w" は open時点でファイルを0バイトへ切り詰める
process.send("ready", () => {
  const until = Date.now() + 8000;
  while (Date.now() < until) {} // 親にSIGKILLされる想定
  fs.writeSync(fd, JSON.stringify({ id: "job-original", stage: "rendered", marker: "NEW_SHOULD_NOT_LAND" }, null, 2));
  fs.closeSync(fd);
});
`;
  await runAndKillAtReady(childScript, [statePath]);

  // open(O_TRUNC)の時点で切り詰められてから殺されているので、元の内容は完全に失われている
  const raw = fs.readFileSync(statePath, "utf-8");
  assert.strictEqual(raw, "", "偽物実装のはずなのに元の内容が残っている(対照が機能していない)");
});

await t("③この検査には検出能力がある: 偽物の壊れ方を「良い実装」用の判定に通すと実際に落ちる", async () => {
  const dir = freshDir();
  const statePath = path.join(dir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(ORIGINAL_STATE, null, 2), "utf-8");

  const childScript = `
import fs from "node:fs";
const statePath = process.argv[2];
const fd = fs.openSync(statePath, "w");
process.send("ready", () => {
  const until = Date.now() + 8000;
  while (Date.now() < until) {}
  fs.closeSync(fd);
});
`;
  await runAndKillAtReady(childScript, [statePath]);

  // ②で使った「元のJSONがそのまま読める」という判定を、この壊れた結果に対して行うと
  // 実際に例外になる(=検査が偽物を見逃さないことの確認)。
  assert.throws(() => {
    const after = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.deepStrictEqual(after, ORIGINAL_STATE);
  }, /.*/, "壊れているはずのstate.jsonが「良い実装」判定を通ってしまった(検出できていない)");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
