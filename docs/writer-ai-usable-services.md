# kosespark Writer 使えるサービス確定リスト（2026-06-16）

> モデル：**客が自分のアカウント・鍵で契約し、kosespark が構築・設定・保守を代行**（＝API登録代行・保守）。再販ではないので「再販/サブライセンス禁止」条項は無関係。
> 判定：**①公式API有＝即統合可**／**②API無＝UI自動操作の可否のみ個別確認**。

## 工程別・使えるサービス（①公式API有＝そのまま統合可）

| 工程 | 使えるサービス（客契約・公式API有） |
|---|---|
| **リサーチ/出典取得** | Tavily / Exa / Perplexity(Sonar) / Brave Search / You.com / SerpAPI / DataForSEO |
| **執筆（LLM土台＋ライター製品）** | OpenAI / Google Gemini / Mistral / Cohere ／ Jasper / Writesonic / Copy.ai / Anyword / Rytr |
| **SEO分析・最適化** | Surfer SEO / Frase / NeuronWriter / DataForSEO / Semrush / Ahrefs |
| **校正（日本語）** | Shodo / Textgears / Yahoo!校正支援 |
| **校正（英語ほか）** | LanguageTool / Sapling / Grammarly / DeepL Write / Wordtune |
| **画像（アイキャッチ・挿絵）** | OpenAI画像 / Ideogram / Recraft / Stability AI / fal.ai / Black Forest Labs(FLUX) / Replicate |

→ 上記は全て**公式APIがあり**、客の鍵で kosespark が統合・運用すれば**そのまま使える**。

## ②API無し＝UI自動操作の可否を個別に確認すべきもの

| サービス | 状況 |
|---|---|
| SAKUBUN / Catchy / EmmaTools（日本語ライター製品） | 公式API無し。使うなら客アカウントを kosespark が UI 自動操作 → "自動操作禁止"条項の有無を個別確認 |
| Clearscope / Scalenut / MarketMuse（SEO） | 公式API無し（同上） |
| 文賢 / QuillBot（校正） | 公式API無し（同上） |

## kosespark 標準パッケージ（ライター向け）の素直な構成例

客の用途・予算に応じて上記から選んで束ねる。例：

- 下調べ：DataForSEO or Perplexity（出典付き）
- 執筆：OpenAI（顧客アプリ提供を明示許可）＋必要なら Jasper（客契約）
- SEO：Surfer or Frase（客契約・APIで構成チェック）
- 校正：Shodo（日本語・API）
- 画像：Ideogram or Recraft（文字入りに強い）

> どれを束ねるかは客ごとにカスタム（＝kosespark の"カスタムメイド構築"そのもの）。鍵は kosespark が預かり安全管理（§2）。

## 補足（事実）

- 日本語ライター消費者製品（SAKUBUN/Catchy/EmmaTools）は**API無し**＝統合は UI 自動操作経由になり、自動操作可否の確認が要る。API がある海外勢（Jasper 等）や LLM/画像/SEOデータ API は素直に統合できる。
- 出典・価格・ToS の根拠は `writer-ai-official-api-list.md` に保存済み。
