// 業務エラーとtransport errorを混同しないことの検証 — AUD-P1-10b
//
// これまでサーバーは業務/アプリケーションエラー(このジョブが失敗した)をSSEの名前付き
// イベント"error"で送っていた。EventSourceは接続断などのネイティブ"error"イベントと、
// サーバーが送った独自の"error"を、クライアント側では同じ addEventListener("error", ...) が
// 受け取ってしまい区別できない。名前を"job-error"へ分離した。
//
// このテストは実サーバーへ本物のPOST/GETを通し、(a) 話し声なし(no_speech)という業務エラーが
// event: job-error として届き、その後ストリームが実際に閉じること(=何度も再接続してループしない
// 終端であること)、(b) 存在しないジョブIDへのSSE要求は、SSEストリームが一度も開かず(text/event-
// streamにならず)HTTPレベルで拒否されること(=これも再接続ループしない終端であること)を確かめる。
//
// 実行: node tests/sse-business-error-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runFfmpeg } from "../src/render-vertical.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");
const PORT = 59195; // このテスト専用の固定ポート

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

// 話し声が無い動画（音楽のみ）を模す: 文字起こしのsegmentsが空。
const SAMPLE_DURATION_SEC = 4;
async function makeSample(dir) {
  const out = path.join(dir, "sample-silent.mp4");
  await runFfmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc=size=320x240:rate=10:duration=${SAMPLE_DURATION_SEC}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${SAMPLE_DURATION_SEC}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    out,
  ]);
  return out;
}

/** 話し声なし(segments:[])を即座に返す偽python。claudeは一切呼ばれない(no_speechで即失敗)。 */
function installFakeNoSpeechPython() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fake-python-nospeech-"));
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, "python");
  fs.writeFileSync(
    exe,
    `#!/usr/bin/env node\n` +
      `const fs = require("fs");\n` +
      `const transcriptPath = process.argv[process.argv.length - 1];\n` +
      `fs.writeFileSync(transcriptPath, JSON.stringify({language:"ja",duration:${SAMPLE_DURATION_SEC},words:[],segments:[]}));\n`
  );
  fs.chmodSync(exe, 0o755);
  return { binDir };
}

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

/** SSEを最後まで読み切り、{status, headers, body, closedNaturally}を返す。 */
function collectEvents(jobId, jobToken, timeoutMs) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    let timer;
    const settle = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const req = http.get({
      host: "127.0.0.1", port: PORT,
      path: `/api/jobs/${jobId}/events?jobToken=${jobToken}`,
      headers: { host: `127.0.0.1:${PORT}` },
    }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => settle(resolve, { status: res.statusCode, headers: res.headers, body, closedNaturally: true }));
    });
    req.on("error", (e) => settle(reject, e));
    timer = setTimeout(() => {
      req.destroy();
      settle(resolve, { status: null, headers: {}, body, closedNaturally: false });
    }, timeoutMs);
  });
}

let server = null;
const createdJobIds = [];
try {
  if (!(await ffmpegAvailable())) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-sse-bizerr-"));
  const sample = await makeSample(tmp);
  const fakePython = installFakeNoSpeechPython();

  const started = await startServer([fakePython.binDir]);
  server = started.child;

  // ── (a) 業務エラー: 話し声なし(no_speech)がevent: job-errorとして届き、実際に閉じる ──
  const posted = await postJob(started.token, sample);
  report("(a) POST /api/jobs が受理される(202)", posted.status === 202, `status=${posted.status} ${posted.body}`);
  const { jobId, jobToken } = JSON.parse(posted.body);
  assert.ok(jobId && jobToken, `jobId/jobTokenが返っていない: ${posted.body}`);
  createdJobIds.push(jobId);

  const events = await collectEvents(jobId, jobToken, 30_000);
  report(
    "(a) 業務エラー(no_speech)は event: job-error として届く(ネイティブerrorと同名衝突しない)",
    /event:\s*job-error/.test(events.body),
    `body=${events.body.slice(0, 300)}`
  );
  report(
    "(a) 業務エラーが来ると、ストリームは実際にサーバー側から閉じられる(終端＝再接続ループしない)",
    events.closedNaturally,
    `closedNaturally=${events.closedNaturally}`
  );
  report(
    "(a) 業務エラーのcodeがno_speechとして正しく伝わる(専用カード判定に使う値)",
    /"code":"no_speech"/.test(events.body),
    `body=${events.body.slice(0, 300)}`
  );

  // ── (b) 存在しないジョブID: SSEストリームが一度も開かず、HTTPレベルで終端拒否される ──
  const badReq = await collectEvents("totally-unknown-job-id", "whatever-token", 5000);
  report(
    "(b) 存在しないジョブIDへのSSE要求は403で即終端し、event-streamとしては一切開かない" +
      "(ブラウザのEventSourceはreadyState=CLOSEDになり、二度と自動再接続しない状況を作れる)",
    badReq.status === 403 && !/^event:/m.test(badReq.body) && !/text\/event-stream/.test(badReq.headers["content-type"] || ""),
    `status=${badReq.status} contentType=${badReq.headers["content-type"]} body=${badReq.body.slice(0, 200)}`
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
