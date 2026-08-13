// video-shorts candidates.json 由来のファイル名を安全に扱う共通ヘルパー — AUD-P1-01a/AUD-P1-01b
//
// candidates.json の `file` は、正規の経路では pipeline.mjs / apply-mosaic-stage.mjs が
// path.basename() した値しか書かない。しかし候補一覧そのものはジョブの成果物フォルダに置かれた
// ただのJSONで、正規の書き手以外（壊れた/悪意あるmanifest、手で編集された candidates.json）が
// `"file": "../../evil.mp4"` のような値を混ぜて置くことを機械的には防げない。
// recaption-stage.mjs / apply-mosaic-stage.mjs はこの値をそのまま path.join() して
// rename/読み込み等のI/Oに使っているため、検証しないと成果物フォルダの外を書き換えられる。
//
// 対策は2段構え:
//  (1) safeBasename() — 単純なファイル名（区切り無し・".."無し・許可拡張子）だけを通す。
//  (2) resolveInside() — 実際にI/Oする直前に、解決後の絶対パスが対象ディレクトリの
//      内側にあるかを毎回検査する（TOCTOU対策）。着手前に1回だけ検査しても、後続の処理が
//      別のパスを組み立て直せば素通りしうるため、I/Oの呼び出し直前ごとに検査し直す設計にする。

import path from "node:path";

/**
 * candidates.json の `file`（またはそこから派生する単純なファイル名）が安全かを検証する。
 * パス区切り（/ や \）・".."・絶対パス・NUL文字を含む値、および許可拡張子以外を拒否する。
 *
 * @param {string} name 検証する値
 * @param {{allowedExt?: string[]}} [opts] 許可する拡張子（小文字・ドット付き）。既定 [".mp4"]。
 * @returns {string} 検証済みの name（そのまま返す。呼び出し側の可読性のため）
 */
export function safeBasename(name, { allowedExt = [".mp4"] } = {}) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`不正なファイル名です（空またはstring以外）: ${JSON.stringify(name)}`);
  }
  if (name.includes("\0") || /[\\/]/.test(name)) {
    throw new Error(`不正なファイル名です（パス区切りを含んでいます）: ${JSON.stringify(name)}`);
  }
  if (name === "." || name === "..") {
    throw new Error(`不正なファイル名です: ${JSON.stringify(name)}`);
  }
  // path.basename() を通しても値が変わらないことも二重に確認する（プラットフォーム差を吸収）。
  if (path.basename(name) !== name) {
    throw new Error(`不正なファイル名です（単純なファイル名ではありません）: ${JSON.stringify(name)}`);
  }
  const ext = path.extname(name).toLowerCase();
  if (!allowedExt.includes(ext)) {
    throw new Error(`不正なファイル名です（許可されていない拡張子 ${ext}）: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * baseDir 配下へ name を解決し、実際に対象ディレクトリの内側に収まっているかを検査する。
 * I/O（読み込み・rename・書き込み等）の直前に毎回呼び出すこと（1回だけの検査に頼らない）。
 *
 * @param {string} baseDir 許可するディレクトリ
 * @param {string} name baseDir 配下の単純なファイル名（安全性は safeBasename 等で別途保証すること）
 * @returns {string} 検証済みの絶対パス
 */
export function resolveInside(baseDir, name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`不正なファイル名です（空またはstring以外）: ${JSON.stringify(name)}`);
  }
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, name);
  const rel = path.relative(resolvedBase, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`不正なファイル名です（対象フォルダの外を指しています）: ${JSON.stringify(name)} → ${resolved}`);
  }
  return resolved;
}

/**
 * candidates.json の `file` を、baseDir 配下の安全な絶対パスへ一度に検証・解決する。
 * safeBasename() + resolveInside() をまとめて行う（呼び出し側の書き分けを減らすための糖衣）。
 * I/Oの直前ごとに呼び直すことを想定している。
 *
 * @param {string} baseDir 許可するディレクトリ
 * @param {string} name candidates.json の `file` 相当の値
 * @param {{allowedExt?: string[]}} [opts]
 * @returns {string} 検証済みの絶対パス
 */
export function safeCandidatePath(baseDir, name, opts = {}) {
  const safe = safeBasename(name, opts);
  return resolveInside(baseDir, safe);
}
