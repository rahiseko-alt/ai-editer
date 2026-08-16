// つなぎ目に「息継ぎの間」が戻ることの検証（G-EDIT-BREATH）。
//
// 背景（2026-08-14 実素材のダイジェストを見たマスターの指摘「つなぎ目がぎちぎちすぎる。
// 一呼吸or半呼吸の間があるとより自然になる」）：逆マッチングの区間は Whisper の単語境界
// ちょうどなので、素材に元々あった文間の無音が全部捨てられ、詰まった音になっていた。
//
// この検査が確認すること:
//   (A) 発話を捨てた実カットのつなぎ目に、狙いどおりの間ができる（出力を実測）
//   (B) 素材が元々持っていた間より長い間は作らない（0.5秒の間はそのまま0.5秒で残る）
//   (C) 先頭と末尾に余白ができる
//   (F) 余白を伸ばしても、捨てたはずの発話が戻ってこない（対照付き＝検出器が効くことを示す）
//   (G) 素材上で連続する区間は統合され、要らないつなぎ目を作らない
//   (H) 伸ばす先は「実測した無音の内側」であって「単語の隙間」ではない（対照付き）
//   (I) 絵と音の尺がずれない
//   (J) 利用者が間の長さを変えられる／off で従来どおりになる
//   (K) trim（無音・言い淀みを詰める）と併用しても、戻した間が削られない
//   (E) 無音が全く無い素材でも落ちず、従来どおりの区間で出る
//
// === 固定素材（合成・数値で確定。コミットしないので生成手順そのものが正） ===
// 320x240 / 30fps / 音声 44100Hz / 全長 12.1 秒。
//   [1.00, 3.00] 3000Hz 振幅0.3  ← 残す発話1（AAAA）
//   [3.00, 3.09] 3000Hz 振幅0.1  ← ★AAAAの余韻。単語終端(3.0)より音が 0.09 秒だけ長く鳴る
//   [3.50, 5.50] 3000Hz 振幅0.3  ← 残す発話2（BBBB。発話1との間は 0.5 秒＝統合される境界値）
//   [5.70, 5.90] 1200Hz 振幅0.6  ← ★単語表に無い音（文字起こしに載らない笑い声・物音の代わり）
//   [6.30, 8.30]  300Hz 振幅0.9  ← 捨てる発話（CCCC。低い周波数・大きい振幅にして検出可能にしてある）
//   [9.10, 11.10] 3000Hz 振幅0.3 ← 残す発話3（DDDD。発話2との間は 3.6 秒＝実カットになる境界値）
//
// 境界値の選び方（★の2つが要）:
//  ・「間が maxPause 以下（0.5秒）＝統合される側」と「間が maxPause を大きく超える（3.6秒）＝
//    実カットになる側」の両方を1つの素材に含め、片方だけ通る実装で緑にならないようにしてある。
//  ・★余韻[3.00,3.09]: 単語境界と音響的な無音境界が 0.09 秒ずれる。実素材で同じずれ幅により
//    統合に失敗し 0.27 秒の不要なカットが残った（docs/failures.md 2026-08-14）。この素材なら
//    BOUNDARY_TOLERANCE_SEC を defect 当時の値へ戻すと (G) が落ちる。
//  ・★単語表に無い音[5.70,5.90]: 単語の隙間としては [5.5,6.3] が 0.8 秒空いて見えるので、
//    単語境界だけで縛る実装はここへ食い込む。実測無音で縛る実装だけが届かない。これが無いと
//    「実測無音の内側」という中核の縛りを抜いた偽実装が全検査をすり抜ける（実際にすり抜けた）。
//
// 実行: node tests/breath-handles-check.mjs   (全PASSで exit 0。ffmpeg必須)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseSilenceLog, detectSilences, planBreathParts, parseBreathOption,
  DEFAULT_MAX_PAUSE_SEC, DEFAULT_EDGE_PAD_SEC,
} from "../src/breath-handles.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PIPELINE = path.join(ROOT, "pipeline.mjs");

let pass = 0, fail = 0;
/**
 * 1件の検査結果を記録して表示する。
 * @param {boolean} cond 合格ならtrue
 * @param {string} name 検査名（そのままロードマップの verify に対応する）
 * @param {string} [extra] 落ちたときだけ出す実測値など
 * @returns {boolean} cond をそのまま返す（続く検査を打ち切る判断に使う）
 */
function check(cond, name, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); return true; }
  fail++; console.log(`FAIL ${name} ${extra}`); return false;
}
/** 実測値が期待値の±tol以内か */
function near(actual, expected, tol, name) {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  return check(ok, `${name}（期待 ${expected}±${tol} / 実測 ${Number.isFinite(actual) ? actual.toFixed(3) : actual}）`);
}

/**
 * 外部コマンドがこの環境で実行できるか。
 * @param {string} bin コマンド名
 * @returns {boolean}
 */
function cmdAvailable(bin) { return spawnSync(bin, ["-version"]).status === 0; }
// ffmpeg/ffprobe が無いときは SKIP で緑にせず落とす。この検査は出力ファイルを実測することが
// 本体なので、道具が無いまま「成功」を返すと、純粋関数の検査もレンダリングの検査も1つも
// 走っていないのに全体が緑に見える＝偽の緑になる（AGENTS.md「テストは本物だけを置く」）。
if (!cmdAvailable("ffmpeg") || !cmdAvailable("ffprobe")) {
  console.error("ERROR: この検査は出力を実測するため ffmpeg と ffprobe が必須です（見つかりませんでした）");
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────
// 1) 純粋関数の検査（ffmpeg 不要・決定的）
// ────────────────────────────────────────────────────────────────
{
  const log = [
    "[silencedetect @ 0x1] silence_start: 0",
    "[silencedetect @ 0x1] silence_end: 1 | silence_duration: 1",
    "frame= 100 fps=0 [silencedetect @ 0x1] silence_start: 3",
    "[silencedetect @ 0x1] silence_end: 3.5 | silence_duration: 0.5",
  ].join("\n");
  const parsed = parseSilenceLog(log);
  check(parsed.length === 2 && parsed[0].start === 0 && parsed[0].end === 1
    && parsed[1].start === 3 && parsed[1].end === 3.5,
  "parseSilenceLog: 進捗行と混ざった stderr からも無音区間を取り出せる", JSON.stringify(parsed));

  const openEnded = parseSilenceLog("silence_start: 11.1", 12.1);
  check(openEnded.length === 1 && openEnded[0].end === 12.1,
    "parseSilenceLog: 末尾まで無音（silence_end が無い）でも終端で閉じる");
}

// 固定素材と同じ無音の並び。
// 上の AEVAL が作る素材を silencedetect に掛けたときに出る無音区間（実測値と一致させる）。
// [3.09,3.5] は余韻ぶん後ろにずれ、[5.5,5.7]/[5.9,6.3] は単語表に無い音で分断されている。
const SILENCES = [
  { start: 0, end: 1.0 }, { start: 3.09, end: 3.5 }, { start: 5.5, end: 5.7 },
  { start: 5.9, end: 6.3 }, { start: 8.3, end: 9.1 }, { start: 11.1, end: 12.1 },
];
const SEGS = [
  { start: 1.0, end: 3.0, hook: "AAA" },
  { start: 3.5, end: 5.5, hook: "BBB" },
  { start: 9.1, end: 11.1, hook: "DDD" },
];

{
  const plan = planBreathParts(SEGS, SILENCES, { maxPauseSec: 0.7, fps: 30, srcDuration: 12.1 });
  check(plan.parts.length === 2,
    "(G) 素材上で連続する区間が統合され、3区間が2部品になる（要らないつなぎ目を作らない）",
    `実=${plan.parts.length}`);
  check(plan.parts[0].members.join(",") === "0,1" && plan.parts[1].members.join(",") === "2",
    "(G) 統合されたのは間が0.5秒だった区間1+2であり、実カットを挟む区間3は別部品のまま");
  check(plan.joins.length === 1, "(G) つなぎ目は1箇所だけになる", `実=${plan.joins.length}`);

  // 区間照合の確からしさ（選別画面が候補ごとに表示する値）を落とさない。統合した部品では
  // 含まれる区間のうち最も低いものに合わせる＝怪しい区間が混ざったまま「確か」と出さない。
  const conf = planBreathParts(
    [{ ...SEGS[0], confidence: 0.9 }, { ...SEGS[1], confidence: 0.6 }, { ...SEGS[2], confidence: 0.8 }],
    SILENCES, { maxPauseSec: 0.7, fps: 30, srcDuration: 12.1 });
  check(conf.parts[0]?.confidence === 0.6 && conf.parts[1]?.confidence === 0.8,
    "(G) 区間照合の確からしさが部品へ引き継がれ、統合部品では低い方に合わせる",
    JSON.stringify(conf.parts.map((p) => p.confidence)));
  near(plan.joins[0]?.pauseSec, 0.7, 0.04, "(A) 発話を捨てた実カットのつなぎ目に一呼吸ぶんの間が入る");
  near(SEGS[0].start - plan.parts[0].start, DEFAULT_EDGE_PAD_SEC, 0.04, "(C) 先頭に余白が付く");
  near(plan.parts[1].end - SEGS[2].end, DEFAULT_EDGE_PAD_SEC, 0.04, "(C) 末尾に余白が付く");

  // (F) 捨てた発話[6.3,8.3]へ食い込んでいない＝伸ばす先が実測無音の内側に収まっている。
  const intrudes = plan.parts.some((p) => p.end > 6.3 - 1e-9 && p.start < 8.3 + 1e-9);
  check(!intrudes, "(F) どの部品も、捨てた発話[6.3,8.3]の区間へ一切かからない",
    JSON.stringify(plan.parts.map((p) => [p.start, p.end])));

  // (J) 間の長さを変えられる。
  const tight = planBreathParts(SEGS, SILENCES, { maxPauseSec: 0.3, fps: 30, srcDuration: 12.1 });
  const tightJoin = tight.joins.find((j) => j.removedSec > 3);
  near(tightJoin?.pauseSec, 0.3, 0.04, "(J) --breath 0.3 を渡すと実カットの間が0.3秒になる");

  // (E) 無音が1つも見つからない素材では、区間を一切動かさない（従来どおり）。
  const noSil = planBreathParts(SEGS, [], { maxPauseSec: 0.7, fps: 30, srcDuration: 12.1 });
  check(noSil.parts.length === 3
    && noSil.parts.every((p, i) => Math.abs(p.start - SEGS[i].start) < 1e-9
      && Math.abs(p.end - SEGS[i].end) < 1e-9),
  "(E) 無音区間が0件の素材では、区間を伸ばさず従来どおりのまま返す");

  // (F) 二重の縛り: 無音の検出しきい値が甘くても、単語境界の上限が独立に効くこと。
  // 「捨てた短い相槌」が区間の直後 0.05 秒に在り、無音検出はそれを跨いで1つの無音として
  // 拾ってしまった、という最悪ケースを作る。words を渡せば、そこへ届かない。
  const sloppySil = [{ start: 3.0, end: 4.6 }]; // 捨てた発話[3.6,3.9]を跨いだ「甘い」無音
  const dropped = { start: 3.6, end: 3.9 };
  const withWords = planBreathParts(
    [{ start: 1.0, end: 3.0, hook: "X" }, { start: 4.6, end: 6.0, hook: "Y" }],
    sloppySil,
    { maxPauseSec: 0.7, fps: 30, srcDuration: 12.1,
      words: [{ start: 1.0, end: 3.0 }, dropped, { start: 4.6, end: 6.0 }] },
  );
  check(withWords.parts.every((p) => p.end <= dropped.start + 1e-9 || p.start >= dropped.end - 1e-9),
    "(F) 無音検出が捨てた発話を跨いで拾ってしまっても、単語境界の上限が効いて発話へ届かない",
    JSON.stringify(withWords.parts.map((p) => [p.start, p.end])));

  // 台本が時系列を並べ替えた場合は統合しない（統合すると素材の別の場所が丸ごと混入する）。
  const reordered = planBreathParts(
    [SEGS[2], SEGS[0], SEGS[1]], SILENCES, { maxPauseSec: 0.7, fps: 30, srcDuration: 12.1 });
  check(reordered.parts.every((p) => p.members.length === 1
    || p.members.every((m, k, arr) => k === 0 || m === arr[k - 1] + 1)),
  "並べ替えられた台本では、時系列が逆転する区間どうしを統合しない");
}

{
  check(parseBreathOption(undefined).sec === DEFAULT_MAX_PAUSE_SEC,
    "parseBreathOption: 未指定は既定値になる");
  check(parseBreathOption("off").sec === null && parseBreathOption("0").sec === null,
    "parseBreathOption: off / 0 は無効化として扱う");
  check(parseBreathOption("0.5").sec === 0.5, "parseBreathOption: 秒数を受け取る");
  check(parseBreathOption("abc").ok === false && parseBreathOption("-1").ok === false
    && parseBreathOption("99").ok === false,
  "parseBreathOption: 不正値・範囲外は fail-fast する（無言で既定へ落とさない）");
}

// ────────────────────────────────────────────────────────────────
// 2) 実レンダリングまでの検査
// ────────────────────────────────────────────────────────────────
const FIX_DUR = 12.1;
// 固定素材の設計（境界値分析）。合成素材は実素材の汚さを再現しないので、実素材で実際に
// 起きた2つの壊れ方を、素材の側にわざと仕込んである（basis-reviewer の反証1・2）。
//   ① 余韻 [3.00,3.09]：AAAA の単語終端は 3.0 だが、音は 0.09 秒だけ後まで鳴る。
//      ＝単語境界と音響的な無音境界がずれる。実素材で 0.09 秒ずれていたため統合に失敗し、
//      0.27 秒の不要なカットが残った（docs/failures.md 2026-08-14）。この素材は
//      BOUNDARY_TOLERANCE_SEC が 0.09 未満だと統合に失敗する＝許容値の境界を踏んでいる。
//   ② 単語表に無い音 [5.70,5.90]（1200Hz）：文字起こしに載らない音（笑い声・物音・
//      Whisper が拾い損ねた発話）。単語境界だけで縛る実装はここへ食い込むが、
//      silencedetect の実測で縛る実装は届かない。＝この機能の中核である
//      「実測した無音の内側でだけ伸ばす」を、単語境界による縛りと区別して検出できる。
const AEVAL = "0.3*sin(2*PI*3000*t)*between(t,1,3)"
  + "+0.1*sin(2*PI*3000*t)*between(t,3.0,3.09)"
  + "+0.3*sin(2*PI*3000*t)*between(t,3.5,5.5)"
  + "+0.6*sin(2*PI*1200*t)*between(t,5.7,5.9)"
  + "+0.9*sin(2*PI*300*t)*between(t,6.3,8.3)"
  + "+0.3*sin(2*PI*3000*t)*between(t,9.1,11.1)";
/** 単語表に無い音(1200Hz)の帯域のピーク音量(dB)。食い込んでいないかを測るのに使う。 */
function noiseBandPeakDb(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file,
    "-af", "bandpass=f=1200:width_type=h:w=150,bandpass=f=1200:width_type=h:w=150,volumedetect",
    "-f", "null", "-"], { encoding: "utf-8" });
  const m = (r.stderr || "").match(/max_volume:\s*(-?[0-9.]+) dB/);
  return m ? Number(m[1]) : NaN;
}

/**
 * ffprobe で1本のストリームの尺（秒）を実測する。
 * @param {string} file 対象ファイル
 * @param {string} stream ffprobe の -select_streams へ渡す指定（例 "a:0" / "v:0"）
 * @returns {number} 秒。取得できなければ NaN
 */
function ffprobeDur(file, stream) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", stream,
    "-show_entries", "stream=duration", "-of", "default=nw=1:nk=1", file], { encoding: "utf-8" });
  return Number((r.stdout || "").trim().split("\n")[0]);
}

/** 出力の無音区間を実測する */
function measureSilences(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file,
    "-af", "silencedetect=noise=-40dB:d=0.15", "-f", "null", "-"], { encoding: "utf-8" });
  return parseSilenceLog(r.stderr || "", ffprobeDur(file, "a:0"));
}

/** 500Hz以下の帯域のピーク音量(dB)。捨てた発話(300Hz)が残っていないかを測るのに使う。 */
function lowBandPeakDb(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file,
    "-af", "lowpass=f=500,lowpass=f=500,volumedetect", "-f", "null", "-"], { encoding: "utf-8" });
  const m = (r.stderr || "").match(/max_volume:\s*(-?[0-9.]+) dB/);
  return m ? Number(m[1]) : NaN;
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "vs-breath-"));
const cleanup = [WORK];
try {
  const input = path.join(WORK, "breath-fixture.mp4");
  const gen = spawnSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=black:s=320x240:r=30:d=${FIX_DUR}`,
    "-f", "lavfi", "-i", `aevalsrc=exprs='${AEVAL}':s=44100:d=${FIX_DUR}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-shortest", input], { encoding: "utf-8" });
  if (!check(gen.status === 0 && fs.existsSync(input), "固定素材(合成・12.1秒)を生成した",
    (gen.stderr || "").slice(-400))) throw new Error("固定素材の生成に失敗");

  // 素材そのものが設計どおりの無音の並びになっていること（＝以降の期待値の前提）。
  const srcSil = await detectSilences(input, { duration: FIX_DUR });
  check(srcSil.length === 6, `素材の無音が設計どおり6箇所ある（実=${srcSil.length}）`,
    JSON.stringify(srcSil.map((s) => [s.start.toFixed(2), s.end.toFixed(2)])));

  // (F) の対照: この測り方は「捨てる発話(300Hz)が有るときに、有ると言える」。
  const srcLowDb = lowBandPeakDb(input);
  check(srcLowDb > -6, `(F・対照) 素材には300Hzの発話があり、低域ピークが高く出る（実=${srcLowDb}dB）`);

  const transcript = {
    language: "en", duration: FIX_DUR,
    words: [
      { w: "AAAA", start: 1.0, end: 3.0 },
      { w: "BBBB", start: 3.5, end: 5.5 },
      { w: "CCCC", start: 6.3, end: 8.3 },
      { w: "DDDD", start: 9.1, end: 11.1 },
    ],
    segments: [{ start: 1.0, end: 11.1, text: "AAAA BBBB CCCC DDDD" }],
  };
  // CCCC（捨てる発話）は台本に入れない。
  const llmResponse = {
    segments: [
      { keepText: "AAAA", hook: "AAAA" },
      { keepText: "BBBB", hook: "BBBB" },
      { keepText: "DDDD", hook: "DDDD" },
    ],
  };
  // (F) の対照用。同じ経路・同じ書き出し設定で CCCC を「残す」台本。捨てた発話が本当に
  // 消えているのかを、素材ではなく**同じパイプラインの出力どうし**で比べるために使う。
  const llmWithDropped = {
    segments: [
      { keepText: "AAAA", hook: "AAAA" },
      { keepText: "BBBB", hook: "BBBB" },
      { keepText: "CCCC", hook: "CCCC" },
      { keepText: "DDDD", hook: "DDDD" },
    ],
  };

  /** init → 固定の transcript/llm-response を置く → render し、digest のパスを返す */
  function runCase(extraArgs, llm = llmResponse, opts = {}) {
    const src = opts.input || input;
    const tr = opts.transcript || transcript;
    const init = spawnSync(process.execPath,
      [PIPELINE, "init", src, "--mode", "digest", "--sub", "off", "--orient", "横"],
      { cwd: ROOT, encoding: "utf-8" });
    if (init.status !== 0) throw new Error(`init 失敗: ${init.stderr}`);
    const workDir = init.stdout.trim();
    cleanup.push(workDir);
    if (opts.statePatch) {
      const sp = path.join(workDir, "state.json");
      fs.writeFileSync(sp, JSON.stringify({ ...JSON.parse(fs.readFileSync(sp, "utf-8")), ...opts.statePatch }), "utf-8");
    }
    fs.writeFileSync(path.join(workDir, "transcript.json"), JSON.stringify(tr), "utf-8");
    fs.writeFileSync(path.join(workDir, "llm-response.json"), JSON.stringify(llm), "utf-8");
    // 2026-08-16: 「間を詰める」を選んだときは、どこを詰めてよいかのAIの判断（trim-judge.json）が
    // 要る（G-EDIT-TRIM2-FAILSTOP。無いと render は止まる）。この検査が確かめたいのは
    // 「詰めても、息継ぎのために戻した間が削られないこと」なので、AI が「どの間も詰めてよい」と
    // 答えた状態を再現する（＝いちばん厳しい条件。それでも protect が守られることを見る）。
    if (opts.statePatch?.trim === "on" || opts.statePatch?.trimSilence === "on") {
      const idx = (tr.words || []).map((_, i) => i);
      fs.writeFileSync(
        path.join(workDir, "trim-judge.json"),
        JSON.stringify({ fillers: [], cutGaps: idx, total: idx.length, dropped: [] }),
        "utf-8",
      );
    }
    const r = spawnSync(process.execPath,
      [PIPELINE, "render", workDir, "--mode", "digest", ...extraArgs],
      { cwd: ROOT, encoding: "utf-8" });
    const state = JSON.parse(fs.readFileSync(path.join(workDir, "state.json"), "utf-8"));
    const outDir = path.join(ROOT, "output", state.id);
    cleanup.push(outDir);
    return { r, state, outDir, digest: path.join(outDir, `digest-${state.id}.mp4`) };
  }

  // ── 既定（--breath 未指定＝0.7秒）────────────────────────────────
  const on = runCase([]);
  if (!check(on.r.status === 0 && fs.existsSync(on.digest),
    "既定（間あり）で digest が生成される", (on.r.stderr || "").slice(-600))) {
    throw new Error("render に失敗したため以降の実測ができません");
  }
  check(/息継ぎの間/.test((on.r.stdout || "") + (on.r.stderr || "")),
    "レンダリング時に間の適用がログへ出る");

  const sil = measureSilences(on.digest);
  const vDur = ffprobeDur(on.digest, "v:0");
  const aDur = ffprobeDur(on.digest, "a:0");

  // 期待: 部品1=[0.6667,5.8667](5.2s) + 部品2=[8.7667,11.4667](2.7s) = 7.9s
  near(aDur, 7.9, 0.12, "(G) 統合と間の反映後、digest の尺が設計どおりになる");
  check(Math.abs(vDur - aDur) < 0.05,
    `(I) 絵と音の尺がずれない（映像 ${vDur?.toFixed(3)} / 音声 ${aDur?.toFixed(3)}）`);

  const head = sil.find((s) => s.start < 0.05);
  near(head ? head.end - head.start : NaN, 0.333, 0.06, "(C) 先頭に余白がある");
  const tail = sil.find((s) => Math.abs(s.end - aDur) < 0.12);
  near(tail ? tail.end - tail.start : NaN, 0.367, 0.06, "(C) 末尾に余白がある");

  const durs = sil.map((s) => s.end - s.start);
  // 単語終端 3.0 → 次の単語 3.5 の 0.5 秒ぶんの素材が、そのまま丸ごと残る。ただし
  // そのうち先頭 0.09 秒は AAAA の余韻（音が鳴っている）なので、無音として測れるのは
  // 0.41 秒。ここで 0.5 を期待すると「素材のまま残す」ではなく「無音を作る」実装を
  // 通してしまうため、素材が実際に持っている無音の長さで判定する。
  check(durs.some((d) => Math.abs(d - 0.41) <= 0.06),
    "(B) 素材が元々持っていた間（無音0.41秒＋余韻0.09秒）が、そのままの長さで残っている",
    JSON.stringify(durs.map((d) => d.toFixed(3))));
  check(durs.some((d) => Math.abs(d - 0.7) <= 0.06),
    "(A) 発話を捨てた実カットのつなぎ目に、一呼吸ぶん(0.7秒)の間ができている",
    JSON.stringify(durs.map((d) => d.toFixed(3))));

  // (F) 対照は「同じ経路で CCCC を残した出力」。素材と比べるのではなく、同じレンダリング・
  // 同じ書き出し設定を通した出力どうしで比べる（合成トーンの立ち上がりが作る広帯域の
  // 過渡音は両方に等しく乗るので、差はもっぱら300Hzの発話の有無になる）。
  const withDropped = runCase([], llmWithDropped);
  const ctrlLowDb = check(withDropped.r.status === 0 && fs.existsSync(withDropped.digest),
    "(F・対照) 捨てた発話を残す台本でも digest が生成される", (withDropped.r.stderr || "").slice(-400))
    ? lowBandPeakDb(withDropped.digest) : NaN;
  check(ctrlLowDb > -12,
    `(F・対照) 同じ経路で CCCC を残すと、低域ピークが高く出る＝この測り方は「有るとき有る」と言える（実=${ctrlLowDb}dB）`);

  const outLowDb = lowBandPeakDb(on.digest);
  check(outLowDb < -25 && outLowDb < ctrlLowDb - 20,
    `(F) 捨てた発話(300Hz)が出力に戻ってきていない（実=${outLowDb}dB / 同一経路の対照=${ctrlLowDb}dB / 素材=${srcLowDb}dB）`);

  // ── --breath off（従来どおり）────────────────────────────────────
  const off = runCase(["--breath", "off"]);
  if (check(off.r.status === 0 && fs.existsSync(off.digest),
    "--breath off でも digest が生成される", (off.r.stderr || "").slice(-600))) {
    const offDur = ffprobeDur(off.digest, "a:0");
    near(offDur, 6.0, 0.12, "(J) --breath off では間が付かず、発話ぶんだけの尺(6.0秒)になる");
    check(offDur < aDur - 1.5,
      `(J) off より既定の方が確実に長い＝間は既定でだけ足されている（off ${offDur?.toFixed(2)}s < 既定 ${aDur?.toFixed(2)}s）`);
    const offSil = measureSilences(off.digest);
    const offHead = offSil.find((s) => s.start < 0.05);
    check(!offHead || offHead.end - offHead.start < 0.1,
      "(J・対照) --breath off では先頭に余白が付かない（余白は間の機能によるものだと示す）");
  }

  // ── (H) 伸ばす先は「実測した無音の内側」であって「単語の隙間」ではない ──────────
  // 素材 [5.7,5.9] には、文字起こしに載っていない音(1200Hz)が置いてある。単語境界だけを
  // 見て伸ばす実装はここへ食い込む（単語 BBBB の終わり 5.5 の次の単語は 6.3 なので、
  // 単語の隙間としては 0.8 秒空いて見える）。silencedetect の実測で縛る実装だけが届かない。
  const ctrlNoiseDb = noiseBandPeakDb(input);
  check(ctrlNoiseDb > -12,
    `(H・対照) 素材には単語表に無い音(1200Hz)があり、その帯域のピークが高く出る＝この測り方は「有るとき有る」と言える（実=${ctrlNoiseDb}dB）`);
  const outNoiseDb = noiseBandPeakDb(on.digest);
  check(outNoiseDb < -35 && outNoiseDb < ctrlNoiseDb - 25,
    `(H) 文字起こしに載っていない音へ食い込まない＝伸ばす先が実測した無音の内側に限られている（実=${outNoiseDb}dB / 対照=${ctrlNoiseDb}dB）`);

  // ── (K) trim（無音・言い淀みを詰める）と併用しても、戻した間が削られない ──────────
  // trim は 0.2 秒以上の無音を機械的に全部詰めるので、素通しだと戻した間ごと消える。
  const trimmed = runCase([], llmResponse, { statePatch: { trim: "on" } });
  if (check(trimmed.r.status === 0 && fs.existsSync(trimmed.digest),
    "(K) trim=on でも digest が生成される", (trimmed.r.stderr || "").slice(-600))) {
    const tSil = measureSilences(trimmed.digest);
    const tDurs = tSil.map((s) => s.end - s.start);
    const tHead = tSil.find((s) => s.start < 0.05);
    near(tHead ? tHead.end - tHead.start : NaN, 0.333, 0.06,
      "(K) trim=on でも先頭の余白が残る");
    check(tDurs.some((d) => Math.abs(d - 0.7) <= 0.06),
      "(K) trim=on でも実カットのつなぎ目の一呼吸(0.7秒)が残る", JSON.stringify(tDurs.map((d) => d.toFixed(3))));
    check(tDurs.some((d) => Math.abs(d - 0.41) <= 0.06),
      "(K) trim=on でも統合された区間の間(0.41秒)が残る", JSON.stringify(tDurs.map((d) => d.toFixed(3))));
  }

  // ── (E) 無音が1つも無い素材でも、製品が通る経路で落ちずに出る ──────────────────
  // pipeline.mjs は無音0件のとき planBreathParts を呼ばない分岐へ入る。純粋関数へ空配列を
  // 渡すのではなく、その分岐を実際に通してレンダリングが成功することを確かめる。
  const contInput = path.join(WORK, "breath-continuous.mp4");
  const gen2 = spawnSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=8",
    "-f", "lavfi", "-i", "aevalsrc=exprs='0.3*sin(2*PI*3000*t)':s=44100:d=8",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-shortest", contInput], { encoding: "utf-8" });
  if (check(gen2.status === 0 && fs.existsSync(contInput),
    "(E) 無音を1つも含まない素材(8秒・鳴りっぱなし)を生成した", (gen2.stderr || "").slice(-300))) {
    const contSil = await detectSilences(contInput, { duration: 8 });
    check(contSil.length === 0,
      `(E・前提) この素材には無音が1件も検出されない（実=${contSil.length}）`);
    const contTranscript = {
      language: "en", duration: 8,
      words: [{ w: "PPPP", start: 0.5, end: 3.0 }, { w: "QQQQ", start: 4.0, end: 7.0 }],
      segments: [{ start: 0.5, end: 7.0, text: "PPPP QQQQ" }],
    };
    const cont = runCase([], { segments: [{ keepText: "PPPP", hook: "P" }, { keepText: "QQQQ", hook: "Q" }] },
      { input: contInput, transcript: contTranscript });
    check(cont.r.status === 0 && fs.existsSync(cont.digest),
      "(E) 無音が無い素材でも、この機能のせいで止まらず digest が出来る", (cont.r.stderr || "").slice(-600));
    check(/無音区間が見つからないため従来どおり/.test(cont.r.stderr || ""),
      "(E) 無音0件のときは「従来どおり」と明示され、黙って別の動きをしない");
  }
} finally {
  for (const d of cleanup) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 後始末の失敗は検査結果に影響させない */ }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
