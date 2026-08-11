// video-shorts P0-5-A 実機検証 — 画面で選んだ向き(size)が、実際に実出力の解像度へ反映される
// ことを確かめる（画面選択→state→CLI引数→実出力解像度、の配線検証）。
//
// server/pipeline-runner.mjs の resolveJobSettings() は opts.size==="16:9" のときだけ
// orient:"landscape" とし、それ以外(既定"9:16")は orient:"portrait" とする。runJob() は
// これを state.json へ書き、pipeline.mjs の render コマンド(cmdRender)が state.orient を読んで
// computeCanvas() の対象解像度(portrait=1080x1920 / landscape=1920x1080)を決める
// (src/render-vertical.mjs)。ここでは startJob() を実際に呼び、size="16:9" と size="9:16" の
// 2ジョブを流し、実際にレンダリングされた成果物ファイルの解像度を ffprobe(probeSize) で確認する。
//
// 入力素材は 1920x1080 (Full HD) にする。portrait/landscape どちらのターゲットに対しても
// computeCanvas() の縮小ガード(k>1のときだけ発動)に掛からない解像度を選ぶことで、実出力が
// ORIENT定数の値と過不足なくちょうど一致することを確認できる（ガードが挟まると期待値が
// 入力解像度依存の別の値になり、1対1照合にならない）。
//
// t段(文字起こし)・s段(区間選定)は mosaic-job-wiring-check.mjs と同じく PATH 差し込みの
// 身代わりで固定応答させ、r段(render)は本物の ffmpeg を通す(この葉が検証したい配線そのもの)。
//
// 実行: node tests/orient-render-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runFfmpeg, probeSize } from "../src/render-vertical.mjs";
import { makeUniqueJobId } from "../src/job-id.mjs";
import { startJob, subscribeJob, unsubscribeJob } from "../server/pipeline-runner.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let fail = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) fail++;
  return cond;
};

function ffmpegAvailable() {
  return new Promise((res) => {
    const p = spawn("ffmpeg", ["-version"], { windowsHide: true });
    p.on("error", () => res(false));
    p.on("close", (c) => res(c === 0));
  });
}

/** PATH の先頭に差し込む「python」「claude」の身代わり実行ファイルを作る(mosaic-job-wiring-checkと同様)。 */
function makeFakeBin(dir, { transcriptFixture, keepText, hook }) {
  fs.mkdirSync(dir, { recursive: true });

  const pythonPath = path.join(dir, "python");
  fs.writeFileSync(
    pythonPath,
    `#!/usr/bin/env node\n` +
      `const fs = require("fs");\n` +
      `const transcriptPath = process.argv[4];\n` +
      `fs.copyFileSync(${JSON.stringify(transcriptFixture)}, transcriptPath);\n`
  );
  fs.chmodSync(pythonPath, 0o755);

  const claudePath = path.join(dir, "claude");
  fs.writeFileSync(
    claudePath,
    `#!/usr/bin/env node\n` +
      `const KEEP_TEXT = ${JSON.stringify(keepText)};\n` +
      `const HOOK = ${JSON.stringify(hook)};\n` +
      `const chunks = [];\n` +
      `process.stdin.on("data", (c) => chunks.push(c));\n` +
      `process.stdin.on("end", () => {\n` +
      `  const input = Buffer.concat(chunks).toString("utf8");\n` +
      `  let result;\n` +
      `  if (input.includes('"fixes"')) {\n` +
      `    result = JSON.stringify({ fixes: [] });\n` +
      `  } else if (input.includes("keepText")) {\n` +
      `    result = JSON.stringify({ segments: [{ keepText: KEEP_TEXT, hook: HOOK }] });\n` +
      `  } else {\n` +
      `    result = JSON.stringify({ segments: [] });\n` +
      `  }\n` +
      `  process.stdout.write(JSON.stringify({ result }));\n` +
      `});\n`
  );
  fs.chmodSync(claudePath, 0o755);
}

/** startJob() が発火する SSE を "done"/"error" まで待つ。 */
function waitForJob(jobId, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let settled = false;
    let timer;
    const push = (line) => {
      lines.push(line);
      if (settled) return;
      if (/^event:\s*done\b/m.test(line)) {
        settled = true;
        unsubscribeJob(jobId, push);
        clearTimeout(timer);
        resolve(lines);
      } else if (/^event:\s*error\b/m.test(line)) {
        settled = true;
        unsubscribeJob(jobId, push);
        clearTimeout(timer);
        reject(new Error(`ジョブが失敗しました:\n${lines.join("")}`));
      }
    };
    subscribeJob(jobId, push, () => {});
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribeJob(jobId, push);
      reject(new Error(`ジョブがタイムアウトしました(${timeoutMs}ms)\n受信済み:\n${lines.join("")}`));
    }, timeoutMs);
  });
}

async function main() {
  if (!(await ffmpegAvailable())) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }

  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "vs-orient-"));
  const jobIds = [];
  const savedPath = process.env.PATH;
  try {
    // 縮小ガード(computeCanvas)が発動しない解像度(1920x1080)を使う。
    // portrait target(1080x1920): k=min(1080/1920,1920/1080)=0.5625<1 → ガード無し → ちょうど1080x1920。
    // landscape target(1920x1080): k=min(1920/1920,1080/1080)=1       → ガード無し → ちょうど1920x1080。
    const input = path.join(WORK, "sample-fullhd.mp4");
    await runFfmpeg([
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=15:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      input,
    ]);
    check(fs.existsSync(input), "検証用の合成素材(1920x1080・4秒)を生成した");

    const transcriptFixture = path.join(WORK, "fixture-transcript.json");
    fs.writeFileSync(
      transcriptFixture,
      JSON.stringify({
        language: "en",
        duration: 3.0,
        words: [
          { w: "ORIENT", start: 0.0, end: 1.0 },
          { w: "WIRING", start: 1.0, end: 2.0 },
        ],
        segments: [{ start: 0.0, end: 2.0, text: "ORIENT WIRING" }],
      })
    );

    const binDir = path.join(WORK, "bin");
    makeFakeBin(binDir, { transcriptFixture, keepText: "ORIENT WIRING", hook: "ORIENTCHECK" });
    process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;

    async function runJobAndInspect(size, label) {
      const jobId = makeUniqueJobId(`orient-${label}.mp4`);
      jobIds.push(jobId);
      // 画面選択(opts.size)を直接与える。既定値の穴埋めや誤入力対応はP0-5-Aの対象外
      // (server/job-params.mjsのparseJobParamsが別途担う)なので、ここでは既に検証済みの
      // 値だけを渡す。
      const opts = { sub: "none", cut: "topic", size, trim: "none" };

      const started = startJob(jobId, path.resolve(input), opts);
      check(started === true, `size=${size}(${label}): startJob が受理された`);
      await waitForJob(jobId);

      const workDir = path.join(ROOT, "work", jobId);
      const outDir = path.join(ROOT, "output", jobId);
      const state = JSON.parse(fs.readFileSync(path.join(workDir, "state.json"), "utf-8"));
      const candPath = path.join(outDir, "candidates.json");
      const cand = JSON.parse(fs.readFileSync(candPath, "utf-8"));

      return { jobId, workDir, outDir, state, cand };
    }

    // ── A: size="16:9" を選んだ実ジョブ ─────────────────────────────
    const landscape = await runJobAndInspect("16:9", "landscape");
    check(landscape.state.orient === "landscape", `size=16:9: state.orient が landscape になる(実=${landscape.state.orient})`);
    check(landscape.cand.candidates.length === 1, `size=16:9: 候補が1本生成された(実=${landscape.cand.candidates.length})`);
    const landscapeFile = landscape.cand.candidates[0].path;
    check(fs.existsSync(landscapeFile), "size=16:9: 出力mp4が実在する");
    const landscapeSize = await probeSize(landscapeFile);
    check(
      landscapeSize.width === 1920 && landscapeSize.height === 1080,
      `size=16:9: 実出力解像度が1920x1080(横型)と一致する(実=${landscapeSize.width}x${landscapeSize.height})`
    );
    check(landscapeSize.width > landscapeSize.height, "size=16:9: 実出力が横長(幅>高さ)である");

    // ── B: size="9:16"(既定) を選んだ実ジョブ ──────────────────────
    const portrait = await runJobAndInspect("9:16", "portrait");
    check(portrait.state.orient === "portrait", `size=9:16: state.orient が portrait になる(実=${portrait.state.orient})`);
    check(portrait.cand.candidates.length === 1, `size=9:16: 候補が1本生成された(実=${portrait.cand.candidates.length})`);
    const portraitFile = portrait.cand.candidates[0].path;
    check(fs.existsSync(portraitFile), "size=9:16: 出力mp4が実在する");
    const portraitSize = await probeSize(portraitFile);
    check(
      portraitSize.width === 1080 && portraitSize.height === 1920,
      `size=9:16: 実出力解像度が1080x1920(縦型)と一致する(実=${portraitSize.width}x${portraitSize.height})`
    );
    check(portraitSize.height > portraitSize.width, "size=9:16: 実出力が縦長(高さ>幅)である");

    // ── 対照: 2つの実出力が互いに異なる(＝size選択が実際に出力へ効いている) ─────
    check(
      landscapeSize.width !== portraitSize.width || landscapeSize.height !== portraitSize.height,
      "対照: size=16:9とsize=9:16の実出力解像度は異なる(向きの選択が無視されていない)"
    );
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(WORK, { recursive: true, force: true });
    for (const jobId of jobIds) {
      fs.rmSync(path.join(ROOT, "work", jobId), { recursive: true, force: true });
      fs.rmSync(path.join(ROOT, "output", jobId), { recursive: true, force: true });
    }
  }

  console.log(`\n--- ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ---`);
  return fail;
}

main()
  .then((fail) => process.exit(fail === 0 ? 0 : 1))
  .catch((e) => {
    console.log("FAIL 例外: " + (e.stack || e.message));
    process.exit(1);
  });
