#!/usr/bin/env node
// video-shorts [2] オーケストレーター — 各段を順に呼び state.json で進捗管理する。
// engine/ と同じファイルベース受け渡し流儀（キーレス・サイレントフェイル禁止）。
//
// サブコマンド:
//   node pipeline.mjs init       <input.mp4>        新規ジョブ作成(work/<id>/)
//   node pipeline.mjs captionfix <workDir>          transcript の変換ミスをAIが直す
//   node pipeline.mjs select     <workDir> [--api]  transcript→LLMリクエスト生成 or API選定
//   node pipeline.mjs render     <workDir>          llm-response→逆マッチ→FFmpegレンダリング
//   node pipeline.mjs status     <workDir>          進捗表示

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  chunkSegments,
  buildRequestDoc,
  parseResponse,
  callAnthropic,
} from "./src/select-segments.mjs";
import { resolveSegments } from "./src/reverse-match.mjs";
import { mergeShortSegments, snapToSilence, resolveMinSec } from "./src/snap-boundaries.mjs";
import { DEFAULT_EXPORT, getExportPreset, listExportPresets } from "./src/export-presets.mjs";
import { wordsInRange, buildAss } from "./src/srt-builder.mjs";
import { planTrim, remapWords, snapStart } from "./src/trim-plan.mjs";
import { getStyle, listStyles, DEFAULT_SUBTITLE_STYLE } from "./src/subtitle-styles.mjs";
import { renderClip, probeSize, probeSampleRate, clipName, computeCanvas } from "./src/render-vertical.mjs";
import { concatClips } from "./src/concat.mjs";
import { DEFAULT_MODE, getMode, isValidMode } from "./src/select-modes.mjs";
import { runDigestEditor } from "./src/digest-editor.mjs";
import { stageStart, stageEnd, stageSetSec, readTiming, summaryLine } from "./src/timing.mjs";
import { makeUniqueJobId } from "./src/job-id.mjs";
import { aiCaptionFixStage, createDefaultRunModel } from "./src/ai-caption-fix.mjs";
import { writeJsonAtomically } from "./src/atomic-json.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");

function die(msg, code = 1) {
  process.stderr.write(`[ERROR] ${msg}\n`);
  process.exit(code);
}
function log(msg) {
  process.stderr.write(`${msg}\n`);
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}
// P2-1: state.json 等の書込みは直接 truncate すると、書いている途中で落ちたときに
// 壊れて読めなくなる（src/atomic-json.mjs 参照）。writeJson はここ経由で state.json /
// llm-response.json / candidates.json など全て書くので、ここを atomic にすれば一括で直る。
function writeJson(p, obj) {
  writeJsonAtomically(p, obj);
}
function loadState(workDir) {
  const sp = path.join(workDir, "state.json");
  if (!fs.existsSync(sp)) die(`state.json がありません: ${sp}`);
  return readJson(sp);
}
function saveState(workDir, state) {
  writeJson(path.join(workDir, "state.json"), state);
}

/** 縦/横のヒアリング回答を正規化。縦=portrait / 横=landscape。不正は null。 */
function normalizeOrient(v) {
  if (["縦", "portrait", "vertical", "tate"].includes(v)) return "portrait";
  if (["横", "landscape", "horizontal", "yoko"].includes(v)) return "landscape";
  return null;
}

function cmdInit(input, mode, sub, orientArg) {
  if (!input || !fs.existsSync(input)) die(`入力mp4が見つかりません: ${input}`);
  // 素材導入時のヒアリングを機械強制（AI 自己規律に頼らない・前回引き継ぎ禁止）。
  if (!isValidMode(mode)) {
    die("--mode を指定してください（topic=話題毎 / digest=ダイジェスト）。\n" +
        "  素材導入時のヒアリング必須項目です（毎回確認・前回の引き継ぎ禁止）。");
  }
  if (sub !== "on" && sub !== "off") {
    die("--sub を指定してください（on=字幕あり / off=字幕なし）。\n" +
        "  字幕有無も毎回ヒアリング必須です（前回の引き継ぎ禁止）。");
  }
  const orient = normalizeOrient(orientArg);
  if (!orient) {
    die("--orient を指定してください（縦=portrait / 横=landscape）。\n" +
        "  縦横も毎回ヒアリング必須です（前回の引き継ぎ禁止）。\n" +
        "  横=画面録画など細かい文字を残す用途 / 縦=SNSリール等の縦枠用途。");
  }
  // P1-8: ファイル名だけで id を決めると、別々の「lecture.mp4」を処理したときに work/output を
  // 共有してしまい、前のジョブの state.json やクリップを上書きする。サーバー経路(P1-3)と同じく
  // ファイル名由来のprefix＋乱数suffixで、ジョブごとに必ず別ディレクトリになるようにする。
  const id = makeUniqueJobId(input);
  const workDir = path.join(WORK_ROOT, id);
  fs.mkdirSync(workDir, { recursive: true });
  stageStart(workDir, "init");
  saveState(workDir, {
    id,
    input: path.resolve(input),
    transcript: null,
    stage: "init",
    mode,
    sub: sub === "on" ? "on" : "none",
    orient,
    createdHint: "transcribe.py で transcript.json を作り select へ",
  });
  stageEnd(workDir, "init");
  log(`[OK] job 作成: ${workDir}（mode=${getMode(mode).label} / 字幕=${sub} / 向き=${orient}）`);
  log(`  次: python src/transcribe.py "${input}" "${path.join(workDir, "transcript.json")}"`);
  console.log(workDir);
}

/**
 * 文字起こしの変換ミスを AI に直させる（select の前に置く工程）。
 * 直す前の transcript.json は transcript.raw.json に残るので、後から見比べられる。
 */
async function cmdCaptionFix(workDir) {
  if (!workDir) die("workDir を指定してください: node pipeline.mjs captionfix <workDir>");
  const state = loadState(workDir);
  const tPath = path.join(workDir, "transcript.json");
  if (!fs.existsSync(tPath)) die(`transcript.json がありません。先に transcribe.py を実行: ${tPath}`);

  stageStart(workDir, "captionfix");
  const r = await aiCaptionFixStage({
    workDir,
    runModel: createDefaultRunModel(workDir),
    onLog: (m) => log(m),
  });
  state.stage = "captionfixed";
  saveState(workDir, state);
  stageEnd(workDir, "captionfix");
  log(`[OK] AIが字幕の間違いを直しました: ${r.total} 語のうち ${r.fixed} 語（${r.chunks} かたまり）`);
  log(`  直す前: ${path.join(workDir, "transcript.raw.json")} / 直した一覧: ${path.join(workDir, "ai-caption-fixes.json")}`);
  log(`  次: node pipeline.mjs select ${workDir}`);
}

async function cmdSelect(workDir, useApi, modeOverride, targetMinutes) {
  const state = loadState(workDir);
  const mode = isValidMode(modeOverride) ? modeOverride : (state.mode || DEFAULT_MODE);
  const tPath = path.join(workDir, "transcript.json");
  if (!fs.existsSync(tPath)) die(`transcript.json がありません。先に transcribe.py を実行: ${tPath}`);

  stageStart(workDir, "select");

  // ダイジェストは編集エージェント（理解→台本再構成→検証修正ループ）が
  // llm-response.json を直接書く。キーレスの手書き経路（llm-request.md）は使わない。
  if (mode === "digest") {
    log("[INFO] ダイジェスト編集エージェント起動（理解→台本→検証修正ループ）");
    const { meta } = await runDigestEditor(workDir, (m) => log(m), { targetMinutes });
    state.stage = "selected";
    state.mode = mode;
    state.digestMeta = meta;
    saveState(workDir, state);
    stageEnd(workDir, "select");
    log(`[OK] ダイジェスト台本完成: ${meta.count}区間 / score=${meta.score} / ${meta.iterations}反復`);
    return;
  }

  const transcript = readJson(tPath);
  const chunks = chunkSegments(transcript);
  if (chunks.length === 0) die("transcript に segments がありません");
  const doc = buildRequestDoc(chunks, mode);
  const reqPath = path.join(workDir, "llm-request.md");
  fs.writeFileSync(reqPath, doc, "utf-8");
  state.stage = "selecting";
  state.chunks = chunks.length;
  state.mode = mode;
  saveState(workDir, state);
  log(`[OK] LLMリクエスト生成: ${reqPath}（mode=${getMode(mode).label} / chunk=${chunks.length}）`);

  if (useApi) {
    log("[INFO] --api: Anthropic API で自動選定...");
    const raw = await callAnthropic(doc);
    const segs = parseResponse(raw);
    writeJson(path.join(workDir, "llm-response.json"), { segments: segs });
    stageEnd(workDir, "select");
    log(`[OK] API選定完了: ${segs.length} 候補 → llm-response.json`);
  } else {
    stageEnd(workDir, "select");
    log("[NEXT] オーケストレーター(Claude Code)は llm-request.md を読み、");
    log(`       ${path.join(workDir, "llm-response.json")} に {"segments":[{keepText,hook}]} を書く。`);
    log("       その後: node pipeline.mjs render " + workDir);
  }
}

/**
 * 1区間を切り出して縦動画へ焼く（出荷経路の本体）。
 *
 * 【なぜ関数として出すか】ここは「切り出しの開始をコマの境目へ揃える → 詰める区間を決める →
 * 字幕をその時間軸へ写す → 焼く」が1本につながっている所で、途中の1つでも抜けると
 * 口の動きと声がずれる。検査（tests/trim-sync-check.py）が同じ手順を自前で書き写すと、
 * 出荷経路の側から手順を消しても検査が自分の写しで揃えてしまい、緑のまま壊れる。
 * 実測: `const segStart = seg.start;` にしても検査は 19 PASS のままだった（2026-08-08）。
 * 検査はこの関数を呼ぶので、ここから何を消しても検査が落ちる。
 *
 * 【なぜ開始を揃えるか】renderClip は -ss で入力シークする。入力シークの後、映像は
 * 「シーク位置以降に在る最初のコマ」から始まり、音声はシーク位置ちょうどから始まるので、
 * 切り出した時点で映像と音声の原点が最大1コマぶん食い違う（クリップ全体に一定量の口パクずれ
 * として残る）。開始をコマの境目へ揃えると、シーク位置が最初のコマの頭と一致して原点がそろう。
 * 実測（コマ番号で切るようにした後・tests/trim-sync-check.py の製品経路・seg.start=1.02 秒）:
 * 揃えると 出力92コマ中 食い違い 0、この行を `const segStart = seg.start;` にすると
 * 出力86コマ中 **86コマすべて**で絵が音より1コマ（66.7ms）先行した。
 * ＝この揃えは、区間の切り方（コマ番号で切る）とは別に独立して要る。
 *
 * @param {object} p
 * @param {string} p.input 素材のパス
 * @param {{start:number,end:number,duration:number,hook?:string}} p.seg 切り出す区間
 * @param {{w:string,start:number,end:number}[]} p.words 素材全体の語（時刻つき）
 * @param {number|null} p.srcFps 素材のコマ数/秒（取れなければ null＝揃えない）
 * @param {number|null} [p.srcSampleRate] 素材の音声の標本化周波数（詰めるときに標本の番号で切るのに使う）。
 * @param {string|null} [p.srcFpsRational] 素材のコマ数/秒を分数のまま書いたもの（"30000/1001" 等）。
 *   詰めるときに、コマ数/秒が一定でない素材（画面録画で出る）で絵だけが先に進むのを防ぐのに要る。
 *   取れなければ null＝従来どおり（コマ数/秒が一定の素材では結果は変わらない）。
 * @param {boolean} p.trim 無音・言い淀みを詰めるか
 * @param {{path:string,style:string,width:number,height:number}|null} p.subtitle 字幕（不要なら null）
 * @param {string} p.output 出力先
 * @returns {Promise<{segStart:number, keep:{start:number,end:number}[]|null,
 *                    assWords:object[], clipDuration:number, cutSeconds:number}>}
 */
export async function renderSegment({
  input, seg, words, srcFps, srcFpsRational = null, srcSampleRate = null,
  srcW, srcH, orientation, trim, subtitle, output, label = "", onLog = log,
  exportPreset = DEFAULT_EXPORT, exportOverrides = {},
}) {
  const segStart = snapStart(seg.start, srcFps);
  const relWordsAll = wordsInRange(words || [], segStart, seg.end);
  let keep = null;
  let assWords = relWordsAll;
  let clipDuration = seg.duration;
  let cutSeconds = 0;
  if (trim) {
    // 無音・言い淀みを詰める。字幕は詰めたあとの時間軸で書かないと、詰めたぶんだけ遅れて出る。
    const plan = planTrim(relWordsAll, { duration: seg.duration, fps: srcFps });
    keep = plan.keep;
    assWords = remapWords(relWordsAll, plan.keep);
    clipDuration = plan.keptSeconds;
    cutSeconds = plan.cutSeconds;
    onLog(`  [TRIM] ${label} ${seg.duration.toFixed(1)}s → ${plan.keptSeconds.toFixed(1)}s（${plan.cutSeconds.toFixed(1)}s 詰めた）`);
  }
  let assPath = null;
  if (subtitle) {
    const ass = buildAss(assWords, seg.hook, clipDuration,
      { style: subtitle.style, width: subtitle.width, height: subtitle.height });
    assPath = subtitle.path;
    fs.writeFileSync(assPath, ass, "utf-8");
  }
  await renderClip({ input, start: segStart, end: seg.end, assPath, output, orientation,
    srcW, srcH, keep, fpsRational: srcFpsRational, sampleRate: srcSampleRate,
    exportPreset, exportOverrides });
  return { segStart, keep, assWords, clipDuration, cutSeconds };
}

async function cmdRender(workDir, opts = {}) {
  const {
    flagNoSub = false, subStyle = DEFAULT_SUBTITLE_STYLE, modeOverride, minSec,
    exportPreset = DEFAULT_EXPORT, exportOverrides = {},
  } = opts;
  if (!getExportPreset(exportPreset)) {
    const avail = listExportPresets().map((e) => `${e.key}（${e.label}）`).join(" / ");
    die(`未知の書き出しプリセット: ${exportPreset}\n  利用可能: ${avail}`);
  }
  const state = loadState(workDir);
  // 字幕有無は init のヒアリング結果（state.sub）が既定。--no-sub フラグは明示上書き。
  const noSub = flagNoSub || state.sub === "none";
  const mode = isValidMode(modeOverride) ? modeOverride : (state.mode || DEFAULT_MODE);
  if (!noSub && !getStyle(subStyle)) {
    const avail = listStyles().map((s) => `${s.key}（${s.label}）`).join(" / ");
    die(`未知の字幕スタイル: ${subStyle}\n  利用可能: ${avail}`);
  }
  stageStart(workDir, "render");
  const transcript = readJson(path.join(workDir, "transcript.json"));
  const respPath = path.join(workDir, "llm-response.json");
  if (!fs.existsSync(respPath)) die(`llm-response.json がありません: ${respPath}`);
  const llmSegs = parseResponse(readJson(respPath));
  if (llmSegs.length === 0) die("LLM候補が0件です");

  // 区間選定(orchestrate)所要時間: llm-request.md(依頼) → llm-response.json(応答) の mtime差分で算出。
  // オーケストレーター(Claude Code)が手動で書く工程のため start/end 計測ができず、mtime から逆算する。
  try {
    const reqPath = path.join(workDir, "llm-request.md");
    if (fs.existsSync(reqPath) && fs.existsSync(respPath)) {
      const reqMs = fs.statSync(reqPath).mtimeMs;
      const respMs = fs.statSync(respPath).mtimeMs;
      const sec = (respMs - reqMs) / 1000;
      if (Number.isFinite(sec) && sec >= 0) stageSetSec(workDir, "orchestrate", sec);
    }
  } catch (e) {
    log(`[WARN] 区間選定時間の算出に失敗（計測スキップ）: ${e.message}`);
  }

  // 逆マッチングで秒数確定（落とし穴#1）。ダイジェストは台本順を保持（時系列に戻さない）。
  let resolved = resolveSegments(llmSegs, transcript, { preserveOrder: mode === "digest" });
  log(`[INFO] 逆マッチング: ${llmSegs.length} 候補 → ${resolved.length} 区間確定${mode === "digest" ? "（台本順）" : ""}`);
  if (resolved.length === 0) die("逆マッチングで確定した区間が0件（transcriptとkeepTextが不一致）");

  // 細切れ解消（digest は台本順・意図的分割なので結合しない）＋斬り方改善（無音スナップ）。
  // digest は編集エージェントが確定した精密な keepText 区間のため、結合・無音スナップ・余韻パディングの
  // いずれも適用しない（適用すると隣接区間が重なり concat 時に同一発話が二重再生されうる＝R-7b/c）。
  if (mode !== "digest") {
    // 1区間の最小尺。--min-sec（CLI）> TOPIC_MIN_SEC（env）> 既定180秒 の順で効く。
    // 解決順は resolveMinSec が正（R-7d: 不正値は次の優先度へ落とし、最後は既定へ）。
    const MIN_SEC = resolveMinSec(minSec, process.env.TOPIC_MIN_SEC);
    const MAX_GAP_RAW = Number(process.env.TOPIC_MERGE_GAP_MAX ?? 3);
    const MAX_GAP = Number.isFinite(MAX_GAP_RAW) && MAX_GAP_RAW > 0 ? MAX_GAP_RAW : 3; // R-8: 不正値は既定(3秒)にフォールバック
    resolved = mergeShortSegments(resolved, MIN_SEC, MAX_GAP);
    resolved = snapToSilence(resolved, transcript.words || [], {});
    log(`[INFO] 区間リファイン後: ${resolved.length} 区間（結合＋無音スナップ）`);

    // 余韻パディング: 語境界ピッタリだと発話が即始まり/即切れて「ぶち切れ」感が出る。
    // 開始を少し前へ・終了を少し後ろへ伸ばし前後に間を作る（素材端でクランプ）。env で調整可。
    const PAD_HEAD_RAW = Number(process.env.CLIP_PAD_HEAD ?? 0.5);
    const PAD_TAIL_RAW = Number(process.env.CLIP_PAD_TAIL ?? 0.8);
    const PAD_HEAD = Number.isFinite(PAD_HEAD_RAW) ? Math.max(0, PAD_HEAD_RAW) : 0.5; // 不正値は既定にフォールバック（NaN伝播防止）
    const PAD_TAIL = Number.isFinite(PAD_TAIL_RAW) ? Math.max(0, PAD_TAIL_RAW) : 0.8;
    const srcDur = transcript.duration || Infinity;
    if (PAD_HEAD > 0 || PAD_TAIL > 0) {
      for (const s of resolved) {
        s.start = Math.max(0, s.start - PAD_HEAD);
        s.end = Math.min(srcDur, s.end + PAD_TAIL);
        s.duration = Math.round((s.end - s.start) * 1000) / 1000;
      }
      log(`[INFO] 余韻パディング適用: 前 ${PAD_HEAD}s / 後 ${PAD_TAIL}s`);
    }
  }

  const outDir = path.join(OUT_ROOT, state.id);
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = [];

  // 素材の実解像度を1回だけprobeし、拡大ガード込みの実canvasを算出（ステップ5）。
  // 字幕ONの場合、buildAssのPlayResにも同じ実canvasを渡しスケールずれを防ぐ。
  const orientation = state.orient || "portrait";
  let srcSize = null;
  try {
    srcSize = await probeSize(state.input);
  } catch (e) {
    log(`[WARN] 素材解像度のprobeに失敗（拡大ガード無効で続行）: ${e.message}`);
  }
  // coded width/height ではなく SAR 補正後の表示寸法を使う（AUD-P2-21）。SAR=1:1（大半の
  // 素材）では displayWidth===width のため無変化。非正方形ピクセルの素材だけ、実際の
  // 表示アスペクト比で拡大ガード・fit の目標寸法を選べるようになる。
  const srcW = srcSize ? srcSize.displayWidth : undefined;
  const srcH = srcSize ? srcSize.displayHeight : undefined;
  // 詰めるときに区間の端をコマの境目へ揃えるのに要る。取れなければ揃えない（従来どおりの動き）。
  const srcFps = srcSize ? srcSize.fps : null;
  // 分数のままの姿。コマ数/秒が一定でない素材（画面録画）で、切る前に等間隔のコマ列へ
  // 揃えるのに要る。小数へ丸めると 30000/1001 との差が音とのずれになるので分数で持ち回る。
  const srcFpsRational = srcSize ? (srcSize.fpsRational ?? null) : null;
  // 音声の標本化周波数。詰めるときに atrim を標本の番号で切るのに使う（秒で切ると丸めが入る）。
  // 取れなくても式の中で aresample が揃えるので、切る位置の秒は変わらない。
  let srcSampleRate = null;
  try {
    srcSampleRate = await probeSampleRate(state.input);
  } catch (e) {
    log(`[WARN] 素材の音声の標本化周波数のprobeに失敗（詰める際に入れ直しになります）: ${e.message}`);
  }
  if (state.trim === "on" && !srcFps) {
    log("[WARN] 素材のコマ数/秒を取得できませんでした。詰めた継ぎ目で絵と音が最大1コマずれることがあります");
  }
  const canvas = computeCanvas(orientation, srcW, srcH);

  for (let i = 0; i < resolved.length; i++) {
    const seg = resolved[i];
    const outFile = clipName(outDir, i, seg.hook);
    log(`[RENDER] #${i + 1} ${seg.start.toFixed(1)}-${seg.end.toFixed(1)}s "${seg.hook}"`);
    try {
      // AUD-P1-02a/02b: この戻り値（実際に使われた開始秒・詰め後の keep 区間・詰め後の尺）を
      // 捨てずに manifest へ持ち回る。捨てると、字幕焼き直し(recaption-stage.mjs)は
      // raw な start/end から作り直すしかなくなり、詰めた尺（例: 4秒→1秒）が戻ってしまう
      // （実際に起きていたバグそのもの）。
      const renderResult = await renderSegment({
        input: state.input,
        seg,
        words: transcript.words || [],
        srcFps, srcFpsRational, srcSampleRate, srcW, srcH, orientation,
        trim: state.trim === "on",
        subtitle: noSub ? null : {
          path: path.join(workDir, `clip-${i + 1}.ass`),
          style: subStyle, width: canvas.w, height: canvas.h,
        },
        exportPreset, exportOverrides,
        output: outFile,
        label: `#${i + 1}`,
      });
      const size = await probeSize(outFile);
      manifest.push({
        index: i + 1,
        file: path.basename(outFile),
        path: outFile,
        start: seg.start,
        end: seg.end,
        duration: seg.duration,
        hook: seg.hook,
        confidence: seg.confidence,
        keepText: seg.keepText,
        width: size.width,
        height: size.height,
        vertical: size.vertical,
        status: "pending", // UI で採用/破棄
        // AUD-P1-02a/02b: 実際に使ったレンダ計画。字幕焼き直しはここを読み、同じ関数へ
        // 同じ値を渡して再現する（raw start/end から作り直さない）。
        renderPlan: {
          segStart: renderResult.segStart,
          keep: renderResult.keep,
          clipDuration: renderResult.clipDuration,
          canvasW: canvas.w,
          canvasH: canvas.h,
        },
      });
      log(`  [OK] ${path.basename(outFile)} ${size.width}x${size.height} vertical=${size.vertical}`);
    } catch (e) {
      log(`  [FAIL] #${i + 1}: ${e.message}`);
    }
  }

  const failCount = resolved.length - manifest.length;
  // P1-5: 区間選定(select)段で一部chunkが失敗していた場合、candidates.jsonにも引き継ぐ。
  // 「本数は生成できたが元の文字起こし全体はカバーできていない」ことを利用者が確認できるようにする。
  const selectIncomplete = !!state.selectIncomplete;
  if (resolved.length > 0 && manifest.length === 0) {
    writeJson(path.join(outDir, "candidates.json"),
      // AUD-S-03: failCountはここまで計算済みなのに、これまでcandidates.jsonへ一度も
      // 書かれていなかった（ログにしか出ない）。一部候補の書き出し失敗を画面側が
      // 検出・表示するための唯一の材料なので、他の2箇所のwriteJsonとあわせて含める。
      { id: state.id, mode, generated: 0, digest: null, candidates: [], incomplete: selectIncomplete,
        srcW, srcH, srcFps: srcFps ?? null, srcFpsRational: srcFpsRational ?? null,
        srcSampleRate: srcSampleRate ?? null, orientation, renderFailed: failCount });
    state.stage = "render_failed";
    state.candidates = 0;
    saveState(workDir, state);
    die(`レンダ失敗: ${resolved.length}区間すべてで生成に失敗しました（0本）。上の [FAIL] ログを確認してください。`);
  }
  if (failCount > 0) {
    log(`[WARN] 部分失敗: ${failCount}/${resolved.length} 区間のレンダに失敗（${manifest.length}本は生成成功）`);
  }

  // ダイジェストは全 part を時系列連結して1本にする（面白い所だけを繋ぐ）。
  let digest = null;
  if (mode === "digest" && manifest.length > 0) {
    const digestPath = path.join(outDir, `digest-${state.id}.mp4`);
    try {
      concatClips(manifest.map((m) => m.path), digestPath);
      const size = await probeSize(digestPath);
      digest = { file: path.basename(digestPath), path: digestPath, parts: manifest.length,
                 width: size.width, height: size.height };
      log(`[OK] ダイジェスト連結: ${manifest.length} 本 → ${path.basename(digestPath)} ${size.width}x${size.height}`);
    } catch (e) {
      log(`  [FAIL] ダイジェスト連結: ${e.message}`);
    }
  }

  if (mode === "digest" && manifest.length > 0 && digest === null) {
    writeJson(path.join(outDir, "candidates.json"),
      // AUD-S-03: 部分失敗件数(renderFailed)を持ち回る（詳細は下の主経路のwriteJson参照）。
      { id: state.id, mode, generated: manifest.length, digest: null, candidates: manifest, incomplete: selectIncomplete,
        srcW, srcH, srcFps: srcFps ?? null, srcFpsRational: srcFpsRational ?? null,
        srcSampleRate: srcSampleRate ?? null, orientation, renderFailed: failCount });
    state.stage = "render_failed";
    state.candidates = manifest.length;
    saveState(workDir, state);
    die("レンダ失敗: digestモードの最終連結（ダイジェスト動画）が生成できませんでした。上の [FAIL] ログを確認してください。");
  }

  writeJson(path.join(outDir, "candidates.json"),
    // AUD-P1-02b: srcW/srcH（+ fps/標本化周波数）をここで持ち回る。recaption-stage.mjs は
    // 従来 state.srcW/state.srcH（本番のstate.jsonには存在しないフィールド）を参照しており、
    // 常にundefined → 拡大ガード無しの既定解像度で焼き直され、初回レンダと解像度がずれていた。
    // AUD-S-03: renderFailed(部分失敗件数)も併せて持ち回る。一部区間だけレンダに失敗しても
    // (failCount>0でもmanifest.length>0なら)この主経路を通るため、失敗件数が
    // webapp-mockup側へ渡る唯一の経路はここになる。
    { id: state.id, mode, generated: manifest.length, digest, candidates: manifest, incomplete: selectIncomplete,
      srcW, srcH, srcFps: srcFps ?? null, srcFpsRational: srcFpsRational ?? null,
      srcSampleRate: srcSampleRate ?? null, orientation, renderFailed: failCount });
  state.stage = "rendered";
  state.candidates = manifest.length;
  saveState(workDir, state);

  // 素材活用度（話題毎/ショートの取りこぼし可視化）。逆マッチ確定区間の合計尺 / 素材尺。
  const covered = resolved.reduce((a, s) => a + (s.end - s.start), 0);
  const total = transcript.duration || 0;
  const rate = total > 0 ? covered / total : 0;
  log(`[COVER] mode=${mode} 選定合計 ${covered.toFixed(1)}s / 素材 ${total.toFixed(1)}s = カバー率 ${rate.toFixed(3)}`);
  stageEnd(workDir, "render");
  log(summaryLine(readTiming(workDir)));
  log(`[DONE] ${manifest.length} 本生成 → ${outDir}\\candidates.json`);
  log(`[NEXT] output/${path.basename(workDir)}/candidates.json と short-*.mp4 を確認し、採用/破棄を選別`);
}

function cmdStatus(workDir) {
  const state = loadState(workDir);
  log(JSON.stringify(state, null, 2));
}

/** rest 配列から `--flag value` の value を取り出す（無ければ fallback） */
function flagValue(rest, flag, fallback) {
  const i = rest.indexOf(flag);
  return i !== -1 && rest[i + 1] ? rest[i + 1] : fallback;
}

async function main() {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  const useApi = rest.includes("--api");
  const modeArg = flagValue(rest, "--mode", undefined);
  const targetMinArg = flagValue(rest, "--target-min", undefined);
  const targetMinutes = targetMinArg !== undefined ? Number(targetMinArg) : undefined;
  switch (cmd) {
    case "init":
      return cmdInit(arg, modeArg, flagValue(rest, "--sub", undefined),
        flagValue(rest, "--orient", undefined));
    case "captionfix": return cmdCaptionFix(arg);
    case "select": return cmdSelect(arg, useApi, modeArg, targetMinutes);
    case "render":
      return cmdRender(arg, {
        flagNoSub: rest.includes("--no-sub"),
        subStyle: flagValue(rest, "--sub-style", DEFAULT_SUBTITLE_STYLE),
        modeOverride: modeArg,
        minSec: flagValue(rest, "--min-sec", undefined),
        exportPreset: flagValue(rest, "--export", DEFAULT_EXPORT),
        // 個別指定はプリセットの上から1項目ずつ上書きする（全部書かなくてよい）。
        exportOverrides: {
          vcodec: flagValue(rest, "--vcodec", undefined),
          preset: flagValue(rest, "--enc-preset", undefined),
          crf: flagValue(rest, "--crf", undefined),
          acodec: flagValue(rest, "--acodec", undefined),
          abitrate: flagValue(rest, "--abitrate", undefined),
        },
      });
    case "status": return cmdStatus(arg);
    case "styles":
      listStyles().forEach((s) => log(`  ${s.key}\t${s.label} — ${s.description}`));
      return;
    case "exports":
      listExportPresets().forEach((e) => log(`  ${e.key}\t${e.label} — ${e.description}`));
      return;
    default:
      log("usage: node pipeline.mjs <init|captionfix|select|render|status|styles> ...");
      log("  init       <input.mp4> --mode <topic|digest> --sub <on|off> --orient <縦|横>");
      log("  captionfix <workDir>（文字起こしの変換ミスをAIが直す。select の前）");
      log("  select     <workDir> [--mode <topic|digest>] [--target-min <分数>]（digestのみ有効）");
      log("  render     <workDir> [--no-sub] [--sub-style karaoke|pop|bold] [--mode ...]");
      log("             [--min-sec <秒>]（1区間の最小尺。既定180秒。短く分けるなら小さくする）");
      log("             [--export <用途>]（書き出し設定。youtube|sns|x|archive|light|standard）");
      log("             [--crf <0-51>] [--vcodec <名>] [--enc-preset <名>] [--acodec <名>] [--abitrate <例:128k>]");
      log("               （個別指定。--export の上から1項目ずつ上書きできる）");
      log("  exports    書き出しプリセットの一覧を表示する");
      process.exit(1);
  }
}

// コマンドとして起動されたときだけ走らせる。
// import されたときにも走ると、renderSegment を呼びたいだけの検査が
// usage を出して exit(1) してしまう（＝出荷経路を検査から呼べなくなる）。
const invokedAs = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedAs === import.meta.url) {
  main().catch((e) => die(e.stack || e.message));
}
