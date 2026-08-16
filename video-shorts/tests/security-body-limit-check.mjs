// JSON系エンドポイントのボディ上限の検証 — P1-13-A/B
//
// server/index.mjs の readBody() は、以前はContent-Lengthも累積受信バイト数も見ずに
// ボディ全量をメモリへ連結していた(H-1、docs/audits/2026-08-13-security-audit.md)。
// PUT /api/jobs/:id/captions と POST /api/jobs/:id/terms が対象。実機PoCで、正規に
// 発行したjobTokenを使い80MBのJSONボディを送信したところ413等の拒否なく全量受信された
// ことを確認した。
//
// P1-13-A: 上限超のボディが413で拒否されること。
// P1-13-B: 413を返す前に、全量がメモリへ溜め込まれない(ピークRSSが上限の数倍以内)こと。
//   全量バッファしてからJSON.parse失敗で400/413を返す偽実装でもP1-13-Aは通ってしまうため、
//   ピークメモリを実測して区別する。
//
// 実行: node tests/security-body-limit-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { MAX_JSON_BODY_BYTES, hashToken } from "../server/security.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 59198; // このテスト専用の固定ポート(他のchild-process系テストと衝突しない)
const JOB_ID = "security-body-limit-check-job";
const JOB_TOKEN = "security-body-limit-check-token";
const WORK_DIR = path.join(ROOT, "work", JOB_ID);

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
    });
    let buf = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("server起動タイムアウト")); }, 30000);
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

/**
 * 指定バイト数の"text"フィールドを持つJSONボディをPUT /api/jobs/:id/captionsへ送り、
 * レスポンスとピークRSSを返す。filler(既定"A")を繰り返してtextの長さを作る。
 */
function readRss(pid) {
  try {
    const statm = fs.readFileSync(`/proc/${pid}/statm`, "utf-8");
    const pages = Number(statm.split(" ")[1]); // resident pages
    return pages * 4096; // ページサイズ4KB前提(Linux既定)
  } catch (_) {
    return null;
  }
}

/**
 * 指定バイト数の"text"フィールドを持つJSONボディをPUT /api/jobs/:id/captionsへ送り、
 * レスポンスと送信中のRSS増分(ピーク-送信開始前)を返す。filler(既定"A")を繰り返して
 * textの長さを作る。slowWriteMs>0 のときはチャンク間に意図的な間隔を空けて送信し、
 * RSSサンプリングが送信中の状態を捉えられるようにする(高速なloopback通信では
 * 一瞬で送受信が終わり、ポーリングが1回もヒットしないことがあるため)。
 */
function putBigCaptions(childPid, sizeBytes, filler = "A", slowWriteMs = 0) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ index: 0, text: filler.repeat(sizeBytes) });
    const buf = Buffer.from(payload, "utf-8");
    const baselineRss = readRss(childPid) ?? 0;
    let peakRss = baselineRss;
    let settled = false;
    const rssTimer = setInterval(() => {
      const rss = readRss(childPid);
      if (rss !== null && rss > peakRss) peakRss = rss;
    }, 3);

    function finish(result, err) {
      if (settled) return;
      settled = true;
      // レスポンス直後の一瞬だけ、まだ解放前のメモリ状態を数回追加サンプリングしてから確定する。
      let extra = 0;
      const grace = setInterval(() => {
        const rss = readRss(childPid);
        if (rss !== null && rss > peakRss) peakRss = rss;
        if (++extra >= 5) {
          clearInterval(grace);
          clearInterval(rssTimer);
          if (err) reject(err);
          else resolve({ ...result, peakRssDelta: Math.max(0, peakRss - baselineRss) });
        }
      }, 3);
    }

    const req = http.request({
      host: "127.0.0.1", port: PORT,
      path: `/api/jobs/${JOB_ID}/captions?jobToken=${JOB_TOKEN}`,
      method: "PUT", timeout: 20000,
      headers: {
        host: `127.0.0.1:${PORT}`,
        "Content-Type": "application/json",
        "Content-Length": buf.length,
      },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => finish({ status: res.statusCode, body: out, sentBytes: buf.length }));
    });
    req.on("timeout", () => { req.destroy(); finish(null, new Error("request timeout")); });
    req.on("error", (e) => finish(null, e));
    // 一度に書き切らず小分けに書く(受信側のストリーミング処理をRSSサンプリングで観測できるようにする)
    const CHUNK = 256 * 1024;
    let offset = 0;
    function writeNext() {
      if (settled) return;
      if (offset >= buf.length) return req.end();
      const end = Math.min(offset + CHUNK, buf.length);
      let ok;
      try {
        ok = req.write(buf.subarray(offset, end));
      } catch (_) {
        return; // ソケットが既に閉じている等。errorイベント側で処理済み。
      }
      offset = end;
      if (slowWriteMs > 0) {
        setTimeout(writeNext, slowWriteMs);
      } else if (ok) {
        setImmediate(writeNext);
      } else {
        req.once("drain", writeNext);
      }
    }
    writeNext();
  });
}

function prepareJob() {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.writeFileSync(path.join(WORK_DIR, "job-token.txt"), hashToken(JOB_TOKEN), "utf-8");
  fs.writeFileSync(
    path.join(WORK_DIR, "transcript.json"),
    JSON.stringify({ words: [{ w: "テスト", start: 0, end: 0.5 }], segments: [] }),
    "utf-8",
  );
}

let server = null;
try {
  prepareJob();
  const started = await startServer();
  server = started.child;

  // ── 対照: 上限以下の正常なボディは従来どおり処理される ──────────
  // text は1語40文字までのバリデーション(saveWordEdit)があるため、サイズ確認には別途
  // 上限すれすれの巨大textを使う(下のP1-13-A/Bケース)。ここでは純粋に「本文サイズ上限の
  // 仕組みそのものが、正常なリクエストまで巻き込んで拒否していないか」だけを見る。
  {
    const r = await putBigCaptions(server.pid, 5, "あ");
    report("対照: 上限以下の正常なボディは200で受理される", r.status === 200, `status=${r.status} ${r.body.slice(0, 200)}`);
  }

  // ── P1-13-A: 上限超のボディは413で拒まれる ────────────────────
  {
    const oversizeBytes = MAX_JSON_BODY_BYTES + 10 * 1024; // 上限を10KB超過
    const r = await putBigCaptions(server.pid, oversizeBytes);
    report("P1-13-A: 上限を超えるJSONボディ(PUT captions)は413で拒否される", r.status === 413, `status=${r.status} ${r.body.slice(0, 200)}`);
  }

  // ── P1-13-B: 上限を大きく超えるボディでも、受信中のRSS増分が跳ねない ──
  {
    const hugeBytes = MAX_JSON_BODY_BYTES * 20; // 上限の20倍
    // チャンク間に3msの間隔を空け、高速なloopback通信でも送信中の状態をRSSサンプリングで
    // 捉えられるようにする(間隔無しだと送受信が一瞬で終わりサンプルが1つも取れないことがある)。
    const r = await putBigCaptions(server.pid, hugeBytes, "A", 3);
    report("P1-13-B前提: 上限の20倍のボディでも413で拒否される", r.status === 413, `status=${r.status}`);
    // RSS増分が「送信量に比例して増える全量バッファ実装」なら、20MBのボディで
    // 数十MB規模のRSS増加が起きるはず。ストリーミングで打ち切る実装なら
    // 上限バイト数(MAX_JSON_BODY_BYTES)の数倍以内(ここでは10倍を閾値とする)に収まる。
    const threshold = MAX_JSON_BODY_BYTES * 10;
    report(
      "P1-13-B: 受信中のRSS増分が上限バイト数の10倍以内に収まる(全量バッファしていない)",
      r.peakRssDelta < threshold,
      `peakRssDelta=${r.peakRssDelta}バイト threshold=${threshold}バイト sentBytes=${r.sentBytes}`,
    );
  }

  // ── POST /api/jobs/:id/terms も同じ上限が効く ──────────────────
  {
    const oversizeBytes = MAX_JSON_BODY_BYTES + 1024;
    const payload = JSON.stringify({ before: "A".repeat(oversizeBytes), after: "テスト" });
    const buf = Buffer.from(payload, "utf-8");
    const r = await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1", port: PORT,
        path: `/api/jobs/${JOB_ID}/terms?jobToken=${JOB_TOKEN}`,
        method: "POST", timeout: 15000,
        headers: {
          host: `127.0.0.1:${PORT}`,
          "Content-Type": "application/json",
          "Content-Length": buf.length,
        },
      }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode, body: out }));
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.write(buf);
      req.end();
    });
    report("P1-13-A: 上限を超えるJSONボディ(POST terms)も413で拒否される", r.status === 413, `status=${r.status} ${r.body.slice(0, 200)}`);
  }
} finally {
  await stopServer(server);
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
