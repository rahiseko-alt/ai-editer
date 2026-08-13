// 結果タブ切替でaria-selectedが実際に更新されることの検証 — AUD-P2-24
//
// クリックで表示パネル(.tab-body)は切り替わるのに、タブ要素のaria-selectedは
// 一度も更新されず、スクリーンリーダーは切替後も前のタブを選択中として読み上げ続けていた。
// このファイルは playwright（実ブラウザ操作）に依存する。他のwebapp-*-check.mjsと同じ作法
// （devDependencies導入・CI組み込み済み。詳細はwebapp-aria-pressed-check.mjs冒頭コメント参照）。
// 実行: node tests/webapp-tab-aria-selected-check.mjs

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

/** タブ要素の { tab, aria, hidden(対応するパネルのhidden有無) } 一覧を返す */
async function tabState(page) {
  return page.evaluate(() => {
    const panelId = (t) => (t.dataset.tab === "keep" ? "tab-keep" : "tab-trash");
    return Array.from(document.querySelectorAll(".tab")).map((el) => ({
      tab: el.dataset.tab,
      isOn: el.classList.contains("is-on"),
      ariaSelected: el.getAttribute("aria-selected"),
      panelVisible: !document.getElementById(panelId(el)).classList.contains("hidden"),
    }));
  });
}

(async () => {
  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => {
    pageErrors.push(err);
    console.error("PAGE ERROR:", err.message);
  });
  await page.goto(filePath);
  await page.waitForTimeout(300);

  // 結果パネルは通常ジョブ完了後に開くが、タブのDOMは常に存在するので直接開いて検証する。
  await page.evaluate(() => window.openResult());
  await page.waitForTimeout(150);

  await t("初期状態: 「採用候補」タブだけがaria-selected=trueで、表示中パネルと一致している", async () => {
    const states = await tabState(page);
    for (const s of states) {
      assert.strictEqual(s.ariaSelected, String(s.isOn), `tab=${s.tab}: is-on=${s.isOn}なのにaria-selected=${s.ariaSelected}`);
      assert.strictEqual(s.ariaSelected === "true", s.panelVisible, `tab=${s.tab}: aria-selectedと実際に表示中のパネルが食い違う`);
    }
    assert.ok(states.find((s) => s.tab === "keep").ariaSelected === "true", "初期状態で採用候補タブがaria-selected=trueでない");
  });

  await t("「使わない候補」タブをクリックすると、そちらだけaria-selected=trueになり表示パネルとも一致する", async () => {
    await page.click('.tab[data-tab="trash"]');
    await page.waitForTimeout(50);
    const states = await tabState(page);
    for (const s of states) {
      assert.strictEqual(s.ariaSelected, String(s.isOn), `tab=${s.tab}: is-on=${s.isOn}なのにaria-selected=${s.ariaSelected}`);
      assert.strictEqual(s.ariaSelected === "true", s.panelVisible, `tab=${s.tab}: aria-selectedと実際に表示中のパネルが食い違う`);
    }
    const trash = states.find((s) => s.tab === "trash");
    const keep = states.find((s) => s.tab === "keep");
    assert.strictEqual(trash.ariaSelected, "true", "クリックした「使わない候補」タブがaria-selected=trueになっていない");
    assert.strictEqual(keep.ariaSelected, "false", "非選択になった「採用候補」タブがaria-selected=falseになっていない(前のタブを読み上げ続ける不具合の再現)");
  });

  await t("「採用候補」タブへ戻すと、aria-selectedも正しく戻る", async () => {
    await page.click('.tab[data-tab="keep"]');
    await page.waitForTimeout(50);
    const states = await tabState(page);
    assert.strictEqual(states.find((s) => s.tab === "keep").ariaSelected, "true");
    assert.strictEqual(states.find((s) => s.tab === "trash").ariaSelected, "false");
  });

  await t("実行中、ブラウザ側で読み込み・実行時エラーが発生していない(pageerrorが1件も無い)", async () => {
    assert.strictEqual(pageErrors.length, 0, `ブラウザ側で実行時エラーが発生した: ${pageErrors.map((e) => e.message).join(", ")}`);
  });

  await context.close();
  await browser.close();

  // ── 対照: aria-selectedを一切更新しない旧実装だと、切替後も前のタブがtrueのまま ──
  await t("対照: aria-selectedを更新しない旧実装だと、切替後も非選択タブがtrueのままで判定に落ちる", async () => {
    const before = "true"; // 「採用候補」の初期値
    const afterClickButNoAriaUpdate = before; // 旧実装は「使わない候補」をクリックしてもここが変わらない
    assert.throws(() => {
      assert.strictEqual(afterClickButNoAriaUpdate, "false", "非選択になったタブのaria-selectedがfalseになっていない");
    }, /aria-selectedがfalseになっていない/, "旧実装(未更新)が「更新された」判定を通ってしまった(検出できていない)");
  });

  console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
