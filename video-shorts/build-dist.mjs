// 配布ビルド: video-shorts の配布対象を dist/kosespark-video-shorts へ同期する。
// 実行: node video-shorts/build-dist.mjs （kosespark ルート or どこからでも可）
//
// 目的（販売安全・plan ステップ4）:
// - 手動 cp 運用を廃し配布物を再現可能に（dist は .gitignore で追跡外のため build で毎回再生成）
// - 現 dist の欠陥を根治: __pycache__・.pyc 混入 → 除去
// - 配布しないもの: server/・webapp-mockup/（保留経路）・ui/（ブラウザ選別UI）・install/（Vercel同意フォーム）、work/output/input/samples/scratch 等の作業物
//   ※ ui/ の選別も install/ の同意も、start-here.md + SKILL.md のチャット完結フローで代替（SKILL.md「UIを使わない」明記）
// - skill/ は video-shorts/skill/ が正本（ビルドのたびに DEST 側をパージしコピーし直す）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SRC = path.dirname(fileURLToPath(import.meta.url)); // = video-shorts/

// --slim: 顔モザイクを外した軽い配布物（ロードマップ G-SLIM）。
// 同梱モデル(SFace 37MB)が容量のほぼ全てで、標準版はメール添付の上限(30MB)を超える。
// モザイクを使わない案件では丸ごと不要なので、モデルとモザイク用スクリプトを外して作る。
const SLIM = process.argv.includes("--slim");
const DEST = path.join(SRC, "..", "dist",
  SLIM ? "kosespark-video-shorts-slim" : "kosespark-video-shorts");

// 軽い版で配布しないもの（モザイク一式）
const MOSAIC_FILES = [
  "src/models",
  "src/apply_mosaic_cli.py",
  "src/face_mosaic.py",
  "src/face_choices.py",
  "tests/face-mosaic-check.py",
  "tests/fixtures",
];
const isMosaicPath = (rel) =>
  MOSAIC_FILES.some((m) => rel === m || rel.startsWith(m + path.sep) || rel.startsWith(m + "/"));

/** 目印(<!-- mosaic:start -->〜<!-- mosaic:end -->)を処理する。
 *  手順書を2つに複製すると片方だけ直す事故が起きるため、正本は1つのままビルドで加工する。
 *  - 軽い版: 目印で囲まれた中身ごと取り除く
 *  - 標準版: 中身は残し、目印の行だけ取り除く（客の手元に加工用の印を出さない） */
function applyMosaicMarkers(text, { drop }) {
  const out = drop
    ? text.replace(/<!-- mosaic:start -->[\s\S]*?<!-- mosaic:end -->\n?/g, "")
    : text.replace(/^[ \t]*<!-- mosaic:(start|end) -->\n?/gm, "");
  if (out.includes("mosaic:start") || out.includes("mosaic:end")) {
    throw new Error("mosaic の目印が対になっていません（削り残しが出ます）");
  }
  return out;
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function copyRel(rel) {
  const from = path.join(SRC, rel);
  const to = path.join(DEST, rel);
  ensureDir(path.dirname(to));
  // 手順書: 軽い版はモザイクの案内ごと削り、標準版は目印だけ消す（G-SLIM S-2 / S-4）。
  // 入っていない機能を勧められて、お客様が実行して失敗するのを防ぐ。
  if (rel.endsWith("SKILL.md")) {
    fs.writeFileSync(to, applyMosaicMarkers(fs.readFileSync(from, "utf-8"), { drop: SLIM }), "utf-8");
    return;
  }
  // 依存: 軽い版は opencv(顔検出用)を要求しない。使わない依存を客に入れさせないため。
  if (rel === "requirements.txt") {
    const raw = fs.readFileSync(from, "utf-8");
    const text = SLIM
      ? raw.replace(/# mosaic:start\n[\s\S]*?# mosaic:end\n?/g, "")
      : raw.replace(/^# mosaic:(start|end)\n?/gm, "");
    fs.writeFileSync(to, text, "utf-8");
    return;
  }
  fs.copyFileSync(from, to);
}

// 配布に含めない名前（バイナリキャッシュ・作業物・一時ファイル・保留経路のテスト・未参照ファイル）
const EXCLUDE = [
  /^__pycache__$/, /\.pyc$/, /\.wav$/, /\.tmp$/, /^scratch/,
  /^e2e-server\.mjs$/, // server 経路の e2e テスト（server は配布しないため不要）
  /^dist-slim-check\.mjs$/, // 配布物そのものを検査するテスト（dist/ を見るので客の手元では動かない）
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
    if (SLIM && isMosaicPath(rel)) continue;
    if (entry.isDirectory()) copyDirFiltered(rel);
    else copyRel(rel);
  }
}

// 0. 再生成対象（src/tests/skill）をクリーン削除してから作り直す（配布外になった残骸・pyc も消す）。
//    ui/ install/ は配布廃止のため、過去ビルドの残骸を purge する目的でここでも削除する。
//    skill/ は video-shorts/skill/ が正本なので DEST 側を毎回パージしてから作り直す。
for (const d of ["src", "tests", "skill", "ui", "install"]) fs.rmSync(path.join(DEST, d), { recursive: true, force: true });
// 配布から外したルート直下の旧ファイルも purge（増分ビルド運用で残骸が客に混入しないよう再現性を担保）。
for (const f of ["setup.html", "README.md", "はじめにお読みください.txt"]) fs.rmSync(path.join(DEST, f), { force: true });

// 1. ルートの配布ファイル（start-here.md = ユーザーが Claude Code に「実行して」と渡すAI向け実行指示書。
//    旧 setup.html(EULA画面) / README.md(人間向け) は新フロー = start-here.md 内 ⓪同意 + Claude 会話で代替のため配布しない）
for (const f of ["start-here.md", "pipeline.mjs", "requirements.txt"]) {
  if (fs.existsSync(path.join(SRC, f))) copyRel(f);
}
// 2. src / tests（pyc・__pycache__ 除外）
copyDirFiltered("src");
copyDirFiltered("tests");
copyDirFiltered("skill");
// 3. 版刻印（再現性のため git hash を記録・.gitignore で追跡外の dist の出所を明示）
let ver = "unknown";
try {
  ver = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: SRC }).toString().trim();
} catch {
  /* git 無し環境でも配布は続行 */
}
fs.writeFileSync(path.join(DEST, "version.txt"), `build: ${ver}\n`, "utf-8");

console.log(`[build-dist] 完了 → ${DEST} (version ${ver})${SLIM ? " ※軽い版(モザイク無し)" : ""}`);
if (SLIM) console.log("[build-dist] 軽い版のため除外: " + MOSAIC_FILES.join(" "));
console.log("[build-dist] 除外: server/ webapp-mockup/ ui/ install/ work/ output/ samples/ scratch* *.wav __pycache__ *.pyc");
console.log("[build-dist] コピー: skill/ （video-shorts/skill/ が正本）");
