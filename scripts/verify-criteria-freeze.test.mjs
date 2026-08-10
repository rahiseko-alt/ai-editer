// verify-criteria-freeze.mjs の核ロジック（ハッシュ計算・BASE/HEAD比較・basisChanges照合）の実テスト。
// git show や実ファイルの docs/roadmap.html には依存せず、純粋関数を直接呼んで判定する。
//
// 2026-08-09の実害の再現：凍結済みの葉 G-EDIT-CAPTION-AI-E1（criteria.text＝「claudeの起動口は
// ちょうど1箇所」）を、実装を直す代わりに criteria.text 自体を書き換えて「達成」と報告した事故が
// 実際に起きた。このテスト（ケース3）は、その状況を機械が違反として検知できることを保証する。
//
// 実行: node scripts/verify-criteria-freeze.test.mjs   (全PASSで exit 0 / 1件でもFAILで exit 1)

import assert from "node:assert";
import {
  criteriaFingerprint,
  extractRoadmapJson,
  findCriteriaFreezeViolations,
  flattenById,
  hashCriteria,
  isCompleteDeclaration,
  isFrozenLeaf,
  isMissingPathError,
} from "./verify-criteria-freeze.mjs";

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n      ${e.message}`);
  }
}

// ---- ヘルパー：最小限の roadmap JSON（rootノード1つの下に対象の葉ノードを1つ置く） ----
function roadmap({ nodeId = "G-1", status = "done", criteria = [], basisChanges, kind = "state" } = {}) {
  return {
    meta: {
      active: "G-1",
      next: "続き",
      handoff: { done: "x", trouble: "無し" },
      ...(basisChanges !== undefined ? { basisChanges } : {}),
    },
    nodes: [
      {
        id: "ROOT",
        kind: "state",
        children: [
          {
            id: nodeId,
            kind,
            status,
            criteria,
          },
        ],
      },
    ],
  };
}

const CRIT_A = [{ text: "claudeの起動口はちょうど1箇所", verify: "grep -c 'spawn(\"claude\"' で1件", evidence: "" }];
const CRIT_B_TAMPERED = [{ text: "claudeの起動口は2箇所まで許容", verify: "grep -c 'spawn(\"claude\"' で2件以下", evidence: "" }];

// ---- extractRoadmapJson ----

t("extractRoadmapJson: script#roadmap-data からJSONを取り出せる", () => {
  const html = `<html><body><script type="application/json" id="roadmap-data">${JSON.stringify({ nodes: [], meta: {} })}</script></body></html>`;
  const data = extractRoadmapJson(html);
  assert.deepStrictEqual(data, { nodes: [], meta: {} });
});

t("extractRoadmapJson: script block が無ければ例外", () => {
  assert.throws(() => extractRoadmapJson("<html></html>"), /roadmap-data script block not found/);
});

// ---- flattenById ----

t("flattenById: 子孫まで再帰的にidをキー化する", () => {
  const nodes = [
    { id: "A", children: [{ id: "B" }, { id: "C", children: [{ id: "D" }] }] },
  ];
  const map = flattenById(nodes);
  assert.deepStrictEqual([...map.keys()].sort(), ["A", "B", "C", "D"]);
});

// ---- criteriaFingerprint / hashCriteria ----

t("criteriaFingerprint: evidence/statusは含まず text/verify だけを見る", () => {
  const withEvidence = [{ text: "t", verify: "v", evidence: "abc123abc123a" }];
  const withoutEvidence = [{ text: "t", verify: "v", evidence: "" }];
  assert.strictEqual(criteriaFingerprint(withEvidence), criteriaFingerprint(withoutEvidence));
});

t("criteriaFingerprint: verifyCmdも凍結対象に含まれる（コマンド差し替えによる骨抜きを防ぐ）", () => {
  const withCmdA = [{ text: "t", verify: "v", verifyCmd: "node tests/a.mjs", evidence: "" }];
  const withCmdB = [{ text: "t", verify: "v", verifyCmd: "true", evidence: "" }]; // 常に成功するダミーへ差し替え
  assert.notStrictEqual(criteriaFingerprint(withCmdA), criteriaFingerprint(withCmdB));
});

t("verifyCmdの無断差し替えは違反になる（宣言なしでverifyCmdだけ緩くする迂回路を塞ぐ）", () => {
  const base = roadmap({ status: "done", criteria: [{ text: "t", verify: "v", verifyCmd: "node tests/strict.mjs" }] });
  const head = roadmap({ status: "done", criteria: [{ text: "t", verify: "v", verifyCmd: "true" }] });
  const violations = findCriteriaFreezeViolations(base, head);
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].reason, "undeclared");
});

t("hashCriteria: text/verifyが同じなら同じハッシュ、違えば違うハッシュ", () => {
  const h1 = hashCriteria(CRIT_A);
  const h2 = hashCriteria(CRIT_A.map((c) => ({ ...c })));
  const h3 = hashCriteria(CRIT_B_TAMPERED);
  assert.strictEqual(h1, h2, "内容が同じなら同一ハッシュ");
  assert.notStrictEqual(h1, h3, "内容が違えば別ハッシュ");
  assert.strictEqual(typeof h1, "string");
  assert.strictEqual(h1.length, 64, "sha256 hexは64文字");
});

// ---- isFrozenLeaf ----

t("isFrozenLeaf: status:todo は凍結対象でない", () => {
  assert.strictEqual(isFrozenLeaf({ id: "x", kind: "state", status: "todo", criteria: [] }), false);
});

t("isFrozenLeaf: status:done かつ葉(子なし)のstateノードは凍結対象", () => {
  assert.strictEqual(isFrozenLeaf({ id: "x", kind: "state", status: "done", criteria: [] }), true);
});

t("isFrozenLeaf: 子を持つノードは凍結対象でない（葉のみ対象）", () => {
  assert.strictEqual(
    isFrozenLeaf({ id: "x", kind: "state", status: "done", children: [{ id: "y" }] }),
    false,
  );
});

t("isFrozenLeaf: kind:workは凍結対象でない（criteriaを持たないノード種別）", () => {
  assert.strictEqual(isFrozenLeaf({ id: "x", kind: "work", status: "done" }), false);
});

t("isFrozenLeaf: statusが無ければ凍結対象でない", () => {
  assert.strictEqual(isFrozenLeaf({ id: "x", kind: "state", criteria: [] }), false);
});

// ---- findCriteriaFreezeViolations: 課題で指定された4ケース ----

t("ケース1: status=todoのノードのcriteriaが変わっても違反にならない", () => {
  const base = roadmap({ status: "todo", criteria: CRIT_A });
  const head = roadmap({ status: "todo", criteria: CRIT_B_TAMPERED });
  const violations = findCriteriaFreezeViolations(base, head);
  assert.deepStrictEqual(violations, [], "todo(着手前)は自由に編集してよい");
});

t("ケース2: status=doneのノードのcriteriaが変わり、basisChangesに正しいid+criteriaHashの新規エントリがあれば違反にならない", () => {
  const base = roadmap({ status: "done", criteria: CRIT_A, basisChanges: [] });
  const newHash = hashCriteria(CRIT_B_TAMPERED);
  const head = roadmap({
    status: "done",
    criteria: CRIT_B_TAMPERED,
    basisChanges: [{ id: "G-1", criteriaHash: newHash, at: "2026-08-09", reason: "仕様変更の正当な理由" }],
  });
  const violations = findCriteriaFreezeViolations(base, head);
  assert.deepStrictEqual(violations, [], "正当な宣言が新規に追加されていれば合格");
});

t("ケース3(事故の再現): status=doneのノードのcriteriaが変わり、basisChangesに何も無ければ違反になる", () => {
  // 2026-08-09の実際の事故：G-EDIT-CAPTION-AI-E1のcriteria.textを実装担当が書き換えて
  // 「達成しました」と報告した状況の再現。
  const base = roadmap({ nodeId: "G-EDIT-CAPTION-AI-E1", status: "done", criteria: CRIT_A });
  const head = roadmap({ nodeId: "G-EDIT-CAPTION-AI-E1", status: "done", criteria: CRIT_B_TAMPERED });
  const violations = findCriteriaFreezeViolations(base, head);
  assert.strictEqual(violations.length, 1, "宣言なしの無断書き換えは検知されなければならない");
  assert.strictEqual(violations[0].id, "G-EDIT-CAPTION-AI-E1");
  assert.strictEqual(violations[0].reason, "undeclared");
});

t("ケース4: status=doneのノードのcriteriaが変わらなければ違反にならない", () => {
  const base = roadmap({ status: "done", criteria: CRIT_A });
  const head = roadmap({ status: "done", criteria: CRIT_A.map((c) => ({ ...c })) });
  const violations = findCriteriaFreezeViolations(base, head);
  assert.deepStrictEqual(violations, [], "内容が同一なら書き換えではない");
});

// ---- 追加の対照テスト（偽の緑を防ぐための境界ケース） ----

t("対照: evidenceだけが埋まった(未充足→充足)場合は違反にならない(text/verifyは不変)", () => {
  const base = roadmap({ status: "done", criteria: [{ text: "t", verify: "v", evidence: "" }] });
  const head = roadmap({ status: "done", criteria: [{ text: "t", verify: "v", evidence: "abcdef1234567" }] });
  const violations = findCriteriaFreezeViolations(base, head);
  assert.deepStrictEqual(violations, [], "evidence充足はcriteria/verify本文の書き換えではない");
});

t("対照: statusがdoneからblockedへ変わっても凍結扱いは継続する(todo以外は全て凍結)", () => {
  const base = roadmap({ status: "done", criteria: CRIT_A });
  const head = roadmap({ status: "blocked", criteria: CRIT_B_TAMPERED });
  const violations = findCriteriaFreezeViolations(base, head);
  assert.strictEqual(violations.length, 1, "doneからblockedへ変わっても凍結済み扱いのまま");
});

t("宣言はあるがBASE時点で既に存在していた場合は「今回PRの新規宣言」でないため違反になる(reason=not-new)", () => {
  const newHash = hashCriteria(CRIT_B_TAMPERED);
  const existingEntry = { id: "G-1", criteriaHash: newHash, at: "2020-01-01", reason: "過去の別件" };
  const base = roadmap({ status: "done", criteria: CRIT_A, basisChanges: [existingEntry] });
  const head = roadmap({ status: "done", criteria: CRIT_B_TAMPERED, basisChanges: [existingEntry] });
  const violations = findCriteriaFreezeViolations(base, head);
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].reason, "not-new");
});

t("削除の迂回路: 凍結済みの葉が丸ごと削除されると、宣言なしでは違反になる", () => {
  // 本文を書き換えずに基準ごと消せば実質的に無効化できてしまう迂回路。
  const base = roadmap({ status: "done", criteria: CRIT_A });
  const head = { meta: {}, nodes: [{ id: "ROOT", kind: "state", children: [] }] };
  const violations = findCriteriaFreezeViolations(base, head);
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].id, "G-1");
  assert.strictEqual(violations[0].reason, "deleted");
});

t("削除の迂回路 対照: BASE側のハッシュで正当な宣言があれば削除は合格する", () => {
  const base = roadmap({ status: "done", criteria: CRIT_A });
  const baseHash = hashCriteria(CRIT_A);
  const head = {
    meta: { basisChanges: [{ id: "G-1", criteriaHash: baseHash, at: "2026-08-10", reason: "この葉は不要と判断し廃止" }] },
    nodes: [{ id: "ROOT", kind: "state", children: [] }],
  };
  const violations = findCriteriaFreezeViolations(base, head);
  assert.deepStrictEqual(violations, []);
});

t("todoへ戻す迂回路: 凍結済みの葉のstatusをtodoへ戻すと、宣言なしでは違反になる", () => {
  // 一旦アンフリーズしてから自由に基準を書き換える迂回路（この時点ではcriteriaは不変でもよい）。
  const base = roadmap({ status: "doing", criteria: CRIT_A });
  const head = roadmap({ status: "todo", criteria: CRIT_A.map((c) => ({ ...c })) });
  const violations = findCriteriaFreezeViolations(base, head);
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].reason, "unfrozen");
});

t("todoへ戻す迂回路 対照: BASE側のハッシュで正当な宣言があればtodoへ戻すのは合格する", () => {
  const base = roadmap({ status: "doing", criteria: CRIT_A });
  const baseHash = hashCriteria(CRIT_A);
  const head = roadmap({
    status: "todo",
    criteria: CRIT_A.map((c) => ({ ...c })),
    basisChanges: [{ id: "G-1", criteriaHash: baseHash, at: "2026-08-10", reason: "再分解のため一旦差し戻す" }],
  });
  const violations = findCriteriaFreezeViolations(base, head);
  assert.deepStrictEqual(violations, []);
});

t("非葉化の迂回路: 凍結済みの葉に子を足して非葉化すると、宣言なしでは違反になる", () => {
  const base = roadmap({ status: "done", criteria: CRIT_A });
  const head = {
    meta: { active: "G-1", next: "続き", handoff: { done: "x", trouble: "無し" } },
    nodes: [
      { id: "ROOT", kind: "state", children: [
        { id: "G-1", kind: "state", status: "done", criteria: [], children: [{ id: "G-1-a", kind: "state", status: "todo", criteria: [] }] },
      ] },
    ],
  };
  const violations = findCriteriaFreezeViolations(base, head);
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].reason, "unfrozen");
});

// ---- basisChangesの必須フィールド(at/reason)検証（CodeRabbit指摘対応） ----
// id/criteriaHashが一致するだけでは宣言として認めない。理由の明示(at/reason)が
// 欠けている宣言は「無い」ものとして扱い、違反(undeclared)になるべき。

t("isCompleteDeclaration: id/criteriaHash/at/reasonが全て揃っていれば完全な宣言", () => {
  const entry = { id: "G-1", criteriaHash: "abc", at: "2026-08-09", reason: "仕様変更" };
  assert.strictEqual(isCompleteDeclaration(entry, "G-1", "abc"), true);
});

t("isCompleteDeclaration: atが欠落していれば不完全", () => {
  const entry = { id: "G-1", criteriaHash: "abc", reason: "仕様変更" };
  assert.strictEqual(isCompleteDeclaration(entry, "G-1", "abc"), false);
});

t("isCompleteDeclaration: atが空文字なら不完全", () => {
  const entry = { id: "G-1", criteriaHash: "abc", at: "", reason: "仕様変更" };
  assert.strictEqual(isCompleteDeclaration(entry, "G-1", "abc"), false);
});

t("isCompleteDeclaration: reasonが欠落していれば不完全", () => {
  const entry = { id: "G-1", criteriaHash: "abc", at: "2026-08-09" };
  assert.strictEqual(isCompleteDeclaration(entry, "G-1", "abc"), false);
});

t("isCompleteDeclaration: reasonが空文字なら不完全", () => {
  const entry = { id: "G-1", criteriaHash: "abc", at: "2026-08-09", reason: "" };
  assert.strictEqual(isCompleteDeclaration(entry, "G-1", "abc"), false);
});

t("境界: basisChangesにid+criteriaHashは一致するがatが空文字 → 違反になる", () => {
  const base = roadmap({ status: "done", criteria: CRIT_A, basisChanges: [] });
  const newHash = hashCriteria(CRIT_B_TAMPERED);
  const head = roadmap({
    status: "done",
    criteria: CRIT_B_TAMPERED,
    basisChanges: [{ id: "G-1", criteriaHash: newHash, at: "", reason: "仕様変更の正当な理由" }],
  });
  const violations = findCriteriaFreezeViolations(base, head);
  assert.strictEqual(violations.length, 1, "atが空文字の宣言は「無い」ものとして扱われるべき");
  assert.strictEqual(violations[0].reason, "undeclared");
});

t("境界: basisChangesにid+criteriaHashは一致するがatが欠落 → 違反になる", () => {
  const base = roadmap({ status: "done", criteria: CRIT_A, basisChanges: [] });
  const newHash = hashCriteria(CRIT_B_TAMPERED);
  const head = roadmap({
    status: "done",
    criteria: CRIT_B_TAMPERED,
    basisChanges: [{ id: "G-1", criteriaHash: newHash, reason: "仕様変更の正当な理由" }],
  });
  const violations = findCriteriaFreezeViolations(base, head);
  assert.strictEqual(violations.length, 1, "atが欠落した宣言は「無い」ものとして扱われるべき");
  assert.strictEqual(violations[0].reason, "undeclared");
});

t("境界: basisChangesにid+criteriaHashは一致するがreasonが空文字 → 違反になる", () => {
  const base = roadmap({ status: "done", criteria: CRIT_A, basisChanges: [] });
  const newHash = hashCriteria(CRIT_B_TAMPERED);
  const head = roadmap({
    status: "done",
    criteria: CRIT_B_TAMPERED,
    basisChanges: [{ id: "G-1", criteriaHash: newHash, at: "2026-08-09", reason: "" }],
  });
  const violations = findCriteriaFreezeViolations(base, head);
  assert.strictEqual(violations.length, 1, "reasonが空文字の宣言は「無い」ものとして扱われるべき");
  assert.strictEqual(violations[0].reason, "undeclared");
});

t("境界: basisChangesにid+criteriaHashは一致するがreasonが欠落 → 違反になる", () => {
  const base = roadmap({ status: "done", criteria: CRIT_A, basisChanges: [] });
  const newHash = hashCriteria(CRIT_B_TAMPERED);
  const head = roadmap({
    status: "done",
    criteria: CRIT_B_TAMPERED,
    basisChanges: [{ id: "G-1", criteriaHash: newHash, at: "2026-08-09" }],
  });
  const violations = findCriteriaFreezeViolations(base, head);
  assert.strictEqual(violations.length, 1, "reasonが欠落した宣言は「無い」ものとして扱われるべき");
  assert.strictEqual(violations[0].reason, "undeclared");
});

t("境界 対照: id+criteriaHash+at+reasonが全て揃っていれば引き続き合格する", () => {
  const base = roadmap({ status: "done", criteria: CRIT_A, basisChanges: [] });
  const newHash = hashCriteria(CRIT_B_TAMPERED);
  const head = roadmap({
    status: "done",
    criteria: CRIT_B_TAMPERED,
    basisChanges: [{ id: "G-1", criteriaHash: newHash, at: "2026-08-09", reason: "仕様変更の正当な理由" }],
  });
  const violations = findCriteriaFreezeViolations(base, head);
  assert.deepStrictEqual(violations, [], "at/reasonが揃った正当な宣言は引き続き合格すべき");
});

// ---- isMissingPathError（CodeRabbit指摘対応：BASE読み取りエラーの握りつぶし防止） ----
// git show が「そのcommitにパスが存在しない」ことを示すエラーだけをスキップ対象とし、
// refが無効・gitコマンド自体の失敗等は再スローされるべき、という判定の純粋関数部分のテスト。

t("isMissingPathError: 'does not exist in' を含むstderrはtrue（refは有効だがそのcommitに無い）", () => {
  const error = { stderr: "fatal: path 'docs/roadmap.html' does not exist in 'HEAD'\n", message: "Command failed" };
  assert.strictEqual(isMissingPathError(error), true);
});

t("isMissingPathError: 'exists on disk, but not in' を含むstderrはtrue（ワークツリーにはあるがcommitに無い）", () => {
  const error = {
    stderr: "fatal: path 'docs/roadmap.html' exists on disk, but not in '4b825dc'\n",
    message: "Command failed",
  };
  assert.strictEqual(isMissingPathError(error), true);
});

t("isMissingPathError: 'invalid object name'（refが無効）はfalse＝再スロー対象", () => {
  const error = { stderr: "fatal: invalid object name 'nonexistent-ref-xyz'.\n", message: "Command failed" };
  assert.strictEqual(isMissingPathError(error), false);
});

t("isMissingPathError: stderrが無くmessageだけの場合もmessageを見る", () => {
  const error = { message: "fatal: path 'docs/roadmap.html' does not exist in 'abc123'" };
  assert.strictEqual(isMissingPathError(error), true);
});

t("isMissingPathError: stderr/messageどちらも無関係な内容ならfalse", () => {
  const error = { stderr: "git: command not found", message: "spawnSync git ENOENT" };
  assert.strictEqual(isMissingPathError(error), false);
});

t("meta.basisChanges未設定(undefined)でも例外にならず、単に宣言0件として扱う", () => {
  const base = { meta: {}, nodes: [{ id: "ROOT", kind: "state", children: [{ id: "G-1", kind: "state", status: "done", criteria: CRIT_A }] }] };
  const head = { meta: {}, nodes: [{ id: "ROOT", kind: "state", children: [{ id: "G-1", kind: "state", status: "done", criteria: CRIT_B_TAMPERED }] }] };
  const violations = findCriteriaFreezeViolations(base, head);
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].reason, "undeclared");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
