# apps/web の AGENTS.md（記入済みの実例）

ルート `AGENTS.md` の普遍ルールを継承しつつ、この案件で確定したスタックを宣言する。
これは「初期化フロー（ヒアリング→リサーチ→提案→承認→設定）」を一度通した結果の実例。

## 概要

Next.js（App Router）の Web アプリ。共有 UI は `@repo/ui`（`packages/ui`）を利用する。

## 技術スタック（確定）

- クラウド / ホスティング: Vercel
- 言語 / ランタイム: TypeScript（strict） / Node.js 22
- フレームワーク: Next.js 15（App Router） + React 19
- パッケージ / 依存管理: pnpm（workspace）
- スタイル: Tailwind CSS v4
- DB / データアクセス: 不要（ステートレス構成。永続データを持たないため。採用時に再評価）
- 認証: 不要（公開の静的トップページのみ・保護対象リソースなし。採用時に再評価）
- IaC / デプロイ: Vercel（main へ push で自動デプロイ、Root Directory = `apps/web`）。ビルド設定は `apps/web/vercel.json` に固定（framework=nextjs / install=`pnpm install --frozen-lockfile` / build=`pnpm --filter web build` / output=`.next`）
- テスト: Vitest（`apps/web/tests`、CI で実行）
- Lint / フォーマッタ: ESLint（flat config）

## コマンド

- セットアップ: `pnpm install`
- 開発: `pnpm --filter web dev`
- ビルド: `pnpm --filter web build`
- 型チェック: `pnpm --filter web typecheck`
- Lint: `pnpm --filter web lint`

## 運用・非機能（確定）

### 環境の区分（G-2-3）

現時点で**実際に稼働している環境**を正直に区分する（多層化は今回は保留）。黙って畳み込まない。

- **sandbox（ローカル / CI）**: 開発者ローカル（`pnpm --filter web dev`）と GitHub Actions。型 / lint / test / build / prod-smoke を実行。外部公開しない使い捨ての検証面。
- **preview（Vercel 自動プレビュー）**: main 以外のブランチ push で Vercel が per-branch に自動生成する使い捨て URL。PR 検証用（例: 観測性自己テストの `/api/boom` はこの面で実演した）。
- **prod（本番）**: `https://cc-v2-web.vercel.app`。main への push で更新される唯一の公開面。

**今回は省略（理由付き・閾値超過時に再評価）**: 専用の staging 環境、環境ごとに分離した config / secret ストア、preview≈prod の parity 保証は、現状 1 ページ静的 scaffold・保護資源/永続データ無しのため**構築しない**。API 連携・認証・DB のいずれかを導入する時点で環境分離を再評価する。

### 性能 / 可用性 / 持続可能性（G-6）

- 1ページscaffold・低トラフィックのため SLO/可用性/持続可能性は現段階N/A、閾値超過時に再評価。

### 可観測性 / 監視・ログ（G-4-1）

- Vercel ログ（Deployment/Runtime ログ）＋ヘルスチェック（トップページの 200 監視）で確定。
- 異常検知の確認: 意図的失敗（500 ルート等）を1回起こし、Vercel ログにそのイベントが現れることで検証（連携後）。

### コスト方針（G-4-4）

- 現段階は Vercel Hobby（無料枠）運用・課金上限/アラート設定なしで確定。有料化検討時に上限・アラートを再評価。

### ロールバック手順（G-4-2）

本番で問題が出たら、前の正常デプロイに戻す（前進修正を待たずに即座に復旧できる）。

1. Vercel ダッシュボード → 対象プロジェクト → **Deployments** を開く。
2. 直前の正常な Production デプロイを選ぶ → **⋯ → Promote to Production**。
   - CLI 代替: `vercel promote <前デプロイのURL>`。
3. 公開URLが前版に戻ったことを `curl` で確認（200＋既知マーカー `cc-v2 monorepo`）。

前提: Vercel 連携が済んでいること（G-2-1）。連携前はこの手順は机上定義であり、実行検証（前版へ実際に戻せる）は G-4-2 の2つ目の条件で別途行う。

## この案件固有のルール / メモ

- `any` は原則禁止（避けられない場合は理由をコメント）。
- React は関数コンポーネント + Hooks。スタイルは Tailwind ユーティリティ中心。
- 共有コンポーネントは `packages/ui/src` に置き、`index.ts` から export して `@repo/ui` で使う。
