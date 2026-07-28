// video-shorts 工程タイマー — work/<job>/timing.json に各工程の開始/終了/所要秒を
// read-modify-write で記録する。計測が失敗しても本処理（init/select/render等）は止めない
// （サイレントフェイル禁止だが、タイマーはあくまで補助計測なので落としてはいけない側ではない）。
//
// スキーマ: { stages: { <name>: { start: <ISO>, end: <ISO>, sec: <number> } } }

import fs from "node:fs";
import path from "node:path";

function timingPath(workDir) {
  return path.join(workDir, "timing.json");
}

/** timing.json を読む。無い/壊れている場合は空の {stages:{}} を返す（作り直し前提）。 */
export function readTiming(workDir) {
  const p = timingPath(workDir);
  try {
    if (!fs.existsSync(p)) return { stages: {} };
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (!data || typeof data !== "object" || typeof data.stages !== "object" || data.stages === null) {
      return { stages: {} };
    }
    return data;
  } catch {
    return { stages: {} };
  }
}

function writeTiming(workDir, timing) {
  const p = timingPath(workDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(timing, null, 2), "utf-8");
}

/** 工程開始時刻を記録する。失敗しても例外を投げず本処理を止めない。 */
export function stageStart(workDir, name) {
  try {
    const timing = readTiming(workDir);
    const prev = timing.stages[name] || {};
    timing.stages[name] = { ...prev, start: new Date().toISOString(), end: prev.end ?? null, sec: prev.sec ?? null };
    writeTiming(workDir, timing);
  } catch (e) {
    process.stderr.write(`[WARN] timing.mjs stageStart 失敗（計測スキップ）: ${e.message}\n`);
  }
}

/** 工程終了時刻を記録し、sec（所要秒）を算出する。start が無ければ end のみ記録し sec は null。 */
export function stageEnd(workDir, name) {
  try {
    const timing = readTiming(workDir);
    const prev = timing.stages[name] || {};
    const end = new Date();
    let sec = null;
    if (prev.start) {
      const startMs = Date.parse(prev.start);
      if (Number.isFinite(startMs)) {
        sec = Math.round((end.getTime() - startMs) / 1000);
      }
    }
    timing.stages[name] = { ...prev, end: end.toISOString(), sec };
    writeTiming(workDir, timing);
    return sec;
  } catch (e) {
    process.stderr.write(`[WARN] timing.mjs stageEnd 失敗（計測スキップ）: ${e.message}\n`);
    return null;
  }
}

/** 任意の工程の sec を直接セットする（mtime差分等、start/endを個別に取れない場合用）。 */
export function stageSetSec(workDir, name, sec) {
  try {
    const timing = readTiming(workDir);
    const prev = timing.stages[name] || {};
    timing.stages[name] = { ...prev, sec: Number.isFinite(sec) ? Math.round(sec) : null };
    writeTiming(workDir, timing);
  } catch (e) {
    process.stderr.write(`[WARN] timing.mjs stageSetSec 失敗（計測スキップ）: ${e.message}\n`);
  }
}

/** [TIME] サマリ行を組み立てる。未計測工程は — 表示。合計は計測済み工程の和。 */
export function summaryLine(timing) {
  const order = ["init", "transcribe", "select", "orchestrate", "render"];
  const labels = { init: "init", transcribe: "transcribe", select: "select", orchestrate: "区間選定", render: "render" };
  const stages = (timing && timing.stages) || {};
  let total = 0;
  let hasAny = false;
  const parts = order.map((name) => {
    const sec = stages[name] && Number.isFinite(stages[name].sec) ? stages[name].sec : null;
    if (sec !== null) {
      total += sec;
      hasAny = true;
      return `${labels[name]} ${sec}s`;
    }
    return `${labels[name]} —`;
  });
  const totalStr = hasAny ? `${total}s` : "—";
  return `[TIME] ${parts.join(" / ")} / 合計 ${totalStr}`;
}
