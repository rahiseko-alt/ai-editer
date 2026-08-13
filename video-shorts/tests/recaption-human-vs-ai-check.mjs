// 焼き直し(recaption)で、AIの直しより人の直しが優先されることの検証 — roadmap葉 G-EDIT-CAPTION-AI-L2
//
// 【なぜ本番の経路を通すか】既存の G-EDIT-CAPTION-AI-L は caption-store.mjs の
// readEdits/applyEdits を直接呼ぶだけで、本番の焼き直し経路(src/recaption-stage.mjs、
// および実HTTPの POST /api/jobs/:id/recaption)を一度も通していなかった（roadmap detail 参照）。
// 「関数を差し替えれば通る」検査は、本番の結線（recaption-stage.mjs が実際に caption-edits.json
// と transcript.json をどう重ねるか）が壊れていても緑のままになりうる。そこでこの検査は、
// (1) 実際に AI 字幕直し工程(aiCaptionFixStage)を走らせて transcript.json をAI直し済みにし、
// (2) 実サーバーへ PUT /api/jobs/:id/captions で人の直しを重ね、
// (3) 実サーバーへ POST /api/jobs/:id/recaption で焼き直しを実行し、
// (4) 生成された .ass の中身と、置き換わった出力クリップそのものを読んで確かめる。
//
// 【語の選び方】4語のうち、
//   0: どちらも触らない語（アルファ）→ そのまま残る対照
//   1: AIが直し、さらに人が直す語（ベータ→ガンマ→デルタ）→ 人の文字(デルタ)が勝つ
//   2: AIが直すが人は触れない語（イプシロン→ゼータ）→ AIの文字(ゼータ)のまま焼かれる
//   3: どちらも触らない語（オメガ）→ そのまま残る対照
// いずれも他の語と共通の文字列を持たないカタカナ語にし、.ass の中身を単純な文字列包含で
// 判定できるようにする（部分一致による誤検出を避ける）。
//
// 実行: node tests/recaption-human-vs-ai-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runFfmpeg } from "../src/render-vertical.mjs";
import { aiCaptionFixStage, createDefaultRunModel } from "../src/ai-caption-fix.mjs";
import { installFakeClaude } from "./helpers/fake-claude-main.mjs";
import { hashToken } from "../server/security.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");
const PORT = 59195; // このテスト専用の固定ポート
const JOB_ID = "recaption-human-vs-ai-check-job";
const WORK_DIR = path.join(WORK_ROOT, JOB_ID);
const OUT_DIR = path.join(OUT_ROOT, JOB_ID);
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

const SAMPLE_DURATION_SEC = 8;
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

// ── 直す前の語。0/3は誰も触らない対照、1はAI→人、2はAIのみ。 ──────
const ORIGINAL_WORDS = [
  { w: "アルファ", start: 0.0, end: 1.0 },
  { w: "ベータ", start: 1.0, end: 2.0 },
  { w: "イプシロン", start: 2.0, end: 3.0 },
  { w: "オメガ", start: 3.0, end: 4.0 },
];
const AI_FIX_1 = "ガンマ";   // AIが index1 を直す先
const AI_FIX_2 = "ゼータ";   // AIが index2 を直す先
const HUMAN_FIX_1 = "デルタ"; // 人が index1 をさらに直す先（AIの直しに勝つはず）

// installFakeClaude は tests/helpers/fake-claude-main.mjs 側の共通実装を使う
// （ai-caption-fix-check.mjs / caption-ai-fail-halts-job-check.mjs と同じ設置手順の重複を避ける）。

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

function call(method, pathAndQuery, { body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf-8");
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: pathAndQuery, method, timeout: 30_000,
      headers: {
        host: `127.0.0.1:${PORT}`,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
      },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let server = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-recaption-l2-"));
try {
  if (!(await ffmpegAvailable())) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }

  // ── 準備: 実素材・実workDir ──────────────────────────────────
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const sample = await makeSample(tmp);

  fs.writeFileSync(
    path.join(WORK_DIR, "transcript.json"),
    JSON.stringify({
      language: "ja",
      duration: SAMPLE_DURATION_SEC,
      words: ORIGINAL_WORDS,
      segments: [{ start: 0.0, end: 4.0, text: ORIGINAL_WORDS.map((w) => w.w).join("") }],
    }, null, 2),
    "utf-8",
  );

  // ── (1) 実際にAI字幕直し工程を走らせ、transcript.jsonを「AI直し済み」にする ──────
  const fakeClaude = installFakeClaude("l2", {
    kind: "fixed",
    answer: JSON.stringify({
      fixes: [
        { index: 1, before: "ベータ", after: AI_FIX_1 },
        { index: 2, before: "イプシロン", after: AI_FIX_2 },
      ],
    }),
  });
  const origPath = process.env.PATH;
  process.env.PATH = `${fakeClaude.binDir}${path.delimiter}${origPath}`;
  let aiResult;
  try {
    aiResult = await aiCaptionFixStage({
      workDir: WORK_DIR,
      runModel: createDefaultRunModel(WORK_DIR),
    });
  } finally {
    process.env.PATH = origPath;
  }
  report("前提: AI字幕直し工程が2語を実際に直した", aiResult.fixed === 2, JSON.stringify(aiResult));
  const afterAiFix = JSON.parse(fs.readFileSync(path.join(WORK_DIR, "transcript.json"), "utf-8"));
  report("前提: transcript.jsonがAI直し済み(ガンマ/ゼータ)になっている",
    afterAiFix.words[1].w === AI_FIX_1 && afterAiFix.words[2].w === AI_FIX_2,
    JSON.stringify(afterAiFix.words));

  // state.json（recaptionStageが読む素材の場所・向き）
  fs.writeFileSync(
    path.join(WORK_DIR, "state.json"),
    JSON.stringify({ id: JOB_ID, input: sample, orient: "portrait", sub: "on", trim: "none" }, null, 2),
    "utf-8",
  );

  // candidates.json（1クリップ・全区間をカバー）と、置き換わる前のダミー旧クリップ。
  fs.writeFileSync(
    path.join(OUT_DIR, "candidates.json"),
    JSON.stringify({
      id: JOB_ID, mode: "topic", generated: 1, digest: null, incomplete: false,
      candidates: [{
        index: 1, file: CLIP_FILE, start: 0.0, end: 4.0, duration: 4.0,
        hook: "テスト", confidence: 1, keepText: afterAiFix.segments[0].text,
        width: 1080, height: 1920, status: "pending",
      }],
    }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(path.join(OUT_DIR, CLIP_FILE), "dummy-old-clip", "utf-8");

  // ── サーバー起動 ──────────────────────────────────────────
  const started = await startServer([]);
  server = started.child;
  // P1-15-B: job-token.txtにはハッシュを保存する(persistJobToken参照)。
  fs.writeFileSync(path.join(WORK_DIR, "job-token.txt"), hashToken("l2-job-token"), "utf-8");
  const auth = "?jobToken=l2-job-token";

  // ── (2) 実HTTPで人の直しを重ねる（index1だけ）。index2は誰も触らない。 ─────────
  const putRes = await call("PUT", `/api/jobs/${JOB_ID}/captions${auth}`, {
    body: { index: 1, text: HUMAN_FIX_1 },
  });
  report("人の直し: PUT /captions が成功する(200)", putRes.status === 200, `status=${putRes.status} ${putRes.body}`);
  const putBody = JSON.parse(putRes.body || "{}");
  report("人の直し: 保存前の値(before)がAIの直しの結果(ガンマ)である（元の「ベータ」ではない）",
    putBody.before === AI_FIX_1, JSON.stringify(putBody));

  // ── (3) 実HTTPで焼き直し ─────────────────────────────────────
  const recapRes = await call("POST", `/api/jobs/${JOB_ID}/recaption${auth}`, { body: {} });
  report("焼き直し: POST /recaption が成功する(200)", recapRes.status === 200, `status=${recapRes.status} ${recapRes.body}`);
  const recapBody = JSON.parse(recapRes.body || "{}");
  report("焼き直し: 1本再構築したと報告する", recapBody.ok === true && recapBody.rebuilt === 1, JSON.stringify(recapBody));

  // ── (4) 生成された .ass の中身を確認 ─────────────────────────
  const assPath = path.join(WORK_DIR, "recaption-1.ass");
  report("焼き直し: .assファイルが生成されている", fs.existsSync(assPath));
  const ass = fs.readFileSync(assPath, "utf-8");

  report("対照0: 誰も触らない語(アルファ)がそのまま入っている", ass.includes("アルファ"));
  report("対照3: 誰も触らない語(オメガ)がそのまま入っている", ass.includes("オメガ"));

  report("L2本体: index1は人の直し(デルタ)で焼かれている", ass.includes(HUMAN_FIX_1));
  report("L2本体: index1にAIの直し(ガンマ)は残っていない（人が上書きした）", !ass.includes(AI_FIX_1));
  report("L2本体: index1に元の語(ベータ)も残っていない", !ass.includes("ベータ"));

  report("L2対照: index2は人が触れていないのでAIの直し(ゼータ)のまま焼かれている", ass.includes(AI_FIX_2));
  report("L2対照: index2に元の語(イプシロン)は残っていない（AIが直した分は反映される）", !ass.includes("イプシロン"));

  // ── 置き換わった出力クリップそのものの確認 ──────────────────
  const clipPath = path.join(OUT_DIR, CLIP_FILE);
  const clipStat = fs.existsSync(clipPath) ? fs.statSync(clipPath) : null;
  report("焼き直し: 出力クリップが実際に置き換わっている（ダミーの旧ファイルではない・サイズがある）",
    !!clipStat && clipStat.size > 100, clipStat ? `size=${clipStat.size}` : "no file");
  report("焼き直し: 差し替え後は一時ファイル(.recaption-tmp.mp4)が残っていない",
    !fs.existsSync(`${clipPath}.recaption-tmp.mp4`));
} finally {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
