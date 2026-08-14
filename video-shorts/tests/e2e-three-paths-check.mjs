// M7: 3経路(A:CLI / B:画面=HTTP / C:配布物)E2E — 同じ凍結素材を通し、成果物が一致することを
// 確かめる(User Goal 全体。§10 Verification Strategy「Runtime Evidence」・§12 Milestone 7)。
//
// 実際の入口はマスターのチャット→CLI(経路A。skill/video-shorts/SKILL.md が案内する
// node pipeline.mjs init/select/render の直列実行)。画面(経路B=server/pipeline-runner.mjs の
// HTTP API)は build-dist.mjs 自身のコメントが明記するとおり配布物に含まれない保留経路で、
// 配線の退行検知(顔モザイクで実際に起きた「画面から設定が渡っていない」形の事故の再発防止。
// pipeline-runner.mjs の G-EDIT-MOSAIC-UI-O-2 コメント参照)として実施する。配布物(経路C)は
// build-dist.mjs が作る dist/ai-editer-video-shorts へ同じCLIコマンド列を実行し、
// 「新規ファイルを git add し忘れて配布物に含まれない」事故(実際に src/export-presets.mjs で
// 発生した。docs/failures.md 2026-08-14)を検知する。
//
// この検査が確認すること:
//   (1) A/B/C 共通で選べる設定(mode=topic/sub=on/orient=縦)を同じ凍結素材へ適用したとき、
//       候補本数・出力解像度(縦長)・字幕(.ass、hookの中身を含む)の有無が3経路で一致する。
//   (2) --duration-min/--export のようなCLI専用フラグを扱うモジュール(export-presets.mjs)が、
//       ソース側と配布物(経路C)側で同じ設定を返す(=配布物への入れ忘れを検出できる)。
//       画面(経路B)はこれらのフラグを渡す配線を持たない(server/job-params.mjs が
//       sub/cut/size/cutMin/mosaic/trim/name の7項目しか受け取らない、既知の制約
//       §4 Constraints)ため、B は比較対象に含めない。
//   (3) B(画面)は、M3で追加したフォント確認ゲート(文字起こし前に止まる)が実際に効く。
//       旧実装はこのゲートが pipeline.mjs の cmdInit だけにあり、画面経路は init を経由せず
//       直接 transcribe.py を起動するため素通りしていた(M7で発覚した回帰。
//       server/pipeline-runner.mjs へ同じ判定を追加して修正した)。
//   (4) 経路Cが server/ を含まない(build-dist.mjsの意図どおり配布されない保留経路である)ことを
//       明示的に確認する。
//
// 実行: node tests/e2e-three-paths-check.mjs   (全PASSで exit 0。ffmpeg 必須)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeSize } from "../src/render-vertical.mjs";
import { makeUniqueJobId } from "../src/job-id.mjs";
import { startJob, subscribeJob, unsubscribeJob } from "../server/pipeline-runner.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // = video-shorts/
const PIPELINE_SRC = path.join(ROOT, "pipeline.mjs");
const DIST = path.join(ROOT, "..", "dist", "ai-editer-video-shorts");
const PIPELINE_DIST = path.join(DIST, "pipeline.mjs");

let pass = 0, fail = 0;
function check(cond, name, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

async function main() {
  if (!has("ffmpeg") || !has("ffprobe")) {
    console.log("SKIP: ffmpeg/ffprobe が見つからないため、この検査は実行できません。");
    return 0;
  }

  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "vs-e2e3-"));
  const jobIds = [];
  const savedPath = process.env.PATH;
  try {
    // ── 凍結素材(3経路で共通)を作る ──────────────────────────────────
    const input = path.join(WORK, "frozen-material.mp4");
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=15:duration=5",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      input,
    ]);
    check(fs.existsSync(input), "凍結素材(1920x1080・5秒)を生成した");

    // 凍結transcript(3経路で同じ内容を使う。keepText/hookは reverse-match の一致規則に合わせ
    // words を空白区切りで連結した形にする＝orient-render-check.mjs等と同じ規約)。
    const HOOK = "E2ETHREE";
    const KEEP_TEXT = "E2ETHREE PARITY CHECK";
    const transcriptFixture = {
      language: "en",
      duration: 4.0,
      words: [
        { w: "E2ETHREE", start: 0.0, end: 1.2 },
        { w: "PARITY", start: 1.2, end: 2.4 },
        { w: "CHECK", start: 2.4, end: 3.6 },
      ],
      segments: [{ start: 0.0, end: 3.6, text: KEEP_TEXT }],
    };
    const transcriptFixturePath = path.join(WORK, "fixture-transcript.json");
    fs.writeFileSync(transcriptFixturePath, JSON.stringify(transcriptFixture));
    const llmResponse = { segments: [{ keepText: KEEP_TEXT, hook: HOOK }] };

    // ── 経路A: CLI(ソース) を実際に起動する ────────────────────────────
    // SKILL.md の手順どおり: init → transcribe.py(の代わりにfixtureを直接置く) →
    // select(手書きのllm-response.jsonを置く、topic modeの本来の運用と同じ) → render。
    function runCliJourney(pipelinePath, label) {
      const initR = spawnSync(
        process.execPath,
        [pipelinePath, "init", input, "--mode", "topic", "--sub", "on", "--orient", "縦"],
        { cwd: path.dirname(pipelinePath), encoding: "utf-8" }
      );
      check(initR.status === 0, `${label}: init が成功する`, initR.stderr);
      const workDir = (initR.stdout || "").trim();
      check(fs.existsSync(workDir), `${label}: work ディレクトリが実在する(${workDir})`);

      fs.copyFileSync(transcriptFixturePath, path.join(workDir, "transcript.json"));

      const selectR = spawnSync(
        process.execPath,
        [pipelinePath, "select", workDir, "--mode", "topic"],
        { cwd: path.dirname(pipelinePath), encoding: "utf-8" }
      );
      check(selectR.status === 0, `${label}: select が成功する(llm-request.mdを生成)`, selectR.stderr);
      check(
        fs.existsSync(path.join(workDir, "llm-request.md")),
        `${label}: llm-request.md が書かれる`
      );

      // topic mode: オーケストレーター(チャットのClaude自身)がllm-request.mdを読んで
      // llm-response.jsonを書く、という運用を、この検査では固定の応答で代替する。
      fs.writeFileSync(path.join(workDir, "llm-response.json"), JSON.stringify(llmResponse));

      const renderR = spawnSync(
        process.execPath,
        [pipelinePath, "render", workDir],
        { cwd: path.dirname(pipelinePath), encoding: "utf-8" }
      );
      check(renderR.status === 0, `${label}: render が成功する`, renderR.stderr);

      const outDir = path.join(path.dirname(pipelinePath), "output", path.basename(workDir));
      const candPath = path.join(outDir, "candidates.json");
      const cand = JSON.parse(fs.readFileSync(candPath, "utf-8"));
      return { workDir, outDir, cand };
    }

    const a = runCliJourney(PIPELINE_SRC, "経路A(CLI/ソース)");
    jobIds.push(path.basename(a.workDir));

    // ── 経路C: 配布物をビルドし、そこに入っている pipeline.mjs を同じ手順で動かす ────
    execFileSync("node", [path.join(ROOT, "build-dist.mjs")], { stdio: "ignore" });
    check(fs.existsSync(PIPELINE_DIST), "経路C: 配布物ビルドに pipeline.mjs が含まれる(前提)");
    const c = runCliJourney(PIPELINE_DIST, "経路C(配布物)");
    jobIds.push(path.basename(c.workDir));

    // ── 経路B: 画面(HTTP) 相当。server/pipeline-runner.mjs の startJob() を直接叩く ───
    const binDir = path.join(WORK, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const pyMarker = path.join(WORK, "python-was-invoked.marker");
    fs.writeFileSync(
      path.join(binDir, "python"),
      `#!/usr/bin/env node\n` +
        `const fs = require("fs");\n` +
        `fs.writeFileSync(${JSON.stringify(pyMarker)}, "1");\n` +
        `const transcriptPath = process.argv[4];\n` +
        `fs.copyFileSync(${JSON.stringify(transcriptFixturePath)}, transcriptPath);\n`
    );
    fs.chmodSync(path.join(binDir, "python"), 0o755);
    fs.writeFileSync(
      path.join(binDir, "claude"),
      `#!/usr/bin/env node\n` +
        `const KEEP_TEXT = ${JSON.stringify(KEEP_TEXT)};\n` +
        `const HOOK = ${JSON.stringify(HOOK)};\n` +
        `const chunks = [];\n` +
        `process.stdin.on("data", (c) => chunks.push(c));\n` +
        `process.stdin.on("end", () => {\n` +
        `  const input = Buffer.concat(chunks).toString("utf8");\n` +
        `  let result;\n` +
        `  if (input.includes('"fixes"')) result = JSON.stringify({ fixes: [] });\n` +
        `  else if (input.includes("keepText")) result = JSON.stringify({ segments: [{ keepText: KEEP_TEXT, hook: HOOK }] });\n` +
        `  else result = JSON.stringify({ segments: [] });\n` +
        `  process.stdout.write(JSON.stringify({ result }));\n` +
        `});\n`
    );
    fs.chmodSync(path.join(binDir, "claude"), 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;

    function waitForJob(jobId, timeoutMs = 180000) {
      return new Promise((resolve, reject) => {
        const lines = [];
        let settled = false;
        let timer;
        const push = (line) => {
          lines.push(line);
          if (settled) return;
          if (/^event:\s*done\b/m.test(line)) {
            settled = true; unsubscribeJob(jobId, push); clearTimeout(timer); resolve(lines);
          } else if (/^event:\s*job-error\b/m.test(line)) {
            settled = true; unsubscribeJob(jobId, push); clearTimeout(timer); resolve(lines);
          }
        };
        subscribeJob(jobId, push, () => {});
        timer = setTimeout(() => {
          if (settled) return;
          settled = true; unsubscribeJob(jobId, push);
          reject(new Error(`タイムアウト(${timeoutMs}ms)\n${lines.join("")}`));
        }, timeoutMs);
      });
    }

    const bJobId = makeUniqueJobId("e2e-three-paths-b.mp4");
    jobIds.push(bJobId);
    const bOpts = { sub: "on", cut: "topic", size: "9:16", mosaic: "none", trim: "none" };
    const bStarted = startJob(bJobId, path.resolve(input), bOpts);
    check(bStarted === true, "経路B: startJob が受理された");
    const bLines = await waitForJob(bJobId);
    check(
      bLines.some((l) => /^event:\s*done\b/m.test(l)),
      "経路B: ジョブが done で終わる(font/wiring の前提が壊れていない)",
      bLines.join("").slice(0, 400)
    );
    const bWorkDir = path.join(ROOT, "work", bJobId);
    const bOutDir = path.join(ROOT, "output", bJobId);
    const bCand = JSON.parse(fs.readFileSync(path.join(bOutDir, "candidates.json"), "utf-8"));

    // ── (1) 3経路の成果物突き合わせ ──────────────────────────────────
    check(
      a.cand.candidates.length === 1 && c.cand.candidates.length === 1 && bCand.candidates.length === 1,
      "3経路とも候補が1本ずつ生成される",
      `A=${a.cand.candidates.length} B=${bCand.candidates.length} C=${c.cand.candidates.length}`
    );

    const [sizeA, sizeB, sizeC] = await Promise.all([
      probeSize(a.cand.candidates[0].path),
      probeSize(bCand.candidates[0].path),
      probeSize(c.cand.candidates[0].path),
    ]);
    check(
      sizeA.width === sizeB.width && sizeA.height === sizeB.height &&
        sizeA.width === sizeC.width && sizeA.height === sizeC.height,
      "3経路の出力解像度が一致する(縦=orient指定が同じ意味で伝わっている)",
      `A=${sizeA.width}x${sizeA.height} B=${sizeB.width}x${sizeB.height} C=${sizeC.width}x${sizeC.height}`
    );
    check(
      sizeA.height > sizeA.width && sizeB.height > sizeB.width && sizeC.height > sizeC.width,
      "3経路とも縦長(高さ>幅)で出力される"
    );

    const assA = path.join(a.workDir, "clip-1.ass");
    const assB = path.join(bWorkDir, "clip-1.ass");
    const assC = path.join(c.workDir, "clip-1.ass");
    check(
      fs.existsSync(assA) && fs.existsSync(assB) && fs.existsSync(assC),
      "3経路とも字幕(.ass)ファイルが作られる(sub=onが3経路とも効いている)",
      `A=${fs.existsSync(assA)} B=${fs.existsSync(assB)} C=${fs.existsSync(assC)}`
    );
    check(
      [assA, assB, assC].every((p) => fs.readFileSync(p, "utf-8").includes(HOOK)),
      "3経路とも字幕にHOOK文字列が含まれる(見出しが焼かれている)"
    );
    // 対照: candidatesが0本、または解像度が食い違えば直上2つの検査は落ちる形になっている
    // (常に同じ値を仮定する実装では検出できない、実測どうしの突き合わせであることの裏付け)。

    // ── (2) CLI専用モジュール(export-presets.mjs)のソース/配布物パリティ ─────────────
    const { resolveExportSettings: resolveSrc, listExportPresets: listSrc } =
      await import(path.join(ROOT, "src", "export-presets.mjs"));
    const { resolveExportSettings: resolveDist, listExportPresets: listDist } =
      await import(path.join(DIST, "src", "export-presets.mjs"));
    check(
      JSON.stringify(resolveSrc("sns")) === JSON.stringify(resolveDist("sns")),
      "経路A/C: export-presets.mjs の sns プリセットがソースと配布物で同じ設定を返す",
      `src=${JSON.stringify(resolveSrc("sns"))} dist=${JSON.stringify(resolveDist("sns"))}`
    );
    check(
      JSON.stringify(listSrc()) === JSON.stringify(listDist()),
      "経路A/C: 書き出しプリセット一覧がソースと配布物で一致する(入れ忘れが無い)"
    );

    // ── (3) 経路B: フォント確認ゲートが文字起こし前に効く(M3のゲートがB経路で回帰していないか) ──
    const fakeNoFontDir = path.join(WORK, "no-font-bin");
    fs.mkdirSync(fakeNoFontDir, { recursive: true });
    fs.writeFileSync(path.join(fakeNoFontDir, "fc-list"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(fakeNoFontDir, "fc-list"), 0o755);
    // fc-list 以外(python/claude)は引き続き上で作った身代わりを使う。
    process.env.PATH = `${fakeNoFontDir}${path.delimiter}${binDir}${path.delimiter}${savedPath}`;

    fs.rmSync(pyMarker, { force: true });
    const noFontJobId = makeUniqueJobId("e2e-three-paths-nofont.mp4");
    jobIds.push(noFontJobId);
    const noFontStarted = startJob(noFontJobId, path.resolve(input), { sub: "on", cut: "topic", size: "9:16" });
    check(noFontStarted === true, "経路B(フォント無し環境): startJob 自体は受理される(拒否は非同期側)");
    const noFontLines = await waitForJob(noFontJobId);
    check(
      noFontLines.some((l) => /^event:\s*job-error\b/m.test(l)),
      "経路B(フォント無し環境): ジョブが job-error で終わる(文字起こし前に止まる)",
      noFontLines.join("").slice(0, 400)
    );
    check(
      !fs.existsSync(pyMarker),
      "経路B(フォント無し環境): transcribe.py(の身代わり)が一度も起動されない(=文字起こし開始前に止まっている)"
    );
    const noFontState = JSON.parse(
      fs.readFileSync(path.join(ROOT, "work", noFontJobId, "state.json"), "utf-8")
    );
    check(
      noFontState.errorCode === "font_missing",
      "経路B(フォント無し環境): state.json の errorCode が font_missing になる",
      JSON.stringify(noFontState.errorCode)
    );

    // 対照: sub=none(字幕なし)なら、同じフォント無し環境でもゲートは働かず先へ進む
    // (ゲートが「常に落ちる」壊れた実装ではなく、sub=on のときだけ働く条件付きであることの裏付け)。
    const noFontNoSubJobId = makeUniqueJobId("e2e-three-paths-nofont-nosub.mp4");
    jobIds.push(noFontNoSubJobId);
    const noFontNoSubStarted = startJob(noFontNoSubJobId, path.resolve(input), { sub: "none", cut: "topic", size: "9:16" });
    check(noFontNoSubStarted === true, "対照: 経路B(フォント無し環境・sub=none): startJob が受理される");
    const noFontNoSubLines = await waitForJob(noFontNoSubJobId);
    check(
      noFontNoSubLines.some((l) => /^event:\s*done\b/m.test(l)),
      "対照: 経路B(フォント無し環境・sub=none): ジョブは font_missing で落ちずに done まで進む",
      noFontNoSubLines.join("").slice(0, 400)
    );

    // ── (4) 経路C(配布物)は server/ を含まない(保留経路として意図どおり除外されている) ──
    check(
      !fs.existsSync(path.join(DIST, "server")),
      "経路C: 配布物に server/(画面=HTTP経路)が含まれない(build-dist.mjsの意図どおり)"
    );
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(WORK, { recursive: true, force: true });
    for (const jobId of jobIds) {
      fs.rmSync(path.join(ROOT, "work", jobId), { recursive: true, force: true });
      fs.rmSync(path.join(ROOT, "output", jobId), { recursive: true, force: true });
      fs.rmSync(path.join(DIST, "work", jobId), { recursive: true, force: true });
      fs.rmSync(path.join(DIST, "output", jobId), { recursive: true, force: true });
    }
  }

  console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
  return fail;
}

main()
  .then((fail) => process.exit(fail === 0 ? 0 : 1))
  .catch((e) => {
    console.log("FAIL 例外: " + (e.stack || e.message));
    process.exit(1);
  });
