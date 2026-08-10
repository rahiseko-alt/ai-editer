// スマホ幅(375px)でのレイアウト崩壊防止の検証 — P2-5
//
// このファイルは playwright（実ブラウザ操作）に依存する。webapp-mockup は build-dist.mjs が
// 配布物へ含めない保留経路（server/・webapp-mockup/ は配布しない、build-dist.mjs 冒頭コメント参照）
// なので、devDependencies へ playwright を加えても配布物には一切影響しない。
// 2026-08-09 マスター承認により devDependencies へ正式導入し、CI(.github/workflows/ci.yml)で
// Chromium をインストールしたうえで pnpm test の並びに組み込んだ（webapp-mockup/measure.mjs は
// 手動実行のツールのまま据え置き、この葉の受入はこのファイルが担う）。
// playwright が使える環境で手動実行して確かめる: node tests/webapp-mobile-layout-check.mjs
//
// verify対象: 375px幅でwebapp-mockupを表示し、レイアウトが1カラムになり要素が重ならないことを確認する。
// 根拠(修正前): 375pxで2カラムを維持し、右カラム(プレビュー)が約96pxへ圧縮され崩壊していた。
//
// ①偽物が壊れる/③壊したものを当てて落ちることの確認: このファイル内の②の判定はそのまま
// 「2カラムのまま」の状態にも適用できる形にしてあり、実際に viewport を変えずCSSを一時的に
// 元へ戻して(このテストの直前に別途 static check で対照は取っている)実測していることを、
// 数値(右カラム幅)そのもので示す。ここでは実ブラウザでの実測に絞り、対照はより高速に
// 判定できる tests/webapp-mobile-layout-static-check.mjs（npm依存ゼロ）側で担う。

import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { chromiumLaunchOptions } from "./helpers/launch-chromium.mjs";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const htmlPath = path.join(ROOT, "webapp-mockup", "index.html");
const filePath = "file://" + htmlPath.split(path.sep).join("/");

let pass = 0, fail = 0;
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

(async () => {
  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => {
    pageErrors.push(err);
    console.error("PAGE ERROR:", err.message);
  });
  await page.goto(filePath);
  await page.waitForTimeout(400);

  await t("②375px幅で col-settings と col-preview が横並び(2カラム)ではなく縦積みになっている", async () => {
    const rects = await page.evaluate(() => {
      const s = document.getElementById("col-settings").getBoundingClientRect();
      const p = document.getElementById("col-preview").getBoundingClientRect();
      return { s: { top: s.top, bottom: s.bottom, left: s.left, right: s.right, width: s.width },
               p: { top: p.top, bottom: p.bottom, left: p.left, right: p.right, width: p.width } };
    });
    // 縦積み = col-previewの上端がcol-settingsの下端以降にある(横に並んでいない)
    assert.ok(
      rects.p.top >= rects.s.bottom - 1,
      `col-previewがcol-settingsの下に来ていない(=2カラムのまま横並び): settings.bottom=${rects.s.bottom}, preview.top=${rects.p.top}`
    );
  });

  await t("②375px幅で col-preview(プレビュー領域)の幅が画面幅並みに確保され、圧縮されていない(旧: 約96pxまで潰れていた)", async () => {
    const width = await page.evaluate(() => document.getElementById("col-preview").getBoundingClientRect().width);
    assert.ok(width > 300, `col-previewの幅が狭すぎる(圧縮されている疑い): ${width}px`);
  });

  await t("②375px幅で横スクロールが発生していない(要素が画面幅をはみ出して重なっていない)", async () => {
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert.ok(scrollWidth <= innerWidth + 1, `横スクロールが発生している(要素がはみ出している): scrollWidth=${scrollWidth} > innerWidth=${innerWidth}`);
  });

  await t("②375px幅でも読み込みエラーが無い(pageerrorイベントが1件も飛んでいないことを直接assertする)", async () => {
    assert.strictEqual(
      pageErrors.length,
      0,
      `ブラウザ側で実行時エラーが発生した: ${pageErrors.map((e) => e.message).join(", ")}`
    );
  });

  await context.close();
  await browser.close();

  console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
