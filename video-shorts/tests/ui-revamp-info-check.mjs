// tests/ui-revamp-info-check.mjs — G-UI-REVAMP-INFO の3葉を実サーバ×実ブラウザで検証する。
//
//   G-UI-REVAMP-INFO-GUIDE    画面の案内文が、実際に選べる項目の数と食い違わない
//   G-UI-REVAMP-INFO-STEPNO   手順の番号が飛んだり重なったりしていない
//   G-UI-REVAMP-INFO-FAVICON  画面を開いたときに、裏側で読み込みエラーが出ない
//
// 2026-08-15 の実測で見つかった現行の欠陥を塞ぐ葉である。
//   ・番号⑤が2つ（「つなぎ目の間」「カットの目安」）、「1本の目安の長さ」だけ番号なし
//   ・案内文が「そのあと①〜④を上から選ぶだけです」なのに実際は7項目
//   ・/favicon.ico が 404
//
// 【対照（偽実装）の置き方】ファイルを書き換えて手で戻す方式は、戻し忘れると検査が嘘になる。
// ここでは対照を「検査の中で注入する」形にしてコミットに残し、誰が何回実行しても同じ合否に
// なるようにした（AGENTS.md『自分以外の人が、自分の意図を知らずに実行して同じ合否になるか』）。
//   ・INFO-GUIDE  … 判定関数へ、現行文言と別表記の言い換え2本を直接食わせて陽性になることを見る
//   ・INFO-STEPNO … 実ページの DOM を一時的に壊して（重複・欠番）判定が落ちることを見る
//   ・INFO-FAVICON… 存在しないパスを同じ判定に掛けて 404 を検出できることを見る
//
// 実行: node tests/ui-revamp-info-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./helpers/launch-chromium.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE); // video-shorts/
const PORT = 5291; // 既定の 5178 と衝突させないための検査専用ポート
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

/* ── INFO-GUIDE の判定本体（対照にも同じ関数を使う）───────────────────────
   案内文に「設定項目の個数として読める数量表現」が含まれるか。表記の種類を問わない。 */
const NUMERIC_PATTERNS = [
  { label: "丸数字", re: /[①-⑳]/ },
  { label: "アラビア数字", re: /[0-9０-９]/ },
  { label: "漢数字", re: /[一二三四五六七八九十]/ },
];
/** @returns {string[]} 検出した数量表現の種類（空配列なら合格） */
export function detectQuantityExpressions(text) {
  return NUMERIC_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.label);
}

/* ── INFO-STEPNO の判定本体（対照にも同じ関数を使う）─────────────────────── */
/** @returns {string|null} 問題があれば理由、無ければ null */
export function checkStepNumbers(nos) {
  if (nos.length === 0) return "step-item が0件（空振りで緑にしない）";
  const missing = nos.filter((n) => n === undefined || n === null || n === "");
  if (missing.length) return `番号を持たない step-item が ${missing.length} 件`;
  const nums = nos.map(Number);
  const expected = nos.map((_, i) => i + 1);
  if (nums.some((n) => !Number.isInteger(n))) return `番号が整数でない: ${JSON.stringify(nos)}`;
  if (JSON.stringify(nums) !== JSON.stringify(expected)) {
    return `連番でない: 実際=${JSON.stringify(nums)} / 期待=${JSON.stringify(expected)}`;
  }
  return null;
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  /** ページ読み込み中に 400 以上を返したレスポンス */
  const badResponses = [];
  page.on("response", (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

  /* ══════ G-UI-REVAMP-INFO-GUIDE ══════ */
  await t("INFO-GUIDE: 案内文に個数の数量表現が含まれない", async () => {
    const guide = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="guide-text"]');
      return el ? el.textContent : null;
    });
    assert.ok(guide !== null, "data-testid=guide-text の要素が見つからない");
    assert.ok(guide.trim().length > 0, "案内文が空（空振りで緑にしない）");
    const hits = detectQuantityExpressions(guide);
    assert.deepStrictEqual(hits, [], `案内文に数量表現が含まれる(${hits.join("/")}): ${guide}`);
  });

  await t("INFO-GUIDE 対照: 表記を変えた3通りの『個数の名指し』をすべて検出できる", () => {
    // 対照1 = 2026-08-15 時点の現行文言（webapp-mockup/app.js:298）
    const c1 = "まずは動画を1つ入れてください。左上の枠にドラッグ、またはクリックで選べます。そのあと①〜④を上から選ぶだけです。";
    // 対照2 = 同じ意味の言い換え（丸数字を使わない）
    const c2 = "そのあと4つを上から選ぶだけです。";
    // 対照3 = 漢数字の言い換え
    const c3 = "そのあと四つを上から選ぶだけです。";
    for (const [i, s] of [c1, c2, c3].entries()) {
      const hits = detectQuantityExpressions(s);
      assert.ok(hits.length > 0, `対照${i + 1}を検出できていない（偽の緑の経路）: ${s}`);
    }
  });

  /* ══════ G-UI-REVAMP-INFO-STEPNO ══════ */
  await t("INFO-STEPNO: 手順の番号が1から始まる連番で、重複も欠番もない", async () => {
    const nos = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="pane-left"] [data-testid="step-item"]')].map(
        (e) => e.dataset.stepNo,
      ),
    );
    const problem = checkStepNumbers(nos);
    assert.strictEqual(problem, null, `手順番号に問題: ${problem}`);
  });

  await t("INFO-STEPNO 対照: 実ページのDOMを壊すと（重複・欠番）判定が落ちる", async () => {
    // 対照A: 2番目の番号を 1 にして重複させる
    const dup = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-testid="pane-left"] [data-testid="step-item"]')];
      const original = items[1].dataset.stepNo;
      items[1].dataset.stepNo = "1";
      const nos = items.map((e) => e.dataset.stepNo);
      items[1].dataset.stepNo = original; // 必ず戻す
      return nos;
    });
    assert.ok(checkStepNumbers(dup) !== null, `重複を検出できていない: ${JSON.stringify(dup)}`);

    // 対照B: 3番目の番号を消して欠番にする
    const gap = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-testid="pane-left"] [data-testid="step-item"]')];
      const original = items[2].dataset.stepNo;
      delete items[2].dataset.stepNo;
      const nos = items.map((e) => e.dataset.stepNo);
      items[2].dataset.stepNo = original; // 必ず戻す
      return nos;
    });
    assert.ok(checkStepNumbers(gap) !== null, `欠番を検出できていない: ${JSON.stringify(gap)}`);

    // 対照C: 2026-08-15 時点の現行の並び（1,2,無,3,4,5,5,無,6,7）
    const current = ["1", "2", undefined, "3", "4", "5", "5", undefined, "6", "7"];
    assert.ok(checkStepNumbers(current) !== null, "現行の破綻した並びを検出できていない");

    // 対照D: 0件（空振り）
    assert.ok(checkStepNumbers([]) !== null, "0件を合格にしてしまっている");
  });

  /* ══════ G-UI-REVAMP-INFO-FAVICON ══════ */
  await t("INFO-FAVICON: ページ読み込みで 400 以上のレスポンスが1件も無い", () => {
    assert.deepStrictEqual(badResponses, [], `失敗したレスポンス: ${badResponses.join(", ")}`);
  });

  await t("INFO-FAVICON: /favicon.ico が 200 を返す", async () => {
    const res = await page.request.get(`${BASE}/favicon.ico`);
    assert.strictEqual(res.status(), 200, `/favicon.ico のステータスが 200 でない: ${res.status()}`);
    const body = await res.body();
    assert.ok(body.length > 0, "/favicon.ico の中身が空");
  });

  await t("INFO-FAVICON 対照: 配信されていないパスなら 404 を検出できる", async () => {
    // favicon の配信を外した状態に相当する。検出手段が「有るとき有ると言える」ことの対照。
    const res = await page.request.get(`${BASE}/favicon-not-served-control.ico`);
    assert.ok(res.status() >= 400, `存在しないパスなのに ${res.status()} が返る（検出手段が効いていない）`);
  });

  await browser.close();
  server.kill("SIGKILL");

  console.log(`\n合計: PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
