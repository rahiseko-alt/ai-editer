// 用語辞書の追記の検証 — G-EDIT-CAPTION-C / G-EDIT-CAPTION-F
//
// C: 画面で直した語が、1語かつ12文字以内のときだけ辞書に追記される
// F: 追記しても、追記前に存在した全エントリが同じキー・同じ値で残り、JSONとして読める
//
// 本物の src/term-corrections.json は書き換えない。同じ中身を写した一時ファイルで測る
// （テストが本番の辞書を書き換えると、以後の全案件に効いてしまう）。
//
// 実行: node tests/term-dictionary-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DICT_PATH, MAX_TERM_LENGTH, appendTerm, isSingleTerm, judgeTermPair, readDictionary,
} from "../src/term-dictionary.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
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

t("C: 載せない理由が文章で返る（黙って捨てない）", () => {
  const r = judgeTermPair("これは 文です", "これは文です");
  assert.ok(!r.ok);
  assert.ok(typeof r.reason === "string" && r.reason.length > 0, "reason が空");
});

t("C: 実際に追記される／されないが、判定どおりになる", () => {
  const p = freshDict();
  const ok = appendTerm("誤変換語", "正しい語", p);
  assert.strictEqual(ok.added, true, "1語12文字以内は追記されるはず");
  assert.strictEqual(readDictionary(p)["誤変換語"], "正しい語");

  const p2 = freshDict();
  const ng = appendTerm("これは 文まるごとの書き換えです", "これは文まるごとの書き換えです", p2);
  assert.strictEqual(ng.added, false, "文まるごとは追記されないはず");
  assert.deepStrictEqual(readDictionary(p2), readDictionary(DICT_PATH), "追記されないなら中身は変わらないはず");
});

t("C: すでにある語は上書きしない（前に直した内容が黙って変わらない）", () => {
  const p = freshDict();
  const r = appendTerm("追患版", "別の語", p);
  assert.strictEqual(r.added, false);
  assert.strictEqual(readDictionary(p)["追患版"], "椎間板", "既存の値が変わっている");
});

// ── F: 追記しても既存が壊れない ──────────────────────────────
t("F: 追記後も、追記前の全エントリが同じキー・同じ値で残る", () => {
  const p = freshDict();
  const before = readDictionary(p);
  const r = appendTerm("あたらしい語", "新しい語", p);
  assert.strictEqual(r.added, true);
  const after = readDictionary(p);
  for (const [k, v] of Object.entries(before)) {
    assert.ok(Object.prototype.hasOwnProperty.call(after, k), `キーが消えた: ${k}`);
    assert.deepStrictEqual(after[k], v, `値が変わった: ${k}`);
  }
});

t("F: 追記後のファイルが JSON として読める", () => {
  const p = freshDict();
  appendTerm("あたらしい語", "新しい語", p);
  const raw = fs.readFileSync(p, "utf-8");
  JSON.parse(raw);   // 例外なら不合格
  assert.ok(raw.endsWith("\n"), "末尾の改行が無い");
});

t("F: 運用の説明（_comment / _limitation）が残る", () => {
  const p = freshDict();
  appendTerm("あたらしい語", "新しい語", p);
  const after = readDictionary(p);
  assert.ok(typeof after._comment === "string" && after._comment.length > 0, "_comment が消えた");
  assert.ok(typeof after._limitation === "string" && after._limitation.length > 0, "_limitation が消えた");
});

t("F: 何度追記しても、先に入れた語が残る", () => {
  const p = freshDict();
  appendTerm("語い", "語1", p);
  appendTerm("語ろ", "語2", p);
  appendTerm("語は", "語3", p);
  const after = readDictionary(p);
  assert.strictEqual(after["語い"], "語1");
  assert.strictEqual(after["語ろ"], "語2");
  assert.strictEqual(after["語は"], "語3");
});

t("F: 壊れた辞書は黙って空にせず、例外にする", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-term-broken-"));
  const p = path.join(dir, "term-corrections.json");
  fs.writeFileSync(p, "{ こわれている", "utf-8");
  assert.throws(() => appendTerm("語", "ご", p), /.*/);
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
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
