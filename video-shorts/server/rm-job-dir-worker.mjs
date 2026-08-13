#!/usr/bin/env node
// server/rm-job-dir-worker.mjs — AUD-P1-15: TTL掃除の削除処理を隔離実行する最小ワーカー。
//
// docs/audits/adversarial-review-2026-08-13.md #15: Node.js v24.13.0のWindows環境で、
// OneDrive配下かつ日本語を含む実パス上で fs.rmSync() を再帰実行すると、終了コード
// -1073740791(ネイティブクラッシュ)でNodeプロセスごと落ちることが実地で確認された。
// これはJSの try/catch では捕まえられない種類の異常終了であり、job-lifecycle.mjs 側で
// どれだけ丁寧にtry/catchしても、そのtry/catchごとプロセスが消し飛ぶため無力になる。
//
// 対策として、削除処理自体を「サーバー本体とは別のOSプロセス」に切り出す。
// このワーカーがネイティブクラッシュしても、死ぬのはこのワーカー・プロセスだけであり、
// 呼び出し元(server/job-lifecycle.mjs の removeDirViaChildProcess)は子プロセスの
// 異常終了(シグナル・非0終了コード)として観測できる(=通常のJSエラーとして扱い、
// サーバー本体は継続稼働できる)。
//
// 使い方: node rm-job-dir-worker.mjs <削除対象ディレクトリの絶対パス>
// 成功: 終了コード0。失敗(捕捉可能な例外): 終了コード1・stderrへ理由。

import fs from "node:fs";

const target = process.argv[2];
if (!target) {
  process.stderr.write("usage: rm-job-dir-worker.mjs <path>\n");
  process.exit(2);
}

try {
  fs.rmSync(target, { recursive: true, force: true });
  process.exit(0);
} catch (e) {
  process.stderr.write(`${e?.message ?? e}\n`);
  process.exit(1);
}
