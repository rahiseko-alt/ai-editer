// AIの字幕点検(stage c)が失敗したら、ジョブ全体が失敗として終わり、後続の区間選定・
// レンダリングへ進まないことの検証 — roadmap葉 G-EDIT-CAPTION-AI-F2
//
// 【なぜ実サーバーで確かめるか】server/pipeline-runner.mjs の runJob() は関数を直接呼べば
// 「stage c が例外を投げたら catch されてジョブが error になる」ことは読み取れるが、それは
// 実装を読んだ結果の推測にすぎない。実際に POST /api/jobs → SSE 進捗という本番と同じ経路を
// 実プロセス2本（サーバー本体・偽 claude）で通し、(a) 進捗が event: error で終わること、
// (b) 区間選定の成果物(llm-response.json)とクリップが1本も作られていないこと、を実測する。
// 対照として、正しく返す偽 claude では同じ手順が event: done まで進み、区間選定の成果物と
// クリップが実際に作られることを確認する（「常に失敗するテスト」で緑を偽装しないため）。
//
// 【文字起こしをどう「済み」にするか】本物の src/transcribe.py は faster-whisper で実際に
// 音声認識するため重く、認識結果が版でぶれると下流の判定が不安定になる。この葉が見たいのは
// 「文字起こしが終わったジョブに対して AI 点検が失敗したら止まるか」であって文字起こしの精度
// ではないので、PATH の python を tests/helpers/fake-transcribe-main.mjs（固定・データ駆動）へ
// 差し替え、既知の transcript.json を即座に書き出させる。claude 側も同じ理由で
// tests/helpers/fake-claude-main.mjs（ai-caption-fix-check.mjs と共通）に差し替える。
//
// 実行: node tests/caption-ai-fail-halts-job-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runFfmpeg } from "../src/render-vertical.mjs";
import { installFakeClaude } from "./helpers/fake-claude-main.mjs";
import { CONFIG_FILE as FAKE_PYTHON_CONFIG_FILE } from "./helpers/fake-transcribe-main.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const FAKE_PYTHON_MAIN = path.join(HERE, "helpers", "fake-transcribe-main.mjs");
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");
const PORT = 59193; // このテスト専用の固定ポート

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

// ── 実機 ffmpeg で最小の16:9素材を毎回合成する（*.mp4はコミットしない方針） ──
function ffmpegAvailable() {
  return new Promise((res) => {
    const p = spawn("ffmpeg", ["-version"], { windowsHide: true });
    p.on("error", () => res(false));
    p.on("close", (c) => res(c === 0));
  });
}

const SAMPLE_DURATION_SEC = 10;
async function makeSample(dir) {
  const out = path.join(dir, "sample-16x9.mp4");
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

// ── 「文字起こし済み」を模す固定 transcript.json ──────────────────
// AI字幕点検(stage c)のプロンプトに渡る語であり、区間選定(stage s)の keepText 照合にも
// 同じ文字列を使う。時刻は synthesizeした素材の尺(10秒)に収まるようにする。
const WORDS = [
  { w: "こんにちは", start: 0.0, end: 1.0 },
  { w: "今日は", start: 1.0, end: 2.0 },
  { w: "晴れです", start: 2.0, end: 6.0 },
];
const SEG_TEXT = WORDS.map((w) => w.w).join("");
const TRANSCRIPT = {
  language: "ja",
  duration: SAMPLE_DURATION_SEC,
  words: WORDS,
  segments: [{ start: 0.0, end: 6.0, text: SEG_TEXT }],
};

// ── 偽 python(transcribe.py 差し替え) / 偽 claude を PATH に置く ─────
function installFakePython(label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `vs-fake-python-${label}-`));
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, "python");
  fs.copyFileSync(FAKE_PYTHON_MAIN, exe);
  fs.chmodSync(exe, 0o755);
  fs.writeFileSync(path.join(binDir, "package.json"), '{"type":"module"}\n', "utf-8");
  fs.writeFileSync(
    path.join(binDir, FAKE_PYTHON_CONFIG_FILE),
    JSON.stringify({ transcript: TRANSCRIPT }),
    "utf-8",
  );
  return { binDir };
}

// installFakeClaude は tests/helpers/fake-claude-main.mjs 側の共通実装を使う
// （ai-caption-fix-check.mjs / recaption-human-vs-ai-check.mjs と同じ設置手順の重複を避ける）。

/** 常に失敗する偽 claude（F2 本体: AI点検そのものが落ちる場面）。 */
const ALWAYS_FAIL_CLAUDE = { kind: "fail", exit: 1, stderr: "boom: fake claude always fails\n" };

/** 正しく答える偽 claude（対照: stage c も stage s も、呼ばれたプロンプトの文言で答え分ける）。 */
const ALWAYS_OK_CLAUDE = {
  kind: "route",
  rules: [
    { needle: "文字起こしを校正する人", answer: JSON.stringify({ fixes: [] }) },
    {
      needle: "区間に切り分ける編集者",
      answer: JSON.stringify({
        segments: [{ keepText: SEG_TEXT, hook: "テスト", reason: "てすと" }],
      }),
    },
  ],
  fallback: JSON.stringify({ fixes: [] }),
};

// ── サーバープロセスの起動・停止 ─────────────────────────────
function startServer(extraPathDirs) {
  return new Promise((resolve, reject) => {
    const PATH = [...extraPathDirs, process.env.PATH].join(path.delimiter);
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), PATH },
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

// ── HTTP 呼び出し ─────────────────────────────────────────────
function postJob(token, samplePath) {
  const buf = fs.readFileSync(samplePath);
  const q = new URLSearchParams({
    token, sub: "none", cut: "topic", size: "9:16", name: "sample.mp4",
  }).toString();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: `/api/jobs?${q}`, method: "POST",
      headers: {
        host: `127.0.0.1:${PORT}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": buf.length,
      },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

/** SSE を接続したまま、サーバーが event:error / event:done で接続を閉じるまで読み切る。 */
function collectEvents(jobId, jobToken, timeoutMs) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    let timer;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const req = http.get({
      host: "127.0.0.1", port: PORT,
      path: `/api/jobs/${jobId}/events?jobToken=${jobToken}`,
      headers: { host: `127.0.0.1:${PORT}` },
    }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => settle(resolve, { status: res.statusCode, body }));
    });
    req.on("error", (e) => settle(reject, e));
    timer = setTimeout(() => {
      req.destroy();
      settle(reject, new Error(`SSEが${timeoutMs}msで終わらなかった（最後まで読めた分）: ${body.slice(-500)}`));
    }, timeoutMs);
  });
}

function getCandidates(jobId, jobToken) {
  return new Promise((resolve, reject) => {
    http.get({
      host: "127.0.0.1", port: PORT,
      path: `/api/jobs/${jobId}/candidates?jobToken=${jobToken}`,
      headers: { host: `127.0.0.1:${PORT}` },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

// ── 本体 ────────────────────────────────────────────────────
const createdJobIds = [];
let server = null;

async function runScenario(label, claudeBehavior, { expectDone }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `vs-caption-ai-f2-${label}-`));
  const sample = await makeSample(tmp);
  const fakePython = installFakePython(label);
  const fakeClaude = installFakeClaude(label, claudeBehavior);

  const started = await startServer([fakeClaude.binDir, fakePython.binDir]);
  server = started.child;
  try {
    const posted = await postJob(started.token, sample);
    report(`${label}: POST /api/jobs が受理される(202)`, posted.status === 202, `status=${posted.status} ${posted.body}`);
    const { jobId, jobToken } = JSON.parse(posted.body);
    assert.ok(jobId && jobToken, `${label}: jobId/jobTokenが返っていない: ${posted.body}`);
    createdJobIds.push(jobId);

    const workDir = path.join(WORK_ROOT, jobId);
    const outDir = path.join(OUT_ROOT, jobId);

    const events = await collectEvents(jobId, jobToken, expectDone ? 90_000 : 30_000);
    const gotError = /event:\s*error/.test(events.body);
    const gotDone = /event:\s*done/.test(events.body);

    if (expectDone) {
      report(`${label}: 正しく答える偽claudeでは進捗がevent: doneで終わる`, gotDone && !gotError,
        `body末尾=${events.body.slice(-300)}`);

      const respPath = path.join(workDir, "llm-response.json");
      report(`${label}: 区間選定の成果物(llm-response.json)が作られている`, fs.existsSync(respPath));

      const cand = await getCandidates(jobId, jobToken);
      report(`${label}: candidates.jsonが200で読める`, cand.status === 200, `status=${cand.status}`);
      const candBody = cand.status === 200 ? JSON.parse(cand.body) : { generated: 0, candidates: [] };
      report(`${label}: 候補が1件以上生成されている`, candBody.generated >= 1 && candBody.candidates.length >= 1,
        JSON.stringify(candBody));
      if (candBody.candidates?.[0]) {
        const clipPath = path.join(outDir, candBody.candidates[0].file);
        report(`${label}: クリップの実ファイルが生成されている`,
          fs.existsSync(clipPath) && fs.statSync(clipPath).size > 0, clipPath);
      }
    } else {
      report(`${label}: 必ず失敗する偽claudeでは進捗がevent: errorで終わる（doneに到達しない）`,
        gotError && !gotDone, `body末尾=${events.body.slice(-300)}`);

      const respPath = path.join(workDir, "llm-response.json");
      report(`${label}: 区間選定の成果物(llm-response.json)が1つも作られていない`, !fs.existsSync(respPath));

      const candPath = path.join(outDir, "candidates.json");
      report(`${label}: candidates.jsonが作られていない`, !fs.existsSync(candPath));

      const clipFiles = fs.existsSync(outDir)
        ? fs.readdirSync(outDir).filter((f) => f.endsWith(".mp4"))
        : [];
      report(`${label}: クリップ(.mp4)が1本も作られていない`, clipFiles.length === 0, JSON.stringify(clipFiles));

      // 「たまたま何かの理由で失敗した」ではなく、偽claudeが実際に呼ばれたうえでの失敗であることを示す
      // （呼ばれてすらいなければ、この検査は「何を壊しても落ちる」だけの空振りになる）。
      report(`${label}: 偽claudeが実際に少なくとも1回呼ばれている（AI点検の失敗経由であることの裏付け）`,
        fakeClaude.calls().length >= 1);
    }
  } finally {
    await stopServer(server);
    server = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (!(await ffmpegAvailable())) {
  console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
  process.exit(1);
}

try {
  // ── F2 本体: 必ず失敗する偽claude → ジョブは失敗として終わり、後続工程の成果物が無い ──
  await runScenario("fail", ALWAYS_FAIL_CLAUDE, { expectDone: false });

  // ── 対照: 正しく答える偽claude → 同じ手順で最後まで進み、成果物が実際に作られる ──
  await runScenario("ok", ALWAYS_OK_CLAUDE, { expectDone: true });
} finally {
  await stopServer(server);
  for (const id of createdJobIds) {
    fs.rmSync(path.join(WORK_ROOT, id), { recursive: true, force: true });
    fs.rmSync(path.join(OUT_ROOT, id), { recursive: true, force: true });
  }
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
