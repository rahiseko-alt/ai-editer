// G-EDIT-UI-SETTINGS-DURATION-VISIBILITY / -DURATION-EFFECT / -EXPORT / -COMPOSE
//
// 「1本の目安の長さ」「書き出しプリセット」を画面から選べること、および複数設定を
// 同時に指定しても互いに打ち消し合わないこと(COMPOSE)を、実サーバ・実ffmpeg・実ブラウザで
// 検査する。ヘルパー(tests/helpers/ui-settings-e2e-harness.mjs)は変更しない前提で、
// そのまま import して使う。
//
// 【DURATION-EFFECT / COMPOSE で既定のTRANSCRIPTを使わない理由】
// harness既定のTRANSCRIPT/TOPIC_CLAUDEは合計8.5秒ぶんの発話しか無い。「1分」「4分」を
// 指定しても、pipeline.mjsは無音区間の伸長のような「水増し」は一切しない(mergeShortSegmentsは
// 素材にある区間を貪欲結合するだけ・capSegmentDurationは長い区間を割るだけで短い区間を
// 伸ばさない)ため、8.5秒の素材からは42秒(1分の-30%)にも到底届かない。
// そこで、この検査だけ「1秒ごとに1語(同じ文字)」の長尺カスタムtranscriptと、それを丸ごと
// 1トピックとしてkeepするfake claude応答を自前で用意し、実際に指定尺へ収まる/収まらないを
// 判定できる長さの素材を作る(makeSample自体は空の映像を任意の長さで作れるので、
// 素材の尺そのものは自由に伸ばせる。既定を使わないのはtranscript側の都合)。
//
// 実行: node tests/ui-settings-duration-export-compose-check.mjs (ffmpeg必須。無ければexit 1)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WORK_ROOT, OUT_ROOT, ffmpegAvailable, makeSample, makeBlackSample, TOPIC_CLAUDE,
  installFakePython, installFakeClaude, startServer, stopServer,
  chromium, chromiumLaunchOptions, runJobViaBrowser, readCandidates,
  extractFramePng, readPixelsRgb, colorClose,
} from "./helpers/ui-settings-e2e-harness.mjs";
import { pixelAt } from "./helpers/caption-style-render.mjs";
import { computeCanvas } from "../src/render-vertical.mjs";
import { computeSubtitleScale, scaleToken, hexToAss } from "../src/subtitle-styles.mjs";

const PORT = 59242; // このテスト専用の固定ポート

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.stack || e.message}`); }
}

// ── 小さなユーティリティ ────────────────────────────────────────────────

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`不正なhex: ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function totalFileSize(jobId, candidates) {
  return candidates.reduce((sum, c) => sum + fs.statSync(path.join(OUT_ROOT, jobId, c.file)).size, 0);
}

/**
 * 背景帯(box)の矩形を、実canvas寸法から求める(tests/caption-style-band-check.mjsの
 * expectedBandRect()と同じ式を、スケール(canvasが基準1080x1920より小さい場合の比例縮小・
 * subtitle-styles.mjsのcomputeSubtitleScale/scaleToken)込みに一般化したもの)。
 */
function bandRectFor(canvasW, canvasH, marginV = 400, fontSize = 88) {
  const scale = computeSubtitleScale(canvasW, canvasH);
  const captionMarginLR = scaleToken(60, scale);
  const scaledFontSize = scaleToken(fontSize, scale);
  const scaledMarginV = scaleToken(marginV, scale);
  const bandHeight = Math.round(scaledFontSize * 1.3);
  const x1 = captionMarginLR;
  const w = Math.max(1, canvasW - captionMarginLR * 2);
  const y1 = canvasH - scaledMarginV - bandHeight;
  return { x1, y1, x2: x1 + w, y2: y1 + bandHeight };
}

/**
 * tests/caption-style-band-check.mjsのfillRatio()と同じ式(矩形の外周だけをサンプリング)。
 * このファイルのCOMPOSEシナリオはbuildLongFixture()が120秒ぶんの「あ」を1本のキャプションと
 * して並べるため(尺の指示±30%を検証するのに実尺120秒の素材が要る)、実際の字幕文字列が
 * 帯の横幅いっぱいまで伸びる。caption-style-band-check.mjsの参照実装は短い固定文言
 * ("帯テスト")で上下端の全幅を安全にサンプリングできる前提だったが、ここでは文字が
 * 上下端の中央部分に重なり誤って判定を割ることを実測で確認した(work/配下の実.assで
 * 帯の座標そのものは計算式と完全一致することを確認済み＝製品側の欠陥ではなく、この
 * 検査の素材選びに起因する)。上下端は文字が乗らない左右の縁(xMargin)だけをサンプリングし、
 * 左右端は従来どおり全高をサンプリングする(帯そのものが描かれているかの検出力は保つ)。
 */
function fillRatioInRect(buf, width, rect, target, tolerance = 20, step = 4, borderPx = 12, xMargin = 100) {
  let total = 0, matched = 0;
  const sample = (x, y) => {
    total++;
    if (colorClose(pixelAt(buf, width, x, y), target, tolerance)) matched++;
  };
  for (let x = rect.x1; x < rect.x2; x += step) {
    if (x > rect.x1 + xMargin && x < rect.x2 - xMargin) continue; // 文字が乗りうる中央帯は避ける
    for (let dy = 0; dy < borderPx; dy++) {
      sample(x, rect.y1 + dy);
      sample(x, rect.y2 - 1 - dy);
    }
  }
  for (let y = rect.y1; y < rect.y2; y += step) {
    for (let dx = 0; dx < borderPx; dx++) {
      sample(rect.x1 + dx, y);
      sample(rect.x2 - 1 - dx, y);
    }
  }
  return total > 0 ? matched / total : 0;
}

/** 矩形の中を1px刻みで塗り潰し走査し、指定色に一致する画素数を返す(tests/caption-style-inner-check.mjsのcountColor()と同じ判定式)。 */
function countColorInRect(buf, width, rect, target, tolerance = 20) {
  let n = 0;
  const y0 = Math.max(0, rect.y1), y1 = rect.y2;
  const x0 = Math.max(0, rect.x1), x1 = rect.x2;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (colorClose(pixelAt(buf, width, x, y), target, tolerance)) n++;
    }
  }
  return n;
}

/**
 * 1秒=1語(同じ1文字)の長尺カスタムtranscriptと、それを丸ごと1トピックとしてkeepする
 * fake claude応答(route)を作る。durationMin(N分)を指定しても、素材そのものにN分ぶんの
 * 「残せる本文」が無ければ指定尺には届かない(pipeline.mjsは水増ししない)ため、
 * 検査対象の指定尺より十分長い/短いを作り分けられるようにtotalSecを外から渡す。
 */
function buildLongFixture(totalSec) {
  const words = [];
  for (let i = 0; i < totalSec; i++) words.push({ w: "あ", start: i, end: i + 1 });
  const text = "あ".repeat(totalSec);
  const transcript = {
    language: "ja",
    duration: totalSec,
    words,
    segments: [{ start: 0, end: totalSec, text }],
  };
  const claude = {
    kind: "route",
    // 2026-08-16: 「間を詰める」の判断工程(src/trim-judge.mjs)が増えたので両方へ答える。
    rules: [
      { needle: "文字起こしを校正する人", answer: JSON.stringify({ fixes: [] }) },
      { needle: "話し言葉を編集する人", answer: JSON.stringify({ fillers: [], cutGaps: [] }) },
    ],
    fallback: JSON.stringify({ segments: [{ keepText: text, hook: "H1" }] }),
  };
  return { transcript, claude };
}

async function withServer(claudeBinDir, pythonBinDir, fn) {
  const started = await startServer([claudeBinDir, pythonBinDir], PORT);
  try {
    await fn();
  } finally {
    await stopServer(started.child);
  }
}

let browser = null;
const tmpDirs = [];
function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

try {
  if (!(await ffmpegAvailable())) {
    console.error("この検査は実ffmpegを必要とします(ffmpeg/ffprobeが見つかりません)。");
    process.exit(1);
  }

  browser = await chromium.launch(chromiumLaunchOptions());

  // ════════════════════════════════════════════════════════════════════
  // セッション1: 既定fixture(TOPIC_CLAUDE / 既定TRANSCRIPT) — VISIBILITY + EXPORT
  // ════════════════════════════════════════════════════════════════════
  await (async () => {
    const fakePython = installFakePython();
    const fakeClaude = installFakeClaude("duration-export-compose-default", TOPIC_CLAUDE);
    await withServer(fakeClaude.binDir, fakePython.binDir, async () => {
      // ── G-EDIT-UI-SETTINGS-DURATION-VISIBILITY ──────────────────────
      await t("VISIBILITY: 話題で切るのとき#duration-minがDOM上に見え、分数で切るへ切替えると消える", async () => {
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
          await page.goto(`http://127.0.0.1:${PORT}/`);
          await page.waitForSelector("#file", { state: "attached" });
          assert.ok(
            await page.isVisible("#duration-min"),
            "初期状態(話題で切る)で#duration-minが見えていない",
          );
          assert.ok(
            await page.isVisible("#card-duration"),
            "初期状態(話題で切る)で#card-durationが見えていない",
          );
          await page.click('[data-group="cut"] .chip[data-val="minutes"]');
          assert.ok(
            !(await page.isVisible("#duration-min")),
            "『分数で切る』へ切り替えても#duration-minがDOM上から消えていない",
          );
          assert.ok(
            !(await page.isVisible("#card-duration")),
            "『分数で切る』へ切り替えても#card-durationがDOM上から消えていない",
          );
          // 対照: 『話題で切る』へ戻せば再び見える(トグルが一方向の壊れではないことの確認)。
          await page.click('[data-group="cut"] .chip[data-val="topic"]');
          assert.ok(
            await page.isVisible("#duration-min"),
            "『話題で切る』へ戻しても#duration-minが再表示されない",
          );
        } finally {
          await context.close();
        }
      });

      // ── G-EDIT-UI-SETTINGS-EXPORT ────────────────────────────────────
      await t("EXPORT: 軽くして共有 < 標準 < 高画質で保存 の順でファイルサイズが変わる(両方向)", async () => {
        const tmp = mkTmp("vs-export-");
        const sample = await makeSample(tmp);
        const sizes = {};
        for (const preset of ["", "light", "archive"]) {
          const context = await browser.newContext();
          const page = await context.newPage();
          try {
            await page.goto(`http://127.0.0.1:${PORT}/`);
            await page.waitForSelector("#file", { state: "attached" });
            const { jobId, failed, errorMessage } = await runJobViaBrowser(page, {
              filePath: sample,
              exportPreset: preset,
            });
            assert.ok(!failed, `ジョブ失敗(preset=${preset || "standard"}): ${errorMessage}`);
            const cand = readCandidates(jobId);
            assert.ok(cand.candidates.length > 0, `候補が0件(preset=${preset || "standard"})`);
            sizes[preset || "standard"] = totalFileSize(jobId, cand.candidates);
          } finally {
            await context.close();
          }
        }
        assert.ok(
          sizes.light < sizes.standard,
          `軽くして共有(${sizes.light}B) < 標準(${sizes.standard}B) でない`,
        );
        assert.ok(
          sizes.standard < sizes.archive,
          `標準(${sizes.standard}B) < 高画質で保存(${sizes.archive}B) でない`,
        );
      });
    });
  })();

  // ════════════════════════════════════════════════════════════════════
  // セッション2: 長尺カスタムfixture(280秒) — DURATION-EFFECT
  // ════════════════════════════════════════════════════════════════════
  await (async () => {
    const LONG_SEC = 280;
    const { transcript, claude } = buildLongFixture(LONG_SEC);
    const fakePython = installFakePython(transcript);
    const fakeClaude = installFakeClaude("duration-effect", claude);
    await withServer(fakeClaude.binDir, fakePython.binDir, async () => {
      await t(
        "DURATION-EFFECT: 1分/4分の指定でそれぞれ±30%範囲に収まり、1分側の中央値が4分側より明確に小さい",
        async () => {
          const tmp = mkTmp("vs-duration-");
          const sample = await makeSample(tmp, { size: "640x360", durationSec: LONG_SEC });
          const cases = [
            { label: "1分", durationMin: 1, floorSec: 42, ceilSec: 78 },
            { label: "4分", durationMin: 4, floorSec: 168, ceilSec: 312 },
          ];
          const results = {};
          for (const c of cases) {
            const context = await browser.newContext();
            const page = await context.newPage();
            try {
              await page.goto(`http://127.0.0.1:${PORT}/`);
              await page.waitForSelector("#file", { state: "attached" });
              const { jobId, failed, errorMessage } = await runJobViaBrowser(page, {
                filePath: sample,
                durationMin: c.durationMin,
              });
              assert.ok(!failed, `ジョブ失敗(${c.label}): ${errorMessage}`);
              const cand = readCandidates(jobId);
              const durations = cand.candidates.map((x) => x.duration);
              assert.ok(durations.length > 0, `候補が0件(${c.label})`);
              for (const d of durations) {
                assert.ok(
                  d >= c.floorSec - 0.5 && d <= c.ceilSec + 0.5,
                  `${c.label}指定: 候補の尺${d}秒が範囲[${c.floorSec},${c.ceilSec}]秒の外`,
                );
              }
              results[c.label] = durations;
            } finally {
              await context.close();
            }
          }
          const med1 = median(results["1分"]);
          const med4 = median(results["4分"]);
          assert.ok(
            med1 < med4 / 2,
            `1分側の中央値(${med1.toFixed(1)}秒)が4分側(${med4.toFixed(1)}秒)より明確に小さくない`,
          );
        },
      );
    });
  })();

  // ════════════════════════════════════════════════════════════════════
  // セッション3: 長尺カスタムfixture(120秒・HD 1080x1920) — COMPOSE シナリオA/B
  // ════════════════════════════════════════════════════════════════════
  await (async () => {
    const LONG_SEC = 120; // 2分指定の±30%(84〜156秒)の範囲内に収まる長さ
    const { transcript, claude } = buildLongFixture(LONG_SEC);
    const fakePython = installFakePython(transcript);
    const fakeClaude = installFakeClaude("compose", claude);
    await withServer(fakeClaude.binDir, fakePython.binDir, async () => {
      const tmp = mkTmp("vs-compose-");
      // 1080x1920で素材を作ると render-vertical.mjs の拡大ガードが効かず(k<=1)、
      // 実canvasがちょうど基準解像度(1080x1920・scale=1)になる。
      // tests/caption-style-band-check.mjs / caption-style-inner-check.mjs の数値基準
      // (bold・fontSize88・marginV400・scale=1)をそのまま同じ式で当てはめられるようにするため。
      // 背景帯・内側縁取りの色を厳密に画素比較するため、testsrc(色模様)ではなく無地(黒)背景を使う
      // (testsrcだと模様が縁の色判定に混ざり、90%基準の充填率検査が誤って割れることを実測で確認した)。
      const sample = await makeBlackSample(tmp, { size: "1080x1920", durationSec: LONG_SEC });
      const canvas = computeCanvas("portrait", 1080, 1920, "pad");
      assert.strictEqual(canvas.w, 1080, `想定外のcanvas幅: ${canvas.w}`);
      assert.strictEqual(canvas.h, 1920, `想定外のcanvas高さ: ${canvas.h}`);
      const rect = bandRectFor(canvas.w, canvas.h);
      const ATSEC = 2.0; // 話者「あ」の1行目(0〜18秒ぶん)の中・背景帯は区間全長で表示

      async function runCompose(opts) {
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
          await page.goto(`http://127.0.0.1:${PORT}/`);
          await page.waitForSelector("#file", { state: "attached" });
          const { jobId, failed, errorMessage } = await runJobViaBrowser(page, {
            filePath: sample,
            sub: true,
            ...opts,
          });
          assert.ok(!failed, `ジョブ失敗: ${errorMessage}`);
          const cand = readCandidates(jobId);
          assert.ok(cand.candidates.length > 0, "候補が0件");
          const c0 = cand.candidates[0];
          const mp4 = path.join(OUT_ROOT, jobId, c0.file);
          const size = fs.statSync(mp4).size;
          const png = extractFramePng(mp4, ATSEC);
          const buf = readPixelsRgb(png);
          const assFiles = fs.readdirSync(path.join(WORK_ROOT, jobId)).filter((f) => f.endsWith(".ass"));
          const ass = assFiles.length
            ? fs.readFileSync(path.join(WORK_ROOT, jobId, assFiles[0]), "utf-8")
            : "";
          return { jobId, candidates: cand.candidates, duration: c0.duration, size, buf, ass };
        } finally {
          await context.close();
        }
      }

      // ── シナリオA: 5設定同時(書体・文字色・背景帯・書き出し・目安の長さ) ─────
      const FILL_HEX = "#33CC33";
      const BAND_HEX = "#102040";
      let baselineA = null;
      let composedA = null;
      await t(
        "COMPOSE-A: 書体・文字色・背景帯・書き出し(軽くして共有)・目安の長さ(2分)を同時指定しても、それぞれ単独指定時どおりに効く",
        async () => {
          baselineA = await runCompose({
            subStyle: "bold",
            captionFont: "mincho",
            captionFill: FILL_HEX,
            captionBand: BAND_HEX,
            exportPreset: "",
            durationMin: 2,
          });
          composedA = await runCompose({
            subStyle: "bold",
            captionFont: "mincho",
            captionFill: FILL_HEX,
            captionBand: BAND_HEX,
            exportPreset: "light",
            durationMin: 2,
          });

          // (1) 尺: 両方とも2分の±30%(84〜156秒)に収まる。
          for (const [label, r] of [["標準側", baselineA], ["軽くして共有側", composedA]]) {
            assert.ok(
              r.duration >= 84 - 0.5 && r.duration <= 156 + 0.5,
              `${label}: 尺${r.duration}秒が84〜156秒の外`,
            );
          }

          // (2) ファイルサイズ: 軽くして共有 < 標準(単独指定のEXPORT検査と同じ向き)。
          assert.ok(
            composedA.size < baselineA.size,
            `複合指定でも軽くして共有(${composedA.size}B) < 標準(${baselineA.size}B) でない`,
          );

          // (3) 書体: composedAの.assのCaptionスタイル行が明朝体のファミリ名を持つ
          //     (単独指定時の期待値=tests/caption-style-font-check.mjsのFONT_CATALOG.minchoと同じfamily名)。
          assert.ok(
            /Style: Caption,Noto Serif JP Black,/.test(composedA.ass),
            `.assのCaptionスタイルが明朝体(Noto Serif JP Black)を指していない: ${composedA.ass.split("\n").find((l) => l.startsWith("Style: Caption"))}`,
          );

          // (4) 文字色・背景帯が.assへ矛盾なく両方載っている(どちらかがどちらかを打ち消していない)。
          const fillAss = hexToAss(FILL_HEX);
          const bandAss = hexToAss(BAND_HEX);
          assert.ok(
            composedA.ass.includes(`,${fillAss},`),
            `.assのStyle行に指定した文字色(${fillAss})が無い`,
          );
          assert.ok(
            composedA.ass.includes(`\\1c${bandAss}`),
            `.assの背景帯Dialogueに指定した帯色(${bandAss})が無い`,
          );

          // (5) 実際に焼かれたフレーム: 背景帯が矩形として充填されている(充填率90%以上)。
          const ratio = fillRatioInRect(composedA.buf, canvas.w, rect, hexToRgb(BAND_HEX));
          assert.ok(ratio >= 0.9, `背景帯の充填率が90%未満: ${(ratio * 100).toFixed(1)}%`);

          // (6) 実際に焼かれたフレーム: 指定した文字色が背景帯の矩形内(=文字が乗る領域)で
          //     実際に検出できる(文字が既定色や背景帯色に埋もれていない)。
          const fillCount = countColorInRect(composedA.buf, canvas.w, rect, hexToRgb(FILL_HEX));
          assert.ok(fillCount >= 50, `文字色(${FILL_HEX})の画素が背景帯領域内で50px未満: ${fillCount}px`);
        },
      );

      // ── シナリオB: 内側縁取り+背景帯(競合しうる組合せ) ＋ 目安の長さ+trim ──────
      const INNER_HEX = "#FFFF00";
      const BAND_HEX_B = "#102040";
      await t(
        "COMPOSE-B: 内側縁取り(黄)+背景帯(紺)を同時指定しても両方見え、目安の長さ+間を詰めるでも尺が範囲内",
        async () => {
          const r = await runCompose({
            subStyle: "bold",
            captionInner: INNER_HEX,
            captionBand: BAND_HEX_B,
            durationMin: 2,
            trim: true,
          });

          // (a) 内側縁取りの黄色画素が200px以上検出できる(caption-style-inner-check.mjsと同じ基準)。
          //     testsrcの背景模様に紛れないよう、背景帯の矩形内(=文字が乗る領域)だけを走査する。
          const yellowCount = countColorInRect(r.buf, canvas.w, rect, hexToRgb(INNER_HEX));
          assert.ok(yellowCount >= 200, `内側縁取り(黄)の画素が200px未満: ${yellowCount}px`);

          // (b) 背景帯の矩形外周の充填率が90%以上(caption-style-band-check.mjsと同じ基準)。
          const ratio = fillRatioInRect(r.buf, canvas.w, rect, hexToRgb(BAND_HEX_B));
          assert.ok(ratio >= 0.9, `背景帯の充填率が90%未満: ${(ratio * 100).toFixed(1)}%`);

          // (c) 目安の長さ(2分)+間を詰める(trim)を同時指定しても、各候補の尺が84〜156秒に収まる。
          for (const c of r.candidates) {
            assert.ok(
              c.duration >= 84 && c.duration <= 156,
              `trim併用時の尺${c.duration}秒が84〜156秒の外`,
            );
          }
        },
      );
    });
  })();
} finally {
  if (browser) await browser.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
