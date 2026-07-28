// video-shorts [5] 字幕生成 — 区間内の word-level を読みやすい字幕行にまとめ、
// 背景ボックス付き ASS 字幕を生成する。9:16(1080x1920)前提。
//
// 既製SaaSの「全ユーザー同一字幕」を避け自前デザインを握る（差別化・RB FORKOFF）。
// スタイルは選択式（subtitle-styles.mjs の登録を参照）: karaoke/pop/line を mode で切替。

import { getStyle, DEFAULT_SUBTITLE_STYLE } from "./subtitle-styles.mjs";

/** 区間 [start,end] に入る words を抜き出し、相対時間(区間先頭=0)に変換 */
export function wordsInRange(words, start, end) {
  return words
    .filter((w) => w.end > start && w.start < end)
    .map((w) => ({ w: w.w, start: Math.max(0, w.start - start), end: Math.max(0, w.end - start) }));
}

/** words を maxChars 程度の字幕行（キャプション）にまとめる */
export function groupCaptions(words, maxChars = 18) {
  const lines = [];
  let cur = { text: "", start: null, end: 0 };
  for (const word of words) {
    if (cur.start === null) cur.start = word.start;
    const next = cur.text + word.w;
    if (next.length > maxChars && cur.text.length > 0) {
      lines.push({ ...cur });
      cur = { text: word.w, start: word.start, end: word.end };
    } else {
      cur.text = next;
      cur.end = word.end;
    }
  }
  if (cur.text) lines.push(cur);
  return lines;
}

/** words を maxChars 程度の行にまとめる。各行に words[] を保持（karaoke mode 用） */
export function groupCaptionsWords(words, maxChars = 14) {
  const lines = [];
  let cur = { words: [], text: "", start: null, end: 0 };
  for (const word of words) {
    if (cur.start === null) cur.start = word.start;
    const next = cur.text + word.w;
    if (next.length > maxChars && cur.words.length > 0) {
      lines.push({ words: cur.words, start: cur.start, end: cur.end });
      cur = { words: [word], text: word.w, start: word.start, end: word.end };
    } else {
      cur.words.push(word);
      cur.text = next;
      cur.end = word.end;
    }
  }
  if (cur.words.length) lines.push({ words: cur.words, start: cur.start, end: cur.end });
  return lines;
}

/** 秒 → ASS タイム形式 h:mm:ss.cc */
function assTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/** ASS の特殊文字をエスケープ */
function escAss(text) {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "（").replace(/\}/g, "）").replace(/\n/g, "\\N");
}

/** スタイルに応じた ASS ヘッダ（[Script Info]+[V4+ Styles]+[Events] 見出し）を作る */
function buildHeader(W, H, font, st, align) {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${font},${st.fontSize},${st.base},&H00000000,&H00000000,1,1,${st.outline},${st.shadow},${align},60,60,${st.marginV},1
Style: Hook,${font},66,&H0000FFFF,&H00111111,&H00000000,1,1,7,4,8,40,40,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
}

/** karaoke: 行を出しつつ、現在の単語だけ highlight 色で 1 語ずつ移動表示 */
function karaokeEvents(relWords, st, maxChars) {
  const lines = groupCaptionsWords(relWords, maxChars);
  const ev = [];
  for (const line of lines) {
    const ws = line.words;
    for (let i = 0; i < ws.length; i++) {
      const start = ws[i].start;
      const end = i < ws.length - 1 ? ws[i + 1].start : line.end; // 次語まで連続表示（点滅防止）
      if (end <= start) continue;
      const text = ws
        .map((w, j) =>
          j === i ? `{\\c${st.highlight}&}${escAss(w.w)}{\\c${st.base}&}` : escAss(w.w)
        )
        .join("");
      ev.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`);
    }
  }
  return ev;
}

/** pop: 1 単語だけ画面中央に大きく、フェードで出ては消える */
function popEvents(relWords, duration) {
  const ev = [];
  for (let i = 0; i < relWords.length; i++) {
    const w = relWords[i];
    const start = w.start;
    const end = i < relWords.length - 1 ? relWords[i + 1].start : Math.min(duration, w.end + 0.3);
    if (end <= start) continue;
    ev.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,{\\fad(40,40)}${escAss(w.w)}`);
  }
  return ev;
}

/** line: 行単位でまとめて表示（現状互換） */
function lineEvents(relWords, maxChars) {
  const captions = groupCaptions(relWords, maxChars);
  return captions.map(
    (c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,${escAss(c.text)}`
  );
}

/**
 * 区間ぶんの ASS 字幕全文を生成。hook 文は画面上部に常時表示、本文字幕は選択スタイルで描画。
 * @param {{w:string,start:number,end:number}[]} relWords 区間先頭基準の相対 words
 * @param {string} hook 冒頭煽り文
 * @param {number} duration 区間長(秒)
 * @param {object} opts { style, width, height, fontMain, maxChars }
 */
export function buildAss(relWords, hook, duration, opts = {}) {
  const W = opts.width ?? 1080;
  const H = opts.height ?? 1920;
  const fontMain = opts.fontMain ?? "Yu Gothic UI";
  const styleRef = opts.style ?? DEFAULT_SUBTITLE_STYLE;
  const st =
    typeof styleRef === "object" ? styleRef : getStyle(styleRef) || getStyle(DEFAULT_SUBTITLE_STYLE);
  const align = st.mode === "pop" ? 5 : 2; // pop=画面中央 / それ以外=下中央
  const maxChars = opts.maxChars ?? (st.mode === "karaoke" ? 14 : 18);

  const header = buildHeader(W, H, fontMain, st, align);
  let events = [];
  if (hook) {
    events.push(`Dialogue: 0,${assTime(0)},${assTime(duration)},Hook,,0,0,0,,{\\an8}${escAss(hook)}`);
  }
  if (st.mode === "karaoke") events = events.concat(karaokeEvents(relWords, st, maxChars));
  else if (st.mode === "pop") events = events.concat(popEvents(relWords, duration));
  else events = events.concat(lineEvents(relWords, maxChars));

  return `${header}\n${events.join("\n")}\n`;
}
