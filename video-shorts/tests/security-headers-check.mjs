// レスポンスセキュリティヘッダの検証 — P1-16-A/B/C/D
//
// 旧実装は grep -rn "Content-Security-Policy" server/ が0件で、CSP・X-Content-Type-Options・
// X-Frame-Options・Referrer-Policyのいずれもサーバー・HTMLとも一切設定していなかった
// (M-2、docs/audits/2026-08-13-security-audit.md)。クライアント側のescape処理が一箇所でも
// 崩れれば、多層防御なしに即XSS→トークン奪取に直結する。
//
// P1-16-A: Content-Security-Policyヘッダが付き、外部由来スクリプトを制限する内容である。
// P1-16-B: X-Content-Type-Options: nosniffヘッダが付く。
// P1-16-C: X-Frame-Options: DENYヘッダが付く。
// P1-16-D: Referrer-Policy: no-referrerヘッダが付く。
// いずれも複数種のエンドポイント(静的配信・JSON API・404応答)すべてで確認する。
//
// 実行: node tests/security-headers-check.mjs   (全PASSで exit 0)

import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 59201; // このテスト専用の固定ポート

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

function get(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: pathAndQuery, method: "GET", timeout: 8000,
      headers: { host: `127.0.0.1:${PORT}` },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
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

  const endpoints = [
    { name: "静的配信(GET /)", path: "/" },
    { name: "存在しないjobIdのcandidates(404 JSON)", path: "/api/jobs/no-such-job/candidates" },
    { name: "存在しない静的パス(404)", path: "/no-such-static-file.txt" },
    { name: "認可エラー(401、トークン無しjobs/eventsではなく通常API)", path: "/api/jobs/no-such-job/candidates?jobToken=wrong" },
  ];

  for (const ep of endpoints) {
    const r = await get(ep.path);

    report(
      `P1-16-A: ${ep.name} にContent-Security-Policyヘッダが付く`,
      typeof r.headers["content-security-policy"] === "string" && r.headers["content-security-policy"].length > 0,
      `headers=${JSON.stringify(r.headers["content-security-policy"])}`,
    );
    report(
      `P1-16-A: ${ep.name} のCSPが既定で外部オリジンのスクリプトを許可しない(default-src/script-srcに'self'を含む)`,
      /script-src[^;]*'self'/.test(r.headers["content-security-policy"] || "")
        || /default-src[^;]*'self'/.test(r.headers["content-security-policy"] || ""),
      `csp=${r.headers["content-security-policy"]}`,
    );
    report(
      `P1-16-B: ${ep.name} にX-Content-Type-Options: nosniffヘッダが付く`,
      r.headers["x-content-type-options"] === "nosniff",
      `value=${r.headers["x-content-type-options"]}`,
    );
    report(
      `P1-16-C: ${ep.name} にX-Frame-Options: DENYヘッダが付く`,
      r.headers["x-frame-options"] === "DENY",
      `value=${r.headers["x-frame-options"]}`,
    );
    report(
      `P1-16-D: ${ep.name} にReferrer-Policy: no-referrerヘッダが付く`,
      r.headers["referrer-policy"] === "no-referrer",
      `value=${r.headers["referrer-policy"]}`,
    );
  }
} finally {
  await stopServer(server);
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
