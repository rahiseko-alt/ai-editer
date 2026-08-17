// video-shorts [4] 逆マッチング — LLMが返した「残すテキスト」を word-level transcript に
// 照合し、start/end 秒数を確定する。LLMに秒数を出させない（落とし穴#1）の中核。
//
// 方式: テキストを正規化トークン列に分解 → transcript.words の正規化列に対し
//       最長一致のスライディング窓で先頭/末尾 word を特定 → その start/end を採用。
//       完全一致が無い場合は最良部分一致（カバー率最大の窓）を返し confidence を下げる。

// P1-9: 部分一致は keepText の「頭」と「尻」を joined 全体から独立に探すため、制約が無いと
// 本来ひと続きの引用のはずが「100秒離れた別の場面の発言」を1クリップに繋いでしまう
// （docs/audits/2026-07-27-kosespark-test-review-proposal.md P1-9）。以下3つの制約で防ぐ。
/** P1-9-A: 頭一致の終わり〜尻一致の始まりに許す空き時間の上限（秒）。超えたら繋がない。 */
export const MAX_MATCH_GAP_SEC = 10;
/** P1-9-C: keepText のうち実際に一致した割合の下限。下回る区間は採用しない。 */
export const MIN_MATCH_COVERAGE = 0.5;

/** 比較用にテキストを正規化（空白・記号除去・小文字化）。日本語はそのまま結合。 */
export function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[、。．，！？!?.,「」『』（）()\-―ー…]/g, "");
}

/** transcript.words を正規化済みの連結文字列＋各文字→word index マップに変換 */
function buildCharIndex(words) {
  let joined = "";
  const charToWord = []; // joined の各文字位置 → words の index
  words.forEach((word, wi) => {
    const norm = normalize(word.w);
    for (let k = 0; k < norm.length; k++) {
      joined += norm[k];
      charToWord.push(wi);
    }
  });
  return { joined, charToWord };
}

/**
 * 1区間ぶんの残すテキストを transcript に逆マッチングし start/end を確定。
 * @param {number} [minCharPos=0] 探索開始 char 位置。同一フレーズが複数回出現する素材で
 *   直前マッチの末尾以降から探し、2つ目以降の出現を選ぶために使う（呼び出し元が時系列で持ち回る）。
 * @param {{maxGapSec?:number,minCoverage?:number}} [opts] P1-9 の制約値（既定は上の定数）。
 * @returns {{start:number,end:number,confidence:number,matchedText:string,endCharPos:number}|null}
 */
export function matchOne(keepText, words, charIndex, minCharPos = 0, opts = {}) {
  const maxGapSec = Number.isFinite(opts.maxGapSec) ? opts.maxGapSec : MAX_MATCH_GAP_SEC;
  const minCoverage = Number.isFinite(opts.minCoverage) ? opts.minCoverage : MIN_MATCH_COVERAGE;
  const target = normalize(keepText);
  if (!target || words.length === 0) return null;
  const { joined, charToWord } = charIndex;

  // 1) 完全一致を試す（minCharPos 以降で探索）
  let pos = joined.indexOf(target, minCharPos);
  if (pos !== -1) {
    const endCharPos = pos + target.length - 1;
    const startWord = words[charToWord[pos]];
    const endWord = words[charToWord[endCharPos]];
    return {
      start: startWord.start,
      end: endWord.end,
      confidence: 1.0,
      matchedText: keepText,
      endCharPos,
    };
  }

  // 2) 部分一致: target を前方から縮めながら最長の一致窓を探す（頭出し用）
  //    さらに末尾も同様に探し、両端 word で区間を張る。
  const headPos = longestPrefixMatch(joined, target, minCharPos);
  let tailPos = longestSuffixMatch(joined, target, minCharPos);
  if (headPos.len === 0 && tailPos.len === 0) return null;

  // 尻の一致は「最初に見つかった出現」なので、それが頭の範囲に食い込んでいても、頭より後ろに
  // 別の出現があるならそちらが本来の尻である可能性が高い。頭の直後から探し直してから判断する。
  if (
    headPos.len > 0 &&
    tailPos.len > 0 &&
    tailPos.pos <= headPos.pos + headPos.len - 1
  ) {
    const afterHead = longestSuffixMatch(joined, target, headPos.pos + headPos.len);
    if (afterHead.len > 0) tailPos = afterHead;
  }

  // 頭と尻の両方が見つかったときだけ「繋ぐ」判断をする。繋がない場合は、長く一致した側の
  // 領域だけを1区間として採用する（区間を丸ごと捨てるより素材を活かせる）。
  let joinable = headPos.len > 0 && tailPos.len > 0;
  if (joinable && tailPos.pos <= headPos.pos + headPos.len - 1) {
    // P1-9-B: 尻の一致が頭の一致より前にある＝繋ぐと会話の順番が逆転する。
    // 頭の範囲に食い込んでいる場合（同じ出現に頭と尻の両方が当たっている場合を含む）も、
    // 繋ぐと同じ文字を二重に数えて matchedChars が実際より大きくなるため結合しない。
    joinable = false;
  }
  if (joinable) {
    // P1-9-A: 頭の一致が終わってから尻の一致が始まるまでが空きすぎている＝別の場面の発言。
    const headEndWord = words[charToWord[headPos.pos + headPos.len - 1]];
    const tailStartWord = words[charToWord[tailPos.pos]];
    if (!headEndWord || !tailStartWord) return null;
    if (tailStartWord.start - headEndWord.end > maxGapSec) joinable = false;
  }

  let startCharPos;
  let rawEndCharPos;
  let matchedChars;
  if (joinable) {
    startCharPos = headPos.pos;
    rawEndCharPos = tailPos.pos + tailPos.len - 1;
    // 頭と尻は target 上で前半・後半にあたるため、一致文字数の合計が target 長を超えることは
    // 重なった場合のみ。重複分を二重に数えないよう target 長で頭打ちにする。
    matchedChars = Math.min(target.length, headPos.len + tailPos.len);
  } else {
    // 片側だけの一致。区間は語境界に揃う（下の longestPrefixMatch 手前の調査コメント参照）が、
    // keepText のうち当たらなかった側は黙って落ちる。＝ここは「広く取る」の逆向き。未修正。
    const useHead = headPos.len >= tailPos.len;
    const side = useHead ? headPos : tailPos;
    startCharPos = side.pos;
    rawEndCharPos = side.pos + side.len - 1;
    matchedChars = side.len;
  }
  const endCharPos = Math.min(rawEndCharPos, charToWord.length - 1);
  const startWord = words[charToWord[startCharPos]];
  const endWord = words[charToWord[endCharPos]];
  if (!startWord || !endWord) return null;
  const coverage = matchedChars / target.length;
  // P1-9-C: keepText のごく一部しか当たっていない区間は、別の発言を拾っている可能性が高い。
  if (coverage < minCoverage) return null;
  return {
    start: startWord.start,
    end: endWord.end,
    confidence: Math.min(0.95, Math.max(0.3, coverage)),
    matchedText: keepText,
    endCharPos,
  };
}

// 【調査済み・2026-08-17】docs/編集についての虎の巻.md 8節A「部分一致が単語の途中から切り出す
// （「画編集」を生む直接の実装）」は、**この実装では再現しない**。同じ調査を繰り返さないこと。
//
// 下の2関数は確かに target を1文字ずつ削って候補文字列を作るので、「画編集の話」のような
// 語の途中から始まる候補が生成される。しかしそれは **探す鍵** にしか使われない。返す時刻は
// matchOne が `words[charToWord[pos]].start` / `words[charToWord[endCharPos]].end` で決めており、
// charToWord は文字位置を「その文字を含む語」へ写すため、pos が語の途中を指していても
// start は必ずその語の先頭へ、end は必ずその語の末尾へ **外側に丸められる**。
// ＝切り出す区間は常に語の境界に揃い、区間は候補文字列より狭くならない（原則3の向き）。
//   実測: ランダム素材で成立したマッチ 126,234 件のうち、start/end が語境界に揃わなかったのは 0 件。
//   実測: 8節Aが提案する直し方（「縮める単位を文字ではなく単語にする」）を実装して
//        tests/fixtures/ai-caption-fix/transcript-miswritten.json に当てたが、
//        一致位置・長さ・開始語すべて現状と同一だった（＝この提案は効かない）。
//        理由は Whisper の words が形態素粒度（「健康」「診断」が別語）で、
//        文字単位で削った候補の端も既に語境界に一致しているため。
//
// ただし **別の実害は残っている**（8節Aの説明とは原因も直し方も違うので、別件として扱うこと）:
// 片側しか当たらなかったとき（下の else 分岐）、当たった側の範囲だけを区間にするので、
// keepText の残り（文末表現や複合語の前半）が黙って落ちる。上記 fixture での実測:
//   keepText「毎年の診断の結果についてお話しします」→ [1.0, 3.9] conf=0.833。
//   実際に流れるのは「診断の結果についてお話しします」で、複合語「健康診断」が
//   「健康」を落として割れる（§2-2 違反）。keepText 欄は元の全文のままなので台本と音もずれる。
// これを「欠かさない方向へ外側に広げる」直し方は試作済みだが、tests/smoke.mjs の凍結済み
// P1-9 アサーション3件（「頭側だけの区間として残る」= end===2.0 を固定しているもの）と
// 正面から矛盾する。基準の側を動かす判断が要るため、ここでは直していない。

/** target の先頭から最長で joined（fromPos 以降）に現れる接頭辞を二分探索的に求める */
function longestPrefixMatch(joined, target, fromPos = 0) {
  let best = { pos: -1, len: 0 };
  for (let len = target.length; len >= 4; len--) {
    const p = joined.indexOf(target.slice(0, len), fromPos);
    if (p !== -1) {
      best = { pos: p, len };
      break;
    }
  }
  return best;
}

/** target の末尾から最長で joined（fromPos 以降）に現れる接尾辞を求める */
function longestSuffixMatch(joined, target, fromPos = 0) {
  let best = { pos: -1, len: 0 };
  for (let len = target.length; len >= 4; len--) {
    const p = joined.indexOf(target.slice(target.length - len), fromPos);
    if (p !== -1) {
      best = { pos: p, len };
      break;
    }
  }
  return best;
}

/**
 * LLM選定結果（segments配列：{keepText, hook}）を transcript に逆マッチングし、
 * start/end/confidence を付与した区間配列を返す。マッチ失敗は除外。
 */
export function resolveSegments(llmSegments, transcript, opts = {}) {
  const { preserveOrder = false, maxGapSec, minCoverage } = opts;
  const matchOpts = { maxGapSec, minCoverage };
  const words = transcript.words || [];
  const charIndex = buildCharIndex(words);
  const out = [];
  // topic（時系列）経路は直前マッチの末尾以降から次を探し、同一フレーズが複数回出現する
  // 素材でも2つ目以降の出現を正しく拾う。digest（preserveOrder）は台本の並べ替えを許すため
  // 下限を伝播させない（minCharPos=0 固定）。マッチ失敗時は cursor を進めず同じ下限で継続。
  let cursor = 0;
  for (const seg of llmSegments) {
    const minCharPos = preserveOrder ? 0 : cursor;
    let m = matchOne(seg.keepText, words, charIndex, minCharPos, matchOpts);
    // topic で「時系列前進の下限より前にしか出現しない」＝LLMが時系列順を守らない選定のとき、
    // 下限を外して全体から再探索し区間の消失を防ぐ（code-review advisory・plan リカバリー案）。
    if (!m && !preserveOrder && minCharPos > 0) m = matchOne(seg.keepText, words, charIndex, 0, matchOpts);
    if (!m) continue;
    if (m.end <= m.start) continue; // 不正区間は捨てる
    // cursor は単調前進（Math.max）で維持し、再探索で前方一致しても後退させない。
    if (!preserveOrder && typeof m.endCharPos === "number") cursor = Math.max(cursor, m.endCharPos + 1);
    out.push({
      start: m.start,
      end: m.end,
      duration: Math.round((m.end - m.start) * 1000) / 1000,
      hook: seg.hook || "",
      keepText: seg.keepText,
      confidence: m.confidence,
    });
  }
  // ダイジェストの台本再構成では順序が意味を持つため時系列ソートしない（llm 配列順を保持）。
  // 話題毎など通常経路は従来どおり時系列順 + 重複 dedupe（落とし穴#5 オーバーラップ対策）。
  if (preserveOrder) return dedupeOverlap(out, 0.6, true);
  out.sort((a, b) => a.start - b.start);
  return dedupeOverlap(out);
}

/** start/end が大きく重なる区間を confidence 優先で間引く。
 * preserveOrder=true なら最後の時系列ソートをせず入力順（＝台本順）を保つ。 */
export function dedupeOverlap(segs, overlapRatio = 0.6, preserveOrder = false) {
  const kept = [];
  for (const s of segs) {
    const clash = kept.find((k) => {
      const ov = Math.min(k.end, s.end) - Math.max(k.start, s.start);
      const shorter = Math.min(k.duration, s.duration);
      return ov > 0 && shorter > 0 && ov / shorter >= overlapRatio;
    });
    if (!clash) {
      kept.push(s);
    } else if (s.confidence > clash.confidence) {
      kept[kept.indexOf(clash)] = s;
    }
  }
  return preserveOrder ? kept : kept.sort((a, b) => a.start - b.start);
}
