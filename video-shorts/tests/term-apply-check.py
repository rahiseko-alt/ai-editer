"""用語辞書が字幕の元へ効くことの検証 — G-EDIT-CAPTION-D（適用の部分＋通し確認）

D の合格条件は「辞書に対が入っているときだけ、字幕の元になる words[].w に修正後の語が現れる」。
焼かれる字幕は words[].w から作られるので、segments[].text だけが直っている状態は不合格。

term-corrections.json の _limitation に書かれていた既知の限界
（誤変換語が複数トークンへ分割されると words[].w が直らない）を塞いだので、
分割された場合も直ることをここで押さえる（ここまでが「適用の部分」＝fix_words/apply_corrections
を直接呼ぶ単体検査）。

【2026-08-11 マスター決定(D-3)により追加・通し確認】
verify は「同じ音声・同じ手順で2本流す」＝実際に faster-whisper で文字起こしを2回走らせる
ことを求めている。以前は「モデル本体がこの環境にキャッシュされておらず、CIで毎回取得すると
負担が大きい」ため、fix_words/apply_corrections を直接呼ぶ単体検査(上のD区間)だけで
済ませていた。マスター決定により、モデルをCIへ実際に載せる方針となったため、
下部の real_model_check() で src/transcribe.py を実際にCLIとして2回起動する
（(a)辞書にペアを入れた状態 / (b)対照として入れない状態）。凍結済み音声素材
tests/fixtures/trim-calibration/calibration.flac を使う（他の素材へは差し替えない）。

実行: python3 tests/term-apply-check.py   (全PASSで exit 0)
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

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


# ══════════════════════════════════════════════════════════════════
# D-3: 通し確認（実際に faster-whisper を2回走らせる）
# ══════════════════════════════════════════════════════════════════
CALIB_FLAC = os.path.join(HERE, "fixtures", "trim-calibration", "calibration.flac")
TERM_DICT_PATH = os.path.join(ROOT, "src", "term-corrections.json")
TRANSCRIBE_PY = os.path.join(ROOT, "src", "transcribe.py")

# calibration.json（凍結済み）が定義する区間のうち index 1 は「こんにちは」
# （2026-08-12 軌道修正C-7反証(2)(3)是正でindex7は「はい」へ差し替えたが、この検査は
# 位置に依存せずwords[].w全体に対する部分一致で見るため、index1が残っていれば影響しない）。
# small モデルでの実測（本検査を書く際に確認済み）では「こんにちは。」のように
# 句読点が付いて1語になるため、辞書側は素の「こんにちは」を key にした部分一致で
# 直る（transcribe.fix_words は連結文字列に対する部分一致で置換する）。
BEFORE_WORD = "こんにちは"
# ひらがな→カタカナで、BEFORE_WORD と共通の文字を持たない語に置き換える
# （部分一致による誤検出を避けるため）。
AFTER_WORD = "コンニチワ"


def run_transcribe(out_path):
    """src/transcribe.py を実際にサブプロセスとして起動し、calibration.flac を文字起こしする。
    GROQ_API_KEY の有無に関わらず --backend local を明示し、ローカル(faster-whisper)を強制する
    （auto だと環境の GROQ_API_KEY 次第でバックエンドが変わり、2回の実行条件が揃わなくなるため）。
    """
    r = subprocess.run(
        [sys.executable, TRANSCRIBE_PY, CALIB_FLAC, out_path,
         "--model", "small", "--lang", "ja", "--backend", "local"],
        cwd=ROOT, capture_output=True, text=True, timeout=600,
    )
    if r.returncode != 0:
        raise RuntimeError(
            f"transcribe.py が失敗しました(code={r.returncode})\n"
            f"stdout={r.stdout}\nstderr={r.stderr[-4000:]}"
        )
    with open(out_path, "r", encoding="utf-8") as f:
        return json.load(f)


def real_model_check():
    global fail
    if not os.path.isfile(CALIB_FLAC):
        check(False, f"D-3通し: 凍結素材が見つかりません: {CALIB_FLAC}")
        return
    if not os.path.isfile(TERM_DICT_PATH):
        check(False, f"D-3通し: 用語辞書が見つかりません: {TERM_DICT_PATH}")
        return

    with open(TERM_DICT_PATH, "r", encoding="utf-8") as f:
        original_dict_text = f.read()
    original_dict = json.loads(original_dict_text)
    check(BEFORE_WORD not in original_dict and AFTER_WORD not in original_dict,
          "D-3通し: 前提として本物の辞書に今回使う語がまだ登録されていない"
          "（登録済みだと対照(b)が意味をなさない）")

    tmp_dir = tempfile.mkdtemp(prefix="term-apply-real-")
    try:
        # ── (b) 対照: 辞書から対を外した状態(＝本物の辞書のまま)で1回目 ──────
        out_b = os.path.join(tmp_dir, "transcript-without-dict.json")
        result_b = run_transcribe(out_b)
        words_b = [w.get("w", "") for w in result_b.get("words", [])]
        joined_b = "".join(words_b)
        check(BEFORE_WORD in joined_b,
              f"D-3通し 対照(b): 辞書に対が無い状態では修正前の語({BEFORE_WORD})が"
              f"words[].w に現れる（実際の words={words_b}）")
        check(AFTER_WORD not in joined_b,
              f"D-3通し 対照(b): 辞書に対が無い状態では修正後の語({AFTER_WORD})は現れない"
              f"（実際の words={words_b}）")

        # ── (a) 辞書に対を入れた状態で2回目（同じ音声・同じ手順） ────────────
        modified_dict = dict(original_dict)
        modified_dict[BEFORE_WORD] = AFTER_WORD
        with open(TERM_DICT_PATH, "w", encoding="utf-8") as f:
            json.dump(modified_dict, f, ensure_ascii=False, indent=2)

        out_a = os.path.join(tmp_dir, "transcript-with-dict.json")
        try:
            result_a = run_transcribe(out_a)
        finally:
            # 本物の辞書は他の全案件に効く共有資源なので、結果を見る前に必ず元へ戻す
            # （この後の check() で例外が起きても辞書だけは復元されているようにする）。
            with open(TERM_DICT_PATH, "w", encoding="utf-8") as f:
                f.write(original_dict_text)

        with open(TERM_DICT_PATH, "r", encoding="utf-8") as f:
            restored = f.read()
        check(restored == original_dict_text,
              "D-3通し: 検査後、本物の用語辞書(term-corrections.json)が元の内容へ復元されている"
              "（他の全案件に効く共有ファイルを検査が壊していないこと）")

        words_a = [w.get("w", "") for w in result_a.get("words", [])]
        joined_a = "".join(words_a)
        check(AFTER_WORD in joined_a,
              f"D-3通し (a): 辞書に対を入れた状態では修正後の語({AFTER_WORD})が"
              f"words[].w に現れる（実際の words={words_a}）")
        check(BEFORE_WORD not in joined_a,
              f"D-3通し (a): 辞書に対を入れた状態では修正前の語({BEFORE_WORD})は"
              f"words[].w に残っていない（実際の words={words_a}）")

        # segments[].text だけ直り words[].w が直っていない、という旧限界(_limitation)が
        # 再発していないことも合わせて確認する（D と同じ観点を実モデル出力でも押さえる）。
        segs_a = [s.get("text", "") for s in result_a.get("segments", [])]
        joined_segs_a = "".join(segs_a)
        check(AFTER_WORD in joined_segs_a,
              f"D-3通し (a): segments[].text にも修正後の語が反映されている（実際={segs_a}）")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


real_model_check()

print(f"\n--- {'ALL PASS' if fail == 0 else str(fail) + ' FAIL'} ---")
sys.exit(0 if fail == 0 else 1)
