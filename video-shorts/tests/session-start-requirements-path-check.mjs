// AUD-P2-17b: 配布物に含まれた .claude/hooks/session-start.sh が、配布された配置
// (video-shorts/という階層が無い、requirements.txtがルート直下に平坦化されたdistレイアウト)
// のままで実際にrequirements.txtを解決できることの検証。
// 実行: node tests/session-start-requirements-path-check.mjs
//
// 修正前: REQUIREMENTS_TXT は "$REPO_ROOT/video-shorts/requirements.txt" 固定だった。これは
// フルチェックアウト(video-shorts/がサブディレクトリ)では正しいが、build-dist.mjsが生成する
// 配布物(dist/ai-editer-video-shorts)ではvideo-shorts/という階層自体が無く、requirements.txtは
// distのルート直下に平坦化されているため見つからず pip install が失敗する。
// 修正後: $REPO_ROOT/video-shorts/requirements.txt → 無ければ $REPO_ROOT/requirements.txt の
// 順に実在確認するようにした。
//
// このテストは実際にネットワーク経由のpip installは行わない(重い・ネットワーク依存のため)。
// 代わりに python3/ffmpeg を身代わり実行ファイルへ差し替え、フック自身が「pipインストール」の
// 段階でどの requirements.txt パスを渡そうとしたか(身代わりpython3がそのまま標準出力へ書く)を
// 実際に実行して確認する(=経路選択ロジックそのものを実行させて検証する。ロジックを読むだけの
// 静的検査ではない)。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.dirname(HERE); // video-shorts/
const REPO_ROOT = path.dirname(PKG_ROOT); // ai-editer/
const HOOK = path.join(REPO_ROOT, ".claude", "hooks", "session-start.sh");

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? `\n      ${detail}` : ""}`); }
}

/** python3/ffmpeg の身代わりをPATHへ差し込み、フックを実行して結果を返す。 */
function runHookAgainst(projectDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "session-start-fake-bin-"));
  const marker = path.join(tmp, "resolved-requirements.txt");

  // ffmpeg: 「導入済み」に見せかけるだけの空実行ファイル(command -v ffmpeg が成功すればよい)。
  fs.writeFileSync(path.join(tmp, "ffmpeg"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(tmp, "ffmpeg"), 0o755);

  // python3: 1回目の `-c "import faster_whisper, groq"` は「未導入」に見せかけexit 1、
  // `-m pip install ... -r <path>` が来たら実際のpip installは行わず、渡された
  // requirements.txtパスをファイルへ書き出してexit 0(=経路選択の結果だけを取り出す)。
  fs.writeFileSync(path.join(tmp, "python3"),
    `#!/bin/bash\n` +
    `if [ "$1" = "-c" ]; then exit 1; fi\n` +
    `if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then\n` +
    `  for a in "$@"; do :; done\n` +
    `  echo "$@" > ${JSON.stringify(marker)}.args\n` +
    `  # 最後の引数(-r の次)がrequirements.txtパス\n` +
    `  prev=""\n` +
    `  for a in "$@"; do\n` +
    `    if [ "$prev" = "-r" ]; then echo "$a" > ${JSON.stringify(marker)}; fi\n` +
    `    prev="$a"\n` +
    `  done\n` +
    `  exit 0\n` +
    `fi\n` +
    `exit 1\n`);
  fs.chmodSync(path.join(tmp, "python3"), 0o755);

  const env = {
    ...process.env,
    CLAUDE_CODE_REMOTE: "true",
    CLAUDE_PROJECT_DIR: projectDir,
    PATH: `${tmp}:${process.env.PATH}`,
  };
  const r = spawnSync("bash", [HOOK], { env, encoding: "utf-8" });
  let resolvedPath = null;
  if (fs.existsSync(marker)) resolvedPath = fs.readFileSync(marker, "utf-8").trim();
  fs.rmSync(tmp, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, resolvedPath };
}

// ── (1) フルチェックアウト相当: requirements.txt が <root>/video-shorts/ 配下 ──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-start-fullcheckout-"));
  fs.mkdirSync(path.join(root, "video-shorts"), { recursive: true });
  const reqPath = path.join(root, "video-shorts", "requirements.txt");
  fs.writeFileSync(reqPath, "faster-whisper\ngroq\n");

  const result = runHookAgainst(root);
  report(
    "フルチェックアウト配置(video-shorts/requirements.txt)でフックが正常終了する",
    result.status === 0,
    `status=${result.status} stderr=${result.stderr}`,
  );
  report(
    "フルチェックアウト配置で、実際に video-shorts/requirements.txt を pip install に渡している",
    result.resolvedPath === reqPath,
    `resolvedPath=${result.resolvedPath} 期待=${reqPath}`,
  );
  fs.rmSync(root, { recursive: true, force: true });
}

// ── (2) 配布物(dist)相当: video-shorts/という階層が無く、requirements.txtがルート直下 ──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-start-dist-flat-"));
  const reqPath = path.join(root, "requirements.txt");
  fs.writeFileSync(reqPath, "faster-whisper\ngroq\n");
  // video-shorts/ ディレクトリ自体を作らない(distの平坦化レイアウトを再現)。

  const result = runHookAgainst(root);
  report(
    "配布物の平坦化配置(ルート直下のrequirements.txt)でフックが正常終了する(修正前はここでENOENT相当のエラーになっていた)",
    result.status === 0,
    `status=${result.status} stderr=${result.stderr}`,
  );
  report(
    "配布物の平坦化配置で、実際にルート直下の requirements.txt を pip install に渡している",
    result.resolvedPath === reqPath,
    `resolvedPath=${result.resolvedPath} 期待=${reqPath}`,
  );
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 対照: どちらの場所にも requirements.txt が無ければ、明確なエラーで exit 1 する ──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-start-missing-"));
  const result = runHookAgainst(root);
  report(
    "対照: requirements.txt がどこにも無い場合はフックがexit 1で明確に失敗する(黙って通らない)",
    result.status === 1 && (result.stderr || "").includes("requirements.txt が見つかりません"),
    `status=${result.status} stderr=${result.stderr}`,
  );
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
