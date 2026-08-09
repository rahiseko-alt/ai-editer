// 用語辞書が他の案件を壊さないことの検証 — 軌道修正 C-4
//
// 【この検査が守るもの】用語辞書は全案件へ単純文字列置換で効く（src/transcribe.py の
// apply_corrections）。だから1件の登録が、以後すべての案件の書き起こしを書き換える。
//
// 【中心症例】字幕の「心筋高速」を「心筋梗塞」へ直したとき、素直に登録すると「高速」→「梗塞」に
// なり、以後すべての案件で「高速道路」が「梗塞道路」になる（2026-08-08 実測で再現）。
// 「高速」は正当な内容語なので、助詞の一覧でも、文字種と長さの規則でも、頻度の高い語の一覧でも、
// 形態素解析でも止まらない。つまり「どの語を登録させないか」の方向では原理的に防げない。
//
// 【なぜ「拒否できる語の一覧」を合格条件にしないか】
// 以前 C-4 の合格条件を「『の』『は』『です』『ました』が拒否される」と書いたが、
// その4語だけを拒否する実装で満たせてしまい、`が` `を` `に` `から` `て` は素通りしたまま
// 製品の壊れ方が1ミリも直らなかった（検証で却下済み）。
// そこで、この検査は入力の可否ではなく【置換の出力】を測る。しかも
// 「直ってはいけない」と「直らなければならない」を対で置くので、
// 「登録を全部拒否する」実装も「置換をやめる」実装も同時には通れない。
//
// 実行: node tests/term-anchor-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DICT_PATH, MIN_KEY_LENGTH, appendAnchoredTerm, findSafeAnchor, readDictionary,
} from "../src/term-dictionary.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.message}`); }
}

/** 本物の辞書は触らない。写しを作って測る（汚すと以後の全案件に効いてしまう）。 */
function freshDict() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vs-anchor-"));
  const p = path.join(d, "term-corrections.json");
  fs.copyFileSync(DICT_PATH, p);
  return p;
}

/** 辞書を実際に書き起こしへ当てて、出てくる文字列を返す（製品と同じ transcribe.py を使う） */
function applyDict(dict, text) {
  const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "src"))})
from transcribe import apply_corrections
d = json.loads(sys.argv[1]); s = sys.argv[2]
r = apply_corrections({"words": [], "segments": [{"text": s, "start": 0, "end": 1}]}, d)
print(r["segments"][0]["text"])
`;
  return execFileSync("python3", ["-c", py, JSON.stringify(dict), text], { encoding: "utf-8" }).trim();
}

/** 辞書を words[] へ当てて、語の並びと時刻を返す */
function applyDictToWords(dict, words) {
  const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "src"))})
from transcribe import fix_words
d = json.loads(sys.argv[1]); w = json.loads(sys.argv[2])
print(json.dumps(fix_words(w, d), ensure_ascii=False))
`;
  return JSON.parse(execFileSync("python3", ["-c", py, JSON.stringify(dict), JSON.stringify(words)],
    { encoding: "utf-8" }).trim());
}

// 素材：この案件で実際に起きる形。「高速」が3か所に出る（うち1つが直したい心筋高速）。
const CORPUS = "今日は心筋高速の話です。高速道路を走ります。最高速さで進みます。";
const AT = CORPUS.indexOf("高速");   // 心筋高速 の中の高速

// ── AC-3: 直す操作をしたとき、載る鍵が誤爆しない形になっている ──────────
// これが「拒否リストを足すだけ」を構造的に不可能にする。
t("AC-3: 「高速」→「梗塞」を直すと、文脈を足した鍵で登録される（裸の「高速」では載らない）", () => {
  const a = findSafeAnchor(CORPUS, AT, "高速", "梗塞");
  assert.ok(a.ok, `登録できなかった: ${a.reason}`);
  assert.notStrictEqual(a.key, "高速", "裸の「高速」が載ってしまった（以後の全案件で高速道路が壊れる）");
  assert.ok(a.key.includes("高速"), `鍵が直したい語を含んでいない: ${a.key}`);
  assert.ok(a.anchored, "文脈が足されていない");
});

const ANCHORED = findSafeAnchor(CORPUS, AT, "高速", "梗塞");
const DICT = ANCHORED.ok ? { [ANCHORED.key]: ANCHORED.value } : {};

// ── AC-1 と AC-2 は対で置く。片方だけなら手抜き実装が通ってしまう ──────
t("AC-1: その辞書で「高速道路を走ります」が1文字も変わらない", () => {
  assert.strictEqual(applyDict(DICT, "高速道路を走ります"), "高速道路を走ります");
});

t("AC-1: その辞書で「最高速さで進みます」も1文字も変わらない", () => {
  assert.strictEqual(applyDict(DICT, "最高速さで進みます"), "最高速さで進みます");
});

t("AC-2: 同じ辞書で「心筋高速です」は「心筋梗塞です」に直る", () => {
  assert.strictEqual(applyDict(DICT, "心筋高速です"), "心筋梗塞です");
});

// ── AC-4: words[] の要素数と時刻が壊れない ───────────────────────
// 直す前は、無関係な2語をまたいで一致し1語に融合していた（実測）。
// words[] は reverse-match.mjs が尺を確定する土台なので、壊れると尺の根拠が消える。
t("AC-4: 無関係な2語（最高／速さ）が融合せず、時刻も変わらない", () => {
  const src = [{ w: "最高", start: 0.0, end: 0.3 }, { w: "速さ", start: 0.3, end: 0.6 }];
  const got = applyDictToWords(DICT, src);
  assert.strictEqual(got.length, 2, `語数が ${got.length} になった（融合している）: ${JSON.stringify(got)}`);
  assert.deepStrictEqual(got.map((w) => w.w), ["最高", "速さ"]);
  assert.strictEqual(got[0].start, 0.0);
  assert.strictEqual(got[1].end, 0.6);
});

t("AC-6: 語をまたいで分割された誤変換は、これまでどおり直る", () => {
  const src = [{ w: "心", start: 0, end: 0.2 }, { w: "筋高", start: 0.2, end: 0.4 },
    { w: "速です", start: 0.4, end: 0.8 }];
  const got = applyDictToWords(DICT, src);
  assert.ok(got.map((w) => w.w).join("").includes("梗塞"), `直っていない: ${JSON.stringify(got)}`);
});

// ── AC-5: 既存の登録の挙動が変わらない ───────────────────────────
t("AC-5: 既存3件と同型の語は、文脈なしのまま載る（挙動が変わらない）", () => {
  const c = "今日は追患版の話です。";
  const a = findSafeAnchor(c, c.indexOf("追患版"), "追患版", "椎間板");
  assert.ok(a.ok, `登録できなかった: ${a.reason}`);
  assert.strictEqual(a.key, "追患版", `文脈が足されてしまった: ${a.key}`);
  assert.strictEqual(a.anchored, false);
});

// ── AC-7: 助詞は、たとえ書き起こしに1回しか出なくても裸では載らない ────
// 「当たるのが1箇所」だけを条件にすると、短い書き起こしで助詞が1箇所になり素通りする
// （実装中に実際に素通りした）。長さの下限を併せて要求している。
// 素材にその助詞が含まれていないと、探す位置が見つからず「対象外」で素通りしてしまう
// （実際に「の」と「が」で空振り合格になっていた。2026-08-08）。
// 素材に含まれていること自体を先に確かめ、含まれていなければ落とす。
const PARTICLE_CORPUS = "今日の検査では心筋高速が見つかったので、腰を専門医に診てもらいます。";
for (const [word, to] of [["の", "ノ"], ["は", "ハ"], ["が", "ガ"], ["を", "ヲ"], ["に", "ニ"]]) {
  t(`AC-7: 「${word}」→「${to}」は裸では載らない（載るとしても文脈つき）`, () => {
    const i = PARTICLE_CORPUS.indexOf(word);
    assert.ok(i >= 0,
      `素材に「${word}」が含まれていないので、この検査は何も測っていない（素材を直すこと）`);
    const a = findSafeAnchor(PARTICLE_CORPUS, i, word, to);
    if (!a.ok) return;                       // 拒否されたなら当然合格
    assert.notStrictEqual(a.key, word, `裸の「${word}」が載ってしまった`);
    assert.ok(a.key.length >= MIN_KEY_LENGTH, `鍵が短すぎる: ${a.key}`);
  });
}

// ── 対照 ────────────────────────────────────────────────
// これが無いと、判定器そのものが効いていない場合も緑になる。

t("対照: 裸の「高速」を載せた辞書なら、AC-1 の判定は落ちる", () => {
  const naive = { 高速: "梗塞" };
  assert.strictEqual(applyDict(naive, "高速道路を走ります"), "梗塞道路を走ります",
    "裸で載せても壊れないなら、この検査は何も見ていない");
});

t("対照: 裸の「高速」を載せた辞書なら、AC-4 の判定も落ちる（2語が融合する）", () => {
  const naive = { 高速: "梗塞" };
  const got = applyDictToWords(naive, [
    { w: "最高", start: 0.0, end: 0.3 }, { w: "速さ", start: 0.3, end: 0.6 }]);
  assert.strictEqual(got.length, 1, "裸で載せても融合しないなら、この検査は何も見ていない");
});

t("対照: 4語だけを拒む実装では、この検査は通らない", () => {
  // 以前 C-4 の合格条件を満たしてしまった偽物を、そのまま再現して当てる。
  const denylist = new Set(["の", "は", "です", "ました"]);
  const judgedByFake = (b) => !denylist.has(b);
  assert.ok(judgedByFake("高速"), "偽物は「高速」を通す（前提の確認）");
  // 偽物は裸の「高速」を載せるので、AC-1 が落ちる
  assert.strictEqual(applyDict({ 高速: "梗塞" }, "高速道路を走ります"), "梗塞道路を走ります");
});

// ── 実際に辞書へ書くところまで通す ──────────────────────────────
t("辞書へ実際に追記され、既存の登録が1件も消えない", () => {
  const p = freshDict();
  const before = readDictionary(p);
  const r = appendAnchoredTerm("高速", "梗塞", CORPUS, AT, p);
  assert.ok(r.added, `追記されなかった: ${r.reason}`);
  const after = readDictionary(p);
  for (const k of Object.keys(before)) {
    assert.ok(Object.prototype.hasOwnProperty.call(after, k), `既存の登録が消えた: ${k}`);
    assert.strictEqual(after[k], before[k], `既存の値が変わった: ${k}`);
  }
  assert.ok(Object.prototype.hasOwnProperty.call(after, r.key), "新しい鍵が入っていない");
});

t("対照: 本物の用語辞書をこの検査が書き換えていない", () => {
  const real = readDictionary(DICT_PATH);
  for (const k of Object.keys(real)) {
    assert.ok(!k.includes("高速"), `本物の辞書が汚れている: ${k}`);
  }
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
