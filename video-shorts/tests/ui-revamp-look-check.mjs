// tests/ui-revamp-look-check.mjs — G-UI-REVAMP-LOOK の5葉を実サーバ×実ブラウザで検証する。
//
//   G-UI-REVAMP-LOOK-WHITE     画面の地が真っ白で、色のついたベールが掛かっていない
//   G-UI-REVAMP-LOOK-RULE      3つの列の境目が、色の違いではなく細い線で分かれている
//   G-UI-REVAMP-LOOK-HEADER    ヘッダーから「無料版」「有料版はこちら」が消えている
//   G-UI-REVAMP-LOOK-CONTRAST  文字とボタンが白背景の上でしっかり読める濃さになっている
//   G-UI-REVAMP-LOOK-3PANE     PCで開くと左=手順・中央=動画・右=設定の3列が同じ高さで並ぶ
//
// 【WHITE が背景色だけを見ては駄目な理由（2026-08-15 の実物）】
// 刷新前は styles.css の body::before に radial-gradient 3枚のベールが全面に敷かれていた。
// これは getComputedStyle().backgroundColor には一切現れないため、下地の色だけ白に書き換えても
// 「白」と判定できてしまう。そこで (a) 実効背景色 と (b) background-image が none であること、の
// 2つを両方見る。対照では実際にベールを注入し、(a) は通るのに (b) だけが落ちることを実測する。
//
// 【対照（偽実装）の置き方】ファイルを書き換えて手で戻す方式は戻し忘れると検査が嘘になるため、
// 対照は検査の中で注入してコミットに残す（誰が何回実行しても同じ合否になる）。
//
// 実行: node tests/ui-revamp-look-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./helpers/launch-chromium.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const PORT = 5292;
const BASE = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 800 };

/** アクセント色（マスター承認済み #0d1117）と、各チャンネルの許容差 */
const ACCENT = { r: 13, g: 17, b: 23 };
const ACCENT_TOLERANCE = 8;

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
    const onData = (c) => {
      buf += String(c);
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

/* ── WCAG 2.1 コントラスト比（対照にも同じ関数を使う）───────────────────── */
export function parseRgb(s) {
  const m = String(s).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3] };
}
function luminance({ r, g, b }) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
/** 境目の罫線として認める太さか（実測にも対照にも同じ関数を使う） */
export function ruleWidthOk(width) {
  return width >= 1 && width <= 2;
}
export function contrastRatio(fg, bg) {
  const a = luminance(fg),
    b = luminance(bg);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

  // ページ側の共通ヘルパを注入（実効背景色 / 背景画像の走査）
  await page.addScriptTag({
    content: `
      window.__effBg = (el) => {
        let c = el;
        while (c) {
          const bg = getComputedStyle(c).backgroundColor;
          if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
          c = c.parentElement;
        }
        return "rgb(255, 255, 255)";
      };
      window.__scanBgImages = () => {
        const ids = ["app-header","pane-left","pane-center","pane-right"];
        const roots = [document.documentElement, document.body,
          ...ids.map(i => document.querySelector('[data-testid="'+i+'"]')).filter(Boolean)];
        const seen = new Set(); const hits = [];
        for (const root of roots) {
          for (const el of [root, ...root.querySelectorAll("*")]) {
            if (seen.has(el)) continue; seen.add(el);
            if (el.closest && el.closest("#result-overlay")) continue;
            for (const pe of [null, "::before", "::after"]) {
              const bi = getComputedStyle(el, pe).backgroundImage;
              if (bi && bi !== "none") {
                hits.push((el.id || el.tagName.toLowerCase()) + (pe || "") + " => " + bi.slice(0, 70));
              }
            }
          }
        }
        return hits;
      };
    `,
  });

  /* ══════ LOOK-WHITE ══════ */
  await t("LOOK-WHITE (a): ヘッダーと3ペインの実効背景色が rgb(255,255,255)", async () => {
    const bg = await page.evaluate(() => {
      const ids = ["app-header", "pane-left", "pane-center", "pane-right"];
      return Object.fromEntries(
        ids.map((i) => {
          const el = document.querySelector(`[data-testid="${i}"]`);
          return [i, el ? window.__effBg(el) : "MISSING"];
        }),
      );
    });
    for (const [k, v] of Object.entries(bg)) {
      assert.strictEqual(v, "rgb(255, 255, 255)", `${k} の実効背景色が白でない: ${v}`);
    }
  });

  await t("LOOK-WHITE (b): html/body/4領域とその子孫に background-image が無い", async () => {
    const hits = await page.evaluate(() => window.__scanBgImages());
    assert.deepStrictEqual(hits, [], `背景画像・グラデーションが残っている:\n      ${hits.join("\n      ")}`);
  });

  await t("LOOK-WHITE 対照: 刷新前のベールを注入すると (a) は通るのに (b) だけが落ちる", async () => {
    // 2026-08-15 時点の webapp-mockup/styles.css:106-113 と同じベールを body::before へ注入する
    const veilTag = await page.addStyleTag({
      content: `body::before {
        content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
        background:
          radial-gradient(ellipse 60% 45% at 12% 88%, rgba(77,122,77,.11), transparent 62%),
          radial-gradient(ellipse 55% 42% at 88% 8%, rgba(193,170,140,.11), transparent 58%),
          radial-gradient(ellipse 48% 42% at 72% 96%, rgba(120,150,170,.06), transparent 60%);
      }`,
    });
    const after = await page.evaluate(() => {
      const ids = ["app-header", "pane-left", "pane-center", "pane-right"];
      const bgs = ids.map((i) => window.__effBg(document.querySelector(`[data-testid="${i}"]`)));
      return { bgs, hits: window.__scanBgImages() };
    });
    // (a) は素通りする＝背景色だけを見る検査ではベールを検出できないことの実証
    assert.ok(
      after.bgs.every((v) => v === "rgb(255, 255, 255)"),
      `対照の前提が崩れている（(a) がベールを検出してしまった）: ${after.bgs.join(", ")}`,
    );
    // (b) が捕まえる
    assert.ok(after.hits.length > 0, "ベールを注入したのに (b) が検出できていない（偽の緑の経路）");
    await veilTag.evaluate((el) => el.remove());
    const restored = await page.evaluate(() => window.__scanBgImages());
    assert.deepStrictEqual(restored, [], "対照の後始末に失敗（ベールが残っている）");
  });

  /* ══════ LOOK-RULE ══════ */
  await t("LOOK-RULE: 列の境目に 1〜2px の罫線があり、白との差が見て取れる", async () => {
    const rules = await page.evaluate(() => {
      const g = (s) => document.querySelector(`[data-testid="${s}"]`);
      const read = (el, side) => {
        const cs = getComputedStyle(el);
        return { width: parseFloat(cs[`border${side}Width`]), color: cs[`border${side}Color`] };
      };
      return [read(g("pane-left"), "Right"), read(g("pane-center"), "Right")];
    });
    for (const [i, r] of rules.entries()) {
      assert.ok(ruleWidthOk(r.width), `境目${i + 1}の罫線の太さが範囲外: ${r.width}px`);
      const c = parseRgb(r.color);
      assert.ok(c, `境目${i + 1}の罫線色が読めない: ${r.color}`);
      const ratio = contrastRatio(c, { r: 255, g: 255, b: 255 });
      assert.ok(ratio >= 1.5, `境目${i + 1}の罫線が白と見分けられない: ${ratio.toFixed(2)}:1`);
    }
  });

  await t("LOOK-RULE 対照: 罫線なし・白い罫線のどちらも不合格になる", () => {
    assert.ok(!ruleWidthOk(0), "罫線なし(0px)を合格にしてしまっている");
    assert.ok(!ruleWidthOk(3), "太すぎる罫線(3px)を合格にしてしまっている");
    const white = contrastRatio({ r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 });
    assert.ok(white < 1.5, `白い罫線を合格にしてしまっている: ${white.toFixed(2)}:1`);
  });

  /* ══════ LOOK-HEADER ══════ */
  await t("LOOK-HEADER: ヘッダーに「無料版」「有料版」もそれへのリンクも無い", async () => {
    const h = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="app-header"]');
      if (!el) return null;
      return {
        text: el.textContent,
        paidLinks: [...el.querySelectorAll("a")].filter(
          (a) => /^https?:/.test(a.getAttribute("href") || "") || a.textContent.includes("有料"),
        ).length,
      };
    });
    assert.ok(h !== null, "data-testid=app-header が見つからない");
    assert.ok(!h.text.includes("無料版"), `ヘッダーに「無料版」が残っている: ${h.text.trim()}`);
    assert.ok(!h.text.includes("有料版"), `ヘッダーに「有料版」が残っている: ${h.text.trim()}`);
    assert.strictEqual(h.paidLinks, 0, "ヘッダーに有料版へのリンクが残っている");
  });

  await t("LOOK-HEADER 対照: 刷新前の表示を戻すと検出される", async () => {
    const detected = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="app-header"]');
      const badge = document.createElement("span");
      badge.textContent = "無料版";
      const link = document.createElement("a");
      link.href = "https://example.com/pro";
      link.textContent = "有料版はこちら →";
      el.append(badge, link);
      const r = {
        free: el.textContent.includes("無料版"),
        paid: el.textContent.includes("有料版"),
        links: [...el.querySelectorAll("a")].filter((a) => /^https?:/.test(a.getAttribute("href") || "")).length,
      };
      badge.remove();
      link.remove();
      return r;
    });
    assert.ok(detected.free && detected.paid && detected.links > 0, "刷新前の表示を検出できていない");
  });

  /* ══════ LOOK-CONTRAST ══════ */
  await t("LOOK-CONTRAST: 主ボタンの色がニアブラックで、文字が 4.5:1 以上", async () => {
    const btns = await page.evaluate(() => {
      const out = {};
      for (const id of ["btn-run", "btn-pick-file"]) {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) {
          out[id] = null;
          continue;
        }
        const cs = getComputedStyle(el);
        out[id] = { color: cs.color, bg: window.__effBg(el) };
      }
      return out;
    });
    for (const [id, v] of Object.entries(btns)) {
      assert.ok(v, `${id} が見つからない`);
      const bg = parseRgb(v.bg);
      for (const ch of ["r", "g", "b"]) {
        assert.ok(
          Math.abs(bg[ch] - ACCENT[ch]) <= ACCENT_TOLERANCE,
          `${id} の背景がニアブラックから外れている(${ch}): ${v.bg}`,
        );
      }
      const ratio = contrastRatio(parseRgb(v.color), bg);
      assert.ok(ratio >= 4.5, `${id} の文字のコントラストが不足: ${ratio.toFixed(2)}:1`);
    }
  });

  await t("LOOK-CONTRAST: 案内文・手順ラベル・設定の見出しと補足が 4.5:1 以上", async () => {
    const items = await page.evaluate(() => {
      const sels = ['[data-testid="guide-text"]', '[data-testid="step-item"]', ".group-label", ".group-note", ".cta-hint"];
      const out = [];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue; // 非表示は対象外
          const cs = getComputedStyle(el);
          if (el.disabled) continue;
          out.push({
            sel,
            text: (el.textContent || "").trim().slice(0, 18),
            color: cs.color,
            bg: window.__effBg(el),
            size: parseFloat(cs.fontSize),
            weight: cs.fontWeight,
          });
        }
      }
      return out;
    });
    assert.ok(items.length > 0, "対象要素が0件（空振りで緑にしない）");
    for (const it of items) {
      const large = it.size >= 24 || (it.size >= 18.66 && Number(it.weight) >= 700);
      const need = large ? 3.0 : 4.5;
      const ratio = contrastRatio(parseRgb(it.color), parseRgb(it.bg));
      assert.ok(
        ratio >= need,
        `コントラスト不足 ${ratio.toFixed(2)}:1 (必要 ${need}) — ${it.sel} 「${it.text}」 color=${it.color} bg=${it.bg}`,
      );
    }
    console.log(`      （対象 ${items.length} 要素をすべて判定）`);
  });

  await t("LOOK-CONTRAST 対照: 補足文を薄いグレーにすると落ちる", () => {
    // #b8bec6 は白背景に対し約 2.1:1
    const ratio = contrastRatio({ r: 184, g: 190, b: 198 }, { r: 255, g: 255, b: 255 });
    assert.ok(ratio < 4.5, `薄いグレーを合格にしてしまっている: ${ratio.toFixed(2)}:1`);
  });

  /* ══════ LOOK-3PANE ══════ */
  await t("LOOK-3PANE: 3列が横に並び、幅・上端・高さが基準どおり", async () => {
    const m = await page.evaluate(() => {
      const g = (s) => document.querySelector(`[data-testid="${s}"]`);
      const r = (e) => {
        const b = e.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, height: b.height, width: b.width };
      };
      const header = g("app-header").getBoundingClientRect();
      return {
        left: r(g("pane-left")),
        center: r(g("pane-center")),
        right: r(g("pane-right")),
        avail: window.innerHeight - header.height,
      };
    });
    // (1) 並び順と非重なり
    assert.ok(m.left.left < m.center.left && m.center.left < m.right.left, "3列の左右の並びが 左<中央<右 でない");
    assert.ok(m.left.right <= m.center.left + 0.01, "左ペインと中央ペインが水平方向に重なっている");
    assert.ok(m.center.right <= m.right.left + 0.01, "中央ペインと右ペインが水平方向に重なっている");
    // (2) 幅
    assert.ok(m.left.width >= 160 && m.left.width <= 240, `左ペインの幅が範囲外: ${m.left.width}px`);
    assert.ok(m.right.width >= 600, `右ペインの幅が下限未満: ${m.right.width}px`);
    assert.ok(Math.abs(m.center.width - 315) <= 1, `中央ペインの幅が315pxでない: ${m.center.width}px`);
    // (3) 上端と高さ
    const tops = [m.left.top, m.center.top, m.right.top];
    assert.ok(Math.max(...tops) - Math.min(...tops) <= 1, `3列の上端が揃っていない: ${tops.join(", ")}`);
    const hs = [m.left.height, m.center.height, m.right.height];
    assert.ok(Math.max(...hs) - Math.min(...hs) <= 1, `3列の高さが揃っていない: ${hs.join(", ")}`);
    assert.ok(
      Math.abs(hs[0] - m.avail) <= 1,
      `3列の高さがヘッダーを除いた表示領域と一致しない: ${hs[0]} vs ${m.avail}`,
    );
  });

  await t("LOOK-3PANE 対照: 右ペインだけ高さを半分にすると (3) が落ちる", async () => {
    const diff = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="pane-right"]');
      const original = el.style.height;
      el.style.height = "50%";
      const hs = ["pane-left", "pane-center", "pane-right"].map(
        (i) => document.querySelector(`[data-testid="${i}"]`).getBoundingClientRect().height,
      );
      el.style.height = original; // 必ず戻す
      return Math.max(...hs) - Math.min(...hs);
    });
    assert.ok(diff > 1, `高さの不一致を検出できていない: 差=${diff}px`);
  });

  await browser.close();
  server.kill("SIGKILL");
  console.log(`\n合計: PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
