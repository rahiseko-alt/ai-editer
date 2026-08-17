// server/claude-select.mjs — claude -p による区間選定（topic 経路の本体）
//
// 【2026-08-17 に作り直した理由】旧実装は transcript.json を10分ごとに割り、各 chunk を
// 完全に独立した claude -p 呼び出しへ投げ、返ってきた segments を**配列連結するだけ**だった。
// つまりこの経路の AI は素材の全体を一度も読んでおらず、マスター指示（AGENTS.md「マスター指示：
// 編集フロー」）にある「台本の内容を理解する」段階が存在しなかった。全体理解ゼロ・全体最適ゼロ。
// 画面の既定はこの topic 経路（webapp-mockup/app.js の初期状態が cut:"topic"）なので、
// 既定の経路が一番考えていない、という状態だった。
//
// いまの流れ:
//   ① 理解: 素材の全文を1回で読ませて「主題・小テーマ・山場・捨てる所・話者の癖」を作る。
//           全文が長すぎて1回で読み切れないときだけ、ブロック要約→全体統合の2段読みへ切り替える
//           （閾値と理由は src/select-segments.mjs の DIRECT_READ_CHARS のコメントが正）。
//   ② 選定: ①の理解と「全体の中でのこの範囲の位置」を各 chunk のプロンプトへ渡して区切らせる。
//           chunk 分割そのものは残す（12h 級の素材を1回で切らせると打ち切りに掛かるため）が、
//           各 chunk は「全体を知ったうえでその範囲を担当する」立場になる。
//   ③ 統合: 全 chunk の候補を1つの一覧にして AI へ戻し、重なり由来の重複や本編でない所を
//           全体視点で整えさせる。本文（keepText）は AI に触らせず番号で選ばせるだけなので、
//           「逐語の連続抜き出し」という後段（逆照合）の前提は崩れない。
//
// npm 依存ゼロ: Node 標準モジュールのみ。

import fs from "node:fs";
import path from "node:path";
import {
  chunkSegments,
  buildPrompt,
  parseResponse,
  parseJsonLoose,
  buildUnderstandPrompt,
  buildBlockOutlinePrompt,
  buildGlobalUnderstandPrompt,
  splitForReading,
  summarizeCandidates,
  buildIntegrationPrompt,
  applyIntegration,
  dedupeSegments,
  DIRECT_READ_CHARS,
} from "../src/select-segments.mjs";
import { DEFAULT_MODE, getMode, isPromptDrivenMode } from "../src/select-modes.mjs";
import { createIsolatedCwd } from "../src/claude-safety.mjs";
import { runClaudeJson } from "../src/claude-run.mjs";

const CLAUDE_TIMEOUT_MS = 300_000; // 1 chunk あたり 5 分（10 分尺 chunk で十分余裕）
/** 全文を読む工程・候補を全部読む工程は入力が桁違いに大きいので、chunk より長く待つ。 */
const READ_TIMEOUT_MS = Number(process.env.CLAUDE_READ_TIMEOUT_MS ?? 600_000);
const POOL = Number(process.env.CLAUDE_SELECT_POOL ?? 3); // 同時実行 chunk 数

/** JSON だけを返させる共通の後書き（どの工程でも同じ言い方に揃える）。 */
function jsonOnly(promptDoc, shapeHint) {
  return (
    promptDoc +
    "\n\n---\n" +
    `必ず ${shapeHint} の JSON のみを返せ。` +
    "コードフェンスで囲んでも構わない。説明文・前置き・後置きは一切不要。"
  );
}

/**
 * claude -p を1回叩いて JSON を受け取る（理解・統合など segments 以外の工程用）。
 * 起動そのもの（ツール無効化 / allowlist / 隔離 cwd / 打ち切り / 終了コード検査）は
 * src/claude-run.mjs の共通口が持つ。ここは「何を渡し、返答をどう読むか」だけを持つ。
 */
async function runJsonPrompt(promptDoc, { cwd, onLog, timeoutMs, shapeHint }) {
  const resultText = await runClaudeJson({
    stdin: jsonOnly(promptDoc, shapeHint),
    cwd,
    timeoutMs,
    onLog,
  });
  return parseJsonLoose(resultText);
}

/**
 * 1 chunk 分のプロンプトを claude -p に渡し、segments 配列を返す。
 * @param {string} promptDoc - buildPrompt の出力
 * @param {(msg:string)=>void} onLog
 * @param {string} cwd - ジョブ専用の隔離ディレクトリ（createIsolatedCwd の出力）
 * @returns {Promise<object[]>} keepText を持つ segments
 */
async function runOneChunk(promptDoc, onLog, cwd) {
  const stdinPayload = jsonOnly(
    promptDoc,
    '{"segments":[{"keepText":"...","hook":"...","reason":"..."}]}'
  );

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

/** work/<id>/state.json を読む（無い・壊れているときは空オブジェクト）。 */
function readState(workDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(workDir, "state.json"), "utf-8"));
  } catch {
    return {};
  }
}

/**
 * 1本あたりの目標尺を決める。
 *
 * 優先順は 呼び出し引数 > state.json。state.json 側は、画面の「1本の目安の長さ」
 * （job-params.mjs の durationMin。話題で切るときだけ意味を持つ設定）と、
 * digest 用の targetMinutes の両方を見る。
 *
 * ※ 2026-08-17 現在、server/pipeline-runner.mjs は durationMin を state.json へ書いていない
 *   （updateState に渡していない）ため、画面から topic で流すとここは null になる。
 *   このファイルからは直せないので（今回の編集許可の外）、runClaudeSelect(workDir, onLog,
 *   { targetMinutes }) で渡すか、pipeline-runner の updateState へ durationMin を1行足せば
 *   そのまま効く形にしてある。渡らなかったときは「尺の条件なし」として素直に振る舞う
 *   （黙って既定値をでっち上げると、指定していない尺で切られたことに誰も気付けない）。
 *
 * @returns {{targetSeconds:number,targetMinutes:number,charBudget:number}|null}
 */
export function resolveDurationTarget({ opts = {}, state = {}, transcript = {}, transcriptText = "" }) {
  const raw = [opts.targetMinutes, state.targetMinutes, state.durationMin].find(
    (v) => Number.isFinite(Number(v)) && Number(v) > 0
  );
  if (raw === undefined) return null;
  const targetMinutes = Number(raw);
  const targetSeconds = targetMinutes * 60;
  // 秒数は AI に出させない（落とし穴#1）ので、この話者の実測話速で「文字数の目安」へ換算して渡す。
  const totalSec = Number.isFinite(transcript.duration) && transcript.duration > 0
    ? transcript.duration
    : Math.max(1, transcriptText.length / 5);
  const charsPerSec = transcriptText.length / totalSec;
  return {
    targetSeconds,
    targetMinutes,
    charBudget: Math.round(targetSeconds * charsPerSec),
  };
}

/**
 * ① 素材の全体を読んで「理解」を作る。
 *
 * 短い素材は全文を1回で読ませる（直読み）。長すぎて1回で読み切れない素材は、
 * ブロックへ割って各ブロックの骨格を書き出させ、その骨格を全部集めて全体理解へ統合する
 * （2段読み）。どちらの経路でも、素材のどの範囲も必ず1回は読解を通る＝全体を読んでいる。
 * 閾値 DIRECT_READ_CHARS とその根拠は src/select-segments.mjs のコメントが正。
 *
 * @returns {Promise<{understanding:object|null, readMode:string, blocks:number, blocksFailed:number}>}
 */
export async function buildUnderstanding(transcriptText, { cwd, onLog = () => {} } = {}) {
  const shape = '{"subject":"...","themes":[...],"peak":{...},"discard":[...],"speakerStyle":"..."}';

  if (transcriptText.length <= DIRECT_READ_CHARS) {
    onLog(`[claude-select] 全文（${transcriptText.length}文字）を1回で読んで理解を作ります`);
    const understanding = await runJsonPrompt(buildUnderstandPrompt(transcriptText), {
      cwd,
      onLog,
      timeoutMs: READ_TIMEOUT_MS,
      shapeHint: shape,
    });
    return { understanding, readMode: "direct", blocks: 1, blocksFailed: 0 };
  }

  // 2段読み。1回で読み切れない長さなので、まず全ブロックの骨格を書き出す。
  const blocks = splitForReading(transcriptText);
  onLog(
    `[claude-select] 全文が${transcriptText.length}文字（1回で読める上限 ${DIRECT_READ_CHARS} を超過）→ ` +
      `${blocks.length}ブロックに分けて全部読み、そのあと全体像へ統合します`
  );
  const results = await runPool(blocks, POOL, async (block) =>
    runJsonPrompt(buildBlockOutlinePrompt(block, blocks.length), {
      cwd,
      onLog,
      timeoutMs: READ_TIMEOUT_MS,
      shapeHint: '{"themes":[...],"peak":{...},"discard":[...],"speakerStyle":"..."}',
    })
  );
  const outlines = [];
  let blocksFailed = 0;
  results.forEach((r, i) => {
    if (r.ok) outlines.push(r.value);
    else {
      blocksFailed++;
      onLog(`[claude-select] 読解ブロック ${i + 1}/${blocks.length} 失敗: ${r.error.message}`);
    }
  });
  if (outlines.length === 0) throw new Error("全ブロックの読解に失敗しました");
  if (blocksFailed > 0) {
    // 読めなかった範囲があるまま「全体を理解した」と名乗らせない（成功したふりをしない）。
    onLog(
      `[claude-select] ${blocksFailed}/${blocks.length} ブロックが読めませんでした。` +
        `残り ${outlines.length} ブロックぶんで全体像を作ります（その範囲は理解に含まれません）`
    );
  }
  const understanding = await runJsonPrompt(buildGlobalUnderstandPrompt(outlines), {
    cwd,
    onLog,
    timeoutMs: READ_TIMEOUT_MS,
    shapeHint: shape,
  });
  return { understanding, readMode: "blocks", blocks: blocks.length, blocksFailed };
}

/**
 * ③ 候補を全体視点で整える。失敗したら null を返し、呼び出し側は整理前の候補で続行する
 * （統合はあくまで仕上げで、これが無くても選定結果自体は使えるため）。
 */
async function integrateCandidates(candidates, { cwd, onLog, understanding, duration }) {
  // 候補が多いほど1件あたりに見せられる文字数は減らす（一覧そのものが窓に収まらなくなるため）。
  const edgeChars = candidates.length > 120 ? 40 : 80;
  const summary = summarizeCandidates(candidates, edgeChars);
  const decision = await runJsonPrompt(
    buildIntegrationPrompt(summary, { understanding, duration }),
    {
      cwd,
      onLog,
      timeoutMs: READ_TIMEOUT_MS,
      shapeHint: '{"segments":[{"index":0,"hook":"...","reason":"..."}],"dropped":[]}',
    }
  );
  return applyIntegration(candidates, decision);
}

/**
 * transcript.json を読み、①全体理解 → ②chunk 選定 → ③全体統合 の順に走らせて
 * work/<id>/llm-response.json に {"segments":[...], "meta":{...}} を書く。
 *
 * P1-5: 一部chunkが失敗しても(1件以上成功していれば)例外にせず続行するが、その場合は
 * incomplete:true を返す。呼び出し側はこれを「一部失敗」として扱い、全チャンク成功と
 * 区別すること(サイレントに成功扱いしない)。同じ考え方で、全体理解に失敗した場合は
 * understandingFailed:true を返す（理解なしで切ったことを黙らない）。
 *
 * @param {string} workDir - work/<id> の絶対パス
 * @param {(msg:string)=>void} [onLog]
 * @param {{targetMinutes?:number, mode?:string}} [opts] - 1本あたりの目標尺（分）と選定モード。
 *   どちらも任意。省略時は state.json から読む（既存の呼び出し方は変わらない）。
 * @returns {Promise<{segments: object[], incomplete: boolean, failedChunks: number,
 *   totalChunks: number, understandingFailed: boolean, meta: object}>}
 */
export async function runClaudeSelect(workDir, onLog = () => {}, opts = {}) {
  const transcriptPath = path.join(workDir, "transcript.json");
  const respPath = path.join(workDir, "llm-response.json");

  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`transcript.json が見つかりません: ${transcriptPath}`);
  }
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));
  const state = readState(workDir);

  // モードは state.json（画面／CLI の init が書く）を正にする。旧実装は buildPrompt へ
  // mode を渡しておらず、常に既定モードの文言で走っていた＝設定が届いていなかった。
  const requested = opts.mode ?? state.mode ?? DEFAULT_MODE;
  const mode = isPromptDrivenMode(requested) ? requested : DEFAULT_MODE;
  if (requested !== mode) {
    // digest はこの経路では扱わない（担当は src/digest-editor.mjs）。呼ばれたこと自体が
    // 結線ミスなので、黙って topic で切らずにログへ残す。
    onLog(`[claude-select] モード「${requested}」はこの経路では扱えません → ${mode} で続行します`);
  }

  const transcriptText = (transcript.segments || []).map((s) => s.text).join(" ").trim();
  if (!transcriptText) throw new Error("transcript に segments がありません");

  const duration = resolveDurationTarget({ opts, state, transcript, transcriptText });
  if (duration) {
    onLog(
      `[claude-select] 1本あたりの目安 ${duration.targetMinutes}分` +
        `（約${duration.charBudget}文字）で切ります`
    );
  } else {
    onLog("[claude-select] 1本あたりの尺の指定は無し（AI が話題の切れ目で判断します）");
  }

  const cwd = createIsolatedCwd(path.basename(workDir));

  // ── ① 理解: 素材の全体を読む ──────────────────────────────
  let understanding = null;
  let readMeta = { readMode: "none", blocks: 0, blocksFailed: 0 };
  let understandingFailed = false;
  try {
    const r = await buildUnderstanding(transcriptText, { cwd, onLog });
    understanding = r.understanding;
    readMeta = { readMode: r.readMode, blocks: r.blocks, blocksFailed: r.blocksFailed };
    const themeCount = Array.isArray(understanding?.themes) ? understanding.themes.length : 0;
    onLog(
      `[claude-select] 理解: 主題「${String(understanding?.subject ?? "").slice(0, 40)}」` +
        ` / 小テーマ${themeCount}件`
    );
  } catch (e) {
    // 理解は選定の下地であって、必須の入力ではない（digest 側と同じ扱い）。ただし
    // 「全体を読まずに切った」ことは戻り値と meta に残し、成功したふりをしない。
    understandingFailed = true;
    onLog(`[claude-select] [WARN] 全体の理解に失敗しました。全体像なしで区間を切ります: ${e.message}`);
  }

  // ── ② 選定: 全体理解を持たせたまま範囲ごとに切る ──────────────
  // 10 分 chunk（1 呼び出しを軽くして claude -p の 300 秒タイムアウト率を下げる）。
  const chunks = chunkSegments(transcript, 10 * 60, 60);
  if (chunks.length === 0) {
    throw new Error("transcript に segments がありません");
  }

  onLog(`[claude-select] ${chunks.length} chunk に分割（プール ${POOL} 並列）`);

  const targetCount = getMode(mode).targetCount;
  let done = 0;
  const results = await runPool(chunks, POOL, async (chunk) => {
    const promptDoc = buildPrompt(chunk, targetCount, mode, {
      understanding,
      duration,
      total: chunks.length,
    });
    const segs = await runOneChunk(promptDoc, onLog, cwd);
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

  // ── ③ 統合: 全体視点で整える ──────────────────────────────
  // まず AI を使わずに、重なり由来の明らかな重複（同一・包含）を落とす。ここは決定的なので、
  // このあとの AI 統合が失敗しても、二重採用だけは必ず消えている状態になる。
  const deduped = dedupeSegments(merged);
  if (deduped.length !== merged.length) {
    onLog(`[claude-select] 重なりによる重複 ${merged.length - deduped.length} 件を統合前に除去`);
  }

  let segments = deduped;
  let integrated = false;
  if (chunks.length > 1 && deduped.length > 1) {
    try {
      const r = await integrateCandidates(deduped, { cwd, onLog, understanding, duration });
      if (r) {
        segments = r.segments;
        integrated = true;
        onLog(`[claude-select] 全体整合: ${deduped.length} 件 → ${segments.length} 件（${r.dropped} 件を整理）`);
      } else {
        onLog("[claude-select] 全体整合の返答を採用しませんでした（候補が減りすぎ／番号が読めない）");
      }
    } catch (e) {
      onLog(`[claude-select] 全体整合に失敗（整理前の候補で続行）: ${e.message}`);
    }
  }

  const meta = {
    mode,
    count: segments.length,
    understanding,
    understandingFailed,
    ...readMeta,
    targetMinutes: duration ? duration.targetMinutes : null,
    targetSeconds: duration ? duration.targetSeconds : null,
    integrated,
    totalChunks: chunks.length,
    failedChunks: failures.length,
  };

  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(respPath, JSON.stringify({ segments, meta }, null, 2), "utf-8");
  onLog(`[claude-select] 確定 ${segments.length} 件 → ${respPath}`);

  return {
    segments,
    incomplete: failures.length > 0,
    failedChunks: failures.length,
    totalChunks: chunks.length,
    understandingFailed,
    meta,
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
