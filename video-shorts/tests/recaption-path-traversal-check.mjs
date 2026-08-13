// AUD-P1-01a — 字幕焼き直しがフォルダ外を書き換えられないことの検証
//
// 【バグの実体】src/recaption-stage.mjs は candidates.json の各候補の `file` を検証せず
// path.join(outDir, c.file) 等でそのままI/O（一時出力の書き込み・最終rename）に使っていた。
// candidates.json はジョブの成果物フォルダに置かれるただのJSONで、正規の書き手
// (pipeline.mjs)は常に path.basename() した値しか書かないが、壊れた/書き換えられた
// candidates.json が `"file": "../../evil.mp4"` のような値を持っていた場合、
// 焼き直しの最終差し替え(fs.renameSync)がジョブの成果物フォルダの外にある
// 既存ファイルを上書きしてしまう。
//
// 【検証のやり方】
//  1. 実際に recaptionStage() を呼び、`../../evil.mp4` を指す candidates.json で
//     焼き直しを実行する。安全な実装なら例外を投げ、被害者ファイルは一切触れられない。
//  2. 対照として、旧実装と同じ「検証なしの path.join」を this ファイル内で直接再現し、
//     同じ入力(outDir, "../../evil.mp4")を渡すと実際にジョブの成果物フォルダの外を
//     指すパスに解決されてしまうことを確認する（このtraversalの成立自体は実装非依存の
//     事実であり、対策が無ければ確実に成立することを示す）。
//
// 【負の対照（別途実施・git stash）】このテストファイル自体は「新実装が安全である」ことを
// 検証する。「旧実装が実際に被害者ファイルを上書きする」ことは、本fixをgit stashで一時的に
// 外した状態で同じrecaptionStage()呼び出しを行うことで確認済み（作業ログ参照）。
//
// 実行: node tests/recaption-path-traversal-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { runFfmpeg } from "../src/render-vertical.mjs";
import { recaptionStage } from "../src/recaption-stage.mjs";

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

const VICTIM_CONTENT = "VICTIM-DO-NOT-TOUCH";
const MALICIOUS_FILE = "../../evil.mp4";

async function main() {
  if (!(await ffmpegAvailable())) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }

  // ── 対照0: path.join の生の挙動そのものが traversal を許すことを確認 ──────────
  // (実装非依存の事実。ここで示すのは「検証しなければ確実に外へ出る」という前提)
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vs-path-traversal-"));
  const outDirForMath = path.join(tmpRoot, "root", "output", "jobid");
  const naiveResolved = path.resolve(path.join(outDirForMath, MALICIOUS_FILE));
  const expectedVictim = path.resolve(path.join(tmpRoot, "root", "evil.mp4"));
  report(
    "対照0: 検証なしのpath.join()は '../../evil.mp4' をジョブ成果物フォルダの外(2階層上)へ解決する",
    naiveResolved === expectedVictim,
    `実=${naiveResolved} / 期待=${expectedVictim}`,
  );

  // ── 本題: 実際に recaptionStage() を呼び、被害者ファイルが無事かを確認する ──────
  const WORK_DIR = path.join(tmpRoot, "root", "work", "jobid");
  const OUT_DIR = path.join(tmpRoot, "root", "output", "jobid");
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 被害者ファイル: outDirの2階層上（naiveResolvedと同じ場所）に、既知の中身で置く。
  const victimPath = path.join(tmpRoot, "root", "evil.mp4");
  fs.writeFileSync(victimPath, VICTIM_CONTENT, "utf-8");

  // 実際に焼き直しが動く最低限の材料。
  const sample = path.join(tmpRoot, "sample.mp4");
  await runFfmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    sample,
  ]);

  fs.writeFileSync(
    path.join(WORK_DIR, "state.json"),
    JSON.stringify({ id: "jobid", input: sample, orient: "portrait", sub: "none", trim: "none" }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(WORK_DIR, "transcript.json"),
    JSON.stringify({
      language: "en", duration: 2.0,
      words: [{ w: "HELLO", start: 0.0, end: 1.0 }],
      segments: [{ start: 0.0, end: 1.0, text: "HELLO" }],
    }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "candidates.json"),
    JSON.stringify({
      id: "jobid", mode: "topic", generated: 1, digest: null, incomplete: false,
      candidates: [{
        index: 1, file: MALICIOUS_FILE, start: 0.0, end: 1.0, duration: 1.0,
        hook: "テスト", confidence: 1, keepText: "HELLO",
        width: 320, height: 180, status: "pending",
      }],
    }, null, 2),
    "utf-8",
  );

  let threw = null;
  try {
    await recaptionStage({ workDir: WORK_DIR, outDir: OUT_DIR, onLog: () => {} });
  } catch (e) {
    threw = e;
  }
  report(
    "AUD-P1-01a: '../../evil.mp4' を含む候補で recaptionStage() を呼ぶと例外になる（無検証で通らない）",
    threw !== null,
    threw ? "" : "例外が投げられなかった",
  );
  if (threw) {
    report(
      "AUD-P1-01a: 例外メッセージが不正なファイル名を理由にしている",
      /不正なファイル名/.test(threw.message),
      threw.message,
    );
  }

  const victimAfter = fs.readFileSync(victimPath, "utf-8");
  report(
    "AUD-P1-01a: ジョブ成果物フォルダ外の既存ファイル(evil.mp4)の中身が一切変わっていない",
    victimAfter === VICTIM_CONTENT,
    `実=${JSON.stringify(victimAfter).slice(0, 80)}`,
  );

  // outDir配下には traversal 由来のtmpファイル等が一切残っていないことも確認する
  // （拒否したのに副作用としてゴミを作っていないか）。
  const outDirListing = fs.readdirSync(OUT_DIR);
  report(
    "AUD-P1-01a: 拒否後もoutDir配下には candidates.json 以外の新規ファイルが作られていない",
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
