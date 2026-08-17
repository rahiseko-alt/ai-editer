// buildRenderArgs() の argv 組み立て検証 — G-EDIT-UI-SETTINGS-WIRING-SERVER
//
// server/pipeline-runner.mjs の render argv 組み立て（旧: renderArgs.push(...)を呼び出し側に
// 1つずつ並べる書き方）は、設定を1つ足すたびに結線を忘れる事故を過去2回起こしている
// （顔モザイク・つなぎ目の間。docs/failures.md 2026-08-14）。buildRenderArgs() へ集約したので、
// ここでは戻り値のargv配列を直接実測する（ソース文字列の正規表現照合は禁止。CodeRabbitが
// 実際に指摘した弱点そのものであるため）。
//
// 実行: node tests/build-render-args-check.mjs   (全PASSで exit 0)

import assert from "node:assert";

import { buildRenderArgs } from "../server/pipeline-runner.mjs";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.message}`); }
}

const PIPELINE = "/tmp/pipeline.mjs";
const WORKDIR = "/tmp/work/job1";

/** argv内に「フラグ + その直後の値」が実在することを、配列の中身で確認する。 */
function assertFlagValue(argv, flag, value, label) {
  const i = argv.indexOf(flag);
  assert.ok(i !== -1, `${label}: argv に ${flag} が無い（argv=${JSON.stringify(argv)}）`);
  assert.strictEqual(argv[i + 1], value, `${label}: ${flag} の値が違う（argv=${JSON.stringify(argv)}）`);
}

/** argv内にフラグが一切現れないことを確認する。 */
function assertNoFlag(argv, flag, label) {
  assert.ok(!argv.includes(flag), `${label}: 渡していないのに argv に ${flag} が入っている（argv=${JSON.stringify(argv)}）`);
}

// ── 基本形（pipelinePath/workDir/render/mode がそのまま入ること） ──
t("基本形: pipelinePath・render・workDir・--mode が先頭に並ぶ（既定はtopicモード）", () => {
  const argv = buildRenderArgs(PIPELINE, WORKDIR, {});
  assert.deepStrictEqual(argv.slice(0, 5), [PIPELINE, "render", WORKDIR, "--mode", "topic"]);
});

t("基本形: cut=minutes なら --mode digest になる", () => {
  const argv = buildRenderArgs(PIPELINE, WORKDIR, { cut: "minutes" });
  assertFlagValue(argv, "--mode", "digest", "mode");
});

// ── 退行検知: 既存の --mode/--no-sub/--breath が引き続き正しく組まれること ──
t("退行検知: sub=none なら --no-sub が付く", () => {
  const argv = buildRenderArgs(PIPELINE, WORKDIR, { sub: "none" });
  assert.ok(argv.includes("--no-sub"), `--no-sub が入っていない（argv=${JSON.stringify(argv)}）`);
});

t("退行検知: sub を渡さない/on なら --no-sub は付かない", () => {
  assertNoFlag(buildRenderArgs(PIPELINE, WORKDIR, {}), "--no-sub", "sub未指定");
  assertNoFlag(buildRenderArgs(PIPELINE, WORKDIR, { sub: "on" }), "--no-sub", "sub=on");
});

t("退行検知: opts.breath があれば --breath <値> が付く", () => {
  const argv = buildRenderArgs(PIPELINE, WORKDIR, { breath: "0.4" });
  assertFlagValue(argv, "--breath", "0.4", "breath");
});

t("退行検知: opts.breath が無ければ --breath は付かない", () => {
  assertNoFlag(buildRenderArgs(PIPELINE, WORKDIR, {}), "--breath", "breath未指定");
});

// ── 新設定8件: それぞれ渡したときに対応するフラグが実在すること ──
const NEW_FLAG_CASES = [
  ["subStyle", "--sub-style", "bold"],
  ["captionFont", "--caption-font", "mincho"],
  ["captionFill", "--caption-fill", "#FF0000"],
  ["captionOutlineColor", "--caption-outline-color", "#000000"],
  ["captionInner", "--caption-inner", "on"],
  ["captionBand", "--caption-band", "on"],
  ["exportPreset", "--export", "hq"],
  ["durationMin", "--duration-min", "3"],
];

for (const [key, flag, value] of NEW_FLAG_CASES) {
  t(`新設定: opts.${key}="${value}" を渡すと argv に ${flag} ${value} が実在する`, () => {
    const argv = buildRenderArgs(PIPELINE, WORKDIR, { [key]: value });
    assertFlagValue(argv, flag, value, key);
  });

  t(`新設定: opts.${key} を渡さなければ argv に ${flag} は一切現れない`, () => {
    const argv = buildRenderArgs(PIPELINE, WORKDIR, {});
    assertNoFlag(argv, flag, key);
  });
}

// ── 全部乗せ: 8件すべてを同時に渡しても、それぞれ独立して欠けずに入ること ──
t("全部乗せ: 新設定8件を同時に渡すと、8個すべてのフラグが1回ずつ実在する", () => {
  const opts = {};
  for (const [key, , value] of NEW_FLAG_CASES) opts[key] = value;
  const argv = buildRenderArgs(PIPELINE, WORKDIR, opts);
  for (const [key, flag, value] of NEW_FLAG_CASES) {
    assertFlagValue(argv, flag, value, key);
    // フラグは1回だけ現れること（二重pushや取り違えの検出）。
    const occurrences = argv.filter((a) => a === flag).length;
    assert.strictEqual(occurrences, 1, `${flag} が ${occurrences} 回現れている（1回のはず）`);
  }
});

// ── 空文字列・undefinedは既存 --breath と同じ作法で付けない ──
t("空文字列を渡した新設定は付かない（既存--breathと同じ『truthyのときだけpush』の作法）", () => {
  const opts = {};
  for (const [key] of NEW_FLAG_CASES) opts[key] = "";
  const argv = buildRenderArgs(PIPELINE, WORKDIR, opts);
  for (const [key, flag] of NEW_FLAG_CASES) {
    assertNoFlag(argv, flag, `${key}=""`);
  }
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
