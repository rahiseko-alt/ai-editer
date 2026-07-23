#!/usr/bin/env node
/**
 * roadmap-state-write-gate.mjs
 *
 * PreToolUse hook for Write|Edit|MultiEdit — 対象は roadmap-state.json のみ。
 *
 * EARS:
 *   WHEN AI が roadmap-state.json を Write/Edit/MultiEdit しようとする
 *   THE SYSTEM SHALL status フィールド（と updated_at）以外の変更を deny する。
 *
 * なぜ要るか（2026-07-17 検証パネル レンズ③ blocking / 既存 backlog id:10 の格上げ）:
 *   plan-daigi-gate が検査する唯一の条件は「`照合先:` の id が roadmap-state.json に実在するか」。
 *   その roadmap-state.json が「AI は status のみ編集可」という**規約だけ**で守られていたため、
 *   AI が milestones に任意 id を足せば gate を素通りできた＝**大義照合ゲートが自己申告と等価**。
 *
 * 設計上の絶対規律（2026-07-17 検証パネル 2 巡目で ②③ が独立に同一の穴を実行再現した教訓）:
 *   **対象ファイルと判明した後は fail-closed**。初版は外側 catch が全例外を warn+exit(0)（＝許可）
 *   にしていたため、`milestones` に null や非配列を混ぜて deny メッセージ組立を TypeError で
 *   クラッシュさせるだけで **Write ツールだけでゲートを無効化できた**（Bash 不要）。
 *   「例外＝黙って通す」は検査 hook では穴そのもの。**判定不能なら deny する。**
 *
 * 限界（正直に明記する。過大申告するな）:
 *   捕まえるのは Write/Edit/MultiEdit ツール経由のみ。Bash から `node -e "fs.writeFileSync(...)"`
 *   で直接書く経路と、hook ファイル自体の削除は防げない。AI が Bash を持つ限り全 hook に共通。
 *
 * root 専用（ROOT_ONLY_HOOK_NAMES 登録）: roadmap-state.json は vibe-base root にのみ在る。
 *
 * 正本: roadmap.md 完走判定 / CLAUDE.md §0
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TARGET = path.join(PROJECT_DIR, 'roadmap-state.json');
const DEFAULT_STATUS = ['todo', 'in_progress', 'done'];

function warn(msg) {
  process.stderr.write(`[roadmap-state-write-gate] ${msg}\n`);
}

function emitDeny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// 対象ファイルと判明した後に立てる。以降の例外は「許可」ではなく「deny」に落とす。
let armed = false;

function bail(label, err) {
  const detail = err?.stack || err?.message || String(err);
  warn(`${label}: ${detail}`);
  if (armed) {
    emitDeny(
      `⛔ [roadmap-state-write-gate] 検査中に例外が発生したため安全側で拒否します。\n\n` +
      `  ${label}: ${err?.message || String(err)}\n` +
      `\n判定できないものを通すと、大義照合の判定材料が無検査で書き換わります。\n` +
      `内容を単純な形に直して再試行するか、マスターに諮ってください。`
    );
  }
  process.exit(0);
}

process.on('uncaughtException', e => bail('uncaughtException', e));
process.on('unhandledRejection', e => bail('unhandledRejection', e));

/**
 * 対象ファイル判定。**文字列比較だけで判定するな。**
 *
 * 初版は path.resolve の文字列比較のみだった。Windows の 8.3 短縮名（`ROADMA~1.JSO`）は
 * NTFS 上で roadmap-state.json と同一実体を指すが文字列としては一致しないため、
 * `isTarget` が false → armed 化前に exit 0（＝無検査で許可）→ Write が実ファイルを書き換える、
 * という **Bash 不要・1 手**の bypass が成立した（2026-07-17 検証パネル 3 巡目・レンズ③が実機再現）。
 * OS がエイリアスを解決する以上、実体（realpath）で照合するしかない。
 */
function isTarget(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;

  const norm = p => {
    try { return path.resolve(String(p)).replace(/\\/g, '/').toLowerCase(); } catch { return null; }
  };
  const real = p => {
    try { return fs.realpathSync.native(String(p)).replace(/\\/g, '/').toLowerCase(); } catch { return null; }
  };

  // 実体が取れる場合は実体で照合する（8.3 短縮名・symlink・ジャンクション・大文字小文字の差を吸収）
  const realTarget = real(TARGET);
  const realGiven = real(filePath);
  if (realTarget && realGiven) return realTarget === realGiven;

  // 実体が取れない（未作成 path 等）場合のみ文字列比較へ落とす
  const normTarget = norm(TARGET);
  const normGiven = norm(filePath);
  return normTarget !== null && normTarget === normGiven;
}

/** キー順に依存しない正規形（順序だけ変えた同義の編集を false-deny しないため） */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = canon(v[k]); return acc; }, {});
  }
  return v;
}

/** status / updated_at を除いた「変えてはいけない部分」の正規形文字列 */
function skeleton(state) {
  const clone = JSON.parse(JSON.stringify(state));
  delete clone.updated_at;
  clone.milestones = clone.milestones.map(m => {
    const c = { ...m };
    delete c.status;
    return c;
  });
  return JSON.stringify(canon(clone));
}

/**
 * 構造の健全性を検査する。**deny メッセージを組み立てる前に必ず通す。**
 * 初版はこれを怠り、壊れた milestones でメッセージ組立がクラッシュ → fail-open した。
 */
function structureError(state, label) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return `${label} が JSON オブジェクトでない`;
  if (!Array.isArray(state.milestones)) return `${label} の milestones[] が配列でない`;
  for (const [i, m] of state.milestones.entries()) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return `${label} の milestones[${i}] がオブジェクトでない`;
    if (!Number.isInteger(m.id)) return `${label} の milestones[${i}].id が整数でない`;
  }
  const ids = state.milestones.map(m => m.id);
  if (new Set(ids).size !== ids.length) return `${label} の milestones[].id に重複がある`;
  return null;
}

/** tool_input から「書き込まれる予定の全文」を組み立てる */
function buildNextContent(toolName, toolInput, current) {
  if (toolName === 'Write') {
    if (typeof toolInput.content !== 'string') throw new Error('content が文字列でない');
    return toolInput.content;
  }

  const applyEdit = (text, edit) => {
    const { old_string, new_string, replace_all } = edit ?? {};
    if (typeof old_string !== 'string' || typeof new_string !== 'string') {
      throw new Error('old_string / new_string が文字列でない');
    }
    const i = text.indexOf(old_string);
    if (i === -1) throw new Error('old_string が現ファイルに見つからない');
    // String.replace は new_string 内の `$&` `$1` 等を特殊展開する。
    // 展開されると「検査した内容 ≠ 実際に書かれる内容」になり検査が無意味になるため使わない。
    if (replace_all) return text.split(old_string).join(new_string);
    return text.slice(0, i) + new_string + text.slice(i + old_string.length);
  };

  if (toolName === 'Edit') return applyEdit(current, toolInput);
  if (toolName === 'MultiEdit') {
    if (!Array.isArray(toolInput.edits)) throw new Error('edits[] が配列でない');
    return toolInput.edits.reduce((acc, e) => applyEdit(acc, e), current);
  }
  throw new Error(`未知の tool: ${toolName}`);
}

const HELP = [
  '',
  'roadmap-state.json は現在地の単一正本です。**AI が編集してよいのは status フィールドのみ**',
  '（todo / in_progress / done）。マイルストーン名・順序・依存の正本は roadmap.md です。',
  '',
  'マイルストーンの追加・削除・id 変更が要るならマスターに諮ってください。',
  'AI が立てるな・推測で埋めるな（CLAUDE.md §0）。',
  '',
  '根拠: plan-daigi-gate はこのファイルの milestones[].id を「大義が実在するか」の唯一の',
  '判定材料にしています。ここを AI が書き換えられると大義照合は自己申告と等価になります。',
].join('\n');

let data = '';
process.stdin.on('data', chunk => (data += chunk));
process.stdin.on('error', e => warn(`stdin.error: ${e?.message}`));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(data || '{}');
  } catch (e) {
    // まだ対象か判らない段階。ここで deny すると無関係な編集を巻き込むため素通り。
    warn(`stdin の JSON parse 失敗: ${e.message}`);
    process.exit(0);
  }

  const toolName = input?.tool_name;
  if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) process.exit(0);
  if (!isTarget(input?.tool_input?.file_path)) process.exit(0);

  // ここから先は対象ファイル確定。判定不能は全て deny に落とす。
  armed = true;

  try {
    if (!fs.existsSync(TARGET)) {
      emitDeny(
        `⛔ [roadmap-state-write-gate] ${path.basename(TARGET)} が実在しません。新規作成はマスター判断です。\n` +
        `\n  path: ${TARGET}\n${HELP}`
      );
    }

    const current = fs.readFileSync(TARGET, 'utf8');

    let before;
    try {
      before = JSON.parse(current);
    } catch (e) {
      // 現ファイルが壊れている＝比較の基準が無い。ここを素通りさせると
      // 「①壊す → ②直しつつ id を注入」の 2 手攻撃が成立する（2026-07-17 レンズ③が実行再現）。
      emitDeny(
        `⛔ [roadmap-state-write-gate] 現在の ${path.basename(TARGET)} が valid JSON でないため、変更を検査できません。\n\n` +
        `  詳細: ${e.message}\n` +
        `\n比較の基準が無い状態で書込を許すと、破壊 → 復元を装った改竄が通ります。\n` +
        `\`git checkout -- roadmap-state.json\` で復元するか、マスターに諮ってください。`
      );
    }

    const beforeErr = structureError(before, '現在の roadmap-state.json');
    if (beforeErr) {
      emitDeny(
        `⛔ [roadmap-state-write-gate] 現在の ${path.basename(TARGET)} の構造が壊れているため検査できません。\n\n` +
        `  ${beforeErr}\n` +
        `\n\`git checkout -- roadmap-state.json\` で復元するか、マスターに諮ってください。`
      );
    }

    const next = buildNextContent(toolName, input.tool_input ?? {}, current);

    let after;
    try {
      after = JSON.parse(next);
    } catch (e) {
      emitDeny(
        `⛔ [roadmap-state-write-gate] 変更後が valid JSON になりません: ${e.message}\n` +
        `\n現在地の正本を壊すと大義照合が機能停止します。${HELP}`
      );
    }

    // **メッセージ組立より前に**構造を検査する。初版はこの順序を誤り fail-open した。
    const afterErr = structureError(after, '変更後');
    if (afterErr) {
      emitDeny(
        `⛔ [roadmap-state-write-gate] 変更後の構造が不正です。\n\n  ${afterErr}\n${HELP}`
      );
    }

    if (skeleton(before) !== skeleton(after)) {
      emitDeny(
        `⛔ [roadmap-state-write-gate] status 以外を変更しようとしています。\n\n` +
        `  変更前の milestones id: ${JSON.stringify(before.milestones.map(m => m.id))}\n` +
        `  変更後の milestones id: ${JSON.stringify(after.milestones.map(m => m.id))}\n` +
        `\n許可されるのは各 milestone の status と updated_at のみです。${HELP}`
      );
    }

    const allowed = Array.isArray(before._status_values) ? before._status_values : DEFAULT_STATUS;
    const bad = after.milestones.filter(m => !allowed.includes(m.status));
    if (bad.length > 0) {
      emitDeny(
        `⛔ [roadmap-state-write-gate] status に不正な値があります: ` +
        `${JSON.stringify(bad.map(m => ({ id: m.id, status: m.status })))}\n\n` +
        `  許可値: ${allowed.join(' / ')}${HELP}`
      );
    }

    process.exit(0);
  } catch (e) {
    bail('検査中の例外', e);
  }
});
