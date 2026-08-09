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
// 【なぜ文脈を足して登録するか（2026-08-08 追加）】上の「短い1語だけ載せる」だけでは誤爆を防げない。
// 中心症例：字幕の「心筋高速」を「心筋梗塞」へ直すと、素直に登録されるのは「高速」→「梗塞」で、
// 以後すべての案件で「高速道路」が「梗塞道路」になる（実測で再現済み）。
// 「高速」は正当な内容語なので、助詞の一覧でも、文字種と長さの規則でも、頻度の高い語の一覧でも、
// 形態素解析でも止まらない（形態素解析はむしろ「高速」を正しい語と認める）。
// つまり「どの語を登録させないか」という方向では、この事故は原理的に防げない。
//
// そこで、載せる鍵の側に文脈を足す。「高速」ではなく「筋高速」のように、
// 手元の書き起こしで当たる箇所がちょうど1つになる最短の長さまで前後へ伸ばしてから載せる。
// ・「追患版」のように元から1箇所しか当たらない語は、文脈ゼロのまま載る（既存3件の挙動は変わらない）
// ・伸ばしても一意にならない語（「の」など）は載せない。理由を返して画面に出す
// この形なら、語の途中で一致してしまう性質（transcribe.py の置換は部分一致）をそのままにできる。
// 鍵が十分に長いので、他の語の内部でたまたま一致することが無くなるためである。
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

/**
 * 文脈を足した鍵の長さの上限。
 * ユーザーが直す語そのものは MAX_TERM_LENGTH までだが、誤爆を避けるために足す文脈は
 * その外側なので、別の上限を置く。ここまで伸ばしても一意にならない語は載せない。
 */
export const MAX_ANCHOR_LENGTH = 24;

/**
 * 文脈を足したあとの鍵の最短の長さ。
 *
 * 「手元の書き起こしで当たる箇所がちょうど1つ」だけを条件にすると、書き起こしが短いときに
 * 「の」のようなありふれた語まで1箇所になってしまい、そのまま載って全案件を壊す（実測で確認）。
 * 短い書き起こしでは「珍しい語」と「たまたま1回しか出ていない語」を区別できないため、
 * 長さの下限を併せて要求する。
 *
 * 3 という値は、既存の登録（追患版・追間板・椎間盤＝すべて3文字）から採った。
 * この線なら既存の3件は文脈ゼロのまま載り続け、1〜2文字の語（の・は・AI 等）は
 * 必ず文脈が付いてその場限りの鍵になる。
 */
export const MIN_KEY_LENGTH = 3;

/** 出現回数を数える（部分一致。transcribe.py の置換と同じ数え方にする） */
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) { n++; i = haystack.indexOf(needle, i + 1); }
  return n;
}

/**
 * 誤爆しない鍵を、文脈を足しながら探す。
 *
 * ユーザーが直したのは corpus 内の at の位置にある before。
 * before だけでは他の箇所にも当たってしまう場合、当たる箇所がちょうど1つになるまで
 * 前後の文字を足していく。足した文字は修正後の側にもそのまま付ける
 * （文脈は「そこだと分かるための目印」であって、直す対象ではないため）。
 *
 * @param {string} corpus  手元にある書き起こし全体（誤爆の有無をここで測る）
 * @param {number} at      corpus の中で before が始まる位置
 * @param {string} before  ユーザーが直す前の語
 * @param {string} after   直したあとの語
 * @returns {{ok:boolean, key?:string, value?:string, anchored?:boolean, hits?:number, reason?:string}}
 */
export function findSafeAnchor(corpus, at, before, after) {
  if (typeof corpus !== "string" || typeof before !== "string" || before.length === 0) {
    return { ok: false, reason: "文脈を測るための書き起こしがありません" };
  }
  if (at < 0 || corpus.slice(at, at + before.length) !== before) {
    return { ok: false, reason: "直した語が書き起こしの中に見つかりません" };
  }

  // 文脈ゼロから始めて、左右へ1文字ずつ広げる。
  // 左右のどちらへ伸ばすかは、伸ばした結果の当たり数が少ない方を選ぶ（早く一意になる方）。
  let left = 0;
  let right = 0;
  for (;;) {
    const start = at - left;
    const end = at + before.length + right;
    const key = corpus.slice(start, end);
    const hits = countOccurrences(corpus, key);
    // 「当たるのが1箇所」と「短すぎない」の両方が要る。
    // 前者だけだと、短い書き起こしで「の」が1箇所になり素通りする。
    if (hits === 1 && key.length >= MIN_KEY_LENGTH) {
      const head = corpus.slice(start, at);
      const tail = corpus.slice(at + before.length, end);
      return {
        ok: true,
        key,
        value: head + after + tail,
        anchored: left > 0 || right > 0,
        hits,
      };
    }
    if (key.length >= MAX_ANCHOR_LENGTH) {
      return {
        ok: false,
        reason: `この語は書き起こしの中の ${hits} か所に当たってしまうため、辞書に載せると別の場所まで書き換わります`
          + `（前後の文字を足しても一意になりませんでした）`,
      };
    }
    // 伸ばせる方向が無くなったら打ち切る
    const canLeft = at - left > 0;
    const canRight = at + before.length + right < corpus.length;
    if (!canLeft && !canRight) {
      return {
        ok: false,
        reason: `この語は書き起こしの中の ${hits} か所に当たってしまうため、辞書に載せると別の場所まで書き換わります`,
      };
    }
    if (canLeft && canRight) {
      const l = countOccurrences(corpus, corpus.slice(start - 1, end));
      const r = countOccurrences(corpus, corpus.slice(start, end + 1));
      if (l <= r) left++; else right++;
    } else if (canLeft) left++;
    else right++;
  }
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
 * 誤爆しない形にしてから辞書へ追記する。
 *
 * appendTerm との違いは、載せる前に「手元の書き起こしで当たる箇所がちょうど1つか」を測り、
 * 1つでなければ前後の文字を足すこと。足しても一意にならなければ載せない。
 *
 * @param {string} before   直す前の語（ユーザーが直した語そのもの）
 * @param {string} after    直したあとの語
 * @param {string} corpus   手元にある書き起こし全体
 * @param {number} at       corpus の中で before が始まる位置
 * @param {string} dictPath
 */
export function appendAnchoredTerm(before, after, corpus, at, dictPath = DICT_PATH) {
  const b = typeof before === "string" ? before.trim() : "";
  const a = typeof after === "string" ? after.trim() : "";
  // まず語そのものの形（長さ・空白・予約キー）を見る。ここは従来どおり。
  const judged = judgeTermPair(before, after);
  if (!judged.ok) return { added: false, reason: judged.reason, before: b, after: a };

  const anchor = findSafeAnchor(corpus, at, b, a);
  if (!anchor.ok) return { added: false, reason: anchor.reason, before: b, after: a };

  const result = putIntoDictionary(anchor.key, anchor.value, dictPath);
  return { ...result, before: b, after: a, key: anchor.key, value: anchor.value, anchored: anchor.anchored };
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
