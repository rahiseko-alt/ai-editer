// verify-done-gate.mjs の核ロジックの実テスト。git/子プロセスには依存せず、
// parse済みJSONオブジェクトと注入したrunCmdで判定する。
//
// 主眼（2026-08-10、マスター指示「最初に決めたハードルを、AIが下げるのを機械ブロックさせろ」）：
// 「基準を決める→凍結する→その基準に機械判定で合格するまで直す」を裏付ける、"done化には
// verifyCmdの実行が必須"というルールが正しく機能することを保証する。
//
// 実行: node scripts/verify-done-gate.test.mjs

import assert from "node:assert";
import {
  findMissingVerifyCmdViolations,
  findNewlyDoneLeaves,
  formatDoneGateViolation,
  isDoneLeaf,
  runVerifyCommands,
} from "./verify-done-gate.mjs";

let pass = 0;
let fail = 0;
/**
 * @param {string} name
 * @param {() => void} fn
 */
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    const message = e instanceof Error ? e.message : String(e);
    console.log(`FAIL ${name}\n      ${message}`);
  }
}

/**
 * @param {{
 *   id?: string,
 *   status?: string,
 *   criteria?: Array<{ text: string, verify: string, verifyCmd?: string }>,
 *   children?: any[],
 * }} [opts]
 */
function leaf({ id = "G-1", status = "todo", criteria = [], children } = {}) {
  /** @type {any} */
  const node = { id, kind: "state", status, criteria };
  if (children) node.children = children;
  return node;
}

/** @param {{ id: string }} leafNode */
function tree(leafNode) {
  return { meta: {}, nodes: [{ id: "ROOT", kind: "state", children: [leafNode] }] };
}

// ---- isDoneLeaf ----

t("isDoneLeaf: 葉(子なし)のstateノードでstatus:doneならtrue", () => {
  assert.strictEqual(isDoneLeaf(leaf({ status: "done" })), true);
});

t("isDoneLeaf: status:doingはfalse", () => {
  assert.strictEqual(isDoneLeaf(leaf({ status: "doing" })), false);
});

t("isDoneLeaf: 子を持つノードはdoneでもfalse（葉のみ対象）", () => {
  assert.strictEqual(isDoneLeaf(leaf({ status: "done", children: [{ id: "x" }] })), false);
});

// ---- findNewlyDoneLeaves ----

t("BASEでdoingだった葉がHEADでdoneに遷移していれば対象になる", () => {
  const base = tree(leaf({ status: "doing" }));
  const head = tree(leaf({ status: "done" }));
  const result = findNewlyDoneLeaves(base, head);
  assert.strictEqual(result.length, 1);
  assert.ok(result[0]);
  assert.strictEqual(result[0].id, "G-1");
});

t("BASEで既にdoneだった葉は対象外（過去に受理済みの葉へ遡って強制しない移行措置）", () => {
  const base = tree(leaf({ status: "done", criteria: [{ text: "t", verify: "v", verifyCmd: "true" }] }));
  const head = tree(leaf({ status: "done", criteria: [{ text: "t", verify: "v", verifyCmd: "true" }] }));
  const result = findNewlyDoneLeaves(base, head);
  assert.deepStrictEqual(result, []);
});

t("BASEに存在しない新規の葉が、いきなりdoneで追加された場合も対象になる", () => {
  const base = { meta: {}, nodes: [{ id: "ROOT", kind: "state", children: [] }] };
  const head = tree(leaf({ status: "done" }));
  const result = findNewlyDoneLeaves(base, head);
  assert.strictEqual(result.length, 1);
});

t("HEADでdoneでない葉（todo/doing/blocked等）は対象外", () => {
  const base = tree(leaf({ status: "todo" }));
  const head = tree(leaf({ status: "blocked" }));
  const result = findNewlyDoneLeaves(base, head);
  assert.deepStrictEqual(result, []);
});

// ---- findMissingVerifyCmdViolations ----

t("verifyCmdが無いcriteriaは違反になる", () => {
  const newlyDone = [{ id: "G-1", node: leaf({ criteria: [{ text: "t", verify: "v" }] }) }];
  const violations = findMissingVerifyCmdViolations(newlyDone);
  assert.strictEqual(violations.length, 1);
  assert.ok(violations[0]);
  assert.strictEqual(violations[0].reason, "missing-verifycmd");
});

t("verifyCmdが空文字も違反になる", () => {
  const newlyDone = [{ id: "G-1", node: leaf({ criteria: [{ text: "t", verify: "v", verifyCmd: "   " }] }) }];
  const violations = findMissingVerifyCmdViolations(newlyDone);
  assert.strictEqual(violations.length, 1);
});

t("対照: verifyCmdが設定されていれば違反にならない", () => {
  const newlyDone = [{ id: "G-1", node: leaf({ criteria: [{ text: "t", verify: "v", verifyCmd: "true" }] }) }];
  const violations = findMissingVerifyCmdViolations(newlyDone);
  assert.deepStrictEqual(violations, []);
});

// ---- runVerifyCommands（実行部分はrunCmdを注入して分離） ----

t("verifyCmdの実行結果がexit0なら違反にならない", () => {
  const newlyDone = [{ id: "G-1", node: leaf({ criteria: [{ text: "t", verify: "v", verifyCmd: "node -e 1" }] }) }];
  const violations = runVerifyCommands(newlyDone, () => ({ code: 0, output: "" }));
  assert.deepStrictEqual(violations, []);
});

t("verifyCmdの実行結果が非0なら違反になる（AIが自己申告だけでdoneにする穴を塞ぐ本題）", () => {
  const newlyDone = [{ id: "G-1", node: leaf({ criteria: [{ text: "t", verify: "v", verifyCmd: "false" }] }) }];
  const violations = runVerifyCommands(newlyDone, () => ({ code: 1, output: "FAIL: 境界値のテストで失敗" }));
  assert.strictEqual(violations.length, 1);
  const v = violations[0];
  assert.ok(v);
  assert.strictEqual(v.reason, "verify-failed");
  assert.strictEqual(v.reason === "verify-failed" ? v.cmd : undefined, "false");
});

t("複数criteriaのうち一部だけ失敗しても、失敗した分だけ違反として報告される", () => {
  const newlyDone = [
    {
      id: "G-1",
      node: leaf({
        criteria: [
          { text: "a", verify: "va", verifyCmd: "cmd-ok" },
          { text: "b", verify: "vb", verifyCmd: "cmd-ng" },
        ],
      }),
    },
  ];
  /** @param {string} cmd */
  const runCmd = (cmd) => (cmd === "cmd-ng" ? { code: 1, output: "ng" } : { code: 0, output: "ok" });
  const violations = runVerifyCommands(newlyDone, runCmd);
  assert.strictEqual(violations.length, 1);
  assert.ok(violations[0]);
  assert.strictEqual(violations[0].index, 1);
});

t("verifyCmd未設定の項目はrunVerifyCommandsで二重報告しない（findMissingVerifyCmdViolations側の責務）", () => {
  const newlyDone = [{ id: "G-1", node: leaf({ criteria: [{ text: "t", verify: "v" }] }) }];
  let called = false;
  const violations = runVerifyCommands(newlyDone, () => {
    called = true;
    return { code: 0, output: "" };
  });
  assert.strictEqual(called, false, "verifyCmdが無い項目は実行を試みるべきでない");
  assert.deepStrictEqual(violations, []);
});

// ---- formatDoneGateViolation ----

t("formatDoneGateViolation: missing-verifycmd は人間可読なメッセージになる", () => {
  const msg = formatDoneGateViolation({ id: "G-1", index: 0, reason: "missing-verifycmd" });
  assert.ok(msg.includes("G-1"));
  assert.ok(msg.includes("verifyCmd"));
});

t("formatDoneGateViolation: verify-failed はコマンドと出力末尾を含む", () => {
  const msg = formatDoneGateViolation({
    id: "G-1",
    index: 0,
    reason: "verify-failed",
    cmd: "node tests/x.mjs",
    code: 1,
    output: "line1\nline2\nFAIL: x",
  });
  assert.ok(msg.includes("node tests/x.mjs"));
  assert.ok(msg.includes("FAIL: x"));
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
