import fs from "node:fs"; import { spawnSync } from "node:child_process";
import { FONTS_DIR, FONT_CATALOG } from "./src/subtitle-styles.mjs";
import { readPixelsRgb } from "./tests/helpers/caption-style-render.mjs";
const OUT="/tmp/claude-0/-home-user-ai-editer/1a8d1d40-5895-5ed4-bd79-40e1ed584813/scratchpad";
const W=1080,H=300,FS=84;
// 背景は純緑。文字は白・縁取りは黒。縁取りが太って隣とくっつくと、文字の帯の中から緑が消える。
function bgGapRatio(outline, fam="Noto Sans JP Black"){
  const ass=`[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: C,${fam},${FS},&H00FFFFFF,&H00000000,&H00000000,1,1,${outline},0,5,10,10,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,C,,0,0,0,,今日は動画編集の話
`;
  fs.writeFileSync(`${OUT}/o.ass`,ass,"utf-8");
  spawnSync("ffmpeg",["-y","-v","error","-f","lavfi","-i",`color=size=${W}x${H}:color=0x00ff00:d=2`,
    "-vf",`ass=filename=${OUT}/o.ass:fontsdir=${FONTS_DIR}`,"-ss","1","-frames:v","1",`${OUT}/o.png`]);
  const buf=readPixelsRgb(`${OUT}/o.png`);
  // 文字の帯（縦の中央±FS/2）の中で、緑のままの画素の割合
  const y0=Math.round(H/2-FS/2), y1=Math.round(H/2+FS/2);
  let green=0,total=0;
  // 横は文字が実際に載っている範囲だけを見る（左右の余白を数えない）
  let minX=W,maxX=0;
  for(let y=y0;y<y1;y++)for(let x=0;x<W;x++){const i=(y*W+x)*3;
    const isG=buf[i]<60&&buf[i+1]>180&&buf[i+2]<60;
    if(!isG){if(x<minX)minX=x;if(x>maxX)maxX=x;}}
  for(let y=y0;y<y1;y++)for(let x=minX;x<=maxX;x++){const i=(y*W+x)*3;
    total++; if(buf[i]<60&&buf[i+1]>180&&buf[i+2]<60) green++;}
  return {ratio:green/total, width:maxX-minX};
}
console.log("書体ごと・縁取り比ごとの「地が残る割合」（fontSize=84）");
const ratios=[0.05,0.06,0.07,0.08,0.09];
console.log("        " + ratios.map(r=>`${(r*100).toFixed(0)}%(${Math.round(FS*r)}px)`.padStart(10)).join(""));
for(const [k,f] of Object.entries(FONT_CATALOG)){
  const row=ratios.map(r=>`${(bgGapRatio(Math.round(FS*r),f.family).ratio*100).toFixed(1)}%`.padStart(10)).join("");
  console.log(k.padEnd(8)+row);
}
