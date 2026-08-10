// ASS字幕タイムスタンプの centisecond 繰り上げの検証 — P2-3
//
// 旧実装は h/m/s を先に切り捨ててから centisecond を別途 round していたため、
// 99センチ秒台(例: 59.996秒)を四捨五入すると centisecond が 100 になり、
// `0:00:59.100` のような ASS として不正な（3桁centisecondの）時刻文字列を吐いていた。
// 本来 59.996秒は次の1分00秒0.00秒に繰り上がるべきで、直さないと字幕の表示タイミングがずれる。
//
// ①偽物が壊れる/③壊したものを当てて落ちることの確認: 旧実装を再現した関数を同じ境界値に
// かけると、実際に不正な3桁センチ秒(または繰り上がらない時刻)を吐くことを対照として示す。
// ②正しい実装の値を測る: 直した assTime()、および buildAss() が生成する ASS 本文の
// Dialogue 行を、99センチ秒台をまたぐ境界値で実測し、正しく繰り上がることを確認する。
//
// 実行: node tests/srt-builder-timestamp-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import { assTime, buildAss } from "../src/srt-builder.mjs";

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n      ${e.stack || e.message}`);
  }
}

// 旧実装の再現（P2-3修正前の assTime と同型）。対照用。
function naiveAssTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/** ASS 時刻文字列が h:mm:ss.cc の形式として正しいか（centisecondが常に2桁=0〜99）を検査する */
function isWellFormedAssTime(str) {
  const m = str.match(/^(\d+):([0-5]\d):([0-5]\d)\.(\d{2})$/);
  if (!m) return false;
  return Number(m[4]) <= 99;
}

// ── ②: 修正後の assTime() を境界値で実測 ──────────────────────────
const BOUNDARY_CASES = [
  { sec: 59.994, expect: "0:00:59.99" },   // 99.4 → round(99.4)=99（繰り上がらない側の境界）
  { sec: 59.995, expect: "0:01:00.00" },   // 5999.5cs → round(5999.5)=6000cs → 1分ちょうど
  { sec: 59.996, expect: "0:01:00.00" },   // 5999.6cs → round=6000cs → 1分ちょうど
  { sec: 0.995, expect: "0:00:01.00" },    // 秒の桁への繰り上げ
  { sec: 1.995, expect: "0:00:02.00" },    // 同上・別の秒での再現性確認
  { sec: 119.996, expect: "0:02:00.00" },  // 分の桁への繰り上げ（1:59.996 → 2:00.00）
  { sec: 3599.996, expect: "1:00:00.00" }, // 時の桁への繰り上げ（59:59.996 → 1:00:00.00）
];

for (const { sec, expect } of BOUNDARY_CASES) {
  t(`②assTime(${sec}) は "${expect}" に正しく繰り上がる`, () => {
    const got = assTime(sec);
    assert.strictEqual(got, expect);
    assert.ok(isWellFormedAssTime(got), `不正な形式のASS時刻: ${got}`);
  });
}

t("②assTime: centisecondは常に2桁(0〜99)で、3桁になることはない(広く境界を走査)", () => {
  // 0.000〜3.000秒を1ミリ秒刻みで総当たりし、centisecondが3桁化する値が無いことを確認する
  // (99センチ秒台の境界だけでなく、丸め誤差が起きうる周辺も含めて広く網羅する)。
  for (let ms = 0; ms <= 3000; ms++) {
    const got = assTime(ms / 1000);
    assert.ok(isWellFormedAssTime(got), `sec=${ms / 1000} で不正な形式: ${got}`);
  }
});

// ── ②: buildAss() が生成する Dialogue 行でも実測（本文の書式で確かめる） ──
t("②buildAss: 59.996秒をまたぐ区間で、生成されたDialogue行のEndが1:00:00.00に正しく繰り上がる", () => {
  const relWords = [{ w: "テスト", start: 59.5, end: 59.996 }];
  const ass = buildAss(relWords, "", 59.996, { style: "line" });
  const dialogueLines = ass.split("\n").filter((l) => l.startsWith("Dialogue:") && l.includes("Caption"));
  assert.ok(dialogueLines.length >= 1, "Dialogue行が生成されていない");
  for (const line of dialogueLines) {
    const times = line.match(/,(\d+:\d{2}:\d{2}\.\d+),(\d+:\d{2}:\d{2}\.\d+),/);
    assert.ok(times, `時刻部分を取り出せない: ${line}`);
    assert.ok(isWellFormedAssTime(times[1]), `Start が不正: ${times[1]} (${line})`);
    assert.ok(isWellFormedAssTime(times[2]), `End が不正: ${times[2]} (${line})`);
  }
  // End は duration(59.996) 由来 → 0:01:00.00 に繰り上がっているはず
  assert.ok(dialogueLines.some((l) => l.includes(",0:01:00.00,")), `Endが繰り上がっていない: ${dialogueLines.join(" | ")}`);
});

// ── ①/③: 旧実装(naiveAssTime)を同じ境界値に当てると壊れる ─────────────
t("①対照: 旧実装は59.996秒で3桁のcentisecond(.100)という不正な時刻を吐く", () => {
  const got = naiveAssTime(59.996);
  assert.strictEqual(got, "0:00:59.100", "対照のはずなのに旧実装のバグが再現されていない");
  assert.strictEqual(isWellFormedAssTime(got), false, "対照のはずなのに不正形式として検出されなかった");
});

t("③この検査には検出能力がある: 旧実装を「正しい繰り上げ」の判定に通すと実際に落ちる", () => {
  assert.throws(() => {
    assert.strictEqual(naiveAssTime(59.996), "0:01:00.00");
  }, /.*/, "旧実装のバグが「正しい繰り上げ」判定をすり抜けてしまった(検出できていない)");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
