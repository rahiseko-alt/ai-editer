#!/bin/bash
# PreToolUse:Bash — 模写コミット前にLayer 3検証の完了を通知
# frame-diff / verify-report が不在なら verify-all.mjs の実行を促す（ブロックしない）

INPUT=$(cat)
CMD=$(echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).tool_input.command)}catch(e){console.log('')}})")

if [ -z "$CMD" ]; then
  exit 0
fi

# git commit で「模写」「clone」「静的HTML」を含むコミットのみ対象
if ! echo "$CMD" | grep -q 'git commit'; then
  exit 0
fi

if ! echo "$CMD" | grep -qiE '模写|clone|静的HTML|ui-clone'; then
  exit 0
fi

# CWD から tmp/clone/ を含むディレクトリを探す
CWD=$(echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).cwd||'')}catch(e){console.log('')}})")
CWD=$(echo "$CWD" | sed 's|\\|/|g')

# products/*/tmp/clone/ または tmp/*-clone/ を探す
CLONE_DIRS=$(find "$CWD" -path "*/tmp/clone" -type d -o -path "*/tmp/*-clone" -type d 2>/dev/null | head -5)

if [ -z "$CLONE_DIRS" ]; then
  exit 0
fi

WARN=0
for CLONE_DIR in $CLONE_DIRS; do
  # clone.html が存在するディレクトリのみ対象
  if [ ! -f "$CLONE_DIR/clone.html" ]; then
    continue
  fi

  # animations/summary.md があるか（= アニメーションありのサイト）
  if [ ! -f "$CLONE_DIR/animations/summary.md" ]; then
    continue
  fi

  # Layer 3 検証ファイルチェック
  MISSING=""
  if [ ! -f "$CLONE_DIR/frame-diff/diff-report.json" ]; then
    MISSING="$MISSING  - frame-diff/diff-report.json\n"
  fi
  if [ ! -f "$CLONE_DIR/verify-report.json" ]; then
    MISSING="$MISSING  - verify-report.json\n"
  fi

  if [ -n "$MISSING" ]; then
    echo "⚠️ Layer 3 アニメーション検証が未完了です" >&2
    echo "" >&2
    echo "以下が不足しています:" >&2
    echo -e "$MISSING" >&2
    echo "自動検証コマンド:" >&2
    echo "  node .claude/skills/animation-extract/verify-all.mjs <reference-url> $CLONE_DIR/clone.html $CLONE_DIR" >&2
    echo "" >&2
    echo "対象: $CLONE_DIR" >&2
    WARN=1
  fi
done

# exit 0 = 通知のみ、ブロックしない
exit 0
