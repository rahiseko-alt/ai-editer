// video-shorts 字幕パスのエスケープ実機検証 — 特殊文字を含むパスに置いた .ass を
// 実際の ffmpeg へ渡し、(1) レンダリングが成功し (2) 字幕が本当に焼き込まれた ことを確かめる。
//
// なぜ「成功した」だけでは不十分か:
//   ass フィルタのオプション値のエスケープを間違えると ffmpeg は起動時に落ちる（＝検出できる）が、
//   将来 filter を変えた際に「字幕が無視されて映像だけ出る」形の退行はコード 0 で素通りする。
//   そこで字幕なしで焼いた同じフレームと画を比較し、差が出ることを合格条件に含める。
//
// 実行: node tests/render-escape-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { renderClip, probeSize, runFfmpeg } from "../src/render-vertical.mjs";
import { buildAss } from "../src/srt-builder.mjs";

// 素材はリポジトリに同梱せず ffmpeg の合成ソース(lavfi)で毎回作る。
// バイナリを持たないので差分レビューが読め、CI でも追加のダウンロードが要らない。
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "vs-escape-"));
const SAMPLE = path.join(WORK, "sample-16x9.mp4");

// 字幕は ASCII のみ。CI ランナーに日本語フォントが無くても豆腐にならず、
// 「フォントが無いから画が変わらない」という偽の FAIL を避ける。
const WORDS = [
  { w: "ESCAPE", start: 0.0, end: 1.0 },
  { w: "CHECK", start: 1.0, end: 2.0 },
];
const ASS_BODY = buildAss(WORDS, "PATH ESCAPE", 2.0);

// 検証するパス。ffmpeg のフィルタ解析で意味を持つ文字を、単独と複合の両方で通す。
// dir は path.join に渡すセグメントの配列。
// env FORCE_WIN_CASES=1 で Windows 用のケース集合を他OSでも走らせる（形状の動作確認用）。
// Windows 実機の禁止文字の扱いまでは再現しないので、これは Windows 検証の代用にはならない。
const WIN = process.env.FORCE_WIN_CASES === "1" || process.platform === "win32";

// どのプラットフォームでもディレクトリ名に使える文字。
const COMMON_CASES = [
  { label: "通常のパス", segs: ["plain"] },
  { label: "アポストロフィ '", segs: ["it's dir"] },
  { label: "等号 =", segs: ["eq=ual"] },
  { label: "カンマ , と角括弧 []", segs: ["comma,[bracket]"] },
];

// : と \ は POSIX ではファイル名の正当な1文字なので、そのまま名前に入れて検証する。
const POSIX_ONLY_CASES = [
  { label: "コロン :", segs: ["co:lon"] },
  { label: "バックスラッシュ \\", segs: ["back\\slash"] },
  { label: "複合 ' : \\ = 空白", segs: ["a'b:c\\d=e f"] },
];

// Windows では : は禁止文字・\ は区切り文字なので、ディレクトリ名には入れられない
// （mkdirSync が renderClip に到達する前に落ちる）。ただし Windows の絶対パスは
// 必ずドライブレターの : と区切りの \ を含むため、ネストしたディレクトリにすれば
// path.join が \ を挟み、同じ2文字がエスケープ対象として実パスに現れる。
// ＝名前の付け方は違うが、検証している文字は POSIX 版と同じ。
const WIN_ONLY_CASES = [
  { label: "ドライブレターの : とパス区切りの \\（ネスト）", segs: ["nested", "dir"] },
  { label: "複合 ' = 空白 + ドライブレター/区切り", segs: ["a'b=c d", "sub"] },
];

const CASES = [...COMMON_CASES, ...(WIN ? WIN_ONLY_CASES : POSIX_ONLY_CASES)];

let fail = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) fail++;
  return cond;
};

/** 指定秒のフレームを PNG で抜き出してバイト列を返す（字幕が焼かれたかの比較用） */
async function grabFrame(video, atSec) {
  const png = path.join(WORK, `frame-${Math.random().toString(36).slice(2)}.png`);
  await runFfmpeg(["-y", "-v", "error", "-ss", String(atSec), "-i", video, "-frames:v", "1", png]);
  const buf = fs.readFileSync(png);
  fs.unlinkSync(png);
  return buf;
}

function ffmpegAvailable() {
  return new Promise((res) => {
    const p = spawn("ffmpeg", ["-version"], { windowsHide: true });
    p.on("error", () => res(false));
    p.on("close", (c) => res(c === 0));
  });
}

async function main() {
  // ffmpeg が無い環境では「スキップして緑」にしない（AGENTS.md が禁じる偽の緑）。
  if (!(await ffmpegAvailable())) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }

  await runFfmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=15:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    SAMPLE,
  ]);
  check(fs.existsSync(SAMPLE), "検証用の合成素材を生成した");

  // 基準: 字幕なしで焼いた同じ区間。以降の各ケースはこれと画が変わることを要求する。
  const baseOut = path.join(WORK, "baseline.mp4");
  await renderClip({ input: SAMPLE, start: 0, end: 2, output: baseOut, orientation: "portrait" });
  const baseFrame = await grabFrame(baseOut, 0.5);
  check(baseFrame.length > 0, "字幕なしの基準フレームを取得した");

  // どちらのケース集合を走らせたかを明示する（Windows で走らせた結果を見た人が、
  // POSIX 固有のケースまで通ったと誤読しないようにする）。
  console.log(
    `[INFO] platform=${process.platform} → ${WIN ? "Windows" : "POSIX"} 用のパスケースを実行します（${CASES.length} 件）`
  );

  for (const c of CASES) {
    const dir = path.join(WORK, "cases", ...c.segs);
    fs.mkdirSync(dir, { recursive: true });
    const assPath = path.join(dir, "sub.ass");
    fs.writeFileSync(assPath, ASS_BODY, "utf-8");
    const out = path.join(dir, "out.mp4");

    let rendered = true;
    try {
      await renderClip({
        input: SAMPLE, start: 0, end: 2, assPath, output: out, orientation: "portrait",
      });
    } catch (e) {
      rendered = false;
      console.log(`     └ ${String(e.message).split("\n")[0]}`);
    }
    if (!check(rendered, `${c.label}: 字幕付きレンダリングが成功する`)) continue;

    const size = await probeSize(out);
    check(size.width === 1080 && size.height === 1920,
      `${c.label}: 出力が 1080x1920 (実=${size.width}x${size.height})`);

    // 字幕が本当に焼かれたか＝字幕なしの同じフレームと画が違うか。
    // ここが同一なら、パスが化けて libass が何も描かなかったことを意味する。
    const frame = await grabFrame(out, 0.5);
    check(!frame.equals(baseFrame), `${c.label}: 字幕が実際に焼き込まれている(基準フレームと差がある)`);
  }

  console.log(`\n--- ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ---`);
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log("FAIL 例外: " + (e.message || e));
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
