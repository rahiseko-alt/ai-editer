// ハングしたジョブの手動キャンセル・自動タイムアウトの検証 — AUD-P1-11a/11b
//
// 旧実装は、SSE切断が子プロセスをkillせず(unsubscribeするだけ)・キャンセルAPIが
// そもそも存在せず・どのステージにも時間の上限が無かった(監査指摘)。
// 標準入力を待ったまま固まったffmpeg/文字起こしのような子プロセスが1本でもいると、
// 実行スロットを永久に占有し続け、後続のジョブが一切進まなくなる。
//
// 対策: server/pipeline-runner.mjs にジョブ単位の制御レコード(jobControls)を持たせ、
//   AUD-P1-11a: POST /api/jobs/:id/cancel が、そのジョブの子プロセスをプロセスツリーごと
//     kill し、実行スロットを解放して 'cancelled' 終端状態にする。
//   AUD-P1-11b: 各ステージにVS_STAGE_TIMEOUT_SECONDSの制限時間を設け、誰もキャンセルしなくても
//     制限時間超過で自動的に同じkill経路へ入り 'timeout' 終端状態にする。
//
// このテストは、PATH上の"python"を「標準入力を待ったまま絶対に自分から終了しない」偽実装
// (tests/helpers/fake-hanging-python.mjs)に差し替え、文字起こし段(t)を実際にハングさせて
// 検証する。VS_MAX_CONCURRENT_JOBS=1 + GROQ_API_KEY(ダミー値)でconcurrencyGateを1本に絞り、
// 「実行スロットが本当に解放され、順番待ちのジョブが進む」ことまで実測する。
//
// 実行: node tests/job-cancel-timeout-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const FAKE_PYTHON_SRC = path.join(HERE, "helpers", "fake-hanging-python.mjs");
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");
const PORT_A = 59208; // 手動キャンセル(11a)専用
const PORT_B = 59209; // 自動タイムアウト(11b)専用

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

function installFakeHangingPython() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fake-hanging-python-"));
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, "python");
  fs.copyFileSync(FAKE_PYTHON_SRC, exe);
  fs.chmodSync(exe, 0o755);
  fs.writeFileSync(path.join(binDir, "package.json"), '{"type":"module"}\n', "utf-8");
  return { binDir, home };
}

function startServer(port, extraPathDirs, extraEnv) {
  return new Promise((resolve, reject) => {
    const PATH = [...extraPathDirs, process.env.PATH].join(path.delimiter);
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), PATH, GROQ_API_KEY: "dummy-groq-key-for-gate-selection", ...extraEnv },
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

function call(port, method, pathAndQuery) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: pathAndQuery, method, timeout: 30_000,
      headers: { host: `127.0.0.1:${port}`, "Content-Type": "application/json", "Content-Length": 0 },
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

function postJob(port, token, name) {
  const head = Buffer.alloc(16);
  head.write("ftyp", 4, "ascii");
  const buf = Buffer.concat([head, Buffer.alloc(2000, 0)]);
  const q = new URLSearchParams({ token, sub: "none", cut: "topic", size: "9:16", name }).toString();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: `/api/jobs?${q}`, method: "POST", timeout: 15000,
      headers: { host: `127.0.0.1:${port}`, "Content-Type": "application/octet-stream", "Content-Length": buf.length },
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

function collectEvents(port, jobId, jobToken, timeoutMs) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    let timer;
    const settle = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const req = http.get({
      host: "127.0.0.1", port,
      path: `/api/jobs/${jobId}/events?jobToken=${jobToken}`,
      headers: { host: `127.0.0.1:${port}` },
    }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => settle(resolve, { status: res.statusCode, body }));
    });
    req.on("error", (e) => settle(reject, e));
    timer = setTimeout(() => { req.destroy(); settle(resolve, { status: 0, body, timedOut: true }); }, timeoutMs);
  });
}

/** 指定パスにPIDファイルが現れるまで待つ(=そのジョブの子プロセスが実際に起動した合図)。 */
async function waitForPidFile(jobId, timeoutMs) {
  const p = path.join(WORK_ROOT, jobId, "fake-python.pid");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) return Number(fs.readFileSync(p, "utf-8").trim());
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** OSのプロセスが実際に生きているか(process.kill(pid,0)はシグナルを送らず存在確認だけ行う)。 */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

/** pidが消えるまで待つ(タイムアウトしたら現在の生死をそのまま返す)。 */
async function waitForPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !pidAlive(pid);
}

function cleanupJobDirs(ids) {
  for (const id of ids) {
    fs.rmSync(path.join(WORK_ROOT, id), { recursive: true, force: true });
    fs.rmSync(path.join(OUT_ROOT, id), { recursive: true, force: true });
  }
}

// 万一APIでのkillが効かなかった場合に、テスト実行環境へハングしたプロセスを残さないための
// 最終安全網。テストが何を主張しようと、これは必ず実行する。
const spawnedPids = new Set();

let serverA = null;
let serverB = null;
const fakePython = installFakeHangingPython();
const createdJobIds = [];
try {
  // ══════════════════════════════════════════════════════════════
  // AUD-P1-11a: 手動キャンセル
  // ══════════════════════════════════════════════════════════════
  {
    const started = await startServer(PORT_A, [fakePython.binDir], { VS_MAX_CONCURRENT_JOBS: "1", VS_STAGE_TIMEOUT_SECONDS: "3600" });
    serverA = started.child;
    const token = started.token;

    const posted1 = await postJob(PORT_A, token, "cancel-check-1.mp4");
    report("前提: 1本目のジョブが受理される(202)", posted1.status === 202, `status=${posted1.status} ${posted1.body}`);
    const { jobId: jobId1, jobToken: jobToken1 } = JSON.parse(posted1.body);
    createdJobIds.push(jobId1);

    const pid1 = await waitForPidFile(jobId1, 5000);
    report("前提: 1本目の子プロセス(偽python)が実際に起動している", pidAlive(pid1), `pid=${pid1}`);
    if (pid1) spawnedPids.add(pid1);

    const posted2 = await postJob(PORT_A, token, "cancel-check-2.mp4");
    report("前提: 2本目のジョブも受理される(202・キューへ積まれるだけで拒否はされない)", posted2.status === 202, `status=${posted2.status}`);
    const { jobId: jobId2, jobToken: jobToken2 } = JSON.parse(posted2.body);
    createdJobIds.push(jobId2);

    await new Promise((r) => setTimeout(r, 500));
    const pid2Early = fs.existsSync(path.join(WORK_ROOT, jobId2, "fake-python.pid"));
    report(
      "前提: 実行スロット(VS_MAX_CONCURRENT_JOBS=1)が埋まっているため、2本目はまだ子プロセスを起動していない",
      pid2Early === false
    );

    const cancelRes = await call(PORT_A, "POST", `/api/jobs/${jobId1}/cancel?jobToken=${jobToken1}`);
    report("AUD-P1-11a: キャンセルAPIが200を返す", cancelRes.status === 200, `status=${cancelRes.status} body=${cancelRes.body}`);

    const gone1 = await waitForPidGone(pid1, 5000);
    report("AUD-P1-11a: キャンセル後、1本目の実OSプロセスが実際に消える(killされている)", gone1, `pid=${pid1} alive=${pidAlive(pid1)}`);

    const events1 = await collectEvents(PORT_A, jobId1, jobToken1, 5000);
    report(
      "AUD-P1-11a: キャンセルされたジョブへ再接続すると event: cancelled がリプレイされる",
      /event:\s*cancelled/.test(events1.body),
      events1.body.slice(0, 300)
    );

    const pid2 = await waitForPidFile(jobId2, 8000);
    report(
      "AUD-P1-11a: 実行スロットが解放され、順番待ちだった2本目のジョブが実際に開始する",
      pidAlive(pid2),
      `pid2=${pid2}`
    );
    if (pid2) spawnedPids.add(pid2);

    // 後始末: 2本目もキャンセルして残さない。
    const cancelRes2 = await call(PORT_A, "POST", `/api/jobs/${jobId2}/cancel?jobToken=${jobToken2}`);
    report("後始末: 2本目のキャンセルも200で成功する(検証対象外の付随確認)", cancelRes2.status === 200, cancelRes2.body);
    await waitForPidGone(pid2, 5000);

    // 対照: 実行中でないジョブ(存在しないID)へのキャンセルは409で拒否される(検査の検出力確認)。
    const cancelBad = await call(PORT_A, "POST", `/api/jobs/nonexistent-job-id/cancel?jobToken=whatever`);
    report(
      "対照: 実行中でない/存在しないジョブへのキャンセルは失敗する(403か409。無条件で200にはならない)",
      cancelBad.status === 403 || cancelBad.status === 409,
      `status=${cancelBad.status}`
    );
  }

  // ══════════════════════════════════════════════════════════════
  // AUD-P1-11b: 自動タイムアウト(誰もキャンセルしない)
  // ══════════════════════════════════════════════════════════════
  {
    const STAGE_TIMEOUT_SEC = 2; // 短いタイムアウトで実測する
    const started = await startServer(PORT_B, [fakePython.binDir], { VS_MAX_CONCURRENT_JOBS: "1", VS_STAGE_TIMEOUT_SECONDS: String(STAGE_TIMEOUT_SEC) });
    serverB = started.child;
    const token = started.token;

    const posted3 = await postJob(PORT_B, token, "timeout-check-1.mp4");
    report("前提: 3本目のジョブが受理される(202)", posted3.status === 202, `status=${posted3.status}`);
    const { jobId: jobId3, jobToken: jobToken3 } = JSON.parse(posted3.body);
    createdJobIds.push(jobId3);

    const pid3 = await waitForPidFile(jobId3, 5000);
    report("前提: 3本目の子プロセス(偽python)が実際に起動している", pidAlive(pid3), `pid=${pid3}`);
    if (pid3) spawnedPids.add(pid3);

    const posted4 = await postJob(PORT_B, token, "timeout-check-2.mp4");
    const { jobId: jobId4, jobToken: jobToken4 } = JSON.parse(posted4.body);
    createdJobIds.push(jobId4);

    // 誰もキャンセルAPIを呼ばない。ステージ制限時間(2秒)より十分長く待ち、
    // SSEに event: timeout が自然に現れることを確認する。
    const events3 = await collectEvents(PORT_B, jobId3, jobToken3, (STAGE_TIMEOUT_SEC + 8) * 1000);
    report(
      "AUD-P1-11b: 誰もキャンセルしなくても、制限時間超過で event: timeout が自動的に発生する",
      /event:\s*timeout/.test(events3.body),
      events3.body.slice(0, 400)
    );

    const gone3 = await waitForPidGone(pid3, 5000);
    report("AUD-P1-11b: タイムアウト後、3本目の実OSプロセスが実際に消える(killされている)", gone3, `pid=${pid3} alive=${pidAlive(pid3)}`);

    const pid4 = await waitForPidFile(jobId4, 8000);
    report(
      "AUD-P1-11b: 実行スロットが解放され、順番待ちだった4本目のジョブが実際に開始する",
      pidAlive(pid4),
      `pid4=${pid4}`
    );
    if (pid4) spawnedPids.add(pid4);

    // 後始末: 4本目も同じくタイムアウトを待つ(短いのですぐ終わる)か、明示的にキャンセルする。
    await call(PORT_B, "POST", `/api/jobs/${jobId4}/cancel?jobToken=${jobToken4}`);
    await waitForPidGone(pid4, 5000);
  }
} finally {
  await stopServer(serverA);
  await stopServer(serverB);
  // 最終安全網: まだ生きているものが万一あれば、テスト環境にハングしたプロセスを残さないよう
  // 直接SIGKILLする(このテストの合否判定には使わない。後始末専用)。
  for (const pid of spawnedPids) {
    if (pidAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch (_) {}
    }
  }
  cleanupJobDirs(createdJobIds);
  fs.rmSync(fakePython.home, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
