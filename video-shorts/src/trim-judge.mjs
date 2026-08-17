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
 * 判断結果のファイルから、planTrim へ渡す判定表を作る。
 * ファイルが無い／読めないときは null（呼び元が「判断が取れなかった」として扱う）。
 * @param {string} workDir
 * @param {{w:string,start:number,end:number}[]} words クリップ相対ではなく素材全体の語
 * @returns {{isFiller:Function, cutSilence:Function, forClip:Function}|null}
 */
export function loadTrimJudge(workDir, words) {
  const p = path.join(workDir, TRIM_JUDGE_FILE);
  if (!fs.existsSync(p)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) {
    return null;
  }
  if (!data || !Array.isArray(data.fillers) || !Array.isArray(data.cutGaps)) return null;
  const fillerSet = new Set(data.fillers);
  // 「詰めてよい間」は、直前の語の終わりの時刻で引けるようにしておく。
  // 添字ではなく時刻で持つのは、planTrim がクリップ相対の語しか見ないため
  // （区間を切り出したあとは添字が全体のものとずれる）。
  const cutEnds = new Set(
    data.cutGaps.map((i) => (words[i] ? t3(words[i].end) : null)).filter((v) => v !== null),
  );
  // 素材の絶対時刻から、素材全体の語の添字を引く表。0.001秒に丸めた開始時刻を鍵にする。
  const idxByStart = new Map();
  words.forEach((w, i) => {
    if (w && Number.isFinite(w.start)) idxByStart.set(t3(w.start), i);
  });

  /**
   * クリップの開始位置(秒)を教えて、そのクリップ用の判断を作る。
   *
   * 【なぜ要るか（2026-08-16）】判断は「素材全体」の添字と絶対時刻で持っているが、
   * planTrim は「クリップ相対」の添字と時刻で動く。この2つの時間軸を橋渡ししないと、
   * 素材の先頭以外から始まるクリップで判断がまるごとずれる。実測した壊れ方は2つ:
   *   ① 言い淀み: クリップ相対の添字で素材全体の語を引くため、素材で最初に出た同じ字面の
   *      判定が使われる。先頭の「あの」が言い淀みなら、後半の「あの資料を」まで消える。
   *   ② 間: cutGaps は素材の絶対時刻で持つのに、planTrim はクリップ相対の時刻で聞くため、
   *      先頭以外のクリップでは常に「詰めない」が返る＝「間を詰める」が丸ごと効かない。
   * 変換をこの1箇所に閉じ込める。呼ぶ側が毎回オフセットを足す形にすると、
   * 足し忘れた経路だけが黙って壊れる（同じ取りこぼしが今回2回起きている）。
   *
   * @param {number} offsetSec クリップの開始位置（素材の絶対秒）
   */
  function forClip(offsetSec = 0) {
    const off = Number.isFinite(offsetSec) ? offsetSec : 0;
    /** クリップ相対の語 → 素材全体の添字（見つからなければ null）。 */
    const absIndexOf = (relWord) => {
      if (!relWord || !Number.isFinite(relWord.start)) return null;
      const hit = idxByStart.get(t3(relWord.start + off));
      if (hit !== undefined) return hit;
      // 丸めの都合で1つずれることがあるので、近いものを探す（0.005秒まで）。
      const abs = relWord.start + off;
      let best = null;
      let bestDiff = 0.005;
      words.forEach((w, i) => {
        const diff = Math.abs(w.start - abs);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = i;
        }
      });
      return best;
    };
    return {
      // 第3引数（クリップ相対の語そのもの）があれば時刻で引き当てる。
      // 無い呼び方（古い検査など）は従来どおり字面と添字で引く。
      isFiller: (index, word, relWord) => {
        if (relWord) {
          const i = absIndexOf(relWord);
          // 引き当てられなければ「消さない」を選ぶ。判断が取れない語を勝手に消すと、
          // 話した言葉が黙って減る（消しすぎより残しすぎのほうが害が小さい）。
          return i === null ? false : fillerSet.has(i);
        }
        return fillerSet.has(indexOfWord(words, word, index));
      },
      cutSilence: (start) => cutEnds.has(t3(start + off)),
      _offsetSec: off,
    };
  }

  return {
    // 素材の先頭から始まるクリップ（offset=0）用。先頭以外のクリップでは forClip() を使う。
    ...forClip(0),
    forClip,
    _absoluteFillers: fillerSet,
    _cutEnds: cutEnds,
  };
}

/** 秒を 0.001 単位へ丸める（時刻を鍵に使うため、両側で同じ丸め方をする）。 */
function t3(sec) {
  return Number(Number(sec).toFixed(3));
}

/** クリップ相対の語を、素材全体の添字へ引き当てる（同じ語が複数あっても順番で当てる）。 */
function indexOfWord(words, word, hint) {
  if (words[hint] && words[hint].w === word) return hint;
  return words.findIndex((w) => w.w === word);
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
