#!/usr/bin/env node
// PreToolUse:Write|Edit — vibe-base 外フォルダへの編集ブロックゲート

// 許可例外パス（正規化後に前方一致）
const ALLOWED_PREFIXES = [
  'C:/Users/user/.claude/',
  'c:/Users/user/.claude/',
  '/c/Users/user/.claude/',
  'C:/Users/user/Desktop/倉庫/事業戦略/ナレッジ/',
  'c:/Users/user/Desktop/倉庫/事業戦略/ナレッジ/',
];

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

let data = '';
process.stdin.on('data', c => (data += c));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const rawPath = (input.tool_input || {}).file_path || '';
    if (!rawPath) process.exit(0);

    const fp = normalizePath(rawPath);

    // CLAUDE_PROJECT_DIR = vibe-base ルート
    const projectDir = normalizePath(process.env.CLAUDE_PROJECT_DIR || '');
    if (!projectDir) process.exit(0);

    // vibe-base 配下なら通過
    const projectDirWithSlash = projectDir.endsWith('/') ? projectDir : projectDir + '/';
    if (fp.startsWith(projectDirWithSlash) || fp === projectDir) {
      process.exit(0);
    }

    // 許可例外パスなら通過
    for (const prefix of ALLOWED_PREFIXES) {
      if (fp.startsWith(prefix)) {
        process.exit(0);
      }
    }

    // それ以外はブロック
    console.log(JSON.stringify({
      decision: 'block',
      reason: [
        '⛔ [outside-vibe-base-gate] vibe-base 外フォルダへの編集を検知',
        `対象パス: ${rawPath}`,
        '根拠: CLAUDE.md §0「1フォルダ=1エージェント。自分の作業ディレクトリ範囲外を無断で編集するな」',
        '許可される例外: ~/.claude/ 配下 / ナレッジvault',
      ].join('\n'),
    }));
    process.exit(0);
  } catch (e) {
    process.stderr.write('[outside-vibe-base-gate] error: ' + (e && e.message ? e.message : String(e)) + '\n');
    process.exit(0);
  }
});
