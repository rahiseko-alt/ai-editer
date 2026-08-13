// 焼き直し(recaption)中は字幕編集UIがロックされることの検証(ブラウザ実測) — AUD-P1-12
//
// server/index.mjs 側のPUT拒否(409)はcaption-recaption-lock-check.mjsが実サーバー経由で
// 検証済み。このファイルは「UIが実際にロックを見せる」側、すなわちwebapp-mockup/app.js の
// capLocked による字幕入力欄のdisabled化を、実ブラウザ(Playwright/Chromium)でDOMを
// 直接観測して確認する(ソース読解だけでは「本当にレンダリング結果へ反映されるか」は
// 分からないため)。
//
// 【なぜ実サーバーを使わないか】このテストが検証したい対象はUIの状態遷移(焼き直し要求を
// 送った瞬間にinputへdisabledが付き、応答が返ったら外れる)だけであり、実際の文字起こし～
// レンダリングは不要。index.htmlをfile://で直接開き、window.fetchを差し替えて
// GET captions / POST recaption の応答を制御する(POST recaptionの解決タイミングは
// テスト側で明示的に握るPromiseにし、ロック中の状態を確実に観測できる窓を作る)。
//
// 実行: node tests/webapp-caption-recaption-lock-check.mjs   (全PASSで exit 0)

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

let browser = null;
try {
  browser = await chromium.launch(chromiumLaunchOptions());
  // result-overlay(モーダル)がデフォルトの小さいビューポートだと画面外へはみ出し、
  // Playwrightの通常のアクション(fill/click)がタイムアウトする(可視性・ビューポート内チェック
  // に失敗するため)。このテストの関心はモーダルの見た目ではなく字幕ロックの挙動なので、
  // 十分に大きいビューポートにしてこの問題自体を避ける。
  const context = await browser.newContext({ viewport: { width: 1280, height: 2000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  await page.goto(filePath);
  await page.waitForSelector("#caption-editor", { state: "attached" });

  // window.fetch を差し替える: GET captionsは固定の単語一覧、POST recaptionは
  // window.__recapGate が解決するまで待つ制御可能なPromiseにする(=「実行中」の窓を作る)。
  await page.evaluate(() => {
    window.__fetchCalls = [];
    window.__recapGate = new Promise((resolve) => { window.__resolveRecap = resolve; });
    window.fetch = async (url, init) => {
      const method = (init && init.method) || "GET";
      window.__fetchCalls.push({ url: String(url), method });
      if (String(url).includes("/captions") && method === "GET") {
        return {
          ok: true,
          json: async () => ({
            id: "lock-ui-test-job",
            words: [
              { index: 0, w: "もと", start: 0, end: 1, original: "もと", edited: false },
              { index: 1, w: "のじまく", start: 1, end: 2, original: "のじまく", edited: false },
            ],
            pairs: [],
          }),
        };
      }
      if (String(url).includes("/recaption") && method === "POST") {
        await window.__recapGate;
        return { ok: true, json: async () => ({ ok: true, rebuilt: 1 }) };
      }
      if (String(url).includes("/captions") && method === "PUT") {
        return { ok: true, json: async () => ({ ok: true, index: 0, before: "もと", after: "変更後" }) };
      }
      throw new Error(`このテストでは想定していないfetch呼び出し: ${method} ${url}`);
    };
  });

  // openCaptionEditor はトップレベル関数宣言（非モジュールscript）なのでグローバルに露出する。
  // #caption-editor は #result-overlay(モーダル)の内側にあるため、モーダル自体も開いた
  // 状態にしないとPlaywrightの可視性チェック(fill等)に引っかかる
  // (このテストの関心はモーダルの開閉ではなく字幕欄のロック挙動のため、直接hiddenを外す)。
  await page.evaluate(() => {
    /* global openCaptionEditor */
    document.getElementById("result-overlay").classList.remove("hidden");
    openCaptionEditor(
      { jobId: "lock-ui-test-job", jobToken: "dummy-token" },
      { h: "テスト区間", start: 0, end: 2 },
    );
  });

  await page.waitForSelector("#caption-words input[data-index]");

  await t("前提: 焼き直し開始前は字幕の入力欄が編集可能(disabledでない)", async () => {
    const disabled = await page.locator('#caption-words input[data-index="0"]').isDisabled();
    assert.strictEqual(disabled, false, "開始前から既にdisabledになっている");
  });

  // #result-overlay は本来GSAPアニメーション付きの開閉関数を経て画面内へ現れる。
  // このテストはその見た目の遷移ではなく字幕ロックの挙動が関心事であり、直接hiddenを
  // 外しただけの今の状態だとGSAPの初期transformが残ってPlaywrightのビューポート内判定に
  // 引っかかるため、実DOMのclick()を直接呼んで実際のイベントリスナーを発火させる
  // (これは #caption-rebake の click ハンドラをそのまま起動するので、見た目の位置に
  // 依存しない実質的に同じ検証になる)。
  await page.evaluate(() => document.getElementById("caption-rebake").click());

  // capLocked=trueの設定・再描画はfetch呼び出しの直前に同期的に行われるため、
  // fetchの解決を待たずに即座にdisabled状態を観測できるはず。
  await t("AUD-P1-12: 焼き直しを開始した直後、字幕の入力欄がdisabledになる(編集ロック)", async () => {
    const disabled = await page.locator('#caption-words input[data-index="0"]').isDisabled();
    assert.strictEqual(disabled, true, "焼き直し開始後もdisabledになっていない");
  });

  await t("AUD-P1-12: ロック中に入力欄を書き換えようとしても、Playwrightの通常操作(fill)は disabled により拒否される", async () => {
    await assert.rejects(
      () => page.locator('#caption-words input[data-index="1"]').fill("ロック中に書いた文字", { timeout: 1000 }),
      /disabled|Element is not enabled/i,
      "disabled要素のはずなのにfillが成功してしまった",
    );
  });

  await t("AUD-P1-12: 仮にdisabled属性を無視して値を書き換えても、changeイベントのJS側ロジックがcapLockedを見て保存させない(多層防御)", async () => {
    await page.evaluate(() => {
      const input = document.querySelector('#caption-words input[data-index="1"]');
      input.disabled = false; // 「disabled属性が何らかの理由で外れていた」ケースを模す
      input.value = "ロック中に無理やり書いた文字";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const puts = await page.evaluate(() => window.__fetchCalls.filter((c) => c.method === "PUT"));
    assert.strictEqual(puts.length, 0, `capLockedのJS側チェックを素通りしてPUTが送られている: ${JSON.stringify(puts)}`);
    // 再描画で元の値・disabled状態へ戻ることも確認する(壊れた入力値が残らない)。
    const disabledAgain = await page.locator('#caption-words input[data-index="1"]').isDisabled();
    assert.strictEqual(disabledAgain, true, "JS側ロックの再描画でdisabledへ戻っていない");
  });

  await t("AUD-P1-12: ロック中はPUT(/captions)が一度も送られていない(disabledによりchangeイベント自体が発火しない)", async () => {
    const puts = await page.evaluate(() => window.__fetchCalls.filter((c) => c.method === "PUT"));
    assert.strictEqual(puts.length, 0, `ロック中にPUTが送られている: ${JSON.stringify(puts)}`);
  });

  // 焼き直しの完了を許可する。
  await page.evaluate(() => window.__resolveRecap());
  await page.waitForFunction(() => {
    const el = document.querySelector('#caption-words input[data-index="0"]');
    return el && !el.disabled;
  }, { timeout: 5000 });

  await t("AUD-P1-12事後: 焼き直しが完了すると字幕の入力欄が再び編集可能に戻る", async () => {
    const disabled = await page.locator('#caption-words input[data-index="0"]').isDisabled();
    assert.strictEqual(disabled, false, "焼き直し完了後もdisabledのままになっている");
  });

  await t("焼き直し完了後は再びPUTを送って保存できる(恒久ロックではない)", async () => {
    // #result-overlay の実際の画面内配置(GSAP)を経ていないため、fill()の代わりに
    // 実DOM操作で値変更＋changeイベント発火を行う(app.js側は実イベントとして扱う)。
    await page.evaluate(() => {
      const input = document.querySelector('#caption-words input[data-index="0"]');
      input.value = "編集後";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(
      () => window.__fetchCalls.some((c) => c.method === "PUT"),
      { timeout: 3000 },
    );
    const puts = await page.evaluate(() => window.__fetchCalls.filter((c) => c.method === "PUT"));
    assert.strictEqual(puts.length, 1, `PUTが期待どおり1回送られていない: ${JSON.stringify(puts)}`);
  });

  await t("ブラウザ側で読み込み・実行時エラーが発生していない(pageerrorが1件も無い)", () => {
    assert.strictEqual(pageErrors.length, 0, `ブラウザ側で実行時エラーが発生した: ${pageErrors.map((e) => e.message).join(", ")}`);
  });

  await context.close();
} finally {
  if (browser) await browser.close();
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
