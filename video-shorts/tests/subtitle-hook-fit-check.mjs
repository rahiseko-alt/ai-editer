// 見出し(Hook)が画面外へはみ出す不具合の検証 — M2 (User Goal「字幕が画面内に収まる」)
//
// 実素材(10分17秒のインタビュー)を製品の入口から処理したところ、区間の見出し
// 「減量完了、緊張ゼロ / 空手道場で仕上げた2週間」(横幅40カラム)が、画面に入る量
// (Hookスタイル: フォントサイズ66・左右余白40 → 32カラム)を大きく超えたまま、
// 区間の全長(2分58秒)にわたって左右へはみ出して表示され続けていた
// (docs/failures.md 2026-08-14)。原因は buildAss() の Hook 行だけが
// splitByDisplayWidth() を一度も通っていなかったこと(修正前は
// `{\\an8}${escAss(hook)}` と改行なしでそのまま埋め込んでいた)。
//
// この検査は3点を守る。
//   (1) 長い見出しが実際に \N で複数行へ折り返されること(偽物: 折り返さない旧実装)。
//   (2) 折り返した結果、元の見出し文字列が1文字も欠落・重複しないこと(偽物: 単純truncate)。
//   (3) 実際にIPAGothicで焼いたフレームで、見出しの画素が画面左右端から
//       40px以上内側に収まること(=UAC-1(a)・INV-1)。
//
// 実行: node tests/subtitle-hook-fit-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildAss } from "../src/srt-builder.mjs";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

// 実素材の初回処理で実際に生成された見出し文(docs/failures.md 2026-08-14に実測記録)。
const HOOK = "減量完了、緊張ゼロ / 空手道場で仕上げた2週間";

/** ASS本文からHookイベントのテキスト(タグ除去済み)を取り出す。 */
function extractHookText(ass) {
  const line = ass.split("\n").find((l) => l.startsWith("Dialogue:") && l.includes(",Hook,"));
  if (!line) return null;
  const text = line.split(",Hook,,0,0,0,,")[1] ?? "";
  return text.replace(/\{[^}]*\}/g, ""); // {\an8} 等のASSタグを除去(\Nは残す)
}

// ── (1)(2) 折り返しと欠落0語 ──────────────────────────────────────────
const assDoc = buildAss([], HOOK, 10, { width: 1080, height: 1920, style: "karaoke" });
const hookRaw = extractHookText(assDoc);

check("Hookイベントが生成されている", hookRaw !== null, "Hook Dialogue行が見つからない");

check(
  "長い見出しが実際に複数行へ折り返される(\\Nを含む)",
  !!hookRaw && hookRaw.includes("\\N"),
  `実際のHook本文: ${hookRaw}`,
);

const reassembled = (hookRaw || "").split("\\N").join("");
check(
  "折り返した各行を繋ぎ合わせると、元の見出し文字列と完全一致する(1文字も欠落・重複していない)",
  reassembled === HOOK,
  `期待 "${HOOK}" (${HOOK.length}字) / 実 "${reassembled}" (${reassembled.length}字)`,
);

// 対照: 旧実装(折り返さずそのまま埋め込む)を模した文字列は、この検査の観点(1)を満たさない。
const oldStyleHook = HOOK; // \N を一切含まない、旧実装が生成していたのと同じ形
check(
  "対照: 折り返さない旧実装相当の出力は、複数行チェックで落ちる形になっている",
  !oldStyleHook.includes("\\N"),
);

// 短い見出しは従来どおり1行のまま(回帰なし)。
const shortAss = buildAss([], "短い見出し", 5, { width: 1080, height: 1920, style: "karaoke" });
const shortHook = extractHookText(shortAss);
check(
  "画面に収まる短い見出しは、折り返されず1行のまま(不要な変化が無い)",
  !!shortHook && !shortHook.includes("\\N") && shortHook === "短い見出し",
  `実 ${shortHook}`,
);

// ── (3) 実際に焼いて画素で確認 ────────────────────────────────────────
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
if (!has("ffmpeg")) {
  console.log("FAIL ffmpeg が見つかりません。CI では quality ジョブで導入しています。");
  fail++;
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-fit-"));
  const assPath = path.join(tmp, "hook.ass");
  // 実際に使うフォント(IPAGothic。M3でこの環境の既定になる)で焼く。
  // buildAss の fontMain 既定値に依存せず、この検査自身が意図するフォントを明示する。
  const assForRender = assDoc.replace(/Style: Hook,[^,]+,/, "Style: Hook,IPAGothic,");
  fs.writeFileSync(assPath, assForRender, "utf-8");

  const outPng = path.join(tmp, "frame.png");
  // 背景は黒(bboxのmin_val=24で文字だけを前景として拾うため。灰色背景だと背景全体が
  // 前景と誤検出される＝AUD-P2-22等の既存テストと同じ手法)。
  const r = spawnSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", "color=size=1080x1920:color=black:d=1",
    "-vf", `ass=${assPath}`,
    "-frames:v", "1", outPng], { encoding: "utf-8" });
  check("Hookを実際にffmpeg(ass filter)で焼けた", r.status === 0, r.stderr || "");

  if (fs.existsSync(outPng)) {
    const bbox = spawnSync("ffmpeg", ["-i", outPng, "-vf", "bbox=min_val=24", "-f", "null", "-"],
      { encoding: "utf-8" });
    const m = (bbox.stderr || "").match(/x1:(\d+)\s+x2:(\d+)/);
    check("焼いたフレームから見出しの画素範囲が読める", !!m, bbox.stderr);
    if (m) {
      const x1 = Number(m[1]);
      const x2 = Number(m[2]);
      const CANVAS_W = 1080;
      check(
        "見出しの左端が画面左端から40px以上内側にある(UAC-1a)",
        x1 >= 40,
        `x1=${x1}`,
      );
      check(
        "見出しの右端が画面右端から40px以上内側にある(UAC-1a)",
        CANVAS_W - x2 >= 40,
        `x2=${x2} canvasW=${CANVAS_W}`,
      );
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
