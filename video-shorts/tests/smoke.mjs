// video-shorts スモークテスト — faster-whisper/ffmpeg 不要でロジック単体を検証。
// 実行: node tests/smoke.mjs   (全PASSで exit 0 / 1件でもFAILで exit 1)

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSegments, normalize, dedupeOverlap } from "../src/reverse-match.mjs";
import { chunkSegments, parseResponse, buildPrompt } from "../src/select-segments.mjs";
import { wordsInRange, groupCaptions, buildAss } from "../src/srt-builder.mjs";
import { mergeShortSegments } from "../src/snap-boundaries.mjs";
import { resolveJobSettings, renderLabel } from "../server/pipeline-runner.mjs";
import { parseJobParams } from "../server/job-params.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

// ダミー transcript（"今日 は いい 天気 です ね"）
const transcript = {
  language: "ja",
  duration: 3.0,
  words: [
    { w: "今日", start: 0.0, end: 0.5 },
    { w: "は", start: 0.5, end: 0.7 },
    { w: "いい", start: 0.7, end: 1.0 },
    { w: "天気", start: 1.0, end: 1.5 },
    { w: "です", start: 1.5, end: 2.0 },
    { w: "ね", start: 2.0, end: 2.3 },
  ],
  segments: [{ start: 0.0, end: 2.3, text: "今日はいい天気ですね" }],
};

t("normalize: 記号と空白を除去", () => {
  assert.strictEqual(normalize("いい、天気です！ "), "いい天気です");
});

t("逆マッチング: 完全一致で秒数確定", () => {
  const out = resolveSegments([{ keepText: "いい天気です", hook: "快晴" }], transcript);
  assert.strictEqual(out.length, 1, "1区間返るべき");
  assert.strictEqual(out[0].start, 0.7, "start=いい の開始");
  assert.strictEqual(out[0].end, 2.0, "end=です の終了");
  assert.strictEqual(out[0].confidence, 1.0);
});

t("逆マッチング: LLMがstart/endを出してもコードは無視する(keepTextのみ使用)", () => {
  // keepText だけを見るので、余計な秒数フィールドは結果に影響しない
  const out = resolveSegments([{ keepText: "天気です", hook: "h", start: 999, end: 9999 }], transcript);
  assert.strictEqual(out[0].start, 1.0);
  assert.strictEqual(out[0].end, 2.0);
});

t("逆マッチング: 不一致テキストは除外", () => {
  const out = resolveSegments([{ keepText: "全く別の文章xyz", hook: "h" }], transcript);
  assert.strictEqual(out.length, 0);
});

t("dedupeOverlap: 重複区間を間引く", () => {
  const segs = [
    { start: 0, end: 10, duration: 10, confidence: 0.8 },
    { start: 1, end: 9, duration: 8, confidence: 0.5 },
    { start: 30, end: 40, duration: 10, confidence: 0.9 },
  ];
  const out = dedupeOverlap(segs);
  assert.strictEqual(out.length, 2, "重なる2件は1件に");
});

t("chunkSegments: 短尺は1チャンク", () => {
  const chunks = chunkSegments(transcript);
  assert.strictEqual(chunks.length, 1);
});

t("chunkSegments: 長尺は複数チャンク＋オーバーラップ", () => {
  const longSegs = [];
  for (let i = 0; i < 60; i++) longSegs.push({ start: i * 60, end: i * 60 + 60, text: `seg${i}` });
  const long = { duration: 3600, segments: longSegs };
  const chunks = chunkSegments(long, 20 * 60, 60);
  assert.ok(chunks.length >= 2, "1時間は複数チャンク");
});

t("parseResponse: ```json フェンスを剥がす", () => {
  const raw = '```json\n{"segments":[{"keepText":"あいうえお","hook":"h"}]}\n```';
  const segs = parseResponse(raw);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].keepText, "あいうえお");
});

t("buildPrompt: 秒数を出させない指示が含まれる", () => {
  const p = buildPrompt({ text: "テスト本文" }, 3);
  assert.ok(p.includes("秒数"), "秒数禁止の指示があるべき");
  assert.ok(p.includes("テスト本文"));
});

t("wordsInRange + groupCaptions: 字幕行にまとまる", () => {
  const rel = wordsInRange(transcript.words, 0.7, 2.0);
  assert.ok(rel.length >= 1);
  const caps = groupCaptions(rel, 4);
  assert.ok(caps.length >= 1);
});

t("buildAss: ASSヘッダと背景ボックススタイルを含む", () => {
  const rel = wordsInRange(transcript.words, 0.0, 2.3);
  const ass = buildAss(rel, "煽り文", 2.3);
  assert.ok(ass.includes("[Script Info]"));
  assert.ok(ass.includes("PlayResX: 1080"));
  assert.ok(ass.includes("Style: Caption"));
  assert.ok(ass.includes("Dialogue:"));
});

t("mergeShortSegments: maxGapSec(R-8)を狭めると隣接結合されない", () => {
  const segs = [
    { start: 0, end: 5, duration: 5, hook: "a", keepText: "a" },
    { start: 9, end: 14, duration: 5, hook: "b", keepText: "b" }, // gap=4s
  ];
  const wide = mergeShortSegments(segs, 180, 5); // gap5 <= maxGap5 → 結合
  const narrow = mergeShortSegments(segs, 180, 3); // gap4 > maxGap3 → 結合しない
  assert.strictEqual(wide.length, 1, "gap内なら1区間に結合されるべき");
  assert.strictEqual(narrow.length, 2, "gap超過なら結合されず2区間のままであるべき");
});

t("mergeShortSegments: maxGapSec未指定時は既定3秒", () => {
  const segs = [
    { start: 0, end: 5, duration: 5, hook: "a", keepText: "a" },
    { start: 9, end: 14, duration: 5, hook: "b", keepText: "b" }, // gap=4s > 既定3s
  ];
  const out = mergeShortSegments(segs, 180); // 第3引数省略
  assert.strictEqual(out.length, 2, "既定3秒はgap4秒を結合しないはず");
});

// 同一フレーズ "これは" が2箇所（先頭0.0 と後方1.7）に出現する transcript（R-5①検証用）
const dupTranscript = {
  language: "ja",
  duration: 3.4,
  words: [
    { w: "これ", start: 0.0, end: 0.5 },
    { w: "は", start: 0.5, end: 0.7 },
    { w: "テスト", start: 0.7, end: 1.2 },
    { w: "です", start: 1.2, end: 1.7 },
    { w: "これ", start: 1.7, end: 2.2 },
    { w: "は", start: 2.2, end: 2.4 },
    { w: "本番", start: 2.4, end: 2.9 },
    { w: "です", start: 2.9, end: 3.4 },
  ],
  segments: [{ start: 0.0, end: 3.4, text: "これはテストですこれは本番です" }],
};

t("逆マッチング(R-5①): 同一フレーズ2回出現時、topic経路は2つ目を別出現に確定する", () => {
  // 同じ keepText "これは" を2区間として渡す。topic（preserveOrder既定false）は走査位置を
  // 持ち回るので、1つ目は先頭(0.0)、2つ目は後方の出現(1.7)に確定する。
  const out = resolveSegments(
    [{ keepText: "これは", hook: "1" }, { keepText: "これは", hook: "2" }],
    dupTranscript,
  );
  assert.strictEqual(out.length, 2, "2つ目が別出現に確定し2区間残るべき");
  const starts = out.map((o) => o.start).sort((a, b) => a - b);
  assert.deepStrictEqual(starts, [0.0, 1.7], "先頭出現と2つ目の出現をそれぞれ拾う");
});

t("逆マッチング(R-5①): topic経路でkeepTextが時系列逆順でも区間消失しない（順序違反救済）", () => {
  // 1番目に後方出現「これは本番」(1.7s以降)、2番目に前方「これはテスト」(0.0s) を渡す。
  // cursor 前進で2番目が下限より前になり消える旧挙動を、下限を外した再探索で救済する。
  const out = resolveSegments(
    [{ keepText: "これは本番", hook: "1" }, { keepText: "これはテスト", hook: "2" }],
    dupTranscript,
  );
  assert.strictEqual(out.length, 2, "順序違反でも2区間とも残るべき（消失しない）");
});

t("逆マッチング(R-5①): digest経路(preserveOrder)は下限を伝播せず両方先頭出現→dedupeで1件", () => {
  // digest は台本の並べ替えを許すため下限伝播しない。両方先頭(0.0)にマッチし dedupe で1件。
  const out = resolveSegments(
    [{ keepText: "これは", hook: "1" }, { keepText: "これは", hook: "2" }],
    dupTranscript,
    { preserveOrder: true },
  );
  assert.strictEqual(out.length, 1, "同一先頭出現2件は dedupeOverlap で1件に間引かれる");
  assert.strictEqual(out[0].start, 0.0);
});

// ---- P0-5: Web UIの設定が生成物へ反映される（画面選択→mode/orient契約） ----

t("resolveJobSettings: cut=topic → mode=topic / size=9:16 → orient=portrait", () => {
  const r = resolveJobSettings({ cut: "topic", size: "9:16", sub: "none" });
  assert.strictEqual(r.mode, "topic");
  assert.strictEqual(r.orient, "portrait");
  assert.strictEqual(r.targetMinutes, undefined, "topicモードはtargetMinutesを持たない");
});

t("resolveJobSettings: cut=minutes → mode=digest / size=16:9 → orient=landscape", () => {
  const r = resolveJobSettings({ cut: "minutes", size: "16:9", sub: "on", cutMin: 7 });
  assert.strictEqual(r.mode, "digest");
  assert.strictEqual(r.orient, "landscape");
  assert.strictEqual(r.targetMinutes, 7);
});

t("resolveJobSettings: digestでもcutMinが不正なら targetMinutes は undefined（クラッシュしない）", () => {
  const r1 = resolveJobSettings({ cut: "minutes", size: "9:16", sub: "none", cutMin: undefined });
  assert.strictEqual(r1.targetMinutes, undefined);
  const r2 = resolveJobSettings({ cut: "minutes", size: "9:16", sub: "none", cutMin: -1 });
  assert.strictEqual(r2.targetMinutes, undefined);
});

t("resolveJobSettings: 未知のcut/sizeは既定(topic/portrait)へフォールバック", () => {
  const r = resolveJobSettings({ cut: "count", size: "4:5", sub: "none" });
  assert.strictEqual(r.mode, "topic");
  assert.strictEqual(r.orient, "portrait");
});

t("parseJobParams: サポート外のcut/sizeはクエリに来ても既定へ丸められる", () => {
  const p = parseJobParams(new URLSearchParams({ cut: "count", size: "4:5", cutMin: "999" }));
  assert.strictEqual(p.cut, "topic");
  assert.strictEqual(p.size, "9:16");
  assert.strictEqual(p.cutMin, 3, "範囲外(1-60)のcutMinは既定3へ丸められる");
});

t("parseJobParams: サポート内の値はそのまま通る", () => {
  const p = parseJobParams(new URLSearchParams({ cut: "minutes", size: "16:9", cutMin: "12", sub: "on" }));
  assert.strictEqual(p.cut, "minutes");
  assert.strictEqual(p.size, "16:9");
  assert.strictEqual(p.cutMin, 12);
  assert.strictEqual(p.sub, "on");
});

// ---- P0-5-B: レンダラー未実装の選択肢(1:1 / 4:5 / 本数で切る)がUIから除去されている ----

t("webapp-mockup: UIに未実装の選択肢(1:1・4:5・本数で切る)が存在しない", () => {
  const html = fs.readFileSync(path.join(ROOT, "webapp-mockup", "index.html"), "utf-8");
  assert.ok(!html.includes('data-val="1:1"'), "1:1 は render-vertical.mjs 未実装のため除去済みのはず");
  assert.ok(!html.includes('data-val="4:5"'), "4:5 は render-vertical.mjs 未実装のため除去済みのはず");
  assert.ok(!html.includes('data-val="count"'), "本数で切る はdigest-editor未実装のため除去済みのはず");
});

t("webapp-mockup: 実装済みの選択肢(9:16・16:9・話題/分数)はUIに残っている", () => {
  const html = fs.readFileSync(path.join(ROOT, "webapp-mockup", "index.html"), "utf-8");
  assert.ok(html.includes('data-val="9:16"'));
  assert.ok(html.includes('data-val="16:9"'));
  assert.ok(html.includes('data-val="topic"'));
  assert.ok(html.includes('data-val="minutes"'));
});

// ---- レンダリング進捗ラベル(landscape対応) ----

t("renderLabel: portraitは縦長、landscapeは横長のラベルを返す", () => {
  assert.strictEqual(renderLabel("portrait"), "縦長の動画に整えています");
  assert.strictEqual(renderLabel("landscape"), "横長の動画に整えています");
  assert.strictEqual(renderLabel(undefined), "縦長の動画に整えています", "未知値は既定(縦長)");
});

t("webapp-mockup: SSEのd.labelを表示に反映する経路がある(EDITING_LABEL固定表示のみに戻っていない)", () => {
  const js = fs.readFileSync(path.join(ROOT, "webapp-mockup", "app.js"), "utf-8");
  assert.ok(
    /const\s*\{\s*stage,\s*status,\s*label\s*\}\s*=\s*d/.test(js),
    "es.onmessageでd.labelを分割代入していること(サーバーが送るorient別ラベルを読み捨てない)",
  );
  assert.ok(
    /label\s*\|\|\s*EDITING_LABEL\[stage\]/.test(js),
    "labelがあれば優先し、無い時だけEDITING_LABEL[stage]にフォールバックすること",
  );
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
