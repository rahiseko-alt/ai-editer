// video-shorts 字幕の焼き直し — G-EDIT-CAPTION-B
//
// 画面で直した字幕で、既に焼いたクリップを作り直す。
// 字幕は焼き込み式なので、直した内容を反映するには焼き直すしかない。
//
// 【全部そろってから差し替える】焼き直しは1本ずつ作るが、成果物フォルダの置き換えは
// 全部そろってから行う。1本ずつ差し替えると、途中で失敗したときに
// 「1本目＝直した字幕／2本目＝古い字幕」が並び、どれが最新か人の記憶頼みになる。
// 失敗したときは作りかけを消し、元のクリップをそのまま残す。
//
// 【古い文字が重ならないこと】焼き直しは元の素材（入力動画）から焼き直す。
// 既に字幕が焼かれたクリップの上へ重ねると、古い文字が下に残って二重になる。
// 入力動画は state.json が持っている。
//
// CLI としても使える（テストから直接叩くため）:
//   node src/recaption-stage.mjs <workDir> <outDir>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyEdits, readEdits } from "./caption-store.mjs";
import { buildAss, wordsInRange } from "./srt-builder.mjs";
import { computeCanvas, renderClip } from "./render-vertical.mjs";
import { remapWords } from "./trim-plan.mjs";
import { resolveInside, safeBasename } from "./safe-path.mjs";

/** 焼き直しに必要なものが揃っているか調べ、揃っていれば材料を返す。 */
export function collectMaterials(workDir, outDir) {
  const statePath = path.join(workDir, "state.json");
  const transcriptPath = path.join(workDir, "transcript.json");
  const candPath = path.join(outDir, "candidates.json");
  for (const [p, what] of [[statePath, "state.json"], [transcriptPath, "transcript.json"], [candPath, "candidates.json"]]) {
    if (!fs.existsSync(p)) throw new Error(`焼き直しに必要な ${what} がありません: ${p}`);
  }
  const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));
  const candidates = JSON.parse(fs.readFileSync(candPath, "utf-8"));
  if (!state.input || !fs.existsSync(state.input)) {
    // 元の素材が無ければ焼き直せない。既に焼いたクリップへ重ねると古い文字が二重に残る。
    throw new Error(`元の素材が見つかりません（焼き直しには元の動画が要ります）: ${state.input}`);
  }
  return { state, transcript, candidates, candPath };
}

/**
 * 直した字幕で全クリップを焼き直す。
 *
 * @param {object} p
 * @param {string} p.workDir ジョブの作業フォルダ（state.json / transcript.json / caption-edits.json）
 * @param {string} p.outDir  成果物フォルダ（candidates.json とクリップ）
 * @param {(s:string)=>void} [p.onLog]
 * @returns {Promise<{rebuilt: number}>}
 */
export async function recaptionStage({ workDir, outDir, onLog }) {
  const { state, transcript, candidates } = collectMaterials(workDir, outDir);
  const edits = readEdits(workDir);
  const words = applyEdits(transcript.words || [], edits);
  const orientation = state.orient || "portrait";
  // AUD-P1-02b: state.srcW/state.srcH は本番の state.json には存在しないフィールドで、
  // 常に undefined になり拡大ガードが効かないまま既定解像度で焼き直されていた。
  // 初回レンダ時に candidates.json へ書いた実際の素材解像度を使う（無ければ従来どおり無指定）。
  const srcW = candidates.srcW;
  const srcH = candidates.srcH;
  const canvas = computeCanvas(orientation, srcW, srcH);
  const clips = candidates.candidates || [];

  // ── 第1段: 全部作る（まだ差し替えない） ──────────────────
  const made = [];
  let failing = null;
  try {
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      if (typeof c.start !== "number" || typeof c.end !== "number") {
        throw new Error(`クリップ ${c.file} に区間の時刻がありません（焼き直せません）`);
      }
      // AUD-P1-01a: candidates.json の `file` は path.join() へそのまま渡すと、
      // "../../evil.mp4" のような値でジョブの成果物フォルダ外を書き換えられてしまう。
      // 単純なbasename・許可拡張子のみを通す（parse直後の1回だけでなく、下のI/Oのたびに
      // resolveInside() で再検査する＝TOCTOU対策）。
      const safeName = safeBasename(c.file);

      // AUD-P1-02a: 初回レンダで確定した「実際に使った開始秒(segStart)」「詰め後に残した区間
      // (keep)」「詰め後の尺(clipDuration)」を manifest から読み、同じ値で再現する。
      // ここを c.start/c.end という raw な値から作り直すと、無音・言い淀みを詰めた分の尺
      // （例: 4秒→1秒）が焼き直しのたびに戻ってしまう（実際に起きていたバグそのもの）。
      const plan = c.renderPlan || {};
      const segStart = typeof plan.segStart === "number" ? plan.segStart : c.start;
      const keep = Array.isArray(plan.keep) && plan.keep.length ? plan.keep : null;
      const clipDuration = typeof plan.clipDuration === "number"
        ? plan.clipDuration
        : (c.duration ?? (c.end - c.start));
      const width = typeof plan.canvasW === "number" ? plan.canvasW : canvas.w;
      const height = typeof plan.canvasH === "number" ? plan.canvasH : canvas.h;

      const relWordsAll = wordsInRange(words, segStart, c.end);
      const assWords = keep ? remapWords(relWordsAll, keep) : relWordsAll;
      const assPath = path.join(workDir, `recaption-${i + 1}.ass`);
      fs.writeFileSync(
        assPath,
        // 初回レンダが実際に使った字幕の見た目を state から読む（pipeline.mjs が state.captionStyle
        // へ残す）。旧実装は state.subStyle という存在しないフィールドを読んでおり常に undefined＝
        // 画面で選んだ書体・スタイルが焼き直しで既定へ戻っていた（2026-08-16 / basis-reviewer 指摘）。
        buildAss(assWords, c.hook, clipDuration, {
          style: state.captionStyle ?? state.subStyle,
          width,
          height,
        }),
        "utf-8",
      );
      const tmpOut = resolveInside(outDir, `${safeName}.recaption-tmp.mp4`);
      failing = tmpOut;
      await renderClip({
        input: state.input, start: segStart, end: c.end, assPath, output: tmpOut,
        orientation, srcW, srcH, keep,
        fpsRational: candidates.srcFpsRational, sampleRate: candidates.srcSampleRate,
      });
      if (!fs.existsSync(tmpOut)) throw new Error(`焼き直しの出力が生成されませんでした: ${c.file}`);
      failing = null;
      made.push({ entry: c, tmpOut, safeName });
      if (onLog) onLog(`[OK] 字幕を焼き直しました: ${c.file}`);
    }
  } catch (e) {
    if (failing) { try { fs.rmSync(failing, { force: true }); } catch (_) {} }
    for (const m of made) { try { fs.rmSync(m.tmpOut, { force: true }); } catch (_) {} }
    throw e;
  }

  // ── 第2段: 全部そろったので差し替える ────────────────────
  const swapped = [];
  try {
    for (const m of made) {
      // TOCTOU対策: 差し替え先(dst)は「解決してからすぐ使う」よう、実際にrenameする直前で
      // 毎回 resolveInside() を呼び直す（第1段で計算した値を使い回さない）。
      const dst = resolveInside(outDir, m.safeName);
      fs.renameSync(m.tmpOut, dst);
      swapped.push(m);
    }
  } catch (e) {
    // ここで失敗すると「直した版と古い版」が混ざる。作りかけを消して、
    // 混ざっている事実を必ず伝える（黙って別の理由で失敗したように見せない）。
    const stuck = [];
    for (const m of made) {
      if (swapped.includes(m)) { stuck.push(m.entry.file); continue; }
      try { fs.rmSync(m.tmpOut, { force: true }); } catch (_) { stuck.push(m.entry.file); }
    }
    if (stuck.length) {
      throw new Error(
        `字幕の焼き直しの差し替えに失敗しました。直した版と古い版が混ざったまま残っています`
        + `（${stuck.join(", ")}）。元の失敗: ${e.message}`);
    }
    throw e;
  }

  return { rebuilt: made.length };
}

// ── CLI（テストから直接叩く） ────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [workDir, outDir] = process.argv.slice(2);
  if (!workDir || !outDir) {
    console.error("usage: node src/recaption-stage.mjs <workDir> <outDir>");
    process.exit(2);
  }
  recaptionStage({ workDir, outDir, onLog: (s) => process.stderr.write(`${s}\n`) })
    .then((r) => console.log(`recaption done: ${r.rebuilt} clip(s)`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
