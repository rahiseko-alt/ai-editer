# 公式APIのあるライター向けAIサービス一覧（2026-06-16・探索結果）

> 目的：kosespark（複数の専門特化AIを束ねる統合ツール）に組み込む候補。**公式API確認済みのみ**。
> 束ねる前提なので「**第三者統合・再販ToS**」を最重要列として併記。価格は調査時点の実数（変動あり）。
> ⚠️ ToS「未確認」は組み込み前に原文確認必須（前に Tavily が再販禁止だった教訓）。

## ⚠ 束ねる可否の早見（最重要）

| 区分 | サービス |
|---|---|
| **明示的に再販/サブライセンス禁止**（そのままは束ねられない・要パートナー契約） | Semrush / Ahrefs / Grammarly / DeepL(Write) / Tavily |
| **第三者統合に向く/設計上OK寄り**（要最終ToS確認） | Copy.ai・Writesonic・Rytr / OpenAI・Gemini・Mistral・Cohere / Frase / DataForSEO(ホワイトラベル前提) |
| **要ToS確認（不明）** | Surfer / NeuronWriter / Exa / Perplexity / Brave / You.com / SerpAPI / LanguageTool / Sapling / Textgears / Shodo / Ideogram / Recraft / fal.ai / Stability / FLUX / Replicate / Anyword / Jasper |

## 1. 汎用ライティング/コピー/記事生成

| サービス | 公式API | 何ができるか | 価格 | 第三者統合・再販 | 確信度 |
|---|---|---|---|---|---|
| Jasper | あり（Business plan） | 生成・ブランドボイス・編集・画像 | $59/月〜＋API要Business・クレジット制 | Tech Partner登録要・再販明文未確認 | 高 |
| Writesonic | あり（SDK有） | 記事/Chatsonic/コピー生成 | 要確認 | 自動化連携例多・再販ToS未確認 | 高 |
| Copy.ai | あり（Workflow API） | 任意ワークフローをAPI化・Webhook | 要確認 | 統合向き設計・再販ToS未確認 | 高 |
| Anyword | あり（Pro/Ent） | コピー生成＋効果予測スコア | Pro:50,000語/月〜 | 200+統合・再販未確認 | 中 |
| Rytr | あり | 30+言語生成・トーン指定 | 従量・無料1万クレジット | 統合可・再販未確認 | 高 |
| OpenAI / Gemini / Mistral / Cohere | あり | 生成全般（執筆の土台） | 従量（例 GPT-4o $2.5/$10 per M） | API構築サービス提供は概ね可・再販は個別確認 | 高 |

## 2. SEO分析・コンテンツ最適化・SERPデータ

| サービス | 公式API | 何ができるか | 価格 | 第三者統合・再販 | 確信度 |
|---|---|---|---|---|---|
| DataForSEO | あり | SERP/キーワード/被リンク/監査 | 従量・最低$50・SERP $0.6/1,000 | **ホワイトラベル前提＝束ねやすい** | 高 |
| Surfer SEO | あり（V2・2026/5更新） | エディタ管理/アウトライン/AI執筆・MCP準備中 | Peace of Mind $219/月前後 | 未確認 | 中 |
| Frase | あり（50+ep・MCP有） | ブリーフ生成/SERP分析/可視性追跡 | 全プラン含む・$39/月〜 | 未確認 | 中 |
| NeuronWriter | あり | クエリ一括/最適化推奨取得 | 未確認 | 未確認 | 中 |
| Semrush | あり | ドメイン/キーワード/被リンク | Business $499.95/月＋ユニット | **再販・サブライセンス禁止** | 高 |
| Ahrefs | あり（Connect） | 被リンク/順位/流入推計 | $500/月〜 | **再販・サブライセンス禁止** | 高 |
| Clearscope / Scalenut / MarketMuse | **API無し**（除外） | — | — | — | 高 |

## 3. 校正・文章改善・言い換え（日本語対応を明記）

| サービス | 公式API | 日本語 | 何ができるか | 第三者統合・再販 | 確信度 |
|---|---|---|---|---|---|
| Shodo | あり | **○（日本語専用）** | 日本語AI校正・誤字・表記ゆれ | 未確認（API申込フォーム有） | 高 |
| Textgears | あり | **○（明記）** | 文法/スペル/可読性スコア | 未確認 | 高 |
| Yahoo!校正支援 | あり | **○** | 誤変換・表記ゆれ | **商用ToS要確認**（個人枠の可能性） | 中 |
| LanguageTool | あり（OSS自ホスト可） | 不明 | 文法/スタイル | OSS版でToS回避可 | 高/低 |
| Sapling | あり | 不明 | 文法/トーン/AI検出 | 未確認 | 高 |
| DeepL Write | あり（Pro） | **×（6言語に日本語無）** | リライト・文章改善 | **再販禁止** | 高 |
| Grammarly | あり（SDK/Ent） | ×（英語特化） | 文法/明瞭さ/AI検出 | **再販禁止**（authorized reseller要） | 高 |
| Wordtune | あり（発表済・現行ドキュ未確認） | 不明 | 言い換え/要約 | 未確認 | 中 |
| QuillBot / 文賢 / ProWritingAid | **API無し/未確認**（除外寄り） | — | — | — | 中 |

## 4. 画像/ビジュアル生成（アイキャッチ・挿絵・図）

| サービス | 公式API | 文字入り画像 | 価格 | 生成物の商用・再販 | 確信度 |
|---|---|---|---|---|---|
| OpenAI Images(gpt-image-1) | あり | 強い | モデル別 | 商用可・生成物所有はユーザー・API転売禁止 | 高 |
| Ideogram | あり | **強い** | $0.025〜0.10/枚 | 全プラン商用可（ToS準拠） | 高 |
| Recraft | あり | **強い（ベクター可）** | $0.022〜0.08/枚 | 有料は商用所有権付与・無料は商用不可 | 高 |
| Stability AI | あり | 標準 | 1Cr=$0.01 | 商用ToS未確認 | 中 |
| fal.ai / Replicate | あり（多モデル集約） | モデル依存 | 従量 $0.003/枚〜 | モデル別ライセンス確認要 | 中 |
| Black Forest Labs(FLUX) | あり | 未確認 | 1Cr=$0.01 | 商用ToS未確認 | 中 |

## 5. リサーチ・検索・出典取得

| サービス | 公式API | 何ができるか | 価格 | 第三者統合・再販＋学習利用 | 確信度 |
|---|---|---|---|---|---|
| Tavily | あり | 検索/抽出/クロール/出典返却 | 無料1,000Cr/月・$0.008/Cr | **再販禁止・入力を学習利用** | 高 |
| Exa | あり | セマンティック検索/要約/出典 | 無料1,000/月・$7/1,000〜 | ToS未確認 | 高 |
| Perplexity Sonar | あり | 検索付き回答・出典URL | トークン＋$5/1,000req〜 | 第三者モデル学習なしと明記・再販ToS未確認 | 中 |
| Brave Search | あり | 自前インデックス検索/LLM Context | $5無料/月・$5/1,000 | ToS未確認 | 高 |
| You.com | あり | 検索/取得/Research | $100無料・$5/1,000 | ToS未確認 | 高 |
| SerpAPI | あり | SERPスクレイピング取得 | 無料250/月・$25/1,000〜 | ToS未確認・検索エンジン規約依存 | 高 |
| DataForSEO SERP | あり | SERP一括取得・AI要約 | 従量 $0.0006/query〜 | ホワイトラベル前提 | 高 |

## メモ（探索で分かった重要事実）

- **日本語消費者向けライター製品（SAKUBUN / Catchy 等）は公式APIなし**（自社アプリ内利用前提）。束ねる対象にならない。
- 日本語校正で公式API＝**Shodo / Textgears / Yahoo!校正**の3つ（Yahoo は商用ToS要確認）。
- 大手SEO（Semrush/Ahrefs）と大手校正（Grammarly/DeepL）は**再販明示禁止**＝そのまま束ねるのは不可、パートナー契約が要る。
- **束ねやすい（ホワイトラベル前提）**のは DataForSEO。SEO実データを入れるならまずここが現実的。
- 全ての「未確認」ToS は組み込み前に原文確認が必須。

---

## ToS確認結果（規約原文に当たって確定・2026-06-16）

> 観点＝「kosespark が客向けツールに統合・提供／再販してよいか」。逐語引用は保存。

### 結論（最重要）

**ライターSaaS製品（Jasper / Writesonic / Copy.ai / Anyword / Rytr）と大手SEO（Surfer / Frase / Semrush / Ahrefs）と校正（Grammarly / DeepL / Shodo / LanguageTool / Wordtune）は、ほぼ全て「再配布・サブライセンス・第三者提供・ホワイトラベル」を規約で明示禁止。**＝**"競合製品をそのまま束ねて客に売る"は、ほとんど規約違反になる。**

唯一クリーンな道：**素のLLM/部品APIの上に kosespark が自分で作り、鍵は kosespark 側で一元管理し、客には"成果物"を渡す**形（OpenAIが明示許可）。＝「Jasperを再販」ではなく「OpenAI等の上に自前で統合ツールを作る」。

### カテゴリ別 確定

| サービス | 客向け統合/提供 | 逐語の核心 |
|---|---|---|
| **OpenAI API** | **可（明示）** キーは客に渡さない | "use APIs to integrate the Services into your...Customer Applications and to make Customer Applications available to End Users" / キー転売は禁止 |
| Google Gemini | 部分可・グレー | "use Grounding with Google Search in an application owned and operated by you"（機能制約あり） |
| Mistral | 書面授権が要る | "nor grant any third party access...without our prior written authorization" |
| Cohere | デフォルト不可・要交渉 | non-sublicensable / service bureau 利用禁止 |
| Jasper/Writesonic/Copy.ai/Anyword/Rytr | **不可**（再販/再配布禁止） | 各社 "resell, sublicense, redistribute" 禁止（Writesonicはagency例外、Jasperは別Reseller契約） |
| Surfer | **不可** | "not possible to assign, transfer or otherwise dispose of (reselling accounts)" |
| Frase | **不可** | "limited, personal, nontransferable...license" + 再販禁止 |
| Semrush / Ahrefs | **不可**（再販明示禁止） | sublicense/resell 禁止・要パートナー契約 |
| DataForSEO | **グレー（再販条文が不在）** 750社B2B実績 | 制限は§7.1の検索エンジン競合利用禁止のみ。要書面確認 |
| Grammarly / DeepL | **不可**（再販禁止） | "Do not sell, resell, or lease our services" 等 |
| Shodo | **不可** | 「自己利用以外の目的で利用してはなりません」 |
| LanguageTool / Sapling / Yahoo校正 | デフォルト不可・**書面交渉で可の余地** | LT="written approval"・Sapling="signed a service agreement"・Yahoo=商用は問い合わせ |
| 画像（OpenAI/FLUX/Replicate/Stability） | **成果物提供は可**（API直公開・キー譲渡は不可） | 各社 "you own outputs...commercial purposes"。ただし fal.ai/Ideogram は第三者へのAPI提供を明示禁止 |
| 検索（Brave/You.com/SerpAPI/Tavily） | **再販禁止が多い**（Braveは自社app可だが結果再配布禁止／You.comは競合製品禁止／Tavilyは再販禁止+学習利用） | Brave §3(b)(xii) "redistribute, resell, or sublicense the Search Results" |

### 採用しやすい順（規約リスク低い順・確定）

1. **OpenAI API**（顧客アプリ提供を明示許可・キーは自社管理）
2. **画像 FLUX(BFL) / Replicate / OpenAI画像**（成果物を客に渡す形＝可）
3. **DataForSEO**（再販条文不在＝グレーだがB2B慣行・要書面確認）
4. 校正は LanguageTool / Sapling / Yahoo を**書面交渉**すれば可の余地（即時は不可）
5. **不可（そのまま束ねられない）**：Jasper / Writesonic / Copy.ai / Anyword / Rytr / Surfer / Frase / Semrush / Ahrefs / Grammarly / DeepL / Shodo / fal.ai / Ideogram / You.com / Tavily
