// server/index.mjs — UI（ブラウザ）とメインの Claude セッションを繋ぐだけの中継ローカルサーバー。
//
// このファイル（および server/ 配下）は、AI の判断・動画処理を一切行わない。
// 行うのは次の7つだけ:
//   1. POST /api/jobs            — ジョブ投入（multipart） → .runtime/chat-inbox.jsonl へ追記
//   2. GET  /api/jobs/:id/events — 完了通知（SSE、.runtime/results.jsonl を読むだけ）
//   3. GET  /api/jobs/:id/result — 状態の同期確認（ページ読み込み時の1回きりの問い合わせ用。
//      SSEと違い接続を張らない。詳細は server/job-result.mjs）
//   4. GET  /api/jobs/:id/transcript — 編集前の文字起こし全文の配信（詳細は server/job-transcript.mjs）
//   5. POST /api/jobs/:id/cancel — 中止依頼（work/<jobId>/.cancel を置くだけ。実際の打ち切りは
//      edit-job.mjs 側がこのフラグを見て行う。詳細は server/job-cancel.mjs）
//   6. GET  /media/:jobId/:file  — 完成動画の配信（.runtime/outputs/ を読むだけ）
//   7. 上記以外の GET/HEAD       — video-shorts/ui/ の静的配信
//
// node:http 以外の依存は使わない（新規ライブラリ追加禁止・自前実装が方針）。
// マスター指示によりローカル専用（127.0.0.1 のみ bind、0.0.0.0 にはしない）。

import http from "node:http";

import { handleJobSubmit } from "./job-submit.mjs";
import { handleJobEvents } from "./job-events.mjs";
import { handleJobResult } from "./job-result.mjs";
import { handleJobTranscript } from "./job-transcript.mjs";
import { handleJobCancel } from "./job-cancel.mjs";
import { handleMedia } from "./media-server.mjs";
import { serveStatic } from "./static-files.mjs";
import { sendJson, sendError } from "./http-utils.mjs";

const HOST = "127.0.0.1"; // ローカル専用に縛る（マスター指示・外部ネットワークからアクセス不可にする）
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 5178;
const ALLOWED_ORIGIN = `http://${HOST}:${PORT}`;

const JOB_EVENTS_RE = /^\/api\/jobs\/([^/]+)\/events$/;
const JOB_RESULT_RE = /^\/api\/jobs\/([^/]+)\/result$/;
const JOB_TRANSCRIPT_RE = /^\/api\/jobs\/([^/]+)\/transcript$/;
const JOB_CANCEL_RE = /^\/api\/jobs\/([^/]+)\/cancel$/;
const MEDIA_RE = /^\/media\/([^/]+)\/([^/]+)$/;

// CSRF対策: multipart/form-data は CORS の "simple request" に該当し、外部の悪意あるWebページが
// 被害者のブラウザ経由でJS不要（フォーム自動送信のみ）でこのAPIへリクエストを送れてしまう。
// Origin ヘッダが付いている場合は自分自身のオリジンと一致することを要求する。
// Origin が無い場合（同一オリジンfetchで省略されることがある・curl等の非ブラウザ）はローカル専用
// ツールという前提のもと許可する（過剰な仕組みは不要という指示のため、簡潔な判定に留める）。
function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === ALLOWED_ORIGIN;
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("[video-shorts server] unhandled error:", err);
    if (!res.headersSent) sendError(res, 500, "サーバー内部エラーです");
    else res.end();
  });
});

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch (_err) {
    return sendError(res, 400, "不正なリクエストURLです");
  }
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, version: "0.1.0" });
  }

  if (req.method === "POST" && pathname === "/api/jobs") {
    if (!isAllowedOrigin(req)) {
      return sendError(res, 403, "許可されていない Origin からのリクエストです");
    }
    return handleJobSubmit(req, res);
  }

  const eventsMatch = JOB_EVENTS_RE.exec(pathname);
  if (req.method === "GET" && eventsMatch) {
    return handleJobEvents(req, res, decodeURIComponent(eventsMatch[1]));
  }

  const resultMatch = JOB_RESULT_RE.exec(pathname);
  if (req.method === "GET" && resultMatch) {
    return handleJobResult(req, res, decodeURIComponent(resultMatch[1]));
  }

  const transcriptMatch = JOB_TRANSCRIPT_RE.exec(pathname);
  if (req.method === "GET" && transcriptMatch) {
    return handleJobTranscript(req, res, decodeURIComponent(transcriptMatch[1]));
  }

  const cancelMatch = JOB_CANCEL_RE.exec(pathname);
  if (req.method === "POST" && cancelMatch) {
    if (!isAllowedOrigin(req)) {
      return sendError(res, 403, "許可されていない Origin からのリクエストです");
    }
    return handleJobCancel(req, res, decodeURIComponent(cancelMatch[1]));
  }

  const mediaMatch = MEDIA_RE.exec(pathname);
  if ((req.method === "GET" || req.method === "HEAD") && mediaMatch) {
    return handleMedia(req, res, decodeURIComponent(mediaMatch[1]), mediaMatch[2]);
  }

  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(req, res, pathname);
  }

  return sendError(res, 404, "not found");
}

server.listen(PORT, HOST, () => {
  console.log(`[video-shorts server] listening on http://${HOST}:${PORT}`);
});
