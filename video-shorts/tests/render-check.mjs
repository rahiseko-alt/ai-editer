// video-shorts レンダリング実機検証 — 実コード(renderClip)で 16:9→9:16 字幕焼きを通し、
// 出力が 1080x1920 縦型・音声コピーであることを ffprobe で確認する。
// 実行: node tests/render-check.mjs   (PASSで exit 0)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { renderClip, probeSize } from "../src/render-vertical.mjs";
import { buildAss } from "../src/srt-builder.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const input = path.join(ROOT, "..", "samples", "test-16x9.mp4");
const outDir = path.join(ROOT, "..", "output", "_render-check");
fs.mkdirSync(outDir, { recursive: true });
const assPath = path.join(outDir, "check.ass");
const outFile = path.join(outDir, "check-vertical.mp4");

function audioCodec(file) {
  return new Promise((res, rej) => {
    const p = spawn("ffprobe", [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_name", "-of", "csv=p=0", file,
    ]);
    let o = "";
    p.stdout.on("data", (d) => (o += d));
    p.on("close", (c) => (c === 0 ? res(o.trim()) : rej(new Error("ffprobe a"))));
  });
}

async function main() {
  if (!fs.existsSync(input)) {
    console.log(`FAIL 合成動画がありません: ${input}（先に samples/test-16x9.mp4 を生成）`);
    process.exit(1);
  }
  // ダミー字幕（合成動画なので文字起こしは無い・焼き込み経路の検証が目的）
  const relWords = [
    { w: "テロップ", start: 0.0, end: 1.0 },
    { w: "焼き込み", start: 1.0, end: 2.0 },
    { w: "テスト", start: 2.0, end: 3.0 },
  ];
  fs.writeFileSync(assPath, buildAss(relWords, "字幕焼きテスト", 3.0), "utf-8");

  const inAudio = await audioCodec(input);
  console.log(`[INFO] 入力音声コーデック: ${inAudio}`);

  await renderClip({ input, start: 1.0, end: 4.0, assPath, output: outFile });

  const size = await probeSize(outFile);
  const outAudio = await audioCodec(outFile);

  let fail = 0;
  const check = (cond, msg) => {
    console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
    if (!cond) fail++;
  };
  check(fs.existsSync(outFile), "出力mp4が生成された");
  check(size.width === 1080 && size.height === 1920, `解像度 1080x1920 (実=${size.width}x${size.height})`);
  check(size.vertical === true, "縦型(高さ>幅)である");
  check(outAudio === inAudio, `音声無劣化コピー(-c:a copy): 入=${inAudio} 出=${outAudio}`);

  console.log(`\n--- ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ---`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log("FAIL 例外: " + (e.message || e));
  process.exit(1);
});
