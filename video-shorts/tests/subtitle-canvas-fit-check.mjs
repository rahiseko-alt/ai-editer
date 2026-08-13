// AUD-P2-22: 小さい画面サイズの動画でも、字幕が画面からはみ出さないことの検証。
// 実行: node tests/subtitle-canvas-fit-check.mjs
//
// 修正前: 拡大ガードでcanvasが360x640等へ縮んでも、font size/outline/marginは
// 1080x1920向けの絶対px値のまま焼かれていた。360x640・bold・20字の分割不能な単語では
// 字幕pixelがcanvas左右端に接触(クリップ)していた。
// 修正後: subtitle-styles.mjsのcomputeSubtitleScale/scaleTokenで全styleトークンをcanvas比で
// scaleし、srt-builder.mjsが表示幅(全角2/半角1)基準で長いtokenを\Nで強制改行する。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { renderClip } from "../src/render-vertical.mjs";
import { buildAss } from "../src/srt-builder.mjs";

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

/** 出力動画に焼かれた非黒(=字幕)pixelの、フレーム全体を通した外接矩形を bbox フィルタで測る。 */
function measureContentBBox(file, minVal = 24) {
  const r = spawnSync("ffmpeg", ["-i", file, "-vf", `bbox=min_val=${minVal}`, "-f", "null", "-"],
    { encoding: "utf-8" });
  const lines = (r.stderr || "").split("\n").filter((l) => l.includes("Parsed_bbox") && l.includes("x1:"));
  if (lines.length === 0) return null; // 非黒pixelが1つも無い(何も描画されていない)
  let x1 = Infinity, x2 = -Infinity;
  for (const line of lines) {
    const m = line.match(/x1:(\d+)\s+x2:(\d+)/);
    if (!m) continue;
    x1 = Math.min(x1, Number(m[1]));
    x2 = Math.max(x2, Number(m[2]));
  }
  return { x1, x2 };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subtitle-canvas-fit-"));
const src = path.join(tmp, "src_black.mp4");
const assPath = path.join(tmp, "sub.ass");
const out = path.join(tmp, "out.mp4");
const CANVAS_W = 360, CANVAS_H = 640;

try {
  // 黒背景の合成素材(bboxで字幕pixelだけを検出させるため)。
  execFileSync("ffmpeg", ["-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=size=1080x1920:color=black",
    "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", src], { stdio: ["ignore", "ignore", "ignore"] });

  // 分割不能な20文字の単語1つを、字幕全期間で表示させる。
  const longWord = "ABCDEFGHIJKLMNOPQRST"; // 20 chars
  const ass = buildAss(
    [{ w: longWord, start: 0, end: 1 }], "", 1,
    { width: CANVAS_W, height: CANVAS_H, style: "bold", fontMain: "DejaVu Sans" },
  );
  fs.writeFileSync(assPath, ass);
  report("ASSの本文が実際に強制改行(\\N)されている(表示幅基準の折り返しが働いている)", ass.includes("\\N"), ass);

  // srcW/srcH=360x640を渡すと拡大ガードが働き、実出力canvasも360x640になる
  // (render-vertical.mjs の computeCanvas: k=min(1080/360,1920/640)=3>1 → guarded)。
  await renderClip({
    input: src, start: 0, end: 1, assPath, output: out,
    orientation: "portrait", srcW: CANVAS_W, srcH: CANVAS_H,
  });
  const outSize = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", out], { encoding: "utf-8" }).stdout.trim();
  report(`出力canvasが実際に${CANVAS_W}x${CANVAS_H}へ縮小されている(拡大ガードが効いている前提の確認)`,
    outSize === `${CANVAS_W},${CANVAS_H}`, `outSize=${outSize}`);

  const bbox = measureContentBBox(out);
  report("字幕pixelが実際に描画されている(bboxで非黒領域を検出できた)", bbox !== null);
  if (bbox) {
    report(
      `字幕pixelの左端(x1=${bbox.x1})がcanvas左端(0)に接触していない`,
      bbox.x1 > 0,
      `x1=${bbox.x1}`,
    );
    report(
      `字幕pixelの右端(x2=${bbox.x2})がcanvas右端(${CANVAS_W - 1})に接触していない`,
      bbox.x2 < CANVAS_W - 1,
      `x2=${bbox.x2} canvasW=${CANVAS_W}`,
    );
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
