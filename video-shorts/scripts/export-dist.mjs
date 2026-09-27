// video-shorts scripts/export-dist.mjs — 他の人に渡す配布物（別リポジトリ）の中身を、このリポジトリから作る。
//
// 2026-09-27 マスター決定「デスクトップ版の Claude Code だけで完結する形にし、他人に渡してその人の PC で使えるようにする」
// 「配布用の別リポジトリ」「相手は Windows だけ」。
//
// 使い方: node video-shorts/scripts/export-dist.mjs <出力先フォルダ>
//   出力先の中身は、.git 以外をすべて消してから書き直す（配布リポジトリのクローンを出力先にする想定）。
//
// 何を入れるか:
//   - edit-job.mjs から import で辿れるファイルだけ（使わないファイルを配らない）
//   - 文字起こし（transcribe.py・transcribe_groq.py・term-corrections.json）、字幕用フォント、BudouX のライセンス
//   - 判断基準（虎の巻・合格条件）とスキル
//   - 配布物専用の CLAUDE.md・README.md・.gitignore（dist-template/ にある）
// マスター専用の規律（テンプレ運用・CI・failures.md 等）は入れない。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VS = path.resolve(__dirname, "..");
const ROOT = path.resolve(VS, "..");

const outArg = process.argv[2];
if (!outArg) {
  console.error("使い方: node video-shorts/scripts/export-dist.mjs <出力先フォルダ>");
  process.exit(1);
}
const OUT = path.resolve(outArg);
if (OUT === ROOT || OUT.startsWith(ROOT + path.sep)) {
  console.error("出力先はこのリポジトリの外にしてください");
  process.exit(1);
}

/** edit-job.mjs から相対 import で辿れる .mjs を集める。 */
function importClosure(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return;
    seen.add(file);
    const src = fs.readFileSync(file, "utf-8");
    for (const m of src.matchAll(/^\s*(?:import|export)[^;]*?from\s*["'](\.[^"']+)["']/gm)) {
      walk(path.resolve(path.dirname(file), m[1]));
    }
  };
  walk(entry);
  return [...seen];
}

// 出力先を空にする（.git は残す）
fs.mkdirSync(OUT, { recursive: true });
for (const name of fs.readdirSync(OUT)) {
  if (name === ".git") continue;
  fs.rmSync(path.join(OUT, name), { recursive: true, force: true });
}

const copied = [];
function copy(fromAbs, toRel, transform = null) {
  const to = path.join(OUT, toRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (transform) fs.writeFileSync(to, transform(fs.readFileSync(fromAbs, "utf-8")), "utf-8");
  else fs.copyFileSync(fromAbs, to);
  copied.push(toRel.replace(/\\/g, "/"));
}
function copyDir(fromAbs, toRel) {
  for (const name of fs.readdirSync(fromAbs)) {
    const p = path.join(fromAbs, name);
    if (fs.statSync(p).isDirectory()) copyDir(p, path.join(toRel, name));
    else copy(p, path.join(toRel, name));
  }
}

// プログラム
for (const file of importClosure(path.join(VS, "src", "edit-job.mjs"))) {
  copy(file, path.join("video-shorts", path.relative(VS, file)));
}
for (const name of ["transcribe.py", "transcribe_groq.py", "term-corrections.json"]) {
  copy(path.join(VS, "src", name), path.join("video-shorts", "src", name));
}
copyDir(path.join(VS, "src", "fonts"), path.join("video-shorts", "src", "fonts"));
copyDir(path.join(VS, "src", "vendor"), path.join("video-shorts", "src", "vendor"));

// Python 依存（文字起こしだけ。顔モザイク用の opencv は入れない）
copy(path.join(VS, "requirements.txt"), path.join("video-shorts", "requirements.txt"), (t) =>
  t.replace(/# mosaic:start[\s\S]*?# mosaic:end\n?/, "")
);

// package.json（実行時の依存はゼロ。doctor だけ用意する。v24 の再帰削除クラッシュは render-edl で避けたので上限は付けない）
fs.mkdirSync(path.join(OUT, "video-shorts"), { recursive: true });
fs.writeFileSync(
  path.join(OUT, "video-shorts", "package.json"),
  JSON.stringify({ name: "video-shorts", private: true, engines: { node: ">=20.0.0" }, scripts: { doctor: "node src/edit-job.mjs doctor" } }, null, 2) + "\n",
  "utf-8"
);
copied.push("video-shorts/package.json");

// 判断基準とスキル。手順の正本は配布物では CLAUDE.md になる。
copy(path.join(ROOT, "docs", "編集についての虎の巻.md"), path.join("docs", "編集についての虎の巻.md"));
copy(path.join(ROOT, "docs", "合格条件.md"), path.join("docs", "合格条件.md"));
copy(
  path.join(ROOT, ".claude", "skills", "video-edit-checklist", "SKILL.md"),
  path.join(".claude", "skills", "video-edit-checklist", "SKILL.md"),
  (t) => t.replace(/`AGENTS\.md`「【絶対項目・毎回】[^」]*」節/g, "`CLAUDE.md`")
);

// 配布物専用のファイルとライセンス
copyDir(path.join(VS, "dist-template"), ".");
copy(path.join(ROOT, "LICENSE"), "LICENSE");

console.log(`配布物を書き出しました: ${OUT}（${copied.length} ファイル）`);
