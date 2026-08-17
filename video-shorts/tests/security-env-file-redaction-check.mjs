// tests/security-env-file-redaction-check.mjs — SEC-ENV-REDACT
//
// 【直した欠陥】secretsToRedact()（server/pipeline-runner.mjs）は process.env しか見ていな
// かったが、groqKeyAvailable() は「鍵が .env にしかない」運用（サーバ起動後に .env を置く・
// env には渡さない）を正規の運用として前提していた。つまり env に無く .env にある状態は
// 正規の運用なのに、そのとき失敗時の SSE 配信と state.json の両方へ生の鍵が出ていた
// （2026-08-16 外部レビュー指摘・実物で確認済み）。
//
// 【検査のやり方】job-failure-state-check.mjs と同じく startJob() を直接呼び、実在しない
// 入力パスを渡す（実在の src/transcribe.py が faster-whisper を読み込む前に
// os.path.isfile() で弾いて即 exit 2 する。決定的・高速・GROQ/claude 不要）。入力パスの
// ファイル名に秘密値そのものを含めることで、[ERROR] 入力が見つかりません: <パス> という
// stderr が spawnAndLog の伏字化（SSE 経路）と startJob の reject（state.json 経路）の
// 両方を同時に通る。偽バイナリは一切使わないので Windows でもそのまま動く。
//
// process.env.VS_ENV_FILE で読みに行く .env を差し替え、実運用の video-shorts/.env には
// 一切触れない（NOHARM）。
//
// 【道具が無い環境】このテストは python/faster-whisper を必要としない（isfile() で弾かれる
// 経路のみを使う）ので、道具の可用性チェックは無い。何らかの理由で state.json が書かれない
// 場合はタイムアウトで FAIL する（exit 0 で緑にはならない）。
//
// 実行: node tests/security-env-file-redaction-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startJob, subscribeJob } from "../server/pipeline-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE); // video-shorts/
const WORK_ROOT = path.join(ROOT, "work");
const REAL_ENV_PATH = path.join(ROOT, ".env");

let pass = 0,
  fail = 0;
function report(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

function sha256OrAbsent(p) {
  return fs.existsSync(p) ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : "(absent)";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForErrorState(stateePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(stateePath)) {
      try {
        const s = JSON.parse(fs.readFileSync(stateePath, "utf-8"));
        if (s.stage === "error") return s;
      } catch (_) {
        /* まだ書き込み中の可能性。次のポーリングへ */
      }
    }
    await sleep(100);
  }
  return null;
}

/**
 * 1ケースぶん実行する。env/.env の状態を設定 → 実在しない入力（秘密値を埋め込んだファイル名）
 * で startJob → state.json が error になるまで待つ → SSE 購読で本文も取る。
 */
async function runCase({ jobId, envVars, dotEnvContent, pathSecrets }) {
  const workDir = path.join(WORK_ROOT, jobId);
  fs.rmSync(workDir, { recursive: true, force: true });

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-env-"));
  const dotEnvPath = path.join(scratchDir, ".env");
  const prevVsEnvFile = process.env.VS_ENV_FILE;
  const prevGroq = process.env.GROQ_API_KEY;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  Object.assign(process.env, envVars || {});
  if (dotEnvContent != null) {
    fs.writeFileSync(dotEnvPath, dotEnvContent, "utf-8");
    process.env.VS_ENV_FILE = dotEnvPath;
  } else {
    delete process.env.VS_ENV_FILE;
  }

  try {
    // env-file.mjs / pipeline-runner.mjs は VS_ENV_FILE・GROQ_API_KEY・ANTHROPIC_API_KEY を
    // 呼び出し時（secretsToRedact() の実行時）に解決するので、モジュールの再 import は不要。
    const missingInput = path.join(
      WORK_ROOT,
      `__missing__${pathSecrets.map((s, i) => `__s${i}_${s}`).join("")}__.mp4`,
    );
    const ok = startJob(jobId, missingInput, { sub: "none", cut: "topic", size: "9:16" });
    assert.strictEqual(ok, true, "startJob が受理されない");

    const statePath = path.join(workDir, "state.json");
    const finalState = await waitForErrorState(statePath, 10_000);

    const lines = [];
    subscribeJob(jobId, (line) => lines.push(line), () => {});
    const sseBody = lines.join("");

    return { state: finalState, sseBody };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(scratchDir, { recursive: true, force: true });
    if (prevVsEnvFile === undefined) delete process.env.VS_ENV_FILE;
    else process.env.VS_ENV_FILE = prevVsEnvFile;
    if (prevGroq === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = prevGroq;
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropic;
  }
}

const REAL_ENV_BEFORE = sha256OrAbsent(REAL_ENV_PATH);

(async () => {
  /* ══════ SSE / STATE: .env にしか鍵が無い正規の運用 ══════ */
  const SECRET_A = "gsk_TEST_ENVFILE_SECRET_SHOULD_NEVER_LEAK_ABC1234567890";
  const CONTROL_1 = "gsk_TEST_CONTROL_MUST_APPEAR_RAW_XYZ0987654321ZZZZZ";
  const r1 = await runCase({
    jobId: "sec-env-redact-sse-state",
    envVars: {},
    dotEnvContent: `GROQ_API_KEY=${SECRET_A}\n`,
    pathSecrets: [SECRET_A, CONTROL_1],
  });

  report(
    "SEC-ENV-REDACT-SSE: .env にしか無い鍵が、SSE配信本文に生のまま現れない",
    !r1.sseBody.includes(SECRET_A) && r1.sseBody.includes("[REDACTED]"),
    `sseBody=${r1.sseBody.slice(0, 300)}`,
  );
  report(
    "SEC-ENV-REDACT-STATE: .env にしか無い鍵が、state.json の error に生のまま現れない",
    !!r1.state && !String(r1.state.error).includes(SECRET_A) && String(r1.state.error).includes("[REDACTED]"),
    `error=${r1.state ? r1.state.error : "(state取得不可)"}`,
  );
  report(
    "対照: .env にも env にも無い別の文字列は、SSE本文に生のまま現れる（『有るとき有る』の確認）",
    r1.sseBody.includes(CONTROL_1),
    `sseBody=${r1.sseBody.slice(0, 300)}`,
  );
  report(
    "対照: .env にも env にも無い別の文字列は、state.json の error にも生のまま現れる",
    !!r1.state && String(r1.state.error).includes(CONTROL_1),
  );

  /* ══════ BOTH: 環境変数と .env に別々の鍵がある ══════ */
  const SECRET_ENV = "gsk_TEST_ENVVAR_SECRET_AAAA11112222333344445555";
  const SECRET_FILE = "gsk_TEST_DOTENV_SECRET_BBBB66667777888899990000";
  const r2 = await runCase({
    jobId: "sec-env-redact-both",
    envVars: { GROQ_API_KEY: SECRET_ENV },
    dotEnvContent: `GROQ_API_KEY=${SECRET_FILE}\n`,
    pathSecrets: [SECRET_ENV, SECRET_FILE],
  });
  report(
    "SEC-ENV-REDACT-BOTH: 環境変数の鍵(A)と.envの鍵(B)、どちらもSSE本文に生のまま現れない",
    !r2.sseBody.includes(SECRET_ENV) && !r2.sseBody.includes(SECRET_FILE),
    `sseBody=${r2.sseBody.slice(0, 300)}`,
  );
  report(
    "SEC-ENV-REDACT-BOTH: 環境変数の鍵(A)と.envの鍵(B)、どちらもstate.jsonのerrorに生のまま現れない",
    !!r2.state &&
      !String(r2.state.error).includes(SECRET_ENV) &&
      !String(r2.state.error).includes(SECRET_FILE),
    `error=${r2.state ? r2.state.error : "(state取得不可)"}`,
  );

  /* ══════ ANTHROPIC: Claude の鍵も .env に置けば隠される ══════ */
  const SECRET_ANTHROPIC = "sk-ant-TEST_SECRET_SHOULD_NEVER_LEAK_CCCC12341234123412";
  const r3 = await runCase({
    jobId: "sec-env-redact-anthropic",
    envVars: {},
    dotEnvContent: `ANTHROPIC_API_KEY=${SECRET_ANTHROPIC}\n`,
    pathSecrets: [SECRET_ANTHROPIC],
  });
  report(
    "SEC-ENV-REDACT-ANTHROPIC: .env にしか無い ANTHROPIC_API_KEY が SSE本文に生のまま現れない",
    !r3.sseBody.includes(SECRET_ANTHROPIC) && r3.sseBody.includes("[REDACTED]"),
    `sseBody=${r3.sseBody.slice(0, 300)}`,
  );
  report(
    "SEC-ENV-REDACT-ANTHROPIC: 同じ鍵が state.json の error にも生のまま現れない",
    !!r3.state &&
      !String(r3.state.error).includes(SECRET_ANTHROPIC) &&
      String(r3.state.error).includes("[REDACTED]"),
    `error=${r3.state ? r3.state.error : "(state取得不可)"}`,
  );

  /* ══════ NOHARM: 検査を走らせても実運用の .env が変わらない ══════ */
  const REAL_ENV_AFTER = sha256OrAbsent(REAL_ENV_PATH);
  report(
    "SEC-ENV-REDACT-NOHARM: 上記の検査を走らせても video-shorts/.env のSHA-256が変わらない",
    REAL_ENV_BEFORE === REAL_ENV_AFTER,
    `before=${REAL_ENV_BEFORE} after=${REAL_ENV_AFTER}`,
  );
  {
    // 対照: ハッシュ比較という測り方が「実際に変われば変わったと言える」ことを、
    // 実運用ファイルとは無関係な使い捨ての一時ファイルで示す（実ファイルには一切触れない）。
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-env-noharm-"));
    const scratchEnv = path.join(scratchDir, ".env");
    const before = sha256OrAbsent(scratchEnv);
    fs.writeFileSync(scratchEnv, "GROQ_API_KEY=dummy\n", "utf-8");
    const after = sha256OrAbsent(scratchEnv);
    report("対照: このハッシュ比較の測り方は、内容が実際に変われば検出できる", before !== after);
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
