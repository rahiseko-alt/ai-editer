# video-shorts の AGENTS.md（記入済みの実例）

ルート `AGENTS.md` の普遍ルールを継承しつつ、この案件で確定したスタックを宣言する。
`kosespark-import` ブランチ（vibe-base モノレポからの分割・別統治）で開発済みのコードを
`docs/roadmap.html` の原子ツリー運用（本リポジトリの正）へ引き継いだもの。

## 概要

長編動画 → 縦型/横型ショート動画への自動編集パイプライン。文字起こし→区間選定→字幕焼き→
レンダリングをローカル PC 上で完結させ、チャット駆動 CLI（`pipeline.mjs`）とローカル Web UI
（`server/index.mjs` + `webapp-mockup/`）の 2 経路を持つ。

## 技術スタック（既存実装より確定）

- クラウド / ホスティング: 不要（客の PC 上でローカル動作。AI-Editer のサーバ・アカウントを介さない）
- 言語 / ランタイム: Node.js 22（標準モジュールのみ・npm 依存ゼロ） + Python 3（文字起こし: Groq Whisper API）
- フレームワーク: 無し（`server/index.mjs` は `node:http` のみで実装した素の HTTP サーバ）
- パッケージ / 依存管理: pnpm workspace（配布物は npm 依存ゼロ）。外部バイナリとして ffmpeg/ffprobe が必須（別途導入）。
  2026-08-09 マスター承認により `playwright` を devDependencies へ追加した（P2-5/7/8 の実ブラウザ検証用）。
  `server/`・`webapp-mockup/` は `build-dist.mjs` が配布物へ含めない保留経路のため、devDependencies が
  増えても配布物（客のPCへ届くもの）には一切影響しない。CI（`.github/workflows/ci.yml`）で Chromium を
  インストールしてから `pnpm test` を実行する。
- DB / データアクセス: 不要（ジョブ状態はファイルシステム上の JSON、`work/`/`output/` はコミット対象外）
- 認証: **未導入**（`server/index.mjs` の localhost API は現状無認証。2026-07-27 監査 P1-2 で指摘済み、roadmap 参照）
- IaC / デプロイ: 客の Claude Code へ `start-here.md` 経由でパッケージ＋設定を配置（`build-dist.mjs` が配布物を生成）
- テスト: プレーン Node/Python スクリプト（`tests/smoke.mjs` 純粋関数ユニットテスト、`tests/transcribe-corrections-check.py`）。
  `tests/render-check.mjs`（ffmpeg 実レンダリング検証）は fixture（`samples/test-16x9.mp4`）が `.gitignore` 対象で
  未コミットのため、現状 CI には未接続（手動実行のみ）。roadmap の backlog 参照
- Lint / フォーマッタ: **未導入**（プレーン JS のため。roadmap の backlog 参照）

## コマンド

- セットアップ: `pnpm install`（本パッケージ自体はゼロ依存）
- 開発 / 実行:
  - ローカル Web UI: `node video-shorts/server/index.mjs`（`http://127.0.0.1:5178`）
  - CLI パイプライン: `node video-shorts/pipeline.mjs init "<動画パス>" --mode <mode> --sub <on/off> --orient <向き>`
- ビルド: 無し（配布物生成は `node video-shorts/build-dist.mjs`）
- テスト: `pnpm --filter video-shorts test`（`package.json` の `test` スクリプトに列挙した Node/Python の
  検査群が直列に走る。2026-08-10 時点で30本、うち3本（`webapp-mobile-layout-check.mjs` /
  `webapp-aria-pressed-check.mjs` / `webapp-modal-focus-check.mjs`）は Playwright(Chromium) による
  実ブラウザ検証。中身の正は `package.json` の `test` スクリプト自体を見る（ここで本数を管理しない））
- Lint: 未導入
- 型チェック: 対象外（プレーン JS）
- デプロイ: 対象外（客 PC 上でのローカル動作）

## この案件固有のルール / メモ

- 全工程キーレスが原則。Groq を使う場合のみ客自身の API キーを使用（AI-Editer が代理・再販しない）。
- 2026-07-27 監査提案（`docs/audits/2026-07-27-kosespark-test-review-proposal.md`）の残作業（P0-5・P1 全12件・P2 全9件）は
  `docs/roadmap.html` の原子ツリーへ移した。以後の進捗管理はそちらが正。
- 旧統治（`memory.md` / `.claude/hooks/*` の vibe-base 系ゲート）はこのリポジトリでは採用しない。
  `AGENTS.md` / `docs/roadmap.html`（本ルート運用）に一本化する。
