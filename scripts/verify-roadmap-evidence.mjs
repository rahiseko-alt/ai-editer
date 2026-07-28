#!/usr/bin/env node
// evidence の機械リンタ（“自己採点”を機械で閉じる）。
// docs/roadmap.html の JSON を parse し、全 criteria の非空 evidence が
// 「偽造不能な外部事実」パターンに合致するかを検査する。合致しなければ exit 1。
// あわせて meta.active が実在ノードIDを指すか（stale 防止）も検査する。
//
// 許可する外部事実（AGENTS.md の evidence 規律と一致）:
//   - commit SHA            : 7〜40桁の hex
//   - CI run               : actions/runs/<数字>  もしくは https://.../actions/runs/<数字>
//   - 任意の URL           : http(s)://...（公開URL・run URL・alert URL 等）
//   - デプロイID           : dpl_<英数字>（Vercel）
// スクショ・「レビューした」等の自己申告は不許可（＝これらは非空でも弾く）。
//
// あわせて原子性（AGENTS.md「検証の規律」＝1葉=1事実=1verify）を機械強制する:
//   - 子を持つ状態ノードに criteria を付けてはいけない（受入条件は葉にのみ許可）
//   - 子を持たない状態ノードは criteria をちょうど1件持たなければならない
//     （0件＝分解未完了／2件以上＝原子性違反＝独立した葉へ分割すること）
//   - 作業ノード(work)に criteria を付けてはいけない（status/commit/done_at で管理）
// これはAIの裁量やレビュー時の見落としに委ねず、どこまで割るかの基準をCIで機械的に閉じる。
// 例外：meta.template:true（白紙テンプレ・コピー直後）は、criteria 0件の ROOT プレースホルダを
//   意図的に許容する（下の nodes 空チェック／nav 必須チェックが代わりに効く）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const roadmapPath = resolve(__dirname, "..", "docs", "roadmap.html");

const EVIDENCE_PATTERNS = [
  /^[0-9a-f]{7,40}$/, // commit SHA
  /^actions\/runs\/\d+$/, // CI run（短縮表記）
  /^https?:\/\/\S+$/, // 任意の外部URL（run/alert/公開URL）
  /^dpl_[A-Za-z0-9]+$/, // Vercel デプロイID
];

function extractRoadmapJson(html) {
  const m = html.match(
    /<script type="application\/json" id="roadmap-data">([\s\S]*?)<\/script>/,
  );
  if (!m) throw new Error("roadmap-data script block not found");
  return JSON.parse(m[1]);
}

function walk(node, visit) {
  visit(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visit);
  }
}

function main() {
  const html = readFileSync(roadmapPath, "utf8");
  const data = extractRoadmapJson(html);

  const ids = new Set();
  const violations = [];
  const depsMap = new Map(); // id -> [依存先id...]（道順/依存。時系列は背骨でなくここで表す）

  const meta = data.meta || {};
  const isTemplate = meta.template === true;

  let decomposed = 0; // 子を持つ（分解された）ノード数
  let leavesWithCriteria = 0; // 受入条件を持つ葉状態の数

  for (const root of data.nodes) {
    walk(root, (node) => {
      if (node.id) ids.add(node.id);
      if (node.id && Array.isArray(node.deps)) depsMap.set(node.id, node.deps);
      const hasChildren = Array.isArray(node.children) && node.children.length > 0;
      const critCount = Array.isArray(node.criteria) ? node.criteria.length : 0;
      if (hasChildren) decomposed++;
      if (!hasChildren && critCount > 0) {
        leavesWithCriteria++;
      }

      // 原子性の機械強制（AGENTS.md「検証の規律」＝1葉=1事実=1verify）。
      // これまでAI裁量に委ねられ「無視されることが多い」と指摘されたため、CIで強制する。
      if (hasChildren && critCount > 0) {
        violations.push(
          `${node.id}: 子を持つ状態ノードに criteria が付いています（受入条件は葉にのみ許可。分解済みなら判定は子に委譲すること）`,
        );
      }
      if (!isTemplate && !hasChildren && node.kind === "state" && critCount === 0) {
        violations.push(
          `${node.id}: 子を持たない状態ノードなのに criteria がありません（原子まで割って verify を置くこと。まだ分解途中なら children を追加すること）`,
        );
      }
      if (!hasChildren && node.kind === "state" && critCount > 1) {
        violations.push(
          `${node.id}: 1葉の criteria に${critCount}件の受入条件が同居しています（原子性違反＝「独立して落ちうる受入事実」が2つ以上）。各事実を独立した子の葉に分割すること`,
        );
      }
      if (node.kind === "work" && critCount > 0) {
        violations.push(
          `${node.id}: 作業ノード(work)に criteria が付いています（criteria は状態ノード(state)専用。作業は status/commit/done_at で管理すること）`,
        );
      }

      for (const c of node.criteria || []) {
        const ev = (c.evidence ?? "").trim();
        if (ev === "") continue; // 未充足は対象外（☐ のまま）
        const ok = EVIDENCE_PATTERNS.some((re) => re.test(ev));
        if (!ok) {
          violations.push(
            `${node.id}: evidence "${ev}" は外部事実パターンに合致しません（commit SHA / actions/runs/<n> / http(s):// / dpl_ のみ許可）`,
          );
        }
      }
    });
  }

  // deps（依存関係）の機械検査：実在IDを指すか＋循環がないか。
  // 依存は「道順」であって背骨ではない。ここで実在・非循環を機械強制し、壊れた依存を CI で弾く。
  for (const [id, deps] of depsMap) {
    for (const d of deps) {
      if (!ids.has(d)) {
        violations.push(
          `${id}: deps "${d}" は実在ノードIDを指していません（依存先が存在しない）`,
        );
      }
      if (d === id) {
        violations.push(`${id}: deps が自分自身を指しています（自己依存）`);
      }
    }
  }
  // 循環検出（DFS。3色マーキングで back-edge を見つける）。
  {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    const cyclePath = [];
    let cycleFound = null;
    const dfs = (id, stack) => {
      if (cycleFound) return;
      color.set(id, GRAY);
      for (const d of depsMap.get(id) || []) {
        if (!ids.has(d)) continue; // 実在チェックは上で別途報告済み
        const c = color.get(d) ?? WHITE;
        if (c === GRAY) {
          cycleFound = [...stack, id, d];
          return;
        }
        if (c === WHITE) dfs(d, [...stack, id]);
        if (cycleFound) return;
      }
      color.set(id, BLACK);
    };
    for (const id of depsMap.keys()) {
      if ((color.get(id) ?? WHITE) === WHITE) dfs(id, []);
      if (cycleFound) break;
    }
    if (cycleFound) {
      violations.push(
        `deps に循環があります（依存は道順であって循環してはいけない）: ${cycleFound.join(" → ")}`,
      );
    }
  }

  // 「案件の絶対起点＝原子ツリー」を機械で裏付ける構造検査。
  // 平坦な md 代替・空/退化したロードマップを CI で弾く（AI の裁量ゼロ）。
  // 例外：白紙テンプレ(meta.template:true)は「まだ描いていない」状態を許容する代わりに、
  //       コピー先が最初に辿る meta.handoff.nav（初回接続トップ手順ナビ）を必須にする。
  if (!Array.isArray(data.nodes) || data.nodes.length === 0) {
    violations.push(
      "nodes が空です（テンプレでも ROOT プレースホルダを1つ残すこと。ゴールを頂点にした原子ツリーが未作成）",
    );
  }
  if (isTemplate) {
    const nav = (meta.handoff || {}).nav;
    if (
      !Array.isArray(nav) ||
      nav.length === 0 ||
      nav.some((s) => String(s ?? "").trim() === "")
    ) {
      violations.push(
        "meta.template:true なのに meta.handoff.nav（初回接続トップ手順ナビ）が空です。コピー先が最初に辿る手順を配列で書くこと",
      );
    }
  } else {
    if (decomposed === 0) {
      violations.push(
        "分解されたノードが1つもありません（ゴールを子条件へ割った『ツリー』になっていない＝平坦なチェックリストは不可）",
      );
    }
    if (leavesWithCriteria === 0) {
      violations.push(
        "受入条件(criteria)を持つ葉が1つもありません（原子まで割って各葉に verify を置くこと）",
      );
    }
  }

  const active = meta.active;
  if (!active || String(active).trim() === "") {
    violations.push("meta.active が未設定です（現在地ノードIDを指すこと）");
  } else if (!ids.has(active)) {
    violations.push(
      `meta.active "${active}" は実在ノードIDを指していません（stale pointer）`,
    );
  }
  if (!meta.next || String(meta.next).trim() === "") {
    violations.push("meta.next が未設定です（次の一手を書くこと）");
  }
  const handoff = meta.handoff || {};
  for (const key of ["done", "trouble"]) {
    if (!handoff[key] || String(handoff[key]).trim() === "") {
      violations.push(
        `meta.handoff.${key} が未設定です（①今回実施 / ②今回トラブル。無ければ「無し」と書く）`,
      );
    }
  }

  if (violations.length > 0) {
    console.error("✗ roadmap evidence リンタ: 不正を検出");
    for (const v of violations) console.error("  - " + v);
    process.exit(1);
  }

  console.log(
    `✓ roadmap evidence リンタ: OK（ノード ${ids.size} 件、不正 evidence なし）`,
  );
}

main();
