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
// ここでは実際の canvas 幅・スケール後フォントサイズ・スケール後余白から「1行に収まる
// 幅の予算(px)」を求め、それでも収まらないものだけを ASS の強制改行(\N)で分割する。
// 2026-08-16 に「カラム数」方式から「書体ごとの実測送り幅(px)を積む」方式へ全面差し替え
// （旧方式は全角1文字を実測の1.88倍に見積もっており、字幕が画面の横幅を半分しか
// 使わない主因だった。lineBudgetPx のコメントと docs/failures.md 2026-08-16 を参照）。

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

/**
 * 1行に収める幅の予算(px)を出す。canvas幅から左右の余白を引いた「可用幅」そのもの。
 *
 * 【2026-08-16 全面差し替え（G-CAP-FIT）】旧実装は「全角=2カラム／半角=1カラム」と数えたうえで
 * 1カラム = 0.65 × fontSize としていた。つまり全角1文字を 1.30 × fontSize と見積もっていたが、
 * 同梱フォントで実際に焼いて測った送り幅は 0.598〜1.000 × fontSize（書体による）で、
 * 既定書体では 0.690。**1.88倍ぶん多く見積もっていた**。その結果、横960pxに実際は16文字
 * 入るのに8文字で折り返し、字幕が画面の横幅を半分しか使わず、単語の途中で切れていた
 * （マスター指摘「字幕は縦動画にした時に酷すぎる」の主因。docs/failures.md 2026-08-16）。
 *
 * 新方式は「カラム数」を捨て、**書体ごとに実測した1文字あたりの送り幅(px)を積む**。
 * 実測値は FONT_CATALOG の wideRatio / narrowRatio（tests/caption-fit-check.mjs が
 * 同じ手順で測り直して照合するので、書体を差し替えれば必ず気付ける）。
 */
function lineBudgetPx(canvasW, marginLR) {
  const available = Number(canvasW) - marginLR * 2;
  return available > 0 ? available : Infinity;
}

// 同梱していない書体（システムのフォールバック等）で使う既定の比。
// 全角は 1.0（CJK の全角送りは em と同じ）。半角は 0.65 で、これは旧実装が
// 1カラム=0.65×fontSize としていた値と同じ＝未知の書体では従来どおりの安全側に倒す
// （DejaVu Sans Bold の大文字が実測 0.613 で、0.55 では足りずはみ出す。
//  tests/subtitle-canvas-fit-check.mjs がこの経路を押さえている）。
const FALLBACK_WIDE_RATIO = 1.0;
const FALLBACK_NARROW_RATIO = 0.65;

/** 1文字の送り幅(px)。全角か半角かで実測比を使い分ける。 */
function charAdvancePx(ch, scaledFontSize, wideRatio, narrowRatio) {
  const wide = charDisplayWidth(ch) === 2;
  const ratio = wide ? (wideRatio ?? FALLBACK_WIDE_RATIO) : (narrowRatio ?? FALLBACK_NARROW_RATIO);
  return scaledFontSize * ratio;
}

/** 文字列の描画幅(px)の見積り。 */
function textWidthPx(text, scaledFontSize, wideRatio, narrowRatio) {
  return Array.from(text).reduce(
    (sum, ch) => sum + charAdvancePx(ch, scaledFontSize, wideRatio, narrowRatio),
    0,
  );
}

/**
 * 文字列を、1行の幅の予算(px)を超えないよう分割する（超えないならそのまま1要素の配列）。
 * グラフィム単位ではなくコードポイント単位（サロゲートペア対応）で切る。
 * 予算は「実際に描いたら何pxになるか」の見積りなので、収まるものは折り返さない。
 */
function splitByDisplayWidth(text, budgetPx, scaledFontSize, wideRatio, narrowRatio) {
  if (!Number.isFinite(budgetPx)) return [text];
  if (textWidthPx(text, scaledFontSize, wideRatio, narrowRatio) <= budgetPx) return [text];
  const pieces = [];
  let cur = "";
  let curPx = 0;
  for (const ch of Array.from(text)) {
    const w = charAdvancePx(ch, scaledFontSize, wideRatio, narrowRatio);
    if (curPx > 0 && curPx + w > budgetPx) {
      pieces.push(cur);
      cur = ch;
      curPx = w;
    } else {
      cur += ch;
      curPx += w;
    }
  }
  if (cur) pieces.push(cur);
  return pieces.length ? pieces : [text];
}

/** スタイルに応じた ASS ヘッダ（[Script Info]+[V4+ Styles]+[Events] 見出し）を作る
 *  @param {number} captionMarginV Caption スタイルの MarginV（px・スケール適用済み） */
function buildHeader(W, H, font, st, align, scale, captionMarginV) {
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
  // 背景帯(box)は Style行(BorderStyle=3)では実装しない。この環境のffmpeg(6.1.1)同梱libassで
  // BorderStyle=3が塗りつぶされた矩形ではなく右下だけの細い縁(恐らくshadowの残骸)しか描かず、
  // 「背景帯」としての見た目を満たさないことが実装後の目視確認で判明した(2026-08-14。
  // docs/failures.md参照)。代わりに buildBackgroundBand() が ASS の描画コマンド(\p1)で
  // 直接矩形を描く(BorderStyle=1のまま・下のイベントで別Dialogueとして重ねる)。
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${font},${scaleToken(st.fontSize, scale)},${st.base},${outlineColor},&H00000000,1,1,${scaleToken(st.outline, scale)},${scaleToken(st.shadow, scale)},${align},${captionMarginLR},${captionMarginLR},${captionMarginV},1
Style: Hook,${font},${hookFontSize},&H0000FFFF,&H00111111,&H00000000,1,1,${hookOutline},${hookShadow},8,${hookMarginLR},${hookMarginLR},${hookMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
}

/**
 * 背景帯(box)を、ASSの描画コマンド(\p1〜\p0のベクター描画)で塗りつぶした矩形として直接描く。
 * BorderStyle=3(不透明ボックス)には頼らない(buildHeader()のコメント参照。この環境では
 * 塗りつぶしにならなかったため)。矩形は字幕の安全エリア(左右余白=captionMarginLR)いっぱいの
 * 横幅・フォントサイズ基準の高さを持つ帯として、区間の全長(duration)ぶん1本だけ描く
 * (karaoke等で単語ごとに複数のCaptionイベントがあっても、帯の位置はどれも同じ1本の帯で足りる)。
 * Layer -1(他のCaptionイベントより小さい)にして、文字より必ず背面に描かれるようにする。
 * @param {object} st resolveCaptionStyle() が返すスタイル
 * @param {number} W canvas幅
 * @param {number} H canvas高さ
 * @param {number} duration 区間長(秒)
 * @param {number} captionMarginLR Captionスタイルの左右余白(スケール後)
 * @param {number} scaledFontSize Captionスタイルのフォントサイズ(スケール後)
 * @param {number} align Captionスタイルの Alignment(2=下中央 / 5=画面中央)
 * @param {number} captionMarginV Captionスタイルの MarginV(px・スケール適用済み)
 * @returns {string[]}
 */
function buildBackgroundBand(st, W, H, duration, captionMarginLR, scaledFontSize, align, captionMarginV) {
  if (!st.box?.enabled) return [];
  const bandHeight = Math.round(scaledFontSize * 1.3);
  const x1 = captionMarginLR;
  const w = Math.max(1, W - captionMarginLR * 2);
  // 帯の縦位置は Caption スタイルの Alignment に合わせる（st.mode ではなく align を見る。
  // 字幕の位置を明示したときは pop でも align=2 へ落ちるため、mode で判定すると帯だけ
  // 画面中央に取り残される）。
  const y1 = align === 5
    ? Math.round(H / 2 - bandHeight / 2) // align=5: 画面中央基準
    : Math.max(0, H - captionMarginV - bandHeight); // align=2: 下端基準
  const draw = `m 0 0 l ${w} 0 ${w} ${bandHeight} 0 ${bandHeight}`;
  return [
    `Dialogue: -1,${assTime(0)},${assTime(duration)},Caption,,0,0,0,,` +
      `{\\an7\\pos(${x1},${y1})\\bord0\\shad0\\1c${st.box.color}\\p1}${draw}{\\p0}`,
  ];
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
function karaokeEvents(relWords, st, maxChars, budgetPx, fs) {
  const lines = groupCaptionsWords(relWords, maxChars);
  const ev = [];
  for (const line of lines) {
    const ws = line.words;
    // 各単語を maxCols で断片化する（収まる単語は1断片のまま）。断片は元の単語indexを保持し、
    // ハイライト色は「その断片の元になった単語」が現在の単語(i)かどうかで決める。
    const runs = [];
    ws.forEach((w, wi) => {
      for (const piece of splitByDisplayWidth(w.w, budgetPx, fs, st.wideRatio, st.narrowRatio))
        runs.push({ text: piece, wordIndex: wi });
    });
    for (let i = 0; i < ws.length; i++) {
      const start = ws[i].start;
      const end = i < ws.length - 1 ? ws[i + 1].start : line.end; // 次語まで連続表示（点滅防止）
      if (end <= start) continue;
      let text = "";
      let curPx = 0;
      for (const run of runs) {
        const px = textWidthPx(run.text, fs, st.wideRatio, st.narrowRatio);
        if (curPx > 0 && Number.isFinite(budgetPx) && curPx + px > budgetPx) {
          text += "\\N";
          curPx = 0;
        }
        const escaped = escAss(run.text);
        // highlight が base と同じなら色の切り替えタグを一切書かない（G-CAP-FIT-COLOR。
        // 話に合わせて色を変えないスタイルでは、途中で色が変わる余地そのものを残さない）。
        text +=
          run.wordIndex === i && st.highlight && st.highlight !== st.base
            ? `{\\c${st.highlight}&}${escaped}{\\c${st.base}&}`
            : escaped;
        curPx += px;
      }
      ev.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`);
    }
  }
  return ev;
}

/** pop: 1 単語だけ画面中央に大きく、フェードで出ては消える */
function popEvents(relWords, duration, budgetPx, fs, st) {
  const ev = [];
  for (let i = 0; i < relWords.length; i++) {
    const w = relWords[i];
    const start = w.start;
    const end = i < relWords.length - 1 ? relWords[i + 1].start : Math.min(duration, w.end + 0.3);
    if (end <= start) continue;
    const text = splitByDisplayWidth(w.w, budgetPx, fs, st.wideRatio, st.narrowRatio)
      .map(escAss)
      .join("\\N");
    ev.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,{\\fad(40,40)}${text}`);
  }
  return ev;
}

/** line: 行単位でまとめて表示（現状互換） */
function lineEvents(relWords, maxChars, budgetPx, fs, st) {
  const captions = groupCaptions(relWords, maxChars);
  return captions.map((c) => {
    const text = splitByDisplayWidth(c.text, budgetPx, fs, st.wideRatio, st.narrowRatio)
      .map(escAss)
      .join("\\N");
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
  // 字幕の位置を明示したとき(resolveCaptionStyle が st.align=2 を立てる)はそれを優先する。
  // 未指定なら従来どおり pop=画面中央 / それ以外=下中央。
  const align = st.align ?? (st.mode === "pop" ? 5 : 2);
  const maxChars = opts.maxChars ?? (st.mode === "karaoke" ? 14 : 18);

  // AUD-P2-22: canvasに応じてstyleの絶対px値を比例縮小し、実際に収まる見た目カラム数を求める。
  const scale = computeSubtitleScale(W, H);
  const scaledFontSize = scaleToken(st.fontSize, scale);
  const captionMarginLR = scaleToken(60, scale);
  const budgetPx = lineBudgetPx(W, captionMarginLR);

  // 見出し(Hook)は本文(Caption)と別スタイル（フォントサイズ66・左右余白40）なので、
  // 折り返し幅も別に計算する。従来はここを一切折り返しておらず、区間の見出し文が
  // 画面の左右へ大きくはみ出したまま区間の全長にわたって表示され続けていた
  // （実素材で横幅40カラム・画面に入るのは32カラム。docs/failures.md 2026-08-14）。
  const hookFontSize = scaleToken(66, scale);
  const hookMarginLR = scaleToken(40, scale);
  const hookBudgetPx = lineBudgetPx(W, hookMarginLR);

  // Caption の MarginV(px)。位置を明示していれば「canvas高さに対する割合」から実pxを求め、
  // 未指定なら従来どおりプリセットの絶対px値を canvas 比で縮小する（＝挙動を変えない）。
  const captionMarginV =
    st.marginVRatio != null
      ? Math.max(0, Math.round(H * st.marginVRatio))
      : scaleToken(st.marginV, scale);

  const header = buildHeader(W, H, fontMain, st, align, scale, captionMarginV);
  let events = [];
  events = events.concat(
    buildBackgroundBand(st, W, H, duration, captionMarginLR, scaledFontSize, align, captionMarginV),
  );
  if (hook) {
    const hookLines = splitByDisplayWidth(hook, hookBudgetPx, hookFontSize, st.wideRatio, st.narrowRatio)
      .map(escAss)
      .join("\\N");
    events.push(`Dialogue: 0,${assTime(0)},${assTime(duration)},Hook,,0,0,0,,{\\an8}${hookLines}`);
  }
  if (st.mode === "karaoke")
    events = events.concat(karaokeEvents(relWords, st, maxChars, budgetPx, scaledFontSize));
  else if (st.mode === "pop")
    events = events.concat(popEvents(relWords, duration, budgetPx, scaledFontSize, st));
  else events = events.concat(lineEvents(relWords, maxChars, budgetPx, scaledFontSize, st));

  events = applyInnerOutline(events, st, scale);

  return `${header}\n${events.join("\n")}\n`;
}
