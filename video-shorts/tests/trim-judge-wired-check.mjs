// tests/trim-judge-wired-check.mjs — G-TRIM2-CLIP-WIRED
//
// 【見ているもの】trim-judge.mjs / trim-plan.mjs の純粋関数がいくら正しくても、pipeline.mjs の
// renderSegment がそれらを正しく配線していなければ意味が無い（G-CAP-FIT-WIRED と同じ理由）。
// 実際に ffmpeg を1回起動して2本のクリップを焼き、2本目の出力尺を ffprobe で実測する。
//
// 【固定素材】tests/fixtures/trim-judge/case-b-multiclip.json と同じ語・判定表を使う。
// 映像そのものはコミットできない（.gitignore）ため、この検査が毎回合成する（安価なテスト用の
// 色+トーン、30fps・26.0秒）。中身は判定に使わない（測るのは焼いた後の音声トラックの尺）。
//
// 期待: クリップ2（[10.0,24.0]・14.0秒）を詰めると 10.9秒 になる（現行のバグでは13.2秒）。
// 2026-08-17: 虎の巻 §3-4 により、詰めたあとの余韻が一律0.3秒から元の間に応じた値へ変わった。
// この素材の『詰めてよい間』は3.0秒なので clamp(0.75,0.3,0.7)=0.7秒 が残り、10.5→10.9 になった。
//
// 【道具が無い環境】ffmpeg/ffprobe が無ければ SKIP ではなく exit 1 にする
// （2026-08-14 の教訓: 道具が無いまま緑を返すのは偽の緑。docs/failures.md）。
//
// 実行: node tests/trim-judge-wired-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const TOL = 0.15; // 継ぎ目3本(clip2内の区間)ぶんのコマ丸め(±1/30秒×3)+ffprobe実測誤差を見込む

function cmdAvailable(bin) {
  return spawnSync(bin, ["-version"]).status === 0;
}
if (!cmdAvailable("ffmpeg") || !cmdAvailable("ffprobe")) {
  console.error("[ERROR] ffmpeg/ffprobe が見つかりません。この検査は道具が無いまま緑を返しません。");
  process.exit(1);
}

let pass = 0,
  fail = 0;
function report(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(HERE, "fixtures", "trim-judge", "case-b-multiclip.json"), "utf-8"),
);
const ALL_WORDS = FIXTURE.words.map((w) => ({ w: w.w, start: w.start, end: w.end }));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-judge-wired-"));
const SRC = path.join(dir, "src.mp4");
const FPS = 30;
const SR = 22050;
const MATERIAL_DUR = 26.0;

function probeSec(p) {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", p],
    { encoding: "utf-8" },
  ).trim();
  return Number(out);
}

/** 実際に pipeline.mjs / trim-judge.mjs を import して2クリップぶん焼く（別プロセス）。 */
async function renderBothClips() {
  const pl = await import(pathToFileURL(path.join(ROOT, "pipeline.mjs")).href);
  const tj = await import(pathToFileURL(path.join(ROOT, "src", "trim-judge.mjs")).href);
  const judge = tj.judgeFor({
    fillers: new Set(FIXTURE.trimJudge.fillers),
    cutGaps: new Set(FIXTURE.trimJudge.cutGaps),
  });
  const clips = [FIXTURE.clip1, FIXTURE.clip2];
  const outs = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const out = path.join(dir, `clip${i}.mp4`);
    const r = await pl.renderSegment({
      input: SRC,
      seg: { start: c.start, end: c.end, duration: c.end - c.start, hook: "" },
      words: ALL_WORDS,
      srcFps: FPS, srcFpsRational: `${FPS}/1`, srcSampleRate: SR,
      srcW: 160, srcH: 90, orientation: "portrait",
      trim: true, trimSilence: true, trimFiller: true, judge,
      subtitle: null, output: out, onLog: () => {},
    });
    outs.push({ out, keptSeconds: r.clipDuration });
  }
  return outs;
}

try {
  // 安価な合成素材（色+トーン・160x90・30fps・26.0秒）。中身は判定に使わない。
  execFileSync(
    "ffmpeg",
    [
      "-y", "-f", "lavfi", "-i", `testsrc=size=160x90:rate=${FPS}:duration=${MATERIAL_DUR}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${SR}:duration=${MATERIAL_DUR}`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", SRC,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  report("前提: 合成素材(160x90・30fps・26.0秒)を生成した", fs.existsSync(SRC));

  const outs = await renderBothClips();
  report("レンダリング: renderSegment が2本とも実行できた", outs.length === 2 && outs.every((o) => fs.existsSync(o.out)));

  const c1Sec = probeSec(outs[0].out);
  const c2Sec = probeSec(outs[1].out);

  report(
    "対照: 1本目(segStart=0)の出力尺が4.5秒前後（製品経路そのものが動いていることの確認）",
    Math.abs(c1Sec - FIXTURE.expected.clip1KeptSeconds) <= TOL,
    `実測=${c1Sec}秒 期待=${FIXTURE.expected.clip1KeptSeconds}秒`,
  );

  report(
    "G-TRIM2-CLIP-WIRED: 2本目の出力尺がAIの判断どおり10.9秒前後になる（現行のバグでは13.2秒前後）",
    Math.abs(c2Sec - FIXTURE.expected.clip2KeptSeconds) <= TOL,
    `実測=${c2Sec}秒 期待=${FIXTURE.expected.clip2KeptSeconds}秒（バグ時の実測は約${FIXTURE.brokenExpected.clip2KeptSeconds}秒）`,
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
