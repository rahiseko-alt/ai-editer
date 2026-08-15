#!/usr/bin/env node
// claude 起動の切り分け梯子（診断ツール）
//
// 【なぜ要るか】2026-08-15、Windows実機で画面から動画を作ると claude 呼び出しが失敗した。
// 原因を推測で当てにいって外し続け、マスターの時間を大量に浪費した（docs/failures.md 参照）。
// 推測を排すため、「ターミナルで動く最小構成」から「製品の呼び出し方」まで、
// **変数をちょうど1つずつ足す**梯子を用意する。最初に落ちた段が原因そのものになる。
//
// 【使い方】video-shorts フォルダで:
//     node scripts/diagnose-claude.mjs
// 実行すると各段の合否が出て、最初に落ちた段と、その意味が表示される。
// 全文ログは diagnose-claude-log.txt に保存されるので、そのまま渡せば解析できる。
//
// 【設計】各段は前の段に「1つだけ」条件を足す。足す条件は次の順:
//   M1 claudeが見つかるか（認証不要）
//   M2 認証が通るか（最小構成・プロンプトは引数・環境そのまま・現在のフォルダ）
//   M3 プロンプトを標準入力から渡す      ← 製品と同じ渡し方
//   M4 --output-format json を足す
//   M5 --strict-mcp-config を足す
//   M6 --tools "" を足す                 ← ここまでで製品と同じ引数
//   M7 環境変数を製品の許可リストに絞る
//   M8 作業フォルダを隔離フォルダにする   ← ここで製品と完全に同条件
//   M9 製品の関数 runClaudeJson() をそのまま呼ぶ（配線の確認）

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSafeEnv, NO_TOOLS_ARGS, createIsolatedCwd, ALLOWED_ENV_VARS } from "../src/claude-safety.mjs";
import { runClaudeJson } from "../src/claude-run.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // = video-shorts/
const LOG_PATH = path.join(ROOT, "diagnose-claude-log.txt");
const PROMPT = "PONGとだけ返してください。他には何も書かないでください。";
const STEP_TIMEOUT_MS = 120_000;

const logLines = [];
function log(line = "") {
  console.log(line);
  logLines.push(line);
}
/** 画面には出さず、ログファイルにだけ残す（長い生出力用）。 */
function logFileOnly(line) {
  logLines.push(line);
}

/** claude を1回起動して結果を返す。判定に要る材料（終了コード・stdout・stderr）を全部持ち帰る。 */
function runClaude({ args, useStdin, env, cwd }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("claude", args, { windowsHide: true, env, cwd });
    } catch (e) {
      return resolve({ spawnError: e.message, code: null, stdout: "", stderr: "" });
    }
    let stdout = "", stderr = "", settled = false;
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch { /* 既に死んでいる場合は無視 */ }
      resolve({ timedOut: true, code: null, stdout, stderr });
    }, STEP_TIMEOUT_MS);
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ spawnError: e.message, code: null, stdout, stderr });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (useStdin) {
      child.stdin.on("error", () => { /* 子が先に死ぬと EPIPE。判定は終了コード側で行う */ });
      child.stdin.write(PROMPT, "utf-8");
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/** 結果が「成功」と言えるか。終了コード0であることを唯一の基準にする（自己申告を挟まない）。 */
function ok(r) {
  return !r.spawnError && !r.timedOut && r.code === 0;
}

/** 失敗の理由を、人が読める1行に圧縮する。 */
function why(r) {
  if (r.spawnError) return `起動そのものに失敗: ${r.spawnError}`;
  if (r.timedOut) return `${STEP_TIMEOUT_MS / 1000}秒以内に応答が返らなかった`;
  const bits = [];
  if (r.stderr?.trim()) bits.push(`stderr: ${r.stderr.trim().slice(0, 300)}`);
  if (r.stdout?.trim()) {
    let reason = r.stdout.trim();
    try {
      const j = JSON.parse(reason);
      for (const k of ["result", "error", "message"]) {
        if (typeof j?.[k] === "string" && j[k].trim()) { reason = `${k}=${j[k].trim()}`; break; }
      }
    } catch { /* JSONでなければ素のまま見せる */ }
    bits.push(`stdout: ${reason.slice(0, 300)}`);
  }
  return bits.length ? bits.join(" / ") : "stdout も stderr も空のまま終了した";
}

// ── 梯子の定義。上から順に、直前の段へ「1つだけ」条件を足していく ──────────────
const BASE_ARGS = ["-p"];
const isolatedCwd = createIsolatedCwd("diagnose");

const STEPS = [
  {
    id: "M2",
    title: "認証が通る（最小構成：プロンプトは引数・環境はそのまま・今のフォルダ）",
    adds: "―（これが土台）",
    meaning: "ここが落ちるなら、製品のせいではなく claude のログイン自体が使えない状態です。",
    run: () => runClaude({ args: [...BASE_ARGS, PROMPT], useStdin: false, env: process.env, cwd: ROOT }),
  },
  {
    id: "M3",
    title: "プロンプトを標準入力から渡す",
    adds: "プロンプトの渡し方を、引数から標準入力へ変える（製品と同じ渡し方）",
    meaning: "ここが落ちるなら、Windowsでの標準入力の受け渡しが原因です。",
    run: () => runClaude({ args: BASE_ARGS, useStdin: true, env: process.env, cwd: ROOT }),
  },
  {
    id: "M4",
    title: "--output-format json を足す",
    adds: "--output-format json",
    meaning: "ここが落ちるなら、JSON出力の指定が原因です。",
    run: () => runClaude({
      args: [...BASE_ARGS, "--output-format", "json"], useStdin: true, env: process.env, cwd: ROOT,
    }),
  },
  {
    id: "M5",
    title: "--strict-mcp-config を足す",
    adds: "--strict-mcp-config",
    meaning: "ここが落ちるなら、MCP設定を切る指定が認証に副作用を持っています。",
    run: () => runClaude({
      args: [...BASE_ARGS, "--strict-mcp-config", "--output-format", "json"],
      useStdin: true, env: process.env, cwd: ROOT,
    }),
  },
  {
    id: "M6",
    title: '--tools "" を足す（＝製品と同じ引数がそろう）',
    adds: '--tools ""',
    meaning: "ここが落ちるなら、ツール無効化の指定が原因です。",
    run: () => runClaude({
      args: [...BASE_ARGS, "--strict-mcp-config", "--output-format", "json", ...NO_TOOLS_ARGS],
      useStdin: true, env: process.env, cwd: ROOT,
    }),
  },
  {
    id: "M7",
    title: "環境変数を製品の許可リストに絞る",
    adds: "env を buildSafeEnv() の出力に差し替える",
    meaning: "ここが落ちるなら、許可リストから漏れている環境変数が原因です（何が漏れているかも下に出ます）。",
    run: () => runClaude({
      args: [...BASE_ARGS, "--strict-mcp-config", "--output-format", "json", ...NO_TOOLS_ARGS],
      useStdin: true, env: buildSafeEnv(), cwd: ROOT,
    }),
  },
  {
    id: "M8",
    title: "作業フォルダを隔離フォルダにする（＝製品と完全に同条件）",
    adds: "cwd を一時フォルダ内の隔離ディレクトリへ変える",
    meaning: "ここが落ちるなら、作業フォルダを移したことが原因です（設定の探索が効かない等）。",
    run: () => runClaude({
      args: [...BASE_ARGS, "--strict-mcp-config", "--output-format", "json", ...NO_TOOLS_ARGS],
      useStdin: true, env: buildSafeEnv(), cwd: isolatedCwd,
    }),
  },
  {
    id: "M9",
    title: "製品の関数 runClaudeJson() をそのまま呼ぶ",
    adds: "製品コードの配線を通す",
    meaning: "M8が通ってここが落ちるなら、原因は claude ではなく製品側の配線です。",
    run: async () => {
      try {
        const out = await runClaudeJson({ stdin: PROMPT, cwd: isolatedCwd, timeoutMs: STEP_TIMEOUT_MS });
        return { code: 0, stdout: String(out), stderr: "" };
      } catch (e) {
        return { code: 1, stdout: e?.stdout ?? "", stderr: e?.stderr ?? "", productError: e?.message };
      }
    },
  },
];

// ── 実行 ───────────────────────────────────────────────────────────────
log("=".repeat(70));
log("claude 起動の切り分け診断");
log("=".repeat(70));
log("");

// M1: 環境の確認（認証を使わないので、ここが落ちるなら話は単純）
log("[M1] claude が見つかるか（ログイン不要の確認）");
const whichCmd = process.platform === "win32" ? "where" : "which";
const whichR = spawnSync(whichCmd, ["claude"], { encoding: "utf-8", windowsHide: true });
const foundPaths = (whichR.stdout ?? "").trim();
const verR = spawnSync("claude", ["--version"], { encoding: "utf-8", windowsHide: true });
const version = (verR.stdout ?? "").trim() || (verR.stderr ?? "").trim();

log(`     claude の場所: ${foundPaths || "(見つからない)"}`);
log(`     claude の版  : ${version || "(取得できない)"}`);
log(`     node の版    : ${process.version} / OS: ${process.platform}`);
if (foundPaths.split(/\r?\n/).filter(Boolean).length > 1) {
  log("     ※ claude が複数見つかりました。別々のインストールが混在している可能性があります。");
}
logFileOnly(`     [生] where/which: ${JSON.stringify(whichR.stdout)} ${JSON.stringify(whichR.stderr)}`);
logFileOnly(`     [生] --version  : ${JSON.stringify(verR.stdout)} ${JSON.stringify(verR.stderr)}`);

if (verR.status !== 0) {
  log("     → 失敗（M1）");
  log("");
  log("【結論】claude コマンド自体が起動できません。製品以前の問題です。");
  log("        claude がインストールされているか、PATH が通っているかを確認してください。");
  fs.writeFileSync(LOG_PATH, logLines.join("\n"), "utf-8");
  log("");
  log(`ログを保存しました: ${LOG_PATH}`);
  process.exit(1);
}
log("     → 成功（M1）");
log("");

// M2以降: 変数を1つずつ足していく
let firstFailure = null;
for (const step of STEPS) {
  log(`[${step.id}] ${step.title}`);
  log(`     足した条件: ${step.adds}`);
  const r = await step.run();
  logFileOnly(`     [生] code=${r.code} spawnError=${r.spawnError ?? "-"} timedOut=${r.timedOut ?? false}`);
  logFileOnly(`     [生] stdout=${JSON.stringify(r.stdout ?? "")}`);
  logFileOnly(`     [生] stderr=${JSON.stringify(r.stderr ?? "")}`);
  if (r.productError) logFileOnly(`     [生] productError=${JSON.stringify(r.productError)}`);

  if (ok(r)) {
    log("     → 成功");
    log("");
    continue;
  }
  log(`     → 失敗: ${why(r)}`);
  log("");
  firstFailure = { step, r };
  break;
}

// ── 結論 ───────────────────────────────────────────────────────────────
log("=".repeat(70));
if (!firstFailure) {
  log("【結論】全ての段が成功しました。");
  log("        製品と同じ条件で claude は正常に動いています。");
  log("        画面からの動画作成がまだ失敗する場合、原因は claude の呼び出しより");
  log("        後ろの工程（文字起こし・書き出し等）にあります。");
} else {
  const { step, r } = firstFailure;
  log(`【結論】${step.id} で初めて失敗しました。`);
  log("");
  log(`  直前の段までは成功しています。${step.id} で足した条件は:`);
  log(`      ${step.adds}`);
  log("");
  log(`  つまり、これが原因です。${step.meaning}`);
  log("");
  log(`  失敗の中身: ${why(r)}`);

  // 環境変数が原因の段だけは、何が落ちているかをその場で出す（次の一手が即決まる）
  if (step.id === "M7") {
    const passed = new Set(Object.keys(buildSafeEnv()));
    const dropped = Object.keys(process.env).filter((k) => !passed.has(k));
    log("");
    log(`  許可リストを通った環境変数（${passed.size}件）: ${[...passed].sort().join(", ")}`);
    log(`  絞り込みで落とした環境変数（${dropped.length}件）:`);
    log(`      ${dropped.sort().join(", ")}`);
    log("");
    log("  この「落とした」側に、claude が必要としているものが含まれています。");
    logFileOnly(`     [生] ALLOWED_ENV_VARS=${JSON.stringify(ALLOWED_ENV_VARS)}`);
  }
}
log("=".repeat(70));

try { fs.rmSync(isolatedCwd, { recursive: true, force: true }); } catch { /* 消せなくても診断結果には影響しない */ }
fs.writeFileSync(LOG_PATH, logLines.join("\n"), "utf-8");
log("");
log(`詳しい記録を保存しました: ${LOG_PATH}`);
log("このファイルの中身をそのまま伝えてもらえれば、原因を確定できます。");

process.exit(firstFailure ? 1 : 0);
