// video-shorts 検証ヘルパ: クリップの映像(v:0)と音声(a:0)の start_time 差を測り A/V 同期を判定する。
// 実行: node src/av-verify.mjs <clip.mp4>   (offset < 5ms で PASS/exit0・超過で FAIL/exit1)
// 設計知見: renderClip は setpts=PTS-STARTPTS + -bf 0 で映像先頭を 0 に揃え音声 0.000 と一致させる
//           （render-vertical.mjs コメント参照）。本ツールはその結果を客観測定する再利用可能な検証器。
//
// P2-2: 映像/音声どちらかのstreamが丸ごと欠けている(無音動画・音声トラック無し等)クリップは、
// ffprobe に -select_streams で存在しないstreamを指定すると「exit code 0・stdout空」を返す。
// これを従来どおり Number("") === 0 として扱うと「start_time=0.0秒（＝offset無し）」に化けて
// しまい、A/V同期がPASS判定される（本来は「そもそも片方のstreamが無い」という別種の不具合で、
// A/V同期の良し悪し以前の問題）。streamの有無は start_time とは別に明示的に確認し、
// 欠けていれば「長さ0秒」に丸めず検証失敗として扱う。
import fs from "node:fs";
import { spawn } from "node:child_process";

const THRESHOLD_MS = 5; // A/V offset 許容上限（目標 0.0ms）

function runFfprobe(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", args, { windowsHide: true });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe code ${code} (args: ${args.join(" ")})`));
      resolve(out.trim());
    });
  });
}

/** ffprobe で指定ストリーム(v:0 / a:0)の start_time(秒) を取得。欠損(N/A・空)は null を返す。 */
export async function probeStartTime(file, stream) {
  const out = await runFfprobe([
    "-v", "error",
    "-select_streams", stream,
    "-show_entries", "stream=start_time",
    "-of", "csv=p=0",
    file,
  ]);
  const val = Number(out);
  return Number.isFinite(val) && out !== "" ? val : null; // "N/A"/空 は null（数値化不能）
}

/**
 * 指定ストリーム(v:0 / a:0)がファイルに存在するかを判定する。
 * -select_streams が該当streamを選べないと、ffprobe は exit code 0 のまま stdout が
 * 空文字になる（エラー扱いされない）。start_time の欠損と原因が違う（"値を取得できない"
 * のではなく"そもそもstreamが無い"）ため、別関数として明示的に確認する。
 */
export async function probeStreamExists(file, stream) {
  const out = await runFfprobe([
    "-v", "error",
    "-select_streams", stream,
    "-show_entries", "stream=index",
    "-of", "csv=p=0",
    file,
  ]);
  return out.length > 0;
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
  const [hasVideo, hasAudio] = await Promise.all([
    probeStreamExists(file, "v:0"),
    probeStreamExists(file, "a:0"),
  ]);
  // streamそのものが無い場合は「長さ0秒」に丸めず、A/V同期以前の問題として検証失敗にする。
  if (!hasVideo || !hasAudio) {
    if (!hasVideo) console.log("FAIL 映像(v:0) streamがありません");
    if (!hasAudio) console.log("FAIL 音声(a:0) streamがありません");
    process.exit(1);
  }

  const [v, a] = await Promise.all([
    probeStartTime(file, "v:0"),
    probeStartTime(file, "a:0"),
  ]);
  // streamは存在するが start_time だけ取得できない(N/A)場合は、握り潰さず明示した上で
  // 0.0秒とみなす（streamの有無はすでに確認済みなので、ここでの欠損は数値化不能の意味のみ）。
  if (v === null) console.log("[WARN] 映像 start_time が取得できず 0.0 とみなす");
  if (a === null) console.log("[WARN] 音声 start_time が取得できず 0.0 とみなす");
  const vSec = v ?? 0.0;
  const aSec = a ?? 0.0;

  const offsetMs = Math.abs(vSec - aSec) * 1000;
  const pass = offsetMs < THRESHOLD_MS;
  console.log(`v:0 start=${vSec.toFixed(6)}s / a:0 start=${aSec.toFixed(6)}s`);
  console.log(`${pass ? "PASS" : "FAIL"} A/V offset = ${offsetMs.toFixed(1)}ms (閾値 < ${THRESHOLD_MS}ms)`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.log("FAIL 例外: " + (e.message || e));
  process.exit(1);
});
