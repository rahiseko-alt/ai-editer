// G-EDIT-UI-SETTINGS-CONDITIONAL-UI / -CONDITIONAL-BACKEND / -RECOVER / -COMPAT の検査。
// tests/ui-settings-wiring-client-check.mjs と同じ作法(pass/fail集計・try/finallyでの
// サーバー・ブラウザ後始末)で書く。実サーバ(server/index.mjs)・実ffmpeg・実ブラウザを使う。
//
// 実行: node tests/ui-settings-conditional-recover-compat-check.mjs (ffmpeg必須。無ければexit 1)
//
// 4葉の検査方針:
//   CONDITIONAL-UI: DOM操作のみ(ジョブ実行不要)。字幕なし/ありの切替でcard-caption-styleの
//     表示・非表示を確認する。
//   CONDITIONAL-BACKEND: sub=noneのまま字幕の見た目値を無理にクエリへ含めて実サーバへ直接
//     POSTし、出来た成果物(work/<jobId>配下)に.assファイルが一切生成されないことを確認する
//     (noSub時はpipeline.mjsがsubtitleオプションをnullにするため、そもそも.assは書かれない
//     ＝render(ass filter)にも使われない、という設計を実測で裏取りする)。
//   RECOVER: 失敗するfake claude({kind:"fail"})を使い、字幕スタイル・尺・書き出しの設定を
//     選んだ状態で作成を実行→失敗→画面上の選択値が変わっていないことを確認する。
//   COMPAT: (1) 新設定を送らずsub=onで作成したジョブの出力に、既定書体(kaku)・既定の白文字
//     (&H00FFFFFF)が実際に描画されていることを実測する(既定値の定義そのものはsubtitle-styles.mjs
//     を読んで確認する。縁取りは黒(背景も黒なので画素分離では検出できない領域)は定義読みで確認する)。
//     (2) 新設定(exportPreset)を送らない場合の書き出しが、明示的にexportPreset=standardを
//     指定した場合とほぼ同じ映像ビットレートになることを実測する(対照としてexportPreset=lightとの
//     差も確認し、測定方法がビットレート差を検出できることを裏取りする)。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import {
  WORK_ROOT, ffmpegAvailable, makeSample, TOPIC_CLAUDE,
  installFakePython, installFakeClaude, startServer, stopServer,
  chromium, chromiumLaunchOptions, readCandidates,
  extractFramePng, readPixelsRgb, dominantColors, colorClose,
} from "./helpers/ui-settings-e2e-harness.mjs";
import {
  FONT_CATALOG, DEFAULT_FONT_KEY, SUBTITLE_STYLES, DEFAULT_SUBTITLE_STYLE,
} from "../src/subtitle-styles.mjs";

const PORT = 59243; // このテスト専用の固定ポート

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.stack || e.message}`); }
}

// ── 直接POST用のユーティリティ(tests/e2e-server.mjsの実例に準拠。P1-2(A)の起動時トークンを
//    index.htmlから読み取って添える点だけ、そちらより新しい実装に追随している) ─────────────

/** GET / のHTMLに埋め込まれた起動時トークン(window.__AI_EDITOR_TOKEN__)を読み取る。 */
function fetchStartupToken(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET" },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          const m = d.match(/__AI_EDITOR_TOKEN__=("[0-9a-fA-F]+")/);
          if (!m) return reject(new Error("index.htmlから起動時トークンを取得できませんでした"));
          resolve(JSON.parse(m[1]));
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** POST /api/jobs へ動画バイナリを直接送る(ブラウザを介さない)。 */
function postJob(port, token, params, buf) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ ...params, token }).toString();
    const req = http.request(
      {
        host: "127.0.0.1", port, path: `/api/jobs?${q}`, method: "POST",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": buf.length },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      },
    );
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

function readState(jobId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(WORK_ROOT, jobId, "state.json"), "utf-8"));
  } catch (_) {
    return null;
  }
}

/** ジョブの完了(candidates.json到達)または失敗(state.stage===error等)を待つ。 */
async function waitForJobDone(jobId, { timeoutMs = 90_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = readState(jobId);
    if (st && ["error", "cancelled", "timeout"].includes(st.stage)) {
      throw new Error(`ジョブ ${jobId} が失敗しました(stage=${st.stage}): ${st.error || ""}`);
    }
    try {
      return readCandidates(jobId);
    } catch (_) {
      /* まだ candidates.json が無い */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`ジョブ ${jobId} が時間内(${timeoutMs}ms)に完了しませんでした`);
}

/** work/<jobId> 配下にある *.ass ファイルの一覧(再帰なし。字幕はclip-N.assとしてこの階層に直接置かれる)。 */
function listAssFiles(jobId) {
  const dir = path.join(WORK_ROOT, jobId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".ass"));
}

// ── ffprobe計測ユーティリティ(export-preset-check.mjsと同じ手法: 映像ぶんのバイト数だけを
//    packet sizeの合計から取り出す。音声ビットレートの差だけでサイズ差を作る偽物を落とすため) ──

function videoBytes(file) {
  const r = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "packet=size", "-of", "csv=p=0", file,
  ], { encoding: "utf-8" });
  return (r.stdout || "").trim().split("\n").reduce((sum, l) => sum + (Number(l) || 0), 0);
}

function sumVideoBytes(candidates) {
  return candidates.reduce((sum, c) => sum + videoBytes(c.path), 0);
}

/** 字幕の見た目確認専用に、背景が完全な黒の合成素材を作る(testsrcの色柄だと字幕の支配色抽出が
 *  背景ノイズに埋もれるため、他の設定と分けて黒背景の専用素材を使う)。 */
function makeBlackSample(dir, { size = "640x360", durationSec } = {}) {
  const out = path.join(dir, `black-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  const r = spawnSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=size=${size}:color=black:rate=15:duration=${durationSec}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSec}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    out,
  ], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`黒背景素材の作成に失敗: ${r.stderr || ""}`);
  return out;
}

let server = null, browser = null, tmp = null;
try {
  if (!(await ffmpegAvailable())) {
    console.log("ERROR: この検査は実ffmpegを必要とします(ffmpeg/ffprobeが見つかりません)。");
    process.exit(1);
  }

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-cond-recover-compat-"));

  // ============================================================
  // サーバー1(成功する固定応答): CONDITIONAL-UI / CONDITIONAL-BACKEND / COMPAT
  // ============================================================
  const sample = await makeSample(tmp);
  const fakePython1 = installFakePython();
  const fakeClaude1 = installFakeClaude("cond-recover-compat-ok", TOPIC_CLAUDE);
  const started1 = await startServer([fakeClaude1.binDir, fakePython1.binDir], PORT);
  server = started1.child;
  const token1 = await fetchStartupToken(PORT);

  browser = await chromium.launch(chromiumLaunchOptions());

  // ── G-EDIT-UI-SETTINGS-CONDITIONAL-UI ──────────────────────────
  await t("CONDITIONAL-UI: 字幕『なし』では字幕の見た目カードがDOM上で非表示", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector("#card-caption-style", { state: "attached" });
    const hidden = await page.evaluate(() =>
      document.getElementById("card-caption-style").classList.contains("hidden"));
    assert.strictEqual(hidden, true, "初期状態(字幕なし)でcard-caption-styleは非表示のはず");
    await context.close();
  });

  await t("CONDITIONAL-UI: 字幕『あり』へ切り替えると字幕の見た目カードが表示される", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector("#card-caption-style", { state: "attached" });
    await page.click('[data-group="sub"] .chip[data-val="on"]');
    const visible = await page.evaluate(() =>
      !document.getElementById("card-caption-style").classList.contains("hidden"));
    assert.strictEqual(visible, true, "『あり』へ切り替えたらcard-caption-styleは表示されるはず");
    await context.close();
  });

  await t("CONDITIONAL-UI: 対照/『なし』へ戻すと再び非表示になる(片方向だけの実装を見逃さない)", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector("#card-caption-style", { state: "attached" });
    await page.click('[data-group="sub"] .chip[data-val="on"]');
    await page.click('[data-group="sub"] .chip[data-val="none"]');
    const hidden = await page.evaluate(() =>
      document.getElementById("card-caption-style").classList.contains("hidden"));
    assert.strictEqual(hidden, true, "『なし』へ戻したら再び非表示になるはず");
    await context.close();
  });

  // ── G-EDIT-UI-SETTINGS-CONDITIONAL-BACKEND ─────────────────────
  await t("CONDITIONAL-BACKEND: sub=noneで字幕見た目値を強制送信しても.assが一切生成されない", async () => {
    const buf = fs.readFileSync(sample);
    const params = {
      sub: "none", cut: "topic", size: "9:16", name: "sample.mp4",
      subStyle: "pop", captionFont: "mincho", captionFill: "#ff0000",
      captionOutlineColor: "#00ff00", captionInner: "#ffff00", captionBand: "#000000",
      durationMin: "2", exportPreset: "light",
    };
    const res = await postJob(PORT, token1, params, buf);
    assert.strictEqual(res.status, 202, `POST /api/jobs が失敗: ${res.status} ${res.body}`);
    const { jobId } = JSON.parse(res.body);
    assert.ok(jobId, "jobIdが返っていない");

    const data = await waitForJobDone(jobId);
    assert.ok(Array.isArray(data.candidates) && data.candidates.length > 0,
      `ジョブが完走していない: ${JSON.stringify(data)}`);

    const assFiles = listAssFiles(jobId);
    assert.deepStrictEqual(assFiles, [],
      `sub=noneなのに.assファイルが生成されている: ${assFiles.join(", ")}`);
  });

  // ── G-EDIT-UI-SETTINGS-COMPAT (1): 既定の書体・色 ──────────────
  await t("COMPAT(1): 既定値の定義そのものがkaku/白文字/黒縁取りである(subtitle-styles.mjs)", () => {
    assert.strictEqual(DEFAULT_FONT_KEY, "kaku", `既定書体キー: 実 ${DEFAULT_FONT_KEY}`);
    assert.ok(FONT_CATALOG[DEFAULT_FONT_KEY], "既定書体キーがFONT_CATALOGに存在しない");
    assert.strictEqual(FONT_CATALOG[DEFAULT_FONT_KEY].label, "角ゴシック",
      `既定書体ラベル: 実 ${FONT_CATALOG[DEFAULT_FONT_KEY].label}`);
    const def = SUBTITLE_STYLES[DEFAULT_SUBTITLE_STYLE];
    assert.strictEqual(def.base, "&H00FFFFFF", `既定文字色(白): 実 ${def.base}`);
    assert.strictEqual(def.outlineColor, "&H00000000", `既定縁取り色(黒): 実 ${def.outlineColor}`);
  });

  await t("COMPAT(1): 新設定を送らずsub=onで作成した動画に、既定の白文字が実際に描画されている", async () => {
    const blackSample = makeBlackSample(tmp, { durationSec: 12 });
    const buf = fs.readFileSync(blackSample);
    const params = { sub: "on", cut: "topic", size: "9:16", name: "black.mp4" };
    const res = await postJob(PORT, token1, params, buf);
    assert.strictEqual(res.status, 202, `POST /api/jobs が失敗: ${res.status} ${res.body}`);
    const { jobId } = JSON.parse(res.body);

    const data = await waitForJobDone(jobId);
    assert.ok(Array.isArray(data.candidates) && data.candidates.length > 0,
      `ジョブが完走していない: ${JSON.stringify(data)}`);

    // 1本目の候補(セグメント "アルファブラボー" 0.0-2.0s)の0.5秒目を焼き出す。
    // karaokeモードは行全体が区間内ずっと表示され、現在の単語だけ黄色・他は既定の白のまま
    // (src/srt-builder.mjsのkaraokeEvents)なので、区間内のどの時点でも白画素が写る。
    const framePng = extractFramePng(data.candidates[0].path, 0.5);
    const buf2 = readPixelsRgb(framePng);
    const colors = dominantColors(buf2, [0, 0, 0], 16, 16);
    const hasWhite = colors.some((c) => colorClose(c.color, [255, 255, 255], 40) && c.count >= 30);
    assert.ok(hasWhite,
      `既定の白文字が検出できない。上位色: ${JSON.stringify(colors.slice(0, 5))}`);
  });

  // ── G-EDIT-UI-SETTINGS-COMPAT (2): 既定の書き出し設定 ──────────
  await t("COMPAT(2): exportPreset未指定 と 明示的な --export standard がほぼ同じビットレートになる", async () => {
    const buf = fs.readFileSync(sample);

    const postAndWait = async (extra) => {
      const params = { sub: "none", cut: "topic", size: "9:16", name: "sample.mp4", ...extra };
      const res = await postJob(PORT, token1, params, buf);
      assert.strictEqual(res.status, 202, `POST /api/jobs が失敗: ${res.status} ${res.body}`);
      const { jobId } = JSON.parse(res.body);
      const data = await waitForJobDone(jobId);
      assert.ok(Array.isArray(data.candidates) && data.candidates.length > 0,
        `ジョブが完走していない: ${JSON.stringify(data)}`);
      return data.candidates;
    };

    const defaultCandidates = await postAndWait({});
    const standardCandidates = await postAndWait({ exportPreset: "standard" });
    const lightCandidates = await postAndWait({ exportPreset: "light" });

    const defBytes = sumVideoBytes(defaultCandidates);
    const stdBytes = sumVideoBytes(standardCandidates);
    const lightBytes = sumVideoBytes(lightCandidates);

    assert.ok(defBytes > 0 && stdBytes > 0 && lightBytes > 0,
      `映像バイト数の計測に失敗: default=${defBytes} standard=${stdBytes} light=${lightBytes}`);

    const diffRatio = Math.abs(defBytes - stdBytes) / Math.max(defBytes, stdBytes);
    assert.ok(diffRatio <= 0.05,
      `未指定とexportPreset=standardのビットレートが乖離: default=${defBytes} standard=${stdBytes} 差=${(diffRatio * 100).toFixed(1)}%`);

    // 対照: light(crf30)はstandard(crf20)より明確に軽くなるはず。これが崩れていたら、
    // 上のほぼ一致チェックが「measurement差を検出できない壊れた測定」による偽陽性である疑いが出る。
    assert.ok(lightBytes <= stdBytes * 0.9,
      `対照: light がstandardより明確に軽くならない(測定方法がビットレート差を検出できていない疑い): standard=${stdBytes} light=${lightBytes}`);
  });

  await browser.close();
  browser = null;
  await stopServer(server);
  server = null;

  // ============================================================
  // サーバー2(常に失敗するfake claude): RECOVER
  // ============================================================
  const fakePython2 = installFakePython();
  const fakeClaude2 = installFakeClaude("recover-fail", {
    kind: "fail", exit: 1, stderr: "fake claude: 意図的な失敗(RECOVER検査用)\n",
  });
  const started2 = await startServer([fakeClaude2.binDir, fakePython2.binDir], PORT);
  server = started2.child;

  browser = await chromium.launch(chromiumLaunchOptions());

  const readSelections = (page) => page.evaluate(() => {
    const activeVal = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getAttribute("data-val") : null;
    };
    return {
      subStyle: activeVal('[data-group="subStyle"] .chip.is-on'),
      captionFont: activeVal('[data-group="captionFont"] .chip.is-on'),
      captionFill: document.getElementById("caption-fill").value,
      durationMin: document.getElementById("duration-min").value,
      exportPreset: activeVal('[data-group="exportPreset"] .chip.is-on'),
    };
  });

  await t("RECOVER: 失敗後も、リロードせず再度『作る』を押すまで選んだ設定値が画面に残る", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector("#file", { state: "attached" });

    await page.setInputFiles("#file", {
      name: "sample.mp4",
      mimeType: "video/mp4",
      buffer: fs.readFileSync(sample),
    });
    await page.click('[data-group="sub"] .chip[data-val="on"]');
    await page.click('[data-group="subStyle"] .chip[data-val="pop"]');
    await page.click('[data-group="captionFont"] .chip[data-val="mincho"]');
    await page.fill("#caption-fill", "#ff0000");
    await page.dispatchEvent("#caption-fill", "input");
    await page.fill("#duration-min", "2");
    await page.dispatchEvent("#duration-min", "input");
    await page.click('[data-group="exportPreset"] .chip[data-val="light"]');

    const before = await readSelections(page);
    assert.deepStrictEqual(before, {
      subStyle: "pop", captionFont: "mincho", captionFill: "#ff0000",
      durationMin: "2", exportPreset: "light",
    }, `選択直後の値が期待と違う: ${JSON.stringify(before)}`);

    await page.click("#btn-run");
    await page.waitForSelector("#confirm-overlay:not(.hidden)");
    await page.click("#confirm-run");
    await page.waitForSelector("#editing-error:not(.hidden)", { timeout: 60_000 });

    const failed = await page.evaluate(() =>
      !document.getElementById("editing-error").classList.contains("hidden"));
    assert.strictEqual(failed, true, "失敗表示(#editing-error)が出ていない");

    const after = await readSelections(page);
    assert.deepStrictEqual(after, before,
      `失敗後に選択値が変わってしまった: 前=${JSON.stringify(before)} 後=${JSON.stringify(after)}`);

    // 「再度『作る』を押すとき」を実際に再現する: btn-runは失敗後に再有効化されており、
    // 押すと確認オーバーレイが開く。その時点でも値は変わっていないことを確認する。
    const runDisabled = await page.evaluate(() => document.getElementById("btn-run").disabled);
    assert.strictEqual(runDisabled, false, "失敗後にbtn-runが再有効化されていない");

    // 実際のユーザー操作と同じく、失敗した編集中カード(の上に出ている失敗表示)を閉じてから
    // 再度押す(editing-cardはz-index 70でconfirm-overlayのz-index 60より上に浮くため、
    // 開いたままだと確認ダイアログが画面上は覆い隠され押せない。閉じる操作自体は
    // 選択値に影響しない=このあとも値が残っていることを確認する)。
    await page.click("#editing-error-close");
    await page.waitForFunction(() =>
      document.getElementById("editing-card").classList.contains("hidden"));

    await page.click("#btn-run");
    await page.waitForSelector("#confirm-overlay:not(.hidden)");
    const afterSecondPress = await readSelections(page);
    assert.deepStrictEqual(afterSecondPress, before,
      `再度『作る』を押した時点で選択値が変わってしまった: 前=${JSON.stringify(before)} 後=${JSON.stringify(afterSecondPress)}`);

    await page.click("#confirm-back"); // 実際にもう一度焼くコストは払わず、確認導線だけ閉じる
    await context.close();
  });
} finally {
  if (browser) await browser.close();
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
