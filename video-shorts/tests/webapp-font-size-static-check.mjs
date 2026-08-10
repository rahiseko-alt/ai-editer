// 最小フォントサイズの静的検証 — P2-6
//
// webapp-mockup/ は npm 依存ゼロのプレーンJS/CSSで、ブラウザを起動する実測(Playwright)は
// webapp-mockup/measure.mjs（#13 最小フォント>=13px を含む15項目）が担う。ただし
// measure.mjs はこのpackage.json（npm依存ゼロ方針）には無い外部パッケージ playwright に
// 依存するため、日常のCI(pnpm -r test)には組み込めない（手動または playwright が使える
// 環境で個別に実行する）。このテストはそれを補う「依存ゼロで動く」静的な回帰ガードで、
// CSSファイルに書かれている font-size 宣言を直接パースし、装飾用の除外(step-n/step-star＝
// measure.mjsの除外基準と同じ)を除いて、保証される最小値(clamp()なら最小境界)が
// 13px未満のものが無いことを機械的に確認する。
//
// ①偽物が壊れる/③壊したものを当てて落ちることの確認: このパーサ自身に、P2-6修正前の
// 実際の値(11px/11.52px等)を含む合成CSSを与えると検出できることを対照として示す。
// ②正しい実装の値を測る: 実ファイル(webapp-mockup/*.css)を対象に実行し、最小値を実測する。
//
// 実行: node tests/webapp-font-size-static-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CSS_DIR = path.join(ROOT, "webapp-mockup");
const CSS_FILES = ["styles.css", "styles-cards.css", "styles-overlay.css", "styles-editing.css"];

// 装飾用のバッジ数字・星（aria-hidden="true"）は measure.mjs の #13 判定でも除外している
// ("el.closest('.step-n') || el.closest('.step-star')")。同じ基準をここでも使う。
const EXCLUDED_SELECTOR_PATTERNS = [".step-n", ".step-star"];

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

/** CSSのブロックコメントを除去する（このCSS群には文字列リテラル中に紛らわしい記号は無い前提の単純除去） */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 深さスタックでCSSを走査し、リーフ規則（@media/@keyframes等のラッパー自体は除く）の
 * {selector, body} 一覧を返す。ネストしていても内側の規則を正しく取り出せる。
 */
function parseCssRules(css) {
  const rules = [];
  const selectorStack = [];
  let buf = "";
  for (const c of stripCssComments(css)) {
    if (c === "{") {
      selectorStack.push(buf.trim());
      buf = "";
    } else if (c === "}") {
      const body = buf;
      const selector = selectorStack.pop() ?? "";
      if (selector && !selector.startsWith("@")) rules.push({ selector, body });
      buf = "";
    } else {
      buf += c;
    }
  }
  return rules;
}

/** font-size の値文字列から「保証される最小px」を求める。inherit/未指定はnull。 */
function minGuaranteedPx(value) {
  const v = value.trim();
  const clampMatch = v.match(/clamp\(\s*([^,]+)\s*,/);
  const target = clampMatch ? clampMatch[1].trim() : v;
  if (target === "inherit" || target === "") return null;
  const pxMatch = target.match(/^(-?[\d.]+)px$/);
  if (pxMatch) return Number(pxMatch[1]);
  const remMatch = target.match(/^(-?[\d.]+)rem$/);
  if (remMatch) return Number(remMatch[1]) * 16; // ルート既定16px前提
  return null; // vw等、絶対下限が定まらない単位は対象外（このCSS群には無い）
}

function isExcluded(selector) {
  return EXCLUDED_SELECTOR_PATTERNS.some((p) => selector.includes(p));
}

/** rules から font-size 宣言だけを集め、{selector, valuePx} の配列にする(除外セレクタは飛ばす) */
function collectFontSizes(rules) {
  const out = [];
  for (const { selector, body } of rules) {
    if (isExcluded(selector)) continue;
    const m = body.match(/font-size\s*:\s*([^;]+);?/);
    if (!m) continue;
    const px = minGuaranteedPx(m[1]);
    if (px === null) continue;
    out.push({ selector, px });
  }
  return out;
}

// ── ②: 実ファイルを実測 ────────────────────────────────────
t("②webapp-mockup/*.css 全体で、保証される最小フォントサイズが13px以上である", () => {
  let allSizes = [];
  for (const file of CSS_FILES) {
    const css = fs.readFileSync(path.join(CSS_DIR, file), "utf-8");
    const rules = parseCssRules(css);
    const sizes = collectFontSizes(rules).map((s) => ({ ...s, file }));
    allSizes = allSizes.concat(sizes);
  }
  assert.ok(allSizes.length > 10, `font-size宣言が想定より少ない(パースの不備を疑う): ${allSizes.length}件`);
  const min = Math.min(...allSizes.map((s) => s.px));
  const offenders = allSizes.filter((s) => s.px < 13);
  assert.strictEqual(
    offenders.length, 0,
    `13px未満のfont-sizeが${offenders.length}件: ${offenders.map((o) => `${o.file} ${o.selector}=${o.px}px`).join(", ")} (min=${min}px)`
  );
});

// ── ①/③: 修正前相当の値を含む合成CSSでは検出できることの確認 ──────
t("①対照: 修正前相当(11px/11.52px)を含む合成CSSを与えると、パーサが正しく13px未満として検出する", () => {
  const brokenCss = `
    .caption-word .caption-orig { font-size: 11px; color: #777; }
    .editing-eta { color: var(--muted); font-size: .72rem; margin: 3px 0 0; }
    .step-n { font-size: 10px; } /* 装飾は除外対象のまま */
  `;
  const rules = parseCssRules(brokenCss);
  const sizes = collectFontSizes(rules);
  // step-n は除外されるので2件だけ残るはず
  assert.strictEqual(sizes.length, 2, `除外ロジックが効いていない: ${JSON.stringify(sizes)}`);
  const offenders = sizes.filter((s) => s.px < 13);
  assert.strictEqual(offenders.length, 2, "対照のはずなのに13px未満として検出されなかった");
});

t("③この検査には検出能力がある: 対照の合成CSSを「全て13px以上」判定に通すと実際に落ちる", () => {
  const brokenCss = `.caption-word .caption-orig { font-size: 11px; }`;
  const rules = parseCssRules(brokenCss);
  const sizes = collectFontSizes(rules);
  assert.throws(() => {
    const offenders = sizes.filter((s) => s.px < 13);
    assert.strictEqual(offenders.length, 0, "13px未満のfont-sizeがある");
  }, /13px未満のfont-sizeがある/, "13px未満の値が「全て13px以上」判定を通ってしまった(検出できていない)");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
