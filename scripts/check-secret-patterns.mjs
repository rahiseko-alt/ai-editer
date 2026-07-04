#!/usr/bin/env node
// scripts/check-secret-patterns.mjs
// シークレットパターン検知の共通ロジック（Q-C 案 2 + G4-5 共通）
// 用途:
//   - PreToolUse hook: import { scanString } で書込内容を判定
//   - git pre-commit hook: node scripts/check-secret-patterns.mjs --file <path>
//   - CLI: --string="..." or --file=path（複数指定可）
// 検出時 exit 1, 検出なし exit 0

import fs from 'fs';

// シークレットパターン（過去 sanitize 履歴 Session 240/250 + 主要 SaaS 公式仕様）
const SECRET_PATTERNS = [
  { name: 'Neon Postgres password', regex: /\bnpg_[A-Za-z0-9]{16,}\b/ },
  { name: 'Supabase secret', regex: /\bsb_secret_[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Google OAuth Client Secret', regex: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Google API Key', regex: /\bAIzaSy[A-Za-z0-9_-]{30,}\b/ },
  { name: 'Stripe live secret', regex: /\bsk_live_[A-Za-z0-9]{20,}\b/ },
  { name: 'Stripe test secret', regex: /\bsk_test_[A-Za-z0-9]{20,}\b/ },
  { name: 'OpenAI / Anthropic style key', regex: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: 'PEM private key block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Replicate API token', regex: /\br8_[A-Za-z0-9]{32,}\b/ },
  { name: 'GitHub token', regex: /\bgh[psoru]_[A-Za-z0-9]{30,}\b/ },
  { name: 'Slack token', regex: /\bxox[bpsa]-[A-Za-z0-9-]{20,}\b/ },
  { name: 'JWT (eyJ.x.x form)', regex: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/ },
];

export function scanString(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits = [];
  for (const pat of SECRET_PATTERNS) {
    if (pat.regex.test(text)) hits.push(pat.name);
  }
  return hits;
}

export function scanFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return scanString(content);
  } catch {
    return [];
  }
}

// CLI 直接実行判定（ESM）
const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    const url = import.meta.url.replace(/^file:\/+/, '/').replace(/\\/g, '/');
    return argv1.endsWith('check-secret-patterns.mjs') && url.endsWith('check-secret-patterns.mjs');
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const strings = [];
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--string') { strings.push(args[++i] || ''); }
    else if (a.startsWith('--string=')) { strings.push(a.slice(9)); }
    else if (a === '--file') { files.push(args[++i] || ''); }
    else if (a.startsWith('--file=')) { files.push(a.slice(7)); }
    else if (!a.startsWith('--')) { files.push(a); }
  }

  let exitCode = 0;
  for (const s of strings) {
    const hits = scanString(s);
    if (hits.length) {
      console.error(`SECRET DETECTED in --string: ${[...new Set(hits)].join(', ')}`);
      exitCode = 1;
    }
  }
  for (const f of files) {
    const hits = scanFile(f);
    if (hits.length) {
      console.error(`SECRET DETECTED in ${f}: ${[...new Set(hits)].join(', ')}`);
      exitCode = 1;
    }
  }
  process.exit(exitCode);
}
