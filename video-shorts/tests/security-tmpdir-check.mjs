// 共有一時置き場のsymlink先回り攻撃の検証 — P1-18-A/B
//
// src/concat.mjs の一時ファイル名(旧実装: vs-concat-${pid}-${clips.length}.txt)と
// src/claude-safety.mjs の createIsolatedCwd が使う親ディレクトリ(旧実装: 固定名
// video-shorts-claude-cwd)は、いずれも実行前から予測可能なパスだった。同一PC上の
// 別プロセス・別ユーザーがそのパスへ先回りしてsymlinkを設置しておくと、書き込み先や
// 作業ディレクトリが攻撃者制御下に化ける(H-4/M-8、docs/audits/2026-08-13-security-audit.md
// で実機PoCにより確認済み)。
//
// P1-18-A: concatClipsが使う一時ファイルパスが実行のたびに予測不能で、先回りされた
//   symlinkの先を書き換えない。
// P1-18-B: createIsolatedCwdが返す作業ディレクトリが実行のたびに予測不能で、先回りされた
//   symlinkの先を作業場所として使わない。
// 対照: このテストの手法が「攻撃を検出できる」こと自体を、旧実装相当のコードに対して
//   確認する(このファイル内でsymlink攻撃を模したミニ実装を再現し、検出できることを示す)。
//
// 実行: node tests/security-tmpdir-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { concatClips } from "../src/concat.mjs";
import { createIsolatedCwd } from "../src/claude-safety.mjs";

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

// TMPDIR を専用ディレクトリへ差し替える(本物の/tmpを汚さない・他プロセスと衝突しない)。
// os.tmpdir()はプロセス起動時に一度だけTMPDIR環境変数を評価するのではなく、
// 呼び出しのたびにprocess.env.TMPDIRを参照するため、ここで差し替えれば以降の
// os.tmpdir()呼び出し(concat.mjs/claude-safety.mjs内)にも反映される。
const sandboxTmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-security-tmpdir-check-"));
const originalTmpdir = process.env.TMPDIR;
process.env.TMPDIR = sandboxTmp;

function resetSandbox() {
  fs.rmSync(sandboxTmp, { recursive: true, force: true });
  fs.mkdirSync(sandboxTmp, { recursive: true });
}

try {
  // ── P1-18-A: concatClips の一時ファイルパスが予測不能 ──────────
  {
    resetSandbox();
    // 旧実装は vs-concat-${pid}-${clips.length}.txt という、pidと本数だけで決まる名前だった。
    // 攻撃者は自分のプロセスから見えるこのプロセスのpidを知ることができるため、
    // clips.length(この呼び出しでは2)だけ分かれば、事前に的中する名前でsymlinkを張れる。
    const victimFile = path.join(sandboxTmp, "victim-concat-target.txt");
    fs.writeFileSync(victimFile, "ORIGINAL CONTENT - must not change");
    const predictedOldPath = path.join(sandboxTmp, `vs-concat-${process.pid}-2.txt`);
    fs.symlinkSync(victimFile, predictedOldPath);

    // 実クリップ(空ファイルで十分。concatClipsはffmpeg実行前に一時ファイルへリストを書く)
    const c1 = path.join(sandboxTmp, "clip1.mp4");
    const c2 = path.join(sandboxTmp, "clip2.mp4");
    fs.writeFileSync(c1, Buffer.alloc(10));
    fs.writeFileSync(c2, Buffer.alloc(10));
    const outPath = path.join(sandboxTmp, "out.mp4");

    try {
      concatClips([c1, c2], outPath);
    } catch (_) {
      // ffmpegが偽mp4の中身を理由に失敗するのは想定内(検証したいのは一時ファイルの
      // 書き込み先であって、ffmpegの成否ではない)。
    }

    const victimAfter = fs.readFileSync(victimFile, "utf-8");
    report(
      "P1-18-A: 予測される旧パスへ先回りしたsymlinkの先(被害者ファイル)が書き換わらない",
      victimAfter === "ORIGINAL CONTENT - must not change",
      `victim file content changed to: ${victimAfter.slice(0, 80)}`,
    );

    // 注意: concatClipsは正常終了・異常終了いずれでも一時ファイルをfinallyで削除するため、
    // 呼び出し後にディレクトリを見ても「実際に使った一時ファイル名」自体は残っていない
    // (=事前に設置したsymlinkだけが残る)。そのため一時ファイル名の直接確認はできないが、
    // 上の「symlinkの先(被害者ファイル)が書き換わっていない」ことが、concatClipsが
    // 予測可能パス(symlink設置箇所)を一切使わなかったことの十分な証拠になる。
  }

  // ── 対照: 予測可能な命名だと、この検査手法自体は攻撃を検出できる ──
  {
    resetSandbox();
    const victimFile = path.join(sandboxTmp, "victim-concat-target-control.txt");
    fs.writeFileSync(victimFile, "ORIGINAL CONTENT - control case");
    const predictablePath = path.join(sandboxTmp, `vs-concat-${process.pid}-2.txt`);
    fs.symlinkSync(victimFile, predictablePath);

    // 旧実装相当: pid+本数だけで決まる名前へ直接書き込む(concat.mjsの現行実装は使わない)。
    fs.writeFileSync(predictablePath, "attacker-controlled overwrite", "utf-8");
    const victimAfter = fs.readFileSync(victimFile, "utf-8");
    report(
      "対照: 予測可能な命名(旧実装相当)を模すと、symlink先が書き換わることをこの検査手法で検出できる",
      victimAfter === "attacker-controlled overwrite",
      `victim file content: ${victimAfter.slice(0, 80)}`,
    );
  }

  // ── P1-18-B: createIsolatedCwd が予測不能なパスを返す ───────────
  {
    resetSandbox();
    // 旧実装は os.tmpdir()/video-shorts-claude-cwd という固定名の親ディレクトリを
    // mkdirSync(recursive:true)で作っていた。この固定パスへ先回りしてsymlinkを設置する。
    const attackerControlled = fs.mkdtempSync(path.join(sandboxTmp, "attacker-controlled-"));
    const oldFixedParent = path.join(sandboxTmp, "video-shorts-claude-cwd");
    fs.symlinkSync(attackerControlled, oldFixedParent);

    const jobId = "victim-job-security-check";
    const cwd = createIsolatedCwd(jobId);
    const realCwd = fs.realpathSync(cwd);
    const realAttacker = fs.realpathSync(attackerControlled);

    report(
      "P1-18-B: createIsolatedCwdが返す実体パスが、先回りされたsymlinkの先(攻撃者制御ディレクトリ)を指さない",
      !(realCwd === realAttacker || realCwd.startsWith(realAttacker + path.sep)),
      `realCwd=${realCwd} attackerDir=${realAttacker}`,
    );
    report(
      "P1-18-B: 固定名の親ディレクトリ(video-shorts-claude-cwd)が使われていない",
      !fs.existsSync(oldFixedParent) || fs.realpathSync(oldFixedParent) !== fs.realpathSync(path.dirname(realCwd)),
      `cwd parent実体=${fs.realpathSync(path.dirname(realCwd))}`,
    );
  }

  // ── 対照: 固定名の親ディレクトリを模すと、この検査手法で先回りが検出できる ──
  {
    resetSandbox();
    const attackerControlled = fs.mkdtempSync(path.join(sandboxTmp, "attacker-controlled-ctrl-"));
    const fixedParent = path.join(sandboxTmp, "video-shorts-claude-cwd-control");
    fs.symlinkSync(attackerControlled, fixedParent);

    // 旧実装相当: 固定名の親ディレクトリを直接使う(claude-safety.mjsの現行実装は使わない)。
    const jobId = "control-job";
    const oldStyleDir = path.join(fixedParent, String(jobId));
    fs.mkdirSync(oldStyleDir, { recursive: true });
    const realOldStyle = fs.realpathSync(oldStyleDir);
    const realAttacker = fs.realpathSync(attackerControlled);
    report(
      "対照: 固定名の親ディレクトリ(旧実装相当)を模すと、攻撃者制御下を指すことをこの検査手法で検出できる",
      realOldStyle === realAttacker || realOldStyle.startsWith(realAttacker + path.sep),
      `realOldStyle=${realOldStyle} attackerDir=${realAttacker}`,
    );
  }
} finally {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  fs.rmSync(sandboxTmp, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
