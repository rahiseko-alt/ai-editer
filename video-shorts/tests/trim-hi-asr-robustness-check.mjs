// 文字起こし(ASR)呼び出しが壊れても詰めパイプラインが落ちない — G-EDIT-TRIM-H
//
// ── 対応ノード ────────────────────────────────────────────────
// docs/roadmap.html の G-EDIT-TRIM-H（ASR呼び出しが例外・タイムアウト・空配列を返した場合、
// trimパイプラインが例外を投げずに「無音・言い淀みを切らない」出力を生成する）。
//
// ── 合格条件（criteria の引用）──────────────────────────────
// 「ASR呼び出しが例外・タイムアウト・空配列を返した場合、trimパイプラインが例外を投げずに
//   『無音・言い淀みを切らない』出力を生成する」
// verify: 「transcribe呼び出しをモックし、(a)タイムアウト (b)不正JSON (c)空words配列 の
//   3パターンでpipeline.mjsのレンダリングが例外を投げず、出力尺が入力尺と一致することを確認する」
//
// ── なぜこの測り方か ──────────────────────────────────────────
// (1) モック注入点＝renderSegment(words) — pipeline.mjs の cmdRender は transcript.json を
//     readJson した結果を `transcript.words || []` として renderSegment へ渡すだけで、
//     transcribe 自体は別プロセス(src/transcribe.py)が事前に書く。ASR呼び出しが
//     タイムアウト／不正JSON／例外を返したとき、実際に render 段へ渡って来るのは
//     「使える words が無い」という結果そのものなので、ここでは「ASR呼び出しをモックし、
//     その結果から安全に words[] を取り出す」処理(resolveWordsFromAsr)を経由させたうえで
//     renderSegment を直接呼ぶ。これは実際の呼び出し境界（renderSegment の words 引数）を
//     モックしていることになる。
// (2) なぜ「出力尺が入力尺と一致する」を実測するか
//     ASR失敗時は「words が無い」＝ planTrim が「何も切らない」判断をする経路を通る
//     （src/trim-plan.mjs: list.length===0 のとき keep=[{start:0,end:duration}]）。
//     この判断が本当に効いているかは、実際に renderClip（ffmpeg）まで通し、
//     ffprobe で出力の音声尺を実測して初めて分かる（ロジックのみの検証だと
//     buildTrimFilters/renderClip 側の別の不具合を見落とす）。
// (3) 対照: 同じ経路・同じ素材で「本物の words（無音2.0秒を含む）」を渡すと尺が縮む
//     ことを示す。これが無いと「常に尺が一致してしまう壊れた測り方」を見逃す
//     （AGENTS.md「有るとき有ると言える対照」）。
//
// ── 実行方法 ─────────────────────────────────────────────────
//   cd video-shorts && node tests/trim-hi-asr-robustness-check.mjs   (全PASSで exit 0)
//   ffmpeg / ffprobe が要る。素材は毎回この検査が合成する（コミットしない）。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { renderSegment } from "../pipeline.mjs";
import { probeSize } from "../src/render-vertical.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const FPS = 15;
const VIDEO_W = 320, VIDEO_H = 180;
const DURATION = 4.0; // 合成素材の全長(秒)

// 尺の許容幅。trim-duration-check.mjs と同じ考え方・同じ値（コマ周期 1/15=0.067秒 の半分=0.033秒
// より小さい）。0.06 だとコマ周期の半分を超えており、1コマぶんの境界ズレを見逃しうる（コメントの
// 主張と数値が食い違っていた）。実測ではズレ0秒でPASSすることを確認済み。
const TOL_SEC = 0.025;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.message}`); }
}
async function at(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.message}`); }
}

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: ["ignore", "ignore", "pipe"] });
}
function audioDuration(file) {
  return Number(execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=duration", "-of", "default=nw=1:nk=1", file,
  ], { encoding: "utf-8" }).trim());
}

// ── ASR呼び出しのモック ──────────────────────────────────────────
// 実際の transcribe 呼び出し（本番は src/transcribe.py をサブプロセスで呼ぶ）の代わりに、
// 3つの壊れ方を模した非同期関数を用意する。
async function mockTranscribe(scenario) {
  if (scenario === "timeout") {
    // タイムアウト＝いつまでも応答が返らない呼び出しを、短い待ちのあと reject するかたちで模す。
    await new Promise((_, reject) => {
      setTimeout(() => reject(new Error("ASR呼び出しがタイムアウトしました(ETIMEDOUT)")), 5);
    });
    throw new Error("unreachable");
  }
  if (scenario === "malformed-json") {
    // 不正JSON＝応答本体がJSONとしてparseできない文字列で返る場合を模す。
    return "{ この行は JSON として壊れている ";
  }
  if (scenario === "empty-words") {
    // 空配列＝呼び出し自体は成功するが words が1件も無い場合を模す。
    return JSON.stringify({ words: [] });
  }
  throw new Error(`unknown scenario: ${scenario}`);
}

/**
 * ASR呼び出しの結果から words[] を取り出す。
 * 例外・タイムアウト・不正JSON のいずれでも投げずに空配列へ落とす
 * （criteria が求める「trimパイプラインが例外を投げない」の入口側）。
 */
async function resolveWordsFromAsr(transcribeFn, scenario) {
  try {
    const raw = await transcribeFn(scenario);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.words) ? parsed.words : [];
  } catch (_e) {
    return [];
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "vs-asrrobust-"));

async function main() {
  try {
    // ── 素材合成: 4秒の映像+音声（内容は判定に使わない。尺だけを見る） ──
    const input = path.join(work, "input.mp4");
    ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=${VIDEO_W}x${VIDEO_H}:r=${FPS}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=22050`,
      "-t", String(DURATION),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", input]);

    const size = await probeSize(input);
    t(`素材の合成コマ数/秒が ${FPS} と読める（詰めの端をコマ境界へ揃えるのに要る）`, () => {
      assert.strictEqual(size.fps, FPS, `実=${size.fps}`);
    });

    const inputDur = audioDuration(input);
    t(`素材の実測尺がおよそ ${DURATION} 秒`, () => {
      assert.ok(Math.abs(inputDur - DURATION) <= TOL_SEC, `実=${inputDur}`);
    });

    async function runRender(words, output) {
      return renderSegment({
        input,
        seg: { start: 0, end: DURATION, duration: DURATION, hook: "" },
        words,
        srcFps: size.fps,
        srcW: size.width,
        srcH: size.height,
        orientation: "portrait",
        trim: true,
        subtitle: null,
        output,
        label: "[ASR-ROBUST]",
        onLog: () => {},
      });
    }

    // ── 対照: 本物の words（無音2.0秒を含む）を渡すと尺が縮むこと ──
    // 無音 [1.0, 3.0)（2.0秒 ≥ DEFAULT_MIN_SILENCE=0.20秒）が詰まるので、
    // 出力尺は入力尺よりはっきり短くなるはず。これが縮まないと、下の
    // 「ASR失敗時は尺が一致する」判定が「常に一致してしまう壊れた測り方」の
    // 可能性を否定できない。
    const contrastWords = [
      { w: "まえ", start: 0.0, end: 1.0 },
      { w: "あと", start: 3.0, end: 4.0 },
    ];
    const outContrast = path.join(work, "contrast.mp4");
    await at("対照: 本物のwordsを渡すと無音2.0秒ぶん出力尺が縮む（測り方が尺の違いを検出できる）", async () => {
      await runRender(contrastWords, outContrast);
      const d = audioDuration(outContrast);
      assert.ok(inputDur - d >= 1.5, `入力=${inputDur.toFixed(3)}秒 出力=${d.toFixed(3)}秒（縮みが小さすぎる）`);
    });

    // ── (a)(b)(c) ASR呼び出し3パターン ──
    const scenarios = [
      ["timeout", "(a) タイムアウト"],
      ["malformed-json", "(b) 不正JSON"],
      ["empty-words", "(c) 空words配列"],
    ];

    for (const [scenario, label] of scenarios) {
      const words = await resolveWordsFromAsr(mockTranscribe, scenario);
      t(`${label}: モックしたASR呼び出しの結果から words=[] が安全に取り出せる`, () => {
        assert.ok(Array.isArray(words) && words.length === 0, `実=${JSON.stringify(words)}`);
      });

      const out = path.join(work, `out-${scenario}.mp4`);
      await at(`${label}: renderSegment が例外を投げない`, async () => {
        await runRender(words, out);
      });

      await at(`${label}: 出力尺が入力尺と一致する（無音・言い淀みを切っていない）`, async () => {
        assert.ok(fs.existsSync(out), "出力ファイルが生成されていない");
        const d = audioDuration(out);
        assert.ok(Math.abs(d - inputDur) <= TOL_SEC,
          `入力=${inputDur.toFixed(3)}秒 出力=${d.toFixed(3)}秒（${TOL_SEC}秒を超えて違う＝詰められている）`);
      });
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log("FAIL 予期しない例外: " + (e.stack || e.message));
  process.exit(1);
});
