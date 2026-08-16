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
const NOWRAP_FILL_MIN = 0.6; // 1行の墨の幅が可用幅に占める割合の下限
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
const st = resolveCaptionStyle(DEFAULT_SUBTITLE_STYLE, {});
// 可用幅の 90%(864px) に収まる全角文字数
const fitChars = Math.floor((AVAIL * 0.9) / (st.fontSize * st.wideRatio));
const fitText = "今日は動画編集を自動化する方法についてお話しします".slice(0, fitChars);

t(`NOWRAP: 可用幅の90%に収まる字幕(${fitChars}文字)が1行で描かれ、幅を使っている`, () => {
  const ass = buildAss(wordsOf(fitText), "", 4, { width: W, height: H, style: st });
  const dialogues = ass.split("\n").filter((l) => l.startsWith("Dialogue"));
  assert.ok(dialogues.length > 0, "字幕イベントが1つも無い");
  for (const d of dialogues) assert.ok(!d.includes("\\N"), `収まるのに折り返している: ${d}`);
  const b = bboxOf(bake(ass), 24);
  assert.ok(b, "墨が見つからない");
  const fill = (b.x2 - b.x1) / AVAIL;
  console.log(`  [実測] 1行の墨の幅 ${b.x2 - b.x1}px / 可用幅 ${AVAIL}px = ${(fill * 100).toFixed(1)}%`);
  assert.ok(
    fill >= NOWRAP_FILL_MIN,
    `画面の横幅を使えていない: ${(fill * 100).toFixed(1)}%（下限 ${NOWRAP_FILL_MIN * 100}%）`,
  );
});

t("NOWRAP 対照: 旧来の見積り（全角=2カラム×0.65）へ戻すと、同じ字幕が折り返して幅を割る", () => {
  // 旧実装の見積り＝全角1文字あたり 1.30×fontSize。style の比をそれに差し替えて再現する。
  const old = { ...st, wideRatio: 1.3, narrowRatio: 0.65 };
  const ass = buildAss(wordsOf(fitText), "", 4, { width: W, height: H, style: old });
  // 行のまとめ方も幅で決めるようになったので、旧来の見積りでは1つの行に入る語が減り、
  // 「1つの字幕の中の \N」ではなく「字幕そのものが増える」形で現れる。どちらの形であれ、
  // マスターが見て困る症状＝1行が画面の横幅を使えないことを、焼いた墨の幅で判定する。
  const b = bboxOf(bake(ass), 24);
  const fill = (b.x2 - b.x1) / AVAIL;
  console.log(`  [実測] 旧来の見積りだと ${b.x2 - b.x1}px = ${(fill * 100).toFixed(1)}%`);
  assert.ok(fill < NOWRAP_FILL_MIN, `旧来の見積りでも幅を使えている: ${(fill * 100).toFixed(1)}%`);
});

/** Dialogue から本文だけを取り出す（ASSタグと強制改行を除き、連続する重複行をまとめる）。 */
function captionTexts(ass) {
  const raw = ass
    .split("\n")
    .filter((l) => l.startsWith("Dialogue") && l.includes(",Caption,"))
    .map((l) => l.split(",,0,0,0,,")[1] ?? "")
    .map((t) => t.replace(/\{[^}]*\}/g, "").replace(/\\N/g, ""));
  const out = [];
  for (const t of raw) if (t && t !== out[out.length - 1]) out.push(t);
  return out;
}

t("NOWRAP: 折り返しても、話した言葉が1文字も消えない", () => {
  // basis-reviewer 2巡目の指摘: 「はみ出さない」だけを見ると、あふれた分を黙って捨てる
  // 実装が通ってしまう。字幕から言葉が消えるのは、はみ出しより重い実害。
  const src = "今日の動画では動画編集を自動化する方法を最後まで詳しく説明していきます";
  const ass = buildAss(wordsOf(src), "", 4, { width: W, height: H, style: st });
  const joined = captionTexts(ass).join("");
  assert.strictEqual(joined, src, `字幕から言葉が消えている\n  入力: ${src}\n  出力: ${joined}`);
});

t("NOWRAP 対照: あふれた分を捨てる実装だと落ちる", () => {
  const src = "今日の動画では動画編集を自動化する方法を最後まで詳しく説明していきます";
  const ass = buildAss(wordsOf(src), "", 4, { width: W, height: H, style: st });
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

t("NOWRAP: 半角中心の字幕でも、画面の横幅を使う", () => {
  // 全角だけで測ると、半角文字の字幕が幅の4割しか使わない状態を見逃す（同上の指摘）。
  const words = "Hello everyone welcome back to my channel today".split(" ").map((w, i) => ({
    w,
    start: i * 0.4,
    end: (i + 1) * 0.4,
  }));
  const ass = buildAss(words, "", 4, { width: W, height: H, style: st });
  const b = bboxOf(bake(ass), 24);
  const fill = (b.x2 - b.x1) / AVAIL;
  console.log(`  [実測] 半角中心の1行の墨の幅 ${b.x2 - b.x1}px = ${(fill * 100).toFixed(1)}%`);
  assert.ok(fill >= NOWRAP_FILL_MIN, `半角の字幕が幅を使えていない: ${(fill * 100).toFixed(1)}%`);
});

/* ══════ ③ 収まらない字幕ははみ出さない ══════ */
const longChars = Math.ceil((AVAIL * 2.5) / (st.fontSize * st.wideRatio));
const longText = "あ".repeat(longChars);

t(`WRAP: 可用幅の2.5倍(${longChars}文字)の字幕が、画面からはみ出さない`, () => {
  const ass = buildAss(wordsOf(longText), "", 4, { width: W, height: H, style: st });
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n合計: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
