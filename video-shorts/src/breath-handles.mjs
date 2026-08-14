// video-shorts ダイジェスト用: つなぎ目に「息継ぎの間」を戻す。
//
// 背景（2026-08-14 実素材のダイジェストを見たマスターの指摘「つなぎ目がぎちぎちすぎる。
// 一呼吸or半呼吸の間があるとより自然になる」。docs/failures.md 参照）:
// 逆マッチング（src/reverse-match.mjs）が返す区間は Whisper の**単語境界ちょうど**なので、
// 素材に元々あった文と文の間の無音（実素材で 0.4〜0.9 秒）が全部捨てられる。結果、
// 発話が終わった瞬間に次の発話が始まる「詰まった」音になる。
//
// === 方針（プロの台詞編集の基礎に沿う。出典は下記） ===
//  1. 合成の無音を挿入しない。素材の**ルームトーン（現場の環境音）ごと**前後へ伸ばす。
//     「完全な無音は人間が経験しないので不自然に聞こえる」ため、無音を足すのではなく
//     元々そこに在った環境音を捨てずに残す、という考え方。
//  2. 伸ばす先は必ず **silencedetect で実測した無音区間の内側**に収める。これにより
//     「カットしたはずの発話が戻ってくる」ことが構造的に起きない（最重要の故障モード）。
//  3. 素材上で連続する区間は**統合して分割しない**。要らないつなぎ目を作らないのが
//     最良のつなぎであり、同時に「隣接区間が重なって同じ発話が二重再生される」
//     （pipeline.mjs が digest で余韻パディングを見送っていた理由＝R-7b/c）も起きない。
//  4. 間の長さは一律にしない。素材が元々持っていた間を上限とし、話題の変わり目
//     （＝間に発話を捨てた実カット）には一呼吸、同一話題内には半呼吸が付く。
//
// 出典（2026-08-14 調査）:
//   https://www.production-expert.com/production-expert-1/5-techniques-for-dialogue-editing-in-film-and-tv
//   https://filmpac.com/5-tricks-to-seamlessly-edit-dialogue/
//   https://ruahcreativehouse.org/blog/video-editing-tips/
//   https://note.com/nvr_nvrlnd/n/n4ce3c247b0fd
//
// 【残課題（backlog）】音のカット端へ 10〜50ms のフェードを掛ける定石は未実装。
// 本実装ではカット点が必ず無音区間の内側に入るため波形が0付近で繋がり、プチッという
// ノイズは構造的に出にくい。無音が全く無い箇所（伸ばせない箇所）だけは従来どおり
// 素の切り口になる。renderClip の音声経路（trim 有無で filter_complex/簡易フィルタが
// 分岐する）へ手を入れる必要があるため別葉として切り出す。

import { spawn } from "node:child_process";
import { snapStart } from "./trim-plan.mjs";

/** 既定の「一呼吸」＝つなぎ目に作る間の上限（秒）。素材が持つ間がこれより短ければそちらが優先。 */
export const DEFAULT_MAX_PAUSE_SEC = 0.7;
/** 先頭・末尾に残す余白（秒）。いきなり始まって唐突に終わるのを防ぐ。 */
export const DEFAULT_EDGE_PAD_SEC = 0.35;
/** 無音とみなす音量のしきい値（dB）。 */
export const SILENCE_NOISE_DB = -40;
/** 無音とみなす最短の長さ（秒）。これ未満の谷は「間」ではなく発話の一部として扱う。 */
export const SILENCE_MIN_SEC = 0.2;
/** 無音区間の端から内側へ必ず空ける余裕（秒）。隣の発話の立ち上がり／余韻を食わないための安全代。 */
export const SILENCE_MARGIN_SEC = 0.02;
/**
 * 単語境界（Whisper）と音響的な無音境界（silencedetect）のずれの許容（秒）。
 * この範囲で接していれば「その無音区間が、この区間の隣にある」とみなす。
 *
 * 実素材（2026-08-14）では、単語の終わり 99.58s に対し音響的な無音の始まりが 99.67s と
 * 0.09 秒ずれていた（＝発話の余韻ぶん）。ここを 0.08 秒にしていたため無音を見つけられず、
 * 本来ひと続きに繋がるはずの2区間が統合されず 0.27 秒の不要なカットが残った。
 * 余韻は残す側の発話自身のものなので、0.15 秒までは「隣接している」とみなしてよい。
 * 誤って捨てた発話へ届かないことは、下の単語境界による上限（hardUpper/hardLower）が
 * 独立に保証する（無音・単語境界の二重の縛り）。
 */
export const BOUNDARY_TOLERANCE_SEC = 0.15;

/**
 * ffmpeg silencedetect の stderr を無音区間の配列へ変換する。
 * silence_start だけで終わっている（素材末尾まで無音）場合は endFallback で閉じる。
 * @param {string} stderr
 * @param {number} [endFallback] 末尾が閉じていないときに使う終端秒
 * @returns {{start:number,end:number}[]} 時系列昇順
 */
export function parseSilenceLog(stderr, endFallback = null) {
  const out = [];
  let open = null;
  // silence_start / silence_end は同一行に混在しうる（進捗行と結合する）ので行単位ではなく
  // トークン単位で拾う。
  const re = /silence_(start|end):\s*(-?[0-9.]+)/g;
  let m;
  while ((m = re.exec(stderr || "")) !== null) {
    const kind = m[1];
    const t = Number(m[2]);
    if (!Number.isFinite(t)) continue;
    if (kind === "start") {
      open = Math.max(0, t);
    } else if (open !== null) {
      if (t > open) out.push({ start: open, end: t });
      open = null;
    }
  }
  if (open !== null && Number.isFinite(endFallback) && endFallback > open) {
    out.push({ start: open, end: endFallback });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * 素材の無音区間を ffmpeg silencedetect で実測する。
 * 失敗しても throw せず空配列を返す（間が付かないだけで、従来どおりの出力になる）。
 * @param {string} input 素材のパス
 * @param {{noiseDb?:number,minSec?:number,duration?:number}} [opts]
 * @returns {Promise<{start:number,end:number}[]>}
 */
export function detectSilences(input, opts = {}) {
  const noiseDb = Number.isFinite(opts.noiseDb) ? opts.noiseDb : SILENCE_NOISE_DB;
  const minSec = Number.isFinite(opts.minSec) && opts.minSec > 0 ? opts.minSec : SILENCE_MIN_SEC;
  const args = [
    "-hide_banner", "-nostats",
    "-i", input,
    "-af", `silencedetect=noise=${noiseDb}dB:d=${minSec}`,
    "-f", "null", "-",
  ];
  return new Promise((resolve) => {
    let stderr = "";
    let proc;
    try {
      proc = spawn("ffmpeg", args, { windowsHide: true });
    } catch {
      resolve([]);
      return;
    }
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", () => resolve([]));
    proc.on("close", (code) => {
      if (code !== 0) { resolve([]); return; }
      resolve(parseSilenceLog(stderr, opts.duration));
    });
  });
}

/** t の左側に接している（または t を含む）無音区間を返す。無ければ null。 */
function regionLeftOf(silences, t) {
  let best = null;
  for (const r of silences) {
    if (r.start <= t + 1e-9 && r.end >= t - BOUNDARY_TOLERANCE_SEC) {
      if (!best || r.start > best.start) best = r;
    }
  }
  return best;
}

/** t の右側に接している（または t を含む）無音区間を返す。無ければ null。 */
function regionRightOf(silences, t) {
  let best = null;
  for (const r of silences) {
    if (r.end >= t - 1e-9 && r.start <= t + BOUNDARY_TOLERANCE_SEC) {
      if (!best || r.end < best.end) best = r;
    }
  }
  return best;
}

/** t から前へ伸ばせる下限（これより前へは伸ばさない）。伸ばせなければ t 自身。 */
function lowerBoundFor(silences, t) {
  const r = regionLeftOf(silences, t);
  if (!r) return t;
  return Math.min(t, r.start + SILENCE_MARGIN_SEC);
}

/** t から後ろへ伸ばせる上限（これより後ろへは伸ばさない）。伸ばせなければ t 自身。 */
function upperBoundFor(silences, t) {
  const r = regionRightOf(silences, t);
  if (!r) return t;
  return Math.max(t, r.end - SILENCE_MARGIN_SEC);
}

/**
 * 区間列に「息継ぎの間」を戻し、素材上で連続するものを統合した再生部品の列にする。
 *
 * @param {{start:number,end:number,hook?:string,keepText?:string}[]} segments
 *   逆マッチングで確定した区間（台本順。時系列とは限らない）
 * @param {{start:number,end:number}[]} silences 素材の無音区間（detectSilences の結果）
 * @param {{maxPauseSec?:number,edgePadSec?:number,fps?:number|null,srcDuration?:number,
 *          words?:{start:number,end:number}[]}} [opts]
 *   words を渡すと、隣の発話（＝台本から捨てた発話を含む）へ絶対に届かないよう上限を追加する。
 * @returns {{parts:{start:number,end:number,duration:number,hook:string,keepText:string,
 *            members:number[]}[], joins:{afterPart:number,pauseSec:number,removedSec:number}[]}}
 */
export function planBreathParts(segments, silences, opts = {}) {
  const segs = Array.isArray(segments) ? segments : [];
  if (segs.length === 0) return { parts: [], joins: [] };
  const maxPause = Number.isFinite(opts.maxPauseSec) && opts.maxPauseSec >= 0
    ? opts.maxPauseSec : DEFAULT_MAX_PAUSE_SEC;
  const edgePad = Number.isFinite(opts.edgePadSec) && opts.edgePadSec >= 0
    ? opts.edgePadSec : Math.min(DEFAULT_EDGE_PAD_SEC, maxPause / 2);
  const sil = Array.isArray(silences) ? silences.slice().sort((a, b) => a.start - b.start) : [];
  const srcDur = Number.isFinite(opts.srcDuration) && opts.srcDuration > 0 ? opts.srcDuration : Infinity;
  const fps = Number.isFinite(opts.fps) && opts.fps > 0 ? opts.fps : null;

  // 1) つなぎ目ごとに狙う間の長さを決める。
  //    素材が元々そこに持っていた間（gap）を上限にする＝素材より長い間は作らない。
  //    gap が大きい（＝間の発話を捨てた実カット）ときだけ maxPause（一呼吸）まで使う。
  const desiredPre = new Array(segs.length).fill(0);
  const desiredPost = new Array(segs.length).fill(0);
  const targets = new Array(Math.max(0, segs.length - 1)).fill(0);
  desiredPre[0] = edgePad;
  desiredPost[segs.length - 1] = edgePad;
  for (let i = 0; i < segs.length - 1; i++) {
    const gap = segs[i + 1].start - segs[i].end;
    // gap <= 0 は台本が時系列を並べ替えた場合（digest は並べ替えを許す）。素材上の間が
    // 存在しないので、狙いは maxPause とする。
    const target = gap > 0 ? Math.min(gap, maxPause) : maxPause;
    targets[i] = target;
    desiredPost[i] = target / 2;
    desiredPre[i + 1] = target / 2;
  }

  // 2) 実測の無音区間の内側へクランプしながら伸ばす。
  //    words があれば「隣の発話の手前まで」という上限も重ねる。無音の検出しきい値や
  //    最短長の設定に関わらず、捨てた発話へ届かないことをこちらが独立に保証する
  //    （＝「カットした言葉が戻ってこない」を二重の縛りで担保する）。
  const words = Array.isArray(opts.words) ? opts.words : null;
  const hardLowerFor = (t) => {
    if (!words) return 0;
    let best = 0;
    for (const w of words) if (w.end <= t + 1e-9 && w.end > best) best = w.end;
    return best;
  };
  const hardUpperFor = (t) => {
    if (!words) return srcDur;
    let best = srcDur;
    for (const w of words) if (w.start >= t - 1e-9 && w.start < best) best = w.start;
    return best;
  };
  const lower = segs.map((s) => Math.max(lowerBoundFor(sil, s.start), hardLowerFor(s.start)));
  const upper = segs.map((s) => Math.min(upperBoundFor(sil, s.end), hardUpperFor(s.end)));
  const newStart = segs.map((s, i) => Math.max(lower[i], s.start - desiredPre[i], 0));
  const newEnd = segs.map((s, i) => Math.min(upper[i], s.end + desiredPost[i], srcDur));

  // 3) 片側が無音不足で伸ばせなかったぶんを、もう片側で埋め合わせる（狙いの合計に近づける）。
  for (let i = 0; i < segs.length - 1; i++) {
    let short = targets[i] - ((newEnd[i] - segs[i].end) + (segs[i + 1].start - newStart[i + 1]));
    if (short <= 1e-6) continue;
    const roomPost = upper[i] - newEnd[i];
    if (roomPost > 0) {
      const add = Math.min(short, roomPost);
      newEnd[i] += add;
      short -= add;
    }
    if (short <= 1e-6) continue;
    const roomPre = newStart[i + 1] - lower[i + 1];
    if (roomPre > 0) newStart[i + 1] -= Math.min(short, roomPre);
  }

  // 4) コマの境目へ揃える（renderClip の入力シークと同じ式）。
  const snapT = (t) => (fps ? snapStart(t, fps) : t);
  for (let i = 0; i < segs.length; i++) {
    newStart[i] = Math.max(0, snapT(newStart[i]));
    newEnd[i] = Math.min(srcDur, snapT(newEnd[i]));
  }

  // 5) 素材上で連続する（伸ばした結果くっついた）区間を統合し、要らないつなぎ目を作らない。
  //    統合してよいのは時系列で前後関係が保たれている場合だけ（台本が並べ替えた区間は繋がない）。
  const parts = [];
  for (let i = 0; i < segs.length; i++) {
    const cur = {
      start: newStart[i],
      end: newEnd[i],
      hook: segs[i].hook || "",
      keepText: segs[i].keepText || "",
      // 区間照合の確からしさ。pipeline.mjs が candidates.json へ書き出し、選別画面が表示する。
      // ここで落とすと digest の候補だけ確からしさが消えて選べなくなる。
      confidence: segs[i].confidence,
      members: [i],
    };
    const prev = parts[parts.length - 1];
    const chronological = prev && segs[i].start >= segs[prev.members[prev.members.length - 1]].end - 1e-9;
    if (prev && chronological && cur.start <= prev.end + 1e-9) {
      prev.end = Math.max(prev.end, cur.end);
      prev.members.push(i);
      // 統合した部品の確からしさは、含まれる区間のうち最も低いものに合わせる（安全側）。
      // 高い方に合わせると、照合が怪しい区間が混ざっているのに「確か」と表示されてしまう。
      if (Number.isFinite(cur.confidence)) {
        prev.confidence = Number.isFinite(prev.confidence)
          ? Math.min(prev.confidence, cur.confidence) : cur.confidence;
      }
      if (cur.keepText) prev.keepText = `${prev.keepText} ${cur.keepText}`.trim();
      continue;
    }
    parts.push(cur);
  }
  for (const p of parts) p.duration = Math.round((p.end - p.start) * 1000) / 1000;

  // 5-b) 「息継ぎのために戻した区間」を部品ごとに記録する（素材時間）。
  //   後段の trim（無音・言い淀みを詰める）は 0.2 秒以上の無音を機械的に全部詰めるので、
  //   ここで戻した間もろとも削ってしまい、この機能が丸ごと無効化される
  //   （basis-reviewer 実測: trim=on で 0.7 秒の間が 0.39 秒へ、0.5 秒の間と先頭余白は消滅）。
  //   詰める目的（言い淀み・長すぎる沈黙を削る）は保ったまま、意図して戻した間だけを
  //   守れるよう、保護する区間を planTrim へ渡せる形で持たせる。
  for (const p of parts) {
    const ranges = [];
    const first = segs[p.members[0]];
    const last = segs[p.members[p.members.length - 1]];
    ranges.push({ start: p.start, end: first.start });          // 先頭に足した余白
    for (let k = 0; k < p.members.length - 1; k++) {            // 統合でそのまま残した素材上の間
      ranges.push({ start: segs[p.members[k]].end, end: segs[p.members[k + 1]].start });
    }
    ranges.push({ start: last.end, end: p.end });               // 末尾に足した余白
    p.protect = ranges.filter((r) => r.end > r.start + 1e-9);
  }

  // 6) 実際にできたつなぎ目の間を報告用に測る（部品iの最後の発話終わり→部品i+1の最初の発話始まり）。
  const joins = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const lastSeg = segs[parts[i].members[parts[i].members.length - 1]];
    const nextSeg = segs[parts[i + 1].members[0]];
    const pauseSec = (parts[i].end - lastSeg.end) + (nextSeg.start - parts[i + 1].start);
    joins.push({
      afterPart: i,
      pauseSec: Math.round(pauseSec * 1000) / 1000,
      removedSec: Math.round((nextSeg.start - lastSeg.end) * 1000) / 1000,
    });
  }
  return { parts, joins };
}

/**
 * `--breath` の値を解釈する。`off`/`none`/`0` は無効化（null）を返す。
 * @param {string|undefined} raw
 * @returns {{ok:true,sec:number|null}|{ok:false,reason:string}}
 */
export function parseBreathOption(raw) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, sec: DEFAULT_MAX_PAUSE_SEC };
  const s = String(raw).trim().toLowerCase();
  if (s === "off" || s === "none" || s === "なし") return { ok: true, sec: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, reason: `--breath は秒数（0以上）か off を指定してください: ${raw}` };
  }
  if (n > 5) return { ok: false, reason: `--breath は5秒以下にしてください（指定: ${raw}）` };
  if (n === 0) return { ok: true, sec: null };
  return { ok: true, sec: n };
}
