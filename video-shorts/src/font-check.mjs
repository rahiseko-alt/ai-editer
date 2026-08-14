// 字幕に使うフォントが、実際にこのマシンで使えるかを確認する。
//
// 背景（2026-08-14 実素材の初回処理・docs/failures.md）：字幕の既定フォントに
// "Yu Gothic UI"（Windows専用）を指定していたが、この環境（Linux）には存在せず、
// fontconfig が黙って中国語フォント(WenQuanYi Zen Hei)へ代替し、日本語が中国語の
// 字形で焼かれた。fc-match は指定した名前が存在しなくても必ず何かを返すため、
// 「存在しない」ことを fc-match の結果だけから判定するのは信頼できない
// （実際に見つからない名前を渡しても fc-match は代替フォントを返してくる）。
//
// そこで fc-list が実際に持っているフォント family の一覧に、指定した名前が
// （エイリアスを含め）完全一致で載っているかを見る。載っていなければ「無い」と
// 断定できる（fc-match の代替解決を経由しないため、この判定は「存在しない」と
// 言えるときに実際に「存在しない」と言える＝AGENTS.mdの対照の規律を満たす）。

import { spawnSync } from "node:child_process";

/**
 * fc-list が使えるかどうか。
 * @returns {boolean}
 */
function hasFcList() {
  return spawnSync("sh", ["-c", "command -v fc-list"]).status === 0;
}

/**
 * この環境に実在するフォント family 名の一覧（エイリアス展開済み）を返す。
 * fc-list の1行は "パス: family1,family2,... :style=..." の形式で、family は
 * カンマ区切りで複数（多言語名を含む）並ぶことがあるため、カンマで分割して集める。
 * @returns {string[]}
 */
function listInstalledFamilies() {
  const r = spawnSync("fc-list", [":", "family"], { encoding: "utf-8" });
  if (r.status !== 0) return [];
  return (r.stdout || "")
    .split("\n")
    .flatMap((line) => line.split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 指定したフォント名が、この環境に実際に存在するかを確認する。
 * @param {string} fontName
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkFontAvailable(fontName) {
  if (typeof fontName !== "string" || fontName.trim() === "") {
    return { ok: false, reason: "フォント名が指定されていません。" };
  }
  if (!hasFcList()) {
    return {
      ok: false,
      reason: "fc-list（fontconfig）が見つからないため、フォントの有無を確認できません。" +
        "fontconfig を導入してください。",
    };
  }
  const families = listInstalledFamilies();
  const found = families.some((f) => f.toLowerCase() === fontName.toLowerCase());
  if (found) return { ok: true, reason: "" };
  return {
    ok: false,
    reason: `字幕用のフォント「${fontName}」がこの環境に見つかりません。` +
      `日本語フォント（例: IPAGothic）を導入するか、導入済みのフォント名を指定してください。` +
      `このまま進めると、字幕が別の言語の字形で無言のまま焼かれます。`,
  };
}
