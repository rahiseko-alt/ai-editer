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
//   S-7 配布物に ffmpeg/ffprobe の実行バイナリが同梱されていない（軌道修正 C-11）
//   P1-10 配布ビルドが空stagingからallowlist方式でコピーされ、未追跡ファイルを混入させない

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

// ---------------------------------------------------------------- P1-10
// 配布ビルドが「空stagingからallowlist方式」でコピーされ、未追跡ファイルを混入させないこと。
// 「本当に空stagingから作っているか」は、既存のdist配下に手動コピー等を模した“侵入者”ファイルを
// 事前に仕込んでおき、build-dist.mjs実行後にそれが消えている（＝生成物がallowlistと完全一致し
// 余剰ファイルが0件）ことで確かめる。もし現状のように「既知のディレクトリ名だけ部分削除」
// していると、この侵入者ファイルは生き残ってしまい FAIL する。
const ALLOWLIST_TOP = ["start-here.md", "pipeline.mjs", "requirements.txt", "version.txt", "src", "tests", "skill", ".claude"];
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

// ---------------------------------------------------------------- AUD-P1-04
// build-dist.mjs は「ディレクトリを丸ごと再帰コピーし、既知の名前だけ除外リストで弾く」方式だと、
// 除外リストが想定していない場所（例: src/ 直下に置かれた誰かの作業用の秘密ファイル）に
// git 未追跡（untracked）のファイルが1つ紛れ込むだけで、それがそのまま配布物へ入ってしまう。
// ここでは「配布ビルドの入力（video-shorts/src/ 等）」側に未追跡ファイルを実際に置いて、
// dist側だけを検査する従来のP1-10と違う経路（規約が想定していないファイルの混入）を確かめる。
const untrackedProbe = path.join(PKG, "src", "customer-secret-check.txt");
fs.writeFileSync(untrackedProbe, "SECRET-SHOULD-NOT-SHIP\n", "utf-8");
try {
  execFileSync("node", [path.join(PKG, "build-dist.mjs")], { stdio: "ignore" });
  execFileSync("node", [path.join(PKG, "build-dist.mjs"), "--slim"], { stdio: "ignore" });
  check(
    "AUD-P1-04: git未追跡ファイル(video-shorts/src/直下)を置いても標準版distへ混入しない",
    !fs.existsSync(path.join(FULL, "src", "customer-secret-check.txt")),
  );
  check(
    "AUD-P1-04: git未追跡ファイル(video-shorts/src/直下)を置いても軽い版distへ混入しない",
    !fs.existsSync(path.join(SLIM, "src", "customer-secret-check.txt")),
  );
} finally {
  fs.rmSync(untrackedProbe, { force: true });
}
// 対照(有るときに有ると言えること): 上のprobeが仮に本当にコピーされる実装だったとしても、
// このテストの exists 判定自体が「混入している」を正しく検出できることを、
// dist側へ直接同名ファイルを置いて自己検証する。
{
  const distIntruder = path.join(FULL, "src", "customer-secret-check.txt");
  fs.writeFileSync(distIntruder, "x\n", "utf-8");
  check(
    "AUD-P1-04 対照: distに直接同名ファイルが有るときは exists 判定が実際にそれを検出する",
    fs.existsSync(distIntruder),
  );
  fs.rmSync(distIntruder, { force: true });
}

// symlink は fail-closed（配布ビルドが中止される）ことを確認する。
// untracked のシンボリックリンクは（上の未追跡ファイルと同じ理由で）そもそも git ls-files に
// 出てこず構造的に混入しないため、ここでは「git 管理下にある symlink」を模して
// `git add -f` で一時的に index へ乗せ、tracked な symlink が実際に拒否されることを確かめる
// （commit はしない・テスト終了時に index から外し symlink 自体も削除する）。
{
  const symlinkRel = path.join("src", "customer-secret-symlink-check");
  const symlinkAbs = path.join(PKG, symlinkRel);
  fs.rmSync(symlinkAbs, { force: true });
  fs.symlinkSync("/etc/hostname", symlinkAbs);
  execFileSync("git", ["add", "-f", symlinkRel], { cwd: PKG });
  let buildFailed = false;
  let buildMsg = "";
  try {
    execFileSync("node", [path.join(PKG, "build-dist.mjs")], { stdio: "pipe" });
  } catch (e) {
    buildFailed = true;
    buildMsg = String((e.stderr && e.stderr.toString()) || e.message).split("\n")[0].slice(0, 200);
  } finally {
    execFileSync("git", ["reset", symlinkRel], { cwd: PKG, stdio: "ignore" });
    fs.rmSync(symlinkAbs, { force: true });
    // symlink無しの状態へ作り直し、後続テストの前提(正常なdist)を汚さない。
    execFileSync("node", [path.join(PKG, "build-dist.mjs")], { stdio: "ignore" });
    execFileSync("node", [path.join(PKG, "build-dist.mjs"), "--slim"], { stdio: "ignore" });
  }
  check(
    "AUD-P1-04: git管理下のsymlinkはfail-closedで配布ビルドが中止される（追従・コピーされない）",
    buildFailed,
    buildMsg,
  );
}

// ---------------------------------------------------------------- AUD-P2-17a
// start-here.md 冒頭は「PCを持たないクラウドセッション利用者向けに .claude/hooks/session-start.sh が
// 自動導入済み」と明言している。この記述が嘘にならないよう、実際に配布物へ含まれることを直接検査する。
for (const [label, dir] of [["軽い版", SLIM], ["標準版", FULL]]) {
  const hookPath = path.join(dir, ".claude", "hooks", "session-start.sh");
  check(
    `AUD-P2-17a: ${label}のdistに .claude/hooks/session-start.sh が存在する`,
    fs.existsSync(hookPath),
  );
  if (fs.existsSync(hookPath)) {
    const mode = fs.statSync(hookPath).mode & 0o777;
    check(
      `AUD-P2-17a: ${label}の .claude/hooks/session-start.sh が実行可能権限を持つ`,
      (mode & 0o100) !== 0,
      `実際のmode=${mode.toString(8)}`,
    );
  }
  // .claude/ 配下は session-start.sh 以外(このテンプレリポジトリ自身の統治用ファイル群)を
  // 客の配布物へ持ち込まない(agents/・skills/・settings.json・check-uncommitted.sh 等)。
  const claudeDir = path.join(dir, ".claude");
  const claudeTop = fs.existsSync(claudeDir) ? fs.readdirSync(claudeDir) : null;
  check(
    `AUD-P2-17a: ${label}のdistの.claude/直下にはhooks/以外の何も無い`,
    !!claudeTop && claudeTop.length === 1 && claudeTop[0] === "hooks",
    `実際の中身=${JSON.stringify(claudeTop)}`,
  );
  const hooksDir = path.join(dir, ".claude", "hooks");
  const hooksTop = fs.existsSync(hooksDir) ? fs.readdirSync(hooksDir) : null;
  check(
    `AUD-P2-17a: ${label}のdistの.claude/hooks/直下にはsession-start.sh以外の何も無い(check-uncommitted.sh等を持ち込まない)`,
    !!hooksTop && hooksTop.length === 1 && hooksTop[0] === "session-start.sh",
    `実際の中身=${JSON.stringify(hooksTop)}`,
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

// ---------------------------------------------------------------- S-7（軌道修正 C-11）
// ffmpeg/ffprobe はホストにある前提(M-4-C系の制約)で、配布物には絶対に同梱しない。
// 同梱した瞬間、手元の GPL 版(--enable-gpl)や客が入れる gyan.dev ビルド(GPLv3)の
// 再配布者になってしまうため、dist を実際に歩いて実行バイナリが混ざっていないことを検査する。
// ファイル名の完全一致(大小文字を区別しない)と、拡張子違い(.exe 等)の両方を見る。
function walkFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}
const BANNED_BASENAMES = new Set(["ffmpeg", "ffprobe", "ffmpeg.exe", "ffprobe.exe"]);
function findBundledFfmpeg(dir) {
  return walkFiles(dir).filter((p) => BANNED_BASENAMES.has(path.basename(p).toLowerCase()));
}
for (const [label, dir] of [["軽い版", SLIM], ["標準版", FULL]]) {
  const found = findBundledFfmpeg(dir);
  check(
    `S-7: ${label}の配布物に ffmpeg/ffprobe の実行バイナリが同梱されていない`,
    found.length === 0,
    `見つかったファイル=${JSON.stringify(found.map((p) => path.relative(dir, p)))}`,
  );
}
// 対照(有るときに有ると言えること): 実際に偽のバイナリを1つ仕込み、検出できることを自己検証する。
// 合成物はコミットしない(テスト内で作って消す)。
const probeDir = path.join(FULL, "src");
const probePath = path.join(probeDir, "ffmpeg");
fs.writeFileSync(probePath, "#!/bin/sh\necho fake\n", { mode: 0o755 });
try {
  const detected = findBundledFfmpeg(FULL);
  check(
    "S-7 対照: dist に ffmpeg という名前のファイルを1つ仕込むと、検査が実際にそれを検出する",
    detected.length === 1 && path.basename(detected[0]) === "ffmpeg",
    `検出=${JSON.stringify(detected.map((p) => path.relative(FULL, p)))}`,
  );
} finally {
  fs.rmSync(probePath, { force: true });
}

console.log(`\n--- ${passed} PASS / ${failed} FAIL ---`);
process.exit(failed ? 1 : 0);
