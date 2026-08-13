// アップロード操作がキーボードだけで到達できることの検証 — AUD-P1-13
//
// 見た目上のアップロード枠(#drop)は<label for="file">で、実体の<input type=file>は
// hiddenのため、tabindex無しの<label>はTab順にもアクセシビリティツリーの
// フォーカス可能要素にも現れず、キーボードだけの利用者はファイル選択そのものに
// 到達できなかった。tabindex="0" + role="button" + Enter/Spaceキー処理で直る。
//
// このファイルは playwright（実ブラウザ操作）に依存する。他のwebapp-*-check.mjsと同じ作法
// （devDependencies導入・CI組み込み済み。詳細はwebapp-aria-pressed-check.mjs冒頭コメント参照）。
// 実行: node tests/webapp-upload-keyboard-check.mjs

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

/** Tabだけを最大limit回押して、id===targetIdの要素へフォーカスが到達するか調べる。 */
async function reachByTabbing(page, targetId, limit) {
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement && document.activeElement.id);
    if (id === targetId) return i + 1;
  }
  return -1;
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

  let tabsUsed = -1;
  await t("Tabキーだけで#drop（アップロード枠）へフォーカスが到達する", async () => {
    tabsUsed = await reachByTabbing(page, "drop", 8);
    assert.ok(tabsUsed > 0, "Tabを8回押してもアップロード枠(#drop)にフォーカスが到達しなかった");
  });

  await t("#dropにフォーカスがある間、見える焦点(outline)が実際に描画されている", async () => {
    const outline = await page.evaluate(() => {
      const el = document.getElementById("drop");
      const cs = getComputedStyle(el);
      return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
    });
    assert.notStrictEqual(outline.outlineStyle, "none", `フォーカス時のoutlineが無い: ${JSON.stringify(outline)}`);
    assert.ok(parseFloat(outline.outlineWidth) > 0, `フォーカス時のoutline幅が0: ${JSON.stringify(outline)}`);
  });

  await t("フォーカスした#drop上でEnterを押すと、ファイル選択(input#fileのクリック相当)が起動する", async () => {
    // 実OSのファイル選択ダイアログはPlaywrightのfilechooserイベントとして観測できる
    // （input#fileはhiddenだが、.click()由来のダイアログでも発火する）。
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 8000 });
    await page.keyboard.press("Enter");
    const chooser = await chooserPromise;
    assert.ok(chooser, "Enterを押してもファイル選択が起動しなかった");
    // 開いたダイアログを片付けておく（未解決のままだと次のfilechooserが発火しないブラウザがある）。
    await chooser.setFiles([]);
  });

  await t("フォーカスした#drop上でSpaceを押しても、ファイル選択が起動する", async () => {
    // 直前のEnterでダイアログが開いたままだとfilechooserが再発火しないブラウザがあるため、
    // 明示的にフォーカスを外して戻し、新しいユーザー操作として扱わせる。
    // 直前のダイアログの後始末が完全に終わるまで少し待つ(即座に次を開こうとすると
    // ブラウザ側の内部状態がまだ前のダイアログを引きずり、発火が遅れることがある)。
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById("drop").focus());
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 8000 });
    await page.keyboard.press(" ");
    const chooser = await chooserPromise;
    assert.ok(chooser, "Spaceを押してもファイル選択が起動しなかった");
  });

  await t("実行中、ブラウザ側で読み込み・実行時エラーが発生していない(pageerrorが1件も無い)", async () => {
    assert.strictEqual(
      pageErrors.length,
      0,
      `ブラウザ側で実行時エラーが発生した: ${pageErrors.map((e) => e.message).join(", ")}`
    );
  });

  await context.close();
  await browser.close();

  // ── 対照: tabindex無し(旧実装相当)の<label>はTab順に現れない ──
  await t("対照: tabindex無しの<label>要素はTabで到達できない(旧実装が同じ判定に落ちることの確認)", async () => {
    const browser2 = await chromium.launch(chromiumLaunchOptions());
    const page2 = await browser2.newPage();
    await page2.setContent(`
      <button id="before">前</button>
      <label id="old-drop" for="f">旧実装（tabindex無し）</label>
      <input type="file" id="f" hidden />
      <button id="after">後</button>
    `);
    const reached = await reachByTabbing(page2, "old-drop", 5);
    await browser2.close();
    assert.strictEqual(reached, -1, "旧実装(tabindex無し)のlabelにTabで到達できてしまった(検出できていない)");
  });

  console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
