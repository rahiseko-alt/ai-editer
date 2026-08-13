// video-shorts ダイジェスト用: 複数の縦型mp4を時系列連結して1本にする。
// 全part が同一パラメータ（1080x1920/h264/aac）なので concat demuxer + -c copy で無劣化・高速。
// copy が失敗した場合のみ再エンコードへ fallback（サイレントフェイル禁止）。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function runFfmpeg(args) {
  const r = spawnSync("ffmpeg", args, { encoding: "utf-8" });
  if (r.error) {
    // spawn 自体の失敗（ENOENT=未インストール / EACCES=権限 等）は r.status が null・stderr が空。
    // ENOENT 以外を握り潰すと下流の `code !== 0` 判定・再エンコード fallback を素通りして
    // 最終的に真因（r.error.message）が消えるため、ここで明示 throw する（サイレントフェイル禁止）。
    if (r.error.code === "ENOENT") {
      throw new Error("ffmpeg が見つかりません。連結に必須です。");
    }
    throw new Error(`ffmpeg 起動失敗: ${r.error.message}`);
  }
  return { code: r.status, err: (r.stderr || "").slice(-600) };
}

/** clipPaths を時系列に連結して outPath に1本出力し、outPath を返す。 */
export function concatClips(clipPaths, outPath) {
  const clips = (clipPaths || []).filter((p) => p && fs.existsSync(p));
  if (clips.length === 0) throw new Error("concat 対象が0件です");
  if (clips.length === 1) {
    fs.copyFileSync(clips[0], outPath);
    return outPath;
  }
  // P1-18-A: pid+本数だけの名前は同一PC上の別プロセスから予測でき、事前に設置された
  // symlinkの先を書き換えられてしまう(実機PoCで確認済み)。crypto由来のランダムな成分を
  // 加えて予測不能にし、さらに"wx"フラグ(O_EXCL)で既存パス(symlink含む)への書き込みを
  // OS レベルで拒否する(万一の衝突・先回りに対する多層防御)。
  const listFile = path.join(
    os.tmpdir(),
    `vs-concat-${process.pid}-${crypto.randomBytes(16).toString("hex")}.txt`,
  );
  // concat demuxer のリスト形式。シングルクォートはエスケープする。
  const body = clips
    .map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(listFile, body, { encoding: "utf-8", flag: "wx" });
  try {
    let r = runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outPath]);
    if (r.code !== 0) {
      // タイムスタンプ不整合などで copy が失敗 → 再エンコード
      r = runFfmpeg([
        "-y", "-f", "concat", "-safe", "0", "-i", listFile,
        "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-c:a", "aac", outPath,
      ]);
      if (r.code !== 0) throw new Error(`ffmpeg concat 失敗: ${r.err}`);
    }
  } finally {
    if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
  }
  return outPath;
}
