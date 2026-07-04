#!/usr/bin/env node
/**
 * hook-runner.mjs
 *
 * Claude Code hook の薄い wrapper。
 * 子 hook を spawn して入出力を pass-through しつつ、
 * 構造化ログ ~/.claude/logs/hook-errors.jsonl に 1 行追記する。
 *
 * 使い方:
 *   node hook-runner.mjs --hook=<hook_name> -- <child command and args...>
 *
 * オプション:
 *   --hook=<name>        ログに記録する hook 識別名（必須）
 *   --log-dir=<path>     ログ出力先ディレクトリ（省略時: ~/.claude/logs/）
 *   HOOK_RUNNER_LOG_DIR  環境変数でも指定可（--log-dir より優先度低）
 */

import { spawn } from 'child_process';
import { appendFile, rename, stat, mkdir } from 'fs/promises';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// 主モジュール判定 (import 時はここで終了。filter-repo dangling import 検知用)
const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return argv1.endsWith('hook-runner.mjs');
  } catch {
    return false;
  }
})();
if (!isMain) {
  // import only mode — top-level の stdin 待ちを回避するため即時終了
  // 検証目的の `await import(...)` 時に exit 0 で import 成功扱い
  process.exit(0);
}

// ---- 引数パース ----

const args = process.argv.slice(2);

let hookName = null;
let logDirOverride = null;
let childArgs = [];
let separatorFound = false;

for (const arg of args) {
  if (separatorFound) {
    childArgs.push(arg);
  } else if (arg === '--') {
    separatorFound = true;
  } else if (arg.startsWith('--hook=')) {
    hookName = arg.slice('--hook='.length);
  } else if (arg.startsWith('--log-dir=')) {
    logDirOverride = arg.slice('--log-dir='.length);
  }
}

// ---- 必須引数バリデーション ----
// --hook= が省略された場合は不正呼び出しとして即時終了
// (hook_name: null の malformed record 生成を防ぐ)
if (!hookName) {
  process.stderr.write('[hook-runner] error: --hook=<name> is required\n');
  process.exit(1);
}

// ---- ログディレクトリ解決 ----

const logDir =
  logDirOverride ||
  process.env.HOOK_RUNNER_LOG_DIR ||
  join(homedir(), '.claude', 'logs');

const LOG_FILE = join(logDir, 'hook-errors.jsonl');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

// ---- kill-switch 検出 (env + flag file) ----
// CLAUDE_HOOKS_DISABLE=1 または ~/.claude/disable-hooks 存在で hook 全停止
// child は spawn せず、disabled structured log を 1 行追記して exit 0

const killSwitchReason =
  process.env.CLAUDE_HOOKS_DISABLE === '1'
    ? 'env'
    : existsSync(join(homedir(), '.claude', 'disable-hooks'))
      ? 'flag'
      : null;

if (killSwitchReason !== null) {
  // stdin は読まずに drain (子に渡さないので blocking 防止)
  process.stdin.resume();
  process.stdin.on('data', () => {});

  const disabledEntry = {
    ts: new Date().toISOString(),
    hook_name: hookName,
    tool_name: null,
    event: null,
    decision: 'disabled',
    reason: killSwitchReason,
    duration_ms: 0,
    exit_code: 0,
    cwd: process.cwd(),
    error: null,
  };
  try {
    mkdirSync(logDir, { recursive: true });
    await appendFile(LOG_FILE, JSON.stringify(disabledEntry) + '\n', 'utf8');
  } catch {
    // log 失敗は無視
  }
  process.exit(0);
}

// ---- stdin を buffer に蓄積 ----

const stdinChunks = [];
for await (const chunk of process.stdin) {
  stdinChunks.push(chunk);
}
const stdinBuffer = Buffer.concat(stdinChunks);

// ---- stdin JSON から tool_name / event を取得（parse 失敗は null）----

let toolName = null;
let eventName = null;
try {
  const parsed = JSON.parse(stdinBuffer.toString('utf8'));
  toolName = parsed.tool_name ?? null;
  eventName = parsed.hook_event_name ?? null;
} catch {
  // parse 失敗は無視
}

// ---- child spawn + 計測 ----

const startMs = Date.now();
let childExitCode = 0;
let childStdout = '';
let spawnError = null;

if (childArgs.length === 0) {
  // child command が指定されていない場合は pass-through
  spawnError = 'No child command specified';
} else {
  try {
    await new Promise((resolve) => {
      const [cmd, ...cmdArgs] = childArgs;
      const child = spawn(cmd, cmdArgs, {
        stdio: ['pipe', 'pipe', 'inherit'],
        shell: false,
      });

      // stdin を child に渡す
      child.stdin.write(stdinBuffer);
      child.stdin.end();

      // stdout を蓄積して pass-through
      const stdoutChunks = [];
      child.stdout.on('data', (chunk) => {
        stdoutChunks.push(chunk);
        process.stdout.write(chunk);
      });

      child.on('close', (code) => {
        childExitCode = code ?? 0;
        childStdout = Buffer.concat(stdoutChunks).toString('utf8');
        resolve();
      });

      child.on('error', (err) => {
        spawnError = err.message;
        resolve();
      });
    });
  } catch (err) {
    spawnError = err.message;
  }
}

const durationMs = Date.now() - startMs;

// ---- spawn 失敗時のフォールバック ----

if (spawnError !== null) {
  // stdout に pass decision を出力して harness を止めない
  process.stdout.write(JSON.stringify({ decision: 'pass' }));
}

// ---- child stdout から decision を取得（parse 失敗は null）----

let decision = null;
try {
  const parsed = JSON.parse(childStdout);
  decision = parsed.decision ?? null;
} catch {
  // parse 失敗は無視
}

// ---- JSONL ログ書込 ----

const logEntry = {
  ts: new Date().toISOString(),
  hook_name: hookName,
  tool_name: toolName,
  event: eventName,
  decision,
  duration_ms: durationMs,
  exit_code: childExitCode,
  cwd: process.cwd(),
  error: spawnError,
};

try {
  // ログディレクトリ自動作成（idempotent）
  try {
    mkdirSync(logDir, { recursive: true });
  } catch (mkdirErr) {
    process.stderr.write(`[hook-runner] log dir creation failed: ${mkdirErr.message}\n`);
    // ログ書込をスキップして正常終了へ
    process.exit(spawnError !== null ? 0 : childExitCode);
  }

  // 5MB ローテーション
  try {
    const stats = await stat(LOG_FILE);
    if (stats.size >= MAX_LOG_SIZE) {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ts =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const rotated = join(logDir, `hook-errors-${ts}.jsonl`);
      await rename(LOG_FILE, rotated);
    }
  } catch {
    // ファイル不在 (ENOENT) 等は無視
  }

  // 1 行追記
  await appendFile(LOG_FILE, JSON.stringify(logEntry) + '\n', 'utf8');
} catch (logErr) {
  // ログ書込失敗でも harness は止めない
  process.stderr.write(`[hook-runner] log write failed: ${logErr.message}\n`);
}

// ---- 終了 ----

process.exit(spawnError !== null ? 0 : childExitCode);
