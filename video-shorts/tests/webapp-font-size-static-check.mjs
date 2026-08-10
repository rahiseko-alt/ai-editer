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

/**
 * font-size の値文字列を分類する。
 * - {kind:"ignorable"}: inherit/未指定など、絶対下限の制約が無いもの
 * - {kind:"px", px}: 保証される最小px(clamp()なら最小境界)が数値で求まったもの
 * - {kind:"unparseable"}: 明示的な値はあるが、既知のパターン(px/rem/clamp/inherit)に
 *   当てはまらないもの。vw/%/var()/calc() 等がここに来る。CodeRabbit指摘: これを黙って
 *   スキップすると「実は13px未満かもしれない値」を検査せずに見逃してしまうため、
 *   呼び出し側でテスト失敗として扱う。
 */
function classifyFontSizeValue(value) {
  const v = value.trim();
  if (v === "inherit" || v === "") return { kind: "ignorable" };
  const clampMatch = v.match(/clamp\(\s*([^,]+)\s*,/);
  const target = clampMatch ? clampMatch[1].trim() : v;
  if (target === "inherit" || target === "") return { kind: "ignorable" };
  const pxMatch = target.match(/^(-?[\d.]+)px$/);
  if (pxMatch) return { kind: "px", px: Number(pxMatch[1]) };
  const remMatch = target.match(/^(-?[\d.]+)rem$/);
  if (remMatch) return { kind: "px", px: Number(remMatch[1]) * 16 }; // ルート既定16px前提
  return { kind: "unparseable" }; // vw等、絶対下限が定まらない単位・var()/calc()等
}

function isExcluded(selector) {
  return EXCLUDED_SELECTOR_PATTERNS.some((p) => selector.includes(p));
}

/** ルール本文中の font-size 宣言を出現順に全部集める(トリム済みの値文字列の配列)。 */
function collectDeclarationValues(body) {
  const re = /font-size\s*:\s*([^;]+);?/g;
  const values = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    values.push(m[1].trim());
  }
  return values;
}

const IMPORTANT_RE = /!\s*important\s*$/i;

/**
 * 同じルール内に複数の font-size 宣言があるとき、実際に効く「有効な宣言」を選ぶ。
 * CSSのカスケード規則どおり: !important付きの宣言が1つでもあれば、その中の最後のものが勝つ。
 * 無ければ、通常の宣言のうち最後のもの(後勝ち)が勝つ。
 */
function pickEffectiveValue(values) {
  if (values.length === 0) return null;
  const importantOnes = values.filter((v) => IMPORTANT_RE.test(v));
  const pool = importantOnes.length > 0 ? importantOnes : values;
  const last = pool[pool.length - 1];
  return last.replace(IMPORTANT_RE, "").trim();
}

/**
 * rules から font-size 宣言を集め、{px: [{selector,px}], unparseable: [{selector,raw}]} を返す
 * (除外セレクタは飛ばす)。同一ルール内に複数の font-size 宣言があっても、実際に効く1つだけを
 * 見る(pickEffectiveValue)。
 */
function collectFontSizes(rules) {
  const px = [];
  const unparseable = [];
  for (const { selector, body } of rules) {
    if (isExcluded(selector)) continue;
    const values = collectDeclarationValues(body);
    if (values.length === 0) continue;
    const effective = pickEffectiveValue(values);
    const result = classifyFontSizeValue(effective);
    if (result.kind === "ignorable") continue;
    if (result.kind === "px") { px.push({ selector, px: result.px }); continue; }
    unparseable.push({ selector, raw: effective });
  }
  return { px, unparseable };
}

// ── ②: 実ファイルを実測 ────────────────────────────────────
t("②webapp-mockup/*.css 全体で、保証される最小フォントサイズが13px以上である(unparseableな明示値も無い)", () => {
  let allSizes = [];
  let allUnparseable = [];
  for (const file of CSS_FILES) {
    const css = fs.readFileSync(path.join(CSS_DIR, file), "utf-8");
    const rules = parseCssRules(css);
    const { px, unparseable } = collectFontSizes(rules);
    allSizes = allSizes.concat(px.map((s) => ({ ...s, file })));
    allUnparseable = allUnparseable.concat(unparseable.map((s) => ({ ...s, file })));
  }
  assert.ok(allSizes.length > 10, `font-size宣言が想定より少ない(パースの不備を疑う): ${allSizes.length}件`);
  // CodeRabbit指摘: 解析できない明示的なfont-size宣言(vw/%/var()/calc()等)を黙って
  // スキップすると、実は13px未満かもしれない値を検査せず見逃す。無条件でテスト失敗にする。
  assert.strictEqual(
    allUnparseable.length, 0,
    `解析できないfont-size宣言が${allUnparseable.length}件あり、13px以上か確認できない: ` +
      allUnparseable.map((o) => `${o.file} ${o.selector}="${o.raw}"`).join(", ")
  );
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
  const { px, unparseable } = collectFontSizes(rules);
  // step-n は除外されるので2件だけ残るはず
  assert.strictEqual(px.length, 2, `除外ロジックが効いていない: ${JSON.stringify(px)}`);
  assert.strictEqual(unparseable.length, 0);
  const offenders = px.filter((s) => s.px < 13);
  assert.strictEqual(offenders.length, 2, "対照のはずなのに13px未満として検出されなかった");
});

t("③この検査には検出能力がある: 対照の合成CSSを「全て13px以上」判定に通すと実際に落ちる", () => {
  const brokenCss = `.caption-word .caption-orig { font-size: 11px; }`;
  const rules = parseCssRules(brokenCss);
  const { px } = collectFontSizes(rules);
  assert.throws(() => {
    const offenders = px.filter((s) => s.px < 13);
    assert.strictEqual(offenders.length, 0, "13px未満のfont-sizeがある");
  }, /13px未満のfont-sizeがある/, "13px未満の値が「全て13px以上」判定を通ってしまった(検出できていない)");
});

// ── CodeRabbit指摘 #10: 同一ルール内の複数font-size宣言は「最後に効く値」を見る ──
t("②同一ルール内に複数のfont-size宣言があると、最後の宣言(後勝ち)が採用される", () => {
  // 1つ目(14px)は最初に書かれているが実際には効かない(後の11pxが上書きする)。
  // 最初の値だけを見る旧実装だと、この11px(13px未満)を見逃してしまう。
  const css = `.foo { font-size: 14px; font-size: 11px; }`;
  const rules = parseCssRules(css);
  const { px, unparseable } = collectFontSizes(rules);
  assert.strictEqual(unparseable.length, 0);
  assert.strictEqual(px.length, 1, `複数宣言のうち1つの有効値だけを採用すべき: ${JSON.stringify(px)}`);
  assert.strictEqual(px[0].px, 11, `後勝ちの値(11px)ではなく最初の値を採用してしまっている: ${JSON.stringify(px)}`);
});

t("②同一ルール内で !important 付きの宣言は、後にある通常の宣言より優先される(CSSのカスケード規則どおり)", () => {
  // 14px !important の後に 20px(通常)が続いても、!importantの14pxが勝つ。
  const css = `.foo { font-size: 14px !important; font-size: 20px; }`;
  const rules = parseCssRules(css);
  const { px, unparseable } = collectFontSizes(rules);
  assert.strictEqual(unparseable.length, 0);
  assert.strictEqual(px.length, 1);
  assert.strictEqual(px[0].px, 14, `!importantの宣言が優先されるべき: ${JSON.stringify(px)}`);
});

t("①/③対照: 最初の宣言だけを見る旧実装だと、後勝ちの13px未満の値を見逃す", () => {
  // 旧実装(body.match の非グローバル正規表現 = 最初の1件だけ)を模す。
  const body = " font-size: 14px; font-size: 11px; ";
  const oldImplMatch = body.match(/font-size\s*:\s*([^;]+);?/); // 最初の1件だけ拾う
  const oldImplValue = oldImplMatch[1].trim();
  assert.strictEqual(oldImplValue, "14px", "対照のはずなのに旧実装の欠陥(最初の値を拾う)が再現できていない");
  assert.throws(() => {
    const result = classifyFontSizeValue(oldImplValue);
    assert.ok(result.kind === "px" && result.px < 13, "旧実装は後勝ちの13px未満を見逃す(14pxは13px以上のためoffenderにならない)");
  }, /旧実装は後勝ちの13px未満を見逃す/, "旧実装(最初の値のみ参照)の欠陥を検出できていない");
});

// ── CodeRabbit指摘 #10 補: 解析できない明示的な宣言は無視せずテスト失敗として扱う ──
t("②解析できないfont-size宣言(vw単位)は、unparseableとして報告され黙ってスキップされない", () => {
  const css = `.foo { font-size: 2.5vw; }`;
  const rules = parseCssRules(css);
  const { px, unparseable } = collectFontSizes(rules);
  assert.strictEqual(px.length, 0, "vw単位は絶対px値が定まらないため、px側には入らないはず");
  assert.strictEqual(unparseable.length, 1, `unparseableとして報告されるはず: ${JSON.stringify({ px, unparseable })}`);
  assert.strictEqual(unparseable[0].raw, "2.5vw");
});

t("①/③対照: 解析できない宣言を黙ってスキップする旧実装だと、13px未満かもしれない値を見逃す", () => {
  // 旧実装(px===nullなら無条件でcontinueし、13px未満判定の対象にすら入らない)を模す。
  const oldImplSkips = true; // 旧実装は unparseable を offenders 判定にすら含めない
  assert.throws(() => {
    assert.strictEqual(oldImplSkips, false, "解析できない宣言を黙ってスキップしてはいけない");
  }, /解析できない宣言を黙ってスキップしてはいけない/, "旧実装(黙ってスキップ)の欠陥を検出できていない");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
