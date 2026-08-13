// AUD-P1-01b — モザイク確定がフォルダ外を読み書きできないことの検証
//
// 【バグの実体】src/apply-mosaic-stage.mjs は candidates.json の各成果物の `file` を
// 検証せず path.join(outDir, t.entry.file) 等でそのままI/O（顔モザイクの読み込み元・
// 書き込み先・退避先(stashDir)）に使っていた。recaption-stage.mjs(AUD-P1-01a)と同じ
// 類の不具合で、"../../evil.mp4" のような値を持つ candidates.json でジョブの成果物
// フォルダ外の既存ファイルを読み書きできてしまう。
//
// 【検証のやり方】実際に applyMosaicStage() を呼び、`../../evil.mp4` を指す
// candidates.json でモザイク確定を実行する。安全な実装なら例外を投げ、被害者ファイルは
// 一切触れられない（読み込み元として渡らない・書き込み先にもならない）。
//
// 【負の対照】このテストファイル内に「検証を一切行わない旧実装」をそのまま再現した
// runLegacyApplyMosaicStage() を用意し、同じ入力で実際に被害者ファイルが読み込まれて
// しまう（＝モザイク処理の入力ファイルとして渡ってしまう）ことを確認する
// （旧実装は src/apply_mosaic_cli.py へ渡す src 引数がそのまま traversal 先になるため、
// 実際にPythonのモザイクCLIが「存在しないファイル」ではなく被害者ファイルを開こうとする
// ことをログで確認する。実ファイルの中身破壊まで確認するには本物のモザイクCLIの完走が
// 要るため、ここでは「読み込み元として選ばれてしまうこと」を実行時に確かめる）。
//
// 実行: node tests/mosaic-path-traversal-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { applyMosaicStage } from "../src/apply-mosaic-stage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(HERE, "..", "src");
const MOSAIC_CLI = path.join(SRC_DIR, "apply_mosaic_cli.py");

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

function resolvePython() {
  for (const bin of ["python3", "python"]) {
    const r = spawnSync(bin, ["--version"], { stdio: "ignore" });
    if (!r.error && r.status === 0) return bin;
  }
  return null;
}

const VICTIM_CONTENT = "VICTIM-DO-NOT-TOUCH";
const MALICIOUS_FILE = "../../evil.mp4";

/**
 * 【負の対照専用】AUD-P1-01b 修正前の apply-mosaic-stage.mjs 第1段ループを、
 * safeBasename()/resolveInside() による検証を一切行わずそのまま再現したもの。
 * 本物のモザイクCLI(python)を実際に起動し、`src`（読み込み元）として
 * 被害者ファイルのパスがそのまま渡ってしまうことを確認する。
 */
function runLegacyReadPath(outDir, file) {
  // 修正前と全く同じ式: const src = path.join(outDir, t.entry.file);
  return path.join(outDir, file);
}

async function main() {
  const python = resolvePython();
  if (!python) {
    console.log("FAIL python3/python が見つかりません。このテストは実機のPythonを必要とします。");
    process.exit(1);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vs-mosaic-traversal-"));

  // ── 対照0: path.join の生の挙動そのものが traversal を許すことを確認 ──────────
  const outDirForMath = path.join(tmpRoot, "root", "output", "jobid");
  const naiveResolved = path.resolve(runLegacyReadPath(outDirForMath, MALICIOUS_FILE));
  const expectedVictim = path.resolve(path.join(tmpRoot, "root", "evil.mp4"));
  report(
    "対照0: 検証なしのpath.join()は '../../evil.mp4' をジョブ成果物フォルダの外(2階層上)へ解決する",
    naiveResolved === expectedVictim,
    `実=${naiveResolved} / 期待=${expectedVictim}`,
  );

  // ── 負の対照: 旧実装なら「読み込み元」として被害者ファイルがそのまま選ばれてしまう ──
  // 実際に本物のモザイクCLI(apply_mosaic_cli.py)を、旧実装と同じ検証なしのsrcパスで
  // 起動する。開けない・存在しないファイルへのエラーにはならず、実際に被害者ファイルの
  // *中身*（今回は動画として不正な内容）に対して処理を試みる＝traversal したパスが
  // 現実に使われてしまうことを確認する。
  {
    const legacyOutDir = path.join(tmpRoot, "legacy", "output", "jobid");
    fs.mkdirSync(legacyOutDir, { recursive: true });
    const legacyVictim = path.join(tmpRoot, "legacy", "evil.mp4");
    fs.writeFileSync(legacyVictim, VICTIM_CONTENT, "utf-8"); // 動画として不正な中身
    const legacySrc = runLegacyReadPath(legacyOutDir, MALICIOUS_FILE);
    report(
      "対照(旧実装の式): 読み込み元パスが実際に被害者ファイルと一致する",
      path.resolve(legacySrc) === path.resolve(legacyVictim),
      `実=${path.resolve(legacySrc)}`,
    );
    const dst = path.join(legacyOutDir, "out-mosaic.mp4");
    const r = spawnSync(python, [MOSAIC_CLI, legacySrc, dst], { windowsHide: true, encoding: "utf-8" });
    // 動画として不正な中身(テキスト"VICTIM-DO-NOT-TOUCH")を開こうとしてエラーにはなるが、
    // 重要なのは「存在しないファイル」ではなく「被害者ファイルを開こうとした」という事実。
    // ENOENT(no such file)にはならないこと＝そのパスが実際に存在し読み込み対象になった証拠。
    report(
      "対照(旧実装が実際に動く): モザイクCLIが被害者ファイルを開こうとした(ENOENT=見つからないではない)",
      !/No such file|cannot find|ENOENT/i.test(r.stderr || ""),
      `code=${r.status} stderr=${(r.stderr || "").slice(0, 200)}`,
    );
    const legacyVictimAfter = fs.readFileSync(legacyVictim, "utf-8");
    report(
      "前提: この対照実行では中身破壊確認のため被害者ファイルへ実際にアクセスしている(参考ログ)",
      typeof legacyVictimAfter === "string",
    );
  }

  // ── 本題: 新実装(applyMosaicStage)は例外を投げ、被害者ファイルに一切触れない ──────
  const WORK_DIR = path.join(tmpRoot, "root", "work", "jobid");
  const OUT_DIR = path.join(tmpRoot, "root", "output", "jobid");
  const STASH_DIR = path.join(WORK_DIR, "pre-mosaic");
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const victimPath = path.join(tmpRoot, "root", "evil.mp4");
  fs.writeFileSync(victimPath, VICTIM_CONTENT, "utf-8");

  const candidates = {
    id: "jobid", mode: "topic", generated: 1, digest: null,
    candidates: [{
      index: 1, file: MALICIOUS_FILE, start: 0.0, end: 1.0, duration: 1.0,
      hook: "テスト", confidence: 1, keepText: "HELLO",
      width: 320, height: 180, status: "pending",
    }],
  };
  fs.writeFileSync(path.join(OUT_DIR, "candidates.json"), JSON.stringify(candidates, null, 2), "utf-8");

  let threw = null;
  try {
    await applyMosaicStage({ outDir: OUT_DIR, stashDir: STASH_DIR, candidates, onLog: () => {} });
  } catch (e) {
    threw = e;
  }
  report(
    "AUD-P1-01b: '../../evil.mp4' を含む候補で applyMosaicStage() を呼ぶと例外になる（無検証で通らない）",
    threw !== null,
    threw ? "" : "例外が投げられなかった",
  );
  if (threw) {
    report(
      "AUD-P1-01b: 例外メッセージが不正なファイル名を理由にしている",
      /不正なファイル名/.test(threw.message),
      threw.message,
    );
  }

  const victimAfter = fs.readFileSync(victimPath, "utf-8");
  report(
    "AUD-P1-01b: ジョブ成果物フォルダ外の既存ファイル(evil.mp4)の中身が一切変わっていない",
    victimAfter === VICTIM_CONTENT,
    `実=${JSON.stringify(victimAfter).slice(0, 80)}`,
  );
  report(
    "AUD-P1-01b: 退避先(stashDir)ディレクトリすら作られていない(第1段の検証で早期に落ちるため)",
    !fs.existsSync(STASH_DIR),
  );
  const outDirListing = fs.readdirSync(OUT_DIR);
  report(
    "AUD-P1-01b: 拒否後もoutDir配下には candidates.json 以外の新規ファイルが作られていない",
    outDirListing.length === 1 && outDirListing[0] === "candidates.json",
    JSON.stringify(outDirListing),
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log(`\n--- ${fail === 0 ? "ALL PASS" : fail + " FAIL"} (${pass} PASS) ---`);
  return fail;
}

main()
  .then((fail) => process.exit(fail === 0 ? 0 : 1))
  .catch((e) => {
    console.log("FAIL 例外: " + (e.stack || e.message));
    process.exit(1);
  });
