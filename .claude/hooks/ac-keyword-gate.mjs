#!/usr/bin/env node
/**
 * ac-keyword-gate.mjs
 *
 * PostToolUse hook for Write|Edit.
 * Stage 2 of acceptance-criteria defense-in-depth.
 *
 * EARS:
 *   WHEN path contains "plans/" AND tool is Write or Edit (completed)
 *   THE SYSTEM SHALL verify the "## 受け入れ基準" H2 section contains
 *     at least one machine-verifiable keyword.
 *
 * Keywords (at least one occurrence required):
 *   EXIT 0 / Glob: / git diff / npm run / test -f / sha256 / wc -l / grep -c
 *
 *   OK -> exit 0
 *   NG -> stdout JSON {decision:"block", reason:"..."}, exit 0
 *
 * Responsibility separation:
 *   Stage 1 (plan-schema-gate) validates STRUCTURE (H2 exist + placeholders + template)
 *   Stage 2 (this) validates CONTENT (machine-verifiable keyword presence)
 *   No overlap - keyword check is NOT performed by Stage 1.
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_PATH = path.join(PROJECT_DIR, '.claude', 'logs', 'ac-keyword-gate.err');

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

// Machine-verifiable keywords. At least one must appear in the 受け入れ基準 H2 section.
const KEYWORDS = [
  'EXIT 0',
  'exit 0',
  'Glob:',
  'git diff',
  'npm run',
  'test -f',
  'sha256',
  'wc -l',
  'grep -c',
];

function isPlanPath(filePath) {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  if (/(^|\/)plans?\//.test(normalized)) return true;
  if (/tests\/fixtures\/plan-schema\//.test(normalized)) return true;
  if (/tests\/fixtures\/ac-keyword\//.test(normalized)) return true;
  if (/tests\/fixtures\/plan-finalize-test\//.test(normalized)) return true;
  return false;
}

function extractH2Section(content, heading) {
  const lines = content.split(/\r?\n/);
  const headingRegex = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRegex.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

let data = '';
process.stdin.on('data', chunk => (data += chunk));
process.stdin.on('error', e => logErr('stdin.error', e));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data || '{}');
    const filePath = (input.tool_input && input.tool_input.file_path) || '';
    if (!isPlanPath(filePath)) {
      process.exit(0);
    }
    if (!/\.md$/i.test(filePath)) {
      process.exit(0);
    }
    // PostToolUse: read the file from disk (it has been written)
    if (!fs.existsSync(filePath)) {
      process.exit(0);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content || content.length < 10) {
      process.exit(0);
    }
    const acceptance = extractH2Section(content, '受け入れ基準');
    if (acceptance === null) {
      // Stage 1 already blocks this case. Stage 2 stays silent (no double-block).
      process.exit(0);
    }
    const found = KEYWORDS.filter(k => acceptance.includes(k));
    if (found.length === 0) {
      const reason = `⛔ [ac-keyword-gate / Stage 2] 「## 受け入れ基準」に機械検証 keyword がありません

対象 path: ${filePath}

「## 受け入れ基準」H2 内には以下のいずれか 1 件以上を含めてください:
  - EXIT 0  (コマンド成功判定)
  - Glob:   (ファイル存在数判定)
  - git diff (diff stat 判定)
  - npm run  (npm script 実行)
  - test -f  (ファイル存在判定)
  - sha256   (ハッシュ判定)
  - wc -l    (行数判定)
  - grep -c  (検出件数判定)

EARS の意図文だけでは「書いてある ≠ 効いている」の罠に陥ります。
受入条件は必ず機械検証可能な形にしてください。

参照: vibe-base/docs/standards/plan-mode.md §「思想 4 を実装する手段：EARS + 機械検証条件の併用」`;
      console.log(JSON.stringify({ decision: 'block', reason }));
      process.exit(0);
    }
    process.exit(0);
  } catch (e) {
    logErr('stdin.end.catch', e);
    process.exit(0);
  }
});
