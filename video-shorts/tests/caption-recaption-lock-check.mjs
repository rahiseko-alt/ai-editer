// 焼き直し(recaption)実行中の字幕保存が黙って握りつぶされないことの検証 — AUD-P1-12
//
// recaptionStage() は開始時に caption-edits.json を1回だけ読み(=直しをスナップショット)、
// そのまま動画へ焼き込む。旧実装は焼き直し実行中でも PUT /api/jobs/:id/captions を通常どおり
// 200で受理していたため、保存自体は成功したように見えるのに、実行中の焼き直しは古い
// スナップショットのまま完了し、保存した直しが黙って握りつぶされていた(利用者は「保存した
// つもり」のまま気づけない)。
//
// 採った対策(監査の「簡易な対策」ルート): 焼き直し実行中の PUT を409で明確に拒否する
// (server/index.mjs handlePutCaptions + pipeline-runner.mjs isRecaptioning)。
// あわせて webapp-mockup/app.js は焼き直し中、字幕入力欄へ disabled を付けて編集をロックする。
//
// 実行: node tests/caption-recaption-lock-check.mjs   (全PASSで exit 0)

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
const PORT = 59207; // このテスト専用の固定ポート
const JOB_ID = "caption-recap-lock-check-job";
const CLIP_FILE = "clip-1.mp4";
const SAMPLE_DURATION_SEC = 4; // 焼き直し(ffmpeg)に、PUTを競合させるための実行時間を確保する

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

async function makeSample(dir) {
  const out = path.join(dir, "sample.mp4");
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

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), ...env },
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

function call(method, pathAndQuery, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: pathAndQuery, method, timeout: 30_000,
      headers: {
        host: `127.0.0.1:${PORT}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function prepareJob(sample) {
  const workDir = path.join(WORK_ROOT, JOB_ID);
  const outDir = path.join(OUT_ROOT, JOB_ID);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const words = [
    { w: "もと", start: 0, end: 1 },
    { w: "のじまく", start: 1, end: 2 },
  ];
  fs.writeFileSync(
    path.join(workDir, "transcript.json"),
    JSON.stringify({ language: "ja", duration: SAMPLE_DURATION_SEC, words, segments: [{ start: 0, end: SAMPLE_DURATION_SEC, text: "もとのじまく" }] }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(workDir, "state.json"),
    JSON.stringify({ id: JOB_ID, input: sample, orient: "portrait", sub: "on", trim: "none" }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(outDir, "candidates.json"),
    JSON.stringify({
      id: JOB_ID, mode: "topic", generated: 1, digest: null, incomplete: false,
      candidates: [{
        index: 1, file: CLIP_FILE, start: 0, end: SAMPLE_DURATION_SEC, duration: SAMPLE_DURATION_SEC,
        hook: "テスト", confidence: 1, keepText: "もとのじまく", width: 1080, height: 1920, status: "pending",
      }],
    }),
    "utf-8",
  );
  fs.writeFileSync(path.join(outDir, CLIP_FILE), "dummy-old-clip", "utf-8");
  fs.writeFileSync(path.join(workDir, "job-token.txt"), hashToken(`${JOB_ID}-token`), "utf-8");
  return { workDir, outDir };
}

function getCaptions(jobToken) {
  return call("GET", `/api/jobs/${JOB_ID}/captions?jobToken=${jobToken}`);
}

let server = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-caption-recap-lock-"));
try {
  if (!(await ffmpegAvailable())) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }

  const sample = await makeSample(tmp);
  const { workDir } = prepareJob(sample);
  const jobToken = `${JOB_ID}-token`;

  const started = await startServer({});
  server = started.child;

  // ── 前提: 焼き直し前は通常どおり字幕を保存できる ────────────────────
  const preEdit = await call("PUT", `/api/jobs/${JOB_ID}/captions?jobToken=${jobToken}`, { index: 0, text: "before-recap" });
  report("前提: 焼き直し開始前のPUTは200で保存できる", preEdit.status === 200, `status=${preEdit.status} body=${preEdit.body}`);

  // ── 焼き直しを開始する(await しない。実行中に競合PUTを送るため) ─────────
  const recapPromise = call("POST", `/api/jobs/${JOB_ID}/recaption?jobToken=${jobToken}`);

  // beginRecaption()はPOSTハンドラの最初(await前)で同期的に呼ばれるため、ごく短い遅延の後には
  // 確実に「焼き直し中」状態になっている。ffmpegの実処理(4秒素材)はまだ終わっていない。
  await new Promise((r) => setTimeout(r, 200));

  // ── AUD-P1-12: 焼き直し実行中のPUTは409で拒否される ────────────────
  const racingPut = await call("PUT", `/api/jobs/${JOB_ID}/captions?jobToken=${jobToken}`, { index: 1, text: "STALE-WOULD-BE-BURNED" });
  report(
    "AUD-P1-12: 焼き直し実行中に送ったPUTは409で拒否される(黙って握りつぶされない)",
    racingPut.status === 409,
    `status=${racingPut.status} body=${racingPut.body}`
  );
  report(
    "AUD-P1-12: 409のレスポンスに理由が書かれている(黙って失敗ではなく明確なエラー)",
    JSON.parse(racingPut.body || "{}").error?.length > 0,
    racingPut.body
  );

  // ── 拒否されたPUTの内容が実際に保存されていないことを確認する(サイレント破棄ではない) ──
  const capsAfterRace = await getCaptions(jobToken);
  const w1 = JSON.parse(capsAfterRace.body).words.find((w) => w.index === 1);
  report(
    "AUD-P1-12: 拒否されたPUTの内容(STALE-WOULD-BE-BURNED)は実際には保存されていない",
    w1 && w1.w !== "STALE-WOULD-BE-BURNED",
    JSON.stringify(w1)
  );

  // ── 焼き直しの完了を待つ ───────────────────────────────────────
  const recapResult = await recapPromise;
  report("前提: 焼き直し自体は正常に完了する(200)", recapResult.status === 200, `status=${recapResult.status} body=${recapResult.body}`);

  // ── 焼き直し完了後は、通常どおりPUTが受理される(ロックが恒久化していない) ──
  const postEdit = await call("PUT", `/api/jobs/${JOB_ID}/captions?jobToken=${jobToken}`, { index: 1, text: "after-recap-ok" });
  report(
    "AUD-P1-12事後: 焼き直しが終わればPUTは通常どおり200で受理される(ロックが焼き直し後まで残らない)",
    postEdit.status === 200,
    `status=${postEdit.status} body=${postEdit.body}`
  );
  const capsAfter = await getCaptions(jobToken);
  const w1After = JSON.parse(capsAfter.body).words.find((w) => w.index === 1);
  report(
    "AUD-P1-12事後: 焼き直し後のPUTは実際に保存される",
    w1After && w1After.w === "after-recap-ok",
    JSON.stringify(w1After)
  );

  void workDir;
} finally {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.join(WORK_ROOT, JOB_ID), { recursive: true, force: true });
  fs.rmSync(path.join(OUT_ROOT, JOB_ID), { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
