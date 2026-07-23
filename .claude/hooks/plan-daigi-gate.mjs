#!/usr/bin/env node
/**
 * plan-daigi-gate.mjs
 *
 * PreToolUse hook for ExitPlanMode. (roadmap M4 — H2大義「vibe-base 自体の大義を確立すること」の完了条件の本体)
 *
 * EARS:
 *   WHEN Claude が ExitPlanMode で plan を承認提出しようとする
 *   THE SYSTEM SHALL plan の「## 大義との整合」内 `照合先:` が roadmap-state.json に実在する
 *     マイルストーン id（整数）または N/A であることを検証し、満たさなければ deny する。
 *
 * 検査条件は 1 個だけ:
 *   `照合先:` の id 実在のみ。`整合:` の一文は機械に意味判定不能なため検査しない
 *   （マスターレビューで担保）。CLAUDE.md §2-4「仕組みは常に最もシンプルに」。
 *
 * なぜ ExitPlanMode か（plan ファイルの Write を捕まえない理由）:
 *   1. plan-schema-gate は「plan を逐次 Write で組み立てる公式ワークフローと衝突し誤検知が
 *      支配的」で 2026-06-30 に撤去された。ExitPlanMode は承認提出の瞬間に 1 回だけ発火し
 *      途中経過を見ないため、この誤検知が構造的に発生しない。
 *   2. 同じく撤去理由の「plan ファイルへの block は無視される」を迂回する。ExitPlanMode は
 *      tool 呼び出しであり、plan 本文が tool_input.plan に入る。ファイルを読まない。
 *   3. plansDirectory 設定が効かず plan が ~/.claude/plans/ に落ちる問題と無関係になる。
 *
 * 公式根拠:
 *   - hook は決定的: "Unlike CLAUDE.md instructions which are advisory, hooks are deterministic
 *     and guarantee the action happens" (code.claude.com/docs/en/best-practices)
 *   - PreToolUse は permission-mode より先: "PreToolUse hooks fire before any permission-mode check"
 *   - ExitPlanMode は matcher に指定可: "The matcher scopes the hook to ExitPlanMode only"
 *     (code.claude.com/docs/en/hooks-guide)
 *
 * 全 product へ配備する（2026-07-17 H2大義「vibe-base と同等の大義システムを全 product へ配備」）:
 *   パス解決は $CLAUDE_PROJECT_DIR 相対なので、product 側に器が在ればそのまま働く。
 *   器が無い product では「H2大義が未確定＝マスターに仰げ」として deny する（bias to safe）。
 *   旧版は root 専用として ROOT_ONLY_HOOK_NAMES に登録していた。除外の理由は「器が root に
 *   しか無いから」であって「配ってはいけないから」ではなかった。
 *
 * 正本: vibe-base/docs/standards/plan-mode.md §大義との整合
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_PATH = path.join(PROJECT_DIR, 'roadmap-state.json');
const HEADING = '大義との整合';

/**
 * H1大義（vibe-base 全体の開発が常に最良であり続けること）を持つのは vibe-base root だけ。
 * 配下 product は H2 のみの 3 段で H1 を持たない（CLAUDE.md §0）。
 * → `照合先: N/A`（＝H1 継続型の作業）を名乗れるのは root だけ。product で許すと
 *   全 plan が N/A で素通りし、配備しても機械が回らない（＝H2大義の完了条件未達）。
 *
 * 判定は 2 条件の AND。判定不能なら false＝N/A を許さない側（fail-closed）に倒す。
 *
 *   (1) 自分が配下でない: 親ディレクトリ名が `products` なら、それは products/<X> ＝ 配下。
 *   (2) 配下を持つ: products/ ディレクトリが実在する。
 *
 * (1) が要る。初版は (2) だけで判定したため、**product の中で `mkdir products` を 1 回
 * 実行するだけで H1 を詐称でき、`照合先: N/A` が無検査通過した**（2026-07-17 検証パネル
 * レンズ③が実機再現）。自分の中に作れるものを判定材料にすると自己申告と等価になる。
 * (1) の詐称には「自分の外」を作り変える必要があり、それは §1 で禁止・permission でも deny。
 */
function hasH1() {
  try {
    if (path.basename(path.dirname(PROJECT_DIR)).toLowerCase() === 'products') return false;
    return fs.statSync(path.join(PROJECT_DIR, 'products')).isDirectory();
  } catch {
    return false;
  }
}

function warn(msg) {
  // 機能停止の隠蔽防止（hook-runner の pass-through で見えなくなる罠を回避）
  process.stderr.write(`[plan-daigi-gate] ${msg}\n`);
}

process.on('uncaughtException', e => { warn(`uncaughtException: ${e?.stack || e}`); process.exit(0); });
process.on('unhandledRejection', e => { warn(`unhandledRejection: ${e?.stack || e}`); process.exit(0); });

function deny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

/**
 * コードフェンスの中身を空行に潰す。行数は保存する。
 *
 * 必須。plan-mode.md §大義との整合 は本セクションの書式をフェンス付きで例示しており、
 * Context 節にその例をコピーした plan が実在しうる。フェンスを区別しないと
 * 「例示の 照合先: を本物より先に拾う」ため、①実在 id の例示 + 不在 id の本物 = 素通り
 * （＝ゲート無力化）②不在 id の例示 + 実在 id の本物 = 正当な plan を deny、の両方が起きる。
 * 2026-07-17 検証パネル レンズ②が実行で再現。
 *
 * CommonMark に倣い **開始フェンスの文字種と長さを覚える**。閉じるのは「同じ文字種・同じ長さ以上・
 * info string 無し」の行のみ。単純トグルにすると `~~~` の中に ``` を入れ子にしただけで
 * 閉じたと誤認し、上記の無力化が再発する（2 巡目でレンズ②が実行再現）。
 *
 * 閉じられていないフェンスは CommonMark どおり文書末尾まで内容とみなす（＝見出しが隠れて deny）。
 * ここで「未閉じなら無かったことにする」と、フェンスで偽セクションを見せる bypass に道を開く。
 * 代わりに unclosed を返し、deny 理由で原因を名指しする。
 */
function stripFencedBlocks(md) {
  const out = [];
  let fence = null; // { char, len }
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (m) {
      const char = m[1][0];
      const len = m[1].length;
      const info = m[2];
      if (!fence) {
        // ``` の info string にバッククォートは置けない（CommonMark）
        if (!(char === '`' && info.includes('`'))) {
          fence = { char, len };
          out.push('');
          continue;
        }
      } else if (char === fence.char && len >= fence.len && info.trim() === '') {
        fence = null;
        out.push('');
        continue;
      }
    }
    out.push(fence ? '' : line);
  }
  return { text: out.join('\n'), unclosed: fence !== null };
}

function extractH2Section(content, heading) {
  const lines = content.split(/\r?\n/);
  // 末尾の `#` は ATX 閉じハッシュ（`## 大義との整合 ##`）。正当な CommonMark なので許容する
  // （2026-07-17 検証パネル 3 巡目・レンズ②が false-deny を実行再現）。
  const headingRegex = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*#*\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRegex.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

function readMilestoneIds() {
  const raw = fs.readFileSync(STATE_PATH, 'utf8');
  const state = JSON.parse(raw);
  if (!Array.isArray(state?.milestones)) throw new Error('milestones[] が配列でない');
  return state.milestones.map(m => m.id);
}

const HELP = [
  '',
  'plan の先頭に以下を置いてください（正本: docs/standards/plan-mode.md §大義との整合）:',
  '',
  '  ## 大義との整合',
  '  - 照合先: 3',
  '  - 整合: <その大義をどう満たすかを一文>',
  '',
  '`照合先:` は roadmap-state.json に実在するマイルストーン id（整数）。',
  'ロードマップを持たない H1（vibe-base 全体の開発が常に最良であり続けること）継続型の',
  '作業は `照合先: N/A` と記してください。**N/A を名乗れるのは H1 を持つ vibe-base root だけ**',
  '（配下 product は H2 のみの 3 段で H1 を持たない）。',
  '',
  '根拠: CLAUDE.md §0 — 序列 H1大義 ＞ H2大義 ＞ プラン ＞ アクション。',
  '上流から順に「満たすか」を照合し、1つでも満たさなければ却下する。',
].join('\n');

let data = '';
process.stdin.on('data', chunk => (data += chunk));
process.stdin.on('error', e => warn(`stdin.error: ${e?.message}`));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data || '{}');

    if (input.tool_name !== 'ExitPlanMode') process.exit(0);

    const planText = input?.tool_input?.plan;
    if (typeof planText !== 'string' || planText.length === 0) {
      // schema 想定外。デッドロックさせず、機能停止は stderr で可視化する。
      warn('tool_input.plan が取得できませんでした（schema 変更の疑い）。検査を skip します。');
      process.exit(0);
    }

    const { text: unfenced, unclosed } = stripFencedBlocks(planText);
    const fenceNote = unclosed
      ? '\n\n⚠ 閉じられていないコードフェンス（``` / ~~~）があります。それ以降が全てコードブロック扱いになり、\n本セクションが隠れている可能性があります。フェンスを閉じてください。'
      : '';

    const section = extractH2Section(unfenced, HEADING);
    if (section === null) {
      deny(`⛔ [plan-daigi-gate] plan に「## ${HEADING}」がありません。${fenceNote}\n${HELP}`);
    }

    // 行頭のリストマーカー・太字・絵文字等の装飾を許容する。
    // 厳しくすると `- ✅ 照合先: 3` や `- **照合先**: 3` を false-deny し、
    // 誤検知支配 → 撤去（過去 2 件の死因）を再演する（2026-07-17 検証パネル 3 巡目・レンズ②が実行再現）。
    // `照合先` の直前に置けるのは「文字でも数字でもない記号」だけなので、散文とは衝突しない。
    const m = section.match(/^[ \t]*(?:[-*+][ \t]+)?(?:[^\p{L}\p{N}\s]+[ \t]*)*照合先[ \t]*(?:[^\p{L}\p{N}\s:：]+[ \t]*)*[:：][ \t]*(.+?)[ \t]*$/mu);
    if (!m) {
      deny(`⛔ [plan-daigi-gate] 「## ${HEADING}」に \`照合先:\` の行がありません。\n${HELP}`);
    }

    const value = m[1].trim();

    // N/A 判定を先に行う。「N/A（H1 継続型）」の "H1" から数字 1 を誤抽出しないため、順序は不可逆。
    // 終端アンカー必須。前方一致だけだと「N/Aだと思ったが999」が N/A 扱いで無検査通過する
    // （2026-07-17 検証パネル レンズ②が実行で確認）。許すのは `N/A` と `N/A（補足）` のみ。
    if (/^N\s*\/\s*A\s*(?:[（(][^）)]*[）)])?\s*$/i.test(value)) {
      // N/A は「H1 継続型の作業」の意。H1 を持つのは vibe-base root だけ。
      // product で許すと全 plan が N/A で素通りし、配備しても機械が回らない。
      if (hasH1()) process.exit(0);
      deny(
        `⛔ [plan-daigi-gate] \`照合先: N/A\` を名乗れるのは H1大義を持つ vibe-base root だけです。\n\n` +
        `  ここは配下（product）です: ${PROJECT_DIR}\n` +
        `\n配下は H2大義のみの 3 段で H1 を持ちません（CLAUDE.md §0）。\n` +
        `この product の H2大義のマイルストーン id を \`照合先:\` に書いてください。\n` +
        `H2大義がまだ無いなら、AI が起案してマスター承認を得るか、マスターが直接確定してください。\n` +
        `大義を確定してから plan を出し直してください。`
      );
    }

    const idMatch = value.match(/\d+/);
    if (!idMatch) {
      deny(
        `⛔ [plan-daigi-gate] \`照合先:\` の値がマイルストーン id（整数）でも N/A でもありません。\n\n` +
        `  検出値: ${value}\n` +
        `\n雛形のプレースホルダのまま提出していませんか。\n${HELP}`
      );
    }

    const id = Number(idMatch[0]);

    let ids;
    try {
      ids = readMilestoneIds();
    } catch (e) {
      // bias to safe: 現在地の正本が読めないなら照合は成立しない。黙って通すと機械が死んだことに誰も気づかない。
      const missing = !fs.existsSync(STATE_PATH);
      deny(
        `⛔ [plan-daigi-gate] ${path.basename(STATE_PATH)} を読めないため大義照合ができません。\n\n` +
        `  path: ${STATE_PATH}\n` +
        `  詳細: ${e?.message}\n` +
        (missing && !hasH1()
          ? `\nこの product の H2大義がまだ確定していません（器が不在）。\n` +
            `**大義はマイルストーンと同格: AI が起案してよい・マスター承認で確定する**（CLAUDE.md §0）。\n` +
            `起案してマスター承認を得たら司令塔（vibe-base root）で次を実行して器を作ります:\n` +
            `  node scripts/init-product-roadmap.mjs ${path.basename(PROJECT_DIR)}`
          : `\n現在地の正本が壊れている可能性があります。\`git checkout -- roadmap-state.json\` で復元するか、マスターに諮ってください。`)
      );
    }

    if (!ids.includes(id)) {
      deny(
        `⛔ [plan-daigi-gate] \`照合先: ${id}\` は roadmap-state.json に実在しないマイルストーン id です。\n\n` +
        `  実在する id: ${ids.join(' / ')}\n` +
        `\nマイルストーン名・順序・依存の正本は roadmap.md、現在地の正本は roadmap-state.json です。\n` +
        `（AI が編集してよいのは status フィールドのみ）\n${HELP}`
      );
    }

    process.exit(0);
  } catch (e) {
    warn(`stdin.end.catch: ${e?.stack || e}`);
    process.exit(0);
  }
});
