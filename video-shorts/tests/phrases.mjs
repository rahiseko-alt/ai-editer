// 文字種をまたがない分断の禁止（docs/caption-plan.md 案1）のテスト。
import assert from "node:assert/strict";
import { groupIntoPhrases, mergeSameScriptBoundaries } from "../src/script/phrases.mjs";

// 単体：カタカナ・数字・英字の途中の境界は消え、それ以外は残る
assert.deepEqual(mergeSameScriptBoundaries(["ショー", "ト動画化です。"]), ["ショート動画化です。"]);
assert.deepEqual(mergeSameScriptBoundaries(["話題ごとの", "ショー", "ト", "動画"]), ["話題ごとの", "ショート", "動画"]);
assert.deepEqual(mergeSameScriptBoundaries(["本番いきます32", "1動画の"]), ["本番いきます321動画の"]);
assert.deepEqual(mergeSameScriptBoundaries(["AI", "tool"]), ["AItool"]);
assert.deepEqual(mergeSameScriptBoundaries(["私は", "動画を"]), ["私は", "動画を"]); // 対照：結合しない

// 統合：語単位の入力で、時刻が壊れず1塊に収まる
const words = [
  ["話題ごとの", 0, 1], ["ショー", 1, 1.5], ["ト", 1.5, 1.7], ["動画化です", 1.7, 2.5],
].map(([w, start, end]) => ({ w, start, end }));
const units = groupIntoPhrases(words);
const joined = units.map((u) => u.w).join("");
assert.equal(joined, "話題ごとのショート動画化です");
assert.ok(units.some((u) => u.w.includes("ショート")), "ショートが1塊に入る");
for (const u of units) assert.ok(u.end > u.start);
console.log("phrases: OK");
