#!/bin/bash
# クラウド上のClaude Codeセッション(PCを持たない利用者向け)を開いた瞬間に、
# video-shorts のパイプラインが必要とする外部ツール(ffmpeg・Python文字起こしライブラリ)を
# 自動で用意する(G-DELIVERY)。ローカルPCでの通常セッションでは何もしない
# ($CLAUDE_CODE_REMOTE が真の場合のみ動作)。
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# バージョン固定（roadmap P1-12-A）: ubuntu-24.04 の apt リポジトリで実際に動作確認した版。
# CI(.github/workflows/ci.yml)の ubuntu-24.04 ランナーと同じ版に合わせてある。
FFMPEG_PIN="7:6.1.1-3ubuntu5"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[session-start] ffmpeg が無いため導入します..." >&2
  # 環境によっては本筋と無関係な野良PPA(deadsnakes/ondrej等)が組織のegressポリシーで
  # 403になり得るが、それらが失敗しても標準リポジトリ由来のffmpeg導入は継続できるべき
  # なので update の非ゼロ終了だけでは止めない。
  sudo apt-get update -y || true
  # "if ! cmd; then rc=\$?" は使わない: "!" による否定後は \$? が否定済みの値(=cmdが
  # 失敗しても0)になり、実際の終了コードを取り違えるため(実地で確認済みのバグ)。
  # "if cmd; then :; else rc=\$?" の形にし、else節でcmdそのものの終了コードを取る。
  if sudo apt-get install -y "ffmpeg=${FFMPEG_PIN}"; then
    :
  else
    # リモート環境の apt ミラーが ubuntu-24.04 と厳密に一致しない場合の保険。
    # 固定版が見つからない事実は隠さず警告してから、無指定版で導入を続ける
    # (ユーザーが動画編集を始められないほうが実害が大きいため、ここは fail-open)。
    echo "[session-start] 固定版 ffmpeg=${FFMPEG_PIN} が見つからないため、無指定版で導入します(要:再固定)" >&2
    if sudo apt-get install -y ffmpeg; then
      :
    else
      rc=$?
      echo "[session-start][ERROR] ffmpeg の apt-get install に失敗しました(exit code: ${rc})。" >&2
      echo "[session-start][ERROR] ネットワーク到達性(egressポリシー等)か、apt パッケージリポジトリの状態を確認してください。" >&2
      exit "$rc"
    fi
  fi
fi

if ! python3 -c "import faster_whisper, groq" >/dev/null 2>&1; then
  echo "[session-start] 文字起こしライブラリ(faster-whisper/groq)が無いため導入します..." >&2
  if python3 -m pip install --break-system-packages -r "$REPO_ROOT/video-shorts/requirements.txt"; then
    :
  else
    rc=$?
    echo "[session-start][ERROR] pip install (video-shorts/requirements.txt) に失敗しました(exit code: ${rc})。" >&2
    echo "[session-start][ERROR] requirements.txt の内容・PyPIへのネットワーク到達性を確認してください。" >&2
    exit "$rc"
  fi
fi
