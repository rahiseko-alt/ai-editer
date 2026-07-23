#!/usr/bin/env node
/**
 * line-count-gate.mjs
 *
 * PostToolUse hook for Write|Edit.
 * 500 行規律（コード構造編）— マスター指示書 2026-06-11。
 *
 * EARS:
 *   WHEN tool is Write or Edit (completed) AND file is a code file
 *     (.html/.js/.jsx/.ts/.tsx/.svelte/.css) AND not excluded
 *   THE SYSTEM SHALL block when the file exceeds 500 lines and instruct
 *     splitting by feature (code-splitting skill).
 *
 *   OK -> exit 0
 *   NG -> stdout JSON {decision:"block", reason:"..."}, exit 0
 *         （vibe-base hook 規律準拠。指示書の exit 2 を block 判定に読み替え）
 *
 * 除外（誤検知防止）: ビルド成果物 / 依存 / min / バンドル / データファイル。
 *   追加が必要な場合は司令塔に報告のうえ EXCLUDE_* を更新する（指示書 §2）。
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_PATH = path.join(PROJECT_DIR, '.claude', 'logs', 'line-count-gate.err');

const LIMIT = 500;
const TARGET_EXT = /\.(html|js|jsx|ts|tsx|svelte|css)$/i;
// ビルド成果物・依存・バックアップ・アーカイブ・納品デザインサンプル（design-samples=納品正本・分割対象外 2026-06-12 マスター承認）
// deploy: 公開専用ディレクトリ（build-*-portfolio.mjs 等の生成物。dist/out と同種・2026-07-09 追加）
const EXCLUDE_PATH = /(^|[/\\])(node_modules|dist|dist\.bak|\.svelte-kit|build|out|coverage|\.vercel|\.wrangler|backups|archive|design-samples|deploy)[/\\]/;
// minified / bundle / ローカル同梱ライブラリ
const EXCLUDE_FILE = /(\.min\.(js|css)|\.bundle\.js|konva\.min\.js)$/i;
// データファイル（漢字 1 字 1 ファイル・パック・画像認識アセット等）
const EXCLUDE_DATA = /[/\\](lib[/\\]data|data[/\\]kanji|pyautogui-assets)[/\\]/;
// 自己完結の配布文書（docs/deliverables/*.html・2026-07-09 追加）
//   営業資料・オンボーディング資料は「1ファイルで送れる／1枚でデプロイできる」ことが仕様であり、
//   CSS/JS を切り出すとメール添付・単体配布が壊れる。500 行規律はコード構造編であり本用途は対象外。
//   対象はこのディレクトリ直下の .html のみ（配下のアプリコードは通常どおり規律対象）。
const EXCLUDE_DELIVERABLE_DOC = /[/\\]docs[/\\]deliverables[/\\][^/\\]+\.html$/i;
// vest1 索引（docs/standards/vest1-catalog.html＝1画面で全 vest1 を見渡すためのカード型索引データ。機能分割すると一覧性が壊れる。2026-07-06 マスター承認）
const EXCLUDE_INDEX = /[/\\]docs[/\\]standards[/\\]vest1-catalog\.html$/;

function logErr(label, err) {
  try {
    const stamp = new Date().toISOString();
    const detail = err?.stack || err?.message || String(err);
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${stamp}] ${label}: ${detail}\n`);
  } catch {}
}

process.on('uncaughtException', e => { logErr('uncaughtException', e); process.exit(0); });
process.on('unhandledRejection', e => { logErr('unhandledRejection', e); process.exit(0); });

let data = '';
process.stdin.on('data', chunk => (data += chunk));
process.stdin.on('error', e => logErr('stdin.error', e));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data || '{}');
    const filePath = (input.tool_input && input.tool_input.file_path) || '';
    if (!filePath) process.exit(0);

    const norm = filePath.replace(/\\/g, '/');
    if (!TARGET_EXT.test(norm)) process.exit(0);
    if (EXCLUDE_PATH.test(filePath) || EXCLUDE_FILE.test(norm) || EXCLUDE_DATA.test(filePath) || EXCLUDE_DELIVERABLE_DOC.test(filePath) || EXCLUDE_INDEX.test(filePath)) process.exit(0);
    if (!fs.existsSync(filePath)) process.exit(0);

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    // wc -l 相当: 末尾改行による空要素は 1 行と数えない
    const n = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;

    if (n > LIMIT) {
      const reason = `⛔ [line-count-gate] ${filePath} が ${n} 行で上限 ${LIMIT} 行を超過

機能単位で別ファイルに分割してください（code-splitting スキル参照）。
  - 切り出し単位: 画面 / 機能 / データ処理
  - 既存からは import 参照のみにする
  - 1 機能ずつ切り出し、都度動作確認する（一度に全部分割しない）

既存の 500 行超ファイルへの追記なら、追記前に分割案を報告してください（即分割しない・マスター指示書 §5）。
自動生成 / データファイルの誤検知なら、除外パターン追加を司令塔に報告してください（指示書 §2）。

参照: ~/.claude/skills/code-splitting/SKILL.md`;
      console.log(JSON.stringify({ decision: 'block', reason }));
      process.exit(0);
    }
    process.exit(0);
  } catch (e) {
    logErr('stdin.end.catch', e);
    process.exit(0);
  }
});
