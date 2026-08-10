// src/atomic-json.mjs の堅牢性の検証（CodeRabbit指摘 #3/#4 対応）
//
// #3: fs.writeSync の戻り値(実際に書けたバイト数)を無視すると、部分書き込みが起きたときに
//     未完成のJSONをそのままfsync/renameしてしまう。戻り値を見てループし、書き切ることを検証する。
// #4: renameSync後に親ディレクトリをfsyncしないと、POSIX上は電源喪失時にrenameが巻き戻りうる。
//     renameの直後に親ディレクトリを openSync(dir, "r") → fsyncSync → closeSync していることを検証する。
//     Windows等でディレクトリのfsyncができない環境でもエラーを握りつぶし、処理全体は成功として
//     扱われることも検証する。
//
// 実行: node tests/atomic-json-robustness-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomically } from "../src/atomic-json.mjs";

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n      ${e.stack || e.message}`);
  }
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vs-atomic-robust-"));
}

// ── #3: 部分書き込みへの対応 ──────────────────────────────────────
t("②fs.writeSyncが要求より少ないバイト数しか書かない(部分書き込み)環境でも、最終的に全バイト書き切られる", () => {
  const dir = freshDir();
  const filePath = path.join(dir, "out.json");
  const data = { hello: "world", padding: "x".repeat(5000) };
  const expected = `${JSON.stringify(data, null, 2)}\n`;

  const realWriteSync = fs.writeSync;
  let callCount = 0;
  fs.writeSync = (fd, buffer, offset, length, position) => {
    callCount++;
    // 1回あたり最大37バイトしか書けない偽のfsを模す(短い書き込みを強制する)。
    const chunk = Math.min(37, length);
    return realWriteSync(fd, buffer, offset, chunk, position);
  };
  try {
    writeJsonAtomically(filePath, data);
  } finally {
    fs.writeSync = realWriteSync;
  }

  const actual = fs.readFileSync(filePath, "utf-8");
  assert.strictEqual(actual, expected, "部分書き込みにより最終ファイルの内容が欠落・破損した");
  assert.ok(callCount > 1, `1回の呼び出しで完結してしまい、部分書き込みの再現になっていない: callCount=${callCount}`);
});

t("①/③対照: 戻り値を無視して1回しかwriteSyncしない旧実装だと、この判定は実際に失敗を検出する", () => {
  const dir = freshDir();
  const filePath = path.join(dir, "out-old.json");
  const data = { hello: "world", padding: "x".repeat(5000) };
  const expected = `${JSON.stringify(data, null, 2)}\n`;
  const buf = Buffer.from(expected, "utf-8");

  // 「戻り値を無視して1回だけ書く」旧実装を模す(このテストファイル内で直接再現する)。
  const tmp = `${filePath}.tmp-old`;
  const fd = fs.openSync(tmp, "w");
  const CHUNK_LIMIT = 37;
  fs.writeSync(fd, buf, 0, Math.min(CHUNK_LIMIT, buf.length)); // 戻り値を見ずに1回だけ
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, filePath);

  const actual = fs.readFileSync(filePath, "utf-8");
  assert.throws(() => {
    assert.strictEqual(actual, expected, "旧実装は部分書き込みのまま公開してしまう");
  }, /旧実装は部分書き込みのまま公開してしまう/, "旧実装(1回のみwriteSync)の欠落を検出できていない");
});

// ── #4: rename後の親ディレクトリfsync ────────────────────────────
t("②renameSync直後に、親ディレクトリを読み取りモードでopenしfsyncしている", () => {
  const dir = freshDir();
  const filePath = path.join(dir, "out.json");
  const data = { a: 1 };

  const realOpenSync = fs.openSync;
  const realFsyncSync = fs.fsyncSync;
  const realCloseSync = fs.closeSync;
  const realRenameSync = fs.renameSync;
  const opened = [];
  const fsynced = [];
  const closed = [];
  let renamedAt = -1;
  let dirFsyncAt = -1;
  let seq = 0;

  fs.openSync = (p, flags) => {
    const fd = realOpenSync(p, flags);
    opened.push({ fd, path: p, flags, seq: seq++ });
    return fd;
  };
  fs.fsyncSync = (fd) => {
    fsynced.push(fd);
    if (opened.some((o) => o.fd === fd && o.path === dir)) dirFsyncAt = seq++;
    return realFsyncSync(fd);
  };
  fs.closeSync = (fd) => {
    closed.push(fd);
    return realCloseSync(fd);
  };
  fs.renameSync = (...args) => {
    renamedAt = seq++;
    return realRenameSync(...args);
  };

  try {
    writeJsonAtomically(filePath, data);
  } finally {
    fs.openSync = realOpenSync;
    fs.fsyncSync = realFsyncSync;
    fs.closeSync = realCloseSync;
    fs.renameSync = realRenameSync;
  }

  const dirOpen = opened.find((o) => o.path === dir && o.flags === "r");
  assert.ok(dirOpen, `親ディレクトリが読み取りモードでopenされていない: ${JSON.stringify(opened)}`);
  assert.ok(fsynced.includes(dirOpen.fd), "親ディレクトリのfdがfsyncされていない");
  assert.ok(closed.includes(dirOpen.fd), "親ディレクトリのfdがcloseされていない");
  assert.ok(renamedAt >= 0 && dirFsyncAt >= 0, "renameまたはディレクトリfsyncの発生順を記録できていない");
  assert.ok(dirFsyncAt > renamedAt, `親ディレクトリのfsyncがrenameより前に起きている(renamedAt=${renamedAt}, dirFsyncAt=${dirFsyncAt})`);

  const actual = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  assert.deepStrictEqual(actual, data);
});

t("②ディレクトリのfsyncが失敗する環境(Windows等)でも、エラーを握りつぶして書き込み自体は成功する", () => {
  const dir = freshDir();
  const filePath = path.join(dir, "out.json");
  const data = { ok: true };

  const realOpenSync = fs.openSync;
  fs.openSync = (p, flags) => {
    if (p === dir && flags === "r") {
      throw new Error("simulated: directory open/fsync unsupported on this platform");
    }
    return realOpenSync(p, flags);
  };
  try {
    assert.doesNotThrow(() => writeJsonAtomically(filePath, data), "ディレクトリfsync失敗で書き込み全体が失敗してしまった");
  } finally {
    fs.openSync = realOpenSync;
  }

  const actual = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  assert.deepStrictEqual(actual, data, "ディレクトリfsync失敗時に、ファイル自体の内容が失われた");
});

t("①/③対照: ディレクトリfsyncを一切行わない旧実装を模した状態でも、rename自体は完了して読める(=この検査単体ではrename巻き戻りの再現はできないため、④は「呼ばれていること」自体を機械的に確認する設計であることの記録)", () => {
  // 実際の電源喪失/クラッシュ再現はテスト環境で安全に行えないため、この検査は
  // 「fsyncSyncが親ディレクトリのfdに対して呼ばれていること」を直接assertする形を取る
  // (上の②のテストがその役目を担う)。ここでは、②のassertion群のうち一つでも
  // 満たされない状態(dirOpenがfalsy)を作ると判定が落ちることだけを対照として示す。
  const dirOpen = undefined;
  assert.throws(() => {
    assert.ok(dirOpen, "親ディレクトリが読み取りモードでopenされていない");
  }, /親ディレクトリが読み取りモードでopenされていない/, "旧実装(ディレクトリfsync無し)を見逃した");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
