// video-shorts [5] FFmpeg縦化＋字幕焼き — 区間を切り出し 9:16 中央crop→scale→字幕焼き。
// 落とし穴#2(字幕焼きは再エンコード・音声は -c:a copy 不可なので別扱い)
// 落とし穴#3(中央拡大は crop 先 → scale 後)。
//
// 注意: 字幕(subtitles filter)を使うと映像は必ず再エンコードされる。音声は変換不要なので
//       -c:a copy で無劣化コピーする（落とし穴#2の正しい解釈）。

import { spawn } from "node:child_process";
import path from "node:path";

import { buildTrimFilters } from "./trim-plan.mjs";

// 向き別の出力解像度。portrait=縦型(SNSリール等)、landscape=横型(画面録画・細かい文字を残す)。
const ORIENT = { portrait: [1080, 1920], landscape: [1920, 1080] };
const DEFAULT_ORIENT = "portrait";

/**
 * 拡大ガード込みの実際の出力canvas(W,H)を算出する。
 * 素材(srcW,srcH)が既定ターゲットより小さい場合、無理に拡大しないターゲットへ縮小する
 * （432x766素材を1080x1920へ6.2倍拡大しても画質向上ゼロで負荷だけ増える＝実測差分あり）。
 * k = min(TARGET_W/srcW, TARGET_H/srcH)。k>1（=そのままだと拡大）なら
 * even(TARGET_W/k) x even(TARGET_H/k) へ縮小（h264は偶数幅高さが必須）。
 * env FORCE_TARGET_RES=1 でガード無効化（オプトアウト）。
 * @returns {{w:number, h:number, guarded:boolean}}
 */
export function computeCanvas(orientation, srcW, srcH) {
  const [TARGET_W, TARGET_H] = ORIENT[orientation] || ORIENT[DEFAULT_ORIENT];
  const forceTarget = process.env.FORCE_TARGET_RES === "1";
  if (!forceTarget && srcW && srcH && srcW > 0 && srcH > 0) {
    const k = Math.min(TARGET_W / srcW, TARGET_H / srcH);
    if (k > 1) {
      const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
      return { w: even(TARGET_W / k), h: even(TARGET_H / k), guarded: true };
    }
  }
  return { w: TARGET_W, h: TARGET_H, guarded: false };
}

/**
 * 入力動画(16:9想定)から区間を切り出し、9:16縦型に中央crop→scaleし、ASS字幕を焼く。
 * crop先→scale後（落とし穴#3）。映像は再エンコード・音声は -c:a copy（落とし穴#2）。
 *
 * @param {object} p
 * @param {string} p.input 入力mp4
 * @param {number} p.start 開始秒
 * @param {number} p.end 終了秒
 * @param {string} p.assPath 焼き込む .ass 字幕パス（無ければ字幕なし）
 * @param {string} p.output 出力mp4
 * @param {number} [p.srcW] 素材の実横幅（拡大ガード用。省略時はガード無効）
 * @param {number} [p.srcH] 素材の実縦幅（拡大ガード用。省略時はガード無効）
 * @param {{start:number,end:number}[]} [p.keep] 残す区間（区間先頭を0とした相対秒）。
 *   渡すと、その区間だけを取り出してつなぐ（無音・言い淀みを詰める）。
 *   省略すると従来どおり、切り出した区間をそのまま焼く。
 * @returns {Promise<{cmd:string, output:string}>}
 */
export function renderClip(p) {
  const dur = Math.max(0.1, p.end - p.start);
  const canvas = computeCanvas(p.orientation, p.srcW, p.srcH);
  const TARGET_W = canvas.w;
  const TARGET_H = canvas.h;
  if (canvas.guarded) {
    process.stderr.write(
      `[INFO] 拡大ガード: 素材${p.srcW}x${p.srcH} → 出力${TARGET_W}x${TARGET_H}（拡大なし）\n`
    );
  }
  const assFilter = p.assPath
    ? `,ass='${escapeFilterPath(p.assPath)}'`
    : "";
  // 素材そのまま方式: 拡大ぼかし帯のような余分な処理はしない。
  // 元映像をアスペクト比維持で TARGET へ収め(decrease)、余白は黒帯(pad)で埋めるだけ。
  //  - portrait(1080x1920): 顔出しトーク向け。16:9素材は中央に縮小され上下に黒帯。
  //  - landscape(1920x1080): 画面録画向け。16:9素材はほぼ原寸で文字が読める。
  // boxblur=40 をフル解像度に毎フレーム掛けるのを廃止し再エンコード負荷を激減
  //（実測: 20秒あたり約48s → 約7s の約7倍速）。
  //
  // === A/V 同期（入力シーク1段方式）===
  //  - `-ss <start>` を `-i` の前に1つだけ置く。ffmpeg 2.1+ の入力シークはキーフレームへ飛んだ後
  //    目的位置までデコードして捨てるため、これ単独でフレーム精度が出る（粗＋精の2段は不要）。
  //  - `-t <dur>` で出力長を指定。切り出しは filter(trim/atrim) ではなくシークで行うため
  //    映像/音声は同一の入力タイムライン上で同時に切られ、開始点が食い違わない。
  //  - `-avoid_negative_ts` は付けない（make_zero は映像側にのみ +21ms の edit-list 起点を残し
  //    映像 start_time≈0.021 / 音声 0.000 の一定オフセットを生む主因）。
  //  - `-bf 0`: B フレーム reorder 由来の mp4 edit-list 先頭オフセットを排除（映像 start_time を 0 に）。
  //  - `setpts=PTS-STARTPTS`: 映像の先頭フレーム PTS を 0 に正規化する（個体差で残る 1 フレーム
  //    ≈33ms のずれを潰す）。
  // 旧 trim/atrim 方式は映像 start_time≈0.021 / 音声 0.000 の 21ms 残留があった。
  // 入力シーク1段へ移行後も start_time は 0.000/0.000 を維持する（2026-07-23 に本方式で再実測。
  // lecture.mp4 の start=0 / 300 / 700s の 3 クリップとも video・audio 共に 0.000000・duration 一致）。
  // ＝下の -bf 0 / -avoid_negative_ts を付けない / setpts の 3 点は 1 段化後も引き続き必要。
  //
  // === 2段シーク（粗 -ss coarse + 精 -ss fine）を廃した理由（2026-07-23 実測で根治）===
  // 出力シーク（`-i` の後の `-ss`）は **filtergraph より後段** で適用される。showinfo で実測すると
  // フィルタに流れる先頭フレームは pts_time=0（＝coarse 起点）で、精シーク分は捨てられていない。
  // 一方 ASS 本体は wordsInRange() が「区間先頭 = p.start」を 0 とした相対時刻で書いている
  // （srt-builder.mjs）。よって ass フィルタは coarse 起点の 0 から字幕を焼き、その結果を後段の
  // 出力シークが fine 秒ぶん切り落とすため、**字幕が常に PREROLL 秒ぶん先行**していた。
  // 実測（lecture.mp4 の 300-312s 区間）: 出力 t=0.5s に ASS の 2.26-2.56s 行が焼かれていた。
  // setpts と ass の順序を入れ替えても解消しない（フィルタ入力 PTS が既に 0 のため setpts が no-op）。
  // 入力シーク1段にすると filtergraph の 0 = p.start となり ASS の相対時刻と一致する。
  // 無音・言い淀みを詰める場合は、先に残す区間だけを取り出してつなぎ、
  // そのあとで縦化と字幕焼きを掛ける。順序が逆だと、切って捨てる部分にも
  // 縦化と字幕焼きの費用を払うことになるうえ、字幕の時刻が詰める前のままになる。
  // 字幕(ASS)の時刻は、呼び出し側が詰めたあとの時間軸へ写してから渡すこと
  // （srt-builder に渡す words を trim-plan の remapWords に通す）。
  const trim = p.keep && p.keep.length ? buildTrimFilters(p.keep) : null;
  const videoIn = trim ? "[tvout]" : "[0:v]";
  const scaleChain =
    `${videoIn}scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,` +
    `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,` +
    `setpts=PTS-STARTPTS` + assFilter + `[v]`;
  const vf = trim
    ? `${trim.videoChain};${trim.audioChain};${scaleChain}`
    : scaleChain;

  const args = [
    "-y",
    "-ss", String(p.start), // 入力シーク（-i の前・1段。filtergraph の 0 が p.start と一致する）
    "-i", p.input,
    "-t", String(dur),
    "-filter_complex", vf,
    "-map", "[v]",
    // 詰める場合は詰めた音声を、詰めない場合はシークで切り出し済みの音声をそのまま map
    // （無音素材でも落ちないよう ?）
    ...(trim ? ["-map", "[taout]"] : ["-map", "0:a?"]),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-bf", "0", // B フレーム無効化＝reorder 遅延の edit-list 先頭オフセットを排除し映像 start_time を 0 に
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    p.output,
  ];
  return runFfmpeg(args);
}

/**
 * パスを ass フィルタのオプション値用にエスケープする。呼出側で単一引用符ラップ
 * （ass='...'）する前提。
 *
 * ffmpeg はフィルタのオプション値を **2 段階** で解釈するため、エスケープも 2 段必要になる。
 *  - 第1段: filtergraph の解析（`,` `;` `[` `]` でフィルタを切り出す。`'` で引用、`\` で escape）
 *  - 第2段: フィルタ自身のオプション解析（`:` でオプション、`=` で key=value を切る。
 *           ここでも `'` と `\` が特殊文字として再度処理される）
 * 第1段の単一引用符は「そのフィルタの引数の切り出し」までしか守らない。引用符は第1段で
 * 取り除かれるので、第2段には裸の文字列が渡る。よって第2段の特殊文字（`\` `'` `:` `=`）は
 * バックスラッシュで明示的に escape してから、第1段用に引用符でくくる必要がある。
 *
 * 実測（ffmpeg 6.1.1）: 旧実装は `:` だけを escape していたためコロンは通っていたが、
 * `'` を含むパスは第2段で引用符の開始と誤認されて "Error initializing filters" で落ちていた。
 *
 * なお `\` → `/` の置換は Windows のパス区切りを filtergraph 向けに正規化するためのもので、
 * Windows でのみ行う。POSIX では `\` はファイル名の正当な 1 文字であり、置換すると
 * 別のパスに化けて字幕が見つからなくなる（旧実装は全プラットフォームで置換していた）。
 */
function escapeFilterPath(p) {
  const normalized = process.platform === "win32" ? p.replace(/\\/g, "/") : p;
  // 第2段（フィルタのオプション解析）用: \ ' : = をバックスラッシュで escape
  const forOptionParser = normalized.replace(/[\\':=]/g, (c) => `\\${c}`);
  // 第1段（filtergraph 解析）用: 呼出側の単一引用符の内側では ' だけが特殊。'\'' で閉じ直す。
  return forOptionParser.replace(/'/g, "'\\''");
}

/** ffmpeg を起動し stderr を拾って解決/却下する */
export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg ${args.join(" ")}`;
    const proc = spawn("ffmpeg", args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (e) => reject(new Error(`ffmpeg 起動失敗: ${e.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ cmd, output: args[args.length - 1] });
      } else {
        reject(new Error(`ffmpeg 終了コード ${code}\n${stderr.slice(-1200)}`));
      }
    });
  });
}

/** ffprobe で width,height を取得（縦型検証用） */
export function probeSize(file) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      file,
    ];
    const proc = spawn("ffprobe", args, { windowsHide: true });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe code ${code}`));
      const [w, h] = out.trim().split(",").map(Number);
      resolve({ width: w, height: h, vertical: h > w });
    });
  });
}

/** 出力ファイル名を作る（区間番号 + 短いhook） */
export function clipName(outDir, index, hook) {
  const safe = (hook || `clip`).replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 16) || "clip";
  return path.join(outDir, `short-${String(index + 1).padStart(2, "0")}-${safe}.mp4`);
}
