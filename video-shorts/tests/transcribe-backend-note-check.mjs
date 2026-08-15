// tests/transcribe-backend-note-check.mjs — G-UI-BACKEND-NOTE
//
// 画面に出る「動画がどこで処理されるか」の説明が、実際の文字起こし経路と一致することを
// 実サーバ×実ブラウザで確かめる。
//
// 【2026-08-16 の実害】画面には常に固定で
//   「この動画はこのPCの中だけで処理されます（外部に送りません）。」
// と書いてあった。しかし文字起こしは transcribe.py の auto 解決で、GROQ_API_KEY があれば
// Groq のクラウドへ音声を送る（src/transcribe.py:216-221）。つまり鍵を入れた瞬間に、画面の
// 記述と実際の動きが食い違う。マスターの指示で Groq を使う運用へ切り替えるため、表示を実態へ
// 追随させた（server/index.mjs の GET /api/env → webapp-mockup/app.js の applyPrivacyNote）。
//
// 【この検査の作り】同じサーバを2通りの環境変数で起動し、画面の文言を実測する。
//   ・GROQ_API_KEY 無し … 「外部へ送りません」と言ってよい（local）
//   ・GROQ_API_KEY 有り … 「Groq へ送信されます」と言わなければならない（cloud）
// 対照は「変更前の固定文言」をそのまま判定関数へ食わせ、cloud のケースで落ちること。
// これが無いと「常に local 用の文言を出す実装」でも片方のケースだけ通ってしまう。
//
// 鍵の値は検査用のダミー（Groq へ接続はしない。GET /api/env は有無しか見ない）。
//
// 実行: node tests/transcribe-backend-note-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./helpers/launch-chromium.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE); // video-shorts/

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
 * 表示文が、その経路について正しいことを言っているかを判定する（対照にも同じ関数を使う）。
 *
 * cloud（音声を Groq へ送る）のとき、外へ出さないという趣旨の言い回しは全部だめ。
 * 「外部に送りません」だけを見ると「クラウドへは送りません」「このPCの中だけ」等の
 * 別の言い方で同じ嘘が書ける（AGENTS.md『語句の一致ではなく中身で判定する』）。
 *
 * @param {"local"|"cloud"} kind
 * @param {string} text
 * @returns {string|null} 問題があれば理由、無ければ null
 */
export function checkBackendNote(kind, text) {
  if (typeof text !== "string" || text.trim() === "") return "説明文が空（空振りで緑にしない）";
  if (text.includes("確認しています")) return "読み込み中の仮文言のまま（実態へ差し替わっていない）";

  // 「外へ出さない」と読める言い回し（表記ゆれを網羅する）
  const NO_SEND = [/外部(へ|に)(は)?[^。]{0,6}送(り|ら)ませ/, /送信しませ/, /このPCの中だけ/, /この[Pp][Cc]内だけ/, /端末の中だけ/];
  // 「外のサービスへ送る」と読める言い回し
  const DOES_SEND = [/送信されます/, /送ります/, /クラウド/, /Groq/i];

  const claimsNoSend = NO_SEND.some((re) => re.test(text));
  const claimsSend = DOES_SEND.some((re) => re.test(text));

  if (kind === "cloud") {
    if (claimsNoSend) return `クラウド経路なのに「外部へ送らない」と書いてある: ${text}`;
    if (!claimsSend) return `クラウド経路なのに、外部へ送ることが書かれていない: ${text}`;
    return null;
  }
  if (!claimsNoSend) return `ローカル経路なのに、外部へ送らないことが書かれていない: ${text}`;
  return null;
}

/** 実サーバ(server/index.mjs)を起動し、listening を確認してから返す。 */
function startServer(port, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), ...env },
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

/** 指定の環境でサーバを起動し、画面を開いて説明文と /api/env の応答を採る。 */
async function observe(browser, port, env) {
  const server = await startServer(port, env);
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
    // 表示は /api/env の応答後に差し替わる。仮文言が消えるまで待つ。
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid="privacy-note"]')].every(
          (el) => el.dataset.transcribe,
        ),
      null,
      { timeout: 10000 },
    );
    const notes = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="privacy-note"]')].map((el) => ({
        text: el.textContent.trim(),
        kind: el.dataset.transcribe,
      })),
    );
    await context.close();
    return notes;
  } finally {
    server.kill("SIGKILL");
  }
}

(async () => {
  const browser = await chromium.launch(chromiumLaunchOptions());

  // GROQ_API_KEY を空文字で渡すと groqKeyAvailable() は falsy と判定する。
  // 実行環境に鍵が入っていても local ケースを再現できるようにするため明示的に空を渡す。
  const localNotes = await observe(browser, 5294, { GROQ_API_KEY: "" });
  const cloudNotes = await observe(browser, 5295, { GROQ_API_KEY: "gsk_dummy_for_test_only" });

  await t("local: 鍵が無いとき、画面が「local」と判定している", () => {
    assert.ok(localNotes.length > 0, "privacy-note が0件（空振りで緑にしない）");
    for (const n of localNotes) assert.strictEqual(n.kind, "local", `判定が local でない: ${n.kind}`);
  });

  await t("local: 鍵が無いとき、外部へ送らないことが書いてある", () => {
    for (const n of localNotes) {
      const problem = checkBackendNote("local", n.text);
      assert.strictEqual(problem, null, problem ?? "");
    }
  });

  await t("cloud: 鍵があるとき、画面が「cloud」と判定している", () => {
    assert.ok(cloudNotes.length > 0, "privacy-note が0件（空振りで緑にしない）");
    for (const n of cloudNotes) assert.strictEqual(n.kind, "cloud", `判定が cloud でない: ${n.kind}`);
  });

  await t("cloud: 鍵があるとき、音声が Groq へ送られることが書いてある", () => {
    for (const n of cloudNotes) {
      const problem = checkBackendNote("cloud", n.text);
      assert.strictEqual(problem, null, problem ?? "");
    }
  });

  await t("local と cloud で、表示される文が実際に違う", () => {
    assert.notStrictEqual(
      localNotes[0].text,
      cloudNotes[0].text,
      "経路が違うのに同じ文が出ている（実態へ追随していない）",
    );
  });

  await t("対照: 変更前の固定文言は cloud のケースで落ちる", () => {
    const before = "この動画はこのPCの中だけで処理されます（外部に送りません）。";
    assert.strictEqual(checkBackendNote("local", before), null, "local では通るはず（対照の前提）");
    assert.ok(
      checkBackendNote("cloud", before) !== null,
      "変更前の文言を cloud で検出できていない（検出手段が効いていない）",
    );
  });

  await t("対照: 言い換えた『外へ出さない』表現も cloud では落ちる", () => {
    for (const s of [
      "処理はこのPCの中だけで行います。",
      "音声を外部へ送信しません。",
      "動画は端末の中だけで処理され、外部には送りません。",
    ]) {
      assert.ok(
        checkBackendNote("cloud", s) !== null,
        `言い換えを検出できていない（語句の一致でしか見られていない）: ${s}`,
      );
    }
  });

  await t("対照: 読み込み中の仮文言のままなら落ちる", () => {
    assert.ok(checkBackendNote("local", "文字起こしの処理先を確認しています…") !== null);
    assert.ok(checkBackendNote("cloud", "文字起こしの処理先を確認しています…") !== null);
  });

  await browser.close();

  console.log(`\n合計: PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
