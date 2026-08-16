// tests/caption-fit-check.mjs — G-CAP-FIT（縦動画の字幕が読める形で出る）
//
// マスター指摘（2026-08-16）「字幕は縦動画にした時に酷すぎる」。
// 同梱フォントで実際に焼いて測ったところ、原因は3つだった。
//   1 折り返しの見積りが実測の 1.88 倍ずれている（全角1文字を 1.30×文字サイズ と数えていたが実測 0.690）
//     → 横960pxに16文字入るのに8文字で折り返し、画面の横幅を半分しか使わず単語の途中で切れる
//   2 縁取りが太すぎる（84pxの文字に14px＝16.7%）→ 隣の文字の黒とくっついて黒い塊になる
//   3 話に合わせて色が変わる（マスター指示「そもそも話に合わせて色を変えなくて良い」）
//
// 【この検査が見ているもの】ASS を書いたかどうかではなく、**実際に焼いた画素**。
// 折り返しは「生成した ASS に \N が入るか」と「焼いた墨の幅」の両方で見る。
//
// 実行: node tests/caption-fit-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildAss } from "../src/srt-builder.mjs";
import {
  FONT_CATALOG,
  FONTS_DIR,
  SUBTITLE_STYLES,
  DEFAULT_SUBTITLE_STYLE,
  resolveCaptionStyle,
} from "../src/subtitle-styles.mjs";
import { hasFfmpeg, readPixelsRgb, bboxOf, dominantColors, colorClose } from "./helpers/caption-style-render.mjs";

const W = 1080;
const H = 1920;
const MARGIN_LR = 60; // srt-builder の captionMarginLR（基準canvasでは 60px）
const AVAIL = W - MARGIN_LR * 2; // 可用幅 960px
const FS_MEASURE = 84; // 比率の実測に使う文字サイズ（既定スタイルと同じ）
const RATIO_TOL = 0.02; // カタログの実測比と測り直した値の許容差
// 上限。1行を画面の端から端まで伸ばさない（実物のショート動画は短い行を積む）。
const NOWRAP_FILL_MAX = 0.92;
// 漢字1文字の実際の高さが画面の高さに占める割合（G-CAP-FIT-SIZE）。
const EM_RATIO_MIN = 0.04;
const EM_RATIO_MAX = 0.065;
// 縁取りの黒の左右差の上限（G-CAP-FIT-NOSHADOW）。影を付けると片側だけ黒が伸びる。
const SHADOW_ASYM_MAX = 0.15;
const BG_KEEP_MIN = 0.2; // 文字の帯の中に地が残る割合の下限
const OLD_OUTLINE_RATIO = 14 / 84; // 直す前の縁取り比（対照に使う）
// 明るい背景の上でも文字の輪郭が残ると言える、縁取りの暗い画素の割合の下限。
// 太すぎない側（BG_KEEP_MIN）だけだと縁取りを 1px にした実装が通ってしまう
// （basis-reviewer 2巡目の指摘。白い場面で白い字が読めなくなる）。
// 実測: 出荷値では 36.9〜46.5%、縁取り1pxでは 8.2〜10.1%。20% は両者をはっきり分ける値。
const OUTLINE_INK_MIN = 0.2;

let pass = 0,
  fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n      ${e.stack || e.message}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caption-fit-"));
const assPath = path.join(tmp, "c.ass");
const pngPath = path.join(tmp, "c.png");

/** ASS 本文を1フレーム焼く。bg は "black"（墨の幅を測る用）か 16進色。 */
function bake(ass, { bg = "black", atSec = 1 } = {}) {
  fs.writeFileSync(assPath, ass, "utf-8");
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-f", "lavfi", "-i", `color=size=${W}x${H}:color=${bg}:d=4`,
      "-vf", `ass=filename=${assPath}:fontsdir=${FONTS_DIR}`, "-ss", String(atSec), "-frames:v", "1", pngPath],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error("ffmpeg 失敗: " + r.stderr);
  return pngPath;
}

/** 素の Style 1行だけの ASS（比率の実測用。縁取り0で送り幅だけを見る）。 */
function plainAss(text, family, fontSize, outline = 0) {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: C,${family},${fontSize},&H00FFFFFF,&H00000000,&H00000000,1,1,${outline},0,5,10,10,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:04.00,C,,0,0,0,,${text}
`;
}

/** 墨（背景以外）の横幅。 */
function inkWidth(text, family, fontSize) {
  const b = bboxOf(bake(plainAss(text, family, fontSize)), 24);
  return b ? b.x2 - b.x1 : null;
}

/** 1文字あたりの送り幅の比（4文字と8文字の差を取り、左右のはみ出しを相殺する）。 */
function advanceRatio(unit, family) {
  const w4 = inkWidth(unit.repeat(4), family, FS_MEASURE);
  const w8 = inkWidth(unit.repeat(8), family, FS_MEASURE);
  return (w8 - w4) / 4 / FS_MEASURE;
}

/** 文字の帯の中で、背景の色のまま残っている画素の割合。 */
function bgKeepRatio(family, outlinePx) {
  const png = bake(plainAss("今日は動画編集の話", family, FS_MEASURE, outlinePx), { bg: "0x00ff00" });
  const buf = readPixelsRgb(png);
  const isGreen = (i) => buf[i] < 60 && buf[i + 1] > 180 && buf[i + 2] < 60;
  const y0 = Math.round(H / 2 - FS_MEASURE / 2);
  const y1 = Math.round(H / 2 + FS_MEASURE / 2);
  let minX = W,
    maxX = 0;
  for (let y = y0; y < y1; y++)
    for (let x = 0; x < W; x++) {
      if (!isGreen((y * W + x) * 3)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  if (maxX <= minX) return 1;
  let green = 0,
    total = 0;
  for (let y = y0; y < y1; y++)
    for (let x = minX; x <= maxX; x++) {
      total++;
      if (isGreen((y * W + x) * 3)) green++;
    }
  return green / total;
}

/** 白い背景に焼いたとき、文字の帯の中で「暗い」画素が占める割合（＝縁取りが見えているか）。 */
function outlineInkRatio(family, outlinePx) {
  const png = bake(plainAss("今日は動画編集の話", family, FS_MEASURE, outlinePx), { bg: "white" });
  const buf = readPixelsRgb(png);
  const y0 = Math.round(H / 2 - FS_MEASURE / 2);
  const y1 = Math.round(H / 2 + FS_MEASURE / 2);
  let minX = W,
    maxX = 0;
  const isDark = (i) => buf[i] < 128 && buf[i + 1] < 128 && buf[i + 2] < 128;
  for (let y = y0; y < y1; y++)
    for (let x = 0; x < W; x++) if (isDark((y * W + x) * 3)) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  if (maxX <= minX) return 0;
  let dark = 0,
    total = 0;
  for (let y = y0; y < y1; y++)
    for (let x = minX; x <= maxX; x++) {
      total++;
      if (isDark((y * W + x) * 3)) dark++;
    }
  return dark / total;
}

/** 全角 n 文字の字幕を1つ作る（語は3つに割って渡す＝実運用と同じ形）。 */
function wordsOf(text, duration = 4) {
  const n = Math.max(1, Math.ceil(text.length / 3));
  const parts = [];
  for (let i = 0; i < text.length; i += n) parts.push(text.slice(i, i + n));
  const step = duration / parts.length;
  return parts.map((w, i) => ({ w, start: i * step, end: (i + 1) * step }));
}

if (!hasFfmpeg()) {
  console.error("ffmpeg が見つかりません。この検査は焼いた画素を実測するため ffmpeg が必要です。");
  process.exit(1);
}

/* ══════ ① 書体ごとの実測値がカタログと合っている ══════ */
for (const [key, font] of Object.entries(FONT_CATALOG)) {
  t(`METRICS: ${key} の文字幅の数値が、実際に描いた字と合っている`, () => {
    const wide = advanceRatio("あ", font.family);
    const narrow = advanceRatio("A", font.family);
    assert.ok(
      Math.abs(wide - font.wideRatio) <= RATIO_TOL,
      `全角の比がずれている: カタログ ${font.wideRatio} / 実測 ${wide.toFixed(3)}`,
    );
    assert.ok(
      Math.abs(narrow - font.narrowRatio) <= RATIO_TOL,
      `半角の比がずれている: カタログ ${font.narrowRatio} / 実測 ${narrow.toFixed(3)}`,
    );
  });
}

t("METRICS 対照: カタログの数値を1つずらすと落ちる", () => {
  const font = FONT_CATALOG.kaku;
  const wide = advanceRatio("あ", font.family);
  assert.ok(Math.abs(wide - (font.wideRatio + 0.2)) > RATIO_TOL, "0.2 ずらしても一致と判定している");
});

/* ══════ ② 収まる字幕を折り返さない ══════ */
// 【重要】この検査は「製品と同じ呼び方」でしか測らない。
// 製品(pipeline.mjs の `style: resolvedCaptionStyle ?? subStyle` / recaption-stage.mjs)は、
// 書体などを指定しないとき buildAss へ**スタイル名の文字列**を渡す。検査だけが
// resolveCaptionStyle() の戻り値を渡していると、文字列経路が直っていなくても緑になる
// （2026-08-16 basis-reviewer 指摘。実際その状態で 40 PASS だった）。
// そこで既定の測定対象は文字列キーそのものにする。
const PRODUCT_STYLE = DEFAULT_SUBTITLE_STYLE; // 製品の既定経路（文字列）
const st = resolveCaptionStyle(DEFAULT_SUBTITLE_STYLE, {});

/** 製品が実際に Style 行へ書いた値を読む（宣言値ではなく、焼く直前の値）。 */
function productStyle(styleRef) {
  const ass = buildAss([{ w: "国", start: 0, end: 2 }], "", 2, { width: W, height: H, style: styleRef });
  const line = ass.split("\n").find((l) => l.startsWith("Style: Caption,"));
  assert.ok(line, "Caption の Style 行が無い");
  const f = line.slice("Style: Caption,".length).split(",");
  return { family: f[0], fontSize: Number(f[1]), outline: Number(f[7]), shadow: Number(f[8]) };
}

// 製品が実際に使う文字サイズ。宣言値(84)ではない。
const SCALED_FS = productStyle(PRODUCT_STYLE).fontSize;

/** 1行だけを焼いて墨の幅を測る。 */
function lineWidth(text, style) {
  const ass = buildAss([{ w: text, start: 0, end: 2 }], "", 2, { width: W, height: H, style, maxChars: 999 });
  const b = bboxOf(bake(ass), 24);
  return b ? b.x2 - b.x1 : 0;
}
/**
 * 製品と同じ呼び方で焼いた字幕を、**字幕ごと**に行へ割って墨の幅の割合を返す。
 *
 * 字幕をまたいで平らにしてはいけない。最終行の幅は「折り返しの見積り」ではなく
 * 「その字幕に残った言葉の量」で決まる（11文字の言葉で1行に9文字入るなら2行目は必ず2文字）ため、
 * どの行が最終行かを字幕ごとに知らないと、下限の判定が測定として成立しない。
 * @returns {{caption: string, lines: string[], fills: number[]}[]}
 */
function capFills(words, duration, style) {
  const ass = buildAss(words, "", duration, { width: W, height: H, style });
  const caps = [];
  for (const l of ass.split("\n")) {
    if (!l.startsWith("Dialogue") || !l.includes(",Caption,")) continue;
    const body = (l.split(",,0,0,0,,")[1] ?? "").replace(/\{[^}]*\}/g, "");
    if (body && body !== caps[caps.length - 1]) caps.push(body);
  }
  return caps.map((c) => {
    const lines = c.split("\\N").filter((x) => x.trim());
    return { caption: c, lines, fills: lines.map((x) => lineWidth(x, style) / AVAIL) };
  });
}
/** 全角の字幕を、製品と同じ呼び方で焼いて字幕ごとの行の割合を返す。 */
function lineFills(text, style) {
  return capFills(wordsOf(text, 8), 8, style);
}
/** 字幕ごとの実測を1行のログにする。 */
function fmt(byCap) {
  return byCap.map((c) => c.fills.map((f) => (f * 100).toFixed(1) + "%").join(" / ")).join(" ｜ ");
}

const NOWRAP_SRC = "えっと昔僕も1時間半くらいある動画を5分にまとめてくれと言われて";
const EN_WORDS = "Hello everyone welcome back to my channel today".split(" ").map((w, i) => ({
  w,
  start: i * 0.4,
  end: (i + 1) * 0.4,
}));
// 1行に使ってよい幅（可用幅の90%）。実物のショート動画は1行を画面の端から端まで伸ばさない。
const LINE_BUDGET = AVAIL * 0.9;
// 1枚の字幕の中で、いちばん広い行といちばん狭い行の差の上限（可用幅に対する割合）。
// 均等に割れば差は「全角1文字ぶん」＝100px＝可用幅の10.4%。20%はその1文字ぶんの余裕。
const EVEN_MAX_GAP = 0.2;

/** 幅の見積り（製品と同じ比）。 */
function advPx(ch) {
  const cp = ch.codePointAt(0);
  const wide = cp >= 0x2e80 && cp <= 0xa4cf;
  return SCALED_FS * (wide ? st.wideRatio : st.narrowRatio);
}

/**
 * 字幕ごとの「必要な行数」。
 * 日本語（空白なし）はどこでも折れるので、墨の総幅 ÷ 1行の予算 の切り上げ。
 * 半角の語が混じる字幕は語の途中で折れないので、語を順に詰めたときの行数
 * （＝語を切らずに詰められる最小の行数）。
 */
function neededLines(cap) {
  const text = cap.lines.join(cap.caption.includes(" ") ? " " : "");
  const totalPx = cap.fills.reduce((sum, f) => sum + f * AVAIL, 0);
  if (!text.includes(" ")) return Math.max(1, Math.ceil(totalPx / LINE_BUDGET));
  let n = 1;
  let px = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = [...word].reduce((sum, ch) => sum + advPx(ch), 0);
    const sp = px > 0 ? advPx(" ") : 0;
    if (px > 0 && px + sp + w > LINE_BUDGET) {
      n++;
      px = w;
    } else px += sp + w;
  }
  return n;
}

t("LINES: 行数が必要最小限になっている（折り返しの見積りが過大でない）", () => {
  const byCap = lineFills(NOWRAP_SRC, PRODUCT_STYLE).concat(capFills(EN_WORDS, 4, PRODUCT_STYLE));
  console.log(`  [実測] ${fmt(byCap)}`);
  for (const c of byCap) {
    assert.strictEqual(
      c.lines.length,
      neededLines(c),
      `字幕「${c.caption}」が ${c.lines.length}行。墨の量から要る行数は ${neededLines(c)}行`,
    );
  }
});

t("LINES 対照: 旧来の見積り（全角=1.30×文字サイズ）へ戻すと、要らない行が増える", () => {
  const old = { ...st, wideRatio: 1.3, narrowRatio: 0.65 };
  const byCap = lineFills(NOWRAP_SRC, old);
  console.log(`  [実測] 旧来の見積りだと: ${fmt(byCap)}`);
  assert.ok(
    byCap.some((c) => c.lines.length > neededLines(c)),
    `旧来の見積りでも行数が最小のまま: ${fmt(byCap)}`,
  );
});

t("MAXFILL: どの行も可用幅の92%以下（1行を画面の端から端まで伸ばさない）", () => {
  const byCap = lineFills(NOWRAP_SRC, PRODUCT_STYLE).concat(capFills(EN_WORDS, 4, PRODUCT_STYLE));
  for (const c of byCap)
    c.fills.forEach((f, i) => {
      assert.ok(
        f <= NOWRAP_FILL_MAX,
        `${i + 1}行目が長すぎる: ${(f * 100).toFixed(1)}%（上限 ${NOWRAP_FILL_MAX * 100}%）「${c.lines[i]}」`,
      );
    });
});

t("MAXFILL 対照: 1行を幅いっぱいまで詰めると上限92%を超える", () => {
  const greedy = { ...st, wideRatio: st.wideRatio / 2, narrowRatio: st.narrowRatio / 2 };
  const byCap = lineFills(NOWRAP_SRC, greedy);
  console.log(`  [実測] 詰め込むと: ${fmt(byCap)}`);
  assert.ok(byCap.some((c) => c.fills.some((f) => f > NOWRAP_FILL_MAX)), `上限を超えない: ${fmt(byCap)}`);
});

t("EVEN: 日本語の字幕は、1枚の中の行の長さが揃っている（最後の行に端数が残らない）", () => {
  const byCap = lineFills(NOWRAP_SRC, PRODUCT_STYLE);
  for (const c of byCap) {
    if (c.lines.length < 2) continue;
    const gap = Math.max(...c.fills) - Math.min(...c.fills);
    console.log(`  [実測] 「${c.caption.slice(0, 8)}…」 差 ${(gap * 100).toFixed(1)}%`);
    assert.ok(
      gap <= EVEN_MAX_GAP,
      `行の長さの差が大きい: ${(gap * 100).toFixed(1)}%（上限 ${EVEN_MAX_GAP * 100}%）${fmt([c])}`,
    );
  }
});

/** 予算いっぱいまで貪欲に詰めた行割り（＝均さない実装の参照）。 */
function greedySplit(text) {
  const out = [];
  let cur = "";
  let px = 0;
  for (const ch of text) {
    const w = advPx(ch);
    if (px > 0 && px + w > LINE_BUDGET) {
      out.push(cur);
      cur = ch;
      px = w;
    } else {
      cur += ch;
      px += w;
    }
  }
  if (cur) out.push(cur);
  return out;
}

t("EVEN 対照: 予算いっぱいまで貪欲に詰めると、最後の行に端数が残って差が開く", () => {
  // 均さない実装（＝この直しの前）の行割りを検査側で作り、同じ測り方で落ちることを見る。
  const lines = greedySplit("今日は動画編集の話をこれから自動化し");
  const fills = lines.map((l) => lineWidth(l, PRODUCT_STYLE) / AVAIL);
  const gap = Math.max(...fills) - Math.min(...fills);
  console.log(`  [実測] 貪欲に詰めると ${fills.map((f) => (f * 100).toFixed(1) + "%").join(" / ")} → 差 ${(gap * 100).toFixed(1)}%`);
  assert.ok(gap > EVEN_MAX_GAP, `貪欲に詰めても差が開かない: ${(gap * 100).toFixed(1)}%`);
});

/** Dialogue から本文だけを取り出す（ASSタグと強制改行を除き、連続する重複行をまとめる）。 */
function captionTexts(ass, keepBreaks = false) {
  const raw = ass
    .split("\n")
    .filter((l) => l.startsWith("Dialogue") && l.includes(",Caption,"))
    .map((l) => l.split(",,0,0,0,,")[1] ?? "")
    .map((t) => t.replace(/\{[^}]*\}/g, ""))
    .map((t) => (keepBreaks ? t : t.replace(/\\N/g, "")));
  const out = [];
  for (const t of raw) if (t && t !== out[out.length - 1]) out.push(t);
  return out;
}

t("WORDS: 半角の語が、語の途中で切れない／語の区切りが読める", () => {
  const ass = buildAss(EN_WORDS, "", 4, { width: W, height: H, style: PRODUCT_STYLE });
  const lines = captionTexts(ass, true).flatMap((c) => c.split("\\N"));
  console.log(`  [実測] ${JSON.stringify(lines)}`);
  const shown = lines.join(" ").split(/\s+/).filter(Boolean);
  const src = EN_WORDS.map((w) => w.w);
  assert.deepStrictEqual(shown, src, `語が壊れている\n  入力: ${src.join(" ")}\n  出力: ${shown.join(" ")}`);
});

t("WORDS 対照: 語の切れ目を見ない実装だと、語が途中で切れて区切りも消える", () => {
  // 直す前の実装＝語を空白なしで連結し、どこでも折る。検査側で同じものを作り、落ちることを見る。
  const joined = EN_WORDS.map((w) => w.w).join("");
  const lines = greedySplit(joined);
  const shown = lines.join(" ").split(/\s+/).filter(Boolean);
  console.log(`  [実測] 対照: ${JSON.stringify(lines)}`);
  assert.notDeepStrictEqual(
    shown,
    EN_WORDS.map((w) => w.w),
    "語の壊れを見分けられていない",
  );
});

t("NOLOSS: 折り返しても、話した言葉が1文字も消えない", () => {
  const src = "今日の動画では動画編集を自動化する方法を最後まで詳しく説明していきます";
  const ass = buildAss(wordsOf(src), "", 4, { width: W, height: H, style: PRODUCT_STYLE });
  const joined = captionTexts(ass).join("");
  assert.strictEqual(joined, src, `字幕から言葉が消えている\n  入力: ${src}\n  出力: ${joined}`);
});

t("NOLOSS 対照: あふれた分を捨てる実装だと落ちる", () => {
  const src = "今日の動画では動画編集を自動化する方法を最後まで詳しく説明していきます";
  const ass = buildAss(wordsOf(src), "", 4, { width: W, height: H, style: PRODUCT_STYLE });
  const truncated = ass
    .split("\n")
    .map((l) => {
      if (!l.startsWith("Dialogue")) return l;
      const i = l.indexOf(",,0,0,0,,");
      if (i < 0) return l;
      return l.slice(0, i + 9) + l.slice(i + 9).replace(/\{[^}]*\}/g, "").slice(0, 8);
    })
    .join("\n");
  assert.notStrictEqual(captionTexts(truncated).join(""), src, "切り捨てを検出できていない");
});

/* ══════ ③ 収まらない字幕ははみ出さない ══════ */
const longChars = Math.ceil((AVAIL * 2.5) / (SCALED_FS * st.wideRatio));
const longText = "あ".repeat(longChars);

t(`WRAP: 可用幅の2.5倍(${longChars}文字)の字幕が、画面からはみ出さない`, () => {
  const ass = buildAss(wordsOf(longText), "", 4, { width: W, height: H, style: PRODUCT_STYLE });
  const b = bboxOf(bake(ass), 24);
  assert.ok(b, "墨が見つからない");
  console.log(`  [実測] 墨の範囲 x1=${b.x1} x2=${b.x2}（安全域 60〜1020）`);
  assert.ok(b.x1 >= MARGIN_LR, `左へはみ出している: x1=${b.x1}`);
  assert.ok(b.x2 <= W - MARGIN_LR, `右へはみ出している: x2=${b.x2}`);
});

t("WRAP 対照: 折り返しを止めると右へはみ出す（折り返しが効いていることを示す）", () => {
  // budget を無限にする＝折り返し無効。style の比を 0 にすると幅の見積りが 0 になり同じ状態になる。
  const noWrap = { ...st, wideRatio: 0, narrowRatio: 0 };
  const ass = buildAss(wordsOf(longText), "", 4, { width: W, height: H, style: noWrap });
  const b = bboxOf(bake(ass), 24);
  assert.ok(b.x2 > W - MARGIN_LR, `折り返しを止めてもはみ出さない: x2=${b.x2}`);
});

/* ══════ ④ 縁取りが太すぎない ══════ */
for (const [key, font] of Object.entries(FONT_CATALOG)) {
  t(`OUTLINE: ${key} で、文字と文字の間に地が見える`, () => {
    const outline = Math.max(1, Math.round(FS_MEASURE * font.outlineRatio));
    const keep = bgKeepRatio(font.family, outline);
    const ps = productStyle(resolveCaptionStyle(PRODUCT_STYLE, { fontKey: key }));
    assert.strictEqual(
      ps.outline,
      Math.max(1, Math.round(ps.fontSize * font.outlineRatio)),
      `製品が書いた縁取り(${ps.outline}px)が、書体の実測比から外れている`,
    );
    console.log(`  [実測] ${key}: 縁取り ${outline}px で 地が残る割合 ${(keep * 100).toFixed(1)}%`);
    assert.ok(
      keep >= BG_KEEP_MIN,
      `縁取りが太すぎて地が見えない: ${(keep * 100).toFixed(1)}%（下限 ${BG_KEEP_MIN * 100}%）`,
    );
  });
}

for (const [key, font] of Object.entries(FONT_CATALOG)) {
  t(`OUTLINE-MIN: ${key} で、明るい背景の上でも文字の輪郭が残る`, () => {
    const outline = Math.max(1, Math.round(FS_MEASURE * font.outlineRatio));
    const ink = outlineInkRatio(font.family, outline);
    console.log(`  [実測] ${key}: 白背景で暗い画素 ${(ink * 100).toFixed(1)}%`);
    assert.ok(
      ink >= OUTLINE_INK_MIN,
      `縁取りが細すぎて明るい背景で読めない: ${(ink * 100).toFixed(1)}%（下限 ${OUTLINE_INK_MIN * 100}%）`,
    );
  });
}

t("OUTLINE-MIN 対照: 縁取りを1pxまで細くすると、5書体すべてが下限を割る", () => {
  const measured = Object.entries(FONT_CATALOG).map(([key, font]) => {
    const ink = outlineInkRatio(font.family, 1);
    return `${key}=${(ink * 100).toFixed(1)}%`;
  });
  console.log(`  [実測] 縁取り1px: ${measured.join(" / ")}`);
  const ok = measured.filter((m) => Number(m.split("=")[1].replace("%", "")) >= OUTLINE_INK_MIN * 100);
  assert.deepStrictEqual(ok, [], `縁取り1pxでも下限を満たす書体がある: ${ok.join(", ")}`);
});

t("OUTLINE 対照: 直す前の太さ(16.7%)へ戻すと、5書体すべてが下限を割る", () => {
  const bad = [];
  for (const [key, font] of Object.entries(FONT_CATALOG)) {
    const keep = bgKeepRatio(font.family, Math.round(FS_MEASURE * OLD_OUTLINE_RATIO));
    if (keep >= BG_KEEP_MIN) bad.push(`${key}=${(keep * 100).toFixed(1)}%`);
  }
  assert.deepStrictEqual(bad, [], `直す前の太さでも下限を満たす書体がある: ${bad.join(", ")}`);
});

/* ══════ ⑤ 話に合わせて色が変わらない ══════ */
/**
 * 焼いたフレームから「文字に使われている色」を取り出す。
 * 支配色1つだけを見ると、3語のうち1語だけ色を変えても多数派（白）のままで気付けない
 * （この検査の対照で実際に素通りした）。上位の色のうち、1位の 5% 以上の面積を持つものを
 * すべて「使われている色」として数える。縁取りの黒と背景は除く。
 */
function inkColors(buf) {
  const top = dominantColors(buf, [0, 0, 0], 60, 12);
  if (!top.length) return [];
  const floor = top[0].count * 0.05;
  return top
    .filter((c) => c.count >= floor)
    .map((c) => c.color)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

/** 同じ字幕が出ている3つの時点の「使われている色」を返す。 */
function colorsOverTime(style) {
  const words = [
    { w: "あああ", start: 0, end: 1 },
    { w: "いいい", start: 1, end: 2 },
    { w: "ううう", start: 2, end: 3 },
  ];
  const ass = buildAss(words, "", 3, { width: W, height: H, style });
  return [0.5, 1.5, 2.5].map((at) => inkColors(readPixelsRgb(bake(ass, { atSec: at }))));
}

/** 2つの「使われている色の集合」が同じか（±12 で対応が取れるか）。 */
function sameColorSet(a, b) {
  if (a.length !== b.length) return false;
  return a.every((c, i) => colorClose(c, b[i], 12));
}

for (const key of Object.keys(SUBTITLE_STYLES)) {
  t(`COLOR: 「${SUBTITLE_STYLES[key].label}」は、1つの字幕の間ずっと同じ色`, () => {
    const sets = colorsOverTime(resolveCaptionStyle(key, {}));
    console.log(`  [実測] ${key}: ${sets.map((s2) => s2.map((c) => `rgb(${c})`).join("+")).join(" / ")}`);
    for (const s2 of sets) {
      assert.strictEqual(
        s2.length,
        1,
        `1枚の中に文字の色が ${s2.length} 種類ある（話に合わせて色を変えている）: ${s2.map((c) => `rgb(${c})`).join(", ")}`,
      );
    }
    assert.ok(sameColorSet(sets[0], sets[1]), `1→2 で色が変わった`);
    assert.ok(sameColorSet(sets[1], sets[2]), `2→3 で色が変わった`);
  });
}

t("COLOR 対照: 話に合わせて色を変えるスタイルだと、3枚の色が割れる", () => {
  const speechSynced = { ...resolveCaptionStyle("karaoke", {}), highlight: "&H0000FFFF" };
  const sets = colorsOverTime(speechSynced);
  console.log(`  [実測] 対照: ${sets.map((s2) => s2.map((c) => `rgb(${c})`).join("+")).join(" / ")}`);
  const detected = sets.some((s2) => s2.length > 1);
  assert.ok(detected, "色を変えるスタイルなのに1色だと判定した＝色の違いを見分けられていない");
});

t("COLOR: 画面から選べるスタイルに、話に合わせて色を変えるものが無い", () => {
  const html = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "webapp-mockup", "index.html"), "utf-8");
  const block = html.slice(html.indexOf('data-group="subStyle"'));
  const keys = [...block.slice(0, block.indexOf("</div>")).matchAll(/data-val="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 2, `画面のスタイル選択肢が読めない: ${keys.join(",")}`);
  for (const k of keys) {
    const s = SUBTITLE_STYLES[k];
    assert.ok(s, `画面にあるスタイル「${k}」が登録表に無い`);
    assert.strictEqual(
      s.highlight,
      s.base,
      `画面から選べる「${s.label}」が、話に合わせて色を変える設定になっている（highlight=${s.highlight} / base=${s.base}）`,
    );
  }
});

/* ══════ ⑤' 製品の既定の呼び方で、直したとおりに焼かれる ══════ */
//
// 2026-08-16 basis-reviewer 指摘。この検査は当初、buildAss へ resolveCaptionStyle() の
// **戻り値**しか渡しておらず、製品が実際に使う「スタイル名の文字列」経路を一度も測っていなかった。
// その経路は素のプリセット（Fontsize 84 / Outline 14 / Shadow 8 / 同梱外の書体）へ落ちており、
// 直したはずの字の大きさ・折り返し・縁取り・影が**まるごと元に戻っていた**のに 40 PASS だった。
// ここは「呼び方が違っても同じ結果になる」ことを、焼く直前の値そのもので押さえる。

t("WIRED: スタイル名の文字列で呼んでも（＝製品の既定の呼び方）、直したとおりの字幕になる", () => {
  const byKey = productStyle(PRODUCT_STYLE);
  const byObj = productStyle(resolveCaptionStyle(PRODUCT_STYLE, {}));
  console.log(`  [実測] 文字列で呼ぶと ${JSON.stringify(byKey)}`);
  assert.deepStrictEqual(byKey, byObj, "呼び方によって焼かれる字幕が違う");
  assert.strictEqual(byKey.shadow, 0, `影が付いている: ${byKey.shadow}`);
  assert.ok(FONT_CATALOG[st.fontKey], `同梱していない書体で焼こうとしている: ${byKey.family}`);
  assert.strictEqual(byKey.family, FONT_CATALOG[st.fontKey].family, "同梱書体で焼いていない");
});

for (const key of Object.keys(SUBTITLE_STYLES)) {
  t(`WIRED: 「${SUBTITLE_STYLES[key].label}」も、文字列で呼んで同じ扱いになる`, () => {
    assert.deepStrictEqual(productStyle(key), productStyle(resolveCaptionStyle(key, {})));
  });
}

t("WIRED 対照: 直す前の呼び方（素のプリセットをそのまま渡す）だと、直す前の値のまま焼かれる", () => {
  const raw = productStyle({ ...SUBTITLE_STYLES[PRODUCT_STYLE] });
  const fixed = productStyle(PRODUCT_STYLE);
  console.log(`  [実測] 素のプリセット ${JSON.stringify(raw)}`);
  assert.ok(
    raw.fontSize < fixed.fontSize && raw.shadow > 0,
    `直す前と直したあとを見分けられていない: 素=${JSON.stringify(raw)} / 直後=${JSON.stringify(fixed)}`,
  );
});

/* ══════ ⑥ 文字がスマホで読める大きさ ══════ */
/** 「国」を1文字だけ縁取り0で焼き、墨の高さが画面の高さに占める割合を返す。 */
function kanjiHeightRatio(family, fontSize) {
  const b = bboxOf(bake(plainAss("国", family, fontSize)), 24);
  assert.ok(b, "墨が見つからない");
  return (b.y2 - b.y1) / H;
}

for (const [key] of Object.entries(FONT_CATALOG)) {
  t(`SIZE: ${key} の字が、スマホで読める大きさで描かれている`, () => {
    // 指定値(Fontsize)は ascent+descent であって em ではないため、書体ごとに縦の余白の比が違う。
    // 製品は「画面の高さに対する字の実寸」から逆算している。ここは**製品が Style 行へ書いた値**を
    // 読み出して焼き、画素で測る（検査が自分で計算し直すと、製品が直っていなくても緑になる）。
    const ps = productStyle(resolveCaptionStyle(PRODUCT_STYLE, { fontKey: key }));
    const ratio = kanjiHeightRatio(ps.family, ps.fontSize);
    console.log(`  [実測] ${key}: 製品が書いた指定値 ${ps.fontSize} → 漢字の高さ ${(ratio * 100).toFixed(1)}%`);
    assert.ok(
      ratio >= EM_RATIO_MIN && ratio <= EM_RATIO_MAX,
      `${(ratio * 100).toFixed(1)}% は範囲外（${EM_RATIO_MIN * 100}〜${EM_RATIO_MAX * 100}%）`,
    );
  });
}

t("SIZE 対照: 直す前の指定値(84)へ戻すと、下限4.0%を割る", () => {
  const ratio = kanjiHeightRatio(FONT_CATALOG.kaku.family, FS_MEASURE);
  console.log(`  [実測] 指定値84: 漢字の高さ ${(ratio * 100).toFixed(1)}%`);
  assert.ok(ratio < EM_RATIO_MIN, `直す前の指定値でも下限を満たす: ${(ratio * 100).toFixed(1)}%`);
});

/* ══════ ⑦ 縁取りの外側にもう一段の黒を重ねていない ══════ */
/**
 * 白い墨の左端から左へ、右端から右へ、黒が続く画素数（＝黒がはみ出している幅）を測り、
 * 左右差の割合を返す。影は右下へ伸びるため、影があると右側だけ黒が長く伸びる。
 *
 * 【行ごとに数えない理由】1行ずつ「その行の白の左端から左へ黒が続く数」を数えると、
 * その行に白が無い隣の字の縁取り（べた塗りの黒）まで数えてしまい、字の形しだいで
 * 0〜119px と暴れる（実測）。影の有無ではなく字形を測ることになるので、
 * 白の墨全体の外枠と、黒の墨全体の外枠の差＝「黒が外へはみ出した幅」を左右で比べる。
 */
function shadowAsymmetry(style) {
  const words = wordsOf("今日は動画編集の話", 4);
  const ass = buildAss(words, "", 4, { width: W, height: H, style });
  const buf = readPixelsRgb(bake(ass, { bg: "0x00ff00" }));
  const isWhite = (i) => buf[i] > 200 && buf[i + 1] > 200 && buf[i + 2] > 200;
  const isBlack = (i) => buf[i] < 60 && buf[i + 1] < 60 && buf[i + 2] < 60;
  const edges = (hit) => {
    let x0 = W,
      x1 = -1;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (hit((y * W + x) * 3)) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
        }
    return [x0, x1];
  };
  const [wx0, wx1] = edges(isWhite);
  const [bx0, bx1] = edges(isBlack);
  assert.ok(wx1 >= 0 && bx1 >= 0, "白または黒の墨が見つからない");
  const left = wx0 - bx0;
  const right = bx1 - wx1;
  const span = Math.max(left, right);
  return { left, right, asym: span <= 0 ? 0 : Math.abs(left - right) / span };
}

t("NOSHADOW: 字幕の黒が文字の左右で対称（外側にもう一段の黒を重ねていない）", () => {
  const r = shadowAsymmetry(PRODUCT_STYLE);
  console.log(`  [実測] 左 ${r.left}px / 右 ${r.right}px → 差 ${(r.asym * 100).toFixed(1)}%`);
  assert.ok(
    r.asym <= SHADOW_ASYM_MAX,
    `左右差が大きい: ${(r.asym * 100).toFixed(1)}%（上限 ${SHADOW_ASYM_MAX * 100}%）`,
  );
});

t("NOSHADOW 対照: 影を8px付けると左右差が15%を超える", () => {
  const r = shadowAsymmetry({ ...resolveCaptionStyle(PRODUCT_STYLE, {}), shadow: 8 });
  console.log(`  [実測] 影8px: 左 ${r.left}px / 右 ${r.right}px → 差 ${(r.asym * 100).toFixed(1)}%`);
  assert.ok(r.asym > SHADOW_ASYM_MAX, `影を付けても左右差が出ない: ${(r.asym * 100).toFixed(1)}%`);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n合計: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
