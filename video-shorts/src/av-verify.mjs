// video-shorts 検証ヘルパ: クリップの映像(v:0)と音声(a:0)の start_time 差を測り A/V 同期を判定する。
// 実行: node src/av-verify.mjs <clip.mp4>   (offset < 5ms で PASS/exit0・超過で FAIL/exit1)
// 設計知見: renderClip は setpts=PTS-STARTPTS + -bf 0 で映像先頭を 0 に揃え音声 0.000 と一致させる
//           （render-vertical.mjs コメント参照）。本ツールはその結果を客観測定する再利用可能な検証器。
import fs from "node:fs";
import { spawn } from "node:child_process";

const THRESHOLD_MS = 5; // A/V offset 許容上限（目標 0.0ms）

/** ffprobe で指定ストリーム(v:0 / a:0)の start_time(秒) を取得。欠損(N/A・空)は null を返す。 */
export function probeStartTime(file, stream) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-select_streams", stream,
      "-show_entries", "stream=start_time",
      "-of", "csv=p=0",
      file,
    ];
    const proc = spawn("ffprobe", args, { windowsHide: true });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe code ${code} (stream ${stream})`));
      const val = Number(out.trim());
      resolve(Number.isFinite(val) ? val : null); // "N/A"/空 は null（数値化不能）
    });
  });
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.log("usage: node src/av-verify.mjs <clip.mp4>");
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.log(`FAIL ファイルがありません: ${file}`);
    process.exit(1);
  }
  const [vRaw, aRaw] = await Promise.all([
    probeStartTime(file, "v:0"),
    probeStartTime(file, "a:0"),
  ]);
  // 欠損は 0.0 とみなすが、握り潰さず明示する（サイレントフェイル禁止）。
  if (vRaw === null) console.log("[WARN] 映像 start_time が取得できず 0.0 とみなす");
  if (aRaw === null) console.log("[WARN] 音声 start_time が取得できず 0.0 とみなす");
  const v = vRaw ?? 0.0;
  const a = aRaw ?? 0.0;

  const offsetMs = Math.abs(v - a) * 1000;
  const pass = offsetMs < THRESHOLD_MS;
  console.log(`v:0 start=${v.toFixed(6)}s / a:0 start=${a.toFixed(6)}s`);
  console.log(`${pass ? "PASS" : "FAIL"} A/V offset = ${offsetMs.toFixed(1)}ms (閾値 < ${THRESHOLD_MS}ms)`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.log("FAIL 例外: " + (e.message || e));
  process.exit(1);
});
