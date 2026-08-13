// AUD-P1-14: 同意を求める契約書が実際に読める状態で提示されることの検証
// (=確定本文が無い間は、同意操作そのものが無効化されていることの検証)。
//
// consent.html は「AI顧問契約書 第10版」への同意を求めるが、確定本文・リンクがどこにも
// 存在しない(唯一の候補文書 docs/terms-and-liability.md も「客向け・素案」「要マスター確定」
// と明記された未確定物)。修正前は、それでも #agree にチェックし #start(同意してダウンロード)
// を押せてしまい、閲覧できない契約への同意が成立してしまっていた。
// 修正後: install/consent.html は data-contract-available="false"(実配布状態)であり、
// #agree はHTML側で静的disabled、consent.js の refresh() がCONTRACT_AVAILABLEを見て
// #agree/#start を常にdisabledへ保つ(名前入力・チェック操作の有無に関わらず)。
//
// このファイルは playwright（実ブラウザ操作）に依存する。他のwebapp-*-check.mjsと同じ作法。
// 実行: node tests/consent-contract-unavailable-check.mjs

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { chromiumLaunchOptions } from "./helpers/launch-chromium.mjs";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const INSTALL_DIR = path.join(ROOT, "install");

// downloadProduct()の実ファイル取得404によるページ遷移を避けるため、install/一式を
// 一時ディレクトリへコピーしダミーのvideo-shorts.zipを添える(consent-receipt-focus-check.mjs
// と同じ作法)。data-contract-available 等は一切書き換えず、実配布状態そのままで検証する。
function makeIsolatedInstallCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-consent-unavailable-"));
  for (const name of fs.readdirSync(INSTALL_DIR)) {
    fs.copyFileSync(path.join(INSTALL_DIR, name), path.join(dir, name));
  }
  fs.writeFileSync(path.join(dir, "video-shorts.zip"), "dummy");
  return dir;
}
const isolatedDir = makeIsolatedInstallCopy();
const htmlPath = path.join(isolatedDir, "consent.html");
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
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => {
    pageErrors.push(err);
    console.error("PAGE ERROR:", err.message);
  });
  await page.goto(filePath);
  await page.waitForTimeout(200);

  await t("前提: この画面は実配布状態(data-contract-available=falseを書き換えていない)である", async () => {
    const val = await page.evaluate(() => document.querySelector(".card")?.dataset.contractAvailable);
    assert.strictEqual(val, "false", `data-contract-available=${val}(この検証は実配布状態でなければ意味がない)`);
  });

  await t("確定本文が未提供である旨の警告が、ページ読み込み時点で既に表示されている", async () => {
    const visible = await page.evaluate(() => {
      const el = document.querySelector(".notice-unavailable");
      return !!el && el.offsetParent !== null && el.textContent.includes("確定本文");
    });
    assert.ok(visible, "警告文が見つからない、または非表示");
  });

  await t("ページ読み込み直後、#agree チェックボックスがdisabledである", async () => {
    const disabled = await page.evaluate(() => document.getElementById("agree").disabled);
    assert.strictEqual(disabled, true);
  });

  await t("名前を入力しても、#agree は disabled のままチェック操作を受け付けない", async () => {
    await page.fill("#name", "テスト太郎");
    await page.waitForTimeout(50);
    // disabled な checkbox は Playwright の check() 自体がタイムアウトで失敗するため、
    // 「実際にクリックしてもchecked状態が変化しないこと」を直接検証する(操作自体は許可する)。
    await page.click("#agree", { force: true, timeout: 2000 }).catch(() => {});
    const state = await page.evaluate(() => ({
      disabled: document.getElementById("agree").disabled,
      checked: document.getElementById("agree").checked,
    }));
    assert.strictEqual(state.disabled, true, "強制クリック後もdisabledのままであるべき");
    assert.strictEqual(state.checked, false, "disabledのチェックボックスがcheckedになってしまった");
  });

  await t("#start(同意してダウンロード)ボタンが、名前入力後も disabled のままである", async () => {
    const disabled = await page.evaluate(() => document.getElementById("start").disabled);
    assert.strictEqual(disabled, true, "#agreeが無効化されている以上、#startも有効化されてはならない");
  });

  await t("#start を強制クリックしても、ダウンロード開始の見た目(ボタン文言変化)は起きない", async () => {
    const before = await page.evaluate(() => document.getElementById("start").textContent);
    await page.click("#start", { force: true, timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => document.getElementById("start").textContent);
    assert.strictEqual(after, before, `#startの文言が変化した(同意が成立してしまった): before=${before} after=${after}`);
  });

  await t("実行中、ブラウザ側で読み込み・実行時エラーが発生していない(pageerrorが1件も無い)", async () => {
    assert.strictEqual(pageErrors.length, 0, `ブラウザ側で実行時エラーが発生した: ${pageErrors.map((e) => e.message).join(", ")}`);
  });

  await context.close();
  await browser.close();

  // ── 対照: CONTRACT_AVAILABLEゲートが無い旧実装は、この判定に落ちる ──
  await t("対照: ゲートが無い旧実装ではチェック・同意ボタンが有効化されてしまう", async () => {
    // 旧実装相当(#agreeにdisabled属性が無い状態)を模した最小HTMLで、同じ操作をしても
    // 「有効化されてしまう」ことを示す(壊れた挙動がこの判定で検出できることの確認)。
    const legacyBrowser = await chromium.launch(chromiumLaunchOptions());
    const legacyPage = await legacyBrowser.newPage();
    await legacyPage.setContent(
      `<input id="agree" type="checkbox"><button id="start" disabled>同意してダウンロード</button>
       <script>
         document.getElementById("agree").addEventListener("change", function () {
           document.getElementById("start").disabled = !this.checked;
         });
       </script>`,
    );
    await legacyPage.check("#agree");
    const startDisabled = await legacyPage.evaluate(() => document.getElementById("start").disabled);
    await legacyBrowser.close();
    assert.strictEqual(startDisabled, false, "旧実装相当のモデルでも有効化されなかった(対照の作り方を見直す必要がある)");
  });

  fs.rmSync(isolatedDir, { recursive: true, force: true });

  console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  fs.rmSync(isolatedDir, { recursive: true, force: true });
  process.exit(1);
});
