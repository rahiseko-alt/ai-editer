// claude -p が失敗したとき、失敗の理由が呼び出し側へ実際に届くかの機械検査。
//
// 【なぜ要るか】2026-08-15、実機(Windows)で画面から動画を作ると
// 「claude 終了コード 1。stderr: 」とだけ出て失敗し、真因が一切分からなかった。
// claude は失敗の出し先を2つ持つ:
//   - 起動前の失敗(不正なフラグ等)  → stderr へ出す
//   - 実行中の失敗(認証・通信・モデル・クォータ等) → 結果として stdout へ出す
//     (公式ドキュメント "Run Claude Code programmatically")
// 旧実装は close ハンドラで stdoutBuf を読まずに捨てていたため、後者が起きると
// 手掛かりがゼロになった。実際、原因の切り分けに独立3系統の調査を要した。
//
// 【この検査が閉じるもの】「終了コード非0のとき、stderr と stdout の両方が呼び出し側へ届く」
// ことを、偽の claude を使って実際に失敗させて確かめる。ソース文字列の正規表現照合ではなく、
// 本物の spawn 経路(runClaudeJson)を通した実測で見る。
//
// 実行: node tests/claude-run-failure-surface-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runClaudeJson, summarizeStdoutFailure } from "../src/claude-run.mjs";

let pass = 0, fail = 0;
const tmpDirs = [];
const savedPath = process.env.PATH;

async function t(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.message}`); }
}

/** 指定した振る舞いをする偽の claude を PATH の先頭へ差し込む。 */
function installFakeClaude(bodyJs) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-claude-fail-"));
  tmpDirs.push(binDir);
  const exe = path.join(binDir, "claude");
  fs.writeFileSync(exe, `#!/usr/bin/env node\n${bodyJs}\n`);
  fs.chmodSync(exe, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  return binDir;
}

function mkCwd() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vs-claude-fail-cwd-"));
  tmpDirs.push(d);
  return d;
}

try {
  // ── 本命: 実行中の失敗(stdout にだけ理由が出る) ─────────────────────────
  // 認証切れ・通信不能・クォータ超過はすべてこの形になる。ここを取りこぼすと真因が消える。
  await t("実行中の失敗(stdoutにだけ理由が出る)でも、理由がエラーメッセージへ現れる", async () => {
    installFakeClaude(
      `process.stdout.write(JSON.stringify({is_error:true,terminal_reason:"api_error",` +
      `result:"API Error: Connection refused — a firewall or proxy may be blocking it"}));\n` +
      `process.exit(1);`
    );
    let caught = null;
    try { await runClaudeJson({ stdin: "hi", cwd: mkCwd() }); }
    catch (e) { caught = e; }
    assert.ok(caught, "失敗するはずが成功した");
    assert.ok(
      /Connection refused/.test(caught.message),
      `stdout に出た理由がメッセージに含まれていない: ${caught.message}`
    );
    assert.ok(/Connection refused/.test(caught.stdout ?? ""), "err.stdout に全文が渡っていない");
  });

  // ── 従来経路: 起動前の失敗(stderr に理由が出る)を壊していないこと ──────────
  await t("起動前の失敗(stderrに理由が出る)は従来どおり理由が現れる", async () => {
    installFakeClaude(
      `process.stderr.write("error: unknown option '--bogus'");\nprocess.exit(1);`
    );
    let caught = null;
    try { await runClaudeJson({ stdin: "hi", cwd: mkCwd() }); }
    catch (e) { caught = e; }
    assert.ok(caught, "失敗するはずが成功した");
    assert.ok(
      /unknown option/.test(caught.message),
      `stderr に出た理由がメッセージに含まれていない: ${caught.message}`
    );
    assert.ok(/unknown option/.test(caught.stderr ?? ""), "err.stderr に全文が渡っていない");
  });

  // ── 両方に出る場合、どちらも落とさない ────────────────────────────────
  await t("stderr と stdout の両方に理由があるとき、どちらも失われない", async () => {
    installFakeClaude(
      `process.stderr.write("[claude-code:unrecognized_model] {}");\n` +
      `process.stdout.write("There's an issue with the selected model");\nprocess.exit(1);`
    );
    let caught = null;
    try { await runClaudeJson({ stdin: "hi", cwd: mkCwd() }); }
    catch (e) { caught = e; }
    assert.ok(caught, "失敗するはずが成功した");
    assert.ok(/unrecognized_model/.test(caught.message), "stderr 側が落ちている");
    assert.ok(/issue with the selected model/.test(caught.message), "stdout 側が落ちている");
  });

  // ── 何も出ないまま死ぬ場合、黙って空にせず「空だった」と言う ───────────────
  await t("両方とも空で終了したときは、空である事実がメッセージに出る", async () => {
    installFakeClaude(`process.exit(1);`);
    let caught = null;
    try { await runClaudeJson({ stdin: "hi", cwd: mkCwd() }); }
    catch (e) { caught = e; }
    assert.ok(caught, "失敗するはずが成功した");
    assert.ok(
      /空/.test(caught.message),
      `出力が無かったことが読み取れない: ${caught.message}`
    );
  });

  // ── 理由がJSONの末尾寄りにあっても切り落とさない ─────────────────────────
  // 実機(Windows)で発生: --output-format json の失敗エンベロープは、人間が読むべき result を
  // usage/session_id 等の機械向けフィールドの後ろに置く。頭から切り詰めると理由だけが落ちる。
  await t("失敗JSONのresultが末尾寄りにあっても、理由が表示される", async () => {
    const envelope = JSON.stringify({
      is_error: true, duration_api_ms: 0, num_turns: 1, stop_reason: "stop_sequence",
      session_id: "77700525-d27a-4461-91d8-da0c0c72fbf7", total_cost_usd: 0,
      usage: {
        input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        output_tokens: 0, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: "standard", cache_creation: { ephemeral_1h_input_tokens: 0 },
      },
      result: "MARKER_REASON_AT_TAIL",
    });
    // 前提の確認: この JSON は素朴に400文字で切ると理由へ到達しない（＝検査が意味を持つ形）
    assert.ok(
      !envelope.slice(0, 400).includes("MARKER_REASON_AT_TAIL"),
      "前提が崩れている: 400文字以内に理由が入ってしまい、この検査が何も守らない"
    );
    installFakeClaude(
      `process.stdout.write(${JSON.stringify(envelope)});\nprocess.exit(1);`
    );
    let caught = null;
    try { await runClaudeJson({ stdin: "hi", cwd: mkCwd() }); }
    catch (e) { caught = e; }
    assert.ok(caught, "失敗するはずが成功した");
    assert.ok(
      caught.message.includes("MARKER_REASON_AT_TAIL"),
      `末尾のresultが切り落とされている: ${caught.message}`
    );
  });

  await t("summarizeStdoutFailure: JSONでない出力はそのまま見せる(フォールバック)", async () => {
    assert.ok(summarizeStdoutFailure("plain text failure").includes("plain text failure"));
    assert.strictEqual(summarizeStdoutFailure(""), "");
    assert.strictEqual(summarizeStdoutFailure(null), "");
    // 既知フィールドが無いJSONは生のまま（黙って空にしない）
    assert.ok(summarizeStdoutFailure('{"unknown":1}').includes("unknown"));
  });

  // ── 対照: 成功時はエラーにせず、ちゃんと結果を返す(検出力の裏付け) ──────────
  await t("対照: 正常終了したときは失敗扱いにならず結果が返る", async () => {
    installFakeClaude(
      `process.stdout.write(JSON.stringify({result:"PONG"}));\nprocess.exit(0);`
    );
    const out = await runClaudeJson({ stdin: "hi", cwd: mkCwd() });
    assert.strictEqual(out, "PONG", `正常時の戻り値が違う: ${out}`);
  });
} finally {
  process.env.PATH = savedPath;
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
