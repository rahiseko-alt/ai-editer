// server/job-worker.mjs — .runtime/chat-inbox.jsonl を見張って、投入されたジョブの
// 編集処理（src/edit-job.mjs）を自動で起動する常駐プロセス。
//
// 【なぜ要るか（2026-08-19 マスター指摘「APPの指示欄に入れた指示が反映されない」の直接原因）】
// server/index.mjs は「AI の判断・動画処理を一切行わない」設計で、子プロセスを起動しない。
// その結果、UI から実行を押しても chat-inbox.jsonl に1行積まれるだけで、誰かが手で
// `node src/edit-job.mjs <jobId>` を叩くまで何も起きず、UI は完了通知(SSE)を待ち続けていた。
// ここがその「叩く人」を務める。
//
// 【設計の境界】サーバー本体（server/index.mjs）は変えない。これは別プロセスとして動かす。
//   ターミナル2枚: `pnpm serve`（HTTP） と `pnpm worker`（この常駐ワーカー）。
//
// 使い方: node server/job-worker.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendJsonLine, chatInboxPath, isValidJobId, resultsPath } from "./runtime-paths.mjs";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_SHORTS_DIR = path.resolve(SERVER_DIR, "..");
const EDIT_JOB = path.join(VIDEO_SHORTS_DIR, "src", "edit-job.mjs");

// job-events.mjs の SSE ポーリングと同じ考え方（重い仕組みを使わず、ファイルを読み直す）。
// fs.watch は Windows・エディタ・同期フォルダで取りこぼしがあるため使わない。
const POLL_INTERVAL_MS = Number(process.env.VS_WORKER_POLL_MS) > 0 ? Number(process.env.VS_WORKER_POLL_MS) : 500;

/** すでに処理した（または処理中の）jobId。二重起動を防ぐ。 */
const handled = new Set();
/** 起動待ちの jobId。1本ずつ順番に処理する。 */
const queue = [];
let running = false;

function log(msg) {
  console.log(`[worker] ${msg}`);
}

/** jsonl を1行ずつ JSON として読む。壊れた行・空行は飛ばす。 */
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
      // 追記の途中で読んだ不完全な行。次のポーリングで読み直す。
    }
  }
  return out;
}

/** results.jsonl に、その jobId の完了記録がすでにあるか。 */
function hasResult(jobId) {
  return readJsonLines(resultsPath()).some((r) => r && r.id === jobId);
}

/**
 * 起動時点で inbox にある行は、すべて「処理済み」として印を付ける（＝過去分を蒸し返さない）。
 *
 * 【なぜ処理しないか】inbox は追記専用の履歴で、過去には動画の無いテスト送信
 * （`"video":null`）や、別マシンのパス（Desktop\AI-editer 配下）を指す行が混ざっている。
 * ワーカーを起こすたびにこれらを走らせると、失敗記録を量産したうえに本命のジョブが待たされる。
 * このワーカーが面倒を見るのは「起動後に投入された分」だけにする。
 */
function markBacklogAsHandled() {
  let count = 0;
  for (const rec of readJsonLines(chatInboxPath())) {
    if (rec && typeof rec.id === "string") {
      handled.add(rec.id);
      count += 1;
    }
  }
  return count;
}

/** inbox を読み直し、まだ見ていない jobId をキューへ積む。 */
function scanInbox() {
  for (const rec of readJsonLines(chatInboxPath())) {
    // id を持たない行（手書きされた {"type":"chat",...} 等）は、そもそもジョブではないので無視する。
    if (!rec || typeof rec.id !== "string") continue;
    if (handled.has(rec.id)) continue;

    // inbox はファイルなので手で書き換えられる。パスを組み立てる前に必ず形式を確かめる。
    if (!isValidJobId(rec.id)) {
      log(`不正な jobId の行を無視します: ${JSON.stringify(rec.id)}`);
      handled.add(rec.id);
      continue;
    }
    // 何らかの理由ですでに完了記録があるなら（手で走らせた等）、走らせ直さない。
    if (hasResult(rec.id)) {
      handled.add(rec.id);
      continue;
    }

    handled.add(rec.id);
    queue.push(rec.id);
    log(`受け付けました: ${rec.id}`);
  }
}

/**
 * 1件だけ編集処理を起動して、終わるまで待つ。
 * ffmpeg と `claude -p` はどちらも重いので、同時には走らせない（キュー直列）。
 */
function runJob(jobId) {
  return new Promise((resolve) => {
    log(`編集を開始します: ${jobId}`);
    const child = spawn(process.execPath, [EDIT_JOB, jobId], {
      cwd: VIDEO_SHORTS_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 進行がマスターの目に見えるよう、子の出力はそのまま流す（edit-job.mjs が [n/7] を出す）。
    const relay = (stream, write) => {
      stream.setEncoding("utf-8");
      stream.on("data", (chunk) => write(chunk));
    };
    relay(child.stdout, (c) => process.stdout.write(c));
    relay(child.stderr, (c) => process.stderr.write(c));

    const finish = (message) => {
      // edit-job.mjs は自分で done/error/cancelled を results.jsonl へ書く。
      // ここで書くのは「edit-job.mjs が書けずに死んだ」場合だけ。書かないと UI の SSE が
      // 永久に待ち続けて、マスターから見て「反映されない」状態になる。
      if (!hasResult(jobId)) {
        appendJsonLine(resultsPath(), {
          id: jobId,
          status: "error",
          message,
          at: new Date().toISOString(),
        });
        log(`完了記録が無いまま終わったので、失敗として記録しました: ${jobId} — ${message}`);
      }
      resolve();
    };

    child.on("error", (err) => {
      finish(`編集処理を起動できませんでした: ${err.message}`);
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        log(`終了しました: ${jobId}`);
        // 正常終了でも完了記録が無いのは異常（書き込みに失敗している）。UI を待たせないため記録する。
        finish("編集処理は正常終了しましたが、完了記録が書かれていません");
        return;
      }
      finish(`編集処理が異常終了しました（code=${code} signal=${signal ?? "なし"}）`);
    });
  });
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      await runJob(queue.shift());
    }
  } finally {
    running = false;
  }
}

function tick() {
  try {
    scanInbox();
  } catch (err) {
    // 見張りは止めない。読めなかった回は次のポーリングでやり直す。
    log(`inbox の読み込みに失敗しました（次の巡回で再試行します）: ${err.message}`);
  }
  void drain();
}

function main() {
  if (!fs.existsSync(EDIT_JOB)) {
    console.error(`[worker] 編集処理が見つかりません: ${EDIT_JOB}`);
    process.exit(1);
  }
  const skipped = markBacklogAsHandled();
  log(`見張りを開始します: ${chatInboxPath()}`);
  log(`起動前にあった ${skipped} 件は処理しません（起動後に投入されたぶんだけ実行します）`);
  setInterval(tick, POLL_INTERVAL_MS);
}

main();
