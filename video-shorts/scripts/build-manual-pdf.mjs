// video-shorts scripts/build-manual-pdf.mjs — 人間向けの取扱説明書（dist-src/取扱説明書.html）を PDF にし、
// 配布物に入る dist-template/取扱説明書.pdf へ書く。
// Playwright（devDependencies）から、PC に入っている Chrome（無ければ Edge）を動かして印刷する。
// Edge を直接 --headless --print-to-pdf で呼ぶ方法は、この PC ではすぐ終了して PDF が出なかった（2026-09-28）。
// 使い方: node video-shorts/scripts/build-manual-pdf.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

const VS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(VS, "dist-src", "取扱説明書.html");
const out = path.join(VS, "dist-template", "取扱説明書.pdf");

let browser;
for (const channel of ["chrome", "msedge"]) {
  try {
    browser = await chromium.launch({ channel });
    break;
  } catch {
    /* 次を試す */
  }
}
if (!browser) {
  console.error("Chrome も Edge も起動できません");
  process.exit(1);
}
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(src).href);
  await page.pdf({ path: out, format: "A4", preferCSSPageSize: true, printBackground: true });
} finally {
  await browser.close();
}
console.log(`書き出しました: ${out}（${fs.statSync(out).size} バイト）`);
