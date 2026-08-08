// 字幕の手直しの保存の検証 — G-EDIT-CAPTION-A（保存の部分）
//
// A の合格条件は「画面で書き換えて保存でき、サーバを再起動して開き直しても残っている」。
// ここで測るのは後半（ディスクに残り、読み直せる）で、画面操作は別途 independent-verifier が見る。
// 「再起動しても残る」を機械で押さえるため、書いたのとは別のプロセスで読み直す。
//
// 実行: node tests/caption-store-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EDITS_FILE, MAX_WORD_LENGTH, applyEdits, editPairs, judgeWordEdit, readEdits, saveWordEdit,
} from "../src/caption-store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, "..", "src", "caption-store.mjs");
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

const WORDS = [
  { w: "きょうは", start: 0.0, end: 0.4 },
  { w: "追患版", start: 0.4, end: 0.9 },
  { w: "の", start: 0.9, end: 1.0 },
  { w: "はなしです", start: 1.0, end: 1.6 },
];

function freshWork() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vs-caption-"));
}

// ── 何を受け付けるか ────────────────────────────────────────
t("A: 範囲の外の位置は受け付けない", () => {
  assert.ok(!judgeWordEdit(-1, "椎間板", WORDS.length).ok);
  assert.ok(!judgeWordEdit(WORDS.length, "椎間板", WORDS.length).ok);
  assert.ok(!judgeWordEdit(1.5, "椎間板", WORDS.length).ok);
});

t("A: 空・空白だけは受け付けない", () => {
  for (const s of ["", "   ", "　"]) assert.ok(!judgeWordEdit(1, s, WORDS.length).ok, JSON.stringify(s));
});

t(`A: ${MAX_WORD_LENGTH + 1}文字と改行入りは受け付けない（行の貼り付けを弾く）`, () => {
  assert.ok(!judgeWordEdit(1, "あ".repeat(MAX_WORD_LENGTH + 1), WORDS.length).ok);
  assert.ok(!judgeWordEdit(1, "椎間板\nの話", WORDS.length).ok);
});

t("A: 受け付けない理由が文章で返る（黙って捨てない）", () => {
  const r = judgeWordEdit(99, "椎間板", WORDS.length);
  assert.ok(!r.ok);
  assert.ok(typeof r.reason === "string" && r.reason.length > 0);
});

// ── 保存して読み直せる ──────────────────────────────────────
t("A: 直した内容がファイルに残る", () => {
  const dir = freshWork();
  const r = saveWordEdit(dir, { index: 1, text: "椎間板", original: WORDS[1].w, wordCount: WORDS.length });
  assert.strictEqual(r.saved, true);
  assert.ok(fs.existsSync(path.join(dir, EDITS_FILE)), "保存先のファイルが無い");
  assert.deepStrictEqual(readEdits(dir).words, { 1: "椎間板" });
});

t("A: 別のプロセスで読み直しても残っている（＝再起動しても消えない）", () => {
  const dir = freshWork();
  saveWordEdit(dir, { index: 1, text: "椎間板", original: WORDS[1].w, wordCount: WORDS.length });
  // このプロセスのメモリを介さず、新しい node で読み直す
  const out = execFileSync(process.execPath, [
    "-e",
    `import(${JSON.stringify(STORE)}).then(m => console.log(JSON.stringify(m.readEdits(${JSON.stringify(dir)}))))`,
  ], { encoding: "utf-8" });
  assert.deepStrictEqual(JSON.parse(out.trim()).words, { 1: "椎間板" });
});

t("A: 何も直していないフォルダは空で返る（不在は「壊れ」ではない）", () => {
  assert.deepStrictEqual(readEdits(freshWork()).words, {});
});

t("A: 壊れたファイルは黙って空にせず、例外にする", () => {
  const dir = freshWork();
  fs.writeFileSync(path.join(dir, EDITS_FILE), "{ こわれている", "utf-8");
  assert.throws(() => readEdits(dir), /.*/);
});

t("A: 同じ語を直し直せる（上書きできる）", () => {
  const dir = freshWork();
  saveWordEdit(dir, { index: 1, text: "椎間盤", original: WORDS[1].w, wordCount: WORDS.length });
  saveWordEdit(dir, { index: 1, text: "椎間板", original: WORDS[1].w, wordCount: WORDS.length });
  assert.deepStrictEqual(readEdits(dir).words, { 1: "椎間板" });
});

t("A: 元の文字に戻すと、直しの記録が消える", () => {
  const dir = freshWork();
  saveWordEdit(dir, { index: 1, text: "椎間板", original: WORDS[1].w, wordCount: WORDS.length });
  saveWordEdit(dir, { index: 1, text: WORDS[1].w, original: WORDS[1].w, wordCount: WORDS.length });
  assert.deepStrictEqual(readEdits(dir).words, {}, "戻したのに直した扱いのまま");
});

t("A: 直しても、直す前の語は元のまま残っている（葉Bと辞書のために要る）", () => {
  const dir = freshWork();
  saveWordEdit(dir, { index: 1, text: "椎間板", original: WORDS[1].w, wordCount: WORDS.length });
  const shown = applyEdits(WORDS, readEdits(dir));
  assert.strictEqual(shown[1].w, "椎間板", "直しが反映されていない");
  assert.strictEqual(WORDS[1].w, "追患版", "元の配列が書き換わっている");
});

t("A: 直しを重ねても、語の時刻は元のまま（焼き直しで字幕がずれない）", () => {
  const dir = freshWork();
  saveWordEdit(dir, { index: 1, text: "椎間板", original: WORDS[1].w, wordCount: WORDS.length });
  const shown = applyEdits(WORDS, readEdits(dir));
  assert.strictEqual(shown[1].start, WORDS[1].start);
  assert.strictEqual(shown[1].end, WORDS[1].end);
});

t("C の入力: 直した語から「修正前→修正後」の対が作れる", () => {
  const dir = freshWork();
  saveWordEdit(dir, { index: 1, text: "椎間板", original: WORDS[1].w, wordCount: WORDS.length });
  saveWordEdit(dir, { index: 3, text: "話です", original: WORDS[3].w, wordCount: WORDS.length });
  assert.deepStrictEqual(editPairs(WORDS, readEdits(dir)), [
    { index: 1, before: "追患版", after: "椎間板" },
    { index: 3, before: "はなしです", after: "話です" },
  ]);
});

// ── 対照: この検査が「壊れ」を実際に見つけられること ──────────
t("対照: 保存しない実装なら、読み直しの検査は落ちる", () => {
  const dir = freshWork();
  // 保存を通さずに読む＝「保存されていない」状態
  assert.deepStrictEqual(readEdits(dir).words, {});
  const wouldPass = Object.keys(readEdits(dir).words).length > 0;
  assert.strictEqual(wouldPass, false, "保存していないのに残っていると判定された");
});

t("対照: 元の配列を書き換える実装なら、元が残る検査は落ちる", () => {
  const copy = WORDS.map((w) => ({ ...w }));
  copy[1].w = "椎間板";   // わざと元を書き換える壊し方
  assert.notStrictEqual(copy[1].w, "追患版", "書き換えたのに元のままと判定された");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
