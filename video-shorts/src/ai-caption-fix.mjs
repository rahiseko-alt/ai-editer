// video-shorts AI による字幕の直し（文字起こしの変換ミスを文脈から直す工程）
//
// 【何のためか】音声認識は音は合っていても字を間違える（「公開」と「後悔」、「回答」と「解答」）。
// ※ ここに書く例は、受入判定に使う固定素材の正解表（tests/fixtures/ai-caption-fix/expected.json）に
//    出てくる語と重ねないこと。重ねると「答えを教え込んだ状態で実力を測る」ことになる
//    （2026-08-09 の independent-verifier の指摘で是正。葉 G-EDIT-CAPTION-AI-I の条件(5)）。
// 字幕は焼き込み式なので、間違ったまま焼くと作り直しになる。人が1語ずつ直す前に、
// 文脈が読める AI に「明らかな変換ミス」だけを直させて、人の手直しを減らす。
//
// 【AI に「台本」を読ませてから直させる】直しは断片ではなく台本全体を踏まえて行う。
// 200語ずつ独立に投げていた頃は、1回の AI に 40〜60 秒分しか見えず、
// 「動画編集の話」が「画編集の話」になるような“内容を分かっていれば起こり得ない誤り”を
// 原理的に直せなかった（窓の外に手がかりがあるため）。いまはどの呼び出しにも
//   (1) 台本の全文（段落の文章 segments[].text をつないだもの＝マスターの言う「台本」）
//   (2) 台本全体で繰り返し出てくる綴りと回数（少数派の綴りが誤変換だと気づく手がかり）
//   (3) 直前までのかたまりで既に決めた直し（かたまりをまたいで表記を揃えるための正）
// を必ず添える。かたまり分けは「1回の返答で直しを求める範囲」を区切るだけで、
// 「AI に見せる範囲」ではなくなった。
// 台本が長すぎて全文を毎回添えられない素材だけ、先に1回「全体を読む」呼び出しをして
// 話題と用語の一覧を作り、それを (1) の代わりに添える（分岐と閾値の理由は
// FULL_SCRIPT_MAX_CHARS / OVERVIEW_EXCERPT_CHARS のコメント）。その1回が失敗しても
// 工程は止めず、(2)(3) だけを手がかりに従来どおりの分割修正で続ける（理由は buildScriptContext）。
//
// 【AI に何をさせないか】ここで許すのは「既にある語の綴りの置き換え」だけである。
// 語を足す・消す・並べ替える・時刻を変えることは、モデルの返答が何を言っていても起きない。
// 返答から読むのは {index, before, after} の3つだけで、words / segments / duration のような
// 他のキーは読まずに捨てる（＝語数と時刻はモデルの手が届かない）。
// 時刻が動くと字幕が声からずれ、語数が動くと caption-store.mjs の「何番目の語」が全部ずれる。
//
// 【語だけでなく段落の文章も直す】transcript には語（words[]）とは別に段落の文章（segments[].text）が
// あり、区間選定が読むのは後者である。語だけ直すと、選定が返す keepText は誤変換のままの文字列になり、
// src/reverse-match.mjs が語の側と突き合わせても一致せず、区間がずれるか
// 「逆マッチングで確定した区間が0件」で落ちる。だから直しは両方へ当てる。
//
// 【元を残す】直す前の transcript.json は transcript.raw.json へ丸ごと退避する。
// 元が残っていないと「AI が直した結果が本当に良くなったのか」を後から確かめられず、
// 直しすぎたときに戻せない。退避は初回だけで、2回流しても最初の元が残る。
//
// 【人の直しが勝つ】画面での手直し（caption-store.mjs の caption-edits.json）は、この工程の
// 後に重ねられる。AI が直した語を人がさらに直したら、人の文字が最後に残る。
//
// CLI としても使える（本物のモデルで流す）:
//   node src/ai-caption-fix.mjs <workDir>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_WORD_LENGTH } from "./caption-store.mjs";
import { createIsolatedCwd, wrapUntrustedText } from "./claude-safety.mjs";
import { runClaudeJson } from "./claude-run.mjs";

/** AI が直した内容を置くファイル名（ジョブの作業フォルダの中） */
export const AI_FIXES_FILE = "ai-caption-fixes.json";

/** 直す前の文字起こしの退避先のファイル名 */
export const RAW_TRANSCRIPT_FILE = "transcript.raw.json";

/**
 * 1 回の呼び出しで「直しの対象」として見せる語数の既定。
 *
 * これは AI が読める範囲ではない（台本の全文は毎回添える）。返ってくる JSON の量の上限である。
 *
 * 【2026-08-17 マスター指摘「なぜ、何回も呼ぶのか？1回でまとめてやれよ。」で 400 → 6000】
 * ここを小さくすると、その数で素材が割られて**割った数だけ AI を直列で呼ぶ**（下のループは
 * 1 かたまりずつ await する）。呼び出し1回に数十秒かかるので、400 語刻みだと 30 分の素材で
 * 12 回＝この工程だけで十数分を使っていた。これが「遅い」の主因だった。
 *
 * 分ける必要がそもそも薄い。AI が返すのは**直す語だけ**（全文ではない）なので、対象の語数を
 * 増やしても返答の量はほとんど増えない。増えるのは依頼文の側だけで、そちらは 20 万トークン級の
 * 文脈窓に対して桁違いに小さい。6000 語は日本語の話速でおよそ 40 分ぶんなので、ふつうの素材は
 * **1 回の呼び出しで終わる**（30分→12回が1回、60分→23回が2回）。
 *
 * 0 にしない（＝常に1回にしない）のは、12 時間級の素材だと語の一覧そのものが依頼文へ
 * 入り切らなくなるため。そのときだけ分割へ落ちる。
 */
export const CHUNK_WORDS = 6000;

/**
 * 台本の全文をそのまま毎回添えてよい上限の文字数。
 *
 * 日本語の話し言葉はおよそ 300〜400 字/分なので 20,000 字はおよそ 50〜60 分の発話にあたる。
 * ショート動画の素材はほぼこの中に収まり、その範囲では「要約を作る」よりも
 * 全文をそのまま読ませた方が確実（要約は作った時点で情報が落ちる）。
 * これを超える素材は、全文をかたまりの数だけ繰り返し添えると1回の入力が膨らみ、
 * 入り切らない・遅い・途中で切れるのいずれかを踏むので、下の要約経路へ切り替える。
 */
export const FULL_SCRIPT_MAX_CHARS = 20_000;

/**
 * 台本が長すぎるときに「全体を読む」1回の呼び出しへ渡す、冒頭と末尾それぞれの文字数。
 *
 * 全文が入り切らない長さでも、話題・登場する固有名詞・言い回しの癖は冒頭と末尾に濃く出る。
 * さらに中間の情報は「台本全体で繰り返し出てくる綴りと回数」（機械で数える。抜けが無い）で
 * 補うので、中間を落としても「何の話か」を取り違えにくい。
 */
export const OVERVIEW_EXCERPT_CHARS = 8_000;

/** 「繰り返し出てくる綴り」に載せる語の上限・最低出現回数・最低文字数。 */
export const VOCAB_MAX_TERMS = 60;
export const VOCAB_MIN_COUNT = 2;
export const VOCAB_MIN_LENGTH = 2;

/** 「すでに決めた直し」としてプロンプトへ載せる組の上限（長い素材で入力が膨らみ続けないため）。 */
export const DECIDED_MAX_PAIRS = 200;

/** 1 回の呼び出しに許す時間。server/claude-select.mjs と同じ 5 分。 */
export const MODEL_TIMEOUT_MS = 300_000;

/**
 * 台本の本文を作る（マスターの言う「台本」＝人が読む文章の並び）。
 *
 * 正は段落の文章（segments[].text）。段落が無い素材のときだけ、語をつないだものへ落とす
 * （日本語なので区切り文字は入れない）。ここで作った文字列は AI に「読むだけ」で渡す。
 *
 * @param {{text?:string}[]} segments
 * @param {{w?:string}[]} words
 * @returns {string}
 */
export function buildScriptText(segments, words) {
  const lines = (Array.isArray(segments) ? segments : [])
    .map((s) => (s && typeof s.text === "string" ? s.text.trim() : ""))
    .filter((t) => t.length > 0);
  if (lines.length > 0) return lines.join("\n");
  return (words || []).map((w) => (w && typeof w.w === "string" ? w.w : "")).join("");
}

/**
 * 台本全体で繰り返し出てくる綴りと、その回数を数える（機械で数えるので抜けが無い）。
 *
 * 【何の役に立つか】「動画」が 12 回出ていて「画」が 1 回だけ、のような偏りは、
 * 少数派の側が変換ミスである強い手がかりになる。1 かたまりの中だけを見ていると
 * この偏り自体が見えない（多数派が窓の外にあるため）ので、全体から作って毎回添える。
 *
 * 【正解表ではない】ここに載る綴りは直す前の文字起こしそのままで、誤変換も混ざる。
 * だから「載っているから正しい」とは言えない。プロンプト側でもそう書く。
 *
 * 並びは回数の多い順、同数なら綴りの辞書順（同じ入力なら誰が動かしても同じ並びになる）。
 *
 * @param {{w?:string}[]} words
 * @returns {{term:string,count:number}[]}
 */
export function buildVocabulary(words, opts = {}) {
  const maxTerms = opts.maxTerms ?? VOCAB_MAX_TERMS;
  const minCount = opts.minCount ?? VOCAB_MIN_COUNT;
  const minLength = opts.minLength ?? VOCAB_MIN_LENGTH;
  const counts = new Map();
  for (const w of words || []) {
    if (!w || typeof w.w !== "string") continue;
    const term = w.w.trim();
    // 1 文字の語（助詞など）は数だけ多くて手がかりにならないので載せない。
    if (term.length < minLength) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, maxTerms)
    .map(([term, count]) => ({ term, count }));
}

/** 台本が長すぎるとき、冒頭と末尾だけを残した抜粋にする（中間は落ちたと明示する）。 */
function excerptScript(scriptText, headTailChars = OVERVIEW_EXCERPT_CHARS) {
  if (scriptText.length <= headTailChars * 2) return scriptText;
  return `${scriptText.slice(0, headTailChars)}
……（中略：台本が長いため中間は省略。省略した部分の語も下の「繰り返し出てくる綴り」には数え上げてある）……
${scriptText.slice(-headTailChars)}`;
}

/**
 * 台本が長すぎて全文を毎回添えられないときだけ使う、「全体を1回読ませる」プロンプト。
 *
 * ここでは直しを一切させない（返させるのは話題と用語だけ）。直しを混ぜると、
 * 「見せていない語まで直す」経路がこちら側に増えてしまう。
 */
export function buildOverviewPrompt(scriptText, vocabulary) {
  const vocab = formatVocabulary(vocabulary);
  const body = vocab ? `${scriptText}\n\n【繰り返し出てくる綴りと回数】\n${vocab}` : scriptText;

  return `あなたは日本語の動画台本を読んで、内容を掴む人です。校正はしません。

# 台本（長いので冒頭と末尾の抜粋のことがあります）
${wrapUntrustedText("SCRIPT", body)}

# 返し方
次の JSON のみを返す（説明文・前置き・後置きは不要。コードフェンスで囲んでも構わない）。
{"topic":"何の話かを1〜2文で","terms":["固有名詞","専門用語"]}
- topic は台本全体が何の話かを 1〜2 文で書く。
- terms は台本に実際に出てくる固有名詞・専門用語・繰り返しの言い回しを 40 語まで。
- 台本に出てこない語を作らない。綴りは台本に出てくるままを書く（ここで直そうとしない）。`;
}

/**
 * 「全体を読ませた」返答から話題と用語を取り出す。
 *
 * 読めない返答は例外にする（呼び出し側が握って、台本無しの経路へ落とす）。
 * ここで黙って空を返すと「全体を読ませたのに手がかりが0件だった」のか
 * 「そもそも読めていない」のかがログから区別できなくなる。
 */
export function parseOverviewResponse(text) {
  const data = JSON.parse(extractJsonBody(text));
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("台本の読み取りの返答が {\"topic\":...,\"terms\":[...]} の形ではありません");
  }
  const topic = typeof data.topic === "string" ? data.topic.trim().slice(0, 400) : "";
  const terms = [];
  const seen = new Set();
  for (const t of Array.isArray(data.terms) ? data.terms : []) {
    if (typeof t !== "string") continue;
    const term = t.trim().replace(/[\r\n]+/g, " ").slice(0, 60);
    if (term.length === 0 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= 40) break;
  }
  if (topic === "" && terms.length === 0) {
    throw new Error("台本の読み取りの返答に topic も terms もありません");
  }
  return { topic, terms };
}

/**
 * 各かたまりのプロンプトへ添える「台本の文脈」を用意する。
 *
 * 【分岐（長さで決める。閾値の理由は各定数のコメント）】
 *   full        : 台本が FULL_SCRIPT_MAX_CHARS 以内 → 全文をそのまま毎回添える（呼び出しは増えない）
 *   vocab-only  : 台本は長いが、かたまりが1つしかない → その1回に全語が載るので、まとめは要らない
 *   overview    : 台本が長く、かたまりも複数 → 1回だけ「全体を読む」呼び出しをして話題と用語を作る
 *
 * 【失敗しても止めない】overview の呼び出しが落ちても例外にしない。誤字直しは
 * 「直せる所を直す」工程であって、全体を読む呼び出しの失敗でパイプライン全体を殺す理由が無い。
 * 落ちたら理由をログへ出し、機械で数えた「繰り返し出てくる綴り」だけを手がかりに、
 * 従来どおりの分割修正で続行する（vocab-only と同じ状態）。
 *
 * @returns {Promise<{mode:string,scriptText:string,topic:string,terms:string[],
 *   vocabulary:{term:string,count:number}[]}>}
 */
export async function buildScriptContext({ words, segments, runModel, chunkCount = 1, onLog }) {
  const vocabulary = buildVocabulary(words);
  const scriptText = buildScriptText(segments, words);
  const base = { scriptText: "", topic: "", terms: [], vocabulary };

  if (scriptText.length === 0) return { ...base, mode: "none" };
  if (scriptText.length <= FULL_SCRIPT_MAX_CHARS) {
    return { ...base, mode: "full", scriptText };
  }
  if (chunkCount <= 1) return { ...base, mode: "vocab-only" };

  try {
    const answer = await runModel(buildOverviewPrompt(excerptScript(scriptText), vocabulary));
    const { topic, terms } = parseOverviewResponse(answer);
    if (onLog) {
      onLog(`[ai-caption-fix] 台本が長い(${scriptText.length}字)ので、先に全体を読んで話題と用語(${terms.length}件)を作りました`);
    }
    return { ...base, mode: "overview", topic, terms };
  } catch (e) {
    if (onLog) {
      onLog(`[ai-caption-fix] 台本全体の読み取りに失敗したので、繰り返し出てくる綴りだけを手がかりに続行します: ${e.message}`);
    }
    return { ...base, mode: "vocab-only" };
  }
}

/** 「綴り(回数)」の一覧を1行にする。載せる語が無ければ空文字。 */
function formatVocabulary(vocabulary) {
  return (vocabulary || [])
    .filter((v) => v && typeof v.term === "string" && Number.isInteger(v.count))
    .map((v) => `${v.term}(${v.count})`)
    .join(" / ");
}

/** すでに採用した直しを「「前」→「後」」の一覧にする（重複は畳む）。 */
function formatDecided(decided) {
  const pairs = [];
  const seen = new Set();
  for (const d of decided || []) {
    if (!d || typeof d.before !== "string" || typeof d.after !== "string") continue;
    // 極端に長い語は一覧を膨らませるだけなので載せない（直し自体は既に当たっている）。
    if (d.before.length > MAX_WORD_LENGTH) continue;
    // 重複を畳む鍵の区切りは、語に出てこない制御文字にする。空白で繋ぐと
    // 「あ い」+「う」と「あ」+「い う」が同じ鍵になり、別々の組を重複と誤判定して片方を落とす。
    const key = `${d.before}\u0000${d.after}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(`「${d.before}」→「${d.after}」`);
    if (pairs.length >= DECIDED_MAX_PAIRS) break;
  }
  return pairs.join("\n");
}

/**
 * 台本の文脈を1つの非信頼テキストの囲いへまとめる。
 *
 * 【なぜ1つの囲いへ入れるか】台本の本文も、繰り返し出てくる綴りも、すでに決めた直しも、
 * もとを辿れば音声から起こした非信頼なテキスト（after はそれを読んだモデルの出力）である。
 * 囲いの外へ地の文として置くと、文字起こしの中に書かれた文が「AI への指示」として読める
 * 位置に混ざる。囲いは1回分の乱数 nonce 付きなので、中から閉じタグを詐称できない。
 *
 * @returns {string} 添えるものが何も無ければ空文字
 */
function formatScriptContext(context, decided) {
  const parts = [];
  if (context && context.mode === "full" && context.scriptText) {
    parts.push(`【台本の全文】\n${context.scriptText}`);
  }
  if (context && context.topic) parts.push(`【この台本の話題】\n${context.topic}`);
  if (context && context.terms && context.terms.length > 0) {
    parts.push(`【台本に出てくる用語】\n${context.terms.join(" / ")}`);
  }
  const vocab = formatVocabulary(context && context.vocabulary);
  if (vocab) parts.push(`【台本全体で繰り返し出てくる綴りと回数】\n${vocab}`);
  const decidedList = formatDecided(decided);
  if (decidedList) parts.push(`【この台本で既に決めた直し】\n${decidedList}`);
  if (parts.length === 0) return "";

  return `
# この動画の台本（内容を掴むために読む。ここ自体は直す対象ではない）
${wrapUntrustedText("SCRIPT", parts.join("\n\n"))}
- 台本と下の語は同じ音声から起こした同じ内容である。台本の側も直っていないので、
  「台本にそう書いてあるから正しい」とは考えない。何の話かを掴むために読む。
- 繰り返し出てくる綴りは正解表ではない。回数の少ない綴りが多い綴りの変換ミスでないかを
  疑う手がかりとしてだけ使う。
- 「既に決めた直し」は、この台本で先に確定した表記である。同じ語が同じ意味で下にも出てきたら、
  同じ綴りへ揃える（場所によって別の直され方をさせないため）。
`;
}

/**
 * 1 かたまり分の「変換ミスを直させる」プロンプトを組み立てる。
 *
 * 文字起こしは非信頼データなので、既存の守り wrapUntrustedText で囲む（P1-1-D）。
 * 乱数 nonce 付きのタグなので、文字起こしの中に閉じタグを書いておく細工をされても、
 * 乱数を当てられない限り境界の外へ抜け出せない。自前の固定文字列で囲むと詐称できてしまう。
 *
 * 台本（context / decided）は「読むだけ」の材料として、別の囲いで添える。添える中身は
 * formatScriptContext を見ること。ここに何を添えても、直しとして採用される範囲は
 * 下の「直す対象」に並べた語だけで変わらない（範囲の判定は parseFixResponse の range が行う）。
 *
 * @param {{w:string,start:number,end:number}[]} words このかたまりの語
 * @param {number} offset このかたまりの先頭が、文字起こし全体で何番目の語か
 * @param {object} [context] buildScriptContext の戻り（省略時は台本を添えない）
 * @param {{before:string,after:string}[]} [decided] ここまでのかたまりで既に採用した直し
 * @returns {string}
 */
export function buildFixPrompt(words, offset, context, decided) {
  // 添字は文字起こし全体での実添字（offset + i）。かたまりの中の番号を渡すと、
  // 2かたまり目以降の直しが先頭の語に当たってしまう。
  const lines = words.map((w, i) => `${offset + i}\t${w.w}`).join("\n");
  const script = formatScriptContext(context, decided);

  return `あなたは日本語の文字起こしを校正する人です。音声認識が音は合っているのに字を間違えた所` +
    `（変換ミス・同音異義語の取り違え）だけを、台本全体の内容と前後の文脈から直してください。
${script}
# 直す対象の文字起こし（1 行に 1 語で「添字<タブ>語」。添字は文字起こし全体での語の番号）
${wrapUntrustedText("TRANSCRIPT", lines)}

# できること・できないこと
- できるのは、既にある語の綴りを別の綴りへ置き換えることだけ。
- 語の追加・削除・並べ替え・時刻の変更はできない。
- 言い回しの改善・要約・敬語の統一はしない。明らかな変換ミスだけを直す。
- 直してよいのは「直す対象」に並んだ語だけ。台本の側だけを見た直しを返しても採用されない。
- 同じ語は台本全体で同じ綴りへ揃える。場所によって違う直し方をしない。
- 迷ったら直さない。直す必要が無ければ 1 件も返さなくてよい。

# 返し方
次の JSON のみを返す（説明文・前置き・後置きは不要。コードフェンスで囲んでも構わない）。
{"fixes":[{"index":5,"before":"公開","after":"後悔"}]}
- index は上に並んだ添字をそのまま使う。同じ添字を2回以上返してはいけない
  （どちらが正しいか決められないので、その添字の直しは全部捨てる）。
- before は、その添字の語を一字一句そのまま書き写す（違っていればその1件は捨てられる）。
- after は直した後の語。1 語だけ・改行なし・${MAX_WORD_LENGTH}文字以内。
- 直す必要が無ければ {"fixes":[]} を返す。`;
}

/**
 * モデルの返答から、採用してよい直しだけを取り出す。
 *
 * 【なぜ黙って捨てるものと例外にするものを分けるか】
 * 「返答そのものが読めない（JSON でない・fixes が無い）」は工程の失敗なので例外にする。
 * 黙って 0 件にすると、モデルが一度も答えていないのに「直す所は無かった」と区別がつかない。
 * 一方「1 件ずつの中身が条件に合わない」のは想定内（モデルは間違える）なので、その1件だけ捨てる。
 *
 * 【同じ添字が2回以上来たら全部捨てる】どちらが正しいかを機械では決められない。
 * 先に来た方を採ると、モデルの並べ方しだいで結果が変わる（同じ返答でも当たり外れが出る）。
 * 直さないのは安全側（元の文字が残るだけ）なので、迷う語は触らない。
 *
 * 【そのかたまりに出していない語は直させない】プロンプトに載せた語だけが直しの対象である。
 * 範囲を全語で見ると、モデルが「そのかたまりに入っていない添字」を返したときに、
 * 見せてもいない語を書き換えられる（1かたまりの返答で文字起こし全体に手が届く）。
 * range を渡すと、採用する添字を `offset <= index < offset + length` に絞る。
 *
 * @param {string} text モデルの返答
 * @param {{w:string}[]} words 文字起こし全体の語（かたまりではなく全部）
 * @param {{offset:number,length:number}} [range] この返答で直してよい添字の範囲
 *   （＝そのかたまりに出した語）。省略時は全語（純粋関数として単体で使うとき用）。
 * @returns {{index:number,before:string,after:string}[]} 添字の昇順
 */
export function parseFixResponse(text, words, range) {
  const body = extractJsonBody(text);
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new Error(
      `AIの返答をJSONとして読めませんでした: ${e.message}（返答の先頭: ${String(text ?? "").slice(0, 120)}）`
    );
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error('AIの返答が {"fixes":[...]} の形ではありません（オブジェクトではありません）');
  }
  if (!Array.isArray(data.fixes)) {
    throw new Error('AIの返答に fixes の配列がありません（直しが無いときも {"fixes":[]} を返させています）');
  }

  // 先に添字の重複を数える。2回以上出てくる添字は、その語の直しを1件も採らない。
  const seenCount = new Map();
  for (const f of data.fixes) {
    if (f === null || typeof f !== "object" || Array.isArray(f)) continue;
    if (!Number.isInteger(f.index)) continue;
    seenCount.set(f.index, (seenCount.get(f.index) ?? 0) + 1);
  }

  const all = words || [];
  // 直してよい添字の範囲。range 未指定なら全語（単体で使うとき）。
  const lo = range && Number.isInteger(range.offset) ? range.offset : 0;
  const hi = range && Number.isInteger(range.length) ? lo + range.length : all.length;
  const out = [];
  for (const f of data.fixes) {
    if (f === null || typeof f !== "object" || Array.isArray(f)) continue;
    const { index } = f;
    // 添字は整数で、実在する語を指していること（範囲外は語数を変えようとしているのと同じ）。
    if (!Number.isInteger(index) || index < 0 || index >= all.length) continue;
    // そのかたまりで見せていない語は直させない（見せていない所に手を伸ばした返答は捨てる）。
    if (index < lo || index >= hi) continue;
    if ((seenCount.get(index) ?? 0) > 1) continue; // 同じ語に2件以上＝どちらも採らない
    const src = all[index];
    if (!src || typeof src.w !== "string") continue;
    // before が実際の語と違う＝モデルが別の語を見ている。位置がずれた直しは当てない。
    if (typeof f.before !== "string" || f.before.trim() !== src.w.trim()) continue;
    if (typeof f.after !== "string") continue;
    // 改行は trim 前の生の文字で見る。trim だけだと「後悔\n」は通ってしまい、
    // 字幕(ASS)の1行に改行が混ざる。
    if (/[\r\n]/.test(f.after)) continue;
    const after = f.after.trim();
    if (after.length === 0) continue;
    // 長さの数え方は caption-store.mjs の手直しと同じ（JS の String.length ＝ UTF-16 の符号単位数）。
    // 二つの入口で数え方が違うと、片方で通る語がもう片方で弾かれる。
    if (after.length > MAX_WORD_LENGTH) continue;
    if (after === src.w) continue; // 直っていないものを直した扱いにしない
    out.push({ index, before: src.w, after });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * 直しを語の配列へ当て込んだ新しい配列を返す。
 * 差し替えるのは w だけで、start / end には触れない（触ると字幕が声からずれる）。
 */
export function applyFixes(words, fixes) {
  const table = new Map();
  for (const f of fixes || []) {
    if (!table.has(f.index)) table.set(f.index, f.after);
  }
  return (words || []).map((w, i) => (table.has(i) ? { ...w, w: table.get(i) } : w));
}

/**
 * 直しを段落の文章（segments[].text）へも当て込んだ新しい配列を返す。
 *
 * 【なぜ要るか】区間選定が読むのは segments[].text で、選定が返す keepText はその文章からの
 * 抜き出しになる。語だけ直して文章を直さないと、選定は誤変換のままの文字列を返し、
 * src/reverse-match.mjs が語の側（直した文字）と突き合わせても一致しない。
 *
 * 【どの段落に当てるか】その語の開始時刻を含む段落。時刻で選ぶので、同じ文字が別の段落に
 * あっても取り違えない。
 *
 * 【段落の中のどこに当てるか＝その語自身の位置】段落に同じ文字が2回以上あるとき、
 * 「before の最初の1回」を置き換えると、モデルが直したのが後ろの語でも前の語が書き換わる。
 * そうなると words[] と segments[].text が食い違い、区間選定→keepText→src/reverse-match.mjs
 * を経て焼き込みへ出る文言が、直したはずの語と別物になる。
 * だから段落に属する語を順に走査して1語ずつの文字位置（オフセット）を求め、
 * その語自身の位置で置き換える。置き換えは**オフセットの降順**に当てる
 * （前から当てると、長さが変わったぶん後ろの位置がずれる）。
 *
 * 【対応が取れない段落は触らない】語をつないだものが段落の文章と辿れない素材
 * （文字起こしの取りこぼし等）では、どの位置がその語かを決められない。
 * その段落は1文字も変えない＝黙って別の箇所を書き換えない。
 *
 * @param {{start:number,end:number,text:string}[]} segments
 * @param {{index:number,before:string,after:string}[]} fixes
 * @param {{start:number,w:string}[]} words 文字起こし全体の語（直す前）
 */
export function applyFixesToSegments(segments, fixes, words) {
  const list = (segments || []).map((s) => ({ ...s }));
  const all = words || [];

  // 段落ごとに、その段落へ当てる直しを集める（1件ずつ当てると位置がずれるため）。
  const bySegment = new Map();
  for (const f of fixes || []) {
    const w = all[f.index];
    if (!w || typeof w.start !== "number") continue;
    const si = list.findIndex(
      (s) => typeof s.text === "string" && w.start >= s.start && w.start <= s.end
    );
    if (si === -1) continue;
    if (!bySegment.has(si)) bySegment.set(si, []);
    bySegment.get(si).push(f);
  }

  for (const [si, segFixes] of bySegment) {
    const seg = list[si];
    const offsets = wordOffsetsInSegment(seg, all);
    if (!offsets) continue; // 語と文章の対応が取れない＝どこを直すか決められないので触らない
    const targets = [];
    for (const f of segFixes) {
      const at = offsets.get(f.index);
      if (at === undefined) continue;
      // 求めた位置に本当にその語があるかを最後に確かめる（ずれた置き換えを当てない）。
      if (seg.text.slice(at, at + f.before.length) !== f.before) continue;
      targets.push({ at, f });
    }
    targets.sort((a, b) => b.at - a.at); // 後ろから当てる＝前の位置がずれない
    for (const { at, f } of targets) {
      seg.text = seg.text.slice(0, at) + f.after + seg.text.slice(at + f.before.length);
    }
  }
  return list;
}

/**
 * その段落に属する語（開始時刻が段落の中にある語）の、段落の文章での文字位置を返す。
 * 語は文章の中に出てくる順に並ぶ前提で、前の語の直後から次の語を探す
 * （同じ文字が複数あっても、その語自身の出現に当たる）。
 * 1語でも辿れなければ null（＝その段落は触らない）。
 *
 * @returns {Map<number,number>|null} 語の添字 → 段落の文章での開始位置
 */
function wordOffsetsInSegment(seg, words) {
  const offsets = new Map();
  let cursor = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w || typeof w.start !== "number" || typeof w.w !== "string") return null;
    if (w.start < seg.start || w.start > seg.end) continue;
    const at = seg.text.indexOf(w.w, cursor);
    if (at === -1) return null;
    offsets.set(i, at);
    cursor = at + w.w.length;
  }
  return offsets;
}

/**
 * 文字起こしを AI に「台本」として読ませ、変換ミスを直して transcript.json を置き換える工程。
 *
 * 直しを求める範囲はかたまりに分けるが、台本の文脈（全文か、全体を読んで作った話題と用語）は
 * どのかたまりの呼び出しにも必ず添える＝1回の AI が窓の中しか見ていない状態を作らない。
 *
 * @param {object} p
 * @param {string} p.workDir ジョブの作業フォルダ（transcript.json がある所）
 * @param {(promptDoc:string)=>Promise<string>} p.runModel モデルを呼ぶ関数
 * @param {number} [p.chunkWords] 1 回に「直す対象」として見せる語数
 * @param {(s:string)=>void} [p.onLog]
 * @returns {Promise<{fixed:number,total:number,chunks:number,contextMode:string}>}
 */
export async function aiCaptionFixStage({ workDir, runModel, chunkWords = CHUNK_WORDS, onLog }) {
  const transcriptPath = path.join(workDir, "transcript.json");
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`文字起こし(transcript.json)がありません: ${transcriptPath}`);
  }
  // 退避はここで読んだ「元の中身そのまま」を書く（parse→stringify し直すと、
  // 元のファイルと1バイトも違わないことを後から確かめられなくなる）。
  const originalText = fs.readFileSync(transcriptPath, "utf-8");
  const transcript = JSON.parse(originalText);
  const words = transcript.words || [];

  const size = Number.isInteger(chunkWords) && chunkWords > 0 ? chunkWords : CHUNK_WORDS;
  const chunks = [];
  for (let i = 0; i < words.length; i += size) {
    chunks.push({ offset: i, words: words.slice(i, i + size) });
  }

  // 先に台本全体の文脈を用意する。これを毎回のプロンプトへ添えることで、
  // 1回の AI が「かたまりの中しか見ていない」状態を無くす（この工程の目的）。
  // ここは失敗しても例外にしない（中で握って、文脈が薄い状態のまま続行する）。
  const context = await buildScriptContext({
    words,
    segments: transcript.segments,
    runModel,
    chunkCount: chunks.length,
    onLog,
  });
  if (onLog && chunks.length > 0) {
    onLog(`[ai-caption-fix] 台本の渡し方=${context.mode}（台本 ${context.scriptText.length} 字 / 用語 ${context.terms.length} 件 / 繰り返し語 ${context.vocabulary.length} 件）を全 ${chunks.length} かたまりへ添えます`);
  }

  // かたまりは順番に処理する（並列にしない）。並列にするとログが混ざって、
  // どのかたまりで何が起きたのかが読めなくなる。速さが要るようになってから並列にする。
  // 順番であることは表記揃えにも効く: 直前までに採用した直し(collected)をそのまま
  // 次のかたまりへ「既に決めた直し」として見せられる。
  const collected = [];
  for (let n = 0; n < chunks.length; n++) {
    const c = chunks[n];
    // runModel / parseFixResponse の例外はそのまま上へ投げる＝工程は失敗して終わる。
    // ここで握りつぶすと「AI が一度も答えていないのに直す所は無かった」ことになる。
    const answer = await runModel(buildFixPrompt(c.words, c.offset, context, collected));
    // 採用するのは、このかたまりに出した語だけ（見せていない語への直しは捨てる）。
    const got = parseFixResponse(answer, words, { offset: c.offset, length: c.words.length });
    collected.push(...got);
    if (onLog) {
      const last = c.offset + c.words.length - 1;
      onLog(`[ai-caption-fix] ${n + 1}/${chunks.length} かたまり（${c.offset}〜${last} 語目）→ ${got.length} 件`);
    }
  }

  // かたまりをまたいで同じ語への直しが来たときも、どちらが正しいか決められないので全部捨てる
  // （かたまりの中で同じ添字が2回来たときと同じ扱い）。
  const countByIndex = new Map();
  for (const f of collected) countByIndex.set(f.index, (countByIndex.get(f.index) ?? 0) + 1);
  const fixes = collected
    .filter((f) => countByIndex.get(f.index) === 1)
    .sort((a, b) => a.index - b.index);

  // 表記揃えの見張り。同じ綴りが場所によって別の綴りへ直されていたら、それを黙って通さずログへ出す。
  // 【なぜ捨てないか】日本語では同じ音の語が文脈ごとに別の字になるのが正しい場合がある
  // （「かいとう」が或る所では「回答」、別の所では「解答」）。機械には見分けが付かないので、
  // ここで消すと正しい直しまで落ちる。揃えるのはプロンプト側（「既に決めた直し」を次の
  // かたまりへ見せる）で行い、ここは人が気づけるようにするだけに留める。
  if (onLog) {
    const afterByBefore = new Map();
    for (const f of fixes) {
      if (!afterByBefore.has(f.before)) afterByBefore.set(f.before, new Set());
      afterByBefore.get(f.before).add(f.after);
    }
    for (const [before, afters] of afterByBefore) {
      if (afters.size > 1) {
        onLog(`[ai-caption-fix] 表記が揃っていません: 「${before}」が ${[...afters].map((a) => `「${a}」`).join("・")} へ直されています（文脈で正しく分かれている場合もあります）`);
      }
    }
  }

  const next = {
    ...transcript,
    words: applyFixes(words, fixes),
    segments: applyFixesToSegments(transcript.segments, fixes, words),
  };

  // ここから書き込み。ここまでで例外が出た経路では transcript.json を1バイトも触っていない。
  // (a) 元の退避（まだ無いときだけ）→ (b) 直しの記録 → (c) 本体の置き換え、の順に行う。
  // (c) を先にやると、途中で落ちたときに「直った本体はあるが元が無い」状態になって戻せない。
  const rawPath = path.join(workDir, RAW_TRANSCRIPT_FILE);
  if (!fs.existsSync(rawPath)) {
    writeFileAtomically(rawPath, originalText);
  }
  writeFileAtomically(
    path.join(workDir, AI_FIXES_FILE),
    `${JSON.stringify({ fixes }, null, 2)}\n`
  );
  writeFileAtomically(transcriptPath, `${JSON.stringify(next, null, 2)}\n`);

  return { fixed: fixes.length, total: words.length, chunks: chunks.length, contextMode: context.mode };
}

/**
 * 本物のモデル（claude -p）を呼ぶ runModel。
 * 起動の守り（ツール無効化 / env allowlist / タイムアウト）は src/claude-run.mjs が持つ。
 */
export async function defaultRunModel(promptDoc, { cwd, timeoutMs = MODEL_TIMEOUT_MS }) {
  return runClaudeJson({ stdin: promptDoc, cwd, timeoutMs });
}

/**
 * 本物のモデルで工程を回すための runModel を作る。
 * cwd はジョブ専用の隔離ディレクトリ（他ジョブ・他顧客のファイルに触れない）。
 */
export function createDefaultRunModel(workDir, timeoutMs = MODEL_TIMEOUT_MS) {
  const cwd = createIsolatedCwd(path.basename(workDir));
  return (promptDoc) => defaultRunModel(promptDoc, { cwd, timeoutMs });
}

/** コードフェンスを剥がし、最初の { から最後の } までを取り出す。 */
function extractJsonBody(text) {
  const s = typeof text === "string" ? text : "";
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fence ? fence[1] : s).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  // 波括弧が見つからないときは、そのまま JSON.parse に判定を委ねて例外にする
  // （ここで空を返すと「読めない返答」が「直し0件」に化ける）。
  if (start === -1 || end === -1 || end < start) return body;
  return body.slice(start, end + 1);
}

/**
 * 同じフォルダの一時ファイルへ書いてから置き換える（caption-store.mjs と同じ作法）。
 * 直接上書きすると、書いている途中で落ちたときに中身が丸ごと読めなくなる。
 */
function writeFileAtomically(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, target);
}

// ── CLI（本物のモデルで流す） ────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [workDir] = process.argv.slice(2);
  if (!workDir) {
    console.error("usage: node src/ai-caption-fix.mjs <workDir>");
    process.exit(2);
  }
  aiCaptionFixStage({
    workDir,
    runModel: createDefaultRunModel(workDir),
    onLog: (s) => process.stderr.write(`${s}\n`),
  })
    .then((r) => console.log(`ai caption fix done: ${r.fixed} fix(es) / ${r.total} word(s) / ${r.chunks} chunk(s)`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
