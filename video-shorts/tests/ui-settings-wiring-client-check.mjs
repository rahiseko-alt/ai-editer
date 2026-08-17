// G-EDIT-UI-SETTINGS-WIRING-CLIENT — 実ブラウザで8設定を1つずつ操作し、実際の送信リクエストの
// クエリ文字列にその値が載ることを確認する(basis-reviewer反証1: app.jsのrun()が設定を手で
// 列挙していたため、新設定を足し忘れると実ブラウザからは一切送られない事故が過去2回発生していた)。
//
// 実行: node tests/ui-settings-wiring-client-check.mjs (ffmpeg必須。無ければexit 1)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ffmpegAvailable, makeSample, installFakePython, installFakeClaude, TOPIC_CLAUDE,
  startServer, stopServer, chromium, chromiumLaunchOptions,
} from "./helpers/ui-settings-e2e-harness.mjs";

const PORT = 59231; // このテスト専用の固定ポート

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.stack || e.message}`); }
}

// 8設定それぞれについて、既定以外の値をどう選ぶか(操作)と、送信クエリに現れるべきkey=valueの対。
const CASES = [
  {
    // 2026-08-17: 既定以外の値として使っていた "pop"（1語ずつポップ）は削除されたので "bold" を選ぶ。
    key: "subStyle", expectPair: "subStyle=bold",
    act: (page) => page.click('[data-group="subStyle"] .chip[data-val="bold"]'),
  },
  {
    key: "captionFont", expectPair: "captionFont=mincho",
    // 2026-08-16: 書体はチップからプルダウンへ変更（マスター指示④）
    act: (page) => page.selectOption('[data-group="captionFont"]', "mincho"),
  },
  {
    key: "captionFill", expectPair: "captionFill=%23ff0000",
    act: async (page) => { await page.fill("#caption-fill", "#ff0000"); await page.dispatchEvent("#caption-fill", "input"); },
  },
  {
    key: "captionOutlineColor", expectPair: "captionOutlineColor=%2300ff00",
    act: async (page) => { await page.fill("#caption-outline-color", "#00ff00"); await page.dispatchEvent("#caption-outline-color", "input"); },
  },
  {
    key: "captionInner", expectPair: "captionInner=%23ffff00",
    act: async (page) => {
      await page.click('[data-group="captionInner"] .chip[data-val="on"]');
      await page.fill("#caption-inner-color", "#ffff00");
      await page.dispatchEvent("#caption-inner-color", "input");
    },
  },
  {
    key: "captionBand", expectPair: "captionBand=%23000000",
    act: async (page) => {
      await page.click('[data-group="captionBand"] .chip[data-val="on"]');
      await page.fill("#caption-band-color", "#000000");
      await page.dispatchEvent("#caption-band-color", "input");
    },
  },
  {
    key: "durationMin", expectPair: "durationMin=2",
    act: async (page) => { await page.fill("#duration-min", "2"); await page.dispatchEvent("#duration-min", "input"); },
  },
  {
    key: "exportPreset", expectPair: "exportPreset=light",
    act: (page) => page.click('[data-group="exportPreset"] .chip[data-val="light"]'),
  },
];

let server = null, browser = null, tmp = null;
try {
  if (!(await ffmpegAvailable())) {
    console.log("ERROR: この検査は実ffmpegを必要とします(ffmpeg/ffprobeが見つかりません)。");
    process.exit(1);
  }

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-wiring-client-"));
  const sample = await makeSample(tmp);
  const fakePython = installFakePython();
  const fakeClaude = installFakeClaude("wiring-client", TOPIC_CLAUDE);
  const started = await startServer([fakeClaude.binDir, fakePython.binDir], PORT);
  server = started.child;

  browser = await chromium.launch(chromiumLaunchOptions());

  for (const c of CASES) {
    await t(`WIRING-CLIENT: ${c.key} を選ぶと実際の送信リクエストへ載る`, async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      let capturedUrl = null;
      page.on("request", (req) => {
        if (req.method() === "POST" && /\/api\/jobs\?/.test(req.url())) capturedUrl = req.url();
      });
      await page.goto(`http://127.0.0.1:${PORT}/`);
      await page.waitForSelector("#file", { state: "attached" });
      await page.setInputFiles("#file", { name: "sample.mp4", mimeType: "video/mp4", buffer: fs.readFileSync(sample) });
      // 字幕系の設定を検査する場合は先に「字幕あり」にしないと設定群が操作できない(CONDITIONAL-UI)。
      if (["subStyle", "captionFont", "captionFill", "captionOutlineColor", "captionInner", "captionBand"].includes(c.key)) {
        await page.click('[data-group="sub"] .chip[data-val="on"]');
      }
      await c.act(page);
      await page.click("#btn-run");
      // ジョブが実際に完走するまで待つ必要は無い(送信リクエストのURLだけを見る検査のため)。
      await page.waitForSelector("#confirm-overlay:not(.hidden)");
      await page.click("#confirm-run");
      await page.waitForTimeout(300); // POSTが飛ぶ猶予
      assert.ok(capturedUrl, "POST /api/jobs が送信されていない");
      assert.ok(capturedUrl.includes(c.expectPair), `送信URLに ${c.expectPair} が無い: ${capturedUrl}`);
      await context.close();
    });
  }

  // 対照: 何も選ばなければ、これら8キーは(空値なので)送信URLに現れない。
  await t("対照: 何も選ばなければ8つの新設定キーは送信URLに現れない", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    let capturedUrl = null;
    page.on("request", (req) => {
      if (req.method() === "POST" && /\/api\/jobs\?/.test(req.url())) capturedUrl = req.url();
    });
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector("#file", { state: "attached" });
    await page.setInputFiles("#file", { name: "sample.mp4", mimeType: "video/mp4", buffer: fs.readFileSync(sample) });
    await page.click("#btn-run");
    await page.waitForSelector("#confirm-overlay:not(.hidden)");
    await page.click("#confirm-run");
    await page.waitForTimeout(300);
    assert.ok(capturedUrl, "POST /api/jobs が送信されていない");
    // captionInner/captionBandは「off」自体が明示的な既定値(トグルの選択状態)であり、
    // 空文字列ではないためstateループでも常に送信される(off=off。サーバ側は未指定と同じに扱う)。
    // それ以外の6設定は未指定=空文字列のため送信URLに一切現れない。
    const ALWAYS_SENT_AT_DEFAULT = new Set(["captionInner", "captionBand"]);
    for (const c of CASES) {
      if (ALWAYS_SENT_AT_DEFAULT.has(c.key)) {
        assert.ok(capturedUrl.includes(`${c.key}=off`), `${c.key} は既定でも off として送られるはず: ${capturedUrl}`);
        continue;
      }
      const key = c.key + "=";
      assert.ok(!capturedUrl.includes(key), `未指定なのに ${c.key} が送信URLに現れている: ${capturedUrl}`);
    }
    await context.close();
  });
} finally {
  if (browser) await browser.close();
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
