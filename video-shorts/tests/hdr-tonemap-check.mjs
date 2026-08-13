// AUD-P1-09: HDR素材を渡しても、一般的なスマホ・SNSで見られる画質(SDR/8bit/BT.709/yuv420p)で
// 書き出されることの検証。
// 実行: node tests/hdr-tonemap-check.mjs
//
// 修正前: render出力に -pix_fmt yuv420p が無く、HDR→SDRのtone mappingもBT.709変換も無かった。
// 10-bit/BT.2020(HDR)素材を通すと、出力もHigh10・yuv420p10le・BT.2020のまま出力され、
// 配信先によっては再生拒否・色化けが起きる。
// 修正後: render-vertical.mjsがprobeColorInfo()でHDR(PQ/HLG伝達関数 or BT.2020原色)を検出し、
// 該当時はzscale+tonemap(hable)でSDR/BT.709へ変換、全出力に -pix_fmt yuv420p 等を強制する。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { renderClip, probeColorInfo, isHdrColorInfo } from "../src/render-vertical.mjs";

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? `\n      ${detail}` : ""}`); }
}

function cmdAvailable(bin) {
  return spawnSync(bin, ["-version"]).status === 0;
}
if (!cmdAvailable("ffmpeg") || !cmdAvailable("ffprobe")) {
  console.log("SKIP: ffmpeg/ffprobe が見つからないため検証できません");
  process.exit(0);
}
// libx265(10bit)が無いとHDRソースを合成できない。無ければ環境起因としてSKIPする(FAILにしない)。
const encodersOut = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf-8" });
if (!/libx265/.test(encodersOut.stdout || "")) {
  console.log("SKIP: libx265 エンコーダが見つからないため10-bit/HDR素材を合成できません");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hdr-tonemap-"));
const src = path.join(tmp, "src_hdr.mp4");
const out = path.join(tmp, "out.mp4");

try {
  // 10-bit / BT.2020 / PQ(smpte2084) を明示タグ付けした合成HDR素材を作る。
  execFileSync("ffmpeg", ["-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:duration=1:rate=15",
    "-pix_fmt", "yuv420p10le", "-c:v", "libx265",
    "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc",
    src], { stdio: ["ignore", "ignore", "ignore"] });

  const colorInfo = await probeColorInfo(src);
  report(
    "probeColorInfo()がHDRタグ(BT.2020/PQ)を実際に読み取っている",
    colorInfo.colorPrimaries === "bt2020" && colorInfo.colorTransfer === "smpte2084",
    JSON.stringify(colorInfo),
  );
  report(
    "isHdrColorInfo()がこの素材をHDRと判定する",
    isHdrColorInfo(colorInfo) === true,
    JSON.stringify(colorInfo),
  );

  const rendered = await renderClip({
    input: src, start: 0, end: 1, assPath: null, output: out, orientation: "portrait",
  });
  report(
    "renderClip()の実行コマンドにtonemapフィルタ(hable)が含まれる(HDR検出時のみ通る経路)",
    rendered.cmd.includes("tonemap=tonemap=hable"),
    rendered.cmd,
  );

  const outInfo = await probeColorInfo(out);
  report(
    "出力のpix_fmtがyuv420p(8bit)である(yuv420p10le等の10bitのまま出ていない)",
    outInfo.pixFmt === "yuv420p",
    `pixFmt=${outInfo.pixFmt}`,
  );
  report(
    "出力のcolor_primariesがbt709である(bt2020のまま出ていない)",
    outInfo.colorPrimaries === "bt709",
    `colorPrimaries=${outInfo.colorPrimaries}`,
  );
  report(
    "出力のcolor_transferがbt709相当である(smpte2084/PQのまま出ていない)",
    outInfo.colorTransfer === "bt709",
    `colorTransfer=${outInfo.colorTransfer}`,
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
