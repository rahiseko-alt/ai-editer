// video-shorts [5] FFmpeg縦化＋字幕焼き — 区間を切り出し 9:16 中央crop→scale→字幕焼き。
// 落とし穴#2(字幕焼きは再エンコード・音声は -c:a copy 不可なので別扱い)
// 落とし穴#3(中央拡大は crop 先 → scale 後)。
//
// 注意: 字幕(subtitles filter)を使うと映像は必ず再エンコードされる。音声は変換不要なので
//       -c:a copy で無劣化コピーする（落とし穴#2の正しい解釈）。

import { spawn } from "node:child_process";
import path from "node:path";

// 向き別の出力解像度。portrait=縦型(SNSリール等)、landscape=横型(画面録画・細かい文字を残す)。
const ORIENT = { portrait: [1080, 1920], landscape: [1920, 1080] };
const DEFAULT_ORIENT = "portrait";

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
 * @returns {Promise<{cmd:string, output:string}>}
 */
export function renderClip(p) {
  const dur = Math.max(0.1, p.end - p.start);
  const [TARGET_W, TARGET_H] = ORIENT[p.orientation] || ORIENT[DEFAULT_ORIENT];
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
  // === A/V 同期の根治（2段出力シーク方式）===
  //  - 粗シーク `-ss <coarse>` を `-i` の前に置き高速に近傍キーフレームへ飛ぶ（デコード量削減）。
  //  - 精シーク `-ss <fine>` を `-i` の後に置き、正確な開始点までフレーム精度で詰める。
  //  - `-t <dur>` で出力長を指定。切り出しは filter(trim/atrim) ではなくシークで行うため
  //    映像/音声は同一の入力タイムライン上で同時に切られ、開始点が食い違わない。
  //  - `-avoid_negative_ts` は付けない（make_zero は映像側にのみ +21ms の edit-list 起点を残し
  //    映像 start_time≈0.021 / 音声 0.000 の一定オフセットを生む主因）。
  //  - `-bf 0`: B フレーム reorder 由来の mp4 edit-list 先頭オフセットを排除（映像 start_time を 0 に）。
  // 旧 trim/atrim 方式は映像 start_time≈0.021 / 音声 0.000 の 21ms 残留があった。
  // 本方式の実測 start_time は 0.000/0.000（両ストリーム0近傍・duration一致）。
  const PREROLL = 2; // 秒。粗シークをこの分だけ手前に置き、精シークで正確な開始点まで詰める。
  const coarse = Math.max(0, p.start - PREROLL);
  const fine = p.start - coarse;
  // 末尾 setpts=PTS-STARTPTS: 映像の先頭フレーム PTS を必ず 0 に正規化する。
  // 2段シーク＋-bf 0 だけでは、精シーク位置がフレームグリッド間に落ちるクリップで
  // 先頭フレームが 1 フレーム(≈33ms)後ろにずれ start_time≈0.033 が残る個体差が出た（実測 4/13 本）。
  // setpts で全クリップの映像先頭を 0 に揃え、音声(0.000)と一定 0ms 同期にする。
  const vf =
    `[0:v]scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,` +
    `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1` +
    assFilter + `,setpts=PTS-STARTPTS[v]`;

  const args = [
    "-y",
    "-ss", String(coarse), // 粗シーク（-i の前・高速キーフレーム飛び）
    "-i", p.input,
    "-ss", String(fine),   // 精シーク（-i の後・フレーム精度で開始点を詰める）
    "-t", String(dur),
    "-filter_complex", vf,
    "-map", "[v]",
    "-map", "0:a?", // 音声はシークで切り出し済のためそのまま map（無音素材でも落ちないよう ?）
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
 * Windows パスを ass フィルタ用にエスケープ。
 * 呼出側で単一引用符ラップ（ass='...'）する前提なので、スペース/コンマは引用符が保護する。
 * \ → / 、drive の : を \: 、パス内の ' は '\'' で閉じ直し（引用符の途中閉じ破損を防ぐ）。
 */
function escapeFilterPath(p) {
  return p
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "'\\''");
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
