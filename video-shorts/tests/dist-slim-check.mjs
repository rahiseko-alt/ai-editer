// 軽い配布物（顔モザイク無し）の検査 — ロードマップ G-SLIM。
// 実行: node tests/dist-slim-check.mjs   (PASSで exit 0)
//
// 各テストは葉と1対1に対応する:
//   S-1 軽い配布物がメールに添付できる大きさに収まる
//   S-2 軽い版の手順書に、使えない機能の案内が無い
//   S-3 軽い版に入っているものだけで、縦型ショートが出来上がる
//   S-4 標準版は従来どおり顔を隠せる
//   S-5 軽い版に、顔モザイク関連の実ファイルが存在しない
//   S-6 標準版・軽量版どちらのSKILL.mdにも、ビルド用の内部目印(mosaic:start/end)が残っていない
//   P1-10 配布ビルドが空stagingからallowlist方式でコピーされ、未追跡ファイルを混入させない

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(ROOT, "..");
const DIST = path.join(PKG, "..", "dist");
const SLIM = path.join(DIST, "kosespark-video-shorts-slim");
const FULL = path.join(DIST, "kosespark-video-shorts");
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
  `cd ${JSON.stringify(DIST)} && zip -qr ${JSON.stringify(zipPath)} kosespark-video-shorts-slim`]);
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

// ---------------------------------------------------------------- P1-10
// 配布ビルドが「空stagingからallowlist方式」でコピーされ、未追跡ファイルを混入させないこと。
// 「本当に空stagingから作っているか」は、既存のdist配下に手動コピー等を模した“侵入者”ファイルを
// 事前に仕込んでおき、build-dist.mjs実行後にそれが消えている（＝生成物がallowlistと完全一致し
// 余剰ファイルが0件）ことで確かめる。もし現状のように「既知のディレクトリ名だけ部分削除」
// していると、この侵入者ファイルは生き残ってしまい FAIL する。
const ALLOWLIST_TOP = ["start-here.md", "pipeline.mjs", "requirements.txt", "version.txt", "src", "tests", "skill"];
function seedIntruders(distDir) {
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "old-build-leftover.txt"), "stale\n", "utf-8");
  fs.mkdirSync(path.join(distDir, "ui"), { recursive: true }); // 配布廃止済みだったディレクトリ名の残骸を模す
  fs.writeFileSync(path.join(distDir, "ui", "index.html"), "stale\n", "utf-8");
  fs.mkdirSync(path.join(distDir, "skill"), { recursive: true });
  fs.writeFileSync(path.join(distDir, "skill", "untracked-note.md"), "stale\n", "utf-8"); // skill/配下への直接混入も模す
}
seedIntruders(SLIM);
seedIntruders(FULL);
execFileSync("node", [path.join(PKG, "build-dist.mjs"), "--slim"], { stdio: "ignore" });
execFileSync("node", [path.join(PKG, "build-dist.mjs")], { stdio: "ignore" });
for (const [label, dir] of [["軽い版", SLIM], ["標準版", FULL]]) {
  const actualTop = fs.readdirSync(dir).sort();
  const expectedTop = [...ALLOWLIST_TOP].sort();
  const extra = actualTop.filter((n) => !expectedTop.includes(n));
  const missing = expectedTop.filter((n) => !actualTop.includes(n));
  check(
    `P1-10: ${label}の配布物(dist直下)が許可リストと完全一致し、仕込んだ未追跡ファイルが混入せず消えている(余剰0件)`,
    extra.length === 0 && missing.length === 0,
    `余剰: ${JSON.stringify(extra)} / 不足: ${JSON.stringify(missing)}`,
  );
  // skill/配下に直接仕込んだ侵入者（untracked-note.md）も、allowlist方式なら残らない。
  check(
    `P1-10: ${label}のskill/配下にも、仕込んだ未追跡ファイルが残っていない`,
    !fs.existsSync(path.join(dir, "skill", "untracked-note.md")),
  );
}

// ---------------------------------------------------------------- S-5
// build-dist.mjsのMOSAIC_FILES除外を直接検証する。除外リストの更新漏れ（新しいモザイク関連
// ファイルを足したのに配布除外リストへ追加し忘れる 等）を、パスの存在確認で機械的に検知する。
const MOSAIC_PATHS_UNDER_SLIM = [
  path.join("src", "models"),
  path.join("src", "apply_mosaic_cli.py"),
  path.join("src", "face_mosaic.py"),
  path.join("src", "face_choices.py"),
];
for (const rel of MOSAIC_PATHS_UNDER_SLIM) {
  check(
    `S-5: 軽い版のdistに ${rel} が存在しない`,
    !fs.existsSync(path.join(SLIM, rel)),
  );
}

// ---------------------------------------------------------------- S-6
// 標準版・軽量版どちらのSKILL.mdにも、ビルド用の内部目印(mosaic:start/end)が残っていないこと。
// S-2/S-4は「モザイク機能の案内が無い」ことを検証する目的の副産物として目印の一部（主に軽い版側）
// を見ているに過ぎず、標準版のmosaic:endは見ていなかった。ここでは両distのSKILL.mdそれぞれに対して
// 両方の目印文字列を横断でチェックし、S-6が指す事実そのものを直接カバーする。
const skillPaths = {
  "軽い版": path.join(SLIM, "skill", "video-shorts", "SKILL.md"),
  "標準版": path.join(FULL, "skill", "video-shorts", "SKILL.md"),
};
const leftoverMarkers = [];
for (const [label, p] of Object.entries(skillPaths)) {
  const text = fs.readFileSync(p, "utf-8");
  for (const marker of ["mosaic:start", "mosaic:end"]) {
    if (text.includes(marker)) leftoverMarkers.push(`${label}:${marker}`);
  }
}
check(
  "S-6: 標準版・軽量版どちらのSKILL.mdにも mosaic:start / mosaic:end の文字列が含まれない",
  leftoverMarkers.length === 0,
  `残っている目印: ${JSON.stringify(leftoverMarkers)}`,
);

console.log(`\n--- ${passed} PASS / ${failed} FAIL ---`);
process.exit(failed ? 1 : 0);
