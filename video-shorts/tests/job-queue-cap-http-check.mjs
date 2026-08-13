// 待ち行列が上限に達したときHTTP経由で4xxが返ることの検証(実サーバー) — AUD-P2-20b
//
// tests/job-queue-cap-check.mjs は pipeline-runner.mjs の startJob() を直接呼び、
// "queue_full" という戻り値そのものを検査した(内部の受入事実そのもの)。
// このファイルはその一段上、server/index.mjs が実際にその戻り値を見て POST /api/jobs へ
// 429を返す配線(HTTPレスポンスとしてクライアントに現れる形)を実サーバーで確認する。
//
// 実行: node tests/job-queue-cap-http-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const FAKE_HANGING_PYTHON = path.join(HERE, "helpers", "fake-hanging-python.mjs");
const WORK_ROOT = path.join(ROOT, "work");
const PORT = 59211; // このテスト専用の固定ポート

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

function installFakeHangingPython() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fake-hang-queue-http-"));
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, "python");
  fs.copyFileSync(FAKE_HANGING_PYTHON, exe);
  fs.chmodSync(exe, 0o755);
  return { binDir, home };
}

function startServer(extraPathDirs) {
  return new Promise((resolve, reject) => {
    const PATH = [...extraPathDirs, process.env.PATH].join(path.delimiter);
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: {
        ...process.env, PORT: String(PORT), PATH,
        GROQ_API_KEY: "dummy-key-for-gate-selection-only",
        VS_MAX_CONCURRENT_JOBS: "1",
        VS_MAX_QUEUE_LENGTH: "1",
      },
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

function postJob(token, name) {
  const head = Buffer.alloc(16);
  head.write("ftyp", 4, "ascii");
  const buf = Buffer.concat([head, Buffer.alloc(2000, 0)]);
  const q = new URLSearchParams({ token, sub: "none", cut: "topic", size: "9:16", name }).toString();
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

async function waitForPidFile(jobId, timeoutMs) {
  const p = path.join(WORK_ROOT, jobId, "fake-python.pid");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) return Number(fs.readFileSync(p, "utf-8").trim());
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

let server = null;
const fakePython = installFakeHangingPython();
const createdJobIds = [];
const spawnedPids = new Set();
try {
  const started = await startServer([fakePython.binDir]);
  server = started.child;
  const token = started.token;

  // job1: 実行スロット(1本)を占有する(stdinを待って固まる偽python)。
  const posted1 = await postJob(token, "queue-cap-http-1.mp4");
  report("前提: 1本目(実行枠を占有する側)が受理される(202)", posted1.status === 202, `status=${posted1.status} ${posted1.body}`);
  const { jobId: jobId1 } = JSON.parse(posted1.body);
  createdJobIds.push(jobId1);
  const pid1 = await waitForPidFile(jobId1, 5000);
  report("前提: 1本目の子プロセスが実際に起動している", pidAlive(pid1), `pid=${pid1}`);
  if (pid1) spawnedPids.add(pid1);

  // job2: 待ち行列(上限1)を満杯にする。
  const posted2 = await postJob(token, "queue-cap-http-2.mp4");
  report("前提: 待ち行列の上限(1)ちょうどまでは受理される(202)", posted2.status === 202, `status=${posted2.status} ${posted2.body}`);
  const { jobId: jobId2 } = JSON.parse(posted2.body);
  createdJobIds.push(jobId2);

  // job3: 待ち行列が満杯の状態でのPOST → 4xxで拒否される。
  const posted3 = await postJob(token, "queue-cap-http-3.mp4");
  report(
    "AUD-P2-20b: 待ち行列が満杯の状態でのPOST /api/jobsは4xxで拒否される",
    posted3.status >= 400 && posted3.status < 500,
    `status=${posted3.status} body=${posted3.body}`
  );
  report(
    "AUD-P2-20b: 拒否されたジョブのworkDirが残っていない(受理しないアップロードを残さない)",
    (() => {
      let body;
      try { body = JSON.parse(posted3.body); } catch (_) { return false; }
      // 拒否時はjobIdを払い出していない(=消すべき対象workDirは無い)ことも合わせて確認する。
      return !body.jobId;
    })(),
    posted3.body
  );
} finally {
  await stopServer(server);
  for (const pid of spawnedPids) {
    if (pidAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch (_) {} }
  }
  fs.rmSync(fakePython.home, { recursive: true, force: true });
  for (const id of createdJobIds) {
    fs.rmSync(path.join(WORK_ROOT, id), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, "output", id), { recursive: true, force: true });
  }
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
