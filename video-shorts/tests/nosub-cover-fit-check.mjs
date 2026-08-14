// 字幕なしのとき、黒帯(letterbox)を残さず枠いっぱいに映すことの検証。
//
// 背景（実素材の見どころダイジェスト・字幕なしで出力を見たマスターからの指摘。
// docs/failures.md 2026-08-14）：字幕なし(--no-sub)で書き出しても、字幕の見出し・本文用に
// 上下へ黒帯(pad)を残す従来の作り(computeCanvas/renderClipのdecrease+pad固定)のままだった
// ため、実映像は画面の3割程度しか使っておらず「背景黒で、枠が小さい」に見えた。
// 修正: 字幕なしのときは fit="cover"（中央crop-fillで枠いっぱいに映す）を既定にし、
// 字幕ありのときは従来どおり fit="pad"（黒帯に見出し・本文を焼く）を維持する。
//
// この検査が確認すること:
//   (1) computeCanvas: fit="cover" は素材が小さくても常にTARGET全体を返す(pad用の
//       拡大ガードで縮まない)。pad(既定)は従来どおり縮む(退行しないことの対照)。
//   (2) renderClip: 実際にffmpegでcover/pad両方を焼き、bboxフィルタで「非黒(=映像)pixelの
//       外接矩形」を測ると、cover は frame 全域を覆い、pad は上下に黒帯(bboxがframeより
//       小さい)が残る。
//   (3) CLI配線: node pipeline.mjs render --no-sub の実行結果が実際にcoverになる
//       (字幕ありの場合はpadのまま=退行していない)。
//
// 実行: node tests/nosub-cover-fit-check.mjs   (全PASSで exit 0。ffmpeg必須)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { computeCanvas, renderClip } from "../src/render-vertical.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PIPELINE = path.join(ROOT, "pipeline.mjs");

let pass = 0, fail = 0;
function check(cond, name, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

function cmdAvailable(bin) {
  return spawnSync(bin, ["-version"]).status === 0;
}
if (!cmdAvailable("ffmpeg") || !cmdAvailable("ffprobe")) {
  console.log("SKIP: ffmpeg/ffprobe が見つからないため検証できません");
  process.exit(0);
}

/** 出力の非黒(min_val超)pixelの、フレーム全体を通した外接矩形(x1,y1,x2,y2)をbboxフィルタで測る。 */
function measureContentBBox(file, minVal = 24) {
  const r = spawnSync("ffmpeg", ["-i", file, "-vf", `bbox=min_val=${minVal}`, "-f", "null", "-"],
    { encoding: "utf-8" });
  const lines = (r.stderr || "").split("\n").filter((l) => l.includes("Parsed_bbox") && l.includes("x1:"));
  if (lines.length === 0) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const line of lines) {
    const m = line.match(/x1:(\d+)\s+x2:(\d+)\s+y1:(\d+)\s+y2:(\d+)/);
    if (!m) continue;
    x1 = Math.min(x1, Number(m[1]));
    x2 = Math.max(x2, Number(m[2]));
    y1 = Math.min(y1, Number(m[3]));
    y2 = Math.max(y2, Number(m[4]));
  }
  return { x1, y1, x2, y2 };
}

// ── (1) computeCanvas: cover は拡大ガードで縮まない ────────────────────
check(
  computeCanvas("portrait", 360, 640, "pad").guarded === true &&
    computeCanvas("portrait", 360, 640, "pad").w === 360,
  "pad(既定): 小さい素材(360x640)ではcanvasが縮む(従来どおりの拡大ガード。退行していない対照)",
  JSON.stringify(computeCanvas("portrait", 360, 640, "pad"))
);
check(
  computeCanvas("portrait", 360, 640, "cover").guarded === false &&
    computeCanvas("portrait", 360, 640, "cover").w === 1080 &&
    computeCanvas("portrait", 360, 640, "cover").h === 1920,
  "cover: 同じ小さい素材でもcanvasはTARGET全体(1080x1920)のまま(黒帯を残さない目的上、縮めない)",
  JSON.stringify(computeCanvas("portrait", 360, 640, "cover"))
);
check(
  computeCanvas("portrait", 1920, 1080).w === computeCanvas("portrait", 1920, 1080, "pad").w,
  "対照: fit省略時はpadと同じ結果になる(既定値が変わっていない)"
);

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "nosub-cover-"));
const jobDirs = [];
try {
  // 16:9・全面に模様が入るtestsrc(自前に黒縁が無い素材)を使う。cover/padの違いが
  // 「素材そのものの黒」ではなく「fitフィルタの黒帯」由来であることを保証するため。
  const src = path.join(WORK, "src.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=15:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", src]);

  // ── (2) renderClip: cover は frame 全域を覆う。pad は上下に黒帯が残る ─────
  const outCover = path.join(WORK, "out-cover.mp4");
  await renderClip({ input: src, start: 0, end: 1, output: outCover, orientation: "portrait", fit: "cover" });
  const bboxCover = measureContentBBox(outCover);
  check(
    bboxCover !== null && bboxCover.y1 === 0 && bboxCover.y2 === 1919,
    "cover: 出力の非黒領域が縦方向(y)でframe全体(0〜1919)を覆う(黒帯が残っていない)",
    JSON.stringify(bboxCover)
  );

  const outPad = path.join(WORK, "out-pad.mp4");
  await renderClip({ input: src, start: 0, end: 1, output: outPad, orientation: "portrait", fit: "pad" });
  const bboxPad = measureContentBBox(outPad);
  check(
    bboxPad !== null && bboxPad.y1 > 0 && bboxPad.y2 < 1919,
    "pad: 出力の非黒領域が縦方向でframe全体を覆わない(上下に黒帯が残る。退行していない対照)",
    JSON.stringify(bboxPad)
  );
  check(
    bboxCover.y2 - bboxCover.y1 > bboxPad.y2 - bboxPad.y1,
    "対照: coverの映像が占める縦幅は、padの映像が占める縦幅より広い(枠を有効に使えている)",
    `cover縦幅=${bboxCover.y2 - bboxCover.y1} pad縦幅=${bboxPad.y2 - bboxPad.y1}`
  );

  // ── (3) CLI配線: --no-sub の実render結果が実際にcoverになる ────────────
  execFileSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=15:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", src]);
  const transcriptFixturePath = path.join(WORK, "fixture-transcript.json");
  const HOOK = "COVERWIRE", KEEP_TEXT = "COVERWIRE CHECK OK";
  fs.writeFileSync(transcriptFixturePath, JSON.stringify({
    language: "en", duration: 1.0,
    words: [{ w: "COVERWIRE", start: 0.0, end: 0.4 }, { w: "CHECK", start: 0.4, end: 0.7 }, { w: "OK", start: 0.7, end: 0.9 }],
    segments: [{ start: 0.0, end: 0.9, text: KEEP_TEXT }],
  }));

  function runCliRender(subFlag) {
    const initR = spawnSync(process.execPath,
      [PIPELINE, "init", src, "--mode", "topic", "--sub", subFlag, "--orient", "縦"],
      { cwd: ROOT, encoding: "utf-8" });
    const workDir = (initR.stdout || "").trim();
    jobDirs.push(path.basename(workDir));
    fs.copyFileSync(transcriptFixturePath, path.join(workDir, "transcript.json"));
    spawnSync(process.execPath, [PIPELINE, "select", workDir, "--mode", "topic"], { cwd: ROOT, encoding: "utf-8" });
    fs.writeFileSync(path.join(workDir, "llm-response.json"),
      JSON.stringify({ segments: [{ keepText: KEEP_TEXT, hook: HOOK }] }));
    const renderR = spawnSync(process.execPath, [PIPELINE, "render", workDir], { cwd: ROOT, encoding: "utf-8" });
    if (renderR.status !== 0) throw new Error(`render失敗: ${renderR.stderr}`);
    const cand = JSON.parse(fs.readFileSync(
      path.join(ROOT, "output", path.basename(workDir), "candidates.json"), "utf-8"));
    return cand.candidates[0].path;
  }

  const noSubOut = runCliRender("off");
  const bboxNoSub = measureContentBBox(noSubOut);
  check(
    bboxNoSub !== null && bboxNoSub.y1 === 0 && bboxNoSub.y2 === 1919,
    "CLI配線: node pipeline.mjs render(字幕off)の実出力が実際にcover(黒帯なし)になる",
    JSON.stringify(bboxNoSub)
  );

  const subOut = runCliRender("on");
  const bboxSub = measureContentBBox(subOut);
  check(
    bboxSub !== null && (bboxSub.y1 > 0 || bboxSub.y2 < 1919),
    "対照CLI配線: 字幕onの実出力は従来どおりpad(黒帯あり)のまま(退行していない)",
    JSON.stringify(bboxSub)
  );
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
  for (const id of jobDirs) {
    fs.rmSync(path.join(ROOT, "work", id), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, "output", id), { recursive: true, force: true });
  }
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
