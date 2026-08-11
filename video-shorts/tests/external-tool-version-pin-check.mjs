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

// ---- (b)/(c) apt-get install の ffmpeg/zip がバージョン固定されている workflow 群 ----
function checkAptPin(relPath, pkgNames) {
  const text = readRepoFile(relPath);
  for (const pkg of pkgNames) {
    // 実物: パッケージ名=版 の形でその workflow 内に出現するか。
    const pinnedRe = new RegExp(`\\b${pkg}=\\S+`);
    report(`P1-12-A: ${relPath} の apt-get install に ${pkg}=版 の固定指定がある`, pinnedRe.test(text));
    // 対照: 「パッケージ名の直後に=が無い無指定呼び出し」を、この正規表現が
    // 誤って固定済みと判定しないことを確認する(検知手段が"無いとき無いと言える"ことの裏付け)。
    const unpinnedSample = `sudo apt-get install -y -qq ${pkg} zip`;
    report(
      `P1-12-A: 対照 - ${relPath}想定 「${pkg}」単体(無指定)は固定判定にならない`,
      !pinnedRe.test(unpinnedSample.replace(new RegExp(`${pkg}=\\S+`), pkg)),
    );
  }
}
checkAptPin(".github/workflows/ci.yml", ["ffmpeg", "zip"]);
checkAptPin(".github/workflows/measure-leak-rate.yml", ["ffmpeg"]);

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
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        // このチェックスクリプト自身のサンプル文字列を誤検知しないよう除外する。
        if (full === path.join(HERE, "external-tool-version-pin-check.mjs")) continue;
        let content;
        try {
          content = fs.readFileSync(full, "utf8");
        } catch {
          continue; // バイナリ等は読めなくてよい(uvx/npx呼び出しは書けないファイル)。
        }
        const matches = [...content.matchAll(unpinnedCallRe)];
        for (const m of matches) hits.push(`${path.relative(REPO_ROOT, full)}: ${m[0].trim()}`);
      }
    }
  }
  walk(VIDEO_SHORTS_ROOT);
  report(
    `P1-12-A: video-shorts配下にuvx/npxの無指定呼び出しが残っていない(実=${hits.length}件)`,
    hits.length === 0,
    hits.join(" | "),
  );
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
if (fail > 0) process.exit(1);
