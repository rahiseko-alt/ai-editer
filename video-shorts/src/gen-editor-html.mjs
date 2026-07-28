import { readFileSync, writeFileSync } from 'fs';

const cJSON = JSON.parse(readFileSync(
  'C:/Users/user/Desktop/ClaudeCode/vibe-base/products/kosespark/video-shorts/output/OpenAI-Academy/candidates.json',
  'utf8'
));
const tJSON = JSON.parse(readFileSync(
  'C:/Users/user/Desktop/ClaudeCode/vibe-base/products/kosespark/video-shorts/work/OpenAI-Academy/transcript.json',
  'utf8'
));

const clips = cJSON.candidates;
const words = tJSON.words;

// Build full text with word timestamps
// Split into used / unused regions
const regions = [];
let i = 0;
for (const cl of clips) {
  // collect words before this clip
  const before = [];
  while (i < words.length && words[i].start < cl.start - 0.1) {
    before.push(words[i].w); i++;
  }
  if (before.length) regions.push({ type: 'unused', text: before.join(' ') });
  // collect words in this clip
  const inClip = [];
  while (i < words.length && words[i].end <= cl.end + 0.5) {
    inClip.push(words[i].w); i++;
  }
  regions.push({ type: 'clip', clip: cl, text: inClip.join(' ') });
}
// remaining words
const after = [];
while (i < words.length) { after.push(words[i].w); i++; }
if (after.length) regions.push({ type: 'unused', text: after.join(' '), label: '未採用 — 末尾' });

// Assign labels to unused blocks
let unusedIdx = 0;
const unusedLabels = [
  '未採用 — 冒頭',
  '未採用',
  '未採用',
  '未採用',
  '未採用 — 末尾',
];
for (const r of regions) {
  if (r.type === 'unused' && !r.label) {
    // compute time range from surrounding clips
    r.label = unusedLabels[unusedIdx] || '未採用';
    unusedIdx++;
  }
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const css = `
body{font-family:'Segoe UI',sans-serif;background:#f5f5f5;color:#222;line-height:1.8;margin:0}
*{box-sizing:border-box}
.header{background:#1a1a2e;color:#fff;padding:20px 32px;position:sticky;top:0;z-index:100;display:flex;align-items:center;gap:16px}
.header h1{font-size:16px;font-weight:600}
.legend{display:flex;gap:16px;margin-left:auto;font-size:12px;align-items:center}
.legend-item{display:flex;align-items:center;gap:6px}
.dot{width:12px;height:12px;border-radius:2px}
.dot-clip{background:#ffd600}.dot-unused{background:#ddd}
.container{max-width:820px;margin:0 auto;padding:32px 24px}
.how-to{background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px 20px;margin-bottom:28px;font-size:13px;color:#555;line-height:1.7}
.how-to strong{color:#222}
.gap{height:8px}
.clip-block{background:#fffde7;border-left:4px solid #ffd600;border-radius:0 6px 6px 0;padding:14px 16px;margin-bottom:4px}
.clip-header{display:flex;align-items:baseline;gap:10px;margin-bottom:8px;flex-wrap:wrap}
.clip-badge{background:#ffd600;color:#222;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;white-space:nowrap}
.clip-hook{font-size:13px;font-weight:600;color:#555}
.clip-meta{font-size:11px;color:#999;margin-left:auto;white-space:nowrap}
.clip-text{font-size:14px;color:#222;line-height:1.8}
.unused-block{background:#fafafa;border-left:4px solid #ddd;border-radius:0 6px 6px 0;padding:14px 16px;margin-bottom:4px}
.unused-label{font-size:10px;color:#bbb;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
.unused-text{font-size:13px;color:#888;line-height:1.8}
`;

let bodyHtml = '';
for (const r of regions) {
  if (r.type === 'clip') {
    const cl = r.clip;
    bodyHtml += `
<div class="clip-block">
  <div class="clip-header">
    <span class="clip-badge">CLIP #${cl.index}</span>
    <span class="clip-hook">${esc(cl.hook)}</span>
    <span class="clip-meta">${cl.start}s〜${cl.end}s｜${cl.duration.toFixed(0)}秒</span>
  </div>
  <div class="clip-text">${esc(r.text)}</div>
</div><div class="gap"></div>`;
  } else {
    bodyHtml += `
<div class="unused-block">
  <div class="unused-label">${r.label || '未採用'}</div>
  <div class="unused-text">${esc(r.text)}</div>
</div><div class="gap"></div>`;
  }
}

const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>OpenAI Academy — トランスクリプト編集ビュー</title>
<style>${css}</style>
</head>
<body>
<div class="header">
  <h1>OpenAI Academy — トランスクリプト編集ビュー</h1>
  <div class="legend">
    <div class="legend-item"><div class="dot dot-clip"></div>採用クリップ</div>
    <div class="legend-item"><div class="dot dot-unused"></div>未採用（延長・追加の候補）</div>
  </div>
</div>
<div class="container">
  <div class="how-to">
    <strong>使い方：</strong> 黄色 = 採用済みクリップ。グレー = 未採用部分。<br>
    「CLIP#1とCLIP#2をつなげて」「CLIP#3の直後の段落も入れて」のようにクリップ番号を指定してAIに再編集を依頼してください。
  </div>
  ${bodyHtml}
  <div style="height:48px"></div>
</div>
</body>
</html>`;

writeFileSync('C:/Users/user/Desktop/OpenAI-Academy-transcript-editor.html', html, 'utf8');
console.log('done — C:/Users/user/Desktop/OpenAI-Academy-transcript-editor.html');
