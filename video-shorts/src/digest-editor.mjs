// video-shorts ダイジェスト編集エージェント。
// 全文字起こしを理解し「面白い所だけ」を抽出、順序を自由に再構成した台本を作り、
// 批評→修正の検証修正ループ（テキスト上のみ・レンダしない）を回して完成台本を返す。
//
// 制約（マスター確定）:
//  - keepText は本文の逐語連続抜き出し（語を変えない・合成音声なし・声は素材のまま）。
//  - 順序は時系列でなくてよい（並べ替え・取捨選択のみ）。
//  - ループは台本テキストで回し、レンダは最終1回だけ（本ファイルはレンダしない）。
//
// LLM は claude -p（サブスクログイン継承＝コスト0）。起動そのものは src/claude-run.mjs の
// 共通口 runClaudeJson に任せる（ツール無効化 / env allowlist / 隔離 cwd / 打ち切り /
// --strict-mcp-config が一箇所に集まっており、ここへ書き写さない）。
// センスが要る工程なので上位モデル(Opus)を --model で pin（モデル階層原則）＝共通口の
// extraArgs で足す。npm 依存ゼロ・Node 標準のみ。

import fs from "node:fs";
import path from "node:path";
import { resolveSegments } from "./reverse-match.mjs";
import { createIsolatedCwd, wrapUntrustedText } from "./claude-safety.mjs";
import { runClaudeJson } from "./claude-run.mjs";

const TIMEOUT_MS = Number(process.env.DIGEST_TIMEOUT_MS ?? 300_000);
const MODEL = process.env.DIGEST_MODEL ?? "claude-opus-4-8";
const MAX_ITER = Number(process.env.DIGEST_MAX_ITER ?? 3);
const PASS_SCORE = Number(process.env.DIGEST_PASS_SCORE ?? 80);

/** --model 指定が原因の失敗だけを見分ける絞り込み（ここを緩めると真因が隠れる）。
 *  旧 /model|unknown|invalid/i は "invalid JSON" 等の一般 stderr にも誤マッチし、
 *  モデル無関係の失敗まで再試行して真因を隠していた。model と無効語の連語のみに絞る。 */
const MODEL_ERROR_RE =
  /(unknown|invalid|unrecognized|no such|not a valid)\s+model|model[\s\S]{0,20}?(not found|not recognized|not supported|is invalid)/i;

/** claude -p を1回叩き stdout(JSON envelope)の result テキストを返す。--model 無効環境はCLI既定へ退避。
 *  cwd はジョブ専用の隔離ディレクトリ（createIsolatedCwd の出力）を呼び出し元から渡す。
 *
 *  起動の作法（ツール無効化 / env allowlist / 隔離 cwd での実行 / 打ち切り / 終了コード検査）は
 *  共通口 runClaudeJson が持つ。ここが持つのは「上位モデルを pin する」ことと、
 *  「その pin が原因で落ちたときだけ1度 CLI 既定モデルへ退避する」ことだけ。
 *  退避の判定は共通口が Error に付ける stderr 全文（切り詰めない）に対して行う。 */
function callClaude(prompt, onLog, useModel = true, cwd) {
  return runClaudeJson({
    stdin: prompt,
    cwd,
    timeoutMs: TIMEOUT_MS,
    extraArgs: useModel ? ["--model", MODEL] : [],
  }).catch((e) => {
    // 終了コードが 0 でない失敗にだけ stderr が付く（打ち切り・spawn 失敗・JSON 崩れには付かない）。
    // ＝再試行するのは「--model 指定が原因で終了コードが非0になった」場合だけ、という従来の絞り込みのまま。
    if (useModel && MODEL_ERROR_RE.test(e?.stderr ?? "")) {
      onLog(`[digest] --model ${MODEL} 失敗→CLI既定モデルで再試行`);
      return callClaude(prompt, onLog, false, cwd);
    }
    throw e;
  });
}

/** 文字列リテラルを考慮して最初の { または [ から釣り合う閉じ括弧までを抽出。
 *  プロローグ（JSON 前の文）とエピローグ（JSON 後の文）の両方を除去する。 */
function extractBalanced(text) {
  const start = text.search(/[{[]/);
  if (start === -1) return text.trim();
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start); // 括弧が不均衡なら残りを返し JSON.parse にエラーを委ねる
}

/** ```json フェンス除去→釣り合う括弧で JSON 本体だけを抽出して JSON.parse。
 *  モデルが JSON の前後に説明文を添えても（プロローグ/エピローグ）壊れない。 */
function parseJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(extractBalanced((fence ? fence[1] : text).trim()));
}

const VERBATIM = `【厳守】keepText は文字起こし本文に実在する連続した部分文字列を一字一句そのまま抜き出す。` +
  `語順を変える・言い換える・要約する・創作するのは禁止（後段が本文へ逆照合して秒数を確定するため）。` +
  `順序（segmentsの並び）だけは自由に入れ替えてよい。`;

export function draftPrompt(transcriptText, targetInfo) {
  return `あなたは一流の動画編集者です。次の長編の文字起こし全体を理解し、視聴者が最後まで飽きない` +
    `「ダイジェスト（面白い所だけ）」の台本を作ってください。冒頭の挨拶・締めの定型・冗長な繰り返し・` +
    `本編でない雑談は捨てる。掴み→展開→山場→締めの流れになるよう、必要なら時系列を入れ替える。\n\n` +
    (targetInfo ? `${targetInfo}\n\n` : "") +
    `${VERBATIM}\n\n# 文字起こし本文\n${wrapUntrustedText("transcript", transcriptText)}\n\n` +
    `# 出力（JSONのみ・前後に説明文を書かない）\n` +
    `{"script":[{"keepText":"本文の逐語連続抜き出し","hook":"20字以内の見出し","reason":"採用理由一言"}]}`;
}

function scriptToText(script) {
  return script.map((s, i) => `#${i + 1} [${s.hook || ""}] ${s.keepText}`).join("\n\n");
}

function criticPrompt(script) {
  return `あなたは辛口の編集レビュアーです。次のダイジェスト台本（この順序で連結して1本の動画にする）を` +
    `観点別に配点で評価してください。各観点20点満点・合計100点で採点します。\n` +
    `観点の定義: 掴み(最初3秒で視聴者を引き込むか)/流れ(展開が自然で飽きないか)/` +
    `密度(冗長・繰り返し・雑談が無く濃いか)/山場(明確な盛り上がりがあるか)/締め(余韻ある終わり方か)。\n` +
    `各観点は「なぜその点か」を減点根拠つきで判断し、満点でない観点は必ず fixes に改善指示を書くこと。\n\n` +
    `# 台本（連結順）\n${scriptToText(script)}\n\n` +
    `# 出力（JSONのみ）\n` +
    `{"scores":{"掴み":0-20,"流れ":0-20,"密度":0-20,"山場":0-20,"締め":0-20},` +
    `"score":合計(0-100の整数),"pass":true/false,"weakest":"最も低い観点名",` +
    `"issues":["問題点"],"fixes":["観点名: その観点を何点上げるための具体的改善指示"]}\n` +
    `fixes は必ず先頭に観点名を付ける。score は scores の合計と一致させる。` +
    `pass は ${PASS_SCORE}点以上かつ致命的問題が無い場合のみ true。`;
}

export function revisePrompt(transcriptText, script, critique) {
  const cur = Number(critique.score) || 0;
  const perScores = critique.scores ? JSON.stringify(critique.scores, null, 0) : "(観点別スコアなし)";
  const weakest = critique.weakest || "";
  return `次のダイジェスト台本を、レビュー指摘に従って改善してください（順序入替・差し替え・削除・追加可）。\n` +
    `現在の総合点は ${cur}点、目標は ${PASS_SCORE}点以上です。観点別スコア: ${perScores}。\n` +
    (weakest ? `特に最も低い観点「${weakest}」を最優先で引き上げてください。\n` : "") +
    `点数を上げるのが目的です。満点でない観点を狙って直し、既に高い観点は壊さないこと。\n\n` +
    `${VERBATIM}\n\n# レビュー指摘（観点別の改善指示）\n${JSON.stringify(critique.fixes || critique.issues || [], null, 0)}\n\n` +
    `# 現在の台本\n${scriptToText(script)}\n\n# 参照可能な全文字起こし\n${wrapUntrustedText("transcript", transcriptText)}\n\n` +
    `# 出力（JSONのみ）\n{"script":[{"keepText":"...","hook":"...","reason":"..."}]}`;
}

/** 尺是正プロンプト（実測秒数が目標から外れた時の1回だけの縮小/拡張指示）。 */
export function durationFixPrompt(transcriptText, segments, { targetSeconds, targetMinutes, actualSeconds }) {
  const dir = actualSeconds > targetSeconds ? "短く削れ" : "本編から追加して伸ばせ";
  return `次のダイジェスト台本は実測${Math.round(actualSeconds)}秒、目標は${targetSeconds}秒` +
    `（約${targetMinutes}分）です。目標の±20%に収まるよう台本を${dir}（順序入替・差し替え・削除・追加可）。\n\n` +
    `${VERBATIM}\n\n# 現在の台本\n${scriptToText(segments.map((s) => ({ ...s, reason: "" })))}\n\n` +
    `# 参照可能な全文字起こし\n${wrapUntrustedText("transcript", transcriptText)}\n\n` +
    `# 出力（JSONのみ）\n{"script":[{"keepText":"...","hook":"...","reason":"..."}]}`;
}

/**
 * ダイジェスト台本を生成して work/<id>/llm-response.json に順序付きで書く。
 * @returns {Promise<{segments:object[], meta:object}>}
 */
export async function runDigestEditor(workDir, onLog = () => {}, opts = {}) {
  const { targetMinutes } = opts;
  const tPath = path.join(workDir, "transcript.json");
  if (!fs.existsSync(tPath)) throw new Error(`transcript.json がありません: ${tPath}`);
  const tr = JSON.parse(fs.readFileSync(tPath, "utf-8"));
  const transcriptText = (tr.segments || []).map((s) => s.text).join(" ").trim();
  if (!transcriptText) throw new Error("文字起こし本文が空です");

  // 尺目標（任意）: 実測の話速（文字数/秒）から文字数の目安に換算してドラフト指示に含める。
  // LLM に秒数を直接出させず、掴みやすい「文字数」の目安に変換して伝える（落とし穴#1の考え方を踏襲）。
  const targetSeconds = Number.isFinite(targetMinutes) && targetMinutes > 0 ? targetMinutes * 60 : null;
  let targetInfo = null;
  if (targetSeconds) {
    const charsPerSec = transcriptText.length / Math.max(1, tr.duration || transcriptText.length / 5);
    const charBudget = Math.round(targetSeconds * charsPerSec);
    targetInfo = `【尺の目安】合計の keepText 文字数が約${charBudget}文字（この話者の話速換算で約${targetMinutes}分相当）に収まるよう選定せよ。` +
      `本当に面白い部分だけに絞り込み、目安を大きく超えないこと。`;
  }

  const cwd = createIsolatedCwd(path.basename(workDir));

  onLog(`[digest] 台本ドラフト作成中（model=${MODEL}）`);
  // draft は必須。長い逐語 keepText で LLM の JSON が崩れることがあるため明示メッセージで失敗させる。
  let draftResp;
  try { draftResp = parseJson(await callClaude(draftPrompt(transcriptText, targetInfo), onLog, true, cwd)); }
  catch (e) { throw new Error(`ドラフト応答の JSON 解析に失敗: ${e.message}`); }
  let script = (draftResp.script) || [];
  if (script.length === 0) throw new Error("ドラフト台本が空です");

  let best = { script, score: -1, iter: 0 };
  let iterations = 1;
  for (let i = 1; i <= MAX_ITER; i++) {
    // critic/revise の応答 JSON は逐語テキスト混入で崩れうる。崩れても best を返して完走させる
    // （旧実装は parseJson が throw して digest 全体が例外死し、せっかくの best を捨てていた）。
    let critique;
    try { critique = parseJson(await callClaude(criticPrompt(script), onLog, true, cwd)); }
    catch (e) { onLog(`[digest] 検証 ${i}回目の応答処理に失敗（JSON崩れ/timeout/spawn等）→best(score=${best.score})で確定: ${e.message}`); break; }
    const score = Number(critique.score) || 0;
    onLog(`[digest] 検証 ${i}回目: score=${score} pass=${!!critique.pass} (${(critique.issues || []).length}件指摘)`);
    if (score > best.score) best = { script, score, iter: i };
    if (critique.pass || score >= PASS_SCORE) { iterations = i; break; }
    if (i === MAX_ITER) { iterations = i; break; }
    onLog(`[digest] 修正 ${i}回目`);
    let revised;
    try { revised = parseJson(await callClaude(revisePrompt(transcriptText, script, critique), onLog, true, cwd)).script; }
    catch (e) { onLog(`[digest] 修正 ${i}回目の応答処理に失敗（JSON崩れ/timeout/spawn等）→best(score=${best.score})で確定: ${e.message}`); break; }
    if (Array.isArray(revised) && revised.length) { script = revised; iterations = i + 1; }
    else break;
  }

  const chosen = best.score >= 0 ? best.script : script;
  let segments = chosen
    .filter((s) => s && typeof s.keepText === "string" && s.keepText.trim().length >= 4)
    .map((s) => ({ keepText: s.keepText.trim(), hook: (s.hook || "").trim() }));
  if (segments.length === 0) throw new Error("採用可能な台本区間が0件です");

  // 尺目標がある場合、実測秒数（reverse-match）が目標から大きく外れていたら1回だけ縮小/拡張指示を出す。
  // 文字数目安だけでは実発話速度のブレを吸収できないため、実測フィードバックで是正する。
  let actualSeconds = null;
  if (targetSeconds) {
    const measure = (segs) => {
      const resolved = resolveSegments(segs, tr, { preserveOrder: true });
      return resolved.reduce((a, s) => a + (s.end - s.start), 0);
    };
    actualSeconds = measure(segments);
    onLog(`[digest] 尺チェック: 実測${actualSeconds.toFixed(0)}s / 目標${targetSeconds}s`);
    if (actualSeconds < targetSeconds * 0.8 || actualSeconds > targetSeconds * 1.2) {
      const fixPrompt = durationFixPrompt(transcriptText, segments, { targetSeconds, targetMinutes, actualSeconds });
      try {
        const fixResp = parseJson(await callClaude(fixPrompt, onLog, true, cwd));
        const fixed = (fixResp.script || [])
          .filter((s) => s && typeof s.keepText === "string" && s.keepText.trim().length >= 4)
          .map((s) => ({ keepText: s.keepText.trim(), hook: (s.hook || "").trim() }));
        if (fixed.length > 0) {
          const fixedSeconds = measure(fixed);
          onLog(`[digest] 尺是正後: 実測${fixedSeconds.toFixed(0)}s`);
          segments = fixed;
          actualSeconds = fixedSeconds;
        }
      } catch (e) {
        onLog(`[digest] 尺是正の応答処理に失敗（元の台本のまま確定）: ${e.message}`);
      }
    }
  }

  const meta = { iterations, score: best.score, count: segments.length,
    targetSeconds, actualSeconds };
  fs.writeFileSync(path.join(workDir, "llm-response.json"),
    JSON.stringify({ segments, meta }, null, 2), "utf-8");
  onLog(`[digest] 完成台本: ${segments.length}区間 / score=${best.score} / ${iterations}反復`);
  return { segments, meta };
}
