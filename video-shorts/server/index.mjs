// server/index.mjs — ローカル Node バックエンド（PORT 5178・127.0.0.1 のみ）
// GET /            → webapp-mockup/ を静的配信
// POST /api/jobs   → 動画アップロード → ジョブ起動
// GET /api/jobs/:id/events    → SSE 進捗ストリーム
// GET /api/jobs/:id/candidates → candidates.json
// GET /api/clips/:id/:file     → mp4 ストリーム配信
// npm 依存ゼロ: Node 標準モジュールのみ。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteStream } from "node:fs";
import {
  startJob,
  subscribeJob,
  unsubscribeJob,
  isRunning,
  activeJobIds,
  beginRecaption,
  endRecaption,
  isRecaptioning,
  runGated,
  cancelJob,
} from "./pipeline-runner.mjs";
import { parseJobParams } from "./job-params.mjs";
import {
  readEdits, saveWordEdit, applyEdits, editPairs,
} from "../src/caption-store.mjs";
import { appendSafeTerm, DICT_PATH } from "../src/term-dictionary.mjs";
import { recaptionStage } from "../src/recaption-stage.mjs";
import { makeUniqueJobId } from "../src/job-id.mjs";
import {
  generateStartupToken,
  extractToken,
  extractJobToken,
  isValidToken,
  isValidJobToken,
  issueJobToken,
  persistJobToken,
  loadPersistedJobToken,
  restoreJobToken,
  isAllowedHost,
  isAllowedOrigin,
  createSignatureSniffer,
  createRateLimiter,
  MAX_UPLOAD_BYTES,
  MAX_JSON_BODY_BYTES,
  hashToken,
} from "./security.mjs";
import {
  resolveTtlSeconds,
  resolveQuotaBytes,
  computeUsedBytes,
  hasQuotaAvailable,
  sweepExpiredJobs,
  removeDirViaChildProcess,
} from "./job-lifecycle.mjs";
import { createBackpressureAwarePush } from "./sse-backpressure.mjs";

const PORT = Number(process.env.PORT ?? 5178);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATIC_ROOT = path.join(ROOT, "webapp-mockup");
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");
// P1-17-A: symlink追随防止用にrealpathを起動時に1回だけ解決してキャッシュする
// (毎リクエストでのrealpathSync呼び出しを避けるため)。
const STATIC_ROOT_REAL = fs.realpathSync(STATIC_ROOT);

// P1-2(A): 起動ごとに変わるトークン。正規のページ(index.html)にのみ埋め込んで配布する。
const SERVER_TOKEN = generateStartupToken();
process.stderr.write(`[ai-editer] startup token (このプロセス限り有効): ${SERVER_TOKEN}\n`);

// P1-2(E): ジョブ起動(POST /api/jobs)へのレート制限。単一利用者のローカルツール前提の固定ウィンドウ。
const jobsRateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

// P1-13-E: 字幕保存・用語追加・焼き直しの書き込み系エンドポイントへのレート制限。
// jobsRateLimiterと違いキーをjobId単位にする(P1-2-Eの"global"固定キーだと、1つのジョブへの
// 連打が無関係な別ジョブの正規リクエストまで429にしてしまうため)。
const writeRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

// P2-4(A/B): ジョブの寿命管理。既定値はVS_JOB_TTL_SECONDS/VS_STORAGE_QUOTA_BYTESで上書きできる
// （job-lifecycle.mjs 参照。客のPC上でwork/outputが際限なく溜まるのを防ぐ）。
const JOB_TTL_SECONDS = resolveTtlSeconds();
const STORAGE_QUOTA_BYTES = resolveQuotaBytes();

/**
 * P2-4(A): TTLを過ぎたジョブ(work/output配下)を削除する。起動時に1回、以後は定期実行する。
 * AUD-P1-15: 削除処理そのものは removeDirViaChildProcess() で別プロセスへ隔離する。
 * Windows/OneDrive/日本語パスの組み合わせで fs.rmSync() がネイティブクラッシュを起こしても
 * (docs/audits/adversarial-review-2026-08-13.md #15)、死ぬのはその子プロセスだけにして
 * サーバー本体は継続稼働させるため(job-lifecycle.mjs のコメント参照)。
 */
function sweepExpiredJobsNow() {
  // 実行中/待機中のジョブは、まだ state.json を書いていない(=ディレクトリのmtimeが古いまま
  // に見える)可能性があるため掃除から除外する（pipeline-runner.mjs activeJobIds() 参照）。
  const removed = sweepExpiredJobs(
    [WORK_ROOT, OUT_ROOT],
    JOB_TTL_SECONDS,
    Date.now(),
    activeJobIds(),
    removeDirViaChildProcess,
  );
  for (const r of removed) {
    process.stderr.write(`[ai-editer] TTL(${JOB_TTL_SECONDS}秒)超過のため削除: ${r.root}/${r.jobId}\n`);
  }
}
sweepExpiredJobsNow();
// 起動しっぱなしのローカルサーバーでも定期的に掃除されるよう、1時間ごとに再実行する。
// unref() でこのタイマーだけのためにプロセスが終了できなくなるのを防ぐ(テスト等での後始末)。
setInterval(sweepExpiredJobsNow, 60 * 60 * 1000).unref();

// ── MIME マップ ───────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
};

// ── jobId サニタイズ ──────────────────────────────────────────
/** 英数・ハイフンのみ・ .. / スラッシュ 禁止 */
function safeId(raw) {
  if (!raw) return null;
  // 日本語等の Unicode 文字・数字・ハイフン・アンダースコアを許可（makeUniqueJobId と整合）。
  // セパレータや「.」は含まないため、下のトラバーサル検査と併せて安全。
  if (!/^[\p{L}\p{N}_-]+$/u.test(raw)) return null;
  if (raw.includes("..") || raw.includes("/") || raw.includes("\\")) return null;
  return raw;
}

/** ファイル名サニタイズ（.mp4 のみ・.. 禁止） */
function safeFile(raw) {
  if (!raw) return null;
  if (raw.includes("..") || raw.includes("/") || raw.includes("\\")) return null;
  if (!raw.endsWith(".mp4")) return null;
  return raw;
}

/** URL エンコードされた path セグメントを復号（不正エンコードは null） */
function decodeId(raw) {
  try { return decodeURIComponent(raw); }
  catch (_) { return null; }
}

// ── JSON レスポンス ──────────────────────────────────────────
function jsonRes(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

// ── リクエストボディを読み切る（小データ用） ────────────────
// P1-13-A: maxBytes を超えるボディは、全量を溜め切る前に打ち切って拒否する
// (字幕の直し・用語追加は本来数百バイト程度で足りるため、上限超はDoS意図とみなす)。
class BodyTooLargeError extends Error {
  constructor(maxBytes) {
    super(`リクエスト本文が上限(${maxBytes}バイト)を超えています`);
    this.name = "BodyTooLargeError";
  }
}

function readBody(req, { maxBytes = MAX_JSON_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    // req.destroy() はソケットそのものを破棄するため、呼び出し側が413レスポンスを
    // 書く前に接続が切れてクライアントには ECONNRESET しか届かない(413を書けない)。
    // ソケットは生かしたまま、以降のチャンクをバッファへ積まない(=メモリを増やさない)
    // だけにすることで、413応答を正常に返しつつメモリ上限も守る。
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume(); // 残りのボディは消費するだけで捨てる(蓄積しない)
      return reject(new BodyTooLargeError(maxBytes));
    }
    const chunks = [];
    let received = 0;
    let rejected = false;
    req.on("data", (c) => {
      received += c.length;
      if (rejected) return; // 上限超過後のチャンクは消費するだけで捨てる(蓄積しない)
      if (received > maxBytes) {
        rejected = true;
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (rejected) return;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => {
      if (!rejected) reject(e);
    });
  });
}

// ── 静的ファイル配信 ─────────────────────────────────────────
function serveStatic(req, res) {
  // URL decode してからパス正規化
  let reqPath;
  try {
    reqPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch (_) {
    res.writeHead(400);
    return res.end("Bad Request");
  }

  // ルートは index.html へ
  if (reqPath === "/") reqPath = "/index.html";

  // 正規化して webapp-mockup 外への脱出を検出
  const resolved = path.resolve(STATIC_ROOT, "." + reqPath);
  if (!resolved.startsWith(STATIC_ROOT + path.sep) && resolved !== STATIC_ROOT) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    res.writeHead(404);
    return res.end("Not Found");
  }

  // P1-17-A: シンボリックリンクの先がwebapp-mockup外を指していないか実体で確認する
  // (上のprefix検査はreqPathの文字列だけを見ており、リンクの追随までは検出できない)。
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (_) {
    res.writeHead(404);
    return res.end("Not Found");
  }
  if (!real.startsWith(STATIC_ROOT_REAL + path.sep) && real !== STATIC_ROOT_REAL) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  const ext = path.extname(resolved).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";

  // P1-2(A): index.html にのみ起動時トークンを埋め込んで配布する（正規ページだけが読める。
  // 別オリジンの悪意あるページはこのレスポンス本文を読めないため、トークンを盗めない）。
  if (reqPath === "/index.html") {
    const html = fs.readFileSync(resolved, "utf-8");
    const tokenScript = `<script>window.__AI_EDITOR_TOKEN__=${JSON.stringify(SERVER_TOKEN)};</script>\n`;
    const injected = html.includes("</head>")
      ? html.replace("</head>", `${tokenScript}</head>`)
      : tokenScript + html;
    const data = Buffer.from(injected, "utf-8");
    res.writeHead(200, { "Content-Type": mime, "Content-Length": data.length });
    return res.end(data);
  }

  const stat = fs.statSync(resolved);
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": stat.size,
  });
  fs.createReadStream(resolved).pipe(res);
}

// P2-4(B) 補助: アップロードクォータの受付判定に使う、プロセス内の「予約済みバイト数」。
// 旧実装は computeUsedBytes() で得た「その時点のディスク使用量」だけをクォータと比較して
// いたため、(a) 複数リクエストが同時に来ると全部が同じスナップショットを見て admission を
// 通過してから書き込みが始まり合計で上限を超えうる、(b) Content-Length を admission 判定に
// 含めていないため単一リクエストの書き込み中にも上限を超えうる、という2つの穴があった
// (CodeRabbit指摘)。ここへ「申告済み/受信済みだが、まだディスク使用量には反映されていない」
// バイト数を積んでおき、後続リクエストの admission 判定にも反映させる。Node は単一スレッドの
// イベントループなので、チェックと加算の間に他リクエストのハンドラが割り込むことはなく、
// レースは起きない。
let reservedUploadBytes = 0;
const QUOTA_EXCEEDED_MESSAGE =
  "保存容量の上限に達しています。既存のジョブを整理するか、しばらく待ってから再試行してください。";

// ── POST /api/jobs ──────────────────────────────────────────
async function handlePostJobs(req, res) {
  // クエリパラメータ取得
  const url = new URL(req.url, "http://x");
  // 分解して startJob へ渡し直すと、設定を1つ足すたびにここへ書き足す必要があり、
  // 足し忘れると「画面で選べるのに一切効かない」設定が出来る（breath で実際に起きた。
  // docs/failures.md 2026-08-14）。パラメータの束はそのまま startJob へ渡し、
  // ここでフィールドを1つずつ数え上げないことで、その取りこぼしを構造的に無くす。
  const jobParams = parseJobParams(url.searchParams);
  const { name } = jobParams;

  // P1-2(E): レート制限（単一利用者のローカルツール前提の固定ウィンドウ）
  if (!jobsRateLimiter.allow("global")) {
    return jsonRes(res, 429, { error: "リクエストが多すぎます。少し待ってから再試行してください。" });
  }

  // P1-2(D): 宣言サイズが上限超過なら本文を受け取る前に拒否
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    return jsonRes(res, 413, { error: "ファイルが大きすぎます" });
  }

  // P2-4(B): 保存容量が上限に達していれば、本文を受け取る前に新規保存を拒否する
  // （書き始めてから溢れるのを待つと、途中まで書いた分が無駄になる）。
  // Content-Length が分かる場合は「使用量 + 予約済み + 申告長」を admission 条件に含める(b対策)。
  // reservedUploadBytes の確認→加算をここで同期的に行うことで、同時に来た複数リクエストが
  // 全部 admission を通過してしまうのを防ぐ(a対策)。
  const hasDeclaredLength = Number.isFinite(declaredLength) && declaredLength >= 0;
  const usedBytesAtStart = computeUsedBytes([WORK_ROOT, OUT_ROOT]);
  let myReservation = hasDeclaredLength ? declaredLength : 0;
  if (!hasQuotaAvailable(usedBytesAtStart + reservedUploadBytes + myReservation, STORAGE_QUOTA_BYTES)) {
    return jsonRes(res, 507, { error: QUOTA_EXCEEDED_MESSAGE });
  }
  reservedUploadBytes += myReservation;
  // 予約は成功・拒否・失敗のいずれの経路でも必ず解放する(try/finally)。多重解放を防ぐため
  // 一度だけ実行するガードを付ける。
  let reservationReleased = false;
  const releaseReservation = () => {
    if (reservationReleased) return;
    reservationReleased = true;
    reservedUploadBytes -= myReservation;
  };

  try {
    // ファイル名からジョブID生成・サニタイズ。P1-3: 乱数suffixで同名ファイルの同時アップロードを
    // ジョブ単位に分離する(workDir/inputPathがジョブごとに必ず別になり、書込みが衝突しない)。
    const rawId = makeUniqueJobId(name);
    const jobId = safeId(rawId);
    if (!jobId) {
      return jsonRes(res, 400, { error: "無効なファイル名" });
    }

    const ext = path.extname(name) || ".mp4";
    const workDir = path.join(WORK_ROOT, jobId);
    fs.mkdirSync(workDir, { recursive: true });
    const inputPath = path.join(workDir, `input${ext}`);

    // リクエストボディをストリームで保存（全量メモリ展開しない）。
    // 併せて P1-2(C) 先頭バイト列のmagic byte検証と、P1-2(D) 実受信量の上限超過検知(宣言値が
    // 無い/嘘の場合の保険)を行う。TCPの都合で最初のdataチャンクが判定に必要な量未満のことが
    // ありうるため(実際にCodeRabbitレビューで指摘)、判定ロジックはcreateSignatureSniffer()に
    // 切り出し、十分な先頭バイト数が揃う(またはストリーム終端する)まで複数チャンクをまたいで
    // 蓄積してから1回だけ判定する。
    let rejection = null;
    try {
      await new Promise((resolve, reject) => {
        const ws = createWriteStream(inputPath);
        let receivedBytes = 0;
        let checkedSignature = false;
        const sniffer = createSignatureSniffer();

        const abort = (status, message) => {
          rejection = { status, message };
          req.pause();
          ws.destroy();
          reject(new Error(message));
        };

        const applySniffResult = (result) => {
          checkedSignature = true;
          if (!result.ok) return abort(415, "動画ファイルとして認識できません");
          ws.write(result.head);
        };

        req.on("data", (chunk) => {
          if (rejection) return;
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_UPLOAD_BYTES) return abort(413, "ファイルが大きすぎます");

          if (!hasDeclaredLength) {
            // Content-Length が無い(chunked等)場合は、宣言長ぶんを事前予約できない。
            // 代わりに受信するたびにここまでの分を動的に予約へ積み増し、都度クォータを
            // 確認して、超える前(=書き込む前)に拒否する。
            reservedUploadBytes += chunk.length;
            myReservation += chunk.length;
            if (usedBytesAtStart + reservedUploadBytes > STORAGE_QUOTA_BYTES) {
              return abort(507, QUOTA_EXCEEDED_MESSAGE);
            }
          }

          if (!checkedSignature) {
            const result = sniffer.push(chunk);
            if (result.decided) applySniffResult(result);
            return;
          }
          ws.write(chunk);
        });
        req.on("end", () => {
          if (rejection) return;
          // ファイル全体が判定に必要な量未満のまま終端した場合、集まった分だけで判定する。
          if (!checkedSignature) applySniffResult(sniffer.finish());
          if (!rejection) ws.end();
        });
        req.on("error", (e) => {
          if (!rejection) reject(e);
        });
        ws.on("finish", resolve);
        ws.on("error", (e) => {
          if (!rejection) reject(e);
        });
      });
    } catch (e) {
      fs.rmSync(workDir, { recursive: true, force: true });
      if (rejection) return jsonRes(res, rejection.status, { error: rejection.message });
      throw e;
    }

    // ジョブをキックして即レスポンス（走行中なら 409 で拒否＝連打事故防止）
    const started = startJob(jobId, inputPath, jobParams);
    if (started === "queue_full") {
      // AUD-P2-20b: 待ち行列が上限に達している。既にディスクへ書き終えたアップロードを
      // 残さない(受理しないのだから成果物フォルダも残す理由が無い＝他の拒否経路と同じ作法)。
      fs.rmSync(workDir, { recursive: true, force: true });
      return jsonRes(res, 429, {
        error: "順番待ちが混み合っています。しばらく待ってから再試行してください。",
      });
    }
    if (!started) {
      return jsonRes(res, 409, { error: "already running", jobId });
    }

    // P1-4(B): このジョブ専用のトークンを発行する。起動時トークンは全ジョブ共通のため、
    // これが無いと同じ起動時トークンを持つ別ジョブの作成者が、jobIdさえ知れば/推測できれば
    // 他人の成果物(SSE進捗・候補JSON・生成動画)を取得できてしまう。
    const jobToken = issueJobToken(jobId);
    // P1-6: メモリのregistryだけだとサーバー再起動で失われ、進行中だったジョブへの正規の
    // 再接続まで401/403で弾かれてしまう(利用者に「再起動で中断された」ことを伝えられない)。
    // workDirへも永続化し、再起動後の再接続を認可できるようにする。
    persistJobToken(workDir, jobToken);

    return jsonRes(res, 202, { jobId, jobToken });
  } finally {
    releaseReservation();
  }
}

// ── GET /api/jobs/:id/events（SSE） ────────────────────────
function handleJobEvents(req, res, jobId) {
  const id = safeId(jobId);
  if (!id) {
    res.writeHead(400);
    return res.end("Bad jobId");
  }

  process.stderr.write(`[SSE connect] jobId=${id}\n`);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // 初期 ping（接続確立確認）
  res.write(": ping\n\n");

  // AUD-P2-25: res.write()のbackpressureを尊重するpushへ差し替える
  // (遅い購読者がいてもNodeプロセス側のメモリが無制限に膨らまないようにする)。
  const push = createBackpressureAwarePush(res);
  function close() {
    try {
      res.end();
    } catch (_) {}
  }

  subscribeJob(id, push, close);

  req.on("close", () => {
    unsubscribeJob(id, push);
  });
}

// ── GET /api/jobs/:id/candidates ────────────────────────────
function handleCandidates(req, res, jobId) {
  const id = safeId(jobId);
  if (!id) return jsonRes(res, 400, { error: "Bad jobId" });

  const candPath = path.join(OUT_ROOT, id, "candidates.json");
  if (!fs.existsSync(candPath)) return jsonRes(res, 404, { error: "Not Found" });

  const data = fs.readFileSync(candPath, "utf-8");
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

// ── GET /api/clips/:id/:file ────────────────────────────────
function handleClip(req, res, jobId, file) {
  const id = safeId(jobId);
  const filename = safeFile(file);
  if (!id || !filename) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  const clipPath = path.join(OUT_ROOT, id, filename);
  if (!fs.existsSync(clipPath)) {
    res.writeHead(404);
    return res.end("Not Found");
  }

  // P1-17-A: symlinkの先がoutput外を指していないか実体で確認する。OUT_ROOTはジョブが
  // 一度も作られていない状態では存在しないため、realpathはここで都度解決する。
  try {
    const outRootReal = fs.realpathSync(OUT_ROOT);
    const real = fs.realpathSync(clipPath);
    if (!real.startsWith(outRootReal + path.sep) && real !== outRootReal) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
  } catch (_) {
    res.writeHead(404);
    return res.end("Not Found");
  }

  const stat = fs.statSync(clipPath);
  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
  });
  fs.createReadStream(clipPath).pipe(res);
}

// P1-2(B): Host/Origin検証。/api/* 全体で常時必須(クロスオリジン/DNS rebinding対策)。
// 静的ファイル配信(GET /)は公開情報のみのため対象外(ページを開く最初の一歩を塞がないため)。
function isAllowedApiOrigin(req) {
  return isAllowedHost(req.headers.host, PORT) && isAllowedOrigin(req.headers.origin, PORT);
}

// P1-2(A): 起動時トークン検証。新規ジョブ作成(POST /api/jobs)はこれを厳密に要求する
// (まだジョブが存在せず、ジョブ単位のトークンへスコープを絞れないため)。
function isValidStartupToken(req, url) {
  const token = extractToken(req, url.searchParams);
  return isValidToken(token, SERVER_TOKEN);
}

// P1-4(B)+P1-6: 既存ジョブの成果物取得(events/candidates/clips)の認可は、そのジョブ専用の
// トークン一致のみで判定する(P1-4-B。workDirへの永続化フォールバック込み=P1-6)。
//
// 起動時トークンをここで併用(bypass)しないのは意図的:起動時トークンは全ジョブ共通の値
// なので、それだけで通してしまうと「同じ起動時トークンを知っている(＝同じページを開いた)
// だけの別ジョブの作成者」が、jobIdさえ知れば(推測困難だが)他人のジョブを覗けてしまい、
// P1-4-B がそもそも守ろうとしていたものを台無しにする。
//
// 起動時トークンをここで必須にもしないのも意図的:それはプロセス起動のたびに変わる値
// なので、サーバーが再起動すると別の値になる。ブラウザが開きっぱなしのEventSourceは
// "再起動前の"起動時トークンを含んだままSSEへ自動再接続するため、これを必須にすると
// 正規の再接続がP1-6の中断通知(event: interrupted)へ到達する前に401で弾かれてしまう
// (2026-07-28 independent-verifierが実サーバー2プロセスでの再現により発見)。
//
// ジョブトークンはそのジョブに一意な暗号学的乱数(P1-4-A/B)であり、単独で
// 「起動時トークンを知っているか」にも「プロセスが再起動したか」にも依存しない
// 十分な認可強度を持つため、これだけで判定する。
// jobId は呼び出し元でURLデコードされた未検証の文字列のため、fsパスに使う前に safeId で
// 検査する(でなければ .. 等でworkDir配下から脱出したパスの存在有無を外部から探れてしまう)。
function isAuthorizedForJob(req, url, jobId) {
  const id = safeId(jobId);
  if (!id) return false;
  const jobToken = extractJobToken(req, url.searchParams);
  if (isValidJobToken(id, jobToken)) return true;
  // P1-15-B: ディスクの job-token.txt にはハッシュのみが入っている(persistJobToken参照)。
  // 候補トークンを同じくハッシュ化してから比較する。一致すれば平文の候補値(=正規のトークン
  // そのもの)をメモリのregistryへ再登録する(restoreJobTokenはハッシュではなく平文を保持する)。
  const persistedHash = loadPersistedJobToken(path.join(WORK_ROOT, id));
  if (persistedHash && jobToken && isValidToken(hashToken(jobToken), persistedHash)) {
    restoreJobToken(id, jobToken);
    return true;
  }
  return false;
}

// ── 字幕の手直し（G-EDIT-CAPTION） ──────────────────────────
// 新しい書き込み口は3つ。いずれも /api/* 共通の Host/Origin 検査に加えて、
// ジョブごとのトークン（isAuthorizedForJob）を通す。ここを緩めると、
// 便利にした結果として他人のジョブを書き換えられる穴になる（葉E）。

/** ジョブの transcript.json を読む。無ければ null（まだ文字起こしが終わっていない）。 */
function readTranscript(jobId) {
  const p = path.join(WORK_ROOT, jobId, "transcript.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

// GET /api/jobs/:id/captions — 直しを重ねた字幕の語を返す
function handleGetCaptions(req, res, jobId) {
  const id = safeId(jobId);
  if (!id) return jsonRes(res, 400, { error: "Bad jobId" });
  let transcript;
  try {
    transcript = readTranscript(id);
  } catch (e) {
    return jsonRes(res, 500, { error: `文字起こしを読めませんでした: ${e.message}` });
  }
  if (!transcript) return jsonRes(res, 404, { error: "Not Found" });
  const workDir = path.join(WORK_ROOT, id);
  let edits;
  try {
    edits = readEdits(workDir);
  } catch (e) {
    return jsonRes(res, 500, { error: e.message });
  }
  const words = transcript.words || [];
  return jsonRes(res, 200, {
    id,
    words: applyEdits(words, edits).map((w, i) => ({
      index: i, w: w.w, start: w.start, end: w.end,
      original: words[i] ? words[i].w : w.w,
      edited: Object.prototype.hasOwnProperty.call(edits.words, String(i)),
    })),
    pairs: editPairs(words, edits),
  });
}

// PUT /api/jobs/:id/captions — 1語の直しを保存する
async function handlePutCaptions(req, res, jobId) {
  const id = safeId(jobId);
  if (!id) return jsonRes(res, 400, { error: "Bad jobId" });
  // AUD-P1-12: recaption(焼き直し)は開始時に字幕の直しを1回だけスナップショットして
  // 動画へ焼き込む。焼き直し実行中にPUTを受理して保存だけ成功させると、実行中の焼き直しは
  // 古いスナップショットのまま完了してしまい、保存した直しが黙って握りつぶされる
  // (保存自体は200で成功したように見えるのに、出来上がる動画には反映されない)。
  // 焼き直し中のPUTは409で明確に拒否し、UI側にも編集ロックさせる(webapp-mockup/app.js)。
  if (isRecaptioning(id)) {
    return jsonRes(res, 409, {
      error: "焼き直し中は字幕を直せません。焼き直しが終わってからもう一度お試しください。",
    });
  }
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
  } catch (e) {
    if (e instanceof BodyTooLargeError) return jsonRes(res, 413, { error: e.message });
    return jsonRes(res, 400, { error: "本文が JSON ではありません" });
  }
  let transcript;
  try {
    transcript = readTranscript(id);
  } catch (e) {
    return jsonRes(res, 500, { error: `文字起こしを読めませんでした: ${e.message}` });
  }
  if (!transcript) return jsonRes(res, 404, { error: "Not Found" });
  const words = transcript.words || [];
  const index = body.index;
  const original = words[index] ? words[index].w : undefined;
  let saved;
  try {
    saved = saveWordEdit(path.join(WORK_ROOT, id), {
      index, text: body.text, original, wordCount: words.length,
    });
  } catch (e) {
    return jsonRes(res, 500, { error: e.message });
  }
  if (!saved.saved) return jsonRes(res, 400, { error: saved.reason });
  return jsonRes(res, 200, { ok: true, index, before: saved.before, after: saved.after });
}

// POST /api/jobs/:id/terms — 直した語を用語辞書へ追記する
async function handlePostTerms(req, res, jobId) {
  const id = safeId(jobId);
  if (!id) return jsonRes(res, 400, { error: "Bad jobId" });
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
  } catch (e) {
    if (e instanceof BodyTooLargeError) return jsonRes(res, 413, { error: e.message });
    return jsonRes(res, 400, { error: "本文が JSON ではありません" });
  }
  let result;
  try {
    // 辞書の置き場所は差し替えられるようにする。テストが本物の用語辞書へ書き込むと、
    // 以後の全案件にその語が効いてしまう（この辞書は全ジョブに単純文字列置換で効く）。
    // 判定は appendSafeTerm の中で、語の形（1語・12文字以内・予約キーでない・重複でない）
    // だけを見る＝世間の用語辞書と同じ水準。載せた語が他の案件で誤爆しないことは保証しない。
    // 字幕の最終的な正しさは、AI が文脈で見て直すことと、人間の確認が担う（2026-08-09 決定）。
    result = appendSafeTerm(
      body.before, body.after,
      process.env.VS_TERM_DICT || DICT_PATH,
    );
  } catch (e) {
    return jsonRes(res, 500, { error: e.message });
  }
  if (!result.added) return jsonRes(res, 400, { error: result.reason, ...result });
  return jsonRes(res, 200, { ok: true, ...result });
}

// POST /api/jobs/:id/cancel — 実行中のジョブを手動でキャンセルする(AUD-P1-11a)
function handleCancelJob(req, res, jobId) {
  const id = safeId(jobId);
  if (!id) return jsonRes(res, 400, { error: "Bad jobId" });
  const result = cancelJob(id);
  if (!result.ok) return jsonRes(res, 409, { error: result.reason });
  return jsonRes(res, 200, { ok: true });
}

// POST /api/jobs/:id/recaption — 直した字幕で焼き直す
async function handleRecaption(req, res, jobId) {
  const id = safeId(jobId);
  if (!id) return jsonRes(res, 400, { error: "Bad jobId" });
  if (isRunning(id)) {
    // 走っている最中に焼き直すと、同じファイルを2つの工程が書き合う。
    return jsonRes(res, 409, { error: "このジョブはまだ処理中です。終わってから焼き直してください" });
  }
  // P1-13-B: 同一ジョブへの並列な焼き直しリクエストは、一時ファイル名の競合を招くため拒否する。
  if (!beginRecaption(id)) {
    return jsonRes(res, 409, { error: "このジョブは既に焼き直し中です。終わってからもう一度試してください" });
  }
  try {
    // 本編ジョブと同じ同時実行数ゲートを共有し、焼き直し由来のffmpeg起動が
    // 際限なく積み上がらないようにする(P1-13-B)。
    const r = await runGated(() =>
      recaptionStage({
        workDir: path.join(WORK_ROOT, id),
        outDir: path.join(OUT_ROOT, id),
      }),
    );
    return jsonRes(res, 200, { ok: true, ...r });
  } catch (e) {
    return jsonRes(res, 500, { error: e.message });
  } finally {
    endRecaption(id);
  }
}

// ── ルーティング ─────────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, "http://x");
  const { pathname } = url;
  const method = req.method.toUpperCase();

  // P1-16-A/B/C/D: CSP・nosniff・X-Frame-Options・Referrer-Policyを全レスポンスへ付ける。
  // writeHead呼び出しより前にsetHeaderしておけば、後続の各ハンドラのwriteHead(status, {...})
  // とマージされる(Node http仕様)。
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (pathname.startsWith("/api/")) {
    if (!isAllowedApiOrigin(req)) {
      return jsonRes(res, 401, { error: "Unauthorized" });
    }
  } else if (!isAllowedHost(req.headers.host, PORT)) {
    // P1-15-A: 静的配信(GET /等)にもHost検査を課す。ここを素通りさせると、別名ホストを
    // 名乗るだけの同一PC上の別プロセスが index.html 経由で起動時トークンを取得できてしまう。
    return jsonRes(res, 401, { error: "Unauthorized" });
  }

  // POST /api/jobs（新規ジョブ作成。まだジョブが存在せず起動時トークンでのみ認可する）
  if (method === "POST" && pathname === "/api/jobs") {
    if (!isValidStartupToken(req, url)) {
      return jsonRes(res, 401, { error: "Unauthorized" });
    }
    try {
      return await handlePostJobs(req, res);
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // GET /api/jobs/:id/events（jobId は日本語だと encode されて届くので復号）
  const eventsMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/events$/);
  if (method === "GET" && eventsMatch) {
    const id = decodeId(eventsMatch[1]);
    if (id === null) { res.writeHead(400); return res.end("Bad jobId"); }
    if (!isAuthorizedForJob(req, url, id)) return jsonRes(res, 403, { error: "Forbidden" });
    return handleJobEvents(req, res, id);
  }

  // GET /api/jobs/:id/candidates
  const candMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/candidates$/);
  if (method === "GET" && candMatch) {
    const id = decodeId(candMatch[1]);
    if (id === null) return jsonRes(res, 400, { error: "Bad jobId" });
    if (!isAuthorizedForJob(req, url, id)) return jsonRes(res, 403, { error: "Forbidden" });
    return handleCandidates(req, res, id);
  }

  // GET|PUT /api/jobs/:id/captions（字幕の手直し）
  const capMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/captions$/);
  if (capMatch && (method === "GET" || method === "PUT")) {
    const id = decodeId(capMatch[1]);
    if (id === null) return jsonRes(res, 400, { error: "Bad jobId" });
    if (!isAuthorizedForJob(req, url, id)) return jsonRes(res, 403, { error: "Forbidden" });
    if (method === "PUT" && !writeRateLimiter.allow(id)) {
      return jsonRes(res, 429, { error: "リクエストが多すぎます。少し待ってから再試行してください。" });
    }
    return method === "GET"
      ? handleGetCaptions(req, res, id)
      : handlePutCaptions(req, res, id);
  }

  // POST /api/jobs/:id/terms（直した語を用語辞書へ）
  const termMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/terms$/);
  if (method === "POST" && termMatch) {
    const id = decodeId(termMatch[1]);
    if (id === null) return jsonRes(res, 400, { error: "Bad jobId" });
    if (!isAuthorizedForJob(req, url, id)) return jsonRes(res, 403, { error: "Forbidden" });
    if (!writeRateLimiter.allow(id)) {
      return jsonRes(res, 429, { error: "リクエストが多すぎます。少し待ってから再試行してください。" });
    }
    return handlePostTerms(req, res, id);
  }

  // POST /api/jobs/:id/cancel（AUD-P1-11a: 実行中のジョブを手動でキャンセルする）
  const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (method === "POST" && cancelMatch) {
    const id = decodeId(cancelMatch[1]);
    if (id === null) return jsonRes(res, 400, { error: "Bad jobId" });
    if (!isAuthorizedForJob(req, url, id)) return jsonRes(res, 403, { error: "Forbidden" });
    if (!writeRateLimiter.allow(id)) {
      return jsonRes(res, 429, { error: "リクエストが多すぎます。少し待ってから再試行してください。" });
    }
    return handleCancelJob(req, res, id);
  }

  // POST /api/jobs/:id/recaption（直した字幕で焼き直す）
  const recapMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/recaption$/);
  if (method === "POST" && recapMatch) {
    const id = decodeId(recapMatch[1]);
    if (id === null) return jsonRes(res, 400, { error: "Bad jobId" });
    if (!isAuthorizedForJob(req, url, id)) return jsonRes(res, 403, { error: "Forbidden" });
    if (!writeRateLimiter.allow(id)) {
      return jsonRes(res, 429, { error: "リクエストが多すぎます。少し待ってから再試行してください。" });
    }
    return handleRecaption(req, res, id);
  }

  // GET /api/clips/:id/:file
  const clipMatch = pathname.match(/^\/api\/clips\/([^/]+)\/([^/]+)$/);
  if (method === "GET" && clipMatch) {
    // pathname は percent-encode のまま。日本語ファイル名を実体に合わせて復号する
    // （復号後に safeFile が ../ 等を検査するため traversal は防がれる）
    let id, file;
    try {
      id = decodeURIComponent(clipMatch[1]);
      file = decodeURIComponent(clipMatch[2]);
    } catch (_) {
      res.writeHead(400);
      return res.end("Bad clip path");
    }
    if (!isAuthorizedForJob(req, url, id)) return jsonRes(res, 403, { error: "Forbidden" });
    return handleClip(req, res, id, file);
  }

  // GET / と静的ファイル
  if (method === "GET") {
    return serveStatic(req, res);
  }

  // それ以外
  res.writeHead(405);
  res.end("Method Not Allowed");
}

// ── グローバルクラッシュ保護 ──────────────────────────────────
// unhandledRejection / uncaughtException でプロセスが落ちると OS が全 TCP 接続を RST する。
// ハンドラを付けてログのみにしてプロセス継続させる。
process.on("uncaughtException", (err) => {
  process.stderr.write(`[FATAL uncaughtException] ${err.stack ?? err}\n`);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[FATAL unhandledRejection] ${reason?.stack ?? reason}\n`);
});

// ── サーバー起動 ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    process.stderr.write(`[server error] ${err.stack || err.message}\n`);
    if (!res.headersSent) {
      jsonRes(res, 500, { error: "Internal Server Error" });
    }
  });
});

// P1-13-C: だらだらとヘッダ・ボディを送り続ける接続にソケットを占有され続けないよう、
// Node既定値任せにせず明示的な値を設定する。
// headersTimeout はヘッダ受信のみに掛かるため、20秒あれば正規のリクエストには十分。
// requestTimeout は動画アップロード(最大500MB、低速回線での完了まで)を壊さないよう、
// Node既定(300秒)より長い10分を明示する(値そのものより「上限が明示されている」ことが
// 目的。既定値のままだと将来のNodeバージョン更新で黙って変わりうる)。
// なお requestTimeout はレスポンスヘッダ送信後の接続(SSE購読等)には適用されない。
server.headersTimeout = 20_000;
server.requestTimeout = 600_000;

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[ai-editer] server listening on http://127.0.0.1:${PORT}\n`);
});
