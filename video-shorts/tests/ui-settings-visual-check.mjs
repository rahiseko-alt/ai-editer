// G-EDIT-UI-SETTINGS-FONT / -FILL / -BAND / -STYLE / -OUTLINE / -INNER — 実ブラウザ×実サーバ×
// 実ffmpegで、画面から選んだ字幕の見た目(書体・文字色・縁取り色・内側縁取り・背景帯・スタイル)が
// 実際に作成された動画の字幕へ反映されることを画素で確認する(docs/roadmap.html 該当葉のcriteria)。
//
// 測定方法について(なぜ実mp4フレームを直接比較しないか):
//   makeSample() が作る素材は ffmpeg の `testsrc`(カラーバー柄)であり、caption-style-render.mjs
//   の既存テスト群が使う黒背景(color=black)と違って画面いっぱいが原色で埋まっている。加えて
//   字幕あり(fit=pad)と字幕なし(fit=cover)ではcanvas寸法自体が変わる(pad側は素材が小さいため
//   拡大ガードが効き640x1136相当・cover側は素材を切り出して1080x1920いっぱいに敷き詰めるため
//   寸法が一致しない)。どちらも「支配色が testsrc の原色バーと衝突する」「寸法が違って比較でき
//   ない」という偽陰性/偽陽性の温床になる(AGENTS.mdの「偽の緑」回避の規律)。
//   そこで、実ジョブ(実ブラウザ操作→実サーバ→実ffmpeg)が実際に work/<jobId>/clip-1.ass へ書き出す
//   「本物の.ass」を読み出し、それを黒背景(color=black、caption-style-render.mjsと同じ手法)へ
//   もう一度焼き直して画素を読む。焼き直す対象は実ジョブが実際に生成した本物の.assそのものであり
//   (合成や再構築はしない)、renderClip()が実際の動画に焼き込む際と同じ ass filter + fontsdir を
//   使うため、書体・色・タグの再現性は動画へ焼いた場合と変わらない。黒背景に変えるのは「何色が
//   支配色か」「何か描かれているか」を曖昧さなく判定するための測定条件の変更に過ぎない。
//
// 実行: node tests/ui-settings-visual-check.mjs (ffmpeg必須。無ければexit 1)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  WORK_ROOT, ffmpegAvailable, makeSample, TOPIC_CLAUDE,
  installFakePython, installFakeClaude, startServer, stopServer,
  chromium, chromiumLaunchOptions, runJobViaBrowser,
  readPixelsRgb, dominantColors, colorClose,
} from "./helpers/ui-settings-e2e-harness.mjs";
import { FONTS_DIR } from "../src/subtitle-styles.mjs";

const PORT = 59241; // このテスト専用の固定ポート(タスク指定)
const ATSEC = 1.2; // 全ジョブで共通: 素材2語目("ブラボー"相当)が表示されている時刻。karaoke/line
                    // モードは区間の全長にわたって何かしら表示中、popモードも単語間の隙間なく
                    // 連続表示されるため(popEventsは次語のstartまでを表示区間にする)、この
                    // 時刻ならどのモードでも字幕本文が表示されている。

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.stack || e.message}`); }
}

// ── 測定ヘルパ ──────────────────────────────────────────────────────────

/** .ass の [Script Info] から PlayResX/PlayResY を読む(黒背景の焼き直しに使うcanvas寸法)。 */
function parsePlayRes(ass) {
  const w = Number(/^PlayResX:\s*(\d+)/m.exec(ass)?.[1]);
  const h = Number(/^PlayResY:\s*(\d+)/m.exec(ass)?.[1]);
  if (!w || !h) throw new Error("assファイルからPlayResX/PlayResYを読み取れません");
  return { w, h };
}

/**
 * 実ジョブが実際に書き出した.assファイルを、黒背景キャンバス(実際の描画に使うのと同じ
 * fontsdir)へそのまま焼き直し、指定秒のフレームをRGB rawへデコードして返す。
 * (caption-style-render.mjsのrenderCaptionFrame()と同じ手法。実.assをそのまま使う点だけが違う)
 */
function renderAssOverBlack(assPath, atSec) {
  const ass = fs.readFileSync(assPath, "utf-8");
  const { w, h } = parsePlayRes(ass);
  const dur = Math.max(atSec + 1, 3);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-visual-"));
  const outPng = path.join(tmp, "frame.png");
  const r = spawnSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", `color=size=${w}x${h}:color=black:d=${dur}`,
    "-vf", `ass=filename=${assPath}:fontsdir=${FONTS_DIR}`,
    "-ss", String(atSec), "-frames:v", "1", outPng]);
  if (r.status !== 0) throw new Error(`ffmpegでのass焼き直しに失敗: ${r.stderr ? r.stderr.toString() : ""}`);
  return { w, h, buf: readPixelsRgb(outPng), ass };
}

/** 黒(既定tol=20)ではない画素数を数える(=何か描かれているか)。 */
function countNonBlack(buf, tol = 20) {
  let n = 0;
  for (let i = 0; i < buf.length; i += 3) {
    if (buf[i] > tol || buf[i + 1] > tol || buf[i + 2] > tol) n++;
  }
  return n;
}

/** 2枚の同寸フレーム間で、しきい値以上に異なる画素数を数える(caption-style-render.mjsのcountDiffPixels相当)。 */
function countDiffPixels(a, b, tol = 20) {
  let n = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 3) {
    if (Math.abs(a[i] - b[i]) > tol || Math.abs(a[i + 1] - b[i + 1]) > tol || Math.abs(a[i + 2] - b[i + 2]) > tol) n++;
  }
  return n;
}

/** 上部(Hookの表示域。全styleでMarginV=150基準・固定)を除いた領域だけを取り出す。 */
function cropBelow(buf, fullW, fullH, y0) {
  const h = fullH - y0;
  const out = Buffer.alloc(fullW * h * 3);
  buf.copy(out, 0, y0 * fullW * 3, fullH * fullW * 3);
  return out;
}

/** dominantColors()の結果一覧のどれかが target に近いか。 */
function anyClose(list, target, tolerance = 24) {
  return list.some((e) => colorClose(e.color, target, tolerance));
}
function findClose(list, target, tolerance = 24) {
  return list.find((e) => colorClose(e.color, target, tolerance))?.color ?? null;
}

/** Caption(本文字幕)のDialogue行だけを取り出す(Hook行・背景帯行(Layer -1)は除く)。 */
function captionDialogueLines(ass) {
  return ass.match(/^Dialogue: 0,[^\n]*,Caption,,0,0,0,,.*$/gm) || [];
}

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const ORANGE = [255, 165, 0];
const BLACK = [0, 0, 0];

// ── 本体 ────────────────────────────────────────────────────────────────

let server = null, browser = null, tmp = null;
try {
  if (!(await ffmpegAvailable())) {
    console.error("この検査は実ffmpegを必要とします(ffmpeg/ffprobeが見つかりません)。");
    process.exit(1);
  }

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-visual-check-"));
  const sample = await makeSample(tmp);
  const fakePython = installFakePython();
  const fakeClaude = installFakeClaude("visual", TOPIC_CLAUDE);
  const started = await startServer([fakeClaude.binDir, fakePython.binDir], PORT);
  server = started.child;
  browser = await chromium.launch(chromiumLaunchOptions());

  /** 1本のジョブを実ブラウザで作成し、実際に書かれた.assのパスを返す。失敗時は例外を投げない
   *  (呼び出し側のjobs[key]がnullのまま残り、依存するt()側でエラーとして報告される)。 */
  async function makeJob(label, opts) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${PORT}/`);
      await page.waitForSelector("#file", { state: "attached" });
      const result = await runJobViaBrowser(page, { filePath: sample, sub: true, ...opts });
      if (result.failed) throw new Error(`ジョブが失敗しました: ${result.errorMessage}`);
      const assPath = path.join(WORK_ROOT, result.jobId, "clip-1.ass");
      if (!fs.existsSync(assPath)) throw new Error(`.assが見つかりません: ${assPath}`);
      return { jobId: result.jobId, assPath };
    } finally {
      await context.close();
    }
  }

  console.log("11本のジョブを実ブラウザ×実サーバ×実ffmpegで作成中(数十秒かかります)...");
  const specs = [
    ["default", {}],
    ["mincho", { captionFont: "mincho" }],
    ["hand", { captionFont: "hand" }],
    ["fillRed", { captionFill: "#FF0000" }],
    ["fillGreen", { captionFill: "#00FF00" }],
    ["bandOn", { captionBand: "#00FFFF" }],
    ["outlineBlue", { captionOutlineColor: "#0000FF" }],
    ["outlineOrange", { captionOutlineColor: "#FFA500" }],
    ["innerOn", { captionInner: "#FFFF00" }],
    ["pop", { subStyle: "pop" }],
    ["bold", { subStyle: "bold" }],
  ];
  // server/index.mjs の jobsRateLimiter は POST /api/jobs を「固定ウィンドウ60秒に10回まで」
  // (キー"global"共通)に制限している(P1-2(E))。11本を間を置かず作ると11本目が429で落ちる
  // ため、10本目を作った直後、最初のジョブ作成からウィンドウが確実に明け直すまで待つ。
  const jobs = {};
  const batchStartedAt = Date.now();
  for (let i = 0; i < specs.length; i++) {
    const [key, opts] = specs[i];
    if (i > 0 && i % 10 === 0) {
      const waitMs = 61_000 - (Date.now() - batchStartedAt);
      if (waitMs > 0) {
        console.log(`  レート制限(60秒に10回まで)のウィンドウ明けを ${Math.ceil(waitMs / 1000)}秒待機...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    try {
      jobs[key] = await makeJob(key, opts);
      console.log(`  OK   ${key} -> ${jobs[key].jobId}`);
    } catch (e) {
      jobs[key] = null;
      console.log(`  ERROR ${key}: ${e.message}`);
    }
  }

  const frameCache = new Map();
  function frameOf(key) {
    if (frameCache.has(key)) return frameCache.get(key);
    const j = jobs[key];
    if (!j) throw new Error(`${key} のジョブが無い(作成に失敗している。上のERROR行を参照)`);
    const r = renderAssOverBlack(j.assPath, ATSEC);
    frameCache.set(key, r);
    return r;
  }
  function assOf(key) {
    const j = jobs[key];
    if (!j) throw new Error(`${key} のジョブが無い(作成に失敗している。上のERROR行を参照)`);
    return fs.readFileSync(j.assPath, "utf-8");
  }

  // ============================================================
  // G-EDIT-UI-SETTINGS-FONT
  // ============================================================
  await t("FONT: 明朝体を選ぶと既定書体と画素で異なる字形になる", async () => {
    const n = countDiffPixels(frameOf("default").buf, frameOf("mincho").buf);
    assert.ok(n > 200, `既定 vs 明朝体 の差分画素数=${n}(> 200 を期待)`);
  });
  await t("FONT: 手書き風を選ぶと既定書体と画素で異なる字形になる", async () => {
    const n = countDiffPixels(frameOf("default").buf, frameOf("hand").buf);
    assert.ok(n > 200, `既定 vs 手書き風 の差分画素数=${n}(> 200 を期待)`);
  });
  await t("FONT: 明朝体と手書き風は互いに異なる字形になる(対照: 常に同じ非既定書体を返す偽実装を検出)", async () => {
    const n = countDiffPixels(frameOf("mincho").buf, frameOf("hand").buf);
    assert.ok(n > 200, `明朝体 vs 手書き風 の差分画素数=${n}(> 200 を期待)`);
  });

  // ============================================================
  // G-EDIT-UI-SETTINGS-FILL
  // ============================================================
  await t("FILL: #FF0000指定で字幕領域の支配色が赤に一致する", async () => {
    const dom = dominantColors(frameOf("fillRed").buf, BLACK, 20, 10);
    assert.ok(anyClose(dom, RED), `支配色一覧=${JSON.stringify(dom.map((d) => d.color))}`);
  });
  await t("FILL: #00FF00指定で字幕領域の支配色が緑に一致する", async () => {
    const dom = dominantColors(frameOf("fillGreen").buf, BLACK, 20, 10);
    assert.ok(anyClose(dom, GREEN), `支配色一覧=${JSON.stringify(dom.map((d) => d.color))}`);
  });
  await t("FILL: 赤指定と緑指定は互いに異なる支配色になる(対照: 常に同じ非既定色を返す偽実装を検出)", async () => {
    const domR = dominantColors(frameOf("fillRed").buf, BLACK, 20, 10);
    const domG = dominantColors(frameOf("fillGreen").buf, BLACK, 20, 10);
    const topR = findClose(domR, RED);
    const topG = findClose(domG, GREEN);
    assert.ok(topR, `赤指定側で赤の支配色が見つからない: ${JSON.stringify(domR.map((d) => d.color))}`);
    assert.ok(topG, `緑指定側で緑の支配色が見つからない: ${JSON.stringify(domG.map((d) => d.color))}`);
    assert.ok(!colorClose(topR, topG), `赤指定=${topR} 緑指定=${topG} が近すぎる`);
  });

  // ============================================================
  // G-EDIT-UI-SETTINGS-BAND
  // ============================================================
  await t("BAND: onにすると背景帯が実際に描かれ、offの画素と明確に異なる", async () => {
    const n = countDiffPixels(frameOf("default").buf, frameOf("bandOn").buf);
    assert.ok(n > 2000, `on vs off の差分画素数=${n}(> 2000 を期待。帯は568x65px相当の矩形)`);
  });

  // ============================================================
  // G-EDIT-UI-SETTINGS-STYLE
  // ============================================================
  await t("STYLE: popはkaraoke(既定)と.ass構造が異なる(fad演出タグが有り、単語ハイライトのタグが無い)", async () => {
    const karaokeLines = captionDialogueLines(assOf("default"));
    const popLines = captionDialogueLines(assOf("pop"));
    assert.ok(karaokeLines.length > 0, "karaokeのCaption行が空");
    assert.ok(popLines.length > 0, "popのCaption行が空");
    assert.ok(
      karaokeLines.some((l) => /\\c&H[0-9A-Fa-f]{8}&/.test(l)),
      "karaoke側に単語ハイライトの色替えタグ(\\c&H..&)が無い(対照が成立していない)",
    );
    assert.ok(
      !popLines.some((l) => /\\c&H[0-9A-Fa-f]{8}&/.test(l)),
      "pop側に単語ハイライトの色替えタグが残っている(karaokeと構造が同じ=偽実装の疑い)",
    );
    assert.ok(
      popLines.some((l) => l.includes("\\fad(40,40)")),
      "pop側にfad演出タグ(\\fad(40,40))が無い(SUBTITLE_STYLES.pop.modeの差が反映されていない)",
    );
    assert.ok(
      !karaokeLines.some((l) => l.includes("\\fad(40,40)")),
      "karaoke側にfad演出タグが付いている(popと構造が同じ=偽実装の疑い)",
    );
  });
  await t("STYLE: boldはkaraoke(既定)と.ass構造が異なる(単語ハイライトのタグが無い)", async () => {
    const boldLines = captionDialogueLines(assOf("bold"));
    assert.ok(boldLines.length > 0, "boldのCaption行が空");
    assert.ok(
      !boldLines.some((l) => /\\c&H[0-9A-Fa-f]{8}&/.test(l)),
      "bold側に単語ハイライトの色替えタグが残っている(karaokeと構造が同じ=偽実装の疑い)",
    );
    const karaokeStyle = (assOf("default").match(/^Style: Caption,.*$/m) || [""])[0];
    const boldStyle = (assOf("bold").match(/^Style: Caption,.*$/m) || [""])[0];
    assert.ok(karaokeStyle && boldStyle && karaokeStyle !== boldStyle,
      `Styleヘッダ行が既定と同一(fontSize/outline/shadow/marginV等が反映されていない): karaoke="${karaokeStyle}" bold="${boldStyle}"`);
  });
  await t("STYLE: popで作成した動画の字幕領域に実際に文字が描画されている(空白のままではない)", async () => {
    const { w, h, buf } = frameOf("pop");
    const cropped = cropBelow(buf, w, h, 200); // 上部200pxはHook表示域(全style共通)なので除く
    const n = countNonBlack(cropped);
    assert.ok(n > 100, `Hook域を除いた非黒画素数=${n}(> 100 を期待。popの本文字幕が実際に描かれているか)`);
  });
  await t("STYLE: boldで作成した動画の字幕領域に実際に文字が描画されている(空白のままではない)", async () => {
    const { w, h, buf } = frameOf("bold");
    const cropped = cropBelow(buf, w, h, 200);
    const n = countNonBlack(cropped);
    assert.ok(n > 100, `Hook域を除いた非黒画素数=${n}(> 100 を期待。boldの本文字幕が実際に描かれているか)`);
  });

  // ============================================================
  // G-EDIT-UI-SETTINGS-OUTLINE
  // ============================================================
  await t("OUTLINE: #0000FF指定で字幕縁取り領域の色が青に一致し、既定(黒)と有意に異なる", async () => {
    const dom = dominantColors(frameOf("outlineBlue").buf, BLACK, 20, 10);
    const match = findClose(dom, BLUE);
    assert.ok(match, `支配色一覧=${JSON.stringify(dom.map((d) => d.color))}`);
    assert.ok(!colorClose(match, BLACK), `検出した色=${match} が黒と区別できない`);
  });
  await t("OUTLINE: #FFA500指定で字幕縁取り領域の色がオレンジに一致し、既定(黒)と有意に異なる", async () => {
    const dom = dominantColors(frameOf("outlineOrange").buf, BLACK, 20, 10);
    const match = findClose(dom, ORANGE);
    assert.ok(match, `支配色一覧=${JSON.stringify(dom.map((d) => d.color))}`);
    assert.ok(!colorClose(match, BLACK), `検出した色=${match} が黒と区別できない`);
  });
  await t("OUTLINE: 青指定とオレンジ指定は互いに異なる縁取り色になる(対照: 常に同じ非既定色を返す偽実装を検出)", async () => {
    const domB = dominantColors(frameOf("outlineBlue").buf, BLACK, 20, 10);
    const domO = dominantColors(frameOf("outlineOrange").buf, BLACK, 20, 10);
    const mb = findClose(domB, BLUE);
    const mo = findClose(domO, ORANGE);
    assert.ok(mb, `青指定側で青の縁取り色が見つからない: ${JSON.stringify(domB.map((d) => d.color))}`);
    assert.ok(mo, `オレンジ指定側でオレンジの縁取り色が見つからない: ${JSON.stringify(domO.map((d) => d.color))}`);
    assert.ok(!colorClose(mb, mo), `青指定=${mb} オレンジ指定=${mo} が近すぎる`);
  });

  // ============================================================
  // G-EDIT-UI-SETTINGS-INNER
  // ============================================================
  await t("INNER: onにすると内側縁取りが実際に描かれ、offの画素と明確に異なる", async () => {
    const n = countDiffPixels(frameOf("default").buf, frameOf("innerOn").buf);
    assert.ok(n > 50, `on vs off の差分画素数=${n}(> 50 を期待)`);
  });
} finally {
  if (browser) await browser.close();
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
