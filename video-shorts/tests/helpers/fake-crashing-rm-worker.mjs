#!/usr/bin/env node
// tests/helpers/fake-crashing-rm-worker.mjs
// job-ttl-isolated-removal-check.mjs (AUD-P1-15) が rm-job-dir-worker.mjs の代わりに
// 差し込む偽実装。実際のネイティブクラッシュ(セグフォルト等)を安定して意図的に起こすのは
// このLinux開発環境では現実的ではないため、代わりに「シグナルで死ぬ」という、
// 親プロセス(removeDirViaChildProcess の呼び出し元)から見て観測できる異常終了の形を模する。
// SIGSEGV を自分自身へ送ることで、ネイティブクラッシュと同じ「シグナル起因の異常終了」を
// 安定して再現する(Node.jsのJSレベルのtry/catchでは検出できない・OSレベルの終了)。
process.kill(process.pid, "SIGSEGV");
