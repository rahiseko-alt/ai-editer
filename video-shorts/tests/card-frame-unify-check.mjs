// tests/card-frame-unify-check.mjs — G-UI-CARDFRAME（カードの枠の統一）
//
// マスター指示（2026-08-16）:
//   「UIがカードの枠があったりなかったりで統一感が無い。編集SaaSなどを参考にして統一感を出せ。」
//
// 【この検査が見ているもの】
//   SAME    … 設定と情報のカードの枠が、どれも同じ描き方であること
//   NONEST  … そのカードの中に、別の枠を持つ入れ物が二重に入っていないこと
//   OVERLAY … 画面に浮く窓（編集中・編集できません・確認）と編集済み動画一覧のパネルも同じ枠であること
// 実際に効いている値（getComputedStyle の結果）で見るので、CSS のどこに書いたかは問わない。
//
// 【2026-08-16 basis-reviewer の反証を受けた改訂】旧版は次の2つの偽物を素通りさせた。
//   (1) 初めは隠れているカード（字幕の見た目）だけを別の枠にする
//       → 隠れているカードも、測るあいだだけ表示させて数える
//   (2) 枠付きの箱に tabindex="-1" を足して二重枠の検査を逃げる
//       → 除外を「本当に操作するもの」に限り（tabindex は 0 以上のみ）、除外要素の子孫も歩く
//   さらに、マスターの指示は画面全体なのに右ペインと中央2枚しか見ていなかったため、
//   浮く窓とパネルを見る OVERLAY を足した。
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
const MIN_CARDS = 10; // 空振りで緑にしないための下限（右ペイン10枚＋中央2枚が実測）

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
      reject(new Error(`サーバが起動しない(30秒)。ポート${PORT}が空いているか確認する。出力:\n${buf}`));
    }, 30000);
  });
}

/* ── ページ側で走らせる採取関数（ブラウザの中で完結させ、Node へは結果だけ返す）── */

/**
 * カードの枠の見た目を1本の文字列にまとめて返す。
 * 隠れているカードは、測るあいだだけ表示させる（隠れている間だけ別の枠にする抜け道を塞ぐ）。
 */
const COLLECT_FRAMES = () => {
  const sel =
    '[data-testid="pane-right"] > section, [data-testid="pane-center"] > .summary-wrap, [data-testid="pane-center"] > .actions-wrap';
  const cards = [...document.querySelectorAll(sel)];
  const restore = [];
  for (const el of cards) {
    if (getComputedStyle(el).display === "none") {
      restore.push([el, el.style.display]);
      el.style.display = "flex";
    }
  }
  const out = cards.map((el) => {
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
  for (const [el, prev] of restore) el.style.display = prev; // 必ず戻す
  return out;
};

/** カードの中に「別の枠を持つ入れ物」が居ないかを調べる。本当に操作するものだけを対象外にする。 */
const COLLECT_NESTED = () => {
  const sel =
    '[data-testid="pane-right"] > section, [data-testid="pane-center"] > .summary-wrap, [data-testid="pane-center"] > .actions-wrap';
  const cards = [...document.querySelectorAll(sel)];
  /** 操作するものか。tabindex は 0 以上（キーボードで選べる）だけを操作扱いにする。 */
  const isControl = (el) => {
    if (el.matches("button, a[href], input, select, textarea, [role='button'], [role='slider']")) return true;
    const ti = el.getAttribute("tabindex");
    return ti !== null && Number(ti) >= 0;
  };
  const shown = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  /** 透明でない線が1辺でも引かれているか。 */
  const hasBorder = (s) => {
    return ["Top", "Right", "Bottom", "Left"].some((k) => {
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
        // 操作するものは「枠が操作対象を示す」ので枠の有無は問わないが、
        // その中身は歩き続ける（除外要素の下へ枠付きの箱を隠す抜け道を塞ぐ）。
        if (!isControl(child) && hasBorder(getComputedStyle(child))) {
          found.push({ card: card.id || card.className, el: child.className || child.tagName });
        }
        walk(child);
      }
    };
    walk(card);
  }
  return found;
};

/** 浮く窓・パネルの枠5項目と、比較元のカード(#card-sub)の枠5項目を返す。 */
const COLLECT_OVERLAY = () => {
  const five = (el) => {
    const s = getComputedStyle(el);
    return [s.borderTopWidth, s.borderTopStyle, s.borderTopColor, s.borderTopLeftRadius, s.backgroundColor].join("|");
  };
  const ids = ["editing-card", "cantedit-card", "confirm-modal", "result-panel"];
  const restore = [];
  const out = [];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) {
      out.push({ id, missing: true });
      continue;
    }
    const had = el.classList.contains("hidden");
    if (had) el.classList.remove("hidden");
    restore.push([el, had]);
    out.push({ id, sig: five(el) });
  }
  for (const [el, had] of restore) if (had) el.classList.add("hidden"); // 必ず戻す
  return { base: five(document.getElementById("card-sub")), items: out };
};

/** 半透明（rgba の alpha が 1 未満）の地の色を含むか。 */
export function hasTranslucentBg(sig) {
  const m = String(sig).match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/g) || [];
  return m.some((x) => Number(x.match(/,\s*([\d.]+)\s*\)$/)[1]) < 1);
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch(chromiumLaunchOptions());
  console.log(`[環境] Chromium ${browser.version()}`);
  const context = await browser.newContext({ viewport: { width: 1365, height: 830 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

  /** ページ側の採取関数を、細工をしてから走らせる（細工は必ず元へ戻す）。 */
  const framesWith = async (id, css) => {
    const prev = await page.evaluate(
      ([i, c]) => {
        const el = document.getElementById(i);
        const before = el.getAttribute("style") || "";
        el.style.cssText = before + ";" + c;
        return before;
      },
      [id, css],
    );
    await page.waitForTimeout(80); // 見た目が変わり切るのを待ってから数える
    const n = await page.evaluate(
      (collect) => new Set(new Function(`return (${collect})()`)().map((f) => f.sig)).size,
      COLLECT_FRAMES.toString(),
    );
    await page.evaluate(([i, p]) => document.getElementById(i).setAttribute("style", p), [id, prev]);
    return n;
  };

  await t("数えている対象が十分ある（空振りで緑にしない）", async () => {
    const frames = await page.evaluate(COLLECT_FRAMES);
    console.log(`[実測] 数えたカード ${frames.length}枚: ${frames.map((f) => f.id).join(", ")}`);
    assert.ok(frames.length >= MIN_CARDS, `カードが少なすぎる: ${frames.length}枚（下限 ${MIN_CARDS}）`);
  });

  await t("FRAME-SAME: 隠れているカードも含め、枠が1種類に揃っている", async () => {
    const frames = await page.evaluate(COLLECT_FRAMES);
    const sigs = new Map();
    for (const f of frames) {
      if (!sigs.has(f.sig)) sigs.set(f.sig, []);
      sigs.get(f.sig).push(f.id);
    }
    const detail = [...sigs.entries()].map(([sig, ids]) => `  ${ids.join(", ")}\n    → ${sig}`).join("\n");
    assert.strictEqual(sigs.size, 1, `枠の描き方が ${sigs.size} 種類ある:\n${detail}`);
  });

  await t("FRAME-SAME 対照: 1枚だけ枠の色を変えると落ちる", async () => {
    assert.ok((await framesWith("card-sub", "border-color:#ff0000")) > 1, "違いを見ていない");
  });

  await t("FRAME-SAME 対照: 1枚だけ枠を消しても落ちる（枠なしも不揃いとして拾う）", async () => {
    assert.ok((await framesWith("card-size", "border:0")) > 1, "枠なしを見逃している");
  });

  await t("FRAME-SAME 対照: 初めは隠れているカードだけ別の枠にしても落ちる", async () => {
    // basis-reviewer(2026-08-16) が旧基準を素通りさせた偽装そのもの。
    const n = await framesWith(
      "card-caption-style",
      "border:4px dashed #ff0000;border-radius:0;padding:28px;background:#ffeeee",
    );
    assert.ok(n > 1, "隠れているカードの不揃いを見逃している");
  });

  await t("FRAME-NONEST: カードの中に、別の枠を持つ入れ物が二重に入っていない", async () => {
    const found = await page.evaluate(COLLECT_NESTED);
    assert.deepStrictEqual(found, [], `二重の枠: ${found.map((f) => `${f.card} > ${f.el}`).join(" / ")}`);
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
    assert.deepStrictEqual(found, [], `二重の枠: ${found.map((f) => `${f.card} > ${f.el}`).join(" / ")}`);
  });

  /** カードの中へ枠付きの箱を1つ差し込み、検出されるかを見る（属性を変えて2通り）。 */
  const nestedWithBox = async (attrs) => {
    const found = await page.evaluate(
      ([collect, a]) => {
        const box = document.createElement("div");
        box.id = "__control_nested";
        box.setAttribute("style", "border:1px solid #000; padding:8px; height:20px;");
        for (const [k, v] of Object.entries(a)) box.setAttribute(k, v);
        document.getElementById("card-sub").appendChild(box);
        const r = new Function(`return (${collect})()`)();
        box.remove(); // 必ず戻す
        return r;
      },
      [COLLECT_NESTED.toString(), attrs],
    );
    return found.length;
  };

  await t("FRAME-NONEST 対照: 枠付きの箱を差し込むと検出される", async () => {
    assert.ok((await nestedWithBox({})) > 0, "差し込んだ箱を検出できていない");
  });

  await t("FRAME-NONEST 対照: その箱に tabindex=\"-1\" を付けても検出される", async () => {
    // basis-reviewer(2026-08-16) が旧基準を素通りさせた偽装そのもの。
    assert.ok((await nestedWithBox({ tabindex: "-1" })) > 0, "tabindex=\"-1\" で逃げられている");
  });

  await t("FRAME-OVERLAY: 浮く窓3つと一覧のパネルも、設定カードと同じ枠になっている", async () => {
    const { base, items } = await page.evaluate(COLLECT_OVERLAY);
    console.log(`[実測] 比較元 #card-sub: ${base}`);
    for (const it of items) {
      assert.ok(!it.missing, `${it.id} が画面に無い`);
      console.log(`[実測] ${it.id}: ${it.sig}`);
    }
    assert.ok(!hasTranslucentBg(base), `比較元の地が半透明: ${base}`);
    for (const it of items) {
      assert.strictEqual(it.sig, base, `${it.id} の枠が設定カードと違う:\n    ${it.sig}\n    ${base}`);
    }
  });

  await t("FRAME-OVERLAY 対照: 編集中の窓の角丸だけ 14px に戻すと落ちる", async () => {
    const same = await page.evaluate(
      ([collect]) => {
        const el = document.getElementById("editing-card");
        const prev = el.getAttribute("style") || "";
        el.style.cssText = prev + ";border-radius:14px";
        const r = new Function(`return (${collect})()`)();
        el.setAttribute("style", prev); // 必ず戻す
        return r.items.every((i) => i.sig === r.base);
      },
      [COLLECT_OVERLAY.toString()],
    );
    assert.ok(!same, "角丸の違いを見逃している");
  });

  await t("対照: 半透明の地を見分けられている", () => {
    assert.ok(hasTranslucentBg("1px|solid|rgb(0,0,0)|12px|rgba(255, 255, 255, 0.97)"), "半透明を見逃している");
    assert.ok(!hasTranslucentBg("1px|solid|rgb(0,0,0)|12px|rgb(255, 255, 255)"), "不透明を半透明と誤判定している");
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
