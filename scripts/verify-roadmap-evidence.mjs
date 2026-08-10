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
// 例外：status:"frozen"（凍結した未来枝）は criteria 0件を許容する。着手条件が揃うまで言語化分解しない
//   枝を、ツリーの形として残すため。凍結を解く＝status から frozen を外した瞬間に criteria 必須が復活する。

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

/**
 * @param {string} html
 * @returns {any}
 */
export function extractRoadmapJson(html) {
  const m = html.match(
    /<script type="application\/json" id="roadmap-data">([\s\S]*?)<\/script>/,
  );
  if (!m || m[1] === undefined) throw new Error("roadmap-data script block not found");
  return JSON.parse(m[1]);
}

/**
 * @param {any} node
 * @param {(node: any) => void} visit
 * @returns {void}
 */
function walk(node, visit) {
  visit(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visit);
  }
}

/**
 * parse済みの roadmap JSON（{nodes, meta}）を検査し、違反メッセージの配列と
 * 実在ノードID数を返す純粋関数。fs/process に一切依存しないためテストしやすい
 * （main() はこの結果を読んで exit code に変換するだけの薄いI/O層にする）。
 * @param {any} data
 * @returns {{ violations: string[], idCount: number }}
 */
export function findRoadmapViolations(data) {
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
      // status:"frozen"（凍結した未来枝）は除外する。2026-08-09 マスター指示により、ゴール直下の
      // ②（PWA）③（SaaS）は「①が納品できる状態になるまで着手しない」＝初めから凍結で、言語化分解
      // （criteria/verify）もしない枝として置く。着手条件が揃っていない枝に criteria を書かせると、
      // 実装より先に基準を凍結できず「後から自分に都合よく緩める」余地を作るため、書かせない方が正しい。
      // 凍結を解くとき status から frozen を外す＝その瞬間に criteria 必須が自動で復活する。
      const isFrozen = node.status === "frozen";
      if (!isTemplate && !isFrozen && !hasChildren && node.kind === "state" && critCount === 0) {
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
        if (ev === "") {
          // 未充足の evidence 自体は「まだ検証待ち」として許容する（doing 等）。
          // ただし status:"done"（＝「達成した」と宣言している）のに evidence が空のままなのは、
          // 本人の自己申告だけで完了扱いにできる穴になるため、ここだけは禁止する。
          if (node.status === "done") {
            violations.push(
              `${node.id}: status が "done" なのに evidence が空です（自己申告だけで完了扱いにできてしまう。外部事実（CI run URL 等）を記入してから done にすること）`,
            );
          }
          continue;
        }
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
    /** @type {string[] | null} */
    let cycleFound = null;
    /**
     * @param {string} id
     * @param {string[]} stack
     * @returns {void}
     */
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
    if (cycleFound !== null) {
      const path = /** @type {string[]} */ (cycleFound);
      violations.push(
        `deps に循環があります（依存は道順であって循環してはいけない）: ${path.join(" → ")}`,
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

  return { violations, idCount: ids.size };
}

function main() {
  const html = readFileSync(roadmapPath, "utf8");
  const data = extractRoadmapJson(html);
  const { violations, idCount } = findRoadmapViolations(data);

  if (violations.length > 0) {
    console.error("✗ roadmap evidence リンタ: 不正を検出");
    for (const v of violations) console.error("  - " + v);
    process.exit(1);
  }

  console.log(
    `✓ roadmap evidence リンタ: OK（ノード ${idCount} 件、不正 evidence なし）`,
  );
}

// このファイルが直接実行された時だけ main() を走らせる（テストからの import 時は走らせない）。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
