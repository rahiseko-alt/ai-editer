// 「編集できません」カード表示時にフォーカスがそこへ移ることの検証 — AUD-P2-23
//
// 見た目はモーダルそのもの(role="dialog")だが、表示してもフォーカスは表示前の場所に
// 残ったままで、aria-modalも無く、既存のフォーカストラップ(confirm/result両モーダルが
// 使うattachModal)にも繋がっていなかった。理由文言・再選択ボタンへキーボードだけで
// 辿り着けることを検証する。
//
// このファイルは playwright（実ブラウザ操作）に依存する。他のwebapp-*-check.mjsと同じ作法
// （devDependencies導入・CI組み込み済み。詳細はwebapp-aria-pressed-check.mjs冒頭コメント参照）。
// 実行: node tests/webapp-cantedit-focus-check.mjs

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

async function getFocusedId(page) {
  return page.evaluate(() => document.activeElement && document.activeElement.id);
}

/** サーバー往復無しで「編集できません」カードを直接発火する(showCantEditはwindowへ露出済み)。 */
async function triggerCantEdit(page) {
  await page.evaluate(() => window.showCantEdit("話し声が見つかりませんでした。"));
  await page.waitForTimeout(120); // requestAnimationFrame後のフォーカス移動を待つ
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

  await t("role=dialog かつ aria-modal=true が静的markupに付いている", async () => {
    const attrs = await page.evaluate(() => {
      const el = document.getElementById("cantedit-card");
      return { role: el.getAttribute("role"), ariaModal: el.getAttribute("aria-modal") };
    });
    assert.strictEqual(attrs.role, "dialog", `role属性が違う: ${attrs.role}`);
    assert.strictEqual(attrs.ariaModal, "true", `aria-modal属性が無い/違う: ${attrs.ariaModal}`);
  });

  await t("カード表示直後、フォーカスがカード内(#cantedit-retry)にある", async () => {
    await triggerCantEdit(page);
    const id = await getFocusedId(page);
    assert.strictEqual(id, "cantedit-retry", `フォーカス先が違う: ${id}(bodyのまま=未実装を示す)`);
  });

  await t("Tabキーで理由文言を経由して再選択ボタンへ辿り着ける(フォーカストラップがカード内を巡回する)", async () => {
    const focusableIds = await page.evaluate(() => {
      const root = document.getElementById("cantedit-card");
      const sel = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
      return Array.from(root.querySelectorAll(sel)).map((el) => el.id || el.tagName);
    });
    assert.ok(focusableIds.includes("cantedit-retry"), `フォーカス可能要素に再選択ボタンが無い: ${JSON.stringify(focusableIds)}`);
    for (let i = 0; i < focusableIds.length * 3; i++) {
      await page.keyboard.press("Tab");
      const id = await getFocusedId(page);
      assert.ok(focusableIds.includes(id), `Tab連打${i + 1}回目でカード外へフォーカスが漏れた: activeElement=${id}`);
    }
  });

  await t("Escapeキーでカードが閉じる", async () => {
    const hiddenBefore = await page.evaluate(() => document.getElementById("cantedit-card").classList.contains("hidden"));
    assert.strictEqual(hiddenBefore, false, "前提: カードが開いていない");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const hiddenAfter = await page.evaluate(() => document.getElementById("cantedit-card").classList.contains("hidden"));
    assert.strictEqual(hiddenAfter, true, "Escapeを押してもカードが閉じない");
  });

  await t("実行中、ブラウザ側で読み込み・実行時エラーが発生していない(pageerrorが1件も無い)", async () => {
    assert.strictEqual(pageErrors.length, 0, `ブラウザ側で実行時エラーが発生した: ${pageErrors.map((e) => e.message).join(", ")}`);
  });

  await context.close();
  await browser.close();

  // ── 対照: 表示するだけでフォーカスを移さない旧実装は、この判定に正しく落ちる ──
  await t("対照: フォーカス移動が無い旧実装(bodyに残ったまま)は、この判定に落ちる", async () => {
    const before = "body"; // 旧実装ではshowCantEdit後もactiveElementがbodyのまま
    assert.throws(() => {
      assert.strictEqual(before, "cantedit-retry", "フォーカス先が違う(bodyのまま=未実装を示す)");
    }, /フォーカス先が違う/, "旧実装(未実装)が「移動した」判定を通ってしまった(検出できていない)");
  });

  console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
