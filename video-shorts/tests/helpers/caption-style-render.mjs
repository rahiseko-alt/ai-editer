// G-EDIT-CAPTION-STYLE のテスト群が共有する「実際にffmpegで1フレーム焼いて画素を読む」ヘルパー。
// subtitle-hook-fit-check.mjs 等、既存テストが使っている手法(ass filter + bbox filter)を
// 字幕スタイルの自由カスタマイズ用に切り出した。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildAss } from "../../src/srt-builder.mjs";
import { FONTS_DIR } from "../../src/subtitle-styles.mjs";

export function hasFfmpeg() {
  return spawnSync("sh", ["-c", "command -v ffmpeg"]).status === 0;
}

/**
 * 指定したstyle(resolveCaptionStyle()の戻り値)でtextを1フレームPNGへ焼く。
 * fontsdir は常に video-shorts/src/fonts(同梱フォント置き場)を明示的に渡す
 * （システムにインストール済みのフォントへフォールバックさせないため）。
 * @returns {{ ok: boolean, stderr: string, outPng: string, tmp: string, assPath: string, ass: string, fontsdir: string }}
 */
export function renderCaptionFrame(text, style, opts = {}) {
  const width = opts.width ?? 1080;
  const height = opts.height ?? 1920;
  const atSec = opts.atSec ?? 0.5;
  const bg = opts.bg ?? "black";
  const duration = 1;
  const relWords = [{ w: text, start: 0, end: duration }];
  const ass = buildAss(relWords, "", duration, { width, height, style, maxChars: 999 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caption-style-"));
  const assPath = path.join(tmp, "cap.ass");
  fs.writeFileSync(assPath, ass, "utf-8");
  const outPng = path.join(tmp, "frame.png");
  const r = spawnSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", `color=size=${width}x${height}:color=${bg}:d=${duration}`,
    "-vf", `ass=filename=${assPath}:fontsdir=${FONTS_DIR}`,
    "-ss", String(atSec), "-frames:v", "1", outPng], { encoding: "utf-8" });
  return { ok: r.status === 0, stderr: r.stderr || "", outPng, tmp, assPath, ass, fontsdir: FONTS_DIR };
}

/** 焼いたPNGをRGB rawへデコードする(Buffer, 長さ=width*height*3)。 */
export function readPixelsRgb(pngPath) {
  const r = spawnSync("ffmpeg", ["-y", "-v", "error", "-i", pngPath,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 128 });
  if (r.status !== 0) throw new Error("ffmpeg raw decode に失敗: " + (r.stderr ? r.stderr.toString() : ""));
  return r.stdout;
}

/** bbox filter(既存テストと同じ手法)で、背景(黒)以外の画素範囲を取得する。無ければ null。 */
export function bboxOf(pngPath, minVal = 24) {
  const r = spawnSync("ffmpeg", ["-i", pngPath, "-vf", `bbox=min_val=${minVal}`, "-f", "null", "-"],
    { encoding: "utf-8" });
  const m = (r.stderr || "").match(/x1:(\d+)\s+y1:\s*(\d+)\s+x2:(\d+)\s+y2:\s*(\d+)/) ||
    (r.stderr || "").match(/x1:(\d+)\s+x2:(\d+)\s+y1:(\d+)\s+y2:(\d+)/);
  // ffmpegのbboxログ実際の書式は "x1:N x2:N y1:N y2:N"。上のパターンで拾えなければこちらを試す。
  const m2 = (r.stderr || "").match(/x1:(\d+)\s+x2:(\d+)\s+y1:(\d+)\s+y2:(\d+)/);
  if (m2) return { x1: +m2[1], x2: +m2[2], y1: +m2[3], y2: +m2[4], stderr: r.stderr };
  if (m) return { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4], stderr: r.stderr };
  return null;
}

/** RGBバッファから (x,y) の色を取り出す。 */
export function pixelAt(buf, width, x, y) {
  const idx = (y * width + x) * 3;
  return [buf[idx], buf[idx + 1], buf[idx + 2]];
}

/** 2枚の同寸フレームの間で、しきい値以上に異なる画素数を数える。 */
export function countDiffPixels(bufA, bufB, threshold = 10) {
  let n = 0;
  const len = Math.min(bufA.length, bufB.length);
  for (let i = 0; i < len; i += 3) {
    const dr = Math.abs(bufA[i] - bufB[i]);
    const dg = Math.abs(bufA[i + 1] - bufB[i + 1]);
    const db = Math.abs(bufA[i + 2] - bufB[i + 2]);
    if (dr > threshold || dg > threshold || db > threshold) n++;
  }
  return n;
}

/**
 * フレーム内の色ヒストグラムを取り、頻度降順で返す(背景色は除外)。
 * @returns {{color:[number,number,number], count:number}[]}
 */
export function dominantColors(buf, bgColor = [0, 0, 0], bgTolerance = 16, topN = 8) {
  const counts = new Map();
  for (let i = 0; i < buf.length; i += 3) {
    const r = buf[i], g = buf[i + 1], b = buf[i + 2];
    if (Math.abs(r - bgColor[0]) <= bgTolerance && Math.abs(g - bgColor[1]) <= bgTolerance &&
      Math.abs(b - bgColor[2]) <= bgTolerance) continue;
    const key = `${r},${g},${b}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key, count]) => ({ color: key.split(",").map(Number), count }));
}

/** ASSの &HAABBGGRR 色文字列を RGB配列へ変換する(比較用)。 */
export function assColorToRgb(ass) {
  const m = /^&H([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(ass);
  if (!m) return null;
  const bb = parseInt(m[2], 16), gg = parseInt(m[3], 16), rr = parseInt(m[4], 16);
  return [rr, gg, bb];
}

/** 2つのRGB色が許容誤差内で一致するか。 */
export function colorClose(a, b, tolerance = 12) {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance &&
    Math.abs(a[2] - b[2]) <= tolerance;
}

export function cleanup(tmp) {
  fs.rmSync(tmp, { recursive: true, force: true });
}
