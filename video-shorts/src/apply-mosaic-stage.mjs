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

import { writeJsonAtomically } from "./atomic-json.mjs";
import { resolveInside, safeBasename } from "./safe-path.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOSAIC_CLI = path.join(HERE, "apply_mosaic_cli.py");

// AUD-P1-06: 退避(stash-move)完了後・candidates.json 書き換え完了前に強制終了すると、
// candidates.json が「もう成果物フォルダに無いファイル」を指したまま残ってしまう。
// stashDir 配下にこの名前で書き込み前ジャーナル(write-ahead journal)を残し、
// 次回 applyMosaicStage() 実行時（＝ジョブ再開/再起動時）に自動で後始末できるようにする。
const JOURNAL_NAME = "mosaic-journal.json";

/**
 * 前回、退避(stash-move)完了後・candidates.json 書き換え完了前に強制終了した形跡
 * （書き込み前ジャーナルの残骸）があれば後始末する。
 *
 * ジャーナルは「これから何を退避し、最終的に candidates.json をどう書き換えるつもりか」を
 * 退避を始める前に書き残したもの。ここでは:
 *  1. ジャーナルに書かれた退避(move)のうち、まだ済んでいないものを完了させる
 *     （退避元にファイルが残っていれば移す。退避先に既にあれば済んでいる＝何もしない）。
 *  2. 退避が全部済んだ状態で、ジャーナルが持つ最終形の candidates.json を原子的に書く。
 *  3. ジャーナルを消す（後始末完了）。
 * ジャーナルが無ければ何もしない（＝前回は正常終了している）。
 *
 * @param {string} stashDir 素顔の退避先ディレクトリ
 * @param {{onLog?: (s:string)=>void}} [opts]
 * @returns {object|null} 復旧して書いた candidates.json の中身（ジャーナルが無ければ null）
 */
export function recoverMosaicJournal(stashDir, { onLog } = {}) {
  const journalPath = path.join(stashDir, JOURNAL_NAME);
  if (!fs.existsSync(journalPath)) return null;
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8"));
  for (const mv of journal.moves) {
    if (fs.existsSync(mv.to)) continue; // 退避済み(ここは何もしない)
    if (fs.existsSync(mv.from)) {
      fs.renameSync(mv.from, mv.to);
      if (onLog) onLog(`[RECOVER] 中断していた顔モザイクの退避を再開しました: ${path.basename(mv.from)}`);
    } else {
      // 退避元にも退避先にも無い＝この移動の記録だけでは復旧できない実データ欠損。
      // 黙って先へ進むと「復旧できた」と偽ることになるので、必ず投げる。
      throw new Error(
        `顔モザイクの後始末を再開できません。退避元にも退避先にもファイルがありません: ${mv.from}`
      );
    }
  }
  writeJsonAtomically(journal.candPath, journal.next);
  fs.rmSync(journalPath, { force: true });
  if (onLog) onLog(`[RECOVER] candidates.json を復旧しました: ${journal.candPath}`);
  return journal.next;
}

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
 * @param {string} [p.candPath] candidates.json の実パス（既定 outDir/candidates.json）。
 *   ここへ最終形を原子的に書き込むところまでこの関数の責務にする（AUD-P1-06:
 *   呼び出し側が受け取った戻り値を fs.writeFileSync で直接truncate書きすると、
 *   書いている途中で落ちたときに壊れて読めなくなる）。
 * @param {(s:string)=>void} [p.onLog]
 * @returns {Promise<object>} 書き換え後の candidates.json の中身
 */
export async function applyMosaicStage({ outDir, stashDir, candidates, candPath, onLog }) {
  const resolvedCandPath = candPath || path.join(outDir, "candidates.json");
  const python = resolvePython();

  // AUD-P1-06: 前回、退避完了後・candidates.json 書き換え完了前に強制終了した形跡があれば、
  // 新しい作業を始める前に必ず先に後始末する。
  try {
    recoverMosaicJournal(stashDir, { onLog });
  } catch (e) {
    throw new Error(`前回の顔モザイク確定処理の復旧に失敗しました: ${e.message}`);
  }

  // 対象（各クリップ＋あればダイジェスト）を一覧にする
  const targets = (candidates.candidates || []).map((c) => ({ kind: "clip", entry: c }));
  if (candidates.digest && candidates.digest.file) {
    targets.push({ kind: "digest", entry: candidates.digest });
  }

  // ── 第1段: 全部作る（まだ何も確定させない） ──────────────
  const made = [];
  let failing = null;
  try {
    for (const t of targets) {
      // AUD-P1-01b: candidates.json の `file` を検証せず path.join() すると、
      // "../../evil.mp4" のような値で成果物フォルダの外を読み書きできてしまう。
      // 単純なbasename・許可拡張子のみを通し、I/Oの直前ごとに再度 resolveInside() する
      // （parse直後の1回だけの検査に頼らないTOCTOU対策）。
      const safeName = safeBasename(t.entry.file);
      const src = resolveInside(outDir, safeName);
      const outName = safeBasename(mosaicName(safeName));
      const dst = resolveInside(outDir, outName);
      // 失敗した本人の書きかけも消す。made へ積むのは成功後なので、made だけを
      // 後始末の対象にすると、書き込みの途中で止まったとき（容量不足など）に
      // 壊れた -mosaic が素顔の隣に残る。納品はフォルダからのコピーで、
      // SKILL.md は「-mosaic の方をコピーする」と案内しているため、
      // 壊れたファイルをそのまま渡す経路になる。
      failing = dst;
      await runMosaic(python, src, dst, null);
      if (!fs.existsSync(dst)) {
        throw new Error(`顔モザイクの出力が生成されませんでした: ${outName}`);
      }
      failing = null;
      made.push({ ...t, src, dst, outName, safeName });
      if (onLog) onLog(`[OK] 顔を隠しました: ${t.entry.file} → ${outName}`);
    }
  } catch (e) {
    // 作りかけを消して素顔だけの状態へ戻す。素顔と加工済みを混在させない。
    if (failing) { try { fs.rmSync(failing, { force: true }); } catch (_) {} }
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
  //
  // AUD-P1-06: 退避(rename)は1本ごとに原子的だが、「退避を全部済ませる」→
  // 「candidates.json を書き換える」という2段そのものは原子的ではない。この間に
  // 強制終了すると、candidates.json が旧のまま（＝もう成果物フォルダに無いファイルを
  // 指す）残ってしまう。退避を始める前に「これから何を退避し、最終的に
  // candidates.json をどう書くか」を書き込み前ジャーナルとして先に書いておき、
  // 次回 applyMosaicStage()（＝recoverMosaicJournal()）が「退避は済んでいるか」を見て
  // 安全に先へ進める・candidates.json を仕上げられるようにする。
  const next = { ...candidates, mosaic: true };
  const byKind = { clip: [], digest: null };
  for (const m of made) {
    const updated = { ...m.entry, file: m.outName, path: m.dst };
    if (m.kind === "digest") byKind.digest = updated;
    else byKind.clip.push(updated);
  }
  next.candidates = byKind.clip;
  if (byKind.digest) next.digest = byKind.digest;

  fs.mkdirSync(stashDir, { recursive: true });
  const journalPath = path.join(stashDir, JOURNAL_NAME);
  const plannedMoves = made.map((m) => ({ from: m.src, to: resolveInside(stashDir, m.safeName) }));
  writeJsonAtomically(journalPath, { candPath: resolvedCandPath, moves: plannedMoves, next });

  const moved = [];
  try {
    for (const mv of plannedMoves) {
      fs.renameSync(mv.from, mv.to);
      moved.push({ from: mv.to, to: mv.from });
    }
  } catch (e) {
    // 戻す作業そのものも失敗しうる（退避を止めた原因＝権限・ロックは戻す側でも起きる）。
    // 黙って握りつぶすと「混ざったまま、別の理由で失敗しました」と報告することになる。
    // 戻せなかったものを数え上げ、混在が残っている事実を必ず伝える。
    const stuck = [];
    for (const mv of moved) {
      try { fs.renameSync(mv.from, mv.to); } catch (_) { stuck.push(path.basename(mv.to)); }
    }
    for (const m of made) {
      try { fs.rmSync(m.dst, { force: true }); } catch (_) { stuck.push(m.outName); }
    }
    // ロールバックできた（＝旧状態に戻せた）ならジャーナルも消す。旧状態のまま
    // 残しておくと、次回 recoverMosaicJournal() がもう存在しないファイルを
    // 前提に後始末を試みてしまう。
    if (!stuck.length) { try { fs.rmSync(journalPath, { force: true }); } catch (_) {} }
    if (stuck.length) {
      throw new Error(
        `顔モザイクの後始末に失敗しました。成果物フォルダに素顔と加工済みが混ざったまま残っています` +
        `（戻せなかったファイル: ${stuck.join(", ")}）。元の失敗: ${e.message}`
      );
    }
    throw e;
  }

  // 退避が全部済んだので、candidates.json を原子的に書き、ジャーナルを消す
  // （ここで強制終了しても、次回 recoverMosaicJournal() が同じ内容を書き直すだけ＝冪等）。
  writeJsonAtomically(resolvedCandPath, next);
  try { fs.rmSync(journalPath, { force: true }); } catch (_) {}

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
    outDir, stashDir, candidates: cand, candPath,
    onLog: (s) => process.stderr.write(s + "\n"),
  }).then((next) => {
    // candidates.json は applyMosaicStage() が既に原子的に書き終えている
    // （AUD-P1-06: ここで再度 fs.writeFileSync すると、その書き込み自体が
    // truncateを伴う非原子的な書き込みに戻ってしまう）。
    console.log(`mosaic applied: ${next.candidates.length} clip(s)`);
  }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
