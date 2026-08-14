// G-EDIT-CAPTION-STYLE-FALLBACK — 指定した書体のフォントファイルが同梱物に無いとき、
// 無言で別書体に化けずエラーで止まることを検証する(2026-08-14のYu Gothic UI事故と同種の
// 再発防止。docs/failures.md参照)。
//
// 実行: node tests/caption-style-fallback-check.mjs   (全PASSで exit 0。ffmpeg必須)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fontFilePath } from "../src/subtitle-styles.mjs";

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

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "caption-fallback-"));
const jobDirs = [];
let renamedAway = null;
try {
  const src = path.join(WORK, "src.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=15:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", src]);

  const HOOK = "FALLBACKWIRE", KEEP_TEXT = "FALLBACKWIRE CHECK OK";
  const transcriptFixturePath = path.join(WORK, "fixture-transcript.json");
  fs.writeFileSync(transcriptFixturePath, JSON.stringify({
    language: "en", duration: 1.0,
    words: [{ w: "FALLBACKWIRE", start: 0.0, end: 0.4 }, { w: "CHECK", start: 0.4, end: 0.7 }, { w: "OK", start: 0.7, end: 0.9 }],
    segments: [{ start: 0.0, end: 0.9, text: KEEP_TEXT }],
  }));

  function makeJob() {
    const initR = spawnSync(process.execPath,
      [PIPELINE, "init", src, "--mode", "topic", "--sub", "on", "--orient", "縦"],
      { cwd: ROOT, encoding: "utf-8" });
    const workDir = (initR.stdout || "").trim();
    jobDirs.push(path.basename(workDir));
    fs.copyFileSync(transcriptFixturePath, path.join(workDir, "transcript.json"));
    spawnSync(process.execPath, [PIPELINE, "select", workDir, "--mode", "topic"], { cwd: ROOT, encoding: "utf-8" });
    fs.writeFileSync(path.join(workDir, "llm-response.json"),
      JSON.stringify({ segments: [{ keepText: KEEP_TEXT, hook: HOOK }] }));
    return workDir;
  }

  // (1) 存在しない書体キーを指定した場合。
  {
    const workDir = makeJob();
    const r = spawnSync(process.execPath,
      [PIPELINE, "render", workDir, "--caption-font", "doesnotexist"],
      { cwd: ROOT, encoding: "utf-8" });
    check(r.status !== 0, "(1) 存在しない書体キーを指定すると、非ゼロ終了で停止する", `status=${r.status}`);
    check(
      (r.stderr || "").includes("doesnotexist"),
      "(1) エラーメッセージに指定した書体キーが含まれる",
      r.stderr,
    );
    check(
      !fs.existsSync(path.join(workDir, "clip-1.ass")),
      "(1) レンダリングが実際に開始されていない(clip-1.assが生成されていない)",
    );
  }

  // (2) 同梱フォントファイルパスを一時的に欠落させた場合(角ゴシック=kakuを使う)。
  {
    const kakuPath = fontFilePath("kaku");
    renamedAway = `${kakuPath}.movedaway-for-test`;
    fs.renameSync(kakuPath, renamedAway);
    const workDir = makeJob();
    const r = spawnSync(process.execPath,
      [PIPELINE, "render", workDir, "--caption-font", "kaku"],
      { cwd: ROOT, encoding: "utf-8" });
    check(r.status !== 0, "(2) 同梱フォントファイルが欠落していると、非ゼロ終了で停止する", `status=${r.status}`);
    check(
      (r.stderr || "").includes("角ゴシック"),
      "(2) エラーメッセージに書体名(角ゴシック)が含まれる",
      r.stderr,
    );
    check(
      !fs.existsSync(path.join(workDir, "clip-1.ass")),
      "(2) レンダリングが実際に開始されていない(clip-1.assが生成されていない)",
    );
    fs.renameSync(renamedAway, kakuPath);
    renamedAway = null;
  }

  // 対照: 正しい書体キー・実在するフォントファイルの場合は同じ経路が正常終了する。
  {
    const workDir = makeJob();
    const r = spawnSync(process.execPath,
      [PIPELINE, "render", workDir, "--caption-font", "kaku"],
      { cwd: ROOT, encoding: "utf-8" });
    check(r.status === 0, "対照: 正しい書体キーでは同じ経路が正常終了する(検出力の裏付け)", r.stderr);
    check(
      fs.existsSync(path.join(workDir, "clip-1.ass")),
      "対照: 正しい書体キーではレンダリングが実際に行われ、clip-1.assが生成される",
    );
  }
} finally {
  if (renamedAway) {
    // テスト自体が例外で落ちた場合でも、同梱フォントを必ず元の場所へ戻す
    // (他のテスト・実運用が壊れたままにならないようにする)。
    const kakuPath = fontFilePath("kaku");
    if (!fs.existsSync(kakuPath) && fs.existsSync(renamedAway)) fs.renameSync(renamedAway, kakuPath);
  }
  fs.rmSync(WORK, { recursive: true, force: true });
  for (const id of jobDirs) {
    fs.rmSync(path.join(ROOT, "work", id), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, "output", id), { recursive: true, force: true });
  }
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
