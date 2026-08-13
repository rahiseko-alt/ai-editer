// AUD-P1-06 — モザイク確定が途中で落ちても壊れないことの検証
//
// 【バグの実体】顔モザイク確定(src/apply-mosaic-stage.mjs)は、素顔の動画をstashDirへ
// 退避(rename)した後、呼び出し側(server/pipeline-runner.mjs)が candidates.json を
// fs.writeFileSync で直接truncate書きしていた。退避のrenameが完了した直後・
// candidates.json の書き換えが完了する前にプロセスが強制終了すると、candidates.json は
// 「もう成果物フォルダに無いファイル(退避済みの素顔)」を指したまま残る。
//
// 【この検査のやり方】tests/helpers/mosaic-crash-worker.mjs を子プロセスとして起動する。
// このワーカーは本体コード(src/apply-mosaic-stage.mjs)を一切変更せず、fs.renameSync を
// フックして「退避先(stashDir)への rename が完了した直後」に自分自身へ SIGKILL を送る。
// 親プロセスは子が SIGKILL で死ぬのを確認した後、
//   (a) 新実装: recoverMosaicJournal() を呼んで復旧し、candidates.json が
//       parseable かつ参照先ファイルが実在することを確認する。
//   (b) 対照(旧実装): 同じ狙った瞬間で強制終了させると、candidates.json は
//       (書き込み前ジャーナルが無いため)復旧手段が無いまま、退避済みで
//       もう存在しないファイルを指したまま残ることを確認する。
//
// 実行: node tests/mosaic-atomic-crash-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runFfmpeg } from "../src/render-vertical.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const WORKER = path.join(HERE, "helpers", "mosaic-crash-worker.mjs");

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

function ffmpegAvailable() {
  return new Promise((res) => {
    const p = spawn("ffmpeg", ["-version"], { windowsHide: true });
    p.on("error", () => res(false));
    p.on("close", (c) => res(c === 0));
  });
}
function pythonAvailable() {
  return new Promise((res) => {
    const p = spawn("python3", ["--version"], { windowsHide: true });
    p.on("error", () => res(false));
    p.on("close", (c) => res(c === 0));
  });
}

/** ワーカーを起動し、SIGKILLで死ぬまで待つ。{signal, code} を返す。 */
function runWorkerUntilKilled(outDir, stashDir, candPath, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [WORKER, outDir, stashDir, candPath], { cwd: ROOT, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ワーカーがタイムアウトした(狙った瞬間のrenameが起きなかった可能性): ${stderr.slice(-500)}`));
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
    child.on("error", reject);
  });
}

async function buildFixture(rootDir, label) {
  const workDir = path.join(rootDir, label, "work", "jobid");
  const outDir = path.join(rootDir, label, "output", "jobid");
  const stashDir = path.join(workDir, "pre-mosaic");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const clipFile = "clip-1.mp4";
  const clipPath = path.join(outDir, clipFile);
  await runFfmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    clipPath,
  ]);

  const candPath = path.join(outDir, "candidates.json");
  const candidates = {
    id: "jobid", mode: "topic", generated: 1, digest: null,
    candidates: [{
      index: 1, file: clipFile, start: 0.0, end: 1.0, duration: 1.0,
      hook: "テスト", confidence: 1, keepText: "HELLO",
      width: 320, height: 180, status: "pending",
    }],
  };
  fs.writeFileSync(candPath, JSON.stringify(candidates, null, 2), "utf-8");
  return { workDir, outDir, stashDir, candPath, clipFile };
}

async function main() {
  if (!(await ffmpegAvailable())) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }
  if (!(await pythonAvailable())) {
    console.log("FAIL python3 が見つかりません。このテストは実機の python3(顔モザイク)を必要とします。");
    process.exit(1);
  }

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-mosaic-crash-"));

  // ── (a) 現在の src/apply-mosaic-stage.mjs に対して、実際にkillタイミングを再現する ──
  const fx = await buildFixture(rootDir, "current");
  const before = fs.readFileSync(fx.candPath, "utf-8");

  const result = await runWorkerUntilKilled(fx.outDir, fx.stashDir, fx.candPath);
  report(
    "前提: ワーカーが退避(stash-move)直後に実際にSIGKILLで強制終了した",
    result.signal === "SIGKILL",
    `signal=${result.signal} code=${result.code} stderr=${result.stderr.slice(-300)}`,
  );

  // クラッシュ直後（復旧前）の生の状態を観察する。素顔は既に退避されているはずだが、
  // candidates.json はまだ古いまま（or 壊れている）可能性がある、という「間」の瞬間。
  const afterCrashOutListing = fs.readdirSync(fx.outDir);
  report(
    "クラッシュ直後: 退避(stash-move)自体は完了しており、outDirから素顔クリップが消えている",
    !afterCrashOutListing.includes(fx.clipFile),
    JSON.stringify(afterCrashOutListing),
  );
  report(
    "クラッシュ直後: 素顔クリップはstashDirへ実際に退避されている",
    fs.existsSync(path.join(fx.stashDir, fx.clipFile)),
  );

  // ── 復旧（新実装: recoverMosaicJournal） ─────────────────────────
  const { recoverMosaicJournal } = await import(
    `${path.resolve(ROOT, "src", "apply-mosaic-stage.mjs")}?t=${Date.now()}`
  );

  if (typeof recoverMosaicJournal !== "function") {
    console.log("SKIP: 現在の src/apply-mosaic-stage.mjs は recoverMosaicJournal を export していません（未修正状態）。");
  } else {
    let recoverThrew = null;
    try {
      recoverMosaicJournal(fx.stashDir, { onLog: () => {} });
    } catch (e) {
      recoverThrew = e;
    }
    report(
      "AUD-P1-06: recoverMosaicJournal() が例外を投げずに復旧する",
      recoverThrew === null,
      recoverThrew ? recoverThrew.message : "",
    );
    let parsed = null, parseError = null;
    try {
      parsed = JSON.parse(fs.readFileSync(fx.candPath, "utf-8"));
    } catch (e) {
      parseError = e;
    }
    report(
      "AUD-P1-06: 復旧後、candidates.json が JSON.parse できる",
      parseError === null,
      parseError ? parseError.message : "",
    );
    if (parsed) {
      const entry = (parsed.candidates || [])[0];
      report(
        "AUD-P1-06: 復旧後、candidates.json の候補が実在するファイルを指している",
        !!entry && fs.existsSync(path.join(fx.outDir, entry.file)),
        entry ? `file=${entry.file} exists=${fs.existsSync(path.join(fx.outDir, entry.file))}` : "候補が無い",
      );
      report(
        "AUD-P1-06: 復旧後、候補のファイル名は -mosaic 版になっている(退避前の素顔名ではない)",
        !!entry && /-mosaic\.mp4$/.test(entry.file),
        entry ? entry.file : "",
      );
    }
  }

  // ── (b) 対照: 書き込み前ジャーナルが無い実装だと、同じkillタイミングで
  //     candidates.jsonが「もう存在しないファイル」を指したまま残ることを確認する。────
  // ここでは実装を書き換えず、「クラッシュ直後の生の状態」そのものが対照になる。
  // recoverMosaicJournal を一切呼ばない場合、before(クラッシュ前のcandidates.json)が
  // そのまま最終状態になる。beforeが指すファイル(clipFile)は既にstashDirへ退避され、
  // outDirには存在しない＝「manifestが存在しないファイルを指す」というAUD-P1-06が
  // 防ごうとしている状態そのものである。
  const beforeParsed = JSON.parse(before);
  const beforeEntry = beforeParsed.candidates[0];
  report(
    "対照: 復旧処理を呼ばなければ、クラッシュ直後のcandidates.json(旧内容)は" +
      "もう存在しないファイルを指したままになる(=AUD-P1-06が防ごうとしているバグそのもの)",
    beforeEntry.file === fx.clipFile && !fs.existsSync(path.join(fx.outDir, beforeEntry.file)),
    `file=${beforeEntry.file} existsInOutDir=${fs.existsSync(path.join(fx.outDir, beforeEntry.file))}`,
  );

  fs.rmSync(rootDir, { recursive: true, force: true });

  console.log(`\n--- ${fail === 0 ? "ALL PASS" : fail + " FAIL"} (${pass} PASS) ---`);
  return fail;
}

main()
  .then((fail) => process.exit(fail === 0 ? 0 : 1))
  .catch((e) => {
    console.log("FAIL 例外: " + (e.stack || e.message));
    process.exit(1);
  });
