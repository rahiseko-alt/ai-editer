# kosespark memory.md

## 引継ぎレポート（次セッション必読）
@docs/session-reports/2026-07-05-checkout.md

> 次セッションは本ファイル冒頭の上記レポートを **必ず先に Read** してから着手すること。
> 分散運用 v2.0 β 統合型。P4 はセッション中に読まない（archive ポインタ参照のみ）。

## P1: 引継ぎミッション（3 件枠）

> 直近 plan: ~/.claude/plans/prancy-wobbling-wave.md（render拡大ガード+工程タイマー標準装備・**全ステップ完了・commit済 2233900/eb9dd36**）

1. [importance:M][2026-07-05] 字幕ASSタイミングずれバグ（区間開始秒≠0で表示ずれ・pre-existing）修正が `task_a39972bd` としてバックグラウンド別セッションで進行中。次セッション開始時に結果を確認 — plan: なし
2. [importance:M][2026-07-05] インスタライブ素材（椎間板ヘルニア回）から生成した7本のショート（`video-shorts/output/insta-live-herunia/`）がマスターの採用/破棄選別待ち。確認UI: `http://localhost:5511/ui/?job=insta-live-herunia`（`.claude/launch.json` の `video-shorts-ui` 設定） — plan: なし
3. [importance:L][2026-07-05] render拡大ガードの1080p以上実素材でのリグレッション確認は素材不足のため720p代替確認のみ（未実施）。実素材が手に入り次第正式確認 — plan: なし

## P2: ADR 索引

→ `docs/adr/` 参照

## P3: 失敗事例

→ `failures.md` 参照

## P4: 永続教訓

→ `archive/kosespark-memory-YYYYMM.md` 参照
