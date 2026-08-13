// AUD-P2-18a: python3コマンドが存在せずpythonコマンドのみ存在する環境で、既定のテスト
// コマンド内のPython検査がpython3固定起動によって失敗しないことの検証。
// 実行: node tests/py-launcher-fallback-check.mjs
//
// 修正前: package.jsonのtestスクリプトが `python3 tests/foo.py` をハードコードしており、
// python3という名前のコマンドが無い環境(Windowsは既定でpythonのみのことが多い)では
// 全滅していた。
// 修正後: scripts/py.mjs が python3 → python の順にPATH上を探し、見つかった方へ
// そのまま引数を渡す。package.jsonのtestスクリプトは `node scripts/py.mjs tests/foo.py`
// を使うよう統一した。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.dirname(HERE);
const LAUNCHER = path.join(PKG_ROOT, "scripts", "py.mjs");

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? `\n      ${detail}` : ""}`); }
}

/** PATH上に python3 / python のどちらを置くかを選べる、実際に動く最小限のPython身代わりを作る。 */
function makeFakeBinDir({ python3Present, pythonPresent }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "py-launcher-fake-bin-"));
  const body = `#!/bin/bash\nif [ "$1" = "PROBE_OK" ]; then echo "PROBE_OK from $0"; exit 0; fi\nexit 3\n`;
  if (python3Present) {
    fs.writeFileSync(path.join(dir, "python3"), body);
    fs.chmodSync(path.join(dir, "python3"), 0o755);
  }
  if (pythonPresent) {
    fs.writeFileSync(path.join(dir, "python"), body);
    fs.chmodSync(path.join(dir, "python"), 0o755);
  }
  return dir;
}

function runLauncherWithPath(fakeBinDir) {
  // 実PATH上に既に本物のpython3/pythonがあっても、身代わりディレクトリだけを見るよう
  // PATHを完全に置き換える(本物が紛れ込むと「python3が無い環境」を再現できないため)。
  // node自身はPATH経由ではなくprocess.execPath(絶対パス)で直接起動する
  // (PATHをfakeBinDirだけへ絞るとnodeコマンド自体がENOENTになってしまうため)。
  const env = { ...process.env, PATH: fakeBinDir };
  return spawnSync(process.execPath, [LAUNCHER, "PROBE_OK"], { env, encoding: "utf-8" });
}

// ── (1) python3のみ存在(通常のLinux環境相当) ──
{
  const dir = makeFakeBinDir({ python3Present: true, pythonPresent: false });
  const r = runLauncherWithPath(dir);
  report(
    "python3のみ存在する環境で、python3経由の実行に成功する",
    r.status === 0 && r.stdout.includes("PROBE_OK") && r.stdout.includes("/python3"),
    `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── (2) python3が無く、pythonのみ存在(Windowsで典型的な環境) ──
{
  const dir = makeFakeBinDir({ python3Present: false, pythonPresent: true });
  const r = runLauncherWithPath(dir);
  report(
    "python3が無くpythonのみ存在する環境でも、pythonへフォールバックして実行に成功する(修正前はここで全滅していた)",
    r.status === 0 && r.stdout.includes("PROBE_OK") && r.stdout.includes(path.sep + "python") && !r.stdout.includes("python3"),
    `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 対照: python3を直接ハードコード起動する(旧実装相当)は、python3が無い環境で失敗する ──
{
  const dir = makeFakeBinDir({ python3Present: false, pythonPresent: true });
  const env = { ...process.env, PATH: dir };
  const r = spawnSync("python3", ["PROBE_OK"], { env, encoding: "utf-8" });
  report(
    "対照: python3固定起動(旧実装相当)は、pythonのみの環境でENOENTにより失敗する",
    r.error && r.error.code === "ENOENT",
    `error=${r.error} status=${r.status}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── (3) どちらも無い場合は、理由の分かるメッセージで明確に失敗する(黙って通らない) ──
{
  const dir = makeFakeBinDir({ python3Present: false, pythonPresent: false });
  const r = runLauncherWithPath(dir);
  report(
    "python3もpythonも無い場合は、exit 127かつ理由の分かるエラーメッセージで失敗する",
    r.status === 127 && /python3.*python/.test(r.stderr || ""),
    `status=${r.status} stderr=${r.stderr}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
