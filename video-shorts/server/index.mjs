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

const PORT = Number(process.env.PORT ?? 5178);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATIC_ROOT = path.join(ROOT, "webapp-mockup");
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");

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
  // 日本語等の Unicode 文字・数字・ハイフン・アンダースコアを許可（makeJobId と整合）。
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

/** jobId を入力ファイル名から生成（pipeline.mjs cmdInit と同じ規則） */
function makeJobId(filename) {
  return path
    .basename(filename)
    .replace(/\.[^.]+$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-");
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
  const sub = url.searchParams.get("sub") === "on" ? "on" : "none";
  const cut = url.searchParams.get("cut") ?? "topic";
  const size = url.searchParams.get("size") ?? "9:16";
  const name = url.searchParams.get("name") ?? "upload.mp4";

  // ファイル名からジョブID生成・サニタイズ
  const rawId = makeJobId(name);
  const jobId = safeId(rawId);
  if (!jobId) {
    return jsonRes(res, 400, { error: "無効なファイル名" });
  }

  const ext = path.extname(name) || ".mp4";
  const workDir = path.join(WORK_ROOT, jobId);
  fs.mkdirSync(workDir, { recursive: true });
  const inputPath = path.join(workDir, `input${ext}`);

  // リクエストボディをストリームで保存（全量メモリ展開しない）
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(inputPath);
    req.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
    req.on("error", reject);
  });

  // ジョブをキックして即レスポンス（走行中なら 409 で拒否＝連打事故防止）
  const started = startJob(jobId, inputPath, { sub, cut, size });
  if (!started) {
    return jsonRes(res, 409, { error: "already running", jobId });
  }

  return jsonRes(res, 202, { jobId });
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

// ── ルーティング ─────────────────────────────────────────────
async function handleRequest(req, res) {
  const { pathname } = new URL(req.url, "http://x");
  const method = req.method.toUpperCase();

  // POST /api/jobs
  if (method === "POST" && pathname === "/api/jobs") {
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
    return handleJobEvents(req, res, id);
  }

  // GET /api/jobs/:id/candidates
  const candMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/candidates$/);
  if (method === "GET" && candMatch) {
    const id = decodeId(candMatch[1]);
    if (id === null) return jsonRes(res, 400, { error: "Bad jobId" });
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
