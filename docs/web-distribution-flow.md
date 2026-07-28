# video-shorts Web配布フロー（おさらい用・正本）

> 2026-07-04 に確定・実機検証済み。次回はここから復習する。
> 公開URL（客に渡す）: **https://install-omega.vercel.app/**

## 客の操作フロー（標準EULA方式・実機検証済み）

1. 客が **https://install-omega.vercel.app/** を開く
2. 「ダウンロード」ボタン → **video-shorts.zip が即DL**（同意ゲートなし）
3. zip を開く（展開）→ 中の **`setup.html` を開く**
4. **［規約を表示］**で内容確認（読む・読まないは自由）→ **［☑ 規約に了承する］**にチェック
5. チェックで **［はじめる］が活性** → 押すと**使用説明書へ** → 使える状態

法的にもこれが正解（リサーチ済み・**クリックラップEULA＝署名不要で最も有効**。DL後・開いた時に「I accept→Next活性」がデスクトップアプリ標準）。

- 根拠: [EULA During Installation (TermsFeed)](https://www.termsfeed.com/blog/eula-installation/) / [How to Use Clickwrap for Your EULA](https://www.termsfeed.com/blog/how-clickwrap-eula/) / クリック同意は署名なしで有効（諾成契約・経産省準則・東京地判平26.2.18）
- 本人特定＝氏名/契約で足りる（証拠力）。署名（電子署名法3条）は必須でない。

## 客に渡すURL

**https://install-omega.vercel.app/**

## 明日（運用）に向けた正直な注意

1. 展開後、客のPCに **Node/Python/ffmpeg＋セットアップ**が要る（非エンジニアなら**構築代行**前提）は変わらない。
2. 旧 `consent.html`（DL前同意版）はWeb上に残っているが、どこからもリンクしていない**死にファイル**（無害）。気になれば消す。
3. `はじめにお読みください.txt` は配布物ローカルにのみ在り（git外）。**このPCでは反映済み**なので明日は問題なし。**別PCで作り直す時だけ要注意**。

## 運用コマンド・構成（触る時のため）

- **製品更新→Web反映はワンコマンド**: `video-shorts/` で
  `powershell -ExecutionPolicy Bypass -File .\build-web.ps1`
  （dist再生成 → video-shorts.zip 梱包 → Vercel本番デプロイ）
- Webページ実体: `video-shorts/install/`（index.html=DLページ / user-manual.html=使用説明書）を Vercel(`install-omega`) が配信
- DL後EULA画面: `video-shorts/setup.html`（パッケージ同梱・自己完結HTML）
- 製品zip: `video-shorts/install/video-shorts.zip`（build-web が生成・git外）

## 関連コミット（2026-07-04）

- `f38b17004` 標準EULA方式（DL自由→setup.htmlで規約了承→はじめる）
- `754ab8ea5` build-web.ps1 ワンコマンド
- `90006860f` 同意→製品zip実DL（前方式・現在は setup.html 方式に移行）
- `eccb99cd0` 同意をDL前画面に再フレーム（前段階）
