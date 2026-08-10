// A/V検証のstream欠落検出の検証 — P2-2
//
// src/av-verify.mjs は元々「欠損は 0.0 とみなす」実装だった。ffprobe に -select_streams で
// 存在しないstreamを指定すると exit code 0・stdout空文字を返す(エラーにならない)ため、
// Number("") === 0 という数値として扱われ、"streamが丸ごと無い"と"streamはあるが
// start_timeがN/A"の区別がつかず、音声または映像streamが欠落した動画がA/V同期PASS判定に
// なってしまっていた。probeStreamExists() でstreamの有無を先に確認し、欠けていれば検証失敗に
// する（P2-2）。
//
// fixture: ffmpeg の lavfi で合成する(コミットしない・下記コマンドで数値的に再現可能)。
//   両方揃い: -f lavfi -i color=black:s=64x64:d=1:r=5 -f lavfi -i sine=frequency=440:duration=1
//             -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest
//   映像のみ: -f lavfi -i color=black:s=64x64:d=1:r=5 -an -c:v libx264 -pix_fmt yuv420p
//   音声のみ: -f lavfi -i sine=frequency=440:duration=1 -c:a aac
//
// ①偽物が壊れる/③壊したものを当てて落ちることの確認: 修正前の実装(欠損を0.0とみなす)を
// 同じ入力にかけると、映像のみ/音声のみの動画を誤ってPASS判定してしまうことを対照として示す。
// ②正しい実装の値を測る: 実際に av-verify.mjs を子プロセスとして実行し、
//   両方揃った動画=PASS(exit0)・片方欠落=FAIL(exit1)であることを実測する。
//
// 実行: node tests/av-verify-stream-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const AV_VERIFY = path.join(ROOT, "src", "av-verify.mjs");

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n      ${e.stack || e.message}`);
  }
}
async function at(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n      ${e.stack || e.message}`);
  }
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vs-av-verify-"));
const BOTH = path.join(DIR, "both.mp4");
const VIDEO_ONLY = path.join(DIR, "video-only.mp4");
const AUDIO_ONLY = path.join(DIR, "audio-only.mp4");

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "pipe" });
}

console.log("--- fixture合成中(ffmpeg lavfi) ---");
ffmpeg([
  "-f", "lavfi", "-i", "color=black:s=64x64:d=1:r=5",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", BOTH,
]);
ffmpeg([
  "-f", "lavfi", "-i", "color=black:s=64x64:d=1:r=5",
  "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", VIDEO_ONLY,
]);
ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", AUDIO_ONLY]);

function runAvVerify(file) {
  try {
    const out = execFileSync(process.execPath, [AV_VERIFY, file], { encoding: "utf-8" });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

// ── ②: 実際の av-verify.mjs を子プロセスで実行して実測 ──────────────
await at("②両方のstreamが揃った動画はPASS(exit0)", async () => {
  const { code, out } = runAvVerify(BOTH);
  assert.strictEqual(code, 0, `PASSになるはずが exit=${code}\n${out}`);
  assert.match(out, /PASS/);
});

await at("②音声streamが欠落した動画はFAIL(exit1)として検出される", async () => {
  const { code, out } = runAvVerify(VIDEO_ONLY);
  assert.strictEqual(code, 1, `FAILになるはずが exit=${code}\n${out}`);
  assert.match(out, /音声.*streamがありません/);
});

await at("②映像streamが欠落した動画はFAIL(exit1)として検出される", async () => {
  const { code, out } = runAvVerify(AUDIO_ONLY);
  assert.strictEqual(code, 1, `FAILになるはずが exit=${code}\n${out}`);
  assert.match(out, /映像.*streamがありません/);
});

// ── ①/③: 修正前の「欠損は0.0とみなす」実装を同じfixtureに当てると誤ってPASSする ──
function naiveCheckLikeBeforeFix(vRawEmpty, aRawEmpty) {
  // 修正前の av-verify.mjs のロジックを再現: ffprobeの空stdout(=streamが無い)を
  // Number("") === 0 として扱ってしまう(streamの有無を確認しない)。
  const v = Number(vRawEmpty === "" ? "" : vRawEmpty) || 0.0;
  const a = Number(aRawEmpty === "" ? "" : aRawEmpty) || 0.0;
  const offsetMs = Math.abs(v - a) * 1000;
  return offsetMs < 5; // THRESHOLD_MS
}

t("①対照: 修正前の実装は、音声streamが丸ごと無い動画も「offset0ms」としてPASSしてしまう", () => {
  // video-only.mp4 は v:0 start_time="0.000000"(あり)・a:0 は select_streamsが空stdoutを返す(欠落)。
  const wouldPass = naiveCheckLikeBeforeFix("0.000000", "");
  assert.strictEqual(wouldPass, true, "対照のはずなのに誤ってFAIL扱いになった(対照が機能していない)");
});

await at("③この検査には検出能力がある: streamの有無チェックを外すと、修正後の実装でも誤ってPASSに戻ることを確認", async () => {
  // av-verify.mjs の probeStreamExists を「常にある」と偽装したモジュールをその場で作り、
  // stream有無チェックを外した状態を再現する。これでも誤ってPASSになるなら、
  // 「streamの有無を見る」という修正の核心部分をこのテストが実際に踏んでいる証拠になる。
  const brokenPath = path.join(DIR, "av-verify-broken.mjs");
  const src = fs.readFileSync(AV_VERIFY, "utf-8").replace(
    "export async function probeStreamExists(file, stream) {",
    "export async function probeStreamExists(file, stream) { return true; } // eslint-disable-line -- テスト用に無効化\nasync function __unused_probeStreamExists(file, stream) {"
  );
  fs.writeFileSync(brokenPath, src, "utf-8");
  const { code, out } = (() => {
    try {
      const o = execFileSync(process.execPath, [brokenPath, VIDEO_ONLY], { encoding: "utf-8" });
      return { code: 0, out: o };
    } catch (e) {
      return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
    }
  })();
  assert.strictEqual(code, 0, `streamチェックを外すと誤ってPASSに戻るはずが exit=${code}\n${out}`);
  assert.match(out, /PASS/);
});

fs.rmSync(DIR, { recursive: true, force: true });

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
