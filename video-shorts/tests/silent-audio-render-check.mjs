// AUD-S-02: 音声の無い素材を keep 指定(トリム/言い淀み詰め)で編集に使っても、
// renderClip() が [0:a] 未解決のffmpegエラーで落ちないことの検証。
// 実行: node tests/silent-audio-render-check.mjs
//
// 修正前: buildTrimFilters() は常に[0:a]を参照するfiltergraphを組んでおり、音声トラックの
// 無い素材へkeepを渡すと「Stream specifier ':a' ... matches no streams」でffmpegが失敗した。
// 通常の自動処理は先にno-speech判定されるためP1には数えないが、renderClip()単体の契約としては
// 不整合だった。
// 修正後: buildTrimFilters()にhasAudioオプションを追加し、falseの場合は[0:a]を一切参照しない
// filtergraphを組む。render-vertical.mjsはprobeHasAudio()でkeep指定時のみ音声有無を検出して配線する。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { renderClip, probeHasAudio } from "../src/render-vertical.mjs";

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? `\n      ${detail}` : ""}`); }
}

function cmdAvailable(bin) {
  return spawnSync(bin, ["-version"]).status === 0;
}
if (!cmdAvailable("ffmpeg") || !cmdAvailable("ffprobe")) {
  console.log("SKIP: ffmpeg/ffprobe が見つからないため検証できません");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "silent-audio-render-"));
const src = path.join(tmp, "src_silent.mp4");
const out = path.join(tmp, "out.mp4");

try {
  // 音声トラックを一切持たない(-an)、2秒の合成素材を作る。
  execFileSync("ffmpeg", ["-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=15:duration=2",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", src], { stdio: ["ignore", "ignore", "ignore"] });

  const hasAudio = await probeHasAudio(src);
  report("probeHasAudio()が音声トラック無しの素材を正しくfalseと判定する", hasAudio === false, `hasAudio=${hasAudio}`);

  // no-speech判定を経由せず、keep指定でrenderClip()を直接呼ぶ(音声トラック無しでも
  // 例外を投げずに完走することがこの葉の受入条件)。
  let threw = null;
  try {
    await renderClip({
      input: src, start: 0, end: 2, assPath: null, output: out, orientation: "portrait",
      keep: [{ start: 0, end: 0.8 }, { start: 1.0, end: 1.6 }],
    });
  } catch (e) {
    threw = e;
  }
  report(
    "音声無し素材+keep指定のrenderClip()が例外を投げずに完走する([0:a]未解決エラーにならない)",
    threw === null,
    threw ? threw.message : "",
  );
  report("出力ファイルが実際に生成されている", fs.existsSync(out) && fs.statSync(out).size > 0);

  if (fs.existsSync(out)) {
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a",
      "-show_entries", "stream=index", "-of", "csv=p=0", out], { encoding: "utf-8" });
    const audioStreamCount = probe.stdout.trim().split("\n").filter(Boolean).length;
    report("出力に音声ストリームが無い(入力どおり無音声のまま)", audioStreamCount === 0, `audioStreamCount=${audioStreamCount}`);

    const durProbe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v",
      "-show_entries", "stream=duration", "-of", "csv=p=0", out], { encoding: "utf-8" });
    const dur = parseFloat(durProbe.stdout.trim());
    // keep区間の合計は0.8+0.6=1.4秒。継ぎ目のフレーム丸めを許容し±0.3秒で判定。
    report("出力尺がkeep区間の合計(≈1.4秒)に近い", Math.abs(dur - 1.4) <= 0.3, `duration=${dur}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
