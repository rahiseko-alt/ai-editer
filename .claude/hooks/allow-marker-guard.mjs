#!/usr/bin/env node
// PreToolUse:Bash|Write|Edit — .allow-* バイパスマーカーの AI 操作を機械拒否する
//
// 背景: root の `.allow-destructive` / `.allow-prod-edit` / `.allow-skill-edit` は
//       mtime 10 分 TTL のバイパストグル。これを touch すれば AI は以下の hook を
//       すべて素通りできる:
//         .claude/hooks/pre-bash-destructive.mjs
//         .claude/hooks/portfolio-generated-guard.mjs
//         .claude/hooks/toranomaki-generated-guard.mjs
//         .codex/hooks/pre-edit.sh
//       過去に AI が自分で touch して自己回避を試みた記録がある。
//
// 方針: マーカーの発行を **マスター本人の `!` 直接実行（hook 非経由）に限定**する。
//       AI 経由の操作は Bash / Write / Edit のいずれであっても deny。
//       CLAUDE.md §4「AI 自己規律は信用しない。強制すべき制御はフックで実装する」。
//
// 過剰拒否側に倒す: 読取専用コマンド（`ls .allow-destructive` 等）もマッチすれば deny する。
//       マーカーの存在確認すら AI には不要であり、誤って通すコストの方が高い。
//
// exit 規約: deny = exit 2（公式に「exit 2 は permission rules より先に tool call を停止」）。
//            非該当・解析失敗 = exit 0（既存 hook と同じ fail-open 方針）。
//
// kill-switch: CLAUDE_HOOKS_DISABLE=1 / ~/.claude/disable-hooks（hook-runner 側が処理）

import fs from 'fs';
import path from 'path';

// `i` フラグ必須。Windows(NTFS) のファイル名は大小無視のため、`.Allow-Destructive` を
// 作られると本 guard（大小区別）は素通りする一方、マーカー消費側の
// `fs.existsSync('.allow-destructive')` は同一ファイルとして true を返す。
// = guard を抜けたままバイパスが成立し、S-5 の目的（AI 自己バイパスの阻止）が消える。
// 2026-07-10 の検証パネルで code-reviewer / security-reviewer が独立に blocking 指摘。
const MARKER_RE = /\.allow-(destructive|prod-edit|skill-edit)/i;

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_PATH = path.join(PROJECT_DIR, 'outputs', 'allow-marker-denials.log');

function appendDenialLog(toolName, matched) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()}\t${toolName}\t${matched}\n`, 'utf8');
  } catch {
    // ログ書込に失敗しても deny 判定は行う（ログは監査補助であって判定の前提ではない）
  }
}

let data = '';
process.stdin.on('data', (chunk) => (data += chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const toolName = input.tool_name || '';
    const toolInput = input.tool_input || {};

    // 検査対象の文字列を tool 種別ごとに選ぶ
    // MultiEdit も対象。既存マーカーの mtime を更新するだけで TTL を延長できるため。
    let subject = '';
    if (toolName === 'Bash') subject = toolInput.command || '';
    else if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit')
      subject = toolInput.file_path || '';

    if (!subject) process.exit(0);

    const m = subject.match(MARKER_RE);
    if (!m) process.exit(0);

    appendDenialLog(toolName, m[0]);

    process.stderr.write(
      [
        '⛔ [allow-marker-guard] .allow-* バイパスマーカーの操作は AI に許可されていない。',
        '',
        `検知 tool : ${toolName}`,
        `検知文字列: ${m[0]}`,
        '',
        'これらのマーカーは pre-bash-destructive / portfolio-generated-guard /',
        'toranomaki-generated-guard / .codex/pre-edit.sh を 10 分間すべて無効化する。',
        'AI が自分で発行すれば防御の意味が消える（過去に自己回避を試みた記録あり）。',
        '',
        '必要ならマスター本人が hook を経由しない形で実行する:',
        '  ! touch <マーカーパス>',
        '',
        `記録: ${LOG_PATH}`,
      ].join('\n') + '\n'
    );
    process.exit(2);
  } catch {
    // JSON 解析失敗 → 安全側に倒して通過（既存 hook と同じ方針）
    process.exit(0);
  }
});
