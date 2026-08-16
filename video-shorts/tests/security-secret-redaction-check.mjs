// 子プロセス出力からのAPIキー伏字化の検証(実サーバー経由) — P1-14-B/C
//
// 旧実装のspawnAndLog(server/pipeline-runner.mjs)は子のstdout/stderrを1行ずつそのまま
// SSEへbroadcastし、異常終了時はstderr先頭400バイトをError.messageへ載せて
// work/<id>/state.jsonへも永続化していた(H-3後半、docs/audits/2026-08-13-security-audit.md)。
// 現状Python側は鍵を出力しないため実害は無いが、「出ない」ことを守る機械検査が無かった。
//
// 本テストは、GROQ_API_KEY形式の文字列をわざとstdout・stderrの両方へ出力してから
// 異常終了する偽pythonを差し込み、
//   P1-14-B: SSE配信本文に生の鍵文字列が現れないこと(stdout由来・stderr由来の両方)、
//   P1-14-C: work/<id>/state.jsonのerrorフィールドに生の鍵文字列が現れないこと、
// を実プロセス経由で確認する。対照として、伏字化を素通りする偽実装(redactSecretsを
// 呼ばない版)を模した検査で、同じ検査が確実に鍵の混入を検出できることも示す。
//
// 実行: node tests/security-secret-redaction-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { redactSecrets } from "../server/security.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORK_ROOT = path.join(ROOT, "work");
const PORT = 59205; // このテスト専用の固定ポート
const SECRET_VALUE = "gsk_TEST_SECRET_SHOULD_NEVER_LEAK_1234567890";

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

// ── 対照(単体): redactSecretsそのものが機能すること ──────────────
{
  const text = `stdout line with secret ${SECRET_VALUE} embedded\nsecond line clean`;
  const redacted = redactSecrets(text, [SECRET_VALUE]);
  report("対照: redactSecrets単体は秘密値を[REDACTED]へ置換する", !redacted.includes(SECRET_VALUE) && redacted.includes("[REDACTED]"));
  report("対照: redactSecrets単体は秘密値を含まない行を変更しない", redacted.includes("second line clean"));
  report("対照: redactSecretsに何も渡さなければ何も変わらない", redactSecrets(text, []) === text);
}

function fakeLeakyPython() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fake-leaky-python-"));
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(`[whisper] loading model, key=${SECRET_VALUE}\n`)});
process.stderr.write(${JSON.stringify(`[ERROR] Groq authentication failed for key ${SECRET_VALUE}\n`)});
process.exitCode = 1;
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
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("server起動タイムアウト")); }, 30000);
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
  const q = new URLSearchParams({ token, sub: "none", cut: "topic", size: "9:16", name: "secret-redaction.mp4" }).toString();
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
const { binDir } = fakeLeakyPython();
try {
  const started = await startServer([binDir], { GROQ_API_KEY: SECRET_VALUE });
  server = started.child;

  const posted = await postJob(started.token);
  report("前提: ジョブが受理される(202)", posted.status === 202, `status=${posted.status} ${posted.body}`);
  const { jobId, jobToken } = JSON.parse(posted.body);
  createdJobId = jobId;

  const events = await collectEvents(jobId, jobToken, 15_000);
  const gotError = /event:\s*job-error/.test(events.body);
  report("前提: 偽pythonの異常終了によりジョブがerrorで終わる", gotError, events.body.slice(0, 500));

  // ── P1-14-B: SSE配信本文に生の鍵が現れない ──────────────────────
  report(
    "P1-14-B: SSE配信本文全体に生の秘密値が含まれない(stdout/stderr両方の伏字化)",
    !events.body.includes(SECRET_VALUE),
    `secretFound=${events.body.includes(SECRET_VALUE)} bodyTail=${events.body.slice(-300)}`,
  );
  report(
    "P1-14-B: SSE配信本文に伏字マーカー[REDACTED]が現れている(伏字化そのものは実際に働いている)",
    events.body.includes("[REDACTED]"),
    events.body.slice(-300),
  );

  // ── P1-14-C: state.jsonのerrorフィールドに生の鍵が現れない ────────
  const statePath = path.join(WORK_ROOT, jobId, "state.json");
  report("前提: state.jsonが書かれている", fs.existsSync(statePath));
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    report(
      "P1-14-C: state.jsonのerrorフィールドに生の秘密値が含まれない",
      typeof state.error === "string" && !state.error.includes(SECRET_VALUE),
      `error=${state.error}`,
    );
    report(
      "P1-14-C: state.jsonのerrorフィールドに伏字マーカー[REDACTED]が現れている",
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
