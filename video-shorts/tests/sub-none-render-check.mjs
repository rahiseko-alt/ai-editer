// video-shorts P0-5-C 実機検証 — 画面で「字幕なし」を選んだジョブが、実際に字幕なしで
// レンダリングされることを確かめる（sub:"none" の配線検証）。
//
// server/pipeline-runner.mjs は state.sub を "on"/"none" のどちらかで state.json へ書き、
// pipeline.mjs の render コマンド(cmdRender)がそれを読んで字幕の有無を決める
// （--no-sub フラグはその上書き）。ここでは pipeline.mjs の実コマンド(init→render)を
// 実際に起動し、state.sub="none" のときに出力へ字幕が焼かれていないことを、
// 「字幕なし基準フレーム」（renderClip を字幕無しで直接呼んで作る、cmdRender を経由しない
// 独立の比較対象）とのフレーム差分比較で確認する。
//
// 対照として sub="on" も同じ区間・同じ入力で流し、基準フレームと**差が出る**ことを示す
// （＝この比較の仕方が「字幕が有れば有ると言える」ことの確認。差が出なければ、
// 比較そのものが何も検出できていないことになる）。
//
// select 段（claude 呼び出し）は経路の対象外なので、llm-response.json は直接書いて経路を
// 単純化する（cmdSelect を経由しないのは、この葉が検証したいのは render 段の配線だからで、
// select 段の配線は他の葉・他のテストが担う）。
//
// 実行: node tests/sub-none-render-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderClip, runFfmpeg, probeSize } from "../src/render-vertical.mjs";
import { snapStart } from "../src/trim-plan.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PIPELINE = path.join(ROOT, "pipeline.mjs");

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

/** 指定秒のフレームを PNG で抜き出してバイト列を返す（字幕が焼かれたかの比較用） */
async function grabFrame(video, atSec, workTmp) {
  const png = path.join(workTmp, `frame-${Math.random().toString(36).slice(2)}.png`);
  await runFfmpeg(["-y", "-v", "error", "-ss", String(atSec), "-i", video, "-frames:v", "1", png]);
  const buf = fs.readFileSync(png);
  fs.unlinkSync(png);
  return buf;
}

/** node pipeline.mjs init を実行し、workDir(stdout)を返す */
function runInit(input, sub) {
  const r = spawnSync(
    process.execPath,
    [PIPELINE, "init", input, "--mode", "topic", "--sub", sub, "--orient", "縦"],
    { cwd: ROOT, encoding: "utf-8" }
  );
  assert.strictEqual(r.status, 0, `init(sub=${sub}) が失敗しました: ${r.stderr}`);
  return r.stdout.trim();
}

/** node pipeline.mjs render を実行する（--no-sub は付けない。state.sub のみで配線を試す） */
function runRender(workDir) {
  return spawnSync(process.execPath, [PIPELINE, "render", workDir, "--mode", "topic"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
}

async function main() {
  if (!(await ffmpegAvailable())) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }

  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "vs-subnone-"));
  const workDirs = [];
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

    // 文字起こしと選定結果は固定素材として直接書く（select段=claude呼び出しはこの葉の対象外）。
    // ASCIIにするのは、CIランナーに日本語フォントが無くても「フォント無しで字幕行が
    // 描かれない」ことを字幕の有無と取り違えないため（render-escape-check.mjs と同じ理由）。
    const transcript = {
      language: "en",
      duration: 3.0,
      words: [
        { w: "SUBTITLE", start: 0.0, end: 1.0 },
        { w: "WIRING", start: 1.0, end: 2.0 },
      ],
      segments: [{ start: 0.0, end: 2.0, text: "SUBTITLE WIRING" }],
    };
    const llmResponse = { segments: [{ keepText: "SUBTITLE WIRING", hook: "SUBCHECK" }] };

    const outputs = {};
    for (const sub of ["off", "on"]) {
      const workDir = runInit(input, sub);
      workDirs.push(workDir);
      fs.writeFileSync(path.join(workDir, "transcript.json"), JSON.stringify(transcript), "utf-8");
      fs.writeFileSync(path.join(workDir, "llm-response.json"), JSON.stringify(llmResponse), "utf-8");

      const r = runRender(workDir);
      if (!check(r.status === 0, `node pipeline.mjs render (state.sub由来, sub=${sub}) が成功する`)) {
        console.log("     └ " + (r.stderr || "").slice(-800));
        continue;
      }

      const state = JSON.parse(fs.readFileSync(path.join(workDir, "state.json"), "utf-8"));
      check(state.sub === (sub === "on" ? "on" : "none"), `state.sub が init の指定どおり(${sub})になっている`);

      const candPath = path.join(ROOT, "output", state.id, "candidates.json");
      check(fs.existsSync(candPath), `sub=${sub}: candidates.json が生成された`);
      const cand = JSON.parse(fs.readFileSync(candPath, "utf-8"));
      check(cand.candidates.length === 1, `sub=${sub}: 候補が1本生成された(実=${cand.candidates.length})`);
      outputs[sub] = { state, manifest: cand.candidates[0] };
    }

    if (fail > 0 && (!outputs.off || !outputs.on)) {
      // 前提が崩れていたら以降の比較は無意味なので打ち切る。
      throw new Error("render が失敗したため、フレーム比較を行えません（上のFAILを参照）");
    }

    // ── 字幕なし基準フレームを作る（cmdRenderを経由しない独立の比較対象） ──────────
    // 同じ入力・同じ区間（実際に選定された start/end をそのまま使う）に対して、
    // renderClip を assPath=null で直接呼ぶ。segStart は renderSegment 内部と同じ
    // snapStart(seg.start, srcFps) を通す（通さないと数十ms のフレーム境界差で
    // 無関係な画素差が出て、比較そのものが誤判定になる）。
    const srcSize = await probeSize(input);
    const m = outputs.off.manifest;
    const segStart = snapStart(m.start, srcSize.fps);
    const baseline = path.join(WORK, "baseline-nosub.mp4");
    await renderClip({ input, start: segStart, end: m.end, output: baseline, orientation: "portrait" });
    check(fs.existsSync(baseline), "独立の「字幕なし基準」動画を生成した");

    const grabAt = Math.min(0.5, Math.max(0, (m.end - m.start) / 2));
    const frameBaseline = await grabFrame(baseline, grabAt, WORK);
    const frameOff = await grabFrame(outputs.off.manifest.path, grabAt, WORK);
    const frameOn = await grabFrame(outputs.on.manifest.path, grabAt, WORK);

    check(frameBaseline.length > 0 && frameOff.length > 0 && frameOn.length > 0, "3本のフレームを取得できた");

    // ── 本題(P0-5-C): sub=none の出力は、字幕なし基準と画が一致する ─────────────
    check(
      frameOff.equals(frameBaseline),
      "sub=none の出力フレームが、字幕なし基準フレームと一致する（＝字幕が焼かれていない）"
    );

    // ── 対照: sub=on の出力は、同じ基準と画が異なる ─────────────────────────
    // これが無いと、上の一致判定が「そもそも何を比べても一致してしまう緩い比較」で
    // 通っているだけの可能性を排除できない（＝字幕が有れば有ると言えることの確認）。
    check(
      !frameOn.equals(frameBaseline),
      "対照: sub=on の出力フレームは、同じ基準フレームと異なる（字幕が実際に焼かれている）"
    );
    check(
      !frameOff.equals(frameOn),
      "対照: 同じ区間でも sub=off と sub=on の出力フレームは異なる（字幕の有無だけが違う）"
    );
  } finally {
    fs.rmSync(WORK, { recursive: true, force: true });
    for (const wd of workDirs) {
      try {
        const state = JSON.parse(fs.readFileSync(path.join(wd, "state.json"), "utf-8"));
        fs.rmSync(path.join(ROOT, "output", state.id), { recursive: true, force: true });
      } catch (_) {
        // state.json が読めない(=render前に失敗した)ケースは output 側に何も無いので無視
      }
      fs.rmSync(wd, { recursive: true, force: true });
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
