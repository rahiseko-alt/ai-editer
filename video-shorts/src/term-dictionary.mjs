// video-shorts 用語辞書の追記 — G-EDIT-CAPTION-C / G-EDIT-CAPTION-F
//
// 画面で字幕を直したとき、その語を src/term-corrections.json へ還元する。
// 次に文字起こしを流すと transcribe.py が words[].w と segments[].text へ適用するので、
// 同じ固有名詞を毎回手で直さなくてよくなる。
//
// 【なぜ「1語かつ12文字以内」に絞るか】この辞書は全ジョブに単純文字列置換で効く。
// 文まるごとが入ると、以後の全案件でその文字列が置換され誤爆する。
// 既存エントリはすべて固有名詞1語(「追患版」→「椎間板」等)なので、それに合わせて上限を置く。
//
// 【なぜ追記が壊れやすいか】このファイルは _comment / _limitation という運用上の説明を
// 先頭に持つ。丸ごと書き直す実装にすると、その説明や既存の登録が黙って消える。
// 追記は「読む→足す→全部を書き戻す」で行い、既存のキーと値を1つも変えない。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DICT_PATH = path.join(HERE, "term-corrections.json");

/** 辞書へ載せてよい語の上限文字数。既存エントリが固有名詞1語であることに合わせた値。 */
export const MAX_TERM_LENGTH = 12;

/**
 * 「1語」とみなせるか。空白（半角・全角・タブ・改行）を含むものは語ではなく文とみなす。
 * 空白で区切られていなくても、12文字を超えるものは文の可能性が高いので載せない。
 */
export function isSingleTerm(text) {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (t.length === 0) return false;
  if (t.length > MAX_TERM_LENGTH) return false;
  // 空白類（ASCII空白・タブ・改行・全角スペース）を1つでも含めば「1語」ではない
  if (/[\s　]/.test(t)) return false;
  return true;
}

/**
 * 修正前→修正後の対を、辞書へ載せてよいか判定する。
 * 載せない理由を返すので、画面へそのまま出せる（黙って捨てない）。
 * @returns {{ok: boolean, reason?: string}}
 */
export function judgeTermPair(before, after) {
  if (!isSingleTerm(before) || !isSingleTerm(after)) {
    return { ok: false, reason: `辞書に載せるのは${MAX_TERM_LENGTH}文字以内の1語だけです（文や長い語は載せません）` };
  }
  const b = before.trim();
  const a = after.trim();
  if (b === a) return { ok: false, reason: "直す前と後が同じです" };
  // _ 始まりのキーは transcribe.py が置換対象から外す運用上の予約。辞書の意味が変わるので拒む。
  if (b.startsWith("_")) return { ip: false, ok: false, reason: "_ で始まる語は辞書の予約キーなので登録できません" };
  return { ok: true };
}

/** 辞書を読む。壊れていれば例外にする（黙って {} にすると既存の登録を全部消してしまう）。 */
export function readDictionary(dictPath = DICT_PATH) {
  const raw = fs.readFileSync(dictPath, "utf-8");
  const data = JSON.parse(raw);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`用語辞書の形が想定と違います（オブジェクトではありません）: ${dictPath}`);
  }
  return data;
}

/**
 * 修正前→修正後の対を辞書へ追記する。
 * 既存のキーと値は1つも変えない（_comment 等の説明も含めてそのまま残す）。
 *
 * @returns {{added: boolean, reason?: string, before: string, after: string}}
 */
export function appendTerm(before, after, dictPath = DICT_PATH) {
  const judged = judgeTermPair(before, after);
  const b = typeof before === "string" ? before.trim() : "";
  const a = typeof after === "string" ? after.trim() : "";
  if (!judged.ok) return { added: false, reason: judged.reason, before: b, after: a };

  const current = readDictionary(dictPath);
  if (Object.prototype.hasOwnProperty.call(current, b)) {
    // 既にある語を上書きしない。上書きすると、前に直した内容が黙って変わる。
    if (current[b] === a) return { added: false, reason: "すでに同じ内容で登録されています", before: b, after: a };
    return { added: false, reason: `すでに「${b}」→「${current[b]}」で登録されています`, before: b, after: a };
  }

  const next = { ...current, [b]: a };
  writeDictionaryAtomically(next, dictPath);
  return { added: true, before: b, after: a };
}

/**
 * 同じディレクトリの一時ファイルへ書いてから置き換える。
 * 直接上書きすると、書いている途中で落ちたときに辞書が壊れ、
 * 次の文字起こしで全部の登録が効かなくなる（読めなければ {} として扱われるため）。
 */
function writeDictionaryAtomically(data, dictPath) {
  const tmp = `${dictPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, dictPath);
}
