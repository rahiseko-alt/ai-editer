// 軽い配布物（顔モザイク無し）の検査 — ロードマップ G-SLIM。
// 実行: node tests/dist-slim-check.mjs   (PASSで exit 0)
//
// 各テストは葉と1対1に対応する:
//   S-1 軽い配布物がメールに添付できる大きさに収まる
//   S-2 軽い版の手順書に、使えない機能の案内が無い
//   S-3 軽い版に入っているものだけで、縦型ショートが出来上がる
//   S-4 標準版は従来どおり顔を隠せる

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(ROOT, "..");
const DIST = path.join(PKG, "..", "dist");
const SLIM = path.join(DIST, "ai-editer-video-shorts-slim");
const FULL = path.join(DIST, "ai-editer-video-shorts");
const LIMIT_MB = 30;

let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name} ${extra}`);
  }
};

const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

// 前提: 両方の配布物を作り直す（前回ビルドの残骸で判定しない）
execFileSync("node", [path.join(PKG, "build-dist.mjs"), "--slim"], { stdio: "ignore" });
execFileSync("node", [path.join(PKG, "build-dist.mjs")], { stdio: "ignore" });

// ---------------------------------------------------------------- S-1
// zip を実際に作って測る。「たぶん小さいはず」ではなく、客が受け取る形で測る。
check(
  "S-1: 大きさを測るのに必要な zip が使える（前提の確認）",
  has("zip"),
  "zip が見つかりません。CI(ubuntu-latest)には同梱されています。",
);
const zipPath = path.join(os.tmpdir(), `slim-check-${process.pid}.zip`);
fs.rmSync(zipPath, { force: true });
execFileSync("sh", ["-c",
  `cd ${JSON.stringify(DIST)} && zip -qr ${JSON.stringify(zipPath)} ai-editer-video-shorts-slim`]);
const zipMB = fs.statSync(zipPath).size / 1e6;
check(
  "S-1: 軽い版の配布物(zip)が30MB以内に収まる",
  zipMB <= LIMIT_MB,
  `実測 ${zipMB.toFixed(1)}MB（上限 ${LIMIT_MB}MB）`,
);
fs.rmSync(zipPath, { force: true });

// ---------------------------------------------------------------- S-2
// 入っていない機能を勧められて、客が実行して失敗するのを防ぐ。
const slimSkill = fs.readFileSync(
  path.join(SLIM, "skill", "video-shorts", "SKILL.md"), "utf-8");
const BANNED = ["モザイク", "apply_mosaic_cli.py", "face_choices.py", "face_mosaic"];
const leftover = BANNED.filter((w) => slimSkill.includes(w));
check(
  "S-2: 軽い版の手順書に、顔モザイクの質問・手順・スクリプト名が含まれない",
  leftover.length === 0,
  `残っている語: ${JSON.stringify(leftover)}`,
);
// 目印そのものが客に見えてしまっていないか（削り漏れの検出）
check(
  "S-2: 手順書に加工用の目印が残っていない",
  !slimSkill.includes("mosaic:start") && !slimSkill.includes("mosaic:end"),
);
// 使わない依存を客に入れさせない
const slimReq = fs.readFileSync(path.join(SLIM, "requirements.txt"), "utf-8");
check(
  "S-2: 軽い版が、使わない依存(opencv)の導入を求めない",
  !slimReq.includes("opencv"),
);

// ---------------------------------------------------------------- S-3
// 削った結果、肝心の編集が動かなくなっていないことを、実際に動画を作って確かめる。
check(
  "S-3: 成果物まで検証するのに必要な ffmpeg が使える（前提の確認）",
  has("ffmpeg") && has("ffprobe"),
  "ffmpeg/ffprobe が見つかりません。CI では quality ジョブで導入しています。",
);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slim-render-"));
const srcVideo = path.join(tmp, "src.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=15:duration=3",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", srcVideo]);
const outVideo = path.join(tmp, "out.mp4");
let rendered = false;
let renderErr = "";
try {
  // 軽い版に入っている実コードだけを読み込んで縦型へ変換する
  const { renderClip, probeSize } = await import(
    path.join(SLIM, "src", "render-vertical.mjs"));
  await renderClip({ input: srcVideo, start: 0, end: 2, output: outVideo });
  const size = await probeSize(outVideo);
  rendered = size.height > size.width;
  renderErr = `${size.width}x${size.height}`;
} catch (e) {
  renderErr = String(e.message).split("\n")[0].slice(0, 200);
}
check(
  "S-3: 軽い版に含まれるものだけで、縦型のmp4が生成される",
  rendered,
  renderErr,
);
fs.rmSync(tmp, { recursive: true, force: true });

// ---------------------------------------------------------------- S-4
// 軽い版を足したせいで、今までの配布物が壊れていないか。
const fullSkill = fs.readFileSync(
  path.join(FULL, "skill", "video-shorts", "SKILL.md"), "utf-8");
check(
  "S-4: 標準版にモザイクのモデルとスクリプトが従来どおり含まれる",
  fs.existsSync(path.join(FULL, "src", "models", "face_detection_yunet_2023mar.onnx")) &&
    fs.existsSync(path.join(FULL, "src", "models", "face_recognition_sface_2021dec.onnx")) &&
    fs.existsSync(path.join(FULL, "src", "apply_mosaic_cli.py")),
);
check(
  "S-4: 標準版の手順書にモザイクを焼く手順が残っている",
  fullSkill.includes("apply_mosaic_cli.py") && fullSkill.includes("省略禁止"),
);
check(
  "S-4: 標準版の手順書にも加工用の目印が出ていない",
  !fullSkill.includes("mosaic:start"),
);

console.log(`\n--- ${passed} PASS / ${failed} FAIL ---`);
process.exit(failed ? 1 : 0);
