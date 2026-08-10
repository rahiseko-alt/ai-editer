// 字幕の手直しの操作口の検証 — G-EDIT-CAPTION-E（および A の HTTP 経路）
//
// E の合格条件は「字幕保存・焼き直し・辞書追記の各口が、合言葉なし・他サイト由来・
// 他人のジョブIDのいずれでも失敗する」。
// 便利にした結果として他人のジョブを書き換えられる穴を開けないための関門で、
// 関数を直接呼ぶだけでは通らない（ルーティングの関門を通していないため）。
// 実プロセスを起動し、本物の HTTP で叩いて確かめる。
//
// 「失敗する」だけでは足りない。失敗を返しつつ書き込みだけ済ませる実装でも通ってしまうので、
// 副作用（保存も追記も起きていないこと）まで毎回確かめる。
//
// 実行: node tests/caption-api-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { EDITS_FILE } from "../src/caption-store.mjs";
import { DICT_PATH, readDictionary } from "../src/term-dictionary.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 59187;                       // このテスト専用の固定ポート
const JOB_ID = "caption-api-check-job";
const OTHER_JOB_ID = "caption-api-check-other";
const JOB_TOKEN = "caption-api-check-token";
const OTHER_TOKEN = "caption-api-check-other-token";
const WORK_DIR = path.join(ROOT, "work", JOB_ID);
const OTHER_WORK_DIR = path.join(ROOT, "work", OTHER_JOB_ID);
// 本物の用語辞書は絶対に書き換えない。写しをサーバーへ使わせる。
// この辞書は全ジョブに単純文字列置換で効くので、テストの語が入ると以後の全案件で誤爆する。
// 実際、関門を外す攻撃を試したときに本物へ書き込まれた（2026-08-08）。
const TEST_DICT = path.join(ROOT, "work", `${JOB_ID}-term-corrections.json`);

const WORDS = [
  { w: "きょうは", start: 0.0, end: 0.4 },
  { w: "追患版", start: 0.4, end: 0.9 },
  { w: "の", start: 0.9, end: 1.0 },
  { w: "はなしです", start: 1.0, end: 1.6 },
];

/** 認可で拒まれたか。「400番台なら何でもよい」にしてはいけない。
 * 関門を外しても、別の理由（材料が無い等）で 500 が返れば合格になってしまう。
 * 実際、焼き直しの口で関門を外したときに素通りした（2026-08-08）。 */
function rejected(r) {
  return r.status === 401 || r.status === 403;
}

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), VS_TERM_DICT: TEST_DICT },
    });
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server起動タイムアウト")), 8000);
    child.stderr.on("data", (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/startup token[^:]*:\s*([0-9a-f]+)/);
      if (m && /listening/.test(buf)) {
        clearTimeout(timer);
        resolve({ child, token: m[1] });
      }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(resolve, 2000);
  });
}

/** 本物の HTTP で叩く。headers を差し替えられるようにして Origin なども試す。 */
function call(method, pathAndQuery, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf-8");
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: pathAndQuery, method, timeout: 8000,
      headers: {
        host: `127.0.0.1:${PORT}`,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** ジョブの作業フォルダを、文字起こしまで終わった状態で用意する */
function prepareJob(dir, token) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job-token.txt"), token, "utf-8");
  fs.writeFileSync(
    path.join(dir, "transcript.json"),
    JSON.stringify({ words: WORDS, segments: [] }, null, 2), "utf-8",
  );
}

function editsOf(dir) {
  const p = path.join(dir, EDITS_FILE);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null;
}

let server = null;
try {
  fs.mkdirSync(path.dirname(TEST_DICT), { recursive: true });
  fs.copyFileSync(DICT_PATH, TEST_DICT);
  prepareJob(WORK_DIR, JOB_TOKEN);
  prepareJob(OTHER_WORK_DIR, OTHER_TOKEN);
  const started = await startServer();
  server = started.child;

  const auth = `?jobToken=${JOB_TOKEN}`;
  const capPath = `/api/jobs/${JOB_ID}/captions`;
  const termPath = `/api/jobs/${JOB_ID}/terms`;
  const recapPath = `/api/jobs/${JOB_ID}/recaption`;
  const dictBefore = readDictionary(TEST_DICT);

  // ── 正常系（対照）: 合言葉が正しければ通り、実際に保存される ──
  // これが無いと「常に失敗を返す実装」でも E の検査が全部通ってしまう。
  {
    const r = await call("GET", capPath + auth);
    report("対照: 正しい合言葉なら字幕を読める", r.status === 200, `status=${r.status}`);
    const body = JSON.parse(r.body || "{}");
    report("対照: 直す前の語が読める", body.words && body.words[1] && body.words[1].w === "追患版",
      JSON.stringify(body.words && body.words[1]));
  }
  {
    const r = await call("PUT", capPath + auth, { body: { index: 1, text: "椎間板" } });
    report("対照: 正しい合言葉なら字幕を保存できる", r.status === 200, `status=${r.status} ${r.body}`);
    report("対照: 保存がファイルに残っている",
      JSON.stringify(editsOf(WORK_DIR)?.words) === JSON.stringify({ 1: "椎間板" }),
      JSON.stringify(editsOf(WORK_DIR)));
  }
  {
    const r = await call("GET", capPath + auth);
    const body = JSON.parse(r.body || "{}");
    report("A: 読み直すと直した語が返り、直す前の語も分かる",
      body.words?.[1]?.w === "椎間板" && body.words?.[1]?.original === "追患版" && body.words?.[1]?.edited === true,
      JSON.stringify(body.words?.[1]));
    report("C の入力: 修正前→修正後の対が返る",
      JSON.stringify(body.pairs) === JSON.stringify([{ index: 1, before: "追患版", after: "椎間板" }]),
      JSON.stringify(body.pairs));
  }

  // ── E: 3つの口 × 3通りの拒み方 ─────────────────────────────
  const gates = [
    { name: "字幕を読む", method: "GET", path: capPath, body: undefined },
    { name: "字幕を保存する", method: "PUT", path: capPath, body: { index: 2, text: "ノ" } },
    { name: "辞書へ追記する", method: "POST", path: termPath, body: { before: "ごへんかん", after: "誤変換" } },
    { name: "字幕を焼き直す", method: "POST", path: recapPath, body: {} },
  ];
  for (const g of gates) {
    // (1) 合言葉を付けない
    {
      const before = JSON.stringify(editsOf(WORK_DIR));
      const r = await call(g.method, g.path, { body: g.body });
      report(`E: ${g.name} — 合言葉なしでは認可で拒まれる`, rejected(r), `status=${r.status} ${r.body}`);
      report(`E: ${g.name} — 合言葉なしでは副作用も残らない`,
        JSON.stringify(editsOf(WORK_DIR)) === before
        && JSON.stringify(readDictionary(TEST_DICT)) === JSON.stringify(dictBefore));
    }
    // (2) 許可されていない他サイト由来
    {
      const before = JSON.stringify(editsOf(WORK_DIR));
      const r = await call(g.method, g.path + auth, {
        body: g.body, headers: { Origin: "https://evil.example" },
      });
      report(`E: ${g.name} — 他サイト由来では認可で拒まれる`, rejected(r), `status=${r.status} ${r.body}`);
      report(`E: ${g.name} — 他サイト由来では副作用も残らない`,
        JSON.stringify(editsOf(WORK_DIR)) === before
        && JSON.stringify(readDictionary(TEST_DICT)) === JSON.stringify(dictBefore));
    }
    // (3) 他人のジョブの合言葉で、こちらのジョブを叩く
    {
      const before = JSON.stringify(editsOf(WORK_DIR));
      const r = await call(g.method, `${g.path}?jobToken=${OTHER_TOKEN}`, { body: g.body });
      report(`E: ${g.name} — 他人の合言葉では認可で拒まれる`, rejected(r), `status=${r.status} ${r.body}`);
      report(`E: ${g.name} — 他人の合言葉では副作用も残らない`,
        JSON.stringify(editsOf(WORK_DIR)) === before
        && JSON.stringify(readDictionary(TEST_DICT)) === JSON.stringify(dictBefore));
    }
  }

  // ── 対照: 許可された Origin なら通る（Origin 検査が全部拒む実装ではない） ──
  {
    const r = await call("GET", capPath + auth, { headers: { Origin: `http://127.0.0.1:${PORT}` } });
    report("対照: 許可された自サイト由来なら通る", r.status === 200, `status=${r.status}`);
  }

  // ── 受け付けない直しは 400 で、理由が返る ────────────────────
  {
    const before = JSON.stringify(editsOf(WORK_DIR));
    const r = await call("PUT", capPath + auth, { body: { index: 99, text: "あ" } });
    const body = JSON.parse(r.body || "{}");
    report("A: 範囲の外の位置は 400 で理由が返る",
      r.status === 400 && typeof body.error === "string" && body.error.length > 0,
      `status=${r.status} ${r.body}`);
    report("A: 受け付けなかったときは保存も起きない", JSON.stringify(editsOf(WORK_DIR)) === before);
  }
  {
    const r = await call("POST", termPath + auth,
      { body: { before: "これは 文です", after: "これは文です" } });
    const body = JSON.parse(r.body || "{}");
    report("C: 文まるごとは 400 で理由が返る",
      r.status === 400 && typeof body.error === "string" && body.error.length > 0,
      `status=${r.status} ${r.body}`);
    report("C: 断る理由が語の形の話である（黙って捨てない）",
      typeof body.error === "string" && body.error.includes("1語"),
      `理由=${body.error}`);
    report("C: 辞書は変わっていない",
      JSON.stringify(readDictionary(TEST_DICT)) === JSON.stringify(dictBefore));
  }
  {
    // 正常系（対照）: 正しく直せば実際に登録される。
    // これが無いと「何を出しても断る」実装でも上の検査が全部通ってしまう。
    const r = await call("POST", termPath + auth,
      { body: { before: "追患版", after: "椎間板" } });
    const body = JSON.parse(r.body || "{}");
    // 既存の辞書に「追患版」→「椎間板」が既にあるので、断り方は「すでに登録済み」になる。
    // 断られること自体ではなく、その理由が「形が悪い」でも「どの語か分からない」でもないことを見る。
    report("対照: 正しい語なら、語の形の判定で断られない",
      r.status === 400 && typeof body.error === "string" && body.error.includes("すでに"),
      `status=${r.status} ${r.body}`);
    report("対照: 載る鍵が、直した語そのものである",
      body.before === "追患版", `before=${body.before}`);
  }
} finally {
  await stopServer(server);
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.rmSync(OTHER_WORK_DIR, { recursive: true, force: true });
  fs.rmSync(TEST_DICT, { force: true });
}

// 対照: このテストが本物の用語辞書を書き換えていないこと。
// 差し替えが効いていなければここで落ちる（＝本物へ書いた事実を毎回検出できる）。
{
  const real = readDictionary(DICT_PATH);
  const dirty = ["ごへんかん", "誤変換語", "あたらしい語"].filter(
    (k) => Object.prototype.hasOwnProperty.call(real, k));
  report("対照: 本物の用語辞書をこのテストが書き換えていない", dirty.length === 0, dirty.join(", "));
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
