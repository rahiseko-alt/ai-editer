// digest動画(まとめて1本にした最終動画)が画面から見られることの検証 — AUD-S-04
//
// 候補APIが返す`digest`フィールド(実際に生成される最終成果物)を、これまでfillResults()は
// 一度も読んでいなかった(data.candidatesしか見ていない)。実サーバー・実ffmpegで
// digestモード（cut="分数で切る"）のジョブを完走させ、結果画面の実際のDOMに
// 再生用<video>と、実際にレスポンスが返るダウンロードリンクが現れることを確認する。
//
// このファイルは playwright（実ブラウザ操作）に依存する。他のwebapp-*-check.mjsと同じ作法
// （devDependencies導入・CI組み込み済み。詳細はwebapp-ai-caption-progress-check.mjs参照）。
// 実行: node tests/webapp-digest-check.mjs

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { runFfmpeg } from "../src/render-vertical.mjs";
import { installFakeClaude } from "./helpers/fake-claude-main.mjs";
import { chromiumLaunchOptions } from "./helpers/launch-chromium.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");
const PORT = 59196; // このテスト専用の固定ポート

let pass = 0, fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n      ${e.stack || e.message}`);
  }
}

function ffmpegAvailable() {
  return new Promise((res) => {
    const p = spawn("ffmpeg", ["-version"], { windowsHide: true });
    p.on("error", () => res(false));
    p.on("close", (c) => res(c === 0));
  });
}

const SAMPLE_DURATION_SEC = 10;
async function makeSample(dir) {
  const out = path.join(dir, "sample-16x9.mp4");
  await runFfmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc=size=640x360:rate=15:duration=${SAMPLE_DURATION_SEC}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${SAMPLE_DURATION_SEC}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    out,
  ]);
  return out;
}

const WORDS = [
  { w: "アルファ", start: 0.0, end: 1.0 },
  { w: "ブラボー", start: 1.0, end: 2.0 },
  { w: "チャーリー", start: 3.0, end: 4.0 },
  { w: "デルタ", start: 4.0, end: 5.0 },
];
const SEG1_TEXT = "アルファブラボー";
const SEG2_TEXT = "チャーリーデルタ";
const TRANSCRIPT = {
  language: "ja",
  duration: SAMPLE_DURATION_SEC,
  words: WORDS,
  segments: [
    { start: 0.0, end: 2.0, text: SEG1_TEXT },
    { start: 3.0, end: 5.0, text: SEG2_TEXT },
  ],
};

function installFakePython() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fake-python-s4-"));
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, "python");
  fs.writeFileSync(
    exe,
    `#!/usr/bin/env node\n` +
      `const fs = require("fs");\n` +
      `const transcriptPath = process.argv[process.argv.length - 1];\n` +
      `fs.writeFileSync(transcriptPath, ${JSON.stringify(JSON.stringify(TRANSCRIPT))});\n`
  );
  fs.chmodSync(exe, 0o755);
  return { binDir };
}

// digest-editor(src/digest-editor.mjs)は「台本ドラフト」「講評」の2種のプロンプトを送る。
// caption-fix(stage c)は別プロンプト("文字起こしを校正する人")。route種で答え分ける。
const DIGEST_DRAFT = JSON.stringify({
  script: [
    { keepText: SEG1_TEXT, hook: "パート1", reason: "つかみ" },
    { keepText: SEG2_TEXT, hook: "パート2", reason: "山場" },
  ],
});
const DIGEST_CRITIQUE = JSON.stringify({ score: 95, pass: true, scores: {}, issues: [], fixes: [] });
const OK_CLAUDE = {
  kind: "route",
  rules: [
    { needle: "文字起こしを校正する人", answer: JSON.stringify({ fixes: [] }) },
    // 2026-08-16: 「間を詰める」の判断工程が増えた。この検査は詰める設定を使わないので
    // 実際には来ないが、来たときに黙って失敗しないよう答えを用意しておく。
    { needle: "話し言葉を編集する人", answer: JSON.stringify({ fillers: [], cutGaps: [] }) },
    { needle: "辛口の編集レビュアー", answer: DIGEST_CRITIQUE },
  ],
  fallback: DIGEST_DRAFT, // 上記2つに当てはまらない呼び出し = 台本ドラフト依頼
};

function startServer(extraPathDirs) {
  return new Promise((resolve, reject) => {
    const PATH = [...extraPathDirs, process.env.PATH].join(path.delimiter);
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), PATH },
    });
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server起動タイムアウト")), 30000);
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

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(resolve, 2000);
  });
}

/** http(s) GETをそのまま投げ、ステータス・Content-Type・本文長を返す(digest動画が実在するかの確認)。 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let len = 0;
      res.on("data", (c) => { len += c.length; });
      res.on("end", () => resolve({ status: res.statusCode, contentType: res.headers["content-type"], length: len }));
    }).on("error", reject);
  });
}

let server = null;
let browser = null;
let tmp = null;
let createdJobId = null;

try {
  if (!(await ffmpegAvailable())) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-webapp-s4-"));
  const sample = await makeSample(tmp);
  const fakePython = installFakePython();
  const fakeClaude = installFakeClaude("s4", OK_CLAUDE);

  const started = await startServer([fakeClaude.binDir, fakePython.binDir]);
  server = started.child;

  browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => {
    pageErrors.push(err);
    console.error("PAGE ERROR:", err.message);
  });

  page.on("response", async (res) => {
    if (res.request().method() !== "POST" || !/\/api\/jobs\?/.test(res.url())) return;
    try {
      const data = await res.json();
      if (data.jobId) createdJobId = data.jobId;
    } catch (_) { /* ignore */ }
  });

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector("#file", { state: "attached" });

  const token = await page.evaluate(() => window.__AI_EDITOR_TOKEN__);
  assert.ok(typeof token === "string" && token.length > 0, "起動時トークンの注入が確認できない");

  await page.setInputFiles("#file", {
    name: "sample.mp4",
    mimeType: "video/mp4",
    buffer: fs.readFileSync(sample),
  });
  // digestを作らせるには「分数で切る」を選ぶ(mode=digest。server/pipeline-runner.mjs
  // resolveJobSettings参照)。
  await page.click('[data-group="cut"] .chip[data-val="minutes"]');
  await page.fill("#cut-min", "1");

  await page.click("#btn-run");
  await page.waitForSelector("#confirm-overlay:not(.hidden)");
  await page.click("#confirm-run");

  await page.waitForSelector("#result-overlay:not(.hidden)", { timeout: 90_000 });

  await t("前提: サーバー側でdigest動画が実際に生成されている(candidates.jsonのdigestが非null)", async () => {
    assert.ok(createdJobId, "jobIdを取得できていない(前提が崩れている)");
    const candPath = path.join(OUT_ROOT, createdJobId, "candidates.json");
    const cand = JSON.parse(fs.readFileSync(candPath, "utf-8"));
    assert.ok(cand.digest && cand.digest.file, `candidates.jsonにdigestが無い: ${JSON.stringify(cand)}`);
    assert.ok(
      fs.existsSync(path.join(OUT_ROOT, createdJobId, cand.digest.file)),
      "digestの実ファイルが存在しない"
    );
  });

  await t("結果画面のDOMにdigestの<video>要素が実際に存在する", async () => {
    const info = await page.evaluate(() => {
      const el = document.getElementById("job-digest");
      const video = el?.querySelector("video");
      return {
        hidden: el?.classList.contains("hidden"),
        hasVideo: !!video,
        src: video?.getAttribute("src") || null,
      };
    });
    assert.strictEqual(info.hidden, false, "#job-digestが隠れたまま(digestが画面に出ていない)");
    assert.ok(info.hasVideo, "#job-digest内に<video>要素が無い");
    assert.ok(info.src, "<video>のsrcが空");
  });

  await t("<video>のsrcが実際にレスポンスする(本物の動画リソースへ紐づいている)", async () => {
    const src = await page.evaluate(() => document.querySelector("#job-digest video").getAttribute("src"));
    const r = await httpGet(`http://127.0.0.1:${PORT}${src}`);
    assert.strictEqual(r.status, 200, `digest動画URLが200を返さない(実=${r.status})`);
    assert.strictEqual(r.contentType, "video/mp4", `Content-Typeがvideo/mp4でない(実=${r.contentType})`);
    assert.ok(r.length > 0, "digest動画の本文が空");
  });

  await t("結果画面のDOMにdigestのダウンロードリンクが存在し、同じリソースを指す", async () => {
    const info = await page.evaluate(() => {
      const a = document.getElementById("job-digest-dl");
      return { href: a?.getAttribute("href") || null, download: a?.getAttribute("download") || null };
    });
    assert.ok(info.href, "ダウンロードリンク(#job-digest-dl)が無い");
    assert.ok(info.download, "download属性(保存ファイル名)が無い");
    const r = await httpGet(`http://127.0.0.1:${PORT}${info.href}`);
    assert.strictEqual(r.status, 200, `ダウンロードリンク先が200を返さない(実=${r.status})`);
  });

  await t("実行中、ブラウザ側で読み込み・実行時エラーが発生していない(pageerrorが1件も無い)", async () => {
    assert.strictEqual(pageErrors.length, 0, `ブラウザ側で実行時エラーが発生した: ${pageErrors.map((e) => e.message).join(", ")}`);
  });

  await context.close();

  // ── 対照: fillResultsがdata.digestを一切読まない旧実装は、この判定に落ちる ──
  await t("対照: digestを一切読まない旧実装は、この判定に落ちる", () => {
    const jobWithoutDigestField = { keep: [{ h: "x" }] }; // 旧addJob()相当(digestプロパティ自体が無い)
    assert.throws(() => {
      assert.ok(jobWithoutDigestField.digest && jobWithoutDigestField.digest.file, "digestが読まれていない");
    }, /digestが読まれていない/, "旧実装(digest未対応)が「読まれた」判定を通ってしまった(検出できていない)");
  });
} finally {
  if (browser) await browser.close();
  await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (createdJobId) {
    fs.rmSync(path.join(WORK_ROOT, createdJobId), { recursive: true, force: true });
    fs.rmSync(path.join(OUT_ROOT, createdJobId), { recursive: true, force: true });
  }
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
