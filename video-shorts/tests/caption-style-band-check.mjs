// G-EDIT-CAPTION-STYLE-BAND-ON / -OFF — 背景帯(box)のオン/オフと色を指定通りに焼けることを検証する。
//
// 実行: node tests/caption-style-band-check.mjs [--mode on|off]
//   --mode 省略時は両方検査する(pnpm test から呼ぶときはこちら)。

import { resolveCaptionStyle } from "../src/subtitle-styles.mjs";
import {
  hasFfmpeg, renderCaptionFrame, readPixelsRgb, bboxOf, colorClose, cleanup,
} from "./helpers/caption-style-render.mjs";

/** フレーム全体で、指定色に近い画素数を数える(帯はグリフごとの矩形で構成され、単純な
 *  1点サンプリングでは当たり外れが出るため、面積ベースで検出する)。 */
function countColor(buf, target, tolerance = 20) {
  let n = 0;
  for (let i = 0; i < buf.length; i += 3) {
    if (colorClose([buf[i], buf[i + 1], buf[i + 2]], target, tolerance)) n++;
  }
  return n;
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const TEXT = "帯テスト";
const WIDTH = 1080, HEIGHT = 1920;
const BAND_RGB = [0x10, 0x20, 0x40]; // #102040 不透明(alpha省略=不透明)

function checkOn() {
  if (!hasFfmpeg()) { console.log("FAIL ffmpeg が見つかりません。"); fail++; return; }
  const style = resolveCaptionStyle("bold", { box: { enabled: true, colorHex: "#102040" } });
  const r = renderCaptionFrame(TEXT, style, { width: WIDTH, height: HEIGHT });
  check("背景帯ON: レンダリングできる", r.ok, r.stderr);
  if (r.ok) {
    const bbox = bboxOf(r.outPng, 24); // 既存テストと同じmin_val(tv-rangeの黒Y=16より確実に上)
    check("背景帯ON: フレームから帯+文字の画素範囲が読める", !!bbox, JSON.stringify(bbox));
    const buf = readPixelsRgb(r.outPng);
    const bandPixels = countColor(buf, BAND_RGB, 20);
    check(
      "背景帯ON: 指定色(#102040)の帯が、面積を持って実際に焼かれている",
      bandPixels >= 500,
      `帯色画素数=${bandPixels}`,
    );
  }
  cleanup(r.tmp);
}

function checkOff() {
  if (!hasFfmpeg()) { console.log("FAIL ffmpeg が見つかりません。"); fail++; return; }
  const styleOff = resolveCaptionStyle("bold", {});
  const styleOn = resolveCaptionStyle("bold", { box: { enabled: true, colorHex: "#102040" } });

  const rOff = renderCaptionFrame(TEXT, styleOff, { width: WIDTH, height: HEIGHT });
  const rOn = renderCaptionFrame(TEXT, styleOn, { width: WIDTH, height: HEIGHT });
  check("背景帯OFF: レンダリングできる", rOff.ok, rOff.stderr);
  check("背景帯ON(対照用): レンダリングできる", rOn.ok, rOn.stderr);

  if (rOff.ok && rOn.ok) {
    const bboxOn = bboxOf(rOn.outPng, 24);
    const bboxOffText = bboxOf(rOff.outPng, 24); // 文字のみのbbox(既存テストと同じmin_val)
    check("背景帯ON側のbboxが取得できる", !!bboxOn, JSON.stringify(bboxOn));
    check("背景帯OFF側の文字bboxが取得できる", !!bboxOffText, JSON.stringify(bboxOffText));
    if (bboxOn && bboxOffText) {
      const areaOn = (bboxOn.x2 - bboxOn.x1) * (bboxOn.y2 - bboxOn.y1);
      const areaOffText = (bboxOffText.x2 - bboxOffText.x1) * (bboxOffText.y2 - bboxOffText.y1);
      check(
        "背景帯ONのbbox(帯を含む)は、OFFの文字だけのbboxより明確に大きい(=帯が実際に描かれている証拠)",
        areaOn > areaOffText * 1.3,
        `areaOn=${areaOn} areaOffText=${areaOffText}`,
      );
    }
    const bufOff = readPixelsRgb(rOff.outPng);
    const bandPixelsOff = countColor(bufOff, BAND_RGB, 20);
    check(
      "背景帯OFF: 帯ONなら現れるはずの帯色画素が、背景帯OFFではほぼ現れない(検出力の裏付け)",
      bandPixelsOff < 20,
      `帯色画素数(OFF)=${bandPixelsOff}`,
    );
  }
  cleanup(rOff.tmp);
  cleanup(rOn.tmp);
}

const args = process.argv.slice(2);
const modeFlagIdx = args.indexOf("--mode");
const requested = modeFlagIdx >= 0 ? [args[modeFlagIdx + 1]] : ["on", "off"];

if (requested.includes("on")) checkOn();
if (requested.includes("off")) checkOff();

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
