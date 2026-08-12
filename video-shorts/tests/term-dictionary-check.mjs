// 用語辞書の追記の検証 — G-EDIT-CAPTION-C / G-EDIT-CAPTION-F
//
// C: 画面で直した語が、世間の用語辞書と同じ水準の形式チェックを通ったときだけ追記される
//    （1語・12文字以内・前後が違う・予約キーでない・字幕へ反映される形・すでに登録済みでない）
// F: 追記しても、追記前に存在した全エントリが同じキー・同じ値で残り、JSONとして読める
//
// 【この検査が守らないこと（2026-08-09 マスター決定）】載せた語が他の案件を壊さないことは
// 保証しない。網羅は不可能で、変換ミスは AI が文脈で直し、編集機能なので人間の確認も通るため。
// 以前あった「ふつうの日本語の素材に出てくる語は載せない」判定と tests/term-safety-check.mjs は
// この決定により削除した。よって「高速」「ました」「今日」等は登録できる（それでよい）。
//
// 本物の src/term-corrections.json は書き換えない。同じ中身を写した一時ファイルで測る
// （テストが本番の辞書を書き換えると、以後の全案件に効いてしまう）。
//
// 実行: node tests/term-dictionary-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DICT_PATH, MAX_TERM_LENGTH, SHORT_TERM_LENGTH, appendSafeTerm, isSingleTerm, judgeTermPair,
  readDictionary,
} from "../src/term-dictionary.mjs";

let pass = 0, fail = 0;

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n      ${e.message}`);
  }
}

/** 本物の辞書を写した一時ファイルを作る（本物は書き換えない） */
function freshDict() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-term-"));
  const p = path.join(dir, "term-corrections.json");
  fs.copyFileSync(DICT_PATH, p);
  return p;
}

// ── C: 何を辞書へ載せるか ────────────────────────────────────
t("C: 12文字以内の1語は載せてよいと判定される", () => {
  assert.ok(isSingleTerm("椎間板"));
  assert.ok(isSingleTerm("あ".repeat(MAX_TERM_LENGTH)));
});

t(`C: ${MAX_TERM_LENGTH + 1}文字は載せない（1文字でも超えたら載せない）`, () => {
  assert.ok(!isSingleTerm("あ".repeat(MAX_TERM_LENGTH + 1)));
});

// 軌道修正C-6反証(11)是正: 「12文字」はJavaScriptのString.prototype.length
// （UTF-16コード単位）で数える、と凍結する（G-EDIT-CAPTION-Cのcriteria/verify参照）。
// コードポイント数や見た目の文字数（書記素）とは異なる結果になる入力で、
// 実装が実際にUTF-16単位で数えていることを対照させる。
t("C対照: サロゲートペア文字は1字あたり2としてUTF-16単位で数えられる（見た目・コードポイント数では通らない境界）", () => {
  // 𠮟（U+20B9F、「しかる」の異体字）はBMP外でUTF-16では2コード単位。
  // 7個なら見た目もコードポイント数も7（12以内）だが、UTF-16単位では14で12を超える。
  const term = "\u{20B9F}".repeat(7);
  assert.strictEqual([...term].length, 7, "前提: コードポイント数は7のはず");
  assert.strictEqual(term.length, 14, "前提: UTF-16コード単位は14のはず");
  assert.ok(!isSingleTerm(term), "コードポイント数7・見た目7文字だが、UTF-16単位14文字なので載せない");
});

t("C対照: サロゲートペア文字ちょうど6個(UTF-16単位で12)は境界内として載せてよい", () => {
  const term = "\u{20B9F}".repeat(6);
  assert.strictEqual(term.length, 12, "前提: UTF-16コード単位はちょうど12のはず");
  assert.ok(isSingleTerm(term), "UTF-16単位でちょうど12文字なので載せてよい");
});

t("C対照: 結合文字（濁点等）は分解形だと見た目の文字数より多くUTF-16単位を消費する（見た目基準では通らない境界）", () => {
  // "が" は "か"+結合濁点(NFD分解形の「が」)。見た目は1文字だがUTF-16単位は2。
  // 7個なら見た目は7文字（12以内）だが、UTF-16単位では14で12を超える。
  const term = "が".repeat(7);
  assert.strictEqual(term.normalize("NFC").length, 7, "前提: 見た目(NFC正規化後)の文字数は7のはず");
  assert.strictEqual(term.length, 14, "前提: UTF-16コード単位は14のはず");
  assert.ok(!isSingleTerm(term), "見た目7文字だが、UTF-16単位14文字なので載せない");
});

t("C: 空白を含むものは「文」とみなして載せない（半角・全角・タブ・改行）", () => {
  for (const s of ["椎間板 ヘルニア", "椎間板　ヘルニア", "椎間板\tヘルニア", "椎間板\nヘルニア"]) {
    assert.ok(!isSingleTerm(s), `載せてはいけない: ${JSON.stringify(s)}`);
  }
});

t("C: 空文字・空白だけ・文字列でないものは載せない", () => {
  for (const s of ["", "   ", "　", null, undefined, 12, {}]) {
    assert.ok(!isSingleTerm(s), `載せてはいけない: ${JSON.stringify(s)}`);
  }
});

t("C: 直す前と後が同じなら載せない", () => {
  assert.ok(!judgeTermPair("椎間板", "椎間板").ok);
});

t("C: _ で始まる語は載せない（辞書の予約キーで、置換対象から外れる運用のため）", () => {
  assert.ok(!judgeTermPair("_comment", "説明").ok);
});

t("C: 直したあとが直す前を含む対は載せない（登録できても字幕に反映されないため）", () => {
  // transcribe.py の fix_words が無限ループ避けでこの対を飛ばす。断らないと
  // 「登録しました」と出るのに何も直らない、黙った失敗になる。
  assert.ok(!judgeTermPair("追患版", "あ追患版い").ok);
});

t(`C: ${SHORT_TERM_LENGTH}文字以下の短い語は、断らずに通したうえで注意書きを返す`, () => {
  // 世間の水準（AmiVoice は短い読みを公式に警告するが拒否はしない）に合わせる。
  // 断ると「心筋高速→心筋梗塞」のような直したい修正まで落ちてしまう。
  const r = judgeTermPair("高速", "梗塞");
  assert.ok(r.ok, "短い語が断られている");
  assert.ok(typeof r.notice === "string" && r.notice.length > 0, "注意書きが返らない");
  // 長い語には注意書きを付けない（何にでも付くなら注意になっていない）
  assert.strictEqual(judgeTermPair("ぎっくり腰症候群", "急性腰痛症").notice, undefined);
});

t("C: ふつうの日本語の語も登録できる（2026-08-09 の決定。AI と人間の確認が直す）", () => {
  // 以前はここで断っていた。断らないことが今回の決定である＝逆戻りを検知するために置く。
  const p = freshDict();
  const r = appendSafeTerm("高速", "梗塞", p);
  assert.strictEqual(r.added, true, `断られた: ${r.reason}`);
  assert.strictEqual(readDictionary(p)["高速"], "梗塞");
  assert.ok(typeof r.notice === "string" && r.notice.length > 0, "短い語なのに注意書きが返らない");
});

t("C: 載せない理由が文章で返る（黙って捨てない）", () => {
  const r = judgeTermPair("これは 文です", "これは文です");
  assert.ok(!r.ok);
  assert.ok(typeof r.reason === "string" && r.reason.length > 0, "reason が空");
});

t("C: 実際に追記される／されないが、判定どおりになる", () => {
  const p = freshDict();
  const ok = appendSafeTerm("誤変換語", "正しい語", p);
  assert.strictEqual(ok.added, true, "1語12文字以内は追記されるはず");
  assert.strictEqual(readDictionary(p)["誤変換語"], "正しい語");

  const p2 = freshDict();
  const ng = appendSafeTerm("これは 文まるごとの書き換えです", "これは文まるごとの書き換えです", p2);
  assert.strictEqual(ng.added, false, "文まるごとは追記されないはず");
  assert.deepStrictEqual(readDictionary(p2), readDictionary(DICT_PATH), "追記されないなら中身は変わらないはず");
});

t("C: すでにある語は上書きしない（前に直した内容が黙って変わらない）", () => {
  const p = freshDict();
  const r = appendSafeTerm("追患版", "別の語", p);
  assert.strictEqual(r.added, false);
  assert.strictEqual(readDictionary(p)["追患版"], "椎間板", "既存の値が変わっている");
});

// ── F: 追記しても既存が壊れない ──────────────────────────────
t("F: 追記後も、追記前の全エントリが同じキー・同じ値で残る", () => {
  const p = freshDict();
  const before = readDictionary(p);
  const r = appendSafeTerm("あたらしい語", "新しい語", p);
  assert.strictEqual(r.added, true);
  const after = readDictionary(p);
  for (const [k, v] of Object.entries(before)) {
    assert.ok(Object.prototype.hasOwnProperty.call(after, k), `キーが消えた: ${k}`);
    assert.deepStrictEqual(after[k], v, `値が変わった: ${k}`);
  }
});

t("F: 追記後のファイルが JSON として読める", () => {
  const p = freshDict();
  appendSafeTerm("あたらしい語", "新しい語", p);
  const raw = fs.readFileSync(p, "utf-8");
  JSON.parse(raw);   // 例外なら不合格
  assert.ok(raw.endsWith("\n"), "末尾の改行が無い");
});

t("F: 運用の説明（_comment / _limitation）が残る", () => {
  const p = freshDict();
  appendSafeTerm("あたらしい語", "新しい語", p);
  const after = readDictionary(p);
  assert.ok(typeof after._comment === "string" && after._comment.length > 0, "_comment が消えた");
  assert.ok(typeof after._limitation === "string" && after._limitation.length > 0, "_limitation が消えた");
});

t("F: 何度追記しても、先に入れた語が残る", () => {
  const p = freshDict();
  appendSafeTerm("語い", "語1", p);
  appendSafeTerm("語ろ", "語2", p);
  appendSafeTerm("語ぬ", "語3", p);
  const after = readDictionary(p);
  assert.strictEqual(after["語い"], "語1");
  assert.strictEqual(after["語ろ"], "語2");
  assert.strictEqual(after["語ぬ"], "語3");
});

t("F: 壊れた辞書は黙って空にせず、例外にする", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-term-broken-"));
  const p = path.join(dir, "term-corrections.json");
  fs.writeFileSync(p, "{ こわれている", "utf-8");
  // 判定を通る語を使う。判定で断られると辞書を読む前に返ってしまい、
  // 「壊れた辞書で例外になるか」を測れなくなる（2026-08-08）。
  assert.throws(() => appendSafeTerm("誤変換語", "正しい語", p), /.*/);
  // 壊れたまま残っていること＝黙って上書きして中身を捨てていない
  assert.strictEqual(fs.readFileSync(p, "utf-8"), "{ こわれている");
});

// ── 対照: この検査が「壊れ」を実際に見つけられること ──────────
t("対照: 既存を消す実装なら F の検査は落ちる", () => {
  const p = freshDict();
  const before = readDictionary(p);
  // わざと「丸ごと書き直す」壊し方をして、上の F と同じ式で落ちることを示す
  fs.writeFileSync(p, `${JSON.stringify({ あたらしい語: "新しい語" }, null, 2)}\n`, "utf-8");
  const after = readDictionary(p);
  const kept = Object.keys(before).every((k) => Object.prototype.hasOwnProperty.call(after, k));
  assert.strictEqual(kept, false, "丸ごと書き直したのに『全部残っている』と判定された");
});

t("対照: 本物の辞書はこのテストで書き換わっていない", () => {
  const real = readDictionary(DICT_PATH);
  assert.ok(!Object.prototype.hasOwnProperty.call(real, "あたらしい語"), "本物の辞書が汚れている");
  assert.ok(!Object.prototype.hasOwnProperty.call(real, "誤変換語"), "本物の辞書が汚れている");
  assert.ok(!Object.prototype.hasOwnProperty.call(real, "高速"), "本物の辞書が汚れている");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
