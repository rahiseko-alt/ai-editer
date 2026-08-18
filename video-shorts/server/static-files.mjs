// server/static-files.mjs — video-shorts/ui/ を配信するだけの簡単な静的サーバー。
//
// frontend-engineer-agent が作る成果物をブラウザで開けるようにするためのもので、
// ui/ の中身自体には一切触れない（読んで返すだけ）。パス検証は既存の src/safe-path.mjs
// の resolveInside() を再利用する。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveInside } from "../src/safe-path.mjs";
import { sendError } from "./http-utils.mjs";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(SERVER_DIR, "..", "ui");

const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function serveStatic(req, res, pathname) {
  const relRaw = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let rel;
  try {
    rel = decodeURIComponent(relRaw);
  } catch (_err) {
    return sendError(res, 400, "不正なURLです");
  }

  let filePath;
  try {
    filePath = resolveInside(UI_DIR, rel);
  } catch (_err) {
    return sendError(res, 404, "見つかりません");
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_err) {
    return sendError(res, 404, "見つかりません");
  }
  if (stat.isDirectory()) {
    try {
      filePath = resolveInside(filePath, "index.html");
      stat = fs.statSync(filePath);
    } catch (_err) {
      return sendError(res, 404, "見つかりません");
    }
  }

  const contentType = MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(filePath).pipe(res);
}
