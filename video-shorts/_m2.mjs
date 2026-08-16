import fs from "node:fs"; import { spawnSync } from "node:child_process";
import { FONT_CATALOG as FONTS, FONTS_DIR } from "./src/subtitle-styles.mjs";
const OUT="/tmp/claude-0/-home-user-ai-editer/1a8d1d40-5895-5ed4-bd79-40e1ed584813/scratchpad";
const W=1080,H=1920,FS=84;
function ink(text,fontName){
  const ass=`[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: C,${fontName},${FS},&H00FFFFFF,&H00000000,&H00000000,1,1,0,0,2,5,5,400,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,C,,0,0,0,,${text}
`;
  fs.writeFileSync(`${OUT}/f.ass`,ass,"utf-8");
  spawnSync("ffmpeg",["-y","-v","error","-f","lavfi","-i",`color=size=${W}x${H}:color=black:d=2`,
    "-vf",`ass=filename=${OUT}/f.ass:fontsdir=${FONTS_DIR}`,"-ss","1","-frames:v","1",`${OUT}/f.png`]);
  const r=spawnSync("ffmpeg",["-i",`${OUT}/f.png`,"-vf","bbox=min_val=24","-f","null","-"],{encoding:"utf-8"});
  const m=(r.stderr||"").match(/x1:(\d+)\s+x2:(\d+)/);
  return m?(+m[2]-+m[1]):null;
}
console.log("同梱書体ごとの1文字あたりの幅（fontSize=84 に対する比）");
for (const [key,f] of Object.entries(FONTS)) {
  const name=f.family||f.name||f;
  const w4=ink("あ".repeat(4),name), w8=ink("あ".repeat(8),name);
  const a4=ink("ABCD",name), a8=ink("ABCDABCD",name);
  const wide=(w8-w4)/4, half=(a8-a4)/4;
  console.log(`  ${key.padEnd(7)} (${String(name).padEnd(22)}) 全角 ${(wide/FS).toFixed(3)} / 半角 ${(half/FS).toFixed(3)}`);
}
