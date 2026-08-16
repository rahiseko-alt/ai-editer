// tests/editing-mode-look-check.mjs — G-UI-EDITMODE（暗幕・動き・配線）
//
// マスター指示（2026-08-16）:
//   ①「編集モードになったら少し画面が暗くなって、編集中のみが少し明るめに表示されるようにしろ」
//   ②「編集中が動いているかどうかわからない、なにか動き付けろ。
//      リサーチしてシンプルなよくあるもので良いので付けろ」
//
// 【この検査が見ているもの】画面に実際に出た画素。CSS を書いたかどうかではない。
//   暗幕は「z-index を書いたか」ではなく「編集中に背景の画素が暗くなったか」で見る。
//   動きは「animation を書いたか」ではなく「時間をおいて撮った画素がどれだけ違うか」で見る。
//
// 【2026-08-16 basis-reviewer の反証を受けた改訂】旧版は次の3つの偽物を素通りさせた。
//   (1) 右の設定カラムだけ覆わない暗幕      → 3ペインすべてで測る（対照も追加）
//   (2) 動きを減らす設定のとき帯を見えなくする → 帯が描かれていることを条件に追加
//   (3) 幅1px の点が3px 動くだけの動き       → 変化量を帯の画素数の25%以上に
//   さらに、5葉とも window.showEditing() を直接呼ぶだけで「編集実行」ボタンからの配線を
//   誰も見ていなかったため、ボタン経路を通る葉(WIRED)を足した。
//
// 実行: node tests/editing-mode-look-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
const DIM_MAX_RATIO = 0.6;
// 編集中カードの中は白のまま（暗幕を被っていない）と言える下限。
const CARD_MIN_LUMA = 235;
// カードが背景よりはっきり明るいと言える差（0〜255 の輝度）。
const CARD_OVER_BG_MIN = 40;
// 動きの帯の最小の大きさ。これ未満は「人が見て分かる帯」ではない。
const BAR_MIN_W = 90;
const BAR_MIN_H = 3;
// 1周期をまたぐ6枚の総当たりで、いちばん違う組の変化量が帯の画素数に占める割合の下限。
// 実測 72.8% に対し約3倍の余裕。幅1px の点が3px 動くだけの偽物は 2% 程度で落ちる。
const MOTION_MIN_RATIO = 0.25;
// 動きを減らす設定のときでも、帯が描かれていると言える「地と違う画素」の割合の下限。
const BAR_INK_MIN_RATIO = 0.2;
// 3ペインそれぞれの測定点（画面の一部だけを暗くする実装を通さないため3か所固定）。
const PTS = {
  左: { x: 20, y: 260, width: 150, height: 110 },
  中央: { x: 230, y: 640, width: 120, height: 60 },
  右: { x: 600, y: 120, width: 200, height: 60 },
};

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

/** 6枚の総当たり15組のうち、いちばん違う組の変化画素数。 */
export function maxPairDiff(shots) {
  let max = 0;
  for (let i = 0; i < shots.length; i++) {
    for (let j = i + 1; j < shots.length; j++) {
      max = Math.max(max, countDiffPixels(shots[i], shots[j]));
    }
  }
  return max;
}

/** 6枚の総当たり15組すべての変化画素数。 */
export function allPairDiffs(shots) {
  const out = [];
  for (let i = 0; i < shots.length; i++) {
    for (let j = i + 1; j < shots.length; j++) out.push(countDiffPixels(shots[i], shots[j]));
  }
  return out;
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
      reject(new Error(`サーバが起動しない(30秒)。ポート${PORT}が空いているか確認する。出力:\n${buf}`));
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
  console.log(`[環境] Chromium ${browser.version()}`);

  /** 指定範囲を撮って RGB バッファで返す。 */
  const grab = async (p, clip) => {
    const f = path.join(tmp, `s${shotNo++}.png`);
    await p.screenshot({ path: f, clip });
    return readPixelsRgb(f);
  };
  /** 3ペインの測定点の明るさをまとめて採る。 */
  const lumas = async (p) => {
    const out = {};
    for (const k of Object.keys(PTS)) out[k] = meanLuma(await grab(p, PTS[k]));
    return out;
  };

  const context = await browser.newContext({ viewport: { width: 1365, height: 830 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

  /** 編集中カードの内側の余白（文字も帯も無い所）を測る範囲。 */
  const cardClip = async () => {
    const r = await page.evaluate(() => {
      const b = document.getElementById("editing-card").getBoundingClientRect();
      return { x: b.x, y: b.y };
    });
    return { x: Math.round(r.x + 8), y: Math.round(r.y + 6), width: 24, height: 8 };
  };

  const before = await lumas(page);
  await page.evaluate(() => window.showEditing());
  await page.waitForTimeout(500); // 暗幕のフェード(.25s)が終わるまで待つ
  const during = await lumas(page);
  const lumaCard = meanLuma(await grab(page, await cardClip()));
  const drop = (k) => (before[k] - during[k]) / before[k];
  console.log(
    "[実測] " +
      Object.keys(PTS)
        .map((k) => `${k} ${before[k].toFixed(1)}→${during[k].toFixed(1)}(${(drop(k) * 100).toFixed(1)}%)`)
        .join(" / ") +
      ` ／ カードの中=${lumaCard.toFixed(1)}`,
  );

  /* ══════ ① 暗幕：3ペインすべてが少し暗くなる ══════ */
  await t("DIM-BG: 編集中になると、左・中央・右のどこも画面が少し暗くなる", () => {
    for (const k of Object.keys(PTS)) {
      const d = drop(k);
      assert.ok(
        d >= DIM_MIN_RATIO,
        `${k}ペインが暗くなっていない: ${before[k].toFixed(1)} → ${during[k].toFixed(1)}（下がり ${(d * 100).toFixed(1)}%）`,
      );
      assert.ok(
        d <= DIM_MAX_RATIO,
        `${k}ペインを暗くしすぎ（「少し」ではない）: ${(d * 100).toFixed(1)}% > ${DIM_MAX_RATIO * 100}%`,
      );
    }
  });

  await t("DIM-CARD: 編集中カードの中は暗くならず、いちばん明るいペインよりさらに明るい", () => {
    assert.ok(
      lumaCard >= CARD_MIN_LUMA,
      `カードの中が暗い: ${lumaCard.toFixed(1)}（下限 ${CARD_MIN_LUMA}）＝暗幕がカードの上に掛かっている`,
    );
    const brightest = Math.max(...Object.values(during));
    assert.ok(
      lumaCard - brightest >= CARD_OVER_BG_MIN,
      `カードと背景の明るさの差が小さい: ${(lumaCard - brightest).toFixed(1)}（下限 ${CARD_OVER_BG_MIN}）`,
    );
  });

  await t("DIM-BG 対照: 暗幕を消すと3か所とも暗くならない（暗さの原因が暗幕である）", async () => {
    await page.evaluate(() => {
      document.getElementById("editing-scrim").style.display = "none";
    });
    await page.waitForTimeout(120);
    const l = await lumas(page);
    await page.evaluate(() => {
      document.getElementById("editing-scrim").style.display = "";
    });
    await page.waitForTimeout(120);
    for (const k of Object.keys(PTS)) {
      assert.ok(
        Math.abs(l[k] - before[k]) <= 2,
        `${k}: 暗幕を消しても暗いまま ${l[k].toFixed(1)}（編集前 ${before[k].toFixed(1)}）`,
      );
    }
  });

  await t("DIM-BG 対照: 右ペインだけ覆わない暗幕にすると落ちる（一部だけ暗い実装を通さない）", async () => {
    // basis-reviewer(2026-08-16) が旧基準を素通りさせた偽装そのもの。
    // 右ペインの実際の左端から右を覆わない暗幕にする（画面幅に依らず「右だけ明るい」を作る）。
    await page.evaluate(() => {
      const right = document.querySelector('[data-testid="pane-right"]').getBoundingClientRect();
      document.getElementById("editing-scrim").style.inset =
        `0 ${Math.round(window.innerWidth - right.left)}px 0 0`;
    });
    await page.waitForTimeout(150);
    const l = await lumas(page);
    await page.evaluate(() => {
      document.getElementById("editing-scrim").style.inset = "";
    });
    await page.waitForTimeout(150);
    const dRight = (before["右"] - l["右"]) / before["右"];
    assert.ok(
      dRight < DIM_MIN_RATIO,
      `右ペインを覆わない暗幕なのに右が暗いと判定された: 下がり ${(dRight * 100).toFixed(1)}%`,
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
    assert.ok(l < CARD_MIN_LUMA, `カードの上に暗幕を掛けても明るいまま: ${l.toFixed(1)}`);
  });

  /* ══════ ② 動き：人が見て分かる大きさで動く ══════ */
  const barRect = async (p) =>
    p.evaluate(() => {
      const b = document.getElementById("editing-bar").getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
    });
  /** 帯を 200ms 間隔で6枚撮る（1周期 1.15秒 をまたぐ）。 */
  const sampleBar = async (p) => {
    const clip = await barRect(p);
    const shots = [];
    for (let i = 0; i < 6; i++) {
      shots.push(await grab(p, clip));
      if (i < 5) await p.waitForTimeout(200);
    }
    return { clip, shots, pixels: shots[0].length / 3 };
  };

  await t("MOTION: 帯が十分な大きさで描かれ、人が見て分かる量だけ変化している", async () => {
    const r = await barRect(page);
    assert.ok(
      r.width >= BAR_MIN_W && r.height >= BAR_MIN_H,
      `帯が小さすぎる: ${r.width}x${r.height}（下限 ${BAR_MIN_W}x${BAR_MIN_H}）`,
    );
    const { shots, pixels } = await sampleBar(page);
    const max = maxPairDiff(shots);
    const ratio = max / pixels;
    console.log(`[実測] 帯 ${r.width}x${r.height}=${pixels}画素 / 総当たり最大の変化 ${max}画素 = ${(ratio * 100).toFixed(1)}%`);
    assert.ok(
      ratio >= MOTION_MIN_RATIO,
      `動きが小さすぎる: ${(ratio * 100).toFixed(1)}%（下限 ${MOTION_MIN_RATIO * 100}%）`,
    );
  });

  await t("MOTION 対照: 動きを止めると15組すべてが0になる（撮影のゆらぎを動きと誤認していない）", async () => {
    await page.addStyleTag({
      content: "#editing-bar .editing-bar-fill { animation: none !important; }",
    });
    await page.waitForTimeout(250);
    const { shots } = await sampleBar(page);
    const diffs = allPairDiffs(shots);
    await page.evaluate(() => document.querySelectorAll("style").forEach((s) => {
      if (s.textContent.includes("animation: none !important")) s.remove();
    }));
    assert.ok(
      diffs.every((d) => d === 0),
      `動きを止めたのに変化を拾っている: ${diffs.join(", ")}`,
    );
  });

  await t("MOTION 対照: 幅1pxの点が3px動くだけの動きは落ちる（人に気づけない動きを通さない）", async () => {
    // basis-reviewer(2026-08-16) が旧基準（変化>0）を素通りさせた偽装そのもの。
    await page.addStyleTag({
      content:
        "@keyframes __tiny { 0% { transform: translateX(0); } 100% { transform: translateX(3px); } }" +
        "#editing-bar .editing-bar-fill { width: 1px !important; animation: __tiny 1.15s linear infinite !important; }",
    });
    await page.waitForTimeout(250);
    const { shots, pixels } = await sampleBar(page);
    const ratio = maxPairDiff(shots) / pixels;
    await page.evaluate(() => document.querySelectorAll("style").forEach((s) => {
      if (s.textContent.includes("__tiny")) s.remove();
    }));
    assert.ok(
      ratio < MOTION_MIN_RATIO,
      `1pxの点が3px動くだけなのに合格した: ${(ratio * 100).toFixed(1)}%`,
    );
  });

  /* ══════ ③ 暗幕は編集が終われば消える ══════ */
  await t("DIM-CLEAR: 編集が終わると暗幕が消え、3か所とも明るさが元へ戻る", async () => {
    await page.evaluate(() => window.hideEditing());
    await page.waitForTimeout(700); // フェード(.25s)＋hidden 付与(300ms)を待つ
    const l = await lumas(page);
    for (const k of Object.keys(PTS)) {
      assert.ok(
        Math.abs(l[k] - before[k]) <= 2,
        `${k}: 暗幕が残っている ${l[k].toFixed(1)}（編集前 ${before[k].toFixed(1)}）`,
      );
    }
    const display = await page.evaluate(
      () => getComputedStyle(document.getElementById("editing-scrim")).display,
    );
    assert.strictEqual(display, "none", `暗幕の要素が残って操作を受け止めている: display=${display}`);
  });

  await t("DIM-CLEAR 対照: hidden を付けない実装だと display が none にならず落ちる", async () => {
    const display = await page.evaluate(async () => {
      const s = document.getElementById("editing-scrim");
      s.classList.remove("hidden"); // 「透明にするだけで要素は残す」実装を再現
      s.style.opacity = "0";
      const d = getComputedStyle(s).display;
      s.style.opacity = "";
      s.classList.add("hidden"); // 必ず戻す
      return d;
    });
    assert.notStrictEqual(display, "none", `要素が残っているのに none と読めている: ${display}`);
  });

  await t("表示の操作でスクリプトエラーが1件も出ていない", () => {
    assert.deepStrictEqual(pageErrors, [], `ページ内エラー: ${pageErrors.join(" / ")}`);
  });

  /* ══════ ④ 「編集実行」ボタンから暗幕と窓が出る（配線） ══════ */
  await t("WIRED: 動画を選んで「編集実行」→「実行する」を押すと、暗幕と編集中の窓が出る", async () => {
    const p = await context.newPage();
    // ジョブ本体（文字起こし〜書き出し）はこの葉の受入事実ではないので、POST は握って返さない。
    // run() は showEditing() を fetch より前に呼ぶため、配線の有無はこれで判定できる。
    await p.route("**/api/jobs?**", async (route) => {
      await new Promise((r) => setTimeout(r, 30000));
      await route.abort();
    });
    await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
    const mp4 = path.join(tmp, "tiny.mp4");
    spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=size=64x64:color=black:d=1",
      "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-shortest", "-t", "1", mp4]);
    await p.setInputFiles("#file", mp4);
    await p.waitForSelector("#btn-run:not([disabled])", { timeout: 5000 });
    await p.click("#btn-run");
    await p.waitForSelector("#confirm-run", { state: "visible", timeout: 5000 });
    await p.click("#confirm-run");
    const shown = await p.waitForFunction(
      () => {
        const s = document.getElementById("editing-scrim");
        const c = document.getElementById("editing-card");
        const ok = (el) => !el.classList.contains("hidden") && getComputedStyle(el).display !== "none";
        return ok(s) && ok(c);
      },
      undefined,
      { timeout: 3000 },
    ).then(() => true).catch(() => false);
    await p.close();
    assert.ok(shown, "ボタンから編集を始めたのに、暗幕と編集中の窓が出ない（run() からの配線が切れている）");
  });

  await t("WIRED 対照: showEditing を何もしない関数へ差し替えると落ちる（配線を見ている）", async () => {
    const p = await context.newPage();
    await p.route("**/api/jobs?**", async (route) => {
      await new Promise((r) => setTimeout(r, 30000));
      await route.abort();
    });
    await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await p.setInputFiles("#file", path.join(tmp, "tiny.mp4"));
    await p.waitForSelector("#btn-run:not([disabled])", { timeout: 5000 });
    // 「画面には足したが run() から呼んでいない」状態を再現する。app.js は普通のスクリプトなので
    // 関数宣言はグローバルオブジェクトの持ち物になり、ここへ代入すると run() の呼び先も変わる。
    await p.evaluate(() => {
      window.showEditing = () => {};
    });
    await p.click("#btn-run");
    await p.waitForSelector("#confirm-run", { state: "visible", timeout: 5000 });
    await p.click("#confirm-run");
    const shown = await p.waitForFunction(
      () => {
        const s = document.getElementById("editing-scrim");
        return !s.classList.contains("hidden") && getComputedStyle(s).display !== "none";
      },
      undefined,
      { timeout: 2000 },
    ).then(() => true).catch(() => false);
    await p.close();
    assert.ok(!shown, "配線が切れているのに暗幕が出たことになっている（配線を見ていない）");
  });

  await context.close();

  /* ══════ ⑤ 動きを止める設定の人には動かさないが、帯は見えている ══════ */
  await t("MOTION-REDUCED: 動きを止める設定では帯が動かず、しかも帯と「編集中」は見えている", async () => {
    const c2 = await browser.newContext({
      viewport: { width: 1365, height: 830 },
      reducedMotion: "reduce",
    });
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await p2.evaluate(() => window.showEditing());
    await p2.waitForTimeout(500);

    const clip = await barRect(p2);
    const shots = [];
    for (let i = 0; i < 6; i++) {
      shots.push(await grab(p2, clip));
      if (i < 5) await p2.waitForTimeout(200);
    }
    const diffs = allPairDiffs(shots);
    assert.ok(diffs.every((d) => d === 0), `動きを止める設定なのに動いている: ${diffs.join(", ")}`);

    // (b) 帯そのものが描かれて見えていること＝帯の画素のうち、カードの地と違うものの割合。
    const bg = await grab(p2, await (async () => {
      const r = await p2.evaluate(() => {
        const b = document.getElementById("editing-card").getBoundingClientRect();
        return { x: b.x, y: b.y };
      });
      return { x: Math.round(r.x + 8), y: Math.round(r.y + 6), width: 8, height: 4 };
    })());
    const bgRgb = [bg[0], bg[1], bg[2]];
    const barBuf = shots[0];
    let ink = 0;
    const n = barBuf.length / 3;
    for (let i = 0; i < n; i++) {
      const d =
        Math.abs(barBuf[i * 3] - bgRgb[0]) +
        Math.abs(barBuf[i * 3 + 1] - bgRgb[1]) +
        Math.abs(barBuf[i * 3 + 2] - bgRgb[2]);
      if (d >= 10) ink++;
    }
    const inkRatio = ink / n;
    console.log(`[実測] 動きを減らす設定: 帯の画素のうち地と違うもの ${(inkRatio * 100).toFixed(1)}%`);
    assert.ok(
      inkRatio >= BAR_INK_MIN_RATIO,
      `帯が描かれていない（動きを消した代わりに何も見えない）: ${(inkRatio * 100).toFixed(1)}%（下限 ${BAR_INK_MIN_RATIO * 100}%）`,
    );

    const title = await p2.evaluate(() => {
      const el = document.querySelector("#editing-card .editing-title");
      const r = el.getBoundingClientRect();
      return { text: el.textContent.trim(), w: r.width, h: r.height };
    });
    assert.strictEqual(title.text, "編集中", `「編集中」の文字が変わっている: ${title.text}`);
    assert.ok(title.w > 2 && title.h > 2, `「編集中」が見えていない: ${title.w}x${title.h}`);

    // 対照: 動きを減らす設定のときだけ帯を見えなくすると (b) が落ちること。
    await p2.addStyleTag({
      content: "@media (prefers-reduced-motion: reduce) { #editing-bar { visibility: hidden !important; } }",
    });
    await p2.waitForTimeout(200);
    const hidden = await grab(p2, clip);
    let ink2 = 0;
    for (let i = 0; i < n; i++) {
      const d =
        Math.abs(hidden[i * 3] - bgRgb[0]) +
        Math.abs(hidden[i * 3 + 1] - bgRgb[1]) +
        Math.abs(hidden[i * 3 + 2] - bgRgb[2]);
      if (d >= 10) ink2++;
    }
    assert.ok(
      ink2 / n < BAR_INK_MIN_RATIO,
      `帯を見えなくしたのに「描かれている」と判定された: ${((ink2 / n) * 100).toFixed(1)}%`,
    );
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
