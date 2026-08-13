// video-shorts P0-5-D 実機検証 — 画面で「モザイクあり」を選んだジョブが、実際に
// server/pipeline-runner.mjs の runJob（startJob 経由）から applyMosaicStage を呼び、
// candidates.json を書き換えることを確かめる（mosaic:"on" の配線検証）。
//
// 【既存テストとの重複確認】
// - tests/face-mosaic-check.py … src/face_mosaic.py の検出/追従/塗りの単体検証。ジョブは通さない。
// - tests/mosaic-ui-check.py   … src/apply-mosaic-stage.mjs を「node src/apply-mosaic-stage.mjs
//   <outDir> <stashDir>」で直接叩き、出来上がりの絵で判定する。server/pipeline-runner.mjs の
//   runJob（startJob 経由）は一度も呼んでいない。
// どちらも「画面でモザイクを選んだら、実際に startJob() 経由でモザイク工程が呼ばれるか」という
// 配線（本葉の対象）は検証していない。tests/smoke.mjs にある関連テストも、ソースコードを
// 正規表現で読むだけの静的検査であり、実際にジョブを起動して確かめてはいない。
// 本ファイルはその隙間を埋める：startJob() を実際に呼び、mosaic:"on" のときだけ
// applyMosaicStage が実行されて candidates.json が書き換わり、mosaic:"none"（既定）のときは
// 一切呼ばれない（成果物が素顔のまま）ことを対照として確かめる。
//
// 【transcribe / claude をどう扱うか】
// t段(文字起こし)はfaster-whisper、s段(区間選定)・c段(AI字幕直し)はclaude -pを実際に叩く。
// どちらもこの葉の検証対象ではなく、CIには claude CLI もwhisperモデルも無い。
// 実行時に PATH の先頭へ「python」「claude」の身代わり実行ファイルを差し込み、
// 固定の transcript / 選定結果を返させる（r段=render・m段=mosaic は本物の ffmpeg/opencv を
// 実際に通す＝この葉が検証したい配線そのものはすべて本物のコードパスを通る）。
//
// 実行: node tests/mosaic-job-wiring-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runFfmpeg } from "../src/render-vertical.mjs";
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

/**
 * PATH の先頭に差し込む「python」「claude」の身代わり実行ファイルを作る。
 *
 * 【なぜ環境変数で渡さないか】claude -p 呼び出しは src/claude-safety.mjs の buildSafeEnv()
 * で allowlist 外の環境変数を全て落とす（P1-1 のハードニング）。FAKE_* のような独自の
 * 環境変数はここで消えるため、身代わりスクリプトの中身に直接埋め込む(実測: 環境変数越しでは
 * keepText が空文字になり、claude-select が「0件」を返して工程が失敗した)。
 */
function makeFakeBin(dir, { transcriptFixture, keepText, hook }) {
  fs.mkdirSync(dir, { recursive: true });

  // t段の身代わり: spawn("python", [transcribe.py, inputAbsPath, transcriptPath]) を横取りし、
  // 実際に whisper を回さず、固定の transcript.json を書く。
  // "python3" は横取りしない（src/apply-mosaic-stage.mjs の resolvePython() は python3 を
  // 先に試すため、モザイク工程(m段)は本物の python3+opencv をそのまま使う＝そこは検証対象）。
  const pythonPath = path.join(dir, "python");
  fs.writeFileSync(
    pythonPath,
    `#!/usr/bin/env node\n` +
      `const fs = require("fs");\n` +
      `const transcriptPath = process.argv[4];\n` +
      `fs.copyFileSync(${JSON.stringify(transcriptFixture)}, transcriptPath);\n`
  );
  fs.chmodSync(pythonPath, 0o755);

  // c段(AI字幕直し)・s段(区間選定)の身代わり: PATH経由で claude という実行ファイル名を横取りする。
  // 標準入力の内容で呼び出し元を判別する（字幕直しのプロンプトは "fixes" を、区間選定の
  // プロンプトは "keepText" を出力スキーマとして要求する。両者は文言が異なり重ならない）。
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

/** startJob() が発火する SSE を "done"/"error" まで待つ。受け取った行を全部返す。 */
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
      } else if (/^event:\s*job-error\b/m.test(line)) {
        settled = true;
        unsubscribeJob(jobId, push);
        clearTimeout(timer);
        reject(new Error(`ジョブが失敗しました:\n${lines.join("")}`));
      }
    };
    const close = () => {};
    subscribeJob(jobId, push, close);
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

  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "vs-mosaic-wire-"));
  const jobIds = [];
  const savedPath = process.env.PATH;
  try {
    const input = path.join(WORK, "sample-16x9.mp4");
    await runFfmpeg([
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=15:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      input,
    ]);
    check(fs.existsSync(input), "検証用の合成素材(16:9・4秒)を生成した");

    // 身代わりの t 段が書く固定 transcript（s 段の身代わりが返す keepText と同じ文言にする）。
    const transcriptFixture = path.join(WORK, "fixture-transcript.json");
    fs.writeFileSync(
      transcriptFixture,
      JSON.stringify({
        language: "en",
        duration: 3.0,
        words: [
          { w: "MOSAIC", start: 0.0, end: 1.0 },
          { w: "WIRING", start: 1.0, end: 2.0 },
        ],
        segments: [{ start: 0.0, end: 2.0, text: "MOSAIC WIRING" }],
      })
    );

    const binDir = path.join(WORK, "bin");
    makeFakeBin(binDir, { transcriptFixture, keepText: "MOSAIC WIRING", hook: "MOSAICCHECK" });
    process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;

    async function runJobAndInspect(mosaicOpt, label) {
      const jobId = makeUniqueJobId(`wiring-${label}.mp4`);
      jobIds.push(jobId);
      const opts = { sub: "none", cut: "topic", size: "9:16", trim: "none" };
      if (mosaicOpt !== undefined) opts.mosaic = mosaicOpt;

      const started = startJob(jobId, path.resolve(input), opts);
      check(started === true, `${label}: startJob が受理された`);
      const lines = await waitForJob(jobId);

      const workDir = path.join(ROOT, "work", jobId);
      const outDir = path.join(ROOT, "output", jobId);
      const state = JSON.parse(fs.readFileSync(path.join(workDir, "state.json"), "utf-8"));
      const candPath = path.join(outDir, "candidates.json");
      const cand = JSON.parse(fs.readFileSync(candPath, "utf-8"));

      return { jobId, workDir, outDir, state, cand, lines };
    }

    // ── A: mosaic:"on" を指定した実ジョブを流す ──────────────────────────
    const on = await runJobAndInspect("on", "on");
    check(on.state.mosaic === "on", "mosaic=on: state.json に mosaic:\"on\" が記録される");
    // AUD-P2-16: ジョブ完了時に state.stage="done" が必ず永続化されるようになったため
    // (旧実装は最後に書いたステージ"mosaicked"のまま止まっていた＝doneの永続化漏れが
    // 実際のバグだった)、ここで観測されるのは"mosaicked"ではなく最終的な"done"になる。
    check(on.state.stage === "done", `mosaic=on: state.stage が(m段を経て)最終的にdoneになる(実=${on.state.stage})`);
    check(
      on.lines.some((l) => l.includes('"stage":"m"')),
      "mosaic=on: SSE進捗に m 段(モザイク)のイベントが流れている"
    );
    check(on.cand.candidates.length === 1, `mosaic=on: 候補が1本ある(実=${on.cand.candidates.length})`);
    const onEntry = on.cand.candidates[0];
    check(
      /-mosaic\.mp4$/.test(onEntry.file),
      `mosaic=on: candidates.json の成果物名が -mosaic.mp4 で終わる(実=${onEntry.file})`
    );
    check(fs.existsSync(onEntry.path), "mosaic=on: モザイク版の動画ファイルが実在する");

    const stashDir = path.join(on.workDir, "pre-mosaic");
    check(fs.existsSync(stashDir) && fs.statSync(stashDir).isDirectory(), "mosaic=on: 素顔の退避先ディレクトリが作られている");
    const stashed = fs.existsSync(stashDir) ? fs.readdirSync(stashDir) : [];
    check(
      stashed.length === 1 && !stashed[0].endsWith("-mosaic.mp4"),
      `mosaic=on: 退避先に素顔(モザイク前)のファイルが1本ある(実=${JSON.stringify(stashed)})`
    );
    const outDirListing = fs.readdirSync(on.outDir);
    check(
      stashed.length === 0 || !outDirListing.includes(stashed[0]),
      "mosaic=on: 成果物フォルダに素顔のファイルは残っていない(退避済み)"
    );

    // ── B: mosaic を指定しない(既定=none)実ジョブを流す ──────────────────
    // parseJobParams の既定と同じく mosaic 未指定 = 何も渡さない状態を再現する（server/index.mjs
    // は parseJobParams が返す既定値 "none" を startJob の opts.mosaic へ渡すため、opts.mosaic が
    // "none" になるのが実際の既定経路。ここでは opts に mosaic キー自体を含めない場合と同じ
    // 「"on" ではない」を確かめる）。
    const off = await runJobAndInspect("none", "off");
    check(off.state.mosaic === undefined, "mosaic=none: state.json に mosaic キーが書かれない(=工程が呼ばれていない)");
    // AUD-P2-16: 同様にm段が無い経路でも、最終的にstate.stage="done"まで永続化される
    // (旧実装は"rendered"のまま止まっていた＝doneの永続化漏れが実際のバグだった)。
    check(off.state.stage === "done", `mosaic=none: state.stage が(m段を経ずに)最終的にdoneになる(実=${off.state.stage})`);
    check(
      !off.lines.some((l) => l.includes('"stage":"m"')),
      "対照: mosaic=none: SSE進捗に m 段のイベントが一切流れていない"
    );
    check(off.cand.candidates.length === 1, `mosaic=none: 候補が1本ある(実=${off.cand.candidates.length})`);
    const offEntry = off.cand.candidates[0];
    check(
      !/-mosaic\.mp4$/.test(offEntry.file),
      `対照: mosaic=none: candidates.json の成果物名は -mosaic.mp4 で終わらない(実=${offEntry.file})`
    );
    check(fs.existsSync(offEntry.path), "mosaic=none: 通常版の動画ファイルは実在する(レンダリング自体は成功している)");
    check(
      !fs.existsSync(path.join(off.workDir, "pre-mosaic")),
      "対照: mosaic=none: 素顔の退避ディレクトリが作られていない(モザイク工程が一度も呼ばれていない)"
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
