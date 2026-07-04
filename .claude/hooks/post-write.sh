#!/bin/bash
# PostToolUse:Write — 新規ファイル作成後の索引漏れ検知（問題1対策）

INPUT=$(cat)
FILE=$(echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).tool_input.file_path)}catch(e){console.log('')}})")

if [ -z "$FILE" ]; then
  exit 0
fi

# バックスラッシュをスラッシュに正規化
FILE=$(echo "$FILE" | sed 's|\\|/|g')

# 対象外: tmp/, hooks/, node_modules/, .claude/
if echo "$FILE" | grep -qE '(tmp/|node_modules/|\.claude/)'; then
  exit 0
fi

# .md または .html のみ
if ! echo "$FILE" | grep -qE '\.(md|html)$'; then
  exit 0
fi

# docs/ または products/ 内のファイルのみ
if ! echo "$FILE" | grep -qE '(docs/|products/)'; then
  exit 0
fi

BASE_DIR="${CLAUDE_PROJECT_DIR:-/c/Users/user/Desktop/ClaudeCode/vibe-base}"
FILENAME=$(basename "$FILE")
RELPATH=$(echo "$FILE" | sed 's|.*/vibe-base/||')

# 索引ファイルでパスを検索
FOUND=0
for INDEX in "$BASE_DIR/CLAUDE.md" "$BASE_DIR/docs/md-inventory.md"; do
  if grep -q "$RELPATH" "$INDEX" 2>/dev/null || grep -q "$FILENAME" "$INDEX" 2>/dev/null; then
    FOUND=1
    break
  fi
done

if [ "$FOUND" -eq 0 ]; then
  MEMORY_MD="/c/Users/user/.claude/projects/C--Users-user-Desktop-ClaudeCode-vibe-base/memory/MEMORY.md"
  if grep -q "$RELPATH" "$MEMORY_MD" 2>/dev/null || grep -q "$FILENAME" "$MEMORY_MD" 2>/dev/null; then
    FOUND=1
  fi
fi

if [ "$FOUND" -eq 0 ]; then
  # 警告のみ（ブロックしない）。EXIT前にまとめて索引追記する運用に変更
  echo "⚠️ 索引漏れ警告: $RELPATH が CLAUDE.md / MEMORY.md / md-inventory.md のいずれにも未記載。EXIT前に索引追記すること。" >&2
  exit 0
else
  exit 0
fi
