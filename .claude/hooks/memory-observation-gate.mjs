#!/usr/bin/env node
// PreToolUse:Write|Edit|MultiEdit — memory.md への継続観察タスク記述ブロックゲート

// ブロック対象パターン
const BLOCK_PATTERNS = [
  /継続観察/,
  /\[sunset-after:/,
  /観察タスク/,
];

let data = '';
process.stdin.on('data', c => (data += c));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const fp = ((input.tool_input || {}).file_path || '').replace(/\\/g, '/');

    // memory.md (大文字小文字不問) で終わるファイルのみ対象
    if (!fp.toLowerCase().endsWith('memory.md')) {
      process.exit(0);
    }

    // Write は content, Edit は new_string, MultiEdit は edits[].new_string から取得
    const toolInput = input.tool_input || {};
    const multiEditContent = Array.isArray(toolInput.edits)
      ? toolInput.edits.map(e => e.new_string || '').join('\n')
      : '';
    const writeContent = toolInput.content ?? toolInput.new_string ?? multiEditContent;

    for (const pattern of BLOCK_PATTERNS) {
      if (pattern.test(writeContent)) {
        console.log(JSON.stringify({
          decision: 'block',
          reason: [
            '⛔ [memory-observation-gate] memory.md への継続観察タスク記述を検知',
            `検知パターン: ${pattern.toString()}`,
            '根拠: 継続観察タスクは memory.md に書くな（feedback_no-observation-task-in-memory.md）',
            '対応: タスクは「今からやって今終わる」ものだけ記載。観察は hook/script/ADR で対応せよ',
          ].join('\n'),
        }));
        process.exit(0);
      }
    }

    process.exit(0);
  } catch (e) {
    process.stderr.write('[memory-observation-gate] error: ' + (e && e.message ? e.message : String(e)) + '\n');
    process.exit(0);
  }
});
