#!/usr/bin/env python3
"""video-shorts [3] 文字起こし — Groq バックエンド。

Groq Whisper (whisper-large-v3-turbo) をクラウドで叩き、ローカル faster-whisper と
同一スキーマの transcript.json を返す（reverse-match.mjs 互換）。§0「外部AIを束ねる」の実装。

出力 JSON はローカル版（transcribe.py）と完全一致:
    {
      "language": "ja",
      "duration": 1234.5,
      "words": [ {"w": "こんにちは", "start": 0.12, "end": 0.65}, ... ],
      "segments": [ {"start": 0.0, "end": 4.2, "text": "..." }, ... ]
    }

単体 CLI:
    python src/transcribe_groq.py <input.mp4> <out_transcript.json> [--lang ja] [--model whisper-large-v3-turbo]

鍵は .env の GROQ_API_KEY か環境変数から読む。値はログに出さない。

Groq audio API のファイルサイズ上限（無料枠 25MB / 有料 100MB）は、送信前に
16kHz モノラル mp3 へ音声抽出することで回避する（extract_audio_16k）。32kbps なら
100 分でも 25MB 未満に収まるため、この長さまでは分割不要。
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

DEFAULT_MODEL = "whisper-large-v3-turbo"
# Groq audio API のファイルサイズ上限（無料枠 25MB / 有料 100MB）を回避するため、
# 送信前に必ず 16kHz モノラル mp3 へ音声抽出する。whisper は内部で 16kHz に
# ダウンサンプルするため ASR 精度への影響は無視できる。32kbps なら 100 分でも
# 25MB 未満に収まり、長尺でも分割不要（元 mp4 直送だと数百 MB で 413 になる）。
AUDIO_SAMPLE_RATE = "16000"
AUDIO_BITRATE = "32k"


def load_key(explicit=None):
    """GROQ_API_KEY を 環境変数 → .env（video-shorts 直下）の順で取得。値は返すのみ・出力しない。

    優先順位は server/pipeline-runner.mjs の groqKeyAvailable() と同一に保つこと
    （並列制御の判定と実働バックエンドの不一致防止）。.env の空値行（GROQ_API_KEY=）は
    「未設定」として読み飛ばす（古い空行が残っていても環境変数へフォールバックする）。"""
    if explicit:
        return explicit.strip()
    env_val = (os.environ.get("GROQ_API_KEY") or "").strip()
    if env_val:
        return env_val
    # VS_ENV_FILE があれば既定の video-shorts/.env の代わりにそれを読む（テストが実運用の
    # .env を汚さずに検証するための差し替え口。src/env-file.mjs の envFilePath() と同じ規約）。
    override = os.environ.get("VS_ENV_FILE")
    if override:
        env_path = os.path.abspath(override)
    else:
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # src/ の親 = video-shorts/
        env_path = os.path.join(here, ".env")
    if os.path.isfile(env_path):
        with open(env_path, "r", encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if line.startswith("GROQ_API_KEY="):
                    # クォート囲み（"gsk_..." 等）で貼られた場合に備えクォートも除去
                    v = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if v:
                        return v
    return ""


def _to_schema(data):
    """Groq verbose_json 応答をローカル版と同一スキーマへ変換。"""
    words = []
    for w in (data.get("words") or []):
        if w.get("start") is None or w.get("end") is None:
            continue
        words.append({
            "w": (w.get("word") or "").strip(),
            "start": round(float(w["start"]), 3),
            "end": round(float(w["end"]), 3),
        })
    segments = []
    for s in (data.get("segments") or []):
        segments.append({
            "start": round(float(s.get("start", 0.0)), 3),
            "end": round(float(s.get("end", 0.0)), 3),
            "text": (s.get("text") or "").strip(),
        })
    return {
        "language": data.get("language"),
        "duration": round(float(data.get("duration") or 0.0), 3),
        "words": words,
        "segments": segments,
    }


def extract_audio_16k(input_path):
    """動画/大容量ファイルを Groq 上限内に収めるため 16kHz モノラル mp3 に抽出する。
    一時ファイルのパスを返す（呼び出し側が finally で削除する責務を持つ）。
    ffmpeg が無い/失敗した場合は RuntimeError（サイレントフェイル禁止）。"""
    fd, tmp = tempfile.mkstemp(suffix=".mp3", prefix="groq-audio-")
    os.close(fd)
    cmd = [
        "ffmpeg", "-y", "-i", input_path,
        "-vn", "-ac", "1", "-ar", AUDIO_SAMPLE_RATE,
        "-c:a", "libmp3lame", "-b:a", AUDIO_BITRATE,
        tmp,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except FileNotFoundError:
        os.path.exists(tmp) and os.remove(tmp)
        raise RuntimeError("ffmpeg が見つかりません。音声抽出に必須です。")
    except subprocess.CalledProcessError as e:
        os.path.exists(tmp) and os.remove(tmp)
        tail = (e.stderr or b"")[-400:].decode("utf-8", "replace")
        raise RuntimeError(f"ffmpeg 音声抽出に失敗: {tail}")
    return tmp


def transcribe_groq(input_path, lang=None, model=DEFAULT_MODEL, api_key=None):
    """Groq で文字起こしし、ローカル版と同一スキーマの dict を返す。
    送信前に 16kHz モノラル mp3 へ抽出し、上限超過（413）と帯域浪費を避ける。"""
    key = load_key(api_key)
    if not key:
        raise RuntimeError("GROQ_API_KEY が未設定です（.env または環境変数）。")
    try:
        from groq import Groq
    except ImportError:
        raise RuntimeError("groq 未インストール。`pip install groq` を実行してください。")

    # 長尺音声は upload + 処理に時間がかかるため timeout を広げ、接続断は自動リトライで吸収する
    # （この端末は Connection reset が出やすい）。max_retries は指数バックオフ付き。
    client = Groq(api_key=key, timeout=600.0, max_retries=3)
    audio_path = extract_audio_16k(input_path)
    try:
        with open(audio_path, "rb") as f:
            resp = client.audio.transcriptions.create(
                file=(os.path.basename(audio_path), f.read()),
                model=model,
                response_format="verbose_json",
                timestamp_granularities=["word", "segment"],
                language=lang,
            )
    finally:
        os.path.exists(audio_path) and os.remove(audio_path)
    data = resp.model_dump() if hasattr(resp, "model_dump") else dict(resp)
    return _to_schema(data)


def parse_args(argv):
    p = argparse.ArgumentParser(description="Groq Whisper word-level transcriber")
    p.add_argument("input", help="入力 mp4/音声ファイル")
    p.add_argument("output", help="出力 transcript.json パス")
    p.add_argument("--lang", default=None, help="言語コード (例: ja)。未指定で自動判定")
    p.add_argument("--model", default=DEFAULT_MODEL, help=f"Groq モデル。既定 {DEFAULT_MODEL}")
    return p.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    if not os.path.isfile(args.input):
        sys.stderr.write(f"[ERROR] 入力が見つかりません: {args.input}\n")
        return 2
    sys.stderr.write(f"[INFO] Groq backend model={args.model} 文字起こし開始: {args.input}\n")
    try:
        result = transcribe_groq(args.input, args.lang, args.model)
    except Exception as e:
        # 認証・ネットワーク等はここで分かりやすく落とす（サイレントフェイル禁止）
        sys.stderr.write(f"[ERROR] Groq 文字起こし失敗: {type(e).__name__}: {e}\n")
        return 4
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    sys.stderr.write(
        f"[OK] words={len(result['words'])} segments={len(result['segments'])} "
        f"duration={result['duration']}s → {args.output}\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
