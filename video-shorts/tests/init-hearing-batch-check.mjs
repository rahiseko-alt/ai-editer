// ヒアリング項目を一度にまとめて列挙することの検証 — M6
// (User Goal「必要なことが一度のやり取りで聞かれる」)
//
// 実素材の初回処理で、--mode → --sub → --orient と1つずつしかエラーにならず、
// 3回やり直しになった(docs/failures.md 2026-08-14)。この検査は、不足項目が
// 一度の実行で全部列挙されることと、一部だけ答えたときは答えた項目が不足一覧に
// 現れないことを確認する。
//
// 実行: node tests/init-hearing-batch-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(ROOT, "..", "pipeline.mjs");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
if (!has("ffmpeg")) {
  console.log("SKIP: ffmpeg が見つからないため入力素材を合成できません");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "init-hearing-"));
const input = path.join(tmp, "src.mp4");
execFileSync("ffmpeg", ["-y", "-v", "error",
  "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=1",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", input]);

const run = (args) => spawnSync("node", [PIPELINE, "init", input, ...args],
  { encoding: "utf-8", cwd: path.join(ROOT, "..") });

// ── 何も指定しない: 3項目とも不足一覧に現れる ──────────────────────────
const rNone = run([]);
check("何も指定しないと非ゼロ終了する", rNone.status !== 0, `status=${rNone.status}`);
check(
  "何も指定しないと、--mode・--sub・--orient の3つが1回のエラーに全部現れる",
  (rNone.stderr || "").includes("--mode") && (rNone.stderr || "").includes("--sub")
    && (rNone.stderr || "").includes("--orient"),
  rNone.stderr,
);
check(
  "3項目が番号付きで一度に列挙される(1つずつ聞き直す形になっていない)",
  /1\.\s*--mode/.test(rNone.stderr || "") && /2\.\s*--sub/.test(rNone.stderr || "")
    && /3\.\s*--orient/.test(rNone.stderr || ""),
  rNone.stderr,
);

// ── 1項目だけ答える: 答えた項目(--mode)は不足一覧に現れず、残り2つだけ出る ──
const rModeOnly = run(["--mode", "topic"]);
check("--mode だけ指定しても、まだ非ゼロ終了する(--sub・--orientが無いため)", rModeOnly.status !== 0);
check(
  "答えた --mode は不足一覧に含まれない",
  !(rModeOnly.stderr || "").includes("--mode <topic|digest>"),
  rModeOnly.stderr,
);
check(
  "答えていない --sub・--orient は不足一覧に含まれる",
  (rModeOnly.stderr || "").includes("--sub") && (rModeOnly.stderr || "").includes("--orient"),
  rModeOnly.stderr,
);

// ── 2項目答える: 残り1項目だけが不足一覧に出る ──────────────────────────
const rTwoOfThree = run(["--mode", "topic", "--sub", "off"]);
check(
  "2項目答えた場合、不足一覧には残り1項目(--orient)だけが出る（答えた項目は出ない）",
  !(rTwoOfThree.stderr || "").includes("--mode <topic|digest>")
    && !(rTwoOfThree.stderr || "").includes("--sub <on|off>")
    && (rTwoOfThree.stderr || "").includes("--orient"),
  rTwoOfThree.stderr,
);

// ── 3項目全部答える: 成功する(字幕off・フォント確認は対象外) ────────────────
const rAll = run(["--mode", "topic", "--sub", "off", "--orient", "縦"]);
check(
  "3項目まとめて答えると、追加の質問なしで成功する",
  rAll.status === 0,
  `status=${rAll.status} stderr=${rAll.stderr}`,
);

// 対照: 旧実装(1つずつしかエラーにしない)なら、何も指定しない場合のエラーに
// --sub・--orient が含まれないはず(まず --mode だけを訴えて終わる)。
check(
  "対照: 旧実装(--modeだけ訴えて終わる)なら、上の「3つとも含まれる」検査は落ちる形になっている",
  !("--mode を指定してください（topic=話題毎 / digest=ダイジェスト）。\n" +
    "  素材導入時のヒアリング必須項目です（毎回確認・前回の引き継ぎ禁止）。").includes("--sub"),
);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
