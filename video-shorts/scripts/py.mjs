#!/usr/bin/env node
// Python 検査を「python3 が無くても」起動できるようにする薄いランチャー（AUD-P2-18a）。
//
// video-shorts の Python 製検査（tests/*.py）はこれまで package.json の "test" スクリプトから
// `python3 tests/foo.py` の形で直接起動していた。Windows は既定で `python` は入っていても
// `python3` という名前のコマンドは入っていないことが多く、その環境では検査そのものが
// 「command not found」で全滅する。
//
// このランチャーは PATH 上で `python3` → `python` の順に探し、最初に見つかった方へ
// 引数をそのまま渡して起動する（終了コードもそのまま返す）。どちらも無ければ、
// サイレントに失敗させず理由の分かるメッセージで止まる。
//
// 使い方: node scripts/py.mjs <実行したい.pyへのパス> [引数...]
//   （package.json の "test" では `python3 tests/foo.py` の代わりに
//    `node scripts/py.mjs tests/foo.py` と書く）

import { spawnSync } from "node:child_process";

const CANDIDATES = ["python3", "python"];

function tryRun(cmd, args) {
  // shell を介さず直接起動する（引数のクォート崩れやシェル差異を避けるため）。
  // コマンドが PATH 上に無ければ Node が ENOENT を error に積んで返す
  // （エラーコードを投げずに戻ってくるので、ここで判別して次の候補へ進める）。
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.error && result.error.code === "ENOENT") {
    return null; // このコマンドは PATH に無かった → 次の候補を試す
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write("[ERROR] scripts/py.mjs: 実行するPythonスクリプトのパスを指定してください。\n");
    process.exit(2);
  }

  for (const cmd of CANDIDATES) {
    const result = tryRun(cmd, args);
    if (result === null) continue; // 見つからなかった → 次の候補
    if (result.error) {
      // ENOENT 以外のエラー（実行権限が無い等）はそのコマンドの実行時エラーとして扱う
      process.stderr.write(`[ERROR] scripts/py.mjs: ${cmd} の起動に失敗しました: ${result.error.message}\n`);
      process.exit(1);
    }
    // 見つかって実行できた（検査自体の成否は呼び出し元がexit codeで判断する）
    process.exit(result.status === null ? 1 : result.status);
  }

  process.stderr.write(
    `[ERROR] scripts/py.mjs: ${CANDIDATES.join(" / ")} のいずれもPATH上に見つかりません。` +
      "Pythonをインストールしてください（`pip install -r requirements.txt` の前提です）。\n",
  );
  process.exit(127);
}

main();
