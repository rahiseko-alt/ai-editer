// G-EDIT-CAPTION-STYLE-INNER — 内側の縁取り(二重縁取り)をオンにすると、外側と別の色の縁が
// もう1本内側に入ることを検証する。オフのときは内側の帯が存在しないことも対照として確認する。
//
// 実行: node tests/caption-style-inner-check.mjs

import { resolveCaptionStyle } from "../src/subtitle-styles.mjs";
import {
  hasFfmpeg, renderCaptionFrame, readPixelsRgb, colorClose, cleanup,
} from "./helpers/caption-style-render.mjs";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const TEXT = "内側テストABC";
const WIDTH = 1080, HEIGHT = 1920;
const INNER_YELLOW = [255, 255, 0];

function countColor(buf, target, tolerance = 20) {
  let n = 0;
  for (let i = 0; i < buf.length; i += 3) {
    if (colorClose([buf[i], buf[i + 1], buf[i + 2]], target, tolerance)) n++;
  }
  return n;
}

if (!hasFfmpeg()) {
  console.log("FAIL ffmpeg が見つかりません。");
  fail++;
} else {
  const onStyle = resolveCaptionStyle("bold", {
    innerOutline: { enabled: true, colorHex: "#FFFF00", width: 4 },
  });
  onStyle.outline = 20; // 外側の縁を太くし、内側縁取り(幅4)がその内側に収まる帯として見える余地を作る

  const offStyle = resolveCaptionStyle("bold", {});
  offStyle.outline = 20;

  const rOn = renderCaptionFrame(TEXT, onStyle, { width: WIDTH, height: HEIGHT });
  const rOff = renderCaptionFrame(TEXT, offStyle, { width: WIDTH, height: HEIGHT });
  check("内側縁取りON: レンダリングできる", rOn.ok, rOn.stderr);
  check("内側縁取りOFF: レンダリングできる", rOff.ok, rOff.stderr);

  if (rOn.ok && rOff.ok) {
    const bufOn = readPixelsRgb(rOn.outPng);
    const bufOff = readPixelsRgb(rOff.outPng);
    const yellowOn = countColor(bufOn, INNER_YELLOW);
    const yellowOff = countColor(bufOff, INNER_YELLOW);
    check(
      "内側縁取りONのとき、内側縁取り色(黄)が帯として実際に検出できる",
      yellowOn >= 200,
      `黄画素数(ON)=${yellowOn}`,
    );
    check(
      "対照: 内側縁取りOFFのときは、同じ色の帯が検出されない(検出力の裏付け)",
      yellowOff < 20,
      `黄画素数(OFF)=${yellowOff}`,
    );
    // ASSは "Dialogue: 0" が背面(外側)・"Dialogue: 1" が前面(内側)で描かれる想定(srt-builder.mjs
    // applyInnerOutline() のコメント参照)。前面に描かれることで黄の帯が実際に見える(=0件でない)
    // という上のチェック自体が、レイヤー順が想定どおり効いていることの検証を兼ねる。
  }
  cleanup(rOn.tmp);
  cleanup(rOff.tmp);
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
