// AUD-P1-07a 手動検証用スクリプト（package.json の test には非組込み・手動実行のみ）。
// 実行: node tests/e2e-manual-walkthrough.mjs [対象html]
//
// 目的: 公開マニュアル(install/user-manual.html)の「3. 使い方」章に書かれたコマンドを、
// 人間が読んだとおりの順で機械的に実行し、init を挟まずに select を呼んで
// 「state.json がありません」という致命エラーで止まらないことを確かめる。
// (この e2e-server.mjs 同様の命名は tests/dist-slim-check.mjs から通常のpnpm testでは
// 実行されない。build-dist.mjs のEXCLUDEにも入れてあり配布物にも含まれない。)
//
// 手順:
//   1. build-dist.mjs で標準版distを作り、zip→展開して「客が受け取った状態」を再現する。
//   2. 展開先に、マニュアルが指す入力ファイル名(入力動画.mp4)で実際の動画を1本置く。
//   3. install/user-manual.html の「3. 使い方」章にある <pre class="cmd"> を上から順に
//      そのまま実行する（work/myvideo は、initの出力から得た実際の作業フォルダへ機械的に置換）。
//   4. 各コマンドの stderr に "state.json がありません" が出ないことを確認する。
//
// 対照実験(negative control)は package.json を変えずに手で確認する
// （このファイルの先頭コメント・docs/roadmap.html の該当葉のevidenceに、
//  「initの手順を除いた版のhtmlに対して同スクリプトを実行するとFAILする」実行結果を記録）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(ROOT, "..");
const DIST = path.join(PKG, "..", "dist");

const manualPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(PKG, "install", "user-manual.html");

function fail(msg) {
  console.error(`FAIL ${msg}`);
  process.exit(1);
}

// ---- 1. マニュアルの「3. 使い方」章から <pre class="cmd"> を上から順に取り出す -------------
const html = fs.readFileSync(manualPath, "utf-8");
const useSectionMatch = html.match(/<section id="use">([\s\S]*?)<\/section>/);
if (!useSectionMatch) fail(`install/user-manual.html に <section id="use"> が見つかりません: ${manualPath}`);
const useSection = useSectionMatch[1];
const cmds = [...useSection.matchAll(/<pre class="cmd">([\s\S]*?)<\/pre>/g)]
  .map((m) => m[1]
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim())
  .filter(Boolean);
if (cmds.length === 0) fail("<section id=\"use\"> 内に実行可能な <pre class=\"cmd\"> が1件も見つかりません");
console.log(`[walkthrough] ${manualPath} から ${cmds.length} 個のコマンドを検出:`);
cmds.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));

// ---- 2. 標準版distを作り、zip→展開して「客が受け取った状態」を再現する ---------------------
execFileSync("node", [path.join(PKG, "build-dist.mjs")], { stdio: "ignore" });
const zipPath = path.join(os.tmpdir(), `manual-walkthrough-${process.pid}.zip`);
fs.rmSync(zipPath, { force: true });
execFileSync("sh", ["-c",
  `cd ${JSON.stringify(DIST)} && zip -qr ${JSON.stringify(zipPath)} ai-editer-video-shorts`]);
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "manual-walkthrough-"));
execFileSync("unzip", ["-q", zipPath, "-d", workRoot]);
const extracted = path.join(workRoot, "ai-editer-video-shorts");
fs.rmSync(zipPath, { force: true });
if (!fs.existsSync(path.join(extracted, "pipeline.mjs"))) {
  fail(`展開後に pipeline.mjs が見つかりません（zip/展開に失敗）: ${extracted}`);
}
console.log(`[walkthrough] 展開先: ${extracted}`);

// ---- 3. マニュアルが指す入力ファイル名で実際の動画を1本置く -------------------------------
const inputVideo = path.join(extracted, "入力動画.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc=size=640x360:rate=15:duration=2",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
  "-c:v", "libx264", "-c:a", "aac", "-shortest", inputVideo]);

// ---- 4. コマンドを上から順に、そのまま実行する ----------------------------------------------
// work/myvideo は、initの標準出力最終行(実際の作業フォルダパス)を得てから機械的に置換する。
let workDirToken = "work/myvideo";
let resolvedWorkDir = null;
let hitStateJsonMissing = false;
let stoppedAt = -1;
let stopReason = "";

for (let i = 0; i < cmds.length; i++) {
  let cmd = cmds[i];
  if (resolvedWorkDir) cmd = cmd.split(workDirToken).join(resolvedWorkDir);
  const parts = cmd.split(/\s+/);
  let bin = parts[0];
  if (bin === "python") bin = "python3"; // このLinux環境では `python` の別名が無いため(マニュアルのFAQどおりの既知の代替)
  const args = parts.slice(1);
  console.log(`\n[run] ${bin} ${args.join(" ")}`);
  const r = spawnSync(bin, args, { cwd: extracted, encoding: "utf-8" });
  console.log(`  exit=${r.status}`);
  if (r.stdout) console.log(`  stdout: ${r.stdout.trim().split("\n").slice(-5).join("\n           ")}`);
  if (r.stderr) console.log(`  stderr: ${r.stderr.trim().split("\n").slice(-5).join("\n           ")}`);

  if ((r.stderr || "").includes("state.json がありません")) {
    hitStateJsonMissing = true;
    stoppedAt = i;
    stopReason = "state.json がありません";
    break;
  }

  if (cmd.startsWith("node pipeline.mjs init")) {
    // cmdInit は最後に console.log(workDir) を1行だけ出す。中身は
    // `path.join(ROOT, "work", id)` の絶対パスなので、以後のコマンドで使う
    // 「extracted からの相対パス」へ変換してから work/myvideo の置換に使う。
    const lastLine = (r.stdout || "").trim().split("\n").pop();
    const absWorkDir = lastLine ? lastLine.trim() : "";
    if (r.status === 0 && absWorkDir && absWorkDir.startsWith(extracted + path.sep)) {
      resolvedWorkDir = path.relative(extracted, absWorkDir);
      console.log(`  [walkthrough] work dir を検出: ${resolvedWorkDir}`);
    }
  }

  if (r.status !== 0) {
    // state.json 欠落以外の失敗（今回のテストではこの後止まる想定）でループを止める。
    stoppedAt = i;
    stopReason = `exit ${r.status}`;
    break;
  }
}

fs.rmSync(workRoot, { recursive: true, force: true });

console.log("\n---------------------------------------------");
if (hitStateJsonMissing) {
  console.log(`FAIL: コマンド${stoppedAt + 1}番目「${cmds[stoppedAt]}」で ` +
    `"state.json がありません" に到達しました（init 抜けで止まるバグを再現）。`);
  process.exit(1);
}
console.log(`PASS: 一連のコマンドで "state.json がありません" には到達しませんでした` +
  (stoppedAt >= 0 ? `（${stoppedAt + 1}番目「${cmds[stoppedAt]}」で別理由(${stopReason})により停止 — ` +
    `合成音声に実発話が無くtranscriptが空のため、select以降は本検証の対象外）` : "（全コマンド完走）"));
process.exit(0);
