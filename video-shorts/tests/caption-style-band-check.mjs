// G-EDIT-CAPTION-STYLE-BAND-ON / -OFF — 背景帯(box)のオン/オフと色を指定通りに焼けることを検証する。
//
// 背景(2026-08-14): 当初 ASS の BorderStyle=3(不透明ボックス)で実装したが、この環境の
// ffmpeg(6.1.1)同梱libassでは塗りつぶした矩形にならず、右下だけの細い縁しか描かれない
// ことが目視で判明した(docs/failures.md参照)。BorderStyle=3をやめ、ASSの描画コマンド
// (\p1〜\p0のベクター描画)で直接矩形を塗る方式(srt-builder.mjsのbuildBackgroundBand())
// へ書き直した。この検査は「面積のどこかに帯色が500px以上ある」ではなく、実際に描いた
// はずの矩形(帯)の中で色が指定どおり埋まっている割合(充填率)を見る。
//
// 実行: node tests/caption-style-band-check.mjs [--mode on|off]
//   --mode 省略時は両方検査する(pnpm test から呼ぶときはこちら)。

import { resolveCaptionStyle } from "../src/subtitle-styles.mjs";
import {
  hasFfmpeg, renderCaptionFrame, readPixelsRgb, pixelAt, colorClose, cleanup,
} from "./helpers/caption-style-render.mjs";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const TEXT = "帯テスト";
const WIDTH = 1080, HEIGHT = 1920;
const BAND_RGB = [0x10, 0x20, 0x40]; // #102040 不透明(alpha省略=不透明)

// srt-builder.mjs の buildBackgroundBand() と同じ式で、期待される帯の矩形を求める
// (bold プリセット: fontSize=88・marginV=400。canvas は基準解像度なので scale=1)。
function expectedBandRect() {
  const captionMarginLR = 60;
  const scaledFontSize = 88;
  const marginV = 400;
  const bandHeight = Math.round(scaledFontSize * 1.3);
  const x1 = captionMarginLR;
  const w = WIDTH - captionMarginLR * 2;
  const y1 = HEIGHT - marginV - bandHeight;
  return { x1, y1, x2: x1 + w, y2: y1 + bandHeight };
}

/**
 * 矩形の縁(上下左右の帯状の外周だけ)をサンプリングし、指定色に一致する割合(0〜1)を返す。
 * 矩形の中心付近は文字(帯の上に描かれる)が占めるため塗りつぶし判定から除外し、
 * 文字が来ないはずの外周だけで「帯そのもの」が塗られているかを見る。
 */
function fillRatio(buf, rect, target, tolerance = 20, step = 4, borderPx = 12) {
  let total = 0, matched = 0;
  const sample = (x, y) => {
    total++;
    if (colorClose(pixelAt(buf, WIDTH, x, y), target, tolerance)) matched++;
  };
  for (let x = rect.x1; x < rect.x2; x += step) {
    for (let dy = 0; dy < borderPx; dy++) {
      sample(x, rect.y1 + dy);
      sample(x, rect.y2 - 1 - dy);
    }
  }
  for (let y = rect.y1; y < rect.y2; y += step) {
    for (let dx = 0; dx < borderPx; dx++) {
      sample(rect.x1 + dx, y);
      sample(rect.x2 - 1 - dx, y);
    }
  }
  return total > 0 ? matched / total : 0;
}

function checkOn() {
  if (!hasFfmpeg()) { console.log("FAIL ffmpeg が見つかりません。"); fail++; return; }
  const style = resolveCaptionStyle("bold", { box: { enabled: true, colorHex: "#102040" } });
  const r = renderCaptionFrame(TEXT, style, { width: WIDTH, height: HEIGHT });
  check("背景帯ON: レンダリングできる", r.ok, r.stderr);
  if (r.ok) {
    const buf = readPixelsRgb(r.outPng);
    const rect = expectedBandRect();
    const ratio = fillRatio(buf, rect, BAND_RGB);
    check(
      "背景帯ON: 想定した帯の矩形の外周(文字が来ない領域)が、指定色でほぼ塗りつぶされている(充填率90%以上)",
      ratio >= 0.9,
      `充填率=${(ratio * 100).toFixed(1)}% rect=${JSON.stringify(rect)}`,
    );
  }
  cleanup(r.tmp);
}

function checkOff() {
  if (!hasFfmpeg()) { console.log("FAIL ffmpeg が見つかりません。"); fail++; return; }
  const styleOff = resolveCaptionStyle("bold", {});
  const rOff = renderCaptionFrame(TEXT, styleOff, { width: WIDTH, height: HEIGHT });
  check("背景帯OFF: レンダリングできる", rOff.ok, rOff.stderr);
  if (rOff.ok) {
    const buf = readPixelsRgb(rOff.outPng);
    const rect = expectedBandRect();
    const ratio = fillRatio(buf, rect, BAND_RGB);
    check(
      "背景帯OFF: 帯ONなら塗りつぶされるはずの矩形が、背景帯OFFではほぼ塗られていない(充填率5%未満。検出力の裏付け)",
      ratio < 0.05,
      `充填率=${(ratio * 100).toFixed(1)}%`,
    );
  }
  cleanup(rOff.tmp);
}

const args = process.argv.slice(2);
const modeFlagIdx = args.indexOf("--mode");
const requested = modeFlagIdx >= 0 ? [args[modeFlagIdx + 1]] : ["on", "off"];

if (requested.includes("on")) checkOn();
if (requested.includes("off")) checkOff();

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
