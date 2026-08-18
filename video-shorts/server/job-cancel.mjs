// server/job-cancel.mjs — POST /api/jobs/:id/cancel（中止依頼）。
//
// 2026-08-18 マスター指示「中止機能が欲しい」。
//
// このサーバーは動画処理そのものを行わない（実処理は edit-job.mjs を実行するメインの
// Claude セッション側）。そのためサーバー単体では処理を止められない。ここでの役割は、
// work/<jobId>/.cancel という空ファイルを置くことだけ。edit-job.mjs は各工程の合間に
// このファイルの有無を確認し、見つかったらその時点で処理を打ち切る（実行中の1工程の
// 途中では止めない＝ffmpeg等の呼び出し単位で安全に打ち切れる粒度に留める）。
// UI 側は、このAPIの応答を待たずに即座に「処理前」の見た目へ戻る（サーバーがフラグを
// 拾って実際に止まるまでの間、UIを待たせないため）。

import fs from "node:fs";

import { isValidJobId, workJobDir, ensureDir } from "./runtime-paths.mjs";
import { sendError, sendJson } from "./http-utils.mjs";

export function handleJobCancel(req, res, jobId) {
  if (!isValidJobId(jobId)) {
    return sendError(res, 400, "不正な jobId です");
  }
  const dir = workJobDir(jobId);
  ensureDir(dir);
  fs.writeFileSync(`${dir}/.cancel`, "", "utf-8");
  return sendJson(res, 200, { ok: true });
}
