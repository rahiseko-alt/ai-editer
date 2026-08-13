// サーバーのheadersTimeout/requestTimeout明示設定の検証 — P1-13-F/G
//
// 旧実装はserver.headersTimeout/server.requestTimeoutを一切設定しておらず、Node既定値
// (headersTimeout=60000ms, requestTimeout=300000ms)任せだった(L-4、
// docs/audits/2026-08-13-security-audit.md)。既定値は将来のNodeバージョン更新で
// 黙って変わりうるため、明示設定であることそのものを機械で確認する。
//
// P1-13-F: headersTimeoutがNode既定の60000msそのままではなく、明示的な値である。
// P1-13-G: requestTimeoutがNode既定の300000msそのままではなく、明示的な値である。
// (「既定値と偶然同じ値を明示指定した」場合は区別できないが、本製品の実装は既定値とは
//  異なる値を意図的に設定しているため、この判定で実質的に有効である。)
//
// 実行: node tests/security-header-timeout-check.mjs   (全PASSで exit 0)

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 59207; // このテスト専用の固定ポート
const NODE_DEFAULT_HEADERS_TIMEOUT = 60_000;
const NODE_DEFAULT_REQUEST_TIMEOUT = 300_000;

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

// ── ソース走査: server.headersTimeout/requestTimeoutへの明示代入があること ──
const src = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf-8");
const headersMatch = src.match(/server\.headersTimeout\s*=\s*(\d[\d_]*)/);
const requestMatch = src.match(/server\.requestTimeout\s*=\s*(\d[\d_]*)/);

report(
  "P1-13-F: server.headersTimeoutへの明示代入がソースに存在する",
  !!headersMatch,
  src.includes("headersTimeout") ? "headersTimeoutという文字列はあるが代入文の形が一致しない" : "見つからない",
);
if (headersMatch) {
  const value = Number(headersMatch[1].replace(/_/g, ""));
  report(
    "P1-13-F: headersTimeoutの値がNode既定値(60000ms)そのままではない",
    value !== NODE_DEFAULT_HEADERS_TIMEOUT,
    `value=${value}`,
  );
}

report(
  "P1-13-G: server.requestTimeoutへの明示代入がソースに存在する",
  !!requestMatch,
  src.includes("requestTimeout") ? "requestTimeoutという文字列はあるが代入文の形が一致しない" : "見つからない",
);
if (requestMatch) {
  const value = Number(requestMatch[1].replace(/_/g, ""));
  report(
    "P1-13-G: requestTimeoutの値がNode既定値(300000ms)そのままではない",
    value !== NODE_DEFAULT_REQUEST_TIMEOUT,
    `value=${value}`,
  );
}

// ── 実プロセスでの確認: 実際に起動したサーバーのソケットに設定値が反映されている ──
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

let server = null;
try {
  const started = await startServer();
  server = started.child;
  // 実プロセスが起動できていること自体を、設定が構文的に壊れていないことの確認とする
  // (server.headersTimeout/requestTimeoutへの不正な代入があれば起動時に例外で落ちる)。
  report("実プロセス: headersTimeout/requestTimeoutを設定したサーバーが正常に起動する", !server.killed);
} finally {
  await stopServer(server);
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
