#!/usr/bin/env node
// 偽 python の本体（固定のスクリプト）— tests/caption-ai-fail-halts-job-check.mjs の足場
//
// 【なぜ python を丸ごと差し替えるか】本物の src/transcribe.py は faster-whisper で実際に
// 音声認識を行う。この検査が見たいのは「文字起こし済みのジョブを AI 字幕直しへ流したとき
// 何が起きるか」であって、文字起こしそのものの精度ではない。実際に認識させると重い
// （モデル読み込み・CPU時間）うえ、認識結果が版によってぶれると下流の判定が不安定になる。
// server/pipeline-runner.mjs は spawnAndLog("python", [TRANSCRIBE_PY, input, output], ...) と
// 起動する。この本体を PATH の先頭に `python` として置くと、TRANSCRIBE_PY 自体は一度も
// 実行されず、代わりにこのスクリプトが起動される。argv の並びは変わらない
// （[..., scriptPath, inputPath, outputPath]）ので、末尾の outputPath へ固定の
// transcript.json を即座に書き出すだけでよい（input は読まない・実在も確認しない）。
//
// 【設定の置き場所】tests/helpers/fake-claude-main.mjs と同じ理由（製品の共通口が子プロセスの
// 環境変数を絞るため、環境変数経由で設定を渡せない）で、実行ファイルの隣の JSON から読む。
//   { "transcript": {...transcript.json としてそのまま書き出す中身...} }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 設定 JSON のファイル名（PATH に置く python と同じフォルダに置く）。 */
export const CONFIG_FILE = "fake-python.json";

function main() {
  const here = path.dirname(path.resolve(process.argv[1]));
  const cfg = JSON.parse(fs.readFileSync(path.join(here, CONFIG_FILE), "utf-8"));
  const outputPath = process.argv[process.argv.length - 1];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(cfg.transcript, null, 2), "utf-8");
}

// PATH へ写された実行ファイルとして起動されたときだけ動く。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
