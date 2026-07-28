// video-shorts [4] 逆マッチング — LLMが返した「残すテキスト」を word-level transcript に
// 照合し、start/end 秒数を確定する。LLMに秒数を出させない（落とし穴#1）の中核。
//
// 方式: テキストを正規化トークン列に分解 → transcript.words の正規化列に対し
//       最長一致のスライディング窓で先頭/末尾 word を特定 → その start/end を採用。
//       完全一致が無い場合は最良部分一致（カバー率最大の窓）を返し confidence を下げる。

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
 * @returns {{start:number,end:number,confidence:number,matchedText:string,endCharPos:number}|null}
 */
export function matchOne(keepText, words, charIndex, minCharPos = 0) {
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
  const tailPos = longestSuffixMatch(joined, target, minCharPos);
  if (headPos.len === 0 && tailPos.len === 0) return null;

  const startCharPos = headPos.len > 0 ? headPos.pos : tailPos.pos;
  const rawEndCharPos =
    tailPos.len > 0 ? tailPos.pos + tailPos.len - 1 : headPos.pos + headPos.len - 1;
  const endCharPos = Math.min(rawEndCharPos, charToWord.length - 1);
  const startWord = words[charToWord[startCharPos]];
  const endWord = words[charToWord[endCharPos]];
  if (!startWord || !endWord) return null;
  const coverage = (headPos.len + tailPos.len) / target.length;
  return {
    start: startWord.start,
    end: endWord.end,
    confidence: Math.min(0.95, Math.max(0.3, coverage)),
    matchedText: keepText,
    endCharPos,
  };
}

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
  const { preserveOrder = false } = opts;
  const words = transcript.words || [];
  const charIndex = buildCharIndex(words);
  const out = [];
  // topic（時系列）経路は直前マッチの末尾以降から次を探し、同一フレーズが複数回出現する
  // 素材でも2つ目以降の出現を正しく拾う。digest（preserveOrder）は台本の並べ替えを許すため
  // 下限を伝播させない（minCharPos=0 固定）。マッチ失敗時は cursor を進めず同じ下限で継続。
  let cursor = 0;
  for (const seg of llmSegments) {
    const minCharPos = preserveOrder ? 0 : cursor;
    let m = matchOne(seg.keepText, words, charIndex, minCharPos);
    // topic で「時系列前進の下限より前にしか出現しない」＝LLMが時系列順を守らない選定のとき、
    // 下限を外して全体から再探索し区間の消失を防ぐ（code-review advisory・plan リカバリー案）。
    if (!m && !preserveOrder && minCharPos > 0) m = matchOne(seg.keepText, words, charIndex, 0);
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
