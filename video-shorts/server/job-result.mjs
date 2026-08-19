// server/job-result.mjs — GET /api/jobs/:id/result（同期的な完了確認・状態復元用エンドポイント）。
//
// 【なぜ要るか（2026-08-19 実際に起きた事故）】
// ジョブの完了通知は本来 SSE（job-events.mjs）で届く。だがその受信は「投入したブラウザタブが
// 最後まで開いたまま」という前提に依存しており、実際には満たされない（タブのリロード、別タブでの
// 再訪問、処理そのものがタブと無関係な別プロセスで進む、等）。この日、タブをリロードしたら完了済みの
// 動画が画面から消え、devtools で player.src を直接書き換える対症療法をした結果、
// 今度は exportBtn（ダウンロードボタン）が有効化されないまま＝別の症状が同じ根因から再発した。
//
// このエンドポイントは、ページ読み込み時に「前回のジョブが今どうなっているか」を1回だけ同期的に
// 問い合わせるためのもの。SSE と違って接続を張りっぱなしにしない（ui/app.js の recoverLastJob() 参照）。
//
// .runtime/results.jsonl と .runtime/chat-inbox.jsonl はどちらも「私（メインの Claude セッション）」
// が書き、このサーバーは読むだけ（既存の他エンドポイントと同じ原則）。

import { isValidJobId, chatInboxPath, findJsonlRecordById } from "./runtime-paths.mjs";
import { sendError, sendJson } from "./http-utils.mjs";
import { findResultLine } from "./job-events.mjs";

export async function handleJobResult(req, res, jobId) {
  if (!isValidJobId(jobId)) {
    return sendError(res, 400, "不正な jobId です");
  }

  let result;
  try {
    result = await findResultLine(jobId);
  } catch (_err) {
    return sendError(res, 500, "results.jsonl の読み込みに失敗しました");
  }
  if (result) {
    return sendJson(res, 200, { done: true, record: result });
  }

  // まだ results.jsonl に無い。chat-inbox.jsonl に記録があれば「投入済み・処理中」と判定できる
  // （このファイルは追記専用で消えないので、投入した事実は消えない）。
  let submitted;
  try {
    submitted = await findJsonlRecordById(chatInboxPath(), jobId);
  } catch (_err) {
    return sendError(res, 500, "chat-inbox.jsonl の読み込みに失敗しました");
  }
  if (!submitted) {
    // どちらにも記録が無い＝このサーバーが受け付けたジョブではない
    // （.runtime が掃除された後の古い localStorage 参照、手で書き換えた不正な jobId 等）。
    // UI 側はこれを「知らないジョブ」として静かに諦める契約（onJobResult は呼ばない）。
    return sendError(res, 404, "指定された jobId のジョブが見つかりません");
  }
  return sendJson(res, 200, { done: false, submittedAt: submitted.at });
}
