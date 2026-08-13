// チャンク境界をまたいで分割された秘密情報も伏字化されることの検証 — AUD-P1-05a/05b
//
// 旧実装のspawnAndLog(server/pipeline-runner.mjs)は子プロセスのstdout/stderrの
// dataイベント(チャンク)ごとに独立してredactSecrets()を掛けてから連結していた。
// 秘密情報の値がちょうど2チャンクの境目で分割されて出力されると(例: 1チャンク目の末尾に
// 前半、2チャンク目の先頭に後半)、どちらのチャンク単体にも完全な秘密情報の文字列が
// 含まれないため伏字化されず、連結後のSSE配信(05a)・state.json永続化(05b)の両方へ
// 生の値がそのまま漏れる。
//
// このファイルは2段構えで検証する:
//   ①単体: server/security.mjs の createStreamingRedactor() が、複数の異なる分割位置で
//     秘密情報を確実に伏字化すること(境界をまたぐ場合・跨がない場合の両方)。
//   ②実プロセス経由: 実際に子プロセス(偽python)がGROQ_API_KEY形式の値を、意図的に
//     複数回のwrite()に分けて(=複数の別々のdataイベントとして)出力し、実サーバーの
//     SSE配信本文とstate.jsonの両方に生の値が現れないことを確認する。
//
// 実行: node tests/security-secret-redaction-stream-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createStreamingRedactor, redactSecrets } from "../server/security.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORK_ROOT = path.join(ROOT, "work");
const PORT = 59206; // このテスト専用の固定ポート(security-secret-redaction-check.mjsの59205とは別)
const SECRET_VALUE = "gsk_TEST_STREAM_SECRET_SHOULD_NEVER_LEAK_1234567890";

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

// ── ①単体: createStreamingRedactor が境界分割に耐えること ────────────────
{
  // 秘密情報の全長にわたる複数のオフセットで分割し、どのオフセットでも生の値が
  // 出力(push()の戻り値の連結 + flush())に現れないことを確認する。
  for (let offset = 1; offset < SECRET_VALUE.length; offset++) {
    const before = `stdout log before secret ${SECRET_VALUE.slice(0, offset)}`;
    const after = `${SECRET_VALUE.slice(offset)} and after the secret\n`;
    const redactor = createStreamingRedactor([SECRET_VALUE]);
    const out1 = redactor.push(before);
    const out2 = redactor.push(after);
    const out3 = redactor.flush();
    const combined = out1 + out2 + out3;
    report(
      `①offset=${offset}: 分割されたチャンクの連結出力に生の秘密値が含まれない`,
      !combined.includes(SECRET_VALUE),
      `combined=${JSON.stringify(combined)}`
    );
    report(
      `①offset=${offset}: 分割されたチャンクでも[REDACTED]が現れる(伏字化そのものは働いている)`,
      combined.includes("[REDACTED]"),
      `combined=${JSON.stringify(combined)}`
    );
  }
}

// ── ①対照: 素朴な「チャンクごとに独立してredactSecretsして連結」だと漏れる ────
{
  const offset = Math.floor(SECRET_VALUE.length / 2); // 秘密値のちょうど真ん中で分割
  const before = `stdout log before secret ${SECRET_VALUE.slice(0, offset)}`;
  const after = `${SECRET_VALUE.slice(offset)} and after the secret\n`;
  // 旧実装を模す: チャンクごとに独立してredactSecretsを掛けてから連結する。
  const naive = redactSecrets(before, [SECRET_VALUE]) + redactSecrets(after, [SECRET_VALUE]);
  report(
    "①対照: チャンク単位で独立に伏字化してから連結する旧方式は、境界分割された秘密値を漏らす" +
      "(この検査に検出能力があることの確認＝偽の緑ではない)",
    naive.includes(SECRET_VALUE),
    `naive=${JSON.stringify(naive)}`
  );
}

// ── ①: 通常の単一チャンク(分割なし)は引き続き正しく動く(回帰なし) ────────
{
  const redactor = createStreamingRedactor([SECRET_VALUE]);
  const out = redactor.push(`single chunk with ${SECRET_VALUE} inline\n`) + redactor.flush();
  report(
    "①単一チャンク(分割なし)でも生の秘密値が含まれない",
    !out.includes(SECRET_VALUE) && out.includes("[REDACTED]"),
    `out=${JSON.stringify(out)}`
  );
}

// ── ②実プロセス経由: SSE配信(05a)・state.json(05b) ─────────────────────
function fakeLeakyPythonSplitWrites() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fake-leaky-python-stream-"));
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const half = Math.floor(SECRET_VALUE.length / 2);
  const part1 = SECRET_VALUE.slice(0, half);
  const part2 = SECRET_VALUE.slice(half);
  // 秘密情報を2回のstderr.write()に分けて出力する(各writeが別々のdataイベントになるよう、
  // 間に短い非同期待ち(setTimeout)を挟んで確実にTCP/パイプの別チャンクにする)。
  const script = `#!/usr/bin/env node
process.stderr.write(${JSON.stringify(`[ERROR] Groq authentication failed for key ${part1}`)});
setTimeout(() => {
  process.stderr.write(${JSON.stringify(`${part2} (split across chunks)\n`)});
  process.exitCode = 1;
}, 100);
`;
  const exe = path.join(binDir, "python");
  fs.writeFileSync(exe, script, "utf-8");
  fs.chmodSync(exe, 0o755);
  return { binDir };
}

function startServer(extraPathDirs, extraEnv) {
  return new Promise((resolve, reject) => {
    const PATH = [...extraPathDirs, process.env.PATH].join(path.delimiter);
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), PATH, ...extraEnv },
    });
    let buf = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("server起動タイムアウト")); }, 8000);
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

function postJob(token) {
  const head = Buffer.alloc(16);
  head.write("ftyp", 4, "ascii");
  const buf = Buffer.concat([head, Buffer.alloc(2000, 0)]);
  const q = new URLSearchParams({ token, sub: "none", cut: "topic", size: "9:16", name: "secret-redaction-stream.mp4" }).toString();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: `/api/jobs?${q}`, method: "POST", timeout: 15000,
      headers: { host: `127.0.0.1:${PORT}`, "Content-Type": "application/octet-stream", "Content-Length": buf.length },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

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
      res.on("end", () => settle(resolve, { status: res.statusCode, body }));
    });
    req.on("error", (e) => settle(reject, e));
    timer = setTimeout(() => { req.destroy(); settle(resolve, { status: 0, body, timedOut: true }); }, timeoutMs);
  });
}

let server = null;
let createdJobId = null;
const { binDir } = fakeLeakyPythonSplitWrites();
try {
  const started = await startServer([binDir], { GROQ_API_KEY: SECRET_VALUE });
  server = started.child;

  const posted = await postJob(started.token);
  report("前提: ジョブが受理される(202)", posted.status === 202, `status=${posted.status} ${posted.body}`);
  const { jobId, jobToken } = JSON.parse(posted.body);
  createdJobId = jobId;

  const events = await collectEvents(jobId, jobToken, 15_000);
  const gotError = /event:\s*error/.test(events.body);
  report("前提: 偽pythonの異常終了によりジョブがerrorで終わる", gotError, events.body.slice(0, 500));

  // ── AUD-P1-05a: SSE配信本文に、チャンク境界で分割された秘密が現れない ──────
  report(
    "AUD-P1-05a: チャンク境界で分割出力された秘密情報でも、SSE配信本文全体に生の値が含まれない",
    !events.body.includes(SECRET_VALUE),
    `secretFound=${events.body.includes(SECRET_VALUE)} bodyTail=${events.body.slice(-400)}`,
  );
  report(
    "AUD-P1-05a: SSE配信本文に伏字マーカー[REDACTED]が現れている(伏字化そのものは実際に働いている)",
    events.body.includes("[REDACTED]"),
    events.body.slice(-400),
  );

  // ── AUD-P1-05b: state.jsonのerrorフィールドに、分割された秘密が現れない ────
  const statePath = path.join(WORK_ROOT, jobId, "state.json");
  report("前提: state.jsonが書かれている", fs.existsSync(statePath));
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    report(
      "AUD-P1-05b: state.jsonのerrorフィールドに、チャンク境界で分割出力された秘密情報が含まれない",
      typeof state.error === "string" && !state.error.includes(SECRET_VALUE),
      `error=${state.error}`,
    );
    report(
      "AUD-P1-05b: state.jsonのerrorフィールドに伏字マーカー[REDACTED]が現れている",
      typeof state.error === "string" && state.error.includes("[REDACTED]"),
      `error=${state.error}`,
    );
  }
} finally {
  await stopServer(server);
  if (createdJobId) {
    fs.rmSync(path.join(WORK_ROOT, createdJobId), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, "output", createdJobId), { recursive: true, force: true });
  }
  fs.rmSync(path.dirname(binDir), { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
