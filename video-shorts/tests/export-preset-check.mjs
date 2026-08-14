// 書き出し設定（用途別プリセット＋個別指定）の検査。
// 実行: node tests/export-preset-check.mjs   (全PASSで exit 0)
//
// 背景（2026-08-14 実素材の初回処理・docs/failures.md）:
// 書き出しは `-crf 20` 固定で利用者が選ぶ口が無く、7分10秒の縦型が70.4MBになった。
//
// この検査は、敵対レビューで挙がった「空虚に真」の穴を先に塞いである:
//   (a) 音声ビットレートの差だけでファイルサイズ差が作れてしまう
//       → 映像ぶんのバイト数を分離して測る。
//   (b) 2x2画素・0バイト等の壊れた出力でも「軽い」ので通る
//       → 両方について解像度・フレーム数・音声ストリームの実在を確かめる。
//   (c) 既定を動かすと、既定の書き出し設定を前提に許容差を決めている
//       凍結済みの葉（G-EDIT-REFRAME-D2 等）が黙って壊れる
//       → 既定が従来どおり（libx264 / veryfast / crf 20 / aac 192k）であることを固定する。
//   (d) 6プリセット中2つしか測らないと、残り4つが全部同じでも通る
//       → 6つすべてが ffmpeg 引数として実際に異なる値で現れることを確かめる。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  EXPORT_PRESETS,
  DEFAULT_EXPORT,
  getExportPreset,
  listExportPresets,
  resolveExportSettings,
  exportArgs,
} from "../src/export-presets.mjs";

let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name} ${extra}`);
  }
};

const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

// ── 素材の合成手順（数値で確定する。コミットしない）─────────────────────
// 毎フレーム内容が変わる素材にする。静止画だと両プリセットとも映像が数十KBへ潰れ、
// サイズ比が素材次第の運になるため（レビュー指摘）。
const W = 1080;
const H = 1920;
const FPS = 30;
const DUR = 10; // 秒
const N_FRAMES = FPS * DUR; // 300
const AUDIO_HZ = 440;
const SRC_PATTERN = `testsrc2=size=${W}x${H}:rate=${FPS}:duration=${DUR}`;
const SRC_AUDIO = `sine=frequency=${AUDIO_HZ}:duration=${DUR}`;

// ── 1. 純粋な解決ロジック（ffmpeg 不要）───────────────────────────────

check(
  "既定は standard（指定しなければ従来どおり）",
  DEFAULT_EXPORT === "standard",
  `実 ${DEFAULT_EXPORT}`,
);

// (c) 既定が従来の書き出しと同一であること。ここが動くと、既定の設定を前提に
// 許容差を決めている凍結済みの葉が黙って壊れる。
const std = resolveExportSettings(DEFAULT_EXPORT);
check(
  "既定の書き出しが従来どおり（libx264 / veryfast / crf 20 / aac 192k）",
  std.vcodec === "libx264" && std.preset === "veryfast" && std.crf === 20
    && std.acodec === "aac" && std.abitrate === "192k",
  JSON.stringify(std),
);

// (d) 6プリセットが実際に別物であること。
const keys = Object.keys(EXPORT_PRESETS);
check(
  "プリセットが6つ登録されている",
  keys.length === 6,
  `実 ${keys.length} 件: ${keys.join(",")}`,
);
const argSigs = new Map();
for (const k of keys) argSigs.set(k, exportArgs(resolveExportSettings(k)).join(" "));
check(
  "6プリセットすべてが、ffmpeg 引数として互いに異なる",
  new Set(argSigs.values()).size === keys.length,
  [...argSigs].map(([k, v]) => `${k}=${v}`).join(" / "),
);
check(
  "軽さの並び順が crf で単調（archive < youtube < standard < sns < x < light）",
  ["archive", "youtube", "standard", "sns", "x", "light"]
    .map((k) => resolveExportSettings(k).crf)
    .every((v, i, a) => i === 0 || a[i - 1] < v),
  ["archive", "youtube", "standard", "sns", "x", "light"]
    .map((k) => `${k}=${resolveExportSettings(k).crf}`).join(" "),
);

check("未知のプリセットは null（黙って既定へ落ちない）", getExportPreset("__none__") === null);
check("一覧が6件返る", listExportPresets().length === 6);

// 個別指定：指定した項目だけ上書きされ、他は残る。
const base = resolveExportSettings("sns");
const over = resolveExportSettings("sns", { crf: 33 });
check(
  "個別指定: crf だけが上書きされ、他の項目はプリセットのまま",
  over.crf === 33 && over.vcodec === base.vcodec && over.preset === base.preset
    && over.acodec === base.acodec && over.abitrate === base.abitrate,
  JSON.stringify(over),
);
check(
  "個別指定: 範囲外(99)は採用せずプリセット値が残る",
  resolveExportSettings("sns", { crf: 99 }).crf === base.crf,
  `実 ${resolveExportSettings("sns", { crf: 99 }).crf}`,
);
check(
  "個別指定: 数値でない値は採用せずプリセット値が残る",
  resolveExportSettings("sns", { crf: "abc" }).crf === base.crf,
);
check(
  "個別指定: 境界値 0 と 51 は採用される",
  resolveExportSettings("sns", { crf: 0 }).crf === 0
    && resolveExportSettings("sns", { crf: 51 }).crf === 51,
);
check(
  "個別指定: 境界の外 -1 と 52 は採用されない",
  resolveExportSettings("sns", { crf: -1 }).crf === base.crf
    && resolveExportSettings("sns", { crf: 52 }).crf === base.crf,
);

// 対照: 個別指定を無視する実装／全項目を上書きする実装なら、上の検査が落ちる形か。
check(
  "対照: 個別指定の有無で結果が実際に変わる（素通りしていない）",
  resolveExportSettings("sns", { crf: 33 }).crf !== resolveExportSettings("sns").crf,
);
check(
  "対照: 指定していない項目まで変わる実装なら落ちる形になっている",
  resolveExportSettings("sns", { crf: 33 }).abitrate === EXPORT_PRESETS.sns.abitrate,
);

// ── 2. 実際に焼いて測る（ffmpeg が要る）──────────────────────────────

if (!has("ffmpeg") || !has("ffprobe")) {
  console.log("FAIL ffmpeg/ffprobe が見つかりません。CI では quality ジョブで導入しています。");
  failed++;
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "export-preset-"));
  const src = path.join(tmp, "src.mp4");
  spawnSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", SRC_PATTERN,
    "-f", "lavfi", "-i", SRC_AUDIO,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-shortest", src], { stdio: "ignore" });
  check("素材を合成できた", fs.existsSync(src) && fs.statSync(src).size > 0);

  /** 指定した書き出し設定で焼く。 */
  const bake = (name, settings) => {
    const out = path.join(tmp, `${name}.mp4`);
    const r = spawnSync("ffmpeg", ["-y", "-v", "error", "-i", src,
      ...exportArgs(settings), "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
      { encoding: "utf-8" });
    return { out, ok: r.status === 0, err: (r.stderr || "").slice(0, 200) };
  };

  /** 映像ぶんのバイト数だけを取り出す（音声差でサイズ差を作る偽物を落とすため）。 */
  const videoBytes = (file) => {
    const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "packet=size", "-of", "csv=p=0", file], { encoding: "utf-8" });
    return (r.stdout || "").trim().split("\n")
      .reduce((sum, l) => sum + (Number(l) || 0), 0);
  };
  const probe = (file) => {
    const r = spawnSync("ffprobe", ["-v", "error",
      "-show_entries", "stream=codec_type,codec_name,width,height,nb_frames,bit_rate",
      "-of", "json", file], { encoding: "utf-8" });
    try { return JSON.parse(r.stdout || "{}").streams || []; } catch { return []; }
  };

  const archive = bake("archive", resolveExportSettings("archive"));
  const light = bake("light", resolveExportSettings("light"));
  check("archive で書き出せた", archive.ok, archive.err);
  check("light で書き出せた", light.ok, light.err);

  const aStreams = probe(archive.out);
  const lStreams = probe(light.out);

  // (b) 壊れた出力を「軽いから合格」にしない。
  for (const [label, streams] of [["archive", aStreams], ["light", lStreams]]) {
    const v = streams.find((s) => s.codec_type === "video");
    const a = streams.find((s) => s.codec_type === "audio");
    check(`${label}: 映像ストリームが実在し ${W}x${H} である`,
      !!v && Number(v.width) === W && Number(v.height) === H,
      v ? `${v.width}x${v.height}` : "映像なし");
    check(`${label}: 音声ストリームが実在する`, !!a, a ? a.codec_name : "音声なし");
    check(`${label}: フレーム数が ${N_FRAMES} である（潰れた出力でない）`,
      !!v && Number(v.nb_frames) === N_FRAMES,
      v ? `実 ${v.nb_frames}` : "映像なし");
  }

  // (a) 映像ぶんだけで比べる。音声ビットレートの差でサイズ差を作る偽物を落とす。
  const aV = videoBytes(archive.out);
  const lV = videoBytes(light.out);
  check(
    "archive の映像が十分な情報量を持つ（比の分母が実在する）",
    aV >= 1_000_000,
    `実 ${aV} バイト`,
  );
  // 上限を25%にしたのは、50%だと実測(18.8%)から2.7倍の余裕があり、light が
  // 2.7倍重くなる退行を検出できないため（敵対レビュー指摘）。実測値の直上に線を置く。
  check(
    "light の映像ぶんが archive の映像ぶんの25%以下（音声差ではなく映像で軽くなっている）",
    lV <= aV * 0.25,
    `archive ${aV} / light ${lV} = ${(lV / aV * 100).toFixed(1)}%`,
  );

  // 対照: プリセットを無視して常に同じ設定で焼く実装なら、上の比較が落ちる形か。
  const same1 = bake("same1", resolveExportSettings("standard"));
  const same2 = bake("same2", resolveExportSettings("standard"));
  const s1 = videoBytes(same1.out);
  const s2 = videoBytes(same2.out);
  check(
    "対照: 同じ設定で2回焼くと映像ぶんがほぼ一致する（＝差はプリセットに由来する）",
    Math.abs(s1 - s2) <= Math.max(s1, s2) * 0.01,
    `${s1} vs ${s2}`,
  );
  check(
    "対照: プリセットを無視する実装（常に standard）では25%以下を満たせない",
    !(s2 <= s1 * 0.25),
    `${s1} / ${s2}`,
  );

  // 個別指定が実際に焼き上がりへ届くこと。crf を上げたら必ず小さくなる（向きも見る）。
  const c18 = bake("c18", resolveExportSettings("sns", { crf: 18 }));
  const c34 = bake("c34", resolveExportSettings("sns", { crf: 34 }));
  const v18 = videoBytes(c18.out);
  const v34 = videoBytes(c34.out);
  check(
    "個別指定 --crf が焼き上がりに届く（crf34 の映像が crf18 の60%以下）",
    v34 <= v18 * 0.6,
    `crf18 ${v18} / crf34 ${v34} = ${(v34 / v18 * 100).toFixed(1)}%`,
  );
  const a18 = probe(c18.out).find((s) => s.codec_type === "audio");
  const a34 = probe(c34.out).find((s) => s.codec_type === "audio");
  check(
    "個別指定: crf だけ変えても音声ビットレートは変わらない",
    !!a18 && !!a34 && Math.abs(Number(a18.bit_rate) - Number(a34.bit_rate))
      <= Number(a18.bit_rate) * 0.1,
    `${a18 && a18.bit_rate} vs ${a34 && a34.bit_rate}`,
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n--- ${passed} PASS / ${failed} FAIL ---`);
process.exit(failed === 0 ? 0 : 1);
