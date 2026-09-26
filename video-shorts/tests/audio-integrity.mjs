// video-shorts tests/audio-integrity.mjs — 書き出し後の音声が、選んだ区間の中身そのままか
// （欠けていないか・ずれていないか・繋ぎ目に素材に無い無音が挟まっていないか）を測る。
//
// 【なぜ要るか】2026-08-19、書き出した動画で「きれいに切り分けてくれちゃうんです」が
// 「切ります」のような別の文言になった（docs/handoff.md）。再文字起こしは実素材でしか回せず、
// 実素材はリポジトリに無い。ここでは時刻ごとに周波数が一意に決まる合成音（チャープ）を使い、
// 各区間の中身を元の数式と1サンプル単位で照合する。音声認識を通さないので、結果がぶれない。
//
// 実行: node tests/audio-integrity.mjs   （ffmpeg / ffprobe が必要）

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderFinal } from "../src/edit-job.mjs";

const SR = 48000;
const FPS = 30;
const SOURCE_SEC = 60;
// 合成音: 0.6*sin(2π(200t + 30t²))。瞬時周波数 200+60t Hz（60秒で 3800Hz）なので、
// どの時刻の音も他の時刻と区別できる＝どこがずれた・欠けたかが一意に分かる。
const chirp = (t) => 0.6 * Math.sin(2 * Math.PI * (200 * t + 30 * t * t));

// 区間の両端で照合から外す幅（秒）。renderFinal のフェード 20ms ＋ 余裕 5ms。
const FADE_EXCLUDE_SEC = 0.025;
// 区間の中身が元と一致していると見なす誤差の上限（平均二乗誤差）。AAC の劣化は 1e-4 程度に収まる。
const CONTENT_MSE_MAX = 1e-3;
// 繋ぎ目に挟まってよい無音の上限（秒）。
// 【現状の記録】2026-09-26 時点の renderFinal は、映像がフレーム単位・音声がサンプル単位で切れるため、
// 繋ぎ目ごとに最大1フレーム（1/30秒）の無音が挟まる（docs/再開発計画_Phase0-2.md §2-1）。
// Phase 2 でこれを 1ms 未満にしたら、この値を 0.001 に下げる。
const GAP_MAX_SEC = 1 / FPS + 0.002;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "buffer", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`${cmd} 失敗: ${r.stderr?.toString() ?? ""}`);
  return r.stdout;
}

function makeSource(dir) {
  const src = path.join(dir, "src.mp4");
  run("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=s=320x180:r=${FPS}:d=${SOURCE_SEC}`,
    "-f", "lavfi", "-i", `aevalsrc='0.6*sin(2*PI*(200*t+30*t*t))':s=${SR}:d=${SOURCE_SEC}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "192k",
    src,
  ]);
  return src;
}

function decodePcm(file) {
  const buf = run("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-ac", "1", "-ar", String(SR), "-"]);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

function mse(y, from, srcStartSec, a, b) {
  let err = 0;
  for (let k = a; k < b; k++) {
    const d = y[from + k] - chirp(srcStartSec + k / SR);
    err += d * d;
  }
  return err / (b - a);
}

/**
 * 各区間について「出力のどこに、その区間の中身があるか」を探し、
 * 想定位置（前の区間の長さの累計）からのずれと、中身の一致度を返す。
 * ずれが区間ごとに増えていれば、その差が繋ぎ目に挟まった余分な音（無音）の長さ。
 */
function locateRanges(y, ranges) {
  const out = [];
  let nominal = 0;
  for (const r of ranges) {
    const n = Math.round((r.end - r.start) * SR);
    // 両端のフェード（renderFinal は 20ms）を避けて中央だけを見る。短い破片では 10% より
    // フェードの方が長いので、フェード＋5ms を最低限の除外幅にする。
    const edge = Math.max(Math.floor(n * 0.1), Math.ceil(FADE_EXCLUDE_SEC * SR));
    const a = edge;
    const b = n - edge;
    // ずれの候補は ±50ms。短い窓で位置を決めてから、中央 80% 全体で一致を確かめる。
    const probeA = Math.floor(n / 2);
    const probeB = Math.min(b, probeA + 2048);
    let best = { err: Infinity, lag: 0 };
    for (let lag = -2400; lag <= 2400; lag++) {
      const from = nominal + lag;
      if (from + probeA < 0 || from + probeB > y.length) continue;
      const e = mse(y, from, r.start, probeA, probeB);
      if (e < best.err) best = { err: e, lag };
    }
    const from = nominal + best.lag;
    const whole = from + a >= 0 && from + b <= y.length ? mse(y, from, r.start, a, b) : Infinity;
    out.push({ range: r, offsetSec: best.lag / SR, mse: whole });
    nominal += n;
  }
  return out;
}

function check(label, src, dir, ranges) {
  const outPath = path.join(dir, `${label}.mp4`);
  renderFinal({ videoPath: src, ranges, portrait: false, assPath: null, workDir: dir, outPath });
  const found = locateRanges(decodePcm(outPath), ranges);
  const failures = [];
  found.forEach((f, i) => {
    const name = `${label} 区間${i}（${f.range.start}〜${f.range.end}秒）`;
    if (!(f.mse <= CONTENT_MSE_MAX)) failures.push(`${name}: 中身が元と一致しない（mse=${f.mse.toExponential(2)}）`);
    if (i > 0) {
      const gap = f.offsetSec - found[i - 1].offsetSec;
      console.log(`  ${label} 繋ぎ目${i}: 挟まった音 ${(gap * 1000).toFixed(2)}ms`);
      if (gap > GAP_MAX_SEC) failures.push(`${name} の手前: ${(gap * 1000).toFixed(2)}ms の余分な音`);
      if (gap < -0.001) failures.push(`${name} の手前: ${(-gap * 1000).toFixed(2)}ms 欠けている`);
    }
  });
  return failures;
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-audio-integrity-"));
  try {
    const src = makeSource(dir);
    // 区間の長さ・位置は、映像のフレーム境界に乗らない値（端数）をわざと混ぜる。
    const inOrder = [
      [1.23, 4.87], [7.5, 9.9], [12.01, 18.44], [22.3, 25.0], [30.2, 33.33], [40.1, 44.7], [50.05, 55.5],
    ].map(([start, end]) => ({ start, end }));
    // ダイジェストでは山場を先頭に持ってくる（時系列の入れ替え）。
    const reordered = [inOrder[6], inOrder[0], inOrder[1], inOrder[5], inOrder[2], inOrder[3], inOrder[4]];
    // 言い淀み除去で1区間が細切れになった状態（短い破片が連続する）。
    const fragmented = [
      { start: 20.0, end: 20.6 }, { start: 20.75, end: 21.2 }, { start: 21.3, end: 21.42 }, { start: 21.6, end: 23.0 },
    ];

    const failures = [
      ...check("時系列順", src, dir, inOrder),
      ...check("並べ替え", src, dir, reordered),
      ...check("細切れ", src, dir, fragmented),
    ];
    if (failures.length) {
      console.error("NG");
      for (const f of failures) console.error(`  ${f}`);
      process.exitCode = 1;
    } else {
      console.log("OK: すべての区間の中身が元と一致し、繋ぎ目の余分な音は上限以内");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
