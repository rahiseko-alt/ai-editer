// video-shorts [4] LLM区間選定 — 「残すテキスト＋hook 文＋選んだ理由」を返させる。
// 秒数は出させない（落とし穴#1）。長尺は chunk 分割（落とし穴#5）。
//
// 【この経路の作り（2026-08-17 に作り直した）】
// 旧実装は「10分ごとに割る → 各 chunk を完全に独立して LLM へ投げる → 返ってきた配列を連結」
// だけで、AI は素材の全体を一度も読んでいなかった。マスター指示（AGENTS.md「マスター指示：
// 編集フロー」）の「台本の内容を理解する」に当たる段階が topic 経路にだけ存在せず、
// 全体理解ゼロ・全体最適ゼロのまま区間が決まっていた。
// ここは次の3段構えにする（実行の順序づけは server/claude-select.mjs が持つ）:
//   ① 理解  : 素材の全文を読んで「主題・小テーマ・山場・捨てる所・話者の癖」を作る
//             （長すぎて1回で読み切れないときだけ、ブロック要約→全体統合の2段読みに切り替える）
//   ② 選定  : ①の理解と「全体の中でのこの範囲の位置」を各 chunk のプロンプトへ渡して区切らせる
//   ③ 統合  : 全 chunk の候補を1つの一覧にして AI へ戻し、重複・取りこぼしを全体視点で整える
//             （keepText は触らせない＝逐語の連続抜き出しという前提を崩さないため、
//               AI が動かせるのは「どの候補を残すか」「見出しと理由の文言」だけ）
//
// キーレス既定: プロンプトを llm-request.md に書き出し、オーケストレーター(Claude Code)が
// llm-response.json を書く。API版は callAnthropic() を使う（ANTHROPIC_API_KEY 必要）。

import { DEFAULT_MODE, getMode, requirePromptMode } from "./select-modes.mjs";
import { wrapUntrustedText } from "./claude-safety.mjs";

const SYSTEM_RULES_BASE = `あなたは長編動画を区間に切り分ける編集者です。
出力は必ず JSON のみ。秒数・タイムスタンプは絶対に出力しないこと（後段が文字起こしに
照合して秒数を確定するため）。

各区間について:
- keepText: その区間に該当する文字起こし本文を一字一句そのまま連続で抜き出す
  （要約・改変・創作は禁止）。
- hook: その区間を一言で表す派手な見出し（20字以内）。
- reason: なぜここを1本として選んだのか（何の話題か／どこが良いか）を一言。
  これは編集者の判断としてユーザーの承認画面にそのまま出るので、必ず埋めること。`;

const OUTPUT_SCHEMA = `{
  "segments": [
    {
      "keepText": "そのトピックの文字起こし本文を最初から最後まで一字一句そのまま連続抜き出し",
      "hook": "トピックを表す派手な見出し(20字以内)",
      "reason": "この区間を選んだ理由・何の話題か一言"
    }
  ]
}`;

/**
 * 全文を1回で読み切ってよい文字数の上限。
 *
 * 【この閾値の理由】日本語は 1 文字がおよそ 1 トークン弱なので、6万字はおよそ5万トークン。
 * 理解プロンプトと出力枠を足しても 20万トークン級の文脈窓に収まり、途中を捨てずに1回で
 * 読み切れる。日本語の話速をおよそ毎秒6文字とすると、約2.8時間ぶんの素材までが直読みの範囲。
 * これを超える素材（この製品は12時間級も対象）は、1回に全文を渡すと窓に入らないか、
 * 入っても中盤の記憶が薄くなるので、ブロック要約→全体統合の2段読みへ切り替える。
 * 2段読みでも「素材の全ブロックが必ずどれかの読解を通る」ので、全体を読んでいることは変わらない。
 */
export const DIRECT_READ_CHARS = 60_000;

/**
 * 2段読みのときの1ブロックの文字数。直読み上限より小さく取る。
 * ブロック要約は「取りこぼしなく骨格を書き出す」作業で、1回に詰め込むほど中盤が薄くなるため、
 * 直読み上限の半分に置いて余裕を持たせる。
 */
export const READ_BLOCK_CHARS = 30_000;

/**
 * 1区間の尺の許容幅（±30%）。レンダリング側 src/snap-boundaries.mjs resolveTargetDuration が
 * 使っている許容幅と同じ値にそろえる。ここを広く取ると、選定が尺を無視して区切っても
 * 後段が機械的に切り詰めて帳尻を合わせてしまい、「尺の指定が効いていない」状態に戻る。
 */
export const TOPIC_DURATION_TOL = 0.3;

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

/**
 * 「読むため」のブロック分割（選定用の chunkSegments とは別物）。
 * 選定は秒で割るが、読解は文脈窓の都合なので文字数で割る。文の途中で切ると、そのブロックの
 * 冒頭と末尾の意味が壊れて要約が歪むので、目標文字数の手前で最も近い文末（。！？改行）へ寄せる。
 *
 * @param {string} text 文字起こし全文
 * @param {number} [blockChars] 1ブロックの目標文字数
 * @returns {Array<{index:number, text:string}>}
 */
export function splitForReading(text, blockChars = READ_BLOCK_CHARS) {
  const src = String(text ?? "");
  if (!src.trim()) return [];
  if (!(blockChars > 0)) return [{ index: 0, text: src }];
  if (src.length <= blockChars) return [{ index: 0, text: src }];

  const blocks = [];
  let pos = 0;
  while (pos < src.length) {
    let end = Math.min(pos + blockChars, src.length);
    if (end < src.length) {
      // 目標位置から手前へ、最大 blockChars の 20% ぶんだけ文末を探す。
      // 見つからない（句点の無い文字起こし等）ときは目標位置でそのまま切る＝必ず前へ進む。
      const searchFloor = Math.max(pos + 1, end - Math.floor(blockChars * 0.2));
      for (let i = end; i > searchFloor; i--) {
        if (/[。！？!?\n]/.test(src[i - 1])) {
          end = i;
          break;
        }
      }
    }
    const body = src.slice(pos, end);
    if (body.trim()) blocks.push({ index: blocks.length, text: body });
    pos = end;
  }
  return blocks;
}

// ───────────────────────── ① 理解（全体を読む） ─────────────────────────

const UNDERSTAND_SCHEMA = `{"subject":"主題1文",` +
  `"themes":[{"name":"小テーマ名","what":"何の話か","strength":1-5,"cue":"この話題が始まる合図になる本文中の短い言い回し"}],` +
  `"peak":{"what":"山場","why":"なぜ引きが強いか"},` +
  `"discard":["捨ててよい所"],` +
  `"speakerStyle":"話者の癖"}`;

/**
 * 「素材の内容を理解する」段階のプロンプト（全文を1回で読み切れる長さのとき）。
 * ここでは区間を1つも決めさせない。理解を成果物として先に確定させ、そのあとの選定・統合が
 * それを参照する形にする（旧実装は理解の段階が無く、chunk ごとの思いつきで区切っていた）。
 */
export function buildUnderstandPrompt(transcriptText) {
  return `あなたは一流の動画編集者です。次の長編の文字起こし**全文**を読み、**まだ区間は1つも決めずに**、
内容の理解だけを出力してください。ここで作るのは、このあとどこで区切るかを決めるための下地です。

次を押さえること:
- 主題: この動画は結局なんの話か（1文）
- 小テーマ: 主題を構成する話題の塊。出てくる順に、それぞれ「何の話か」「面白さの強さ(1-5)」と、
  その話題が始まる合図になる本文中の短い言い回し（cue。ここが区切り位置の手掛かりになる）
- 山場: 最も引きが強い箇所と、その理由
- 捨ててよい所: 挨拶・定型・機材確認・本編でない雑談・同じことの繰り返し
- 話者の癖: 結論が先か後か、言い切るか濁すか（どこで切ると意味が壊れるかの判断に使う）

# 文字起こし本文
${wrapUntrustedText("transcript", transcriptText)}

# 出力（JSONのみ・前後に説明文を書かない）
${UNDERSTAND_SCHEMA}`;
}

/**
 * 2段読みの1段目: 1ブロックぶんの骨格を書き出させるプロンプト。
 * ここでの出力は「そのブロックに何があったか」の記録で、次の段（全体統合）の入力になる。
 * 取りこぼすとその範囲は全体理解から永久に落ちるので、面白くない話題も必ず1件は残させる。
 */
export function buildBlockOutlinePrompt(block, total) {
  const pos = `全${total}ブロック中 ${Number(block.index) + 1} 番目`;
  return `あなたは一流の動画編集者です。長い素材を分けて読んでいます（${pos}）。
このブロックの範囲について、**区間は1つも決めずに**、何があったかの骨格だけを書き出してください。
この記録は、このあと全ブロックぶんを突き合わせて「素材全体の理解」を作るために使います。
面白くない話題・つなぎの話題も、抜けると全体像が歪むので必ず記録してください（取りこぼし禁止）。

# このブロックの本文
${wrapUntrustedText("transcript-block", block.text)}

# 出力（JSONのみ・前後に説明文を書かない）
{"themes":[{"name":"小テーマ名","what":"何の話か","strength":1-5,"cue":"その話題が始まる合図になる本文中の短い言い回し"}],` +
    `"peak":{"what":"このブロックで最も引きが強い箇所","why":"理由"},` +
    `"discard":["このブロックで捨ててよい所"],"speakerStyle":"話者の癖"}`;
}

/**
 * 2段読みの2段目: 全ブロックの骨格を突き合わせて「素材全体の理解」を1つにまとめるプロンプト。
 * 入力は1段目の出力（＝素材の全範囲がここに要約として集まっている）なので、
 * この段の AI は「全体を見たうえで」主題と構成を決められる。
 */
export function buildGlobalUnderstandPrompt(outlines) {
  const body = outlines
    .map((o, i) => `## ブロック ${i + 1}\n${typeof o === "string" ? o : JSON.stringify(o)}`)
    .join("\n\n");
  return `あなたは一流の動画編集者です。長い素材を${outlines.length}個のブロックに分けて全部読み、
各ブロックの骨格を書き出しました。以下がその全ブロックぶんです（素材の最初から最後までが
ここに漏れなく含まれています）。これを突き合わせて、**素材全体としての理解**を1つにまとめてください。

まとめ方:
- 主題は、ブロックをまたいで繰り返し戻ってくる話が何かで決める（どこか1ブロックの話題ではない）
- 小テーマは、隣り合うブロックで同じ話が続いているなら1つに束ねる（ブロック境界で割らない）
- 山場は全ブロックを通して最も引きが強いものを1つ選ぶ
- 面白さの強さ(strength)は、全体の中での相対評価に付け直す

# 全ブロックの骨格
${wrapUntrustedText("block-outlines", body)}

# 出力（JSONのみ・前後に説明文を書かない）
${UNDERSTAND_SCHEMA}`;
}

/** 理解の結果を、選定・統合のプロンプトへ差し込める形の文字列にする。 */
export function buildUnderstandingBlock(u) {
  if (!u || typeof u !== "object") return "";
  const themes = Array.isArray(u.themes)
    ? u.themes
        .map((t) => {
          const cue = t?.cue ? `／始まりの合図「${t.cue}」` : "";
          return `- ${t?.name ?? ""}（面白さ${t?.strength ?? "?"}/5）: ${t?.what ?? ""}${cue}`;
        })
        .join("\n")
    : "";
  const discard = Array.isArray(u.discard) ? u.discard.join(" / ") : "";
  return (
    `# この素材の理解（先に全体を読んで整理したもの）\n` +
    (u.subject ? `主題: ${u.subject}\n` : "") +
    (themes ? `小テーマ（出てくる順）:\n${themes}\n` : "") +
    (u.peak?.what ? `山場: ${u.peak.what}（${u.peak.why ?? ""}）\n` : "") +
    (discard ? `捨ててよい所: ${discard}\n` : "") +
    (u.speakerStyle ? `話者の癖: ${u.speakerStyle}\n` : "") +
    `これは素材の全体を読んで作った理解です。目の前の範囲だけで判断せず、` +
    `この全体像の中でこの範囲がどの小テーマに当たるのかを見極めてから区切ってください。` +
    `全体像と食い違う切り方をするなら、その理由を reason に書いてください。\n\n`
  );
}

// ───────────────────────── 尺（1本あたりの目安） ─────────────────────────

/**
 * 目標尺の帯ごとに「何を残し何を捨てるか」「どこで区切るか」の方針そのものを変える。
 *
 * なぜ必要か（マスター指摘 2026-08-17「1分と1分半でほぼ変わらないのは考えていない証拠だ」）:
 * 尺を「合計◯◯秒」という数値1つとして渡しても、AI にとって「1分なら何を捨てるか」
 * 「3分なら何を足せるか」は決まらないので、同じ素材からはほぼ同じ切り方が出る。
 * 尺は長さの上限ではなく「どういう単位で切り、何を入れるか」の指示である、という形で渡す。
 *
 * digest 側（src/digest-editor.mjs の durationStrategy）と同じ思想だが、対象が違うので文言は別。
 * digest は「1本の動画全体の尺」、こちらは「切り出される1本ごとの尺」であり、帯が変わると
 * 変わるのは構成ではなく**区切りの単位**（言い切り単位 / 主張単位 / 話題単位 / テーマ単位）。
 * import で digest-editor に依存させない（あちらは台本再構成まで抱えた別経路のため）。
 *
 * @param {number} targetSeconds 1区間の目標秒数
 * @returns {string|null} プロンプトへ差し込む方針文（指定が無ければ null）
 */
export function topicDurationStrategy(targetSeconds) {
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) return null;
  if (targetSeconds <= 60) {
    return `【この尺の方針】1本＝「言い切り1つ」。話題まるごとではなく、その話題の中で最も強く言い切っている` +
      `一かたまりだけを取る。導入・前置き・言い直し・脱線・具体例の列挙は区間に入れない。` +
      `区切りは「結論の直前」から「結論を言い終えた直後」まで。1つの話題の中に強い言い切りが複数あるなら、` +
      `それぞれを別の区間として取ってよい（＝話題の数より区間の数が多くなることがある）。迷ったら捨てる。`;
  }
  if (targetSeconds <= 180) {
    return `【この尺の方針】1本＝「主張1つ＋それを裏づける具体例1つ」。区切りは話題単位ではなく主張単位で決める。` +
      `同じ話題でも主張が変われば別の区間にする。導入は1文まで、繰り返し・脱線は入れない。` +
      `言い切りだけでは弱いので、その主張を裏づけている箇所まで含めて1本にする。`;
  }
  if (targetSeconds <= 600) {
    return `【この尺の方針】1本＝「話題まるごと」。導入→展開→結論が1本に収まる長さなので、` +
      `話題の入口から結論までを丸ごと1区間にする。その話題に関係する脱線・具体例は、文脈として残してよい。` +
      `区切ってよいのは話題そのものが変わる所だけで、主張ごとに刻まない。`;
  }
  return `【この尺の方針】1本＝「大テーマで束ねる」。関連する複数の話題を1本にまとめる長さなので、` +
    `話題が変わるたびに切らず、テーマ（何について話している時間帯か）が変わる所でだけ切る。` +
    `1本の中でテーマが移り変わってよいが、テーマの入口と締めが1本に入るようにする。`;
}

/**
 * 尺の条件をプロンプトへ書き下すブロック。
 * @param {{targetSeconds:number, targetMinutes:number, charBudget?:number}|null} target
 */
export function buildDurationBlock(target) {
  if (!target) return "";
  const { targetSeconds, targetMinutes, charBudget } = target;
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) return "";
  const lo = Math.round(targetSeconds * (1 - TOPIC_DURATION_TOL));
  const hi = Math.round(targetSeconds * (1 + TOPIC_DURATION_TOL));
  const budget =
    Number.isFinite(charBudget) && charBudget > 0
      ? `この話者の話速では1区間あたり およそ ${charBudget} 文字が目安（keepText の文字数で測れる）。` +
        `${Math.round(charBudget * (1 - TOPIC_DURATION_TOL))}〜${Math.round(charBudget * (1 + TOPIC_DURATION_TOL))} 文字に収める。`
      : "";
  return (
    `# 1本あたりの尺の条件\n` +
    `切り出される動画1本（＝1区間）の目安は ${Math.round(targetSeconds)}秒（約${targetMinutes}分）。` +
    `許容範囲は ${lo}〜${hi}秒（目安の±${Math.round(TOPIC_DURATION_TOL * 100)}%）。${budget}\n` +
    `${topicDurationStrategy(targetSeconds)}\n` +
    `【重要】この尺は「切り終わったあとに機械が切り詰めるための数値」ではありません。` +
    `どこで区切るか・その区間に何を入れて何を入れないかを、上の方針そのものから決めてください。` +
    `長い話題を1本にしてから機械に等分させると、話の途中で切れた本ができます。\n\n`
  );
}

// ───────────────────────── ② 選定（chunk ごと） ─────────────────────────

/**
 * 「全体の中でこの範囲はどこか」をプロンプトへ書き下すブロック。
 * これが無いと、AI は毎回「素材の全部がこの chunk だ」と思って冒頭挨拶や締めを探し始め、
 * 重なり部分の話題を両方の chunk が二重に採る。
 */
export function buildPositionBlock(chunk, total) {
  if (!(total > 1) || !Number.isFinite(Number(chunk?.index))) return "";
  const i = Number(chunk.index);
  const range =
    Number.isFinite(chunk.start) && Number.isFinite(chunk.end)
      ? `素材の ${Math.round(chunk.start / 60)}分ごろ〜${Math.round(chunk.end / 60)}分ごろ`
      : "";
  return (
    `# この範囲の位置\n` +
    `これは素材全体を${total}分割したうちの ${i + 1} 番目です${range ? `（${range}）` : ""}。` +
    `素材の全体ではありません。${i > 0 ? "前の範囲と一部が重なっています。" : "ここが素材の冒頭です。"}` +
    `${i < total - 1 ? "次の範囲とも一部が重なっています。" : "ここが素材の末尾です。"}\n` +
    `重なりで二重に採らないため、またぎの話題は「その話題の中心（結論を言っている所）がこの範囲にあるとき」` +
    `だけ採ること。中心が範囲の外にあるなら、ここでは採らない。\n` +
    `${i > 0 ? "冒頭の挨拶を探さないこと（それは1番目の範囲にあります）。" : ""}` +
    `${i < total - 1 ? "締めの定型を探さないこと（それは最後の範囲にあります）。" : ""}\n\n`
  );
}

/**
 * 1 chunk ぶんの選定プロンプト本文を組み立てる（mode でルールを切替）。
 *
 * @param {{index?:number,start?:number,end?:number,text:string}} chunk
 * @param {number} [targetCount] 件数の上限目安（0=上限なし）
 * @param {string} [mode] 選定モード（プロンプト経路を持つモードのみ）
 * @param {{understanding?:object|null, duration?:object|null, total?:number}} [ctx]
 *   understanding = ①で作った素材全体の理解 / duration = 1本あたりの尺の条件 /
 *   total = chunk の総数（位置の説明に使う）。いずれも任意＝渡さなければ従来と同じプロンプト。
 */
export function buildPrompt(chunk, targetCount = 0, mode = DEFAULT_MODE, ctx = {}) {
  const m = requirePromptMode(mode);
  const { understanding = null, duration = null, total = 1 } = ctx;
  const limit = targetCount > 0 ? `（多くても ${targetCount} 件程度に抑える）` : "";
  return `${SYSTEM_RULES_BASE}

${m.fragment}

${buildUnderstandingBlock(understanding)}${buildDurationBlock(duration)}${buildPositionBlock(chunk, total)}# 文字起こし本文（この範囲を分割する）
${wrapUntrustedText("transcript-chunk", chunk.text)}

# 指示
上記を上記モードの方針で区間に分割し、各区間を次のJSONスキーマで出力せよ${limit}。
keepText は本文に実在する連続した抜き出しに限る（要約・改変・創作は禁止）。
秒数は出力しない（後段が文字起こしに照合して確定する）。
reason には「なぜこの区切りにしたか」を書く（ユーザーの承認画面にそのまま出る）。

# 出力スキーマ
${OUTPUT_SCHEMA}`;
}

/**
 * 複数 chunk のプロンプトを 1 つの request.md に連結（区切りで分離）。
 * キーレス経路（人＝オーケストレーターが読んで llm-response.json を書く）用。
 * この経路では全 CHUNK が1つの文書に載っている＝読み手は素材の全体を持っているので、
 * 「先に全部読んでから切れ」という順序を文書の冒頭で指示する（②の理解に相当する）。
 */
export function buildRequestDoc(chunks, mode = DEFAULT_MODE, ctx = {}) {
  const m = requirePromptMode(mode);
  const total = chunks.length;
  const blocks = chunks.map(
    (c) => `\n<!-- CHUNK ${c.index} -->\n${buildPrompt(c, m.targetCount, mode, { ...ctx, total })}`
  );
  return `# video-shorts LLM区間選定リクエスト（モード: ${m.label}）

chunk 数: ${total}。

【順序（守ること）】まず全 CHUNK の本文を通して読み、この素材が結局なんの話で、
どこに山場があり、どこが捨ててよい所かを掴んでください。**そのあとで**区間を決めます。
CHUNK ごとに独立して判断すると、同じ話題が二重に採られたり、全体の山場を外したりします。
各 CHUNK は前後と一部が重なっているので、またぎの話題は中心がある側の CHUNK でだけ採ってください。
全候補を 1 つの {"segments":[...]} に統合して llm-response.json に書いてください（秒数は出力しない）。
${blocks.join("\n")}
`;
}

// ───────────────────────── ③ 統合（全体で整える） ─────────────────────────

/**
 * chunk ごとの候補を、AI へ戻せる一覧（要約）にする。
 * keepText 全文を戻すと素材全体ぶんの文字数になって窓に入らないので、頭と尻だけを見せる。
 * 「どれを残すか」の判断には見出し・理由・前後の文と長さがあれば足りる。
 *
 * @param {Array<{keepText:string,hook?:string,reason?:string}>} segments
 * @param {number} [edgeChars] 頭と尻に見せる文字数
 */
export function summarizeCandidates(segments, edgeChars = 80) {
  return segments.map((s, i) => {
    const text = String(s.keepText ?? "");
    const head = text.slice(0, edgeChars);
    const tail = text.length > edgeChars * 2 ? text.slice(-edgeChars) : "";
    return {
      index: i,
      hook: (s.hook ?? "").trim(),
      reason: (s.reason ?? "").trim(),
      chars: text.length,
      head,
      tail,
    };
  });
}

/**
 * 統合プロンプト。全 chunk の候補を1つの一覧として AI に読ませ、全体視点で整えさせる。
 *
 * keepText は一覧に**戻させない**（頭と尻しか見せない＆番号で答えさせる）。これは逐語の連続
 * 抜き出しという前提を守るためで、AI に本文を書き直させる余地を作らないための作りである。
 * AI が動かせるのは「どの候補を残すか／落とすか」と「見出し・理由の文言」だけ。
 */
export function buildIntegrationPrompt(candidates, ctx = {}) {
  const { understanding = null, duration = null } = ctx;
  const list = candidates
    .map(
      (c) =>
        `[${c.index}] (${c.chars}文字) 見出し: ${c.hook || "(なし)"} / 理由: ${c.reason || "(なし)"}\n` +
        `  冒頭: ${c.head}\n` +
        (c.tail ? `  末尾: ${c.tail}\n` : "")
    )
    .join("");
  return `あなたは一流の動画編集者です。長い素材を範囲ごとに分けて切った結果、次の候補区間が集まりました。
範囲ごとに別々に切ったため、**重なり部分で同じ話題が二重に採られている／同じ話が細切れになっている／
本編でない所（挨拶・機材確認・締めの定型）が混ざっている**ことがあります。
これを素材全体の視点で1本の並びとして整えてください。

${buildUnderstandingBlock(understanding)}${buildDurationBlock(duration)}【守ること】
- 本文（keepText）は書き換えません。あなたが決めるのは「どの候補を残すか」と「見出し・理由の文言」だけです。
- 並び順は素材の時系列のまま（番号の昇順）にしてください。入れ替えないでください。
- 落としてよいのは、重なりによる重複／ほぼ同じ内容の重複／本編でない所（挨拶・機材確認・締めの定型・
  本編と関係ない雑談）だけです。**本編の話題を「面白くないから」という理由で落とさないでください**
  （このモードは素材を漏れなく使うのが前提です）。
- 重複している2件は、話の中心が入っている方（結論まで入っている方）を残してください。
- 残す候補には、素材全体の中での位置づけが分かる見出しと理由を付け直してください
  （範囲ごとに切ったときの見出しは、全体を知らずに付けたものです）。

# 候補一覧
${wrapUntrustedText("candidates", list)}

# 出力（JSONのみ・前後に説明文を書かない）
{"segments":[{"index":候補番号,"hook":"20字以内の見出し","reason":"この区間を残した理由・何の話題か"}],
 "dropped":[{"index":候補番号,"why":"落とした理由"}]}`;
}

/**
 * 統合の返答を、実際の segments へ適用する（純粋関数）。
 * keepText は必ず元の候補から取る＝AI の返答に本文が混ざっていても採らない
 * （逐語の連続抜き出しという前提は、ここで機械的に守る。AI の自己申告に頼らない）。
 *
 * @param {Array<{keepText:string,hook?:string,reason?:string}>} candidates 元の候補（順序＝index）
 * @param {object} decision buildIntegrationPrompt の返答をパースしたもの
 * @param {{minKeepRatio?:number}} [opts]
 * @returns {{segments:Array, dropped:number}|null} 採用できなければ null（呼び出し側は元の候補で続行）
 */
export function applyIntegration(candidates, decision, opts = {}) {
  const { minKeepRatio = 0.5 } = opts;
  const list = decision && Array.isArray(decision.segments) ? decision.segments : null;
  if (!list || list.length === 0) return null;

  // 番号 → AI が付け直した見出し／理由。番号の重複・範囲外・非整数は捨てる。
  const chosen = new Map();
  for (const item of list) {
    const idx = Number(item?.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) continue;
    if (chosen.has(idx)) continue;
    chosen.set(idx, { hook: (item?.hook ?? "").trim(), reason: (item?.reason ?? "").trim() });
  }
  if (chosen.size === 0) return null;

  // 消しすぎの歯止め。topic は「取りこぼし禁止＝素材を最大限使う」モードなので、
  // 半分以上が落ちたら重複整理ではなく選び直しをしている＝統合を採用しない
  // （AI の1回の返答で素材の大半が消えるのを、機械で止める）。
  if (chosen.size < Math.ceil(candidates.length * minKeepRatio)) return null;

  // 並びは番号の昇順＝素材の時系列に必ず戻す（返答が入れ替えてきても機械で直す。
  // topic は全カバーが前提で、並べ替えは編集意図に含まれない）。
  const segments = [...chosen.keys()]
    .sort((a, b) => a - b)
    .map((idx) => {
      const src = candidates[idx];
      const over = chosen.get(idx);
      return {
        keepText: src.keepText, // 本文は必ず元のまま（AI が返した文字列は使わない）
        hook: over.hook || (src.hook ?? "").trim(),
        reason: over.reason || (src.reason ?? "").trim(),
      };
    });

  return { segments, dropped: candidates.length - segments.length };
}

/**
 * chunk の重なりから来る明らかな重複を、AI を使わずに落とす（決定的な前処理）。
 * 統合（AI）が失敗しても、重なり由来の二重採用だけは必ず消えるようにするための土台。
 * 短い区間まで包含判定に掛けると別の話題を巻き込むので、一定の長さ以上だけを対象にする。
 *
 * @param {Array<{keepText:string}>} segments
 * @param {number} [minChars] 包含判定の対象にする最小文字数
 */
export function dedupeSegments(segments, minChars = 20) {
  const norm = (s) => String(s ?? "").replace(/\s+/g, "");
  const out = [];
  for (const seg of segments) {
    const n = norm(seg.keepText);
    if (!n) continue;
    let replaced = false;
    let skip = false;
    for (let i = 0; i < out.length; i++) {
      const o = norm(out[i].keepText);
      if (n === o) { skip = true; break; }
      if (n.length >= minChars && o.length >= minChars) {
        if (o.includes(n)) { skip = true; break; }          // 既にある方が広い＝今回は捨てる
        if (n.includes(o)) { out[i] = seg; replaced = true; break; } // 今回の方が広い＝置き換える
      }
    }
    if (!skip && !replaced) out.push(seg);
  }
  return out;
}

// ───────────────────────── 返答のパース ─────────────────────────

/**
 * 文字列リテラルを考慮して最初の { または [ から釣り合う閉じ括弧までを抽出。
 * JSON の前後に説明文（プロローグ／エピローグ）が付いても壊れない。
 */
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
  return text.slice(start);
}

/** ```json フェンスを剥がし、釣り合う括弧で JSON 本体だけを取り出して JSON.parse する。 */
export function parseJsonLoose(raw) {
  if (typeof raw !== "string") return raw;
  return JSON.parse(extractBalanced(stripFence(raw).trim()));
}

/**
 * llm-response.json をパースし、keepText を持つ segments のみ返す（防御的）。
 *
 * reason（なぜこの区間を選んだか）は落とさない。旧実装は keepText と hook だけを残して
 * reason を捨てており、AI に書かせた判断がここで消えていた。承認画面はユーザーに
 * 「なぜこの区間なのか」を見せて可否を判断してもらう場所なので、ここで捨ててはいけない。
 */
export function parseResponse(raw) {
  let data;
  try {
    data = typeof raw === "string" ? parseJsonLoose(raw) : raw;
  } catch (e) {
    throw new Error(`llm-response.json のパースに失敗: ${e.message}`);
  }
  const segs = Array.isArray(data) ? data : data.segments;
  if (!Array.isArray(segs)) throw new Error("segments 配列がありません");
  return segs
    .filter((s) => s && typeof s.keepText === "string" && s.keepText.trim().length >= 4)
    .map((s) => ({
      keepText: s.keepText.trim(),
      hook: (s.hook || "").trim(),
      reason: (s.reason || "").trim(),
    }));
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
