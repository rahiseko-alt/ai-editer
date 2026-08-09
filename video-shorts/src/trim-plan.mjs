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

  const merged = snapToFrames(mergeSpans(keep), opts.fps);
  const keptSeconds = merged.reduce((a, s) => a + (s.end - s.start), 0);
  return {
    keep: merged,
    cuts: mergeCuts(cuts),
    keptSeconds: round3(keptSeconds),
    cutSeconds: round3(Math.max(0, duration - keptSeconds)),
  };
}

/**
 * 残す区間の端を、コマの境目へ揃える。
 *
 * 【なぜ要るか】ffmpeg の trim（映像）は指定時刻に最も近いコマ境界へ丸めるが、
 * atrim（音声）はサンプル精度でちょうど切る。端が半端な時刻だと、区間ごとに
 * 最大1コマぶんの差が出て、継ぎ目の数だけ積み上がる。
 * 実測（15fps・区間長 29/30秒・開始オフセット 1/30秒）:
 *   区間2個 -67ms / 5個 -167ms / 10個 -333ms / 20個 -673ms。
 * 詰めた実素材で口の動きと声がずれる。
 *
 * 【なぜ planTrim の側で揃えるか】pipeline.mjs は同じ keep を remapWords へも渡して
 * 字幕の時刻を写す。buildTrimFilters の側で揃えると、字幕だけ古い時間軸に残る。
 *
 * fps が取れなかった素材（r_frame_rate が 0/0 等）では揃えずに返す。
 * 従来どおりの動きになるだけで、揃えないより悪くはならない。
 */
/**
 * 残す区間の最短の長さ（コマ数）。
 *
 * 1コマちょうどの区間を ffmpeg へ渡すと、映像のコマが落ちる。
 * 実測（15fps・1コマ区間を10個）: 映像は10コマ出るはずが2コマしか出ず、
 * 音だけ10コマぶん残って絵と音がずれる（2026-08-08、independent-verifier の指摘）。
 * 2コマ以上なら正常に出る（2コマ区間10個で20コマ、3コマ区間10個で30コマを実測）。
 *
 * 短くなった区間は落とさずに広げる。落とすと、言い淀みの合間に挟まった短い発話が
 * 消えてしまう（AGENTS.md「必要な話を消すほうが害が大きい」）。
 */
export const MIN_KEEP_FRAMES = 2;

/**
 * 切り出しの開始をコマの境目へ揃える。
 *
 * renderClip は -ss で入力シークするので、開始が半端な時刻だとシーク後のコマ格子が
 * そのぶんずれる。すると残す区間の端をコマ周期の整数倍にしても、trim（最寄りコマへ丸める）と
 * atrim（サンプル精度で切る）がまた食い違う。
 * 実測: 揃えないと seg.start=0.02 で103コマ中103コマ、0.10 で102コマ中52コマが1コマずれた。
 *
 * 【なぜ関数として出すか】pipeline.mjs と検査が同じ式を別々に書いていると、
 * pipeline 側から式を消しても検査が自前の写しで揃えてしまい、緑のままになる
 * （2026-08-08、independent-verifier の指摘で実際に起きていた）。
 */
export function snapStart(start, fps) {
  if (!Number.isFinite(fps) || fps <= 0) return start;
  return Math.round(start * fps) / fps;
}

export function snapToFrames(spans, fps) {
  if (!Number.isFinite(fps) || fps <= 0) return spans;
  const out = [];
  for (const s of spans) {
    const start = Math.round(s.start * fps) / fps;
    let end = Math.round(s.end * fps) / fps;
    let frames = Math.round((end - start) * fps);
    if (frames < MIN_KEEP_FRAMES) {
      // 短すぎる区間は、後ろへ広げて最短の長さにする（落とさない）
      frames = MIN_KEEP_FRAMES;
      end = start + frames / fps;
    }
    // ここでは round3 しない。3桁に丸めるとコマ境界を表しきれず、揃えた意味が消える。
    out.push({ start, end });
  }
  // 広げた結果、隣とくっついたり重なったりすることがあるのでつなぎ直す。
  // つないだ区間もコマ境界のままなので、揃えた性質は保たれる。
  return mergeSpans(out);
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
 * @param {object} [opts]
 * @param {boolean} [opts.seamFade] 継ぎ目にフェードを掛けるか（既定 true）
 * @param {string} [opts.fpsRational] 素材の r_frame_rate（"30000/1001" のような分数の文字列）。
 *   渡すと、切る前に映像をこのコマ数/秒の等間隔へ揃える（下の【コマ数/秒が一定でない素材】参照）。
 *   渡さなければ従来どおり（何も前置しない）。
 * @returns {{videoSelect:string, audioSelect:string}|null} 全部残すなら null（フィルタ不要）
 */
export function buildTrimFilters(keep, opts = {}) {
  const withFade = opts.seamFade !== false;
  const fpsRational = normalizeFpsRational(opts.fpsRational);
  const spans = (keep || []).filter((s) => s && s.end > s.start);
  if (spans.length === 0) return null;

  // select ではなく trim/atrim + concat で組む。
  // select は「そのコマを通すか」の判定なので、音声の1コマ(約46ms)の途中に区間の端が
  // 来ると、そのコマが丸ごと通って尺が余る（実測: 1.000秒×2区間で2.043秒）。
  // 区間の数だけ余りが積み上がるので、尺を測る受入条件では致命的になる。
  // trim/atrim は指定した時刻ちょうどで切るため、この余りが出ない。
  //
  // 【コマ数/秒が一定でない素材（可変フレームレート＝VFR）】
  // trim=start=s:end=e は「pts が [s,e) に入るコマを通す」だけで、その区間の中に何コマ
  // 在るかは素材次第。画面録画は動きの無い間コマを間引くので、同じ (e-s) 秒でもコマ数が減る。
  // setpts=PTS-STARTPTS が区間の頭の欠けを畳み、concat が前の区間の実長の直後に繋ぐため、
  // 映像だけが短くなる。一方 atrim は (e-s) 秒ちょうど切るので、差が継ぎ目の数だけ積み上がる。
  // 実測（10区間×29/30秒・30fps から不規則に間引いた素材・平均18.8fps）:
  //   映像 180 コマ（正解 290 コマ）／音声 463 パケット。110 コマ＝3.67 秒ぶん絵が先に進む。
  // 端をコマの境目へ揃える snapToFrames はこの差に原理的に効かない（コマの「在る場所」が
  // 格子に乗っていないため）。
  //
  // 直し方: 切る前に fps フィルタで等間隔のコマ列へ揃える。間引かれた所は直前のコマが
  // 複製されるので、(e-s) 秒には必ず (e-s)*fps コマ在る状態になる。
  // 実測: 上の素材で 180 → 290 コマ（コマ数/秒が一定の素材での正解と完全一致）。
  //
  // ・区間ごとに書かず split で1回だけ掛ける（区間の数だけデコード後の処理が重複するため）。
  // ・fps の目標は r_frame_rate の**分数のまま**渡す。29.97 のように小数へ丸めると
  //   30000/1001 との差で約1万秒に1コマずれる（probeSize の Number 化した fps は使わない）。
  // ・コマ数/秒が一定の素材では恒等。だから「VFR かどうか」を判定する必要が無い。
  //
  // 【round は既定（near）のまま。down にしてはいけない】
  // fps フィルタの round は「入力のコマを、出力のどの枠へ入れるか」の丸め方。
  // 容器の時刻の刻みは細かくないので（Matroska は1ミリ秒）、素材のコマは k/30 秒ちょうどでは
  // なく 0.033 / 0.067 / 0.100 … のように 1ms 弱手前に載っている。down（切り捨て）にすると
  // 0.033×30=0.99 が枠0へ落ちて、出力の1コマ目に素材の2コマ目が入る。
  // 実測（この素材・10区間×29/30秒）: コマ数はどの round でも 290 で同じなのに、中身は
  //   near（既定）: コマ数が一定の素材で食い違い0 / 一定でない素材でも0
  //   down        : 一定の素材で 290 コマ中 100 コマ、一定でない素材で 63 コマが別のコマ
  //   up / inf    : 90 コマ / 55 コマ、zero: 100 コマ / 63 コマ
  // コマ数だけを見ていると down でも直ったように見えるので、中身で確かめること。
  const vSrc = (i) => (fpsRational ? `[sv${i}]` : "[0:v]");
  const fpsHead = fpsRational
    ? `[0:v]fps=fps=${fpsRational},split=${spans.length}`
      + `${spans.map((_, i) => `[sv${i}]`).join("")};`
    : "";
  const v = spans.map((s, i) =>
    `${vSrc(i)}trim=start=${fmt(s.start)}:end=${fmt(s.end)},setpts=PTS-STARTPTS[tv${i}]`);
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
    videoChain: `${fpsHead}${v.join(";")};${vLabels}concat=n=${spans.length}:v=1:a=0[tvout]`,
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

/**
 * fps フィルタへ渡すコマ数/秒を「分数の文字列」として受け取り、そのまま返す。
 *
 * 分数のまま持ち回るのが要点。小数へ直すと 30000/1001 と 29.97 の差
 * （約1万秒に1コマ）がそのまま音とのずれになる。
 * 分数の形をしていない値は null にして何も前置しない（従来どおりの動きに戻るだけ）。
 * ついでに、ここを通さない文字列がフィルタ式へ入り込むのを防ぐ
 * （フィルタ式は文字列連結で組むので、区切り文字が混ざると式ごと壊れる）。
 */
export function normalizeFpsRational(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!(num > 0) || !(den > 0)) return null;
  return `${num}/${den}`;
}

/** ffmpeg のフィルタ式へ入れる秒数（小数3桁で固定。指数表記にしない） */
function fmt(n) {
  // 小数6桁。3桁だとコマ境界（15fps なら 1/15=0.066667 秒）を表しきれず、
  // せっかく揃えた端が区間ごとに 0.3ms ほどずれて積み上がる。
  // 音声は atrim がこの値でちょうど切るので、桁を落とすとそのまま音のずれになる。
  return (Math.round(n * 1e6) / 1e6).toFixed(6);
}
