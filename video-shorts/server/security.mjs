// server/security.mjs — localhost API のハードニング(P1-2・P1-4・P1-6)。副作用なし(ジョブトークン
// registryと、その再起動復元用のworkDir永続化ファイルを除く)・単体テスト用に分離。同じPC上の
// 別アプリ/悪意あるWebページ、あるいは同じ起動時トークンを持つ「他のジョブの作成者」から、勝手に
// ジョブを起動されたり他人の成果物にアクセスされたりしないようにするための項目群:
//   P1-2: (A)起動時トークン (B)Origin/Host検証 (C)magic byte検証 (D)アップロードサイズ上限 (E)レート制限
//   P1-4: (A)ジョブIDの暗号学的ランダム化 (B)成果物取得のジョブ別認可(ジョブトークン)
//   P1-6: プロセス再起動後もジョブトークンで正規に再接続できるようworkDirへ永続化

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 起動ごとに変わるランダムトークンを生成する(P1-2-A)。 */
export function generateStartupToken() {
  return crypto.randomBytes(24).toString("hex");
}

/** リクエストから任意名のトークンを取り出す。ヘッダ(fetch用)とクエリ(EventSourceはカスタム
 *  ヘッダ不可のため)の両対応。headerName は小文字(Node はヘッダ名を小文字化して渡す)。 */
export function extractNamedToken(req, searchParams, headerName, queryName) {
  const header = req.headers[headerName];
  if (typeof header === "string" && header) return header;
  const q = searchParams?.get(queryName);
  return q || null;
}

/** リクエストから起動時トークンを取り出す(P1-2-A)。 */
export function extractToken(req, searchParams) {
  return extractNamedToken(req, searchParams, "x-ai-editer-token", "token");
}

/** リクエストからジョブトークンを取り出す(P1-4-B)。 */
export function extractJobToken(req, searchParams) {
  return extractNamedToken(req, searchParams, "x-ai-editer-job-token", "jobToken");
}

/** トークンが一致するか(タイミング攻撃を避けるため長さ一致後にtimingSafeEqual)。
 *  expected が無い(未発行・存在しないジョブ等)場合は常に false。 */
export function isValidToken(candidate, expected) {
  if (typeof candidate !== "string" || !candidate) return false;
  if (typeof expected !== "string" || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * ジョブ別トークンのregistry(P1-4-B)。起動時トークンは全ジョブ共通のため、それだけでは
 * 「自分が作成したジョブ以外の成果物を推測/横取りできない」ことを保証できない。ジョブ作成時に
 * 発行し、そのジョブのSSE/候補JSON/クリップ取得のいずれにも一致を必須にする。
 */
const jobTokens = new Map(); // jobId -> token

/** ジョブ作成時に一度だけ呼び、そのジョブ専用のトークンを発行する。 */
export function issueJobToken(jobId) {
  const token = crypto.randomBytes(16).toString("hex");
  jobTokens.set(jobId, token);
  return token;
}

/** 指定ジョブのトークンと一致するか。ジョブ自体が存在しなければ常に false。 */
export function isValidJobToken(jobId, candidate) {
  return isValidToken(candidate, jobTokens.get(jobId));
}

/**
 * P1-6: jobTokens registry はプロセス再起動で消える(メモリのみ)。再起動後も、以前このプロセスが
 * 正規に発行したトークンでの再接続(SSE再購読)を許可できるよう、workDir配下にも同じトークンを
 * 永続化しておく(state.jsonと同じ信頼境界=ローカルの作業ディレクトリ)。
 */
export function persistJobToken(workDir, token) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "job-token.txt"), token, "utf-8");
}

/** 永続化されたジョブトークンを読む(無ければ null)。 */
export function loadPersistedJobToken(workDir) {
  const p = path.join(workDir, "job-token.txt");
  if (!fs.existsSync(p)) return null;
  const v = fs.readFileSync(p, "utf-8").trim();
  return v || null;
}

/** 既に発行済みのトークンをメモリのregistryへ再登録する(新規生成しない点がissueJobTokenと異なる)。
 *  再起動後、永続化トークンとの一致を確認できた場合にのみ呼ぶ想定。 */
export function restoreJobToken(jobId, token) {
  jobTokens.set(jobId, token);
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

const TS_PACKET_SIZE = 188;
const TS_MIN_SYNC_COUNT = 4;

/** looksLikeVideo()が判定に必要とする最大の先頭バイト数(呼び出し側は、この量が集まるまで
 *  複数チャンクにまたがっても構わないので判定を遅らせる必要がある。単一チャンクが必ずこの
 *  サイズ以上とは限らない=実際にCodeRabbitレビューで指摘され是正した点)。 */
export const SNIFF_BYTES = TS_PACKET_SIZE * TS_MIN_SYNC_COUNT;

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
  // MPEG-TS (188バイト境界で同期バイト0x47が連続4回以上現れることを要求。先頭1バイトのみの
  // 判定だと「先頭バイトがたまたま0x47の非動画ファイル」を通してしまう=独立検証で実証された
  // バイパスのため、複数パケットの同期を必須にする)
  (buf) => {
    if (buf.length < SNIFF_BYTES) return false;
    for (let i = 0; i < TS_MIN_SYNC_COUNT; i++) {
      if (buf[i * TS_PACKET_SIZE] !== 0x47) return false;
    }
    return true;
  },
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
 * ストリーミングアップロードの先頭バイト列を、チャンクをまたいで蓄積してから1回だけ
 * looksLikeVideo()判定するための状態機械。TCPの都合で最初のdataチャンクがSNIFF_BYTES
 * 未満のことがありうるため(単一チャンクのみで判定すると正当なMPEG-TSが誤って415になり
 * うる=CodeRabbitレビューで指摘され是正)、判定に十分な先頭バイト数が揃うか入力が終端
 * するまで判定を遅らせる。socketの生ロジックから切り離し単体テスト可能にする。
 */
export function createSignatureSniffer() {
  let chunks = [];
  let bytes = 0;
  let decided = false;

  function decide() {
    decided = true;
    const head = Buffer.concat(chunks, bytes);
    chunks = [];
    return { decided: true, ok: looksLikeVideo(head), head };
  }

  return {
    /** チャンクを追加する。十分な先頭バイト数が揃った時点で{decided:true,ok,head}を返し、
     *  まだならchunkをバッファに溜めるだけで{decided:false}を返す。 */
    push(chunk) {
      if (decided) throw new Error("createSignatureSniffer: 判定済みチャンクへのpushは不正");
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes < SNIFF_BYTES) return { decided: false };
      return decide();
    },
    /** 入力が終端した(=SNIFF_BYTES未満のまま全量を受け取った)場合、集まった分だけで確定判定する。 */
    finish() {
      if (decided) throw new Error("createSignatureSniffer: 判定済み後のfinishは不正");
      return decide();
    },
  };
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
