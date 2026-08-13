// 字幕の焼き直し(recaption)で、新しい文字だけが実際に読み取れることの検証 — G-EDIT-CAPTION-B
//
// 【マスター決定 2026-08-11（D-2）】この葉の確かめ方は「文字認識ツール(tesseract-ocr)を
// 入れて実際に読ませる」。旧verifyは「画面を操作する手順を含むため independent-verifier が
// 自分で再実行し観察して判定する」だったが、これを自動化した機械検証へ置き換える。
//
// 【なぜ .ass の文字列比較だけでは足りないか】tests/recaption-human-vs-ai-check.mjs は
// 生成された .ass ファイルの中身を文字列 includes() で調べているが、これは「焼き込みの
// 材料」を見ているだけで「実際にピクセルとして読める字幕」を見ていない。フォントが
// 無くて豆腐(tofu)になる・文字が画面外に出る・他の描画と重なって潰れる、といった
// 実際の見え方の欠陥は文字列比較では検出できない。この葉の受入事実は「新しい文字が
// "写っている"」なので、出力動画から実際にフレームを抜き、OCRで読ませて確かめる。
//
// 【実際に流す経路】本物のHTTPサーバーを起動し、実際に
//   (1) POST /api/jobs/:id/recaption を編集なしで叩く(＝まだ誰も直していない状態の
//       焼き直し。実運用では最初のジョブ完了直後の状態に相当し、対照実験の「書き換え
//       なし」を兼ねる)
//   (2) PUT  /api/jobs/:id/captions で語を直す
//   (3) POST /api/jobs/:id/recaption をもう一度叩く(＝直した字幕で焼き直す)
// の3回を実サーバー・実ffmpegで実行する。(1)の出力を「書き換え前」、(3)の出力を
// 「書き換え後」として、それぞれ独立にフレームを抜きOCRで読む。
//
// 【背景を単色にする理由】実際の映像コンテンツ(人物・テキストが混在する画面等)を背景に
// 使うと、OCRの成否が背景の複雑さに左右され、検査自体が不安定になる(境界値分析ではなく
// ノイズ源が増えるだけ)。この検査が確かめたいのは「焼き直しが正しい文字を焼くか」であって
// 「どんな背景でもOCRできるか」ではないため、背景は無地(黒)に固定する。これは
// tests/reframe_fixtures.py が幾何の検証に市松模様を選んだのと同じ考え方(検証したい
// 事実だけを際立たせる)。
//
// 【語の選び方】単純なカタカナ短語(例:「サクラ」)は、この環境の tesseract 5.3.4 + jpn
// 言語パックでは字形によって誤読する実測がある(「サクラ」→「サクフラ」等、psm 6/7/8/11
// いずれでも再現)。かな+漢字を混ぜた語では実測で安定して正しく読めたため、
// 「書き換え前」「書き換え後」ともかな+漢字混在の語を選ぶ。共通の文字を含まない対にして
// 部分一致による誤検出を避ける。
//
// 【前処理】ass の下部中央(align=2)に焼かれる字幕を tesseract で安定して読ませるため、
// 抽出したフレームを (a) 白黒反転(negate: 黒地に白文字 → 白地に黒文字) (b) 字幕が写る
// 下部帯(高さの65%〜95%)へ切り出し (c) 2倍拡大(lanczos) という前処理を掛ける。
// --psm 7 (単一行) を使う。
//
// 【複数フレームで判定】字幕が表示される区間から等間隔に3フレーム抜き、すべてで
// 「書き換え後の文字が読み取れ、書き換え前の文字が読み取れない」ことを確認する
// (1フレームだけだと、たまたま良い/悪いフレームを引いた偶然を拾ってしまう)。
//
// 実行: node tests/caption-recaption-ocr-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runFfmpeg } from "../src/render-vertical.mjs";
import { hashToken } from "../server/security.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const WORK_ROOT = path.join(ROOT, "work");
const OUT_ROOT = path.join(ROOT, "output");
const PORT = 59208; // このテスト専用の固定ポート(他テストと衝突しない値。旧59196はsmoke.mjsのSMOKE_SERVER_PORTと重複していたためL-7で是正)
const JOB_ID = "caption-recaption-ocr-check-job";
const WORK_DIR = path.join(WORK_ROOT, JOB_ID);
const OUT_DIR = path.join(OUT_ROOT, JOB_ID);
const CLIP_FILE = "clip-1.mp4";

const CLIP_DURATION_SEC = 2.4;
const CANVAS_W = 1080;
const CANVAS_H = 1920;

// 書き換え前後の語。かな+漢字混在・実測で正しく読める語を選ぶ(共通文字なし)。
const BEFORE_WORD = "桜が咲く";
const AFTER_WORD = "梅の花";

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

function toolAvailable(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { windowsHide: true });
    p.on("error", () => res(false));
    p.on("close", (c) => res(c === 0));
  });
}

async function makeSolidSample(dir) {
  // 拡大ガード(computeCanvas)が発動しないよう、素材を出力canvasと同じ1080x1920にする
  // (拡大されると輪郭がぼやけOCRが不安定になるため、等倍で焼く)。
  const out = path.join(dir, "sample-1080x1920.mp4");
  await runFfmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=black:size=${CANVAS_W}x${CANVAS_H}:rate=15:duration=${CLIP_DURATION_SEC}`,
    "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:duration=${CLIP_DURATION_SEC}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    out,
  ]);
  return out;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
    });
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server起動タイムアウト")), 8000);
    child.stderr.on("data", (chunk) => {
      buf += chunk.toString();
      if (/listening/.test(buf)) {
        clearTimeout(timer);
        resolve({ child });
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

function call(method, pathAndQuery, { body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf-8");
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: pathAndQuery, method, timeout: 30_000,
      headers: {
        host: `127.0.0.1:${PORT}`,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
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

/** 動画から1フレームをPNGへ抜き、OCRしやすいよう前処理する。 */
async function extractPreprocessedFrame(videoPath, tSec, outPngPath) {
  const raw = `${outPngPath}.raw.png`;
  await runFfmpeg(["-y", "-v", "error", "-ss", String(tSec), "-i", videoPath, "-frames:v", "1", raw]);
  // negate(白黒反転) → 下部帯(65%〜95%)へ切り出し → 2倍拡大(lanczos)
  await runFfmpeg([
    "-y", "-v", "error", "-i", raw,
    "-vf", "negate,crop=iw:ih*0.3:0:ih*0.65,scale=iw*2:ih*2:flags=lanczos",
    outPngPath,
  ]);
  fs.rmSync(raw, { force: true });
}

function ocrRead(pngPath) {
  const r = spawnSync("tesseract", [pngPath, "-", "-l", "jpn", "--psm", "7"], { encoding: "utf-8" });
  if (r.error) throw r.error;
  return (r.stdout || "").replace(/\s+/g, "");
}

/** clipPath の表示区間から等間隔にNフレーム抜き、OCR結果の配列を返す。 */
async function ocrFramesOf(clipPath, tmpDir, tag, n = 3) {
  const texts = [];
  for (let i = 0; i < n; i++) {
    // 区間の端(フェード等が無くても念のため)を避け、内側から等間隔に取る。
    const t = (CLIP_DURATION_SEC * (i + 1)) / (n + 1);
    const png = path.join(tmpDir, `${tag}-frame-${i}.png`);
    await extractPreprocessedFrame(clipPath, t, png);
    texts.push(ocrRead(png));
  }
  return texts;
}

let server = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-caption-ocr-"));
try {
  if (!(await toolAvailable("ffmpeg", ["-version"]))) {
    console.log("FAIL ffmpeg が見つかりません。このテストは実機の ffmpeg を必要とします。");
    process.exit(1);
  }
  if (!(await toolAvailable("tesseract", ["--version"]))) {
    console.log("FAIL tesseract が見つかりません。このテストは実機の tesseract-ocr(+jpn言語パック)を必要とします。");
    process.exit(1);
  }

  // ── 準備: 実素材・実workDir/outDir ──────────────────────────
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const sample = await makeSolidSample(tmp);

  fs.writeFileSync(
    path.join(WORK_DIR, "transcript.json"),
    JSON.stringify({
      language: "ja",
      duration: CLIP_DURATION_SEC,
      words: [{ w: BEFORE_WORD, start: 0.0, end: CLIP_DURATION_SEC }],
      segments: [{ start: 0.0, end: CLIP_DURATION_SEC, text: BEFORE_WORD }],
    }, null, 2),
    "utf-8",
  );

  fs.writeFileSync(
    path.join(WORK_DIR, "state.json"),
    JSON.stringify({
      id: JOB_ID, input: sample, orient: "portrait", sub: "on", trim: "none",
      // "bold"(line方式): 行がそのまま出続けるスタイル。karaoke の単語ハイライトは
      // OCRの判定に無関係な複雑さを持ち込むので避ける。
      subStyle: "bold",
      srcW: CANVAS_W, srcH: CANVAS_H,
    }, null, 2),
    "utf-8",
  );

  fs.writeFileSync(
    path.join(OUT_DIR, "candidates.json"),
    JSON.stringify({
      id: JOB_ID, mode: "topic", generated: 1, digest: null, incomplete: false,
      candidates: [{
        index: 1, file: CLIP_FILE, start: 0.0, end: CLIP_DURATION_SEC, duration: CLIP_DURATION_SEC,
        hook: null, confidence: 1, keepText: BEFORE_WORD,
        width: CANVAS_W, height: CANVAS_H, status: "pending",
      }],
    }, null, 2),
    "utf-8",
  );
  // 焼き直し前のプレースホルダ(recaptionは全部そろってから差し替えるので中身は問われない)
  fs.writeFileSync(path.join(OUT_DIR, CLIP_FILE), "dummy-old-clip", "utf-8");

  // ── サーバー起動 ──────────────────────────────────────────
  const started = await startServer();
  server = started.child;
  // P1-15-B: job-token.txtにはハッシュを保存する(persistJobToken参照)。
  fs.writeFileSync(path.join(WORK_DIR, "job-token.txt"), hashToken("caption-ocr-job-token"), "utf-8");
  const auth = "?jobToken=caption-ocr-job-token";

  // ── (1) 対照実験: まだ誰も直していない状態で焼き直し(=最初のジョブ完了直後と同じ) ──
  const recap1 = await call("POST", `/api/jobs/${JOB_ID}/recaption${auth}`, { body: {} });
  report("対照: 編集なしでの POST /recaption が成功する(200)", recap1.status === 200,
    `status=${recap1.status} ${recap1.body}`);
  const recap1Body = JSON.parse(recap1.body || "{}");
  report("対照: 1本焼いたと報告する", recap1Body.ok === true && recap1Body.rebuilt === 1, JSON.stringify(recap1Body));

  const beforeClip = path.join(tmp, "before-clip.mp4");
  fs.copyFileSync(path.join(OUT_DIR, CLIP_FILE), beforeClip);
  const beforeStat = fs.statSync(beforeClip);
  report("対照: 書き換え前の出力クリップが実際に生成されている(サイズがある)", beforeStat.size > 1000, `size=${beforeStat.size}`);

  const beforeTexts = await ocrFramesOf(beforeClip, tmp, "before");
  console.log(`  [OCR] 書き換え前フレーム: ${JSON.stringify(beforeTexts)}`);
  for (let i = 0; i < beforeTexts.length; i++) {
    report(`対照フレーム${i}: 書き換え前の文字(${BEFORE_WORD})が読み取れる`, beforeTexts[i].includes(BEFORE_WORD), beforeTexts[i]);
    report(`対照フレーム${i}: 書き換え後の文字(${AFTER_WORD})はまだ読み取れない`, !beforeTexts[i].includes(AFTER_WORD), beforeTexts[i]);
  }

  // ── (2) 人が字幕を直す(実HTTP) ──────────────────────────────
  const putRes = await call("PUT", `/api/jobs/${JOB_ID}/captions${auth}`, {
    body: { index: 0, text: AFTER_WORD },
  });
  report("編集: PUT /captions が成功する(200)", putRes.status === 200, `status=${putRes.status} ${putRes.body}`);
  const putBody = JSON.parse(putRes.body || "{}");
  report("編集: 保存前の値(before)が元の語である", putBody.before === BEFORE_WORD, JSON.stringify(putBody));
  report("編集: 保存後の値(after)が新しい語である", putBody.after === AFTER_WORD, JSON.stringify(putBody));

  // ── (3) 直した字幕で焼き直し(実HTTP) ────────────────────────
  const recap2 = await call("POST", `/api/jobs/${JOB_ID}/recaption${auth}`, { body: {} });
  report("本体: 編集後の POST /recaption が成功する(200)", recap2.status === 200, `status=${recap2.status} ${recap2.body}`);
  const recap2Body = JSON.parse(recap2.body || "{}");
  report("本体: 1本焼き直したと報告する", recap2Body.ok === true && recap2Body.rebuilt === 1, JSON.stringify(recap2Body));

  const afterClip = path.join(OUT_DIR, CLIP_FILE); // 差し替え後の実物をそのまま読む
  const afterStat = fs.existsSync(afterClip) ? fs.statSync(afterClip) : null;
  report("本体: 書き換え後の出力クリップが実際に置き換わっている(サイズがある)",
    !!afterStat && afterStat.size > 1000, afterStat ? `size=${afterStat.size}` : "no file");
  report("本体: 差し替え後は一時ファイル(.recaption-tmp.mp4)が残っていない",
    !fs.existsSync(`${afterClip}.recaption-tmp.mp4`));

  const afterTexts = await ocrFramesOf(afterClip, tmp, "after");
  console.log(`  [OCR] 書き換え後フレーム: ${JSON.stringify(afterTexts)}`);
  for (let i = 0; i < afterTexts.length; i++) {
    report(`本体フレーム${i}: 書き換え後の文字(${AFTER_WORD})が読み取れる`, afterTexts[i].includes(AFTER_WORD), afterTexts[i]);
    report(`本体フレーム${i}: 書き換え前の文字(${BEFORE_WORD})はもう読み取れない`, !afterTexts[i].includes(BEFORE_WORD), afterTexts[i]);
  }
} finally {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
