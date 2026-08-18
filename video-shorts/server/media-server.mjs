// server/media-server.mjs — GET /media/:jobId/:filename（完成動画の配信エンドポイント）。
//
// .runtime/outputs/<jobId>/ 配下は「私（メインの Claude セッション）」が result.mp4 等を書く。
// このサーバーは読んで配信するだけ。パス検証は自作せず、既存の src/safe-path.mjs
// （safeBasename / resolveInside）を再利用する（マスター指示）。

import fs from "node:fs";
import path from "node:path";

import { safeBasename, resolveInside } from "../src/safe-path.mjs";
import { isValidJobId, outputsRootDir } from "./runtime-paths.mjs";
import { sendError } from "./http-utils.mjs";

const MIME_BY_EXT = {
  ".mp4": "video/mp4",
};

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

export function handleMedia(req, res, rawJobId, rawFilename) {
  if (!isValidJobId(rawJobId)) {
    return sendError(res, 400, "不正な jobId です");
  }

  let filename;
  try {
    filename = decodeURIComponent(rawFilename);
  } catch (_err) {
    return sendError(res, 400, "不正なファイル名です");
  }

  let filePath;
  try {
    // jobId は isValidJobId() 済み（UUID形式の文字集合のみ）なので、それ自体は安全な
    // 単純トークンだが、対象ディレクトリの内側に収まっているかを I/O 直前に必ず検査する。
    const jobDir = resolveInside(outputsRootDir(), rawJobId);
    const safeName = safeBasename(filename, { allowedExt: [".mp4"] });
    filePath = resolveInside(jobDir, safeName);
  } catch (err) {
    return sendError(res, 400, err.message);
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_err) {
    return sendError(res, 404, "ファイルが見つかりません");
  }
  if (!stat.isFile()) {
    return sendError(res, 404, "ファイルが見つかりません");
  }

  const contentType = MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;

  if (range) {
    const match = RANGE_RE.exec(range);
    if (!match) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start > end ||
      start < 0 ||
      end >= stat.size
    ) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      "Content-Type": contentType,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(filePath).pipe(res);
}
