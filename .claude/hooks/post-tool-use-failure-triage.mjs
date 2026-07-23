// PostToolUseFailure — 微細エラー判定支援（マスター運用改善レポート§3-4実装・claude --debug 未検証）
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'state', 'post-tool-use-failure-counts.json');
const MAX_RETRY = 3;

const HIGH_COST_KEYWORDS = [
  'stripe', '決済', '課金', 'billing', 'payment',
  'auth', '認証', 'oauth', 'jwt',
  'migration', 'マイグレーション', 'migrate',
  '本番', 'production', '--prod',
  '.env', 'secrets', 'secret'
];

let input = '';
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(input);
    const toolName = j.tool_name || '';
    const cmd = (j.tool_input && (j.tool_input.command || j.tool_input.file_path)) || '';
    const errorText = JSON.stringify(j.tool_response || j.error || '');

    const sig = `${toolName}:${cmd}`.slice(0, 300);
    let state = {};
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
    state[sig] = (state[sig] || 0) + 1;
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    const count = state[sig];
    const isHighCost = HIGH_COST_KEYWORDS.some(k => (cmd + errorText).toLowerCase().includes(k.toLowerCase()));

    if (count > MAX_RETRY) {
      console.log(JSON.stringify({
        decision: 'block',
        reason: `⚠️ 同一エラー(${sig.slice(0, 80)}...)が${count}回連続。無限リトライループの疑い。マスターへ報告し方針確認せよ（最大リトライ${MAX_RETRY}回超過）。`
      }));
      return;
    }

    const advice = isHighCost
      ? '高コスト領域(課金/認証/マイグレーション/本番設定)の疑いあり。一文で説明できてもプランを立てて進めること。'
      : `再現回数=${count}回目。①現マイルストーンをブロックするか ②再現性 ③高コスト領域か ④一文で説明できるか、の順で判定せよ。`;

    console.log(JSON.stringify({ reason: `[微細エラー判定支援] ${advice}` }));
  } catch {
    process.exit(0);
  }
});
