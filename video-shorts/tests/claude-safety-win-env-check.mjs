// claude -p へ渡す環境変数の allowlist が、Windows で子プロセスを成立させられるかの機械検査。
//
// 【なぜ要るか】2026-08-15、実機(Windows/PowerShell)で画面から動画を作ると
// 「claude 終了コード 1。stderr: 」とだけ出て失敗した。原因は allowlist が POSIX 名だけで
// 構成されており、Windows で必須の変数(USERPROFILE / SystemRoot 等)が1つも入っていなかったこと。
// Windows の PowerShell は HOME を定義しない(定義するのは Git Bash 等 MSYS 系のみ)ため、
// allowlist を通過するホーム情報がゼロになり、さらに SystemRoot 不在は Winsock の
// プロバイダDLL読込を壊す(通信を伴うプロセスが理由も出せずに落ちる。golang/go#25513 が同型)。
//
// 【なぜソースの目視ではなく機械検査にするか】この欠陥は「Linuxでは全く再現しない」ため、
// CI(全ジョブ ubuntu)でも開発者の手元でも永久に気付けない。上流(Claude Code CLI)が必要な変数を
// 増やしたときに、こちらだけ古いまま取り残される事故も同型で起きる。対照表
// (WINDOWS_MINIMUM_ENV_VARS)との突き合わせを機械に見張らせ、Linux 上でも判定できるようにする。
//
// 実行: node tests/claude-safety-win-env-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import { ALLOWED_ENV_VARS, WINDOWS_MINIMUM_ENV_VARS, buildSafeEnv } from "../src/claude-safety.mjs";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.message}`); }
}

/** Windows の環境変数名は大文字小文字を区別しないので、比較は正規化して行う。 */
const upper = (arr) => arr.map((v) => v.toUpperCase());

t("allowlist は、Claude Code CLI が定める Windows 最小集合をすべて含む", () => {
  const have = upper(ALLOWED_ENV_VARS);
  const missing = WINDOWS_MINIMUM_ENV_VARS.filter((v) => !have.includes(v.toUpperCase()));
  assert.deepStrictEqual(
    missing, [],
    `Windows で必須の変数が allowlist に無い: ${missing.join(", ")}。` +
    `src/claude-safety.mjs の ALLOWED_ENV_VARS へ足すこと`
  );
});

t("Windows を模した環境で、ホームと通信に要る変数が実際に子プロセスへ渡る", () => {
  // Windows の PowerShell を模す＝HOME / USER / XDG_* / TMPDIR / LANG は存在しない。
  const winEnv = {
    PATH: "C:\\Windows\\system32",
    USERPROFILE: "C:\\Users\\user",
    SystemRoot: "C:\\Windows",
    SystemDrive: "C:",
    APPDATA: "C:\\Users\\user\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local",
    TEMP: "C:\\Users\\user\\AppData\\Local\\Temp",
    USERNAME: "user",
  };
  const safe = buildSafeEnv(winEnv);
  // ホームの解決(認証情報 %USERPROFILE%\.claude\.credentials.json への到達)に要る
  assert.strictEqual(safe.USERPROFILE, "C:\\Users\\user", "USERPROFILE が子プロセスへ渡っていない");
  // HTTPS 通信(Winsock のプロバイダDLL読込)に要る
  assert.strictEqual(safe.SystemRoot, "C:\\Windows", "SystemRoot が子プロセスへ渡っていない");
});

t("対照: Windows を模した環境でも、秘密情報は従来どおり遮断され続ける", () => {
  // 変数を足したことで秘密まで通るようになっていないことを、同じ経路で確かめる
  // （この検査が無いと「足しすぎて漏れる」方向の退行を見逃す）。
  const winEnv = {
    PATH: "C:\\Windows\\system32",
    USERPROFILE: "C:\\Users\\user",
    ANTHROPIC_API_KEY: "sk-MUST-NOT-PASS",
    GROQ_API_KEY: "gsk-MUST-NOT-PASS",
    DATABASE_URL: "postgres://user:pass@host/db",
    AWS_SECRET_ACCESS_KEY: "MUST-NOT-PASS",
  };
  const safe = buildSafeEnv(winEnv);
  for (const secret of ["ANTHROPIC_API_KEY", "GROQ_API_KEY", "DATABASE_URL", "AWS_SECRET_ACCESS_KEY"]) {
    assert.strictEqual(safe[secret], undefined, `${secret} が子プロセスへ漏れている`);
  }
  assert.ok(
    Object.keys(safe).every((k) => ALLOWED_ENV_VARS.includes(k)),
    "allowlist に無いキーが出力に混ざっている"
  );
});

t("対照: POSIX を模した環境では、従来どおりの変数が渡り続ける(Windows対応で壊していない)", () => {
  const posixEnv = { PATH: "/usr/bin", HOME: "/home/u", LANG: "ja_JP.UTF-8", USER: "u", ANTHROPIC_API_KEY: "sk-x" };
  const safe = buildSafeEnv(posixEnv);
  assert.strictEqual(safe.PATH, "/usr/bin");
  assert.strictEqual(safe.HOME, "/home/u");
  assert.strictEqual(safe.LANG, "ja_JP.UTF-8");
  assert.strictEqual(safe.USER, "u");
  assert.strictEqual(safe.ANTHROPIC_API_KEY, undefined);
  // Windows 用に足した名前は POSIX 環境には存在しないので、出力にも現れない（＝無害）。
  assert.strictEqual(safe.USERPROFILE, undefined);
  assert.strictEqual(safe.SystemRoot, undefined);
});

t("対照: この検査は実際に不足を検出できる(検出力の裏付け)", () => {
  // 「常に通るだけの検査」でないことを示す。allowlist から USERPROFILE を抜いた偽物を作り、
  // 1つ目の検査と同じ判定式に掛けて、実際に不足として検出されることを確かめる。
  const broken = ALLOWED_ENV_VARS.filter((v) => v.toUpperCase() !== "USERPROFILE");
  const have = upper(broken);
  const missing = WINDOWS_MINIMUM_ENV_VARS.filter((v) => !have.includes(v.toUpperCase()));
  assert.ok(missing.includes("USERPROFILE"), "USERPROFILE を抜いても不足として検出されない＝検査が働いていない");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
