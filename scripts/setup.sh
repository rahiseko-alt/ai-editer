#!/usr/bin/env bash
#
# 新案件セットアップ（cc-v2 をコピーした新リポジトリで「1回だけ」実行する）。
#
# 目的：branch protection を掛け、「CI が緑でなければマージできない」状態にする。
#   ＝ AGENTS.md のルール文に“歯”を付け、cc-v2 と同レベルの機械強制で運用する。
#   これ（サーバー側設定）はクローンで運ばれないため、新リポジトリごとに一度だけ要る。
#
# 前提：gh CLI（https://cli.github.com）がインストール済み・認証済み（`gh auth login`）。
# 冪等：何度実行しても同じ結果（既存の保護があれば同じ内容で上書きする）。
#
# 使い方：
#   bash scripts/setup.sh            # 適用（保護を掛ける）
#   bash scripts/setup.sh --dry-run  # 何も変更せず、送信内容と前提チェックだけ表示
#
# 必須チェック（context 名）：
#   - ci-green         … ci.yml の集約ゲート（quality/smoke が全て緑のときだけ success）
#   - roadmap-required … 全PRに docs/roadmap.html 差分を要求
#
# ⚠ 既知の制約：このスクリプトは classic Branch Protection API を使うため、
#   「Require a pull request before merging（0 approvals）」は設定できない
#   （classic API は required_approving_review_count に 0 を受け付けない）。
#   このスクリプトだけを実行した状態では main への直 push が可能なまま＝
#   ci-green/roadmap-required を丸ごと迂回できてしまう。実地で確認済み。
#   PR必須化は AGENTS.md 手順0-b の (A) Rulesets を手動で使うこと
#   （Require a pull request before merging にチェック、Required approvals は 0）。
#   ※ どちらもワークフロー内の job 'name:' と一致させてある。ここを変えたら両方直すこと。

set -euo pipefail

MODE="apply"
case "${1:-}" in
  --dry-run) MODE="dry-run" ;;
  "")        MODE="apply" ;;
  *)         echo "usage: bash scripts/setup.sh [--dry-run]" >&2; exit 2 ;;
esac

REQUIRED_CHECKS=("ci-green" "roadmap-required")

die()  { echo "✗ $*" >&2; exit 1; }
note() { echo "• $*"; }

# 1) origin から owner/repo を判別（https / ssh 両対応）。
#    GitHub の owner/repo は常にパスの末尾2要素。前置きパス(プロキシ等)があっても末尾2つを取る。
origin_url="$(git remote get-url origin 2>/dev/null)" \
  || die "git remote 'origin' が見つかりません（このリポジトリの中で実行してください）。"
path="$(printf '%s' "$origin_url" | sed -E 's#^git@[^:]+:##; s#^[a-zA-Z]+://[^/]+/##; s#\.git$##; s#/+$##')"
repo="${path##*/}"
rest="${path%/*}"
owner="${rest##*/}"
{ [ -n "$owner" ] && [ -n "$repo" ] && [ "$rest" != "$path" ]; } \
  || die "origin URL から owner/repo を判別できません: $origin_url"

# 2) gh の有無（dry-run では無くても続行して内容だけ見せる）
have_gh=1
command -v gh >/dev/null 2>&1 || have_gh=0

# 3) 既定ブランチ（gh→git→main の順にフォールバック）
default_branch=""
if [ "$have_gh" -eq 1 ]; then
  default_branch="$(gh api "repos/$owner/$repo" --jq .default_branch 2>/dev/null || true)"
fi
if [ -z "$default_branch" ]; then
  default_branch="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
fi
[ -n "$default_branch" ] || default_branch="main"

# 4) API ペイロード（守るのは "CI が緑" だけ＝レビュー必須にはしない）
checks_json=""
for c in "${REQUIRED_CHECKS[@]}"; do
  checks_json="${checks_json}{\"context\":\"${c}\"},"
done
checks_json="[${checks_json%,}]"

payload="$(cat <<JSON
{
  "required_status_checks": { "strict": true, "checks": ${checks_json} },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_conversation_resolution": false,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
)"

note "対象:         ${owner}/${repo}"
note "保護ブランチ: ${default_branch}"
note "必須チェック: ${REQUIRED_CHECKS[*]}"

# 5) dry-run：送信せず内容だけ表示
if [ "$MODE" = "dry-run" ]; then
  [ "$have_gh" -eq 1 ] || echo "⚠ gh CLI 未検出（適用実行には gh のインストールと 'gh auth login' が必要）"
  echo "--- dry-run: 以下を送信します（実行しません）---"
  echo "PUT repos/${owner}/${repo}/branches/${default_branch}/protection"
  echo "$payload"
  exit 0
fi

# 6) 適用：gh が要る
[ "$have_gh" -eq 1 ] \
  || die "gh CLI が必要です。https://cli.github.com からインストールし 'gh auth login' してください。"
# 管理者トークンを環境変数(GH_TOKEN/GITHUB_TOKEN)で渡した場合は対話ログイン確認を省く。
# ※ branch protection には管理者権限が要る。GitHub Actions の自動トークンには権限が無く使えない
#    （このスクリプトは、管理者本人が手元で gh auth 済みで実行する用途）。
if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  gh auth status >/dev/null 2>&1 \
    || die "gh が未認証です。'gh auth login' を実行してください。"
fi

printf '%s' "$payload" | gh api -X PUT \
  -H "Accept: application/vnd.github+json" \
  "repos/${owner}/${repo}/branches/${default_branch}/protection" \
  --input - >/dev/null

echo "✓ branch protection を適用しました: ${owner}/${repo}@${default_branch}"
echo "  必須チェック ${REQUIRED_CHECKS[*]} が緑でなければマージ不可になりました。"
echo "  これで cc-v2 と同レベルの機械強制で運用されます。"
