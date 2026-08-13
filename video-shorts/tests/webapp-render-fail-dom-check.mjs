// 一部候補の書き出し失敗を画面のDOMに表示することの検証 — AUD-S-03
//
// pipeline.mjs は失敗件数(failCount)を計算してログに出すだけで、candidates.json へ
// 一度も書いていなかった(=API応答にすら乗らない)。今回それを`renderFailed`として
// candidates.json へ持ち回るようにしたが、それだけではAPIのJSONに数値が乗るだけで
// 画面には何も出ない(監査が名指しした「APIだけ直してDOMは直さない」誤検出そのもの)。
// このテストは実サーバー・実ffmpegで「2候補中1候補だけ書き出しに実際に失敗する」ジョブを
// 本当に走らせ、結果画面の実際のDOM(#tab-keep innerHTML)に失敗件数の文言が現れることまで確認する。
//
// 【1候補だけ実際に失敗させる方法】字幕焼き込み(sub:on)は各候補ごとに
// work/<jobId>/clip-{i+1}.ass を書いてからffmpegへ渡す。2番目の候補が使うはずの
// clip-2.ass のパスへ「ファイルの代わりにディレクトリ」を先回りして置いておくと、
// fs.writeFileSync(assPath, ...) がEISDIRで例外を投げ、pipeline.mjsの該当try/catchが
// 実際に[FAIL]として捕捉する（ffmpegの内部を騙すのではなく、実際のI/O失敗を起こす）。
// POST /api/jobs のレスポンスでjobIdを受け取った直後（レンダ段が始まるよりずっと前）に
// 罠のディレクトリを作るので、タイミング競合は無い。
//
// このファイルは playwright（実ブラウザ操作）に依存する。他のwebapp-*-check.mjsと同じ作法
// （devDependencies導入・CI組み込み済み。詳細はwebapp-ai-caption-progress-check.mjs参照）。
// 実行: node tests/webapp-render-fail-dom-check.mjs

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const PORT = 59198; // このテスト専用の固定ポート

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

// 2区間ぶんの固定 transcript（重ならない時系列2区間）。
// R-7a(src/snap-boundaries.mjs mergeShortSegments): 区間どうしの間隔が既定の
// maxGapSec(3秒)以内だと1本に結合されてしまい、2本目のclip-2.assが一度も
// 書かれない(=罠を踏めない)。2区間の間隔を4秒あけて結合を防ぐ。
const WORDS = [
  { w: "アルファ", start: 0.0, end: 1.0 },
  { w: "ブラボー", start: 1.0, end: 2.0 },
  { w: "チャーリー", start: 6.0, end: 7.0 },
  { w: "デルタ", start: 7.0, end: 8.0 },
];
const SEG1_TEXT = "アルファブラボー";
const SEG2_TEXT = "チャーリーデルタ";
const TRANSCRIPT = {
  language: "ja",
  duration: SAMPLE_DURATION_SEC,
  words: WORDS,
  segments: [
    { start: 0.0, end: 2.0, text: SEG1_TEXT },
    { start: 6.0, end: 8.0, text: SEG2_TEXT },
  ],
};

function installFakePython() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fake-python-s3-"));
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

// 2候補を返す偽claude（1本目=GOODCLIP、2本目=BROKENCLIP。どちらのkeepTextも実在の
// transcript範囲に一致するので選定自体は両方成功する。失敗させるのはディレクトリの罠側）。
const OK_CLAUDE = {
  kind: "route",
  rules: [
    { needle: "文字起こしを校正する人", answer: JSON.stringify({ fixes: [] }) },
    {
      needle: "区間に切り分ける編集者",
      answer: JSON.stringify({
        segments: [
          { keepText: SEG1_TEXT, hook: "GOODCLIP", reason: "てすと1" },
          { keepText: SEG2_TEXT, hook: "BROKENCLIP", reason: "てすと2" },
        ],
      }),
    },
  ],
  fallback: JSON.stringify({ fixes: [] }),
};

function startServer(extraPathDirs) {
  return new Promise((resolve, reject) => {
    const PATH = [...extraPathDirs, process.env.PATH].join(path.delimiter);
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), PATH },
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

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(resolve, 2000);
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

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-webapp-s3-"));
  const sample = await makeSample(tmp);
  const fakePython = installFakePython();
  const fakeClaude = installFakeClaude("s3", OK_CLAUDE);

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

  // POST /api/jobs の応答からjobIdを受け取った瞬間に、2本目の候補が使うassパスへ罠を仕込む。
  // レンダ段(r)は文字起こし・字幕AI校正・区間選定のすべてが終わったあとに始まるため、
  // ここで仕込めばレンダ段開始よりずっと前に間に合う(タイミング競合は無い)。
  page.on("response", async (res) => {
    if (res.request().method() !== "POST" || !/\/api\/jobs\?/.test(res.url())) return;
    try {
      const data = await res.json();
      if (!data.jobId) return;
      createdJobId = data.jobId;
      const workDir = path.join(WORK_ROOT, data.jobId);
      fs.mkdirSync(workDir, { recursive: true });
      // clip-2.ass の位置にディレクトリを置く＝2本目の字幕書き込みだけが実際に失敗する。
      fs.mkdirSync(path.join(workDir, "clip-2.ass"), { recursive: true });
    } catch (_) { /* JSONでない応答は無視 */ }
  });

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector("#file", { state: "attached" });

  await page.setInputFiles("#file", {
    name: "sample.mp4",
    mimeType: "video/mp4",
    buffer: fs.readFileSync(sample),
  });
  // 字幕「あり」にする(sub:on)。これでcandidateごとにclip-N.assが書かれ、罠が効く。
  await page.click('.sub-chip[data-val="on"]');

  await page.click("#btn-run");
  await page.waitForSelector("#confirm-overlay:not(.hidden)");
  await page.click("#confirm-run");

  await page.waitForSelector("#result-overlay:not(.hidden)", { timeout: 90_000 });

  await t("前提: 罠が実際に踏まれ、サーバー側で1本だけ生成に失敗している(candidates.jsonのrenderFailed=1)", async () => {
    assert.ok(createdJobId, "jobIdを取得できていない(前提が崩れている)");
    const candPath = path.join(OUT_ROOT, createdJobId, "candidates.json");
    const cand = JSON.parse(fs.readFileSync(candPath, "utf-8"));
    assert.strictEqual(cand.renderFailed, 1, `renderFailedが1でない(実=${cand.renderFailed}): ${JSON.stringify(cand)}`);
    assert.strictEqual(cand.candidates.length, 1, `成功した候補が1本でない(実=${cand.candidates.length})`);
  });

  await t("結果画面のDOMに「1件の書き出しに失敗」の警告文が実際に表示されている", async () => {
    const html = await page.evaluate(() => document.getElementById("tab-keep").innerHTML);
    assert.ok(/1件の書き出しに失敗/.test(html), `#tab-keepのinnerHTMLに失敗件数の文言が無い: ${html.slice(0, 300)}`);
  });

  await t("採用候補の本数表示(#keep-n)は成功した1本だけを示している", async () => {
    const keepN = await page.evaluate(() => document.getElementById("keep-n").textContent);
    assert.strictEqual(keepN, "1", `#keep-nが1でない(実=${keepN})`);
  });

  await t("実行中、ブラウザ側で読み込み・実行時エラーが発生していない(pageerrorが1件も無い)", async () => {
    assert.strictEqual(pageErrors.length, 0, `ブラウザ側で実行時エラーが発生した: ${pageErrors.map((e) => e.message).join(", ")}`);
  });

  await context.close();

  // ── 対照: APIのJSONにrenderFailedが乗るだけでDOMを直さない旧実装は、この判定に落ちる ──
  await t("対照: DOM未対応(APIのJSONにrenderFailedが乗るだけ)の旧実装は、この判定に落ちる", () => {
    const htmlWithoutFix = `<p class="reason">あなたの設定をもとに、AIがそのまま使える部分を1本選びました。</p>`;
    assert.throws(() => {
      assert.ok(/1件の書き出しに失敗/.test(htmlWithoutFix), "#tab-keepのinnerHTMLに失敗件数の文言が無い(APIのみ直した旧実装を再現)");
    }, /失敗件数の文言が無い/, "APIのみ直した旧実装が「表示された」判定を通ってしまった(検出できていない)");
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
