#!/bin/bash
# PreToolUse:Write|Edit — clone.html書込をsite-measurement.md未存在時にブロック
# animation-gate.sh（通知型）とは異なり、これはブロック型

INPUT=$(cat)
FILE=$(echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).tool_input.file_path)}catch(e){console.log('')}})")

if [ -z "$FILE" ]; then
  exit 0
fi

# バックスラッシュをスラッシュに正規化
FILE=$(echo "$FILE" | sed 's|\\|/|g')

# clone.html への書込みのみ対象
if ! echo "$FILE" | grep -q '/tmp/clone/clone\.html$\|/tmp/.*/clone\.html$'; then
  exit 0
fi

# clone.html の親ディレクトリを特定
CLONE_DIR=$(dirname "$FILE")

# site-measurement.md の存在確認
MEASUREMENT_FILE="$CLONE_DIR/site-measurement.md"

# Windows パス変換も試行
if [ ! -f "$MEASUREMENT_FILE" ]; then
  MEASUREMENT_FILE_WIN=$(echo "$MEASUREMENT_FILE" | sed 's|^/c/|C:/|')
  if [ ! -f "$MEASUREMENT_FILE_WIN" ]; then
    # どちらのパスでも見つからない → ブロック
    echo "{\"decision\":\"block\",\"reason\":\"site-measurement.md が存在しません。clone.html を書く前に計測を実行してください:\\n\\n  node .claude/skills/ui-clone/measure-site.mjs <url> $CLONE_DIR\\n\\nsite-measurement.md なしでの模写は禁止されています。\"}"
    exit 0
  fi
fi

# site-measurement.md が存在する → 許可
exit 0
