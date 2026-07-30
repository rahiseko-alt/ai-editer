// tests/cli-job-isolation-check.mjs — P1-8の実地検証。
// 実行: node tests/cli-job-isolation-check.mjs
//
// 同じ名前の動画(例: どちらも lecture.mp4)を別々に処理したとき、CLIジョブの work/output が
// 混線しないことを、実際に `pipeline.mjs init` を2回起動して確認する。
// 以前は id をファイル名のbasenameだけから決めていたため、2回目の init が1回目の
// work/<id>/state.json を上書きし、output/<id> も共有していた(P1-8)。
// 関数を直接呼ぶ単体テストでは「CLIが実際に作るディレクトリ」を検証できないため、
// restart-reconnect-check.mjs と同じく実プロセスを起動する形にする。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PIPELINE = path.join(ROOT, "pipeline.mjs");
const OUT_ROOT = path.join(ROOT, "output");

let pass = 0;
let fail = 0;
function report(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 同名(lecture.mp4)のダミー入力を、別々のフォルダに1つずつ作る */
function makeInput(tmpDir, sub) {
  const dir = path.join(tmpDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "lecture.mp4");
  // init は存在確認しかしないため、中身は識別用の文字列で足りる(ffmpeg不要)。
  fs.writeFileSync(file, `dummy-${sub}`);
  return file;
}

/** pipeline.mjs init を1回実行し、stdoutに出る workDir を返す */
function runInit(input) {
  const r = spawnSync(
    process.execPath,
    [PIPELINE, "init", input, "--mode", "topic", "--sub", "on", "--orient", "縦"],
    { cwd: ROOT, encoding: "utf-8" }
  );
  assert.strictEqual(r.status, 0, `init が失敗しました: ${r.stderr}`);
  return r.stdout.trim();
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-job-isolation-"));
const workDirs = [];
try {
  const inputA = makeInput(tmpDir, "a");
  const inputB = makeInput(tmpDir, "b");

  const workA = runInit(inputA);
  const workB = runInit(inputB);
  workDirs.push(workA, workB);

  report(
    "同名動画で2回 init すると、work が別ディレクトリになる(前のジョブを上書きしない)",
    workA !== workB && fs.existsSync(workA) && fs.existsSync(workB),
    `workA=${workA} workB=${workB}`
  );

  const stateA = JSON.parse(fs.readFileSync(path.join(workA, "state.json"), "utf-8"));
  const stateB = JSON.parse(fs.readFileSync(path.join(workB, "state.json"), "utf-8"));

  report(
    "それぞれの state.json が、自分の入力動画を指したまま干渉しない",
    stateA.input === path.resolve(inputA) && stateB.input === path.resolve(inputB),
    `A.input=${stateA.input} B.input=${stateB.input}`
  );

  // 成果物の置き場(output/<state.id>)は render 時に作られるため、ここでは id から導かれる
  // パスが別になることを確認する(render まで回すと ffmpeg/文字起こしが必要になるため)。
  report(
    "成果物の置き場(output/<id>)も別ディレクトリになる",
    path.join(OUT_ROOT, stateA.id) !== path.join(OUT_ROOT, stateB.id),
    `A=${stateA.id} B=${stateB.id}`
  );

  report(
    "ジョブIDはファイル名由来のprefixを保つ(どの動画のジョブか人が判別できる)",
    stateA.id.startsWith("lecture-") && stateB.id.startsWith("lecture-"),
    `A=${stateA.id} B=${stateB.id}`
  );
} finally {
  for (const d of workDirs) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
