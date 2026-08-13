// 焼き直し(recaption)連打への耐性の検証 — P1-13-C/D
//
// 旧実装の POST /api/jobs/:id/recaption は isRunning(id)(パイプライン本編の実行中判定)
// しか見ておらず、pipeline-runner.mjs の concurrencyGate にもレート制限にも一切乗らなかった
// (H-2、docs/audits/2026-08-13-security-audit.md)。そのため:
//   (a) 異なるジョブへ同時に焼き直しを連打すると、ffmpegが同時実行数の上限を超えて
//       際限なくspawnされる。
//   (b) 同一ジョブへ焼き直しを同時に2回送ると、src/recaption-stage.mjsの一時ファイル名
//       (${outDir}/${c.file}.recaption-tmp.mp4)がジョブごとに固定のため競合する。
//
// P1-13-C: 複数の異なるジョブへ同時に焼き直しを送っても、同時に生存するffmpeg子プロセス数が
//   既定の上限(VS_MAX_CONCURRENT_JOBS)を超えない。
// P1-13-D: 同一ジョブへ焼き直しを同時に2回送ると、片方は409で拒まれ、実行された方の
//   成果物は壊れない。
//
// 実行: node tests/security-recaption-flood-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runFfmpeg } from "../src/render-vertical.mjs";
import { hashToken } from "../server/security.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");
const PORT = 59199; // このテスト専用の固定ポート
const MAX_CONCURRENT = 2; // このテストではVS_MAX_CONCURRENT_JOBSを2に固定して検証する
const CLIP_FILE = "clip-1.mp4";

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

function ffmpegAvailable() {
  return new Promise((res) => {
    const p = spawn("ffmpeg", ["-version"], { windowsHide: true });
    p.on("error", () => res(false));
    p.on("close", (c) => res(c === 0));
  });
}

// 焼き直しの実行時間を稼ぐため、意図的にやや長め(3秒)の素材を使う。
// あまり長いと1回のffmpeg処理自体は速いので、同時実行数の観測窓を確保するのが目的。
const SAMPLE_DURATION_SEC = 3;
async function makeSample(dir, seed) {
  const out = path.join(dir, `sample-${seed}.mp4`);
  await runFfmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc=size=640x360:rate=15:duration=${SAMPLE_DURATION_SEC}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${SAMPLE_DURATION_SEC}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    out,
  ]);
  return out;
}

function startServer(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), ...extraEnv },
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

function call(method, pathAndQuery) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: pathAndQuery, method, timeout: 30_000,
      headers: { host: `127.0.0.1:${PORT}`, "Content-Type": "application/json", "Content-Length": 2 },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.write("{}");
    req.end();
  });
}

/** ppidを親に持つffmpegプロセスの数を数える(Linuxの/proc走査。psコマンド非依存)。 */
function countFfmpegChildren(ppid) {
  let count = 0;
  try {
    for (const pidStr of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(pidStr)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${pidStr}/stat`, "utf-8");
        const m = stat.match(/^\d+ \(([^)]*)\) \S (\d+)/);
        if (!m) continue;
        const [, comm, parentPidStr] = m;
        if (Number(parentPidStr) === ppid && comm.includes("ffmpeg")) count++;
      } catch (_) { /* プロセスが既に終了 */ }
    }
  } catch (_) { /* /procが無い環境等 */ }
  return count;
}

function prepareJob(jobId, sample, words, keepText) {
  const workDir = path.join(WORK_ROOT, jobId);
  const outDir = path.join(OUT_ROOT, jobId);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(workDir, "transcript.json"),
    JSON.stringify({ language: "ja", duration: SAMPLE_DURATION_SEC, words, segments: [{ start: 0, end: SAMPLE_DURATION_SEC, text: keepText }] }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(workDir, "state.json"),
    JSON.stringify({ id: jobId, input: sample, orient: "portrait", sub: "on", trim: "none" }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(outDir, "candidates.json"),
    JSON.stringify({
      id: jobId, mode: "topic", generated: 1, digest: null, incomplete: false,
      candidates: [{
        index: 1, file: CLIP_FILE, start: 0, end: SAMPLE_DURATION_SEC, duration: SAMPLE_DURATION_SEC,
        hook: "テスト", confidence: 1, keepText, width: 1080, height: 1920, status: "pending",
      }],
    }),
    "utf-8",
  );
  fs.writeFileSync(path.join(outDir, CLIP_FILE), "dummy-old-clip", "utf-8");
  fs.writeFileSync(path.join(workDir, "job-token.txt"), hashToken(`${jobId}-token`), "utf-8");
  return { workDir, outDir };
}

let server = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-recaption-flood-"));
const jobIds = ["security-recap-flood-1", "security-recap-flood-2", "security-recap-flood-3", "security-recap-flood-4"];
const dupJobId = "security-recap-flood-dup";
try {
  if (!(await ffmpegAvailable())) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }

  const words = [{ w: "テスト", start: 0, end: 1 }];
  const keepText = "テスト";

  // ── P1-13-C: 4ジョブを同時に焼き直し、同時実行ffmpeg数が上限(2)を超えない ──
  const samples = [];
  for (let i = 0; i < jobIds.length; i++) {
    const sample = await makeSample(tmp, i);
    samples.push(sample);
    prepareJob(jobIds[i], sample, words, keepText);
  }
  const dupSample = await makeSample(tmp, "dup");
  prepareJob(dupJobId, dupSample, words, keepText);

  const started = await startServer({ VS_MAX_CONCURRENT_JOBS: String(MAX_CONCURRENT) });
  server = started.child;

  let peakFfmpeg = 0;
  const monitor = setInterval(() => {
    const n = countFfmpegChildren(server.pid);
    if (n > peakFfmpeg) peakFfmpeg = n;
  }, 30);

  const results = await Promise.all(
    jobIds.map((id) => call("POST", `/api/jobs/${id}/recaption?jobToken=${id}-token`)),
  );
  // 全リクエストが終わった後も、ffmpegが後追いで立ち上がる可能性を考慮し少し監視を続ける。
  await new Promise((r) => setTimeout(r, 300));
  clearInterval(monitor);

  report(
    "P1-13-C前提: 4つの異なるジョブへの焼き直しがすべて200で成功する",
    results.every((r) => r.status === 200),
    JSON.stringify(results.map((r) => r.status)),
  );
  // AUD-P2-26: プロセスツリー監視が実際に何も観測できていない(peakFfmpeg==0のまま)場合、
  // 以前の実装ではそれでも「上限を超えていない」という理由でPASS扱いになっていた。
  // それは「監視が機能していない」ことと「上限を守れている」ことを区別できない偽の緑
  // (docs/audits/adversarial-review-2026-08-13.md AUD-P2-26)。監視が実際にffmpeg子プロセスを
  // 最低1つ観測したことを独立した受入事実として先に検証し、これが崩れたら後続の上限チェックも
  // 連動してFAILさせる(スキップではなく明示的な不合格にする)。
  report(
    `P1-13-C前提: 監視が実際に少なくとも1つのffmpeg子プロセスを観測した(実測ピーク=${peakFfmpeg})`,
    peakFfmpeg >= 1,
    `peak=${peakFfmpeg}; 0のままだと監視機構が機能しておらず、上限チェックが何も検証していない(偽の緑の疑い)`,
  );
  report(
    `P1-13-C: 同時に生存するffmpeg子プロセス数が上限(${MAX_CONCURRENT})を超えない(実測ピーク=${peakFfmpeg})`,
    peakFfmpeg >= 1 && peakFfmpeg <= MAX_CONCURRENT,
    `peak=${peakFfmpeg} limit=${MAX_CONCURRENT}`,
  );

  // ── P1-13-D: 同一ジョブへ焼き直しを同時に2回送る ──────────────
  const [dupA, dupB] = await Promise.all([
    call("POST", `/api/jobs/${dupJobId}/recaption?jobToken=${dupJobId}-token`),
    call("POST", `/api/jobs/${dupJobId}/recaption?jobToken=${dupJobId}-token`),
  ]);
  const statuses = [dupA.status, dupB.status].sort();
  report(
    "P1-13-D: 同一ジョブへの同時焼き直しは、片方が200・もう片方が409になる(両方成功しない)",
    JSON.stringify(statuses) === JSON.stringify([200, 409]),
    `statuses=${JSON.stringify([dupA.status, dupB.status])} bodies=${JSON.stringify([dupA.body, dupB.body])}`,
  );

  const dupClipPath = path.join(OUT_ROOT, dupJobId, CLIP_FILE);
  const dupClipStat = fs.existsSync(dupClipPath) ? fs.statSync(dupClipPath) : null;
  report(
    "P1-13-D: 成功した方の焼き直しで、出力クリップが壊れずに置き換わっている(ダミーの旧ファイルではない)",
    !!dupClipStat && dupClipStat.size > 100,
    dupClipStat ? `size=${dupClipStat.size}` : "no file",
  );
  report(
    "P1-13-D: 差し替え後に一時ファイル(.recaption-tmp.mp4)が残っていない",
    !fs.existsSync(`${dupClipPath}.recaption-tmp.mp4`),
  );
} finally {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const id of [...jobIds, dupJobId]) {
    fs.rmSync(path.join(WORK_ROOT, id), { recursive: true, force: true });
    fs.rmSync(path.join(OUT_ROOT, id), { recursive: true, force: true });
  }
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
