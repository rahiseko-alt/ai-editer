#!/usr/bin/env python3
"""Groq API キーが有効か（通ったか）を人間が確認するためのチェッカー。

使い方（video-shorts フォルダで）:
    python src/check-groq-key.py

最軽量の chat API を1回叩くだけ。音声ファイル不要・課金ほぼゼロ。
「✅ 通った / ❌ まだ無効」を日本語で表示する。鍵の値は一切表示しない。
"""
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # video-shorts/


def load_key():
    # 優先順位: 環境変数 → .env（transcribe_groq.py / pipeline-runner.mjs と同一に保つ）。
    # .env の空値行（GROQ_API_KEY=）は「未設定」として読み飛ばす。
    env_val = (os.environ.get("GROQ_API_KEY") or "").strip()
    if env_val:
        return env_val
    env = os.path.join(HERE, ".env")
    if os.path.isfile(env):
        for line in open(env, encoding="utf-8-sig"):
            line = line.strip()
            if line.startswith("GROQ_API_KEY="):
                v = line.split("=", 1)[1].strip().strip('"').strip("'")
                if v:
                    return v
    return ""


def main():
    key = load_key()
    if not key:
        print("[NG] .env に GROQ_API_KEY がありません。")
        print("   → video-shorts/.env に  GROQ_API_KEY=gsk_...  を1行書いてください。")
        return 1
    if not key.startswith("gsk_"):
        print("[NG] 鍵の形式がおかしいです（gsk_ で始まっていません）。貼り直してください。")
        return 1
    try:
        from groq import Groq
    except ImportError:
        print("[NG] groq 未インストール。`pip install groq` を実行してください。")
        return 1

    try:
        c = Groq(api_key=key)
        c.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "user", "content": "ping"}],
            max_tokens=1,
        )
    except Exception as e:
        name = type(e).__name__
        if "401" in str(e) or "invalid_api_key" in str(e):
            print("[NG] まだ鍵が無効です（Groq が Invalid API Key と返しました）。")
            print("   対処: https://console.groq.com/keys で鍵を作り直す、")
            print("        または console の Settings で組織・請求設定の未完了バナーが無いか確認。")
        else:
            print(f"[!] 別のエラーです: {name}: {str(e)[:160]}")
        return 2

    print("[OK] 鍵は有効です。文字起こしで Groq（高速）が使えます。")
    print("   確認: python src/transcribe.py <動画> <out.json> --backend groq --lang ja")
    return 0


if __name__ == "__main__":
    sys.exit(main())
