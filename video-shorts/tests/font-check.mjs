// 字幕フォントが実在するかの確認、および「文字起こし前に止まる」ことの検証 — M3
// (User Goal「使えない環境では、時間を無駄にする前に止まる」)
//
// 実素材の初回処理で、既定フォント "Yu Gothic UI"（Windows専用）がこの環境に無いまま
// fontconfig が黙って中国語フォントへ代替し、10分の処理を終えたあとの焼き込み段階で
// 初めて壊れた見た目が判明した(docs/failures.md 2026-08-14)。この検査は2点を守る。
//   (1) checkFontAvailable() が「実在するフォント名だがこの環境には無い名前」
//       （まさに事故の原因だった "Yu Gothic UI"）・明らかに架空の名前・不正な入力の
//       いずれでも正しく「無い」と判定すること(3種)。
//   (2) node pipeline.mjs init --sub on が、フォントが無い環境では文字起こしより前
//       （＝init コマンドの時点）で非ゼロ終了し、フォントがある環境・字幕なしの場合は
//       通ること。
//
// 実行: node tests/font-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkFontAvailable } from "../src/font-check.mjs";
import { DEFAULT_FONT } from "../src/srt-builder.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(ROOT, "..", "pipeline.mjs");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

// ── (1) checkFontAvailable の3種の入力 ──────────────────────────────────
check(
  "実在するフォント(IPAGothic)は ok=true",
  checkFontAvailable("IPAGothic").ok === true,
);
check(
  "実在するフォント名だがこの環境には無い名前(Yu Gothic UI＝実際の事故原因)は ok=false",
  checkFontAvailable("Yu Gothic UI").ok === false
    && checkFontAvailable("Yu Gothic UI").reason.includes("Yu Gothic UI"),
  JSON.stringify(checkFontAvailable("Yu Gothic UI")),
);
check(
  "明らかに架空のフォント名は ok=false",
  checkFontAvailable("__NO_SUCH_FONT_ZZZ__").ok === false,
);
check(
  "空文字列・未指定は ok=false（黙って既定へ倒れない）",
  checkFontAvailable("").ok === false && checkFontAvailable(undefined).ok === false,
);
check(
  "現在の製品既定(DEFAULT_FONT)は、この検査を書いた環境で実際に見つかる",
  checkFontAvailable(DEFAULT_FONT).ok === true,
  `DEFAULT_FONT=${DEFAULT_FONT}`,
);

// ── (2) init コマンドの統合動作 ──────────────────────────────────────────
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
if (!has("ffmpeg")) {
  console.log("SKIP: ffmpeg が見つからないため入力素材を合成できません（(2)はスキップ）");
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "font-check-init-"));
  const input = path.join(tmp, "src.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", input]);

  const fakeBinDir = path.join(tmp, "fakebin");
  fs.mkdirSync(fakeBinDir);
  // fc-list を「何も返さない」実装で差し替え、フォントが1つも無い環境を模す。
  fs.writeFileSync(path.join(fakeBinDir, "fc-list"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(fakeBinDir, "fc-list"), 0o755);
  const envNoFont = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` };

  const runInit = (extraEnv, subFlag) => spawnSync(
    "node", [PIPELINE, "init", input, "--mode", "topic", "--sub", subFlag, "--orient", "portrait"],
    { encoding: "utf-8", env: extraEnv, cwd: path.join(ROOT, "..") },
  );

  const rNoFontSubOn = runInit(envNoFont, "on");
  check(
    "フォントが無い環境で --sub on だと、init が非ゼロ終了する（文字起こしより前）",
    rNoFontSubOn.status !== 0,
    `status=${rNoFontSubOn.status}`,
  );
  check(
    "その失敗メッセージに、使おうとしたフォント名が挙げられている",
    (rNoFontSubOn.stderr || "").includes(DEFAULT_FONT),
    rNoFontSubOn.stderr,
  );

  const rNoFontSubOff = runInit(envNoFont, "off");
  check(
    "フォントが無い環境でも --sub off なら init は成功する（字幕を使わないので無関係）",
    rNoFontSubOff.status === 0,
    `status=${rNoFontSubOff.status} stderr=${rNoFontSubOff.stderr}`,
  );

  const rRealFontSubOn = runInit(process.env, "on");
  check(
    "フォントがある(実際の)環境では --sub on でも init が成功する",
    rRealFontSubOn.status === 0,
    `status=${rRealFontSubOn.status} stderr=${rRealFontSubOn.stderr}`,
  );

  // 対照: フォント確認そのものを削除した実装なら、上の「無い環境で落ちる」検査が
  // 満たされないはず、というのが検出力の裏付け（このプロセスでは削除できないので、
  // fakebin が実際に使われている＝差し替えが効いていることを別途確認する）。
  const fakeCheck = spawnSync("sh", ["-c", "command -v fc-list"], { env: envNoFont, encoding: "utf-8" });
  check(
    "対照: フォント無し環境の PATH 差し替えが実際に効いている(fc-listがfakebinを指す)",
    (fakeCheck.stdout || "").trim() === path.join(fakeBinDir, "fc-list"),
    fakeCheck.stdout,
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
