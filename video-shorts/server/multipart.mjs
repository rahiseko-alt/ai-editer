// server/multipart.mjs — multipart/form-data の自前ストリーミングパーサー。
//
// AGENTS.md / 発注指示により新規依存ライブラリの追加は禁止のため、`busboy` 等を使わず
// node:http の Readable ストリームを直接読む。動画ファイルはメモリに溜め込まず、
// 受信した端から書き込み先（onFile が返す sink）へ流す。フィールド（テキスト値）だけを
// 小さくメモリに保持する。
//
// 実装方針: 受信バッファに対して「今どの部分を読んでいるか」を state machine で管理し、
// 境界文字列 `--BOUNDARY` が複数チャンクにまたがっても正しく検出できるよう、
// 境界候補分の末尾バイトだけを次回へ持ち越す（ファイル本体を全量バッファしない）。

const CRLF = "\r\n";

// パート毎のヘッダー部分（Content-Disposition等）の上限。ヘッダーは通常小さいため、
// これを超えて CRLFCRLF（ヘッダー終端）が来ない場合は不正なリクエストとして即座に打ち切る。
// これが無いと、終端が来ないヘッダーを送り続けられた場合に buffer が無制限に
// Buffer.concat され続け、メモリを食い潰す（preamble/body state は末尾のみ保持するトリムが
// あるが、headers state には無かった）。
const MAX_HEADER_BYTES = 64 * 1024;

export class MultipartError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = "MultipartError";
    this.status = status;
  }
}

/**
 * Content-Type ヘッダーから boundary 文字列を取り出す。無ければ null。
 */
export function parseBoundary(contentType) {
  if (typeof contentType !== "string") return null;
  if (!/^multipart\/form-data/i.test(contentType.trim())) return null;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) return null;
  const boundary = (match[1] || match[2] || "").trim();
  return boundary || null;
}

function parseHeaderBlock(headerText) {
  const headers = {};
  for (const line of headerText.split(CRLF)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

/**
 * req（IncomingMessage）から multipart/form-data 本文を読み切る。
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {string} boundary Content-Type から取り出した boundary
 * @param {object} handlers
 * @param {(name: string, value: string) => void} handlers.onField
 * @param {(name: string, filename: string|null, contentType: string|null) => ({write(chunk: Buffer): void, end(): void, abort(): void} | null)} handlers.onFile
 *   ファイルパートの書き込み先を返す。null を返すとそのパートは読み捨てる。
 * @param {number} [handlers.maxBytes] 受信総バイト数の上限。超えたら MultipartError(413) で中断する。
 * @returns {Promise<void>}
 */
export function parseMultipart(req, boundary, { onField, onFile, maxBytes }) {
  return new Promise((resolve, reject) => {
    const boundaryBuf = Buffer.from(`--${boundary}`, "utf-8");
    const bodyMarker = Buffer.concat([Buffer.from(CRLF, "utf-8"), boundaryBuf]);
    const headerEndMarker = Buffer.from(CRLF + CRLF, "utf-8");

    let buffer = Buffer.alloc(0);
    let state = "preamble"; // preamble | after-boundary | headers | body | done
    let currentIsFile = false;
    let currentFieldName = null;
    let currentFileSink = null;
    let fieldChunks = [];
    let totalBytes = 0;
    let settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onErr);
      if (currentFileSink) {
        try {
          currentFileSink.abort();
        } catch (_err) {
          // ベストエフォート
        }
      }
      reject(err);
    }

    function succeed() {
      if (settled) return;
      settled = true;
      resolve();
    }

    function startPart(headerText) {
      const headers = parseHeaderBlock(headerText);
      const disposition = headers["content-disposition"] || "";
      const nameMatch = /name="([^"]*)"/i.exec(disposition);
      const filenameMatch = /filename="([^"]*)"/i.exec(disposition);
      currentFieldName = nameMatch ? nameMatch[1] : null;
      const filename = filenameMatch ? filenameMatch[1] : null;
      const contentType = headers["content-type"] || null;
      currentIsFile = Boolean(filenameMatch);
      fieldChunks = [];
      currentFileSink = null;
      if (currentIsFile && currentFieldName) {
        currentFileSink = onFile(currentFieldName, filename, contentType) || null;
      }
    }

    function pushBodyChunk(chunk) {
      if (chunk.length === 0) return;
      if (currentIsFile) {
        if (currentFileSink) currentFileSink.write(chunk);
      } else {
        fieldChunks.push(Buffer.from(chunk));
      }
    }

    function endPart() {
      if (currentIsFile) {
        if (currentFileSink) currentFileSink.end();
      } else if (currentFieldName !== null) {
        onField(currentFieldName, Buffer.concat(fieldChunks).toString("utf-8"));
      }
      currentFileSink = null;
      currentFieldName = null;
      currentIsFile = false;
      fieldChunks = [];
    }

    function process() {
      for (;;) {
        if (state === "preamble") {
          const idx = buffer.indexOf(boundaryBuf);
          if (idx === -1) {
            const keep = boundaryBuf.length;
            if (buffer.length > keep) buffer = buffer.subarray(buffer.length - keep);
            return;
          }
          buffer = buffer.subarray(idx + boundaryBuf.length);
          state = "after-boundary";
          continue;
        }
        if (state === "after-boundary") {
          if (buffer.length < 2) return;
          if (buffer[0] === 0x2d && buffer[1] === 0x2d) {
            state = "done";
            continue;
          }
          if (buffer.length < 2) return;
          if (buffer[0] === 0x0d && buffer[1] === 0x0a) {
            buffer = buffer.subarray(2);
            state = "headers";
            continue;
          }
          return fail(new MultipartError("不正な multipart 境界です"));
        }
        if (state === "headers") {
          const idx = buffer.indexOf(headerEndMarker);
          if (idx === -1) {
            if (buffer.length > MAX_HEADER_BYTES) {
              return fail(new MultipartError("multipart のヘッダーが大きすぎます", { status: 400 }));
            }
            return;
          }
          if (idx > MAX_HEADER_BYTES) {
            return fail(new MultipartError("multipart のヘッダーが大きすぎます", { status: 400 }));
          }
          const headerText = buffer.subarray(0, idx).toString("utf-8");
          buffer = buffer.subarray(idx + headerEndMarker.length);
          startPart(headerText);
          state = "body";
          continue;
        }
        if (state === "body") {
          const idx = buffer.indexOf(bodyMarker);
          if (idx === -1) {
            const keep = bodyMarker.length - 1;
            if (buffer.length > keep) {
              pushBodyChunk(buffer.subarray(0, buffer.length - keep));
              buffer = buffer.subarray(buffer.length - keep);
            }
            return;
          }
          pushBodyChunk(buffer.subarray(0, idx));
          endPart();
          buffer = buffer.subarray(idx + bodyMarker.length);
          state = "after-boundary";
          continue;
        }
        if (state === "done") {
          succeed();
          return;
        }
        return;
      }
    }

    function onData(chunk) {
      if (settled) return;
      totalBytes += chunk.length;
      if (maxBytes && totalBytes > maxBytes) {
        fail(new MultipartError(`アップロードサイズが上限（${maxBytes}バイト）を超えました`, { status: 413 }));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      try {
        process();
      } catch (err) {
        fail(err);
      }
    }

    function onEnd() {
      if (settled) return;
      if (state !== "done") {
        fail(new MultipartError("multipart の終端が不正です（本文が途中で切れています）"));
      }
    }

    function onErr(err) {
      fail(err);
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onErr);
  });
}
