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
import { spawnSync } from "node:child_process";

const target = process.argv[2];
if (!target) {
  process.stderr.write("usage: rm-job-dir-worker.mjs <path>\n");
  process.exit(2);
}

/**
 * Windows で OS 自身の削除コマンドを使って消す。
 *
 * 【なぜ要るか（2026-08-17 マスターの実機で実測）】
 * 上のコメントのとおり、Windows で日本語を含むパスを fs.rmSync の再帰削除に掛けると
 * Node がネイティブクラッシュする。ワーカーへ隔離したのでサーバーは生き残るが、
 * **削除そのものは永久に成功しない**。マスターの環境では同じ7件が1時間ごとに再試行され、
 * 毎回 0xC0000409 で落ちてログを埋め、動画ファイルが消えずに溜まり続けていた。
 * 溜まるほど「使用量を数える処理」が重くなるので、放置すると遅くなる一方になる。
 *
 * 隔離は「サーバーを守る」対策であって「削除できるようにする」対策ではなかった。
 * Node の再帰削除を通さず、OS の rd コマンドへ渡せばこのクラッシュ経路を踏まない。
 */
function removeWithWindowsShell(p) {
  // cmd の rd は引数を1つの塊として受けるので、パスは丸ごと引用符で囲む。
  // shell:true にしないと rd（cmd の組み込みコマンド）は起動できない。
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `rd /s /q "${p}"`], {
    windowsHide: true, encoding: "utf-8", timeout: 25_000,
  });
  // rd は「消せたか」を終了コードで正直に返さないことがあるので、実際に消えたかで判定する。
  return !fs.existsSync(p) ? { ok: true } : { ok: false, detail: (r.stderr || r.stdout || "").toString().slice(0, 200) };
}

try {
  if (process.platform === "win32") {
    const first = removeWithWindowsShell(target);
    if (first.ok) process.exit(0);
    // rd で消えなかったときだけ Node 側を試す（クラッシュしてもこのワーカーが死ぬだけ）。
    process.stderr.write(`rd で消えなかったので Node 側を試します: ${first.detail}\n`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  process.exit(0);
} catch (e) {
  process.stderr.write(`${e?.message ?? e}\n`);
  process.exit(1);
}
