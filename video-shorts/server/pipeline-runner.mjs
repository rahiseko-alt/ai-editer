// server/pipeline-runner.mjs — ジョブごとの段階実行管理
// transcribe → AIが字幕の間違いを直す → select(llm-request) → claude-select → render
// →（選ばれたときだけ）顔モザイク の流れを制御する。
// 各 spawn の stderr を行単位で取得し SSE 購読者へ push する。
// npm 依存ゼロ: Node 標準モジュールのみ。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runClaudeSelect } from "./claude-select.mjs";
import { applyMosaicStage } from "../src/apply-mosaic-stage.mjs";
import { aiCaptionFixStage, createDefaultRunModel } from "../src/ai-caption-fix.mjs";
import { writeJsonAtomically } from "../src/atomic-json.mjs";
import { redactSecrets } from "./security.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");
const PIPELINE_MJS = path.join(ROOT, "pipeline.mjs");
const TRANSCRIBE_PY = path.join(ROOT, "src", "transcribe.py");

/**
 * jobId → { stage, subscribers: Set<{push,close}>, error }
 * メモリ上の状態 Map。プロセス再起動で消える設計（ローカル用途）。
 */
const jobs = new Map();

/** 「実行中/待機中」とみなすstage一覧。TTL掃除の除外判定・二重起動ガードの両方から参照する。 */
const RUNNING_STAGES = ["init", "t", "c", "s", "r", "m"];

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

/** ジョブが実行中（init/t/c/s/r/m）かを返す。POST 受理前の二重起動チェック用。 */
export function isRunning(jobId) {
  const j = jobs.get(jobId);
  return !!j && RUNNING_STAGES.includes(j.stage);
}

/**
 * 現在「実行中/待機中」(RUNNING_STAGES)のジョブID一覧。
 * P2-4-A: TTL掃除(job-lifecycle.mjs の sweepExpiredJobs)は work/output ディレクトリの
 * mtimeだけを見るため、startJob() でキューへ積まれた直後（state.jsonをまだ書いていない・
 * ディレクトリのmtimeが古いまま）のジョブを「放置された古いジョブ」と誤認して消しうる。
 * server/index.mjs はこの一覧を掃除の除外リストとして渡す。
 */
export function activeJobIds() {
  const ids = [];
  for (const [id, job] of jobs) {
    if (RUNNING_STAGES.includes(job.stage)) ids.push(id);
  }
  return ids;
}

/** サーバー再起動時にクライアントへ伝える、ジョブが中断された旨のメッセージ(P1-6)。 */
const INTERRUPTED_MESSAGE = "サーバーが再起動したため、処理が中断されました。お手数ですが、もう一度実行してください。";

/**
 * SSE 購読者を追加。
 * P1-6: jobId がこのプロセスの jobs Map に存在しない状態で呼ばれるのは、"ジョブトークン認可
 * (P1-4, isAuthorizedForJob)を通過している"のに"このプロセスはこのジョブを一度も起動していない"
 * ケースに限られる(起動直後は startJob() が必ず先に jobs.set 済みのため)。これは実質的に
 * 「以前のプロセス(再起動前)が発行したジョブへの再接続」を意味する。進捗はメモリのみでプロセス
 * 再起動により失われているため、"unknown"のまま永久待機させず、中断された事実を即座に明示する。
 */
export function subscribeJob(jobId, push, close) {
  if (!jobs.has(jobId)) {
    jobs.set(jobId, { stage: "interrupted", subscribers: new Set(), error: null, errorCode: null });
  }
  const job = jobs.get(jobId);
  const sub = { push, close };
  job.subscribers.add(sub);

  // race condition 対策: 既に終了済み/中断済みならリプレイして即通知
  if (job.stage === "error") {
    try { push(`event: error\ndata: ${JSON.stringify({ message: job.error || "処理に失敗しました", code: job.errorCode || null })}\n\n`); } catch (_) {}
    try { close(); } catch (_) {}
    job.subscribers.delete(sub);
  } else if (job.stage === "done") {
    try { push(`event: done\ndata: ${JSON.stringify({ stage: "done" })}\n\n`); } catch (_) {}
    try { close(); } catch (_) {}
    job.subscribers.delete(sub);
  } else if (job.stage === "interrupted") {
    try { push(`event: interrupted\ndata: ${JSON.stringify({ message: INTERRUPTED_MESSAGE })}\n\n`); } catch (_) {}
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

/**
 * ジョブの state.json を書く。
 * P2-1: 直接 truncate 書込みだと、書いている途中でプロセスが落ちたときに state.json が
 * 壊れて読めなくなる（ジョブが再開できなくなる）。writeJsonAtomically で
 * 「同じディレクトリの一時ファイルへ書く→fsync→rename」の作法にする。
 */
function writeState(workDir, state) {
  writeJsonAtomically(path.join(workDir, "state.json"), state);
}

// P1-14-A: パイプラインの子(python/node)へ渡してよい環境変数の基本allowlist。
// claude起動口(src/claude-safety.mjs ALLOWED_ENV_VARS)より広いのは、python/nodeの実行系・
// ライブラリ解決・モデルキャッシュに必要な変数を含むため(APIキー等の秘密情報は含めない)。
const BASE_CHILD_ENV_VARS = [
  "PATH", "HOME", "LANG", "LC_ALL", "LANGUAGE", "USER",
  "TMPDIR", "TMP", "TEMP",
  "PYTHONPATH", "PYTHONIOENCODING", "PYTHONUNBUFFERED", "VIRTUAL_ENV",
  "NODE_PATH",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "HF_HOME", "HUGGINGFACE_HUB_CACHE", // faster-whisperモデルキャッシュの置き場所
];

/** allowlist(+呼び出しごとの追加キー)だけを含むenvを作る。単体テストのためexportする。 */
export function buildChildEnv(extraKeys = []) {
  const env = {};
  for (const key of [...BASE_CHILD_ENV_VARS, ...extraKeys]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** P1-14-B/C: 子の出力・エラーメッセージから伏字にすべき秘密情報の実値一覧。 */
function secretsToRedact() {
  return [process.env.GROQ_API_KEY, process.env.ANTHROPIC_API_KEY].filter(Boolean);
}

/**
 * 子プロセスを spawn し、stderr を行単位で onLine に渡す。
 * 終了コード 0 以外は reject。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ envExtra?: string[], [key: string]: any }} opts envExtra はこの呼び出しに限り
 *   allowlistへ追加する環境変数キー(例: transcribe.pyのGROQ_API_KEY)。値そのものではなくキー名。
 * @param {(line: string) => void} onLine
 */
function spawnAndLog(cmd, args, opts, onLine) {
  const { envExtra, ...restOpts } = opts || {};
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: buildChildEnv(envExtra),
      windowsHide: true,
      ...restOpts,
    });
    const secrets = secretsToRedact();
    let errBuf = "";
    child.stderr.on("data", (chunk) => {
      const text = redactSecrets(chunk.toString(), secrets);
      errBuf += text;
      text.split("\n").forEach((ln) => {
        if (ln.trim()) onLine(ln.trim());
      });
    });
    // stdout も受け取る（pipeline.mjs が stdout に出力する場合あり）
    child.stdout.on("data", (chunk) => {
      redactSecrets(chunk.toString(), secrets)
        .split("\n")
        .forEach((ln) => {
          if (ln.trim()) onLine(`[stdout] ${ln.trim()}`);
        });
    });
    child.on("error", (err) => reject(new Error(`spawn error: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        // errBuf は上でチャンク単位で既に伏字化済み(P1-14-C: state.jsonへ書かれるError.messageの
        // 経路もここを通るため、二重に伏字化する必要はない)。
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

// ── 同時実行数の上限（P2-4-C） ──────────────────────────────────
// Groq（クラウド）経路は元々「同時に何本でも」起動していた。大量投入すると外部APIの
// レート制限や端末のネットワーク/CPUを使い切りうるため、同時に走らせる本数へ上限を設け、
// 超過分は拒否せずFIFOで順番待ちにする（local経路はもともとCPU律速でFIFO=1本ずつのため、
// どんな上限値でも既に満たしており変更不要）。

/** 同時実行数の上限を環境変数から解決する（純粋関数・テスト用に切り出し）。既定3。 */
export function resolveMaxConcurrentJobs(envValue = process.env.VS_MAX_CONCURRENT_JOBS) {
  const n = Number(envValue);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

/**
 * 同時実行数を max 本までに絞るゲートを作る。run(fn) は fn（引数無しで Promise を返す
 * 関数）をキューへ積み、空きスロットがあれば即実行・無ければ順番待ちにする（拒否しない）。
 * pipeline-runner.mjs 固有の spawn/SSE 等には依存しない純粋なスケジューラなので、
 * 実際のジョブ実行を伴わずに単体テストできる。
 */
export function createConcurrencyGate(max) {
  let running = 0;
  const queue = [];
  function drain() {
    if (running >= max || queue.length === 0) return;
    running++;
    const fn = queue.shift();
    fn().finally(() => {
      running--;
      drain();
    });
  }
  return {
    run(fn) {
      queue.push(fn);
      drain();
    },
    get running() { return running; },
    get waiting() { return queue.length; },
  };
}

const MAX_CONCURRENT_JOBS = resolveMaxConcurrentJobs();
const concurrencyGate = createConcurrencyGate(MAX_CONCURRENT_JOBS);

// P1-13-B: 焼き直し(recaption)専用の管理。同一ジョブへの並列連打は
// src/recaption-stage.mjs の一時ファイル名がジョブ固定のため競合する。また、
// 焼き直しはこれまでconcurrencyGateの対象外でffmpegを無制限にspawnできた。
// 本編ジョブと同じゲートを共有させ、同時実行数の上限を一本化する。
const recaptioningJobs = new Set();

/** 指定ジョブが現在焼き直し中かどうか。 */
export function isRecaptioning(jobId) {
  return recaptioningJobs.has(jobId);
}

/** 焼き直しの開始をマークする。既に開始済みなら false（呼び出し側は409等で拒否する）。 */
export function beginRecaption(jobId) {
  if (recaptioningJobs.has(jobId)) return false;
  recaptioningJobs.add(jobId);
  return true;
}

/** 焼き直しの終了をマークする（成功・失敗いずれの経路でも呼ぶこと）。 */
export function endRecaption(jobId) {
  recaptioningJobs.delete(jobId);
}

/**
 * fn（引数無しでPromiseを返す関数）を、本編ジョブと共有の同時実行数ゲート配下で実行し、
 * その結果を呼び出し側へ返す。焼き直しのffmpeg起動を、本編ジョブと合算した上限内に収める。
 */
export function runGated(fn) {
  return new Promise((resolve, reject) => {
    concurrencyGate.run(() => fn().then(resolve, reject));
  });
}

/**
 * ジョブ実行開始（非同期・kick して即返す）
 *
 * @param {string} jobId
 * @param {string} inputAbsPath - 保存済みの入力動画絶対パス
 * @param {{ sub: "on"|"none", cut: "topic"|"minutes", size: "9:16"|"16:9", cutMin?: number }} opts
 */
export function startJob(jobId, inputAbsPath, opts) {
  // 走行中ガード: 同一 jobId が実行中（init/t/c/s/r/m）なら二重起動を拒否。
  // 完了済（done/error）や購読のみ（unknown）は再起動を許可（同じ動画の再編集）。
  const existing = jobs.get(jobId);
  if (existing && RUNNING_STAGES.includes(existing.stage)) {
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
  const workDir = path.join(WORK_ROOT, jobId);
  const exec = () =>
    runJob(jobId, inputAbsPath, opts).catch((err) => {
      process.stderr.write(`[pipeline error] jobId=${jobId} ${err?.stack ?? err}\n`);
      const job = jobs.get(jobId);
      if (job) {
        job.stage = "error";
        job.error = err?.message ?? String(err);
        job.errorCode = err?.code ?? null;
      }
      // G-EDIT-MOSAIC-UI-O-2: 失敗をメモリ上の job.stage だけでなく state.json にも残す。
      // ここを書かないと、途中まで（例: rendered）進んだ state.json が最後に書いた
      // 成功段階のまま残り、サーバー再起動後に読み直すと成功したジョブに見えてしまう
      // （メモリの job.stage は再起動で消える一方、state.json はディスクに残るため）。
      // state.json がまだ一度も書かれていない（init 前に落ちた等）場合は空オブジェクトを土台にする。
      try {
        const current = readState(workDir) || {};
        writeState(workDir, {
          ...current,
          stage: "error",
          error: err?.message ?? String(err),
          errorCode: err?.code ?? null,
        });
      } catch (writeErr) {
        process.stderr.write(
          `[pipeline error] state.json への失敗記録に失敗 jobId=${jobId} ${writeErr?.stack ?? writeErr}\n`
        );
      }
      broadcast(jobId, { message: err?.message ?? String(err), code: err?.code ?? null }, "error");
    });
  if (groqKeyAvailable()) {
    // Groq: 並列実行（クラウド側で並列処理される）。ただし同時実行数の上限までで、
    // 超過分はconcurrencyGateがFIFOで順番待ちにする(P2-4-C)。
    concurrencyGate.run(exec);
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

/**
 * UIの設定契約(P0-5)をpipeline.mjsが理解するmode/orientへ変換する。
 * サポート外の値はここでも既定へフォールバックし、末端(select/render)まで不正値を伝播させない。
 */
export function resolveJobSettings(opts) {
  const mode = opts.cut === "minutes" ? "digest" : "topic";
  const orient = opts.size === "16:9" ? "landscape" : "portrait";
  const targetMinutes =
    mode === "digest" && Number.isFinite(opts.cutMin) && opts.cutMin > 0 ? opts.cutMin : undefined;
  return { mode, orient, targetMinutes };
}

/** レンダリングstageの進捗ラベルをorientに応じて出し分ける（縦長/横長） */
export function renderLabel(orient) {
  return orient === "landscape" ? "横長の動画に整えています" : "縦長の動画に整えています";
}

/** 実際の段階実行（内部・エラーは呼び元でキャッチ） */
async function runJob(jobId, inputAbsPath, opts) {
  const workDir = path.join(WORK_ROOT, jobId);
  const noSub = opts.sub === "none";
  const { mode, orient, targetMinutes } = resolveJobSettings(opts);

  // state.json 初期作成（pipeline.mjs init の代替）
  const state = {
    id: jobId,
    input: inputAbsPath,
    transcript: null,
    stage: "init",
    mode,
    orient,
    targetMinutes,
    sub: opts.sub === "none" ? "none" : "on",
    // 無音・言い淀みを詰めるか。pipeline.mjs のレンダリングが state.trim を見る。
    // ここへ入れ忘れると、画面で「詰める」を選んでも一度も詰まらない
    // （顔モザイクで同じ取りこぼしをしたので、結線を smoke.mjs で押さえる）。
    trim: opts.trim === "on" ? "on" : "none",
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
    // P1-14-A: GROQ_API_KEYはtranscribe.pyのGroq経路選択に必要な唯一の秘密情報。
    // ここでだけ明示的にallowlistへ加える(select/renderの子には渡さない)。
    { envExtra: ["GROQ_API_KEY"] },
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

  // ── Stage c: AIが字幕の間違いを直す ──────────────────────────
  // 文字起こしの直後・区間選定の前に置く。ここで直しておくと、後段の区間選定も
  // 直った文字を読む（「公開」と「後悔」を取り違えた文で場面を選ばれずに済む）し、
  // 焼く字幕も直った文字になる。失敗したら例外のままジョブを失敗させる
  // （黙って元の文字起こしで進めると、直したつもりで直っていない動画が出る）。
  job.stage = "c";
  broadcast(jobId, { stage: "c", status: "active", label: "AIが字幕の間違いを直しています" });

  const fixed = await aiCaptionFixStage({
    workDir,
    runModel: createDefaultRunModel(workDir),
    onLog: (msg) => broadcast(jobId, { stage: "c", status: "active", log: msg }),
  });

  state.stage = "captionfixed";
  writeState(workDir, state);
  broadcast(jobId, { stage: "c", status: "active", log: `[ai-caption-fix] ${fixed.total} 語のうち ${fixed.fixed} 語を直しました` });
  broadcast(jobId, { stage: "c", status: "done" });

  // ── Stage s: 区間選定（llm-request 生成 → claude 呼び出し） ──────
  job.stage = "s";
  broadcast(jobId, { stage: "s", status: "active", label: "良い場面を選んでいます" });

  // digest(分数で切る): pipeline.mjs select --mode digest が編集エージェント(runDigestEditor)を
  // 自前で起動し claude -p を呼んで llm-response.json まで書く。topic 側の claude-select は使わない。
  const selectArgs = [PIPELINE_MJS, "select", workDir, "--mode", mode];
  if (mode === "digest" && targetMinutes !== undefined) {
    selectArgs.push("--target-min", String(targetMinutes));
  }
  await spawnAndLog(
    "node",
    selectArgs,
    {},
    (ln) => broadcast(jobId, { stage: "s", status: "active", log: ln })
  );

  // topic(話題で切る): pipeline.mjs select は llm-request.md を書くだけなので、
  // claude -p 呼び出し(チャンク並列)は別途ここで行い llm-response.json を書く。
  // P1-5: 一部chunkが失敗しても(1件以上成功していれば)処理は続行するが、その場合は
  // incomplete:true をstateへ残し、成功したふりをしない(候補生成・SSE完了通知の両方に反映)。
  let selectIncomplete = false;
  if (mode !== "digest") {
    const result = await runClaudeSelect(workDir, (msg) => {
      broadcast(jobId, { stage: "s", status: "active", log: msg });
    });
    selectIncomplete = result.incomplete;
    if (selectIncomplete) {
      broadcast(jobId, {
        stage: "s",
        status: "active",
        log: `[WARN] ${result.failedChunks}/${result.totalChunks} chunk が失敗しました。成功分のみで続行します。`,
      });
    }
  }

  state.stage = "selected";
  state.selectIncomplete = selectIncomplete;
  writeState(workDir, state);
  broadcast(jobId, { stage: "s", status: "done", incomplete: selectIncomplete });

  // ── Stage r: レンダリング ────────────────────────────────────
  job.stage = "r";
  broadcast(jobId, { stage: "r", status: "active", label: renderLabel(orient) });

  const renderArgs = [PIPELINE_MJS, "render", workDir, "--mode", mode];
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

  // ── Stage m: 顔モザイク（選ばれたときだけ） ──────────────────
  // これまでモザイクは CLI 経路にしか無く、画面から使うと素顔のまま出ていた。
  // 掛けたときは素顔のファイルを成果物フォルダの外へ退避する（納品はフォルダからの
  // コピーなので、一覧から隠すだけでは「うっかり素顔を渡す」を防げない）。
  if (opts.mosaic === "on") {
    job.stage = "m";
    broadcast(jobId, { stage: "m", status: "active", label: "顔にモザイクを掛けています" });

    const outDir = path.join(OUT_ROOT, jobId);
    const candPath = path.join(outDir, "candidates.json");
    const cand = JSON.parse(fs.readFileSync(candPath, "utf-8"));
    // AUD-P1-06: candidates.json の書き換えは applyMosaicStage() が原子的（temp+rename）に
    // 行う。ここで改めて fs.writeFileSync すると、その書き込み自体が非原子的なtruncate書きに
    // 戻ってしまい、書いている途中で落ちたときに壊れて読めなくなる。
    await applyMosaicStage({
      outDir,
      stashDir: path.join(workDir, "pre-mosaic"),
      candidates: cand,
      candPath,
      onLog: (ln) => broadcast(jobId, { stage: "m", status: "active", log: ln }),
    });

    state.stage = "mosaicked";
    state.mosaic = "on";
    writeState(workDir, state);
    broadcast(jobId, { stage: "m", status: "done" });
  }

  // ── 完了 ─────────────────────────────────────────────────────
  job.stage = "done";
  broadcast(jobId, { stage: "done", incomplete: selectIncomplete }, "done");
}
