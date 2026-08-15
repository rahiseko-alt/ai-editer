// 本物の claude コマンドに対する疎通検査（偽物へ差し替えない唯一のテスト）。
//
// 【なぜ要るか】tests/ 配下の claude 関連テストは helpers/fake-claude-main.mjs の
// installFakeClaude() で PATH へ偽物を差し込んで実行しており、「本物の claude が、
// このプロジェクトの起動方法（-p --strict-mcp-config --output-format json --tools "" /
// buildSafeEnv() の制限環境 / createIsolatedCwd() の隔離 cwd）で実際に動くか」を
// 検証しているテストが1本も無かった。引数の綴りが等しいことを assert する同語反復や
// ソース文字列の正規表現マッチでは、本物の CLI が受け付けない引数・認証が通らない env
// といった実害（Windows 実機で発生）を検出できない。ここは本物だけを相手にする。
//
// 【CI に登録していない理由】CI ランナーには本物の claude（および OAuth ログイン状態）が
// 無いため、pnpm test のチェーンに入れると常に赤になる。よって package.json の test には
// 登録せず、開発者が手元で実行する検査として置く。
//
// 実行: node tests/claude-run-real-check.mjs   （video-shorts ディレクトリで実行）
//
// claude が無い環境でも SKIP して exit 0 にはしない（AGENTS.md「検証の規律」＝道具が無いまま
// 緑を返すのは偽の緑）。理由を出して exit 1 する。

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runClaudeJson } from "../src/claude-run.mjs";
import { createIsolatedCwd, buildSafeEnv } from "../src/claude-safety.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");

// 本物の claude を叩くので、既定の 300s より短くはしない（ネットワーク往復＋モデル応答待ち）。
const TIMEOUT_MS = Number(process.env.REAL_CLAUDE_TIMEOUT_MS ?? 180_000);

// 疎通確認用の最小プロンプト。応答内容の品質は問わない（問うと本物のモデルの揺らぎで落ちる）。
const PING_PROMPT = "PONGとだけ返してください。他の文字は一切出力しないでください。";

// src/digest-editor.mjs が --model に渡す既定モデル。ハードコードした値がソースとズレたら
// 気付けるよう、下の t() で digest-editor.mjs から読み出した値との一致も検査する。
const EXPECTED_DIGEST_MODEL = "claude-opus-4-8";

/** src/digest-editor.mjs から `process.env.DIGEST_MODEL ?? "<既定>"` の既定値を読み出す。 */
function readDigestModelDefault() {
  const src = fs.readFileSync(path.join(SRC, "digest-editor.mjs"), "utf-8");
  const m = src.match(/process\.env\.DIGEST_MODEL\s*\?\?\s*"([^"]+)"/);
  assert.ok(m, "src/digest-editor.mjs から DIGEST_MODEL の既定値を読み取れませんでした");
  return m[1];
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.stack || e.message}`); }
}

/**
 * 子プロセスが実際に受け取る PATH（buildSafeEnv() の出力）の上で claude の実体を探す。
 *
 * ここで子プロセスを起こして版を問い合わせないのは、
 * tests/ai-caption-fix-check.mjs（葉E）が「claude を起こせる箇所は src/claude-run.mjs の
 * ちょうど1箇所」を機械で見張っているため。この検査ファイルが自前で claude を起こすと
 * 守り（ツール無効化 / env allowlist / 隔離 cwd）を迂回できる2つ目の起動口になってしまう。
 * 起動は必ず共通口 runClaudeJson 経由に限り、ここでは実体の有無だけをファイル系で確かめる。
 */
function findClaudeOnPath() {
  const pathValue = buildSafeEnv().PATH ?? "";
  const exts = os.platform() === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [];
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const name of ["claude", ...exts.map((e) => `claude${e.toLowerCase()}`)]) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* 次の候補へ */ }
    }
  }
  return null;
}

// --- 前提: 本物の claude が居ること（居なければ SKIP せず落とす） ---
const claudeBin = findClaudeOnPath();
if (!claudeBin) {
  console.log(
    "FAIL 本物の claude コマンドが見つからないため、この検査は成立しません。\n" +
    "      これは偽物へ差し替えずに本物の claude を叩く検査です。SKIP して緑を返すことは\n" +
    "      AGENTS.md「検証の規律」で禁止されているため exit 1 します。\n" +
    "      （CI には本物の claude が無いので、この検査は pnpm test のチェーンに登録していません。\n" +
    "        手元で実行してください: node tests/claude-run-real-check.mjs）\n" +
    `      探した PATH（buildSafeEnv() が子へ渡すもの）: ${buildSafeEnv().PATH ?? "(未設定)"}`
  );
  process.exit(1);
}
console.log(`[env] 本物の claude: ${claudeBin}`);

const cwds = [];
/** ジョブ専用の隔離 cwd を作る（後始末は finally でまとめて削除）。 */
function isolated(tag) {
  const dir = createIsolatedCwd(`realcheck-${tag}`);
  cwds.push(dir);
  return dir;
}

try {
  // 1) 本番と同じ経路（プロジェクト本来の引数 + 隔離 cwd + 制限環境）で本物の claude と疎通する。
  await t("本物のclaudeが、本番と同じ引数(-p --strict-mcp-config --output-format json --tools \"\")と隔離cwdで応答を返す", async () => {
    const result = await runClaudeJson({
      stdin: PING_PROMPT,
      cwd: isolated("plain"),
      timeoutMs: TIMEOUT_MS,
    });
    assert.strictEqual(typeof result, "string", `応答が文字列ではありません: ${typeof result}`);
    assert.ok(result.trim().length > 0, "応答が空文字列です（疎通していない疑い）");
  });

  // 4) 制限環境の妥当性。buildSafeEnv() の allowlist だけで本物の claude が認証を通せるか。
  //    「1) が通れば実質確認できる」が、意図を独立の検査名として明示しておく
  //    （allowlist から HOME 等を落としたときに、何が壊れたのかが名前で分かるようにする）。
  await t("buildSafeEnv()のallowlistだけで本物のclaudeが認証を通せる（Not logged in にならない）", async () => {
    const safeEnv = buildSafeEnv();
    // 秘密情報を渡していないこと（サブスク継承のみ）を、実際に叩く env について確認する。
    assert.ok(!("ANTHROPIC_API_KEY" in safeEnv), "buildSafeEnv() に ANTHROPIC_API_KEY が混ざっています");
    const result = await runClaudeJson({
      stdin: PING_PROMPT,
      cwd: isolated("auth"),
      timeoutMs: TIMEOUT_MS,
    });
    assert.ok(
      !/not logged in|invalid api key|authentication|credit balance/i.test(result),
      `認証エラーらしき応答が返りました: ${result.slice(0, 200)}`
    );
    assert.ok(result.trim().length > 0, "応答が空文字列です");
  });

  // 2) src/digest-editor.mjs が使う --model 付きの経路も、本物の claude で通ること。
  await t("ハードコードした既定モデル名が src/digest-editor.mjs の既定値と一致している", async () => {
    assert.strictEqual(
      readDigestModelDefault(),
      EXPECTED_DIGEST_MODEL,
      "digest-editor.mjs の既定モデルが変わっています。この検査の EXPECTED_DIGEST_MODEL も追随させてください"
    );
  });

  await t(`本物のclaudeが extraArgs:["--model", "${EXPECTED_DIGEST_MODEL}"]（digest-editorと同じ経路）でも応答を返す`, async () => {
    const model = process.env.DIGEST_MODEL ?? EXPECTED_DIGEST_MODEL;
    const result = await runClaudeJson({
      stdin: PING_PROMPT,
      cwd: isolated("model"),
      timeoutMs: TIMEOUT_MS,
      extraArgs: ["--model", model],
    });
    assert.strictEqual(typeof result, "string", `応答が文字列ではありません: ${typeof result}`);
    assert.ok(result.trim().length > 0, "応答が空文字列です（--model 付きで疎通していない疑い）");
  });

  // 3) 対照（検出力の裏付け）。上の疎通検査が「何を渡しても通るだけの検査」でないことを示す。
  //    本物の claude が受け付けない引数を渡したとき、runClaudeJson が実際に失敗（reject）すること。
  await t("対照: 本物のclaudeが受け付けない引数を渡すと runClaudeJson が実際に失敗する（疎通検査の検出力の裏付け）", async () => {
    const bogus = "--bogus-flag-that-does-not-exist";
    let thrown = null;
    try {
      await runClaudeJson({
        stdin: PING_PROMPT,
        cwd: isolated("bogus"),
        timeoutMs: TIMEOUT_MS,
        extraArgs: [bogus],
      });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, `無効な引数 ${bogus} を渡したのに runClaudeJson が成功しました（＝疎通検査に検出力が無い）`);
    // 「失敗した」だけでなく「無効な引数が原因で失敗した」ことまで確認する
    // （タイムアウトや spawn 失敗で偶然落ちただけ、を通さない）。
    const detail = `${thrown.message}\n${thrown.stderr ?? ""}`;
    assert.ok(
      detail.includes(bogus),
      `失敗はしましたが、原因が無効な引数だと確認できません: ${detail.slice(0, 400)}`
    );
  });
} finally {
  for (const dir of cwds) fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
