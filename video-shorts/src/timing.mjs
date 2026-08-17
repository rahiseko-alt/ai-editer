// video-shorts 工程タイマー — work/<job>/timing.json に各工程の開始/終了/所要秒を
// read-modify-write で記録する。計測が失敗しても本処理（init/select/render等）は止めない
// （サイレントフェイル禁止だが、タイマーはあくまで補助計測なので落としてはいけない側ではない）。
//
// スキーマ: { stages: { <name>: { start: <ISO>, end: <ISO>, sec: <number> } } }

import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomically } from "./atomic-json.mjs";

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

/**
 * timing.json を書く。
 *
 * 2026-08-17: 直接 writeFileSync（O_TRUNC）していたため、書いている途中で落ちると
 * timing.json が壊れ、readTiming() が「空の {stages:{}}」を返す＝それまでに計測した
 * 全工程の記録がまとめて消える。工程は複数のプロセス（server / pipeline.mjs /
 * transcribe.py）が read-modify-write で書き足していく共有ファイルなので、
 * 1回の中断で全部失うのは割に合わない。state.json と同じ原子的書き込みへ揃える。
 */
function writeTiming(workDir, timing) {
  writeJsonAtomically(timingPath(workDir), timing);
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

/**
 * 開始・終了の時刻が「別のプロセス/別の層で起きた事実」から後追いで分かる工程を記録する
 * （例: アップロードは HTTP 層で起きるので、受け取ったファイルの作成時刻〜最終更新時刻で
 * 後から確定させる）。start/end/sec を一度に埋めるだけで、スキーマは stageStart/stageEnd と同じ。
 * @param {string} workDir
 * @param {string} name
 * @param {number} startMs epoch ミリ秒
 * @param {number} endMs epoch ミリ秒
 */
export function stageSetSpan(workDir, name, startMs, endMs) {
  try {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return;
    const timing = readTiming(workDir);
    const prev = timing.stages[name] || {};
    timing.stages[name] = {
      ...prev,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      sec: Math.round((endMs - startMs) / 1000),
    };
    writeTiming(workDir, timing);
  } catch (e) {
    process.stderr.write(`[WARN] timing.mjs stageSetSpan 失敗（計測スキップ）: ${e.message}\n`);
  }
}

/**
 * 表示順（ジョブが進む順）。ここに無い工程名も落とさず末尾へ並べる（下記 summaryLine 参照）。
 *
 * 【なぜ「順番だけ」を固定するのか】2026-08-17 まで、この配列は表示順であると同時に
 * **集計の対象一覧**でもあった（順に map して合計していた）。そのため
 * captionfix / trimjudge / approval-wait のように後から足した工程は、timing.json に
 * 記録されていても [TIME] 行にも合計にも一切出てこず、「合計」がジョブ全体の所要時間から
 * 黙って外れていた（＝どこで時間を食っているのか数字で切り分けられない）。
 * 集計対象は timing.json に載っている工程**全部**とし、この配列は並び順の指定に徹する。
 */
const STAGE_ORDER = [
  "upload",        // 端末→サーバーへの動画の送信（画面経路のみ）
  "queue-wait",    // 受理〜実行開始（同時実行数の順番待ち）
  "init",          // 作業ディレクトリと state.json の作成（CLI経路）
  "transcribe",    // 文字起こし
  "captionfix",    // AIが文字起こしの誤字を直す
  "trimjudge",     // AIが詰めてよい所（言い淀み・間）を判断する
  "select",        // 区間選定の下準備（llm-request.md 生成 / digest は編集エージェント本体）
  "orchestrate",   // AIによる区間選定そのもの
  "approval-wait", // 人間の承認待ち（AI・動画処理の遅さとは別物なので必ず分ける）
  "render",        // 切り出し・字幕焼き込み
  "mosaic",        // 顔モザイク
];

const STAGE_LABELS = {
  upload: "アップロード",
  "queue-wait": "順番待ち",
  init: "init",
  transcribe: "transcribe",
  captionfix: "誤字修正",
  trimjudge: "詰める所の判断",
  select: "select",
  orchestrate: "区間選定",
  "approval-wait": "承認待ち",
  render: "render",
  mosaic: "モザイク",
};

/**
 * 記録が無くても「—」を出す工程。どの経路でも必ず通るのに timing.json に載っていない
 * ＝計測が抜けている、という事実を隠さないため（黙って行から消すと抜けに気付けない）。
 */
const ALWAYS_SHOWN = ["transcribe", "select", "render"];

/**
 * [TIME] サマリ行を組み立てる。未計測工程は — 表示。
 * 合計は **timing.json に載っている工程すべて** の和＝ジョブ全体の所要時間。
 *
 * 【前提】各工程は重ならないこと（入れ子の工程を別名で二重に記録すると合計が水増しされる）。
 * 例: 画面経路の区間選定は select（下準備）と orchestrate（AI呼び出し）に分けて記録し、
 * 片方がもう片方を含まないようにしている。
 */
export function summaryLine(timing) {
  const stages = (timing && timing.stages) || {};
  const names = [
    ...STAGE_ORDER.filter((n) => stages[n] || ALWAYS_SHOWN.includes(n)),
    // 将来足された（この一覧に未登録の）工程も落とさず末尾に並べる。
    ...Object.keys(stages).filter((n) => !STAGE_ORDER.includes(n)),
  ];
  let total = 0;
  let hasAny = false;
  const parts = names.map((name) => {
    const label = STAGE_LABELS[name] || name;
    const sec = stages[name] && Number.isFinite(stages[name].sec) ? stages[name].sec : null;
    if (sec === null) return `${label} —`;
    total += sec;
    hasAny = true;
    return `${label} ${sec}s`;
  });
  const totalStr = hasAny ? `${total}s` : "—";
  return `[TIME] ${parts.join(" / ")} / 合計 ${totalStr}`;
}
