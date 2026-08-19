#!/usr/bin/env node
// server/watch-jobs.mjs — 投入された編集ジョブの状態を見張り、手を打つ必要があるものだけを
// 1行1件で標準出力へ流す。Claude セッションが Monitor(persistent) で常駐させる前提。
//
// 【なぜ要るか（2026-08-19 に実際に起きた事故）】
// この日、区間選定を使い捨ての `claude -p` へ丸投げするのをやめ、edit-job.mjs を
// `prepare`（文字起こし〜文節化）と `render`（書き出し）へ割った。ワーカー
// （job-worker.mjs）は prepare までしか自動実行せず、正常終了時は results.jsonl へ
// 何も書かない（内容を決めるのはこれからなので「完了」ではない）。
//
// ところが、**その「これから決める」側へ prepare の完了を知らせる線を繋がなかった。**
// job-worker.mjs の完了通知は別ターミナルの標準出力に出るだけで、実際に区間を決める
// Claude セッションには届かない。結果、この日 15:48 に prepare 完了していたジョブ
// (62bce4ac…・226文節) に誰も気づかず、待たされたマスターが中止を押した。
//
// 【使い方】Claude セッションが Monitor ツールで常駐させる。
//   Monitor({ command: "node server/watch-jobs.mjs", persistent: true, ... })
// 標準出力の1行が1通知としてセッションへ届く。**Bash のバックグラウンド実行で代用しては
// いけない**（常駐プロセスは終了しないので、1行ごとの通知が届かず「張ったつもり」になる）。
//
// 【なぜ 起動.bat の3枚目のウィンドウにしないのか（重要な非変更）】
// このスクリプトの目的は「Claude セッションに届かせる」ことである。起動.bat から別ウィンドウで
// 起動すると、出力はそのウィンドウに出るだけで、**まさに今回直している不具合と同じ形になる。**
// 通知を受ける主体が Claude 自身であることが設計の要なので、起動は必ず Claude 側から行う。
//
// 【設計（敵対検証で12件の穴を出したうえでの版）】
// 1. **起点は「投入された全ジョブ」＝ chat-inbox.jsonl。** work/ のディレクトリ一覧を起点に
//    すると、ディレクトリが作られる前に死んだ場合（ワーカーが落ちている・別ジョブで詰まって
//    いる・prepare が強制終了された）に**1行も出ない**。投入の記録を起点にすれば、
//    「投入されたのに何も進んでいない」を検出できる。ここが最も重要な検出対象。
// 2. **沈黙は成功ではない。** 選定待ちだけでなく、失敗・中止・停滞も出す。とくに
//    `units.json` が空配列（語が1つも取れなかった）を「まだ準備中」と誤解しない。
// 3. **通知が多すぎると Monitor は自動停止する＝壊れている時ほど失明する。** よって
//    全ての行を1行へ整形し（ffmpeg/python の stderr が丸ごと乗るのを防ぐ）、
//    同じ巡回エラーを繰り返し出さない。
// 4. fs.watch は使わない。Windows・エディタ・同期フォルダで取りこぼす（job-worker.mjs の既決事項）。
// 5. 生存の合図は「待っているジョブがある時だけ」出す。何も無い時の沈黙は正常なので黙る。

import fs from "node:fs";
import path from "node:path";

import { chatInboxPath, isValidJobId, resultsPath, workJobDir } from "./runtime-paths.mjs";

const POLL_INTERVAL_MS = Number(process.env.VS_WATCH_POLL_MS) > 0 ? Number(process.env.VS_WATCH_POLL_MS) : 2000;

/** 投入からこれだけ経っても先へ進んでいなければ「停滞」として1回だけ知らせる（分）。
 * 長尺の文字起こしは時間がかかるので余裕を持たせる。誤報1行は、沈黙より常にましである。 */
const STALL_MIN = Number(process.env.VS_WATCH_STALL_MIN) > 0 ? Number(process.env.VS_WATCH_STALL_MIN) : 15;

/** これより古い投入は「停滞」として知らせない（分。既定24時間）。
 * inbox は追記専用の履歴なので、過去のテスト送信や放棄されたジョブが永久に残る。上限が無いと
 * 見張りを起こすたびに同じ古い行が通知され、肝心な新しいジョブが埋もれる（実測で4件出た）。
 * 「今手を打つ対象」だけを通知の対象にする。 */
const STALL_MAX = Number(process.env.VS_WATCH_STALL_MAX_MIN) > 0 ? Number(process.env.VS_WATCH_STALL_MAX_MIN) : 24 * 60;

/** 待っているジョブがある間だけ、これだけ間隔を空けて生存の合図を出す（分）。 */
const HEARTBEAT_MIN = Number(process.env.VS_WATCH_HEARTBEAT_MIN) > 0 ? Number(process.env.VS_WATCH_HEARTBEAT_MIN) : 30;

/** 起動直後に溜まっていた分を、最大この件数まで個別に出す（残りは件数だけ知らせる）。 */
const BACKLOG_LIST_MAX = 10;

/** jobId → 最後に報告した状態。状態が変わった瞬間だけ出すために使う。 */
const reported = new Map();
/** 直前に出した巡回エラー。同じ内容を2秒ごとに出し続けないための重複抑制。 */
let lastTickError = null;
let lastHeartbeatAt = Date.now();
let firstTick = true;

/** 1行＝1通知。改行や連続空白を潰して、必ず1行に収める。 */
function emit(text) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  process.stdout.write(`${oneLine}\n`);
}

function shorten(text, max = 160) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** jsonl を1行ずつ JSON として読む。壊れた行・空行は飛ばす（job-worker.mjs と同じ作法）。 */
function readJsonLines(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch (_err) {
      // 追記の途中で読んだ不完全な行。次の巡回で読み直す。
    }
  }
  return out;
}

/**
 * JSON を読む。返り値は3通りを区別する:
 *   { ok: true, value }  読めた
 *   { ok: false, missing: true }   ファイルが無い
 *   { ok: false, missing: false }  在るが読めない（書き込み途中・別プロセスが掴んでいる等）
 * 「在るが読めない」を「無い」と同じ扱いにすると、状態が往復して同じ通知を繰り返す。
 */
function readJson(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: false, missing: true };
    return { ok: false, missing: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (_err) {
    return { ok: false, missing: false };
  }
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch (_err) {
    return false;
  }
}

function minutesSince(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 60000;
}

/**
 * 投入された1ジョブの、いま報告すべき状態を決める。
 * 返り値 null は「報告不要」。undefined は「判定できなかった（状態を更新しない）」。
 *
 * 優先順位に意味がある: 完了 > 中止 > 失敗 > 選定待ち > 停滞 > 準備中
 * 手を打つ必要が高いものを先に出す。
 */
function classify(job, results) {
  const jobId = job.id;
  let dir;
  try {
    dir = workJobDir(jobId);
  } catch (_err) {
    return null; // 形式が不正な jobId（runtime-paths が弾く）
  }

  const age = minutesSince(job.at);

  // 古すぎる投入は、状態がどうであれ知らせない。
  // inbox は追記専用の履歴なので、過去のテスト送信・放棄されたジョブ・古い失敗記録が永久に残る。
  // 上限が無いと見張りを起こすたびに同じ古い行が並び、肝心な新しいジョブが埋もれる
  // （実測で32時間前のテスト送信4件が毎回出た）。「今手を打つ対象」だけを通知する。
  if (age != null && age > STALL_MAX) return null;

  const result = results.get(jobId);
  if (result && result.status === "done") return null; // 終わっている。知らせることは無い

  if (exists(path.join(dir, ".cancel"))) {
    return { state: "中止", detail: ".cancel の旗が立っています（このまま render しても即座に打ち切られます）" };
  }

  const keepExists = exists(path.join(dir, "keep.json"));
  const units = readJson(path.join(dir, "units.json"));

  if (result && result.status === "error") {
    return { state: "失敗", detail: shorten(result.message) || "（理由の記録なし）" };
  }
  if (result && result.status === "cancelled") {
    // 中止として記録済み。旗は既に下りている（上で確認済み）。手を打つ必要は無い。
    return null;
  }

  if (units.ok) {
    if (!Array.isArray(units.value) || units.value.length === 0) {
      // prepare は完走したのに文節が0個。音が無い・語が1つも取れなかった場合に起きる。
      // これを「まだ準備中」と読むと永久に沈黙する（敵対検証で見つかった致命的な穴）。
      return { state: "失敗", detail: "文字起こしで語が1つも取れませんでした（units.json が空）。素材の音声を確認してください" };
    }
    if (!keepExists) {
      return { state: "選定待ち", units: units.value.length };
    }
    // keep.json まで書いてあるのに完了記録が無い＝ render が止まった可能性。
    if (age != null && age >= STALL_MIN && age <= STALL_MAX) {
      return { state: "停滞", detail: `keep.json は在るが完了記録がありません（投入から${Math.floor(age)}分）。render が落ちたか、叩き忘れの可能性` };
    }
    return null; // render 中とみなす
  }

  if (!units.missing) return undefined; // 在るが読めなかった。状態を変えずに次の巡回で読み直す

  // units.json が無い＝まだ prepare が終わっていない。時間が経ちすぎていれば知らせる。
  if (age != null && age >= STALL_MIN && age <= STALL_MAX) {
    const started = exists(path.join(dir, "transcript.json"));
    return {
      state: "停滞",
      detail: started
        ? `文字起こしはあるが文節化まで進んでいません（投入から${Math.floor(age)}分）。prepare が落ちた可能性`
        : `投入から${Math.floor(age)}分、何も進んでいません。ワーカー（job-worker.mjs）が動いているか確認してください`,
    };
  }
  return null; // 準備中（正常）
}

function describe(job, info) {
  if (info.state === "選定待ち") {
    const instruction = shorten(job.instruction, 80);
    const aspect = job.settings?.aspect ?? "?";
    const caption = job.settings?.caption ? "字幕あり" : "字幕なし";
    return `選定待ち ${job.id} 文節${info.units} ${aspect}/${caption} 指示「${instruction || "（指示なし）"}」`;
  }
  return `${info.state} ${job.id} ${info.detail}`;
}

function tick() {
  const results = new Map();
  for (const r of readJsonLines(resultsPath())) {
    // 同じ id が再実行されると複数行になる。最後の行が現在の状態。
    if (r && typeof r.id === "string") results.set(r.id, r);
  }

  // 起点は「投入された記録」。work/ のディレクトリ一覧を起点にすると、
  // ディレクトリが作られる前に死んだジョブが丸ごと見えなくなる。
  const jobs = readJsonLines(chatInboxPath()).filter((j) => j && isValidJobId(j.id));

  const pending = [];
  let waiting = 0;

  for (const job of jobs) {
    const info = classify(job, results);
    if (info === undefined) continue; // 判定できず。状態は据え置き

    const state = info ? info.state : "なし";
    if (state === "選定待ち" || state === "なし") {
      // 「なし」には準備中も含まれる。生存の合図を出すかの判断に使う。
      if (info) waiting += 1;
    }
    if (reported.get(job.id) === state) continue;

    if (!info) {
      reported.set(job.id, state);
      continue;
    }
    if (firstTick) {
      pending.push({ job, info });
      continue; // reported は下でまとめて設定する（出せなかった分を据え置くため）
    }
    reported.set(job.id, state);
    emit(describe(job, info));
  }

  if (firstTick) {
    const shown = pending.slice(0, BACKLOG_LIST_MAX);
    for (const { job, info } of shown) {
      reported.set(job.id, info.state);
      emit(describe(job, info));
    }
    if (pending.length > shown.length) {
      // 出さなかった分は reported に入れない＝次の巡回以降に個別で出る（取りこぼさない）。
      emit(`ほかに手当てが必要なジョブが${pending.length - shown.length}件あります（順次お知らせします）`);
    }
    firstTick = false;
  }

  // 待っているジョブがある間だけ生存を知らせる。何も待っていない時の沈黙は正常なので黙る。
  if (waiting > 0 && Date.now() - lastHeartbeatAt >= HEARTBEAT_MIN * 60000) {
    lastHeartbeatAt = Date.now();
    emit(`見張り継続中（処理中のジョブ${waiting}件）`);
  } else if (waiting === 0) {
    lastHeartbeatAt = Date.now();
  }
}

function main() {
  emit(`見張り開始: ${chatInboxPath()}（${POLL_INTERVAL_MS}ms ごと・選定待ち/失敗/中止/停滞を通知します）`);
  setInterval(() => {
    try {
      tick();
      lastTickError = null;
    } catch (err) {
      // 見張りは止めない。ただし同じエラーを2秒ごとに出し続けると Monitor が自動停止して
      // 恒久的に失明するので、内容が変わった時だけ1行出す。
      const message = shorten(err && err.message ? err.message : String(err));
      if (message !== lastTickError) {
        lastTickError = message;
        emit(`見張りの巡回に失敗しました（次の巡回で再試行します）: ${message}`);
      }
    }
  }, POLL_INTERVAL_MS);
}

main();
