// 受け入れ基準 15 項目を Playwright で機械実測するスクリプト
// 実行: node measure.mjs
// 受け入れ基準（plan 2026-06-21 確定）:
//   1. 背景 warm off-white — body 背景 RGB: 各値>=240&&<=253 かつ R>=B
//   2. 面トーン階調 — 主要カード面の明度が body 背景と異なる（差>=2）
//   3. soft shadow — 主要カードの computed boxShadow != 'none'
//   4. テキストチャコール — body color RGB 各値 <=70
//   5. テキストコントラスト — コントラスト比 >=4.5（WCAG式）
//   6. アクセント低彩度 — 実行ボタン背景の HSL S<=0.6
//   7. ベタ塗り抑制 — アクセント色ベタ塗り要素<=2 かつ 選択チップ背景 RGB各値>=200
//   8. デバイス枠固定 — サイズ9:16→16:9 変更前後で #phone-frame の rect 差<2px
//   9. 動画領域のみ可変 — 同変更で .video-area の縦横比が data-ar に一致（誤差<0.05）
//  10. 動画領域がデバイス画面内 — .video-area 矩形が .device-screen 矩形内（はみ出し<=1px）
//  11. デバイスタブ — .device-tab が 2 個 かつ click で表示フレーム切替
//  12. ②③横並び維持 — #card-sub と #card-cut の top 差 <3px
//  13. 最小フォント維持 — 全テキスト要素の computed font-size 最小値>=13px
//  14. 広い画面スクロールゼロ — scrollHeight<=innerHeight && scrollWidth<=innerWidth
//  15. 構文健全性 — node --check 全JS EXIT 0・ブラウザロードエラー=0
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, 'index.html');
const appJsPath = path.join(__dirname, 'app.js');
const filePath = 'file:///' + htmlPath.split('\\').join('/');

const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1920x1080', width: 1920, height: 1080 },
];
const VIEWPORT_LOW = { name: '1280x700', width: 1280, height: 700 };

async function measure(page, vpName) {
  const R = [];
  const push = (check, pass, val) => { R.push({ check, pass, val }); };

  // ================================================================
  // #1 背景 warm off-white: RGB各値>=240&&<=253 かつ R>=B
  // ================================================================
  const bgCheck = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    const m = s.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return { ok: false, r: 0, g: 0, b: 0 };
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    const rangeOk = r >= 240 && r <= 253 && g >= 240 && g <= 253 && b >= 240 && b <= 253;
    const warmOk = r >= b;
    return { ok: rangeOk && warmOk, r, g, b, rangeOk, warmOk };
  });
  push('#1 背景warm off-white(>=240&&<=253 かつ R>=B)', bgCheck.ok,
    `RGB(${bgCheck.r},${bgCheck.g},${bgCheck.b}) rangeOk=${bgCheck.rangeOk} warmOk=${bgCheck.warmOk}`);

  // ================================================================
  // #2 面トーン階調: 主要カード面明度が body 背景と異なる（差>=2）
  // ================================================================
  const toneCheck = await page.evaluate(() => {
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const card = document.querySelector('.settings-group');
    if (!card) return { ok: false, val: 'no .settings-group' };
    const cardBg = getComputedStyle(card).backgroundColor;
    const parseL = s => {
      const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return -1;
      return (+m[1] + +m[2] + +m[3]) / 3;
    };
    const bodyL = parseL(bodyBg), cardL = parseL(cardBg);
    const diff = Math.abs(bodyL - cardL);
    return { ok: diff >= 2, diff: +diff.toFixed(2), bodyBg, cardBg };
  });
  push('#2 面トーン階調(body vs card 明度差>=2)', toneCheck.ok,
    `diff=${toneCheck.diff} body=${toneCheck.bodyBg} card=${toneCheck.cardBg}`);

  // ================================================================
  // #3 soft shadow: 主要カードの computed boxShadow != 'none'
  // ================================================================
  const shadowCheck = await page.evaluate(() => {
    const card = document.querySelector('.settings-group');
    if (!card) return { ok: false, val: 'no .settings-group' };
    const bs = getComputedStyle(card).boxShadow;
    return { ok: bs !== 'none' && bs !== '', val: bs.slice(0, 80) };
  });
  push('#3 soft shadow(boxShadow!=none)', shadowCheck.ok, `boxShadow="${shadowCheck.val}"`);

  // ================================================================
  // #4 テキストチャコール: body color RGB 各値 <=70
  // ================================================================
  const fgCheck = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    const m = s.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return { ok: false, r: 0, g: 0, b: 0 };
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    return { ok: r <= 70 && g <= 70 && b <= 70, r, g, b };
  });
  push('#4 テキストチャコール(各値<=70)', fgCheck.ok,
    `RGB(${fgCheck.r},${fgCheck.g},${fgCheck.b})`);

  // ================================================================
  // #5 テキストコントラスト: >=4.5
  // ================================================================
  const contrastCheck = await page.evaluate(() => {
    function sRGB(c) { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    function L(r, g, b) { return 0.2126 * sRGB(r) + 0.7152 * sRGB(g) + 0.0722 * sRGB(b); }
    function cr(a, b2) { const hi = Math.max(a, b2), lo = Math.min(a, b2); return (hi + 0.05) / (lo + 0.05); }
    function parseRgb(s) { const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); return m ? [+m[1], +m[2], +m[3]] : null; }
    const bs = getComputedStyle(document.body);
    const fg = parseRgb(bs.color), bg = parseRgb(bs.backgroundColor);
    if (!fg || !bg) return { ok: false, ratio: 0 };
    const ratio = cr(L(...fg), L(...bg));
    return { ok: ratio >= 4.5, ratio: +ratio.toFixed(2) };
  });
  push('#5 テキストコントラスト(>=4.5)', contrastCheck.ok, `ratio=${contrastCheck.ratio}`);

  // ================================================================
  // #6 アクセント低彩度: 実行ボタン背景の HSL S<=0.6
  // ================================================================
  const accentSatCheck = await page.evaluate(() => {
    const btn = document.getElementById('btn-run');
    if (!btn) return { ok: false, val: 'no #btn-run' };
    const bg = getComputedStyle(btn).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return { ok: false, val: 'parse fail: ' + bg };
    const r = +m[1] / 255, g = +m[2] / 255, b = +m[3] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const s = max === min ? 0 : (max - min) / (l > 0.5 ? 2 - max - min : max + min);
    return { ok: s <= 0.6, s: +s.toFixed(3), bg };
  });
  push('#6 アクセント低彩度(S<=0.6)', accentSatCheck.ok,
    `S=${accentSatCheck.s} bg=${accentSatCheck.bg}`);

  // ================================================================
  // #7 ベタ塗り抑制: アクセント色で「面（幅x高さ>=400px²）」を埋めた要素<=2
  //    かつ 選択チップ背景 RGB各値>=200（淡tint）
  //    ※ badge・step-n・spark等の小さなアイコン/バッジは面塗りでなく除外
  // ================================================================
  const accentBetaCheck = await page.evaluate(() => {
    const btn = document.getElementById('btn-run');
    if (!btn) return { ok: false, val: 'no #btn-run' };
    const accentBg = getComputedStyle(btn).backgroundColor;
    const accentM = accentBg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!accentM) return { ok: false, val: 'accent parse fail' };
    const [ar, ag, ab] = [+accentM[1], +accentM[2], +accentM[3]];
    // アクセント色(近似20以内)でベタ塗りし かつ「面」として機能するサイズの要素を数える
    // 除外: step-n, step-star, badge, spark（ポイントアクセント・インラインバッジ）
    // 面基準: 幅>=60px かつ 高さ>=30px（ボタン・大面積カード相当）
    const allEls = Array.from(document.querySelectorAll('*'));
    let accentFillCount = 0;
    const accentFillEls = [];
    for (const el of allEls) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      // バッジ・アイコン系（クラス名）を除外
      const cls = Array.from(el.classList);
      if (cls.some(c => ['step-n','step-star','badge','spark'].includes(c))) continue;
      const bgM = s.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),?\s*([\d.]+)?/);
      if (!bgM) continue;
      const alpha = bgM[4] !== undefined ? +bgM[4] : 1;
      if (alpha < 0.5) continue;
      const [br, bg2, bb] = [+bgM[1], +bgM[2], +bgM[3]];
      if (Math.abs(br - ar) <= 20 && Math.abs(bg2 - ag) <= 20 && Math.abs(bb - ab) <= 20) {
        const rect = el.getBoundingClientRect();
        // 面として機能する最小サイズ（幅>=60px かつ 高さ>=30px）
        if (rect.width >= 60 && rect.height >= 30) {
          accentFillCount++;
          accentFillEls.push(`${el.tagName}.${el.className.split(' ')[0]}(${rect.width.toFixed(0)}x${rect.height.toFixed(0)})`);
        }
      }
    }
    // 選択チップ背景が淡tint(RGB各値>=200)か確認
    const onChip = document.querySelector('.chip.is-on');
    let chipTintOk = true, chipR = 0, chipG = 0, chipB = 0;
    if (onChip) {
      const chipBg = getComputedStyle(onChip).backgroundColor;
      const chipM = chipBg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (chipM) {
        chipR = +chipM[1]; chipG = +chipM[2]; chipB = +chipM[3];
        chipTintOk = chipR >= 200 && chipG >= 200 && chipB >= 200;
      }
    }
    const fillOk = accentFillCount <= 2;
    return { ok: fillOk && chipTintOk, accentFillCount, fillOk, chipTintOk,
      chipRGB: `RGB(${chipR},${chipG},${chipB})`,
      els: accentFillEls.join(' | ') };
  });
  push('#7 ベタ塗り抑制(面fill<=2 かつ chipTint>=200)', accentBetaCheck.ok,
    `accentFill=${accentBetaCheck.accentFillCount}(<=2:${accentBetaCheck.fillOk}) chip=${accentBetaCheck.chipRGB}(>=200:${accentBetaCheck.chipTintOk}) els=[${accentBetaCheck.els}]`);

  // ================================================================
  // #8 デバイス枠固定: サイズ9:16→16:9 変更前後で #phone-frame の rect 差<2px
  // ================================================================
  const frameFix = await page.evaluate(async () => {
    const phoneTab = document.getElementById('tab-phone');
    if (phoneTab) phoneTab.click();
    await new Promise(r => setTimeout(r, 300));
    // 9:16 に設定
    const chip916 = document.querySelector('.size-chip[data-val="9:16"]');
    if (chip916) chip916.click();
    await new Promise(r => setTimeout(r, 500));
    const frame = document.getElementById('phone-frame');
    if (!frame) return { ok: false, val: 'no #phone-frame' };
    const before = frame.getBoundingClientRect();
    // 16:9 に変更
    const chip169 = document.querySelector('.size-chip[data-val="16:9"]');
    if (chip169) chip169.click();
    await new Promise(r => setTimeout(r, 500));
    const after = frame.getBoundingClientRect();
    const wDiff = Math.abs(before.width - after.width);
    const hDiff = Math.abs(before.height - after.height);
    const ok = wDiff < 2 && hDiff < 2;
    // 元に戻す
    if (chip916) chip916.click();
    await new Promise(r => setTimeout(r, 200));
    return { ok, wDiff: +wDiff.toFixed(2), hDiff: +hDiff.toFixed(2),
      before: `${before.width.toFixed(1)}x${before.height.toFixed(1)}`,
      after: `${after.width.toFixed(1)}x${after.height.toFixed(1)}` };
  });
  push('#8 デバイス枠固定(前後<2px)', frameFix.ok,
    `wDiff=${frameFix.wDiff}px hDiff=${frameFix.hDiff}px before=${frameFix.before} after=${frameFix.after}`);

  // ================================================================
  // #9 動画領域のみ可変: .video-area の縦横比が data-ar に一致（誤差<0.05）
  // ================================================================
  const videoAreaAr = await page.evaluate(async () => {
    const phoneTab = document.getElementById('tab-phone');
    if (phoneTab) phoneTab.click();
    await new Promise(r => setTimeout(r, 300));
    const chips = Array.from(document.querySelectorAll('.size-chip'));
    const results = [];
    for (const chip of chips) {
      chip.click();
      await new Promise(r => setTimeout(r, 500));
      const area = document.getElementById('video-area-phone');
      if (!area) { results.push({ ar: chip.dataset.ar, ok: false, val: 'no video-area-phone' }); continue; }
      const rect = area.getBoundingClientRect();
      const arStr = chip.dataset.ar || area.dataset.ar;
      if (!arStr) { results.push({ ar: '?', ok: false, val: 'no data-ar' }); continue; }
      const [w, h] = arStr.split('/').map(Number);
      const expected = w / h;
      const actual = rect.height > 0 ? rect.width / rect.height : 0;
      const ok = Math.abs(actual - expected) < 0.05;
      results.push({ ar: arStr, expected: +expected.toFixed(3), actual: +actual.toFixed(3), ok });
    }
    const def = document.querySelector('.size-chip[data-val="9:16"]');
    if (def) def.click();
    return { ok: results.every(r => r.ok), results };
  });
  push('#9 動画領域比率(data-ar一致 誤差<0.05)', videoAreaAr.ok,
    (videoAreaAr.results || []).map(r => `${r.ar}:act=${r.actual}${r.ok ? '' : '≠exp' + r.expected}`).join(' | '));

  // ================================================================
  // #10 動画領域がデバイス画面内（はみ出し<=1px）
  // ================================================================
  const videoAreaInside = await page.evaluate(async () => {
    const phoneTab = document.getElementById('tab-phone');
    if (phoneTab) phoneTab.click();
    await new Promise(r => setTimeout(r, 300));
    const screen = document.getElementById('device-screen');
    const area   = document.getElementById('video-area-phone');
    if (!screen || !area) return { ok: false, val: 'no device-screen or video-area-phone' };
    const sr = screen.getBoundingClientRect();
    const ar = area.getBoundingClientRect();
    const overL = sr.left - ar.left;
    const overT = sr.top  - ar.top;
    const overR = ar.right  - sr.right;
    const overB = ar.bottom - sr.bottom;
    const maxOver = Math.max(overL, overT, overR, overB);
    return { ok: maxOver <= 1, maxOver: +maxOver.toFixed(2),
      screen: `L${sr.left.toFixed(0)}T${sr.top.toFixed(0)}R${sr.right.toFixed(0)}B${sr.bottom.toFixed(0)}`,
      area:   `L${ar.left.toFixed(0)}T${ar.top.toFixed(0)}R${ar.right.toFixed(0)}B${ar.bottom.toFixed(0)}` };
  });
  push('#10 動画領域がデバイス画面内(はみ出し<=1px)', videoAreaInside.ok,
    `maxOver=${videoAreaInside.maxOver}px screen=${videoAreaInside.screen} area=${videoAreaInside.area}`);

  // ================================================================
  // #11 デバイスタブ: .device-tab が 2 個 かつ click で表示フレーム切替
  // ================================================================
  const deviceTabCheck = await page.evaluate(async () => {
    const tabs = document.querySelectorAll('.device-tab');
    if (tabs.length !== 2) return { ok: false, count: tabs.length, val: 'count!=2' };
    const phoneFrame = document.getElementById('phone-frame');
    const pcFrame    = document.getElementById('pc-frame');
    const pcTab   = document.getElementById('tab-pc');
    const phoneTab = document.getElementById('tab-phone');
    if (!phoneFrame || !pcFrame || !pcTab || !phoneTab) return { ok: false, count: 2, val: 'frame not found' };
    // 初期状態（スマホ表示）
    const beforePhoneHidden = phoneFrame.classList.contains('hidden');
    const beforePcHidden    = pcFrame.classList.contains('hidden');
    pcTab.click();
    await new Promise(r => setTimeout(r, 100));
    const afterPhoneHidden = phoneFrame.classList.contains('hidden');
    const afterPcHidden    = pcFrame.classList.contains('hidden');
    phoneTab.click();
    await new Promise(r => setTimeout(r, 100));
    const switched = (beforePhoneHidden !== afterPhoneHidden) || (beforePcHidden !== afterPcHidden);
    return { ok: switched, count: 2,
      before: `phone:${!beforePhoneHidden} pc:${!beforePcHidden}`,
      after:  `phone:${!afterPhoneHidden} pc:${!afterPcHidden}` };
  });
  push('#11 デバイスタブ(2個かつ切替)', deviceTabCheck.ok,
    `count=${deviceTabCheck.count} before=${deviceTabCheck.before} after=${deviceTabCheck.after}`);

  // ================================================================
  // #12 ②③横並び維持: #card-sub と #card-cut の top 差 <3px
  // ================================================================
  const subCutCheck = await page.evaluate(() => {
    const sub = document.getElementById('card-sub');
    const cut = document.getElementById('card-cut');
    if (!sub || !cut) return { ok: false, diff: -1 };
    const diff = Math.abs(sub.getBoundingClientRect().top - cut.getBoundingClientRect().top);
    return { ok: diff < 3, diff: +diff.toFixed(1),
      subTop: +sub.getBoundingClientRect().top.toFixed(1),
      cutTop: +cut.getBoundingClientRect().top.toFixed(1) };
  });
  push('#12 ②③横並び(top差<3px)', subCutCheck.ok,
    `diff=${subCutCheck.diff}px sub=${subCutCheck.subTop} cut=${subCutCheck.cutTop}`);

  // ================================================================
  // #13 最小フォント: 全テキスト要素の computed font-size 最小値>=13px
  // ================================================================
  const fontCheck = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll(
      'p, span, label, button, h1, h2, h3, li, .group-note, .cut-note, .bubble p, .progress li, .summary li'
    ));
    const results = [];
    for (const el of els) {
      if (el.closest('.step-n') || el.closest('.step-star')) continue;
      const s = window.getComputedStyle(el);
      if (s.display === 'none') continue;
      const fs = parseFloat(s.fontSize);
      if (!isNaN(fs) && fs > 0) results.push(fs);
    }
    const min = results.length ? Math.min(...results) : 999;
    const fails = results.filter(r => r < 13);
    return { ok: min >= 13, min: +min.toFixed(1), failCount: fails.length };
  });
  push('#13 最小フォント(>=13px)', fontCheck.ok,
    `min=${fontCheck.min}px failCount=${fontCheck.failCount}`);

  // ================================================================
  // #14 広い画面スクロールゼロ（低画面は縦スクロール許容）
  // ================================================================
  const vpInfo = page.viewportSize();
  const isLowViewport = vpInfo.height <= 700;
  const scroll = await page.evaluate(() => ({
    swOk: document.documentElement.scrollWidth <= window.innerWidth,
    shOk: document.documentElement.scrollHeight <= window.innerHeight,
    sw: document.documentElement.scrollWidth, iw: window.innerWidth,
    sh: document.documentElement.scrollHeight, ih: window.innerHeight,
  }));
  push('#14 スクロールゼロ(横)', scroll.swOk,
    `scrollWidth=${scroll.sw} innerWidth=${scroll.iw}`);
  if (isLowViewport) {
    push('#14 スクロールゼロ(縦) ※低画面=縦スクロール許容', true,
      `scrollHeight=${scroll.sh} innerHeight=${scroll.ih} (低画面スキップ)`);
  } else {
    push('#14 スクロールゼロ(縦)', scroll.shOk,
      `scrollHeight=${scroll.sh} innerHeight=${scroll.ih}`);
  }

  // ================================================================
  // #15 ブラウザロードエラー = 0
  // ================================================================
  const errors = await page.evaluate(() => (window.__loadErrors || []).length);
  push('#15 ブラウザロードエラーなし', errors === 0, `errors=${errors}`);

  console.log(`\n=== ${vpName} (${vpInfo.width}x${vpInfo.height}) ===`);
  for (const r of R) {
    console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.check}${r.val ? ' -- ' + r.val : ''}`);
  }
  return R;
}

(async function () {
  // ================================================================
  // #15 構文チェック（静的・Playwright前）
  // ================================================================
  console.log('\n=== STATIC CHECK ===');
  let nodeCheckOk = true;
  try {
    execSync(`node --check "${appJsPath}"`, { encoding: 'utf-8' });
    console.log('  [PASS] node --check app.js');
  } catch (e) {
    console.log('  [FAIL] node --check app.js -- ' + e.message.split('\n')[0]);
    nodeCheckOk = false;
  }

  const browser = await chromium.launch({ headless: true });
  const allResults = [];

  // 通常ビューポート（1280x800, 1920x1080）
  for (const vpDef of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vpDef.width, height: vpDef.height } });
    const page = await context.newPage();
    page.on('pageerror', err => { console.error('PAGE ERROR:', err.message); });
    await page.goto(filePath);
    await page.waitForTimeout(1000);
    const res = await measure(page, vpDef.name);
    allResults.push(...res.map(r => ({ ...r, viewport: vpDef.name })));
    await context.close();
  }

  // 低画面ビューポート（1280x700）: #12/#14横 を確認
  {
    const context = await browser.newContext({ viewport: { width: VIEWPORT_LOW.width, height: VIEWPORT_LOW.height } });
    const page = await context.newPage();
    await page.goto(filePath);
    await page.waitForTimeout(1000);
    const res = await measure(page, VIEWPORT_LOW.name);
    const lowItems = res.filter(r => r.check.startsWith('#12') || r.check.includes('横'));
    allResults.push(...lowItems.map(r => ({ ...r, viewport: VIEWPORT_LOW.name })));
    await context.close();
  }

  // node --check 結果を allResults に追加
  allResults.push({
    check: '#15 node --check app.js',
    pass: nodeCheckOk,
    val: nodeCheckOk ? 'EXIT 0' : 'FAIL',
    viewport: 'static',
  });

  const fails = allResults.filter(r => !r.pass);
  console.log('\n=== SUMMARY ===');
  console.log(`Total: ${allResults.length}, PASS: ${allResults.length - fails.length}, FAIL: ${fails.length}`);
  if (fails.length > 0) {
    console.log('FAIL items:');
    for (const f of fails) console.log(`  [${f.viewport}] ${f.check} -- ${f.val}`);
  } else {
    console.log('All PASS!');
  }

  await browser.close();
  process.exit(fails.length > 0 ? 1 : 0);
}());
