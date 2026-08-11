#!/usr/bin/env node
// 偽 python の本体（tests/helpers/fake-transcribe-main.mjs の遅延版）
// — tests/webapp-ai-caption-progress-check.mjs 専用の足場
//
// 【なぜ遅延させるか】fake-transcribe-main.mjs は文字起こしをファイル書き出し1回で
// 即終了させる。本物の src/transcribe.py（faster-whisper）は実際の音声認識に必ず
// 実時間がかかるが、即時終了する偽物だとブラウザがPOST応答を受けてから新しく
// EventSourceを張るまでの実ネットワーク往復より先に文字起こし工程(stage t)が
// 終わってしまうことがある。サーバー側のSSE配送は接続中の購読者にしか届けない
// （後から接続した購読者へ過去分を再送しない）ため、その場合ブラウザは
// stage tのactive/doneイベントを一度も受け取れない（購読前に飛んだ分は消える）。
// これは本番でも起こりうる素材依存の競合（音声認識が極端に速く終わる場合）だが、
// テストの検証対象（stage cが独立した段として現れるか）とは別の関心事なので、
// ここでは「本物の文字起こしが実際に持つはずの遅延」を模して、EventSourceの
// 接続を待つのに十分な短い遅延（500ms）を入れてから書き出す。
//
// 設定JSONの形は fake-transcribe-main.mjs と同じ（{"transcript": {...}}）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 設定 JSON のファイル名（fake-transcribe-main.mjs と揃える＝installFakePython側の作法を流用） */
export const CONFIG_FILE = "fake-python.json";

const DELAY_MS = 500;

function main() {
  const here = path.dirname(path.resolve(process.argv[1]));
  const cfg = JSON.parse(fs.readFileSync(path.join(here, CONFIG_FILE), "utf-8"));
  const outputPath = process.argv[process.argv.length - 1];
  setTimeout(() => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(cfg.transcript, null, 2), "utf-8");
  }, DELAY_MS);
}

// PATH へ写された実行ファイルとして起動されたときだけ動く。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
