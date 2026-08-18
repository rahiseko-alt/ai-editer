// server/job-events.mjs — GET /api/jobs/:id/events（完了通知エンドポイント、Server-Sent Events）。
//
// .runtime/results.jsonl は「私（メインの Claude セッション）」が書く。このサーバーは読むだけ。
// 監視はポーリング（数百ms間隔でファイルを読み直す）。DB等の重い仕組みは使わない。

import fs from "node:fs/promises";

import { isValidJobId, resultsPath } from "./runtime-paths.mjs";
import { sendError } from "./http-utils.mjs";

const POLL_INTERVAL_MS = Number(process.env.VS_SSE_POLL_MS) > 0 ? Number(process.env.VS_SSE_POLL_MS) : 400;
const HEARTBEAT_MS = 15000;

/**
 * results.jsonl 全体を読み、id が一致する行があれば parse して返す。無ければ null。
 * 書き込み最中の不完全な行（rename ではなく append のjsonlなので理論上は起き得るが、
 * appendFileSync による1回のwriteなのでほぼ起きない）は JSON.parse 失敗として読み飛ばし、
 * 次のポーリングで再読込する。
 */
async function findResultLine(jobId) {
  let text;
  try {
    text = await fs.readFile(resultsPath(), "utf-8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch (_err) {
      continue;
    }
    if (obj && obj.id === jobId) return obj;
  }
  return null;
}

export function handleJobEvents(req, res, jobId) {
  if (!isValidJobId(jobId)) {
    return sendError(res, 400, "不正な jobId です");
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  let closed = false;
  let pollTimer = null;
  let heartbeatTimer = null;

  function cleanup() {
    closed = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
  req.on("close", cleanup);
  // 多層防御: 万一 write() が破棄済みソケットへ向いてしまい 'error' が起きても、
  // ここで拾って cleanup するだけにする（無リスナーの 'error' は Node プロセス全体を
  // クラッシュさせるため、必ずリスナーを登録しておく）。
  res.on("error", cleanup);

  res.write(": connected\n\n");

  async function poll() {
    if (closed) return;
    let found;
    try {
      found = await findResultLine(jobId);
    } catch (_err) {
      // await の間にクライアントが切断している可能性があるため、書き込み前に必ず再チェックする。
      if (closed) return;
      res.write(`event: error\ndata: ${JSON.stringify({ message: "results.jsonl の読み込みに失敗しました" })}\n\n`);
      cleanup();
      res.end();
      return;
    }
    // await の間にクライアントが切断（'close'）している可能性があるため、書き込み前に必ず再チェックする。
    if (closed) return;
    if (found) {
      res.write(`event: result\ndata: ${JSON.stringify(found)}\n\n`);
      cleanup();
      res.end();
      return;
    }
    if (!closed) pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  }

  heartbeatTimer = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, HEARTBEAT_MS);

  poll();
}
