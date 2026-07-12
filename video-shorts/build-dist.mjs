// 配布ビルド: video-shorts の配布対象を dist/kosespark-video-shorts へ同期する。
// 実行: node video-shorts/build-dist.mjs （kosespark ルート or どこからでも可）
//
// 目的（販売安全・plan ステップ4）:
// - 手動 cp 運用を廃し配布物を再現可能に（dist は .gitignore で追跡外のため build で毎回再生成）
// - 現 dist の欠陥を根治: __pycache__・.pyc 混入 → 除去
// - 配布しないもの: server/・webapp-mockup/（保留経路）・ui/（ブラウザ選別UI）・install/（Vercel同意フォーム）、work/output/input/samples/scratch 等の作業物
//   ※ ui/ の選別も install/ の同意も、start-here.md + SKILL.md のチャット完結フローで代替（SKILL.md「UIを使わない」明記）
// - skill/ は配布固有物として保持（本スクリプトは触らない）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SRC = path.dirname(fileURLToPath(import.meta.url)); // = video-shorts/
const DEST = path.join(SRC, "..", "dist", "kosespark-video-shorts");

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function copyRel(rel) {
  const from = path.join(SRC, rel);
  const to = path.join(DEST, rel);
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
}

// 配布に含めない名前（バイナリキャッシュ・作業物・一時ファイル・保留経路のテスト・未参照ファイル）
const EXCLUDE = [
  /^__pycache__$/, /\.pyc$/, /\.wav$/, /\.tmp$/, /^scratch/,
  /^e2e-server\.mjs$/, // server 経路の e2e テスト（server は配布しないため不要）
  /^gen-editor-html\.mjs$/, // pipeline.mjs 未参照（R-1 で反映不要と判断済）
  /^\.vercel$/, // Vercel デプロイ設定（Web配布用・ローカル配布物には不要）
  /\.zip$/, // 配布用 zip（Web配布で生成・dist へ巻き込まない）
];
const excluded = (name) => EXCLUDE.some((re) => re.test(name));

// ディレクトリを除外フィルタ付きで再帰コピー
function copyDirFiltered(relDir) {
  for (const entry of fs.readdirSync(path.join(SRC, relDir), { withFileTypes: true })) {
    if (excluded(entry.name)) continue;
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) copyDirFiltered(rel);
    else copyRel(rel);
  }
}

// 0. 再生成対象（src/tests）をクリーン削除してから作り直す（配布外になった残骸・pyc も消す）。
//    ui/ install/ は配布廃止のため、過去ビルドの残骸を purge する目的でここでも削除する。
//    skill/ は DEST 直下の配布固有物なので触らない。
for (const d of ["src", "tests", "ui", "install"]) fs.rmSync(path.join(DEST, d), { recursive: true, force: true });

// 1. ルートの配布ファイル（start-here.md = ユーザーが Claude Code に「実行して」と渡すAI向け実行指示書。
//    旧 setup.html(EULA画面) / README.md(人間向け) は新フロー = start-here.md 内 ⓪同意 + Claude 会話で代替のため配布しない）
for (const f of ["start-here.md", "pipeline.mjs", "requirements.txt"]) {
  if (fs.existsSync(path.join(SRC, f))) copyRel(f);
}
// 2. src / tests（pyc・__pycache__ 除外）
copyDirFiltered("src");
copyDirFiltered("tests");
// 3. 版刻印（再現性のため git hash を記録・.gitignore で追跡外の dist の出所を明示）
let ver = "unknown";
try {
  ver = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: SRC }).toString().trim();
} catch {
  /* git 無し環境でも配布は続行 */
}
fs.writeFileSync(path.join(DEST, "version.txt"), `build: ${ver}\n`, "utf-8");

console.log(`[build-dist] 完了 → ${DEST} (version ${ver})`);
console.log("[build-dist] 除外: server/ webapp-mockup/ ui/ install/ work/ output/ samples/ scratch* *.wav __pycache__ *.pyc");
console.log("[build-dist] 保持: skill/ （配布固有物）");
