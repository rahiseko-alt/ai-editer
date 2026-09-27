# video-shorts の AGENTS.md

ルート `AGENTS.md` の普遍ルールを継承しつつ、この案件で確定したスタックを宣言する。

## 概要

長編動画 → 縦型/横型のダイジェスト・切り抜き動画への編集ツール。文字起こし→台本案（区間選定）→承認→書き出し→検品を、
**デスクトップ版 Claude Code のチャットだけで完結させる**（2026-09-27 マスター決定。ローカル Web UI・サーバー・ワーカーは削除した）。
区間選定と検品は、チャットしているセッション自身が行う（ルート `AGENTS.md` の絶対項目）。手順の正は `.claude/skills/video-edit-checklist`。

## 技術スタック

- クラウド / ホスティング: 不要（使う人の PC 上でローカル動作）
- 言語 / ランタイム: Node.js（標準モジュールのみ・実行時の npm 依存ゼロ） + Python 3（文字起こし: Groq Whisper API またはローカルの faster-whisper）。
  `package.json` の `engines.node` は `>=20.0.0 <24.0.0`（Node.js v24.13.0 の Windows で OneDrive 配下・日本語パス上の
  `fs.rmSync()` 再帰削除がネイティブクラッシュした実測があるため。`docs/audits/adversarial-review-2026-08-13.md` #15）。
- 外部バイナリ: ffmpeg / ffprobe（必須）
- パッケージ / 依存管理: pnpm workspace（devDependencies は lint 用のみ）。Python 依存は `requirements.txt`。
- DB: 不要（ジョブ状態はリポジトリ直下 `.runtime/` の JSON。コミット対象外）
- 認証: 不要（サーバーを持たない）
- テスト: プレーン Node スクリプト（`tests/*.mjs`）。中身の正は `package.json` の `test` スクリプト
- Lint: ESLint 9（`eslint.config.mjs`）

## コマンド（すべて `video-shorts/` で実行。叩くのはセッション）

- 環境チェック: `node src/edit-job.mjs doctor`
- 動画の登録〜文字起こし: `node src/edit-job.mjs new "<動画パス>" [--portrait] [--caption] [--instruction "<指示>"]`
- 台本案: `node src/edit-job.mjs plan <jobId>` → 承認: `approve <jobId>` → 書き出し: `render <jobId>`
- テスト: `pnpm --filter video-shorts test` / Lint: `pnpm --filter video-shorts lint`

## この案件固有のルール / メモ

- 全工程キーレスが原則。Groq を使う場合のみ使う人自身の API キーを使用する（代理・再販しない）。
