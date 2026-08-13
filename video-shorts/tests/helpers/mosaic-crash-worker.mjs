#!/usr/bin/env node
// AUD-P1-06 検証用ワーカー — 退避(stash-move)の rename が完了した直後、
// candidates.json の書き換えが終わる前に SIGKILL で強制終了する。
//
// src/apply-mosaic-stage.mjs 本体は一切変更せず、fs.renameSync をこのプロセス内だけで
// フックし「行き先(to)が stashDir 配下」の rename が完了した直後に自分自身へ SIGKILL を
// 送る。この方法は本体コードの実装(ジャーナルの有無など)に依存しないため、修正前
// (負の対照)・修正後のどちらの src/apply-mosaic-stage.mjs に対しても同じ狙った瞬間で
// 強制終了できる。
//
// 使い方: node tests/helpers/mosaic-crash-worker.mjs <outDir> <stashDir> <candJsonPath>
// 正常終了せず、狙った瞬間に SIGKILL で死ぬのが仕様（親プロセスが signal を確認する）。

import fs from "node:fs";
import path from "node:path";
import { applyMosaicStage } from "../../src/apply-mosaic-stage.mjs";

const [outDir, stashDir, candJsonPath] = process.argv.slice(2);
if (!outDir || !stashDir || !candJsonPath) {
  console.error("usage: node mosaic-crash-worker.mjs <outDir> <stashDir> <candJsonPath>");
  process.exit(2);
}
const candidates = JSON.parse(fs.readFileSync(candJsonPath, "utf-8"));
const resolvedStashDir = path.resolve(stashDir);

const realRenameSync = fs.renameSync;
fs.renameSync = (from, to) => {
  const r = realRenameSync(from, to);
  const toResolved = path.resolve(String(to));
  const toDir = path.dirname(toResolved);
  const toBase = path.basename(toResolved);
  // stashDir配下への rename のうち、書き込み前ジャーナル自体の書き込み(journalファイル・
  // その一時ファイル)は「退避(stash-move)」ではないので対象外にする（新実装は
  // ジャーナルをstashDir配下へ writeJsonAtomically で先に書くため、これも一度
  // stashDir配下への rename を起こす。ここで殺すと退避が1つも終わらないうちに
  // 強制終了してしまい、狙った瞬間からズレる）。
  const isJournalWrite = toBase === "mosaic-journal.json" || toBase.includes(".tmp-");
  if (toDir === resolvedStashDir && !isJournalWrite) {
    // 退避(stash-move: 素顔クリップ本体の rename)が完了した直後。ここで即座に強制終了する。
    process.kill(process.pid, "SIGKILL");
  }
  return r;
};

applyMosaicStage({ outDir, stashDir, candidates, candPath: candJsonPath, onLog: () => {} })
  .then(() => { process.exit(0); })
  .catch((e) => { console.error(e && e.message); process.exit(1); });
