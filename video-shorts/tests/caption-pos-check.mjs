// tests/caption-pos-check.mjs — G-UI-CAPPOS（字幕の縦位置をプレビュー上で決める）
//
// マスター指示（2026-08-16）:
//   「字幕の位置をこの時点で決めたい。中央のスマホやPCの画面上であらかじめ設定できないか？」
//
// 値が通る鎖は次のとおりで、どこか1本切れると「画面で動かせるのに効かない」になる
// （顔モザイク・つなぎ目の間で実際に2回起きた形）。この検査は鎖の各段を独立に見る。
//
//   画面のつまみ(.cap-ghost) → state.captionPos → POST /api/jobs?captionPos=
//     → parseJobParams → buildRenderArgs → --caption-pos → resolveCaptionStyle(posPercent)
//     → buildAss の Style 行の MarginV / Alignment
//
// 【対照の置き方】どの段も「効いていないとき効いていないと言える」ことを同じ検査の中で示す。
//   ・位置を渡さない場合は変更前と同じ MarginV になること（＝退行していないことの裏返し）
//   ・ASS 仕様上 Alignment=5（画面中央）は MarginV を見ない。どのスタイルでも Alignment=2
//     でなければ「指定しても効かない」ので、それを検出する（2026-08-17 に Alignment=5 だった
//     "pop" プリセットを削除。中央基準の分岐が残っていないことを、全スタイルで確かめる）
//   ・parseJobParams は 0 を正当な値として通し、範囲外は undefined へ丸めること
//   ・buildRenderArgs は 0 を落とさないこと（truthy 判定だと 0 だけ黙って消える）
//
// 実行: node tests/caption-pos-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./helpers/launch-chromium.mjs";
import {
  CAPTION_POS_MAX,
  CAPTION_POS_MIN,
  SUBTITLE_STYLES,
  resolveCaptionStyle,
  scaleToken,
} from "../src/subtitle-styles.mjs";
import { buildAss } from "../src/srt-builder.mjs";
import { parseJobParams } from "../server/job-params.mjs";
import { buildRenderArgs } from "../server/pipeline-runner.mjs";
import { buildCaptionOverrides } from "../pipeline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE); // video-shorts/
const PORT = 5298;
const BASE = `http://127.0.0.1:${PORT}`;

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

const WORDS = [{ w: "あいうえお", s: 0, e: 1.2 }];

/** buildAss の出力から Caption スタイル行の Alignment と MarginV を取り出す。 */
export function readCaptionStyleRow(ass) {
  const line = ass.split("\n").find((l) => l.startsWith("Style: Caption,"));
  assert.ok(line, "Style: Caption 行が見つからない");
  const f = line.slice("Style: ".length).split(",");
  // Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,BorderStyle,
  //         Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
  return { align: Number(f[10]), marginV: Number(f[13]) };
}

function assFor(styleKey, overrides, H = 1920, W = 1080) {
  const st = resolveCaptionStyle(styleKey, overrides);
  return buildAss(WORDS, null, 1.2, { style: st, width: W, height: H });
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
      reject(new Error(`サーバが起動しない(20秒)。出力:\n${buf}`));
    }, 20000);
  });
}

(async () => {
  /* ══════ 1. 出力（.ass）に効いているか ══════ */

  await t("出力: 指定した％が、画面の高さに対する MarginV になる（縦1080x1920）", () => {
    for (const pct of [0, 12.5, 33, 90]) {
      const { marginV } = readCaptionStyleRow(assFor("karaoke", { posPercent: pct }));
      assert.strictEqual(marginV, Math.round(1920 * (pct / 100)), `pct=${pct} の MarginV が違う`);
    }
  });

  await t("出力: 横1920x1080 でも、％は画面の高さに対して解釈される", () => {
    const { marginV } = readCaptionStyleRow(assFor("karaoke", { posPercent: 25 }, 1080, 1920));
    assert.strictEqual(marginV, Math.round(1080 * 0.25), "横向きで％が高さ基準になっていない");
  });

  await t("出力: どのスタイルでも Alignment=2（下端基準）で、指定した位置がそのまま効く", () => {
    // ASS の Alignment=5（画面中央）は仕様上 MarginV を見ない。どれか1つのスタイルでも
    // 5 のままだと「画面で動かせるのに一切効かない」状態になるので、登録表の全スタイルで
    // 見る（2026-08-17 に Alignment=5 だった "pop" プリセットを削除した。中央基準の分岐が
    // どこかに残っていれば、ここで 5 として出る）。
    for (const key of Object.keys(SUBTITLE_STYLES)) {
      const moved = readCaptionStyleRow(assFor(key, { posPercent: 40 }));
      assert.strictEqual(moved.align, 2, `${key}: Alignment が 2 でない＝位置の指定が効かない`);
      assert.strictEqual(moved.marginV, Math.round(1920 * 0.4), `${key}: MarginV が指定どおりでない`);
    }
  });

  await t("出力: 背景帯も、指定した位置へ一緒に動く", () => {
    const draw = (pct) => {
      const ass = assFor("karaoke", { posPercent: pct, box: { enabled: true, colorHex: "#000000" } });
      const line = ass.split("\n").find((l) => l.includes("\\p1}"));
      assert.ok(line, "帯の描画行が見つからない");
      return Number(/\\pos\(\d+,(-?\d+)\)/.exec(line)[1]);
    };
    const low = draw(5);
    const high = draw(70);
    assert.ok(high < low, `位置を上げたのに帯が下がっている（low=${low} high=${high}）`);
  });

  await t("対照: 位置を指定しなければ、これまでどおりのプリセット既定値のまま", () => {
    for (const [key, preset] of Object.entries(SUBTITLE_STYLES)) {
      const { align, marginV } = readCaptionStyleRow(assFor(key, {}));
      // scaleToken は 0 を 1 へ持ち上げる（字幕が完全に消えるのを防ぐ既存の作法）ので、
      // 「変更前と同じ」の期待値もそれを通した値にする。
      assert.strictEqual(
        marginV,
        scaleToken(preset.marginV, 1),
        `${key}: 未指定なのに MarginV が変わっている`,
      );
      assert.strictEqual(align, 2, `${key}: 未指定なのに Alignment が変わっている`);
    }
  });

  await t("対照: 位置を指定した .ass と、しない .ass は実際に別物になる", () => {
    const withPos = readCaptionStyleRow(assFor("karaoke", { posPercent: 60 }));
    const without = readCaptionStyleRow(assFor("karaoke", {}));
    assert.notStrictEqual(withPos.marginV, without.marginV, "指定してもしなくても同じ＝効いていない");
  });

  await t("対照: 範囲外・数値でない位置は、黙って既定へ落とさず例外にする", () => {
    for (const bad of [-1, CAPTION_POS_MAX + 0.1, "abc", NaN, Infinity]) {
      assert.throws(
        () => resolveCaptionStyle("karaoke", { posPercent: bad }),
        /字幕の位置/,
        `不正値 ${String(bad)} が通ってしまっている`,
      );
    }
  });

  /* ══════ 2. サーバの受け口（parseJobParams）══════ */

  await t("受け口: 0 と 90（境界）は正当な指定として通る", () => {
    for (const v of [CAPTION_POS_MIN, CAPTION_POS_MAX, 33.5]) {
      const got = parseJobParams(new URLSearchParams({ captionPos: String(v) })).captionPos;
      assert.strictEqual(got, v, `captionPos=${v} が通らない`);
    }
  });

  await t("受け口: 範囲外・不正・未指定は undefined へ丸める（ジョブを失敗させない）", () => {
    for (const v of ["-1", "91", "abc", "", "  ", "__proto__", "Infinity", "NaN"]) {
      const got = parseJobParams(new URLSearchParams({ captionPos: v })).captionPos;
      assert.strictEqual(got, undefined, `captionPos="${v}" が丸められていない: ${got}`);
    }
    assert.strictEqual(parseJobParams(new URLSearchParams()).captionPos, undefined, "未指定が undefined でない");
  });

  /* ══════ 3. render への結線（buildRenderArgs）══════ */

  await t("結線: 受け口が返した値が、そのまま --caption-pos として render へ渡る", () => {
    for (const v of [0, 45, 90]) {
      const opts = parseJobParams(new URLSearchParams({ sub: "on", captionPos: String(v) }));
      const argv = buildRenderArgs("/p/pipeline.mjs", "/w", opts);
      const i = argv.indexOf("--caption-pos");
      assert.ok(i >= 0, `captionPos=${v} が argv に無い: ${argv.join(" ")}`);
      assert.strictEqual(argv[i + 1], String(v), `argv の値が違う: ${argv[i + 1]}`);
    }
  });

  await t("対照: 未指定のときは --caption-pos を付けない（既定を上書きしない）", () => {
    const opts = parseJobParams(new URLSearchParams({ sub: "on" }));
    const argv = buildRenderArgs("/p/pipeline.mjs", "/w", opts);
    assert.ok(!argv.includes("--caption-pos"), `未指定なのに argv に入っている: ${argv.join(" ")}`);
  });

  await t("結線: --caption-pos の値が resolveCaptionStyle の overrides まで届く", () => {
    // cmdRender は flagValue() で文字列として受け取るので、文字列のまま渡して確かめる。
    for (const v of ["0", "45", "90"]) {
      const ov = buildCaptionOverrides({ captionPos: v });
      assert.ok(ov, `captionPos="${v}" だけを指定したときに overrides が組み立てられない`);
      assert.strictEqual(ov.posPercent, Number(v), `posPercent が違う: ${ov.posPercent}`);
    }
  });

  await t("対照: 位置も他の見た目も未指定なら overrides を作らない（従来経路のまま）", () => {
    assert.strictEqual(buildCaptionOverrides({}), null, "何も指定していないのに overrides を作っている");
    assert.strictEqual(buildCaptionOverrides({ captionPos: "" }), null, "空文字を指定扱いにしている");
  });

  /* ══════ 4. 画面（実サーバ×実ブラウザ）══════ */

  const server = await startServer();
  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

  const GHOST = '#cap-ghost-phone';
  const ghostHidden = () => page.locator(GHOST).evaluate((e) => e.classList.contains("hidden"));
  const ghostBottom = () => page.locator(GHOST).evaluate((e) => e.style.bottom);

  await t("画面: 字幕「なし」のときは、位置のつまみが出ない", async () => {
    assert.strictEqual(await ghostHidden(), true, "字幕なしなのにつまみが出ている");
  });

  await t("画面: 字幕「あり」にすると、つまみが既定位置に出る", async () => {
    await page.click('[data-group="sub"] .chip[data-val="on"]');
    await page.waitForFunction(
      () => !document.querySelector("#cap-ghost-phone").classList.contains("hidden"),
      null,
      { timeout: 5000 },
    );
    // 既定位置は GET /api/env が src/subtitle-styles.mjs から計算して配る（画面に数値を
    // 書き写していないことの確認も兼ねる）。karaoke の marginV=360 / 1920 = 18.8%。
    const expected = Math.round((SUBTITLE_STYLES.karaoke.marginV / 1920) * 1000) / 10;
    assert.strictEqual(await ghostBottom(), `${expected}%`, "既定位置がプリセットと一致しない");
  });

  await t("画面: 矢印キーで位置が変わり、表示の数値も一緒に変わる", async () => {
    const before = await ghostBottom();
    await page.focus(GHOST);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    const after = await ghostBottom();
    assert.notStrictEqual(after, before, "矢印キーで動いていない");
    const shown = await page.locator('[data-testid="caption-pos-value"]').textContent();
    assert.ok(
      shown.includes(after.replace("%", "")),
      `表示の数値(${shown})とつまみの位置(${after})が食い違う`,
    );
  });

  await t("画面: 上下ドラッグで位置が変わる", async () => {
    const box = await page.locator(GHOST).boundingBox();
    const area = await page.locator("#video-area-phone").boundingBox();
    const before = await ghostBottom();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, area.y + area.height * 0.3, { steps: 8 });
    await page.mouse.up();
    const after = await ghostBottom();
    assert.notStrictEqual(after, before, "ドラッグで動いていない");
    assert.ok(parseFloat(after) > parseFloat(before), "上へ動かしたのに値が増えていない");
  });

  await t("画面: 決めた位置が POST /api/jobs のクエリに載る", async () => {
    const expected = (await ghostBottom()).replace("%", "");
    await page.setInputFiles("#file", {
      name: "t.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("x".repeat(64)),
    });
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/jobs") && r.method() === "POST", {
        timeout: 15000,
      }),
      (async () => {
        await page.click("#btn-run");
        await page.waitForSelector("#confirm-overlay:not(.hidden)");
        await page.click("#confirm-run");
      })(),
    ]);
    const sent = new URL(req.url()).searchParams.get("captionPos");
    assert.strictEqual(sent, expected, `送信値(${sent})と画面の位置(${expected})が食い違う`);
  });

  await t("画面: 「既定に戻す」を押すと、captionPos を送らなくなる", async () => {
    await page.reload({ waitUntil: "networkidle" });
    await page.click('[data-group="sub"] .chip[data-val="on"]');
    await page.focus(GHOST);
    await page.keyboard.press("ArrowUp");
    await page.click('[data-testid="caption-pos-reset"]');
    const sentAfterReset = await page.evaluate(() => {
      // run() と同じ走査規則（未指定＝空文字は送らない）で確かめる
      const el = document.querySelector("#cap-ghost-phone");
      return el.dataset.capPos;
    });
    assert.strictEqual(sentAfterReset, "", `既定に戻したのに値が残っている: "${sentAfterReset}"`);
  });

  await t("画面: 位置の操作でスクリプトエラーが1件も出ていない", () => {
    assert.deepStrictEqual(pageErrors, [], `ページ内エラー: ${pageErrors.join(" / ")}`);
  });

  await browser.close();
  server.kill("SIGKILL");

  console.log(`\n合計: PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
