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
// 【なぜ一般的な日本語の素材で判定するか（2026-08-08 追加）】上の「短い1語だけ載せる」では
// 誤爆を防げない。中心症例：字幕の「心筋高速」を「心筋梗塞」へ直すと、素直に登録されるのは
// 「高速」→「梗塞」で、以後すべての案件で「高速道路」が「梗塞道路」になる（実測で再現済み）。
//
// そこで、同梱の common-japanese.txt（ふつうの日本語の文の集まり）に対して判定する。
// 直す前の語がその素材に1回でも出てくるなら載せない。出てくる語は「ふつうの日本語の語」なので、
// 載せれば他の案件でその語が出るたびに書き換わる。出てこない語は誤変換で生まれた文字の並び
// （追患版・椎間盤 等）なので、そのまま載せて安全である。
// ・既存3件（追患版・追間板・椎間盤）はいずれも素材に出ないので、挙動は変わらない
// ・「高速」「ました」「の」等は載せられなくなる。理由を返して画面に出す
//
// なお、当初は「素材に当たらなくなるまで前後の文字を足す」方式を実装し push まで行ったが、
// 実測2回で偽の安全だと分かって取り下げた。詳しい経緯は judgeAgainstCommonJapanese の説明にある。
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
  if (b.startsWith("_")) return { ok: false, reason: "_ で始まる語は辞書の予約キーなので登録できません" };
  return { ok: true };
}

/** 一般的な日本語の文の集まり。載せてよい語かどうかを、この素材に対して判定する。 */
export const COMMON_JA_PATH = path.join(HERE, "common-japanese.txt");

let commonJaCache = null;

/**
 * 判定の土台を読む。行頭が # の行（説明）は落とす。
 */
export function readCommonJapanese(p = COMMON_JA_PATH) {
  if (p === COMMON_JA_PATH && commonJaCache !== null) return commonJaCache;
  const raw = fs.readFileSync(p, "utf-8");
  const body = raw.split("\n").filter((line) => !line.startsWith("#")).join("\n");
  if (p === COMMON_JA_PATH) commonJaCache = body;
  return body;
}

/** 出現回数を数える（部分一致。transcribe.py の置換と同じ数え方にする） */
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) { n++; i = haystack.indexOf(needle, i + 1); }
  return n;
}

/**
 * 載せてよい対かを、一般的な日本語の素材に対して判定する。
 *
 * 【規則】直す前の語が、一般的な日本語の素材に1回でも出てくるなら載せない。
 * 出てくる語は「ふつうの日本語の語」なので、辞書へ載せると他の案件でその語が出るたびに
 * 書き換わる。出てこない語は誤変換で生まれた文字の並び（追患版・椎間盤 等）なので、
 * そのまま載せて安全である。
 *
 * 【なぜ「前後の文字を足して安全にする」方式をやめたか（2026-08-08、実測2回）】
 * 当初は「素材に当たらなくなるまで前後の文字を足す」方式を実装し、一度は push まで行った。
 * しかし足してできる鍵は「高速です」「うは高速」「て行き」のような、ふつうの日本語なのに
 * 素材にたまたま無い並びになる。素材を1.5倍に増やしても漏れ続けた。
 * この方式は素材の網羅度がそのまま安全性になるが、判定対象が「任意の部分文字列」なので、
 * 手で書ける規模の素材では偽の安全しか作れない。
 * 規則を「直す前の語そのものが素材に出るか」にすると、判定対象が「1つの語」へ狭まるので、
 * 手で書ける素材でも網羅できる。「高速」は載せられなくなるが、それは正しい拒否である
 * （載せれば必ず他の案件の「高速道路」を壊すため）。
 *
 * 【この方式の限界（隠さずに書く）】素材に無い実在の語は通ってしまう。
 * 素材を育てることが、そのまま安全性を上げる唯一の手段である。
 * 素材が満たすべき条件は common-japanese.txt の冒頭に書いてある。
 *
 * @param {string} before  ユーザーが直す前の語
 * @param {string} after   直したあとの語
 * @param {string} common  判定の土台。既定は同梱の一般的な日本語の素材
 * @returns {{ok:boolean, key?:string, value?:string, reason?:string}}
 */
export function judgeAgainstCommonJapanese(before, after, common = null) {
  const ref = common === null ? readCommonJapanese() : common;
  if (typeof before !== "string" || before.length === 0) {
    return { ok: false, reason: "直す前の語がありません" };
  }
  if (countOccurrences(ref, before) > 0) {
    return {
      ok: false,
      reason: `「${before}」はふつうの日本語に出てくる語なので、辞書に載せると他の案件の字幕まで書き換わります`
        + `（誤変換された部分だけでなく、まとまり全体を直してから覚えさせてください）`,
    };
  }
  // 置換後が置換前を含むと、transcribe.py の fix_words が無限ループ避けでその対を飛ばす＝字幕が直らない。
  // 登録は成功と表示されるのに効かない、という黙った失敗になるので、ここで断る。
  if (typeof after === "string" && after.includes(before)) {
    return {
      ok: false,
      reason: "直したあとの文字列が直す前の文字列を含んでいるため、字幕には反映されません",
    };
  }
  return { ok: true, key: before, value: after };
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
 * 修正前→修正後の対を辞書へ追記する（語の形だけを見る内部用）。
 *
 * 【export しない理由】この関数は「ふつうの日本語の語か」を見ないので、
 * 直接呼べば「高速」のような語を裸で登録でき、以後の全案件を壊せる。
 * 製品の出荷経路は appendSafeTerm だけにして、抜け道を残さない（2026-08-08）。
 * 既存のキーと値は1つも変えない（_comment 等の説明も含めてそのまま残す）。
 *
 * @returns {{added: boolean, reason?: string, before: string, after: string}}
 */
function appendTerm(before, after, dictPath = DICT_PATH) {
  const judged = judgeTermPair(before, after);
  const b = typeof before === "string" ? before.trim() : "";
  const a = typeof after === "string" ? after.trim() : "";
  if (!judged.ok) return { added: false, reason: judged.reason, before: b, after: a };

  return putIntoDictionary(b, a, dictPath);
}

/**
 * 判定を通った対を、実際に辞書へ書く。
 * 形の判定（長さ・空白・予約キー）は呼び出し側で済ませてある前提。
 *
 * 文脈を足した鍵は MAX_TERM_LENGTH を超えることがあるので、ここでは長さを見ない。
 * 文脈は「そこだと分かるための目印」であって、載せてよい語の長さの話ではないため。
 */
function putIntoDictionary(key, value, dictPath) {
  const current = readDictionary(dictPath);
  if (Object.prototype.hasOwnProperty.call(current, key)) {
    // 既にある語を上書きしない。上書きすると、前に直した内容が黙って変わる。
    if (current[key] === value) {
      return { added: false, reason: "すでに同じ内容で登録されています", before: key, after: value };
    }
    return { added: false, reason: `すでに「${key}」→「${current[key]}」で登録されています`, before: key, after: value };
  }
  const next = { ...current, [key]: value };
  writeDictionaryAtomically(next, dictPath);
  return { added: true, before: key, after: value };
}

/**
 * 他の案件を壊さないことを確かめてから辞書へ追記する。これが製品の出荷経路である。
 *
 * appendTerm との違いは、載せる前に「その語がふつうの日本語に出てくる語か」を
 * 同梱の素材（common-japanese.txt）に対して測ること。出てくる語は載せない。
 *
 * @param {string} before    直す前の語（ユーザーが直した語そのもの）
 * @param {string} after     直したあとの語
 * @param {string} common    判定の土台。既定は同梱の素材（テストで差し替えられるようにしてある）
 * @param {string} dictPath
 */
export function appendSafeTerm(before, after, common = null, dictPath = DICT_PATH) {
  const b = typeof before === "string" ? before.trim() : "";
  const a = typeof after === "string" ? after.trim() : "";
  // まず語そのものの形（長さ・空白・予約キー）を見る。ここは従来どおり。
  const judged = judgeTermPair(before, after);
  if (!judged.ok) return { added: false, reason: judged.reason, before: b, after: a };

  const safe = judgeAgainstCommonJapanese(b, a, common);
  if (!safe.ok) return { added: false, reason: safe.reason, before: b, after: a };

  const result = putIntoDictionary(safe.key, safe.value, dictPath);
  return { ...result, before: b, after: a, key: safe.key, value: safe.value };
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
