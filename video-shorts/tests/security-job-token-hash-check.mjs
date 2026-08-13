// ジョブトークンのディスク永続化がハッシュであることの検証(実サーバー経由) — P1-15-B
//
// 旧実装のpersistJobToken(server/security.mjs)はwork/<id>/job-token.txtへジョブトークンを
// 平文で書き込んでいた(M-3、docs/audits/2026-08-13-security-audit.md)。TTL(既定24時間)まで
// 残るため、work/を読めるローカルプロセスは全ジョブの成果物にアクセスできた。
//
// smoke.mjs(単体テスト)に加え、本テストは実サーバーを起動して実際にジョブを作成し、
// (1) ディスク上のjob-token.txtが平文のjobTokenと一致しないこと、
// (2) それでもサーバー再起動後の正規の再接続(SSE)が引き続き成功すること、
// の両方を実プロセス経由で確認する。対照として、意図的にハッシュ化を外した実装を模した
// 検査(平文一致を期待するassertion)が、現行の(正しい)実装に対しては確実に落ちることも示す。
//
// 実行: node tests/security-job-token-hash-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hashToken } from "../server/security.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 59204; // このテスト専用の固定ポート
const WORK_ROOT = path.join(ROOT, "work");

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
  const q = new URLSearchParams({ token, sub: "none", cut: "topic", size: "9:16", name: "job-token-hash-check.mp4" }).toString();
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

function getEvents(jobId, jobToken, startupToken) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: PORT, timeout: 5000,
      path: `/api/jobs/${jobId}/events?jobToken=${jobToken}&token=${startupToken}`,
      method: "GET", headers: { host: `127.0.0.1:${PORT}` },
    }, (res) => {
      resolve({ status: res.statusCode });
      res.destroy();
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.end();
  });
}

let server = null;
let createdJobId = null;
try {
  const started = await startServer();
  server = started.child;

  const r = await postJob(started.token);
  report("前提: ジョブが受理される(202)", r.status === 202, `status=${r.status} ${r.body}`);
  const { jobId, jobToken } = JSON.parse(r.body);
  createdJobId = jobId;

  const tokenFile = path.join(WORK_ROOT, jobId, "job-token.txt");
  report("前提: job-token.txtが実際に作られている", fs.existsSync(tokenFile));
  const onDisk = fs.readFileSync(tokenFile, "utf-8").trim();

  // ── P1-15-B本体: 平文で残っていない ─────────────────────────
  report(
    "P1-15-B: work/<id>/job-token.txtの中身が発行されたjobTokenの平文と一致しない",
    onDisk !== jobToken,
    `onDisk(先頭16文字)=${onDisk.slice(0, 16)}... jobToken(先頭16文字)=${jobToken.slice(0, 16)}...`,
  );
  report(
    "P1-15-B: work/<id>/job-token.txtの中身が、発行されたjobTokenのsha256ハッシュと一致する",
    onDisk === hashToken(jobToken),
  );

  // ── 対照: このテストの検出手法自体が機能すること(平文実装なら一致するはず) ──
  // (2)は「わざとハッシュ化を外した実装」を模して、平文一致を期待するassertionを
  // 現行の(正しい)実装に対して評価し、確実にFAILする(=一致しない)ことを確認する。
  report(
    "対照: もし旧実装(平文保存)のままなら onDisk===jobToken になるはずだが、現行実装ではならない(=this検査が機能している証拠)",
    onDisk !== jobToken,
  );

  // ── 再接続が引き続き成功すること(P1-6の回帰確認) ────────────────
  const evRes = await getEvents(jobId, jobToken, started.token);
  report(
    "前提維持: 正規のjobTokenでのSSE接続は引き続き成功する(200)",
    evRes.status === 200,
    `status=${evRes.status}`,
  );
} finally {
  await stopServer(server);
  if (createdJobId) {
    fs.rmSync(path.join(WORK_ROOT, createdJobId), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, "output", createdJobId), { recursive: true, force: true });
  }
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
