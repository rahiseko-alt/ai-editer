// tests/editing-card-simple-check.mjs — G-UI-EDITCARD-SIMPLE
//
// マスター指示（2026-08-16）:
//   「この表示を修正。シンプルに文字だけにする。0ベースで以下にしろ ／ 編集中」
//
// 直前の編集中カードには、ハサミでフィルムを切る SVG アニメ・進捗の点5つ・
// 「AIが字幕の間違いを直しています」の段階文言・「0:23 経過 ・ ふつう1〜3分で終わります」の
// 4つが出ていた。指示はこれを全部やめて「編集中」の1行だけにすること。
//
// 【この検査が見ているもの】編集中カードに**目で見える形で出ている文字**が「編集中」だけであること。
// 要素の有無ではなく画面に出る文字で判定するのは、SVG を消して代わりに別の飾り文字を足す等の
// 抜け道を塞ぐため。逆に、読み上げ専用(.sr-only)の段階文言は「目に見えない」ので許す
// （画面を見ない人に編集の進行が一切伝わらなくなるのを防ぐために意図して残している）。
//
// 【対照】刷新前の中身（進捗の点・経過時間・段階文言）をその場で注入し、判定が落ちることを見る。
// これが無いと「カードが空でも通る」判定になっていないかを確かめられない。
//
// 実行: node tests/editing-card-simple-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./helpers/launch-chromium.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE); // video-shorts/
const PORT = 5297;
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

/**
 * 編集中カードに見えている文字が「編集中」だけかを判定する（対照にも同じ関数を使う）。
 * @param {{visibleText: string, hasGraphic: boolean}} observed
 * @returns {string|null} 問題があれば理由、無ければ null
 */
export function checkEditingCard(observed) {
  const text = (observed.visibleText ?? "").replace(/\s+/g, "");
  if (text === "") return "カードに文字が1つも出ていない（空振りで緑にしない）";
  if (observed.hasGraphic) return "カードに図（svg/canvas/画像）が残っている";
  if (text !== "編集中") return `「編集中」以外の文字が出ている: 「${text}」`;
  return null;
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

/** ページ側で「編集中カードに目で見えているもの」を採る評価関数（対照でも同じものを使う）。 */
const OBSERVE = () => {
  const card = document.getElementById("editing-card");
  const shown = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    // .sr-only 相当（1px へ潰して clip している）は「目に見えない」として扱う
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  let visibleText = "";
  const walk = (el) => {
    if (!shown(el)) return;
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) visibleText += node.textContent;
      else if (node.nodeType === Node.ELEMENT_NODE) walk(node);
    }
  };
  walk(card);
  const hasGraphic = [...card.querySelectorAll("svg, canvas, img")].some(shown);
  return { visibleText, hasGraphic };
};

(async () => {
  const server = await startServer();
  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1365, height: 830 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

  // 編集中カードを表示状態にする（ジョブを実際に走らせずに見た目だけを見る）
  const show = () =>
    page.evaluate(() => {
      const c = document.getElementById("editing-card");
      c.classList.remove("hidden", "is-error");
      c.classList.add("show");
      document.getElementById("editing-error").classList.add("hidden");
    });
  await show();
  await page.waitForTimeout(200);

  await t("編集中カードに見えている文字は「編集中」だけ", async () => {
    const observed = await page.evaluate(OBSERVE);
    const problem = checkEditingCard(observed);
    assert.strictEqual(problem, null, problem ?? "");
  });

  await t("段階の文言は残っているが、目には見えない（読み上げ専用）", async () => {
    const st = await page.evaluate(() => {
      const el = document.getElementById("editing-status");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { text: el.textContent.trim(), w: r.width, h: r.height };
    });
    assert.ok(st, "#editing-status が消えている（画面を見ない人へ進行が伝わらなくなる）");
    assert.ok(st.text.length > 0, "#editing-status が空");
    assert.ok(st.w <= 2 && st.h <= 2, `#editing-status が目に見えている: ${st.w}x${st.h}`);
  });

  await t("経過時間の表示が無い", async () => {
    const observed = await page.evaluate(OBSERVE);
    assert.ok(
      !/\d+\s*:\s*\d{2}/.test(observed.visibleText),
      `経過時間らしき表示が残っている: ${observed.visibleText}`,
    );
  });

  await t("失敗したときは、理由が目に見える形で出る（簡素化で失敗が黙らない）", async () => {
    await page.evaluate(() => {
      document.getElementById("editing-error-msg").textContent = "編集できませんでした：話し声が見つかりません";
      document.getElementById("editing-error").classList.remove("hidden");
      document.getElementById("editing-card").classList.add("is-error");
    });
    await page.waitForTimeout(150);
    const observed = await page.evaluate(OBSERVE);
    assert.ok(
      observed.visibleText.includes("編集できませんでした"),
      `失敗の理由が出ていない: ${observed.visibleText}`,
    );
  });

  await t("対照: 刷新前の中身（進捗の点・経過時間・段階文言）を戻すと落ちる", async () => {
    const observed = await page.evaluate(() => {
      const c = document.getElementById("editing-card");
      c.classList.remove("is-error");
      document.getElementById("editing-error").classList.add("hidden");
      const before = document.createElement("div");
      before.id = "__control_before";
      before.innerHTML =
        '<p style="font-size:14px">AIが字幕の間違いを直しています</p>' +
        '<p style="font-size:13px"><b>0:23</b> 経過 ・ ふつう1〜3分で終わります</p>';
      c.appendChild(before);
      const card = document.getElementById("editing-card");
      const shown = (el) => {
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      let visibleText = "";
      const walk = (el) => {
        if (!shown(el)) return;
        for (const node of el.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) visibleText += node.textContent;
          else if (node.nodeType === Node.ELEMENT_NODE) walk(node);
        }
      };
      walk(card);
      const hasGraphic = [...card.querySelectorAll("svg, canvas, img")].some(shown);
      before.remove(); // 必ず戻す
      return { visibleText, hasGraphic };
    });
    assert.ok(
      checkEditingCard(observed) !== null,
      `刷新前の中身を検出できていない（検出手段が効いていない）: ${observed.visibleText}`,
    );
  });

  await t("対照: 図（svg）を1枚戻すと落ちる", () => {
    assert.ok(checkEditingCard({ visibleText: "編集中", hasGraphic: true }) !== null, "図を見逃している");
  });

  await t("対照: カードが空なら落ちる（空振りで緑にしない）", () => {
    assert.ok(checkEditingCard({ visibleText: "   ", hasGraphic: false }) !== null, "空を合格にしている");
  });

  await t("表示の操作でスクリプトエラーが1件も出ていない", () => {
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
