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
} from "./pipeline-runner.mjs";
import { parseJobParams } from "./job-params.mjs";
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
} from "./security.mjs";

const PORT = Number(process.env.PORT ?? 5178);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATIC_ROOT = path.join(ROOT, "webapp-mockup");
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");

// P1-2(A): 起動ごとに変わるトークン。正規のページ(index.html)にのみ埋め込んで配布する。
const SERVER_TOKEN = generateStartupToken();
process.stderr.write(`[kosespark] startup token (このプロセス限り有効): ${SERVER_TOKEN}\n`);

// P1-2(E): ジョブ起動(POST /api/jobs)へのレート制限。単一利用者のローカルツール前提の固定ウィンドウ。
const jobsRateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

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
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
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

  const ext = path.extname(resolved).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";

  // P1-2(A): index.html にのみ起動時トークンを埋め込んで配布する（正規ページだけが読める。
  // 別オリジンの悪意あるページはこのレスポンス本文を読めないため、トークンを盗めない）。
  if (reqPath === "/index.html") {
    const html = fs.readFileSync(resolved, "utf-8");
    const tokenScript = `<script>window.__KOSESPARK_TOKEN__=${JSON.stringify(SERVER_TOKEN)};</script>\n`;
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

// ── POST /api/jobs ──────────────────────────────────────────
async function handlePostJobs(req, res) {
  // クエリパラメータ取得
  const url = new URL(req.url, "http://x");
  const { sub, cut, size, cutMin, mosaic, name } = parseJobParams(url.searchParams);

  // P1-2(E): レート制限（単一利用者のローカルツール前提の固定ウィンドウ）
  if (!jobsRateLimiter.allow("global")) {
    return jsonRes(res, 429, { error: "リクエストが多すぎます。少し待ってから再試行してください。" });
  }

  // P1-2(D): 宣言サイズが上限超過なら本文を受け取る前に拒否
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    return jsonRes(res, 413, { error: "ファイルが大きすぎます" });
  }

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
  const started = startJob(jobId, inputPath, { sub, cut, size, cutMin, mosaic });
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

  function push(line) {
    res.write(line);
  }
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
  const persisted = loadPersistedJobToken(path.join(WORK_ROOT, id));
  if (persisted && isValidToken(jobToken, persisted)) {
    restoreJobToken(id, persisted);
    return true;
  }
  return false;
}

// ── ルーティング ─────────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, "http://x");
  const { pathname } = url;
  const method = req.method.toUpperCase();

  if (pathname.startsWith("/api/")) {
    if (!isAllowedApiOrigin(req)) {
      return jsonRes(res, 401, { error: "Unauthorized" });
    }
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

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[kosespark] server listening on http://127.0.0.1:${PORT}\n`);
});
