// server/claude-select.mjs — claude -p による区間選定（チャンク分割並列版）
// transcript.json を chunkSegments で分割し、各 chunk を個別の claude -p 呼び出しで
// 選定する（プール並列）。全 chunk の segments を統合して llm-response.json に書く。
// 「1 回で全文を渡してタイムアウト」する旧方式を廃し、長尺（12h 級）でも通るようにする。
// npm 依存ゼロ: Node 標準モジュールのみ。

import fs from "node:fs";
import path from "node:path";
import {
  chunkSegments,
  buildPrompt,
  parseResponse,
} from "../src/select-segments.mjs";
import { createIsolatedCwd } from "../src/claude-safety.mjs";
import { runClaudeJson } from "../src/claude-run.mjs";

const CLAUDE_TIMEOUT_MS = 300_000; // 1 chunk あたり 5 分（10 分尺 chunk・--bare 起動で十分余裕）
const POOL = Number(process.env.CLAUDE_SELECT_POOL ?? 3); // 同時実行 chunk 数

/**
 * 1 chunk 分のプロンプトを claude -p に渡し、segments 配列を返す。
 * @param {string} promptDoc - buildPrompt の出力
 * @param {(msg:string)=>void} onLog
 * @param {string} cwd - ジョブ専用の隔離ディレクトリ（createIsolatedCwd の出力）
 * @returns {Promise<object[]>} keepText を持つ segments
 */
async function runOneChunk(promptDoc, onLog, cwd) {
  const stdinPayload =
    promptDoc +
    "\n\n---\n" +
    '必ず {"segments":[{"keepText":"...","hook":"...","reason":"..."}]} の JSON のみを返せ。' +
    "コードフェンスで囲んでも構わない。説明文・前置き・後置きは一切不要。";

  // 起動そのもの（ツール無効化/env allowlist/隔離cwd/タイムアウト/終了コード検査）は
  // src/claude-run.mjs の共通口が持つ。ここは「何を渡し、返答をどう読むか」だけを持つ。
  const resultText = await runClaudeJson({
    stdin: stdinPayload,
    cwd,
    timeoutMs: CLAUDE_TIMEOUT_MS,
    onLog,
  });
  try {
    return parseResponse(resultText); // 0 件もここでは許容（chunk 単位なので空 chunk はありうる）
  } catch (e) {
    throw new Error(`parseResponse 失敗: ${e.message}`);
  }
}

/**
 * プール並列で配列を処理する（同時実行数を poolSize に制限）。
 * 1 件が throw しても他は継続し、{ok,value|error} で結果を返す。
 */
async function runPool(items, poolSize, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function lane() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }
  const lanes = Array.from({ length: Math.min(poolSize, items.length) }, lane);
  await Promise.all(lanes);
  return results;
}

/**
 * transcript.json を chunk 分割し、各 chunk を個別の claude -p で選定して統合。
 * work/<id>/llm-response.json に {"segments":[...]} を書く。
 * P1-5: 一部chunkが失敗しても(1件以上成功していれば)例外にせず続行するが、その場合は
 * incomplete:true を返す。呼び出し側はこれを「一部失敗」として扱い、全チャンク成功と
 * 区別すること(サイレントに成功扱いしない)。
 *
 * @param {string} workDir - work/<id> の絶対パス
 * @param {(msg:string)=>void} [onLog]
 * @returns {Promise<{segments: object[], incomplete: boolean, failedChunks: number, totalChunks: number}>}
 */
export async function runClaudeSelect(workDir, onLog = () => {}) {
  const transcriptPath = path.join(workDir, "transcript.json");
  const respPath = path.join(workDir, "llm-response.json");

  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`transcript.json が見つかりません: ${transcriptPath}`);
  }
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));

  // 10 分 chunk（1 呼び出しを軽くして claude -p の 300 秒タイムアウト率を下げる）。
  const chunks = chunkSegments(transcript, 10 * 60, 60);
  if (chunks.length === 0) {
    throw new Error("transcript に segments がありません");
  }

  onLog(`[claude-select] ${chunks.length} chunk に分割（プール ${POOL} 並列）`);

  const cwd = createIsolatedCwd(path.basename(workDir));
  let done = 0;
  const results = await runPool(chunks, POOL, async (chunk) => {
    const segs = await runOneChunk(buildPrompt(chunk, 0), onLog, cwd);
    done++;
    onLog(`[claude-select] ${done}/${chunks.length} chunk 完了（+${segs.length} 件）`);
    return segs;
  });

  // 統合: 成功 chunk の segments を全結合。失敗 chunk はログに残して継続。
  const { merged, failures } = summarizeChunkResults(results);

  if (failures.length) {
    onLog(`[claude-select] ${failures.length} chunk 失敗: ${failures.join(" / ").slice(0, 300)}`);
  }
  // 全 chunk 失敗 or 1 件も取れなかった場合のみエラー（一部成功なら続行）。
  if (merged.length === 0) {
    throw new Error(
      failures.length
        ? `全 chunk の選定に失敗しました（${failures[0]}）`
        : "claude が返した segments が 0 件です"
    );
  }

  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(respPath, JSON.stringify({ segments: merged }, null, 2), "utf-8");
  onLog(`[claude-select] 統合 ${merged.length} 件 → ${respPath}`);

  return {
    segments: merged,
    incomplete: failures.length > 0,
    failedChunks: failures.length,
    totalChunks: chunks.length,
  };
}

/**
 * P1-5: runPool() の結果(chunkごとの成否)を、成功分のsegments統合と失敗一覧へ要約する純粋関数。
 * 「一部chunk失敗を黙って成功扱いにしない」ための判定(incomplete)をここに切り出し単体テスト可能にする。
 * @param {Array<{ok: true, value: object[]} | {ok: false, error: Error}>} results
 * @returns {{ merged: object[], failures: string[] }}
 */
export function summarizeChunkResults(results) {
  const merged = [];
  const failures = [];
  results.forEach((r, i) => {
    if (r.ok) merged.push(...r.value);
    else failures.push(`chunk ${i}: ${r.error.message}`);
  });
  return { merged, failures };
}
