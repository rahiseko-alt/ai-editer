// video-shorts 区間リファイン — topic 出力の2大不満を後処理で解消する。
//  1) 細切れ（本数が多すぎ）→ mergeShortSegments で隣接区間を貪欲結合。
//  2) 斬り方が悪い（文の途中で切れる）→ snapToSilence で start/end を無音境界へ寄せる。
// digest（台本再構成）は意図的な分割・並べ替えのため mergeShortSegments は掛けない。
// ESM・Node標準のみ・元配列非破壊。

/** mergeShortSegments に渡す「1区間の最小尺」の既定値（秒）。 */
export const DEFAULT_MIN_SEC = 180;

/**
 * 1区間の最小尺を決める。優先順は CLI(--min-sec) > env(TOPIC_MIN_SEC) > 既定180秒。
 *
 * CLI から指定できるようにした理由（2026-08-14 実素材の初回処理・docs/failures.md）：
 * 既定180秒のままだと「話題毎」でAIが選んだ区間が3分未満のとき隣と強制結合され、
 * 実素材では4区間が2本(うち1本7分10秒)になってショート動画にならなかった。
 * 指定口が無いこと自体が不具合だったので、env だけでなく CLI からも効くようにする。
 *
 * 数値として読めない値・0以下は「指定なし」とみなして次の優先度へ落とす（黙って
 * 0秒扱いにすると結合が全く効かなくなり、壊れ方が分かりにくいため）。
 *
 * @param {unknown} cliValue --min-sec の値（未指定なら undefined）
 * @param {unknown} envValue process.env.TOPIC_MIN_SEC（未設定なら undefined）
 * @returns {number} 実際に使う最小尺（秒）
 */
export function resolveMinSec(cliValue, envValue) {
  for (const raw of [cliValue, envValue]) {
    if (raw === undefined || raw === null || raw === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MIN_SEC;
}

/**
 * 目標尺(分)から、区間の下限秒(floor)・上限秒(ceil)を決める。
 * 優先順は CLI(--duration-min) > 未指定(null=おまかせ)。
 *
 * 「3分くらいで」と指示したのに1分30秒〜4分30秒まで許すと、指示したとは言えない
 * （実装が「常に同じ長さを返す」形でも許容幅に収まってしまい、指定が効いているか
 * 判定できない）。無音境界へ寄せるずれ(snapToSilence)は通常1発話ぶん(数秒)で、
 * 180秒に対して数%しかない。floor/ceil を目標の ±30% に置くのは、この実測されている
 * ずれ幅(数%)よりは十分広く、かつ「常に同じ長さを返す」実装が3分指定と1分指定の
 * 両方を同時に満たせない（3分の70%=126秒 > 1分の130%=78秒で範囲が重ならない）ように
 * 締めるため。
 *
 * @param {unknown} durationMinCli --duration-min の値（分。未指定なら undefined）
 * @returns {{floorSec: number, ceilSec: number} | null} 指定が無ければ null（おまかせ）
 */
export function resolveTargetDuration(durationMinCli) {
  if (durationMinCli === undefined || durationMinCli === null || durationMinCli === "") return null;
  const n = Number(durationMinCli);
  if (!Number.isFinite(n) || n <= 0) return null;
  const targetSec = n * 60;
  return { floorSec: targetSec * 0.7, ceilSec: targetSec * 1.3 };
}

/** idealEnd に最も近い word.end を、(rangeStart, rangeEnd) の開区間内から探す。無ければ null。 */
function nearestWordEnd(idealEnd, words, rangeStart, rangeEnd) {
  let best = null;
  let bestDist = Infinity;
  for (const w of words) {
    if (!(w.end > rangeStart) || !(w.end < rangeEnd)) continue;
    const dist = Math.abs(w.end - idealEnd);
    if (dist < bestDist) { bestDist = dist; best = w.end; }
  }
  return best;
}

/**
 * maxSec を超える区間を、ほぼ等分になるよう複数本へ割る（語の途中では切らない）。
 *
 * 「おまかせ」時に1本が素材の1/3を超える（実測: 4区間が2本へ結合され1本7分10秒）のを防ぐ
 * ため、または「3分くらいで」の指示に対して上限を守るために使う。分割位置は理想の等分点に
 * 最も近い word.end へ寄せる（word境界を無視すると発話の途中で切れる）。寄せる先が
 * 見つからない場合は理想の等分点をそのまま使う（words が疎な素材でも、割ること自体は保証する。
 * 語の途中で切れる可能性はあるが、上限を超えたまま1本残すよりは害が小さい）。
 * @param {Array} segments mergeShortSegments/snapToSilence 適用後の区間配列
 * @param {number} maxSec 1本の上限秒数（Infinity/0以下等は無変更）
 * @param {Array<{w:string,start:number,end:number}>} [words] 分割位置探索用
 * @returns {Array} 新配列（元配列は破壊しない。割られた区間は複数本になる）
 */
export function capSegmentDuration(segments, maxSec, words = []) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  if (!(maxSec > 0) || !Number.isFinite(maxSec)) return segments.map((s) => ({ ...s }));
  const out = [];
  for (const seg of segments) {
    const dur = seg.end - seg.start;
    if (dur <= maxSec) { out.push({ ...seg }); continue; }
    const n = Math.ceil(dur / maxSec);
    const chunkLen = dur / n;
    let cursor = seg.start;
    for (let i = 0; i < n; i++) {
      const isLast = i === n - 1;
      const idealEnd = isLast ? seg.end : seg.start + chunkLen * (i + 1);
      const end = isLast ? seg.end : (nearestWordEnd(idealEnd, words, cursor, seg.end) ?? idealEnd);
      out.push({ ...seg, start: cursor, end, duration: Math.round((end - cursor) * 1000) / 1000 });
      cursor = end;
      if (cursor >= seg.end) break;
    }
  }
  return out;
}

/** 全角込みの見かけ幅で切る（全角=2/半角=1 として合計 maxWidth に収める）。 */
function truncateByWidth(text, maxWidth) {
  let width = 0;
  let out = "";
  for (const ch of text) {
    // ASCII 範囲（半角）は 1、それ以外（全角想定）は 2 として数える。
    const w = ch.charCodeAt(0) <= 0xff ? 1 : 2;
    if (width + w > maxWidth) break;
    width += w;
    out += ch;
  }
  return out;
}

/**
 * 隣接区間を貪欲に結合し「細切れ」を解消する。
 * segments は start 昇順前提。先頭から accumulate し、累積 duration が minSec 以上に
 * なったら1区間として確定→次のグループへ。最後の余りも必ず1区間として emit する。
 * @param {Array<{start:number,end:number,duration:number,hook:string,keepText:string,confidence:number}>} segments
 * @param {number} minSec 1区間の最小尺（秒）
 * @param {number} [maxGapSec=3] 隣接区間とみなす最大ギャップ秒（呼び出し元は env `TOPIC_MERGE_GAP_MAX` で調整可・R-8）
 * @returns {Array} 新配列（元配列は破壊しない）
 */
export function mergeShortSegments(segments, minSec, maxGapSec = 3) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const out = [];
  let group = [];

  const flush = () => {
    if (group.length === 0) return;
    const head = group[0];
    const tail = group[group.length - 1];
    const start = head.start;
    const end = tail.end;
    const hooks = group.map((g) => g.hook).filter((h) => h && h.length > 0);
    const hook = truncateByWidth(hooks.join(" / "), 40);
    const keepText = group.map((g) => g.keepText || "").join(" ");
    const confidence = group.reduce(
      (min, g) => Math.min(min, g.confidence ?? 1),
      Infinity,
    );
    out.push({
      start,
      end,
      duration: Math.round((end - start) * 1000) / 1000,
      hook,
      keepText,
      confidence: confidence === Infinity ? 0 : confidence,
    });
    group = [];
  };

  for (const seg of segments) {
    // R-7a: 直前区間との間に大きなギャップ（=LLMが除外した区間）があれば、
    // ここで一旦区切ってから追加する。除外区間を跨いで結合すると復活してしまうため。
    if (group.length > 0) {
      const gap = seg.start - group[group.length - 1].end;
      if (gap > maxGapSec) flush();
    }
    group.push(seg);
    const acc = group[group.length - 1].end - group[0].start;
    if (acc >= minSec) flush();
  }
  flush(); // 最後の余り

  return out;
}

/**
 * 各区間の start/end を最寄りの無音（word 間ギャップ）にスナップし、文の途中切りを防ぐ。
 * start は「直前ギャップが最大かつ ≥minGap」の word.start に、
 * end は「直後ギャップが最大かつ ≥minGap」の word.end に寄せる。
 * @param {Array} segments 区間配列
 * @param {Array<{w:string,start:number,end:number}>} words word 単位 transcript
 * @param {{window?:number,minGap?:number}} opts window=探索窓(秒) / minGap=無音閾値(秒)
 * @returns {Array} 新配列（元配列は破壊しない）
 */
export function snapToSilence(segments, words, opts = {}) {
  if (!Array.isArray(segments)) return [];
  const window = opts.window ?? 1.5;
  const minGap = opts.minGap ?? 0.25;
  // words 空なら無変更（浅いコピーで非破壊）。
  if (!Array.isArray(words) || words.length === 0) {
    return segments.map((s) => ({ ...s }));
  }

  return segments.map((seg) => {
    const newStart = snapStart(seg.start, words, window, minGap);
    const newEnd = snapEnd(seg.end, words, window, minGap);
    // ガード: start >= end になるなら据え置き。
    if (newStart >= newEnd) return { ...seg };
    return {
      ...seg,
      start: newStart,
      end: newEnd,
      duration: Math.round((newEnd - newStart) * 1000) / 1000,
    };
  });
}

/** start を最寄りの「直前ギャップ最大」word.start にスナップ。該当なしは据え置き。 */
function snapStart(start, words, window, minGap) {
  let best = null;
  let bestGap = minGap;
  for (let i = 0; i < words.length; i++) {
    const ws = words[i].start;
    if (ws < start - window) continue;
    if (ws > start + window) break; // words は昇順前提
    const prevEnd = i > 0 ? words[i - 1].end : 0;
    const gap = ws - prevEnd;
    if (gap >= bestGap) {
      bestGap = gap;
      best = ws;
    }
  }
  return best ?? start;
}

/** end を最寄りの「直後ギャップ最大」word.end にスナップ。該当なしは据え置き。 */
function snapEnd(end, words, window, minGap) {
  let best = null;
  let bestGap = minGap;
  for (let i = 0; i < words.length; i++) {
    const we = words[i].end;
    if (we < end - window) continue;
    if (we > end + window) break; // words は昇順前提
    const nextStart = i < words.length - 1 ? words[i + 1].start : we;
    const gap = nextStart - we;
    if (gap >= bestGap) {
      bestGap = gap;
      best = we;
    }
  }
  return best ?? end;
}
