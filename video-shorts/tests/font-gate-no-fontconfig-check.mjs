// tests/font-gate-no-fontconfig-check.mjs
//
// 字幕ありのジョブが始まる前に通る「フォントの関門」が、fontconfig(fc-list) が無い環境でも
// 通ることを確かめる。
//
// 【2026-08-15 の実害】マスターの手元 Windows で「字幕あり」を選ぶと必ず失敗していた。
// 画面には次の理由が出ていた:
//   「fc-list（fontconfig）が見つからないため、フォントの有無を確認できません。」
// 原因は関門が checkFontAvailable(DEFAULT_FONT="IPAGothic") を見ていたことで、これは
//   (a) fc-list(fontconfig) を必要とし、Windows には無いので原理的に成立しない
//   (b) そもそも実際に焼かれるのは同梱フォント（resolveCaptionStyle が DEFAULT_FONT_KEY="kaku"
//       へ解決し、render-vertical が fontsdir=src/fonts を渡す）で、IPAGothic は使われない
// という二重の誤りだった。**使わないフォントを、無いツールで確認していた。**
//
// 【この検査の作り】fontconfig が無い状況を PATH を空にして作る。
//   ・新しい関門(checkBundledFont) … PATH が空でも通る（外部コマンドを使わないため）
//   ・旧い関門(checkFontAvailable) … PATH が空だと落ちる（対照。旧実装なら Windows で
//     必ず落ちたことの再現であり、この検査が「効いているとき効いていると言える」証拠）
// あわせて、製品コードの関門が実際に新しい方を使っていることをソースで確認する。
//
// 実行: node tests/font-gate-no-fontconfig-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkBundledFont, checkFontAvailable } from "../src/font-check.mjs";
import { DEFAULT_FONT_KEY } from "../src/subtitle-styles.mjs";
import { DEFAULT_FONT } from "../src/srt-builder.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

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

/** PATH を空にして fn を実行する（fontconfig が無い環境の再現）。必ず元へ戻す。 */
function withoutPath(fn) {
  const saved = process.env.PATH;
  try {
    process.env.PATH = "";
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

t("新しい関門: fontconfig が無くても、同梱フォントの確認は通る", () => {
  const r = withoutPath(() => checkBundledFont(DEFAULT_FONT_KEY));
  assert.strictEqual(r.ok, true, `既定書体(${DEFAULT_FONT_KEY})の確認が通らない: ${r.reason}`);
});

t("新しい関門: 同梱している5書体すべてが、fontconfig 無しで確認できる", () => {
  for (const key of ["kaku", "maru", "mincho", "hand", "marker"]) {
    const r = withoutPath(() => checkBundledFont(key));
    assert.strictEqual(r.ok, true, `書体 ${key} の確認が通らない: ${r.reason}`);
  }
});

t("対照: 旧い関門は fontconfig が無いと落ちる（Windows で常に失敗していた再現）", () => {
  const r = withoutPath(() => checkFontAvailable(DEFAULT_FONT));
  assert.strictEqual(r.ok, false, "旧い関門が落ちない（対照が成立していない）");
  assert.ok(
    r.reason.includes("fc-list") || r.reason.includes("fontconfig"),
    `落ちた理由が fontconfig 由来でない: ${r.reason}`,
  );
});

t("対照: 存在しない書体キーは、新しい関門でも落ちる（無条件に通してはいない）", () => {
  const r = withoutPath(() => checkBundledFont("__NO_SUCH_FONT_KEY__"));
  assert.strictEqual(r.ok, false, "存在しない書体キーを通してしまっている");
});

t("製品の関門が、実際に同梱フォント検査を使っている（画面経路・CLI経路の両方）", () => {
  for (const rel of ["server/pipeline-runner.mjs", "pipeline.mjs"]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf-8");
    assert.ok(
      src.includes("checkBundledFont("),
      `${rel} が checkBundledFont を呼んでいない`,
    );
    // 呼び出しの有無はコメント本文にも一致してしまうため、import されているかで見る
    // （import していない関数は呼べない。コメントで言及するのは自由）。
    const importsOld = /import\s*\{[^}]*\bcheckFontAvailable\b[^}]*\}\s*from\s*["'][^"']*font-check\.mjs["']/.test(src);
    assert.ok(
      !importsOld,
      `${rel} が fc-list 依存の checkFontAvailable を import している（Windows で必ず落ちる）`,
    );
  }
});

console.log(`\n合計: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
