#!/usr/bin/env node
  // PreToolUse:Write|Edit|MultiEdit — settings.local.json 書込時のシークレット検知ブロック
  // Q-C 案 2（Session 250 Plan Mode 確定）: settings.local.json に
  // sk-/AIza/GOCSPX-/npg_ 等のシークレットが混入した状態で Write/Edit/MultiEdit を実行したら即ブロック
  // 既存 hook（area-gate.mjs）と同じパターン: stdin JSON → 判定 → block or pass

  import path from 'path';
  import { fileURLToPath, pathToFileURL } from 'url';
  const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const { scanString } = await import(pathToFileURL(path.join(PROJECT_DIR, 'scripts', 'check-secret-patterns.mjs')).href);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  let data = '';
  process.stdin.on('data', chunk => (data += chunk));
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(data);
      const toolInput = input.tool_input || {};
      const filePath = (toolInput.file_path || '').replace(/\\/g, '/');

      const basename = path.basename(filePath);
      const isSettingsLocal = basename === 'settings.local.json';
      const isEnvFile = basename === '.env' || /^\.env\./.test(basename);
      const isGitCredentials = /\.git\/credentials$/.test(filePath);
      if (!isSettingsLocal && !isEnvFile && !isGitCredentials) {
        process.exit(0);
      }

      const texts = [];
      if (typeof toolInput.content === 'string') texts.push(toolInput.content);
      if (typeof toolInput.new_string === 'string') texts.push(toolInput.new_string);
      if (Array.isArray(toolInput.edits)) {
        for (const e of toolInput.edits) {
          if (typeof e.new_string === 'string') texts.push(e.new_string);
        }
      }

      const hits = [];
      for (const t of texts) hits.push(...scanString(t));

      if (hits.length > 0) {
        const unique = [...new Set(hits)];
        const reason = '[secret-write-gate] secret pattern detected: ' + unique.join(', ');
        console.log(JSON.stringify({ decision: 'block', reason: reason }));
      }
      process.exit(0);
    } catch (e) {
      // fail-closed: parse error / scanString 例外時もブロック (シークレット検査 silent skip 防止)
      process.stderr.write('[secret-write-gate] error: ' + (e && e.message ? e.message : String(e)) + '\n');
      process.exit(2);
    }
  });
  