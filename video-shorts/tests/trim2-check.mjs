// tests/trim2-check.mjs — G-EDIT-TRIM2（「間を詰める」の作り直し）
//
// マスターの棚卸し指示（2026-08-16）による作り直しを、値が通る鎖の各段で確かめる。
//
//   画面の2つのつまみ → POST /api/jobs?trimSilence=&trimFiller=
//     → parseJobParams → buildRenderArgs → --trim-silence / --trim-filler
//     → renderSegment → planTrim（余韻0.3秒・AIの判断表）
//
// 【固定素材】tests/fixtures/trim-judge/case-a.json
//   SHA-256 80f1a192caa482573dc0893b505c04575619eed6fb9e4a26ef2d8a218a21a026
//   全長 21.5秒・使う区間は 0.0〜21.5秒の全体。境界値分析で6つの場面を1本に含む
//   （先頭の言い淀み／詰める余地が無い境界／詰まる0.7秒／指示語の「あの」／
//     相手を待つ長い沈黙／会話が途切れた無音）。判定表(role/kind→残す/詰める)と
//   規則(余韻0.3秒)は素材ファイル側で確定させてある＝実装者が後から選べない。
//
// 【許容差】秒は ±0.05秒（両端を含む）、丸めは四捨五入。
//
// 実行: node tests/trim2-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./helpers/launch-chromium.mjs";
import { planTrim, isFiller, AFTER_SPEECH_MARGIN_SEC } from "../src/trim-plan.mjs";
import { parseJobParams } from "../server/job-params.mjs";
import { buildRenderArgs } from "../server/pipeline-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE); // video-shorts/
const PORT = 5296;
const TOL = 0.05;

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(HERE, "fixtures", "trim-judge", "case-a.json"), "utf-8"),
);

let pass = 0,
  fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n      ${e.stack || e.message}`);
  }
}

const words = FIXTURE.words.map((w) => ({ w: w.w, start: w.start, end: w.end }));

/** 素材が決めた対応表どおりの判定表を作る（AI がそう答えた状態を再現する）。 */
function judgeFromFixture(extraWords = []) {
  const all = [...FIXTURE.words, ...extraWords];
  return {
    isFiller: (index) => FIXTURE.judge.fillerByRole[all[index]?.role] === true,
    cutSilence: (start, end) => {
      const g = FIXTURE.gaps.find(
        (x) => Math.abs(x.start - start) < 1e-6 && Math.abs(x.end - end) < 1e-6,
      );
      return g ? FIXTURE.judge.cutByKind[g.kind] === true : false;
    },
  };
}

const run = (cutSilence, cutFillers, judge = judgeFromFixture()) =>
  planTrim(words, { duration: FIXTURE.durationSec, cutSilence, cutFillers, judge });

/** keep 区間と [a,b] の重なりの長さ。 */
function overlap(keep, a, b) {
  return keep.reduce(
    (acc, k) => acc + Math.max(0, Math.min(k.end, b) - Math.max(k.start, a)),
    0,
  );
}

/** 実サーバを起動して listening を待つ。 */
function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let timer;
    const onData = (c) => {
      buf += String(c);
      if (buf.includes("server listening")) {
        clearTimeout(timer);
        resolve(proc);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", reject);
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`サーバが起動しない(20秒)。出力:\n${buf}`));
    }, 20000);
  });
}

(async () => {
  /* ══════ SPLIT-SILENCE ══════ */
  await t("SPLIT-SILENCE: 無音だけを詰めると 18.2秒になり、「えーと」は残る", () => {
    const r = run(true, false);
    assert.ok(Math.abs(r.keptSeconds - 18.2) <= TOL, `残り=${r.keptSeconds}（期待 18.2 ±${TOL}）`);
    assert.ok(
      Math.abs(overlap(r.keep, 0.0, 1.2) - 1.2) <= TOL,
      "言い淀み「えーと」が消えている（言い淀みを消さない設定なのに巻き込まれた）",
    );
  });

  await t("SPLIT-SILENCE 対照: 言い淀みも消す設定にすると 16.7秒になり「えーと」が消える", () => {
    const r = run(true, true);
    assert.ok(Math.abs(r.keptSeconds - 16.7) <= TOL, `残り=${r.keptSeconds}（期待 16.7）`);
    assert.ok(overlap(r.keep, 0.0, 1.2) <= TOL, "「えーと」が残っている（2つのつまみが独立していない）");
  });

  /* ══════ SPLIT-FILLER ══════ */
  await t("SPLIT-FILLER: 言い淀みだけを消すと 20.3秒になり、6つの間が1つも短くならない", () => {
    const r = run(false, true);
    assert.ok(Math.abs(r.keptSeconds - 20.3) <= TOL, `残り=${r.keptSeconds}（期待 20.3 ±${TOL}）`);
    for (const g of FIXTURE.gaps) {
      const kept = overlap(r.keep, g.start, g.end);
      assert.ok(
        Math.abs(kept - g.sec) <= TOL,
        `間 [${g.start},${g.end}] が ${kept}秒 に縮んでいる（元 ${g.sec}秒）`,
      );
    }
  });

  await t("SPLIT-FILLER 対照: 無音も詰める設定にすると、少なくとも2つの間が短くなる", () => {
    const r = run(true, true);
    const shrunk = FIXTURE.gaps.filter((g) => overlap(r.keep, g.start, g.end) < g.sec - TOL);
    assert.ok(shrunk.length >= 2, `短くなった間が ${shrunk.length} 個（期待 2個以上）`);
  });

  /* ══════ TAIL（発言の後にだけ0.3秒）══════ */
  await t("TAIL: 詰めたつなぎ目に、直前の発言の後の 0.3秒 がちょうど残る", () => {
    const r = run(true, true);
    // 4.2秒に終わる発言・15.0秒に終わる発言の直後
    for (const end of [4.2, 15.0]) {
      const kept = overlap(r.keep, end, end + AFTER_SPEECH_MARGIN_SEC);
      assert.ok(
        Math.abs(kept - AFTER_SPEECH_MARGIN_SEC) <= TOL,
        `${end}秒 の発言の後の余韻が ${kept}秒（期待 ${AFTER_SPEECH_MARGIN_SEC}）`,
      );
      // その先は詰まっていること（余韻だけ残して切る＝際限なく残さない）
      assert.ok(
        overlap(r.keep, end + AFTER_SPEECH_MARGIN_SEC + 0.05, end + AFTER_SPEECH_MARGIN_SEC + 0.15) <= TOL,
        `${end}秒 の余韻の先が詰まっていない`,
      );
    }
  });

  await t("TAIL: 次の発言の前には余韻を付けない（冒頭は余韻なしで全部詰まる）", () => {
    const r = run(true, true);
    // 冒頭 [0.0,1.7] は「えーと」＋その後の間。直前に残る発言が無いので余韻は付かない。
    assert.ok(overlap(r.keep, 0.0, 1.7) <= TOL, `冒頭に ${overlap(r.keep, 0.0, 1.7)}秒 残っている`);
    // 次の発言 1.7秒 はその直後から始まる
    assert.ok(
      Math.abs(r.keep[0].start - 1.7) <= TOL,
      `最初に残る区間の開始が ${r.keep[0].start}（期待 1.7）`,
    );
  });

  await t("TAIL 対照: 0.3秒以下の間は詰める余地が無いのでそのまま残る", () => {
    // 合成データ: 語(1.0秒) → 間0.3秒 → 語(1.0秒)。判定表は「詰めてよい」と答える。
    const w = [
      { w: "あいうえお", start: 0.0, end: 1.0 },
      { w: "かきくけこ", start: 1.3, end: 2.3 },
    ];
    const r = planTrim(w, {
      duration: 2.3,
      cutSilence: true,
      cutFillers: true,
      judge: { isFiller: () => false, cutSilence: () => true },
    });
    assert.ok(Math.abs(r.keptSeconds - 2.3) <= TOL, `残り=${r.keptSeconds}（期待 2.3 ＝1秒も詰まらない）`);
  });

  await t("TAIL 対照: 余韻を付けない実装なら 16.7秒にならない", () => {
    // judge はそのまま、余韻の規則だけ無い状態＝旧実装の値（0.3×3＝0.9秒ぶん短い）
    const r = run(true, true);
    assert.ok(
      Math.abs(r.keptSeconds - (16.7 - AFTER_SPEECH_MARGIN_SEC * 3)) > TOL,
      "余韻が1秒も足されていない（旧実装のまま）",
    );
  });

  /* ══════ AI-FILLER（単語一覧が決定権を持たない）══════ */
  await t("AI-FILLER: 一覧に載っている「あの」も、判断が『言い淀みでない』なら残る", () => {
    assert.ok(isFiller("あの"), "前提が崩れている: 単語一覧に「あの」が載っていない");
    const r = run(true, true);
    assert.ok(
      Math.abs(overlap(r.keep, 4.9, 5.3) - 0.4) <= TOL,
      "指示語の「あの」が消えている（単語一覧が決定権を持ったまま）",
    );
  });

  await t("AI-FILLER: 一覧に無い語でも、判断が『言い淀みである』なら消える", () => {
    assert.ok(!isFiller("ちょっと"), "前提が崩れている: 「ちょっと」が単語一覧に載っている");
    const w = [...words, { w: "ちょっと", start: 20.5, end: 21.0 }];
    const r = planTrim(w, {
      duration: 21.5,
      cutSilence: false,
      cutFillers: true,
      judge: { isFiller: (i) => i === w.length - 1, cutSilence: () => false },
    });
    assert.ok(overlap(r.keep, 20.5, 21.0) <= TOL, "一覧に無い語を消せていない");
  });

  await t("AI-FILLER 対照: 判断表を渡さないと、一覧どおりに「あの」が消える（現行の欠陥の再現）", () => {
    const r = planTrim(words, { duration: FIXTURE.durationSec, cutSilence: true, cutFillers: true });
    assert.ok(
      overlap(r.keep, 4.9, 5.3) <= TOL,
      "判断表なしでも「あの」が残った（この対照が成立していない）",
    );
  });

  /* ══════ AI-SILENCE（長さだけでは決まらない）══════ */
  await t("AI-SILENCE: 相手を待つ沈黙(1.8秒/1.5秒)は残り、会話が途切れた無音(3.0秒)は詰まる", () => {
    const r = run(true, true);
    for (const [a, b, sec] of [[7.4, 9.2, 1.8], [11.0, 12.5, 1.5]]) {
      assert.ok(
        Math.abs(overlap(r.keep, a, b) - sec) <= TOL,
        `会話の途中の沈黙 [${a},${b}] が ${overlap(r.keep, a, b)}秒 に縮んでいる`,
      );
    }
    const dead = overlap(r.keep, 15.0, 18.0);
    assert.ok(
      Math.abs(dead - AFTER_SPEECH_MARGIN_SEC) <= TOL,
      `会話が途切れた無音の残りが ${dead}秒（期待 ${AFTER_SPEECH_MARGIN_SEC}）`,
    );
    // 長さの大小だけでは決まらないことの明示（1.8秒は残り、より長い3.0秒は詰まる）
    assert.ok(overlap(r.keep, 7.4, 9.2) > dead, "長さの閾値だけで決めている疑い");
  });

  await t("AI-SILENCE 対照: 長さの閾値だけで決める実装だと、待つ沈黙まで詰まる", () => {
    const r = planTrim(words, { duration: FIXTURE.durationSec, cutSilence: true, cutFillers: false });
    assert.ok(
      overlap(r.keep, 7.4, 9.2) < 1.8 - TOL,
      "閾値だけの実装でも待つ沈黙が残った（この対照が成立していない）",
    );
  });

  await t("AI-SILENCE 対照: すべて『会話の途中』と答えると、3.0秒の無音も残る", () => {
    const r = run(true, true, {
      isFiller: () => false,
      cutSilence: () => false,
    });
    assert.ok(Math.abs(r.keptSeconds - 21.5) <= TOL, `残り=${r.keptSeconds}（期待 21.5）`);
  });

  /* ══════ COMPAT ══════ */
  await t("COMPAT: どちらも「なし」なら素材と同じ 21.5秒・1区間", () => {
    const r = run(false, false);
    assert.ok(Math.abs(r.keptSeconds - 21.5) <= TOL, `残り=${r.keptSeconds}（期待 21.5）`);
    assert.strictEqual(r.keep.length, 1, `keep が ${r.keep.length} 区間（期待 1）`);
  });

  /* ══════ 受け口と結線 ══════ */
  await t("受け口: 2つのつまみが独立して受理される", () => {
    const p1 = parseJobParams(new URLSearchParams({ trimSilence: "on" }));
    assert.strictEqual(p1.trimSilence, "on");
    assert.strictEqual(p1.trimFiller, "none");
    const p2 = parseJobParams(new URLSearchParams({ trimFiller: "on" }));
    assert.strictEqual(p2.trimSilence, "none");
    assert.strictEqual(p2.trimFiller, "on");
  });

  await t("受け口: 既定はどちらも none（これまでどおり詰めない）", () => {
    const p = parseJobParams(new URLSearchParams());
    assert.strictEqual(p.trimSilence, "none");
    assert.strictEqual(p.trimFiller, "none");
    assert.strictEqual(p.trim, "none");
  });

  await t("受け口: 旧 trim=on は「両方あり」として受け続ける（後方互換）", () => {
    // ここを落とすと、旧いクエリが none へ丸まり、詰め処理が走らないまま
    // 「間が残っている」系の検査が緑になる（偽の緑）。
    const p = parseJobParams(new URLSearchParams({ trim: "on" }));
    assert.strictEqual(p.trimSilence, "on");
    assert.strictEqual(p.trimFiller, "on");
    assert.strictEqual(p.trim, "on");
  });

  await t("受け口: 新しい指定があれば、旧 trim より新しい方が優先される", () => {
    const p = parseJobParams(new URLSearchParams({ trim: "on", trimSilence: "on" }));
    assert.strictEqual(p.trimSilence, "on");
    assert.strictEqual(p.trimFiller, "none", "旧 trim=on に引きずられて言い淀みまで消えている");
  });

  await t("結線: 受け口の値が --trim-silence / --trim-filler として render へ渡る", () => {
    const opts = parseJobParams(new URLSearchParams({ trimSilence: "on", trimFiller: "none" }));
    const argv = buildRenderArgs("/p/pipeline.mjs", "/w", opts);
    const i = argv.indexOf("--trim-silence");
    const j = argv.indexOf("--trim-filler");
    assert.ok(i >= 0 && j >= 0, `argv に渡っていない: ${argv.join(" ")}`);
    assert.strictEqual(argv[i + 1], "on");
    assert.strictEqual(argv[j + 1], "none");
  });

  /* ══════ 画面 ══════ */
  const server = await startServer();
  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1365, height: 830 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });

  await t("画面: 2つのつまみが別々に置かれ、どちらも既定は「詰めない／残す」", async () => {
    for (const key of ["trimSilence", "trimFiller"]) {
      const on = await page.locator(`[data-group="${key}"] .chip[data-val="none"]`).getAttribute("aria-pressed");
      assert.strictEqual(on, "true", `${key} の既定が選ばれていない`);
    }
  });

  await t("画面: 片方だけ押しても、もう片方は変わらない", async () => {
    await page.click('[data-group="trimSilence"] .chip[data-val="on"]');
    const other = await page
      .locator('[data-group="trimFiller"] .chip[data-val="none"]')
      .getAttribute("aria-pressed");
    assert.strictEqual(other, "true", "片方を押したら、もう片方まで変わった");
  });

  await t("画面: 選んだ内容の説明が、4通りで別々の文になる", async () => {
    const desc = () => page.locator("#trim-desc").textContent();
    const seen = new Set();
    // すでに trimSilence=on の状態
    seen.add((await desc()).trim());
    await page.click('[data-group="trimFiller"] .chip[data-val="on"]');
    seen.add((await desc()).trim());
    await page.click('[data-group="trimSilence"] .chip[data-val="none"]');
    seen.add((await desc()).trim());
    await page.click('[data-group="trimFiller"] .chip[data-val="none"]');
    seen.add((await desc()).trim());
    assert.strictEqual(seen.size, 4, `説明が ${seen.size} 通りしかない（期待 4通り）`);
  });

  await t("画面: 選んだ2つの値が POST /api/jobs のクエリに別々に載る", async () => {
    await page.click('[data-group="trimFiller"] .chip[data-val="on"]');
    await page.setInputFiles("#file", {
      name: "t.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("x".repeat(64)),
    });
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/jobs") && r.method() === "POST", {
        timeout: 15000,
      }),
      (async () => {
        await page.click("#btn-run");
        await page.waitForSelector("#confirm-overlay:not(.hidden)");
        await page.click("#confirm-run");
      })(),
    ]);
    const q = new URL(req.url()).searchParams;
    // 画面は2つとも明示して送る（"none" も送る）。片方だけ送ると、受け口の
    // 「新しい指定があるか」の判定が片側にしか働かず、旧 trim との優先関係が曖昧になる。
    assert.strictEqual(q.get("trimFiller"), "on", "言い淀みの指定が載っていない");
    assert.strictEqual(q.get("trimSilence"), "none", "無音の指定が『詰めない』として載っていない");
    assert.strictEqual(q.get("trim"), null, "廃止した旧 trim がまだ送られている");
  });

  await t("画面: 操作でスクリプトエラーが1件も出ていない", () => {
    assert.deepStrictEqual(pageErrors, [], `ページ内エラー: ${pageErrors.join(" / ")}`);
  });

  await browser.close();
  server.kill("SIGKILL");

  console.log(`\n合計: PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
