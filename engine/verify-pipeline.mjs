#!/usr/bin/env node
// kosespark Writer エンジン — パイプライン機械検証ゲート
// 使い方: node engine/verify-pipeline.mjs <id>
// 役割: 「完成」を Claude の自己申告でなく機械で判定する（サイレントフェイル禁止の強制）。
// 終了コード: 0=全工程パス / 2=1件以上の欠落・空・未完（= ブロック）

import fs from 'node:fs';
import path from 'node:path';

const id = process.argv[2];
if (!id) {
  console.error('[verify] 引数 <id> が必要です。例: node engine/verify-pipeline.mjs 20260616-001');
  process.exit(2);
}

const base = path.join('workspace', 'pipeline', id);

// 工程 → 必須出力ファイル（PIPELINE.md と一致させること）
const STEPS = [
  { key: 'research', file: '01-research.md', label: 'リサーチ(DuckDuckGo)' },
  { key: 'write',    file: '02-draft.md',   label: '執筆(Claude)' },
  { key: 'proof',    file: '03-revised.md', label: '校正(textlint)' },
  { key: 'slide',    file: '04-slide.html', label: 'スライド(Marp)' },
];

const errors = [];

// 1) ディレクトリ存在
if (!fs.existsSync(base)) {
  console.error(`[verify] FAIL: 作業ディレクトリが存在しません: ${base}`);
  process.exit(2);
}

// 2) 各工程の出力が存在し非空か
for (const s of STEPS) {
  const p = path.join(base, s.file);
  if (!fs.existsSync(p)) {
    errors.push(`${s.label}: 出力ファイル不在 (${s.file})`);
  } else if (fs.statSync(p).size === 0) {
    errors.push(`${s.label}: 出力ファイルが空 (${s.file})`);
  }
}

// 3) state.json と整合（全工程 done か）
const statePath = path.join(base, 'state.json');
if (!fs.existsSync(statePath)) {
  errors.push('state.json が不在');
} else {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    for (const s of STEPS) {
      const st = state.steps?.[s.key]?.status;
      if (st !== 'done') {
        errors.push(`${s.label}: state.json の status が "${st ?? '未定義'}"（done でない）`);
      }
    }
  } catch (e) {
    errors.push(`state.json が不正な JSON: ${e.message}`);
  }
}

// 4) 校正結果に未対応の error が残っていないか（lint.json があれば確認）
const lintPath = path.join(base, '03-lint.json');
if (fs.existsSync(lintPath)) {
  try {
    const lint = JSON.parse(fs.readFileSync(lintPath, 'utf8'));
    const messages = Array.isArray(lint) ? lint.flatMap(r => r.messages || []) : (lint.messages || []);
    const remaining = messages.filter(m => m.severity === 2).length;
    if (remaining > 0) {
      console.error(`[verify] WARN: 校正 error が ${remaining} 件残存（意図的残置か要確認・03-lint.json）`);
    }
  } catch { /* lint.json の解析失敗は WARN 扱いにせずスキップ */ }
}

if (errors.length > 0) {
  console.error(`[verify] FAIL (${base}):`);
  for (const e of errors) console.error('  - ' + e);
  console.error('[verify] サイレントフェイル検知。完成と扱わず停止してください。');
  process.exit(2);
}

console.log(`[verify] PASS: ${base} — 4 工程すべて出力あり・非空・state done`);
process.exit(0);
