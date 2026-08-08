"""用語辞書が字幕の元へ効くことの検証 — G-EDIT-CAPTION-D（適用の部分）

D の合格条件は「辞書に対が入っているときだけ、字幕の元になる words[].w に修正後の語が現れる」。
焼かれる字幕は words[].w から作られるので、segments[].text だけが直っている状態は不合格。

term-corrections.json の _limitation に書かれていた既知の限界
（誤変換語が複数トークンへ分割されると words[].w が直らない）を塞いだので、
分割された場合も直ることをここで押さえる。

実行: python3 tests/term-apply-check.py   (全PASSで exit 0)
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "src"))

from transcribe import apply_corrections, fix_words  # noqa: E402

fail = 0


def check(cond, msg):
    global fail
    print(f"{'PASS' if cond else 'FAIL'} {msg}")
    if not cond:
        fail += 1
    return cond


DICT = {"追患版": "椎間板"}


def texts(words):
    return [w["w"] for w in words]


# ── 対照: 辞書が無ければ直らない ────────────────────────────
# これが無いと、音声認識が元々正しく書き起こしただけでも合格してしまう。
split = [
    {"w": "追", "start": 0.0, "end": 0.1},
    {"w": "患", "start": 0.1, "end": 0.2},
    {"w": "版", "start": 0.2, "end": 0.3},
    {"w": "の話", "start": 0.3, "end": 0.6},
]
check(texts(fix_words([dict(w) for w in split], {})) == ["追", "患", "版", "の話"],
      "対照D: 辞書が空なら words[].w は元のまま（修正前の語が残る）")

# ── D: 1語に収まる誤変換 ────────────────────────────────────
one = [{"w": "追患版", "start": 0.0, "end": 0.3}, {"w": "の話", "start": 0.3, "end": 0.6}]
check(texts(fix_words([dict(w) for w in one], DICT)) == ["椎間板", "の話"],
      "D: 1語に収まる誤変換が words[].w で直る")

# ── D: 複数トークンへ分割された誤変換（これまでの限界） ──────
fixed = fix_words([dict(w) for w in split], DICT)
check(texts(fixed) == ["椎間板", "の話"],
      f"D: 語をまたいで分割された誤変換も words[].w で直る（実={texts(fixed)}）")
check(fixed[0]["start"] == 0.0 and fixed[0]["end"] == 0.3,
      f"D: まとめた語の時刻が元の範囲のまま（実={fixed[0]['start']}〜{fixed[0]['end']}）")

# ── D: 語の途中で一致した場合、前後の文字を落とさない ────────
partial = [{"w": "あ追患", "start": 0.0, "end": 0.2}, {"w": "版い", "start": 0.2, "end": 0.4}]
got = fix_words([dict(w) for w in partial], DICT)
check(texts(got) == ["あ椎間板い"], f"D: 一致範囲の前後の文字が残る（実={texts(got)}）")

# ── D: 同じ誤変換が2か所にあっても両方直る ──────────────────
twice = [
    {"w": "追患版", "start": 0.0, "end": 0.3},
    {"w": "と", "start": 0.3, "end": 0.4},
    {"w": "追", "start": 0.4, "end": 0.5},
    {"w": "患版", "start": 0.5, "end": 0.7},
]
got2 = fix_words([dict(w) for w in twice], DICT)
check(texts(got2) == ["椎間板", "と", "椎間板"], f"D: 2か所とも直る（実={texts(got2)}）")

# ── D: 直した語が別の誤変換を含んでも無限に回らない ──────────
loopy = fix_words([{"w": "ああ", "start": 0, "end": 1}], {"あ": "ああ"})
check(texts(loopy) == ["ああ"], f"D: 置換後が同じ誤変換を含む辞書でも止まる（実={texts(loopy)}）")

# ── D: segments[].text だけ直っている状態は作らない ──────────
result = {
    "words": [dict(w) for w in split],
    "segments": [{"text": "追患版の話", "start": 0.0, "end": 0.6}],
}
applied = apply_corrections(result, DICT)
check(texts(applied["words"]) == ["椎間板", "の話"],
      "D: apply_corrections が words[].w を直す")
check(applied["segments"][0]["text"] == "椎間板の話",
      "D: apply_corrections が segments[].text も直す")
check(not any("追患版" in w["w"] for w in applied["words"]),
      "D: 直したあとの words[].w に修正前の語が残っていない")

# ── 対照: この検査が「直っていない状態」を見つけられること ────
naive = [dict(w) for w in split]
for w in naive:
    for wrong, right in DICT.items():
        if wrong in w["w"]:
            w["w"] = w["w"].replace(wrong, right)
check(texts(naive) == ["追", "患", "版", "の話"],
      "対照D: 1語ずつ置換する素朴な実装では分割された語が直らない（＝この検査に意味がある）")

# ── 壊れた入力で落ちない ────────────────────────────────────
check(fix_words([{"start": 0, "end": 1}], DICT) == [{"start": 0, "end": 1}],
      "D: w を持たない語があっても落ちない")
check(fix_words([], DICT) == [], "D: 語が無くても落ちない")
check(fix_words(None, DICT) is None, "D: words が None でも落ちない")

print(f"\n--- {'ALL PASS' if fail == 0 else str(fail) + ' FAIL'} ---")
sys.exit(0 if fail == 0 else 1)
