// G-EDIT-UI-SETTINGS-VALIDATE / G-EDIT-UI-SETTINGS-ACCEPT の job-params 単体分の検証。
//
// parseJobParams() に新設した8設定(subStyle/captionFont/captionFill/captionOutlineColor/
// captionInner/captionBand/exportPreset/durationMin)について、
//   (1) 正当な値 → CLI側の正引き関数(getFont/getStyle/hexToAss/getExportPreset)が実際に
//       受理する値がそのまま返ること(G-EDIT-UI-SETTINGS-ACCEPT相当)。
//   (2) 不正・範囲外・欠落の値 → 例外を投げず、「何も送らなかった場合」と同じ既定値
//       (空文字列 or undefined)へ丸まること(G-EDIT-UI-SETTINGS-VALIDATE相当のうち job-params
//       単体で確認できる部分)。
//   (3) __proto__ / constructor をキー名に使ってもプロトタイプ汚染が起きないこと。
//
// 実行: node tests/job-params-ui-settings-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import { parseJobParams } from "../server/job-params.mjs";
import { getFont, getStyle, hexToAss } from "../src/subtitle-styles.mjs";
import { getExportPreset } from "../src/export-presets.mjs";

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name} ${e.message}`);
  }
}

// 何も送らなかった場合の「真の既定値」。丸めた結果がこれと一致するかを毎回突き合わせる
// (クラッシュしないことだけでは満たさない＝丸めた先が壊れた別の値になっていないかを見る)。
const DEFAULTS = parseJobParams(new URLSearchParams());
const UI_SETTINGS_KEYS = [
  "subStyle",
  "captionFont",
  "captionFill",
  "captionOutlineColor",
  "captionInner",
  "captionBand",
  "exportPreset",
  "durationMin",
];

// ── (1) 正当な値は、対応するCLI側パーサでも実際に受理される ────────────────────

t("subStyle=pop はそのまま通り、getStyle()が実際に受理する", () => {
  const p = parseJobParams(new URLSearchParams({ subStyle: "pop" }));
  assert.strictEqual(p.subStyle, "pop");
  assert.ok(getStyle(p.subStyle), "getStyle(subStyle) が null ではない");
});

t("captionFont=mincho はそのまま通り、getFont()が実際に受理する", () => {
  const p = parseJobParams(new URLSearchParams({ captionFont: "mincho" }));
  assert.strictEqual(p.captionFont, "mincho");
  assert.ok(getFont(p.captionFont), "getFont(captionFont) が null ではない");
});

t("captionFill=#FF0000 はそのまま通り、hexToAss()が実際に受理する", () => {
  const p = parseJobParams(new URLSearchParams({ captionFill: "#FF0000" }));
  assert.strictEqual(p.captionFill, "#FF0000");
  assert.notStrictEqual(hexToAss(p.captionFill), null);
});

t("captionOutlineColor=#00FF00 はそのまま通り、hexToAss()が実際に受理する", () => {
  const p = parseJobParams(new URLSearchParams({ captionOutlineColor: "#00FF00" }));
  assert.strictEqual(p.captionOutlineColor, "#00FF00");
  assert.notStrictEqual(hexToAss(p.captionOutlineColor), null);
});

t("captionInner=off はそのまま off として通る(無効化指定)", () => {
  const p = parseJobParams(new URLSearchParams({ captionInner: "off" }));
  assert.strictEqual(p.captionInner, "off");
});

t("captionInner=#FFFF00 はそのまま通り、hexToAss()が実際に受理する", () => {
  const p = parseJobParams(new URLSearchParams({ captionInner: "#FFFF00" }));
  assert.strictEqual(p.captionInner, "#FFFF00");
  assert.notStrictEqual(hexToAss(p.captionInner), null);
});

t("captionBand=#00000080 (8桁=RRGGBBAA) はそのまま通り、hexToAss()が実際に受理する", () => {
  const p = parseJobParams(new URLSearchParams({ captionBand: "#00000080" }));
  assert.strictEqual(p.captionBand, "#00000080");
  assert.notStrictEqual(hexToAss(p.captionBand), null);
});

t("captionBand=off はそのまま off として通る(無効化指定)", () => {
  const p = parseJobParams(new URLSearchParams({ captionBand: "off" }));
  assert.strictEqual(p.captionBand, "off");
});

t("exportPreset=light はそのまま通り、getExportPreset()が実際に受理する", () => {
  const p = parseJobParams(new URLSearchParams({ exportPreset: "light" }));
  assert.strictEqual(p.exportPreset, "light");
  assert.ok(getExportPreset(p.exportPreset), "getExportPreset(exportPreset) が null ではない");
});

t("durationMin=2 は数値2としてそのまま通る(topicモードのpipeline.mjs側が正の数値として受理できる形)", () => {
  const p = parseJobParams(new URLSearchParams({ durationMin: "2" }));
  assert.strictEqual(p.durationMin, 2);
  assert.ok(Number.isFinite(p.durationMin) && p.durationMin > 0);
});

// ── (2) 不正・範囲外・欠落は例外を投げず、「何も送らなかった場合」と同じ既定値へ丸まる ──

t("何も送らなかった場合の8設定の既定値(丸め先の基準)", () => {
  assert.strictEqual(DEFAULTS.subStyle, "");
  assert.strictEqual(DEFAULTS.captionFont, "");
  assert.strictEqual(DEFAULTS.captionFill, "");
  assert.strictEqual(DEFAULTS.captionOutlineColor, "");
  assert.strictEqual(DEFAULTS.captionInner, "");
  assert.strictEqual(DEFAULTS.captionBand, "");
  assert.strictEqual(DEFAULTS.exportPreset, "");
  assert.strictEqual(DEFAULTS.durationMin, undefined);
});

t("subStyle=unknown(未知のスタイル名)は例外を投げず既定(空)へ丸まる", () => {
  const p = parseJobParams(new URLSearchParams({ subStyle: "unknown" }));
  assert.strictEqual(p.subStyle, DEFAULTS.subStyle);
  assert.strictEqual(getStyle(p.subStyle), null, "丸めた値をgetStyleへ通しても受理されない(=未指定扱い)");
});

t("captionFont=__proto__(プロトタイプ汚染狙い)は例外を投げず既定(空)へ丸まる", () => {
  const p = parseJobParams(new URLSearchParams({ captionFont: "__proto__" }));
  assert.strictEqual(p.captionFont, DEFAULTS.captionFont);
  assert.strictEqual(getFont(p.captionFont), null);
});

t("captionFont=constructor(プロトタイプ汚染狙い)は例外を投げず既定(空)へ丸まる", () => {
  const p = parseJobParams(new URLSearchParams({ captionFont: "constructor" }));
  assert.strictEqual(p.captionFont, DEFAULTS.captionFont);
  assert.strictEqual(getFont(p.captionFont), null);
});

t("captionFill=red(色として不正な形式)は例外を投げず既定(空)へ丸まる", () => {
  const p = parseJobParams(new URLSearchParams({ captionFill: "red" }));
  assert.strictEqual(p.captionFill, DEFAULTS.captionFill);
  assert.strictEqual(hexToAss(p.captionFill), null);
});

t("captionFill=notacolor(色として不正な形式)は例外を投げず既定(空)へ丸まる", () => {
  const p = parseJobParams(new URLSearchParams({ captionFill: "notacolor" }));
  assert.strictEqual(p.captionFill, DEFAULTS.captionFill);
});

t("captionOutlineColor=notacolorは例外を投げず既定(空)へ丸まる", () => {
  const p = parseJobParams(new URLSearchParams({ captionOutlineColor: "notacolor" }));
  assert.strictEqual(p.captionOutlineColor, DEFAULTS.captionOutlineColor);
});

t("captionInner=red-ish(offでも色形式でもない)は例外を投げず既定(空)へ丸まる", () => {
  const p = parseJobParams(new URLSearchParams({ captionInner: "red-ish" }));
  assert.strictEqual(p.captionInner, DEFAULTS.captionInner);
  assert.notStrictEqual(p.captionInner, "off");
});

t("captionBand=xyz(offでも色形式でもない)は例外を投げず既定(空)へ丸まる", () => {
  const p = parseJobParams(new URLSearchParams({ captionBand: "xyz" }));
  assert.strictEqual(p.captionBand, DEFAULTS.captionBand);
  assert.notStrictEqual(p.captionBand, "off");
});

t("exportPreset=unknown(未知のプリセット名)は例外を投げず既定(空)へ丸まる", () => {
  const p = parseJobParams(new URLSearchParams({ exportPreset: "unknown" }));
  assert.strictEqual(p.exportPreset, DEFAULTS.exportPreset);
  assert.strictEqual(getExportPreset(p.exportPreset), null);
});

t("durationMin=-5(範囲外=0以下)は例外を投げず既定(undefined)へ丸まる", () => {
  const p = parseJobParams(new URLSearchParams({ durationMin: "-5" }));
  assert.strictEqual(p.durationMin, DEFAULTS.durationMin);
  assert.strictEqual(p.durationMin, undefined);
});

t("durationMin=0(範囲外=0は正の数ではない)は例外を投げず既定(undefined)へ丸まる", () => {
  const p = parseJobParams(new URLSearchParams({ durationMin: "0" }));
  assert.strictEqual(p.durationMin, undefined);
});

t("durationMin=abc(数値として不正)は例外を投げず既定(undefined)へ丸まる", () => {
  const p = parseJobParams(new URLSearchParams({ durationMin: "abc" }));
  assert.strictEqual(p.durationMin, DEFAULTS.durationMin);
  assert.strictEqual(p.durationMin, undefined);
});

t("durationMin=Infinity(有限でない)は例外を投げず既定(undefined)へ丸まる", () => {
  const p = parseJobParams(new URLSearchParams({ durationMin: "Infinity" }));
  assert.strictEqual(p.durationMin, undefined);
});

// ── 複合: 8設定すべてを一度に「意地悪な値」で送っても例外を投げず、まとめて既定値と一致する ──

t("8設定すべてに不正値を同時に送っても例外を投げず、まとめて既定値と一致する", () => {
  const q = new URLSearchParams({
    subStyle: "unknown",
    captionFont: "__proto__",
    captionFill: "notacolor",
    captionOutlineColor: "notacolor",
    captionInner: "red-ish",
    captionBand: "xyz",
    exportPreset: "unknown",
    durationMin: "-5",
  });
  let p;
  assert.doesNotThrow(() => { p = parseJobParams(q); });
  for (const k of UI_SETTINGS_KEYS) {
    assert.strictEqual(p[k], DEFAULTS[k], `${k} が既定値と一致すること`);
  }
});

// ── (3) __proto__ / constructor をキー名に使ってもプロトタイプ汚染が起きない ─────────

t("クエリのキー名自体に__proto__/constructorを使っても例外を投げず、Objectのプロトタイプが汚染されない", () => {
  const before = JSON.stringify(Object.getPrototypeOf({}));
  const q = new URLSearchParams(
    "__proto__[polluted]=yes&constructor[prototype][polluted]=yes&captionFont=kaku",
  );
  let p;
  assert.doesNotThrow(() => { p = parseJobParams(q); });
  // 通常の返り値であること(壊れたオブジェクトになっていない)
  assert.strictEqual(p.captionFont, "kaku");
  assert.ok(getFont(p.captionFont));
  // グローバルなObjectのプロトタイプに polluted が生えていないこと
  const after = JSON.stringify(Object.getPrototypeOf({}));
  assert.strictEqual(after, before, "Object.prototype が変化していない");
  assert.strictEqual({}.polluted, undefined, "新規オブジェクトに polluted が生えていない");
});

t("__proto__をキー名にしたクエリでcaptionFont/subStyle/exportPresetへ__proto__を直接渡しても既定へ丸まる", () => {
  const q = new URLSearchParams();
  q.set("__proto__", "ignored");
  q.set("captionFont", "__proto__");
  q.set("subStyle", "__proto__");
  q.set("exportPreset", "__proto__");
  let p;
  assert.doesNotThrow(() => { p = parseJobParams(q); });
  assert.strictEqual(p.captionFont, "");
  assert.strictEqual(p.subStyle, "");
  assert.strictEqual(p.exportPreset, "");
});

// ── 退行防止: 既存8項目(sub/cut/size/cutMin/mosaic/trim/breath/name)の挙動は変えていない ──

t("既存項目(sub/cut/size/cutMin/mosaic/trim/breath/name)は今回の変更後も既定どおり", () => {
  const p = parseJobParams(new URLSearchParams());
  assert.strictEqual(p.sub, "none");
  assert.strictEqual(p.cut, "topic");
  assert.strictEqual(p.size, "9:16");
  assert.strictEqual(p.cutMin, 3);
  assert.strictEqual(p.mosaic, "none");
  assert.strictEqual(p.trim, "none");
  assert.strictEqual(p.breath, "");
  assert.strictEqual(p.name, "upload.mp4");
});

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
