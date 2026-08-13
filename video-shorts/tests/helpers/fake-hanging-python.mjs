#!/usr/bin/env node
// tests/helpers/fake-hanging-python.mjs
// job-cancel-timeout-check.mjs (AUD-P1-11a/11b) が PATH 上の "python" として差し込む偽実装。
// transcribe.py の代わりに呼ばれ、標準入力を読もうとしたまま(誰も書き込まない)一切終了せず
// ハングし続ける — 「stdinを待って固まったffmpeg」を、実際の子プロセス管理コードで
// 検証可能な形で模したもの。SIGTERM/SIGKILLへの特別なハンドラは付けない
// (Nodeの既定動作どおり、シグナルを受ければ普通に終了する＝「実際に殺せるか」を検証できる)。
//
// server/pipeline-runner.mjs の spawnAndLog は `python <TRANSCRIBE_PY> <input> <transcript>`
// の形で起動するため、process.argv[3] が input のパスになる(workDir/input.ext)。
// 自分のPIDを workDir/fake-python.pid へ書き、テスト側が「本当に動いている実プロセス」を
// 直接 process.kill(pid, 0) で観測できるようにする。

import fs from "node:fs";
import path from "node:path";

const inputPath = process.argv[3];
if (inputPath) {
  const workDir = path.dirname(inputPath);
  try {
    fs.writeFileSync(path.join(workDir, "fake-python.pid"), String(process.pid), "utf-8");
  } catch (_) {
    // workDirが無い等は無視(テスト側がPIDファイルの出現を待つので、出なければ前提確認で落ちる)
  }
}

process.stderr.write("[fake-hanging-python] waiting on stdin forever (simulated hang)\n");
process.stdin.resume(); // 誰もEOFを送らないので、これだけで永久にイベントループを生かし続ける
