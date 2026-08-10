// アップロードクォータ判定の競合状態の検証(CodeRabbit指摘対応) — P2-4-B の実地回帰テスト
//
// server/job-lifecycle.mjs の hasQuotaAvailable()/computeUsedBytes() 自体は job-quota-check.mjs
// が検証済みだが、それらを呼ぶ server/index.mjs 側の handlePostJobs() には次の2つの穴があった:
//   (a) 複数リクエストが同時に来ると、両方とも同じディスク使用量のスナップショットを見て
//       admission判定を通過してから書き込みが始まり、合計でクォータを超えうる。
//   (b) Content-Length を admission 判定に含めていないため、単一リクエストの書き込み中にも
//       クォータを超えうる。
// これは HTTP ルーティング層(server/index.mjs)の振る舞いであり、job-lifecycle.mjs の純粋関数を
// 直接呼ぶだけでは検出できない。restart-reconnect-check.mjs 等と同じく実サーバープロセスを
// 起動し、本物の HTTP で叩いて確認する。
//
// 実行: node tests/job-quota-race-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { computeUsedBytes } from "../server/job-lifecycle.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 59191; // このテスト専用の固定ポート
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");
const JOB_NAME_PREFIX = "quota-race-check";

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), ...env },
    });
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server起動タイムアウト")), 8000);
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

/** 有効な動画として扱われるダミーバッファ(mp4のftyp署名)を、指定サイズぶん作る。 */
function makeVideoBuffer(size) {
  const buf = Buffer.alloc(size, 0x00);
  buf.write("ftyp", 4, "ascii"); // バイト4-7が"ftyp" = MP4/MOV系のmagic byte
  return buf;
}

/** POST /api/jobs を叩く。Content-Length は buf.length からNodeが自動設定する。 */
function postJob({ token, name, buf }) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ sub: "none", cut: "topic", size: "9:16", name, token }).toString();
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: `/api/jobs?${q}`, method: "POST", timeout: 15000,
      headers: {
        host: `127.0.0.1:${PORT}`,
        "content-type": "application/octet-stream",
        "content-length": buf.length,
      },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end(buf);
  });
}

function cleanupJobDirs() {
  for (const root of [WORK_ROOT, OUT_ROOT]) {
    if (!fs.existsSync(root)) continue;
    for (const ent of fs.readdirSync(root)) {
      if (ent.startsWith(JOB_NAME_PREFIX)) {
        fs.rmSync(path.join(root, ent), { recursive: true, force: true });
      }
    }
  }
}

let server = null;
try {
  cleanupJobDirs();

  // 既存の使用量(他テストの残骸等)に上乗せする形で、このテスト専用の小さい予算を切る。
  const baseline = computeUsedBytes([WORK_ROOT, OUT_ROOT]);
  const BUDGET = 300_000; // 300KB
  const quotaBytes = baseline + BUDGET;

  const started = await startServer({ VS_STORAGE_QUOTA_BYTES: String(quotaBytes) });
  server = started.child;
  const token = started.token;

  // ── (b) 単一リクエストの Content-Length が予算を超えていれば、書き込み前に拒否される ──
  {
    const bigBuf = makeVideoBuffer(BUDGET + 100_000); // 予算を超える宣言長
    const r = await postJob({ token, name: `${JOB_NAME_PREFIX}-oversize.mp4`, buf: bigBuf });
    report(
      "(b) Content-Lengthが予算を超える単一アップロードは507で拒否される",
      r.status === 507,
      `status=${r.status} body=${r.body.slice(0, 200)}`
    );
    // 拒否されたジョブのworkDirが残っていない(部分書き込みが残骸化していない)ことも確認する。
    const leftover = fs.existsSync(WORK_ROOT)
      ? fs.readdirSync(WORK_ROOT).filter((n) => n.startsWith(`${JOB_NAME_PREFIX}-oversize`))
      : [];
    report(
      "(b) 拒否されたアップロードのworkDirが残っていない",
      leftover.length === 0,
      `leftover=${JSON.stringify(leftover)}`
    );
  }

  // ── (a) 予算内に収まる2つのリクエストを同時に送ると、合計超過分は片方だけ拒否される ──
  {
    // 個別には予算内(70%)だが、2本合計だと予算(140%)を超えるサイズにする。
    const eachSize = Math.floor(BUDGET * 0.7);
    const bufA = makeVideoBuffer(eachSize);
    const bufB = makeVideoBuffer(eachSize);
    const [rA, rB] = await Promise.all([
      postJob({ token, name: `${JOB_NAME_PREFIX}-race-a.mp4`, buf: bufA }),
      postJob({ token, name: `${JOB_NAME_PREFIX}-race-b.mp4`, buf: bufB }),
    ]);
    const statuses = [rA.status, rB.status].sort();
    report(
      "(a) 同時に来た2本のうち、合計超過分はちょうど1本だけ507で拒否される(両方202は不可)",
      statuses.length === 2 && statuses.includes(202) && statuses.includes(507),
      `statuses=${JSON.stringify(statuses)} bodyA=${rA.body.slice(0, 150)} bodyB=${rB.body.slice(0, 150)}`
    );
  }

  // ── 予約解放の確認: 上記の拒否分がreservedUploadBytesに残ったままだと、
  //    以後の正当なリクエストまで巻き添えで拒否されてしまう。予約が正しく解放されていれば、
  //    実ディスク使用量(まだ小さいまま)に対する小さいアップロードは通るはず。
  {
    const smallBuf = makeVideoBuffer(1000);
    const r = await postJob({ token, name: `${JOB_NAME_PREFIX}-after-release.mp4`, buf: smallBuf });
    report(
      "予約は拒否経路でも解放され、以後の正当な小さいアップロードは巻き添えで拒否されない",
      r.status === 202,
      `status=${r.status} body=${r.body.slice(0, 200)}`
    );
  }
} finally {
  await stopServer(server);
  cleanupJobDirs();
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
