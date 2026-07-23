#!/usr/bin/env node
// PreToolUse:Bash — destructive command 単独検知ブロック
// 公式推奨パターン（https://docs.claude.com/en/docs/claude-code/hooks）に準拠:
//   "PreToolUse + Bash で rm -rf 等を検出→deny" を正規 UC として例示
// マスター制約「Hook 過剰反応ダメ」遵守:
//   複合コマンド (`;`, `&&`, `||`, `$(...)`, バッククォート) 解析は実装しない
//   単独 prefix match のみで誤検知率を最小化
// 承認マーカー: `$CLAUDE_PROJECT_DIR/.allow-destructive` (10 分 TTL・既存 pre-edit.sh と同形)

import fs from 'fs';
import path from 'path';

const MARKER_TTL_SEC = 600;
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MARKER_PATH = path.join(PROJECT_DIR, '.allow-destructive');

let data = '';
process.stdin.on('data', chunk => (data += chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const toolInput = input.tool_input || {};
    const command = (toolInput.command || '').trim();
    if (!command) {
      process.exit(0);
    }

    // 承認マーカー（10 分 TTL）が有効なら全 destructive を通過
    if (fs.existsSync(MARKER_PATH)) {
      const ageSec = (Date.now() - fs.statSync(MARKER_PATH).mtimeMs) / 1000;
      if (ageSec < MARKER_TTL_SEC) {
        process.exit(0);
      }
    }

    // 「危険な対象 path」 = ルート系単独パターン
    // 通過: rm -rf node_modules / rm -rf .next / rm -rf /tmp/test
    // block: rm -rf / / rm -rf ~ / rm -rf .. / rm -rf * / rm -rf $HOME
    const DANGEROUS_PATH = /\s(\/|~|\$\w+|\.\.|\*)(\s|$)/;

    const matchers = [
      // rm -rf / rm -fr / rm -r -f
      {
        pattern: /^rm\s+-[rf]+\s+/,
        requireDangerousPath: true,
        name: 'rm -rf with dangerous root-level path',
        alternative: '具体的なディレクトリ名を指定（rm -rf node_modules 等）。代替: npm run clean',
      },
      // rimraf / npx rimraf
      {
        pattern: /^(npx\s+(--?[a-z-]+\s+)*)?rimraf\s+/,
        requireDangerousPath: true,
        name: 'rimraf with dangerous root-level path',
        alternative: '具体的なディレクトリ名を指定。代替: npm run clean',
      },
      // find ... -delete
      {
        pattern: /^find\s+.+\s+-delete(\s|$)/,
        requireDangerousPath: false,
        name: 'find -delete (一括削除)',
        alternative: 'find で対象を列挙してから rm で個別削除',
      },
      // dd if=*
      {
        pattern: /^dd\s+if=/,
        requireDangerousPath: false,
        name: 'dd (disk dump - 不可逆ディスク書込)',
        alternative: '不可逆操作のため明示承認マーカー必須',
      },
      // mkfs (filesystem format)
      {
        pattern: /^mkfs/,
        requireDangerousPath: false,
        name: 'mkfs (filesystem format)',
        alternative: '不可逆操作のため明示承認マーカー必須',
      },
      // shred (secure delete)
      {
        pattern: /^shred(\s|$)/,
        requireDangerousPath: false,
        name: 'shred (secure delete)',
        alternative: '不可逆削除のため明示承認マーカー必須',
      },
      // taskkill /F (Windows force kill - Session 278 再発防止)
      {
        pattern: /^taskkill\s+\/F/i,
        requireDangerousPath: false,
        name: 'taskkill /F (force kill process)',
        alternative: 'Session 278 再発防止: プロセス kill は明示同意必須。マスターに承認を仰ぐ',
      },
      // git clean（untracked ファイルの不可逆削除・監査 #3）
      // deny 前方一致 `git clean -fd*` は次のいずれでも抜けて `Bash(git:*)` allow に落ちる:
      //   - フラグ順序/組合せ（`-df` / `-xfd`）      … 順序非依存マッチで対応
      //   - 大文字（`Git clean`。Windows はコマンド解決が大小無視）… pattern に /i
      //   - git グローバルオプション前置（`git -C <path> clean` / `git --git-dir=X clean`）… pattern で吸収
      // 判定は「-f の有無」ではなく「dry-run か否か」で行う（bias-to-safe）。理由:
      //   `git config clean.requireForce false` 後は `-f` 無し（`git clean -d` や裸の `git clean`）でも
      //   削除されるため、-f 依存の判定は requireForce=false 経由でバイパスされる（③検証パネル指摘）。
      // よって `-n`/`--dry-run` を含まない git clean をすべて危険とする（dry-run は git 側で n が優先）。
      // dry-run 検出はトークン境界 `(?=\s|$)` で固定する。緩い `-[a-z]*n` だと `-not_tracked/` /
      // `-newdir/` 等ハイフン始まりの pathspec を dry-run flag と誤認し `-fd` 付き実削除を素通りさせる
      // （②検証パネル指摘）。真の dry-run flag は `-`+英字のみのトークン末尾で終わる（`-n` `-nd` `-fn`）。
      // 副作用: `-h`/`--help`（無害）も dry-run 非含有ゆえ block されるが、bias-to-safe として許容（記録のみ）。
      // 複合コマンド（`;` `&&` `bash -c`/`env` 前置）・フルパス起動（`/usr/bin/git`）は本 hook 対象外
      // （canonical L91・#1 で de-scope 済＝全 matcher 共通の既存限界）。
      {
        pattern: /^git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+|--\S+\s+|-\w\s+)*clean\b/i,
        dangerousPath: /^(?!.*--dry-run)(?!.*(?:^|\s)-[a-z]*n[a-z]*(?=\s|$))/,
        requireDangerousPath: 'custom',
        name: 'git clean (untracked ファイルの不可逆削除)',
        alternative: 'git clean -n で削除対象を確認してから個別 rm。全削除が必要なら承認マーカーを touch',
      },
      // node -e with fs.rmSync / fs.rm({recursive:true})
      {
        pattern: /^node\s+(--?[a-zA-Z][\w-]*\s+)*-e\s/,
        dangerousPath: /fs\.(rmSync|rm)\s*\(/,
        requireDangerousPath: 'custom',
        name: 'node -e with fs.rmSync / fs.rm (任意コード経由削除)',
        alternative: 'node ワンライナーで recursive 削除する代わりにスクリプトファイル化し PR レビュー経由',
      },
    ];

    for (const m of matchers) {
      if (!m.pattern.test(command)) continue;
      if (m.requireDangerousPath === true && !DANGEROUS_PATH.test(command)) continue;
      if (m.requireDangerousPath === 'custom' && !m.dangerousPath.test(command)) continue;

      const reason = `⛔ [pre-bash-destructive] 破壊的コマンドを検知: ${m.name}

検知コマンド: ${command}

代替手段: ${m.alternative}

TPO バイパス: 意図的な実行の場合は承認マーカーを touch（10 分間有効）:
  touch "${MARKER_PATH}"

根拠: 公式推奨パターン（PreToolUse + Bash で destructive command 検知）
過去事案: Session 278 taskkill /F 自動実行で YMM4 破壊・マスター激怒（feedback_no-process-kill-without-consent.md）`;

      console.log(JSON.stringify({ decision: 'block', reason }));
      process.exit(0);
    }

    // どの検知パターンにもマッチしなければ通過
    process.exit(0);
  } catch (e) {
    // JSON 解析失敗 → 安全側に倒して通過（既存 hook と同じ方針）
    process.exit(0);
  }
});
