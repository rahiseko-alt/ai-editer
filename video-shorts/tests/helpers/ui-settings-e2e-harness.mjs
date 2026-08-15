// tests/helpers/ui-settings-e2e-harness.mjs — G-EDIT-UI-SETTINGS の実ブラウザ×実サーバ検査で
// 共通して使う土台。実サーバ(server/index.mjs)を実ffmpegで起動しつつ、時間のかかる
// 文字起こし(transcribe.py)と区間選定(claude)だけを固定応答へ差し替える。
//
// 差し替えの作法はtests/webapp-digest-check.mjsと同じ(fake python=transcribe.pyの代わりに
// 固定transcriptを書くだけの実行ファイルをPATHへ差し込む。installFakeClaudeは既存ヘルパを再利用)。
// render(実際の字幕焼き込み・書き出し)は本物のffmpegを通すため、字幕の見た目・尺・書き出し
// 画質を画素/ファイルサイズで実測できる。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { runFfmpeg } from "../../src/render-vertical.mjs";
import { installFakeClaude } from "./fake-claude-main.mjs";
import { chromiumLaunchOptions } from "./launch-chromium.mjs";
import { readPixelsRgb, dominantColors, colorClose, bboxOf } from "./caption-style-render.mjs";

export { readPixelsRgb, dominantColors, colorClose, bboxOf };

/**
 * 実際に出来た動画(mp4)の指定秒からPNGを1枚焼き出す。字幕の見た目系のUI葉(FONT/FILL/BAND/
 * OUTLINE/INNER/STYLE)が、実ジョブの出力を画素で確認するための共通口。
 * @returns {string} 出力PNGの絶対パス
 */
export function extractFramePng(mp4Path, atSec = 1.0) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-frame-"));
  const outPng = path.join(tmp, "frame.png");
  const r = spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", String(atSec), "-i", mp4Path, "-frames:v", "1", outPng]);
  if (r.status !== 0) throw new Error(`ffmpegでのフレーム抽出に失敗: ${r.stderr?.toString() || ""}`);
  return outPng;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(path.dirname(HERE)); // video-shorts/
export const WORK_ROOT = path.join(ROOT, "work");
export const OUT_ROOT = path.join(ROOT, "output");

/** ffmpeg/ffprobeがこの環境で使えるか。使えなければ呼び出し側がSKIPではなくFAIL(exit 1)にすること。 */
export function ffmpegAvailable() {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-version"], { windowsHide: true });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

/** 話す内容が一定(2区間・4語)の凍結transcript。素材のSAMPLE_DURATION_SECと対にして使う。 */
export const SAMPLE_DURATION_SEC = 12;
export const WORDS = [
  { w: "アルファ", start: 0.0, end: 1.0 },
  { w: "ブラボー", start: 1.0, end: 2.0 },
  { w: "チャーリー", start: 3.0, end: 4.0 },
  { w: "デルタ", start: 4.0, end: 5.0 },
  { w: "エコー", start: 6.0, end: 7.0 },
  { w: "フォックストロット", start: 7.0, end: 8.5 },
];
export const SEG1_TEXT = "アルファブラボー";
export const SEG2_TEXT = "チャーリーデルタ";
export const SEG3_TEXT = "エコーフォックストロット";
export const TRANSCRIPT = {
  language: "ja",
  duration: SAMPLE_DURATION_SEC,
  words: WORDS,
  segments: [
    { start: 0.0, end: 2.0, text: SEG1_TEXT },
    { start: 3.0, end: 5.0, text: SEG2_TEXT },
    { start: 6.0, end: 8.5, text: SEG3_TEXT },
  ],
};

/** topicモード(claude-select)用の固定応答: 全区間をkeepする。 */
export const TOPIC_CLAUDE = {
  kind: "route",
  rules: [{ needle: "文字起こしを校正する人", answer: JSON.stringify({ fixes: [] }) }],
  fallback: JSON.stringify({
    segments: [
      { keepText: SEG1_TEXT, hook: "H1" },
      { keepText: SEG2_TEXT, hook: "H2" },
      { keepText: SEG3_TEXT, hook: "H3" },
    ],
  }),
};

/** digestモード(digest-editor)用の固定応答。 */
export function digestClaude() {
  const draft = JSON.stringify({
    script: [
      { keepText: SEG1_TEXT, hook: "パート1", reason: "つかみ" },
      { keepText: SEG2_TEXT, hook: "パート2", reason: "山場" },
      { keepText: SEG3_TEXT, hook: "パート3", reason: "締め" },
    ],
  });
  const critique = JSON.stringify({ score: 95, pass: true, scores: {}, issues: [], fixes: [] });
  return {
    kind: "route",
    rules: [
      { needle: "文字起こしを校正する人", answer: JSON.stringify({ fixes: [] }) },
      { needle: "辛口の編集レビュアー", answer: critique },
    ],
    fallback: draft,
  };
}

/** 話し声つきの合成動画を作る(testsrc+sine。実際の言葉ではないが、fake pythonが文字起こし自体を
 *  代替するため中身の音は問われない。長さと画面サイズだけが実レンダリングに影響する)。 */
export async function makeSample(dir, { size = "640x360", durationSec = SAMPLE_DURATION_SEC } = {}) {
  const out = path.join(dir, `sample-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  await runFfmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc=size=${size}:rate=15:duration=${durationSec}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSec}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    out,
  ]);
  return out;
}

/** transcribe.pyの代わりに固定transcriptを書くだけの`python`をPATHへ差し込む。 */
export function installFakePython(transcript = TRANSCRIPT) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fake-python-uis-"));
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, "python");
  fs.writeFileSync(
    exe,
    `#!/usr/bin/env node\n` +
      `const fs = require("fs");\n` +
      `const transcriptPath = process.argv[process.argv.length - 1];\n` +
      `fs.writeFileSync(transcriptPath, ${JSON.stringify(JSON.stringify(transcript))});\n`
  );
  fs.chmodSync(exe, 0o755);
  return { binDir };
}

export { installFakeClaude, chromiumLaunchOptions, chromium };

/** 実サーバ(server/index.mjs)をランダム未使用ポートで起動する。 */
export function startServer(extraPathDirs, port) {
  return new Promise((resolve, reject) => {
    const PATH = [...extraPathDirs, process.env.PATH].join(path.delimiter);
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), PATH },
    });
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server起動タイムアウト")), 8000);
    child.stderr.on("data", (chunk) => {
      buf += chunk.toString();
      if (/listening/.test(buf)) {
        clearTimeout(timer);
        resolve({ child });
      }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

export function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(resolve, 2000);
  });
}

/**
 * 1本のジョブを実ブラウザで作成し、完走(#result-overlay表示)まで待つ。
 * @param {import("playwright").Page} page
 * @param {{
 *   filePath: string, cut?: "topic"|"minutes", cutMin?: number,
 *   sub?: boolean, captionFont?: string, subStyle?: string,
 *   captionFill?: string, captionOutlineColor?: string,
 *   captionInner?: string|null, captionBand?: string|null,
 *   durationMin?: number, exportPreset?: string,
 * }} opts captionInner/captionBandは色(#RRGGBB)を渡すとon、nullまたは未指定ならoffのまま。
 * @returns {Promise<{jobId: string|null}>}
 */
export async function runJobViaBrowser(page, opts) {
  let jobId = null;
  const onResponse = async (res) => {
    if (res.request().method() !== "POST" || !/\/api\/jobs\?/.test(res.url())) return;
    try {
      const data = await res.json();
      if (data.jobId) jobId = data.jobId;
    } catch (_) { /* ignore */ }
  };
  page.on("response", onResponse);

  await page.setInputFiles("#file", {
    name: "sample.mp4",
    mimeType: "video/mp4",
    buffer: fs.readFileSync(opts.filePath),
  });

  if (opts.sub) {
    await page.click('[data-group="sub"] .chip[data-val="on"]');
  }
  if (opts.captionFont) {
    await page.click(`[data-group="captionFont"] .chip[data-val="${opts.captionFont}"]`);
  }
  if (opts.subStyle) {
    await page.click(`[data-group="subStyle"] .chip[data-val="${opts.subStyle}"]`);
  }
  if (opts.captionFill) {
    await page.fill("#caption-fill", opts.captionFill);
    await page.dispatchEvent("#caption-fill", "input");
  }
  if (opts.captionOutlineColor) {
    await page.fill("#caption-outline-color", opts.captionOutlineColor);
    await page.dispatchEvent("#caption-outline-color", "input");
  }
  if (opts.captionInner) {
    await page.click('[data-group="captionInner"] .chip[data-val="on"]');
    await page.fill("#caption-inner-color", opts.captionInner);
    await page.dispatchEvent("#caption-inner-color", "input");
  }
  if (opts.captionBand) {
    await page.click('[data-group="captionBand"] .chip[data-val="on"]');
    await page.fill("#caption-band-color", opts.captionBand);
    await page.dispatchEvent("#caption-band-color", "input");
  }
  if (opts.cut === "minutes") {
    await page.click('[data-group="cut"] .chip[data-val="minutes"]');
    if (opts.cutMin) await page.fill("#cut-min", String(opts.cutMin));
  } else if (opts.durationMin) {
    await page.fill("#duration-min", String(opts.durationMin));
    await page.dispatchEvent("#duration-min", "input");
  }
  if (opts.exportPreset !== undefined) {
    const val = opts.exportPreset || "";
    await page.click(`[data-group="exportPreset"] .chip[data-val="${val}"]`);
  }
  if (opts.trim) {
    await page.click('[data-group="trim"] .chip[data-val="on"]');
  }

  await page.click("#btn-run");
  await page.waitForSelector("#confirm-overlay:not(.hidden)");
  await page.click("#confirm-run");
  await page.waitForSelector("#result-overlay:not(.hidden), #editing-error:not(.hidden)", { timeout: 90_000 });

  const failed = await page.evaluate(() => !document.getElementById("editing-error").classList.contains("hidden"));
  const errorMessage = failed
    ? await page.evaluate(() => document.getElementById("editing-error-msg").textContent)
    : null;

  page.off("response", onResponse);
  return { jobId, failed, errorMessage };
}

/** ジョブの出力ディレクトリ(output/<jobId>/)のcandidates.jsonを読む。 */
export function readCandidates(jobId) {
  return JSON.parse(fs.readFileSync(path.join(OUT_ROOT, jobId, "candidates.json"), "utf-8"));
}
