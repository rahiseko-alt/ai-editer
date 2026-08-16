// 静的配信・クリップ配信のsymlink追随防止の検証 — P1-17-A
//
// 旧実装のserveStatic/handleClipはfs.realpathSyncを呼ばず、webapp-mockup/・output/<id>/
// 配下にsymlinkが置かれていればその先を辿って配信していた(L-1、
// docs/audits/2026-08-13-security-audit.md)。現状symlinkは0件だが対策が無いことを
// コードレビューで確認済み。本テストは実際にsymlinkを設置して配信されないことを確認する。
//
// 実行: node tests/security-symlink-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hashToken } from "../server/security.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATIC_ROOT = path.join(ROOT, "webapp-mockup");
const OUT_ROOT = path.join(ROOT, "output");
const WORK_ROOT = path.join(ROOT, "work");
const PORT = 59202; // このテスト専用の固定ポート
const JOB_ID = "security-symlink-check-job";

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
const staticSecretPath = path.join(STATIC_ROOT, "__security-symlink-check-secret.html");
const staticLinkPath = path.join(STATIC_ROOT, "__security-symlink-check-link.html");
const outsideSecretFile = path.join(ROOT, "..", "security-symlink-check-outside-secret.txt");
try {
  // ── 準備: リポジトリ外の秘密ファイルと、それを指すsymlink ──────
  fs.writeFileSync(outsideSecretFile, "TOP SECRET CONTENT - must never be served", "utf-8");
  fs.symlinkSync(outsideSecretFile, staticLinkPath);

  const jobId = JOB_ID;
  const outDir = path.join(OUT_ROOT, jobId);
  const workDir = path.join(WORK_ROOT, jobId);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const clipSecretFile = path.join(ROOT, "..", "security-symlink-check-clip-secret.mp4");
  fs.writeFileSync(clipSecretFile, "SECRET CLIP CONTENT - must never be served", "utf-8");
  const clipLinkPath = path.join(outDir, "linked-clip.mp4");
  fs.symlinkSync(clipSecretFile, clipLinkPath);
  fs.writeFileSync(path.join(workDir, "job-token.txt"), hashToken(`${jobId}-token`), "utf-8");

  const started = await startServer();
  server = started.child;

  // ── P1-17-A本体: 静的配信がsymlinkの先を配信しない ─────────────
  {
    const r = await get("/__security-symlink-check-link.html");
    report(
      "P1-17-A: webapp-mockup配下のsymlinkの先(リポジトリ外の秘密ファイル)が配信されない",
      r.status === 403 || r.status === 404,
      `status=${r.status} bodyIncludesSecret=${r.body.includes("TOP SECRET")}`,
    );
    report(
      "P1-17-A: レスポンス本文に秘密の中身が含まれていない",
      !r.body.includes("TOP SECRET"),
    );
  }

  // ── P1-17-A本体: クリップ配信がsymlinkの先を配信しない ──────────
  {
    const r = await get(`/api/clips/${jobId}/linked-clip.mp4?jobToken=${jobId}-token`);
    report(
      "P1-17-A: output配下のsymlinkの先(リポジトリ外の秘密クリップ)が配信されない",
      r.status === 403 || r.status === 404,
      `status=${r.status} bodyIncludesSecret=${r.body.includes("SECRET CLIP")}`,
    );
  }

  // ── 対照: symlinkでない通常ファイルは従来どおり配信される ───────
  {
    fs.writeFileSync(staticSecretPath, "<html>not a secret, just a normal file</html>", "utf-8");
    const r = await get("/__security-symlink-check-secret.html");
    report(
      "対照: symlinkではない通常の静的ファイルは200で配信される(realpath検査で正規ファイルまで拒否していない)",
      r.status === 200 && r.body.includes("not a secret"),
      `status=${r.status}`,
    );
  }

  // ── 対照: このテストの検出手法自体が機能すること(symlinkを辿った場合は検出できる) ──
  {
    // realpath検査を経由せず、symlinkの実体を直接readFileSyncした場合に
    // 秘密の中身が読めてしまうこと(=symlink設置自体は機能していること)を確認する。
    // これにより上のFAIL/PASS判定が「そもそもsymlinkが機能していないから通っただけ」
    // ではないことを保証する。
    const direct = fs.readFileSync(staticLinkPath, "utf-8");
    report(
      "対照: 設置したsymlink自体は正しく秘密ファイルを指している(readFileSyncで直接読める)",
      direct.includes("TOP SECRET"),
    );
  }
} finally {
  await stopServer(server);
  fs.rmSync(staticSecretPath, { force: true });
  fs.rmSync(staticLinkPath, { force: true });
  fs.rmSync(outsideSecretFile, { force: true });
  fs.rmSync(path.join(ROOT, "..", "security-symlink-check-clip-secret.mp4"), { force: true });
  fs.rmSync(path.join(OUT_ROOT, JOB_ID), { recursive: true, force: true });
  fs.rmSync(path.join(WORK_ROOT, JOB_ID), { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
