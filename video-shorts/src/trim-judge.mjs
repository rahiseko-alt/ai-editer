// src/trim-judge.mjs — 「間を詰める」の判断を AI に任せる（G-EDIT-TRIM2-AI-*）
//
// マスターの棚卸し指示（2026-08-16）:
//   「１.2もAIに任せるが、会話の途中の沈黙であれば残さなくてはいけない。ここはAIの文脈判断力」
//
// 【なぜ規則だけでは足りないか】既存の src/trim-plan.mjs は
//   ・言い淀み … 固定16語との完全一致（一覧に「あの」「その」が単体で載っている）
//   ・無音     … 長さの閾値（0.20秒以上）
// で決めていた。このため「あの資料」の指示語まで消え、相手を待っている沈黙も長さだけで
// 消えていた。どちらも文脈を見ないと判断できない。
//
// 【この工程の作り】規則は**候補を拾うため**だけに使い、消すかどうかの決定は AI が返す。
//   ・言い淀みの候補 … 全部の語（AI が「その場面で言い淀みか」を答える）
//   ・無音の候補     … 0.3秒より長い間（それ以下は余韻の規則で詰める余地が無い）
// 返ってきた答えを検証してから trim-judge.json へ書き、render 段の planTrim が読む。
//
// 【壊れた答えを採用しない】モデルは間違える。構文は正しいが中身が異常な返答
// （そのかたまりに出していない添字・重複・全部を言い淀みと言う 等）を採用すると、
// 動画が丸ごと消える。1件ずつ検証して、条件に合わないものだけを捨てる。
// 「返答そのものが読めない」は工程の失敗として例外にする（黙って0件にしない）。

import fs from "node:fs";
import path from "node:path";

/** この工程が書き出すファイル名。render 段がここから判断結果を読む。 */
export const TRIM_JUDGE_FILE = "trim-judge.json";

/** 1回の問い合わせで見せる語の数。ai-caption-fix と同じ考え方（長すぎると精度が落ちる）。 */
export const CHUNK_WORDS = 120;

/**
 * 詰める候補になる無音の下限（秒）。
 * 余韻の規則（発言の後に0.3秒残す）により、0.3秒以下の間は詰めても1秒も減らない。
 * 減らないものを AI へ聞くのは時間の無駄なので、候補から外す。
 */
export const SILENCE_CANDIDATE_MIN_SEC = 0.3;

/**
 * 1回の返答で「言い淀み」と認めてよい割合の上限。
 * 全部を言い淀みだと答えられると、動画が丸ごと消える。人が話す中で言い淀みが
 * 半分を超えることは実際には無いので、超えた返答はそのかたまりごと捨てる
 * （捨てる＝消さない＝安全側。元の音がそのまま残るだけ）。
 */
export const MAX_FILLER_RATIO = 0.5;

/** 乱数のタグで囲む。文字起こしの中に閉じタグを書いておく細工をされても抜け出せない。 */
function wrapUntrustedText(label, text, nonce) {
  return `<${label} nonce="${nonce}">\n${text}\n</${label} nonce="${nonce}">`;
}

/**
 * 語と間の一覧から、AI へ渡す依頼文を作る。
 *
 * @param {{w:string,start:number,end:number}[]} words このかたまりの語
 * @param {number} offset このかたまりの先頭が、全体で何番目の語か
 * @param {{index:number,sec:number}[]} gaps このかたまりの中の間（index の語の**後ろ**の間）
 * @param {string} nonce 乱数タグ
 * @returns {string}
 */
export function buildTrimPrompt(words, offset, gaps, nonce) {
  const lines = words.map((w, i) => `${offset + i}\t${w.w}`).join("\n");
  const gapLines = gaps.map((g) => `${g.index}\t${g.sec.toFixed(2)}`).join("\n");

  return `あなたは日本語の話し言葉を編集する人です。次の2つを、前後の文脈から判断してください。

# 判断1: 言い淀み（消してよい語）
その語が、意味を持たない「言い淀み」かどうか。
- 消してよい例: 「えーと」「あのー」「そのー」「うーん」など、次の言葉を探している間つなぎ。
- **消してはいけない例**: 指示語。「**あの**資料を見てください」「**その**話は」の「あの」「その」は、
  何を指すかを示す大事な語なので消してはいけない。同じ表記でも役割が違う。
- 迷ったら消さない。消す必要が無ければ 1 件も返さなくてよい。

# 判断2: 間（詰めてよい無音）
語の後ろの無音を、詰めてよいかどうか。
- **詰めてはいけない例**: 会話の途中の沈黙。相手の反応を待っている間、相手が資料を開くのを
  待っている間、質問したあとの返事待ち、考えている間。ここを詰めると会話が噛み合わなくなる。
- 詰めてよい例: 会話が途切れている無音。物を探している・紙をめくっているだけで、
  やり取りが進んでいない時間。
- 迷ったら詰めない。

# 語（1 行に 1 語で「添字<タブ>語」。添字は全体での語の番号）
${wrapUntrustedText("TRANSCRIPT", lines, nonce)}

# 間（1 行に「直前の語の添字<タブ>その後ろの無音の長さ(秒)」）
${wrapUntrustedText("GAPS", gapLines, nonce)}

# 返し方
次の JSON のみを返す（説明文・前置き・後置きは不要。コードフェンスで囲んでも構わない）。
{"fillers":[5,12],"cutGaps":[7]}
- fillers は「消してよい言い淀み」の語の添字。上に並んだ添字だけを使う。
- cutGaps は「詰めてよい間」の、直前の語の添字。上の間の一覧に出ている添字だけを使う。
- どちらも同じ添字を2回以上入れない。
- 消す・詰めるものが無ければ {"fillers":[],"cutGaps":[]} を返す。`;
}

/** モデルの返答から JSON 本体を取り出す（コードフェンスや前置きを許す）。 */
function extractJsonBody(text) {
  if (typeof text !== "string") return "";
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return "";
  return body.slice(start, end + 1);
}

/**
 * モデルの返答から、採用してよい判断だけを取り出す。
 *
 * @param {string} text モデルの返答
 * @param {{offset:number,length:number}} range この返答で答えてよい添字の範囲（＝見せた語）
 * @param {number[]} gapIndexes この返答で答えてよい間の添字（＝見せた間）
 * @returns {{fillers:number[], cutGaps:number[], dropped:string[]}}
 * @throws 返答そのものが読めないとき（JSON でない・配列が無い）＝工程の失敗
 */
export function parseTrimResponse(text, range, gapIndexes) {
  const body = extractJsonBody(text);
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new Error(`AIの返答がJSONとして読めません: ${e.message}`);
  }
  if (!data || !Array.isArray(data.fillers) || !Array.isArray(data.cutGaps)) {
    throw new Error("AIの返答に fillers / cutGaps の配列がありません");
  }

  const dropped = [];
  const lo = range.offset;
  const hi = range.offset + range.length;
  const gapSet = new Set(gapIndexes);

  const take = (arr, label, allowed) => {
    const out = [];
    const seen = new Set();
    for (const v of arr) {
      if (!Number.isInteger(v)) { dropped.push(`${label}: 整数でない値 ${JSON.stringify(v)}`); continue; }
      if (!allowed(v)) { dropped.push(`${label}: 見せていない添字 ${v}`); continue; }
      if (seen.has(v)) { dropped.push(`${label}: 同じ添字が2回 ${v}`); continue; }
      seen.add(v);
      out.push(v);
    }
    return out.sort((a, b) => a - b);
  };

  const fillers = take(data.fillers, "fillers", (v) => v >= lo && v < hi);
  const cutGaps = take(data.cutGaps, "cutGaps", (v) => gapSet.has(v));

  // 全部を言い淀みだと言う返答は、そのかたまりごと捨てる（安全側＝消さない）。
  if (range.length > 0 && fillers.length > range.length * MAX_FILLER_RATIO) {
    dropped.push(
      `fillers: ${range.length}語のうち${fillers.length}語を言い淀みとしたため、` +
        `このかたまりの判断を全部捨てた（上限 ${MAX_FILLER_RATIO * 100}%）`,
    );
    return { fillers: [], cutGaps, dropped };
  }
  return { fillers, cutGaps, dropped };
}

/**
 * 語の並びから「詰める候補になる間」を作る。
 * @param {{w:string,start:number,end:number}[]} words
 * @returns {{index:number,sec:number}[]} index はその間の**直前**の語の添字
 */
export function collectGapCandidates(words) {
  const out = [];
  for (let i = 0; i + 1 < words.length; i += 1) {
    const sec = words[i + 1].start - words[i].end;
    if (sec > SILENCE_CANDIDATE_MIN_SEC) out.push({ index: i, sec });
  }
  return out;
}

/**
 * 判断結果のファイルから、判定データ（素材全体の絶対添字ベース）を読む。
 * ファイルが無い／読めないときは null（呼び元が「判断が取れなかった」として扱う）。
 *
 * 【2026-08-17 の作り直し（G-TRIM2-CLIP）】旧実装はここで「クリップ相対の語→素材全体の
 * 添字」への引き当て（indexOfWord）まで行い、isFiller/cutSilence の関数を直接返していた。
 * 引き当てを語の**表記**で行っていたため、同じ表記の語が素材の別の場所（別のクリップ）にも
 * あると、2本目以降のクリップで誤った判定が使われた（先頭の「あの」が言い淀みなら、後半の
 * 「あの資料を」も消えた）。無音の cutSilence も同様に、絶対時刻とクリップ相対時刻を比べて
 * いたため、segStart>0 のクリップでは実質つねに false になっていた（無音が一切詰まらない）。
 *
 * 引き当ての責務は呼び出し側（pipeline.mjs）へ移した。呼び出し側は
 * `indexesInRange()`（srt-builder.mjs）で「クリップの語が素材全体で何番目か」を求め、
 * 各語オブジェクトへ `_absIndex` として持たせてから planTrim へ渡す。planTrim は
 * それを使って judge を絶対添字で呼ぶので、ここでは絶対添字の集合を返すだけでよい。
 *
 * @param {string} workDir
 * @returns {{fillers:Set<number>, cutGaps:Set<number>}|null}
 */
export function loadTrimJudge(workDir) {
  const p = path.join(workDir, TRIM_JUDGE_FILE);
  if (!fs.existsSync(p)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) {
    return null;
  }
  if (!data || !Array.isArray(data.fillers) || !Array.isArray(data.cutGaps)) return null;
  return { fillers: new Set(data.fillers), cutGaps: new Set(data.cutGaps) };
}

/**
 * loadTrimJudge() が返した判定データから、planTrim へ渡す judge オブジェクトを作る。
 *
 * isFiller/cutSilence はどちらも**絶対添字**で呼ばれる前提（trim-plan.mjs 側が、各語の
 * `_absIndex`（無ければ list 内の位置）を渡す）。ここでは Set の有無を見るだけでよく、
 * 表記の突き合わせも時刻の突き合わせも行わない。
 *
 * @param {{fillers:Set<number>, cutGaps:Set<number>}|null} data
 * @returns {{isFiller:Function, cutSilence:Function}|null}
 */
export function judgeFor(data) {
  if (!data) return null;
  return {
    isFiller: (absIndex) => data.fillers.has(absIndex),
    // afterIndex は「その無音の直前の語」の絶対添字。先頭の無音（直前に語が無い）は -1。
    cutSilence: (_start, _end, afterIndex) => afterIndex >= 0 && data.cutGaps.has(afterIndex),
  };
}

/**
 * 判断の工程。AI へ問い合わせ、検証した結果を trim-judge.json へ書く。
 *
 * 失敗（モデルが起動できない・返答が読めない）は例外にする。黙って規則へ退避すると、
 * マスターが直そうとしている欠陥をそのまま出力に出したうえで、それを利用者に知らせない
 * ことになる（G-EDIT-TRIM2-FAILSTOP）。
 *
 * @param {{workDir:string, runModel:Function, chunkWords?:number, onLog?:Function,
 *          randomNonce?:Function}} args
 * @returns {Promise<{total:number, fillers:number, cutGaps:number, chunks:number, dropped:string[]}>}
 */
export async function trimJudgeStage({ workDir, runModel, chunkWords = CHUNK_WORDS, onLog, randomNonce }) {
  const transcriptPath = path.join(workDir, "transcript.json");
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`文字起こし(transcript.json)がありません: ${transcriptPath}`);
  }
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));
  const words = transcript.words || [];
  const log = typeof onLog === "function" ? onLog : () => {};
  const nonceOf =
    typeof randomNonce === "function"
      ? randomNonce
      : () => Math.random().toString(36).slice(2, 12);

  const size = Number.isInteger(chunkWords) && chunkWords > 0 ? chunkWords : CHUNK_WORDS;
  const allFillers = [];
  const allCutGaps = [];
  const dropped = [];
  let chunkCount = 0;

  for (let i = 0; i < words.length; i += size) {
    const chunk = words.slice(i, i + size);
    // この かたまり の中で完結する間だけを見せる（かたまりをまたぐ間は次の回で見せない。
    // 見せていない間の添字を返されても採用しない仕組みなので、取りこぼしは安全側に倒れる）。
    const gaps = collectGapCandidates(chunk).map((g) => ({ index: g.index + i, sec: g.sec }));
    const nonce = nonceOf();
    const prompt = buildTrimPrompt(chunk, i, gaps, nonce);
    const answer = await runModel(prompt);
    const r = parseTrimResponse(answer, { offset: i, length: chunk.length }, gaps.map((g) => g.index));
    allFillers.push(...r.fillers);
    allCutGaps.push(...r.cutGaps);
    dropped.push(...r.dropped);
    chunkCount += 1;
    log(`  [TRIM-JUDGE] ${chunkCount}かたまり目: 言い淀み${r.fillers.length}件 / 詰める間${r.cutGaps.length}件`);
  }

  const result = {
    fillers: [...new Set(allFillers)].sort((a, b) => a - b),
    cutGaps: [...new Set(allCutGaps)].sort((a, b) => a - b),
    total: words.length,
    dropped,
  };
  fs.writeFileSync(path.join(workDir, TRIM_JUDGE_FILE), JSON.stringify(result, null, 1), "utf-8");
  return {
    total: words.length,
    fillers: result.fillers.length,
    cutGaps: result.cutGaps.length,
    chunks: chunkCount,
    dropped,
  };
}
