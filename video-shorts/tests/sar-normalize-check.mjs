// AUD-P2-21: 横長でない特殊な比率(非正方形ピクセル/SAR)の素材でも、人物や文字が横に
// つぶれない(表示アスペクト比で fit/pad される)ことの検証。
// 実行: node tests/sar-normalize-check.mjs
//
// 修正前: probeSize() は coded width/height だけを返し、renderClip() は setsar=1 するだけで
// 物理的な伸縮をしなかった。SAR 32:27(coded 720x480 = coded比1.5、display比≈16:9)の素材を
// landscape(1920x1080)へ fit すると、coded比1.5を基準にfitするため実際の表示比より縦長に
// 判定され、左右にピラーボックス(黒帯)が入る＝横方向が実質つぶれる。
// 修正後: probeSize()がSAR補正後のdisplayWidth/Heightを返し、renderClip()のfilter chainが
// scale=trunc(iw*sar/2)*2:ih,setsar=1 で物理的にSARを1:1へ伸縮してからfitする。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { renderClip, probeSize } from "../src/render-vertical.mjs";

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? `\n      ${detail}` : ""}`); }
}

function ffmpegAvailable() {
  const r = spawnSync("ffmpeg", ["-version"]);
  return r.status === 0;
}
if (!ffmpegAvailable()) {
  console.log("SKIP: ffmpeg が見つからないため検証できません");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sar-normalize-"));
const src = path.join(tmp, "src.mp4");
const out = path.join(tmp, "out.mp4");

try {
  // coded 720x480・SAR 32:27(display 16:9相当)の合成素材を作る。
  execFileSync("ffmpeg", ["-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=size=720x480:color=gray,setsar=32/27,format=yuv420p",
    "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", src]);

  const srcProbe = await probeSize(src);
  report(
    "probeSize()がSAR(32:27)を実際に読み取っている",
    srcProbe.sarNum === 32 && srcProbe.sarDen === 27,
    `sarNum=${srcProbe.sarNum} sarDen=${srcProbe.sarDen}`,
  );
  report(
    "probeSize()のdisplayWidthがcoded幅(720)ではなくSAR補正後の値(≈853)を返す",
    Math.abs(srcProbe.displayWidth - 853) <= 2,
    `displayWidth=${srcProbe.displayWidth}(期待≈853) coded width=${srcProbe.width}`,
  );

  const rendered = await renderClip({
    input: src, start: 0, end: 1, assPath: null, output: out, orientation: "landscape",
  });
  report(
    "renderClip()の実行コマンドに、SARを物理的に正規化するフィルタ(scale=trunc(iw*sar/2)*2:ih,setsar=1)が含まれる",
    rendered.cmd.includes("scale=trunc(iw*sar/2)*2:ih,setsar=1"),
    rendered.cmd,
  );

  const outProbe = await probeSize(out);
  report(
    "出力のSARが1:1へ正規化されている(=タグ付けだけでなく物理的に伸縮された)",
    outProbe.sarNum === 1 && outProbe.sarDen === 1,
    `sarNum=${outProbe.sarNum} sarDen=${outProbe.sarDen}`,
  );

  // cropdetectで出力フレームの非黒領域(実コンテンツ)の幅を測る。SARが正しく効いていれば
  // display比(≈16:9)がtarget比(1920:1080=16:9)とほぼ一致するため、左右のピラーボックスは
  // ほぼ発生しない(コンテンツ幅≈1920)。SARを無視するとcoded比(1.5)基準でfitされ、
  // 左右に黒帯が入りコンテンツ幅が有意に狭くなる(≈1620)。
  const cropOut = spawnSync("ffmpeg", ["-i", out, "-vf", "cropdetect=24:2:0", "-f", "null", "-"], { encoding: "utf-8" });
  const matches = [...(cropOut.stderr || "").matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  const last = matches[matches.length - 1];
  const cropWidth = last ? Number(last[1]) : null;
  report(
    "出力フレームの実コンテンツ幅が、ほぼ全幅(横方向のつぶれ=ピラーボックスが無い)",
    cropWidth !== null && cropWidth >= 1900,
    `cropdetect幅=${cropWidth}(期待: 1900以上/1920満)。狭ければSAR無視によるピラーボックス発生を示す`,
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
