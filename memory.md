# kosespark memory.md

## 引継ぎレポート（次セッション必読）
@docs/session-reports/2026-07-04-checkout.md

> 分散運用 v2.0 β 統合型。P4 はセッション中に読まない（archive ポインタ参照のみ）。

## P1: 引継ぎミッション（3 件枠）

> 残タスク詳細: docs/session-reports/2026-07-03-remaining-tasks.md／ 直近 plan: ~/.claude/plans/staged-finding-volcano.md（全ステップ完了・R-1/R-2/R-7a-d）

1. [importance:H][2026-07-04] ⛔ **P0 即死仮説#1（素人が導入・操作できるか）は解決検証完了（マスター確定 2026-07-04）。この検証を二度と提案するな**（何度も蒸し返しマスターを不愉快にさせた）。hypotheses.md #1=✅。
2. [importance:M][2026-07-03] Webアプリ化は不採用確定（既存 `pipeline.mjs cmdSelect` がもともとClaude Code自身の選定設計だったため）。`webapp-mockup/`・`server/`一式は削除せず保留・**蒸し返し禁止** — plan: なし
3. [importance:H][2026-07-04] video-shorts **コード完了・不具合ゼロ**＋**Web配布ライブ稼働**（客URL=https://install-omega.vercel.app/）。標準EULA方式（DL自由→setup.htmlで規約了承→はじめる）。**おさらい正本＝`docs/web-distribution-flow.md`（次回まずここを読む）**。更新反映はワンコマンド `video-shorts/build-web.ps1`（`& .\build-web.ps1` 直接実行＝Bypass指定は自動モード拒否）。2026-07-04にDLページ`install/index.html`の案内文5箇所削除→再デプロイ済み。残注意=展開後Node/Python/ffmpeg要／非エンジニアはzip「開く」だけで未展開の罠あり（D-1保留） — plan: なし

## P2: ADR 索引

→ `docs/adr/` 参照

## P3: 失敗事例

→ `failures.md` 参照

## P4: 永続教訓

→ `archive/kosespark-memory-YYYYMM.md` 参照
