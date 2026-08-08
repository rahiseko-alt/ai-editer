// video-shorts 無音と言い淀みの詰め方を決める — G-EDIT-TRIM
//
// 「どこを切るか」だけを決める。実際に切るのは呼び出し側（レンダリング）。
// 決めることと切ることを分けているのは、切る前に「何秒縮むか」を画面へ出せるようにするためと、
// 切り方（ffmpeg の組み立て）を変えても決め方を測り直さなくて済むようにするため。
//
// 【何を切るか】
// (1) 語と語の間の無音。話していない時間を見せられずに済む。
// (2) 言い淀み（「えーと」「あのー」等）。話し慣れていない人の録画でも見やすくなる。
//
// 【何を切らないか】
// ・末尾の無音。言い終わりの余韻まで切ると、ぶつ切りに聞こえる。
// ・言い淀み以外の語。詰めた結果、必要な話まで消えてはいけない（葉C）。

/**
 * 言い淀みとみなす語。
 * 音声認識の書き起こしは伸ばし棒や句読点が揺れるので、比べる前に形をそろえる。
 * ここに無い言い回しは切らない（迷ったら残す。必要な話を消すほうが害が大きい）。
 */
export const FILLERS = [
  "えーと", "えっと", "えと", "ええと",
  "あのー", "あの", "あのう",
  "そのー", "その",
  "まあ", "まー",
  "うーん", "んー",
  "なんか",
];

/** 継ぎ目に掛けるフェードの長さ（秒）。短すぎると跳ねが残り、長すぎると語頭が痩せる。 */
export const SEAM_FADE_SEC = 0.005;

/** 既定: これ以上の長さの無音を「詰めるべき間」とみなす（秒） */
export const DEFAULT_MIN_SILENCE = 0.20;

/**
 * 語を比べるために形をそろえる。
 * 伸ばし棒・句読点・空白・記号を落とす（「あのー、」と「あの」を同じものとして扱う）。
 */
export function normalizeWord(text) {
  if (typeof text !== "string") return "";
  return text
    .trim()
    .replace(/[ー〜~]/g, "")
    .replace(/[、。，．,.!?！？\s　]/g, "");
}

const FILLER_SET = new Set(FILLERS.map(normalizeWord).filter(Boolean));

/** その語が言い淀みか。 */
export function isFiller(text) {
  const n = normalizeWord(text);
  return n.length > 0 && FILLER_SET.has(n);
}

/**
 * 詰め方を決める。
 *
 * @param {{w:string,start:number,end:number}[]} words 文字起こしの語（時刻つき）
 * @param {object} [opts]
 * @param {number} [opts.duration] 素材全体の長さ（秒）。末尾の余韻を残すために使う
 * @param {number} [opts.minSilence] これ以上の無音を詰める（秒）
 * @param {boolean} [opts.cutSilence] 無音を詰めるか（既定 true）
 * @param {boolean} [opts.cutFillers] 言い淀みを詰めるか（既定 true）
 * @returns {{keep: {start:number,end:number}[], cuts: {start:number,end:number,reason:string}[],
 *            keptSeconds: number, cutSeconds: number}}
 */
export function planTrim(words, opts = {}) {
  const minSilence = opts.minSilence ?? DEFAULT_MIN_SILENCE;
  const cutSilence = opts.cutSilence !== false;
  const cutFillers = opts.cutFillers !== false;

  const list = (words || [])
    .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .slice()
    .sort((a, b) => a.start - b.start);

  const duration = Number.isFinite(opts.duration)
    ? opts.duration
    : (list.length ? list[list.length - 1].end : 0);

  // 語が1つも無いときは、何も切らない。文字起こしが取れていないだけで
  // 素材を丸ごと捨てると、無音の動画が出来上がってしまう。
  if (list.length === 0) {
    return { keep: duration > 0 ? [{ start: 0, end: duration }] : [], cuts: [],
      keptSeconds: round3(duration), cutSeconds: 0 };
  }

  // 時間軸を「語」「言い淀み」「無音」の区間へ隙間なく割る。
  // 語のところだけを見て歩くと、言い淀みの前後の無音がどちらの一覧にも入らず、
  // 残す時間の合計が素材の長さと合わなくなる（実際にそう書いて3件落ちた）。
  const regions = [];
  let cursor = 0;
  for (const w of list) {
    if (w.start > cursor + 1e-9) regions.push({ start: cursor, end: w.start, kind: "silence" });
    const s = Math.max(cursor, w.start);
    if (w.end > s) regions.push({ start: s, end: w.end, kind: isFiller(w.w) ? "filler" : "word" });
    cursor = Math.max(cursor, w.end);
  }
  if (duration > cursor + 1e-9) regions.push({ start: cursor, end: duration, kind: "tail" });

  const keep = [];
  const cuts = [];
  for (const r of regions) {
    if (r.kind === "word") { keep.push(r); continue; }
    if (r.kind === "tail") { keep.push(r); continue; }   // 末尾の余韻は残す
    if (r.kind === "filler") {
      if (cutFillers) cuts.push({ ...r, reason: "filler" });
      else keep.push(r);
      continue;
    }
    // 無音。短い間は詰めない（不自然に詰まらないように）。
    if (cutSilence && r.end - r.start >= minSilence) cuts.push({ ...r, reason: "silence" });
    else keep.push(r);
  }

  const merged = mergeSpans(keep);
  const keptSeconds = merged.reduce((a, s) => a + (s.end - s.start), 0);
  return {
    keep: merged,
    cuts: mergeCuts(cuts),
    keptSeconds: round3(keptSeconds),
    cutSeconds: round3(Math.max(0, duration - keptSeconds)),
  };
}

/** 隣り合う・重なる区間をつなぐ */
function mergeSpans(spans) {
  const sorted = spans
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    // 浮動小数の誤差でごく短い隙間ができるのを防ぐ（1マイクロ秒未満はつなぐ）
    if (last && s.start - last.end <= 1e-6) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

function mergeCuts(cuts) {
  const sorted = cuts.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.start - last.end <= 1e-6) {
      last.end = Math.max(last.end, c.end);
      if (last.reason !== c.reason) last.reason = "silence+filler";
    } else out.push({ ...c });
  }
  return out;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * 残す区間だけを取り出してつなぐ ffmpeg のフィルタ式を組み立てる。
 *
 * select は「残す区間のどれかに入っているコマだけを通す」判定、
 * setpts/asetpts は「通したコマを詰めて並べ直す」ための書き換え。
 * この2つを揃えて掛けないと、切ったぶんの時間が空白として残り、尺が縮まない。
 *
 * @param {{start:number,end:number}[]} keep 残す区間（時刻の順・重なり無し）
 * @returns {{videoSelect:string, audioSelect:string}|null} 全部残すなら null（フィルタ不要）
 */
export function buildTrimFilters(keep, opts = {}) {
  const withFade = opts.seamFade !== false;
  const spans = (keep || []).filter((s) => s && s.end > s.start);
  if (spans.length === 0) return null;

  // select ではなく trim/atrim + concat で組む。
  // select は「そのコマを通すか」の判定なので、音声の1コマ(約46ms)の途中に区間の端が
  // 来ると、そのコマが丸ごと通って尺が余る（実測: 1.000秒×2区間で2.043秒）。
  // 区間の数だけ余りが積み上がるので、尺を測る受入条件では致命的になる。
  // trim/atrim は指定した時刻ちょうどで切るため、この余りが出ない。
  const v = spans.map((s, i) =>
    `[0:v]trim=start=${fmt(s.start)}:end=${fmt(s.end)},setpts=PTS-STARTPTS[tv${i}]`);
  // 継ぎ目の前後にごく短いフェードを掛ける。掛けないと、波形が途中で急に切り替わって
  // 「プツッ」という音が入る（葉D が防ぎたい状態）。
  // 長さは SEAM_FADE_SEC。耳に「消えた」と分からない範囲で、跳ねだけを均す。
  const a = spans.map((s, i) => {
    const len = s.end - s.start;
    const fade = Math.min(SEAM_FADE_SEC, Math.max(0, len / 4));
    const fadeIn = (!withFade || i === 0) ? "" : `,afade=t=in:st=0:d=${fmt(fade)}`;
    const fadeOut = (!withFade || i === spans.length - 1) ? "" : `,afade=t=out:st=${fmt(Math.max(0, len - fade))}:d=${fmt(fade)}`;
    return `[0:a]atrim=start=${fmt(s.start)}:end=${fmt(s.end)},asetpts=PTS-STARTPTS`
      + `${fadeIn}${fadeOut}[ta${i}]`;
  });
  const vLabels = spans.map((_, i) => `[tv${i}]`).join("");
  const aLabels = spans.map((_, i) => `[ta${i}]`).join("");
  return {
    // 映像だけ／音声だけを詰める式（呼び出し側が必要なほうを使う）
    videoChain: `${v.join(";")};${vLabels}concat=n=${spans.length}:v=1:a=0[tvout]`,
    audioChain: `${a.join(";")};${aLabels}concat=n=${spans.length}:v=0:a=1[taout]`,
    count: spans.length,
  };
}

/**
 * 語の時刻を、詰めたあとの時間軸へ写し直す。
 *
 * 詰めると時間が前へ詰まるので、字幕の時刻も同じだけ前へ動かさないと
 * 字幕だけ遅れて出る（葉E が防ぎたい状態）。
 * 切られた区間に入る語は返さない（もう画面に無いのに字幕だけ出るのを防ぐ）。
 *
 * @param {{w:string,start:number,end:number}[]} words
 * @param {{start:number,end:number}[]} keep
 * @returns {{w:string,start:number,end:number}[]}
 */
export function remapWords(words, keep) {
  const spans = (keep || []).filter((s) => s && s.end > s.start)
    .slice().sort((a, b) => a.start - b.start);
  if (spans.length === 0) return [];
  // 各区間が、詰めたあとの時間軸のどこから始まるか
  const offsets = [];
  let acc = 0;
  for (const s of spans) { offsets.push(acc); acc += s.end - s.start; }

  const out = [];
  for (const w of words || []) {
    if (!w || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end <= w.start) continue;
    // 語が複数の区間にまたがることは無い（区間は語の境目で割ってある）が、
    // 念のため、語の中心が入る区間を使う。
    const mid = (w.start + w.end) / 2;
    const i = spans.findIndex((s) => mid >= s.start && mid < s.end);
    if (i < 0) continue;                       // 切られた区間の語＝もう画面に無い
    const s = spans[i];
    const start = Math.max(s.start, w.start);
    const end = Math.min(s.end, w.end);
    if (end <= start) continue;
    out.push({
      ...w,
      start: round3(offsets[i] + (start - s.start)),
      end: round3(offsets[i] + (end - s.start)),
    });
  }
  return out;
}

/** ffmpeg のフィルタ式へ入れる秒数（小数3桁で固定。指数表記にしない） */
function fmt(n) {
  return (Math.round(n * 1000) / 1000).toFixed(3);
}
