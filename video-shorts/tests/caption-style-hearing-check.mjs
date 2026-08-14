// G-EDIT-CAPTION-STYLE-HEARING — CLI(--caption-font/--caption-fill/--caption-outline-color/
// --caption-inner/--caption-band)で指定した5項目が、実際にレンダリングまで渡ることを検証する。
// (--sub-styleと同じ「render時に指定する」設計。init時のstate.jsonには保存しない)
//
// 実行: node tests/caption-style-hearing-check.mjs   (全PASSで exit 0。ffmpeg必須)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hexToAss } from "../src/subtitle-styles.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PIPELINE = path.join(ROOT, "pipeline.mjs");

let pass = 0, fail = 0;
function check(cond, name, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

function cmdAvailable(bin) {
  return spawnSync(bin, ["-version"]).status === 0;
}
if (!cmdAvailable("ffmpeg") || !cmdAvailable("ffprobe")) {
  console.log("FAIL ffmpeg/ffprobe が見つかりません。CI では quality ジョブで導入しています。");
  process.exit(1);
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "caption-hearing-"));
const jobDirs = [];
try {
  const src = path.join(WORK, "src.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=15:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", src]);

  const HOOK = "HEARINGWIRE", KEEP_TEXT = "HEARINGWIRE CHECK OK";
  const transcriptFixturePath = path.join(WORK, "fixture-transcript.json");
  fs.writeFileSync(transcriptFixturePath, JSON.stringify({
    language: "en", duration: 1.0,
    words: [{ w: "HEARINGWIRE", start: 0.0, end: 0.4 }, { w: "CHECK", start: 0.4, end: 0.7 }, { w: "OK", start: 0.7, end: 0.9 }],
    segments: [{ start: 0.0, end: 0.9, text: KEEP_TEXT }],
  }));

  const initR = spawnSync(process.execPath,
    [PIPELINE, "init", src, "--mode", "topic", "--sub", "on", "--orient", "縦"],
    { cwd: ROOT, encoding: "utf-8" });
  const workDir = (initR.stdout || "").trim();
  check(initR.status === 0 && !!workDir, "init: ジョブ作成が成功する", initR.stderr);
  jobDirs.push(path.basename(workDir));
  fs.copyFileSync(transcriptFixturePath, path.join(workDir, "transcript.json"));
  spawnSync(process.execPath, [PIPELINE, "select", workDir, "--mode", "topic"], { cwd: ROOT, encoding: "utf-8" });
  fs.writeFileSync(path.join(workDir, "llm-response.json"),
    JSON.stringify({ segments: [{ keepText: KEEP_TEXT, hook: HOOK }] }));

  // 既定と異なる5項目をすべてCLIで指定する。
  const CAPTION_FONT = "maru";
  const CAPTION_FILL = "#123456";
  const CAPTION_OUTLINE_COLOR = "#654321";
  const CAPTION_INNER = "#00FF00";
  const CAPTION_BAND = "#101010";

  const renderR = spawnSync(process.execPath, [PIPELINE, "render", workDir,
    "--sub-style", "bold",
    "--caption-font", CAPTION_FONT,
    "--caption-fill", CAPTION_FILL,
    "--caption-outline-color", CAPTION_OUTLINE_COLOR,
    "--caption-inner", CAPTION_INNER,
    "--caption-band", CAPTION_BAND,
  ], { cwd: ROOT, encoding: "utf-8" });
  check(renderR.status === 0, "render: CLI引数(5項目)を指定したレンダリングが成功する", renderR.stderr);

  const assPath = path.join(workDir, "clip-1.ass");
  check(fs.existsSync(assPath), "render: clip-1.ass が実際に生成されている", assPath);

  if (fs.existsSync(assPath)) {
    const ass = fs.readFileSync(assPath, "utf-8");
    const styleLine = ass.split("\n").find((l) => l.startsWith("Style: Caption,"));
    check(!!styleLine, "生成された.assにCaptionスタイル行がある", ass);

    // Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold,
    //         BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
    const fields = (styleLine || "").split(",");
    const [, fontname, , primaryColour, outlineColour, backColour, , borderStyle] = fields;

    check(
      fontname === "M PLUS Rounded 1c Black",
      "--caption-font maru の指定が、実際に生成された.assのFontnameに反映されている",
      `Fontname=${fontname}`,
    );
    check(
      primaryColour === hexToAss(CAPTION_FILL),
      "--caption-fill の指定が、実際に生成された.assのPrimaryColourに反映されている",
      `PrimaryColour=${primaryColour} 期待=${hexToAss(CAPTION_FILL)}`,
    );
    check(
      outlineColour === hexToAss(CAPTION_OUTLINE_COLOR),
      "--caption-outline-color の指定が、実際に生成された.assのOutlineColourに反映されている",
      `OutlineColour=${outlineColour} 期待=${hexToAss(CAPTION_OUTLINE_COLOR)}`,
    );
    check(
      borderStyle === "3" && backColour === hexToAss(CAPTION_BAND),
      "--caption-band の指定が、実際に生成された.assのBorderStyle=3・BackColourに反映されている",
      `BorderStyle=${borderStyle} BackColour=${backColour} 期待BackColour=${hexToAss(CAPTION_BAND)}`,
    );

    // 内側縁取り: applyInnerOutline()がLayer0/Layer1の2重Dialogueへ複製している
    // (srt-builder.mjsの実装。フォント/色系と違いStyle行ではなくEvents行に現れる)。
    const dialogueLines = ass.split("\n").filter((l) => l.startsWith("Dialogue:") && l.includes(",Caption,"));
    const hasLayer0Bord = dialogueLines.some((l) => /^Dialogue: 0,/.test(l) && l.includes("\\bord"));
    const hasLayer1WithInnerColor = dialogueLines.some(
      (l) => /^Dialogue: 1,/.test(l) && l.includes(`\\3c${hexToAss(CAPTION_INNER)}`),
    );
    check(
      hasLayer0Bord && hasLayer1WithInnerColor,
      "--caption-inner の指定が、実際に生成された.assの2重Dialogue(内側縁取り)に反映されている",
      `layer0Bord=${hasLayer0Bord} layer1Inner=${hasLayer1WithInnerColor}`,
    );
  }
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
  for (const id of jobDirs) {
    fs.rmSync(path.join(ROOT, "work", id), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, "output", id), { recursive: true, force: true });
  }
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
