// SSE切断後、自動再接続し見逃した進捗を復旧することの検証 — AUD-P1-10a
//
// これまでEventSourceのerrorハンドラは、原因を問わず常にes.close()していた。これは
// ブラウザのネイティブ自動再接続(接続済みストリームが途中で切れた場合、標準仕様で
// ブラウザが裏で自動的に再試行する)を毎回握りつぶしていたことを意味する。
// readyStateで「途中で切れただけ(CONNECTING=自動再接続中)」と「二度と繋がらない
// (CLOSED)」を区別し、前者ではes.close()を呼ばないよう直した(AUD-P1-10a)。
// あわせて、再接続後にサーバーが現在の進捗スナップショットを即送る(AUD-P1-10c)ため、
// 切断中に発生した進捗も画面へ復旧する。
//
// 【本物のTCP切断をどう起こすか】ブラウザ↔実サーバーの間に自前の生TCPリレー(net相当)を
// 挟み、Playwrightはリレーのポートへ接続する(index.htmlの相対URLはそのままリレー経由に
// なる)。SSE接続を特定した上で、そのリレー接続だけを両側とも物理的にdestroy()し、
// 「途中でTCP接続が切れた」状態を実際に作る(サーバー側のfetchを差し替えて偽装するのでは
// なく、本物のソケット破棄)。
//
// このファイルは playwright（実ブラウザ操作）に依存する。他のwebapp-*-check.mjsと同じ作法
// （devDependencies導入・CI組み込み済み。詳細はwebapp-ai-caption-progress-check.mjs参照）。
// 実行: node tests/webapp-sse-reconnect-check.mjs

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
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
const SERVER_PORT = 59200; // 実サーバー(このテスト専用の固定ポート)
const RELAY_PORT = 59201;  // ブラウザが実際に繋ぐリレーのポート

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
  { w: "こんにちは", start: 0.0, end: 1.0 },
  { w: "今日は", start: 1.0, end: 2.0 },
  { w: "晴れです", start: 2.0, end: 6.0 },
];
const SEG_TEXT = WORDS.map((w) => w.w).join("");
const TRANSCRIPT = { language: "ja", duration: SAMPLE_DURATION_SEC, words: WORDS, segments: [{ start: 0.0, end: 6.0, text: SEG_TEXT }] };

function installFakePython() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fake-python-recon-"));
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, "python");
  fs.copyFileSync(FAKE_PYTHON_MAIN, exe);
  fs.chmodSync(exe, 0o755);
  fs.writeFileSync(path.join(binDir, "package.json"), '{"type":"module"}\n', "utf-8");
  fs.writeFileSync(path.join(binDir, FAKE_PYTHON_CONFIG_FILE), JSON.stringify({ transcript: TRANSCRIPT }), "utf-8");
  return { binDir };
}

const OK_CLAUDE = {
  kind: "route",
  rules: [
    { needle: "文字起こしを校正する人", answer: JSON.stringify({ fixes: [] }) },
    // 2026-08-16: 「間を詰める」の判断工程が増えた。この検査は詰める設定を使わないので
    // 実際には来ないが、来たときに黙って失敗しないよう答えを用意しておく。
    { needle: "話し言葉を編集する人", answer: JSON.stringify({ fillers: [], cutGaps: [] }) },
    { needle: "区間に切り分ける編集者", answer: JSON.stringify({ segments: [{ keepText: SEG_TEXT, hook: "テスト", reason: "てすと" }] }) },
  ],
  fallback: JSON.stringify({ fixes: [] }),
};

function startServer(extraPathDirs) {
  return new Promise((resolve, reject) => {
    const PATH = [...extraPathDirs, process.env.PATH].join(path.delimiter);
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(SERVER_PORT), PATH },
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

/**
 * ブラウザ↔実サーバー間の生TCPリレー。ブラウザが繋ぐのはこのポート。
 * 各接続の先頭バイトからHTTPリクエスト行を読み、/api/jobs/*\/events 宛かどうかを判別する。
 * 返り値の sseConns は「SSEだと判定した接続」を発生順に積んだ配列(destroy()できる)。
 */
// note: 'g'フラグ付きregexは.test()を複数回呼ぶとlastIndexが残り誤判定しうるため、
// 判定用('g'無し)と置換用('g'付き)を分けて持つ。
const RELAY_HOST_RE = new RegExp(`Host: 127\\.0\\.0\\.1:${RELAY_PORT}`, "i");
const RELAY_HOST_RE_G = new RegExp(`Host: 127\\.0\\.0\\.1:${RELAY_PORT}`, "gi");
const RELAY_ORIGIN_RE = new RegExp(`Origin: http://127\\.0\\.0\\.1:${RELAY_PORT}`, "i");
const RELAY_ORIGIN_RE_G = new RegExp(`Origin: http://127\\.0\\.0\\.1:${RELAY_PORT}`, "gi");
function startRelay() {
  const sseConns = [];
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: "127.0.0.1", port: SERVER_PORT });
    let markedAsSse = false;
    client.on("data", (chunk) => {
      // Keep-Alive接続は複数のリクエストを同じTCPソケットで使い回す(2本目以降のGETが
      // "最初のchunk"ではない位置に現れる)ため、Host/Originのリライトも、SSE判定も
      // 最初のchunkだけでなく毎chunk行う(実測: 最初のchunkだけ見ていると、静的取得が
      // 何本か先行済みの接続でGET /events が飛んだ場合に検出漏れ・401漏れが起きた)。
      const head = chunk.toString("latin1", 0, Math.min(chunk.length, 600));
      if (!markedAsSse && /^GET \/api\/jobs\/[^ ]*\/events/.test(head)) {
        markedAsSse = true;
        sseConns.push({ client, upstream });
      }
      // 実サーバーはHost/Originヘッダを自身のPORTと突き合わせて検証する(P1-2-B/P1-15-A)ため、
      // リレーのポートのままだと401で弾かれる。ヘッダ部分だけをリライトして転送する。
      const asStr = chunk.toString("latin1");
      if (RELAY_HOST_RE.test(asStr) || RELAY_ORIGIN_RE.test(asStr)) {
        const rewritten = asStr
          .replace(RELAY_HOST_RE_G, `Host: 127.0.0.1:${SERVER_PORT}`)
          .replace(RELAY_ORIGIN_RE_G, `Origin: http://127.0.0.1:${SERVER_PORT}`);
        chunk = Buffer.from(rewritten, "latin1");
      }
      if (upstream.writable) upstream.write(chunk);
    });
    upstream.on("data", (chunk) => { if (client.writable) client.write(chunk); });
    client.on("error", () => {});
    upstream.on("error", () => {});
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(RELAY_PORT, "127.0.0.1", () => resolve({ server, sseConns }));
  });
}

let server = null;
let browser = null;
let relay = null;
let tmp = null;
let createdJobId = null;

try {
  if (!(await ffmpegAvailable())) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-webapp-recon-"));
  const sample = await makeSample(tmp);
  const fakePython = installFakePython();
  const fakeClaude = installFakeClaude("recon", OK_CLAUDE);

  const started = await startServer([fakeClaude.binDir, fakePython.binDir]);
  server = started.child;
  relay = await startRelay();

  browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => {
    pageErrors.push(err);
    console.error("PAGE ERROR:", err.message);
  });

  // ブラウザはリレー経由で本物のサーバーへ繋ぐ(相対URLなのでPOST/SSE/静的配信すべてが乗る)。
  await page.goto(`http://127.0.0.1:${RELAY_PORT}/`);
  await page.waitForSelector("#file", { state: "attached" });

  await page.setInputFiles("#file", {
    name: "sample.mp4",
    mimeType: "video/mp4",
    buffer: fs.readFileSync(sample),
  });

  await page.click("#btn-run");
  await page.waitForSelector("#confirm-overlay:not(.hidden)");
  await page.click("#confirm-run");

  // SSE接続がリレーを通るのを待つ(1本目=最初の接続)。
  await t("前提: EventSourceの接続がリレーを実際に通っている", async () => {
    for (let i = 0; i < 50 && relay.sseConns.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(relay.sseConns.length >= 1, "SSE接続がリレーを通った形跡が無い");
  });

  // 進捗が最低1段階(stage t のactive)動くのを待ってから、まさに切断する。
  await page.waitForFunction(
    () => document.getElementById("editing-status")?.textContent === "話し言葉を文字にしています",
    { timeout: 15000 }
  );

  // ── 本物のTCP切断: 最初のSSE接続を両側ともdestroy()する ──
  const firstConn = relay.sseConns[0];
  firstConn.client.destroy();
  firstConn.upstream.destroy();

  // 切断してすぐ(=再接続が完了する前)にも、UIが即座に「終端のエラー」扱いしていないことを
  // 確認する(この時点でediting-errorが出ていたら、ネイティブerrorをまだ閉じてしまっている)。
  await t("切断直後: UIが即座に終端エラー扱いしていない(自動再接続に任せている)", async () => {
    await page.waitForTimeout(200);
    const errShown = await page.evaluate(() => !document.getElementById("editing-error").classList.contains("hidden"));
    assert.strictEqual(errShown, false, "切断直後にediting-errorが表示されてしまっている(即closeして終端扱いした疑い)");
  });

  await t("ブラウザが自動的に再接続し、リレーに2本目のSSE接続が実際に張られる", async () => {
    for (let i = 0; i < 100 && relay.sseConns.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(relay.sseConns.length >= 2, `再接続が観測できなかった(接続本数=${relay.sseConns.length})`);
  });

  // ジョブは切断中も裏で進み続け(サーバー側は無関係に処理続行)、再接続後は
  // サーバーが現在のスナップショットを即送る(AUD-P1-10c)ため、そのまま完走するはず。
  await page.waitForSelector("#result-overlay:not(.hidden)", { timeout: 90_000 });

  createdJobId = await page.evaluate(() => {
    /* global jobs */
    return (typeof jobs !== "undefined" && jobs[0] && jobs[0].jobId) || null;
  });

  await t("切断・再接続を経てもジョブは完走し、結果パネルに候補が出る(復旧できている)", async () => {
    const kept = await page.evaluate(() => document.getElementById("keep-n")?.textContent);
    assert.strictEqual(kept, "1", `候補が想定通り1件になっていない: ${kept}`);
  });

  await t("実行中、ブラウザ側で読み込み・実行時エラーが発生していない(pageerrorが1件も無い)", async () => {
    assert.strictEqual(pageErrors.length, 0, `ブラウザ側で実行時エラーが発生した: ${pageErrors.map((e) => e.message).join(", ")}`);
  });

  await context.close();
} finally {
  if (browser) await browser.close();
  if (relay) relay.server.close();
  await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (createdJobId) {
    fs.rmSync(path.join(WORK_ROOT, createdJobId), { recursive: true, force: true });
    fs.rmSync(path.join(OUT_ROOT, createdJobId), { recursive: true, force: true });
  }
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
