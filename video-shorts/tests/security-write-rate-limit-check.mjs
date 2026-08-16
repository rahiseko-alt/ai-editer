// 書き込み系エンドポイントへのレート制限の検証 — P1-13-E
//
// 旧実装のjobsRateLimiter(server/index.mjs)はPOST /api/jobsにのみ適用され、
// PUT /api/jobs/:id/captions・POST /api/jobs/:id/terms・POST /api/jobs/:id/recaptionの
// 3つの書き込み系エンドポイントにはレート制限が一切無かった(M-4、
// docs/audits/2026-08-13-security-audit.md)。連打すればディスク書き込みやffmpeg起動を
// 際限なく積み上げられる。
//
// 実行: node tests/security-write-rate-limit-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hashToken } from "../server/security.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORK_ROOT = path.join(ROOT, "work");
const PORT = 59206; // このテスト専用の固定ポート
const JOB_ID = "security-write-rate-limit-check-job";
const JOB_TOKEN = "security-write-rate-limit-check-token";

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
    });
    let buf = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("server起動タイムアウト")); }, 30000);
    child.stderr.on("data", (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/startup token[^:]*:\s*([0-9a-f]+)/);
      if (m && /listening/.test(buf)) { clearTimeout(timer); resolve({ child, token: m[1] }); }
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

function put(pathAndQuery, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf-8");
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: pathAndQuery, method: "PUT", timeout: 8000,
      headers: { host: `127.0.0.1:${PORT}`, "Content-Type": "application/json", "Content-Length": payload.length },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function prepareJob() {
  fs.rmSync(path.join(WORK_ROOT, JOB_ID), { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK_ROOT, JOB_ID), { recursive: true });
  fs.writeFileSync(path.join(WORK_ROOT, JOB_ID, "job-token.txt"), hashToken(JOB_TOKEN), "utf-8");
  fs.writeFileSync(
    path.join(WORK_ROOT, JOB_ID, "transcript.json"),
    JSON.stringify({ words: [{ w: "テスト", start: 0, end: 0.5 }], segments: [] }),
    "utf-8",
  );
}

let server = null;
try {
  prepareJob();
  const started = await startServer();
  server = started.child;

  const capPath = `/api/jobs/${JOB_ID}/captions?jobToken=${JOB_TOKEN}`;

  // 閾値を超えるまで連打する。閾値未満は成功(200)/受理相当が続き、超えた分は429になるはず。
  const results = [];
  for (let i = 0; i < 30; i++) {
    const r = await put(capPath, { index: 0, text: `直し${i % 10}` });
    results.push(r.status);
  }

  const got429 = results.some((s) => s === 429);
  report(
    "P1-13-E: 字幕保存(PUT captions)を30回連打すると、途中から429が返るようになる",
    got429,
    `statuses=${JSON.stringify(results)}`,
  );
  const firstNon200Index = results.findIndex((s) => s !== 200);
  report(
    "P1-13-E: 最初の数回(閾値以内)は429にならず200で受理される(全リクエストが一律拒否ではない)",
    firstNon200Index > 0,
    `firstNon200Index=${firstNon200Index}`,
  );
} finally {
  await stopServer(server);
  fs.rmSync(path.join(WORK_ROOT, JOB_ID), { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
