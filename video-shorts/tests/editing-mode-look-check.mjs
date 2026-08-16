// tests/editing-mode-look-check.mjs — G-UI-EDITMODE（暗幕・動き）
//
// マスター指示（2026-08-16）:
//   ①「編集モードになったら少し画面が暗くなって、編集中のみが少し明るめに表示されるようにしろ」
//   ②「編集中が動いているかどうかわからない、なにか動き付けろ。
//      リサーチしてシンプルなよくあるもので良いので付けろ」
//
// 【この検査が見ているもの】画面に実際に出た画素。CSS を書いたかどうかではない。
//   暗幕は「z-index を書いたか」ではなく「編集中に背景の画素が暗くなったか」で見る。
//   動きは「animation を書いたか」ではなく「時間をおいて撮った2枚の画素が違うか」で見る。
//   どちらも、書いただけで効いていない（別の要素に隠れている・上書きされている）状態を
//   通してしまわないため。
//
// 【明るさの測り方】Playwright で画面の一部を PNG に撮り、既存ヘルパ readPixelsRgb（ffmpeg で
// RGB へ展開）で画素を読む。明るさは輝度 Y = 0.2126R + 0.7152G + 0.0722B の平均（0〜255）。
//
// 実行: node tests/editing-mode-look-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./helpers/launch-chromium.mjs";
import { hasFfmpeg, readPixelsRgb, countDiffPixels } from "./helpers/caption-style-render.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE); // video-shorts/
const PORT = 5298;
const BASE = `http://127.0.0.1:${PORT}`;

// 「少し暗くなる」の範囲。下限=暗くなったと言える最小、上限=真っ暗にはしない（下の画面が読める）。
const DIM_MIN_RATIO = 0.08;
const DIM_MAX_RATIO = 0.60;
// 編集中カードの中は白のまま（暗幕を被っていない）と言える下限。
const CARD_MIN_LUMA = 235;
// カードが背景よりはっきり明るいと言える差（0〜255 の輝度）。
const CARD_OVER_BG_MIN = 40;

let pass = 0,
  fail = 0;
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

/** RGB raw バッファの平均輝度（0〜255）。 */
export function meanLuma(buf) {
  let sum = 0;
  const n = Math.floor(buf.length / 3);
  for (let i = 0; i < n; i++) {
    sum += 0.2126 * buf[i * 3] + 0.7152 * buf[i * 3 + 1] + 0.0722 * buf[i * 3 + 2];
  }
  return sum / n;
}

/** 実サーバ(server/index.mjs)を起動し、listening を確認してから返す。 */
function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let timer;
    const onData = (chunk) => {
      buf += String(chunk);
      if (buf.includes("server listening")) {
        clearTimeout(timer);
        resolve(proc);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", reject);
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`サーバが起動しない(30秒)。出力:\n${buf}`));
    }, 30000);
  });
}

(async () => {
  if (!hasFfmpeg()) {
    // 画素を読むのに ffmpeg が要る。無いときは SKIP で緑にせず落とす（偽の緑を作らない）。
    console.error("ffmpeg が見つかりません。この検査は画面の画素を実測するため ffmpeg が必要です。");
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "editing-mode-"));
  let shotNo = 0;
  const server = await startServer();
  const browser = await chromium.launch(chromiumLaunchOptions());

  /** 指定範囲を撮って RGB バッファで返す。 */
  const grab = async (page, clip) => {
    const p = path.join(tmp, `s${shotNo++}.png`);
    await page.screenshot({ path: p, clip });
    return readPixelsRgb(p);
  };

  const context = await browser.newContext({ viewport: { width: 1365, height: 830 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

  // 背景を測る場所＝左ペインの何も無い所（カードにも暗幕の外にも属さない地の色）。
  const BG_CLIP = { x: 20, y: 260, width: 150, height: 110 };
  /** 編集中カードの内側の余白（文字も帯も無い所）を測る範囲を、実際の位置から出す。 */
  const cardClip = async () => {
    const r = await page.evaluate(() => {
      const b = document.getElementById("editing-card").getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    });
    return { x: Math.round(r.x + 8), y: Math.round(r.y + 6), width: 24, height: 8 };
  };

  const lumaBefore = meanLuma(await grab(page, BG_CLIP));

  await page.evaluate(() => window.showEditing());
  await page.waitForTimeout(500); // 暗幕のフェード(.25s)が終わるまで待つ
  const lumaDuring = meanLuma(await grab(page, BG_CLIP));
  const lumaCard = meanLuma(await grab(page, await cardClip()));
  console.log(
    `[実測] 背景の明るさ 編集前=${lumaBefore.toFixed(1)} / 編集中=${lumaDuring.toFixed(1)}` +
      `（下がり ${(((lumaBefore - lumaDuring) / lumaBefore) * 100).toFixed(1)}%）、` +
      `カードの中=${lumaCard.toFixed(1)}`,
  );

  /* ══════ ① 暗幕：背景が少し暗くなる ══════ */
  await t("DIM-BG: 編集中になると、カードの外の画面が少し暗くなる", () => {
    const drop = (lumaBefore - lumaDuring) / lumaBefore;
    assert.ok(
      drop >= DIM_MIN_RATIO,
      `暗くなっていない: 編集前 ${lumaBefore.toFixed(1)} → 編集中 ${lumaDuring.toFixed(1)}（下がり ${(drop * 100).toFixed(1)}%）`,
    );
    assert.ok(
      drop <= DIM_MAX_RATIO,
      `暗くしすぎ（「少し」ではない）: 下がり ${(drop * 100).toFixed(1)}% > ${DIM_MAX_RATIO * 100}%`,
    );
  });

  await t("DIM-CARD: 編集中カードの中は暗くならず、背景よりはっきり明るい", () => {
    assert.ok(
      lumaCard >= CARD_MIN_LUMA,
      `カードの中が暗い: ${lumaCard.toFixed(1)}（下限 ${CARD_MIN_LUMA}）＝暗幕がカードの上に掛かっている`,
    );
    assert.ok(
      lumaCard - lumaDuring >= CARD_OVER_BG_MIN,
      `カードと背景の明るさの差が小さい: ${(lumaCard - lumaDuring).toFixed(1)}（下限 ${CARD_OVER_BG_MIN}）`,
    );
  });

  await t("DIM-BG 対照: 暗幕を消すと暗くならない（暗さを暗幕以外の理由で拾っていない）", async () => {
    await page.evaluate(() => {
      document.getElementById("editing-scrim").style.display = "none";
    });
    await page.waitForTimeout(120);
    const l = meanLuma(await grab(page, BG_CLIP));
    await page.evaluate(() => {
      document.getElementById("editing-scrim").style.display = "";
    });
    await page.waitForTimeout(120);
    assert.ok(
      Math.abs(l - lumaBefore) <= 2,
      `暗幕を消しても暗いまま: ${l.toFixed(1)}（編集前 ${lumaBefore.toFixed(1)}）。測っている暗さの原因が暗幕ではない`,
    );
  });

  await t("DIM-CARD 対照: 暗幕をカードより上へ出すとカードも暗くなる（明るさの検出が効いている）", async () => {
    await page.evaluate(() => {
      document.getElementById("editing-scrim").style.zIndex = "99";
    });
    await page.waitForTimeout(120);
    const l = meanLuma(await grab(page, await cardClip()));
    await page.evaluate(() => {
      document.getElementById("editing-scrim").style.zIndex = "";
    });
    await page.waitForTimeout(120);
    assert.ok(
      l < CARD_MIN_LUMA,
      `カードの上に暗幕を掛けても明るいまま: ${l.toFixed(1)}。カードの明るさを見ていない`,
    );
  });

  /* ══════ ② 動き：帯が動く ══════ */
  const barClip = async () => {
    const r = await page.evaluate(() => {
      const b = document.getElementById("editing-bar").getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    });
    assert.ok(r.w > 2 && r.h > 2, `動きを示す帯が描かれていない: ${r.w}x${r.h}`);
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) };
  };
  /** 帯を等間隔で3枚撮り、互いに異なる枚数の判定材料を返す。 */
  const sampleBar = async (p) => {
    const clip = await barClip();
    const shots = [];
    for (let i = 0; i < 3; i++) {
      shots.push(await grab(p, clip));
      if (i < 2) await p.waitForTimeout(260);
    }
    const diffs = [
      countDiffPixels(shots[0], shots[1]),
      countDiffPixels(shots[1], shots[2]),
      countDiffPixels(shots[0], shots[2]),
    ];
    return diffs;
  };

  await t("MOTION: 編集中カードの中の帯が、時間をおいて撮ると変わっている（止まって見えない）", async () => {
    const diffs = await sampleBar(page);
    assert.ok(
      diffs.some((d) => d > 0),
      `260ms 間隔の3枚がすべて同一。動いていない: 差の画素数 ${diffs.join(", ")}`,
    );
  });

  await t("MOTION 対照: 動きを止めると3枚が同一になる（変化の検出が効いている）", async () => {
    await page.addStyleTag({
      id: "__stop_motion",
      content: "#editing-bar .editing-bar-fill { animation: none !important; }",
    });
    await page.waitForTimeout(200);
    const diffs = await sampleBar(page);
    await page.evaluate(() => document.getElementById("__stop_motion")?.remove());
    assert.deepStrictEqual(
      diffs,
      [0, 0, 0],
      `動きを止めたのに変化を拾っている: ${diffs.join(", ")}。撮影のゆらぎを動きと誤認している`,
    );
  });

  /* ══════ ③ 暗幕は編集が終われば消える ══════ */
  await t("DIM-CLEAR: 編集が終わると暗幕が消え、画面の明るさが元へ戻る", async () => {
    await page.evaluate(() => window.hideEditing());
    await page.waitForTimeout(700); // フェード(.25s)＋hidden 付与(300ms)を待つ
    const l = meanLuma(await grab(page, BG_CLIP));
    assert.ok(
      Math.abs(l - lumaBefore) <= 2,
      `暗幕が残っている: 編集後 ${l.toFixed(1)}（編集前 ${lumaBefore.toFixed(1)}）`,
    );
    const shown = await page.evaluate(() => {
      const s = document.getElementById("editing-scrim");
      return { hidden: s.classList.contains("hidden"), display: getComputedStyle(s).display };
    });
    assert.strictEqual(shown.display, "none", `暗幕の要素が残って操作を受け止めている: ${JSON.stringify(shown)}`);
  });

  await t("表示の操作でスクリプトエラーが1件も出ていない", () => {
    assert.deepStrictEqual(pageErrors, [], `ページ内エラー: ${pageErrors.join(" / ")}`);
  });

  await context.close();

  /* ══════ ④ 動きを止める設定の人には動かさない ══════ */
  await t("MOTION-REDUCED: 動きを止める設定では帯が動かず、「編集中」は読めるまま", async () => {
    const c2 = await browser.newContext({
      viewport: { width: 1365, height: 830 },
      reducedMotion: "reduce",
    });
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await p2.evaluate(() => window.showEditing());
    await p2.waitForTimeout(500);

    const clip = await p2.evaluate(() => {
      const b = document.getElementById("editing-bar").getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
    });
    const shots = [];
    for (let i = 0; i < 3; i++) {
      shots.push(await grab(p2, clip));
      if (i < 2) await p2.waitForTimeout(260);
    }
    const diffs = [
      countDiffPixels(shots[0], shots[1]),
      countDiffPixels(shots[1], shots[2]),
      countDiffPixels(shots[0], shots[2]),
    ];
    assert.deepStrictEqual(diffs, [0, 0, 0], `動きを止める設定なのに動いている: ${diffs.join(", ")}`);

    const title = await p2.evaluate(() => {
      const el = document.querySelector("#editing-card .editing-title");
      const r = el.getBoundingClientRect();
      return { text: el.textContent.trim(), w: r.width, h: r.height };
    });
    assert.strictEqual(title.text, "編集中", `「編集中」の文字が変わっている: ${title.text}`);
    assert.ok(title.w > 2 && title.h > 2, `「編集中」が見えていない: ${title.w}x${title.h}`);
    await c2.close();
  });

  await browser.close();
  server.kill("SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n合計: PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
