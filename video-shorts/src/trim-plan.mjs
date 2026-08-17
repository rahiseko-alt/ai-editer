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

/**
 * 詰めた継ぎ目に残す「言い終わりの余韻」（秒）。
 *
 * マスター指示（2026-08-16）「発言の後にだけ、余韻を0.3秒存在させる」。**前には付けない。**
 * この規則により、詰めたあとの継ぎ目はどれも必ずちょうど 0.3 秒の間になる
 * （元から 0.3 秒以下の間は、詰める余地が無いのでそのまま残る）。
 *
 * 直前に「残る発言」が無いとき（動画の冒頭など）は余韻を付けず、その区間は全部詰める。
 * 余韻は「発言の後」に置くものなので、置く相手が居なければ置きようがない。
 */
export const AFTER_SPEECH_MARGIN_SEC = 0.3;

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
 * @param {object} [opts.judge] AI の判断結果（G-EDIT-TRIM2）。渡すと、どれを消すかの決定権は
 *   こちらへ移り、固定の単語一覧(FILLERS)と長さの閾値(minSilence)は**候補を拾うためだけ**に
 *   使われる。渡さないときは従来どおり一覧と閾値だけで決める（CLI の後方互換）。
 *   - judge.isFiller(index, word, relWord) => boolean  その語を言い淀みとして消すか
 *     （relWord はクリップ相対の語そのもの。judge 側が素材の絶対時刻へ直すのに使う）
 *   - judge.cutSilence(start, end) => boolean  その無音を詰めてよいか（false＝会話の途中）
 * @returns {{keep: {start:number,end:number}[], cuts: {start:number,end:number,reason:string}[],
 *            keptSeconds: number, cutSeconds: number}}
 */
export function planTrim(words, opts = {}) {
  const minSilence = opts.minSilence ?? DEFAULT_MIN_SILENCE;
  const cutSilence = opts.cutSilence !== false;
  const cutFillers = opts.cutFillers !== false;
  // 息継ぎのために戻した間（クリップ相対秒）。ここは詰めない。
  const protect = (Array.isArray(opts.protect) ? opts.protect : [])
    .filter((r) => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start);
  const isProtected = (r) => protect.some((p) => r.start < p.end - 1e-9 && r.end > p.start + 1e-9);

  const judge = opts.judge && typeof opts.judge === "object" ? opts.judge : null;
  const judgeIsFiller =
    judge && typeof judge.isFiller === "function" ? judge.isFiller : null;
  const judgeCutSilence =
    judge && typeof judge.cutSilence === "function" ? judge.cutSilence : null;

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
  let idx = 0;
  for (const w of list) {
    if (w.start > cursor + 1e-9) regions.push({ start: cursor, end: w.start, kind: "silence" });
    const s = Math.max(cursor, w.start);
    if (w.end > s) {
      // 言い淀みかどうかの決定権は judge にある。judge が無いときだけ一覧で決める
      // （2026-08-16 以前の挙動。一覧は「あの」「その」を単体で含むため、判定を任せると
      //  「あの資料」の指示語まで消える。これがマスター指摘の実害(a)）。
      // 第3引数に語そのもの（クリップ相対の start/end を持つ）を渡す。judge 側は
      // クリップの開始位置を知っているので、これで素材の絶対時刻へ直して引き当てられる
      // （2026-08-16。添字だけを渡していたため、2本目以降のクリップで別の語の判定が
      //  使われ、指示語が誤カットされていた）。
      const filler = judgeIsFiller ? judgeIsFiller(idx, w.w, w) === true : isFiller(w.w);
      regions.push({ start: s, end: w.end, kind: filler ? "filler" : "word" });
    }
    cursor = Math.max(cursor, w.end);
    idx += 1;
  }
  if (duration > cursor + 1e-9) regions.push({ start: cursor, end: duration, kind: "tail" });

  const keep = [];
  const cuts = [];
  // 直前の区間を残したかどうか。「発言の後にだけ余韻を置く」ので、直前が残る発言のときだけ
  // 0.3秒を残す。冒頭のように直前が無い／直前も消した場合は余韻を置かない。
  let prevKept = false;
  for (const r of regions) {
    if (r.kind === "word") { keep.push(r); prevKept = true; continue; }
    // 末尾の無音は言い終わりの余韻として常に全部残す（ぶつ切りに聞こえるのを防ぐ既存の作法）。
    if (r.kind === "tail") { keep.push(r); prevKept = true; continue; }
    if (r.kind === "filler") {
      if (cutFillers) { cuts.push({ ...r, reason: "filler" }); prevKept = false; }
      else { keep.push(r); prevKept = true; }
      continue;
    }
    // 無音を詰めるか。judge があればその判断が決定権を持ち、無ければ長さの閾値で決める。
    // 息継ぎのために意図して戻した間（protect）は、判断に関わらず詰めない。ここを詰めると
    // breath が戻した間を trim が削り取り、機能が丸ごと無効化される（G-EDIT-BREATH-TRIM）。
    const wantCut = judgeCutSilence
      ? judgeCutSilence(r.start, r.end) === true
      : r.end - r.start >= minSilence;
    if (cutSilence && wantCut && !isProtected(r)) {
      // 直前が残る発言なら、その後ろ 0.3秒だけ余韻として残してから詰める。
      const margin = prevKept ? AFTER_SPEECH_MARGIN_SEC : 0;
      const cutFrom = r.start + margin;
      if (cutFrom >= r.end - 1e-9) {
        // 余韻のぶんで区間を使い切る＝詰める余地が無い。そのまま残す。
        keep.push(r);
        prevKept = true;
      } else {
        if (margin > 0) keep.push({ start: r.start, end: cutFrom, kind: "margin" });
        cuts.push({ start: cutFrom, end: r.end, reason: "silence" });
        prevKept = false;
      }
    } else { keep.push(r); prevKept = true; }
  }

  const merged = toFrameSpans(mergeSpans(keep), opts.fps);
  const keptSeconds = merged.reduce((a, s) => a + (s.end - s.start), 0);
  return {
    keep: merged,
    cuts: mergeCuts(cuts),
    keptSeconds: round3(keptSeconds),
    cutSeconds: round3(Math.max(0, duration - keptSeconds)),
  };
}

/**
 * 切り出しの開始をコマの境目へ揃える。
 *
 * renderClip は `-ss` で入力シークする。入力シークの後、**映像は「シーク位置以降に在る最初のコマ」**
 * から始まり（＝シーク位置がコマの途中なら、そのコマぶんだけ後ろにずれた所が先頭になる）、
 * **音声はシーク位置ちょうど**から始まる。つまり切り出した直後の時点で、映像の時間軸の原点と
 * 音声の時間軸の原点が最大1コマぶん食い違う。この食い違いは区間の切り方とは無関係に、
 * クリップ全体へ一定量の口パクずれとして残る（積み上がりはしないが消えもしない）。
 *
 * 開始をコマの境目へ揃えると、シーク位置が最初のコマの頭と一致するので、映像・音声とも
 * 原点が同じになる。実測（**コマ番号で切るようにした後**・15fps・目印つき素材・seg.start=1.02 秒。
 * tests/trim-sync-check.py の製品経路を通した結果）:
 *   揃える（1.02 → 1.0 秒へ）: 出力 92 コマ中、絵と音の食い違い 0 コマ
 *   揃えない（pipeline.mjs を `const segStart = seg.start;` に変えただけ）:
 *     出力 86 コマ中 **86 コマすべて**で絵が音より 1 コマ（66.7ms）先行
 * ＝コマ番号で切るようにしても、この揃えは独立して要る（積み上がりはしないが、
 *   クリップ全体に一定量の口パクずれとして残るため）。
 *
 * 【なぜ関数として出すか】pipeline.mjs と検査が同じ式を別々に書いていると、
 * pipeline 側から式を消しても検査が自前の写しで揃えてしまい、緑のままになる
 * （2026-08-08、independent-verifier の指摘で実際に起きていた）。
 */
export function snapStart(start, fps) {
  if (!Number.isFinite(fps) || fps <= 0) return start;
  return Math.round(start * fps) / fps;
}

/**
 * 残す区間を「素材の何コマ目から何コマ目まで」へ写す。
 *
 * 【なぜ秒ではなくコマ番号で持つか】ffmpeg の `trim` は時刻を丸めない。`trim=start=秒` は
 * 「そのコマの pts が半開区間 [start,end) に入るか」を見るだけの**選び方**で、区間の中に何コマ
 * 在るかは素材の pts 次第になる（Matroska の時刻の刻みは1ミリ秒なので、コマは k/fps 秒ちょうど
 * ではなく 0.033 / 0.067 / 0.100… に載る）。一方 `atrim=start=秒` は標本の数でちょうど切る。
 * だから秒で指定すると、区間ごとに最大1コマぶん映像と音声の長さが食い違う。
 * `trim=start_frame=a:end_frame=b` は pts を一切見ず、到着したコマを数えるだけなので
 * **必ずちょうど b−a コマ**を通す。そのためにコマ番号を先に決めておく。
 *
 * 【なぜ planTrim の側で決めるか】pipeline.mjs は同じ keep を remapWords へも渡して
 * 字幕の時刻を写す。buildTrimFilters の側だけで決めると、字幕だけ別の時間軸に残る。
 *
 * 端は最寄りのコマへ写す（四捨五入）。写した結果 0 コマになる区間は 1 コマへ広げる。
 * 落とすと、言い淀みの合間に挟まった短い発話が消えてしまう
 * （AGENTS.md「必要な話を消すほうが害が大きい」）。1コマの区間は `end_frame − start_frame = 1`
 * なので、構成上かならず 1 コマ出る（旧 MIN_KEEP_FRAMES=2 の水増しは要らなくなった）。
 *
 * fps が取れなかった素材（r_frame_rate が 0/0 等）ではコマ番号を付けずに秒のまま返す。
 *
 * @param {{start:number,end:number}[]} spans
 * @param {number} fps
 * @returns {{start:number,end:number,startFrame?:number,endFrame?:number}[]}
 */
export function toFrameSpans(spans, fps) {
  if (!Number.isFinite(fps) || fps <= 0) {
    return (spans || []).map((s) => ({ start: s.start, end: s.end }));
  }
  const out = [];
  for (const s of spans || []) {
    const startFrame = Math.round(s.start * fps);
    const endFrame = Math.max(startFrame + 1, Math.round(s.end * fps));
    // ここでは round3 しない。3桁に丸めるとコマ境界を表しきれず、写した意味が消える。
    out.push({ start: startFrame / fps, end: endFrame / fps, startFrame, endFrame });
  }
  return mergeFrameSpans(out, fps);
}

/** コマ番号で見て、隣り合う・重なる区間をつなぐ */
function mergeFrameSpans(spans, fps) {
  const sorted = spans.slice().sort((a, b) => a.startFrame - b.startFrame);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.startFrame <= last.endFrame) {
      last.endFrame = Math.max(last.endFrame, s.endFrame);
      last.end = last.endFrame / fps;
    } else {
      out.push({ ...s });
    }
  }
  return out;
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
 * 音声の標本化周波数が分からないときに使う値。
 *
 * この値は「当てずっぽうの前提」にはならない。式の先頭で `aresample` を掛けて
 * 実際にこの周波数へ揃えてから標本の番号で切るので、素材が何 Hz でも、
 * 切る位置の**秒**は必ず狙いどおりになる（下の buildTrimFilters の注を参照）。
 */
export const DEFAULT_SAMPLE_RATE = 48000;

/**
 * 残す区間だけを取り出してつなぐ ffmpeg のフィルタ式を組み立てる。
 *
 * 【要点1: 映像と音声を1本の concat で繋ぐ】
 * concat フィルタの公式説明（doc/filters.texi）:
 *   "related synchronized streams (e.g. a video and its audio track) should be concatenated at once.
 *    The concat filter will use the duration of the longest stream in each segment,
 *    and if necessary pad shorter audio streams with silence."
 * 実装（libavfilter/avf_concat.c）でも、`find_next_delta_ts` がセグメントごとに全ストリームの
 * 終端 pts の**最大**を取って `delta_ts` を共有し、`flush_segment` が足りない音声を無音で埋める。
 * つまり1本にすれば、区間ごとの端数は継ぎ目ごとにその場で清算され、次の区間へ持ち越されない。
 * 映像用と音声用に concat を2本へ分けると、この清算が起きず、区間の数だけ差が積み上がる。
 * 実測（この直しの前・15fps・区間長 29/30秒・開始オフセット 1/30秒）:
 *   区間2個 -67ms / 5個 -167ms / 10個 -333ms / 20個 -673ms（＝継ぎ目の数に比例）。
 *
 * 【要点2: 秒ではなくコマ番号・標本番号で切る】
 * `trim`（libavfilter/trim.c）の判定は pts を見ず、到着したコマを数える `nb_frames` だけを見る:
 *   if (s->start_frame >= 0 && s->nb_frames >= s->start_frame)   drop = 0;
 *   if (s->end_frame != INT64_MAX && s->nb_frames < s->end_frame) drop = 0;
 * だから `trim=start_frame=a:end_frame=b` は**必ずちょうど b−a コマ**を通す。
 * 容器の時刻の刻み（Matroska は1ミリ秒）・コマ数/秒が一定でない素材・`-ss` の格子ずれの
 * いずれとも無関係になる。`atrim=start_sample=A:end_sample=B` も同じで、**必ずちょうど B−A 標本**。
 * 秒で指定していた頃は、映像が「pts が [s,e) に入るコマ」の選択、音声が標本ちょうどの切り出しに
 * なるため、区間ごとに最大1コマぶん食い違っていた。
 *
 * 【要点3: 標本の番号は「絶対の端点の差」で出す】
 *   A = a * sr * den / num（整数の割り算）/ B = b * sr * den / num → 標本数 = B − A
 * 区間ごとに長さを丸めて足すのではなく、絶対の端点をそれぞれ写してから引く。
 * こうすると丸めの誤差が望遠鏡的に打ち消え、区間をいくつ並べても積み上がらない。
 *
 * 【コマ数/秒が一定でない素材（可変フレームレート＝VFR）】
 * 画面録画は動きの無い間コマを間引くので、同じ (e−s) 秒でもコマ数が減る。コマ番号で切る場合、
 * 「a コマ目」が指す時刻が素材によってばらつくと、絵と音の対応が崩れる。
 * そこで切る前に `fps` フィルタで等間隔のコマ列へ揃える。間引かれた所は直前のコマが複製され、
 * どの素材でも「a コマ目 ＝ a/fps 秒」が成り立つ。
 * ・区間ごとに書かず split で1回だけ掛ける（区間の数だけデコード後の処理が重複するため）。
 * ・fps の目標は r_frame_rate の**分数のまま**渡す。29.97 のように小数へ丸めると
 *   30000/1001 との差で約1万秒に1コマずれる（probeSize の Number 化した fps は使わない）。
 * ・コマ数/秒が一定の素材では恒等。だから「VFR かどうか」を判定する必要が無い。
 * 【round は既定（near）のまま。down にしてはいけない】
 * 容器の時刻の刻みは細かくないので、素材のコマは k/fps 秒ちょうどではなく 1ms 弱手前に載る。
 * down（切り捨て）にすると 0.033×30=0.99 が枠0へ落ち、出力の1コマ目に素材の2コマ目が入る。
 * 実測（間引いた素材・10区間）: コマ数はどの round でも同じなのに、中身は near で食い違い0、
 * down で 63 コマ、up/inf で 55 コマ、zero で 63 コマが別のコマになる。
 *
 * 【音声側も同じ理由で aresample を1回だけ前置する】
 * `atrim` の標本番号は、そのフィルタへ届く音声の標本化周波数で数える。式を組む側が周波数を
 * 取り違えると切る秒がずれるので、**式の中で実際にその周波数へ揃えてしまう**。
 * こうすると「呼び出し側が正しい周波数を渡したか」に結果が依存しない（渡せば無変換で素通り）。
 *
 * @param {{start:number,end:number,startFrame?:number,endFrame?:number}[]} keep
 *   残す区間（時刻の順・重なり無し）。planTrim が付けたコマ番号があればそれを使う。
 * @param {object} [opts]
 * @param {boolean} [opts.seamFade] 継ぎ目にフェードを掛けるか（既定 true）
 * @param {string} [opts.fpsRational] 素材の r_frame_rate（"30000/1001" のような分数の文字列）
 * @param {number} [opts.sampleRate] 素材の音声の標本化周波数（既定 48000）
 * @param {boolean} [opts.hasAudio] 素材に音声ストリームが有るか（既定 true）。
 *   false のときは `[0:a]` を一切参照しない映像のみの式を組む（AUD-S-02）。
 *   音声トラックが無い素材に対して `[0:a]` を参照すると、そのラベルが存在しないため
 *   ffmpeg が「Stream specifier ':a' in filtergraph ... matches no streams」で落ちる。
 *   通常経路は上流の無音声検出でこの入口を通らないよう守られているが、renderClip() を
 *   直接 keep 付きで呼ぶ経路（テスト・将来の呼び出し側）ではこのガードが無いため、
 *   ここで音声の有無に応じて式そのものを変える。
 * @returns {{chain:string, count:number, hasAudio:boolean,
 *            spans:{startFrame:number|null,endFrame:number|null,
 *                   startSample:number|null,endSample:number|null}[]}|null}
 *   全部残すなら null（フィルタ不要）。chain は [tvout]（映像）を作り、hasAudio が true の
 *   ときだけ加えて [taout]（音声）も作る1本の式。
 */
export function buildTrimFilters(keep, opts = {}) {
  const withFade = opts.seamFade !== false;
  const hasAudio = opts.hasAudio !== false; // 既定は従来どおり「音声あり」
  const rat = parseFpsRational(opts.fpsRational);
  const sr = Number.isFinite(opts.sampleRate) && opts.sampleRate > 0
    ? Math.round(opts.sampleRate)
    : DEFAULT_SAMPLE_RATE;
  const spans = (keep || []).filter((s) => s && s.end > s.start);
  if (spans.length === 0) return null;
  const n = spans.length;

  // 各区間を「コマ番号の区間」と「標本番号の区間」へ写す。
  // コマ番号は planTrim が付けたものを優先し、無ければ分数のコマ数/秒から写す。
  // どちらも無い（コマ数/秒がまったく取れなかった）ときだけ、秒で切る従来の形へ落ちる。
  const cuts = spans.map((s) => {
    const a = Number.isInteger(s.startFrame) ? s.startFrame
      : (rat ? Math.round((s.start * rat.num) / rat.den) : null);
    const bRaw = Number.isInteger(s.endFrame) ? s.endFrame
      : (rat ? Math.round((s.end * rat.num) / rat.den) : null);
    const b = (a !== null && bRaw !== null) ? Math.max(a + 1, bRaw) : null;
    // 標本番号も「絶対の端点」から出す（区間ごとの長さを丸めて足さない）。
    const A = (rat && a !== null) ? Math.floor((a * sr * rat.den) / rat.num)
      : Math.round(s.start * sr);
    const BRaw = (rat && b !== null) ? Math.floor((b * sr * rat.den) / rat.num)
      : Math.round(s.end * sr);
    return { a, b, A, B: Math.max(A + 1, BRaw), start: s.start, end: s.end };
  });

  const labels = (p) => cuts.map((_, i) => `[${p}${i}]`).join("");
  const vHead = rat
    ? `[0:v]fps=fps=${rat.num}/${rat.den},split=${n}${labels("sv")};`
    : `[0:v]split=${n}${labels("sv")};`;
  // hasAudio=false のときはヘッダ自体を組まない（`[0:a]` を式のどこにも書かない）。
  const aHead = hasAudio ? `[0:a]aresample=${sr},asplit=${n}${labels("sa")};` : "";

  const v = cuts.map((c, i) => {
    const cut = c.a !== null
      ? `trim=start_frame=${c.a}:end_frame=${c.b}`
      : `trim=start=${fmt(c.start)}:end=${fmt(c.end)}`;
    return `[sv${i}]${cut},setpts=PTS-STARTPTS[tv${i}]`;
  });

  // 継ぎ目の前後にごく短いフェードを掛ける。掛けないと、波形が途中で急に切り替わって
  // 「プツッ」という音が入る（葉D が防ぎたい状態）。
  // 長さは SEAM_FADE_SEC。耳に「消えた」と分からない範囲で、跳ねだけを均す。
  // ここも標本の数で指定する（秒で書くと afade の中でまた丸めが起きる）。
  const a = hasAudio ? cuts.map((c, i) => {
    const len = c.B - c.A;
    const fade = Math.min(Math.round(SEAM_FADE_SEC * sr), Math.floor(len / 4));
    const fadeIn = (!withFade || i === 0 || fade < 1) ? "" : `,afade=t=in:ss=0:ns=${fade}`;
    const fadeOut = (!withFade || i === n - 1 || fade < 1) ? ""
      : `,afade=t=out:ss=${len - fade}:ns=${fade}`;
    return `[sa${i}]atrim=start_sample=${c.A}:end_sample=${c.B},asetpts=PTS-STARTPTS`
      + `${fadeIn}${fadeOut}[ta${i}]`;
  }) : [];

  // concat の入力は音声ありなら [映像0][音声0][映像1][音声1]… の交互順（v=1:a=1）、
  // 音声無しなら [映像0][映像1]… の映像だけの並び（v=1:a=0・[taout]は作らない）。
  const pairs = cuts.map((_, i) => (hasAudio ? `[tv${i}][ta${i}]` : `[tv${i}]`)).join("");
  const concatOut = hasAudio ? "[tvout][taout]" : "[tvout]";
  const parts = [vHead, aHead, `${v.join(";")};`];
  if (hasAudio) parts.push(`${a.join(";")};`);
  parts.push(`${pairs}concat=n=${n}:v=1:a=${hasAudio ? 1 : 0}${concatOut}`);

  return {
    chain: parts.join(""),
    count: n,
    hasAudio,
    spans: cuts.map((c) => ({
      startFrame: c.a, endFrame: c.b,
      startSample: hasAudio ? c.A : null, endSample: hasAudio ? c.B : null,
    })),
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
  const r = parseFpsRational(raw);
  return r ? `${r.num}/${r.den}` : null;
}

/** 分数の文字列を {num, den} へ。分数の形をしていなければ null。 */
function parseFpsRational(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!(num > 0) || !(den > 0)) return null;
  return { num, den };
}

/**
 * ffmpeg のフィルタ式へ入れる秒数（小数6桁で固定。指数表記にしない）。
 *
 * **コマ数/秒がまったく取れなかった素材でしか使わない**。それ以外の経路は
 * コマ番号・標本番号で切るので、フィルタ式に秒は現れない。
 */
function fmt(n) {
  return (Math.round(n * 1e6) / 1e6).toFixed(6);
}
