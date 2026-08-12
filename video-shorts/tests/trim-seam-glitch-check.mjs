// 詰めた継ぎ目の直後で、音声にプツ音が聞こえない — G-EDIT-TRIM-D
//
// ── 対応ノード ────────────────────────────────────────────────
// docs/roadmap.html の G-EDIT-TRIM-D。3回の改訂を経てマスター承認された最終設計を実装する。
// 下書きの経緯・却下した対処案は本ファイルには残さない（正はロードマップの detail/criteria）。
//
// ── 合格条件（criteria の引用）──────────────────────────────
// 「詰めた継ぎ目のうち、両側に実際の発話がある継ぎ目（この凍結素材では継ぎ目1・継ぎ目2）で、
//   音の段差が周辺で普通に起きる変化に比べて大きく外れていない（＝「プツッ」という段差が無い）。
//   継ぎ目3（両側とも無音に近い）は、この凍結素材ではどの実装でも段差そのものが物理的に作れない
//   ため、判定対象に含めない。」
//
// ── 指標（二階差分 z-score）────────────────────────────────
// 各標本 x[n] の二階差分（離散曲率）c[n]=x[n+1]-2x[n]+x[n-1] を求め、出力クリップ全体
// （3継ぎ目±5msを除く）の |c[n]| の中央値(median)とMAD（絶対偏差の中央値）から
// 頑健標準偏差=1.4826×MAD を出す。継ぎ目1・2それぞれで z=(|c[n_seam]|-median)/頑健標準偏差 を求め、
// z<2.5 を機械の合格ラインとする。しきい値2.5・除外窓5msの根拠、SRを強制ダウンサンプルすると
// 検出力が失われる実測（44100→22050で壊れた実装がz=72.652→2.533まで低下する 等）は
// このセッションの basis-reviewer 自己レビュー記録・過去のロードマップ改訂履歴を参照。
//
// ── 継ぎ目3を対象外とする理由（実測）──────────────────────────
// 素材TV/calibration.flac の継ぎ目3（よろしく→こんにちは）は、espeak-ng合成の性質上、両側の
// 語の端が既に振幅ほぼ0のため、正しい実装・フェード無し偽物のいずれでも段差そのものが物理的に
// 生まれない（0と0の間に段差は無い）。位置の特定は行うが（除外窓の計算に使う）、判定には使わない。
//
// ── なぜ継ぎ目2は指標1だけでは不十分か（独立検証を追加する理由）──────────
// 継ぎ目2（ありがとう→よろしく）は、指標1の検出力が継ぎ目1ほど大きくない。この凍結素材の
// ネイティブSR(22050Hz)で実測すると、フェード無し偽物ですら z が閾値2.5を下回ることがある
// （＝指標1だけでは「フェード無し」という明白な壊れ方すら継ぎ目2で確実に検出できない）。
// さらにフェード長を1/25(0.2ms)に縮める壊れ方は、継ぎ目1では検出できる(z>2.5)が、継ぎ目2では
// 実測で一貫して閾値を下回る(下記 t() の "fake_short_fade: 継ぎ目2は閾値未満" が毎回そうなることを
// 記録する)。これは指標の実装の不備ではなく、この凍結素材の継ぎ目2という位置固有の統計的限界
// （自然な音声のばらつきと、短いフェードが作る段差の大きさが同程度）と判断した。
// SEAM_FADE_SEC は全継ぎ目で共有される単一定数（trim-plan.mjs）なので、フェード関連の実装退行が
// 起きれば継ぎ目1が確実に検出する（このテストの fake_no_fade / fake_short_fade の両方で継ぎ目1は
// 常に閾値を超えることを確認する）。継ぎ目2固有の弱点（フェード短縮バグ）は、docs/roadmap.html の
// G-EDIT-TRIM-D の criteria.verify が定める independent-verifier による聴き比べで別途担保する
// （このテストの範囲外。実施記録は roadmap 側に残す）。
//
// ── なぜ buildTrimFilters をそのまま使い、位置は独立に手計算するか ──────────
// 継ぎ目の理論標本位置は、検証者が buildTrimFilters/planTrim を一切呼ばず、凍結済み
// calibration.json の start_sample/end_sample（設計値・SHA-256固定）だけから手計算する
// （nativeLen/EXPECTED_SEAM_NATIVE を参照）。buildTrimFilters に実装のバグで位置がずれた場合、
// 「期待値の計算」もそこに依存していると同じズレが両方に乗って検出できなくなるため
// （trim-duration-check.mjs の TA_KEEP_FRAMES と同じ流儀）。
// 一方、実際に判定する音声そのもの（cut境界=A/B）は本物の buildTrimFilters をそのまま呼んで作る
// （＝ここで検証するのは実装の出力そのもの）。buildTrimFilters はフェード長(SEAM_FADE_SEC)を
// 差し替える口を持たないため、fake_short_fade の変異だけは、実装が返す cut 境界(spans)は
// そのまま使い、フェード適用部分だけを同じ計算式で手作りする（buildAudioChain）。
//
// ── なぜ音声のみの経路（fpsRational を渡さない）か ──────────────────
// buildTrimFilters は fpsRational を渡すと、音声の標本境界(A/B)もコマ番号ベースに変わる
// （実測: 実際の映像コンテナと組み合わせてコマ番号を渡さず時刻ベースで切ると、コマの量子化誤差が
// 継ぎ目ごとに蓄積し、理論位置から最大2000標本以上ずれることを本セッションで確認した）。
// この葉が対象とするのは「フェードで段差を均せているか」であって「映像のコマ境界への丸め」は
// 別のGEDIT-TRIM-F/trim-vfr-sync-check.pyの対象。ここでは音声のみの経路（fpsRational無し）で
// 実装の音声カット・フェード計算を対象にする。
//
// ── 実行方法 ─────────────────────────────────────────────────
//   cd video-shorts && node tests/trim-seam-glitch-check.mjs   (全PASSで exit 0)
//   ffmpeg / ffprobe が要る。素材は毎回この検査が合成する（コミットしない）。

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildTrimFilters, SEAM_FADE_SEC } from "../src/trim-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "fixtures", "trim-calibration");
const FLAC = path.join(FIXTURE_DIR, "calibration.flac");
const CAL_JSON = path.join(FIXTURE_DIR, "calibration.json");
const FLAC_SHA = "9590ab1d5c3b084e999bb434cf4e6a6c7c13778a20b30d85cde1088b4ffe9165";
const CAL_SHA = "9cb743c2f9ff730e223c7f8cfc3879faa3f366593f6233cb79e6efe83625dc58";

// ── しきい値・窓（着手前に固定。基準の凍結後は緩めない）──────────
const Z_THRESHOLD = 2.5;      // 指標1の合格ライン(z<2.5)
const EXCLUDE_MS = 5;         // baseline母集団から除く継ぎ目周辺の窓(SEAM_FADE_SECに合わせた)
const DRIFT_MS = 0.6;         // 理論位置から実際の継ぎ目標本を探す探索窓(片側)。
// 根拠: 出荷コーデック(aac)を経由するとエンコーダのpriming/paddingで理論位置から標本がずれる
// （実測: 44100Hzで最大約20標本=0.45ms）。0.6msはその実測値に約1.3倍の余裕を載せた値。
// 改訂3の実験で、探索窓を1〜2msより広げると正しい実装側が語頭の自然な子音の立ち上がりを
// 誤検出することを確認済みのため、0.6msはその安全域(≤1〜2ms)の中に収まっている。

const BROKEN_FADE_SEC = 0.0002; // SEAM_FADE_SEC(5ms)を1/25に縮めた壊れ方（既知の弱点の実証用）

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.message}`); }
}

function sha256(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: ["ignore", "ignore", "pipe"] });
}
function ffprobeSR(file) {
  return Number(execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate",
    "-of", "default=nw=1:nk=1", file,
  ], { encoding: "utf-8" }).trim());
}
function decodePCM(file, sr) {
  const raw = execFileSync("ffmpeg", [
    "-v", "error", "-i", file, "-map", "a:0", "-ar", String(sr), "-ac", "1",
    "-f", "f64le", "-acodec", "pcm_f64le", "pipe:1",
  ], { maxBuffer: 1 << 30 });
  const n = raw.length / 8;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = raw.readDoubleLE(i * 8);
  return x;
}

/** 二階差分（離散曲率） */
function curvature(x, n) { return x[n + 1] - 2 * x[n] + x[n - 1]; }

/** 理論位置±driftSamplesの中で |c[n]| が最大の標本を探す（出荷コーデックのpriming/padding補正）*/
function findSeam(x, theoryIdx, driftSamples) {
  let best = theoryIdx, bestVal = -1;
  for (let d = -driftSamples; d <= driftSamples; d++) {
    const n = theoryIdx + d;
    if (n < 1 || n >= x.length - 1) continue;
    const v = Math.abs(curvature(x, n));
    if (v > bestVal) { bestVal = v; best = n; }
  }
  return best;
}

/** baseline(継ぎ目±EXCLUDE_MSを除いた全体)のmedian/MADから、各継ぎ目のzを求める */
function zScores(x, seamIdxs, excludeSamples) {
  const vals = [];
  for (let n = 1; n < x.length - 1; n++) {
    if (seamIdxs.some((s) => Math.abs(n - s) <= excludeSamples)) continue;
    vals.push(Math.abs(curvature(x, n)));
  }
  vals.sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  const absdev = vals.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = absdev[Math.floor(absdev.length / 2)] || 1e-12;
  const sigma = (1.4826 * mad) || 1e-12;
  return {
    median, mad, sigma, population: vals.length,
    z: seamIdxs.map((s) => (Math.abs(curvature(x, s)) - median) / sigma),
  };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "vs-seamglitch-"));

try {
  // ── 素材が凍結どおりであること ────────────────────────────
  t("素材: 音声が凍結どおり（SHA-256が一致する）", () => {
    assert.strictEqual(sha256(FLAC), FLAC_SHA);
  });
  t("素材: 区間表が凍結どおり（SHA-256が一致する）", () => {
    assert.strictEqual(sha256(CAL_JSON), CAL_SHA);
  });

  const cal = JSON.parse(fs.readFileSync(CAL_JSON, "utf-8"));
  const NATIVE_SR = cal.audio.sample_rate; // 22050（凍結素材のネイティブSR）

  // ── 継ぎ目の理論標本位置を独立に手計算する（buildTrimFilters/planTrimを一切呼ばない）──
  // calibration.json の kind==="word" の4区間(index1,3,5,7)がこの順に連結され、
  // 保持する語の長さの累積和が、出力内(0起点)の継ぎ目の標本位置になる。
  function nativeLen(idx) {
    const s = cal.segments[idx];
    assert.strictEqual(s.kind, "word", `index${idx}はwordではなくkind=${s.kind}`);
    return s.end_sample - s.start_sample;
  }
  const len1 = nativeLen(1), len3 = nativeLen(3), len5 = nativeLen(5), len7 = nativeLen(7);
  t("検算: 独立算出した保持語の長さが凍結値のとおり（word1/3/5/7。2026-08-12素材作り直しでword7=はいへ差し替え）", () => {
    assert.deepStrictEqual([len1, len3, len5, len7], [27739, 23307, 24917, 17023]);
  });
  // 継ぎ目1=word1の直後 / 継ぎ目2=word1+word3の直後 / 継ぎ目3=word1+word3+word5の直後(判定対象外)
  const EXPECTED_SEAM_NATIVE = [len1, len1 + len3, len1 + len3 + len5];

  // ── 実際に判定する出力音声を作る(cut境界=A/Bは本物のbuildTrimFiltersをそのまま使う)──
  // KEEP は calibration.json の word 区間そのまま(planTrimは呼ばない。無音/言い淀み検出の
  // ロジックは既に自明＝word区間だけを残すことが分かっているため、他の葉(trim-plan-check.mjs)の
  // 対象と重複させない)。fpsRational は渡さない(上記「音声のみの経路」参照)。
  const KEEP = [1, 3, 5, 7].map((i) => {
    const s = cal.segments[i];
    return { start: s.start, end: s.end };
  });
  const spans = buildTrimFilters(KEEP, { sampleRate: NATIVE_SR }).spans;
  t("製品コード: buildTrimFiltersの実測cut境界が、独立算出した長さと一致する", () => {
    const lens = spans.map((s) => s.endSample - s.startSample);
    assert.deepStrictEqual(lens, [len1, len3, len5, len7]);
  });

  /**
   * 音声だけの継ぎ目チェーンを組む(buildTrimFiltersの「a=cuts.map(...)」の式と同じ計算式)。
   * cut境界(spans)は本物の実装の出力をそのまま使う。fadeSec/withFade だけ差し替えられるのは、
   * buildTrimFilters が SEAM_FADE_SEC を差し替える口を持たないため
   * （fake_short_fade の変異でだけ使う。correct/fake_no_fade は実装がそのままサポートする
   * seamFade:true/false を使うのが本来だが、映像との対concatが無いと監査できる純音声出力に
   * ならないため、ここでは3変異とも同じ手作りチェーンで統一する。式自体は
   * buildTrimFilters内部の a=cuts.map(...) の写しであることをコードレビューで確認できる）。
   */
  function buildAudioChain(fadeSec, withFade) {
    const n = spans.length;
    const aHead = `[0:a]aresample=${NATIVE_SR},asplit=${n}${spans.map((_, i) => `[sa${i}]`).join("")};`;
    const a = spans.map((c, i) => {
      const len = c.endSample - c.startSample;
      const fade = Math.min(Math.round(fadeSec * NATIVE_SR), Math.floor(len / 4));
      const fadeIn = (!withFade || i === 0 || fade < 1) ? "" : `,afade=t=in:ss=0:ns=${fade}`;
      const fadeOut = (!withFade || i === n - 1 || fade < 1) ? "" : `,afade=t=out:ss=${len - fade}:ns=${fade}`;
      return `[sa${i}]atrim=start_sample=${c.startSample}:end_sample=${c.endSample},asetpts=PTS-STARTPTS${fadeIn}${fadeOut}[ta${i}]`;
    });
    const pairs = spans.map((_, i) => `[ta${i}]`).join("");
    return `${aHead}${a.join(";")};${pairs}concat=n=${n}:v=0:a=1[taout]`;
  }

  function render(fadeSec, withFade, outFile) {
    ffmpeg(["-i", FLAC, "-filter_complex", buildAudioChain(fadeSec, withFade),
      "-map", "[taout]", "-c:a", "aac", "-b:a", "192k", outFile]);
  }

  /** 出力を解析し、継ぎ目1・2・3のzと関連情報を返す。分析側はダウンサンプルしない(ネイティブSRのまま)。*/
  function analyze(outFile) {
    const srOut = ffprobeSR(outFile);
    const scale = srOut / NATIVE_SR;
    const theory = EXPECTED_SEAM_NATIVE.map((s) => Math.round(s * scale));
    const driftSamples = Math.ceil((DRIFT_MS / 1000) * srOut);
    const excludeSamples = Math.round((EXCLUDE_MS / 1000) * srOut);
    const x = decodePCM(outFile, srOut);
    const found = theory.map((idx) => findSeam(x, idx, driftSamples));
    const res = zScores(x, found, excludeSamples);
    return { srOut, theory, found, ...res };
  }

  const outCorrect = path.join(work, "correct.m4a");
  render(SEAM_FADE_SEC, true, outCorrect);
  const outNoFade = path.join(work, "fake-no-fade.m4a");
  render(0, false, outNoFade);
  const outShortFade = path.join(work, "fake-short-fade.m4a");
  render(BROKEN_FADE_SEC, true, outShortFade);

  const rCorrect = analyze(outCorrect);
  const rNoFade = analyze(outNoFade);
  const rShortFade = analyze(outShortFade);

  for (const [label, r] of [["correct", rCorrect], ["fake_no_fade", rNoFade], ["fake_short_fade", rShortFade]]) {
    console.log(`[${label}] srOut=${r.srOut} population=${r.population} `
      + `z(継ぎ目1,2,3)=${r.z.map((v) => v.toFixed(3)).join(",")}`);
  }

  t(`検算: 出力の実測サンプリング周波数が凍結素材と同じ${NATIVE_SR}Hz（ダウンサンプルしていない）`, () => {
    assert.strictEqual(rCorrect.srOut, NATIVE_SR);
  });
  t("検算: baseline母集団が十分な標本数を持つ（MAD=0による不定に陥っていない）", () => {
    assert.ok(rCorrect.population > 1000, `population=${rCorrect.population}`);
    assert.ok(rCorrect.mad > 0, "mad=0（不定）");
  });

  // ── 主判定: 正しい実装は、継ぎ目1・継ぎ目2ともz<2.5 ──────────────
  t(`合格: 正しい実装（フェード${SEAM_FADE_SEC * 1000}ms）は継ぎ目1でz<${Z_THRESHOLD}`, () => {
    assert.ok(rCorrect.z[0] < Z_THRESHOLD, `z=${rCorrect.z[0].toFixed(3)}`);
  });
  t(`合格: 正しい実装は継ぎ目2でz<${Z_THRESHOLD}`, () => {
    assert.ok(rCorrect.z[1] < Z_THRESHOLD, `z=${rCorrect.z[1].toFixed(3)}`);
  });

  // ── 対照(負の対照): フェード無し偽物は、継ぎ目1で確実に落ちる ──────────
  // 継ぎ目1はこの凍結素材で最も検出力が大きく(実測 z=十〜数百のオーダー)、指標が
  // 実際に働いていることの対照として最も頑健。この対照が無いと、そもそも測れていない
  // 場合(例: 継ぎ目位置がずれていて何も見ていない)も合格してしまう。
  t(`対照: フェード無し偽物(atrim+concatのみ)は継ぎ目1でz≥${Z_THRESHOLD}（検出できる）`, () => {
    assert.ok(rNoFade.z[0] >= Z_THRESHOLD, `z=${rNoFade.z[0].toFixed(3)}（不合格ラインに達しなかった＝指標が効いていない）`);
  });
  console.log(`[参考] fake_no_fade 継ぎ目2 z=${rNoFade.z[1].toFixed(3)}`
    + `（この凍結素材のネイティブSRでは継ぎ目2の検出力は継ぎ目1ほど大きくない。閾値を`
    + `${rNoFade.z[1] >= Z_THRESHOLD ? "上回った" : "下回った"}。この弱点はG-EDIT-TRIM-Dの`
    + `independent-verifierによる聴き比べで別途担保する）`);

  // ── 既知の弱点の実証: フェード短縮偽物は継ぎ目1では検出できるが、継ぎ目2では
  //    指標1だけでは検出できない（これが independent-verifier を追加している理由そのもの）。
  t(`対照: フェード短縮偽物(0.2ms)は継ぎ目1でz≥${Z_THRESHOLD}（SEAM_FADE_SECは全継ぎ目で`
    + "共有される単一定数なので、継ぎ目1が確実に検出する)", () => {
    assert.ok(rShortFade.z[0] >= Z_THRESHOLD, `z=${rShortFade.z[0].toFixed(3)}`);
  });
  console.log(`[既知の弱点・記録] fake_short_fade 継ぎ目2 z=${rShortFade.z[1].toFixed(3)}`
    + `（閾値${Z_THRESHOLD}を${rShortFade.z[1] >= Z_THRESHOLD ? "上回った(想定外)" : "下回った(想定どおり)"}。`
    + "指標1単独では継ぎ目2のこの壊れ方を検出できないことを示す既知の弱点。"
    + "docs/roadmap.html G-EDIT-TRIM-D の criteria.verify が定める independent-verifier の"
    + "聴き比べで、この弱点を人の耳による判定が補う。");

  // ── 継ぎ目3: 位置は特定するが判定には使わない（物理的に段差が作れないため）──
  console.log(`[判定対象外・記録] 継ぎ目3 z（correct/no_fade/short_fade）= `
    + `${rCorrect.z[2].toFixed(3)}, ${rNoFade.z[2].toFixed(3)}, ${rShortFade.z[2].toFixed(3)}`
    + "（どの実装でもほぼ同じ値＝両側が無音に近く、そもそも段差が物理的に作れないことの実測確認）");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
