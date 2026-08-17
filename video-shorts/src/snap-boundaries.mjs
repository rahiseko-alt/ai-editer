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

/** 語の末尾が句点系＝文の終わり（虎の巻 §2-1 の序列1位）。 */
const SENTENCE_END_RE = /[。．！？!?…]$/;
/** 語の末尾が読点系＝意味の切れ目（同 序列2位）。 */
const CLAUSE_END_RE = /[、，,]$/;

/**
 * 分割点の候補を「意味の切れ目」優先で選ぶ（虎の巻 §2-1 の序列）。
 *  1位: 文末（句点で終わる語の直後）
 *  2位: 読点で終わる語の直後 / 直後に minGap 以上の間がある語の直後（＝息継ぎの切れ目）
 *  それも無ければ null（呼び出し元が最寄り word.end へフォールバックする）
 * 同順位が複数あれば idealEnd に最も近いものを採る。
 * @returns {number|null}
 */
function chooseSplitEnd(idealEnd, words, lo, hi, searchWindow, minGap) {
  let best = null;
  let bestRank = Infinity;
  let bestDist = Infinity;
  for (let i = 0; i < words.length; i++) {
    const we = words[i].end;
    if (!(we > lo) || !(we < hi)) continue;
    const dist = Math.abs(we - idealEnd);
    if (dist > searchWindow) continue;
    const text = String(words[i].w ?? "");
    const gapAfter = i < words.length - 1 ? words[i + 1].start - we : Infinity;
    let rank;
    if (SENTENCE_END_RE.test(text)) rank = 0;
    else if (CLAUSE_END_RE.test(text) || gapAfter >= minGap) rank = 1;
    else continue; // 文節の内側＝ここでは候補にしない
    if (rank < bestRank || (rank === bestRank && dist < bestDist)) {
      bestRank = rank; bestDist = dist; best = we;
    }
  }
  return best;
}

/**
 * maxSec を超える区間を、ほぼ等分になるよう複数本へ割る（意味の切れ目で切る）。
 *
 * 「おまかせ」時に1本が素材の1/3を超える（実測: 4区間が2本へ結合され1本7分10秒）のを防ぐ
 * ため、または「3分くらいで」の指示に対して上限を守るために使う。
 *
 * 【2026-08-17 の修正（虎の巻 §8-F: 等分点で機械的に割る）】
 * 以前は「理想の等分点に最も近い word.end」へ寄せるだけだったので、切れ目が文の途中に
 * 落ちた（実測: 3本に割ったうち2本が文の途中で終わり／文の途中から始まった。末尾が
 * 「…台無しになります。たとえば」、次の本の先頭が「単語の途中で切ると…」）。
 * いまは等分点の近傍から「文末（句点）＞読点／息継ぎの間」の順で切れ目を探し（chooseSplitEnd）、
 * 見つからないときだけ従来どおり最寄りの word.end へ落とす。
 *
 * 虎の巻は「文末が見つからなければ割らずに諦める」と書いているが、ここで無条件に諦めると
 * 上限（--duration-min の指示・おまかせ時の素材1/3）という別の約束が壊れる。そこで
 * 「諦める」のは **語の切れ目が1つも無い（＝どこで切っても語の内側になる）とき** に限定した。
 * 語の途中で切ること（虎の巻 A1・事故の原因そのもの）は素材から作り直しになるが、長いまま
 * 残すのは後から詰められる＝害が小さい（原則3）。
 * ただし words を渡されていない呼び出しは、そもそも語の情報が無く判断できないので従来どおり
 * 等分点で割る（後方互換）。
 *
 * @param {Array} segments mergeShortSegments/snapToSilence 適用後の区間配列
 * @param {number} maxSec 1本の上限秒数（Infinity/0以下等は無変更）
 * @param {Array<{w:string,start:number,end:number}>} [words] 分割位置探索用
 * @returns {Array} 新配列（元配列は破壊しない。割られた区間は複数本になる）
 */
export function capSegmentDuration(segments, maxSec, words = []) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  if (!(maxSec > 0) || !Number.isFinite(maxSec)) return segments.map((s) => ({ ...s }));
  const hasWords = Array.isArray(words) && words.length > 0;
  const minGap = 0.25; // 「間」とみなす最短の無言（snapToSilence の既定と揃える）
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
      let end;
      if (isLast) {
        end = seg.end;
      } else {
        // 切れ目を探してよい範囲。ここを外れると「この本が上限超え」「残りが上限に収まらない」の
        // どちらかが起きるので、意味の切れ目より上限の約束を優先する（探索窓ではなく硬い制約）。
        const remaining = n - i - 1;
        const hardMin = Math.max(cursor + 1e-3, seg.end - remaining * maxSec);
        const hardMax = Math.min(seg.end - 1e-3, cursor + maxSec);
        // 等分点からどれだけ動いてよいか。動かしすぎると1本だけ極端に短くなるので 1/4 で頭打ち。
        const searchWindow = Math.min(chunkLen * 0.25, Math.max(0, hardMax - hardMin));
        const picked = hardMin < hardMax
          ? (chooseSplitEnd(idealEnd, words, hardMin, hardMax, searchWindow, minGap)
            ?? nearestWordEnd(idealEnd, words, hardMin, hardMax))
          : null;
        if (picked !== null && picked !== undefined) {
          end = picked;
        } else if (!hasWords) {
          end = idealEnd; // 語の情報が無い呼び出しは従来どおり等分点（後方互換）
        } else {
          // 語の切れ目が1つも無い＝どこで切っても語の内側。割らずに残りを1本として出す。
          out.push({
            ...seg, start: cursor, end: seg.end,
            duration: Math.round((seg.end - cursor) * 1000) / 1000,
          });
          cursor = seg.end;
          break;
        }
      }
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
 * 語の情報が無いときに「跨いでよい」とみなすギャップの上限（秒）。
 *
 * 【2026-08-17 追加（虎の巻 §8-G: 捨てたはずの発話を復活させる）】
 * 結合後の区間は head.start〜tail.end なので、間にあるギャップの中身はそのまま音になる。
 * ギャップに発話が入っていれば、AI が「要らない」と判断して捨てた発話が動画に戻り、
 * しかも keepText には入っていないので台本（承認画面・字幕の元）と音が食い違う。
 * words を渡してもらえれば「ギャップに発話があるか」を実際に見て決められるが、渡されない
 * 呼び出しでは判断材料が無いので、**発話が入りうる長さのギャップは跨がない**（1秒）。
 * 文と文の間の自然な間は実素材で 0.4〜0.9 秒（src/breath-handles.mjs の実測）なので、
 * 1秒以下は「間だけ」とみなしてよく、それを超えるものは発話が入っている前提で扱う。
 */
export const SAFE_BRIDGE_GAP_SEC = 1.0;

/** ギャップ (a,b) に発話（word）が入っているか。words 未提供なら長さで推定する。 */
function speechInGap(words, a, b) {
  const gap = b - a;
  if (!(gap > 0)) return false;
  if (!Array.isArray(words) || words.length === 0) return gap > SAFE_BRIDGE_GAP_SEC;
  // 0.05 秒以下の掛かりは語境界の丸め。それ以上重なっていれば「発話が入っている」。
  return words.some((w) => Math.min(w.end, b) - Math.max(w.start, a) > 0.05);
}

/**
 * 隣接区間を貪欲に結合し「細切れ」を解消する。
 * segments は start 昇順前提。先頭から accumulate し、累積 duration が minSec 以上に
 * なったら1区間として確定→次のグループへ。最後の余りも必ず1区間として emit する。
 *
 * 結合は「間（無言）だけを跨ぐ」場合に限る。捨てた発話を跨ぐ結合はしない（上の
 * SAFE_BRIDGE_GAP_SEC 参照）。尺が足りないぶんを内容で埋めるのは AI が選び直すことで、
 * ここで黙って埋めてよいことではない。
 * @param {Array<{start:number,end:number,duration:number,hook:string,keepText:string,confidence:number}>} segments
 * @param {number} minSec 1区間の最小尺（秒）
 * @param {number} [maxGapSec=3] 隣接区間とみなす最大ギャップ秒（呼び出し元は env `TOPIC_MERGE_GAP_MAX` で調整可・R-8）
 * @param {Array<{w:string,start:number,end:number}>} [words] 渡すと「ギャップに発話があるか」を実際に見て判定する
 * @returns {Array} 新配列（元配列は破壊しない）
 */
export function mergeShortSegments(segments, minSec, maxGapSec = 3, words = []) {
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
    // 2026-08-17: maxGapSec（既定3秒）以下でも、ギャップに発話が入っていれば同じことが
    // 起きる（実測: 2.8秒のギャップに入っていた「えーっとちょっと待ってくださいね。」が
    // 復活し、keepText には無いまま音だけ戻った）。発話が入るギャップは跨がない。
    if (group.length > 0) {
      const prevEnd = group[group.length - 1].end;
      const gap = seg.start - prevEnd;
      if (gap > maxGapSec || speechInGap(words, prevEnd, seg.start)) flush();
    }
    group.push(seg);
    const acc = group[group.length - 1].end - group[0].start;
    if (acc >= minSec) flush();
  }
  flush(); // 最後の余り

  return out;
}

/**
 * 各区間の start/end を、その区間が乗っている「発話のかたまり」の外側の切れ目まで広げる。
 *
 * 【2026-08-17 の修正（虎の巻 §8-E: 最大ギャップを選び、意味の切れ目を見ていない）】
 * 以前は探索窓 ±1.5 秒の中で **最も長いギャップ** の語境界へ寄せていた。長い間は文と文の
 * 間だけでなく、文の途中の「溜め」（言いにくいことの前の間）にもできるので、
 * 実測で次のように壊れていた：
 *   - 「昨日の収録で使った素材は〈0.8秒の溜め〉全部撮り直しました。」の区間が
 *     溜めの手前へ寄せられ、落ちである「全部撮り直しました。」0.63秒が音から消えた。
 *     keepText は元のままなので、承認した台本と音が食い違う。
 *   - 「でも、〈0.85秒〉これだけは…」の区間は start が溜めの後ろへ動き、先頭の「でも、」が消えた。
 * いまは **外側へしか動かさない**（start は前へ、end は後ろへ）。動かす先は「今の発話の
 * かたまりの端」（＝ minGap 以上の間に接する語境界）で、間を跨いで隣の発話へは入らない。
 * こうすると
 *   - keepText の語が音から欠けることが構造的に起きない（台本と音が食い違わない）ので、
 *     keepText を書き換える必要も無い（虎の巻 §8-E の後半の指摘への回答）。
 *   - 切り位置が「文の途中」から「発話のかたまりの切れ目」になる（原則1・原則3）。
 *
 * 【音の実測（虎の巻 §8-D）について】ここは transcript の語の時刻しか見ておらず、
 * ffmpeg silencedetect による無音の実測はしていない（実測は src/breath-handles.mjs
 * detectSilences が持つが、素材のパスと await が要るためこの純関数からは呼べない）。
 * 本来は §3-1 のとおり実測した無音の内側に切り点を置くべきで、そのときは
 * opts に実測結果を渡して「かたまりの端」をさらに内側へ寄せる形になる。
 * なお topic 経路では、この直後に pipeline.mjs が前0.5秒・後0.8秒の余韻パディングを掛けており、
 * 「のりしろが無いまま語境界ちょうどで切る」状態にはなっていない。
 *
 * @param {Array} segments 区間配列（topic 経路は start 昇順）
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

  return segments.map((seg, i) => {
    // 広げた結果が隣の区間へ食い込むと、同じ発話が2本のクリップで二重に再生される。
    // 時系列で並んでいる隣とだけ突き合わせて上限・下限にする。
    const prev = segments[i - 1];
    const next = segments[i + 1];
    const lowerLimit = prev && prev.end <= seg.start ? prev.end : -Infinity;
    const upperLimit = next && next.start >= seg.end ? next.start : Infinity;
    const newStart = snapStart(seg.start, words, window, minGap, lowerLimit);
    const newEnd = snapEnd(seg.end, words, window, minGap, upperLimit);
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

/**
 * start を「今の発話のかたまりの先頭」まで前へ寄せる（後ろへは動かさない）。
 * 候補は「直前に minGap 以上の間がある word.start」のうち start に最も近いもの。
 * 該当なし（窓内にかたまりの先頭が無い）は据え置き。
 */
function snapStart(start, words, window, minGap, lowerLimit = -Infinity) {
  let best = null;
  for (let i = 0; i < words.length; i++) {
    const ws = words[i].start;
    if (ws > start + 1e-6) break; // words は昇順前提。start より後ろへは動かさない。
    if (ws < start - window || ws < lowerLimit) continue;
    const prevEnd = i > 0 ? words[i - 1].end : 0;
    if (ws - prevEnd >= minGap) best = ws; // 昇順なので上書きするほど start に近くなる
  }
  return best ?? start;
}

/**
 * end を「今の発話のかたまりの終わり」まで後ろへ伸ばす（手前へは動かさない）。
 * 候補は「直後に minGap 以上の間がある word.end」のうち end に最も近いもの。
 * 該当なし（窓内にかたまりの終わりが無い）は据え置き。
 */
function snapEnd(end, words, window, minGap, upperLimit = Infinity) {
  for (let i = 0; i < words.length; i++) {
    const we = words[i].end;
    if (we < end - 1e-6) continue; // end より手前へは動かさない
    if (we > end + window || we > upperLimit) break; // words は昇順前提
    // 素材の最後の語は「この後ずっと間」とみなす（伸ばす先が素材末尾しかないため）。
    const gapAfter = i < words.length - 1 ? words[i + 1].start - we : Infinity;
    if (gapAfter >= minGap) return we; // 昇順なので最初に見つかったものが最寄り
  }
  return end;
}
