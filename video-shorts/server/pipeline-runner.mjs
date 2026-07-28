// server/pipeline-runner.mjs — ジョブごとの段階実行管理
// transcribe → select(llm-request) → claude-select → render の流れを制御する。
// 各 spawn の stderr を行単位で取得し SSE 購読者へ push する。
// npm 依存ゼロ: Node 標準モジュールのみ。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runClaudeSelect } from "./claude-select.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORK_ROOT = path.join(ROOT, "work");
const PIPELINE_MJS = path.join(ROOT, "pipeline.mjs");
const TRANSCRIBE_PY = path.join(ROOT, "src", "transcribe.py");

/**
 * jobId → { stage, subscribers: Set<{push,close}>, error }
 * メモリ上の状態 Map。プロセス再起動で消える設計（ローカル用途）。
 */
const jobs = new Map();

/** SSE イベントを購読者全員に push。error/done は接続も close する */
function broadcast(jobId, payload, event = null) {
  const job = jobs.get(jobId);
  if (!job) return;
  const line = event
    ? `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    : `data: ${JSON.stringify(payload)}\n\n`;
  for (const sub of job.subscribers) {
    try {
      sub.push(line);
    } catch (_) {
      // 切断済み購読者は無視
    }
  }
  // 終端イベント（error / done）は全購読者の SSE 接続を閉じて Set をクリア
  if (event === "error" || event === "done") {
    for (const sub of job.subscribers) {
      try { sub.close(); } catch (_) {}
    }
    job.subscribers.clear();
  }
}

/** ジョブが実行中（init/t/s/r）かを返す。POST 受理前の二重起動チェック用。 */
export function isRunning(jobId) {
  const j = jobs.get(jobId);
  return !!j && ["init", "t", "s", "r"].includes(j.stage);
}

/** SSE 購読者を追加 */
export function subscribeJob(jobId, push, close) {
  if (!jobs.has(jobId)) {
    jobs.set(jobId, { stage: "unknown", subscribers: new Set(), error: null, errorCode: null });
  }
  const job = jobs.get(jobId);
  const sub = { push, close };
  job.subscribers.add(sub);

  // race condition 対策: 既に終了済みならリプレイして即通知
  if (job.stage === "error") {
    try { push(`event: error\ndata: ${JSON.stringify({ message: job.error || "処理に失敗しました", code: job.errorCode || null })}\n\n`); } catch (_) {}
    try { close(); } catch (_) {}
    job.subscribers.delete(sub);
  } else if (job.stage === "done") {
    try { push(`event: done\ndata: ${JSON.stringify({ stage: "done" })}\n\n`); } catch (_) {}
    try { close(); } catch (_) {}
    job.subscribers.delete(sub);
  }
}

/** SSE 購読者を削除 */
export function unsubscribeJob(jobId, push) {
  const job = jobs.get(jobId);
  if (!job) return;
  for (const sub of job.subscribers) {
    if (sub.push === push) {
      job.subscribers.delete(sub);
      break;
    }
  }
}

/** ジョブの state.json を読む（無ければ null） */
function readState(workDir) {
  const sp = path.join(workDir, "state.json");
  if (!fs.existsSync(sp)) return null;
  return JSON.parse(fs.readFileSync(sp, "utf-8"));
}

/** ジョブの state.json を書く */
function writeState(workDir, state) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(
    path.join(workDir, "state.json"),
    JSON.stringify(state, null, 2),
    "utf-8"
  );
}

/**
 * 子プロセスを spawn し、stderr を行単位で onLine に渡す。
 * 終了コード 0 以外は reject。
 */
function spawnAndLog(cmd, args, opts, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: process.env,
      windowsHide: true,
      ...opts,
    });
    let errBuf = "";
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      errBuf += text;
      text.split("\n").forEach((ln) => {
        if (ln.trim()) onLine(ln.trim());
      });
    });
    // stdout も受け取る（pipeline.mjs が stdout に出力する場合あり）
    child.stdout.on("data", (chunk) => {
      chunk
        .toString()
        .split("\n")
        .forEach((ln) => {
          if (ln.trim()) onLine(`[stdout] ${ln.trim()}`);
        });
    });
    child.on("error", (err) => reject(new Error(`spawn error: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(
            `${cmd} 終了コード ${code}。stderr: ${errBuf.slice(0, 400)}`
          )
        );
      }
      resolve();
    });
  });
}

// ── バックエンド判定と並列制御（複数本同時投入・Groq 時のみ並列） ──────
// Groq（クラウド）はサーバ側で並列処理されるため複数ジョブの同時実行を許可する。
// local（faster-whisper / CPU）は並列しても CPU 律速で合計時間が変わらず
// 各本が遅くなるだけなので、FIFO キューで 1 本ずつ直列に流す。
// 判定は transcribe.py の auto 解決と同じ「GROQ_API_KEY の有無」（env → .env の順）。
function groqKeyAvailable() {
  if (process.env.GROQ_API_KEY) return true;
  try {
    const envPath = path.join(ROOT, ".env");
    if (!fs.existsSync(envPath)) return false;
    return fs
      .readFileSync(envPath, "utf-8")
      .split(/\r?\n/)
      .some((ln) => {
        const s = ln.trim();
        if (!s.startsWith("GROQ_API_KEY=")) return false;
        const v = s.slice("GROQ_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
        return v.length > 0;
      });
  } catch (_) {
    return false;
  }
}

const localQueue = []; // local バックエンド時の FIFO（要素は () => Promise）
let localRunning = false;

function drainLocalQueue() {
  if (localRunning || localQueue.length === 0) return;
  localRunning = true;
  const exec = localQueue.shift();
  // exec は内部でエラーを catch 済み（reject しない）
  exec().finally(() => {
    localRunning = false;
    drainLocalQueue();
  });
}

/**
 * ジョブ実行開始（非同期・kick して即返す）
 *
 * @param {string} jobId
 * @param {string} inputAbsPath - 保存済みの入力動画絶対パス
 * @param {{ sub: "on"|"none", cut: string, size: string }} opts
 */
export function startJob(jobId, inputAbsPath, opts) {
  // 走行中ガード: 同一 jobId が実行中（init/t/s/r）なら二重起動を拒否。
  // 完了済（done/error）や購読のみ（unknown）は再起動を許可（同じ動画の再編集）。
  const existing = jobs.get(jobId);
  const RUNNING = ["init", "t", "s", "r"];
  if (existing && RUNNING.includes(existing.stage)) {
    return false;
  }
  if (!existing) {
    jobs.set(jobId, { stage: "init", subscribers: new Set(), error: null, errorCode: null });
  } else {
    // 購読者（SSE）は保持したまま状態だけリセットして再実行
    existing.stage = "init";
    existing.error = null;
    existing.errorCode = null;
  }
  // 非同期で実行（エラーは exec 内で処理し reject させない＝キュー drain を止めない）
  const exec = () =>
    runJob(jobId, inputAbsPath, opts).catch((err) => {
      process.stderr.write(`[pipeline error] jobId=${jobId} ${err?.stack ?? err}\n`);
      const job = jobs.get(jobId);
      if (job) {
        job.stage = "error";
        job.error = err?.message ?? String(err);
        job.errorCode = err?.code ?? null;
      }
      broadcast(jobId, { message: err?.message ?? String(err), code: err?.code ?? null }, "error");
    });
  if (groqKeyAvailable()) {
    exec(); // Groq: 並列実行（クラウド側で並列処理される）
  } else {
    // local: 直列。待ち中であることを購読者へ通知してからキュー投入
    if (localRunning || localQueue.length > 0) {
      broadcast(jobId, {
        stage: "init",
        status: "active",
        label: "順番待ちです（この端末では1本ずつ処理します）",
      });
    }
    localQueue.push(exec);
    drainLocalQueue();
  }
  return true;
}

/** 実際の段階実行（内部・エラーは呼び元でキャッチ） */
async function runJob(jobId, inputAbsPath, opts) {
  const workDir = path.join(WORK_ROOT, jobId);
  const noSub = opts.sub === "none";

  // state.json 初期作成（pipeline.mjs init の代替）
  const ext = path.extname(inputAbsPath) || ".mp4";
  const state = {
    id: jobId,
    input: inputAbsPath,
    transcript: null,
    stage: "init",
  };
  writeState(workDir, state);

  const job = jobs.get(jobId);

  // ── Stage t: 文字起こし ──────────────────────────────────────
  job.stage = "t";
  broadcast(jobId, { stage: "t", status: "active", label: "話し言葉を文字にしています" });

  const transcriptPath = path.join(workDir, "transcript.json");
  await spawnAndLog(
    "python",
    [TRANSCRIBE_PY, inputAbsPath, transcriptPath],
    {},
    (ln) => broadcast(jobId, { stage: "t", status: "active", log: ln })
  );

  state.stage = "transcribed";
  state.transcript = transcriptPath;
  writeState(workDir, state);

  // 話し声が無い動画（音楽・歓声のみ等）は文字起こしが 0 件になる。
  // ここで素人に分かる言葉で止める（select/claude を走らせず無駄なコストも避ける）。
  const tr = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));
  if (!tr.segments || tr.segments.length === 0) {
    const e = new Error("話し声が見つかりませんでした。");
    e.code = "no_speech";   // フロントは専用カードを出す
    throw e;
  }

  broadcast(jobId, { stage: "t", status: "done" });

  // ── Stage s: 区間選定（llm-request 生成 → claude 呼び出し） ──────
  job.stage = "s";
  broadcast(jobId, { stage: "s", status: "active", label: "良い場面を選んでいます" });

  // pipeline.mjs select で llm-request.md を生成（--api なし）
  await spawnAndLog(
    "node",
    [PIPELINE_MJS, "select", workDir],
    {},
    (ln) => broadcast(jobId, { stage: "s", status: "active", log: ln })
  );

  // claude -p で区間選定（llm-response.json を書く）
  await runClaudeSelect(workDir, (msg) => {
    broadcast(jobId, { stage: "s", status: "active", log: msg });
  });

  state.stage = "selected";
  writeState(workDir, state);
  broadcast(jobId, { stage: "s", status: "done" });

  // ── Stage r: レンダリング ────────────────────────────────────
  job.stage = "r";
  broadcast(jobId, { stage: "r", status: "active", label: "縦長の動画に整えています" });

  const renderArgs = [PIPELINE_MJS, "render", workDir];
  if (noSub) renderArgs.push("--no-sub");

  await spawnAndLog(
    "node",
    renderArgs,
    {},
    (ln) => broadcast(jobId, { stage: "r", status: "active", log: ln })
  );

  state.stage = "rendered";
  writeState(workDir, state);
  broadcast(jobId, { stage: "r", status: "done" });

  // ── 完了 ─────────────────────────────────────────────────────
  job.stage = "done";
  broadcast(jobId, { stage: "done" }, "done");
}
