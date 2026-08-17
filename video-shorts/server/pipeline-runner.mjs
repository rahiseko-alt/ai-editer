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
import { trimJudgeStage } from "../src/trim-judge.mjs";
import { writeJsonAtomically } from "../src/atomic-json.mjs";
import { stageStart, stageEnd, stageSetSpan, readTiming, summaryLine } from "../src/timing.mjs";
import { redactSecrets, createStreamingRedactor } from "./security.mjs";
import { readEnvFileValue } from "../src/env-file.mjs";
import { checkBundledFont } from "../src/font-check.mjs";
import { DEFAULT_FONT_KEY } from "../src/subtitle-styles.mjs";

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

/** 終端(それ以上進まない)とみなすstage一覧。AUD-P2-20aのメモリ回収の対象判定に使う。 */
const TERMINAL_STAGES = ["done", "error", "cancelled", "timeout"];

/**
 * AUD-P2-20a: 終端ジョブの保持期間(ms)。既定10分。VS_JOB_RETENTION_SECONDSで秒単位の
 * 上書きができる(0以下・非数は既定へ)。terminalStages(done/error/cancelled/timeout)へ
 * 到達してからこの期間を過ぎたジョブは、定期的にメモリ(jobs Map)から回収する。
 *
 * 旧実装は終端に達したジョブをjobs Mapから一切削除しておらず、稼働し続けるサーバーへ
 * 継続的にジョブが投入されると、終わったジョブの記録がメモリに際限なく溜まり続けていた
 * (監査指摘)。
 */
export function resolveJobRetentionMs(envValue = process.env.VS_JOB_RETENTION_SECONDS) {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n * 1000 : 10 * 60 * 1000;
}
const JOB_RETENTION_MS = resolveJobRetentionMs();

/**
 * jobs Mapのうち、終端(TERMINAL_STAGES)に達してから JOB_RETENTION_MS を過ぎたものを
 * 削除する(AUD-P2-20a)。終端イベントの時点でSSE購読者は既に全員closeされている
 * (broadcast参照)ため、削除しても購読者を巻き込まない。
 * @param {number} [nowMs] テストで実時間を待たずに検証できるよう呼び出し側が渡せる。
 * @returns {string[]} 削除したjobId一覧
 */
export function reclaimTerminalJobs(nowMs = Date.now()) {
  const removed = [];
  for (const [id, job] of jobs) {
    if (!TERMINAL_STAGES.includes(job.stage)) continue;
    if (typeof job.terminatedAt !== "number") continue; // 保険(通常は終端到達時に必ず設定される)
    if (nowMs - job.terminatedAt > JOB_RETENTION_MS) {
      jobs.delete(id);
      removed.push(id);
    }
  }
  return removed;
}

// 起動しっぱなしのローカルサーバーでも定期的に回収されるよう、1分ごとに実行する
// (エントリ自体は軽量なので毎分の走査コストは無視できる)。unref()でこのタイマーだけの
// ためにプロセスが終了できなくなるのを防ぐ(テスト等での後始末)。
setInterval(() => reclaimTerminalJobs(), 60 * 1000).unref();

/** jobs Mapに指定jobIdがまだ載っているか(テスト用に公開)。 */
export function hasJobInMemory(jobId) {
  return jobs.has(jobId);
}

/** jobs Mapの現在の件数(テスト用に公開)。 */
export function jobsMapSize() {
  return jobs.size;
}

// P1-13-B/AUD-P1-03a/03b: 焼き直し(recaption)専用の管理。同一ジョブへの並列連打は
// src/recaption-stage.mjs の一時ファイル名がジョブ固定のため競合する。activeJobIds()
// (TTL掃除の除外判定)からも参照するため、使用箇所より前で宣言する。
const recaptioningJobs = new Set();

/**
 * AUD-P1-11a/11b: ジョブごとのキャンセル/タイムアウト管理。
 * jobId → { child: ChildProcess|null, cancelRequested: boolean, terminalReason: "cancelled"|"timeout"|null }
 *   - child: そのジョブが現在spawnしている子プロセス(spawnAndLog経由)。無ければnull
 *     (ステージの合間・子プロセスを使わないステージの実行中など)。
 *   - cancelRequested: cancelJob()が呼ばれたら true。以後このジョブは新しい子プロセスを
 *     起動する前に即座に中止する(既にキューで順番待ち中でも、次に子を起動しようとした
 *     瞬間に止まる)。
 *   - terminalReason: 子プロセスの close ハンドラが「なぜ死んだか」を判定するための印。
 *     killChildTree()を呼ぶ側(cancelJob/タイムアウト)が呼ぶ前にここへ書き込む。
 */
const jobControls = new Map();

/** jobIdの制御レコードを取得(無ければ作る)。 */
function getControl(jobId) {
  let c = jobControls.get(jobId);
  if (!c) {
    c = { child: null, cancelRequested: false, terminalReason: null };
    jobControls.set(jobId, c);
  }
  return c;
}

/** ジョブの制御レコードを破棄する。ジョブの(再)開始時・終端到達時に呼ぶ。 */
function resetControl(jobId) {
  jobControls.delete(jobId);
}

/**
 * AUD-P1-11a: 子プロセスを起動しないステージ(AI字幕校正・顔モザイク等)の合間でも
 * キャンセル要求を汲み取れるよう、各ステージの開始直前に呼ぶチェックポイント。
 * cancelRequested済みならその場で 'cancelled' を投げ、以降のステージへ進ませない
 * (spawnAndLog自身も同様のチェックを持つが、spawnAndLogを経由しないステージは
 * このチェックポイントが無いとキャンセルに気付けないまま最後まで走ってしまう)。
 */
function throwIfCancelled(jobId) {
  const c = jobControls.get(jobId);
  if (c && c.cancelRequested) {
    const err = new Error("ユーザーによりキャンセルされました");
    err.code = "cancelled";
    throw err;
  }
}

/**
 * 子プロセス(のプロセスツリー全体)を殺す。
 * AUD-P1-11a/11b: 「直接の子だけ」kill すると、ffmpeg 等が spawn した孫プロセスが
 * 生き残ってしまう(監査指摘)。POSIXでは spawnAndLog が detached:true で子を
 * 独立プロセスグループのリーダーにしているため、`-pid`(負のPID)を kill すると
 * そのグループに属する子孫プロセスもまとめて終了できる。Windowsではプロセスグループの
 * 概念が異なるため taskkill の /T(ツリー) オプションで代替する。
 * まず SIGTERM で行儀よく止め、一定時間後もまだ生きていれば SIGKILL で強制終了する。
 */
function killChildTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const send = (signal) => {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        process.kill(-child.pid, signal);
      }
    } catch (_) {
      // 既に終了している(ESRCH)等は無視。killChildTreeは「止まっていてほしい」という
      // 意思表示であり、既に死んでいるなら目的は達成済み。
    }
  };
  send("SIGTERM");
  // SIGTERMに応じない(ハングしたffmpeg等)場合の保険。グレースピリオド後にSIGKILLへ。
  const killer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    send("SIGKILL");
  }, 3000);
  killer.unref();
}

/**
 * ジョブをキャンセルする(AUD-P1-11a: 手動キャンセルAPI)。
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || !RUNNING_STAGES.includes(job.stage)) {
    return { ok: false, reason: "実行中のジョブではありません" };
  }
  const c = getControl(jobId);
  c.cancelRequested = true;
  c.terminalReason = "cancelled";
  if (c.child) killChildTree(c.child);
  return { ok: true };
}

/** ジョブとして終端状態を意味するイベント名一覧(SSE接続を閉じる基準)。 */
const TERMINAL_EVENTS = ["job-error", "done", "cancelled", "timeout"];

/** SSE イベントを購読者全員に push。error/done/cancelled/timeout は接続も close する */
function broadcast(jobId, payload, event = null) {
  const job = jobs.get(jobId);
  if (!job) return;
  const line = event
    ? `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    : `data: ${JSON.stringify(payload)}\n\n`;
  // AUD-P1-10c: 「今どの段階が進行中か」を表す進捗行(status付き・ログ行ではない)だけを
  // 直近スナップショットとして憶えておく。これがあると、(a) POST応答からEventSource接続
  // までの間に飛んだ進捗、(b) 切断中に飛んだ進捗を、後から購読した相手へ即座に届けられる
  // （購読者0人の間にbroadcastしても、下のforは何もせず素通りして消えてしまうため）。
  if (payload && payload.status && !event) {
    job.lastEvent = line;
  }
  for (const sub of job.subscribers) {
    try {
      sub.push(line);
    } catch (_) {
      // 切断済み購読者は無視
    }
  }
  // AUD-P1-10b: 終端イベント(job-error / done / cancelled / timeout)は全購読者の SSE 接続を
  // 閉じて Set をクリアする。業務エラーの wire イベント名は"error"ではなく"job-error"を使う。
  // EventSourceは接続断などのネイティブ"error"と、サーバーが"event: error"という名前で送った
  // 独自イベントを、クライアント側では同じ addEventListener("error", ...) が受け取ってしまい
  // 区別できない(前者は再接続すべき一時的な障害、後者は再接続しても無意味な終端)ため、
  // 名前を分けてクライアントがネイティブerrorだけを伝送エラーとして扱えるようにする。
  if (TERMINAL_EVENTS.includes(event)) {
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
 *
 * AUD-P1-03a/03b: 本編ジョブ(jobs Map)だけでなく、焼き直し(recaption)中/焼き直し待ち
 * （concurrencyGateで順番待ち）のジョブIDも含める。recaptioningJobs は
 * beginRecaption()〜endRecaption() の間、その2状態(実行中・共有ゲートで待機中)の両方に
 * わたって当該jobIdを保持し続けるため(server/index.mjsのhandleRecaptionはbeginRecaption→
 * runGated→endRecaptionの順で呼ぶ)、ここに含めるだけで両方をまとめて保護できる。
 * 含めていないと、焼き直し中/焼き直し待ちのジョブがTTLを過ぎていた場合にwork/outputの
 * ディレクトリごと掃除で消えてしまい、実行中の焼き直しが入出力ファイルを失って壊れる。
 */
export function activeJobIds() {
  const ids = new Set();
  for (const [id, job] of jobs) {
    if (RUNNING_STAGES.includes(job.stage)) ids.add(id);
  }
  for (const id of recaptioningJobs) {
    ids.add(id);
  }
  return [...ids];
}

/** サーバー再起動時にクライアントへ伝える、ジョブが中断された旨のメッセージ(P1-6)。 */
const INTERRUPTED_MESSAGE = "サーバーが再起動したため、処理が中断されました。お手数ですが、もう一度実行してください。";

/** ジョブの state.json を読む（無ければ null）。subscribeJob (AUD-P2-16) から参照するため
 *  ここ(subscribeJobより前)で宣言する。 */
function readState(workDir) {
  const sp = path.join(workDir, "state.json");
  if (!fs.existsSync(sp)) return null;
  return JSON.parse(fs.readFileSync(sp, "utf-8"));
}

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
    // AUD-P2-16: メモリのjobs Mapに無いからといって無条件で"interrupted"を合成しない。
    // このプロセスが一度もこのジョブを起動していない(=以前のプロセス、または再起動後の
    // 再接続)場合でも、work/<jobId>/state.jsonが実際に終端(done/error/cancelled/timeout)
    // まで到達していれば、その事実を優先してリプレイする。state.jsonが処理途中のstageの
    // まま止まっている(=書き込みが止まっている＝プロセスが死んだ証拠)場合や、
    // state.json自体が無い(このジョブを誰も一度も起動していない)場合だけ、
    // 従来どおり本当に「中断された」ものとして扱う。
    const disk = readState(path.join(WORK_ROOT, jobId));
    const diskStage = disk?.stage;
    if (diskStage === "done") {
      jobs.set(jobId, { stage: "done", subscribers: new Set(), error: null, errorCode: null, lastEvent: null });
    } else if (diskStage === "error" || diskStage === "cancelled" || diskStage === "timeout") {
      jobs.set(jobId, {
        stage: diskStage,
        subscribers: new Set(),
        error: disk.error || null,
        errorCode: disk.errorCode || null,
        lastEvent: null,
      });
    } else {
      jobs.set(jobId, { stage: "interrupted", subscribers: new Set(), error: null, errorCode: null, lastEvent: null });
    }
  }
  const job = jobs.get(jobId);
  const sub = { push, close };
  job.subscribers.add(sub);

  // race condition 対策: 既に終了済み/中断済みならリプレイして即通知
  if (job.stage === "error") {
    // AUD-P1-10b: wireのイベント名は job-error（内部の job.stage==="error" とは別物）。
    try { push(`event: job-error\ndata: ${JSON.stringify({ message: job.error || "処理に失敗しました", code: job.errorCode || null })}\n\n`); } catch (_) {}
    try { close(); } catch (_) {}
    job.subscribers.delete(sub);
  } else if (job.stage === "done") {
    try { push(`event: done\ndata: ${JSON.stringify({ stage: "done" })}\n\n`); } catch (_) {}
    try { close(); } catch (_) {}
    job.subscribers.delete(sub);
  } else if (job.stage === "cancelled" || job.stage === "timeout") {
    // AUD-P1-11a/11b: キャンセル/タイムアウトで終端したジョブへの再接続も、error/done と
    // 同じくリプレイして即通知する(でなければ再接続した購読者だけ永久に何も受け取れない)。
    try {
      push(`event: ${job.stage}\ndata: ${JSON.stringify({ message: job.error || null, code: job.errorCode || null })}\n\n`);
    } catch (_) {}
    try { close(); } catch (_) {}
    job.subscribers.delete(sub);
  } else if (job.stage === "interrupted") {
    try { push(`event: interrupted\ndata: ${JSON.stringify({ message: INTERRUPTED_MESSAGE })}\n\n`); } catch (_) {}
    try { close(); } catch (_) {}
    job.subscribers.delete(sub);
  } else if (job.lastEvent) {
    // AUD-P1-10c: まだ実行中(init/t/c/s/r/m)のジョブへの購読。POST応答〜EventSource接続の
    // 間や、切断していた間に進捗が進んでいても、次の進捗が飛んでくるまで画面が更新されない
    // (=見逃した進捗が復旧しない)。直近のスナップショットを接続直後に1回だけ届け、
    // 見た目上の状態を現在地へ追いつかせる。
    try { push(job.lastEvent); } catch (_) {}
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

/**
 * ジョブの state.json を書く。
 * P2-1: 直接 truncate 書込みだと、書いている途中でプロセスが落ちたときに state.json が
 * 壊れて読めなくなる（ジョブが再開できなくなる）。writeJsonAtomically で
 * 「同じディレクトリの一時ファイルへ書く→fsync→rename」の作法にする。
 */
function writeState(workDir, state) {
  writeJsonAtomically(path.join(workDir, "state.json"), state);
}

/**
 * AUD-P2-16: state.json への更新を「読む→マージ→原子書き込み」の一本道に集約する。
 *
 * 旧実装は runJob() が起動時に作った1個のJSオブジェクト(state)を関数の間ずっと使い回し、
 * 各ステージ完了ごとに `state.stage = "..."; writeState(workDir, state);` で丸ごと
 * 上書きしていた。ところが `node pipeline.mjs select/render` は**別プロセス**であり、
 * それ自身が state.json を読み書きして digestMeta・candidates 等のフィールドを
 * 書き加える(pipeline.mjs の saveState 参照)。子プロセスの書き込み**後**に、
 * pipeline-runner.mjs 側の「子プロセスが何を書いたか知らない・起動時のまま古い」
 * インメモリの state オブジェクトを丸ごと書き戻すと、子プロセスが追加したフィールドが
 * 消える(監査指摘: 「a stale in-memory state object gets written back over fields a
 * child process added」)。
 *
 * 対策: 各更新のたびに、その時点のディスク上の state.json を読み直し(=子プロセスが
 * 書いたものを含む最新の状態)、そこへ今回のパッチだけをマージしてから書き戻す。
 * これにより、どのフィールドを最後に触ったのが誰であっても(このプロセス自身でも
 * 別の子プロセスでも)、上書きで消えることがなくなる。
 *
 * @param {string} workDir
 * @param {object} patch 上書きしたいフィールドのみ
 * @returns {object} マージ後の完全なstateオブジェクト(呼び出し側が参照したい場合用)
 */
function updateState(workDir, patch) {
  const current = readState(workDir) || {};
  const merged = { ...current, ...patch };
  writeState(workDir, merged);
  return merged;
}

// P1-14-A: パイプラインの子(python/node)へ渡してよい環境変数の基本allowlist。
// claude起動口(src/claude-safety.mjs ALLOWED_ENV_VARS)より広いのは、python/nodeの実行系・
// ライブラリ解決・モデルキャッシュに必要な変数を含むため(APIキー等の秘密情報は含めない)。
//
// 【allowlistが2つある構造と、そこに空いていた穴】この関所を通った先で claude が起動する経路が
// ある。「分数で切る(digest)」は server → node(pipeline.mjs) → digest-editor → claude と孫まで
// 潜るため、claude の env は「ここで絞られた後の process.env」を claude-safety.mjs が更に絞った
// 結果になる。2026-08-15 に claude-safety.mjs 側へ Windows 用の変数を足したとき、こちらは
// POSIX 名のままで、この経路の claude へ渡るのが PATH/TMP/TEMP の3個だけになっていた
// (Windows の PowerShell は HOME を定義しないため)。片方だけ直すと、もう片方が黙って残る。
// tests/claude-safety-win-env-check.mjs が **両方の allowlist** を対照表と突き合わせて見張る。
const BASE_CHILD_ENV_VARS = [
  "PATH", "HOME", "LANG", "LC_ALL", "LANGUAGE", "USER",
  "TMPDIR", "TMP", "TEMP",
  "PYTHONPATH", "PYTHONIOENCODING", "PYTHONUNBUFFERED", "VIRTUAL_ENV",
  "NODE_PATH",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "HF_HOME", "HUGGINGFACE_HUB_CACHE", // faster-whisperモデルキャッシュの置き場所
  // ── Windows 用（POSIX 環境には存在しないので、そちらでは自動的に無視される）──
  // 内訳の根拠は src/claude-safety.mjs の ALLOWED_ENV_VARS 側コメントと
  // WINDOWS_MINIMUM_ENV_VARS(Claude Code CLI 自身が定める Windows 最小集合)を参照。
  "USERPROFILE", "SystemRoot", "windir", "APPDATA", "LOCALAPPDATA",
  "SystemDrive", "HOMEDRIVE", "HOMEPATH",
  "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
  "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "USERNAME",
  // COMSPEC/PATHEXT: Windows で python/node をシェル経由・拡張子解決つきで起こす経路が要る。
  "COMSPEC", "PATHEXT",
];

/** 両方のallowlistをテストから突き合わせられるようexportする（片方だけ直す事故の再発防止）。 */
export { BASE_CHILD_ENV_VARS };

/** allowlist(+呼び出しごとの追加キー)だけを含むenvを作る。単体テストのためexportする。 */
export function buildChildEnv(extraKeys = []) {
  const env = {};
  for (const key of [...BASE_CHILD_ENV_VARS, ...extraKeys]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/**
 * P1-14-B/C: 子の出力・エラーメッセージから伏字にすべき秘密情報の実値一覧。
 *
 * 【2026-08-17 の是正（SEC-ENV-REDACT）】旧実装は process.env しか見ていなかった。
 * groqKeyAvailable() は「鍵が .env にしかない」運用（サーバ起動後に .env を置く）を
 * 正規の運用として前提しているのに、ここは env に無い鍵を伏字化できていなかった＝
 * その運用のとき、失敗時の SSE・state.json へ生の鍵が出ていた。
 *
 * env と .env の両方を並べる（env を優先して片方だけ返す形にはしない）。env に古い鍵・
 * .env に現用鍵がある状態で、片方だけ伏字化から漏れることを防ぐため。ANTHROPIC_API_KEY も
 * 対象に含める（redactSecrets() は4文字未満の値を無視するので、空値混入による誤爆は無い）。
 * 呼び出しごとに .env を読み直す（キャッシュしない）＝サーバ起動後に鍵を置く運用でも
 * 次のジョブから守られる。
 */
function secretsToRedact() {
  return [
    process.env.GROQ_API_KEY,
    readEnvFileValue("GROQ_API_KEY"),
    process.env.ANTHROPIC_API_KEY,
    readEnvFileValue("ANTHROPIC_API_KEY"),
  ].filter(Boolean);
}
export { secretsToRedact };

/**
 * ステージ単位のタイムアウト(ms)。既定30分。VS_STAGE_TIMEOUT_SECONDSで秒単位で上書きできる
 * (0以下・非数は既定へ)。AUD-P1-11b: ハングした子プロセス(ffmpeg/ffprobe/文字起こし等)を
 * 誰もキャンセルしなくても自動的に打ち切るための上限。spawnAndLog経由の各ステージ
 * (transcribe.py / node pipeline.mjs select / node pipeline.mjs render)それぞれに
 * 個別に適用される(ステージが変わるたびタイマーはリセットされる＝ジョブ全体ではなく
 * 「今動いている1本の子プロセス」が単位)。
 */
export function resolveStageTimeoutMs(envValue = process.env.VS_STAGE_TIMEOUT_SECONDS) {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n * 1000 : 30 * 60 * 1000;
}
const STAGE_TIMEOUT_MS = resolveStageTimeoutMs();

/**
 * 子プロセスを spawn し、stderr を行単位で onLine に渡す。
 * 終了コード 0 以外は reject。
 *
 * AUD-P1-05a/05b: 秘密情報(APIキー等)が2つのdataイベント(チャンク)の境目で分割されて
 * 出力されると、チャンク単位で独立に伏字化してから連結する旧方式では伏字化を素通りして
 * しまう。stdout/stderr それぞれに createStreamingRedactor() を1つずつ持たせ、チャンクを
 * またいで秘密情報の出現を検出できるようにする(ストリームが終わったら flush() で
 * 保持していた末尾も確定させる)。さらに、close 時にreject する Error.message
 * （state.jsonのerrorフィールド・SSEのevent:errorへ伝播する経路の入り口）を組み立てる
 * 直前にも念のためもう一度 redactSecrets を掛け、防御を二重化する(万一ストリーミング側の
 * 境界計算に取りこぼしがあっても、この最終防波堤で捕まえる)。
 *
 * AUD-P1-11a/11b: jobIdを渡すと、そのジョブの制御レコード(jobControls)へ実行中の
 * 子プロセスを登録する。これにより cancelJob() からプロセスツリーごと kill できる
 * (P1-11a)。あわせて STAGE_TIMEOUT_MS を過ぎても終わらない場合は自動的に同じ kill 経路へ
 * 入り、'timeout' として reject する(P1-11b＝誰もキャンセルしなくても自動的に打ち切られる)。
 * jobId が既に cancelRequested 済みなら、そもそも子プロセスを起動せず即座に reject する
 * (キューで順番待ち中にキャンセルされたジョブが、自分の番が来た瞬間に新しい子を
 * 起動してしまうのを防ぐ)。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ envExtra?: string[], jobId?: string, [key: string]: any }} opts envExtra は
 *   この呼び出しに限りallowlistへ追加する環境変数キー(例: transcribe.pyのGROQ_API_KEY)。
 *   jobId を渡すとキャンセル/タイムアウト管理の対象になる(渡さない呼び出しは対象外)。
 * @param {(line: string) => void} onLine
 */
function spawnAndLog(cmd, args, opts, onLine) {
  const { envExtra, jobId, ...restOpts } = opts || {};
  return new Promise((resolve, reject) => {
    const control = jobId ? getControl(jobId) : null;
    if (control && control.cancelRequested) {
      const err = new Error("ユーザーによりキャンセルされました");
      err.code = "cancelled";
      return reject(err);
    }
    const child = spawn(cmd, args, {
      env: buildChildEnv(envExtra),
      windowsHide: true,
      // AUD-P1-11a: POSIXでは独立プロセスグループのリーダーにし、killChildTree()が
      // グループごと(孫プロセス含め)止められるようにする。Windowsではこのオプションは
      // 新コンソールの意味になり別の副作用があるため付けない(taskkill /T で代替する)。
      detached: process.platform !== "win32",
      ...restOpts,
    });
    if (control) control.child = child;
    let stageTimer = null;
    if (control && STAGE_TIMEOUT_MS > 0) {
      stageTimer = setTimeout(() => {
        control.terminalReason = "timeout";
        killChildTree(child);
      }, STAGE_TIMEOUT_MS);
      stageTimer.unref();
    }
    const secrets = secretsToRedact();
    const stderrRedactor = createStreamingRedactor(secrets);
    const stdoutRedactor = createStreamingRedactor(secrets);
    // AUD-P2-25: errBufは異常終了時のError.message組み立てにしか使わず、実際に使うのは
    // 末尾で `.slice(0, 400)` した先頭400文字だけ(下のclose参照)。旧実装はここへ
    // stderr全量を無制限に連結し続けており、長時間・大量に出力する子プロセスが
    // 異常終了せずに走り続けると、この文字列だけでプロセスのメモリを際限なく食う
    // (監査指摘)。使われるのは先頭部分だけなので、上限に達したら以後は溜めない。
    const ERR_BUF_CAP = 8192;
    let errBuf = "";
    const emitErrText = (text) => {
      if (!text) return;
      if (errBuf.length < ERR_BUF_CAP) {
        errBuf += text.slice(0, ERR_BUF_CAP - errBuf.length);
      }
      text.split("\n").forEach((ln) => {
        if (ln.trim()) onLine(ln.trim());
      });
    };
    const emitOutText = (text) => {
      if (!text) return;
      text.split("\n").forEach((ln) => {
        if (ln.trim()) onLine(`[stdout] ${ln.trim()}`);
      });
    };
    child.stderr.on("data", (chunk) => {
      emitErrText(stderrRedactor.push(chunk.toString()));
    });
    // stdout も受け取る（pipeline.mjs が stdout に出力する場合あり）
    child.stdout.on("data", (chunk) => {
      emitOutText(stdoutRedactor.push(chunk.toString()));
    });
    child.on("error", (err) => {
      if (stageTimer) clearTimeout(stageTimer);
      reject(new Error(`spawn error: ${err.message}`));
    });
    child.on("close", (code, signal) => {
      if (stageTimer) clearTimeout(stageTimer);
      if (control && control.child === child) control.child = null;
      // ストリームが終わったので、まだ確定させていなかった末尾(境界待ちの保持分)を出す。
      emitErrText(stderrRedactor.flush());
      emitOutText(stdoutRedactor.flush());
      // AUD-P1-11a/11b: cancelJob()/タイムアウトのどちらかが既にこの子を殺しにいっていれば、
      // 通常の「終了コード0以外」エラーではなく、code/'cancelled'/'timeout'として reject する。
      const reason = control && control.terminalReason;
      if (reason === "cancelled" || reason === "timeout") {
        const err = new Error(
          reason === "cancelled"
            ? "ユーザーによりキャンセルされました"
            : `処理が制限時間(${Math.round(STAGE_TIMEOUT_MS / 1000)}秒)を超えたため自動的に打ち切られました`
        );
        err.code = reason;
        return reject(err);
      }
      if (code !== 0) {
        // errBuf は上でチャンクをまたいで伏字化済みだが、Error.message はこの後
        // state.json永続化(P1-14-C)・SSE配信(P1-14-B)の両方の入り口になるため、
        // 多層防御としてここでもう一度 redactSecrets を掛ける(AUD-P1-05a/05b)。
        return reject(
          new Error(
            `${cmd} 終了コード ${code}${signal ? `(signal ${signal})` : ""}。stderr: ${redactSecrets(errBuf, secrets).slice(0, 400)}`
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
// 2026-08-16: 画面(GET /api/env)へ「文字起こしがどこで行われるか」を出すためにも使う。
// 鍵そのものは返さない＝有無(真偽)だけを外へ出す。
export function groqKeyAvailable() {
  // .env の読み取りは src/env-file.mjs（readEnvFileValue）に統合済み。ここは
  // env → .env の優先順位を適用するだけ（Python 側 transcribe_groq.py / check-groq-key.py の
  // load_key() と同じ優先順位を保つこと。docstring 参照）。
  return Boolean(process.env.GROQ_API_KEY) || readEnvFileValue("GROQ_API_KEY") !== null;
}

/**
 * 文字起こし(transcribe.py)の stderr 1行から「実際に使ったバックエンド」を読み取る。
 * 該当しない行なら null（＝直前の判定を変えない）。
 *
 * 【なぜ鍵の有無ではなく stderr を読むのか】鍵があることと Groq を使えたことは別物である。
 * 鍵の有無からの先読みで "groq" を送ると、Groq が失敗してローカルへ落ちた回にも画面は
 * Turbo（クラウドで処理中の印）を出したままになり、**表示と実態が食い違う**。
 * これは過去に「処理先の表示」がマスター指示で廃止された理由そのもの
 * （docs/roadmap.html の G-UI-BACKEND-NOTE-TRUTH）。実際に動いた側だけを画面へ流す。
 *
 * 読み取る文言は src/transcribe.py の main() が出す2行（あちらにも同じ契約を明記してある）:
 *   "[INFO] backend=groq" / "[INFO] backend=local"
 *   "[WARN] Groq 失敗→local フォールバック: ..."
 * @param {string} line
 * @returns {"groq"|"local"|null}
 */
export function parseBackendFromLog(line) {
  if (typeof line !== "string") return null;
  const decided = line.match(/\[INFO\]\s*backend=(groq|local)\b/);
  if (decided) return decided[1];
  // フォールバック＝ここから先はローカル。Groq のままだと嘘になるので必ず訂正する。
  if (/\[WARN\]\s*Groq\s*失敗\s*→\s*local\s*フォールバック/.test(line)) return "local";
  return null;
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

/** groq経路の待ち行列(順番待ち・実行中を除く)の現在長。AUD-P2-20bのテスト用に公開する。 */
export function queueWaitingCount() {
  return concurrencyGate.waiting;
}

/**
 * AUD-P2-20b: 順番待ちキューの長さ上限（純粋関数・テスト用に切り出し）。既定20。
 * VS_MAX_QUEUE_LENGTHで上書きできる(1未満・非数は既定へ)。
 *
 * 旧実装は待ち行列(groq経路のconcurrencyGate内部キュー・local経路のlocalQueue)に
 * 上限が無く、投入され続けると際限なく伸びた(監査指摘)。上限に達したら新規投入自体を
 * 4xxで拒否する(キューへ積まずに即座に断る＝黙って溜め込まない)。
 */
export function resolveMaxQueueLength(envValue = process.env.VS_MAX_QUEUE_LENGTH) {
  const n = Number(envValue);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20;
}
const MAX_QUEUE_LENGTH = resolveMaxQueueLength();

// P1-13-B: 焼き直し(recaption)は同一ジョブへの並列連打だと一時ファイル名がジョブ固定のため
// 競合する。また、焼き直しはこれまでconcurrencyGateの対象外でffmpegを無制限にspawnできた。
// 本編ジョブと同じゲートを共有させ、同時実行数の上限を一本化する。
// (recaptioningJobs 本体の宣言は activeJobIds() より前・ファイル冒頭側にある。)

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
 * アップロード（端末→サーバーへの動画の送信）に掛かった時間を timing.json へ残す。
 *
 * 送信そのものは HTTP 層（server/index.mjs）で起き、この関数が呼ばれる時点では既に
 * 終わっている。開始時刻を後から知る手段は、受け取ったファイル自身の作成時刻しかないので、
 * 「作成時刻（＝本文の1バイト目を書いた瞬間）〜最終更新時刻（＝書き終えた瞬間）」で確定する。
 *
 * 【この計測の限界（正直に書く）】作成時刻(birthtime)を持たないファイルシステムでは、Node が
 * birthtime に ctime を代入することがある。その場合この値は 0 秒に潰れる＝「速かった」のか
 * 「取れなかった」のか区別が付かない。逆向き（実際より長く出る）ことは無いので、
 * 0 秒が出たときは「アップロードは遅さの原因ではない」と断定せず、他の工程を見ること。
 */
function recordUploadTiming(workDir, inputAbsPath) {
  try {
    const st = fs.statSync(inputAbsPath);
    stageSetSpan(workDir, "upload", st.birthtimeMs, st.mtimeMs);
  } catch (e) {
    // 計測は補助。入力が消えている等でここが失敗しても本処理は止めない
    // （本当に入力が無ければ、この直後の文字起こしが本来の理由で失敗する）。
    process.stderr.write(`[WARN] アップロード時間の記録に失敗（計測スキップ）: ${e.message}\n`);
  }
}

/**
 * ジョブ実行開始（非同期・kick して即返す）
 *
 * @param {string} jobId
 * @param {string} inputAbsPath - 保存済みの入力動画絶対パス
 * @param {{ sub: "on"|"none", cut: "topic"|"minutes", size: "9:16"|"16:9", cutMin?: number }} opts
 * @returns {true|false|"queue_full"} true=受理, false=同一jobId実行中で拒否(409),
 *   "queue_full"=AUD-P2-20b: 待ち行列が上限に達しているため拒否(呼び出し側は4xxで断ること)。
 */
export function startJob(jobId, inputAbsPath, opts) {
  // 走行中ガード: 同一 jobId が実行中（init/t/c/s/r/m）なら二重起動を拒否。
  // 完了済（done/error/cancelled/timeout）や購読のみ（unknown）は再起動を許可（同じ動画の再編集）。
  const existing = jobs.get(jobId);
  if (existing && RUNNING_STAGES.includes(existing.stage)) {
    return false;
  }
  // AUD-P2-20b: どちらの経路(groq/local)を使うかで見るべき待ち行列が違う。
  // ジョブ登録・制御レコード初期化より前に判定し、上限超過時は何も変更せず即座に断る
  // (キューへ積んでから断ると「積んだのに拒否された」という不整合が起きる)。
  const willUseGroq = groqKeyAvailable();
  const currentQueueLength = willUseGroq ? concurrencyGate.waiting : localQueue.length;
  if (currentQueueLength >= MAX_QUEUE_LENGTH) {
    return "queue_full";
  }
  // AUD-P1-11a/11b: 前回の実行(キャンセル/タイムアウト/エラー)の制御レコードが残っていると、
  // 新しい実行が「まだキャンセル済みのまま」扱いされて子プロセスを一切起動できなくなる。
  // 開始のたびに必ずクリアする。
  resetControl(jobId);
  if (!existing) {
    jobs.set(jobId, { stage: "init", subscribers: new Set(), error: null, errorCode: null, lastEvent: null });
  } else {
    // 購読者（SSE）は保持したまま状態だけリセットして再実行
    existing.stage = "init";
    existing.error = null;
    existing.errorCode = null;
    // AUD-P1-10c: 前回実行分の古いスナップショットを持ち越さない(再実行直後に新規購読が
    // 来た場合、前回ジョブの進捗を新しいジョブの状態として誤って見せてしまうのを防ぐ)。
    existing.lastEvent = null;
  }
  // 非同期で実行（エラーは exec 内で処理し reject させない＝キュー drain を止めない）
  const workDir = path.join(WORK_ROOT, jobId);
  // 工程計測の起点。ここまで（アップロード）と、ここから実行開始まで（順番待ち）を残す。
  // 画面経路は「送信」と「順番待ち」がジョブ全体の所要時間に含まれるのに、これまで
  // 一切計測されておらず、遅さの切り分けから丸ごと外れていた。
  recordUploadTiming(workDir, inputAbsPath);
  stageStart(workDir, "queue-wait");
  const exec = () =>
    runJob(jobId, inputAbsPath, opts).then(
      () => {
        // AUD-P1-11a/11b: 正常終了した(=もうこのジョブをキャンセル/タイムアウトさせる対象では
        // ない)ので、制御レコードを片付ける(残しておくと次回実行時までメモリに残り続ける)。
        resetControl(jobId);
      },
      (err) => {
        process.stderr.write(`[pipeline error] jobId=${jobId} ${err?.stack ?? err}\n`);
        // AUD-P1-05a/05b: SSE配信(broadcast)・state.json永続化(writeState)の直前に、
        // それぞれ念のためもう一度 redactSecrets を掛ける(多層防御)。spawnAndLog側の
        // ストリーミング伏字化(chunk境界対応)が主たる修正だが、err.messageはpipeline.mjs等
        // 別経路のエラー（子プロセスのspawn自体の失敗メッセージ等）から来る場合もあり、
        // ここが「SSEへ出る/state.jsonへ書かれる直前」の最後の関門になる。
        const safeMessage = redactSecrets(err?.message ?? String(err), secretsToRedact());
        // AUD-P1-11a/11b: cancelJob()や自動タイムアウトで終わった場合は、汎用の"error"ではなく
        // 専用の終端stage/イベント("cancelled"/"timeout")として区別する。フロントや
        // 監視側が「利用者の意思によるキャンセル」「自動打ち切り」「本当の失敗」を
        // 見分けられるようにするため。
        const terminalStage =
          err?.code === "cancelled" ? "cancelled" : err?.code === "timeout" ? "timeout" : "error";
        const job = jobs.get(jobId);
        if (job) {
          job.stage = terminalStage;
          job.error = safeMessage;
          job.errorCode = err?.code ?? null;
          // AUD-P2-20a: 終端到達時刻を記録する(reclaimTerminalJobsの保持期間判定に使う)。
          job.terminatedAt = Date.now();
        }
        // G-EDIT-MOSAIC-UI-O-2: 失敗をメモリ上の job.stage だけでなく state.json にも残す。
        // ここを書かないと、途中まで（例: rendered）進んだ state.json が最後に書いた
        // 成功段階のまま残り、サーバー再起動後に読み直すと成功したジョブに見えてしまう
        // （メモリの job.stage は再起動で消える一方、state.json はディスクに残るため）。
        // state.json がまだ一度も書かれていない（init 前に落ちた等）場合は空オブジェクトを土台にする。
        // AUD-P2-16: ここも updateState (読む→マージ→原子書き込み) に統一する。
        try {
          updateState(workDir, {
            stage: terminalStage,
            error: safeMessage,
            errorCode: err?.code ?? null,
          });
        } catch (writeErr) {
          process.stderr.write(
            `[pipeline error] state.json への失敗記録に失敗 jobId=${jobId} ${writeErr?.stack ?? writeErr}\n`
          );
        }
        // AUD-P1-10b: state.json/job.stage は内部的に "error" のままだが、SSE の wire イベント名は
        // ネイティブEventSourceの"error"と衝突しない"job-error"へ変換する(cancelled/timeoutはそのまま)。
        broadcast(jobId, { message: safeMessage, code: err?.code ?? null }, terminalStage === "error" ? "job-error" : terminalStage);
        // 制御レコードは既に使い終えたので片付ける(cancelJob()の対象から外れる)。
        resetControl(jobId);
      }
    );
  if (willUseGroq) {
    // Groq: 並列実行（クラウド側で並列処理される）。ただし同時実行数の上限までで、
    // 超過分はconcurrencyGateがFIFOで順番待ちにする(P2-4-C。上限はAUD-P2-20bで別途判定済み)。
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

/** 文字起こし中の進捗ラベル。backend の訂正イベントでも同じ文言を使い回す（画面の文言が
 *  訂正のたびに揺れないようにするため）。画面側 EDITING_LABEL.t と同じ文言に揃えてある。 */
const TRANSCRIBE_LABEL = "話し言葉を文字にしています";

/** レンダリングstageの進捗ラベルをorientに応じて出し分ける（縦長/横長） */
export function renderLabel(orient) {
  return orient === "landscape" ? "横長の動画に整えています" : "縦長の動画に整えています";
}

/**
 * node pipeline.mjs render の argv 組み立て（G-EDIT-UI-SETTINGS-WIRING-SERVER）。
 * 設定を1つずつ数え上げる書き方（renderArgs.push(...)を呼び出し側に並べる）は、設定を
 * 1つ足すたびに結線を忘れる事故を過去2回起こしている（顔モザイク・つなぎ目の間。
 * docs/failures.md 2026-08-14）。ここへ集約し、戻り値のargvを検査から直接実測できる
 * 純粋関数にすることで、結線漏れを機械的に検出できるようにする。
 *
 * @param {string} pipelinePath pipeline.mjs の絶対パス（PIPELINE_MJS相当）
 * @param {string} workDir ジョブの作業ディレクトリ
 * @param {object} opts startJob() へ渡されるものと同じ形。sub/mode/breath/subStyle/
 *   captionFont/captionFill/captionOutlineColor/captionInner/captionBand/captionPos/exportPreset/
 *   durationMin を含みうる（すべて任意）。
 * @returns {string[]} spawn("node", argv) にそのまま渡せるargv配列
 */
export function buildRenderArgs(pipelinePath, workDir, opts) {
  const noSub = opts.sub === "none";
  const { mode } = resolveJobSettings(opts);

  const renderArgs = [pipelinePath, "render", workDir, "--mode", mode];
  if (noSub) renderArgs.push("--no-sub");
  // つなぎ目に戻す息継ぎの間（G-EDIT-BREATH-SERVER）。渡し忘れると、画面から選んでも
  // 常に既定 0.7 秒固定になり off にもできない（trim/mosaic と同じ結線の取りこぼし）。
  if (opts.breath) renderArgs.push("--breath", String(opts.breath));
  // 「間を詰める」の2つのつまみ（G-EDIT-TRIM2）。渡し忘れると、画面で片方だけ選んでも
  // 両方効く／両方効かないという、選べるのに効かない状態になる。
  if (opts.trimSilence) renderArgs.push("--trim-silence", String(opts.trimSilence));
  if (opts.trimFiller) renderArgs.push("--trim-filler", String(opts.trimFiller));
  if (opts.subStyle) renderArgs.push("--sub-style", String(opts.subStyle));
  if (opts.captionFont) renderArgs.push("--caption-font", String(opts.captionFont));
  if (opts.captionFill) renderArgs.push("--caption-fill", String(opts.captionFill));
  if (opts.captionOutlineColor) renderArgs.push("--caption-outline-color", String(opts.captionOutlineColor));
  if (opts.captionInner) renderArgs.push("--caption-inner", String(opts.captionInner));
  if (opts.captionBand) renderArgs.push("--caption-band", String(opts.captionBand));
  // 字幕の縦位置（G-UI-CAPPOS）。0（画面の一番下）も正当な指定なので、真偽ではなく
  // 「指定されたか」で判定する。truthy 判定にすると 0 だけ黙って落ちる。
  if (opts.captionPos !== undefined && opts.captionPos !== null && opts.captionPos !== "") {
    renderArgs.push("--caption-pos", String(opts.captionPos));
  }
  if (opts.exportPreset) renderArgs.push("--export", String(opts.exportPreset));
  if (opts.durationMin) renderArgs.push("--duration-min", String(opts.durationMin));

  return renderArgs;
}

/** 実際の段階実行（内部・エラーは呼び元でキャッチ） */
async function runJob(jobId, inputAbsPath, opts) {
  const workDir = path.join(WORK_ROOT, jobId);
  const noSub = opts.sub === "none";
  const { mode, orient, targetMinutes } = resolveJobSettings(opts);

  // 順番待ち（受理〜実行開始）はここで終わり。以降が実際の処理時間になる。
  stageEnd(workDir, "queue-wait");

  // 字幕ありの場合、文字起こし（数分〜数十分かかる）を始める前に、使うフォントが
  // 実際にこの環境にあるかを確認する(pipeline.mjs cmdInit と同じ判定・M3)。
  // 旧実装はこのチェックが pipeline.mjs init だけにあり、画面(HTTP)経路は init を呼ばず
  // 直接 transcribe.py を起動するため、この関門を素通りしていた
  // (M7 3経路E2Eで発覚。docs/failures.md 2026-08-14)。
  if (!noSub) {
    // 2026-08-15: 旧実装は checkFontAvailable(DEFAULT_FONT="IPAGothic") を見ていた。これは
    // (a) fc-list(fontconfig)を必要とし Windows では原理的に成立しない (b) そもそも実際に
    // 焼かれるのは同梱フォント(resolveCaptionStyle が DEFAULT_FONT_KEY="kaku" へ解決し、
    // render-vertical が fontsdir=src/fonts を渡す)で、IPAGothic は使われない、という
    // 二重の誤りだった。マスターの手元Windowsで「字幕あり」が常に失敗していた。
    // 実際に使う同梱フォントのファイル実在を見る形へ改める(OS非依存)。
    const fontCheck = checkBundledFont(opts.captionFont || DEFAULT_FONT_KEY);
    if (!fontCheck.ok) {
      const e = new Error(fontCheck.reason);
      e.code = "font_missing";
      throw e;
    }
  }

  // state.json 初期作成（pipeline.mjs init の代替）
  // AUD-P2-16: 以後このローカル変数を使い回して丸ごと上書きすることはしない
  // (updateStateがそのつど最新のディスク内容を読んでマージする＝子プロセスが
  // 書き足したフィールドを消さない)。
  updateState(workDir, {
    id: jobId,
    input: inputAbsPath,
    transcript: null,
    stage: "init",
    mode,
    orient,
    targetMinutes,
    // 画面の「1本の目安の長さ」。旧実装は render の引数にしか渡しておらず state.json に
    // 入っていなかったため、topic 経路の選定は目安の長さを一度も知らないまま切っていた
    // （尺は後段が機械的に切り詰めるだけになる）。選定が読めるようにここへ入れる。
    durationMin: opts.durationMin ?? null,
    // 画面の「本数に分ける」で指定した作る本数。durationMin と同じ理由でここへ入れる＝
    // topic 経路の選定（server/claude-select.mjs）はこの state.json しか読まないので、
    // ここへ入れないと画面で本数を指定しても選定は一度もそれを知らないまま切る。
    // render の argv には渡さない（本数は「どう括るか」の指示で、レンダリング側に対応する
    // フラグが無い。渡す先が無いのに argv へ足すと、効かない結線が増えるだけになる）。
    clips: opts.clips ?? null,
    sub: opts.sub === "none" ? "none" : "on",
    // 無音・言い淀みを詰めるか。pipeline.mjs のレンダリングが state.trim を見る。
    // ここへ入れ忘れると、画面で「詰める」を選んでも一度も詰まらない
    // （顔モザイクで同じ取りこぼしをしたので、結線を smoke.mjs で押さえる）。
    trim: opts.trim === "on" ? "on" : "none",
    trimSilence: opts.trimSilence === "on" ? "on" : "none",
    trimFiller: opts.trimFiller === "on" ? "on" : "none",
  });

  const job = jobs.get(jobId);

  // ── Stage t: 文字起こし ──────────────────────────────────────
  job.stage = "t";
  // 2026-08-17: 「どこで文字起こししたか(groq=クラウド / local=この端末)」は、**実際に動いた側**
  // だけを流す。旧実装はここで groqKeyAvailable()（鍵の有無）から先読みした backend を送って
  // いたが、それは「Groq を使えるはず」でしかなく、Groq が失敗してローカルへ落ちた回にも
  // 画面は Turbo を出し続けた＝表示と実態が食い違う（過去に処理先の表示が廃止された理由
  // そのもの＝G-UI-BACKEND-NOTE-TRUTH）。判定は transcribe.py の stderr から取る（下記）。
  broadcast(jobId, { stage: "t", status: "active", label: TRANSCRIBE_LABEL });

  const transcriptPath = path.join(workDir, "transcript.json");
  // transcribe.py 自身も同じ工程名で timing.json を書く（あちらの write_timing）。ここで
  // 挟んでおくのは、python が書く前に落ちた場合でも「いつ始めたか」を残すため。両方が書いた
  // 場合は python の start と、こちらの end（子プロセスの終了時刻）で確定する＝記録は1つのまま。
  stageStart(workDir, "transcribe");
  // 実際に使ったバックエンド。transcribe.py が出す "[INFO] backend=..." を見るまでは未確定
  // なので、それまでは backend を一切名乗らない（画面は backend==="groq" のときだけ Turbo を
  // 出すので、名乗らない＝出ない＝実態と食い違わない）。
  let usedBackend = null;
  await spawnAndLog(
    "python",
    [TRANSCRIBE_PY, inputAbsPath, transcriptPath],
    // P1-14-A: GROQ_API_KEYはtranscribe.pyのGroq経路選択に必要な唯一の秘密情報。
    // ここでだけ明示的にallowlistへ加える(select/renderの子には渡さない)。
    // AUD-P1-11a/11b: jobIdを渡し、キャンセル/タイムアウトの対象にする。
    { envExtra: ["GROQ_API_KEY"], jobId },
    (ln) => {
      const detected = parseBackendFromLog(ln);
      if (detected && detected !== usedBackend) {
        if (usedBackend === "groq") {
          // 訂正：Groq で始まったが途中でローカルへ落ちた。画面が Turbo を消す口は
          // 「stage t の status:done」しか無い（画面は編集禁止）ので、いったんそれを送って
          // バッジを落とし、直後に active へ戻して進行中の見た目を保つ。
          // 嘘の Turbo を出したままにするより、この一往復のほうが実態に合う。
          broadcast(jobId, { stage: "t", status: "done" });
        }
        usedBackend = detected;
        broadcast(jobId, { stage: "t", status: "active", label: TRANSCRIBE_LABEL, backend: usedBackend });
      }
      // 以降のログ行にも判明済みの backend を載せる。broadcast() が憶える直近スナップショット
      // (job.lastEvent) は最後に流れた status 付きイベントなので、載せておかないと再接続時に
      // 「実際に使った側」が失われる。
      broadcast(jobId, usedBackend
        ? { stage: "t", status: "active", log: ln, backend: usedBackend }
        : { stage: "t", status: "active", log: ln });
    }
  );
  stageEnd(workDir, "transcribe");

  updateState(workDir, { stage: "transcribed", transcript: transcriptPath, backend: usedBackend });

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
  throwIfCancelled(jobId);
  job.stage = "c";
  broadcast(jobId, { stage: "c", status: "active", label: "AIが字幕の間違いを直しています" });

  stageStart(workDir, "captionfix");
  const fixed = await aiCaptionFixStage({
    workDir,
    runModel: createDefaultRunModel(workDir),
    onLog: (msg) => broadcast(jobId, { stage: "c", status: "active", log: msg }),
  });
  stageEnd(workDir, "captionfix");

  updateState(workDir, { stage: "captionfixed" });
  broadcast(jobId, { stage: "c", status: "active", log: `[ai-caption-fix] ${fixed.total} 語のうち ${fixed.fixed} 語を直しました` });

  // 「間を詰める」を選んでいるときだけ、どこを詰めるかを AI に判断させる（G-EDIT-TRIM2-AI-*）。
  // 固定の単語一覧と長さの閾値だけでは「あの資料」の指示語まで消え、相手を待つ沈黙も消える。
  // 失敗したら例外のままジョブを失敗させる（黙って一覧と閾値へ退避すると、直そうとしている
  // 欠陥をそのまま出力に出したうえで、それを利用者に知らせないことになる＝FAILSTOP）。
  // どちらも「なし」のときは呼ばない（判断が要らない設定まで AI に依存させない）。
  if (opts.trimSilence === "on" || opts.trimFiller === "on") {
    broadcast(jobId, { stage: "c", status: "active", label: "AIが詰めてよい所を選んでいます" });
    stageStart(workDir, "trimjudge");
    const judged = await trimJudgeStage({
      workDir,
      runModel: createDefaultRunModel(workDir),
      onLog: (msg) => broadcast(jobId, { stage: "c", status: "active", log: msg }),
    });
    stageEnd(workDir, "trimjudge");
    broadcast(jobId, {
      stage: "c", status: "active",
      log: `[trim-judge] ${judged.total} 語のうち 言い淀み${judged.fillers}件 / 詰める間${judged.cutGaps}件`,
    });
  }
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
  // 計測は select（下準備）と orchestrate（AI が実際に選ぶ）に分ける。片方でまとめると
  // 「AI が遅いのか、その前後が遅いのか」を切り分けられないうえ、pipeline.mjs render が
  // llm-request.md→llm-response.json の mtime 差から orchestrate を書き足すので、
  // まとめた select の中に orchestrate が入れ子で二重計上され、合計が水増しされる。
  stageStart(workDir, "select");
  await spawnAndLog(
    "node",
    selectArgs,
    { jobId },
    (ln) => broadcast(jobId, { stage: "s", status: "active", log: ln })
  );
  stageEnd(workDir, "select");

  // topic(話題で切る): pipeline.mjs select は llm-request.md を書くだけなので、
  // claude -p 呼び出し(チャンク並列)は別途ここで行い llm-response.json を書く。
  // P1-5: 一部chunkが失敗しても(1件以上成功していれば)処理は続行するが、その場合は
  // incomplete:true をstateへ残し、成功したふりをしない(候補生成・SSE完了通知の両方に反映)。
  let selectIncomplete = false;
  if (mode !== "digest") {
    throwIfCancelled(jobId);
    // 「AI が区間を選んでいる時間」そのもの。CLI 経路で pipeline.mjs render が mtime 差から
    // 書き足すのと同じ工程名にして、記録の形を経路ごとに増やさない。
    stageStart(workDir, "orchestrate");
    const result = await runClaudeSelect(workDir, (msg) => {
      broadcast(jobId, { stage: "s", status: "active", log: msg });
    });
    stageEnd(workDir, "orchestrate");
    selectIncomplete = result.incomplete;
    if (selectIncomplete) {
      broadcast(jobId, {
        stage: "s",
        status: "active",
        log: `[WARN] ${result.failedChunks}/${result.totalChunks} chunk が失敗しました。成功分のみで続行します。`,
      });
    }
  }

  updateState(workDir, { stage: "selected", selectIncomplete });
  broadcast(jobId, { stage: "s", status: "done", incomplete: selectIncomplete });

  // ── Stage r: レンダリング ────────────────────────────────────
  job.stage = "r";
  broadcast(jobId, { stage: "r", status: "active", label: renderLabel(orient) });

  const renderArgs = buildRenderArgs(PIPELINE_MJS, workDir, opts);

  // 子(pipeline.mjs render)も同じ工程名で start/end を書く。ここで挟むのは、子が
  // 書き終える前に落ちた場合でも「いつ始めたか」が残るようにするため（記録の形は同じ）。
  stageStart(workDir, "render");
  await spawnAndLog(
    "node",
    renderArgs,
    { jobId },
    (ln) => broadcast(jobId, { stage: "r", status: "active", log: ln })
  );
  stageEnd(workDir, "render");

  updateState(workDir, { stage: "rendered" });
  broadcast(jobId, { stage: "r", status: "done" });

  // ── Stage m: 顔モザイク（選ばれたときだけ） ──────────────────
  // これまでモザイクは CLI 経路にしか無く、画面から使うと素顔のまま出ていた。
  // 掛けたときは素顔のファイルを成果物フォルダの外へ退避する（納品はフォルダからの
  // コピーなので、一覧から隠すだけでは「うっかり素顔を渡す」を防げない）。
  if (opts.mosaic === "on") {
    throwIfCancelled(jobId);
    job.stage = "m";
    broadcast(jobId, { stage: "m", status: "active", label: "顔にモザイクを掛けています" });

    const outDir = path.join(OUT_ROOT, jobId);
    const candPath = path.join(outDir, "candidates.json");
    const cand = JSON.parse(fs.readFileSync(candPath, "utf-8"));
    // AUD-P1-06: candidates.json の書き換えは applyMosaicStage() が原子的（temp+rename）に
    // 行う。ここで改めて fs.writeFileSync すると、その書き込み自体が非原子的なtruncate書きに
    // 戻ってしまい、書いている途中で落ちたときに壊れて読めなくなる。
    stageStart(workDir, "mosaic");
    await applyMosaicStage({
      outDir,
      stashDir: path.join(workDir, "pre-mosaic"),
      candidates: cand,
      candPath,
      onLog: (ln) => broadcast(jobId, { stage: "m", status: "active", log: ln }),
    });
    stageEnd(workDir, "mosaic");

    updateState(workDir, { stage: "mosaicked", mosaic: "on" });
    broadcast(jobId, { stage: "m", status: "done" });
  }

  // ── 完了 ─────────────────────────────────────────────────────
  // AUD-P2-16: doneも(errorやcancelled/timeoutと同様に)必ずディスクへ永続化する。
  // 旧実装はメモリのjob.stageだけをdoneにしており、state.jsonは最後に書いた
  // "rendered"/"mosaicked"のまま止まっていた。サーバー再起動後にこのジョブへ
  // 再接続すると、jobs Mapが空(=このプロセスは一度も起動していない)なので、
  // state.jsonを読んで「本当はdoneだった」と判定できることが要る(subscribeJob参照)。
  updateState(workDir, { stage: "done", selectIncomplete });
  // 工程ごとの所要時間を1行にまとめてサーバーのログへ出す（CLI 経路 pipeline.mjs render の
  // 末尾と同じ [TIME] 行）。timing.json を開かなくても、どこで時間を使ったかが分かる。
  process.stderr.write(`${summaryLine(readTiming(workDir))} jobId=${jobId}\n`);
  job.stage = "done";
  // AUD-P2-20a: 終端到達時刻を記録する(reclaimTerminalJobsの保持期間判定に使う)。
  job.terminatedAt = Date.now();
  broadcast(jobId, { stage: "done", incomplete: selectIncomplete }, "done");
}
