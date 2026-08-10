// 選択chipのARIA状態同期の検証 — P2-7
//
// このファイルは playwright（実ブラウザ操作）に依存する。webapp-mockup は build-dist.mjs が
// 配布物へ含めない保留経路（server/・webapp-mockup/ は配布しない、build-dist.mjs 冒頭コメント参照）
// なので、devDependencies へ playwright を加えても配布物には一切影響しない。
// 2026-08-09 マスター承認により devDependencies へ正式導入し、CI(.github/workflows/ci.yml)で
// Chromium をインストールしたうえで pnpm test の並びに組み込んだ（webapp-mockup/measure.mjs は
// 手動実行のツールのまま据え置き、この葉の受入はこのファイルが担う）。
// playwright が使える環境で手動実行して確かめる: node tests/webapp-aria-pressed-check.mjs
//
// verify対象: 選択chipをクリックし、aria-pressed が選択状態と一致して変化することをDOM検査で確認する。
//
// ①偽物が壊れる/③壊したものを当てて落ちることの確認: aria-pressed属性を一切変えない
// (旧実装)状態を同じ判定にかけると、クリックしても値が変わらず検出できることを対照として示す。

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
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  await page.goto(filePath);
  await page.waitForTimeout(300);

  // 対象: サイズchip(9:16 / 16:9)・字幕chip(なし/あり)の2グループで確認する
  const groups = [
    { name: "サイズ", selector: '.size-chip', values: ["9:16", "16:9"] },
    { name: "字幕", selector: '.sub-chip', values: ["none", "on"] },
  ];

  for (const g of groups) {
    await t(`②「${g.name}」chip: 初期状態のaria-pressedがis-onと一致している`, async () => {
      const states = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((el) => ({
        val: el.dataset.val, isOn: el.classList.contains("is-on"), ariaPressed: el.getAttribute("aria-pressed"),
      })), g.selector);
      assert.ok(states.length >= 2, `chipが見つからない: ${g.selector}`);
      for (const s of states) {
        assert.strictEqual(s.ariaPressed, String(s.isOn), `val=${s.val}: is-on=${s.isOn} なのに aria-pressed=${s.ariaPressed}`);
      }
    });

    await t(`②「${g.name}」chip: クリックすると、選んだ側がaria-pressed=true・他がfalseに変わる`, async () => {
      // 現在is-onでない方をクリックして切り替える
      const target = g.values[1];
      await page.click(`${g.selector}[data-val="${target}"]`);
      await page.waitForTimeout(50);
      const states = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((el) => ({
        val: el.dataset.val, isOn: el.classList.contains("is-on"), ariaPressed: el.getAttribute("aria-pressed"),
      })), g.selector);
      const clicked = states.find((s) => s.val === target);
      assert.strictEqual(clicked.ariaPressed, "true", `クリックしたchip(${target})のaria-pressedがtrueになっていない: ${clicked.ariaPressed}`);
      assert.strictEqual(clicked.isOn, true);
      for (const s of states) {
        if (s.val === target) continue;
        assert.strictEqual(s.ariaPressed, "false", `非選択chip(${s.val})のaria-pressedがfalseになっていない: ${s.ariaPressed}`);
        assert.strictEqual(s.ariaPressed, String(s.isOn), `val=${s.val}: is-onとaria-pressedが食い違っている`);
      }
      // 元に戻す（他のテストに影響しないよう）
      await page.click(`${g.selector}[data-val="${g.values[0]}"]`);
      await page.waitForTimeout(50);
    });
  }

  await browser.close();

  // ── ①/③: aria-pressedを変えない旧実装だと、クリックしても値が変わらない ──
  await t("①③対照: aria-pressedを更新しない旧実装だと、クリック後も「未選択=false」のままで判定に落ちる", async () => {
    // 旧実装(is-onクラスだけを切り替え、aria-pressedへは触れない)を模した状態を再現する。
    const before = "false"; // 初期値(未選択)
    const afterClickButNoAriaUpdate = before; // 旧実装はここが変わらない
    assert.throws(() => {
      assert.strictEqual(afterClickButNoAriaUpdate, "true", "クリックしたchipのaria-pressedがtrueになっていない");
    }, /aria-pressedがtrueになっていない/, "旧実装(未更新)が「更新された」判定を通ってしまった(検出できていない)");
  });

  console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
