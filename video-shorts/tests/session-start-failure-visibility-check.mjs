// tests/session-start-failure-visibility-check.mjs — G-DELIVERY-FAILCLEAR の機械検証。
//
// 【何の穴を塞ぐか】.claude/hooks/session-start.sh は、クラウドセッション起動時に
// ffmpeg / 文字起こしライブラリ(faster-whisper・groq)を自動導入するフック。修正前は
// 「if ! cmd; then rc=$?」の形で、"!" による否定の直後に "$?" を取っていたため、
// 否定演算の結果($?)を拾ってしまい、cmd が実際には失敗していても常に exit code 0で
// 終了する不具合があった(=導入に失敗しても、利用者からは何が起きたか分からない)。
//
// このテストは、apt-get/python3 を「必ず失敗するモック」に差し替えた状態で
// 実際に session-start.sh を子プロセスとして実行し、
// (a) 終了コードが、失敗したコマンドのexit codeと一致すること(0に潰されないこと)
// (b) stderr に "[session-start][ERROR]" プレフィックス付きの原因メッセージが出ること
// を確認する。対照として、モックを成功させた場合は exit 0・stderrへの[ERROR]出力なし
// であることも確認する(失敗時だけ壊れて見える誤検知でないことの裏付け)。
//
// 実行: node tests/session-start-failure-visibility-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(path.dirname(HERE)); // video-shorts/tests -> ai-editer root
const HOOK_PATH = path.join(REPO_ROOT, ".claude", "hooks", "session-start.sh");

// テスト実行時のPATHでbash実体を解決しておく(下でPATHをモック専用ディレクトリだけに
// 絞るため、bash自体をPATH検索で見つけられなくなる。絶対パスで直接起動する)。
const BASH_PATH = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
assert.ok(BASH_PATH, "bashの絶対パスを解決できませんでした");

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

assert.ok(fs.existsSync(HOOK_PATH), `hookが見つかりません: ${HOOK_PATH}`);

/**
 * 指定した内容の実行可能モックを mockDir/name に書く。
 * @param {string} mockDir
 * @param {string} name
 * @param {string} body シバン行を除いたシェルスクリプト本体
 */
function writeMock(mockDir, name, body) {
  const p = path.join(mockDir, name);
  fs.writeFileSync(p, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

/**
 * mockDir だけを PATH にした環境で session-start.sh を実行し、結果を返す。
 * @param {string} mockDir
 * @returns {{ code: number, stderr: string, stdout: string }}
 */
function runHookWithMocks(mockDir) {
  try {
    const stdout = execFileSync(BASH_PATH, [HOOK_PATH], {
      encoding: "utf8",
      env: {
        PATH: mockDir,
        CLAUDE_CODE_REMOTE: "true",
        CLAUDE_PROJECT_DIR: REPO_ROOT,
        HOME: os.tmpdir(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return {
      code: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

function makeMockDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---- ケースA: apt-get install が(固定版・無指定版とも)必ず失敗する ----
{
  const mockDir = makeMockDir("session-start-mock-apt-fail-");
  const APT_FAIL_CODE = 42;
  writeMock(mockDir, "sudo", `exec "$@"`); // sudoはそのまま次のコマンドへ委譲するだけ
  writeMock(mockDir, "apt-get", `echo "mock apt-get: $*" >&2\nexit ${APT_FAIL_CODE}`);
  // python3はこのケースでは呼ばれない想定(apt-get失敗でexitするはず)だが、
  // 呼ばれてしまった場合に検知できるよう明示的に「呼ばれたら失敗」にしておく。
  writeMock(mockDir, "python3", `echo "unexpected python3 call: $*" >&2\nexit 99`);

  const r = runHookWithMocks(mockDir);
  report(
    "G-DELIVERY-FAILCLEAR: apt-get install失敗時、終了コードが失敗コマンドのexit codeと一致する(0に潰されない)",
    r.code === APT_FAIL_CODE,
    `got code=${r.code} stderr=${r.stderr}`,
  );
  report(
    "G-DELIVERY-FAILCLEAR: apt-get install失敗時、stderrに[session-start][ERROR]の原因メッセージが出る",
    r.stderr.includes("[session-start][ERROR]") && /ffmpeg/i.test(r.stderr),
    `stderr=${r.stderr}`,
  );
  fs.rmSync(mockDir, { recursive: true, force: true });
}

// ---- ケースB: apt-get(ffmpeg導入)は成功するが、python3 -m pip install が失敗する ----
{
  const mockDir = makeMockDir("session-start-mock-pip-fail-");
  const PIP_FAIL_CODE = 55;
  writeMock(mockDir, "sudo", `exec "$@"`);
  writeMock(mockDir, "apt-get", `echo "mock apt-get: $* (ok)" >&2\nexit 0`);
  writeMock(
    mockDir,
    "python3",
    [
      'if [ "$1" = "-c" ]; then',
      '  echo "mock python3 -c: import失敗を装う" >&2',
      "  exit 1",
      'elif [ "$1" = "-m" ] && [ "$2" = "pip" ]; then',
      '  echo "mock pip install failure" >&2',
      `  exit ${PIP_FAIL_CODE}`,
      "fi",
      'echo "unexpected python3 args: $*" >&2',
      "exit 98",
    ].join("\n"),
  );

  const r = runHookWithMocks(mockDir);
  report(
    "G-DELIVERY-FAILCLEAR: pip install失敗時、終了コードが失敗コマンドのexit codeと一致する(0に潰されない)",
    r.code === PIP_FAIL_CODE,
    `got code=${r.code} stderr=${r.stderr}`,
  );
  report(
    "G-DELIVERY-FAILCLEAR: pip install失敗時、stderrに[session-start][ERROR]の原因メッセージが出る",
    r.stderr.includes("[session-start][ERROR]") && /pip/i.test(r.stderr),
    `stderr=${r.stderr}`,
  );
  fs.rmSync(mockDir, { recursive: true, force: true });
}

// ---- 対照: 両方成功すれば exit 0・[ERROR]出力なし(失敗時にしか出ない誤検知でないことの裏付け) ----
{
  const mockDir = makeMockDir("session-start-mock-both-ok-");
  writeMock(mockDir, "sudo", `exec "$@"`);
  writeMock(mockDir, "apt-get", `exit 0`);
  writeMock(
    mockDir,
    "python3",
    ['if [ "$1" = "-c" ]; then', "  exit 0", "fi", "exit 0"].join("\n"),
  );

  const r = runHookWithMocks(mockDir);
  report(
    "G-DELIVERY-FAILCLEAR 対照: apt-get/python3とも成功すれば終了コード0",
    r.code === 0,
    `got code=${r.code} stderr=${r.stderr}`,
  );
  report(
    "G-DELIVERY-FAILCLEAR 対照: 成功時はstderrに[ERROR]が出ない(失敗時だけの誤検知でない)",
    !r.stderr.includes("[session-start][ERROR]"),
    `stderr=${r.stderr}`,
  );
  fs.rmSync(mockDir, { recursive: true, force: true });
}

// ---- 対照: CLAUDE_CODE_REMOTE未設定はローカル扱いで無音no-op(ci.ymlのjobと同じ確認をここでも独立に持つ) ----
{
  const mockDir = makeMockDir("session-start-mock-local-");
  const out = execFileSync(BASH_PATH, [HOOK_PATH], {
    encoding: "utf8",
    env: { PATH: mockDir, HOME: os.tmpdir() },
  });
  report(
    "G-DELIVERY-FAILCLEAR 対照: CLAUDE_CODE_REMOTE未設定はローカル扱いで無音no-op",
    out === "",
    `stdout=${JSON.stringify(out)}`,
  );
  fs.rmSync(mockDir, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exitCode = fail > 0 ? 1 : 0;
