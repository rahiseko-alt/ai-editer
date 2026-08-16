// パイプラインの子プロセスへ渡る環境変数のallowlist化の検証 — P1-14-A
//
// 旧実装のspawnAndLog(server/pipeline-runner.mjs)は env: process.env を丸ごと子へ渡していた。
// transcribe.py・pipeline.mjs select・pipeline.mjs renderの3箇所いずれも対象で、
// ANTHROPIC_API_KEY等の秘密情報がGROQ_API_KEY同様に子プロセスへ渡っていた(H-3前半、
// docs/audits/2026-08-13-security-audit.md)。
//
// 3段構えで検証する:
//   (1) 純粋関数buildChildEnvの単体テスト: allowlist外の変数(ANTHROPIC_API_KEY等)を
//       process.envに含めても、extraKeysに無ければ出力に含まれないこと。
//   (2) ソース走査: spawnAndLogの呼び出し箇所が3箇所ちょうどで、transcribe.pyの呼び出し
//       にだけenvExtra:["GROQ_API_KEY"]が付き、select/renderには秘密情報系のenvExtraが
//       付いていないこと(P1-1-A/Bと同じ配線検査の作法)。
//   (3) 実プロセスでの確認: 実際に transcribe.py の呼び出し箇所を偽pythonへ差し替え、
//       受け取ったprocess.envを実際にダンプさせて、ANTHROPIC_API_KEY(親プロセスにだけ
//       設定した秘密)が子に渡っていないことを実測する。
//
// 実行: node tests/security-child-env-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildChildEnv } from "../server/pipeline-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const PORT = 59203; // このテスト専用の固定ポート
const JOB_ID = "security-child-env-check-job";

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

// ── (1) buildChildEnv の単体テスト ────────────────────────────
{
  const origAnthropic = process.env.ANTHROPIC_API_KEY;
  const origGroq = process.env.GROQ_API_KEY;
  const origSecret = process.env.SECRET_MARKER_XYZ;
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
  process.env.GROQ_API_KEY = "gsk-should-not-leak-without-extraKeys";
  process.env.SECRET_MARKER_XYZ = "totally-unrelated-secret";
  try {
    const envNoExtra = buildChildEnv([]);
    report(
      "1a: buildChildEnv([])はANTHROPIC_API_KEYを含まない",
      !Object.prototype.hasOwnProperty.call(envNoExtra, "ANTHROPIC_API_KEY"),
      JSON.stringify(Object.keys(envNoExtra)),
    );
    report(
      "1a: buildChildEnv([])はGROQ_API_KEYも含まない(extraKeys未指定)",
      !Object.prototype.hasOwnProperty.call(envNoExtra, "GROQ_API_KEY"),
    );
    report(
      "1a: buildChildEnv([])は無関係な秘密(SECRET_MARKER_XYZ)も含まない",
      !Object.prototype.hasOwnProperty.call(envNoExtra, "SECRET_MARKER_XYZ"),
    );
    report(
      "1a: buildChildEnv([])はPATHを含む(実行に必須な基本変数は通す)",
      Object.prototype.hasOwnProperty.call(envNoExtra, "PATH"),
    );

    const envWithGroq = buildChildEnv(["GROQ_API_KEY"]);
    report(
      "1b: buildChildEnv(['GROQ_API_KEY'])はGROQ_API_KEYを含む(transcribe.py用)",
      envWithGroq.GROQ_API_KEY === "gsk-should-not-leak-without-extraKeys",
    );
    report(
      "1b: buildChildEnv(['GROQ_API_KEY'])でもANTHROPIC_API_KEYは含まない(個別指定のみ通す)",
      !Object.prototype.hasOwnProperty.call(envWithGroq, "ANTHROPIC_API_KEY"),
    );
  } finally {
    if (origAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = origAnthropic;
    if (origGroq === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = origGroq;
    if (origSecret === undefined) delete process.env.SECRET_MARKER_XYZ; else process.env.SECRET_MARKER_XYZ = origSecret;
  }
}

// ── (2) ソース走査: spawnAndLog呼び出し箇所の配線確認 ────────────
{
  const src = fs.readFileSync(path.join(ROOT, "server", "pipeline-runner.mjs"), "utf-8");
  const calls = [...src.matchAll(/spawnAndLog\(\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]);
  report(
    "2: spawnAndLogの呼び出し箇所がtranscribe(python)・select(node)・render(node)の3箇所ちょうど",
    calls.length === 3 && calls.filter((c) => c === "python").length === 1 && calls.filter((c) => c === "node").length === 2,
    `calls=${JSON.stringify(calls)}`,
  );

  // 各spawnAndLog(呼び出しの開始位置から、次のspawnAndLog(呼び出し(または末尾)までを1ブロックとする。
  // コメント中の日本語括弧「(...)」が閉じ括弧の対応を崩すため、括弧の対応数えではなく
  // 「次の呼び出し開始位置まで」で機械的に区切る(P1-1-A/Bの配線検査と同じ考え方)。
  const callStarts = [...src.matchAll(/spawnAndLog\(/g)].map((m) => m.index);
  function blockAt(startIdx) {
    const next = callStarts.find((i) => i > startIdx);
    return src.slice(startIdx, next ?? src.length);
  }

  const pythonCallStart = callStarts.find((i) => src.slice(i, i + 60).includes('"python"'));
  const transcribeBlock = pythonCallStart !== undefined ? blockAt(pythonCallStart) : null;
  report(
    "2: transcribe.py呼び出しにenvExtra:[\"GROQ_API_KEY\"]が付いている",
    !!transcribeBlock && /envExtra:\s*\[\s*"GROQ_API_KEY"\s*\]/.test(transcribeBlock),
    transcribeBlock ? transcribeBlock.replace(/\s+/g, " ").slice(0, 300) : "not found",
  );

  // select/render呼び出しブロックにenvExtraが付いていない(=BASE_CHILD_ENV_VARSのみ)こと。
  const nodeCallStarts = callStarts.filter((i) => src.slice(i, i + 60).includes('"node"'));
  const nodeBlocks = nodeCallStarts.map((i) => blockAt(i));
  report(
    "2: select/render(node)呼び出しはいずれもenvExtraを指定していない(秘密情報が渡らない)",
    nodeBlocks.length === 2 && nodeBlocks.every((b) => !/envExtra\s*:/.test(b)),
    JSON.stringify(nodeBlocks.map((b) => b.replace(/\s+/g, " "))),
  );
}

// ── (3) 実プロセス: transcribe.py呼び出しを偽pythonに差し替え、実際に届いたenvを確認 ──
function fakeEnvDumpPython() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fake-envdump-python-"));
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const dumpFile = path.join(home, "env-dump.json");
  const script = `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify(process.env), "utf-8");
const outputPath = process.argv[process.argv.length - 1];
fs.mkdirSync(process.argv0 ? "." : ".", { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify({ language: "ja", duration: 1, words: [], segments: [] }), "utf-8");
`;
  const exe = path.join(binDir, "python");
  fs.writeFileSync(exe, script, "utf-8");
  fs.chmodSync(exe, 0o755);
  fs.writeFileSync(path.join(binDir, "package.json"), '{"type":"module"}\n', "utf-8");
  return { binDir, dumpFile };
}

function startServer(extraPathDirs, extraEnv) {
  return new Promise((resolve, reject) => {
    const PATH = [...extraPathDirs, process.env.PATH].join(path.delimiter);
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), PATH, ...extraEnv },
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

function postJob(token, buf) {
  const q = new URLSearchParams({ token, sub: "none", cut: "topic", size: "9:16", name: "sample.mp4" }).toString();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: `/api/jobs?${q}`, method: "POST", timeout: 15000,
      headers: { host: `127.0.0.1:${PORT}`, "Content-Type": "application/octet-stream", "Content-Length": buf.length },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

let server = null;
const { binDir, dumpFile } = fakeEnvDumpPython();
try {
  const started = await startServer([binDir], {
    ANTHROPIC_API_KEY: "sk-ant-should-not-reach-transcribe-child",
    GROQ_API_KEY: "gsk-should-reach-transcribe-child",
  });
  server = started.child;

  // 有効なmp4署名(ftyp)を持つ最小限のダミー動画で足りる(実際に読み込むのは偽pythonなので中身は無関係)。
  const head = Buffer.alloc(16);
  head.write("ftyp", 4, "ascii");
  const videoBuf = Buffer.concat([head, Buffer.alloc(2000, 0)]);
  const r = await postJob(started.token, videoBuf);
  report("3前提: ジョブが受理される(202)", r.status === 202, `status=${r.status} ${r.body}`);

  // transcribe(偽python)が起動しenv-dump.jsonを書くまで待つ(最大5秒)。
  let dumped = null;
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(dumpFile)) {
      await new Promise((res) => setTimeout(res, 100)); // 書き込み完了を少し待つ
      try { dumped = JSON.parse(fs.readFileSync(dumpFile, "utf-8")); break; } catch (_) { /* まだ書き込み中 */ }
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  report("3前提: 偽pythonが起動しenvをダンプした", dumped !== null, "env-dump.jsonが作られなかった");

  if (dumped) {
    report(
      "3: transcribe.pyの子プロセスにANTHROPIC_API_KEYが渡っていない",
      !Object.prototype.hasOwnProperty.call(dumped, "ANTHROPIC_API_KEY"),
      `keys=${JSON.stringify(Object.keys(dumped))}`,
    );
    report(
      "3: transcribe.pyの子プロセスにGROQ_API_KEYは渡っている(この処理に必要な唯一の秘密情報)",
      dumped.GROQ_API_KEY === "gsk-should-reach-transcribe-child",
    );
  }
} finally {
  await stopServer(server);
  fs.rmSync(path.join(ROOT, "work", JOB_ID), { recursive: true, force: true });
  fs.rmSync(path.dirname(binDir), { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
