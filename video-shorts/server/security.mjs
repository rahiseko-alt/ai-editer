// server/security.mjs — localhost API のハードニング(P1-2)。副作用なし・単体テスト用に分離。
// 同じPC上の別アプリ/悪意あるWebページから、勝手にジョブを起動されたりファイルを盗まれたりしない
// ようにするための5点: (A)起動時トークン (B)Origin/Host検証 (C)magic byte検証
// (D)アップロードサイズ上限 (E)レート制限。

import crypto from "node:crypto";

/** 起動ごとに変わるランダムトークンを生成する(A)。 */
export function generateStartupToken() {
  return crypto.randomBytes(24).toString("hex");
}

/** リクエストからトークンを取り出す。ヘッダ(fetch用)とクエリ(EventSourceはカスタムヘッダ不可のため)の両対応。 */
export function extractToken(req, searchParams) {
  const header = req.headers["x-kosespark-token"];
  if (typeof header === "string" && header) return header;
  const q = searchParams?.get("token");
  return q || null;
}

/** 起動時トークンと一致するか(タイミング攻撃を避けるため長さ一致後にtimingSafeEqual)。 */
export function isValidToken(candidate, expected) {
  if (typeof candidate !== "string" || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Host ヘッダが 127.0.0.1:port / localhost:port のいずれかであること(B)。 */
export function isAllowedHost(hostHeader, port) {
  if (!hostHeader) return false;
  return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
}

/** Origin ヘッダが送られてきた場合のみ、127.0.0.1:port / localhost:port と一致すること(B)。
 *  Origin未送出(同一オリジンの一部のGET等)は許可し、Hostチェックに委ねる。 */
export function isAllowedOrigin(originHeader, port) {
  if (!originHeader) return true;
  return originHeader === `http://127.0.0.1:${port}` || originHeader === `http://localhost:${port}`;
}

/** アップロード上限(D)。既定500MB(長尺動画1本ぶんの現実的な上限)。 */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/** 既知の動画コンテナのmagic byteだけを許可する(C)。誤検知よりも「本物の動画ファイルのはず」を優先。 */
const VIDEO_SIGNATURES = [
  // MP4/MOV系: バイト4-7が "ftyp"
  (buf) => buf.length >= 8 && buf.subarray(4, 8).toString("ascii") === "ftyp",
  // WebM/Matroska (EBML header)
  (buf) => buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3,
  // AVI (RIFF....AVI )
  (buf) =>
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "AVI ",
  // MPEG-TS (先頭が同期バイト0x47。188バイト境界で複数回現れるのが正だが、先頭のみ簡易確認)
  (buf) => buf.length >= 1 && buf[0] === 0x47,
];

export function looksLikeVideo(buf) {
  return VIDEO_SIGNATURES.some((check) => {
    try {
      return check(buf);
    } catch (_) {
      return false;
    }
  });
}

/**
 * 固定ウィンドウのレート制限(E)。key単位でカウントし、ウィンドウ内で上限を超えたら false。
 * 単一利用者のローカルツール前提のため、単純な固定ウィンドウで十分(分散攻撃を想定しない)。
 * nowClock は時刻取得を差し替え可能にする(テストで実時間を待たずウィンドウ経過を検証するため)。
 */
export function createRateLimiter({ windowMs, max, nowClock = Date.now }) {
  const hits = new Map(); // key -> { count, windowStart }
  return {
    allow(key) {
      const now = nowClock();
      const entry = hits.get(key);
      if (!entry || now - entry.windowStart >= windowMs) {
        hits.set(key, { count: 1, windowStart: now });
        return true;
      }
      if (entry.count >= max) return false;
      entry.count++;
      return true;
    },
  };
}
