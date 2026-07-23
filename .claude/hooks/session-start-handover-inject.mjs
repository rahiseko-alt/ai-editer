#!/usr/bin/env node
/**
 * .claude/hooks/session-start-handover-inject.mjs
 *
 * SessionStart 強制注入 — 前回 Check-out の引継ぎレポートを additionalContext で**必ず**注入する。
 * マスター指示（2026-07-01）「次セッションで引継ぎ漏れゼロ + 絶対にその引継ぎを読む」を
 * AI 自己規律でなく hook で機械強制する（CLAUDE.md §4 AI 規律不信原則）。
 *
 * 二層の機械保証:
 *   ① 絶対読む : memory.md 冒頭の @参照先 MD の最重要部（🔴最重要 + G次セッション初手）を
 *               additionalContext として注入。AI は読まずに着手できない。
 *   ② 漏れ検知 : docs/session-reports/ の最新 *-checkout.md と @参照のファイル名を照合。
 *               ズレ（前回 Check-out の @参照更新漏れ）/ リンク切れ / @参照不在を警告注入。
 *
 * 設計:
 *   - root 専用（司令塔のみ）: registry.json 不在の product セッションでは無通知 exit 0。
 *   - read-only: 一切書込まない。
 *   - EXIT 常に 0（SessionStart を絶対にブロックしない）。
 *
 * 入出力: stdin に SessionStart JSON。stdout に { hookSpecificOutput:{hookEventName, additionalContext} }。
 */
import fs from 'fs';
import path from 'path';

// 見出しからセクション本文を抽出（次の ## 見出し or 文末まで）
function extractSection(md, headPattern) {
  const re = new RegExp(`##\\s*${headPattern}[\\s\\S]*?(?=\\n##\\s|$)`);
  const m = md.match(re);
  return m ? m[0].trim() : '';
}

/**
 * H2大義 + ロードマップ現在地を注入する（マスター指示 2026-07-17）。
 * 序列 H1大義 > H2大義 > プラン > アクション の最上位を、AI 自己規律でなく hook で毎セッション強制注入する。
 * memory.md の @参照でなく**固定パス**で読む（memory.md の記述に依存すると、AI が memory.md を
 * 壊した時に大義ごと消えるため）。roadmap.md 不在 = H2大義が空 = 判定機構の停止として警告する。
 */
/**
 * H2大義を `roadmap-state.json` の `daigi` から読む（マスター指示 2026-07-17）。
 *
 * 大義は JSON フィールド。**AI が起案してよい・マスター承認で確定する**（マイルストーンと同格・CLAUDE.md §0/§1）。
 * JSON にしてあるのは「AI が Markdown を気軽に上書きするより、JSON を不適切に書き換え
 * にくい」という公式知見に沿った物理的な抑止。加えて `roadmap-state-write-gate` が
 * status 以外の変更（＝daigi の書き換えを含む）を deny する。完全機械強制ではなく、
 * 書き換えたらマスターが気付いて直させる運用（新しい機械は作らない・シンプル維持）。
 */
function daigiText(st) {
  const d = st && st.daigi;
  if (!d || typeof d !== 'object' || !d.statement) return null;
  const lines = [d.statement];
  if (d.type) lines.push(`種別: ${d.type}`);
  if (d.done_when) lines.push(`完了条件: ${d.done_when}`);
  if (d.constraint) lines.push(`前提: ${d.constraint}`);
  return lines.join('\n');
}

function daigiBlock(projectDir) {
  const sp = path.join(projectDir, 'roadmap-state.json');

  let st = null;
  try {
    st = JSON.parse(fs.readFileSync(sp, 'utf-8'));
  } catch {}

  const daigi = daigiText(st);

  // 大義が未設定（器が無い or daigi 空）＝エラーではない。初期状態。
  if (!daigi) {
    return [
      '═══════════════════════════════════════════',
      'ℹ️ H2大義が未設定（エラーではない。初期状態だ）',
      '大義はマイルストーンと同格: **AI が起案してよい・マスター承認で確定する**（CLAUDE.md §0/§1）。',
      '取るべき行動: **AI が大義を起案してマスター承認を得る（またはマスターが直接確定する）。空のまま進めるな。**',
      '確定: roadmap.md に大義を書き、必要なら roadmap-state.json を整える（マスター承認後）。',
      '═══════════════════════════════════════════',
    ].join('\n');
  }

  const rp = path.join(projectDir, 'roadmap.md');
  let roadmap = '';
  try {
    roadmap = fs.readFileSync(rp, 'utf-8').trim();
  } catch {}

  let stateLine = '';
  try {
    const by = (s) => ((st.milestones || []).filter((x) => x.status === s).map((x) => x.id).join(',') || '-');
    stateLine = `現在地（roadmap-state.json / updated_at: ${st.updated_at || '不明'}）: 進行中=[${by('in_progress')}] 完了=[${by('done')}] 未着手=[${by('todo')}]`;
  } catch {}

  return [
    '═══════════════════════════════════════════',
    '🎯 H2大義 ＋ ロードマップ（機械強制注入・最上位）',
    '序列: H1大義 ＞ H2大義 ＞ プラン ＞ アクション。上流から順に「満たすか」を照合し、1つでも満たさなければ却下。下流は上流を遡るな（CLAUDE.md §0）。',
    '─────────────────────────────────────',
    '【H2大義】（正本: roadmap-state.json の daigi・AI は書き換え禁止 CLAUDE.md §1）',
    daigi,
    '',
    roadmap,
    '',
    stateLine,
    '═══════════════════════════════════════════',
    '↑ この H2大義から外れる/遠ざかる作業は、その時点で却下。着手前に照合せよ。',
  ].join('\n');
}

/**
 * plan 実行順の進捗表と実行規律を注入する（マスター指示 2026-07-10）。
 * 「毎回 Check-in で読ませる / 寄り道しない / 発見は併記」を AI 自己規律でなく hook で強制する。
 * 全 7 本完了時に正本ファイルごと削除される想定のため、**不在なら無通知で空文字**を返す。
 */
function planProgressBlock(projectDir) {
  const p = path.join(projectDir, 'docs', 'ops', 'plan-execution-order.md');
  if (!fs.existsSync(p)) return '';
  let md;
  try {
    md = fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
  const progress = extractSection(md, '進捗');
  const discipline = extractSection(md, '実行規律');
  const found = extractSection(md, '実行中に発見した問題');
  const body = [progress, discipline, found].filter(Boolean).join('\n\n');
  if (!body) return '';
  return [
    '',
    '═══════════════════════════════════════════',
    '📋 plan 実行順の現在地（機械強制注入・本線から外れるな）',
    '正本: docs/ops/plan-execution-order.md',
    '─────────────────────────────────────',
    body,
    '═══════════════════════════════════════════',
    '↑ 寄り道禁止。想定外を検知しても、まず現在の plan を完走せよ。',
    '   発見した問題はその場で直さず「実行中に発見した問題」節へ併記追加せよ。',
  ].join('\n');
}

function emit(context) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // 序列どおり H2大義を最上位に置く（引継ぎ・plan 進捗より前）。
  const daigi = daigiBlock(projectDir);
  const progress = planProgressBlock(projectDir);
  const full = [daigi, context, progress].filter(Boolean).join('\n');
  if (!full) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: full },
    })
  );
}

function main() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // 引継ぎレポート注入（memory.md の @参照・session-reports の鮮度照合）は司令塔の関心事。
  // だが**大義注入は全 product の関心事**（2026-07-17 H2大義）。product セッション（registry 不在）は
  // 引継ぎ部分を飛ばし、大義ブロックだけを注入して終える。emit() が daigiBlock を先頭に組むため、
  // 空文字を渡せば大義のみが出る（roadmap.md 不在なら「⛔ H2大義が不在＝マスターに仰げ」）。
  const isOrchestrator = fs.existsSync(path.join(projectDir, 'docs', 'html-toranomaki', 'registry.json'));
  if (!isOrchestrator) {
    emit('');
    process.exit(0);
  }

  const memoryPath = path.join(projectDir, 'memory.md');
  if (!fs.existsSync(memoryPath)) {
    emit('⛔ 引継ぎ強制注入: memory.md が見つかりません。引継ぎ機構が機能していません。');
    process.exit(0);
  }

  const memory = fs.readFileSync(memoryPath, 'utf-8');
  const m = memory.match(/^@(\S+\.md)/m);

  // 鮮度チェック用: docs/session-reports/ の最新 checkout
  const srDir = path.join(projectDir, 'docs', 'session-reports');
  let latest = null;
  try {
    const checkouts = fs.readdirSync(srDir).filter((f) => /-checkout\.md$/.test(f)).sort();
    latest = checkouts[checkouts.length - 1] || null;
  } catch {}

  // ① @参照が無い → 引継ぎ漏れ
  if (!m) {
    emit(
      [
        '⛔ 引継ぎ強制注入: memory.md 冒頭に @引継ぎレポート参照がありません。',
        '前回 Check-out が @参照更新（B-2.5）を漏らした可能性。',
        latest ? `docs/session-reports/ の最新は「${latest}」。これを Read してから着手すること。` : 'docs/session-reports/ を確認すること。',
      ].join('\n')
    );
    process.exit(0);
  }

  const ref = m[1];
  const refPath = path.join(projectDir, ref);
  const refBase = path.basename(ref);

  let staleWarn = '';
  if (latest && latest !== refBase) {
    staleWarn = `⚠️ 鮮度警告: @参照は「${refBase}」だが docs/session-reports/ の最新は「${latest}」。@参照が古い＝前回 Check-out の更新漏れを疑え。両方 Read すること。`;
  }

  // ② リンク切れ
  if (!fs.existsSync(refPath)) {
    emit(
      [
        `⛔ 引継ぎ強制注入: @参照先「${ref}」が存在しません（リンク切れ＝引継ぎ漏れ）。`,
        latest ? `最新の引継ぎは「${latest}」。これを Read すること。` : 'docs/session-reports/ を確認すること。',
        staleWarn,
      ].filter(Boolean).join('\n')
    );
    process.exit(0);
  }

  // ③ 本文注入（最重要部を抽出・無ければ先頭50行）
  const md = fs.readFileSync(refPath, 'utf-8');
  const critical = extractSection(md, '🔴');
  const nextStep = extractSection(md, 'G\\.');
  let body = [critical, nextStep].filter(Boolean).join('\n\n');
  if (!body) body = md.split('\n').slice(0, 50).join('\n');

  emit(
    [
      '═══════════════════════════════════════════',
      '🔴 前回セッションからの引継ぎ（機械強制注入・必読）',
      `正本全文: ${ref} ← 着手前に必ず全文 Read すること`,
      staleWarn,
      '─── 引継ぎ最重要抜粋 ───',
      body,
      '═══════════════════════════════════════════',
      '↑ この引継ぎを読まずに作業着手することは禁止（マスター指示 2026-07-01・hook で機械強制）。',
    ].filter(Boolean).join('\n')
  );
  process.exit(0);
}

// stdin を drain（hang 回避）してから実行。
let settled = false;
function run() {
  if (settled) return;
  settled = true;
  try {
    main();
  } catch (e) {
    process.stderr.write('[handover-inject] ' + (e?.message || String(e)) + '\n');
    process.exit(0); // SessionStart は絶対にブロックしない
  }
}
process.stdin.on('data', () => {});
process.stdin.on('end', run);
setTimeout(run, 500);
