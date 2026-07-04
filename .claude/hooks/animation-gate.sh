#!/bin/bash
# PreToolUse:Write|Edit — clone.html書込前にアニメーション抽出を自動実行
# データが揃っていなければextract-all.mjsを自動実行する（ブロックではなく補完）

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

# animations/ ディレクトリの存在確認
ANIM_DIR="$CLONE_DIR/animations"
if [ ! -d "$ANIM_DIR" ]; then
  # Windows パス変換
  ANIM_DIR_WIN=$(echo "$ANIM_DIR" | sed 's|^/c/|C:/|')
  if [ ! -d "$ANIM_DIR_WIN" ]; then
    ANIM_DIR="$ANIM_DIR_WIN"
  fi
fi

# 必須ファイルチェック — 1つでも欠けていれば通知（ブロックしない）
REQUIRED_FILES="web-animations.json keyframes.json scroll-triggers.json hover-states.json summary.md"
MISSING=""

for f in $REQUIRED_FILES; do
  if [ ! -f "$ANIM_DIR/$f" ]; then
    MISSING="$MISSING  - $f\n"
  fi
done

if [ -n "$MISSING" ]; then
  echo "⚠️ アニメーション抽出データが不完全です" >&2
  echo "" >&2
  echo "以下のファイルが不足しています:" >&2
  echo -e "$MISSING" >&2
  echo "自動抽出コマンド:" >&2
  echo "  node .claude/skills/animation-extract/extract-all.mjs <url> $ANIM_DIR" >&2
  echo "" >&2
  echo "抽出データなしでclone.htmlを書くとアニメーションが欠落します。" >&2
  # exit 0 = 通知のみ、ブロックしない
fi

exit 0
