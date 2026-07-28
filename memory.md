# kosespark memory.md

## 引継ぎレポート（次セッション必読）
@docs/session-reports/2026-07-28-checkout.md

> 次セッションは本ファイル冒頭の上記レポートを **必ず先に Read** してから着手すること。
> 分散運用 v2.0 β 統合型。P4 はセッション中に読まない（archive ポインタ参照のみ）。

## P1: 引継ぎミッション（3 件枠）

> 直近 plan: ~/.claude/plans/federated-painting-kernighan.md（07-27監査P0是正・**全ステップ完了・commit済 0dd7909・vercel --prod デプロイ済み・実地確認済み**）

1. [importance:H][2026-07-23] **マスター確認待ち（継続）**: `video-shorts/work/hensyu01/` に 07-22 配置の素材 `lecture.mp4`（2048×1046・18分24秒・動画編集レクチャー）があり文字起こし済（`lecture_tr.json`）だが、`state.json` が無く pipeline 未 init ＝ 編集モード/字幕/縦横のヒアリング未実施で宙に浮いている。**この素材で何を作るのかをマスターに訊いてから着手する**（決め打ち禁止・自治憲法 §4 2026-07-02/07-03）。副次的に render拡大ガードの1080p以上実素材リグレッション確認（07-05から継続）もこの素材で可能 — plan: なし
2. [importance:M][2026-07-23] kosespark の **H2大義が未確定**。`roadmap.md`/`roadmap-state.json` が無いため、`plan-daigi-gate` hook が product では `照合先: N/A` を拒否し **ExitPlanMode を必ず deny する**（`照合先: N/A`はvibe-base root専用・productは実在マイルストーンidが必須と07-28に再確認）。新規の方向性を伴う plan を出す前に、H2大義＋マイルストーンを起案してマスター承認を得ること（07-23・07-28とも「大義を立てず作業のみ・Plan Mode 手動解除」でマスターが回避を選択） — plan: なし
3. [importance:H][2026-07-28] **マスター指示確定：07-27監査の残作業を全件改善（次セッション着手）**。`docs/audits/2026-07-27-kosespark-test-review-proposal.md`のP0 6件中、CLI配布に関わる分（P0-1〜4・P0-6のCLI/user-manual部分）は本セッションで是正・`vercel --prod`デプロイ・実地確認まで完了済み（commit 0dd7909→Check-out検証パネルの指摘2件を追加是正しc2a9b36で再デプロイ済み）。**残る P0-5（webapp-mockup設定未反映）・P1全12件（プロンプト注入/localhost API無認証/同名ジョブ競合/推測可能ID/依存脆弱性等）・P2全9件（UI/UX崩壊・ARIA・focus管理等）は、マスターが2026-07-28に明示指示「全て改善しろ」で対応範囲を確定**。次セッションはこの範囲でPlan Modeから着手すること（webapp-mockup/serverは現状dist除外＝配布対象外だが、監査提案の推奨修正順（Phase2セキュリティ境界→Phase3正しさ/停止性→Phase4 UX）に沿って全項目着手し、必要なら配布復帰も検討） — plan: なし（次セッションで新規plan起票）

## P2: ADR 索引

→ `docs/adr/` 参照

## P3: 失敗事例

→ `failures.md` 参照

## P4: 永続教訓

→ `archive/kosespark-memory-YYYYMM.md` 参照
