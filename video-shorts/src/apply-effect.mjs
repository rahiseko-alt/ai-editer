// video-shorts エフェクト適用 — 生成済みショートに派手なエフェクトを焼く。
// 全て FFmpeg 標準フィルタ（CPU・無料・追加ビルド不要）。音声は -c:a copy で無劣化。
//
// CLI: node src/apply-effect.mjs <input.mp4> <glitch|neon|shake> <output.mp4>

import { runFfmpeg } from "./render-vertical.mjs";

export const PRESETS = {
  // ① 色収差グリッチ: RGBずらし＋時間ノイズ＋彩度/コントラスト爆上げ＋シャープ
  glitch: {
    label: "色収差グリッチ",
    type: "vf",
    filter:
      "rgbashift=rh=-12:bh=12:rv=7:bv=-7," +
      "noise=alls=14:allf=t," + // temporalのみ・強度↓（u併用はサイズ暴走の原因）
      "eq=contrast=1.3:saturation=1.6:brightness=0.02," +
      "unsharp=5:5:1.3",
  },
  // ② ネオングロー: 自身をぼかして screen 合成で発光させ、彩度UP＋色相を時間回転
  neon: {
    label: "ネオングロー",
    type: "complex",
    filter:
      "[0:v]split[a][b];" +
      "[b]gblur=sigma=20[bb];" +
      "[a][bb]blend=all_mode=screen," +
      "eq=saturation=2.0:contrast=1.1," +
      "hue=H='2*PI*t/4'[v]",
  },
  // ③ ズームシェイク: 1.1倍に拡大し、切り出し位置を sin/cos で揺らしてカメラシェイク
  // 拡大ガード（render-vertical.mjs computeCanvas）で出力canvasが1080x1920より小さくなる
  // ケースがあるため、固定1080x1920ではなく入力解像度(iw/ih)基準の式にする（横断チェック§4）。
  shake: {
    label: "ズームシェイク",
    type: "vf",
    filter:
      "scale=trunc(iw*1.1/2)*2:trunc(ih*1.1/2)*2," +
      "crop=iw/1.1:ih/1.1:" +
      "x='(in_w-in_w/1.1)/2+34*sin(t*12)':" +
      "y='(in_h-in_h/1.1)/2+34*cos(t*10)'",
  },
};

/** 入力動画に preset エフェクトを焼いて output に書き出す */
export function applyEffect(input, preset, output) {
  const p = PRESETS[preset];
  if (!p) throw new Error(`unknown preset: ${preset} (glitch|neon|shake)`);
  const args = ["-y", "-i", input];
  if (p.type === "complex") {
    args.push("-filter_complex", p.filter, "-map", "[v]", "-map", "0:a?");
  } else {
    // -vf でも map を明示し、音声追従を ffmpeg のデフォルト選択（version 依存）に委ねない。
    args.push("-vf", p.filter, "-map", "0:v", "-map", "0:a?");
  }
  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-maxrate", "8M", // VBVキャップ: ノイズ等でビットレートが暴走するのを防ぐ
    "-bufsize", "16M",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    output
  );
  return runFfmpeg(args);
}

// CLI 実行
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("apply-effect.mjs")) {
  const [input, preset, output] = process.argv.slice(2);
  if (!input || !preset || !output) {
    console.error("usage: node src/apply-effect.mjs <input.mp4> <glitch|neon|shake> <output.mp4>");
    process.exit(1);
  }
  applyEffect(input, preset, output)
    .then((r) => console.log(`[OK] ${PRESETS[preset].label} → ${r.output}`))
    .catch((e) => {
      console.error(`[FAIL] ${e.message}`);
      process.exit(1);
    });
}
