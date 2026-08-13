// tests/restart-reconnect-check.mjs — P1-6の実地回帰テスト。
// 実行: node tests/restart-reconnect-check.mjs
//
// smoke.mjs のP1-6テストは pipeline-runner.mjs / security.mjs の関数を直接呼ぶだけで、
// HTTPルーティング全体(起動時トークンのゲート)を通さない。そのため「サーバー再起動で
// 起動時トークンが変わり、旧トークンのまま自動再接続するEventSourceが401で弾かれ、
// event: interrupted に到達できない」というバグを検出できなかった
// (2026-07-28 independent-verifierが実サーバー2プロセスでの再現により発見)。
// 同じ見落としを繰り返さないよう、実プロセスを2回起動する本物の再起動シナリオで検証する。

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hashToken } from "../server/security.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 59179; // このテスト専用の固定ポート(他テストの通常起動ポート5178とは別)
const JOB_ID = "restart-reconnect-check-job";
const JOB_TOKEN = "restart-reconnect-check-token";
const WORK_DIR = path.join(ROOT, "work", JOB_ID);

/** サーバーを起動し、"listening"ログが出たら{child, token}でresolveする */
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
    });
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server起動タイムアウト")), 5000);
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

/** サーバープロセスを終了させる(SIGTERM→保険のタイムアウト) */
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
    const req = http.get({ host: "127.0.0.1", port: PORT, path: pathAndQuery, timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
  });
}

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

let serverA = null, serverB = null;
try {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  // POST /api/jobsを実際に叩かず、"以前のプロセスが発行し永続化した"状態を直接再現する
  // (P1-6の対象は再接続の認可/通知ロジックであり、実際の文字起こし～レンダリングは不要)。
  // P1-15-B: job-token.txtにはハッシュを保存する(persistJobToken参照)。
  fs.writeFileSync(path.join(WORK_DIR, "job-token.txt"), hashToken(JOB_TOKEN), "utf-8");

  // プロセスA: "再起動前"の起動時トークンを得るためだけに一度起動して停止する。
  const a = await startServer();
  serverA = a.child;
  const oldStartupToken = a.token;
  await stopServer(serverA);
  serverA = null;

  // プロセスB: 実際の"再起動後"サーバー(新しい起動時トークンになる=旧トークンはもう無効)。
  const b = await startServer();
  serverB = b.child;
  assert.notStrictEqual(oldStartupToken, b.token, "前提: 起動時トークンは再起動のたび変わること");

  const r1 = await get(`/api/jobs/${JOB_ID}/events?token=${oldStartupToken}&jobToken=${JOB_TOKEN}`);
  report(
    "再起動前の起動時トークン+永続化ジョブトークンでSSE再接続すると、401にならずevent: interruptedに到達する",
    r1.status === 200 && /event:\s*interrupted/.test(r1.body),
    `status=${r1.status} body=${r1.body.slice(0, 200)}`
  );

  const r2 = await get(`/api/jobs/${JOB_ID}/events?token=${oldStartupToken}&jobToken=wrong-token`);
  report(
    "起動時トークンが古くても、誤ったジョブトークンは引き続き拒否される(回帰なし)",
    r2.status === 401 || r2.status === 403,
    `status=${r2.status}`
  );

  const r3 = await get(`/api/jobs/${JOB_ID}/events?token=${b.token}&jobToken=${JOB_TOKEN}`);
  report(
    "r1でメモリへ復元済みのジョブトークンは、以後ファイル再読込なしの通常経路でも機能する",
    r3.status === 200 && /event:\s*interrupted/.test(r3.body),
    `status=${r3.status}`
  );

  const r4 = await get(`/api/jobs/totally-unknown-job/events?token=${b.token}&jobToken=whatever`);
  report(
    "存在しないjobId(永続化トークンも無い)は、現在の起動時トークンが正しくても拒否される" +
      "(起動時トークンだけでジョブトークン必須を迂回できてはならない＝P1-4-Bの回帰防止)",
    r4.status === 403,
    `status=${r4.status}`
  );
} finally {
  await stopServer(serverA);
  await stopServer(serverB);
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
