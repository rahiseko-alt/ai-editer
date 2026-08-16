// 遅い購読者がいてもサーバー全体のメモリが膨らみ続けないことの検証 — AUD-P2-25
//
// 旧実装(server/index.mjsのhandleJobEvents)は res.write() の戻り値(backpressure)を
// 一切見ておらず、子プロセスの出力行1つ1つを毎回無条件でres.write()していた。
// res.write()はOS送信バッファが埋まっていてもfalseを返すだけで例外にならず、内部的には
// 書き込みキューへ積み続けるため、受信の遅い購読者がいると、そのHTTPレスポンスの
// 内部バッファへ際限なく書き込みが溜まり続けサーバープロセス全体のメモリを圧迫する
// (監査指摘)。
//
// server/sse-backpressure.mjs の createBackpressureAwarePush() は、write()がfalseを
// 返したら drain イベントまで以後の push を bounded ring buffer(既定200行)へ溜め、
// OSへの実書き込み自体は行わない(coalesce・上限超は古い行から捨てる)。
//
// このテストは①決定的な単体検証(res.write()の戻り値・drainイベントを完全に制御できる
// 偽objectを使い、force-feedingが実際に止まること・bufferが本当に上限で頭打ちになる
// ことを機械的に確認する)と、②実サーバー+実TCPソケットでの結線確認(バーストを実際に
// 送り込み、遅い受信側でもサーバープロセスのメモリが際限なく膨らまないことを実測する)
// の2段構えで検証する。
//
// 実行: node tests/sse-backpressure-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createBackpressureAwarePush, DEFAULT_BACKPRESSURE_BUFFER_LINES } from "../server/sse-backpressure.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const WORK_ROOT = path.join(ROOT, "work");
const PORT = 59212; // このテスト専用の固定ポート

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

// ══════════════════════════════════════════════════════════════
// ①単体: res.write()の戻り値・drainイベントを完全に制御できる偽resで検証する
// ══════════════════════════════════════════════════════════════

/** node:http の ServerResponse のうち、createBackpressureAwarePush が使う write/on だけを
 *  持つ偽object。acceptWritesを外側から切り替えてbackpressureを再現する。 */
function makeFakeRes() {
  const emitter = new EventEmitter();
  const writes = [];
  let acceptWrites = true;
  return {
    write(line) { writes.push(line); return acceptWrites; },
    on: emitter.on.bind(emitter),
    setAccept(v) { acceptWrites = v; },
    emitDrain() { emitter.emit("drain"); },
    writes,
  };
}

{
  // ── 前提: backpressureが無ければ、これまでどおり毎回即座に書き込む ──
  const res = makeFakeRes();
  const push = createBackpressureAwarePush(res);
  for (let i = 0; i < 5; i++) push(`line${i}`);
  report(
    "前提: backpressureが無い間は、pushのたびに即座にres.write()される(回帰なし)",
    res.writes.length === 5 && !push.isPaused(),
    `writes=${res.writes.length}`
  );
}

{
  // ── AUD-P2-25核心: write()がfalseを返したら、以後drainまで書き込みを止める ──
  const res = makeFakeRes();
  res.setAccept(false); // 最初からOS送信バッファが埋まっている状態を模す
  const push = createBackpressureAwarePush(res);

  push("first-line");
  report(
    "AUD-P2-25: 最初のpushはres.write()される(戻り値がfalseでも、その1回は書き込む)",
    res.writes.length === 1 && res.writes[0] === "first-line",
    `writes=${JSON.stringify(res.writes)}`
  );
  report("AUD-P2-25: write()がfalseを返した直後、pausedになる", push.isPaused());

  // ここでさらに1000行流し込む(=「大量の進捗ログのバースト」の再現)。
  const FLOOD = 1000;
  for (let i = 0; i < FLOOD; i++) push(`flood-${i}`);

  report(
    `AUD-P2-25: pause中は追加のpush(${FLOOD}行)がres.write()を一切呼ばない` +
      "(force-feedingが止まっている＝これがこの修正の核心)",
    res.writes.length === 1,
    `writes.length=${res.writes.length}(期待=1)`
  );
  report(
    `AUD-P2-25: pause中に溜めた行数は無制限に伸びず、上限(${DEFAULT_BACKPRESSURE_BUFFER_LINES})で頭打ちになる`,
    push.bufferedLineCount() === DEFAULT_BACKPRESSURE_BUFFER_LINES,
    `buffered=${push.bufferedLineCount()}(期待=${DEFAULT_BACKPRESSURE_BUFFER_LINES})`
  );

  // ── drainで再開する。バッファは「古い行を捨てて新しい行を残す」coalesceのはず ──
  res.setAccept(true);
  res.emitDrain();
  const flushedAfterDrain = res.writes.length - 1; // 最初の1行を除く
  report(
    `AUD-P2-25: drain後、溜めていた分(上限${DEFAULT_BACKPRESSURE_BUFFER_LINES}行ぶん)が書き込まれる`,
    flushedAfterDrain === DEFAULT_BACKPRESSURE_BUFFER_LINES,
    `flushedAfterDrain=${flushedAfterDrain}`
  );
  report(
    `AUD-P2-25: coalesceは古い行から捨てる(残っているのは直近の${DEFAULT_BACKPRESSURE_BUFFER_LINES}行=flood-${FLOOD - DEFAULT_BACKPRESSURE_BUFFER_LINES}〜flood-${FLOOD - 1})`,
    res.writes[res.writes.length - 1] === `flood-${FLOOD - 1}` &&
      res.writes[1] === `flood-${FLOOD - DEFAULT_BACKPRESSURE_BUFFER_LINES}`,
    `first-flushed=${res.writes[1]} last-flushed=${res.writes[res.writes.length - 1]}`
  );
  report("AUD-P2-25: drain後はpausedが解除される", !push.isPaused());
}

{
  // ── drain中にまた即座にbackpressureへ戻るケース(flush途中でまたfalseになる) ──
  const res = makeFakeRes();
  res.setAccept(false);
  const push = createBackpressureAwarePush(res);
  push("a");
  for (let i = 0; i < 10; i++) push(`b${i}`);
  assert.strictEqual(push.bufferedLineCount(), 10);

  // drain発火時点でも送信バッファがまだ埋まっている(=最初の1回書いたらまたfalse)状況を模す。
  let writeCount = 0;
  res.write = () => {
    writeCount++;
    return writeCount === 1; // flush中の最初の1回だけ通し、2回目以降はまたbackpressure
  };
  res.emitDrain();
  // flush()は「書き込みを試みた行」をok/falseに関わらずbufferから外す(実際に
  // res.write()へ渡した=OS/Nodeの内部キューへは渡っている値のため)。ここでは
  // 1回目(true)・2回目(false)の計2行を試みた時点でfalseに当たり停止するので、
  // 10行あったバッファは2行減って8行残る。
  report(
    "AUD-P2-25: flush中に再度backpressureへ戻った場合、そこで止めて残りはバッファに留める" +
      "(全部を無理に書き切ろうとしない)",
    push.isPaused() && push.bufferedLineCount() === 8,
    `paused=${push.isPaused()} buffered=${push.bufferedLineCount()}`
  );
}

// ── 対照: 旧実装(res.write()の戻り値を見ない素朴なpush)は、pause中でも全行を
//    force-feedし続けてしまう(この検査に検出能力があることの確認) ──
{
  const res = makeFakeRes();
  res.setAccept(false);
  const naivePush = (line) => { res.write(line); }; // 旧実装相当: 戻り値を無視
  for (let i = 0; i < 500; i++) naivePush(`x${i}`);
  report(
    "対照: 戻り値を見ない旧実装は、backpressure中でも全500行をres.write()し続けてしまう" +
      "(この検査が実際に問題を検出できることの確認＝偽の緑ではない)",
    res.writes.length === 500,
    `writes.length=${res.writes.length}`
  );
}

// ══════════════════════════════════════════════════════════════
// ②実サーバー+実TCPソケット: 遅い購読者がいてもサーバーが健全なまま・
//   際限なくメモリが膨らまないことを結線レベルで確認する
// ══════════════════════════════════════════════════════════════

function installFakeFloodingPython(lineCount) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fake-flood-python-"));
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, "python");
  fs.writeFileSync(
    exe,
    `#!/usr/bin/env node\n` +
      `const fs = require("fs");\n` +
      `const transcriptPath = process.argv[4];\n` +
      // 大量の行をstderrへ一気に吐く(=大量の進捗ログのバースト)。
      `for (let i = 0; i < ${lineCount}; i++) process.stderr.write("burst line " + i + " ".repeat(200) + "\\n");\n` +
      // その後、無音(0件)のtranscriptを書いて即エラー終端させる(このテストの関心は
      // バースト自体がSSE購読者側でどう扱われるかであり、後続段は不要なため)。
      `fs.writeFileSync(transcriptPath, JSON.stringify({ words: [], segments: [] }));\n`
  );
  fs.chmodSync(exe, 0o755);
  return { binDir, home };
}

function startServer(extraPathDirs) {
  return new Promise((resolve, reject) => {
    const PATH = [...extraPathDirs, process.env.PATH].join(path.delimiter);
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), PATH },
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
function postJob(token, name) {
  const head = Buffer.alloc(16);
  head.write("ftyp", 4, "ascii");
  const buf = Buffer.concat([head, Buffer.alloc(2000, 0)]);
  const q = new URLSearchParams({ token, sub: "none", cut: "topic", size: "9:16", name }).toString();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: `/api/jobs?${q}`, method: "POST", timeout: 15000,
      headers: { host: `127.0.0.1:${PORT}`, "Content-Type": "application/octet-stream", "Content-Length": buf.length },
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
}

/** 生ソケットでSSEへ接続し、'data'を一切読まない(=受信の遅い購読者を模す)まま
 *  一定時間待ち、その間にサーバー側プロセスのRSSがどれだけ増えるかを実測する。 */
function connectSlowSubscriber(jobId, jobToken) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: PORT }, () => {
      const req =
        `GET /api/jobs/${jobId}/events?jobToken=${jobToken} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${PORT}\r\n` +
        `Connection: keep-alive\r\n\r\n`;
      socket.write(req);
      // ここで socket.pause() し、以後一切 'data' を消費しない(=受信が止まった遅い購読者)。
      // TCPの受信ウィンドウが埋まり、サーバー側の送信(res.write)もいずれ滞る。
      socket.pause();
      resolve(socket);
    });
    socket.on("error", reject);
  });
}

function rssMB(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf-8");
    const m = status.match(/VmRSS:\s*(\d+)\s*kB/);
    return m ? Number(m[1]) / 1024 : null;
  } catch (_) {
    return null; // /proc が無い環境等(このテストの②部分は結線確認の付随確認とし、
    // 取れなければ数値評価をスキップする＝①の決定的単体検証が主な受入証拠)。
  }
}

let server = null;
let createdJobId = null;
let slowSocket = null;
const fakePython = installFakeFloodingPython(20000); // 「大量の進捗ログのバースト」
try {
  const started = await startServer([fakePython.binDir]);
  server = started.child;

  const posted = await postJob(started.token, "sse-backpressure-check.mp4");
  report("前提: ジョブが受理される(202)", posted.status === 202, `status=${posted.status}`);
  const { jobId, jobToken } = JSON.parse(posted.body);
  createdJobId = jobId;

  const rssBefore = rssMB(server.pid);
  slowSocket = await connectSlowSubscriber(jobId, jobToken);

  // バースト(2万行)が流れ切る・ジョブが終端するまで待つ(受信側は止めたまま)。
  await new Promise((r) => setTimeout(r, 4000));

  report(
    "②結線: 大量バースト送出中も、受信を止めた遅い購読者に対してサーバープロセスは生存し続ける" +
      "(クラッシュ・ハングしていない)",
    !server.killed && server.exitCode === null
  );

  const rssAfter = rssMB(server.pid);
  if (rssBefore != null && rssAfter != null) {
    const growthMB = rssAfter - rssBefore;
    report(
      `②結線(実測): 遅い購読者へ2万行のバーストを送っても、サーバープロセスのRSS増加は` +
        `わずか(${growthMB.toFixed(1)}MB)に収まる(無制限バッファなら購読者1本でも` +
        `数MB〜数十MB以上膨らむ規模のバーストのはず)`,
      growthMB < 20,
      `rssBefore=${rssBefore.toFixed(1)}MB rssAfter=${rssAfter.toFixed(1)}MB growth=${growthMB.toFixed(1)}MB`
    );
  } else {
    console.log("SKIP ②結線(実測): /proc からRSSを読めない環境のためメモリ実測はスキップ(①の単体検証が主な受入証拠)");
  }
} finally {
  if (slowSocket) { try { slowSocket.destroy(); } catch (_) {} }
  await stopServer(server);
  fs.rmSync(fakePython.home, { recursive: true, force: true });
  if (createdJobId) {
    fs.rmSync(path.join(WORK_ROOT, createdJobId), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, "output", createdJobId), { recursive: true, force: true });
  }
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
