// G-EDIT-CAPTION-STYLE-COLOR-FILL / -OUTLINE — 文字色(内側)・外側縁取り色を指定した色で
// 実際に焼けることを検証する。
//
// 実行: node tests/caption-style-color-check.mjs [--axis fill|outline]
//   --axis 省略時は両方検査する(pnpm test から呼ぶときはこちら)。

import { resolveCaptionStyle } from "../src/subtitle-styles.mjs";
import {
  hasFfmpeg, renderCaptionFrame, readPixelsRgb, dominantColors, colorClose, cleanup, assColorToRgb,
} from "./helpers/caption-style-render.mjs";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const TEXT = "色テストABC";
const WIDTH = 1080, HEIGHT = 1920;

function checkFill() {
  if (!hasFfmpeg()) { console.log("FAIL ffmpeg が見つかりません。"); fail++; return; }

  // outline幅を細く(2px)して、フレーム内で優勢な非背景色=fillだと判定しやすくする。
  const defaultStyle = resolveCaptionStyle("bold", {});
  defaultStyle.outline = 2;
  const redStyle = resolveCaptionStyle("bold", { fillHex: "#FF0000" });
  redStyle.outline = 2;

  const rDefault = renderCaptionFrame(TEXT, defaultStyle, { width: WIDTH, height: HEIGHT });
  const rRed = renderCaptionFrame(TEXT, redStyle, { width: WIDTH, height: HEIGHT });
  check("fill既定色: レンダリングできる", rDefault.ok, rDefault.stderr);
  check("fill赤指定: レンダリングできる", rRed.ok, rRed.stderr);
  if (rDefault.ok && rRed.ok) {
    const domDefault = dominantColors(readPixelsRgb(rDefault.outPng), [0, 0, 0], 16, 3);
    const domRed = dominantColors(readPixelsRgb(rRed.outPng), [0, 0, 0], 16, 3);
    const defaultTop = domDefault[0]?.color;
    const redTop = domRed[0]?.color;
    check(
      "fill既定色(白)が、実際に優勢色として検出できる(対照: この検出手段が働く証拠)",
      !!defaultTop && colorClose(defaultTop, [255, 255, 255], 20),
      `優勢色=${defaultTop}`,
    );
    check(
      "fill赤指定が、指定どおり優勢色として焼かれている",
      !!redTop && colorClose(redTop, [255, 0, 0], 20),
      `優勢色=${redTop}`,
    );
    check(
      "fill既定色と赤指定は、実際に異なる色として焼かれている",
      !!defaultTop && !!redTop && !colorClose(defaultTop, redTop, 20),
    );
  }
  cleanup(rDefault.tmp);
  cleanup(rRed.tmp);
}

function checkOutline() {
  if (!hasFfmpeg()) { console.log("FAIL ffmpeg が見つかりません。"); fail++; return; }

  // fillを白のまま、outlineを既定(黒)と青で比較する。outline幅を太く(20px)して
  // 優勢色2位(fillに次ぐ面積)として検出しやすくする。
  const defaultStyle = resolveCaptionStyle("bold", {});
  defaultStyle.outline = 20;
  const blueStyle = resolveCaptionStyle("bold", { outlineColorHex: "#0000FF" });
  blueStyle.outline = 20;

  const rDefault = renderCaptionFrame(TEXT, defaultStyle, { width: WIDTH, height: HEIGHT });
  const rBlue = renderCaptionFrame(TEXT, blueStyle, { width: WIDTH, height: HEIGHT });
  check("outline既定色: レンダリングできる", rDefault.ok, rDefault.stderr);
  check("outline青指定: レンダリングできる", rBlue.ok, rBlue.stderr);
  if (rDefault.ok && rBlue.ok) {
    // 既定(黒)の縁取りは背景(黒)と同色で見分けが付かないため、ここでは「青を指定したら
    // フレームに青画素が実際に現れ、既定(縁取り黒指定なし)には現れない」という対照で確認する。
    const bufDefault = readPixelsRgb(rDefault.outPng);
    const bufBlue = readPixelsRgb(rBlue.outPng);
    const blueRgb = assColorToRgb("&H00FF0000");
    const countBlue = (buf) => {
      let n = 0;
      for (let i = 0; i < buf.length; i += 3) {
        if (colorClose([buf[i], buf[i + 1], buf[i + 2]], blueRgb, 20)) n++;
      }
      return n;
    };
    const nDefault = countBlue(bufDefault);
    const nBlue = countBlue(bufBlue);
    check(
      "outline既定(黒)には青画素がほぼ現れない(対照)",
      nDefault < 50,
      `青画素数=${nDefault}`,
    );
    check(
      "outline青指定では、青画素が縁取り相当の面積で実際に現れる",
      nBlue >= 500,
      `青画素数=${nBlue}`,
    );
  }
  cleanup(rDefault.tmp);
  cleanup(rBlue.tmp);
}

const args = process.argv.slice(2);
const axisFlagIdx = args.indexOf("--axis");
const requested = axisFlagIdx >= 0 ? [args[axisFlagIdx + 1]] : ["fill", "outline"];

if (requested.includes("fill")) checkFill();
if (requested.includes("outline")) checkOutline();

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
