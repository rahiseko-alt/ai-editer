// tests/recaption-style-persist-check.mjs — G-CAP-FIT-RECAPTION
//
// 【何を見るか】画面（や CLI）で選んだ字幕の見た目が、「字幕を直して焼き直す」を押したあとも
// そのまま残ること。
//
// 【なぜ要るか】2026-08-16 の basis-reviewer 指摘。焼き直しの実装 src/recaption-stage.mjs は
// `state.subStyle` を読んでいたが、state を作る pipeline.mjs はそんなフィールドを書いていない
// （常に undefined）。そのため書体を「明朝体」にして作った動画でも、焼き直した瞬間に既定の
// 角ゴシックへ戻っていた。取りこぼしを構造的に防ぐため、pipeline.mjs は「実際に buildAss へ
// 渡した値」そのものを state.captionStyle として残し、焼き直しはそれを読む。
//
// 【測り方】焼き直しが実際に書き出した .ass の Style 行（＝ffmpeg が読む当のもの）を読む。
// 「state に書いてあるか」ではなく「焼く直前の値がどうなったか」で見る。
//
// 実行: node tests/recaption-style-persist-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { recaptionStage } from "../src/recaption-stage.mjs";
import { resolveCaptionStyle, FONT_CATALOG } from "../src/subtitle-styles.mjs";

let pass = 0,
  fail = 0;
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

function hasFfmpeg() {
  return spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" }).status === 0;
}
if (!hasFfmpeg()) {
  console.error("ffmpeg が見つかりません。この検査は実際に焼き直すため ffmpeg が必要です。");
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-recap-style-"));

/** 焼き直しに必要な最小の材料（素材動画・state.json・transcript.json・candidates.json）を作る。 */
function makeJob(captionStyle) {
  const dir = fs.mkdtempSync(path.join(tmp, "job-"));
  const workDir = path.join(dir, "work");
  const outDir = path.join(dir, "out");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const input = path.join(dir, "input.mp4");
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-f", "lavfi", "-i", "color=size=640x360:color=black:d=3",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-shortest",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", input],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error("素材の合成に失敗: " + r.stderr);

  const state = { id: "t", input, stage: "render", sub: "on", orient: "portrait" };
  if (captionStyle !== undefined) state.captionStyle = captionStyle;
  fs.writeFileSync(path.join(workDir, "state.json"), JSON.stringify(state), "utf-8");
  fs.writeFileSync(
    path.join(workDir, "transcript.json"),
    JSON.stringify({
      language: "ja",
      duration: 3,
      words: [
        { w: "今日は", start: 0, end: 1 },
        { w: "動画の", start: 1, end: 2 },
        { w: "話です", start: 2, end: 3 },
      ],
      segments: [{ start: 0, end: 3, text: "今日は動画の話です" }],
    }),
    "utf-8",
  );
  // 焼き直しは既存クリップを差し替えるので、置き換え先のダミーを置いておく。
  fs.writeFileSync(path.join(outDir, "clip-1.mp4"), "dummy", "utf-8");
  fs.writeFileSync(
    path.join(outDir, "candidates.json"),
    JSON.stringify({
      id: "t",
      srcW: 640,
      srcH: 360,
      candidates: [{ file: "clip-1.mp4", start: 0, end: 3, hook: "", duration: 3 }],
    }),
    "utf-8",
  );
  return { workDir, outDir };
}

/** 焼き直しを実行し、書き出された .ass の Caption の Style 行を読む。 */
async function recaptionStyleLine(captionStyle) {
  const { workDir, outDir } = makeJob(captionStyle);
  await recaptionStage({ workDir, outDir, onLog: () => {} });
  const assPath = path.join(workDir, "recaption-1.ass");
  assert.ok(fs.existsSync(assPath), "焼き直しの .ass が作られていない");
  const line = fs
    .readFileSync(assPath, "utf-8")
    .split("\n")
    .find((l) => l.startsWith("Style: Caption,"));
  assert.ok(line, "Caption の Style 行が無い");
  const f = line.slice("Style: Caption,".length).split(",");
  return { family: f[0], fontSize: Number(f[1]) };
}

const MINCHO = resolveCaptionStyle("karaoke", { fontKey: "mincho" });

const results = [];
try {
  results.push(["選んだ書体", await recaptionStyleLine(MINCHO)]);
  results.push(["state に何も無い場合", await recaptionStyleLine(undefined)]);
} catch (e) {
  console.log(`FAIL 焼き直しの実行に失敗: ${e.stack || e.message}`);
  fail++;
}

if (results.length === 2) {
  const [[, chosen], [, fallback]] = results;

  t("RECAPTION: 焼き直しても、選んだ書体（明朝体）のまま焼かれる", () => {
    console.log(`  [実測] 焼き直しの Style 行: ${JSON.stringify(chosen)}`);
    assert.strictEqual(
      chosen.family,
      FONT_CATALOG.mincho.family,
      `焼き直しで書体が変わっている（既定へ戻っている）: ${chosen.family}`,
    );
  });

  t("RECAPTION 対照: state に見た目が残っていないと、既定の書体で焼かれる", () => {
    // 直す前の実装は常にこちら（state.subStyle が undefined）だった。
    // 対照が「選んだ書体」と違う値を出すことで、この検査に見分ける力があることを示す。
    console.log(`  [実測] 何も残っていない場合: ${JSON.stringify(fallback)}`);
    assert.strictEqual(fallback.family, FONT_CATALOG.kaku.family, `既定の書体になっていない`);
    assert.notStrictEqual(
      fallback.family,
      chosen.family,
      "選んだ書体と既定の書体が同じ値で、見分けられていない",
    );
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n合計: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
