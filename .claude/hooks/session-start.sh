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

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[session-start] ffmpeg が無いため導入します..." >&2
  # 環境によっては本筋と無関係な野良PPA(deadsnakes/ondrej等)が組織のegressポリシーで
  # 403になり得るが、それらが失敗しても標準リポジトリ由来のffmpeg導入は継続できるべき
  # なので update の非ゼロ終了だけでは止めない。
  sudo apt-get update -y || true
  sudo apt-get install -y ffmpeg
fi

if ! python3 -c "import faster_whisper, groq" >/dev/null 2>&1; then
  echo "[session-start] 文字起こしライブラリ(faster-whisper/groq)が無いため導入します..." >&2
  python3 -m pip install --break-system-packages -r "$REPO_ROOT/video-shorts/requirements.txt"
fi
