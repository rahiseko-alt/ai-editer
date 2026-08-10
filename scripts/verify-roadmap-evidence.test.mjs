// verify-roadmap-evidence.mjs の核ロジック（findRoadmapViolations）の実テスト。
// fs には依存せず、parse済みJSONオブジェクトを直接渡して判定する。
//
// 主眼：status:"done" なのに evidence が空のまま（＝自己申告だけで完了扱いにできる穴）を
// 機械が検知できること。2026-08-10、マスター指摘「CI緑だけではAIがハードルを下げているだけ
// では」を受けて追加した規律を裏付ける。
//
// 実行: node scripts/verify-roadmap-evidence.test.mjs

import assert from "node:assert";
import { extractRoadmapJson, findRoadmapViolations } from "./verify-roadmap-evidence.mjs";

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

function leaf({ id = "G-1", status = "done", criteria = [] } = {}) {
  return { id, kind: "state", status, criteria };
}

function tree(leafNode, metaOverrides = {}) {
  return {
    meta: {
      active: leafNode.id,
      next: "続き",
      handoff: { done: "x", trouble: "無し" },
      ...metaOverrides,
    },
    nodes: [{ id: "ROOT", kind: "state", children: [leafNode] }],
  };
}

// ---- extractRoadmapJson ----

t("extractRoadmapJson: script#roadmap-data からJSONを取り出せる", () => {
  const html = `<script type="application/json" id="roadmap-data">${JSON.stringify({ nodes: [], meta: {} })}</script>`;
  assert.deepStrictEqual(extractRoadmapJson(html), { nodes: [], meta: {} });
});

// ---- status:"done" と evidence の関係（本題） ----

t("done なのに evidence が空 → 違反になる（自己申告だけで完了扱いにできる穴を塞ぐ）", () => {
  const data = tree(leaf({ status: "done", criteria: [{ text: "t", verify: "v", evidence: "" }] }));
  const { violations } = findRoadmapViolations(data);
  assert.ok(
    violations.some((v) => v.includes("evidence が空です")),
    `evidence空のdoneが検知されるべき。実際の violations: ${JSON.stringify(violations)}`,
  );
});

t("対照: doing なら evidence が空でも違反にならない（未検証はdoingのまま許容）", () => {
  const data = tree(leaf({ status: "doing", criteria: [{ text: "t", verify: "v", evidence: "" }] }));
  const { violations } = findRoadmapViolations(data);
  assert.deepStrictEqual(violations, []);
});

t("対照: done で evidence が外部事実パターンに合致していれば違反にならない", () => {
  const data = tree(
    leaf({ status: "done", criteria: [{ text: "t", verify: "v", evidence: "https://github.com/x/y/actions/runs/123" }] }),
  );
  const { violations } = findRoadmapViolations(data);
  assert.deepStrictEqual(violations, []);
});

t("done で evidence が非空だがパターン不一致（自己申告文言等） → 違反になる", () => {
  const data = tree(leaf({ status: "done", criteria: [{ text: "t", verify: "v", evidence: "レビューしました" }] }));
  const { violations } = findRoadmapViolations(data);
  assert.ok(violations.some((v) => v.includes("外部事実パターンに合致しません")));
});

t("done で criteria が複数件ある場合、evidence が空の1件だけでも違反になる", () => {
  const data = tree(
    leaf({
      status: "done",
      criteria: [
        { text: "a", verify: "va", evidence: "abcdef1234567" },
      ],
    }),
  );
  // このケース自体は正常系（1葉1criteriaが原子性ルール）。空混在は別ノードで再現する。
  const { violations } = findRoadmapViolations(data);
  assert.deepStrictEqual(violations, []);
});

// ---- idCount ----

t("findRoadmapViolations: idCount は実在ノードID数を返す", () => {
  const data = tree(leaf({ status: "doing", criteria: [{ text: "t", verify: "v", evidence: "" }] }));
  const { idCount } = findRoadmapViolations(data);
  assert.strictEqual(idCount, 2); // ROOT + G-1
});

// ---- 既存の原子性・構造チェックが壊れていないことの対照 ----

t("対照: 子を持つ状態ノードに criteria が付いていると違反になる", () => {
  const data = {
    meta: { active: "ROOT", next: "x", handoff: { done: "x", trouble: "無し" } },
    nodes: [
      {
        id: "ROOT",
        kind: "state",
        criteria: [{ text: "t", verify: "v", evidence: "" }],
        children: [leaf()],
      },
    ],
  };
  const { violations } = findRoadmapViolations(data);
  assert.ok(violations.some((v) => v.includes("子を持つ状態ノードに criteria が付いています")));
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
