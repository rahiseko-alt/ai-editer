// video-shorts 字幕の手直しの保存 — G-EDIT-CAPTION-A
//
// 字幕は焼き込み式なので、名前や固有名詞を聞き間違えられると作り直しになる。
// 焼く前に文字を直せるようにするため、直した内容をジョブの作業フォルダへ保存する。
//
// 【なぜ words 単位で持つか】焼かれる字幕(ASS)は transcript.json の words[] から作られ、
// 1語ごとの時刻を使う書式(karaoke 等)がある。行のテキストだけを持つと、その時刻が失われて
// 書式を選び直せなくなる。直すのは語の綴りであって喋った時刻ではないので、
// 「何番目の語を、どの文字へ直したか」だけを保存し、時刻は transcript.json のまま使う。
//
// 【なぜ元を書き換えないか】transcript.json を直接書き換えると、直す前が分からなくなり
// 「直す前の文字が焼き直した動画に残っていないか」(葉B)を後から確かめられない。
// また辞書へ載せる「修正前→修正後」の対も作れなくなる。上書きせず、別のファイルに差分で持つ。

import fs from "node:fs";
import path from "node:path";

/** 直した内容を置くファイル名（ジョブの作業フォルダの中） */
export const EDITS_FILE = "caption-edits.json";

/** 1語として保存してよい長さの上限。字幕1行に収まらない長さは打ち間違いとみなす。 */
export const MAX_WORD_LENGTH = 40;

/**
 * 保存された直しを読む。
 * 不在なら空（まだ何も直していない）。壊れていれば例外にする
 * （黙って空にすると、直した内容が消えたのに「直していない」と区別がつかない）。
 * @returns {{words: Record<string, string>}} キーは words[] の添字（文字列）
 */
export function readEdits(workDir) {
  const p = path.join(workDir, EDITS_FILE);
  if (!fs.existsSync(p)) return { words: {} };
  const data = JSON.parse(fs.readFileSync(p, "utf-8"));
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`字幕の直しの形が想定と違います: ${p}`);
  }
  const words = data.words;
  if (words === undefined) return { words: {} };
  if (words === null || typeof words !== "object" || Array.isArray(words)) {
    throw new Error(`字幕の直しの words が想定と違います: ${p}`);
  }
  return { words: { ...words } };
}

/**
 * 1語の直しを受け付けられるか判定する。受け付けない理由は文章で返す（黙って捨てない）。
 * @param {number} index words[] の添字
 * @param {string} text 直したあとの文字
 * @param {number} wordCount transcript.json の words[] の件数
 */
export function judgeWordEdit(index, text, wordCount) {
  if (!Number.isInteger(index) || index < 0 || index >= wordCount) {
    return { ok: false, reason: `直す語の位置が範囲の外です（0〜${wordCount - 1} の中で指定してください）` };
  }
  if (typeof text !== "string") return { ok: false, reason: "直したあとの文字が文字列ではありません" };
  const t = text.trim();
  if (t.length === 0) return { ok: false, reason: "空にはできません（消したいときは語を残して別の文字にしてください）" };
  if (t.length > MAX_WORD_LENGTH) {
    return { ok: false, reason: `1語は${MAX_WORD_LENGTH}文字までです（行をまるごと貼り付けていませんか）` };
  }
  if (/[\r\n]/.test(t)) return { ok: false, reason: "改行は入れられません" };
  return { ok: true, text: t };
}

/**
 * 1語の直しを保存する。既に直してある語は上書きしてよい（同じ語を直し直すのは普通の操作）。
 * 元へ戻したいときは元の文字を渡せばよく、その場合は直しの記録を消す。
 *
 * @param {string} workDir ジョブの作業フォルダ
 * @param {object} p
 * @param {number} p.index words[] の添字
 * @param {string} p.text 直したあとの文字
 * @param {string} p.original transcript.json の words[index].w（直す前）
 * @param {number} p.wordCount words[] の件数
 * @returns {{saved: boolean, reason?: string, before?: string, after?: string}}
 */
export function saveWordEdit(workDir, { index, text, original, wordCount }) {
  const judged = judgeWordEdit(index, text, wordCount);
  if (!judged.ok) return { saved: false, reason: judged.reason };

  const edits = readEdits(workDir);
  const key = String(index);
  if (judged.text === original) {
    // 元と同じ＝直しを取り消したということ。記録を残すと、以後ずっと「直した」扱いになる。
    delete edits.words[key];
  } else {
    edits.words[key] = judged.text;
  }
  writeEditsAtomically(workDir, edits);
  return { saved: true, before: original, after: judged.text };
}

/**
 * transcript.json の words[] に、保存された直しを重ねた配列を返す。
 * 元の配列は書き換えない（直す前が分からなくなると、焼き直した動画に古い文字が
 * 残っていないかを後から確かめられない）。
 */
export function applyEdits(words, edits) {
  const table = (edits && edits.words) || {};
  return (words || []).map((w, i) => {
    const fixed = table[String(i)];
    return fixed === undefined ? w : { ...w, w: fixed };
  });
}

/**
 * 保存された直しから「修正前→修正後」の対を作る（辞書へ載せる候補）。
 * 元の語が分からないと対にできないので、元の words[] を必ず渡す。
 */
export function editPairs(words, edits) {
  const table = (edits && edits.words) || {};
  const pairs = [];
  for (const [key, after] of Object.entries(table)) {
    const i = Number(key);
    const src = (words || [])[i];
    if (!src || typeof src.w !== "string") continue;
    if (src.w === after) continue;
    pairs.push({ index: i, before: src.w, after });
  }
  return pairs.sort((a, b) => a.index - b.index);
}

/**
 * 同じフォルダの一時ファイルへ書いてから置き換える。
 * 直接上書きすると、書いている途中で落ちたときに直した内容が丸ごと読めなくなる。
 */
function writeEditsAtomically(workDir, edits) {
  fs.mkdirSync(workDir, { recursive: true });
  const p = path.join(workDir, EDITS_FILE);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(edits, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, p);
}
