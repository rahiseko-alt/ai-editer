// server/job-transcript.mjs — GET /api/jobs/:id/transcript（編集前の文字起こし全文を返す）。
//
// .runtime/work/<jobId>/transcript.json は edit-job.mjs の prepare が書き、このサーバーは読むだけ
// （既存の他エンドポイントと同じ原則）。words は文字/音節単位の断片（例:"コ","ンデ","ィ"...）なので、
// 間に空白を入れず連結して平文にする（空白を挟むと不自然な日本語になる）。

import fs from "node:fs";
import path from "node:path";

import { isValidJobId, workJobDir } from "./runtime-paths.mjs";
import { sendError, sendJson } from "./http-utils.mjs";

export async function handleJobTranscript(req, res, jobId) {
  if (!isValidJobId(jobId)) {
    return sendError(res, 400, "不正な jobId です");
  }

  const transcriptPath = path.join(workJobDir(jobId), "transcript.json");
  let raw;
  try {
    raw = await fs.promises.readFile(transcriptPath, "utf-8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return sendError(res, 404, "このジョブの文字起こしはまだありません");
    }
    return sendError(res, 500, "transcript.json の読み込みに失敗しました");
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (_err) {
    return sendError(res, 500, "transcript.json の内容を解釈できませんでした");
  }

  const words = Array.isArray(data.words) ? data.words : [];
  const text = words.map((w) => (w && typeof w.w === "string" ? w.w : "")).join("");
  return sendJson(res, 200, { text, duration: typeof data.duration === "number" ? data.duration : null });
}
