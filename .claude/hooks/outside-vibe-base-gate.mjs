#!/usr/bin/env node
// PreToolUse:Write|Edit — vibe-base 外フォルダへの編集ブロックゲート
import path from 'node:path';

// 許可例外パス（正規化後に前方一致）
const ALLOWED_PREFIXES = [
  'C:/Users/user/.claude/',
  'c:/Users/user/.claude/',
  '/c/Users/user/.claude/',
  'C:/Users/user/Desktop/倉庫/事業戦略/ナレッジ/',
  'c:/Users/user/Desktop/倉庫/事業戦略/ナレッジ/',
  'C:/Users/user/AppData/Local/Temp/claude/',
  'c:/Users/user/AppData/Local/Temp/claude/',
  '/c/Users/user/AppData/Local/Temp/claude/',
];

// `\`→`/` 変換のみでは `..` を解決できず、`vibe-base/../../etc/passwd` の
// ようなトラバーサル混じりパスが startsWith 前方一致で「プロジェクト配下」と
// 誤判定され通過してしまう。path.posix.normalize() でセグメントを畳み込んで
// から比較する。path.resolve() は git-bash 形式 `/c/Users/...` をカレント
// ドライブ相対パスと誤変換するため使わない。
function normalizePath(p) {
  return path.posix.normalize(p.replace(/\\/g, '/'));
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
    // path.posix.normalize('') は '.' を返し truthy になるため、正規化前に
    // 空文字判定する（正規化後だと !projectDir が機能せず fail-safe が壊れる）
    const rawProjectDir = process.env.CLAUDE_PROJECT_DIR || '';
    if (!rawProjectDir) process.exit(0);
    const projectDir = normalizePath(rawProjectDir);

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
        '根拠: CLAUDE.md §1「1フォルダ=1エージェント。自分の作業ディレクトリ範囲外を無断で編集するな」',
        '許可される例外: ~/.claude/ 配下 / ナレッジvault',
      ].join('\n'),
    }));
    process.exit(0);
  } catch (e) {
    process.stderr.write('[outside-vibe-base-gate] error: ' + (e && e.message ? e.message : String(e)) + '\n');
    process.exit(0);
  }
});
