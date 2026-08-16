// tests/card-frame-unify-check.mjs — G-UI-CARDFRAME（カードの枠の統一）
//
// マスター指示（2026-08-16）:
//   「UIがカードの枠があったりなかったりで統一感が無い。編集SaaSなどを参考にして統一感を出せ。」
//
// 【この検査が見ているもの】画面に出ている「まとまりを囲う入れ物」の枠が、
//   (1) 全部同じ描き方であること（線の太さ・線の種類・線の色・角丸・内側の余白・地の色）
//   (2) その入れ物の中に、別の枠を持つ入れ物が二重に入っていないこと
// 実際に効いている値（getComputedStyle の結果）で見るので、CSS のどこに書いたかは問わない。
// 「枠が無い」も不揃いの一種なので、(1) は太さ0を含めて全部同じかどうかで判定する
// （＝1つだけ枠が無ければ値が2種類になり落ちる）。
//
// 【対象の数え方】画面を開いた直後に見えている次のものすべて。個別に選ばず、構造で数える。
//   ・右ペイン直下の設定カード: [data-testid="pane-right"] > section
//   ・中央ペイン直下の情報カード: [data-testid="pane-center"] > .summary-wrap / > .actions-wrap
//
// 実行: node tests/card-frame-unify-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./helpers/launch-chromium.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE); // video-shorts/
const PORT = 5299;
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

/* ページ側で走らせる採取関数。ブラウザの中で完結させる（Node 側へは結果だけ返す）。 */

/** カードの枠の見た目を1本の文字列にまとめて返す（同じなら同じ文字列になる）。 */
const COLLECT_FRAMES = () => {
  const cards = [
    ...document.querySelectorAll('[data-testid="pane-right"] > section'),
    ...document.querySelectorAll(
      '[data-testid="pane-center"] > .summary-wrap, [data-testid="pane-center"] > .actions-wrap',
    ),
  ].filter((el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  });
  return cards.map((el) => {
    const s = getComputedStyle(el);
    return {
      id: el.id || el.className,
      sig: [
        s.borderTopWidth,
        s.borderRightWidth,
        s.borderBottomWidth,
        s.borderLeftWidth,
        s.borderTopStyle,
        s.borderTopColor,
        s.borderTopLeftRadius,
        s.paddingTop,
        s.paddingRight,
        s.paddingBottom,
        s.paddingLeft,
        s.backgroundColor,
      ].join("|"),
    };
  });
};

/** カードの中に「別の枠を持つ入れ物」が居ないかを調べる。操作するものは対象外。 */
const COLLECT_NESTED = () => {
  const CONTROL = "button, a, input, select, textarea, label, [role='button'], [role='slider'], [tabindex]";
  const cards = [
    ...document.querySelectorAll('[data-testid="pane-right"] > section'),
    ...document.querySelectorAll(
      '[data-testid="pane-center"] > .summary-wrap, [data-testid="pane-center"] > .actions-wrap',
    ),
  ];
  const shown = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  /** 透明でない線が1本でも引かれているか。 */
  const hasBorder = (s) => {
    const sides = ["Top", "Right", "Bottom", "Left"];
    return sides.some((k) => {
      const w = parseFloat(s[`border${k}Width`]);
      const style = s[`border${k}Style`];
      const color = s[`border${k}Color`];
      const transparent = color === "transparent" || /rgba\([^)]*,\s*0\)$/.test(color);
      return w > 0 && style !== "none" && style !== "hidden" && !transparent;
    });
  };
  const found = [];
  for (const card of cards) {
    if (!shown(card)) continue;
    const walk = (el) => {
      for (const child of el.children) {
        if (!shown(child)) continue;
        if (child.matches(CONTROL)) continue; // 操作するものとその中身は対象外
        if (hasBorder(getComputedStyle(child))) {
          found.push({ card: card.id || card.className, el: child.className || child.tagName });
        }
        walk(child);
      }
    };
    walk(card);
  }
  return found;
};

(async () => {
  const server = await startServer();
  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1365, height: 830 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

  await t("数えている対象が空でない（空振りで緑にしない）", async () => {
    const frames = await page.evaluate(COLLECT_FRAMES);
    assert.ok(frames.length >= 5, `見えているカードが少なすぎる: ${frames.length}枚`);
  });

  await t("FRAME-SAME: 見えているカードの枠が、1種類に揃っている", async () => {
    const frames = await page.evaluate(COLLECT_FRAMES);
    const sigs = new Map();
    for (const f of frames) {
      if (!sigs.has(f.sig)) sigs.set(f.sig, []);
      sigs.get(f.sig).push(f.id);
    }
    const detail = [...sigs.entries()].map(([sig, ids]) => `  ${ids.join(", ")}\n    → ${sig}`).join("\n");
    assert.strictEqual(sigs.size, 1, `枠の描き方が ${sigs.size} 種類ある:\n${detail}`);
  });

  /** 1枚のカードへ細工をしてから枠の種類数を数え、必ず元へ戻す。 */
  const countWithTweak = async (id, css) => {
    const before = await page.evaluate(
      ([i, c]) => {
        const el = document.getElementById(i);
        const prev = el.getAttribute("style") || "";
        el.style.cssText = prev + ";" + c;
        return prev;
      },
      [id, css],
    );
    await page.waitForTimeout(80); // 見た目が変わり切るのを待ってから数える
    const n = await page.evaluate((collect) => {
      return new Set(new Function(`return (${collect})()`)().map((f) => f.sig)).size;
    }, COLLECT_FRAMES.toString());
    await page.evaluate(
      ([i, prev]) => {
        document.getElementById(i).setAttribute("style", prev); // 必ず戻す
      },
      [id, before],
    );
    return n;
  };

  await t("FRAME-SAME 対照: 1枚だけ枠の色を変えると落ちる（違いの検出が効いている）", async () => {
    const size = await countWithTweak("card-sub", "border-color:#ff0000");
    assert.ok(size > 1, `1枚だけ色を変えたのに1種類のまま。違いを見ていない`);
  });

  await t("FRAME-SAME 対照: 1枚だけ枠を消しても落ちる（枠が無いのも不揃いとして拾う）", async () => {
    const size = await countWithTweak("card-size", "border:0");
    assert.ok(size > 1, `1枚だけ枠を消したのに1種類のまま。枠なしを見逃している`);
  });

  await t("FRAME-NONEST: カードの中に、別の枠を持つ入れ物が二重に入っていない", async () => {
    const found = await page.evaluate(COLLECT_NESTED);
    assert.deepStrictEqual(
      found,
      [],
      `カードの中にもう1枚の枠がある: ${found.map((f) => `${f.card} > ${f.el}`).join(" / ")}`,
    );
  });

  await t("FRAME-NONEST: 動画を選んだ後の表示でも、二重の枠が出ない", async () => {
    const found = await page.evaluate((collect) => {
      const bar = document.getElementById("filebar");
      const had = bar.classList.contains("hidden");
      bar.classList.remove("hidden");
      const r = new Function(`return (${collect})()`)();
      if (had) bar.classList.add("hidden"); // 必ず戻す
      return r;
    }, COLLECT_NESTED.toString());
    assert.deepStrictEqual(
      found,
      [],
      `動画を選んだ後に二重の枠が出る: ${found.map((f) => `${f.card} > ${f.el}`).join(" / ")}`,
    );
  });

  await t("FRAME-NONEST 対照: カードの中へ枠付きの箱を1つ入れると落ちる", async () => {
    const found = await page.evaluate((collect) => {
      const box = document.createElement("div");
      box.id = "__control_nested";
      box.style.cssText = "border:1px solid #000; padding:8px; height:20px;";
      document.getElementById("card-sub").appendChild(box);
      const r = new Function(`return (${collect})()`)();
      box.remove(); // 必ず戻す
      return r;
    }, COLLECT_NESTED.toString());
    assert.ok(found.length > 0, "カードの中に入れた枠付きの箱を検出できていない");
  });

  await t("画面を開いてスクリプトエラーが1件も出ていない", () => {
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
