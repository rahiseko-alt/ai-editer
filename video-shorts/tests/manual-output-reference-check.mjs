// AUD-P1-07b: 公開マニュアルが、実際に配布されているファイル・命名規則を案内することの検証。
// 実行: node tests/manual-output-reference-check.mjs
//
// 修正前は install/user-manual.html が「ui/index.html を開いて…」と、配布物に含まれない
// (build-dist.mjs の allowlist に無い)ファイルを開くよう案内していた。修正後はマニュアルの
// 案内先を実在する output/<作業フォルダ>/short-*.mp4・candidates.json へ書き換えている。
//
// このテストは (1) 配布distに ui/index.html が実在しないこと、(2) マニュアル本文が
// ui/index.html を案内していないこと、(3) マニュアルが実際の命名規則(src/render-vertical.mjs
// の clipName() が実際に生成するファイル名パターン)を正しく案内していること、をハードコードの
// 文字列比較ではなく実装コード(clipName)から動的に導出して突き合わせる(ドキュメントと実装が
// 将来ズレても検出できるようにするため)。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { clipName } from "../src/render-vertical.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, "..");
const DIST = path.join(PKG, "..", "dist");

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? `\n      ${detail}` : ""}`); }
}

execFileSync("node", [path.join(PKG, "build-dist.mjs")], { stdio: "ignore" });
const distRoot = path.join(DIST, "ai-editer-video-shorts");

report(
  "配布distに ui/index.html が実在しない(=マニュアルが指せば必ず開けないファイルであることの裏付け)",
  !fs.existsSync(path.join(distRoot, "ui", "index.html")),
  `path=${path.join(distRoot, "ui", "index.html")}`,
);

const manualPath = path.join(PKG, "install", "user-manual.html");
const manual = fs.readFileSync(manualPath, "utf-8");

report(
  "user-manual.html が ui/index.html を一切案内していない",
  !manual.includes("ui/index.html"),
  "manual に 'ui/index.html' の文字列が見つかった",
);

// clipName() が実際に生成するファイル名から、マニュアルが案内すべき接頭辞パターンを動的に導出する
// (「short-」「01」ゼロ埋め2桁 等をこのテストにハードコードせず、実装から取り出す)。
const sampleName = path.basename(clipName("/tmp", 0, "テスト"));
const prefixMatch = sampleName.match(/^([a-zA-Z]+-)\d+/);
if (!prefixMatch) {
  report("clipName() の命名規則からファイル名接頭辞を抽出できる", false, `sampleName=${sampleName}`);
} else {
  const prefix = prefixMatch[1]; // 例: "short-"
  report(
    `マニュアルが実装の命名規則(接頭辞 "${prefix}...") を案内している`,
    manual.includes(prefix),
    `prefix=${prefix} がmanual本文に見つからない`,
  );
}

report(
  "マニュアルが候補一覧ファイル(candidates.json)の場所を案内している",
  manual.includes("candidates.json"),
  "manual に 'candidates.json' の文字列が見つからない",
);

report(
  "マニュアルが実際の出力先ディレクトリ名(output/)を案内している",
  manual.includes("output/"),
  "manual に 'output/' の文字列が見つからない",
);

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
