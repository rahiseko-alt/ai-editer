// server/claude-select.mjs — claude -p による区間選定（チャンク分割並列版）
// transcript.json を chunkSegments で分割し、各 chunk を個別の claude -p 呼び出しで
// 選定する（プール並列）。全 chunk の segments を統合して llm-response.json に書く。
// 「1 回で全文を渡してタイムアウト」する旧方式を廃し、長尺（12h 級）でも通るようにする。
// npm 依存ゼロ: Node 標準モジュールのみ。

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  chunkSegments,
  buildPrompt,
  parseResponse,
} from "../src/select-segments.mjs";
import {
  buildSafeEnv,
  createIsolatedCwd,
  NO_TOOLS_ARGS,
} from "../src/claude-safety.mjs";

const CLAUDE_TIMEOUT_MS = 300_000; // 1 chunk あたり 5 分（10 分尺 chunk・--bare 起動で十分余裕）
const POOL = Number(process.env.CLAUDE_SELECT_POOL ?? 3); // 同時実行 chunk 数

/**
 * 1 chunk 分のプロンプトを claude -p に渡し、segments 配列を返す。
 * @param {string} promptDoc - buildPrompt の出力
 * @param {(msg:string)=>void} onLog
 * @param {string} cwd - ジョブ専用の隔離ディレクトリ（createIsolatedCwd の出力）
 * @returns {Promise<object[]>} keepText を持つ segments
 */
function runOneChunk(promptDoc, onLog, cwd) {
  const stdinPayload =
    promptDoc +
    "\n\n---\n" +
    '必ず {"segments":[{"keepText":"...","hook":"...","reason":"..."}]} の JSON のみを返せ。' +
    "コードフェンスで囲んでも構わない。説明文・前置き・後置きは一切不要。";

  return new Promise((resolve, reject) => {
    // --strict-mcp-config（--mcp-config 未指定）で MCP サーバーをゼロにする。
    //   真因: 毎チャンクの claude -p 起動で serena 等 MCP ブート（150s+）が走り、入力が小さくても
    //   300s タイムアウトを食い潰していた。MCP を切ると 300s→5.5s（実測）。モデルは変えない＝選定品質不変。
    // ※ --bare は MCP/hook を全スキップして更に軽いが OAuth ログインまで剥がし "Not logged in" になる
    //   （サブスク無料運用が壊れる）ため使用不可。MCP だけ切る本フラグが正解。
    // 非信頼な文字起こしを渡す呼び出しなので P1-1 ハードニング（ツール無効化/env allowlist/隔離cwd）を適用する。
    const child = spawn(
      "claude",
      ["-p", "--strict-mcp-config", "--output-format", "json", ...NO_TOOLS_ARGS],
      {
        windowsHide: true,
        env: buildSafeEnv(),
        cwd,
      }
    );

    let stdoutBuf = "";
    let stderrBuf = "";

    child.stdout.on("data", (c) => (stdoutBuf += c.toString()));
    child.stderr.on("data", (c) => {
      const line = c.toString();
      stderrBuf += line;
      onLog(`[claude stderr] ${line.trim()}`);
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p タイムアウト (${CLAUDE_TIMEOUT_MS / 1000}s)`));
    }, CLAUDE_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(
          new Error(`claude 終了コード ${code}。stderr: ${stderrBuf.slice(0, 400)}`)
        );
      }
      let envelope;
      try {
        envelope = JSON.parse(stdoutBuf.trim());
      } catch (e) {
        return reject(
          new Error(`claude stdout JSON parse 失敗: ${e.message}\nraw: ${stdoutBuf.slice(0, 400)}`)
        );
      }
      const resultText = envelope.result ?? envelope.content ?? stdoutBuf;
      let segs;
      try {
        segs = parseResponse(resultText);
      } catch (e) {
        return reject(new Error(`parseResponse 失敗: ${e.message}`));
      }
      resolve(segs); // 0 件もここでは許容（chunk 単位なので空 chunk はありうる）
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`claude spawn エラー: ${err.message}`));
    });

    child.stdin.write(stdinPayload, "utf-8");
    child.stdin.end();
  });
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
 *
 * @param {string} workDir - work/<id> の絶対パス
 * @param {(msg:string)=>void} [onLog]
 * @returns {Promise<{segments: object[]}>}
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
  const merged = [];
  const failures = [];
  results.forEach((r, i) => {
    if (r.ok) merged.push(...r.value);
    else failures.push(`chunk ${i}: ${r.error.message}`);
  });

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

  return { segments: merged };
}
