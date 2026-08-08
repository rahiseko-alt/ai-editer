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

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOSAIC_CLI = path.join(HERE, "apply_mosaic_cli.py");

/**
 * python3 → python の順で使える実行ファイルを選ぶ。
 * "python" 決め打ちだと python3 しか無い環境（多くの Linux ディストリ）で ENOENT になる。
 * ここだけは同期でよい（--version は数ミリ秒で、工程の開始前に1回だけ走る）。
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
 * モザイクを1本焼く（非同期）。
 * 同期実行（spawnSync）にすると、動画の長さと同程度の時間サーバー全体が応答しなくなる
 * （720p/30fps の10秒動画で実測10秒）。イベントループを止めないよう spawn で待つ。
 */
function runMosaic(python, src, dst, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [MOSAIC_CLI, src, dst], { windowsHide: true });
    let err = "";
    child.stderr.on("data", (c) => {
      const text = c.toString();
      err += text;
      if (onLog) text.split("\n").forEach((ln) => ln.trim() && onLog(ln.trim()));
    });
    child.on("error", (e) => reject(new Error(`顔モザイクの起動に失敗しました: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`顔モザイクが失敗しました: ${err.slice(-800)}`));
      resolve();
    });
  });
}

/**
 * candidates.json の全成果物にモザイクを焼き、素顔を退避し、manifest を書き換える。
 *
 * 【全部そろってから確定する】モザイクは1本ずつ作るが、素顔の退避と成果物フォルダへの
 * 配置は「全部そろってから」まとめて行う。1本ずつ確定すると、途中で失敗したときに
 * 「1本目＝顔を隠した版／2本目・3本目＝素顔のまま」が成果物フォルダに並び、
 * candidates.json も書き換わらないまま素顔を指す。これは葉Fが防ごうとしている状況そのもので、
 * 「エラーが出るから人が気づく」に頼ることになる。
 * 失敗したときは、作りかけのモザイク版を消して素顔だけの状態に戻す（混在させない）。
 *
 * @param {object} p
 * @param {string} p.outDir    成果物フォルダ（output/<id>）
 * @param {string} p.stashDir  素顔の退避先（成果物フォルダの外）
 * @param {object} p.candidates candidates.json の中身
 * @param {(s:string)=>void} [p.onLog]
 * @returns {Promise<object>} 書き換え後の candidates.json の中身
 */
export async function applyMosaicStage({ outDir, stashDir, candidates, onLog }) {
  const python = resolvePython();

  // 対象（各クリップ＋あればダイジェスト）を一覧にする
  const targets = (candidates.candidates || []).map((c) => ({ kind: "clip", entry: c }));
  if (candidates.digest && candidates.digest.file) {
    targets.push({ kind: "digest", entry: candidates.digest });
  }

  // ── 第1段: 全部作る（まだ何も確定させない） ──────────────
  const made = [];
  try {
    for (const t of targets) {
      const src = path.join(outDir, t.entry.file);
      const outName = mosaicName(t.entry.file);
      const dst = path.join(outDir, outName);
      await runMosaic(python, src, dst, null);
      if (!fs.existsSync(dst)) {
        throw new Error(`顔モザイクの出力が生成されませんでした: ${outName}`);
      }
      made.push({ ...t, src, dst, outName });
      if (onLog) onLog(`[OK] 顔を隠しました: ${t.entry.file} → ${outName}`);
    }
  } catch (e) {
    // 作りかけを消して素顔だけの状態へ戻す。素顔と加工済みを混在させない。
    for (const m of made) {
      try { fs.rmSync(m.dst, { force: true }); } catch (_) {}
    }
    throw e;
  }

  // ── 第2段: 全部そろったので確定する ────────────────────
  // ここも失敗しうる（退避先が作れない、ウイルス対策や権限でファイルが動かせない等）。
  // 途中で落ちたまま放置すると「1本目＝退避済みで顔を隠した版だけ／2本目＝素顔と
  // 顔を隠した版が両方」という混在が成果物フォルダに残る。第1段と同じく、
  // 失敗したら素顔だけの状態へ戻す。
  const moved = [];
  const next = { ...candidates, mosaic: true };
  const byKind = { clip: [], digest: null };
  try {
    fs.mkdirSync(stashDir, { recursive: true });
    for (const m of made) {
      const stashed = path.join(stashDir, m.entry.file);
      fs.renameSync(m.src, stashed);
      moved.push({ from: stashed, to: m.src });
      const updated = { ...m.entry, file: m.outName, path: m.dst };
      if (m.kind === "digest") byKind.digest = updated;
      else byKind.clip.push(updated);
    }
  } catch (e) {
    for (const mv of moved) {
      try { fs.renameSync(mv.from, mv.to); } catch (_) {}
    }
    for (const m of made) {
      try { fs.rmSync(m.dst, { force: true }); } catch (_) {}
    }
    throw e;
  }
  next.candidates = byKind.clip;
  if (byKind.digest) next.digest = byKind.digest;

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
  applyMosaicStage({
    outDir, stashDir, candidates: cand,
    onLog: (s) => process.stderr.write(s + "\n"),
  }).then((next) => {
    fs.writeFileSync(candPath, JSON.stringify(next, null, 2), "utf-8");
    console.log(`mosaic applied: ${next.candidates.length} clip(s)`);
  }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
