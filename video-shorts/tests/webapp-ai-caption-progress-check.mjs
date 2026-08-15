// 画面の進捗表示に「AIが字幕を点検している」工程(stage c)が独立した段として現れ、
// 実行中→完了の表示遷移が既存の段（文字起こしt・場面選びs等）と同じ形で起きることの検証
// — roadmap葉 G-EDIT-CAPTION-AI-K2
//
// 【なぜブラウザ実測が要るか】webapp-mockup/app.jsのSTEP_ORDER/EDITING_LABEL/data-k="c"の
// 存在は静的なソース読解で確認できるが、それだけでは「実際にジョブを流したときに、
// #progress li[data-k="c"] が本当に
// active→done とクラスを切り替えるか」「その切り替えが文字起こし(t)の後・場面選び(s)の前
// という既存の段と同じ位置・同じ形で起きるか」は分からない。本テストは実サーバー
// （server/index.mjs）を起動し、実ブラウザ（Playwright/Chromium）で
// ファイル選択→実行確認→ジョブ完了までを流し、DOMのクラス変化を実際に観測する。
//
// 【文字起こし・AI点検をどう安定させるか】caption-ai-fail-halts-job-check.mjsと同じ作法で、
// PATHのpythonをtests/helpers/fake-transcribe-delayed-main.mjs（fake-transcribe-main.mjsの遅延版。
// 理由は同ファイル冒頭コメント参照）へ、claudeをtests/helpers/fake-claude-main.mjs
// （routeの2ルール: 字幕校正/区間選定）へ差し替える。場面選び(s)以降・書き出し(r)は実物
// （実ffmpegでの縦動画レンダリング）をそのまま通す。
//
// 【観測方法】run()を呼ぶ前に、app.js側の段階切替関数 setStage()、および
// #editing-statusへのtextContent代入を同期的にフック（元の実装は必ず素通しで呼ぶ）し、
// 呼ばれた引数をそのまま順番に記録する。
// 【なぜMutationObserverではなくフックか】MutationObserverはマイクロタスクでまとめて配送される
// ため、fake python/claudeが一瞬で返す関係で複数SSEイベントの処理が同一タスク内で連続すると、
// 「途中のclass状態」がobserverに一度も配送されないまま次の状態へ上書きされ、記録が丸ごと
// 欠落することがある（実測: 4回に1回程度、tのdone記録が消える）。関数呼び出しそのものを
// 同期的にフックすれば、呼ばれた事実と引数を取りこぼしなく記録できる。
//
// 実行: node tests/webapp-ai-caption-progress-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { runFfmpeg } from "../src/render-vertical.mjs";
import { installFakeClaude } from "./helpers/fake-claude-main.mjs";
import { CONFIG_FILE as FAKE_PYTHON_CONFIG_FILE } from "./helpers/fake-transcribe-delayed-main.mjs";
import { chromiumLaunchOptions } from "./helpers/launch-chromium.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const FAKE_PYTHON_MAIN = path.join(HERE, "helpers", "fake-transcribe-delayed-main.mjs");
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");
const PORT = 59197; // このテスト専用の固定ポート(他のchild-process系テストと衝突しない)

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

// ── 実機 ffmpeg で最小の16:9素材を毎回合成する（*.mp4はコミットしない方針） ──
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

// ── 「文字起こし済み」を模す固定 transcript.json ────────────────────
const WORDS = [
  { w: "こんにちは", start: 0.0, end: 1.0 },
  { w: "今日は", start: 1.0, end: 2.0 },
  { w: "晴れです", start: 2.0, end: 6.0 },
];
const SEG_TEXT = WORDS.map((w) => w.w).join("");
const TRANSCRIPT = {
  language: "ja",
  duration: SAMPLE_DURATION_SEC,
  words: WORDS,
  segments: [{ start: 0.0, end: 6.0, text: SEG_TEXT }],
};

function installFakePython() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fake-python-k2-"));
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, "python");
  fs.copyFileSync(FAKE_PYTHON_MAIN, exe);
  fs.chmodSync(exe, 0o755);
  fs.writeFileSync(path.join(binDir, "package.json"), '{"type":"module"}\n', "utf-8");
  fs.writeFileSync(
    path.join(binDir, FAKE_PYTHON_CONFIG_FILE),
    JSON.stringify({ transcript: TRANSCRIPT }),
    "utf-8",
  );
  return { binDir };
}

// 正しく答える偽claude（文字起こし校正/区間選定の両方に、プロンプトの文言で答え分ける）
const OK_CLAUDE = {
  kind: "route",
  rules: [
    { needle: "文字起こしを校正する人", answer: JSON.stringify({ fixes: [] }) },
    {
      needle: "区間に切り分ける編集者",
      answer: JSON.stringify({
        segments: [{ keepText: SEG_TEXT, hook: "テスト", reason: "てすと" }],
      }),
    },
  ],
  fallback: JSON.stringify({ fixes: [] }),
};

// ── サーバープロセスの起動・停止 ─────────────────────────────
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

// ── ブラウザ内で段階切替の呼び出しを、発生順に同期記録する仕込み ──
async function installHooks(page) {
  await page.evaluate(() => {
    window.__capLog = [];

    // #progress li[data-k] の active/done 切替は setStage(key, cls) が担う。
    const origSetStage = window.setStage;
    assert2(typeof origSetStage === "function", "window.setStageが見つからない(非モジュールscriptのグローバル露出が前提)");
    window.setStage = function (key, cls) {
      window.__capLog.push({ fn: "setStage", key, cls: cls || null });
      return origSetStage.apply(this, arguments);
    };

    // #editing-status の文言はインスタンスへの直接代入(`$("editing-status").textContent = text`)
    // なので、その要素インスタンスにだけ own property を定義して代入を横取りする。
    const statusEl = document.getElementById("editing-status");
    assert2(!!statusEl, "#editing-statusが見つからない");
    const desc = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
    Object.defineProperty(statusEl, "textContent", {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) {
        window.__capLog.push({ fn: "editing-status", text: v });
        desc.set.call(this, v);
      },
    });

    function assert2(cond, msg) { if (!cond) throw new Error(msg); }
  });
}

/** logの中で fn==="setStage" && key===k && cls===c を満たす最初の添字（無ければ -1）。 */
function firstStageIndex(log, k, cls) {
  return log.findIndex((e) => e.fn === "setStage" && e.key === k && e.cls === cls);
}

// ── 本体 ────────────────────────────────────────────────────
let server = null;
let browser = null;
let tmp = null;
let createdJobId = null;

try {
  if (!(await ffmpegAvailable())) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-webapp-k2-"));
  const sample = await makeSample(tmp);
  const fakePython = installFakePython();
  const fakeClaude = installFakeClaude("k2", OK_CLAUDE);

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

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector("#file", { state: "attached" });

  // トークンがサーバーから実際に注入されていることの前提確認
  // （偽装されたトークン無しでは以降のPOSTが弾かれ、テストの土台自体が崩れる）
  const token = await page.evaluate(() => window.__AI_EDITOR_TOKEN__);
  assert.ok(typeof token === "string" && token.length > 0, "index.htmlへの起動時トークン注入が確認できない");

  await page.setInputFiles("#file", {
    name: "sample.mp4",
    mimeType: "video/mp4",
    buffer: fs.readFileSync(sample),
  });

  await installHooks(page);

  await page.click("#btn-run");
  await page.waitForSelector("#confirm-overlay:not(.hidden)");
  await page.click("#confirm-run");

  // ジョブ完了（結果パネルが開く）まで待つ。実ffmpegでの縦動画レンダリングを含むため長めに取る。
  await page.waitForSelector("#result-overlay:not(.hidden)", { timeout: 90_000 });

  // 完了直後にjobIdを控え、後始末で使う
  // app.js の jobs は非モジュールscript直下の `let jobs = []`（トップレベルlet/constは
  // windowのプロパティにならない）。window.jobs 経由では取れないため、素の識別子として参照する
  // （ページのグローバルレキシカル環境の一部として見える）。この関数はNode側ではなく
  // ブラウザページ内で評価されるので、`jobs` はこのファイルのモジュールスコープには存在しない
  // （ESLintの静的解析には分からないため /* global jobs */ で明示する）。
  createdJobId = await page.evaluate(() => {
    /* global jobs */
    return (typeof jobs !== "undefined" && jobs[0] && jobs[0].jobId) || null;
  });

  const log = await page.evaluate(() => window.__capLog);

  await t("①前提: AI点検段(c)のactive/done切替が実際に記録できている(0件なら以降の判定が無意味)", () => {
    assert.ok(log.length > 0, "フックの記録が1件も無い（仕込みそのものが機能していない）");
  });

  await t("②#progress: 文字起こし(t)がdoneになった後に、AI点検(c)がactiveになる（tとsの間に独立した段として現れる）", () => {
    const tDone = firstStageIndex(log, "t", "done");
    const cActive = firstStageIndex(log, "c", "active");
    assert.ok(tDone >= 0, `progress側: 文字起こし(t)がdoneになった呼び出しが無い: ${JSON.stringify(log)}`);
    assert.ok(cActive >= 0, "progress側: AI点検(c)がactiveになった呼び出しが無い");
    assert.ok(cActive > tDone, `AI点検(c)がactiveになったのが文字起こし(t)完了より前（順序が違う）: tDone=${tDone}, cActive=${cActive}`);
  });

  await t("③#progress: AI点検(c)は実行中(active)を経てから完了(done)として表示される", () => {
    const cActive = firstStageIndex(log, "c", "active");
    const cDone = firstStageIndex(log, "c", "done");
    assert.ok(cDone >= 0, "progress側: AI点検(c)がdoneになった呼び出しが無い");
    assert.ok(cDone > cActive, `AI点検(c)のdoneがactiveより前に記録されている: cActive=${cActive}, cDone=${cDone}`);
  });

  await t("④#progress: AI点検(c)がdoneになった後に、場面選び(s)がactiveになる（cの後にsが続く）", () => {
    const cDone = firstStageIndex(log, "c", "done");
    const sActive = firstStageIndex(log, "s", "active");
    assert.ok(sActive >= 0, "progress側: 場面選び(s)がactiveになった呼び出しが無い");
    assert.ok(sActive > cDone, `場面選び(s)のactiveがAI点検(c)のdoneより前（cが独立した段になっていない疑い）: cDone=${cDone}, sActive=${sActive}`);
  });

  await t("⑥編集中オーバーレイの文言: AI点検中は「AIが字幕の間違いを直しています」が表示される", () => {
    const shown = log.some((e) => e.fn === "editing-status" && e.text === "AIが字幕の間違いを直しています");
    assert.ok(shown, `想定の文言が#editing-statusに一度も表示されなかった: ${JSON.stringify(log.filter((e) => e.fn === "editing-status"))}`);
  });

  await t("⑦ジョブは実際にevent:doneまで完走している（結果パネルに候補が出ている＝c段の表示が「見せかけ」ではなく実処理と連動）", async () => {
    const kept = await page.evaluate(() => document.getElementById("keep-n")?.textContent);
    assert.strictEqual(kept, "1", `候補が想定通り1件になっていない: ${kept}`);
  });

  await t("⑧ブラウザ側で読み込み・実行時エラーが発生していない(pageerrorが1件も無い)", () => {
    assert.strictEqual(pageErrors.length, 0, `ブラウザ側で実行時エラーが発生した: ${pageErrors.map((e) => e.message).join(", ")}`);
  });

  await context.close();
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
