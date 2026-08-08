// video-shorts 顔モザイク工程（Web UI 経路用）— G-EDIT-MOSAIC-UI
//
// これまでモザイクは CLI 経路（SKILL.md 手順7.5）にしか無く、Web UI から実行すると
// 素顔のまま出力されていた（docs/product-mechanism.md 2.9）。本モジュールはレンダリング後の
// 成果物にモザイクを焼き、成果物フォルダから素顔のファイルを退避させる。
//
// 素顔を「候補一覧から隠す」だけでは足りない。この製品の納品は skill/video-shorts/SKILL.md の
// とおりフォルダからのファイルコピーなので、素顔が output/<id>/ に残っている限り
// 「うっかり素顔を納品する」事故は人の注意力頼みのままになる。実体を出力フォルダの外へ移す。
//
// CLI としても使える（テストから直接叩くため）:
//   node src/apply-mosaic-stage.mjs <outDir> <stashDir>

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOSAIC_CLI = path.join(HERE, "apply_mosaic_cli.py");

/**
 * python3 → python の順で使える実行ファイルを選ぶ。
 * "python" 決め打ちだと python3 しか無い環境（多くの Linux ディストリ）で ENOENT になる。
 */
export function resolvePython() {
  for (const bin of ["python3", "python"]) {
    const r = spawnSync(bin, ["--version"], { stdio: "ignore" });
    if (!r.error && r.status === 0) return bin;
  }
  throw new Error("python3 も python も見つかりません。顔モザイクには Python が必要です。");
}

/** 素顔のファイルにモザイクを焼いた出力先の名前（SKILL.md と同じ -mosaic 規則） */
export function mosaicName(file) {
  const ext = path.extname(file);
  return `${path.basename(file, ext)}-mosaic${ext}`;
}

/**
 * 成果物1本にモザイクを焼き、素顔を退避する。
 * @returns {{file:string, path:string}} モザイク版の名前と絶対パス
 */
function maskOne({ outDir, stashDir, file, python, onLog }) {
  const src = path.join(outDir, file);
  const outName = mosaicName(file);
  const dst = path.join(outDir, outName);

  const r = spawnSync(python, [MOSAIC_CLI, src, dst], { encoding: "utf-8" });
  if (r.error) throw new Error(`顔モザイクの起動に失敗しました: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`顔モザイクが失敗しました (${file}): ${(r.stderr || "").slice(-800)}`);
  }
  if (!fs.existsSync(dst)) {
    throw new Error(`顔モザイクの出力が生成されませんでした: ${outName}`);
  }

  // 素顔を成果物フォルダの外へ移す。ここで移さないと、候補一覧から隠しても
  // フォルダを直接見た人が素顔のほうをコピーできてしまう。
  fs.mkdirSync(stashDir, { recursive: true });
  fs.renameSync(src, path.join(stashDir, file));

  if (onLog) onLog(`[OK] 顔を隠しました: ${file} → ${outName}`);
  return { file: outName, path: dst };
}

/**
 * candidates.json の全成果物にモザイクを焼き、素顔を退避し、manifest を書き換える。
 * 呼び出し側は戻り値で candidates.json を上書きする。
 *
 * @param {object} p
 * @param {string} p.outDir    成果物フォルダ（output/<id>）
 * @param {string} p.stashDir  素顔の退避先（成果物フォルダの外）
 * @param {object} p.candidates candidates.json の中身
 * @param {(s:string)=>void} [p.onLog]
 * @returns {object} 書き換え後の candidates.json の中身
 */
export function applyMosaicStage({ outDir, stashDir, candidates, onLog }) {
  const python = resolvePython();
  const next = { ...candidates, mosaic: true };

  next.candidates = (candidates.candidates || []).map((c) => {
    const masked = maskOne({ outDir, stashDir, file: c.file, python, onLog });
    return { ...c, ...masked };
  });

  if (candidates.digest && candidates.digest.file) {
    const masked = maskOne({ outDir, stashDir, file: candidates.digest.file, python, onLog });
    next.digest = { ...candidates.digest, ...masked };
  }

  return next;
}

// ── CLI（テストから直接叩く） ────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [outDir, stashDir] = process.argv.slice(2);
  if (!outDir || !stashDir) {
    console.error("usage: node src/apply-mosaic-stage.mjs <outDir> <stashDir>");
    process.exit(2);
  }
  const candPath = path.join(outDir, "candidates.json");
  const cand = JSON.parse(fs.readFileSync(candPath, "utf-8"));
  const next = applyMosaicStage({
    outDir, stashDir, candidates: cand,
    onLog: (s) => process.stderr.write(s + "\n"),
  });
  fs.writeFileSync(candPath, JSON.stringify(next, null, 2), "utf-8");
  console.log(`mosaic applied: ${next.candidates.length} clip(s)`);
}
