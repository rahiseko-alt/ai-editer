// G-EDIT-CAPTION-STYLE-FONT-* — 書体選択(角ゴシック/丸ゴシック/明朝体/手書き風/マーカー風)が
// 実際に同梱ttf(システムフォントに頼らない)から異なる字形で焼かれることを検証する。
//
// 実行: node tests/caption-style-font-check.mjs [--font kaku|maru|mincho|hand|marker]
//   --font 省略時は5書体すべてを検査する(pnpm test から呼ぶときはこちら)。

import fs from "node:fs";
import { createHash } from "node:crypto";
import { FONT_CATALOG, resolveCaptionStyle, FONTS_DIR, fontFilePath } from "../src/subtitle-styles.mjs";
import { hasFfmpeg, renderCaptionFrame, readPixelsRgb, countDiffPixels, cleanup } from "./helpers/caption-style-render.mjs";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

// docs/roadmap.html の G-EDIT-CAPTION-STYLE-FONT-* criteria に記載した固定SHA-256(パンあて済み)。
const PINNED_SHA256 = {
  kaku: "63a34f5646cc2a8d7781638221eded85dd77c7104e2c02e15708633abbb8e657",
  maru: "7409964207251dab6315577128d3f6e9fd637d1fa7b0af771bb4cc029f07a4dd",
  mincho: "a19cc17fc0d9ff71331a8d779c5c41f1b4c0ee9b6491b190787cf290bfaef546",
  hand: "4b8d0022c8dadd090ef67cd1f71f130714767af7806cba2eb4ebe4b0271c1d68",
  marker: "82098615f39ed9da6a8ccc674b9006e49c70dd5b775a7a1697f6bedd22ce25a2",
};

const TEXT = "字幕テストABC123";
const WIDTH = 1080, HEIGHT = 1920;

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function baselineFor(key) {
  return key === "kaku" ? "maru" : "kaku";
}

function checkOneFont(key) {
  const font = FONT_CATALOG[key];
  check(`書体キー「${key}」がFONT_CATALOGに存在する`, !!font, key);
  if (!font) return;

  const filePath = fontFilePath(key);
  check(`${font.label}: 同梱ttfファイルが実在する(${font.file})`, fs.existsSync(filePath), filePath);
  if (!fs.existsSync(filePath)) return;

  const actualSha = sha256(filePath);
  check(
    `${font.label}: SHA-256が固定値と一致する`,
    actualSha === PINNED_SHA256[key],
    `期待 ${PINNED_SHA256[key]} / 実 ${actualSha}`,
  );

  if (!hasFfmpeg()) {
    console.log("FAIL ffmpeg が見つかりません。CI では quality ジョブで導入しています。");
    fail++;
    return;
  }

  const base = baselineFor(key);
  const styleTarget = resolveCaptionStyle("bold", { fontKey: key });
  const styleBase = resolveCaptionStyle("bold", { fontKey: base });

  const target = renderCaptionFrame(TEXT, styleTarget, { width: WIDTH, height: HEIGHT });
  check(`${font.label}: 実際にffmpegでレンダリングできる`, target.ok, target.stderr);
  check(
    `${font.label}: レンダリングコマンドのfontsdirが同梱パス(video-shorts/src/fonts)を指している`,
    target.fontsdir === FONTS_DIR && target.ass.includes(`Style: Caption,${font.family},`),
    `fontsdir=${target.fontsdir} / ass=${target.ass.split("\n").find((l) => l.startsWith("Style: Caption"))}`,
  );

  const baseline = renderCaptionFrame(TEXT, styleBase, { width: WIDTH, height: HEIGHT });
  check(`${FONT_CATALOG[base].label}(対照書体): 実際にffmpegでレンダリングできる`, baseline.ok, baseline.stderr);

  if (target.ok && baseline.ok) {
    const bufTarget = readPixelsRgb(target.outPng);
    const bufBase = readPixelsRgb(baseline.outPng);
    const diff = countDiffPixels(bufTarget, bufBase, 10);
    check(
      `${font.label}: 同一テキストでも${FONT_CATALOG[base].label}とはピクセル単位で字形が異なる(diff=${diff}px >= 1000px)`,
      diff >= 1000,
      `diff=${diff}px`,
    );
  }
  cleanup(target.tmp);
  cleanup(baseline.tmp);
}

const args = process.argv.slice(2);
const fontFlagIdx = args.indexOf("--font");
const requested = fontFlagIdx >= 0 ? [args[fontFlagIdx + 1]] : Object.keys(FONT_CATALOG);

for (const key of requested) checkOneFont(key);

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
