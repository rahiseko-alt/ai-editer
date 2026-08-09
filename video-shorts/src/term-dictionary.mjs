// video-shorts 用語辞書の追記 — G-EDIT-CAPTION-C / G-EDIT-CAPTION-F
//
// 画面で字幕を直したとき、その語を src/term-corrections.json へ還元する。
// 次に文字起こしを流すと transcribe.py が words[].w と segments[].text へ適用するので、
// 同じ固有名詞を毎回手で直さなくてよくなる。
//
// 【この辞書の位置づけ（2026-08-09 マスター決定・ここが正）】
// 辞書は「機械的に正解を出す」道具で、本気で効かせるには日本語の語彙を網羅する必要があるが、
// それは手に負えない。一方この製品では、
//   ・字幕は LLM が文脈で見て直せる（変換ミスの最終的な正しさはそちらが担う）
//   ・そもそも編集機能であり、出す前に人間の確認も通る
// ため、辞書の精度に労力を割く価値が小さい。
// そこで **辞書は「世間にある平均的な辞書」と同じ水準（形式チェックと重複拒否だけ）** と定義し、
// 変換ミスは AI が直す前提に置く。網羅性も「他の案件を壊さないこと」も、ここでは約束しない。
//
// 【世間の水準（2026-08-08 実測した他社の用語辞書）】
//   ・AmiVoice（日本語ASR）：1〜2文字の短い読みは誤変換を招くと公式に警告するが、拒否はしない
//   ・Notta：1辞書あたり200語の上限
//   ・DeepL 用語集：ソース語の重複はエラーで拒否
//   ・Google STT / Azure：そもそも置換ではなく重み付け。上限フレーズ数を置く
// いずれも「載せた語が他の文書を壊さないこと」は保証していない。ここも同じ水準に合わせる。
//
// 【以前あった安全機構を外した経緯（2026-08-09）】
// 同梱の日本語素材（common-japanese.txt）に出てくる語は載せない、という判定を持っていたが、
// 上の決定により削除した。結果として「高速」「ました」「今日」等も登録できる。
// それで壊れた字幕は AI と人間の確認で直る、というのが今回の設計上の前提である。
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
 * 注意書きを出す長さ。これ以下の語は誤変換を招きやすい（AmiVoice の公式ガイダンスに倣う）。
 * 拒否はしない＝通したうえで理由を添えて知らせる。
 */
export const SHORT_TERM_LENGTH = 2;

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
 * 短い語への注意書きを返す（無ければ null）。
 *
 * 短い語は他の語の一部にも当たるので誤変換を招きやすい。ただし断らない。
 * 断ると「心筋高速→心筋梗塞」のような直したい修正まで落ちるうえ、
 * この製品では最終的な字幕の正しさを AI と人間の確認が担うためである。
 */
export function shortTermNotice(term) {
  if (typeof term !== "string") return null;
  const t = term.trim();
  if (t.length === 0 || t.length > SHORT_TERM_LENGTH) return null;
  return `「${t}」は${SHORT_TERM_LENGTH}文字以下なので、他の語の一部にも当たって誤変換を招くことがあります`
    + `（登録はしました。おかしくなったら辞書から外してください）`;
}

/**
 * 修正前→修正後の対を、辞書へ載せてよいか判定する。
 * 見るのは語の「形」だけ（世間の用語辞書と同じ水準）。
 * 載せない理由を返すので、画面へそのまま出せる（黙って捨てない）。
 * @returns {{ok: boolean, reason?: string, notice?: string}}
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
  // 置換後が置換前を含むと、transcribe.py の fix_words が無限ループ避けでその対を飛ばす＝字幕が直らない。
  // 「登録しました」と出るのに何も起きない黙った失敗になるので、形の判定として断る。
  if (a.includes(b)) {
    return { ok: false, reason: "直したあとの文字列が直す前の文字列を含んでいるため、字幕には反映されません" };
  }
  const notice = shortTermNotice(b);
  return notice ? { ok: true, notice } : { ok: true };
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
 * 判定を通った対を、実際に辞書へ書く。
 * 形の判定（長さ・空白・予約キー）は呼び出し側で済ませてある前提。
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
 * 修正前→修正後の対を辞書へ追記する。これが製品の出荷経路である。
 *
 * 見るのは語の形と重複だけ（judgeTermPair）。載せた語が他の案件で誤爆しないことは
 * **保証しない**。字幕の最終的な正しさは、AI が文脈で見て直すことと、人間の確認が担う。
 *
 * @param {string} before    直す前の語（ユーザーが直した語そのもの）
 * @param {string} after     直したあとの語
 * @param {string} dictPath  辞書の置き場所（テストが本物を汚さないよう差し替えられる）
 * @returns {{added: boolean, reason?: string, notice?: string, before: string, after: string}}
 */
export function appendSafeTerm(before, after, dictPath = DICT_PATH) {
  const b = typeof before === "string" ? before.trim() : "";
  const a = typeof after === "string" ? after.trim() : "";
  const judged = judgeTermPair(before, after);
  if (!judged.ok) return { added: false, reason: judged.reason, before: b, after: a };

  const result = putIntoDictionary(b, a, dictPath);
  return judged.notice ? { ...result, notice: judged.notice } : result;
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
