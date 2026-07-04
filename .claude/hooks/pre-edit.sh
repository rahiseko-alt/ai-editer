#!/bin/bash
# PreToolUse:Write|Edit — 本番ファイル無断変更防止（問題3対策）
# matcher は Write|Edit（Session 303: skills/agents/commands 書き込みガードの Write 経路を塞ぐ）
# products/{X}/ 配下に .vercel/ があるファイルを本番とみなし、チャット内承認(ask)を要求する
# ハードコード不要 — vercel linkした時点で自動的に保護対象になる（ルート .vercel は無視）

INPUT=$(cat)
FILE=$(echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).tool_input.file_path)}catch(e){console.log('')}})")

if [ -z "$FILE" ]; then
  exit 0
fi

# バックスラッシュをスラッシュに正規化
FILE=$(echo "$FILE" | sed 's|\\|/|g')

# 注: .claude/skills|agents|commands への書込は公式 Protected Paths (code.claude.com/docs/en/permission-modes)
# により PROMPT 経路で保護される。本 hook での HARD BLOCK + 承認マーカー機構は撤去
# (a-b-c-3-jazzy-squid plan 段階 A-1a)。公式仕様は同パスを "Claude routinely creates content"
# として Protected Paths 対象から明示的に除外している。

# products/ 配下でなければ無視
if ! echo "$FILE" | grep -q '/products/'; then
  exit 0
fi

# 設定ファイル・統治/引継ぎファイルは対象外（CLAUDE.md, memory.md, failures.md, pc-progress.html, docs/, tmp/）
# 注: 旧版は 'memory.md\.md' の typo で memory.md が除外されず、.vercel 製品の Check-out
# (products/{X}/memory.md・failures.md への Edit) が HARD BLOCK される不具合があった (2026-05-29 修正)。
BASENAME=$(basename "$FILE")
if echo "$BASENAME" | grep -qE '^(CLAUDE\.md|memory\.md|failures\.md|pc-progress\.html)$'; then
  exit 0
fi
if echo "$FILE" | grep -qE '/docs/'; then
  exit 0
fi
if echo "$FILE" | grep -qE '/tmp/'; then
  exit 0
fi

# ファイルパスから上方向に .vercel/ を探す（/products/ サブツリー内のみ・ルート .vercel は無視）
DIR=$(dirname "$FILE")
FOUND_VERCEL=0
while echo "$DIR" | grep -q '/products/'; do
  if [ -d "$DIR/.vercel" ]; then
    FOUND_VERCEL=1
    break
  fi
  DIR=$(dirname "$DIR")
done

if [ "$FOUND_VERCEL" -eq 1 ]; then
  # 本番デプロイ済みファイル: 公式 PreToolUse 形式でチャット内承認(ask)を要求する。
  # pre-edit.sh は settings.json 直接起動のため stdout が Claude Code に直送される。
  # 旧 .allow-prod-edit ターミナルマーカー方式は撤去（チャット内 1 クリック承認に移行）。
  RELPATH=$(echo "$FILE" | sed 's|.*/vibe-base/||')
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"本番デプロイ済みプロダクトのファイルです: ${RELPATH}。編集を承認しますか？\"}}"
  exit 0
fi

exit 0
