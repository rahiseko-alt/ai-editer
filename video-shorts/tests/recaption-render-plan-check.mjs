// AUD-P1-02a / AUD-P1-02b — 字幕焼き直し後もトリム尺・解像度が保持されることの検証
//
// 【バグの実体】pipeline.mjs の初回レンダは (a) 無音・言い淀みを詰めた後の keep 区間・
// 実際に使った開始秒(segStart)・詰め後の尺(clipDuration) と (b) 拡大ガード込みの実際の
// 出力解像度（素材の実 srcW/srcH から算出）を計算するが、従来はどちらも manifest
// (candidates.json) へ持ち回っていなかった。src/recaption-stage.mjs は
//   (02a) c.start/c.end という raw な値から作り直すため、詰めた尺が戻ってしまう
//         （4秒→1秒に詰めたクリップが、焼き直すと4秒に戻る）
//   (02b) state.srcW/state.srcH という「本番の state.json には存在しないフィールド」
//         を参照するため常に undefined になり、拡大ガードが効かないまま既定解像度
//         (1080x1920) で焼き直され、初回レンダの解像度（小さい素材なら縮小ガード後の
//         より小さい解像度）とずれる
// という2つの独立した不具合を生んでいた。
//
// 【この検査のやり方】実際に pipeline.mjs render を1回通し、次に src/recaption-stage.mjs
// の recaptionStage() を実際に呼んで焼き直し、両方とも ffprobe で実測する。
// 手で candidates.json の renderPlan を組み立てて recaptionStage だけを試すのではなく、
// 生成側(pipeline.mjs)→消費側(recaption-stage.mjs)を両方本物の経路で通す
// （生成側が正しく manifest へ書けていなければ、消費側だけ直しても本番では再現しない）。
//
// 【素材設計・境界値】
//  - 素材長 4.0 秒・10fps。語は先頭 0.0-0.5秒("A")と末尾 3.5-4.0秒("B")の2語だけで、
//    間の 3.0 秒は無音（既定の無音しきい値 0.20 秒を大きく超える）→ 詰めると 1.3 秒残る。
//    2026-08-16: マスター指示「発言の後にだけ、余韻を0.3秒存在させる」により、詰める無音の
//    直前に残る発言があるとき 0.3 秒を残すようになった。語 0.5+0.5 秒＋余韻 0.3 秒＝1.3 秒。
//    ffprobe の実測許容は ±0.15 秒（1コマ=0.1秒の2コマ弱ぶん。fps境界の丸めを吸収しつつ、
//    4.0秒との取り違えは検出できる十分小さい値）。
//  - 解像度は 320x180（1080x1920 へは6.75倍ぶんの拡大になるため、computeCanvas() の
//    拡大ガードが必ず発動し 320x568 に縮小される。既定の 1080x1920 とは明確に異なるので、
//    ガードが効いているかどうかを解像度の値そのもので判定できる）。
//  - 字幕ありで焼く(state.sub="on")。字幕なし(--no-sub)は fit="cover" になり黒帯を残さず
//    常にTARGET全体(1080x1920)を使う既定の挙動へ変わった(2026-08-14、実素材で「黒帯だらけで
//    映像が小さい」という指摘を受けての修正。docs/failures.md)ため、拡大ガードによる縮小は
//    fit="pad"（字幕あり）のときだけ起きる。この検査は拡大ガードの保持を見るのが目的なので
//    字幕ありに固定する。
//  - CLIP_PAD_HEAD/TAIL=0（既定の余韻パディングを切り、区間の境界を素材設計どおりに保つ）。
//
// 実行: node tests/recaption-render-plan-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runFfmpeg, probeSize } from "../src/render-vertical.mjs";
import { recaptionStage } from "../src/recaption-stage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");
const PIPELINE_MJS = path.join(ROOT, "pipeline.mjs");
const JOB_ID = "recaption-render-plan-check-job";
const WORK_DIR = path.join(WORK_ROOT, JOB_ID);
const OUT_DIR = path.join(OUT_ROOT, JOB_ID);

const SRC_W = 320, SRC_H = 180, SRC_FPS = 10;
const TOTAL_SEC = 4.0;
const EXPECT_TRIMMED_SEC = 1.3; // word "A"(0.5s) + 余韻(0.3s) + word "B"(0.5s)
const DURATION_TOLERANCE_SEC = 0.15;
const GUARDED_W = 320, GUARDED_H = 568; // computeCanvas(portrait, 320, 180) の実測値

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

function ffmpegAvailable() {
  return new Promise((res) => {
    const p = spawn("ffmpeg", ["-version"], { windowsHide: true });
    p.on("error", () => res(false));
    p.on("close", (c) => res(c === 0));
  });
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", args, { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  if (!(await ffmpegAvailable())) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }

  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-recaption-plan-"));
  const sample = path.join(tmp, "sample-320x180.mp4");
  await runFfmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc=size=${SRC_W}x${SRC_H}:rate=${SRC_FPS}:duration=${TOTAL_SEC}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${TOTAL_SEC}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    sample,
  ]);
  report("前提: 検証用の合成素材(320x180・10fps・4秒)を生成した", fs.existsSync(sample));

  // state.json（cmdRender が読む。trim:"on" はサーバー経路(pipeline-runner.mjs)が
  // 付与するフィールドで、CLI initは付けないためここで直接書く）。
  fs.writeFileSync(
    path.join(WORK_DIR, "state.json"),
    JSON.stringify({
      id: JOB_ID, input: sample, mode: "topic", sub: "on", orient: "portrait", trim: "on",
    }, null, 2),
    "utf-8",
  );

  // 2026-08-16: trim:"on" のときは、どこを詰めてよいかのAIの判断(trim-judge.json)が要る
  // （G-EDIT-TRIM2-FAILSTOP。無いと render は止まる）。この検査の主題は焼き直しの計画なので、
  // AI が「どの間も詰めてよい」と答えた状態を再現する。
  fs.writeFileSync(
    path.join(WORK_DIR, "trim-judge.json"),
    JSON.stringify({ fillers: [], cutGaps: [0, 1], total: 2, dropped: [] }),
    "utf-8",
  );

  // transcript.json: 先頭0.5秒と末尾0.5秒だけに語があり、間3.0秒は無音（詰められる）。
  fs.writeFileSync(
    path.join(WORK_DIR, "transcript.json"),
    JSON.stringify({
      language: "en", duration: TOTAL_SEC,
      words: [
        { w: "ALPHA", start: 0.0, end: 0.5 },
        { w: "BETA", start: 3.5, end: 4.0 },
      ],
      segments: [{ start: 0.0, end: TOTAL_SEC, text: "ALPHA BETA" }],
    }, null, 2),
    "utf-8",
  );

  // llm-response.json: 逆マッチングで exact match するよう、両語を連結した keepText にする。
  fs.writeFileSync(
    path.join(WORK_DIR, "llm-response.json"),
    JSON.stringify({ segments: [{ keepText: "ALPHA BETA", hook: "テスト" }] }, null, 2),
    "utf-8",
  );

  // ── 初回レンダ（本物の pipeline.mjs render を通す） ──────────────────
  const renderResult = await runNode(
    [PIPELINE_MJS, "render", WORK_DIR, "--mode", "topic"],
    { CLIP_PAD_HEAD: "0", CLIP_PAD_TAIL: "0" },
  );
  report("初回レンダ: pipeline.mjs render が成功する(exit 0)",
    renderResult.code === 0, `stderr=${renderResult.stderr.slice(-500)}`);

  const candPath = path.join(OUT_DIR, "candidates.json");
  const cand = JSON.parse(fs.readFileSync(candPath, "utf-8"));
  report("初回レンダ: 候補が1本ある", cand.candidates && cand.candidates.length === 1,
    JSON.stringify(cand.candidates));
  const entry = cand.candidates[0];

  // ── 生成側(pipeline.mjs)の検証: manifest に renderPlan と srcW/srcH が書かれているか ──
  report("AUD-P1-02a(生成側): candidates.json の候補に renderPlan.keep が書かれている",
    !!(entry.renderPlan && Array.isArray(entry.renderPlan.keep) && entry.renderPlan.keep.length > 0),
    JSON.stringify(entry.renderPlan));
  report("AUD-P1-02a(生成側): renderPlan.clipDuration が詰め後の尺(≈1.0秒)になっている",
    entry.renderPlan && Math.abs(entry.renderPlan.clipDuration - EXPECT_TRIMMED_SEC) < DURATION_TOLERANCE_SEC,
    `実=${entry.renderPlan && entry.renderPlan.clipDuration}`);
  report("AUD-P1-02b(生成側): candidates.json 直下に実素材解像度 srcW/srcH が書かれている",
    cand.srcW === SRC_W && cand.srcH === SRC_H,
    `実=${cand.srcW}x${cand.srcH}`);

  const firstOutPath = path.join(OUT_DIR, entry.file);
  const firstSize = await probeSize(firstOutPath);
  report(`前提: 初回レンダの出力解像度が拡大ガード後の ${GUARDED_W}x${GUARDED_H} である`,
    firstSize.width === GUARDED_W && firstSize.height === GUARDED_H,
    `実=${firstSize.width}x${firstSize.height}`);

  const firstProbe = await ffprobeDuration(firstOutPath);
  report(`前提: 初回レンダの出力尺が詰め後(≈${EXPECT_TRIMMED_SEC}秒)になっている`,
    Math.abs(firstProbe - EXPECT_TRIMMED_SEC) < DURATION_TOLERANCE_SEC,
    `実=${firstProbe}`);

  // ── 焼き直し（本物の recaptionStage() を呼ぶ） ──────────────────────
  const recapResult = await recaptionStage({ workDir: WORK_DIR, outDir: OUT_DIR, onLog: () => {} });
  report("焼き直し: recaptionStage が1本再構築したと報告する", recapResult.rebuilt === 1,
    JSON.stringify(recapResult));

  const afterSize = await probeSize(firstOutPath);
  const afterDuration = await ffprobeDuration(firstOutPath);

  // ── AUD-P1-02a: 焼き直し後もトリム尺(≈1秒)が保持される（4秒に戻らない） ──────
  report(
    `AUD-P1-02a: 焼き直し後の出力尺が ${EXPECT_TRIMMED_SEC}秒 前後のまま保持される(実=${afterDuration.toFixed(3)}秒)`,
    Math.abs(afterDuration - EXPECT_TRIMMED_SEC) < DURATION_TOLERANCE_SEC,
  );
  report(
    `対照: 焼き直し後の出力尺は raw な区間長(4.0秒)には戻っていない(実=${afterDuration.toFixed(3)}秒)`,
    Math.abs(afterDuration - TOTAL_SEC) > 1.0,
  );

  // ── AUD-P1-02b: 焼き直し後も解像度が保持される（既定の1080x1920にドリフトしない） ──
  report(
    `AUD-P1-02b: 焼き直し後の解像度が初回レンダと一致する(初回=${firstSize.width}x${firstSize.height} / 後=${afterSize.width}x${afterSize.height})`,
    afterSize.width === firstSize.width && afterSize.height === firstSize.height,
  );
  report(
    `対照: 焼き直し後の解像度は拡大ガード無視の既定値(1080x1920)にはドリフトしていない(実=${afterSize.width}x${afterSize.height})`,
    !(afterSize.width === 1080 && afterSize.height === 1920),
  );

  console.log(`\n--- ${fail === 0 ? "ALL PASS" : fail + " FAIL"} (${pass} PASS) ---`);
  return fail;
}

function ffprobeDuration(file) {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file];
    const p = spawn("ffprobe", args, { windowsHide: true });
    let out = "";
    p.stdout.on("data", (c) => (out += c.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe code ${code}`));
      resolve(Number(out.trim()));
    });
  });
}

main()
  .then((fail) => process.exit(fail === 0 ? 0 : 1))
  .catch((e) => {
    console.log("FAIL 例外: " + (e.stack || e.message));
    process.exit(1);
  })
  .finally(() => {
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  });
