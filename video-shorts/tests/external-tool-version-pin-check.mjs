// tests/external-tool-version-pin-check.mjs — P1-12-A の機械検証。
//
// 【何の穴を塞ぐか】roadmap P1-12-A「uvx/npx 等の可変依存呼び出しをバージョン/hash固定する」。
// 対処済みと主張している4箇所の実物ファイルを直接読み、以下を確認する:
//   (a) video-shorts/requirements.txt の faster-whisper/groq/opencv-python-headless が
//       `==` による厳密固定になっている(`>=` 等の下限のみ・無指定を許さない)。
//   (b) .github/workflows/ci.yml の apt-get install で ffmpeg/zip が `パッケージ名=版` の
//       形で固定されている(無指定の `ffmpeg` 単体トークンを許さない)。
//   (c) .github/workflows/measure-leak-rate.yml の apt-get install でも同様に ffmpeg が固定。
//   (d) .claude/hooks/session-start.sh の FFMPEG_PIN が具体的な版文字列(数字を含む)に
//       設定され、実際に `apt-get install` へその変数が渡っている。
//   (e) video-shorts 配下(node_modules除く)に `uvx `/`npx ` の無指定呼び出しが残っていない
//       (今回の対処範囲=video-shorts。docs/setup-runbook.md の kosespark Writer 向け記述は
//       roadmap detail が明記するとおり対象外)。
//
// 「無いことの確認」には対照実験が要る(AGENTS.md 検証の規律)。(a)(b)(e) は、検知に使う
// 正規表現自身を「わざと無指定にした文字列」に対して先に走らせ、無指定を検知できることを
// 確認してから、実物ファイルに対して「無指定が無い」ことを確認する2段構成にする。
//
// 実行: node tests/external-tool-version-pin-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(path.dirname(HERE)); // video-shorts/tests -> ai-editer root
const VIDEO_SHORTS_ROOT = path.dirname(HERE); // video-shorts/tests -> video-shorts

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

function readRepoFile(relPath) {
  const p = path.join(REPO_ROOT, relPath);
  assert.ok(fs.existsSync(p), `ファイルが見つかりません: ${p}`);
  return fs.readFileSync(p, "utf8");
}

// ---- (a) requirements.txt: faster-whisper / groq / opencv-python-headless が == 固定 ----
{
  const text = readRepoFile("video-shorts/requirements.txt");
  const targets = ["faster-whisper", "groq", "opencv-python-headless"];
  for (const pkg of targets) {
    const lineMatch = text.match(new RegExp(`^${pkg}\\S*$`, "m"));
    report(`P1-12-A: requirements.txtに${pkg}の行がある`, !!lineMatch, `見つからない: ${pkg}`);
    if (lineMatch) {
      const line = lineMatch[0];
      const pinned = new RegExp(`^${pkg}==\\S+$`).test(line);
      report(`P1-12-A: ${pkg} が==で厳密固定されている(実=${line})`, pinned);
      // 対照: 無指定(>=・上限なし)の形は「固定されている」と誤判定しないことを確認する。
      const unpinnedSample = `${pkg}>=1.0.0`;
      const unpinnedWronglyPassed = new RegExp(`^${pkg}==\\S+$`).test(unpinnedSample);
      report(`P1-12-A: 対照 - ${pkg}>=1.0.0 のような無指定は固定判定にならない`, !unpinnedWronglyPassed);
    }
  }
}

// ---- (b) .github/workflows/ 配下の全 *.yml / *.yaml を再帰的に検査し、apt/pip の
// 無指定インストールが無いことを確認する ----
//
// 【AUD-P2-19で塞ぐ穴】旧実装(P1-12-A)は ci.yml と measure-leak-rate.yml だけを
// ハードコードでスキャンしていたため、それ以外の workflow (roadmap-required.yml 等)に
// 無指定の apt install があってもこのチェックの視界に入らず、素通りしていた
// (docs/audits/adversarial-review-2026-08-13.md AUD-P2-19)。
// 対処: ハードコードのファイル一覧をやめ、.github/workflows/ 配下の *.yml / *.yaml を
// 再帰的に列挙して全ファイルを検査する。
{
  const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

  function listWorkflowFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...listWorkflowFiles(full));
      } else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  // apt-get/apt の install 行から、無指定(バージョン未固定)のパッケージトークンを拾う。
  // remove/update/upgrade は対象外(パッケージを新規に持ち込まないため版固定は不要)。
  function findUnpinnedAptInstalls(text) {
    const hits = [];
    const re = /^[ \t]*(?:sudo\s+)?apt(?:-get)?\s+(install|remove|update|upgrade)\b(.*)$/gm;
    let m;
    while ((m = re.exec(text))) {
      const [line, action, rest] = m;
      if (action !== "install") continue;
      for (const tok of rest.trim().split(/\s+/).filter(Boolean)) {
        if (tok.startsWith("-")) continue; // フラグ(-y, -qq 等)
        if (tok.includes("=")) continue; // パッケージ=版 で固定済み
        hits.push(`${tok} (行: ${line.trim()})`);
      }
    }
    return hits;
  }

  // pip install 行から、無指定のパッケージトークンを拾う。"$spec" のような変数経由の
  // インストールは、その変数を requirements.txt から `==` 付きで抜き出す前提(上の(a)で
  // requirements.txt 側を検査済み)のため対象外とする。
  function findUnpinnedPipInstalls(text) {
    const hits = [];
    const re = /^[ \t]*(?:python3?\s+-m\s+)?pip3?\s+install\b(.*)$/gm;
    let m;
    while ((m = re.exec(text))) {
      const [line, rest] = m;
      for (const tok of rest.trim().split(/\s+/).filter(Boolean)) {
        if (tok.startsWith("-")) continue; // フラグ(-r 等)
        if (/^["']?\$/.test(tok)) continue; // 変数参照(例: "$spec")
        if (tok.includes("==")) continue; // パッケージ==版 で固定済み
        hits.push(`${tok} (行: ${line.trim()})`);
      }
    }
    return hits;
  }

  const files = listWorkflowFiles(WORKFLOWS_DIR);
  report(
    "P2-19: .github/workflows/ 配下の再帰列挙が.ymlファイルを検出できている(対照)",
    files.length > 0,
    `files=${files.length}`,
  );

  // 対照: 検知に使う正規表現自身が「わざと無指定にした文字列」を検知できることを先に確認する
  // (AGENTS.md 検証の規律「無いことの確認には対照実験が要る」)。
  report(
    "P2-19: 対照 - apt無指定検知の正規表現は無指定サンプル(apt-get install ffmpeg)を検知できる",
    findUnpinnedAptInstalls("sudo apt-get install -y -qq ffmpeg").length > 0,
  );
  report(
    "P2-19: 対照 - apt無指定検知の正規表現は版固定済みサンプルを誤検知しない",
    findUnpinnedAptInstalls("sudo apt-get install -y -qq ffmpeg=7:6.1.1-3ubuntu5").length === 0,
  );
  report(
    "P2-19: 対照 - apt remove/update は無指定でも検知対象にならない(パッケージを新規導入しないため)",
    findUnpinnedAptInstalls("sudo apt-get remove -y ffmpeg\nsudo apt-get update -qq").length === 0,
  );
  report(
    "P2-19: 対照 - pip無指定検知の正規表現は無指定サンプル(pip install foo)を検知できる",
    findUnpinnedPipInstalls("python -m pip install foo").length > 0,
  );
  report(
    "P2-19: 対照 - pip無指定検知の正規表現は変数経由(\"$spec\")のインストールを誤検知しない",
    findUnpinnedPipInstalls('python -m pip install "$spec"').length === 0,
  );

  const allUnpinned = [];
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const text = fs.readFileSync(file, "utf8");
    for (const hit of findUnpinnedAptInstalls(text)) allUnpinned.push(`${rel}: apt ${hit}`);
    for (const hit of findUnpinnedPipInstalls(text)) allUnpinned.push(`${rel}: pip ${hit}`);
  }
  report(
    `P2-19: .github/workflows/ 配下(${files.length}ファイル)に無指定のapt/pipインストールが残っていない(実=${allUnpinned.length}件)`,
    allUnpinned.length === 0,
    allUnpinned.join(" | "),
  );
}

// ---- (d) session-start.sh: FFMPEG_PIN が具体的な版で、実際に install へ渡っている ----
{
  const text = readRepoFile(".claude/hooks/session-start.sh");
  const pinMatch = text.match(/FFMPEG_PIN="([^"]+)"/);
  report("P1-12-A: session-start.shにFFMPEG_PINの定義がある", !!pinMatch);
  if (pinMatch) {
    const value = pinMatch[1];
    const looksLikeVersion = /\d/.test(value) && value.length > 0;
    report(`P1-12-A: FFMPEG_PINが具体的な版文字列(実=${value})`, looksLikeVersion);
  }
  const usesVar = /ffmpeg=\$\{FFMPEG_PIN\}/.test(text);
  report("P1-12-A: apt-get installがFFMPEG_PIN変数を実際に使っている", usesVar);
}

// ---- (e) video-shorts配下(node_modules除く)にuvx/npxの無指定呼び出しが残っていない ----
{
  const unpinnedCallRe = /\b(uvx|npx)\s+(?!--)[^\s@][^\n]*/g;
  // 対照: この正規表現自身が、意図的に無指定にしたサンプル行を検知できることを先に確認する。
  const sample = "実行コマンド: npx marp --version";
  const sampleMatches = [...sample.matchAll(unpinnedCallRe)];
  report(
    "P1-12-A: 対照 - 検知用の正規表現は無指定のnpx呼び出しサンプルを検知できる",
    sampleMatches.length > 0,
  );

  /** @type {string[]} */
  const hits = [];
  // git管理下のファイルだけを対象にする(build-dist.mjsのgitTrackedFiles()と同じ考え方)。
  // 以前はファイルシステムを再帰列挙していたため、.gitignore対象の生成物(output/・work/配下の
  // 実素材mp4等)まで拾ってしまい、mp4バイナリ中の偶然のバイト列("uvx"に一致)を無指定呼び出しと
  // 誤検知していた(docs/failures.md 2026-08-14)。git ls-filesはgitignore対象を列挙に含めない
  // ため、生成物を都度削除しなくても構造的に誤検知し得なくなる。
  let trackedFiles;
  try {
    trackedFiles = execFileSync("git", ["ls-files", "-z"], { cwd: VIDEO_SHORTS_ROOT })
      .toString("utf-8").split("\0").filter(Boolean);
  } catch (e) {
    throw new Error(`git ls-files に失敗しました。この検査はgit管理下のチェックアウトが前提です: ${e.message}`);
  }
  for (const rel of trackedFiles) {
    const segments = rel.split("/");
    if (segments.some((seg) => seg === "node_modules" || seg.startsWith(".git"))) continue;
    const full = path.join(VIDEO_SHORTS_ROOT, rel);
    // このチェックスクリプト自身のサンプル文字列を誤検知しないよう除外する。
    if (full === path.join(HERE, "external-tool-version-pin-check.mjs")) continue;
    let content;
    try {
      content = fs.readFileSync(full, "utf8");
    } catch {
      continue; // 削除済みだが未commit等でworking treeに無い、またはバイナリ等は読めなくてよい。
    }
    const matches = [...content.matchAll(unpinnedCallRe)];
    for (const m of matches) hits.push(`${path.relative(REPO_ROOT, full)}: ${m[0].trim()}`);
  }
  report(
    `P1-12-A: video-shorts配下にuvx/npxの無指定呼び出しが残っていない(実=${hits.length}件)`,
    hits.length === 0,
    hits.join(" | "),
  );
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
if (fail > 0) process.exit(1);
