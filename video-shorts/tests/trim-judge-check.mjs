// tests/trim-judge-check.mjs — G-EDIT-TRIM2 の AI 工程（src/trim-judge.mjs）
//
// 【この検査が見ているもの】AI が返した答えの扱い。3つに分けて見る。
//   (1) 正しく答えたとき、その答えが**実際に使われる**こと（＝呼んで捨てていない）
//   (2) 壊れた答えを**採用しない**こと（構文は正しいが中身が異常な返答）
//   (3) 返答そのものが読めないときは、黙って0件にせず**例外にする**こと
//
// (1) は basis-reviewer（2026-08-16）の指摘への対応。失敗経路の検査だけだと、
// AI を呼んで答えを捨て、これまでどおり固定16語と閾値で消す実装でも緑になる。
//
// (2) は「全部言い淀みです」と答えられたら動画が丸ごと消える、という故障モード。
//
// 実行: node tests/trim-judge-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildTrimPrompt,
  collectGapCandidates,
  loadTrimJudge,
  parseTrimResponse,
  trimJudgeStage,
  MAX_FILLER_RATIO,
  SILENCE_CANDIDATE_MIN_SEC,
  TRIM_JUDGE_FILE,
} from "../src/trim-judge.mjs";
import { planTrim } from "../src/trim-plan.mjs";

let pass = 0,
  fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n      ${e.stack || e.message}`);
  }
}

// 「あの資料」の指示語と、本物の言い淀みを1本に含む語の並び。
const WORDS = [
  { w: "えーと", start: 0.0, end: 1.2 },      // 0 本物の言い淀み
  { w: "今日は", start: 1.7, end: 2.5 },      // 1
  { w: "あの", start: 4.9, end: 5.3 },        // 2 指示語（消してはいけない）
  { w: "資料を", start: 5.3, end: 6.2 },      // 3
  { w: "見てください", start: 6.2, end: 7.4 }, // 4
  { w: "まとめます", start: 9.2, end: 10.5 },  // 5
];
const DURATION = 11.5;

function makeWorkDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-judge-"));
  fs.writeFileSync(path.join(dir, "transcript.json"), JSON.stringify({ words: WORDS }), "utf-8");
  return dir;
}

(async () => {
  /* ══════ 候補の拾い方 ══════ */
  await t("候補: 0.3秒より長い間だけを AI へ聞く（それ以下は詰めても減らない）", () => {
    const gaps = collectGapCandidates(WORDS);
    // 1.2→1.7 (0.5秒) / 2.5→4.9 (2.4秒) / 7.4→9.2 (1.8秒) の3つ。
    // 5.3→5.3 と 6.2→6.2 は0秒、SILENCE_CANDIDATE_MIN_SEC 以下なので候補外。
    assert.deepStrictEqual(gaps.map((g) => g.index), [0, 1, 4]);
    for (const g of gaps) {
      assert.ok(g.sec > SILENCE_CANDIDATE_MIN_SEC, `候補に ${g.sec}秒 の間が混ざっている`);
    }
  });

  await t("依頼文: 指示語と言い淀みの区別、会話の途中の沈黙を残すことを実際に求めている", () => {
    const p = buildTrimPrompt(WORDS, 0, collectGapCandidates(WORDS), "n0nce");
    // 語句の一致ではなく、区別すべき具体例が依頼文に入っているかを見る。
    assert.ok(p.includes("指示語"), "指示語という区別を依頼していない");
    assert.ok(p.includes("資料"), "指示語の具体例が入っていない");
    assert.ok(p.includes("待っている") || p.includes("返事待ち"), "待つ沈黙の例が入っていない");
    assert.ok(p.includes("n0nce"), "乱数タグで囲んでいない（文字起こしから抜け出せる）");
  });

  /* ══════ (1) 正しい答えが実際に使われる ══════ */
  await t("正答: AI が『0は言い淀み・2は違う』と答えると、そのとおりに効く", async () => {
    const dir = makeWorkDir();
    const runModel = async () => JSON.stringify({ fillers: [0], cutGaps: [1] });
    const r = await trimJudgeStage({ workDir: dir, runModel });
    assert.strictEqual(r.fillers, 1, `言い淀みが ${r.fillers} 件（期待 1）`);
    assert.strictEqual(r.cutGaps, 1, `詰める間が ${r.cutGaps} 件（期待 1）`);

    const judge = loadTrimJudge(dir, WORDS);
    assert.ok(judge, "判定表が読めない");
    const plan = planTrim(WORDS, { duration: DURATION, cutSilence: true, cutFillers: true, judge });
    const kept = (a, b) =>
      plan.keep.reduce((acc, k) => acc + Math.max(0, Math.min(k.end, b) - Math.max(k.start, a)), 0);
    // 「えーと」(0.0-1.2) は消える
    assert.ok(kept(0.0, 1.2) <= 0.05, "AI が言い淀みと答えた語が消えていない");
    // 指示語の「あの」(4.9-5.3) は残る（固定16語に載っているのに消えない＝一覧が決定権を持たない）
    assert.ok(Math.abs(kept(4.9, 5.3) - 0.4) <= 0.05, "AI が違うと答えた指示語が消えている");
    // AI が挙げなかった間 (7.4-9.2) はそのまま残る
    assert.ok(Math.abs(kept(7.4, 9.2) - 1.8) <= 0.05, "AI が挙げていない間まで詰まっている");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t("正答 対照: AI が何も挙げなければ、1秒も詰まらない（答えを無視していない）", async () => {
    const dir = makeWorkDir();
    const runModel = async () => JSON.stringify({ fillers: [], cutGaps: [] });
    await trimJudgeStage({ workDir: dir, runModel });
    const judge = loadTrimJudge(dir, WORDS);
    const plan = planTrim(WORDS, { duration: DURATION, cutSilence: true, cutFillers: true, judge });
    assert.ok(
      Math.abs(plan.keptSeconds - DURATION) <= 0.05,
      `残り=${plan.keptSeconds}（期待 ${DURATION}）。AI の答えを無視して規則で消している疑い`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* ══════ (2) 壊れた答えを採用しない ══════ */
  await t("壊れた答え: 見せていない添字は採用しない（見せてもいない語を消させない）", () => {
    const r = parseTrimResponse(
      JSON.stringify({ fillers: [0, 999], cutGaps: [0, 7] }),
      { offset: 0, length: 6 },
      [0, 1, 4],
    );
    assert.deepStrictEqual(r.fillers, [0]);
    assert.deepStrictEqual(r.cutGaps, [0]);
    assert.ok(r.dropped.length >= 2, `捨てた記録が残っていない: ${JSON.stringify(r.dropped)}`);
  });

  await t("壊れた答え: 同じ添字が2回来たら2つ目を捨てる", () => {
    const r = parseTrimResponse(
      JSON.stringify({ fillers: [0, 0], cutGaps: [] }),
      { offset: 0, length: 6 },
      [0, 1, 4],
    );
    assert.deepStrictEqual(r.fillers, [0]);
  });

  await t("壊れた答え: 整数でない値は捨てる", () => {
    const r = parseTrimResponse(
      JSON.stringify({ fillers: [1.5, "0", null], cutGaps: [] }),
      { offset: 0, length: 6 },
      [0, 1, 4],
    );
    assert.deepStrictEqual(r.fillers, []);
  });

  await t("壊れた答え: 半分より多くを言い淀みだと言われたら、そのかたまりの言い淀みを全部捨てる", () => {
    // これを採用すると、話している中身ごと消えて動画が壊れる。
    const r = parseTrimResponse(
      JSON.stringify({ fillers: [0, 1, 2, 3], cutGaps: [1] }),
      { offset: 0, length: 6 },
      [0, 1, 4],
    );
    assert.deepStrictEqual(r.fillers, [], `${MAX_FILLER_RATIO * 100}% 超を採用してしまっている`);
    // 間の判断だけは巻き添えにしない（言い淀みの異常と間の判断は別）
    assert.deepStrictEqual(r.cutGaps, [1]);
  });

  await t("壊れた答え 対照: 半分ちょうどまでは採用する（境界）", () => {
    const r = parseTrimResponse(
      JSON.stringify({ fillers: [0, 1, 2], cutGaps: [] }),
      { offset: 0, length: 6 },
      [0, 1, 4],
    );
    assert.deepStrictEqual(r.fillers, [0, 1, 2], "境界ちょうどを捨ててしまっている");
  });

  /* ══════ (3) 読めない返答は例外 ══════ */
  await t("読めない返答: JSON でなければ例外（黙って0件にしない）", () => {
    assert.throws(() => parseTrimResponse("直す所はありません", { offset: 0, length: 6 }, []), /JSON/);
  });

  await t("読めない返答: 配列が無ければ例外", () => {
    assert.throws(
      () => parseTrimResponse(JSON.stringify({ fillers: [] }), { offset: 0, length: 6 }, []),
      /配列/,
    );
  });

  await t("読めない返答: 工程ごと失敗する（判断が取れないまま先へ進まない）", async () => {
    const dir = makeWorkDir();
    let threw = false;
    try {
      await trimJudgeStage({ workDir: dir, runModel: async () => "こわれた返事" });
    } catch (_) {
      threw = true;
    }
    assert.ok(threw, "読めない返答なのに工程が成功した");
    assert.ok(
      !fs.existsSync(path.join(dir, TRIM_JUDGE_FILE)),
      "判断が取れていないのに判定表を書いている",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t("読めない返答: モデルが起動できないときも工程ごと失敗する", async () => {
    const dir = makeWorkDir();
    let threw = false;
    try {
      await trimJudgeStage({
        workDir: dir,
        runModel: async () => { throw new Error("claude が見つかりません"); },
      });
    } catch (e) {
      threw = /claude/.test(e.message);
    }
    assert.ok(threw, "モデルの起動失敗が工程の失敗になっていない");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t("判定表が無いときは null を返す（呼び元が『判断が取れなかった』と分かる）", () => {
    const dir = makeWorkDir();
    assert.strictEqual(loadTrimJudge(dir, WORDS), null);
    fs.writeFileSync(path.join(dir, TRIM_JUDGE_FILE), "{壊れたJSON", "utf-8");
    assert.strictEqual(loadTrimJudge(dir, WORDS), null, "壊れた判定表を読めたことにしている");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`\n合計: PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
