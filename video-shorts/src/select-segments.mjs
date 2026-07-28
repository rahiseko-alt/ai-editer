// video-shorts [4] LLM区間選定 — virality 4軸(Hook/Flow/Value/Trend)で「残すテキスト＋hook文」
// を返させる。秒数は出させない（落とし穴#1）。長尺は chunk 分割（落とし穴#5）。
//
// キーレス既定: プロンプトを llm-request.md に書き出し、オーケストレーター(Claude Code)が
// llm-response.json を書く。API版は callAnthropic() を使う（ANTHROPIC_API_KEY 必要）。

import { DEFAULT_MODE, getMode } from "./select-modes.mjs";
import { wrapUntrustedText } from "./claude-safety.mjs";

const SYSTEM_RULES_BASE = `あなたは長編動画を区間に切り分ける編集者です。
出力は必ず JSON のみ。秒数・タイムスタンプは絶対に出力しないこと（後段が文字起こしに
照合して秒数を確定するため）。

各区間について:
- keepText: その区間に該当する文字起こし本文を一字一句そのまま連続で抜き出す
  （要約・改変・創作は禁止）。
- hook: その区間を一言で表す派手な見出し（20字以内）。`;

const OUTPUT_SCHEMA = `{
  "segments": [
    {
      "keepText": "そのトピックの文字起こし本文を最初から最後まで一字一句そのまま連続抜き出し",
      "hook": "トピックを表す派手な見出し(20字以内)",
      "reason": "このトピックが何の話題か一言"
    }
  ]
}`;

/** transcript.segments を chunk に分割（長尺対策・落とし穴#5）。20分相当でオーバーラップ。 */
export function chunkSegments(transcript, chunkSec = 20 * 60, overlapSec = 60) {
  const segs = transcript.segments || [];
  if (segs.length === 0) return [];
  const total = transcript.duration || (segs[segs.length - 1]?.end ?? 0);
  if (total <= chunkSec) return [{ index: 0, text: segs.map((s) => s.text).join(" ") }];
  const chunks = [];
  let start = 0;
  let idx = 0;
  while (start < total) {
    const end = start + chunkSec;
    const text = segs
      .filter((s) => s.end > start && s.start < end)
      .map((s) => s.text)
      .join(" ");
    if (text.trim()) chunks.push({ index: idx++, start, end, text });
    start += chunkSec - overlapSec;
  }
  return chunks;
}

/** 1 chunk ぶんの選定プロンプト本文を組み立てる（mode でルールを切替） */
export function buildPrompt(chunk, targetCount = 0, mode = DEFAULT_MODE) {
  const m = getMode(mode);
  const limit = targetCount > 0 ? `（多くても ${targetCount} 件程度に抑える）` : "";
  return `${SYSTEM_RULES_BASE}

${m.fragment}

# 文字起こし本文（この範囲を分割する）
${wrapUntrustedText("transcript-chunk", chunk.text)}

# 指示
上記を上記モードの方針で区間に分割し、各区間を次のJSONスキーマで出力せよ${limit}。
keepText は本文に実在する連続した抜き出しに限る（要約・改変・創作は禁止）。
秒数は出力しない（後段が文字起こしに照合して確定する）。

# 出力スキーマ
${OUTPUT_SCHEMA}`;
}

/** 複数 chunk のプロンプトを 1 つの request.md に連結（区切りで分離） */
export function buildRequestDoc(chunks, mode = DEFAULT_MODE) {
  const m = getMode(mode);
  const blocks = chunks.map(
    (c) => `\n<!-- CHUNK ${c.index} -->\n${buildPrompt(c, m.targetCount, mode)}`
  );
  return `# video-shorts LLM区間選定リクエスト（モード: ${m.label}）

chunk 数: ${chunks.length}。各 CHUNK ブロックを処理し、全候補を 1 つの
{"segments":[...]} に統合して llm-response.json に書いてください（秒数は出力しない）。
${blocks.join("\n")}
`;
}

/** llm-response.json をパースし、keepText を持つ segments のみ返す（防御的） */
export function parseResponse(raw) {
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(stripFence(raw)) : raw;
  } catch (e) {
    throw new Error(`llm-response.json のパースに失敗: ${e.message}`);
  }
  const segs = Array.isArray(data) ? data : data.segments;
  if (!Array.isArray(segs)) throw new Error("segments 配列がありません");
  return segs
    .filter((s) => s && typeof s.keepText === "string" && s.keepText.trim().length >= 4)
    .map((s) => ({ keepText: s.keepText.trim(), hook: (s.hook || "").trim() }));
}

/** ```json フェンスを剥がす */
function stripFence(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1] : text;
}

/** API版（任意）。ANTHROPIC_API_KEY があれば Claude を直接呼ぶ。 */
export async function callAnthropic(promptDoc, model = "claude-opus-4-8") {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY 未設定（キーレス既定モードを使ってください）");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: promptDoc }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API エラー: ${res.status}`);
  const json = await res.json();
  return json.content?.[0]?.text ?? "";
}
