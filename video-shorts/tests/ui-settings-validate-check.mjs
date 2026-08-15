// G-EDIT-UI-SETTINGS-VALIDATE — 実サーバへ直接POST /api/jobsを叩き、range外・不正形式・欠落・
// __proto__/constructor等のプロトタイプ汚染狙いの値が8設定(subStyle/captionFont/captionFill/
// captionOutlineColor/captionInner/captionBand/exportPreset/durationMin)のどれについて来ても、
//   (1) parseJobParamsが例外を投げず既定値へ丸め、pipeline.mjsをfail-fastさせない
//   (2) ジョブが最後まで(stage=doneまで)完走する
//   (3) 丸めた結果が「何も指定しなかったとき」と同じ真の既定値であることを実測で確認する
// ことを、実ffmpeg・実サーバで検査する。
//
// tests/job-params-ui-settings-check.mjs が parseJobParams 単体でのこれら8ケースの丸め値を
// 既に検査済み。このテストはその先、実サーバでジョブが実際に完走しdoneへ到達すること・
// 出来た成果物が既定と一致することの実測を担う。
//
// 実ブラウザ(playwright)は使わず、httpモジュールで直接POST /api/jobs?...を叩く(不正なクエリ値を
// 細工しやすいため)。POSTの形・SSEでの完走待ち・起動時トークンの扱いはtests/e2e-server.mjs・
// tests/job-cancel-timeout-check.mjsを参考にした。起動時トークンはGET /が返すindex.htmlに
// window.__AI_EDITOR_TOKEN__として埋め込まれている(server/index.mjs 250-258行目。正規のページに
// のみ埋め込む本番の配布経路そのものであり、テスト専用の抜け道ではない)ので、それをそのまま読む。
//
// 実行: node tests/ui-settings-validate-check.mjs (ffmpeg必須。無ければexit 1)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  ROOT, WORK_ROOT, OUT_ROOT, ffmpegAvailable, makeSample, TOPIC_CLAUDE,
  installFakePython, installFakeClaude, startServer, stopServer, readCandidates,
  extractFramePng, readPixelsRgb,
} from "./helpers/ui-settings-e2e-harness.mjs";

const PORT = 59244; // このテスト専用の固定ポート

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n      ${e.stack || e.message}`); }
}

// ── 実サーバとの通信ヘルパ(playwright不使用。tests/e2e-server.mjs・job-cancel-timeout-check.mjsを参考) ──

/** GET / のHTML本文から、正規配布経路(server/index.mjs)が埋め込む起動時トークンを読み取る。 */
function fetchStartupToken(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          const m = body.match(/window\.__AI_EDITOR_TOKEN__="([0-9a-f]+)"/);
          if (!m) return reject(new Error("GET / のHTMLから起動時トークンを抽出できない: " + body.slice(0, 200)));
          resolve(m[1]);
        });
      }
    );
    req.on("error", reject);
  });
}

/** POST /api/jobs?query に生の動画バイト列を送る(tests/e2e-server.mjsと同じraw送信)。 */
function postJob(port, query, buf) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1", port, path: `/api/jobs?${query}`, method: "POST", timeout: 20_000,
        headers: { host: `127.0.0.1:${port}`, "Content-Type": "application/octet-stream", "Content-Length": buf.length },
      },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode, body: out }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("POST /api/jobs timeout")));
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

/**
 * GET /api/jobs/:id/events(SSE)へ接続し、終端イベント(done/job-error/cancelled/timeout)が
 * 最初に現れた時点で接続を切って返す(tests/job-cancel-timeout-check.mjsのcollectEventsと違い、
 * タイムアウトいっぱい待たず終端イベントで即座に確定させる。8ケース分の完走待ちを速くするため)。
 */
function waitForTerminalEvent(port, jobId, jobToken, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    let timer;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const req = http.get(
      {
        host: "127.0.0.1", port,
        path: `/api/jobs/${encodeURIComponent(jobId)}/events?jobToken=${jobToken}`,
        headers: { host: `127.0.0.1:${port}` },
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (settled) return;
          buf += chunk;
          const m = buf.match(/event:\s*(done|job-error|cancelled|timeout)/);
          if (m) {
            req.destroy();
            settle(resolve, { stage: m[1], body: buf });
          }
        });
        res.on("end", () => settle(resolve, { stage: null, body: buf }));
      }
    );
    req.on("error", (e) => settle(reject, e));
    timer = setTimeout(() => {
      req.destroy();
      settle(resolve, { stage: null, body: buf, timedOut: true });
    }, timeoutMs);
  });
}

let server = null, tmp = null;
const createdJobIds = [];

/** 後始末: 作ったジョブのwork/output配下を消す(TTLに頼らず、テスト環境を汚さない)。 */
function cleanupJobDirs() {
  for (const id of createdJobIds) {
    fs.rmSync(path.join(WORK_ROOT, id), { recursive: true, force: true });
    fs.rmSync(path.join(OUT_ROOT, id), { recursive: true, force: true });
  }
}

try {
  if (!(await ffmpegAvailable())) {
    console.error("ERROR: この検査は実ffmpegを必要とします(ffmpeg/ffprobeが見つかりません)。");
    process.exit(1);
  }

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-validate-"));
  const samplePath = await makeSample(tmp);
  const sampleBuf = fs.readFileSync(samplePath);

  const fakePython = installFakePython();
  const fakeClaude = installFakeClaude("validate", TOPIC_CLAUDE);
  const started = await startServer([fakeClaude.binDir, fakePython.binDir], PORT);
  server = started.child;

  const token = await fetchStartupToken(PORT);

  /**
   * 1本のジョブをPOST /api/jobsで作成し、SSEでstage=done(または終端)まで待つ。
   * sub=onを固定で付け、字幕関連の8設定(subStyle/captionFont/captionFill/captionOutlineColor/
   * captionInner/captionBand)が実際に字幕合成経路(ass生成・resolveCaptionStyle)まで
   * 通ることを確認できるようにする(sub=noneだと字幕関連の設定はそもそも使われず検査にならない)。
   */
  async function runJob(name, extraParams) {
    const query = new URLSearchParams({
      token, sub: "on", cut: "topic", size: "9:16", name, ...extraParams,
    }).toString();
    // P1-2(E)のレート制限(60秒固定窓・最大10件)へ、このテストが1本のジョブ作成のたび
    // 引っかかりうる(11本以上ジョブを作るため)。制限を回避するのではなく、窓が開くまで
    // 実際に待ってから再試行する(429を握りつぶさない=本物のレート制限に実際に従う)。
    let posted = await postJob(PORT, query, sampleBuf);
    let retries = 0;
    while (posted.status === 429 && retries < 20) {
      await new Promise((r) => setTimeout(r, 5000));
      posted = await postJob(PORT, query, sampleBuf);
      retries++;
    }
    assert.strictEqual(posted.status, 202, `POST /api/jobs が202ではない: status=${posted.status} body=${posted.body}`);
    const parsed = JSON.parse(posted.body);
    const { jobId, jobToken } = parsed;
    assert.ok(jobId, "jobIdが返っていない: " + posted.body);
    createdJobIds.push(jobId);
    const ev = await waitForTerminalEvent(PORT, jobId, jobToken, 90_000);
    return { jobId, jobToken, ev };
  }

  // ── 8つの不正値ケース(それぞれ単独で細工クエリに含める) ──────────────────────
  const MALICIOUS_CASES = [
    { key: "subStyle", value: "unknown", label: "未知のスタイル名" },
    { key: "captionFont", value: "__proto__", label: "プロトタイプ汚染狙い" },
    { key: "captionFill", value: "red", label: "色として不正な形式" },
    { key: "captionOutlineColor", value: "notacolor", label: "色として不正な形式" },
    { key: "captionInner", value: "badvalue", label: "offでも色形式でもない" },
    { key: "captionBand", value: "xyz", label: "offでも色形式でもない" },
    { key: "exportPreset", value: "unknown", label: "未知のプリセット名" },
    { key: "durationMin", value: "-5", label: "範囲外(0以下)" },
  ];

  // key -> jobId (代表比較で使い回すため、完走確認のジョブをそのまま再利用する)
  const maliciousJobIds = {};

  for (const c of MALICIOUS_CASES) {
    await t(`VALIDATE: ${c.key}=${c.value}(${c.label})は例外を投げず完走しstage=doneへ到達する`, async () => {
      const { jobId, ev } = await runJob(`malicious-${c.key}.mp4`, { [c.key]: c.value });
      assert.notStrictEqual(ev.stage, "job-error", `stageがjob-errorになった(fail-fastした疑い): ${ev.body.slice(0, 500)}`);
      assert.strictEqual(ev.stage, "done", `stageがdoneに到達しなかった(stage=${ev.stage}): ${ev.body.slice(0, 500)}`);
      const candidates = readCandidates(jobId);
      assert.ok(candidates.generated > 0 && candidates.candidates.length > 0, "候補が1本も生成されていない");
      maliciousJobIds[c.key] = jobId;
    });
  }

  // ── ベースライン: 新設定(8つ)を一切送らない場合。これが「真の既定値」の実測基準。 ──────
  let baselineJobId = null;
  await t("前提: 新設定を一切送らないベースラインジョブも完走しstage=doneへ到達する", async () => {
    const { jobId, ev } = await runJob("baseline.mp4", {});
    assert.strictEqual(ev.stage, "done", `stageがdoneに到達しなかった: ${ev.body.slice(0, 500)}`);
    const candidates = readCandidates(jobId);
    assert.ok(candidates.generated > 0 && candidates.candidates.length > 0, "候補が1本も生成されていない");
    baselineJobId = jobId;
  });

  // ── 代表比較1: captionFill=red が丸められ、出来た字幕フレームがベースライン(既定)と一致する ──
  // (クラッシュしないことだけでは満たさない=丸めた先が壊れた別の値になっていないかを画素で見る)
  function frameDiffRatio(pathA, pathB, atSec = 1.0, threshold = 10) {
    const pngA = extractFramePng(pathA, atSec);
    const pngB = extractFramePng(pathB, atSec);
    const bufA = readPixelsRgb(pngA);
    const bufB = readPixelsRgb(pngB);
    assert.strictEqual(bufA.length, bufB.length, "フレームサイズ(解像度)が一致しない");
    let diff = 0;
    const total = bufA.length / 3;
    for (let i = 0; i < bufA.length; i += 3) {
      const dr = Math.abs(bufA[i] - bufB[i]);
      const dg = Math.abs(bufA[i + 1] - bufB[i + 1]);
      const db = Math.abs(bufA[i + 2] - bufB[i + 2]);
      if (dr > threshold || dg > threshold || db > threshold) diff++;
    }
    return diff / total;
  }

  await t("VALIDATE: captionFill=red は既定へ丸まり、字幕フレームがベースラインと画素で一致する", async () => {
    const base = readCandidates(baselineJobId);
    const malicious = readCandidates(maliciousJobIds.captionFill);
    const basePath = base.candidates[0].path;
    const maliciousPath = malicious.candidates[0].path;
    assert.ok(fs.existsSync(basePath), "ベースラインの動画ファイルが無い: " + basePath);
    assert.ok(fs.existsSync(maliciousPath), "captionFill=redジョブの動画ファイルが無い: " + maliciousPath);
    const ratio = frameDiffRatio(basePath, maliciousPath);
    assert.ok(
      ratio < 0.01,
      `字幕フレームがベースラインと有意に異なる(差分画素${(ratio * 100).toFixed(2)}%): ` +
        `captionFill=redが既定色ではない別の色へ丸まっている疑い`
    );
  });

  // 対照: 検出力の確認。実際に異なる有効な色(#00FF00)を指定した場合は、上と同じ比較手法で
  // ベースラインとの差分が明確に検出できること(=diff比較そのものに検出力があることの証明。
  // 「差が無い」ことだけを合格条件にすると、比較手法が鈍くて常にPASSする偽の緑を見逃す)。
  await t("対照: 有効なcaptionFill=#00FF00は同じ比較手法でベースラインと有意に異なる(検出力の確認)", async () => {
    const { jobId, ev } = await runJob("control-captionFill.mp4", { captionFill: "#00FF00" });
    assert.strictEqual(ev.stage, "done", `stageがdoneに到達しなかった: ${ev.body.slice(0, 500)}`);
    const base = readCandidates(baselineJobId);
    const control = readCandidates(jobId);
    const ratio = frameDiffRatio(base.candidates[0].path, control.candidates[0].path);
    assert.ok(
      ratio >= 0.01,
      `有効な色指定なのにベースラインとの差分が検出できない(差分画素${(ratio * 100).toFixed(2)}%): ` +
        `フレーム比較の検出力が無い(常に一致判定する偽の緑になっている疑い)`
    );
  });

  // ── 代表比較2: durationMin=-5 が丸められ、出来た候補(区間選定結果)がベースラインと一致する ──
  function candidateShape(candidates) {
    return {
      generated: candidates.generated,
      segments: candidates.candidates.map((c) => ({
        start: c.start, end: c.end, duration: c.duration, hook: c.hook,
        width: c.width, height: c.height,
      })),
    };
  }

  await t("VALIDATE: durationMin=-5 は既定(おまかせ)へ丸まり、候補(区間選定結果)がベースラインと一致する", async () => {
    const base = candidateShape(readCandidates(baselineJobId));
    const malicious = candidateShape(readCandidates(maliciousJobIds.durationMin));
    assert.deepStrictEqual(
      malicious, base,
      "durationMin=-5 の候補(生成本数・区間・尺)がベースラインと一致しない(既定と違う丸め先になっている疑い)"
    );
  });

  // 対照: 検出力の確認。実際に有効かつ強い制約のdurationMin(=0.05分=3秒。上限2.1〜3.9秒)を
  // 指定した場合は、素材(12秒・3話題)の区間の切り方が変わり、上と同じ比較手法でベースラインとの
  // 差が検出できること。
  await t("対照: 有効なdurationMin=0.05は同じ比較手法でベースラインと有意に異なる(検出力の確認)", async () => {
    const { jobId, ev } = await runJob("control-durationMin.mp4", { durationMin: "0.05" });
    assert.strictEqual(ev.stage, "done", `stageがdoneに到達しなかった: ${ev.body.slice(0, 500)}`);
    const base = candidateShape(readCandidates(baselineJobId));
    const control = candidateShape(readCandidates(jobId));
    assert.notDeepStrictEqual(
      control, base,
      "有効なdurationMin指定なのに候補がベースラインと区別できない(候補比較の検出力が無い疑い)"
    );
  });
} finally {
  if (server) await stopServer(server);
  cleanupJobDirs();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
