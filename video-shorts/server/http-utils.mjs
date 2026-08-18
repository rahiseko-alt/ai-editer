// server/http-utils.mjs — レスポンス送出の共通ヘルパー（依存ゼロ、node:http の素の API のみ）。

/**
 * JSON レスポンスを送る。エラー形は UI 側契約に合わせ { error: { message } } を使う。
 */
export function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}

export function sendError(res, status, message) {
  sendJson(res, status, { error: { message } });
}
