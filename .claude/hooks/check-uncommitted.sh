#!/bin/bash
# Stop hook: AGENTS.md「コミットは小さく・説明的に」「変更後はチェックを緑にしてからコミット」の
# 規律を、環境を問わず（誰の・どの実行環境でも）機械的に思い出させるためのプロジェクト共有フック。
#
# 個人設定（~/.claude/配下）に置かれた同種のフックとの違い：
# あちらは実行基盤（CCR）固有の署名検証などを含み、それはこのリポジトリの規律ではないため含めない。
# ここでは「未コミット／未追跡／未pushが残っていないか」という、どの環境でも成立する git 衛生のみを見る。
#
# ブロックではなく催促（exit 2 = Claudeに継続を促すフィードバック）。ネットワーク等の理由で
# 解消不能な場合の無限ループを避けるため、stop_hook_active が true の再入時は何もしない。

input=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

stop_hook_active=$(echo "$input" | jq -r '.stop_hook_active // "false"' 2>/dev/null)
if [[ "$stop_hook_active" == "true" ]]; then
  exit 0
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

if [[ -z "$(git remote 2>/dev/null)" ]]; then
  exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "未コミットの変更が残っています。AGENTS.mdの規律に従い、ワークスペース全体のチェック（typecheck/lint/test/build/verify-roadmap）を緑にしてからコミットしてください。" >&2
  exit 2
fi

untracked=$(git ls-files --others --exclude-standard)
if [[ -n "$untracked" ]]; then
  echo "未追跡ファイルが残っています。意図した変更であればコミットに含め、不要なら.gitignoreへの追加を検討してください。" >&2
  exit 2
fi

current_branch=$(git branch --show-current 2>/dev/null)
if [[ -n "$current_branch" ]] && git rev-parse "origin/$current_branch" >/dev/null 2>&1; then
  unpushed=$(git rev-list "origin/$current_branch..HEAD" --count 2>/dev/null) || unpushed=0
  if [[ "$unpushed" -gt 0 ]]; then
    echo "ブランチ '$current_branch' に未pushのコミットが $unpushed 件あります。origin へ push してください。" >&2
    exit 2
  fi
fi

exit 0
