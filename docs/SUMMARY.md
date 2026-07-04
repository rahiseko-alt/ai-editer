# kosespark 検討サマリー（すぐ出せる版・2026-06-16）

> このセッションで確定した内容と成果物の索引。詳細は各ファイルへ。

## 1. コンセプト（確定・CLAUDE.md 冒頭に明記済）

- kosespark ＝ **複数の専門特化AI（Jasper / Surfer / SAKUBUN 等の競合製品も含む）を束ね、素人が"1つの窓口"で使える統合ハブ**（＝Genspark型アグリゲーター）。
- **Claude Code 単体で完結させるのは厳禁**（コンセプトの否定）。執筆は「LLMスロット」で、テスト版＝Claude / 本格版＝外部LLM に差し替わる。

## 2. 事業モデル（確定）

- **客が自分のアカウント・鍵で契約し、kosespark が構築・設定・保守を代行**（＝§0「API登録代行・保守」）。
- kosespark 自身のアカウントを客に使わせる"再販/プロキシ"ではない → **PC セットアップ代行と同じ正規の受託**。
- ＝各ツールの「再販・サブライセンス禁止」条項は**無関係**。「束ねたら違反では」と再検討しない。
- 唯一の個別確認点：**API が無く UI 自動操作するツールのみ** "自動操作禁止" 条項を確認。

## 3. 2つのバージョン

| | テスト版（実装済） | 本格版（将来） |
|---|---|---|
| 基盤 | Claude Code | Web SaaS（Claude Code不要） |
| 執筆LLM | Claude Code内のClaude | 外部LLM API |
| 裏の連携 | リサーチ/校正/スライド等は外部ツール | 同じ |

## 4. テスト版エンジン（構築済・実データ1本通過を確認）

- 構成：DuckDuckGo(検索) → Claude(執筆) → textlint(校正) → Marp(スライド)。完全キーレス。
- **サイレントフェイル禁止を機械強制**：`engine/verify-pipeline.mjs`（PASS/FAIL を exit code で判定・実証済）。
- 導入手順：`docs/setup-runbook.md`。手順書：`engine/PIPELINE.md`。
- フロントUI試作：`writer-test/`（SaaS風・Claude Codeに見えない）。

## 5. 機密・品質の方針（確定）

- 「客の資料だけを根拠に・出典付き・客の文体で書く」。
- **執筆は Claude で行う（抜粋は Anthropic へ送るが学習なし＝NotebookLM並み）を受容**。完全ローカルは品質が落ちるため不採用。
- 「出さない」は **hook でネット出口を機械遮断**して強制（AIの善意に頼らない）。
- **ファクトチェックはAIに真偽判定させない** → 「出典提示できるものだけ書く／要確認に隔離」「閉じた資料(NotebookLM型)」で担保。
- 資料は**自動リサーチ＋出典付き保管**で貯める（手入力は任意）。貯まった資産＝囲い込み。

## 6. 使えるサービス（客契約・kosespark構築モデル）

- **API有＝そのまま統合可**：OpenAI / Gemini / Mistral / Jasper / Writesonic / Copy.ai / Rytr / Surfer / Frase / NeuronWriter / DataForSEO / Semrush / Ahrefs / Shodo / Textgears / Yahoo校正 / LanguageTool / Sapling / Grammarly / DeepL Write / OpenAI画像 / Ideogram / Recraft / Stability / fal.ai / FLUX / Replicate / Tavily / Exa / Perplexity / Brave / You.com / SerpAPI。
- **API無＝UI自動操作の可否を要確認**：SAKUBUN / Catchy / EmmaTools / Clearscope / Scalenut / 文賢 / QuillBot。
- 詳細（API有無・価格・制約）→ `docs/writer-ai-service-matrix.md`。

## 7. 市場の結論（差別化の方向）

- ライターが**金を払う理由**：時間削減・量産 ＞ SEO競合分析→構成 ＞ ブランドボイス保持 ＞ 公開まで一気通貫。
- **欲しいのに無い**：ファクトチェック(要望1位58%)・文体が死なない・低価格で公開まで完結。
- **日本市場の空白**：既存は全て「客が自分で使いこなす」前提＝非エンジニアに高ハードル → **導入代行＋伴走が kosespark の勝ち筋**。
- **低価格では戦わない**（既存に資本で負ける）。機密・出典・文体の品質＋導入伴走で取る。

## 8. 未決定（次の論点）

1. 標準パッケージとして**どのサービスを束ねるか**（用途別の既定構成）。
2. ブランドボイス永続／出典トレース機能の実装。
3. 本格版（Web SaaS化）に進むかの判断。

## 9. ファイル索引

| ファイル | 内容 |
|---|---|
| `CLAUDE.md`（冒頭） | 根幹・コンセプト・事業モデル（絶対厳守） |
| `docs/SUMMARY.md` | 本ファイル（すぐ出せる全体像） |
| `docs/writer-ai-market-research.md` | 市場・競合・ペイン |
| `docs/writer-ai-official-api-list.md` | 公式API＋ToS逐語確認 |
| `docs/writer-ai-usable-services.md` | 使えるサービス確定リスト |
| `docs/writer-ai-service-matrix.md` | API/価格/制約マトリクス |
| `docs/external-ai-tools-research.md` | 初期10カテゴリ調査 |
| `docs/setup-runbook.md` | 導入手順Runbook |
| `engine/PIPELINE.md` / `engine/verify-pipeline.mjs` | テスト版手順書／検証ゲート |
| `writer-test/` | フロントUI試作 |
| `.mcp.json` / `.textlintrc.json` / `package.json` | テスト版設定 |
