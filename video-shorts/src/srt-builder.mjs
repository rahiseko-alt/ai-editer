// video-shorts [5] 字幕生成 — 区間内の word-level を読みやすい字幕行にまとめ、
// 背景ボックス付き ASS 字幕を生成する。9:16(1080x1920)前提。
//
// 既製SaaSの「全ユーザー同一字幕」を避け自前デザインを握る（差別化・RB FORKOFF）。
// スタイルは選択式（subtitle-styles.mjs の登録を参照）: karaoke/pop/line を mode で切替。

import { getStyle, DEFAULT_SUBTITLE_STYLE, computeSubtitleScale, scaleToken } from "./subtitle-styles.mjs";

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

/**
 * 秒 → ASS タイム形式 h:mm:ss.cc
 *
 * 【P2-3 のバグと直し方】旧実装は h/m/s を先に切り捨ててから、centisecond を
 * 別途 `Math.round((sec - Math.floor(sec)) * 100)` で出していた。99.xx センチ秒台の
 * 値を四捨五入すると 100 になりうる（例: 59.996秒 → 整数秒部分は59のまま・小数部
 * 0.996*100=99.6 を round すると100）が、繰り上げ先の秒(s)側はすでに切り捨て済みで
 * 更新されないため `0:00:59.100` のような3桁のcentisecond（ASSとして不正な時刻）を
 * 吐いてしまい、字幕の表示タイミングがずれる（実際には59.996秒は次の1分00秒0.00秒に
 * 繰り上がるべき）。
 *
 * 直し方は「先に全体を100分の1秒単位の整数へ丸めてから、その整数１つを
 * h/m/s/cs に分解する」。丸めを1回・最後に整数だけで行うため、centisecondが
 * 100になる余地そのものが無くなり、繰り上がりは自動的に h/m/s 側へ伝播する。
 */
export function assTime(sec) {
  const totalCs = Math.round(sec * 100); // 100分の1秒単位の整数へ丸める（ここでしか丸めない）
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/** ASS の特殊文字をエスケープ */
function escAss(text) {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "（").replace(/\}/g, "）").replace(/\n/g, "\\N");
}

// ── AUD-P2-22: canvasに収まる表示幅(全角=2/半角=1カラム)を基準にした折り返し ──────────
//
// 文字「数」ベースの既存グルーピング(groupCaptions/groupCaptionsWords の maxChars)だけでは、
// canvasが小さい（拡大ガードで縮小された場合等）ときや、1語が極端に長い（伸ばし語・URL等）
// ときに、その1トークンだけで canvas の横幅からはみ出しうる（groupCaptions* は「既に中身が
// ある行に足すと超える」場合しか改行しないため、単独の長い1語はそのまま素通りする）。
// ここでは実際の canvas 幅・スケール後フォントサイズ・スケール後余白から「収まる見た目
// カラム数(maxCols)」を求め、それでも収まらないトークンだけを ASS の強制改行(\N)で
// 分割する。通常サイズ・通常長の字幕（既に canvas に収まっている大多数のケース）は
// displayCols(text) <= maxCols が成り立つため無変化のまま（回帰リスクを抑える）。

/** 全角相当(East Asian Wide/Fullwidth・ハングル音節等)なら2カラム、それ以外(半角)は1カラム。 */
function charDisplayWidth(ch) {
  const cp = ch.codePointAt(0);
  const WIDE_RANGES = [
    [0x1100, 0x115f], // Hangul Jamo
    [0x2e80, 0xa4cf], // CJK Radicals..Yi（漢字・ひらがな・カタカナを含む）
    [0xac00, 0xd7a3], // Hangul Syllables
    [0xf900, 0xfaff], // CJK Compatibility Ideographs
    [0xff00, 0xff60], // Fullwidth Forms
    [0xffe0, 0xffe6],
    [0x20000, 0x3fffd], // CJK Extension B以降
  ];
  return WIDE_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1;
}

/** 文字列の表示幅（カラム数の合計）。コードポイント単位で数える（サロゲートペア対応）。 */
function displayCols(text) {
  return Array.from(text).reduce((sum, ch) => sum + charDisplayWidth(ch), 0);
}

/**
 * canvas幅・スケール後fontSize・スケール後左右余白(片側)から、1行に収まる目安のカラム数を出す。
 * 求まらない（幅0以下等）ときは Infinity（＝制限しない・従来どおり）。
 *
 * 【perColumnPx の実測根拠】太字・大文字英数字(半角=1カラム)を実際にlibass(DejaVu Sans Bold
 * フォールバック)で描画し、フレームの画素から実測したところ、fontsize=29pxで1文字あたり
 * 約18.7px（≈0.645×fontsize）だった（検証: scratchpad/audit-verify/verify-aud-p2-22.mjs の
 * 事前調査）。輪郭線(Outline)が字の左右にもわずかに広がる分の安全マージンを足し、
 * 0.72×fontsize を1カラムぶんの目安として使う（実測より広めに見積もる＝はみ出す方向より
 * 早めに折り返す方向に倒して安全側にする）。全角(2カラム)は、フォントの字送りが概ね
 * fontsize相当という一般的な経験則から、同じ式のまま「2カラム分」として扱う。
 */
function computeMaxCols(canvasW, scaledFontSize, marginLR) {
  const available = Number(canvasW) - marginLR * 2;
  if (!(available > 0) || !(scaledFontSize > 0)) return Infinity;
  const perColumnPx = scaledFontSize * 0.72;
  return Math.max(1, Math.floor(available / perColumnPx));
}

/**
 * 文字列を maxCols を超えないよう分割する（超えないならそのまま1要素の配列）。
 * グラフィム単位ではなくコードポイント単位（サロゲートペア対応）で切る。
 */
function splitByDisplayWidth(text, maxCols) {
  if (!Number.isFinite(maxCols) || displayCols(text) <= maxCols) return [text];
  const chars = Array.from(text);
  const pieces = [];
  let cur = "";
  let curCols = 0;
  for (const ch of chars) {
    const w = charDisplayWidth(ch);
    if (curCols > 0 && curCols + w > maxCols) {
      pieces.push(cur);
      cur = ch;
      curCols = w;
    } else {
      cur += ch;
      curCols += w;
    }
  }
  if (cur) pieces.push(cur);
  return pieces.length ? pieces : [text];
}

/** スタイルに応じた ASS ヘッダ（[Script Info]+[V4+ Styles]+[Events] 見出し）を作る */
function buildHeader(W, H, font, st, align, scale) {
  // AUD-P2-22: Caption/Hook の絶対px値（フォントサイズ・縁取り・影・余白）を canvas に応じて
  // 比例縮小する。scale=1（canvasが基準どおり）のときは全て元の値のまま＝従来どおりの見た目。
  const captionMarginLR = scaleToken(60, scale);
  const hookFontSize = scaleToken(66, scale);
  const hookOutline = scaleToken(7, scale);
  const hookShadow = scaleToken(4, scale);
  const hookMarginLR = scaleToken(40, scale);
  const hookMarginV = scaleToken(150, scale);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${font},${scaleToken(st.fontSize, scale)},${st.base},&H00000000,&H00000000,1,1,${scaleToken(st.outline, scale)},${scaleToken(st.shadow, scale)},${align},${captionMarginLR},${captionMarginLR},${scaleToken(st.marginV, scale)},1
Style: Hook,${font},${hookFontSize},&H0000FFFF,&H00111111,&H00000000,1,1,${hookOutline},${hookShadow},8,${hookMarginLR},${hookMarginLR},${hookMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
}

/** karaoke: 行を出しつつ、現在の単語だけ highlight 色で 1 語ずつ移動表示 */
function karaokeEvents(relWords, st, maxChars, maxCols) {
  const lines = groupCaptionsWords(relWords, maxChars);
  const ev = [];
  for (const line of lines) {
    const ws = line.words;
    // 各単語を maxCols で断片化する（収まる単語は1断片のまま）。断片は元の単語indexを保持し、
    // ハイライト色は「その断片の元になった単語」が現在の単語(i)かどうかで決める。
    const runs = [];
    ws.forEach((w, wi) => {
      for (const piece of splitByDisplayWidth(w.w, maxCols)) runs.push({ text: piece, wordIndex: wi });
    });
    for (let i = 0; i < ws.length; i++) {
      const start = ws[i].start;
      const end = i < ws.length - 1 ? ws[i + 1].start : line.end; // 次語まで連続表示（点滅防止）
      if (end <= start) continue;
      let text = "";
      let curCols = 0;
      for (const run of runs) {
        const cols = displayCols(run.text);
        if (curCols > 0 && Number.isFinite(maxCols) && curCols + cols > maxCols) {
          text += "\\N";
          curCols = 0;
        }
        const escaped = escAss(run.text);
        text += run.wordIndex === i ? `{\\c${st.highlight}&}${escaped}{\\c${st.base}&}` : escaped;
        curCols += cols;
      }
      ev.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`);
    }
  }
  return ev;
}

/** pop: 1 単語だけ画面中央に大きく、フェードで出ては消える */
function popEvents(relWords, duration, maxCols) {
  const ev = [];
  for (let i = 0; i < relWords.length; i++) {
    const w = relWords[i];
    const start = w.start;
    const end = i < relWords.length - 1 ? relWords[i + 1].start : Math.min(duration, w.end + 0.3);
    if (end <= start) continue;
    const text = splitByDisplayWidth(w.w, maxCols).map(escAss).join("\\N");
    ev.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,{\\fad(40,40)}${text}`);
  }
  return ev;
}

/** line: 行単位でまとめて表示（現状互換） */
function lineEvents(relWords, maxChars, maxCols) {
  const captions = groupCaptions(relWords, maxChars);
  return captions.map((c) => {
    const text = splitByDisplayWidth(c.text, maxCols).map(escAss).join("\\N");
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,${text}`;
  });
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

  // AUD-P2-22: canvasに応じてstyleの絶対px値を比例縮小し、実際に収まる見た目カラム数を求める。
  const scale = computeSubtitleScale(W, H);
  const scaledFontSize = scaleToken(st.fontSize, scale);
  const captionMarginLR = scaleToken(60, scale);
  const maxCols = computeMaxCols(W, scaledFontSize, captionMarginLR);

  const header = buildHeader(W, H, fontMain, st, align, scale);
  let events = [];
  if (hook) {
    events.push(`Dialogue: 0,${assTime(0)},${assTime(duration)},Hook,,0,0,0,,{\\an8}${escAss(hook)}`);
  }
  if (st.mode === "karaoke") events = events.concat(karaokeEvents(relWords, st, maxChars, maxCols));
  else if (st.mode === "pop") events = events.concat(popEvents(relWords, duration, maxCols));
  else events = events.concat(lineEvents(relWords, maxChars, maxCols));

  return `${header}\n${events.join("\n")}\n`;
}
