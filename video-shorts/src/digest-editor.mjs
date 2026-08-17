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
import { resolveSegments, normalize } from "./reverse-match.mjs";
import { createIsolatedCwd, wrapUntrustedText } from "./claude-safety.mjs";
import { runClaudeJson, DEFAULT_CLAUDE_MODEL } from "./claude-run.mjs";

const TIMEOUT_MS = Number(process.env.DIGEST_TIMEOUT_MS ?? 300_000);
// モデルは src/claude-run.mjs の DEFAULT_CLAUDE_MODEL に統一する（マスター指示 2026-08-17
// 「全部Opus5で統一しろ」）。以前はここだけが独自のモデルを pin し、誤字修正・話題ごとの
// 選定・言い淀みの判断は何も指定していなかったため、CLI の既定（実測 claude-sonnet-5）で
// 動いていた＝工程ごとにモデルが違った。
// ここで明示的に持つのは、この工程だけが「その pin が原因で落ちたら CLI 既定へ1度だけ
// 退避する」仕組みを持っているため（下の callClaude）。モデル名が使えない環境でも
// 台本作成だけは止まらないようにする保険で、共通口へ移すと失われる。
const MODEL = process.env.DIGEST_MODEL ?? DEFAULT_CLAUDE_MODEL;
const MAX_ITER = Number(process.env.DIGEST_MAX_ITER ?? 3);
const PASS_SCORE = Number(process.env.DIGEST_PASS_SCORE ?? 80);
/** 目標尺の許容幅。旧実装は ±20% で、目標60秒(48〜72s)と目標90秒(72〜108s)の許容が
 *  72秒で重なっていた＝同じ台本が1分指定でも1分半指定でも合格しえた（マスター指摘の一因）。
 *  帯が重ならないよう ±10% へ狭める（60s→54〜66s / 90s→81〜99s）。 */
const DURATION_TOL = Number(process.env.DIGEST_DURATION_TOL ?? 0.1);
/** 尺是正の最大試行回数。旧実装は if 1回きりで、外れたままでも確定していた。 */
const DURATION_MAX_FIX = Number(process.env.DIGEST_DURATION_MAX_FIX ?? 2);

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
    // 退避のときは共通口の既定モデルも付けない（付くと同じ理由で落ちる）。
    noDefaultModel: !useModel,
  }).catch((e) => {
    // 終了コードが 0 でない失敗にだけ stderr/stdout が付く（打ち切り・spawn 失敗・JSON 崩れには付かない）。
    // ＝再試行するのは「--model 指定が原因で終了コードが非0になった」場合だけ、という従来の絞り込みのまま。
    //
    // 判定は stderr と stdout の両方に対して行う。claude はモデル起因の失敗のとき、stderr へは
    // 機械可読タグ（[claude-code:unrecognized_model] {...}）を出す一方、人間可読な理由
    // （"There's an issue with the selected model ..."）は結果として stdout 側へ出す。
    // 旧実装は stderr だけを見ており、CLI の文言が変わって機械タグ側が正規表現に掛からなくなると、
    // 退避できるはずの失敗をそのまま投げてしまう（2026-08-15 の調査で判明。docs/failures.md 参照）。
    const failureText = `${e?.stderr ?? ""}\n${e?.stdout ?? ""}`;
    if (useModel && MODEL_ERROR_RE.test(failureText)) {
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

// 「どこで切るか」の規則。docs/編集についての虎の巻.md の §2（言葉の側の切り方）が正で、
// ここはその要点をプロンプトへ落としたもの。虎の巻と食い違ったら虎の巻が正（AGENTS.md）。
//
// なぜ要るか（マスター指摘 2026-08-17）: 旧 VERBATIM は「実在する連続した部分文字列」としか
// 言っておらず、**単語の途中から始めてよい**と明示的に許していた。文字列としての部分列で
// あることは、切り方として正しいことを何も保証しない。「動画編集」を割って「画編集」に
// するような候補が、規則の上では合法だった。
const CUT_RULES = `【切る位置の規則（部分文字列であれば良い、ではない）】\n` +
  `1. keepText の先頭は文の先頭にする。末尾は文末表現の最後まで含める（「〜と思うんですよ」の「よ」まで）。\n` +
  `2. 複合語は1語なので絶対に割らない（動画編集／文字起こし／切り抜き動画／視聴維持率 等）。` +
  `「動画編集の話」を「画編集の話」にするような切り方は、部分文字列として存在しても禁止。\n` +
  `3. 助詞（は・が・を・に・で・と・から・けど・ので 等）で始まる断片を作らない。助詞は直前の語と1つのまとまり。\n` +
  `4. 接続詞（で、／それで、／だから、／でも、／なので、）や相槌（はい／うん／そうですね）で始めない。\n` +
  `5. 指示語（それは／これが／あの件は／そういうのは）で始めない。指示先を含むまで範囲を前へ広げる。` +
  `広げられないならその候補は捨てる。\n` +
  `6. 接続助詞で終わらない（〜なんですけど、／〜して、／〜すると、）。主語だけ・目的語だけで終わらない。\n` +
  `7. 迷ったら広く取る。短く削って意味が壊れるより、少し長い方が良い。\n` +
  `8. 切り出した一片が、それ単体で読んで意味が通ること。通らないなら範囲を広げるか、その候補を捨てる。`;

const VERBATIM = `【厳守】keepText は文字起こし本文に実在する連続した部分文字列を一字一句そのまま抜き出す。` +
  `語順を変える・言い換える・要約する・創作するのは禁止（後段が本文へ逆照合して秒数を確定するため）。` +
  `順序（segmentsの並び）だけは自由に入れ替えてよい。\n\n${CUT_RULES}`;

/** 先頭に来たらその断片が単体で意味を成さないもの（虎の巻 §2-3 / §2-4）。 */
const BAD_HEAD_RE = /^(?:[はがをにへとでもや]|から|けど|けれど|ので|のに|そして|それで|だから|ですから|でも|しかし|なので|それから|ただ|つまり|要するに|で、|はい|ええ|うん|そうですね|それ|これ|あれ|そういう|こういう|あの件|その件)/;
/** 末尾に来たら言い差し・宙ぶらりんになるもの（虎の巻 §2-3 / §2-4）。 */
const BAD_TAIL_RE = /(?:[はがをにへとでもや]|けど|けれど|ですけど|ますけど|ので|のに|から|して|すると|であり|でして|ですが|ますが|、)$/;

/**
 * keepText が「切り出した一片として使えるか」を見る。
 *
 * 旧実装は `keepText.trim().length >= 4` だけで採否を決めており、文として閉じているかを
 * 一度も見ていなかった（虎の巻 §8-C）。4文字の断片（「画編集の」）がそのまま通る。
 *
 * ここは機械的な足切りなので、日本語の係り受けを完全に判定することはできない。
 * 狙いは「明らかに壊れている断片を落とす」ことだけで、正しさの保証は AI 側（CUT_RULES）に置く。
 */
export function isUsableKeepText(text) {
  if (typeof text !== "string") return false;
  const s = text.trim();
  if (s.length < 6) return false;          // 4文字では文になり得ない。虎の巻 §2-5-4
  if (BAD_HEAD_RE.test(s)) return false;
  if (BAD_TAIL_RE.test(s)) return false;
  return true;
}

/**
 * 台本の区間配列を、使える形へ整える。
 *
 * 足切りで全滅すると製品が止まるため、`isUsableKeepText` で0件になったときだけ
 * 従来の長さのみの条件へ退避する（落とすことより、動画が作れなくなる方が害が大きい）。
 * 退避したことはログに残し、黙って基準が緩まないようにする。
 */
function pickUsableSegments(list, onLog = () => {}, where = "") {
  const base = (list || []).filter((s) => s && typeof s.keepText === "string");
  const strict = base.filter((s) => isUsableKeepText(s.keepText));
  if (strict.length > 0) return strict;
  const loose = base.filter((s) => s.keepText.trim().length >= 4);
  if (loose.length > 0) {
    onLog(`[digest] 切り方の条件を満たす区間が0件のため、長さのみの条件へ退避${where ? `（${where}）` : ""}: ${loose.length}件`);
  }
  return loose;
}

/**
 * 目標尺の帯ごとに「何を残し何を捨てるか」の方針そのものを変える。
 *
 * なぜ必要か（マスター指摘 2026-08-17「ダイジェストで1分とダイジェストで1分半なら
 * 当然大きく変わるはずなのにほぼ変わらない。考えていない証拠だ。」）:
 * 旧実装が尺について伝えていたのは「合計◯◯文字」という数値1つだけだった。
 * 数値だけを差し替えても、AIにとって「1分なら何を捨てるか」「1分半なら何を足せるか」は
 * 決まらないため、同じ素材からはほぼ同じ台本が出る。尺は文字数の上限ではなく
 * 「どういう構成にするか」の指示である、という形へ直す。
 */
/** 尺の帯（虎の巻 §5-3 の表）。lo/hi は帯の秒数範囲、countLo/countHi はその帯の「区間数の目安」。
 *  帯だけで方針を決めると、同じ帯に入る目標（例: 60秒と90秒はどちらも「〜90秒」の帯）で
 *  文面が1文字も変わらない。帯の中のどこに居るかで本数を決めるため、目安を範囲で持つ。 */
const DURATION_BANDS = [
  { lo: 0, hi: 45, countLo: 1, countHi: 2,
    prose: `主張を1つだけ、最も強い言い方で見せ切る長さ。話題は1つに絞り、` +
      `前置き・導入・補足・具体例は原則すべて捨てる。最も引きの強い一文から始め、結論で終える。迷ったら「削る」を選ぶ。` },
  { lo: 45, hi: 90, countLo: 2, countHi: 4,
    prose: `主張1つ＋それを裏づける具体例1つが入る長さ。主題は1つに保ったうえで、` +
      `主張だけでは弱いので裏づけを1つ足す。関連の薄い話題は入れない。` +
      `45秒以下の構成に「具体例を1つ足す」のではなく、具体例が入る前提で主張の選び方から見直すこと。` },
  { lo: 90, hi: 180, countLo: 4, countHi: 7,
    prose: `展開を作れる長さ。掴み→具体例2つ以上→山場→締め、の起伏を組む。` +
      `主題は1つに保ちつつ、途中で角度を変えて飽きさせない。` +
      `短い尺の構成を引き伸ばすのではなく、起伏のある構成として組み直すこと。` },
];
const LONG_BAND_PROSE = `複数の話題を束ねて1本にできる長さ。主題を2〜3の小テーマへ分け、` +
  `テーマの切り替わりが分かる順序に並べる。各テーマに山場を1つ置き、最後に全体を締める。`;

/** 区間が何本入るかで「何を入れられて何を入れられないか」が決まる。本数ごとの役割の割り当て。
 *  尺そのものではなく本数で分けるのは、本数が「1本ぶんの枠を何に使うか」の単位だから。 */
function rolesForCount(n) {
  if (n <= 1) {
    return `1本で言い切る。前置きも具体例も入る枠が無いので、単体で意味が閉じている最も強い一言だけを選ぶ。`;
  }
  if (n === 2) {
    return `主張1本＋落とし所1本。具体例の枠が無いので、前提の説明が要る主張は最初から選ばない。`;
  }
  if (n === 3) {
    return `掴みを兼ねた主張1本＋裏づけ1本＋締め1本。背景を説明する枠が無いので、` +
      `説明抜きでそのまま通じる主張だけを選ぶ。裏づけは一言で効くものを1本だけ。`;
  }
  if (n === 4) {
    return `掴み1本＋主張1本＋具体例1本＋締め1本。具体例に丸ごと1本使える前提なので、` +
      `3本では説明しきれず捨てるしかなかった「説明の要る主張」をここで初めて選んでよい。` +
      `3本の構成に具体例を1本足すのではなく、その主張が選べる前提で主張から選び直す。`;
  }
  if (n <= 7) {
    return `掴み1本→具体例2本以上→山場1本→締め1本。途中に角度を変える区間を1本入れて飽きさせない。` +
      `1本の主張を長く語るのではなく、別の場面・別の言い方の区間を並べて起伏を作る。`;
  }
  return `小テーマ2〜3に分け、テーマごとに山場を1本置く。最後に全体を締める1本を置く。` +
    `テーマの切り替わりが区間の並びで分かるようにする。`;
}

/**
 * 目標尺から「この尺ならどう組むか」の骨格（区間数・1区間あたりの長さ・役割の割り当て）を出す。
 *
 * なぜ帯だけでは足りないか（マスター指摘 2026-08-17 / 虎の巻 §5-3）:
 * 虎の巻の表は4段の帯だが、§5-3 が名指しで「同じ素材から60秒と90秒を作って内容がほぼ同じに
 * なったら考えていない証拠」と言っている当の60秒と90秒は、どちらも「〜90秒」の同じ帯に入る。
 * 帯を段関数としてそのまま当てると、60秒と90秒の方針文が1文字も変わらない（実測で確認）。
 * 帯の文言は虎の巻が正なので保ったまま、帯の中の位置から本数を決め、本数から役割を割り当てる。
 */
export function durationPlan(targetSeconds) {
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) return null;
  const band = DURATION_BANDS.find((b) => targetSeconds <= b.hi);
  const count = band
    ? Math.max(1, Math.round(
        band.countLo + ((targetSeconds - band.lo) / (band.hi - band.lo)) * (band.countHi - band.countLo)))
    : Math.max(7, Math.round(7 + (targetSeconds - 180) / 60));
  return {
    count,
    avgSec: Math.max(1, Math.round(targetSeconds / count)),
    prose: band ? band.prose : LONG_BAND_PROSE,
    roles: rolesForCount(count),
  };
}

/**
 * 目標尺の帯ごとに「何を残し何を捨てるか」の方針そのものを変える。
 *
 * なぜ必要か（マスター指摘 2026-08-17「ダイジェストで1分とダイジェストで1分半なら
 * 当然大きく変わるはずなのにほぼ変わらない。考えていない証拠だ。」）:
 * 旧実装が尺について伝えていたのは「合計◯◯文字」という数値1つだけだった。
 * 数値だけを差し替えても、AIにとって「1分なら何を捨てるか」「1分半なら何を足せるか」は
 * 決まらないため、同じ素材からはほぼ同じ台本が出る。尺は文字数の上限ではなく
 * 「どういう構成にするか」の指示である、という形へ直す。
 */
export function durationStrategy(targetSeconds) {
  const plan = durationPlan(targetSeconds);
  if (!plan) return null;
  return `【この尺の方針】${plan.prose}\n` +
    `【この尺の骨格】区間は約${plan.count}本、1区間あたり平均${plan.avgSec}秒。${plan.roles}\n` +
    `【尺が変われば構成が変わる】この骨格は目標尺ごとに違う。別の尺で作った台本の端を伸縮させて` +
    `秒数だけ合わせるのは禁止。尺が変わったら、選ぶ区間の「集合」そのものを選び直すこと（虎の巻 §5-3）。`;
}

/**
 * 2つの台本が「同じ区間の端を動かしただけ」の関係かを見る（虎の巻 §5-3 / §8-M）。
 *
 * §5-3 は「尺を変えたら、選ぶ区間の『集合』が変わらなければならない。端を伸縮させるだけの
 * 調整は禁止」と決めている。旧実装は尺是正の採否を「目標秒数へ近づいたか」だけで見ており、
 * 端を1秒ずつ削っただけの修正でも近づけば採用されていた＝§5-3 の検査がどこにも無かった。
 *
 * 判定は正規化（記号・空白を落とす）した keepText の包含関係で行う。ある区間が旧区間の
 * 部分文字列（端を削った）か、旧区間を含む文字列（端を伸ばした）なら「同じ区間の端を動かしただけ」。
 * 本数が変わっている／どの旧区間の伸縮でも説明できない区間が1つでもあれば、集合は変わっている。
 *
 * @returns {boolean} true＝端の伸縮だけ（＝構成が変わっていない）
 */
export function isEdgeOnlyChange(before, after) {
  const A = (before || []).map((s) => normalize(s?.keepText)).filter(Boolean);
  const B = (after || []).map((s) => normalize(s?.keepText)).filter(Boolean);
  if (A.length === 0 || B.length === 0) return false; // 比べられない＝止めない
  if (A.length !== B.length) return false;            // 本数が変わっていれば集合が変わっている
  const used = new Array(A.length).fill(false);
  for (const b of B) {
    const i = A.findIndex((a, k) => !used[k] && (a.includes(b) || b.includes(a)));
    if (i === -1) return false; // どの旧区間の端の伸縮でも説明できない＝新しく選ばれている
    used[i] = true;
  }
  return true;
}

/** 尺の条件をプロンプトへ書き下す共通部品（draft / critic / revise / 尺是正で同じ言い方を使う）。 */
function durationBlock(dur) {
  if (!dur || !Number.isFinite(dur.targetSeconds) || dur.targetSeconds <= 0) return "";
  const lo = Math.round(dur.targetSeconds * (1 - DURATION_TOL));
  const hi = Math.round(dur.targetSeconds * (1 + DURATION_TOL));
  const actual = Number.isFinite(dur.actualSeconds)
    ? `現在の台本を本文へ逆照合した実測は ${Math.round(dur.actualSeconds)}秒。`
    : "";
  return `# 尺の条件\n目標 ${Math.round(dur.targetSeconds)}秒（約${dur.targetMinutes}分）。` +
    `許容範囲は ${lo}〜${hi}秒（目標の±${Math.round(DURATION_TOL * 100)}%）。${actual}\n` +
    `${durationStrategy(dur.targetSeconds)}\n`;
}

/**
 * 「台本の内容を理解する」段階のプロンプト。
 *
 * マスター指示の流れ（AGENTS.md「マスター指示：編集フロー（逐語・要約禁止）」節が正）に
 * 「台本の内容を理解する。」という独立した段階がある。旧実装はこの段階を持たず、
 * draftPrompt の中で「全体を理解し…台本を作ってください」と一息に指示していたため、
 * 理解の結果がどこにも残らず、後段（選定・尺の是正）が何も参照できなかった。
 *
 * ここでは理解そのものを成果物として出させる。台本を作る前に一度だけ走らせ、
 * 結果を understanding.json として残し、draft へ渡す。
 */
export function understandPrompt(transcriptText) {
  return `あなたは一流の動画編集者です。次の長編の文字起こし全文を読み、**まだ台本は作らずに**、` +
    `内容の理解だけを出力してください。ここで作るのは、この後どの部分を使うかを決めるための下地です。\n\n` +
    `次を押さえること:\n` +
    `- 主題: この動画は結局なんの話か（1文）\n` +
    `- 小テーマ: 主題を構成する話題の塊。出てくる順に、それぞれ「何の話か」と「面白さの強さ(1-5)」\n` +
    `- 山場: 最も引きが強い箇所と、その理由\n` +
    `- 捨ててよい所: 挨拶・定型・機材確認・本編でない雑談・同じことの繰り返し\n` +
    `- 話者の癖: 結論が先か後か、言い切るか濁すか（どこで切ると意味が壊れるかの判断に使う）\n\n` +
    `# 文字起こし本文\n${wrapUntrustedText("transcript", transcriptText)}\n\n` +
    `# 出力（JSONのみ・前後に説明文を書かない）\n` +
    `{"subject":"主題1文",` +
    `"themes":[{"name":"小テーマ名","what":"何の話か","strength":1-5}],` +
    `"peak":{"what":"山場","why":"なぜ引きが強いか"},` +
    `"discard":["捨ててよい所"],` +
    `"speakerStyle":"話者の癖"}`;
}

/** 理解の結果を、後段のプロンプトへ差し込める形の文字列にする。
 *  purpose="draft"  … 台本づくり（この理解に沿って選ばせる）
 *  purpose="critic" … 批評（この理解に照らして、選ばれた区間が主題から外れていないかを見させる）
 *  理解が無い／形が違うときは空文字を返すので、呼び出し側は従来どおりの文面になる。 */
function understandingBlock(u, purpose = "draft") {
  if (!u || typeof u !== "object") return "";
  const themes = Array.isArray(u.themes)
    ? u.themes.map((t) => `- ${t?.name ?? ""}（面白さ${t?.strength ?? "?"}/5）: ${t?.what ?? ""}`).join("\n")
    : "";
  const discard = Array.isArray(u.discard) ? u.discard.join(" / ") : "";
  // 理解の本文は、非信頼な文字起こしを読んだ LLM の出力＝文字起こしの内容が混ざりうる。
  // つまり本文に仕込まれた指示が「理解」を経由して洗浄され、素のまま後段プロンプトへ入りうる。
  // よって理解も文字起こし本文と同じ作法で非信頼データとして包む（指示文は包みの外に置く）。
  const facts =
    (u.subject ? `主題: ${u.subject}\n` : "") +
    (themes ? `小テーマ:\n${themes}\n` : "") +
    (u.peak?.what ? `山場: ${u.peak.what}（${u.peak.why ?? ""}）\n` : "") +
    (discard ? `捨ててよい所: ${discard}\n` : "") +
    (u.speakerStyle ? `話者の癖: ${u.speakerStyle}\n` : "");
  if (!facts) return "";
  return `# この動画の理解（先に全文を読んで整理したもの）\n` +
    `${wrapUntrustedText("understanding", facts.trimEnd())}\n` +
    (purpose === "critic"
      ? `\nこの理解は、台本を作る前に文字起こし全文を読んで整理したものです。採点にあたっては、` +
        `選ばれた区間がこの主題から外れていないか / 山場を拾えているか / 「捨ててよい所」が混じっていないかを` +
        `必ず照合し、外れているものがあれば issues に「理解との食い違い」として具体的に挙げること` +
        `（食い違いは主に「流れ」「密度」「山場」の減点根拠として扱う）。\n`
      : `\nこの理解に沿って選ぶこと。理解と食い違う選び方をするなら、その理由を reason に書くこと。\n`);
}

export function draftPrompt(transcriptText, targetInfo, understanding = null) {
  return `あなたは一流の動画編集者です。次の長編の文字起こし全体を理解し、視聴者が最後まで飽きない` +
    `「ダイジェスト（面白い所だけ）」の台本を作ってください。冒頭の挨拶・締めの定型・冗長な繰り返し・` +
    `本編でない雑談は捨てる。掴み→展開→山場→締めの流れになるよう、必要なら時系列を入れ替える。\n\n` +
    (targetInfo ? `${targetInfo}\n\n` : "") +
    understandingBlock(understanding) +
    `${VERBATIM}\n\n# 文字起こし本文\n${wrapUntrustedText("transcript", transcriptText)}\n\n` +
    `# 出力（JSONのみ・前後に説明文を書かない）\n` +
    `{"script":[{"keepText":"本文の逐語連続抜き出し","hook":"20字以内の見出し","reason":"採用理由一言"}]}`;
}

function scriptToText(script) {
  return script.map((s, i) => `#${i + 1} [${s.hook || ""}] ${s.keepText}`).join("\n\n");
}

// 【criticPrompt は廃止】採点と直しを別々の呼び出しにしていた頃の批評プロンプト。
// 合格しない素材では「批評→修正」を最大3周＝最大5回 AI を直列で呼んでおり、遅さの一因
// だった（マスター指摘 2026-08-17）。いまは reviewPrompt が1回でまとめて行う。

/**
 * 採点と直しを1回の呼び出しでまとめて頼む（批評→修正の2往復を1往復にする）。
 *
 * 【なぜ（マスター指摘 2026-08-17「相変わらず遅い」「1回でまとめてやれよ」）】
 * 旧実装は「批評で1回・修正で1回」を最大3周するので、合格しない素材では最大5回 AI を
 * 直列で呼んでいた。1回に数十秒かかるため、ここだけで数分を使う。
 * 採点と直しは同じ台本を見て行う作業なので、分ける必然が無い。1回で
 * 「点数と、合格でないなら直した台本」を返させれば往復が半分になる。
 * 分けないほうが直しの質も落ちにくい（採点した本人がその場で直すので、
 * 減点の理由と直しの内容がずれない）。
 *
 * 合格なら script を返させない（返答が無駄に大きくならないように）。
 */
function reviewPrompt(transcriptText, script, dur = null, understanding = null) {
  const durBlock = durationBlock(dur);
  const undBlock = understandingBlock(understanding, "critic");
  return `あなたは辛口の編集レビュアー兼編集者です。次のダイジェスト台本（この順序で連結して1本の動画にする）を` +
    `観点別に配点で評価し、**合格でなければ、その場で直した台本も返してください**。\n` +
    `各観点20点満点・合計100点で採点します。\n` +
    `観点の定義: 掴み(最初3秒で視聴者を引き込むか)/流れ(展開が自然で飽きないか)/` +
    `密度(冗長・繰り返し・雑談が無く濃いか)/山場(明確な盛り上がりがあるか)/締め(余韻ある終わり方か)。\n` +
    `各観点は「なぜその点か」を減点根拠つきで判断すること。\n\n` +
    (durBlock
      ? `${durBlock}尺は点数とは別の「満たすか満たさないか」の条件です。実測が許容範囲に入っているかを` +
        `fitsDuration で答えること。外れているなら、直した台本で許容範囲へ入れること` +
        `（尺は点数と引き換えにできません）。また、上の【この尺の方針】に照らして構成そのものが` +
        `合っているか（短い尺なのに話題を詰め込んでいないか、長い尺なのに起伏が無いか）も見ること。\n\n`
      : "") +
    (undBlock ? `${undBlock}\n` : "") +
    `${VERBATIM}\n\n` +
    `# 台本（連結順）\n${scriptToText(script)}\n\n` +
    `# 参照可能な全文字起こし（直すときはここから抜き出す）\n${wrapUntrustedText("transcript", transcriptText)}\n\n` +
    `# 出力（JSONのみ）\n` +
    `{"scores":{"掴み":0-20,"流れ":0-20,"密度":0-20,"山場":0-20,"締め":0-20},` +
    `"score":合計(0-100の整数),"pass":true/false,"weakest":"最も低い観点名",` +
    (durBlock ? `"fitsDuration":true/false,` : "") +
    `"issues":["問題点"],` +
    `"script":[{"keepText":"...","hook":"...","reason":"..."}]}\n` +
    `pass は ${PASS_SCORE}点以上かつ致命的問題が無い` +
    (durBlock ? `、かつ fitsDuration が true の` : "") +
    `場合のみ true。\n` +
    `**pass が true のときは script を空配列にしてよい**（直す必要が無いため）。` +
    `pass が false のときは、最も低い観点を最優先で引き上げた台本を script に入れること。` +
    `既に高い観点は壊さないこと。`;
}

/** 批評の観点別スコアを、そのまま meta へ残せる素直な形（観点名→数値）に整える。
 *  合計 score だけを残すと「掴みが弱かったのか締めが弱かったのか」が後段に一切伝わらない。
 *  モデルは観点名や型を崩して返すことがあるので、数値として読める観点だけを拾う
 *  （拾えるものが1つも無ければ null＝「観点別スコアは取れなかった」を明示する）。 */
function normalizeScores(scores) {
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) return null;
  const out = {};
  for (const [k, v] of Object.entries(scores)) {
    const n = Number(v);
    if (k && Number.isFinite(n)) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

export function revisePrompt(transcriptText, script, critique, dur = null) {
  const cur = Number(critique.score) || 0;
  const perScores = critique.scores ? JSON.stringify(critique.scores, null, 0) : "(観点別スコアなし)";
  const weakest = critique.weakest || "";
  const durBlock = durationBlock(dur);
  const durFix = (critique.durationFix || "").trim();
  return `次のダイジェスト台本を、レビュー指摘に従って改善してください（順序入替・差し替え・削除・追加可）。\n` +
    `現在の総合点は ${cur}点、目標は ${PASS_SCORE}点以上です。観点別スコア: ${perScores}。\n` +
    (weakest ? `特に最も低い観点「${weakest}」を最優先で引き上げてください。\n` : "") +
    `点数を上げるのが目的です。満点でない観点を狙って直し、既に高い観点は壊さないこと。\n\n` +
    (durBlock
      ? `${durBlock}${critique.fitsDuration === false
          ? `尺が許容範囲を外れています。点数の改善と同時に尺も許容範囲へ入れること` +
            `（尺は満たすか満たさないかの条件で、点数と引き換えにできません）。` +
            (durFix ? `\nレビュアーの尺に関する指示: ${durFix}` : "") + `\n`
          : `尺は許容範囲に入っています。直した結果この範囲から外れないようにすること。\n`}\n`
      : "") +
    `${VERBATIM}\n\n# レビュー指摘（観点別の改善指示）\n${JSON.stringify(critique.fixes || critique.issues || [], null, 0)}\n\n` +
    `# 現在の台本\n${scriptToText(script)}\n\n# 参照可能な全文字起こし\n${wrapUntrustedText("transcript", transcriptText)}\n\n` +
    `# 出力（JSONのみ）\n{"script":[{"keepText":"...","hook":"...","reason":"..."}]}`;
}

/** 尺是正プロンプト（実測秒数が目標から外れた時の縮小/拡張指示）。
 *  旧実装は「今の台本を削れ/伸ばせ」としか言わず、元の台本を保ったまま端を調整するだけだった。
 *  尺の帯が変われば構成そのものが変わるべきなので、方針（durationStrategy）を必ず添える。
 *
 *  さらに「端の伸縮だけの是正は機械的に破棄する」ことを先に宣言する（虎の巻 §5-3 / §8-M）。
 *  条件を後から人が採点するのではなく、依頼文の時点で受入条件として渡す＝呼び出し側の
 *  isEdgeOnlyChange() と同じことを言っておかないと、破棄されるだけで理由が伝わらない。
 *
 *  @param {object} [opts] 4番目は任意。既存の3引数呼び出し（tests/smoke.mjs）を壊さない。
 *  @param {boolean} [opts.rejectedEdgeOnly] 直前の是正が「端の伸縮だけ」で破棄されたか。 */
export function durationFixPrompt(
  transcriptText,
  segments,
  { targetSeconds, targetMinutes, actualSeconds },
  opts = {},
) {
  const over = actualSeconds > targetSeconds;
  const dir = over ? "短く削れ" : "本編から追加して伸ばせ";
  const lo = Math.round(targetSeconds * (1 - DURATION_TOL));
  const hi = Math.round(targetSeconds * (1 + DURATION_TOL));
  const plan = durationPlan(targetSeconds);
  const now = segments.length;
  const diff = plan ? plan.count - now : 0;
  // 本数の差を「何本入れ替える/落とす/選び直す」という具体の作業量に翻訳する。
  // 骨格の本数と今の本数が同じでも、集合が変わっていなければ受け付けない旨を明記する。
  const countInstruction = plan
    ? (diff > 0
        ? `いまは${now}本だが、この尺の骨格は約${plan.count}本。少なくとも${diff}本は、本文の別の場所から新しく選ぶこと。`
        : diff < 0
          ? `いまは${now}本だが、この尺の骨格は約${plan.count}本。少なくとも${-diff}本は区間ごと丸ごと落とすこと。`
          : `本数は約${plan.count}本のままでよいが、本数が同じでも中身の集合は変える。少なくとも1本は、` +
            `いまの区間を丸ごと捨てて本文の別の場所から選び直すこと。`)
    : "";
  return `次のダイジェスト台本は実測${Math.round(actualSeconds)}秒、目標は${targetSeconds}秒` +
    `（約${targetMinutes}分）です。${lo}〜${hi}秒に収まるよう台本を${dir}（順序入替・差し替え・削除・追加可）。\n` +
    `これは「今の台本の端を伸縮させて秒数を合わせる」作業ではありません。` +
    `この尺の骨格に合わせて、どの区間を使うかという集合そのものを組み直す作業です。\n` +
    `${durationStrategy(targetSeconds)}\n` +
    `${over
      ? `削るときは「端を少しずつ詰める」のではなく、上の骨格に照らして"この尺に要らない区間"を丸ごと落とすこと。`
      : `伸ばすときは「今ある区間を長くする」のではなく、上の骨格に照らして"この尺だから入れられる区間"を本文から新たに選ぶこと。`}\n` +
    (countInstruction ? `${countInstruction}\n` : "") +
    `【受入条件】新しい台本は、下の「現在の台本」と区間の集合が変わっていること。` +
    `同じ区間の端を伸ばした／縮めただけのものは、機械が自動で検出して破棄します` +
    `（区間ごとの入れ替え・削除・新規選定のいずれかが必ず要る）。\n` +
    (opts.rejectedEdgeOnly
      ? `【前回の是正は破棄しました】前回返ってきた台本は、現在の台本と同じ区間の端を動かしただけで、` +
        `区間の集合が変わっていませんでした。今度は必ず、区間を丸ごと落とす／本文の別の場所から丸ごと選ぶ形で組み直してください。\n`
      : "") + `\n` +
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
  // あわせて durationStrategy() で「この尺なら何を残し何を捨てるか」の方針も渡す。数値だけを
  // 差し替えても構成が変わらないため（マスター指摘 2026-08-17）。
  const targetSeconds = Number.isFinite(targetMinutes) && targetMinutes > 0 ? targetMinutes * 60 : null;
  let targetInfo = null;
  if (targetSeconds) {
    const charsPerSec = transcriptText.length / Math.max(1, tr.duration || transcriptText.length / 5);
    const charBudget = Math.round(targetSeconds * charsPerSec);
    targetInfo = `【尺の目安】合計の keepText 文字数が約${charBudget}文字（この話者の話速換算で約${targetMinutes}分相当）に収まるよう選定せよ。` +
      `本当に面白い部分だけに絞り込み、目安を大きく超えないこと。\n` +
      `${durationStrategy(targetSeconds)}`;
  }

  // 実測（本文への逆照合）で秒数を出す。批評ループの中でも使うのでここで定義する。
  // 旧実装はループを抜けたあとにしか測っておらず、批評・修正は尺を一度も見ないまま回っていた。
  const measure = (segs) => {
    const usable = segs
      .filter((s) => s && typeof s.keepText === "string" && s.keepText.trim().length >= 4)
      .map((s) => ({ keepText: s.keepText.trim(), hook: (s.hook || "").trim() }));
    if (usable.length === 0) return 0;
    try {
      const resolved = resolveSegments(usable, tr, { preserveOrder: true });
      return resolved.reduce((a, s) => a + (s.end - s.start), 0);
    } catch { return 0; }
  };
  const durOf = (segs) => (targetSeconds
    ? { targetSeconds, targetMinutes, actualSeconds: measure(segs) }
    : null);

  const cwd = createIsolatedCwd(path.basename(workDir));

  // 「台本の内容を理解する」段階。台本を作る前に一度だけ走らせ、結果を成果物として残す。
  // ここが失敗しても台本づくりは続行する（理解は選定の質を上げるための下地であって、必須の入力ではない）。
  onLog(`[digest] 内容を理解中（model=${MODEL}）`);
  let understanding = null;
  try {
    understanding = parseJson(await callClaude(understandPrompt(transcriptText), onLog, true, cwd));
    // 配列や素の値が返ってきた場合は「理解できなかった」として扱う（後段へ形の違うものを流さない）。
    if (!understanding || typeof understanding !== "object" || Array.isArray(understanding)) {
      throw new Error("理解の応答が期待した形（オブジェクト）ではありません");
    }
    fs.writeFileSync(path.join(workDir, "understanding.json"),
      JSON.stringify(understanding, null, 2), "utf-8");
    const themeCount = Array.isArray(understanding?.themes) ? understanding.themes.length : 0;
    onLog(`[digest] 理解: 主題「${(understanding?.subject ?? "").slice(0, 40)}」/ 小テーマ${themeCount}件`);
  } catch (e) {
    onLog(`[digest] 内容理解に失敗（理解なしで台本づくりへ進む）: ${e.message}`);
    understanding = null;
  }

  onLog(`[digest] 台本ドラフト作成中（model=${MODEL}）`);
  // draft は必須。長い逐語 keepText で LLM の JSON が崩れることがあるため明示メッセージで失敗させる。
  let draftResp;
  try { draftResp = parseJson(await callClaude(draftPrompt(transcriptText, targetInfo, understanding), onLog, true, cwd)); }
  catch (e) { throw new Error(`ドラフト応答の JSON 解析に失敗: ${e.message}`); }
  let script = (draftResp.script) || [];
  if (script.length === 0) throw new Error("ドラフト台本が空です");

  let best = { script, score: -1, iter: 0 };
  let iterations = 1;
  for (let i = 1; i <= MAX_ITER; i++) {
    // critic/revise の応答 JSON は逐語テキスト混入で崩れうる。崩れても best を返して完走させる
    // （旧実装は parseJson が throw して digest 全体が例外死し、せっかくの best を捨てていた）。
    let critique;
    // 批評へ「目標尺と現在の実測秒数」を渡す。これが無いと、反復するほど尺と無関係な
    // 「採点関数の最高点」へ収束し、1分指定と1分半指定が同じ台本になる。
    const durNow = durOf(script);
    // 批評にも理解を渡す（理解に照らして主題から外れていないかを見させる）。理解が取れなかった
    // ときは null のまま渡り、従来どおり台本テキストだけを見る批評になる。
    // 採点と直しは1回の呼び出しでまとめて頼む（reviewPrompt）。旧実装は批評と修正で
    // 2回に分けており、合格しない素材では最大5回 AI を直列で呼んでいた（＝遅さの一因）。
    try { critique = parseJson(await callClaude(reviewPrompt(transcriptText, script, durNow, understanding), onLog, true, cwd)); }
    catch (e) { onLog(`[digest] 検証 ${i}回目の応答処理に失敗（JSON崩れ/timeout/spawn等）→best(score=${best.score})で確定: ${e.message}`); break; }
    const score = Number(critique.score) || 0;
    // 尺は点数と引き換えにできない条件として扱う。実測が許容範囲外なら、点数が高くても合格にしない。
    const fits = !durNow || (Math.abs(durNow.actualSeconds - targetSeconds) <= targetSeconds * DURATION_TOL);
    if (durNow) critique.fitsDuration = fits;
    onLog(`[digest] 検証 ${i}回目: score=${score} pass=${!!critique.pass}` +
      (durNow ? ` 実測${durNow.actualSeconds.toFixed(0)}s/目標${targetSeconds}s 尺${fits ? "OK" : "NG"}` : "") +
      ` (${(critique.issues || []).length}件指摘)`);
    // best は「尺を満たしているもの」を優先する。尺を外した高得点で確定すると、
    // 指定尺を変えても同じ台本が選ばれ続ける。
    const better = fits === (best.fits ?? false) ? score > best.score : (fits && !best.fits);
    // 採用する台本と一緒に、その台本を採点したときの観点別スコア・最弱観点も持ち回る
    // （meta へ残して、承認画面が「何が弱いまま確定したのか」を出せるようにするため）。
    if (best.score < 0 || better) {
      best = { script, score, iter: i, fits,
        scores: normalizeScores(critique.scores),
        weakest: typeof critique.weakest === "string" ? critique.weakest.trim() : "" };
    }
    if (fits && (critique.pass || score >= PASS_SCORE)) { iterations = i; break; }
    if (i === MAX_ITER) { iterations = i; break; }
    // 直した台本は、いま受け取った同じ応答の中に入っている（追加の呼び出しはしない）。
    const revised = critique.script;
    if (Array.isArray(revised) && revised.length) {
      onLog(`[digest] 修正 ${i}回目（同じ応答に入っていた直しを採用: ${revised.length}区間）`);
      script = revised;
      iterations = i + 1;
    } else {
      // 合格していないのに直しが返っていない＝これ以上良くならないので、best で確定する。
      onLog(`[digest] 修正 ${i}回目: 直した台本が返らなかった→best(score=${best.score})で確定`);
      break;
    }
  }

  const chosen = best.score >= 0 ? best.script : script;
  // reason（なぜこの区間を採ったか）は捨てない。ユーザーへ台本を提示して承認を取る画面で、
  // 「なぜこれが選ばれたか」が見えないと判断できないため（旧実装はここで落としていた）。
  // 採否は「4文字以上か」ではなく「切り出した一片として使えるか」で見る（虎の巻 §8-C）。
  let segments = pickUsableSegments(chosen, onLog, "台本の確定")
    .map((s) => ({ keepText: s.keepText.trim(), hook: (s.hook || "").trim(), reason: (s.reason || "").trim() }));
  if (segments.length === 0) throw new Error("採用可能な台本区間が0件です");

  // 尺目標がある場合、実測秒数（reverse-match）が目標から大きく外れていたら1回だけ縮小/拡張指示を出す。
  // 文字数目安だけでは実発話速度のブレを吸収できないため、実測フィードバックで是正する。
  let actualSeconds = null;
  // 「端の伸縮だけ」として破棄した是正の回数。黙って捨てると、尺が合わないまま確定した理由が
  // ログにも meta にも残らず、承認画面から見て「なぜこの秒数なのか」が説明できなくなる。
  let edgeOnlyRejected = 0;
  if (targetSeconds) {
    actualSeconds = measure(segments);
    const inRange = (sec) => Math.abs(sec - targetSeconds) <= targetSeconds * DURATION_TOL;
    onLog(`[digest] 尺チェック: 実測${actualSeconds.toFixed(0)}s / 目標${targetSeconds}s`);
    // 旧実装は if 1回きりで、是正後もまだ外れていればそのまま確定していた。範囲へ入るまで繰り返す。
    for (let f = 1; f <= DURATION_MAX_FIX && !inRange(actualSeconds); f++) {
      const fixPrompt = durationFixPrompt(transcriptText, segments,
        { targetSeconds, targetMinutes, actualSeconds },
        { rejectedEdgeOnly: edgeOnlyRejected > 0 });
      try {
        const fixResp = parseJson(await callClaude(fixPrompt, onLog, true, cwd));
        const fixed = pickUsableSegments(fixResp.script || [], onLog, "尺是正")
          .map((s) => ({ keepText: s.keepText.trim(), hook: (s.hook || "").trim(), reason: (s.reason || "").trim() }));
        if (fixed.length === 0) break;
        // 秒数より先に構成を見る。虎の巻 §5-3「尺を変えたら、選ぶ区間の『集合』が変わらなければ
        // ならない。端を伸縮させるだけの調整は禁止」＝秒数と引き換えにできない条件なので、
        // 目標へ近づいていても端の伸縮だけの是正は採らない（採ると A10 そのものになる）。
        // 破棄したことは次の依頼文へ伝える（黙って捨てると同じものが返ってくる）。
        if (isEdgeOnlyChange(segments, fixed)) {
          edgeOnlyRejected++;
          onLog(`[digest] 尺是正 ${f}回目は区間の集合が変わらず端の伸縮だけ（虎の巻 §5-3）→採用しない`);
          continue;
        }
        const fixedSeconds = measure(fixed);
        onLog(`[digest] 尺是正 ${f}回目: 実測${fixedSeconds.toFixed(0)}s`);
        // 目標から遠ざかる是正は採らない（是正のたびに悪化して確定するのを防ぐ）。
        if (Math.abs(fixedSeconds - targetSeconds) >= Math.abs(actualSeconds - targetSeconds)) {
          onLog(`[digest] 尺是正 ${f}回目は目標へ近づかなかったため採用しない`);
          break;
        }
        segments = fixed;
        actualSeconds = fixedSeconds;
      } catch (e) {
        onLog(`[digest] 尺是正の応答処理に失敗（元の台本のまま確定）: ${e.message}`);
        break;
      }
    }
    if (!inRange(actualSeconds)) {
      onLog(`[digest] 尺は許容範囲(${Math.round(targetSeconds * (1 - DURATION_TOL))}〜${Math.round(targetSeconds * (1 + DURATION_TOL))}s)に入らないまま確定: 実測${actualSeconds.toFixed(0)}s`);
    }
  }

  // understanding（理解の結果）・scores（観点別スコア）・durationTolerance を meta に残す。
  // ユーザーへ台本を提示する画面が「何を主題だと判断してこの区間を選んだのか」「どの観点が弱いまま
  // 確定したのか」を出せるようにするため（合計点だけでは、何が弱かったかが分からない）。
  const meta = { iterations, score: best.score, count: segments.length,
    scores: best.scores ?? null, weakest: best.weakest || null,
    targetSeconds, actualSeconds,
    durationTolerance: targetSeconds ? DURATION_TOL : null,
    // 構成を変えずに端だけ伸縮させた是正を何回破棄したか（虎の巻 §5-3）。
    edgeOnlyFixesRejected: targetSeconds ? edgeOnlyRejected : null,
    fitsDuration: targetSeconds
      ? Math.abs(actualSeconds - targetSeconds) <= targetSeconds * DURATION_TOL
      : null,
    understanding };
  fs.writeFileSync(path.join(workDir, "llm-response.json"),
    JSON.stringify({ segments, meta }, null, 2), "utf-8");
  onLog(`[digest] 完成台本: ${segments.length}区間 / score=${best.score} / ${iterations}反復`);
  return { segments, meta };
}
