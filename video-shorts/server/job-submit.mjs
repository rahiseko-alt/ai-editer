// server/job-submit.mjs — POST /api/jobs（ジョブ投入エンドポイント）。
//
// UI の送信ボタンから multipart/form-data で受け取り、動画があれば
// .runtime/uploads/<jobId>/<元ファイル名> へ保存し、.runtime/chat-inbox.jsonl へ1行追記する。
// このファイル自身は動画編集・AIの判断を一切行わない（ジョブの受付と受け渡しだけ）。

import crypto from "node:crypto";
import fs from "node:fs/promises";

import { parseMultipart, parseBoundary, MultipartError } from "./multipart.mjs";
import { createFileSink } from "./file-sink.mjs";
import { resolveInside } from "../src/safe-path.mjs";
import { chatInboxPath, uploadsJobDir, ensureDir, removeDirRecursive, appendJsonLine } from "./runtime-paths.mjs";
import { sendError, sendJson } from "./http-utils.mjs";

// マスター指示: 無制限に受信しない。既定2GB、環境変数で上書き可能。
const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
function maxUploadBytes() {
  const raw = Number(process.env.VS_MAX_UPLOAD_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_UPLOAD_BYTES;
}

const ASPECTS = new Set(["portrait", "landscape"]);
const MAX_OUTPUT_COUNT = 20;

// Windows のファイル名で使えない記号（制御文字はコード点で別途判定する。
// 正規表現の文字クラスへ バックスラッシュ0 のような制御文字エスケープを書くと編集ツール上で
// 化けやすいため、1文字ずつの比較で実装する）。
const FORBIDDEN_FILENAME_CHARS = new Set(["<", ">", ":", '"', "|", "?", "*"]);

// Windows のパス長上限（約260文字）に対する安全マージン。uploads/<jobId>/ 配下に置くため
// ディレクトリ部分（.runtime/uploads/<uuid>/）の分の余裕も見て、ファイル名自体はこれより
// 十分短く切り詰める（本質的な修正は非同期エラー捕捉漏れの修正だが、予防としても入れておく）。
const MAX_FILENAME_LENGTH = 200;

// Windows の予約デバイス名（大文字小文字を問わず、拡張子付きでも無効）。
const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/**
 * ブラウザが送ってくる元ファイル名を、保存に使えるファイル名へ整える。
 * ディレクトリ区切り・制御文字・Windowsで禁止された文字を除去する。
 * 最終的な保存先パスは呼び出し側で resolveInside() により再検証する（多層防御）。
 */
function sanitizeUploadFilename(rawName) {
  const fallback = "video";
  if (typeof rawName !== "string" || rawName.length === 0) return fallback;
  const base = rawName.split(/[\\/]/).pop() || fallback;
  let out = "";
  for (const ch of base) {
    const code = ch.codePointAt(0);
    const isControl = code < 0x20 || code === 0x7f;
    if (isControl || FORBIDDEN_FILENAME_CHARS.has(ch)) continue;
    out += ch;
  }
  let cleaned = out.trim();
  cleaned = cleaned.replace(/^\.+/, "").replace(/[.\s]+$/, "");
  if (cleaned === "" || cleaned === "." || cleaned === "..") return fallback;
  if (cleaned.length > MAX_FILENAME_LENGTH) {
    // 拡張子はできるだけ残す（末尾の "." 以降・16文字までを拡張子とみなす簡易判定で十分）。
    const dotIdx = cleaned.lastIndexOf(".");
    const ext = dotIdx > 0 && cleaned.length - dotIdx <= 16 ? cleaned.slice(dotIdx) : "";
    const stem = ext ? cleaned.slice(0, dotIdx) : cleaned;
    cleaned = stem.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
  }
  const stemForReservedCheck = cleaned.includes(".") ? cleaned.slice(0, cleaned.indexOf(".")) : cleaned;
  if (WINDOWS_RESERVED_NAMES.has(stemForReservedCheck.toUpperCase())) {
    cleaned = `_${cleaned}`;
  }
  return cleaned;
}

export async function handleJobSubmit(req, res) {
  const boundary = parseBoundary(req.headers["content-type"]);
  if (!boundary) {
    return sendError(res, 400, "Content-Type は multipart/form-data である必要があります");
  }

  const limit = maxUploadBytes();
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    return sendError(res, 413, `アップロードサイズが上限（${limit}バイト）を超えています`);
  }

  const jobId = crypto.randomUUID();
  const fields = {};
  let videoInfo = null; // { path, originalName }
  let fileSink = null;

  function cleanupUpload() {
    removeDirRecursive(uploadsJobDir(jobId));
  }

  try {
    await parseMultipart(req, boundary, {
      maxBytes: limit,
      onField(name, value) {
        fields[name] = value;
      },
      onFile(name, filename) {
        if (name !== "video") return null; // 想定外のファイルフィールドは読み捨てる
        const jobDir = uploadsJobDir(jobId);
        ensureDir(jobDir);
        const safeName = sanitizeUploadFilename(filename);
        const targetPath = resolveInside(jobDir, safeName);
        videoInfo = { path: targetPath, originalName: filename || safeName };
        fileSink = createFileSink(targetPath);
        return fileSink;
      },
    });
  } catch (err) {
    cleanupUpload();
    if (err instanceof MultipartError) {
      return sendError(res, err.status, err.message);
    }
    return sendError(res, 400, "リクエストの解析に失敗しました");
  }

  if (fileSink) {
    // ストリームの 'error' は非同期に（open のタイミング等で遅れて）発火しうるため、
    // parseMultipart() が resolve した直後に hadError() を見ても間に合わないことがある
    // （例: Windowsのパス長上限超過）。ストリームが実際に閉じるまで待ってから判定する。
    await fileSink.waitClose();
    if (fileSink.hadError()) {
      cleanupUpload();
      return sendError(res, 500, "動画の保存に失敗しました");
    }
    // 実際にディスクへ書き込めたバイト数を、受け取ったバイト数と突き合わせて検証する
    // （非同期エラーの取りこぼしに対する多層防御）。
    try {
      const st = await fs.stat(videoInfo.path);
      if (st.size !== fileSink.bytesWritten()) {
        cleanupUpload();
        return sendError(res, 500, "動画の保存に失敗しました（書き込みサイズが一致しません）");
      }
    } catch (_err) {
      cleanupUpload();
      return sendError(res, 500, "動画の保存に失敗しました");
    }
  }

  // --- 入力 validation（すべて必須。不正なら 400 で拒否し、保存済みアップロードは破棄する） ---
  // instruction は「空文字（指示なしで自動編集）」と「欄ごと送られてこなかった（UIの不具合・
  // 手書きリクエスト）」を区別する。後者を空文字として黙って通すと、指示が消えても誰も
  // 気づけない（2026-08-19 マスター指摘「指示欄に入れた指示が反映されない」の一因）。
  if (typeof fields.instruction !== "string") {
    cleanupUpload();
    return sendError(res, 400, "instruction 欄がありません（指示なしで実行する場合も空文字で送ってください）");
  }
  const instruction = fields.instruction;

  const aspect = fields.aspect;
  if (!ASPECTS.has(aspect)) {
    cleanupUpload();
    return sendError(res, 400, "aspect は portrait または landscape を指定してください");
  }

  const captionRaw = typeof fields.caption === "string" ? fields.caption.toLowerCase() : "";
  if (captionRaw !== "true" && captionRaw !== "false") {
    cleanupUpload();
    return sendError(res, 400, "caption は true または false を指定してください");
  }
  const caption = captionRaw === "true";

  // 【2026-08-19 削除】targetDurationSec（目標の尺）。マスター判断で撤去した。
  // 必須の数値目標だったため、編集の AI が意味の完結より尺合わせを優先し、動画の掴みや
  // 機能の説明を尺のために落としていた（.runtime/work/*/decision.json に記録が残っている）。
  // 尺を指定したいときは instruction に「1分半で」と書く＝意味と天秤にかけられる制約になる。

  const outputCount = Number(fields.outputCount);
  if (!Number.isInteger(outputCount) || outputCount < 1 || outputCount > MAX_OUTPUT_COUNT) {
    cleanupUpload();
    return sendError(res, 400, `outputCount は1以上${MAX_OUTPUT_COUNT}以下の整数を指定してください`);
  }

  const record = {
    id: jobId,
    at: new Date().toISOString(),
    instruction,
    video: videoInfo ? { path: videoInfo.path, originalName: videoInfo.originalName } : null,
    settings: { aspect, caption, outputCount },
  };

  try {
    appendJsonLine(chatInboxPath(), record);
  } catch (_err) {
    cleanupUpload();
    return sendError(res, 500, "ジョブの登録に失敗しました");
  }

  // 受け付けた指示をそのまま返す。UI はこれを「この指示で編集します」として画面に出し、
  // マスターが送ったつもりの文と、サーバーが実際に受け取った文を突き合わせられるようにする。
  sendJson(res, 201, { jobId, instruction });
}
