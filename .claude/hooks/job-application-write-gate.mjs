#!/usr/bin/env node
// .claude/hooks/job-application-write-gate.mjs
// PreToolUse(Write|Edit|MultiEdit): 応募文の本体ファイルへの書き込みを、
// job-application-writer サブエージェント経由でなければ機械的に BLOCK する。
//
// 設計思想: AI 自己規律を信用しない（CLAUDE.md §4）。助言注入（job-application-agent-gate）は
// 司令塔が無視できる。応募文は事実の捏造が直接マスターの信用を毀損するため、経路を機械強制する。
//
// 2026-07-09 実害: 司令塔が直に応募文を書き、氏名の読みを捏造（「こばら」）、
// 61分32秒を「1時間5分」と誤記した。サブ経由なら自己検証チェックリストが走る。
//
// 実行主体の判定（2026-07-09 実測で確定・推測禁止）:
//   PreToolUse の入力に `agent_type` が入るのはサブエージェント実行時のみ。
//   親セッション（司令塔）の呼び出しでは `agent_type` 自体が存在しない。
//   ※ `transcript_path` はセッション**ディレクトリ**であり `.jsonl` ファイルではない。
//     サブ／親で同一値のため識別に使えない（当初これで実装して失敗した）。
//
// 判定:
//   対象 = docs/deliverables/job-applications/**/application*.md
//   許可 = agent_type === 'job-application-writer'
//   拒否 = それ以外（親セッションの直書き・別サブエージェント）
//
// **Bash 迂回の封鎖（2026-07-09 security-reviewer が blocking 検出）**:
//   matcher が Write|Edit|MultiEdit だけだと `echo > application.md` / `cp` / `mv` /
//   `tee` / `sed -i` / `node -e fs.writeFileSync` で hook を発火させずに書ける。
//   Bash も matcher に含め、コマンド文字列が対象パスへの書き込みを含むなら deny する。
//   読み取り（cat / grep / wc 等）は素通しする。
//
// 出力: exit 2 + stderr（本 repo の deny 規約。secret-write-gate と同形）。

const ALLOWED_AGENT = 'job-application-writer';

// 応募文の本体のみを守る。突合表・添付一覧は司令塔の内部資料なので対象外。
const TARGET_RE = /\/docs\/deliverables\/job-applications\/[^/]+\/application[^/]*\.md$/i;

// Bash コマンド内で対象パスに言及しているか（引用符・エスケープを跨ぐため緩く見る）
const BASH_TARGET_RE = /docs[/\\]deliverables[/\\]job-applications[/\\][^\s'"]*application[^\s'"]*\.md/i;
// 書き込み動作を示すトークン。読み取り専用コマンドを巻き込まないため動詞・リダイレクトに限定する。
const BASH_WRITE_RE = /(>>?\s*[^|&;]*application|(\b(cp|mv|tee|touch|install|rsync)\b)|sed\s+-i|perl\s+-i|awk[^|]*>\s|writeFileSync|appendFileSync|createWriteStream|Out-File|Set-Content|Add-Content)/i;

function allow() { process.exit(0); }

function deny(reason) {
  process.stderr.write(
    `⛔ [job-application-write-gate] 応募文への直接書き込みを拒否しました\n\n` +
    `理由: ${reason}\n\n` +
    `応募文は ${ALLOWED_AGENT} サブエージェント経由でのみ書けます。\n` +
    `  Agent(subagent_type="${ALLOWED_AGENT}", run_in_background=false)\n\n` +
    `委譲前に、マスターから「骨子（事実）」を受け取っているか確認せよ。\n` +
    `骨子なしで書かせると事実を捏造する（氏名の読み・数値の算術を誤った実害あり）。\n\n` +
    `対象外（本 hook は関与しない）: job-requirements-mapping.md / attachments.md\n`
  );
  process.exit(2);
}

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(data); } catch { return allow(); } // 入力破損は通常フローへ（他 hook と同方針）

  try {
    const ti = input.tool_input || {};
    const toolName = String(input.tool_name || '');
    let hit = false;

    if (toolName === 'Bash') {
      // シェル経由の書き込み（echo > / cp / mv / tee / sed -i / node -e writeFileSync 等）
      const cmd = String(ti.command || '');
      hit = BASH_TARGET_RE.test(cmd) && BASH_WRITE_RE.test(cmd);
    } else {
      const rawPath = String(ti.file_path || '');
      if (!rawPath) return allow();
      hit = TARGET_RE.test(rawPath.replace(/\\/g, '/'));
    }

    // 対象外は即 allow（最速 skip）
    if (!hit) return allow();

    const agentType = String(input.agent_type || '');

    if (!agentType) {
      return deny(`親セッション（司令塔）からの直接書き込みです（tool: ${toolName || '不明'}）`);
    }
    if (agentType !== ALLOWED_AGENT) {
      return deny(`サブエージェント "${agentType}" からの書き込みです（許可されるのは ${ALLOWED_AGENT} のみ）`);
    }

    return allow();
  } catch (e) {
    // 例外時も通すな（応募文の捏造リスクを優先）
    return deny(`hook 内部エラー: ${e && e.message}`);
  }
});
