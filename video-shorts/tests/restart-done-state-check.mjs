// 再起動しても完了ジョブが interrupted 化けしないことの検証 — AUD-P2-16
//
// 旧実装は2つの独立した欠陥を持っていた:
//   (a) job.stage="done" になっても、それはメモリ(jobs Map)だけの話で state.json は
//       最後に書いたステージ(rendered/mosaicked)のまま止まっていた(doneが永続化されない)。
//   (b) `node pipeline.mjs select/render` という別プロセスが state.json へ書き足す
//       フィールド(chunks/candidates等)を、pipeline-runner.mjs 自身が持つ「起動時のまま
//       古いインメモリのstateオブジェクト」で丸ごと上書きし、消してしまっていた。
//   (c) subscribeJob() は、jobs Map に無いjobId(=このプロセスは一度も起動していない/
//       再起動後)を、state.jsonの中身を見ずに無条件で"interrupted"として扱っていた。
// 結果として、実際にはレンダリングまで完走していたジョブへ再起動後に再接続すると、
// 「中断されました」という誤った案内が出ていた。
//
// このテストは実サーバー2プロセス(再起動前後)・実ffmpegレンダリングを使い、
//   ①ジョブが実際にrendered→doneまで完走すること(2候補)
//   ②state.jsonのstageが実際に"done"まで書かれること(doneの永続化)
//   ③state.jsonに、子プロセス(node pipeline.mjs select/render)だけが書けるフィールド
//     (chunks・candidates)が、pipeline-runner.mjs自身の書き込みで消えずに残っていること
//     (クロバー修正の直接証拠)
//   ④再起動後の同じjobIdへのSSE再接続が、interruptedではなくdoneイベントを返すこと
// を実測する。
//
// 実行: node tests/restart-done-state-check.mjs   (全PASSで exit 0)

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
const PORT = 59210; // このテスト専用の固定ポート

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

const SAMPLE_DURATION_SEC = 400; // 2区間(各190秒)+区間間ギャップ+余韻パディングを収める長さ
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

// 2つの独立した区間を持つ文字起こし。claudeへ2候補を選ばせるための材料。
// pipeline.mjs の topic モードは既定 TOPIC_MIN_SEC=180秒 未満の区間を隣接区間と結合する
// (src/snap-boundaries.mjs mergeShortSegments)。この結合はサーバー側のchild-process env
// allowlist(P1-14-A)の対象外であるTOPIC_MIN_SEC等のenv経由では回避できない
// (server/pipeline-runner.mjs buildChildEnv が秘密情報以外の任意env変数を子プロセスへ
// 通さない設計のため・意図的な制限)。そのため、このテストは既定値どおりの実運用条件で
// 「2候補のまま結合されない」ことを再現するよう、各区間を180秒以上・区間間のギャップを
// 既定の結合上限(3秒)より大きく取る(=env上書きに頼らず、本物の既定動作のまま2候補になる
// 入力を用意する)。
const SEG1_START = 0, SEG1_MID = 95, SEG1_END = 190;
const SEG2_START = 200, SEG2_MID = 295, SEG2_END = 390;
const WORDS = [
  { w: "こんにちは", start: SEG1_START, end: SEG1_START + 1 },
  { w: "今日は", start: SEG1_MID, end: SEG1_MID + 1 },
  { w: "晴れです", start: SEG1_END - 1, end: SEG1_END },
  { w: "次は", start: SEG2_START, end: SEG2_START + 1 },
  { w: "雨です", start: SEG2_MID, end: SEG2_MID + 1 },
  { w: "明日は曇りです", start: SEG2_END - 1, end: SEG2_END },
];
const SEG1_TEXT = "こんにちは今日は晴れです";
const SEG2_TEXT = "次は雨です明日は曇りです";
const TRANSCRIPT = {
  language: "ja",
  duration: SAMPLE_DURATION_SEC,
  words: WORDS,
  segments: [
    { start: SEG1_START, end: SEG1_END, text: SEG1_TEXT },
    { start: SEG2_START, end: SEG2_END, text: SEG2_TEXT },
  ],
};

function installFakePython() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fake-python-p216-"));
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
  return { binDir, home };
}

// 校正(fixes無し)と、2区間を選ぶ区間選定の両方に答える偽claude。
const OK_CLAUDE = {
  kind: "route",
  rules: [
    { needle: "文字起こしを校正する人", answer: JSON.stringify({ fixes: [] }) },
    // 2026-08-16: 「間を詰める」の判断工程が増えた。この検査は詰める設定を使わないので
    // 実際には来ないが、来たときに黙って失敗しないよう答えを用意しておく。
    { needle: "話し言葉を編集する人", answer: JSON.stringify({ fillers: [], cutGaps: [] }) },
    {
      needle: "区間に切り分ける編集者",
      answer: JSON.stringify({
        segments: [
          { keepText: SEG1_TEXT, hook: "朝の話", reason: "r1" },
          { keepText: SEG2_TEXT, hook: "明日の話", reason: "r2" },
        ],
      }),
    },
  ],
  fallback: JSON.stringify({ fixes: [] }),
};

function startServer(extraPathDirs) {
  return new Promise((resolve, reject) => {
    const PATH = [...extraPathDirs, process.env.PATH].join(path.delimiter);
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), PATH },
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

function postJob(token, sample) {
  const q = new URLSearchParams({ token, sub: "none", cut: "topic", size: "9:16", name: "restart-done-check.mp4" }).toString();
  const buf = fs.readFileSync(sample);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: `/api/jobs?${q}`, method: "POST", timeout: 15000,
      headers: { host: `127.0.0.1:${PORT}`, "Content-Type": "application/octet-stream", "Content-Length": buf.length },
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

function collectEvents(jobId, jobToken, timeoutMs) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    let timer;
    const settle = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
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
    timer = setTimeout(() => { req.destroy(); settle(resolve, { status: 0, body, timedOut: true }); }, timeoutMs);
  });
}

let serverA = null;
let serverB = null;
let createdJobId = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-restart-done-"));
const fakePython = installFakePython();
const fakeClaude = installFakeClaude("p216", OK_CLAUDE);
try {
  if (!(await ffmpegAvailable())) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }

  const sample = await makeSample(tmp);

  const startedA = await startServer([fakeClaude.binDir, fakePython.binDir]);
  serverA = startedA.child;

  const posted = await postJob(startedA.token, sample);
  report("前提: ジョブが受理される(202)", posted.status === 202, `status=${posted.status} ${posted.body}`);
  const { jobId, jobToken } = JSON.parse(posted.body);
  createdJobId = jobId;

  // done まで完走するのを待つ(実ffmpegレンダリングを含むため長めに取る)。
  const events = await collectEvents(jobId, jobToken, 180_000);
  report(
    "①前提: ジョブが実際にdoneまで完走する(SSEにevent: doneが現れる)",
    /event:\s*done/.test(events.body),
    events.body.slice(-500)
  );

  const candPath = path.join(OUT_ROOT, jobId, "candidates.json");
  const cand = fs.existsSync(candPath) ? JSON.parse(fs.readFileSync(candPath, "utf-8")) : null;
  report(
    "①前提: candidates.jsonに2候補が実際に生成されている",
    !!cand && Array.isArray(cand.candidates) && cand.candidates.length === 2,
    cand ? `count=${cand.candidates.length}` : "candidates.json無し"
  );

  const statePath = path.join(WORK_ROOT, jobId, "state.json");
  const stateAfterDone = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  report(
    "②AUD-P2-16: state.jsonのstageが実際に\"done\"まで永続化されている(メモリだけでない)",
    stateAfterDone.stage === "done",
    `stage=${stateAfterDone.stage}`
  );
  report(
    "③AUD-P2-16: state.jsonに子プロセス(node pipeline.mjs select)だけが書けるchunksフィールドが残っている" +
      "(pipeline-runner.mjs自身の以後の書き込みで消えていない＝クロバー修正の直接証拠)",
    typeof stateAfterDone.chunks === "number" && stateAfterDone.chunks > 0,
    `chunks=${JSON.stringify(stateAfterDone.chunks)}`
  );
  report(
    "③AUD-P2-16: state.jsonに子プロセス(node pipeline.mjs render)だけが書けるcandidatesフィールドが" +
      "正しい件数(2)で残っている(pipeline-runner.mjs自身の\"done\"書き込みで消えていない)",
    stateAfterDone.candidates === 2,
    `candidates=${JSON.stringify(stateAfterDone.candidates)}`
  );

  // ── 再起動 ────────────────────────────────────────────────
  await stopServer(serverA);
  serverA = null;

  const startedB = await startServer([fakeClaude.binDir, fakePython.binDir]);
  serverB = startedB.child;

  // 再起動後、このプロセスは jobId を一度も起動していない(jobs Mapは空)。
  // 同じjobToken(永続化されたトークン経由で認可される)で再接続する。
  const eventsAfterRestart = await collectEvents(jobId, jobToken, 10_000);
  report(
    "④AUD-P2-16: 再起動後の再接続で event: interrupted **ではなく** event: done が返る",
    /event:\s*done/.test(eventsAfterRestart.body) && !/event:\s*interrupted/.test(eventsAfterRestart.body),
    `status=${eventsAfterRestart.status} body=${eventsAfterRestart.body.slice(0, 300)}`
  );
} finally {
  await stopServer(serverA);
  await stopServer(serverB);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(fakePython.home, { recursive: true, force: true });
  if (createdJobId) {
    fs.rmSync(path.join(WORK_ROOT, createdJobId), { recursive: true, force: true });
    fs.rmSync(path.join(OUT_ROOT, createdJobId), { recursive: true, force: true });
  }
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
