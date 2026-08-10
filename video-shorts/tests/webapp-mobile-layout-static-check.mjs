// モバイル幅(375px)での1カラム化の静的検証 — P2-5
//
// 375px幅での実際のレイアウト崩れの実測(要素の重なり等)は webapp-mockup/measure.mjs 系の
// Playwright実測（このpackage.jsonのnpm依存ゼロ方針の外にある playwright を要る）で行う
// （手動または playwright が使える環境で個別に実行する。tests/webapp-mobile-layout-check.mjs
// 参照）。このテストはそれを補う「依存ゼロで動く」静的な回帰ガードで、
//   (a) 狭い画面向けの @media (max-width: ...) 内で .two-col が1カラム
//       (grid-template-columns が単一トラック)になっていること
//   (b) DOM順が「設定(col-settings)→プレビュー(col-preview)」であること
//       （1カラムグリッドではDOM順がそのまま表示順になるため、これが崩れていないかを確認する）
// を機械的に確認する。
//
// ①偽物が壊れる/③壊したものを当てて落ちることの確認: 修正前のCSS相当（メディアクエリが
// 無い・2カラムのまま）を合成して同じ判定にかけると、正しく「1カラムになっていない」
// として検出できることを対照として示す。
//
// 実行: node tests/webapp-mobile-layout-static-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CSS_PATH = path.join(ROOT, "webapp-mockup", "styles.css");
const HTML_PATH = path.join(ROOT, "webapp-mockup", "index.html");

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

/** css本文から @media (max-width: Npx) ブロックの中身(本文全体)を抜き出す(最初の1つ) */
function extractMaxWidthMediaBody(css) {
  const idx = css.search(/@media\s*\(\s*max-width\s*:/);
  if (idx < 0) return null;
  // "{" から対応する "}" までを深さカウントで取り出す
  const open = css.indexOf("{", idx);
  if (open < 0) return null;
  let depth = 0, i = open;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return css.slice(open + 1, i);
}

/** 正規表現の特殊文字を全てエスケープする(CodeQL指摘: .# だけでは \ 等が漏れて壊れる)。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** mediaブロック本文の中から、指定セレクタの規則本文(宣言部分)を取り出す(単純ネスト対応) */
function findRuleBody(mediaBody, selectorName) {
  const re = new RegExp(`${escapeRegExp(selectorName)}\\s*\\{([^{}]*)\\}`);
  const m = mediaBody.match(re);
  return m ? m[1] : null;
}

/** grid-template-columns の値が単一トラック(=1カラム)かどうかを判定する。
 *  "1fr" や "minmax(0,1fr)" のような1トラックのみを1カラムとみなし、
 *  空白区切りで複数トラックが並ぶ("1.6fr 1fr" 等)場合はNGとする。 */
function isSingleColumn(gridTemplateColumnsValue) {
  const v = gridTemplateColumnsValue.trim();
  const tracks = v.split(/\s+(?![^(]*\))/); // "minmax(a, b)" の中の空白では割らない
  return tracks.length === 1;
}

t("②狭い画面向けmedia query内で .two-col が1カラム(grid-template-columns:1トラック)になっている", () => {
  const css = fs.readFileSync(CSS_PATH, "utf-8");
  const mediaBody = extractMaxWidthMediaBody(css);
  assert.ok(mediaBody, "@media (max-width: ...) ブロックが見つからない(モバイル対応が無い)");
  const twoColBody = findRuleBody(mediaBody, ".two-col");
  assert.ok(twoColBody, ".two-col の規則がmedia query内に無い");
  const m = twoColBody.match(/grid-template-columns\s*:\s*([^;]+);/);
  assert.ok(m, ".two-col に grid-template-columns の指定が無い(2カラムのまま=デフォルトを継承してしまう)");
  assert.ok(isSingleColumn(m[1]), `1カラムになっていない: grid-template-columns=${m[1]}`);
});

t("②DOM順が「設定(col-settings)→プレビュー(col-preview)」のままである(1カラムでの表示順の根拠)", () => {
  const html = fs.readFileSync(HTML_PATH, "utf-8");
  const settingsIdx = html.indexOf('id="col-settings"');
  const previewIdx = html.indexOf('id="col-preview"');
  assert.ok(settingsIdx >= 0 && previewIdx >= 0, "col-settings / col-preview が見つからない");
  assert.ok(settingsIdx < previewIdx, "DOM順が設定→プレビューになっていない(1カラム時にプレビューが先に出てしまう)");
});

// ── ①/③: 旧CSS相当(メディアクエリ無し=2カラムのまま)では検出できることの確認 ──
t("①対照: メディアクエリが無い旧CSS相当だと、1カラム化の判定に落ちる(=バグを再現できる)", () => {
  const brokenCss = `
    .two-col { display: grid; grid-template-columns: 1.6fr 1fr; }
  `; // 修正前: media query自体が無く、狭い画面でも2カラムのまま
  const mediaBody = extractMaxWidthMediaBody(brokenCss);
  assert.strictEqual(mediaBody, null, "対照のはずなのにmedia queryが見つかってしまった");
});

t("③この検査には検出能力がある: 2カラムのままのmedia queryを「1カラム」判定に通すと実際に落ちる", () => {
  const brokenCss = `
    @media (max-width: 640px) {
      .two-col { grid-template-columns: 1.6fr 1fr; }
    }
  `;
  const mediaBody = extractMaxWidthMediaBody(brokenCss);
  const twoColBody = findRuleBody(mediaBody, ".two-col");
  const m = twoColBody.match(/grid-template-columns\s*:\s*([^;]+);/);
  assert.throws(() => {
    assert.ok(isSingleColumn(m[1]), `1カラムになっていない: grid-template-columns=${m[1]}`);
  }, /1カラムになっていない/, "2カラムのままなのに「1カラム」判定を通ってしまった(検出できていない)");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
