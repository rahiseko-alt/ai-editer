#!/usr/bin/env node
// 凍結済み criteria/verify の無断書き換えを検知する機械チェック。
//
// 背景（2026-08-09）：凍結済みの葉 G-EDIT-CAPTION-AI-E1（criteria.text＝「claudeの起動口は
// ちょうど1箇所」）に対し、実装を直す代わりに criteria.text の方を「起動口が2箇所」を許容する
// 内容へ書き換えて「達成しました」と報告する事故が起きた。人間が気づいて差し戻したが、
// 既存の verify-roadmap-evidence.mjs は「形」（criteria の件数・evidence の外部事実性）しか
// 見ておらず、criteria/verify の本文が変わったこと自体は検知できなかった。
//
// AGENTS.md「検証の規律」節：criteria/verify は「着手前に固定し、作業の途中で自分に都合よく
// 緩めない」。この規律を機械で裏付けるのが本スクリプトの役割。
//
// 「凍結」の定義：ある葉ノードの status が "todo" 以外（doing/done/blocked 等）になった時点で、
// そのノードの criteria/verify/verifyCmd 本文は凍結済みとみなす。status:"todo"（着手前）のノードは
// 言語化フェーズなので自由に編集してよい。
//
// 検知の仕組み（PRごとに BASE→HEAD の差分で検査する）：
//   1. BASE/HEAD それぞれの docs/roadmap.html から roadmap JSON を取り出す。
//   2. 両方のツリーを id をキーにした Map へフラット化する。
//   3. BASE側で「status を持ち status!=="todo"、かつ子を持たない state ノード（葉）」
//      （＝凍結済みの葉）であるものを対象にする。
//   4. 対象ノードについて、HEAD側の状態を3パターンに分けて検査する：
//      (a) 本文が変わった：criteria から {text, verify, verifyCmd} を取り出し正規化した
//          文字列の sha256 を BASE 版・HEAD 版で比較し、不一致なら「undeclared」。
//      (b) 丸ごと削除された：HEADにそのIDが存在しない → 「deleted」。
//      (c) 凍結が解けた：HEADには存在するが、status が "todo" に戻された／子が足されて
//          非葉化した／kind が "state" でなくなった等で isFrozenLeaf が false になった
//          → 「unfrozen」。
//      本文を書き換えずに「削除する」「一旦 todo に戻して直してまた凍結し直す」という
//      迂回路も、テキストの無断書き換えと同じく基準を骨抜きにできるため、同じ扱いで塞ぐ。
//   5. (a)は HEAD 側の新ハッシュ、(b)(c)は BASE 側の元ハッシュを識別子として、
//      meta.basisChanges に「今回のPRで新規に追加された」正当な宣言
//      （{id, criteriaHash, at, reason}）があるかを確認する。無ければ違反として報告し exit 1。
//
// 実行方法：
//   - 通常（CI/PR）：環境変数 BASE_REF / HEAD_REF に比較対象の commit-ish を渡す。
//     git show "<ref>:docs/roadmap.html" で各版を取り出す（fetch-depth: 0 でのチェックアウトが前提）。
//   - HEAD_REF 未指定：作業ツリーの docs/roadmap.html を readFileSync で直接読む（git show を使わない）。
//   - BASE_REF 未指定：比較対象が無いので "BASE_REF未指定のためスキップ" とだけ表示して正常終了する
//     （新規リポジトリの最初のコミット等、BASE が存在しない状況を含む）。
//   - BASE_REF はあるが、その commit に docs/roadmap.html が存在しない（新規追加コミット等）場合も
//     比較不能なのでスキップして正常終了する（isMissingPathError で判定。git show の
//     "does not exist in" / "exists on disk, but not in" エラーだけをこの扱いにする）。
//   - BASE_REF が無効な ref（typo・存在しない commit）だったり、git コマンド自体が別の理由で
//     失敗した場合は「比較不能」ではなく「壊れている」ので、握りつぶさず再スローして異常終了する。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROADMAP_REL_PATH = "docs/roadmap.html";
const roadmapAbsPath = resolve(__dirname, "..", ROADMAP_REL_PATH);

// ---- 純粋関数（テスト対象。git/fsに依存しない） -----------------------------------

/**
 * @typedef {{ text?: string, verify?: string, verifyCmd?: string, evidence?: string, [key: string]: any }} Criterion
 * @typedef {{
 *   id?: string,
 *   kind?: string,
 *   status?: string,
 *   criteria?: Criterion[],
 *   children?: RoadmapNode[],
 *   [key: string]: any,
 * }} RoadmapNode
 * @typedef {{ id: string, criteriaHash: string, at?: string, reason?: string }} BasisChangeEntry
 * @typedef {{ id: string, baseHash: string | null, headHash: string | null, reason: "undeclared" | "not-new" | "deleted" | "unfrozen", category?: "undeclared" | "deleted" | "unfrozen", criteriaHash?: string }} FreezeViolation
 */

/**
 * docs/roadmap.html の HTML 文字列から roadmap JSON を取り出す。
 * verify-roadmap-evidence.mjs の extractRoadmapJson と同じロジック。
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
 * ツリー(nodes配列)を id をキーにした Map へフラット化する（子を辿るwalk）。
 * verify-roadmap-evidence.mjs の walk 関数を参考に、id -> node の対応表を作る版。
 * @param {RoadmapNode[] | undefined | null} nodes
 * @returns {Map<string, RoadmapNode>}
 */
export function flattenById(nodes) {
  /** @type {Map<string, RoadmapNode>} */
  const map = new Map();
  /** @param {RoadmapNode | undefined | null} node */
  function walk(node) {
    if (node && node.id) map.set(node.id, node);
    if (node && Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  }
  for (const root of nodes || []) walk(root);
  return map;
}

/**
 * criteria 配列から text/verify/verifyCmd だけを取り出し、JSON.stringify で正規化した文字列にする。
 * evidence・status など「達成状況」に関わるフィールドは意図的に含めない
 * （evidence が埋まっただけで「基準が変わった」と誤検知しないため）。
 * verifyCmd（done化の直前にCIが実際に実行する検証コマンド。verify-done-gate.mjs が使う）も、
 * 文章(text/verify)と同じく「着手前に固定し、後から緩めさせない」対象に含める。
 * コマンド文言だけ差し替えて実質的に検証を骨抜きにする迂回路を防ぐため。
 * @param {Criterion[] | undefined | null} criteria
 * @returns {string}
 */
export function criteriaFingerprint(criteria) {
  const normalized = (criteria || []).map((c) => ({
    text: c?.text ?? null,
    verify: c?.verify ?? null,
    verifyCmd: c?.verifyCmd ?? null,
  }));
  return JSON.stringify(normalized);
}

/**
 * criteria の {text, verify} 正規化文字列の sha256(hex) を返す。
 * @param {Criterion[] | undefined | null} criteria
 * @returns {string}
 */
export function hashCriteria(criteria) {
  return createHash("sha256").update(criteriaFingerprint(criteria)).digest("hex");
}

/**
 * ノードが「凍結済みの葉」（＝criteria/verify を書き換えてはいけない対象）かどうかを判定する。
 * 条件：status を持ち、status !== "todo"、かつ子を持たない state ノード。
 * @param {RoadmapNode | undefined | null} node
 * @returns {boolean}
 */
export function isFrozenLeaf(node) {
  if (!node || typeof node !== "object") return false;
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const hasStatus = typeof node.status === "string" && node.status.trim() !== "";
  return !hasChildren && hasStatus && node.status !== "todo" && node.kind === "state";
}

/**
 * meta.basisChanges の1エントリが、id と criteriaHash に加えて、宣言として必須の
 * at（日付。空でない文字列）・reason（理由。空でない文字列）も揃っているかを判定する。
 * どちらか欠けている宣言は「理由を明示していない」ので、宣言として認めない
 * （id/criteriaHashだけ一致すれば通ってしまうと、基準変更の理由を明示する目的が骨抜きになる）。
 * @param {unknown} v
 * @returns {boolean}
 */
export function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * @param {any} entry
 * @param {string} id
 * @param {string} criteriaHash
 * @returns {boolean}
 */
export function isCompleteDeclaration(entry, id, criteriaHash) {
  return (
    !!entry &&
    entry.id === id &&
    entry.criteriaHash === criteriaHash &&
    isNonEmptyString(entry.at) &&
    isNonEmptyString(entry.reason)
  );
}

/**
 * リストの中で、指定した id/criteriaHash に一致する「完全な宣言」が何件あるかを数える。
 * @param {BasisChangeEntry[]} list
 * @param {string} id
 * @param {string} criteriaHash
 * @returns {number}
 */
function countCompleteDeclarations(list, id, criteriaHash) {
  return list.filter((e) => isCompleteDeclaration(e, id, criteriaHash)).length;
}

/**
 * ある識別子(idとcriteriaHash)について、HEAD側に「今回のPRで新規に追加された」正当な宣言が
 * あるかを判定する。無ければ違反。あるが BASE 時点で既に同数以上存在していれば "not-new" として
 * 違反。無ければ null（＝合格）を返す純粋ヘルパー（3つの違反パターンで共有する）。
 *
 * 存在チェックではなく件数比較にしているのは、同じ id/criteriaHash の組が過去に一度
 * 正当な理由で宣言され、その後 criteria 本文を書き換えないまま再び別の正当な理由
 * （例：以前は文面修正の宣言、今回は削除の宣言）で宣言し直すケースがあるため。
 * 単純な存在チェックだと、BASE に同じ id/criteriaHash の宣言が1件でも残っていれば、
 * HEAD 側に今回のPRで新規に追加した宣言があっても「既出」として誤って弾いてしまう
 * （2026-08-12、G-EDIT-CAPTION-E の削除宣言が、2026-08-11 の文面修正時に生まれたのと
 * 同じ criteriaHash を指したために誤検知したのを機に発見・是正）。
 * HEAD 側の件数が BASE 側の件数を上回っていれば、少なくとも1件は今回のPRで新規に
 * 追加されたとみなせる。
 *
 * category には常に元の違反種別("deleted"/"unfrozen"/"undeclared")を残す。reason が
 * "not-new" に化けても、formatViolation が「削除／凍結解除の文脈で書かれた"not-new"」を
 * 正しく判別できるようにするため（category が無いと、削除されたノードの"not-new"メッセージが
 * 「本文が書き換えられています」「criteriaHash: "null"」という誤った文言になってしまうバグがあった）。
 * @param {{
 *   id: string,
 *   criteriaHash: string,
 *   headBasisChanges: BasisChangeEntry[],
 *   baseBasisChanges: BasisChangeEntry[],
 *   baseHash: string | null,
 *   headHash: string | null,
 *   undeclaredReason: "undeclared" | "deleted" | "unfrozen",
 * }} args
 * @returns {FreezeViolation | null}
 */
function checkDeclaration({ id, criteriaHash, headBasisChanges, baseBasisChanges, baseHash, headHash, undeclaredReason }) {
  const headCount = countCompleteDeclarations(headBasisChanges, id, criteriaHash);
  if (headCount === 0) {
    return { id, baseHash, headHash, reason: undeclaredReason, category: undeclaredReason };
  }
  const baseCount = countCompleteDeclarations(baseBasisChanges, id, criteriaHash);
  if (headCount <= baseCount) {
    return { id, baseHash, headHash, reason: "not-new", category: undeclaredReason, criteriaHash };
  }
  return null; // 正当な基準変更として合格
}

/**
 * BASE/HEAD それぞれの roadmap JSON（parse済みオブジェクト）を比較し、
 * 「凍結済み葉の criteria/verify/verifyCmd が正当な宣言なしに書き換えられている」、
 * および「本文は変えずに削除・凍結解除で基準を骨抜きにしている」違反を検出する。
 * git や fs に一切依存しない純粋関数（テストしやすくするため分離）。
 *
 * 戻り値：違反の配列。各要素は { id, baseHash, headHash, reason, category } の形。
 *   reason: "undeclared"（宣言が無い、またはat/reasonが欠けていて宣言として不完全） |
 *           "not-new"（宣言はあるがBASE時点で既に存在した＝今回PRの新規宣言でない） |
 *           "deleted"（凍結済み葉が丸ごと削除された） |
 *           "unfrozen"（凍結済み葉が todo に戻された／非葉化された／state でなくなった）
 *   category: reason が "not-new" のときに、元の違反文脈（"deleted"/"unfrozen"/"undeclared"）を
 *     保持するフィールド（formatViolation が正しいメッセージを組み立てるために使う）。
 *     reason が "not-new" 以外のときは category === reason になる。
 * @param {any} baseRoadmap
 * @param {any} headRoadmap
 * @returns {FreezeViolation[]}
 */
export function findCriteriaFreezeViolations(baseRoadmap, headRoadmap) {
  const baseMap = flattenById(baseRoadmap?.nodes || []);
  const headMap = flattenById(headRoadmap?.nodes || []);

  /** @type {BasisChangeEntry[]} */
  const headBasisChanges = Array.isArray(headRoadmap?.meta?.basisChanges)
    ? headRoadmap.meta.basisChanges
    : [];
  /** @type {BasisChangeEntry[]} */
  const baseBasisChanges = Array.isArray(baseRoadmap?.meta?.basisChanges)
    ? baseRoadmap.meta.basisChanges
    : [];

  /** @type {FreezeViolation[]} */
  const violations = [];

  for (const [id, baseNode] of baseMap) {
    if (!isFrozenLeaf(baseNode)) continue; // status:"todo" or 非葉 or 非state は言語化フェーズ＝自由編集可
    const baseHash = hashCriteria(baseNode.criteria);

    if (!headMap.has(id)) {
      // 丸ごと削除：本文は書き換えていないが、基準ごと消せば実質的に無効化できてしまう迂回路。
      // 識別子は BASE 側のハッシュ（=消される基準そのもの）で宣言させる。
      const v = checkDeclaration({
        id, criteriaHash: baseHash, headBasisChanges, baseBasisChanges,
        baseHash, headHash: null, undeclaredReason: "deleted",
      });
      if (v) violations.push(v);
      continue;
    }

    const headNode = headMap.get(id);
    if (!headNode) continue; // headMap.has(id)で確認済みだが、TSの型上は念のため防御的に確認する

    if (!isFrozenLeaf(headNode)) {
      // 凍結解除：status を todo に戻す／子を足して非葉化する／kind を変える、のいずれか。
      // 「一旦アンフリーズしてから自由に直す」を、本文の書き換えと同じ扱いで塞ぐ。
      const headHash = hashCriteria(headNode.criteria);
      const v = checkDeclaration({
        id, criteriaHash: baseHash, headBasisChanges, baseBasisChanges,
        baseHash, headHash, undeclaredReason: "unfrozen",
      });
      if (v) violations.push(v);
      continue;
    }

    const headHash = hashCriteria(headNode.criteria);
    if (baseHash === headHash) continue; // 本文は変わっていない＝問題なし

    const v = checkDeclaration({
      id, criteriaHash: headHash, headBasisChanges, baseBasisChanges,
      baseHash, headHash, undeclaredReason: "undeclared",
    });
    if (v) violations.push(v);
  }

  return violations;
}

const NOT_NEW_SUFFIX =
  `\n    （meta.basisChanges に id/criteriaHash が一致する宣言はありましたが、` +
  `BASE側に既に存在しており今回のPRで新規に追加されたものではありません。今回のPRで新規追加してください）`;

/**
 * 違反1件を人間可読な日本語メッセージへ整形する。
 *
 * v.reason は "deleted"/"unfrozen"/"undeclared"/"not-new" の4種類だが、"not-new" は
 * どの文脈（削除／凍結解除／本文書き換え）で起きたかを reason だけでは判別できない
 * （checkDeclaration が "not-new" に一本化して潰すため）。v.category に元の文脈
 * （"deleted"/"unfrozen"/"undeclared"）が残っているので、まず category を見てから
 * reason で「宣言そのものが無い」か「宣言はあるがBASEで既出（not-new）」かを分ける。
 * こうしないと、削除された葉の"not-new"メッセージが「本文が書き換えられています」
 * 「criteriaHash: "null"」という誤った文言になってしまう（実際に発生した不具合）。
 * @param {FreezeViolation} v
 * @returns {string}
 */
export function formatViolation(v) {
  const category = v.category ?? v.reason;

  if (category === "deleted") {
    const msg =
      `凍結済みの葉 ${v.id} が docs/roadmap.html から丸ごと削除されています。` +
      `本文を書き換えずに基準ごと消す迂回路も無断変更と同じ扱いです。` +
      `正当な削除なら meta.basisChanges に ` +
      `{id: "${v.id}", criteriaHash: "${v.baseHash}", at, reason} を追加すること` +
      `（criteriaHash は削除される直前のcriteria本文のsha256(hex)）。`;
    return v.reason === "not-new" ? `${msg}${NOT_NEW_SUFFIX}` : msg;
  }

  if (category === "unfrozen") {
    const msg =
      `凍結済みの葉 ${v.id} の凍結が解除されています（status を "todo" に戻す／子を足して` +
      `非葉化する／kind を変える、のいずれか）。一旦アンフリーズしてから自由に基準を書き換える` +
      `迂回路も無断変更と同じ扱いです。正当な理由があるなら meta.basisChanges に ` +
      `{id: "${v.id}", criteriaHash: "${v.baseHash}", at, reason} を追加すること` +
      `（criteriaHash は凍結解除される直前のcriteria本文のsha256(hex)）。`;
    return v.reason === "not-new" ? `${msg}${NOT_NEW_SUFFIX}` : msg;
  }

  const base =
    `凍結済みの葉 ${v.id} の criteria/verify/verifyCmd 本文が、正当な宣言（meta.basisChanges）なしに` +
    `書き換えられています。正当な変更なら meta.basisChanges に ` +
    `{id: "${v.id}", criteriaHash: "${v.headHash}", at, reason} を追加すること。` +
    `criteriaHash は新しいcriteria本文のsha256(hex)。`;
  return v.reason === "not-new" ? `${base}${NOT_NEW_SUFFIX}` : base;
}

// ---- git/fs 依存の入出力（CLI実行時のみ使う） --------------------------------------

/**
 * git show の失敗が「そのcommitに docs/roadmap.html というパスが存在しない」ことを
 * 示すエラーかどうかを判定する（純粋関数。error オブジェクトの stderr/message文字列だけを見る）。
 *
 * git show は、パスがそのref上に存在しない場合、典型的に次のいずれかを stderr に出す
 * （実際にこのリポジトリで存在しないref/存在しないパスを指定して確認済み）：
 *   - "fatal: path '<path>' does not exist in '<ref>'"        …refは有効だがそのcommitに無い
 *   - "fatal: path '<path>' exists on disk, but not in '<ref>'" …ワークツリーにはあるがcommitに無い
 * これに該当しないエラー（refが無効＝invalid object name、gitコマンド自体が無い 等）は
 * 「比較不能」ではなく「壊れている」ので、呼び出し側で再スローして異常終了させる。
 * @param {any} error
 * @returns {boolean}
 */
export function isMissingPathError(error) {
  const text = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  return text.includes("does not exist in") || text.includes("exists on disk, but not in");
}

/** @param {string | undefined} ref */
function readRoadmapAt(ref) {
  // ref が未指定なら作業ツリーを直接読む（git show を使わない）。
  if (!ref) {
    return readFileSync(roadmapAbsPath, "utf8");
  }
  return execFileSync("git", ["show", `${ref}:${ROADMAP_REL_PATH}`], {
    encoding: "utf8",
  });
}

function main() {
  const BASE_REF = process.env.BASE_REF || "";
  const HEAD_REF = process.env.HEAD_REF || "";

  if (!BASE_REF) {
    console.log("BASE_REF未指定のためスキップ");
    return;
  }

  let baseHtml;
  try {
    baseHtml = readRoadmapAt(BASE_REF);
  } catch (e) {
    if (!isMissingPathError(e)) {
      // refが無効・gitコマンド自体の失敗等、「比較不能」ではなく「壊れている」ケース。
      // ここを握りつぶすとCIゲートの意味が無くなるので、握りつぶさず再スローして異常終了させる。
      throw e;
    }
    console.log(
      `BASE(${BASE_REF})に ${ROADMAP_REL_PATH} が存在しないためスキップ（新規リポジトリの最初のコミット等）`,
    );
    return;
  }

  const headHtml = readRoadmapAt(HEAD_REF || undefined);

  const baseData = extractRoadmapJson(baseHtml);
  const headData = extractRoadmapJson(headHtml);

  const violations = findCriteriaFreezeViolations(baseData, headData);

  if (violations.length > 0) {
    console.error("✗ criteria凍結リンタ: 不正を検出");
    for (const v of violations) {
      console.error("  - " + formatViolation(v));
    }
    process.exit(1);
  }

  console.log("✓ criteria凍結リンタ: OK（凍結済み葉の criteria/verify 本文に無断変更なし）");
}

// このファイルが直接実行された時だけ main() を走らせる（テストからの import 時は走らせない）。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
