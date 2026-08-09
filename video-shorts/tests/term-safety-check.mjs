// 用語辞書が他の案件を壊さないことの検証 — 軌道修正 C-4
//
// 【守る受入事実】覚えさせた語のせいで、まだ見ぬ他の案件の字幕が1文字も変わらないこと。
//
// 【測り方の要】判定に使う素材（src/common-japanese.txt）と、検証に使う素材
// （tests/fixtures/term-safety/held-out.txt）は【別物】である。
// 判定に使った素材で検証すると「当たらないように選んだ鍵が当たらない」ことを確かめるだけになり、
// 何も測らない。2026-08-08 に実際にその失敗をした（下記）。
//
// 【この検査が作り直しである経緯（同じ穴を二度掘らないために残す）】
//  1回目の受入基準「『の』『は』『です』『ました』が拒否される」→ その4語の拒否リストで満たせた。
//   実測で が/を/に/から/て は素通りし、製品は1ミリも直らなかった。却下。
//  2回目の実装「その案件の書き起こしの中で当たる箇所が1つになるまで前後の文字を足す」→
//   鍵はそうなるまで伸ばして選ぶのだから必ず1箇所になる。何も測っていなかった。
//   実測：「この高速です」→鍵「の高速」→ 別案件の「この高速道路」が「この梗塞道路」に化けた。
//   素材を1.5倍にしても「高速です」「うは高速」「て行き」が漏れ続けた。取り下げ。
//  3回目（いまの実装）：判定対象を「任意の部分文字列」から「直す前の語そのもの」へ狭め、
//   ふつうの日本語の素材に出てくる語は載せない。「高速」は載せられなくなるが、それは正しい拒否。
//
// 実行: node tests/term-safety-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  COMMON_JA_PATH, DICT_PATH, appendSafeTerm, judgeAgainstCommonJapanese, readCommonJapanese,
  readDictionary,
} from "../src/term-dictionary.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HELD_OUT_PATH = path.join(HERE, "fixtures", "term-safety", "held-out.txt");

// 素材を凍結する。中身が変われば合否も変わるので、ハッシュを基準に含める。
// 素材を差し替えて緑にする逃げ道を塞ぐため（合格しなかったときに素材の方を書き換えられない）。
const COMMON_JA_SHA256 = "40cd03ba5a14d61924349300930dc357f5f1998b674604511adaba2c39ee43aa";
const HELD_OUT_SHA256 = "204ab34e6823db4a4973dcfc9eba66504e40fb6aafad781f3afa321d18893059";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.message}`); }
}

function sha256(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function heldOut() {
  return fs.readFileSync(HELD_OUT_PATH, "utf-8")
    .split("\n").filter((l) => !l.startsWith("#")).join("\n");
}

/** 辞書を実際に文へ当てて、出てくる文字列を返す（製品と同じ transcribe.py を使う） */
function applyDict(dict, text) {
  const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "src"))})
from transcribe import apply_corrections
d = json.loads(sys.argv[1]); s = sys.argv[2]
r = apply_corrections({"words": [], "segments": [{"text": s, "start": 0, "end": 1}]}, d)
print(r["segments"][0]["text"], end="")
`;
  return execFileSync("python3", ["-c", py, JSON.stringify(dict), text], { encoding: "utf-8" });
}

/** 辞書を words[] へ当てて、語の並びと時刻を返す */
function applyDictToWords(dict, words) {
  const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "src"))})
from transcribe import fix_words
print(json.dumps(fix_words(json.loads(sys.argv[2]), json.loads(sys.argv[1])), ensure_ascii=False))
`;
  return JSON.parse(execFileSync("python3", ["-c", py, JSON.stringify(dict), JSON.stringify(words)],
    { encoding: "utf-8" }).trim());
}

/** 辞書の写しを作る。本物を汚すと以後の全案件に効いてしまう。 */
function freshDict() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vs-termsafe-"));
  const p = path.join(d, "term-corrections.json");
  fs.copyFileSync(DICT_PATH, p);
  return p;
}

// ── 素材の凍結確認 ────────────────────────────────────────────
t("素材: 判定に使う一般的な日本語が、凍結したものと同じ", () => {
  assert.strictEqual(sha256(COMMON_JA_PATH), COMMON_JA_SHA256,
    "src/common-japanese.txt が変わっている。基準のハッシュも一緒に更新すること");
});

t("素材: 検証に使う別案件の文が、凍結したものと同じ", () => {
  assert.strictEqual(sha256(HELD_OUT_PATH), HELD_OUT_SHA256,
    "held-out.txt が変わっている。基準のハッシュも一緒に更新すること");
});

t("素材: 判定用と検証用が別物である（同じなら何も測っていない）", () => {
  const common = readCommonJapanese();
  const held = heldOut();
  assert.notStrictEqual(common, held, "判定用と検証用が同じ中身になっている");
  // 行ごとに見て、重なりが無いこと。1行でも共有すると held-out の意味が薄れる。
  const set = new Set(common.split("\n").map((s) => s.trim()).filter(Boolean));
  const shared = held.split("\n").map((s) => s.trim()).filter((s) => s && set.has(s));
  assert.strictEqual(shared.length, 0, `同じ文を共有している: ${shared.slice(0, 3).join(" / ")}`);
});

// ── 本体: 登録できた語は、別案件の文を1文字も変えない ──────────
// これが受入事実そのもの。判定に使っていない文で測るので、実装の内部を見ていない。
t("覚えさせられる語をすべて登録しても、別案件の文が1文字も変わらない", () => {
  const held = heldOut();
  // 誤変換で生まれうる語をひととおり試し、登録できたものだけを辞書に集める
  const tried = [
    ["追患版", "椎間板"], ["追間板", "椎間板"], ["椎間盤", "椎間板"],
    ["心筋高速", "心筋梗塞"], ["高速", "梗塞"], ["ました", "ましだ"],
    ["という", "と言う"], ["ですね", "ですネ"], ["の", "ノ"], ["は", "ハ"],
    ["が", "ガ"], ["を", "ヲ"], ["に", "ニ"], ["から", "カラ"], ["て", "テ"],
    ["です", "デス"], ["病院", "美容院"], ["検査", "県査"], ["今日", "京"],
  ];
  const dict = {};
  for (const [b, a] of tried) {
    const r = judgeAgainstCommonJapanese(b, a);
    if (r.ok) dict[r.key] = r.value;
  }
  assert.ok(Object.keys(dict).length > 0, "1件も登録できないなら、この検査は何も測っていない");
  const got = applyDict(dict, held);
  assert.strictEqual(got, held,
    `別案件の文が変わった。登録できた辞書=${JSON.stringify(dict)}`);
});

t("覚えさせられる語をすべて登録しても、別案件の語の数と時刻が変わらない", () => {
  const dict = {};
  for (const [b, a] of [["追患版", "椎間板"], ["心筋高速", "心筋梗塞"], ["高速", "梗塞"], ["ました", "ましだ"]]) {
    const r = judgeAgainstCommonJapanese(b, a);
    if (r.ok) dict[r.key] = r.value;
  }
  const src = [
    { w: "あり", start: 0.0, end: 0.3 }, { w: "ま", start: 0.3, end: 0.5 },
    { w: "した", start: 0.5, end: 0.9 }, { w: "ね", start: 0.9, end: 1.0 },
  ];
  const got = applyDictToWords(dict, src);
  assert.deepStrictEqual(got, src,
    `語の並びか時刻（秒）が変わった: ${JSON.stringify(got)}`);
});

// ── 対で置く: 直したいところは直る ─────────────────────────────
// 上の検査だけなら「何も登録しない」実装で通ってしまう。対で置いて塞ぐ。
t("直したかった誤変換は、ちゃんと直る", () => {
  const r = judgeAgainstCommonJapanese("追患版", "椎間板");
  assert.ok(r.ok, `登録できなかった: ${r.reason}`);
  assert.strictEqual(applyDict({ [r.key]: r.value }, "腰の追患版が痛いです"), "腰の椎間板が痛いです");
});

t("語をまたいで分割された誤変換も、これまでどおり直る（G-EDIT-CAPTION-D の回帰）", () => {
  const r = judgeAgainstCommonJapanese("追患版", "椎間板");
  const got = applyDictToWords({ [r.key]: r.value }, [
    { w: "あ追患", start: 0.0, end: 0.3 }, { w: "版い", start: 0.3, end: 0.6 }]);
  assert.deepStrictEqual(got, [{ w: "あ椎間板い", start: 0.0, end: 0.6 }],
    `語の並びか時刻が想定と違う: ${JSON.stringify(got)}`);
});

t("既存3件は、これまでどおり登録できる（挙動が変わらない）", () => {
  for (const b of ["追患版", "追間板", "椎間盤"]) {
    const r = judgeAgainstCommonJapanese(b, "椎間板");
    assert.ok(r.ok, `「${b}」が登録できなくなった: ${r.reason}`);
    assert.strictEqual(r.key, b);
  }
});

// ── 断る側 ────────────────────────────────────────────────
t("ふつうの日本語の語は断られ、理由が文章で返る（黙って捨てない）", () => {
  for (const b of ["高速", "ました", "という", "の", "は", "が", "を", "に", "から", "て"]) {
    const r = judgeAgainstCommonJapanese(b, "X");
    assert.ok(!r.ok, `「${b}」が登録できてしまう`);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0, `理由が返らない: ${b}`);
  }
});

t("直したあとが直す前を含む対は断る（登録できても字幕には反映されないため）", () => {
  // transcribe.py の fix_words が無限ループ避けでこの対を飛ばす。
  // 断らないと「登録しました」と出るのに何も直らない、黙った失敗になる。
  const r = judgeAgainstCommonJapanese("追患版", "あ追患版い");
  assert.ok(!r.ok, "断っていない");
});

// ── 変異実験（この検査が本当に効くことの証明）─────────────────
// 「何もしていない実装」で通らないことを、テスト自身に証明させる。
t("変異: 判定を素通りさせると、別案件の文が壊れる", () => {
  // 判定器を「何でも通す」に差し替えたのと同じ辞書を作る
  const naive = { 高速: "梗塞", ました: "ましだ", の: "ノ" };
  const held = heldOut();
  assert.notStrictEqual(applyDict(naive, held), held,
    "素通りさせても別案件が壊れないなら、この検査は何も見ていない");
});

t("変異: 判定の土台を空にすると、ふつうの日本語の語が通ってしまう", () => {
  // 素材が空＝どの語も「出てこない」ので全部通る。素材が効いていることの裏返しの確認。
  const r = judgeAgainstCommonJapanese("高速", "梗塞", "");
  assert.ok(r.ok, "素材を空にしても断るなら、判定は素材を見ていない");
});

t("変異: 素材を1文字ずらした偽物では、この検査は通らない", () => {
  // 「素材に無い並び」を鍵にすればよい、という抜け道が塞がれていることの確認。
  // 「高速です」は素材に無い並びだが、ふつうの日本語なので held-out に出る。
  const held = heldOut();
  assert.ok(held.includes("高速で"), "held-out に「高速で」が無いと、この確認は成立しない");
  assert.notStrictEqual(applyDict({ 高速で: "梗塞で" }, held), held,
    "前後の文字を足した鍵でも別案件が壊れることを、この検査は捕まえられる");
});

// ── 辞書へ実際に書くところまで ────────────────────────────────
t("辞書へ実際に追記され、既存の登録が1件も消えない（G-EDIT-CAPTION-F の回帰）", () => {
  const p = freshDict();
  const before = readDictionary(p);
  const r = appendSafeTerm("ぎっくり腰症候群", "急性腰痛症", null, p);
  assert.ok(r.added, `追記されなかった: ${r.reason}`);
  const after = readDictionary(p);
  for (const k of Object.keys(before)) {
    assert.strictEqual(after[k], before[k], `既存の登録が変わった: ${k}`);
  }
});

t("辞書への追記でも、ふつうの日本語の語は断られ、ファイルが変わらない", () => {
  const p = freshDict();
  const before = fs.readFileSync(p, "utf-8");
  const r = appendSafeTerm("高速", "梗塞", null, p);
  assert.ok(!r.added, "「高速」が辞書に入ってしまった");
  assert.strictEqual(fs.readFileSync(p, "utf-8"), before, "断ったのにファイルが変わった");
});

t("対照: 本物の用語辞書をこの検査が書き換えていない", () => {
  const real = readDictionary(DICT_PATH);
  assert.deepStrictEqual(Object.keys(real).sort(),
    ["_comment", "_limitation", "椎間盤", "追患版", "追間板"].sort());
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
