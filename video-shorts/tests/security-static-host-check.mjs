// 静的配信のHost検査の検証 — P1-15-A
//
// 旧実装のHost/Origin検査(isAllowedApiOrigin)はpathnameが"/api/"で始まる場合のみ適用され、
// GET /（静的配信・index.htmlへの起動時トークン埋め込み）は対象外だった(M-1、
// docs/audits/2026-08-13-security-audit.md)。実機PoCで、Host: evil.example.comを付けた
// GET /が200で応答し、本文に実際の起動時トークンが埋め込まれて返ってくることを確認済み。
//
// 実行: node tests/security-static-host-check.mjs   (全PASSで exit 0)

import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 59200; // このテスト専用の固定ポート

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

function getRoot(hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: "/", method: "GET", timeout: 8000,
      headers: { host: hostHeader },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end();
  });
}

let server = null;
try {
  const started = await startServer();
  server = started.child;
  const realToken = started.token;

  // ── P1-15-A本体: 許可外Hostでは起動時トークンが返らない ────────
  for (const badHost of ["evil.example.com", "evil.example.com:9999", "127.0.0.1:9999"]) {
    const r = await getRoot(badHost);
    const tokenLeaked = r.body.includes(realToken);
    report(
      `P1-15-A: Host="${badHost}"でのGET /は起動時トークンを含まない`,
      !tokenLeaked,
      `status=${r.status} tokenLeaked=${tokenLeaked}`,
    );
    report(
      `P1-15-A: Host="${badHost}"でのGET /は200(通常配信)で応答しない(401等で拒否される)`,
      r.status !== 200,
      `status=${r.status}`,
    );
  }

  // ── 対照: 正規のHostでは従来どおりトークンが埋め込まれて返る ────
  for (const goodHost of [`127.0.0.1:${PORT}`, `localhost:${PORT}`]) {
    const r = await getRoot(goodHost);
    report(
      `対照: Host="${goodHost}"でのGET /は200で応答し、起動時トークンが埋め込まれる`,
      r.status === 200 && r.body.includes(realToken),
      `status=${r.status} bodyIncludesToken=${r.body.includes(realToken)}`,
    );
  }
} finally {
  await stopServer(server);
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
