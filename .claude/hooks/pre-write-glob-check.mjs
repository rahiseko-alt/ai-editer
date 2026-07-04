#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_PATH = path.join(PROJECT_DIR, '.claude', 'logs', 'pre-write-glob-check.err');

function logErr(label, err) {
  try {
    const stamp = new Date().toISOString();
    const detail = err?.stack || err?.message || String(err);
    fs.appendFileSync(LOG_PATH, `[${stamp}] ${label}: ${detail}\n`);
  } catch {
  }
}

process.on('uncaughtException', e => {
  logErr('uncaughtException', e);
  process.exit(0);
});
process.on('unhandledRejection', e => {
  logErr('unhandledRejection', e);
  process.exit(0);
});

let data = '';
process.stdin.on('data', chunk => (data += chunk));
process.stdin.on('error', e => logErr('stdin.error', e));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const filePath = (input.tool_input && input.tool_input.file_path) || '';
    if (!filePath) {
      process.exit(0);
    }
    if (fs.existsSync(filePath)) {
      const reason = `⛔ [plan Mode 規律違反検知] Write 対象が既に存在します

対象 path: ${filePath}

plan に「新規作成」と書かれた path が既存です。以下のいずれかを実施してください:
  1. plan の影響範囲セクションを「修正」に書き換える
  2. Write ではなく Edit を使う
  3. 既存ファイルを削除してから再実行する（破壊的・要マスター承認）

参照: docs/standards/plan-mode.md 「plan の実体照合（新規作成 path の Glob 義務）」`;
      console.log(JSON.stringify({ decision: 'block', reason }));
      process.exit(0);
    }
    process.exit(0);
  } catch (e) {
    logErr('stdin.end.catch', e);
    process.exit(0);
  }
});
