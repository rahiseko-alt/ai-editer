# kosespark ライター向け 外部AIツール調査（10カテゴリ）

> 調査日 2026-06-16 / サブエージェント10体並列。
> 前提（CLAUDE.md 根幹）= Claude/Anthropic 以外の外部AIツールを Claude Code がハブとして束ねる。subagent 代替は禁止。
> 条件 = ①Claude以外 ②無料 or 無料枠 ③MCP か API/URL で Claude Code に繋がる。

## ★ 鍵不要で即繋がる（素人向け最重要・設定ゼロ）

| ツール | 用途 | 連携手段 | 商用・再販注意 |
|---|---|---|---|
| textlint | 日本語校正（誤字・表記ゆれ・文体） | 公式MCP `claude mcp add textlint -- npx textlint --mcp`。MIT・鍵不要 | 制限なし（MIT）。客配布も可 |
| Pollinations.AI | アイキャッチ/挿絵 画像生成 | 鍵不要・URLだけ `image.pollinations.ai/prompt/{text}`。公式MCPも有 | 無料の商用可否は要確認。モデル別ライセンス確認 |
| QuickChart | グラフ画像（棒/折れ線/円） | 鍵不要・URLだけ `quickchart.io/chart?c={JSON}`。月10万枚無料 | 生成画像は用途不問で使用可。API再販は要問合せ |
| Kroki / Mermaid.ink | 図解・ダイアグラム（フロー/シーケンス等） | 鍵不要・URLだけ。Kroki MIT | 内包ライブラリ別ライセンス（PlantUML=GPL等）確認 |
| LibreTranslate(セルフホスト) | 翻訳 | 公式MCP `npx @libretranslate/mcp`＋localhost。文字数無制限 | AGPL-3.0。SaaS化時はソース開示義務に注意 |

## カテゴリ別 最有力（鍵は要るが無料枠で動く）

| # | カテゴリ | 最有力 | 無料枠 | 連携 | 商用・再販注意 |
|---|---|---|---|---|---|
| 1 | 文章生成LLM | Google Gemini API | 1,500req/日・クレカ不要 | 非公式MCP複数/公開API | 無料枠出力はGoogleが学習利用。商用はVertex AI推奨 |
| 1 | 〃(代替) | OpenRouter | 50req/日・鍵1本で複数モデル | OpenAI互換API/MCP実績 | モデル別ToS継承 |
| 1 | 〃(高速) | Groq (Llama/Gemma) | 1,000req/日 | OpenAI互換API | 再販可否は未確認 |
| 3 | SEOキーワード | DataForSEO | $1クレジット+サンドボックス | 公式MCP（claude mcp add） | 再販/白ラベルToS未確認。完全無料枠は薄い |
| 5 | Web検索リサーチ | Tavily | 1,000クレジット/月 | 公式MCP（1行接続） | **無料枠は非商用限定**。商用は有料 |
| 5 | 〃(代替) | Exa | 1,000req/月（非認証150/日） | 公式MCP（Star4400+） | MCPはMIT。API ToS未確認 |
| 7 | 文字起こし | Gladia | 月10時間（恒常・カード不要） | 公式MCP `gladiaio/mcp-gladia` | ToS未確認。日本語可 |
| 7 | 〃(代替) | Groq Whisper | 2,000req/日 | OpenAI互換API | 無料枠商用可否要確認 |
| 8 | 翻訳 | DeepL API Free | 月50万文字 | 公式MCP `claude mcp add deepl` | **再販禁止・無料枠は学習利用**。代行は実質Pro必要 |

## 連携が現実的に弱いカテゴリ（正直な報告）

| カテゴリ | 状況 |
|---|---|
| 9 ファクトチェック/盗用・AI検出 | GPTZero/Originality/Copyleaks はAPIが有料プランのみ。継続的な無料API連携は事実上不可。無料は Google Fact Check Tools API（鍵のみ）と ClaimBuster（学術向け）程度 |
| 図解AI(高品質) | Napkin AI は公開APIなし（Web専用）。連携不可。鍵不要で繋ぐなら QuickChart/Kroki に限定される |

## ⚠ 重大な注意（kosespark は「客に売る」業態）

多くの無料枠が **「非商用/個人限定」または「入力データを学習利用」**（Tavily無料=非商用、Gemini無料=学習利用、DeepL Free=学習利用＋再販禁止）。
- 自分の検証や素人体験デモは無料枠でよい。
- **顧客に納品/再販する段階では、商用可なもの（有料API）か、セルフホスト無料（LibreTranslate / textlint / Whisper OSS）に寄せる必要がある。** → リスク診断 #3（代理登録・再販のToS）と直結。鍵管理方針（CLAUDE.md §2）確定までは実装着手禁止の対象。

## ライター向け最小構成（鍵不要中心の叩き台候補）

外部AIだけで「下調べ→執筆→校正→画像→図表」が一通り組める:
1. 下調べ … Tavily（無料・MCP）※非商用限定に注意
2. 執筆/タイトル/要約 … Gemini API（無料・要鍵1本）
3. 校正 … textlint（鍵不要・公式MCP）
4. アイキャッチ … Pollinations（鍵不要・URL）
5. 図表 … QuickChart / Kroki（鍵不要・URL）

> 各ツールの出典URL一覧は調査ログ（本セッションのサブエージェント出力）に保持。必要時に再掲。

---

## ライター向けバージョン 確定構成（マスター指定 2026-06-16）

> マスター指定: 執筆は Claude（＝プラットフォーム本体／追加API鍵・課金なしでその場で書ける旨味）。他は Claude 以外の特化に振る。「全部 Claude」では専門特化の spark にならない。

| 役割 | 担当 | 種別 | 連携手段 | 鍵 | 商用・納品時の注意 |
|---|---|---|---|---|---|
| リサーチ専門 | Tavily（代替: Exa） | AI検索 | 公式MCP（1行接続） | 要（無料枠） | **無料枠は非商用限定**。客納品時は有料 or Exa を検討 |
| 執筆 | **Claude 本体** | LLM | プラットフォーム内（追加連携なし） | 不要 | — |
| 校正 | textlint | ルールベース校正 | 公式MCP `claude mcp add textlint` | 不要 | MIT・制限なし |
| スライド生成 | Marp（marp-mcp）／編集可pptx要なら Office-PowerPoint-MCP-Server | 変換ツール | 公式MCP `claude mcp add` | 不要 | MIT・制限なし |

### 未解決の論点（マスター確認待ち）

「他は特化したAIにしろ」の指定に対し、**校正(textlint)・スライド(Marp)は厳密には"AI"ではなくルールベース/変換ツール**である。
- 無料・鍵不要を優先 → 上表（専門ツール）でよい。
- "AI"であることにこだわる → 校正=Shodo(API月4万円〜)、スライド=Gamma(API Pro $25/月〜)となり**有料化**する。

### スライド生成調査の根拠（2026-06-16）

| 候補 | 生成物 | 鍵/料金 | 連携 |
|---|---|---|---|
| marp-mcp | PDF/HTML/PPTX | 鍵不要・無料・MIT | `claude mcp add marp-mcp -- npx -y @masaki39/marp-mcp@latest` |
| Office-PowerPoint-MCP-Server | PPTX(編集可) | 鍵不要・無料・MIT・Star1.8k | smithery/claude mcp add |
| Gamma(AIスライド) | PPTX/PDF/Web | API は Pro $25/月〜 | 公式MCP/Connector |

