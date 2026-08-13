// POST /api/jobsの応答〜EventSourceの実接続までの間に飛んだ進捗も取りこぼさないことの検証
// — AUD-P1-10c
//
// server/pipeline-runner.mjs のSSE配送は、broadcast()時点で接続中の購読者にしか届かない。
// これまでは「購読が遅れて始まった場合、遅れた間に飛んだ進捗イベントはそのまま消える」実装
// だったため、POST応答からEventSourceが実際に開くまでの実ネットワーク往復の間に発生した
// 進捗(例: stage t のactive化)を、接続後も一切知る術が無かった(次の進捗が来るまで無音のまま)。
// subscribeJob()が、接続直後に直近スナップショットを1回だけ即送るようにして直した。
//
// 【なぜ実サーバーで確かめるか】subscribeJob()を直接呼ぶ単体テストでは「関数の内部状態」しか
// 見えず、「本物のPOST→(意図的な遅延)→本物のGET /events」という実際の競合状況を再現できない。
// 実プロセスを起動し、POST応答を受けたあと意図的に接続を遅らせてから、GET /eventsで届く
// 最初のデータが「現在の進捗」を反映していることを実測する。
//
// 実行: node tests/sse-snapshot-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runFfmpeg } from "../src/render-vertical.mjs";
import { installFakeClaude } from "./helpers/fake-claude-main.mjs";
import { CONFIG_FILE as FAKE_PYTHON_CONFIG_FILE } from "./helpers/fake-transcribe-delayed-main.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const FAKE_PYTHON_MAIN = path.join(HERE, "helpers", "fake-transcribe-delayed-main.mjs");
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");
const PORT = 59194; // このテスト専用の固定ポート

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
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

function installFakePython(label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `vs-fake-python-${label}-`));
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
    { needle: "区間に切り分ける編集者", answer: JSON.stringify({ segments: [{ keepText: SEG_TEXT, hook: "テスト", reason: "てすと" }] }) },
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
      const m = buf.match(/startup token[^:]*:\s*([0-9a-f]+)/);
      if (m && /listening/.test(buf)) {
        clearTimeout(timer);
        resolve({ child, token: m[1] });
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

function postJob(token, samplePath) {
  const buf = fs.readFileSync(samplePath);
  const q = new URLSearchParams({ token, sub: "none", cut: "topic", size: "9:16", name: "sample.mp4" }).toString();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: `/api/jobs?${q}`, method: "POST",
      headers: { host: `127.0.0.1:${PORT}`, "Content-Type": "application/octet-stream", "Content-Length": buf.length },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

/** GET /events を開き、最初にdataとして届いた行(ping/コメント行は無視)を最大waitMsだけ待って返す。
 * 何も届かなければ null。接続はテスト側で明示的に破棄する。 */
function firstDataLine(jobId, jobToken, waitMs) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (settled) return; settled = true; clearTimeout(timer); req.destroy(); resolve(v); };
    const req = http.get({
      host: "127.0.0.1", port: PORT,
      path: `/api/jobs/${jobId}/events?jobToken=${jobToken}`,
      headers: { host: `127.0.0.1:${PORT}` },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c.toString();
        // ": ping" (接続確立確認コメント行)を除き、"data:"を含む実データ行が来たら確定。
        const lines = buf.split("\n\n").filter((chunk) => chunk.trim() && !chunk.startsWith(": ping"));
        if (lines.length > 0) settle(lines[0]);
      });
    });
    req.on("error", () => settle(null));
    const timer = setTimeout(() => settle(null), waitMs);
  });
}

let server = null;
const createdJobIds = [];
try {
  if (!(await ffmpegAvailable())) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-sse-snap-"));
  const sample = await makeSample(tmp);
  const fakePython = installFakePython("snap");
  const fakeClaude = installFakeClaude("snap", OK_CLAUDE);

  const started = await startServer([fakeClaude.binDir, fakePython.binDir]);
  server = started.child;

  const posted = await postJob(started.token, sample);
  report("POST /api/jobs が受理される(202)", posted.status === 202, `status=${posted.status} ${posted.body}`);
  const { jobId, jobToken } = JSON.parse(posted.body);
  assert.ok(jobId && jobToken, `jobId/jobTokenが返っていない: ${posted.body}`);
  createdJobIds.push(jobId);

  // AUD-P1-10c本体: POST応答を受けてから、わざとEventSource接続を遅らせる
  // (=実ブラウザがPOST応答からEventSourceを実際に開くまでのネットワーク往復を模す)。
  // fake-transcribe-delayed(500ms)により、この間にstage t のactive化イベントは
  // 既に発生済み(job.lastEventへスナップショットされている)が、誰も購読していないので
  // 通常のbroadcastは空振りする。
  await new Promise((r) => setTimeout(r, 250));

  const line = await firstDataLine(jobId, jobToken, 3000);
  report(
    "遅れて接続しても、接続直後に届く最初のデータが現在の進捗(stage t)を表している(見逃した進捗が復旧する)",
    !!line && /"stage":"t"/.test(line) && /"status":"active"/.test(line),
    `line=${JSON.stringify(line)}`
  );
} finally {
  await stopServer(server);
  for (const jobId of createdJobIds) {
    fs.rmSync(path.join(WORK_ROOT, jobId), { recursive: true, force: true });
    fs.rmSync(path.join(OUT_ROOT, jobId), { recursive: true, force: true });
  }
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
