# R-4 文字起こし後補正の単体テスト。実行: python tests/transcribe-corrections-check.py
# faster-whisper/ffmpeg 不要でロジック単体を検証する（transcribe.py の import は関数のみで副作用なし）。
import sys
import os

try:
    sys.stdout.reconfigure(encoding="utf-8")  # Windows cp932 での日本語文字化け回避
except Exception:
    pass

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from transcribe import load_corrections, apply_corrections

fail = 0


def check(cond, msg):
    global fail
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        fail += 1


c = load_corrections()
check(len(c) >= 1, f"辞書ロード({len(c)}件・_comment除外)")
check(all(not k.startswith("_") for k in c), "_始まりキーは置換対象から除外される")

# words[].w と segments[].text の両方が補正される
r = {
    "words": [{"w": "追患版", "start": 0, "end": 1}, {"w": "です", "start": 1, "end": 2}],
    "segments": [{"start": 0, "end": 2, "text": "追患版ヘルニアです"}],
}
apply_corrections(r, c)
check(r["words"][0]["w"] == "椎間板", "words[].w が補正される")
check(r["segments"][0]["text"] == "椎間板ヘルニアです", "segments[].text が補正される")

# 空辞書・欠損フィールドで例外を出さない（サイレントフェイル禁止だがクラッシュもさせない）
r2 = {"words": [{"start": 0}], "segments": []}
apply_corrections(r2, {})
apply_corrections(r2, c)
check(True, "空辞書・w欠損wordで例外なし")

print(f"\n--- {'ALL PASS' if fail == 0 else str(fail) + ' FAIL'} ---")
sys.exit(0 if fail == 0 else 1)
