#!/usr/bin/env node
// PreToolUse:Bash — git の無差別 stage（共有 index sweep）を機械ブロック
//
// 複数セッションが単一 working tree / 単一 index を共有する環境では、
// `git add -A` / `git add .` / `git commit -a|-am|--all`（pathspec 無し）が
// **他セッションが staged 中のファイルまで巻き込んで commit**し「commit 食われ」を起こす
// （failures L95/L103・2026-06-21 実証）。本 hook で path-scoped staging を機械強制する。
//
// Block: git add -A|--all / git add . / git commit -a|-am|--all
// 通過: git add <明示パス> / git add -- <path> / git add -p / git commit -m "..."（-a 無し）/
//       git commit -- <path> / git commit --amend / 複合コマンド(;|&`$()含む=safe-side) /
//       バイパス $CLAUDE_PROJECT_DIR/.allow-add-all（10分 TTL）

import fs from 'fs';
import path from 'path';

const MARKER_TTL_SEC = 600;
const PROJECT_DIR = (process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/\\/g, '/');
const MARKER_PATH = path.join(PROJECT_DIR, '.allow-add-all');

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const command = ((input.tool_input || {}).command || '').trim();
    if (!command) process.exit(0);

    // 複合コマンドは解析しない（誤検知回避・pre-bash-destructive と同じ保守方針）
    if (/[;&|`]/.test(command) || /\$\(/.test(command)) process.exit(0);

    // バイパスマーカー（10分 TTL・意図的な一括 add 用）
    if (fs.existsSync(MARKER_PATH)) {
      const ageSec = (Date.now() - fs.statSync(MARKER_PATH).mtimeMs) / 1000;
      if (ageSec < MARKER_TTL_SEC) process.exit(0);
    }

    let hit = null;
    if (/^git\s+add\b/.test(command)) {
      const region = command.split(/\s--(?=\s|$)/)[0]; // -- pathspec より前のフラグ領域
      if (/(^|\s)-[A-Za-z]*A[A-Za-z]*(\s|$)/.test(region)) hit = 'git add -A（全変更を無差別 stage）';
      else if (/(^|\s)--all(\s|$)/.test(region)) hit = 'git add --all（全変更を無差別 stage）';
      else if (/\sadd\s+\.(\s|$)/.test(region)) hit = 'git add .（カレント配下を無差別 stage）';
    } else if (/^git\s+commit\b/.test(command)) {
      // -m/--message 以降（コミットメッセージ）を除いたフラグ領域だけを検査（メッセージ内 "-a" の誤検知回避）
      const flags = command.replace(/\s(-m|--message)\b[\s\S]*$/, '');
      if (/(^|\s)--all(\s|$)/.test(flags)) hit = 'git commit --all（全 tracked を stage して commit）';
      else if (/(^|\s)-[A-Za-z]*a[A-Za-z]*(\s|$)/.test(flags)) hit = 'git commit -a（全 tracked を stage して commit）';
    }

    if (hit) {
      console.log(JSON.stringify({
        decision: 'block',
        reason: [
          '⛔ [pre-git-staging-gate] git の無差別 stage を検知（共有 index sweep 防止）',
          `対象: ${hit}`,
          '複数セッションが共有する index では、他セッションが staged 中のファイルまで巻き込んで',
          'commit され「commit 食われ」が起きます。path-scoped で操作してください:',
          '  - git add <明示パス>          例: git add docs/ scripts/foo.mjs',
          '  - git commit -- <明示パス>     例: git commit -m "..." -- docs/a.md',
          '根拠: 防御3段モデル / failures（共有 index 巻込）/ 2026-06-21 実証',
          'TPO バイパス（意図的な一括 add・10分有効）: touch "' + MARKER_PATH + '"',
        ].join('\n'),
      }));
      process.exit(0);
    }

    process.exit(0);
  } catch (e) {
    process.stderr.write('[pre-git-staging-gate] error: ' + (e && e.message ? e.message : String(e)) + '\n');
    process.exit(0);
  }
});
