#!/usr/bin/env node
// video-shorts [2] オーケストレーター — 各段を順に呼び state.json で進捗管理する。
// engine/ と同じファイルベース受け渡し流儀（キーレス・サイレントフェイル禁止）。
//
// サブコマンド:
//   node pipeline.mjs init   <input.mp4>        新規ジョブ作成(work/<id>/)
//   node pipeline.mjs select <workDir> [--api]  transcript→LLMリクエスト生成 or API選定
//   node pipeline.mjs render <workDir>          llm-response→逆マッチ→FFmpegレンダリング
//   node pipeline.mjs status <workDir>          進捗表示

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chunkSegments,
  buildRequestDoc,
  parseResponse,
  callAnthropic,
} from "./src/select-segments.mjs";
import { resolveSegments } from "./src/reverse-match.mjs";
import { mergeShortSegments, snapToSilence } from "./src/snap-boundaries.mjs";
import { wordsInRange, buildAss } from "./src/srt-builder.mjs";
import { getStyle, listStyles, DEFAULT_SUBTITLE_STYLE } from "./src/subtitle-styles.mjs";
import { renderClip, probeSize, clipName, computeCanvas } from "./src/render-vertical.mjs";
import { concatClips } from "./src/concat.mjs";
import { DEFAULT_MODE, getMode, isValidMode } from "./src/select-modes.mjs";
import { runDigestEditor } from "./src/digest-editor.mjs";
import { stageStart, stageEnd, stageSetSec, readTiming, summaryLine } from "./src/timing.mjs";
import { makeUniqueJobId } from "./src/job-id.mjs";

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
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
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

async function cmdRender(workDir, opts = {}) {
  const { flagNoSub = false, subStyle = DEFAULT_SUBTITLE_STYLE, modeOverride } = opts;
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
    const MIN_SEC_RAW = Number(process.env.TOPIC_MIN_SEC ?? 180);
    const MIN_SEC = Number.isFinite(MIN_SEC_RAW) && MIN_SEC_RAW > 0 ? MIN_SEC_RAW : 180; // R-7d: 不正値は既定にフォールバック
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
  const srcW = srcSize ? srcSize.width : undefined;
  const srcH = srcSize ? srcSize.height : undefined;
  const canvas = computeCanvas(orientation, srcW, srcH);

  for (let i = 0; i < resolved.length; i++) {
    const seg = resolved[i];
    // 字幕(ASS)生成（--no-sub 指定時はスキップ）
    let assPath = null;
    if (!noSub) {
      const relWords = wordsInRange(transcript.words || [], seg.start, seg.end);
      const ass = buildAss(relWords, seg.hook, seg.duration, { style: subStyle, width: canvas.w, height: canvas.h });
      assPath = path.join(workDir, `clip-${i + 1}.ass`);
      fs.writeFileSync(assPath, ass, "utf-8");
    }
    const outFile = clipName(outDir, i, seg.hook);
    log(`[RENDER] #${i + 1} ${seg.start.toFixed(1)}-${seg.end.toFixed(1)}s "${seg.hook}"`);
    try {
      await renderClip({ input: state.input, start: seg.start, end: seg.end, assPath, output: outFile, orientation, srcW, srcH });
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
      { id: state.id, mode, generated: 0, digest: null, candidates: [], incomplete: selectIncomplete });
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
      { id: state.id, mode, generated: manifest.length, digest: null, candidates: manifest, incomplete: selectIncomplete });
    state.stage = "render_failed";
    state.candidates = manifest.length;
    saveState(workDir, state);
    die("レンダ失敗: digestモードの最終連結（ダイジェスト動画）が生成できませんでした。上の [FAIL] ログを確認してください。");
  }

  writeJson(path.join(outDir, "candidates.json"),
    { id: state.id, mode, generated: manifest.length, digest, candidates: manifest, incomplete: selectIncomplete });
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
  log(`[NEXT] ui/index.html を開いて candidates.json を読み込み、採用/破棄を選別`);
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
    case "select": return cmdSelect(arg, useApi, modeArg, targetMinutes);
    case "render":
      return cmdRender(arg, {
        flagNoSub: rest.includes("--no-sub"),
        subStyle: flagValue(rest, "--sub-style", DEFAULT_SUBTITLE_STYLE),
        modeOverride: modeArg,
      });
    case "status": return cmdStatus(arg);
    case "styles":
      listStyles().forEach((s) => log(`  ${s.key}\t${s.label} — ${s.description}`));
      return;
    default:
      log("usage: node pipeline.mjs <init|select|render|status|styles> ...");
      log("  init   <input.mp4> --mode <topic|digest> --sub <on|off> --orient <縦|横>");
      log("  select <workDir> [--mode <topic|digest>] [--target-min <分数>]（digestのみ有効）");
      log("  render <workDir> [--no-sub] [--sub-style karaoke|pop|bold] [--mode ...]");
      process.exit(1);
  }
}

main().catch((e) => die(e.stack || e.message));
