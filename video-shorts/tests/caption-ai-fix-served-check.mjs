// AI字幕点検(stage c)の結果が、実際に焼き込みに使う字幕ファイル(.ass)へ載ることの検証
// — roadmap葉 G-EDIT-CAPTION-AI-K1
//
// 【なぜ実サーバーで確かめるか】aiCaptionFixStage が transcript.json を書き換えることは
// tests/ai-caption-fix-check.mjs（関数を直接呼ぶ単体検査）で確かめてあるが、それだけでは
// 「サーバでジョブを処理したとき、直った文字が実際に区間選定・レンダリングへ渡り、
// 焼き込みに使う .ass に反映されるか」までは分からない。POST /api/jobs → SSE 進捗という
// 本番と同じ経路を実プロセス2本（サーバー本体・偽 claude）で通し、
// (a) work/<id>/ai-caption-fixes.json の中身、(b) 焼き込みに使われた work/<id>/clip-1.ass の
// 中身を実測する。対照として、直し0件を返す偽 claude では同じ .ass に「以上」が残ることを
// 確認する（AI を呼ばずに空の一覧を書くだけの工程でも合格しないようにするため）。
//
// 【固定素材】tests/fixtures/ai-caption-fix/transcript-miswritten.json（SHA-256 fcea22…、98語）を
// そのまま transcript.json として使う。G-EDIT-CAPTION-AI-A/A2/A3/D2/I/J と同じ凍結素材で、
// 添字13「以上」→「異常」に直す1件を使う（親ノード detail の凍結どおり）。
//
// 【文字起こし・claudeの差し替え】caption-ai-fail-halts-job-check.mjs と同じ理由で、
// PATH の python を tests/helpers/fake-transcribe-main.mjs へ、claude を
// tests/helpers/fake-claude-main.mjs へ差し替える。
//
// 実行: node tests/caption-ai-fix-served-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import crypto from "node:crypto";
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
const FIXTURE_PATH = path.join(HERE, "fixtures", "ai-caption-fix", "transcript-miswritten.json");
const FIXTURE_SHA256 = "fcea227fe0435d449152f782f80883f3dd726380d8ba39ff454c9c813fbaa775";
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");
const PORT = 59194; // このテスト専用の固定ポート（caption-ai-fail-halts-job-check.mjs の 59193 と別）

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

// ── 固定素材（AI-A/A2/A3/D2/I/J と同じ）をそのまま使う ─────────────
const FIXTURE_TEXT = fs.readFileSync(FIXTURE_PATH, "utf-8");
const FIXTURE_SHA_ACTUAL = crypto.createHash("sha256").update(FIXTURE_TEXT).digest("hex");
const TRANSCRIPT = JSON.parse(FIXTURE_TEXT);
const SAMPLE_DURATION_SEC = Math.ceil(TRANSCRIPT.duration) + 2; // 全語を覆う長さ + 余裕

const FIX_INDEX = 13;
const FIX_BEFORE = "以上";
const FIX_AFTER = "異常";
assert.strictEqual(TRANSCRIPT.words[FIX_INDEX].w, FIX_BEFORE, "fixtureの添字13が想定と違う（写し間違い検出）");

// 添字13を含む段落（segments[1]）の、直す前後それぞれの文章。stage sのkeepTextに使う
// （区間選定は直った文章を読むはずなので、シナリオごとに正しい方を渡す必要がある）。
const SEGMENT_BEFORE_TEXT = TRANSCRIPT.segments[1].text;
const SEGMENT_AFTER_TEXT = SEGMENT_BEFORE_TEXT.replace(FIX_BEFORE, FIX_AFTER);
assert.ok(
  SEGMENT_BEFORE_TEXT.includes(FIX_BEFORE) && SEGMENT_AFTER_TEXT.includes(FIX_AFTER),
  "fixtureのsegments[1]が想定の文言と違う"
);

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

// ── 偽 python(transcribe.py 差し替え) を PATH に置く ────────────────
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

// installFakeClaude は tests/helpers/fake-claude-main.mjs 側の共通実装を使う。

/**
 * 偽 claude の振る舞いを組み立てる。stage c(校正)と stage s(区間選定)の両方の
 * プロンプトに、文言で答え分ける（呼ばれた順・回数に依らない）。
 * @param {number} fixCount 0 なら「直し無し」、1 なら添字13を直す。
 */
function buildClaudeBehavior(fixCount) {
  const fixesAnswer = fixCount === 1
    ? JSON.stringify({ fixes: [{ index: FIX_INDEX, before: FIX_BEFORE, after: FIX_AFTER }] })
    : JSON.stringify({ fixes: [] });
  // 区間選定が読むのは直った(または直っていない)段落の文章なので、シナリオに応じて渡す
  // keepText を変える（不一致だと逆マッチングが失敗し、後続の検証ができなくなるため）。
  const keepText = fixCount === 1 ? SEGMENT_AFTER_TEXT : SEGMENT_BEFORE_TEXT;
  return {
    kind: "route",
    rules: [
      { needle: "文字起こしを校正する人", answer: fixesAnswer },
      // 2026-08-16: 「間を詰める」の判断工程が増えた。この検査は詰める設定を使わないので
      // 実際には来ないが、来たときに黙って失敗しないよう答えを用意しておく。
      { needle: "話し言葉を編集する人", answer: JSON.stringify({ fillers: [], cutGaps: [] }) },
      {
        needle: "区間に切り分ける編集者",
        answer: JSON.stringify({
          segments: [{ keepText, hook: "健康診断", reason: "テスト用の代表区間" }],
        }),
      },
    ],
    fallback: JSON.stringify({ fixes: [] }),
  };
}

// ── サーバープロセスの起動・停止（caption-ai-fail-halts-job-check.mjs と同じ作法） ──
function startServer(extraPathDirs) {
  return new Promise((resolve, reject) => {
    const PATH = [...extraPathDirs, process.env.PATH].join(path.delimiter);
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), PATH },
    });
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server起動タイムアウト")), 30000);
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
    token, sub: "on", cut: "topic", size: "9:16", name: "sample.mp4",
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

/** SSE を接続したまま、サーバーが event:job-error / event:done で接続を閉じるまで読み切る。 */
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

async function runScenario(label, fixCount, { expectFixApplied }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `vs-caption-ai-k1-${label}-`));
  const sample = await makeSample(tmp);
  const fakePython = installFakePython(label);
  const fakeClaude = installFakeClaude(label, buildClaudeBehavior(fixCount));

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

    const events = await collectEvents(jobId, jobToken, 90_000);
    const gotDone = /event:\s*done/.test(events.body);
    report(`${label}: 進捗がevent: doneまで進む`, gotDone, `body末尾=${events.body.slice(-300)}`);

    // (a) work/<id>/ai-caption-fixes.json の中身
    const fixesPath = path.join(workDir, "ai-caption-fixes.json");
    report(`${label}: ai-caption-fixes.jsonが残っている`, fs.existsSync(fixesPath));
    const fixesBody = fs.existsSync(fixesPath)
      ? JSON.parse(fs.readFileSync(fixesPath, "utf-8"))
      : { fixes: [] };
    if (expectFixApplied) {
      report(
        `${label}: ai-caption-fixes.jsonに添字13の直しが1件残っている`,
        fixesBody.fixes.length === 1
          && fixesBody.fixes[0].index === FIX_INDEX
          && fixesBody.fixes[0].before === FIX_BEFORE
          && fixesBody.fixes[0].after === FIX_AFTER,
        JSON.stringify(fixesBody)
      );
    } else {
      report(`${label}: ai-caption-fixes.jsonは0件のまま`, fixesBody.fixes.length === 0, JSON.stringify(fixesBody));
    }

    const cand = await getCandidates(jobId, jobToken);
    report(`${label}: candidates.jsonが200で読める`, cand.status === 200, `status=${cand.status}`);
    const candBody = cand.status === 200 ? JSON.parse(cand.body) : { generated: 0, candidates: [] };
    report(
      `${label}: 候補が1件以上生成されている`,
      candBody.generated >= 1 && candBody.candidates.length >= 1,
      JSON.stringify(candBody)
    );

    // (b) 焼き込みに使われた .ass の中身（work/<id>/clip-1.ass。pipeline.mjs cmdRender が
    // renderSegment へ渡す subtitle.path そのもので、renderClip の ass= フィルタに直接渡る）。
    const assPath = path.join(workDir, "clip-1.ass");
    report(`${label}: 焼き込みに使うclip-1.assが残っている`, fs.existsSync(assPath));
    const assText = fs.existsSync(assPath) ? fs.readFileSync(assPath, "utf-8") : "";
    if (expectFixApplied) {
      report(`${label}: .assに「${FIX_AFTER}」が入っている`, assText.includes(FIX_AFTER), assText.slice(0, 500));
      report(`${label}: .assの該当箇所に「${FIX_BEFORE}」が残っていない`, !assText.includes(FIX_BEFORE), assText.slice(0, 500));
    } else {
      report(
        `${label}: .assに「${FIX_BEFORE}」が残っている（AIを呼んでも直さなければ何も変わらないことの対照）`,
        assText.includes(FIX_BEFORE),
        assText.slice(0, 500)
      );
      report(`${label}: .assに「${FIX_AFTER}」は入っていない`, !assText.includes(FIX_AFTER), assText.slice(0, 500));
    }

    if (candBody.candidates?.[0]) {
      const clipPath = path.join(outDir, candBody.candidates[0].file);
      report(
        `${label}: クリップの実ファイルが生成されている`,
        fs.existsSync(clipPath) && fs.statSync(clipPath).size > 0,
        clipPath
      );
    }

    // 偽claudeが実際に呼ばれたうえでの結果であることの裏付け（呼ばれてすらいなければ空振り）。
    report(`${label}: 偽claudeが実際に呼ばれている`, fakeClaude.calls().length >= 1);
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

report(
  "素材: fixtureのSHA-256が凍結値と一致している（差し替え検出）",
  FIXTURE_SHA_ACTUAL === FIXTURE_SHA256,
  `actual=${FIXTURE_SHA_ACTUAL}`
);

try {
  // ── K1本体: 添字13を直す偽claude → ai-caption-fixes.jsonに1件・.assに「異常」 ──
  await runScenario("fix", 1, { expectFixApplied: true });

  // ── 対照: 直し0件を返す偽claude → ai-caption-fixes.jsonは0件・.assは「以上」のまま ──
  await runScenario("nofix", 0, { expectFixApplied: false });
} finally {
  await stopServer(server);
  for (const id of createdJobIds) {
    fs.rmSync(path.join(WORK_ROOT, id), { recursive: true, force: true });
    fs.rmSync(path.join(OUT_ROOT, id), { recursive: true, force: true });
  }
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
