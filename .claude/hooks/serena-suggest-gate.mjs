#!/usr/bin/env node
// .claude/hooks/serena-suggest-gate.mjs
// PreToolUse(Read|Edit): 大物の product コードファイルを触る瞬間に、Serena 利用を
// マスターへ提案するよう AI へ助言注入する（機械検知 → AI提案 → マスター承認 → 発火 の入口）。
// 常時注入はしない。下記条件を全て満たす時だけ・セッション1回だけ発火する。
// 設計思想: AI 自己規律でなく hook で機械強制（CLAUDE.md §5・serena-contribution-report §4）。
//
// 出力形: hookSpecificOutput.additionalContext（非ブロッキング助言注入）。
//   Live 検証(plan S-5)で PreToolUse でも本 harness が honor することを実挙動確認済み。
//
// 検知条件（すべてその場で判定可能・最速 skip 順に評価）:
//   1. tool_input.file_path の拡張子が TS/JS/Py 系のコード（生成物/依存/ミニファイは除外）
//   2. 解決後の実パスが CLAUDE_PROJECT_DIR（vibe-base）配下である（外部パス・traversal を封じる）
//   3. リポジトリ相対で products/<name>/ 配下（root 直下 scripts/.claude は Serena activate 禁止領域）
//   4. ファイルサイズ >= SERENA_SUGGEST_MIN_BYTES（既定 10000 byte）
//   5. このセッションで未提案（session_id 付き marker が無い）

import fs from 'node:fs';
import path from 'node:path';

const _mb = Number(process.env.SERENA_SUGGEST_MIN_BYTES);
const MIN_BYTES = Number.isFinite(_mb) && _mb > 0 ? _mb : 10_000; // 非数値 env でも既定に落とす
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/i;
// 生成物・依存・ミニファイは Serena 編集対象外なので提案しない
const EXCLUDE_RE = /\/(node_modules|dist|build|out|\.vercel|\.next|\.svelte-kit|coverage|vendor|__pycache__)\/|\.min\.(js|css)$|\.bundle\.js$/i;
const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/\\/g, '/');

function done() { process.exit(0); } // 無出力 = 通常フロー継続

function emit(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context },
  }));
  process.exit(0);
}

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(data); } catch { return done(); }
  try {
    const rawPath = (input.tool_input || {}).file_path || '';
    if (!rawPath) return done();
    const norm = String(rawPath).replace(/\\/g, '/');

    // 条件1: コード拡張子のみ・生成物/依存/ミニファイは除外
    if (!CODE_RE.test(norm)) return done();
    if (EXCLUDE_RE.test(norm)) return done();

    // パス解決（絶対 or CLAUDE_PROJECT_DIR 相対）→ 実体 resolve
    const candidate = path.isAbsolute(norm) ? norm : path.join(PROJECT_DIR, norm);
    const absResolved = path.resolve(candidate).replace(/\\/g, '/');

    // 条件2: PROJECT_DIR（vibe-base）配下限定（外部の products/ 同名フォルダ・../ traversal を封じる）
    const base = PROJECT_DIR.toLowerCase();
    if (absResolved.toLowerCase() !== base && !absResolved.toLowerCase().startsWith(base + '/')) return done();

    // 条件3: リポジトリ相対で products/<name>/ 配下か（root 直下は Serena 禁止領域）
    const rel = absResolved.slice(PROJECT_DIR.length + 1);
    const m = rel.match(/^products\/([^/]+)\//);
    if (!m) return done();
    const product = String(m[1]).replace(/[^\w.-]/g, '_'); // 注入防止: 埋め込み前にサニタイズ

    // 条件4: サイズ閾値（statSync 失敗 = 新規/不在ファイルは skip）
    let size = 0;
    try { size = fs.statSync(absResolved).size; } catch { return done(); }
    if (size < MIN_BYTES) return done();

    // 条件5: このセッションで未提案（session_id がある時のみ dedup。無い時は永久サイレント化を避け都度判定）
    const rawSid = input.session_id ? String(input.session_id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : '';
    if (rawSid) {
      const markerDir = path.join(PROJECT_DIR, '.claude', '.serena-suggest');
      const marker = path.join(markerDir, `fired-${rawSid}`);
      try { if (fs.existsSync(marker)) return done(); } catch { /* 判定不能時は提案側に倒す */ }
      try { fs.mkdirSync(markerDir, { recursive: true }); fs.writeFileSync(marker, new Date().toISOString(), 'utf-8'); } catch { /* 書けなくても提案は出す */ }
    }

    const kb = (size / 1024).toFixed(0);
    const context = [
      `[serena-suggest] このファイルは Serena 向きです（products/${product}・約${kb}KB のコード）。`,
      `全文 Read を続ける前に、マスターへ「Serena を使うか」を AskUserQuestion で提案してください。`,
      `承認されたら: ToolSearch で "select:mcp__serena__activate_project,mcp__serena__get_symbols_overview,mcp__serena__find_symbol" のスキーマを取得 →`,
      `activate_project で products/${product} を activate → get_symbols_overview / find_symbol でシンボル単位に切替（全文 Read を避ける）。`,
      `マスターが拒否したら、または無人（非対話）セッションなら、提案せず従来どおり Read を続行してください。この提案はこのセッションでは一度だけ表示されます。`,
    ].join(' ');
    return emit(context);
  } catch (e) {
    process.stderr.write(`[serena-suggest] error: ${e && e.message}\n`);
    return done();
  }
});
