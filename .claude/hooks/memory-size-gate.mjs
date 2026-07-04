#!/usr/bin/env node
/**
 * memory-size-gate.mjs
 *
 * PreToolUse hook for Write|Edit.
 * memory 系ファイルの「書込時バイト上限」を機械強制する（context 圧迫の再肥大封鎖）。
 *
 * 背景: 既存の行数ベース check（check-in-verify.sh の memory.md 200 行）は
 *   (a) 事後 WARN/NG で書込を止めない (b) 行数測定なので 1 行長文化をすり抜ける。
 *   context コストは行数でなくバイト。本 gate はバイト測定 × 書込時 deny で補完する。
 *
 * EARS:
 *   WHEN Write|Edit targets a memory file
 *     (failures.md / memory.md / MEMORY.md / docs/session-reports/*.md)
 *     AND the resulting file byte size exceeds its budget
 *   THE SYSTEM SHALL block the write and instruct archival/trim.
 *   OK -> exit 0 / NG -> stdout {decision:"block", reason}, exit 0
 *
 * 閾値は「実測最大＋余裕」に校正＝再肥大（≒倍増）を止める stop-the-bleeding 値。
 *   既存ファイルを縮小させる目的ではない（縮小は archival 別タスク）。
 *   読み取り側コスト（pc-checkin の全文 Read）は scripts/failures-recent.sh で別途縮小。
 *
 * 参照: docs/ops/plans/2026-06-23-memory-context-bloat-fix.md
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_PATH = path.join(PROJECT_DIR, '.claude', 'logs', 'memory-size-gate.err');

// バイト上限（stop-the-bleeding 校正・実測最大＋余裕）。大文字/小文字を厳密区別するため i フラグ不使用。
const BUDGETS = [
  { test: /(^|\/)MEMORY\.md$/,   limit: 10000, label: 'MEMORY.md（auto-memory・全セッション auto-load）' },
  { test: /(^|\/)failures\.md$/, limit: 28000, label: 'failures.md' },
  { test: /(^|\/)memory\.md$/,   limit: 12000, label: 'memory.md（引継ぎ）' },
  { test: /\/docs\/session-reports\/[^/]+\.md$/, limit: 10000, label: 'session-report' },
];

function logErr(label, err) {
  try {
    const stamp = new Date().toISOString();
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${stamp}] ${label}: ${err?.stack || err?.message || String(err)}\n`);
  } catch {}
}
process.on('uncaughtException', e => { logErr('uncaughtException', e); process.exit(0); });
process.on('unhandledRejection', e => { logErr('unhandledRejection', e); process.exit(0); });

function bytes(s) { return Buffer.byteLength(s ?? '', 'utf8'); }

let data = '';
process.stdin.on('data', c => (data += c));
process.stdin.on('error', e => logErr('stdin.error', e));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data || '{}');
    const tool = input.tool_name || '';
    const ti = input.tool_input || {};
    const filePath = ti.file_path || '';
    if (!filePath) process.exit(0);

    const norm = filePath.replace(/\\/g, '/');
    const budget = BUDGETS.find(b => b.test.test(norm));
    if (!budget) process.exit(0); // 対象外

    // 書込後の最終バイト数を算出（Edit/MultiEdit は実ファイルへ置換を順次適用して測る）
    let resultBytes;
    if (tool === 'Write') {
      resultBytes = bytes(ti.content);
    } else if (tool === 'Edit' || tool === 'MultiEdit') {
      // 既存ファイルは読む。存在するのに読めない場合のみ fail-open（block しない）。非存在は新規＝空から適用。
      let cur = '';
      if (fs.existsSync(filePath)) {
        try { cur = fs.readFileSync(filePath, 'utf8'); }
        catch (e) { logErr('read-fail(existing→fail-open)', e); process.exit(0); }
      }
      const edits = tool === 'MultiEdit'
        ? (ti.edits ?? [])
        : [{ old_string: ti.old_string, new_string: ti.new_string, replace_all: ti.replace_all }];
      let next = cur;
      for (const e of edits) {
        const o = e.old_string ?? '';
        const n = e.new_string ?? '';
        next = e.replace_all ? next.split(o).join(n) : next.replace(o, n);
      }
      resultBytes = bytes(next);
    } else {
      process.exit(0); // 未対応 tool は素通り
    }

    if (resultBytes > budget.limit) {
      const over = resultBytes - budget.limit;
      const reason = `⛔ [memory-size-gate] ${budget.label} 書込後 ${resultBytes} バイトが上限 ${budget.limit} バイトを ${over} バイト超過

memory 系ファイルは context に毎回乗るため byte 上限で再肥大を機械封鎖しています。
対処（いずれか）:
  - 古い/完了済みエントリを archive/ へ退避してから書き直す
  - 1 行が長文化していないか確認（context コストは行数でなくバイト）
  - 上限が実態に合わない場合のみ司令塔に報告し BUDGETS を校正する

参照: docs/ops/plans/2026-06-23-memory-context-bloat-fix.md`;
      console.log(JSON.stringify({ decision: 'block', reason }));
      process.exit(0);
    }
    process.exit(0);
  } catch (e) {
    logErr('stdin.end.catch', e);
    process.exit(0);
  }
});
