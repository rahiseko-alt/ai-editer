#!/usr/bin/env node
// .claude/hooks/job-application-agent-gate.mjs
// UserPromptSubmit: マスターの発話が「求人・案件への応募文」を求めていると機械検知したら、
// job-application-writer サブエージェントへの委譲を AI に強制的に想起させる。
//
// 設計思想: AI 自己規律を信用しない（CLAUDE.md §4）。description ベースの自動委譲は
// 確率的で、忘れれば司令塔が直に書き、事実を捏造する（2026-07-09 実害: 氏名の読み捏造・
// 61分32秒→「1時間5分」誤記）。機構で想起を強制する。
//
// 出力形: hookSpecificOutput.additionalContext（非ブロッキング助言注入）。
//
// 発火条件（すべて満たす時のみ・セッション1回）:
//   1. prompt に応募系トリガー語が含まれる
//   2. prompt に除外語（出品・営業提案書・改善提案 等）が含まれない
//      → 「提案」「ココナラ」単独では発火させない。応募以外の提案文脈で誤発火するため。
//   3. このセッションで未提案

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/\\/g, '/');

// 応募トリガー: 「求人・案件に応募する」意図が明確な語のみ
const TRIGGER_RE = /(応募文|応募したい|応募する|求人に応募|案件に応募|この求人|募集要項|職務経歴書|エントリーシート|ココナラの提案文|案件へ提案)/;

// 除外: 応募ではない「提案」文脈。ここに一致したら発火しない
const EXCLUDE_RE = /(出品|営業提案書|改善提案|提案書を作|プロダクト提案|企画提案|見積書|提案資料)/;

function done() { process.exit(0); } // 無出力 = 通常フロー継続

function emit(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  }));
  process.exit(0);
}

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(data); } catch { return done(); }
  try {
    const prompt = String(input.prompt || '');
    if (!prompt) return done();

    // 条件1・2
    if (!TRIGGER_RE.test(prompt)) return done();
    if (EXCLUDE_RE.test(prompt)) return done();

    // 条件3: セッション内 dedup（session_id が無い時は永久サイレント化を避け都度判定）
    const rawSid = input.session_id ? String(input.session_id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : '';
    if (rawSid) {
      const markerDir = path.join(PROJECT_DIR, '.claude', '.job-application-gate');
      const marker = path.join(markerDir, `fired-${rawSid}`);
      try { if (fs.existsSync(marker)) return done(); } catch { /* 判定不能時は提案側に倒す */ }
      try { fs.mkdirSync(markerDir, { recursive: true }); fs.writeFileSync(marker, new Date().toISOString(), 'utf-8'); } catch { /* 書けなくても提案は出す */ }
    }

    const context = [
      '[job-application-gate] 応募文・提案文の作成要求を検知しました。',
      '司令塔が直に書くな。Agent ツールで subagent_type="job-application-writer" に委譲せよ（フォアグラウンド実行・run_in_background:false）。',
      '委譲前に、マスターから「骨子（事実）」を受け取っているか確認せよ。骨子が無ければ書かせるな。骨子なしで書かせると事実を捏造する（氏名の読み・数値の算術を誤る実害あり）。',
      '骨子が未提示なら、まずマスターに骨子を求めよ。',
      'サブが出力したら、内容を鵜呑みにせず、骨子との差分（骨子に無いのに書かれた事実）と数値の算術を必ず自分で検算せよ。',
      'この提案はこのセッションでは一度だけ表示されます。',
    ].join(' ');
    return emit(context);
  } catch (e) {
    process.stderr.write(`[job-application-gate] error: ${e && e.message}\n`);
    return done();
  }
});
