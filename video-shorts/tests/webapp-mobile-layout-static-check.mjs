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

/**
 * css本文から @media (max-width: Npx) ブロックを出現順に全部抜き出し、
 * {maxWidth, body} の配列で返す。
 * CodeRabbit指摘: 最初に見つかったブロックだけを使う実装だと、より小さいブレークポイント
 * (例: 320px)の規則がファイル中で先に書かれていると、375pxでは実際には適用されない
 * その規則を「効いているもの」として誤って使ってしまう。まず全ブロックを集め、
 * 呼び出し側で「375pxで実際に適用されるもの」を選び直す。
 */
function extractAllMaxWidthMediaBlocks(css) {
  const blocks = [];
  const re = /@media\s*\(\s*max-width\s*:\s*([\d.]+)px\s*\)/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const open = css.indexOf("{", re.lastIndex);
    if (open < 0) continue;
    let depth = 0, i = open;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push({ maxWidth: Number(m[1]), body: css.slice(open + 1, i) });
    re.lastIndex = i + 1; // 次の検索はこのブロックの後ろから(入れ子の誤検出を避ける)
  }
  return blocks;
}

/**
 * 指定ビューポート幅で実際に適用される @media (max-width: ...) ブロックを、ファイル中の
 * 出現順のまま返す(max-width >= viewportPx のものが対象。CSSのmedia queryは
 * "ビューポート幅がmax-width以下なら適用"なので、375px幅では max-width>=375 の
 * ブロックが(複数あれば全部)同時に適用される)。
 */
function applicableMediaBlocksAt(blocks, viewportPx) {
  return blocks.filter((b) => b.maxWidth >= viewportPx);
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

const TARGET_VIEWPORT_PX = 375; // このテストが検証する対象幅(webapp-mobile-layout-check.mjsと同じ)
const EXPECTED_BREAKPOINT_PX = 640; // このアプリが1カラム化に使う想定のブレークポイント

/** 375pxで実際に適用されるmediaブロック群の中から、.two-colのgrid-template-columnsとして
 *  実際に効く値(最後に適用されたもの=後勝ち)を求める。適用ブロックの中に.two-colの
 *  規則が無ければnullを返す。 */
function effectiveTwoColGridTemplateColumnsAt(css, viewportPx) {
  const blocks = extractAllMaxWidthMediaBlocks(css);
  const applicable = applicableMediaBlocksAt(blocks, viewportPx);
  let effective = null;
  for (const b of applicable) {
    const body = findRuleBody(b.body, ".two-col");
    if (!body) continue;
    const m = body.match(/grid-template-columns\s*:\s*([^;]+);/);
    if (m) effective = m[1];
  }
  return { applicable, value: effective };
}

t(`②${TARGET_VIEWPORT_PX}pxで実際に適用されるmedia query内で .two-col が1カラム(grid-template-columns:1トラック)になっている`, () => {
  const css = fs.readFileSync(CSS_PATH, "utf-8");
  const { applicable, value } = effectiveTwoColGridTemplateColumnsAt(css, TARGET_VIEWPORT_PX);
  assert.ok(applicable.length > 0, `${TARGET_VIEWPORT_PX}pxで適用される@media(max-width:...)ブロックが無い(モバイル対応が無い)`);
  assert.ok(value, `${TARGET_VIEWPORT_PX}pxで適用されるブロック内に.two-colのgrid-template-columns指定が無い(2カラムのまま=デフォルトを継承してしまう)`);
  assert.ok(isSingleColumn(value), `1カラムになっていない: grid-template-columns=${value}`);
});

t(`②想定しているブレークポイント(@media(max-width:${EXPECTED_BREAKPOINT_PX}px))が実在する`, () => {
  const css = fs.readFileSync(CSS_PATH, "utf-8");
  const blocks = extractAllMaxWidthMediaBlocks(css);
  assert.ok(
    blocks.some((b) => b.maxWidth === EXPECTED_BREAKPOINT_PX),
    `@media (max-width: ${EXPECTED_BREAKPOINT_PX}px) が見つからない: ${JSON.stringify(blocks.map((b) => b.maxWidth))}`
  );
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
  const { applicable, value } = effectiveTwoColGridTemplateColumnsAt(brokenCss, TARGET_VIEWPORT_PX);
  assert.strictEqual(applicable.length, 0, "対照のはずなのにmedia queryが見つかってしまった");
  assert.strictEqual(value, null);
});

t("③この検査には検出能力がある: 2カラムのままのmedia queryを「1カラム」判定に通すと実際に落ちる", () => {
  const brokenCss = `
    @media (max-width: 640px) {
      .two-col { grid-template-columns: 1.6fr 1fr; }
    }
  `;
  const { value } = effectiveTwoColGridTemplateColumnsAt(brokenCss, TARGET_VIEWPORT_PX);
  assert.throws(() => {
    assert.ok(isSingleColumn(value), `1カラムになっていない: grid-template-columns=${value}`);
  }, /1カラムになっていない/, "2カラムのままなのに「1カラム」判定を通ってしまった(検出できていない)");
});

// ── CodeRabbit指摘 #12: 375pxでは適用されない、より小さいブレークポイントの1カラム規則が
//    ファイル中で先に書かれていても、それを「効いている」ものとして誤採用しない ──
t("②375pxでは適用されない小さいブレークポイント(320px)の1カラム規則が先に書かれていても、実際に適用される640px側の値(2カラムのまま)を正しく検出する", () => {
  // 320px向けの規則は1カラムで先に書かれているが、375px幅ではこの@mediaは適用されない
  // (375 > 320)。実際に適用されるのは640px側だが、そちらは(バグとして)2カラムのまま。
  // 「最初に見つかったブロックを使う」旧実装だと、320px側の1カラムを誤って「効いている」と
  // みなしPASSにしてしまう(=このテストが検出したい壊れ方そのもの)。
  const brokenCss = `
    @media (max-width: 320px) {
      .two-col { grid-template-columns: 1fr; }
    }
    @media (max-width: 900px) {
      .two-col { grid-template-columns: 1.6fr 1fr; }
    }
  `;
  const { applicable, value } = effectiveTwoColGridTemplateColumnsAt(brokenCss, TARGET_VIEWPORT_PX);
  // 320pxブロックは適用対象から除外され、900pxブロックだけが適用されるはず
  assert.deepStrictEqual(applicable.map((b) => b.maxWidth), [900], `適用ブロックの選定を誤っている: ${JSON.stringify(applicable.map((b) => b.maxWidth))}`);
  assert.strictEqual(value, "1.6fr 1fr", "実際に適用される640px相当側の値を採用できていない");
  assert.strictEqual(isSingleColumn(value), false, "2カラムのままのはずなのに1カラムと判定してしまった(320px側を誤って採用した疑い)");
});

t("①/③対照: 「最初に見つかったブロックを使う」旧実装だと、375pxでは適用されない320px側の1カラム規則を誤って採用しPASSしてしまう", () => {
  const brokenCss = `
    @media (max-width: 320px) {
      .two-col { grid-template-columns: 1fr; }
    }
    @media (max-width: 900px) {
      .two-col { grid-template-columns: 1.6fr 1fr; }
    }
  `;
  // 旧実装(search()で最初に見つかった@media(max-width:...)を使う)を模す。
  const idx = brokenCss.search(/@media\s*\(\s*max-width\s*:/);
  const open = brokenCss.indexOf("{", idx);
  let depth = 0, i = open;
  for (; i < brokenCss.length; i++) {
    if (brokenCss[i] === "{") depth++;
    else if (brokenCss[i] === "}") { depth--; if (depth === 0) break; }
  }
  const oldImplMediaBody = brokenCss.slice(open + 1, i);
  const twoColBody = findRuleBody(oldImplMediaBody, ".two-col");
  const m = twoColBody.match(/grid-template-columns\s*:\s*([^;]+);/);
  assert.strictEqual(m[1], "1fr", "対照のはずなのに旧実装の欠陥(最初のブロックを使う=320px側)が再現できていない");
  assert.throws(() => {
    assert.ok(!isSingleColumn(m[1]), "旧実装は375pxで実際には適用されない320px側の1カラムを誤ってPASSにしてしまう");
  }, /旧実装は375pxで実際には適用されない320px側の1カラムを誤ってPASSにしてしまう/, "旧実装(最初のブロックを使う)の欠陥を検出できていない");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
