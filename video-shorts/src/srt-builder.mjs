// video-shorts [5] 字幕生成 — 区間内の word-level を読みやすい字幕行にまとめ、
// 背景ボックス付き ASS 字幕を生成する。9:16(1080x1920)前提。
//
// 既製SaaSの「全ユーザー同一字幕」を避け自前デザインを握る（差別化・RB FORKOFF）。
// スタイルは選択式（subtitle-styles.mjs の登録を参照）: karaoke/pop/line を mode で切替。

import { getStyle, DEFAULT_SUBTITLE_STYLE, computeSubtitleScale, scaleToken } from "./subtitle-styles.mjs";

// 既定フォント（2026-08-14 是正）。旧既定 "Yu Gothic UI" はWindows専用で、この製品が
// 動く環境（客のPC。Linux/macOSも含む想定）に存在しないことがあり、fontconfig が
// 黙って別言語のフォントへ代替していた（docs/failures.md 2026-08-14）。IPAGothicは
// パブリックドメイン相当のライセンスでOS横断の日本語フォントとして広く使われており、
// 配布物にも同梱しやすい。実在の確認は src/font-check.mjs が担う（このモジュールは
// 「どのフォント名を使うか」だけを持ち、「実在するか」の判定は持たない）。
export const DEFAULT_FONT = "IPAGothic";

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
 * 【perColumnPx の実測根拠（2026-08-14 更新）】旧係数0.72は、fontsize=29pxで1文字あたり
 * 約18.7px（≈0.645×fontsize）という測定（太字・大文字英数字＝半角=1カラム、DejaVu Sans Bold
 * フォールバック）に安全マージンを足したものだったが、日本語の全角文字（本来の用途）を
 * 実際に描画した画素で測っていなかった。実素材の処理で字幕が画面の7割しか使わず読みにくい
 * ことが判明（docs/failures.md 2026-08-14）。
 *
 * 改めて、出荷既定フォント IPAGothic で全角7文字「コンディーショ」を実際に libass で焼き、
 * 2つの独立したスケール（fontsize=84px・PlayResX=1080＝縦型の基準解像度／fontsize=28px・
 * PlayResX=360＝AUD-P2-22の縮小ケース）でフレームの画素から1カラムあたりの幅を実測した。
 * 結果は 36.6〜37.2px（fontsize=84時）・12.14px（fontsize=28時）で、比率は 0.434〜0.439 と
 * スケールに依らず一致した。
 *
 * ただし computeMaxCols は全角(2カラム)・半角(1カラム)を同じ perColumnPx で見積もる作りで、
 * 半角側の実測が別に要る。AUD-P2-22 の既存対照（DejaVu Sans・太字・半角大文字20字連続）を
 * 同じ手順で実測すると、半角1文字あたり 53.95px（fontsize=88時）＝比率 0.613 で、CJK全角の
 * 比率(0.434〜0.439)より大きい。同じ perColumnPx を両方に使う以上、安全な側（半角の実測
 * 0.613）に約6%の余裕を足した 0.65×fontsize を採用する。全角はこの式のまま「2カラム分」
 * として扱うため、CJK主体の字幕では実際の可用幅の約65%相当までしか使わない計算になるが、
 * 旧係数0.72（実測0.439の1.65倍＝可用幅の61%相当）からは改善している。半角の太字文字を
 * 同じ精度で測って初めて全角側の余裕を使い切れる設計（列ごとに別のpxを許す拡張）は、
 * 今回のスコープ外の改善余地として残す（検証: scratchpad配下で使い捨てスクリプトにより
 * 実測。再現手順はffmpegのassフィルタで同じStyle定義の.assを1フレーム焼き、閾値200の
 * 二値化で文字の画素範囲を読む。AUD-P2-22実測: 0.65のとき対照文字列でも左右34px以上の
 * 余白を確認済み）。
 */
function computeMaxCols(canvasW, scaledFontSize, marginLR) {
  const available = Number(canvasW) - marginLR * 2;
  if (!(available > 0) || !(scaledFontSize > 0)) return Infinity;
  const perColumnPx = scaledFontSize * 0.65;
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
  // 縁取り色: 既定は黒(&H00000000)。resolveCaptionStyle() で上乗せされていればそれを使う
  // （2026-08-14 追加。旧実装は縁取り色が常に固定で、Style行に書かず単に未指定=黒だった）。
  const outlineColor = st.outlineColor ?? "&H00000000";
  // 背景帯(box): st.box.enabled のときだけ BorderStyle=3（不透明ボックス背景）にし、
  // BackColour に指定色を使う。無効時は従来どおり BorderStyle=1（縁取りのみ・背景なし）。
  const boxEnabled = st.box?.enabled === true;
  const borderStyle = boxEnabled ? 3 : 1;
  const backColour = boxEnabled ? st.box.color : "&H00000000";
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${font},${scaleToken(st.fontSize, scale)},${st.base},${outlineColor},${backColour},1,${borderStyle},${scaleToken(st.outline, scale)},${scaleToken(st.shadow, scale)},${align},${captionMarginLR},${captionMarginLR},${scaleToken(st.marginV, scale)},1
Style: Hook,${font},${hookFontSize},&H0000FFFF,&H00111111,&H00000000,1,1,${hookOutline},${hookShadow},8,${hookMarginLR},${hookMarginLR},${hookMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
}

/**
 * 内側縁取り(二重縁取り)を、Captionスタイルの各Dialogue行を2枚重ねに複製することで実現する。
 * ASSの1つのStyleは縁取りを1色しか持てないため、以下の「重ね貼り」技法を使う:
 *   Layer 0（背面・外側）: 幅=st.outline(スケール後)・色=st.outlineColor で、文字色も
 *     outlineColorと同じ単色にして塗りつぶす（外側の縁だけが輪として見える下地）。
 *   Layer 1（前面・内側）: 幅=st.innerOutline.width(スケール後)・色=st.innerOutline.color で、
 *     文字色は元のまま(karaokeのハイライト等はそのまま活きる)。
 * ASSはLayer番号が大きいほど後から(上に)描画されるため、Layer1がLayer0の上に重なり、
 * 外側の縁の輪だけが内側の縁の外にリングとして残る。
 * @param {string[]} events "Dialogue: 0,...,Caption,,0,0,0,,text" 形式の行の配列(Hookを含む)
 * @param {object} st resolveCaptionStyle() が返すスタイル
 * @param {number} scale computeSubtitleScale() の結果
 * @returns {string[]}
 */
function applyInnerOutline(events, st, scale) {
  if (!st.innerOutline?.enabled) return events;
  const re = /^Dialogue: 0,([^,]+),([^,]+),Caption,,0,0,0,,(.*)$/;
  const outerW = scaleToken(st.outline, scale);
  const innerW = scaleToken(st.innerOutline.width, scale);
  const outerColor = st.outlineColor ?? "&H00000000";
  const innerColor = st.innerOutline.color;
  const out = [];
  for (const line of events) {
    const m = re.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const [, start, end, text] = m;
    const outerText = text.replace(/\{\\c[^}]*\}/g, "");
    out.push(
      `Dialogue: 0,${start},${end},Caption,,0,0,0,,{\\bord${outerW}\\shad0\\3c${outerColor}\\1c${outerColor}}${outerText}`,
    );
    out.push(`Dialogue: 1,${start},${end},Caption,,0,0,0,,{\\bord${innerW}\\3c${innerColor}}${text}`);
  }
  return out;
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
  const styleRef = opts.style ?? DEFAULT_SUBTITLE_STYLE;
  const st =
    typeof styleRef === "object" ? styleRef : getStyle(styleRef) || getStyle(DEFAULT_SUBTITLE_STYLE);
  // resolveCaptionStyle() 由来のスタイルは st.fontFamily を持つ（書体選択・G-EDIT-CAPTION-STYLE）。
  // 持たない場合(旧来のプリセットそのまま・テスト等)は opts.fontMain / DEFAULT_FONT にフォールバック。
  const fontMain = st.fontFamily ?? opts.fontMain ?? DEFAULT_FONT;
  const align = st.mode === "pop" ? 5 : 2; // pop=画面中央 / それ以外=下中央
  const maxChars = opts.maxChars ?? (st.mode === "karaoke" ? 14 : 18);

  // AUD-P2-22: canvasに応じてstyleの絶対px値を比例縮小し、実際に収まる見た目カラム数を求める。
  const scale = computeSubtitleScale(W, H);
  const scaledFontSize = scaleToken(st.fontSize, scale);
  const captionMarginLR = scaleToken(60, scale);
  const maxCols = computeMaxCols(W, scaledFontSize, captionMarginLR);

  // 見出し(Hook)は本文(Caption)と別スタイル（フォントサイズ66・左右余白40）なので、
  // 折り返し幅も別に計算する。従来はここを一切折り返しておらず、区間の見出し文が
  // 画面の左右へ大きくはみ出したまま区間の全長にわたって表示され続けていた
  // （実素材で横幅40カラム・画面に入るのは32カラム。docs/failures.md 2026-08-14）。
  const hookFontSize = scaleToken(66, scale);
  const hookMarginLR = scaleToken(40, scale);
  const hookMaxCols = computeMaxCols(W, hookFontSize, hookMarginLR);

  const header = buildHeader(W, H, fontMain, st, align, scale);
  let events = [];
  if (hook) {
    const hookLines = splitByDisplayWidth(hook, hookMaxCols).map(escAss).join("\\N");
    events.push(`Dialogue: 0,${assTime(0)},${assTime(duration)},Hook,,0,0,0,,{\\an8}${hookLines}`);
  }
  if (st.mode === "karaoke") events = events.concat(karaokeEvents(relWords, st, maxChars, maxCols));
  else if (st.mode === "pop") events = events.concat(popEvents(relWords, duration, maxCols));
  else events = events.concat(lineEvents(relWords, maxChars, maxCols));

  events = applyInnerOutline(events, st, scale);

  return `${header}\n${events.join("\n")}\n`;
}
