// tests/job-failure-state-check.mjs — pipeline-runner.mjs の失敗時 state.json 永続化の回帰テスト。
//
// 【何の穴を塞ぐか】server/pipeline-runner.mjs の startJob() は、ジョブが失敗すると
// メモリ上の jobs Map（job.stage="error" 等）を更新して SSE で error イベントを流すが、
// 元の実装では state.json への書き戻しをしていなかった。state.json は最後に成功した
// 段階（例: "rendered"）のまま残るため、サーバーを再起動して state.json を読み直すと、
// 実際には失敗したジョブが成功したように見えてしまう（メモリの job.stage は再起動で
// 消える一方、state.json はディスクに残るため）。
//
// このテストは「文字起こしの入力ファイルが存在しない」という、GROQ_API_KEY や
// claude -p を一切必要とせず数秒で決定的に失敗する経路を使って、
// (a) 失敗後に state.json の stage が "error" になっていること
// (b) その後に subscribeJob した購読者にも error イベントがリプレイされること
// を確認する。
//
// 【これは G-EDIT-MOSAIC-UI-O-1/O-2 の凍結された verify の代替ではない】
// 凍結された verify は「/api/jobs から実サーバーへ、実際の文字起こし・字幕直し・区間選定・
// レンダリングを経て、モザイク工程だけを失敗させる」ことを求めており、そのためには
// VS_FIXTURE_MANIFEST による文字起こし・区間選定の差し替え機構が要る（未実装）。
// このテストは pipeline-runner.mjs の状態永続化ロジックそのものの回帰を検出するための
// 補助的な単体テストであり、O-1/O-2 の doing 昇格の証拠には使わない。
//
// 実行: node tests/job-failure-state-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startJob, subscribeJob } from "../server/pipeline-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const WORK_ROOT = path.join(ROOT, "work");

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFile(filePath, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) return true;
    await sleep(50);
  }
  return false;
}

const JOB_ID = "job-failure-state-check-job";
const WORK_DIR = path.join(WORK_ROOT, JOB_ID);
const STATE_PATH = path.join(WORK_DIR, "state.json");
// 実在しない入力: transcribe.py は faster-whisper を読み込む前に
// os.path.isfile() で弾いて即座に exit 2 する（決定的・高速・GROQ/claude 不要）。
const MISSING_INPUT = path.join(ROOT, "work", "__does-not-exist__.mp4");

try {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });

  const ok = startJob(JOB_ID, MISSING_INPUT, { sub: "none", cut: "topic", size: "9:16" });
  assert.strictEqual(ok, true, "前提: startJob が受理される");

  // state.json が最初に書かれる（stage: "init"）のを待つ。
  const initWritten = await waitForFile(STATE_PATH, 5000);
  report("前提: 実行開始直後に state.json (stage=init) が書かれる", initWritten);

  // transcribe.py が「入力が見つかりません」で exit 2 → runJob が reject → catch が
  // state.json を上書きするまで待つ（stage が "error" になるまでポーリング）。
  const deadline = Date.now() + 10_000;
  let finalState = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(STATE_PATH)) {
      const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
      if (s.stage === "error") { finalState = s; break; }
    }
    await sleep(100);
  }

  report(
    "state.json の stage が失敗後に \"error\" へ書き換わる（メモリだけの失敗にしない）",
    !!finalState && finalState.stage === "error",
    `実際のstage=${finalState ? finalState.stage : "(取得不可)"}`
  );
  report(
    "state.json に失敗理由（error）が記録される",
    !!finalState && typeof finalState.error === "string" && finalState.error.length > 0,
    `実際のerror=${finalState ? finalState.error : "(取得不可)"}`
  );
  report(
    "失敗前に書かれていたジョブID等のフィールドが失敗記録でも失われない（丸ごと上書きでない）",
    !!finalState && finalState.id === JOB_ID,
    `実際のid=${finalState ? finalState.id : "(取得不可)"}`
  );

  // O-1相当（SSE到達）: 既に完了(error)したジョブへ後から購読しても、
  // 既存の replay ロジックで error イベントが即座に届くことを確認する
  // (subscribeJob の "race condition 対策" 経路。既存コードの回帰確認)。
  const lines = [];
  let closed = false;
  subscribeJob(
    JOB_ID,
    (line) => lines.push(line),
    () => { closed = true; }
  );
  const body = lines.join("");
  report(
    "完了後に購読しても error イベントがリプレイされる（画面が後から開いても失敗が伝わる）",
    /event:\s*error/.test(body) && closed,
    `body=${body.slice(0, 200)}`
  );
} finally {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
