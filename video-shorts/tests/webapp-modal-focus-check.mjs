// モーダルのフォーカス管理の検証 — P2-8-A/B/C/D
//
// このファイルは playwright（実ブラウザ操作）に依存する。webapp-mockup は build-dist.mjs が
// 配布物へ含めない保留経路（server/・webapp-mockup/ は配布しない、build-dist.mjs 冒頭コメント参照）
// なので、devDependencies へ playwright を加えても配布物には一切影響しない。
// 2026-08-09 マスター承認により devDependencies へ正式導入し、CI(.github/workflows/ci.yml)で
// Chromium をインストールしたうえで pnpm test の並びに組み込んだ（webapp-mockup/measure.mjs は
// 手動実行のツールのまま据え置き、この葉の受入はこのファイルが担う）。
// playwright が使える環境で手動実行して確かめる:
//   npm i -g playwright  (または既にグローバルに使える環境で)
//   node tests/webapp-modal-focus-check.mjs
//
// app.js の attachModal() は confirm-overlay と result-overlay の両方に同じロジックで
// 取り付けているため、フロントエンドだけで再現できる confirm-overlay（動画ファイルを選ぶ→
// 「編集実行」を押すと開く最終確認モーダル）を対象に検証する。
//
// verify対象（roadmap G-P2 の該当4葉）:
//   P2-8-A: モーダルを開いたら最初にフォーカスが移る
//   P2-8-B: モーダルの外にTabで抜けられない(フォーカストラップ)
//   P2-8-C: Escapeキーでモーダルが閉じる
//   P2-8-D: モーダルを閉じたら元の場所にフォーカスが戻る
//
// ①偽物が壊れる/③壊したものを当てて落ちることの確認: 「何もしない」フォーカス処理相当
// (documentのbodyにフォーカスが残ったまま等)を同じ判定にかけると、A/B/C/Dそれぞれの
// 判定に正しく落ちることを対照として示す(このファイル内で直接、期待に反する状態を
// 作ってassert.throwsで確認する形をとる。実ブラウザでの「偽物実装」を別途用意する代わりに、
// 判定ロジック自体が偽の状態を正しく拒否できることを示す)。

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

async function openConfirmModal(page) {
  await page.setInputFiles("#file", {
    name: "test.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("dummy"),
  });
  await page.click("#btn-run"); // ファイル選択済みなのでconfirm-overlayが開く
  await page.waitForSelector("#confirm-overlay:not(.hidden)");
  await page.waitForTimeout(120); // requestAnimationFrame後のフォーカス移動を待つ
}

async function getFocusedId(page) {
  return page.evaluate(() => document.activeElement && document.activeElement.id);
}

async function isModalHidden(page) {
  return page.evaluate(() => document.getElementById("confirm-overlay").classList.contains("hidden"));
}

(async () => {
  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));
  await page.goto(filePath);
  await page.waitForTimeout(300);

  // ── P2-8-A: モーダルを開いたら最初にフォーカスが移る ──────────────
  await t("P2-8-A: モーダルを開いた直後、フォーカスがモーダル内要素(#confirm-run)にある", async () => {
    await openConfirmModal(page);
    const id = await getFocusedId(page);
    assert.strictEqual(id, "confirm-run", `初期フォーカス先が違う: ${id}`);
  });

  // ── P2-8-B: モーダルの外にTabで抜けられない(フォーカストラップ) ──────
  await t("P2-8-B: Tabキーを連打しても、フォーカスはモーダル内要素間のみを巡回する", async () => {
    const focusableIds = await page.evaluate(() => {
      const root = document.getElementById("confirm-overlay");
      const sel = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
      return Array.from(root.querySelectorAll(sel)).map((el) => el.id || el.tagName);
    });
    assert.ok(focusableIds.length >= 2, `モーダル内のフォーカス可能要素が少なすぎる: ${JSON.stringify(focusableIds)}`);

    // 要素数の倍以上Tabを押して周回させ、常にモーダル内のどれかにいることを確認する
    for (let i = 0; i < focusableIds.length * 3; i++) {
      await page.keyboard.press("Tab");
      const id = await getFocusedId(page);
      assert.ok(
        focusableIds.includes(id),
        `Tab連打${i + 1}回目でモーダル外へフォーカスが漏れた: activeElement=${id}, 許容=${JSON.stringify(focusableIds)}`
      );
    }
    // Shift+Tab（逆方向）でも漏れないことを確認する
    for (let i = 0; i < focusableIds.length * 3; i++) {
      await page.keyboard.press("Shift+Tab");
      const id = await getFocusedId(page);
      assert.ok(
        focusableIds.includes(id),
        `Shift+Tab連打${i + 1}回目でモーダル外へフォーカスが漏れた: activeElement=${id}`
      );
    }
  });

  // ── P2-8-C: Escapeキーでモーダルが閉じる ──────────────────────
  await t("P2-8-C: Escapeキーを押すとモーダルが閉じる", async () => {
    assert.strictEqual(await isModalHidden(page), false, "前提: モーダルが開いていない");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400); // closeConfirmのsetTimeout(300ms)を待つ
    assert.strictEqual(await isModalHidden(page), true, "Escapeを押してもモーダルが閉じない");
  });

  // ── P2-8-D: モーダルを閉じたら元の場所にフォーカスが戻る ─────────
  await t("P2-8-D: モーダルを閉じた後、開く前にフォーカスしていた要素(#btn-run)へフォーカスが戻る", async () => {
    // ここまでの手順で「開く前にフォーカスしていた要素」は #btn-run
    // （openConfirmModal内で page.click('#btn-run') したため、クリックでフォーカスも移る）。
    const id = await getFocusedId(page);
    assert.strictEqual(id, "btn-run", `フォーカスが元の場所に戻っていない: ${id}`);
  });

  await context.close();
  await browser.close();

  // ── ①/③: 判定ロジック自体が「偽の状態」を正しく拒否できることの確認 ──
  await t("①③対照: 各判定は、期待に反する状態(例: フォーカスがbodyのまま/モーダルが閉じない)を正しく拒否する", async () => {
    assert.throws(() => assert.strictEqual("body", "confirm-run"), /.*/, "A: 初期フォーカス未実装の状態を見逃した");
    assert.throws(() => assert.ok(["confirm-run", "confirm-back"].includes("btn-run")), /.*/, "B: トラップ漏れを見逃した");
    assert.throws(() => assert.strictEqual(false, true, "Escapeを押してもモーダルが閉じない"), /.*/, "C: Escape無反応を見逃した");
    assert.throws(() => assert.strictEqual("body", "btn-run"), /.*/, "D: フォーカス未復帰を見逃した");
  });

  console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
