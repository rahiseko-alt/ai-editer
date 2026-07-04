# kosespark Writer テスト版 — 裏エンジン手順書（PIPELINE）

> Claude（オーケストレーター）はこのファイルを読み、定義された 4 工程を**上から順に**実行する。
> 各工程は「外部AIツール（Claude 以外）」が担当する（CLAUDE.md 冒頭の絶対厳守）。執筆だけ Claude 本体。
> **完全キーレス**：どの工程も API 鍵を必要としない。

## 連携先（全て鍵不要）

| 工程 | 担当 | 呼ぶ MCP ツール |
|---|---|---|
| ① リサーチ | DuckDuckGo MCP | `mcp__duckduckgo__search` / `mcp__duckduckgo__fetch_content` |
| ② 執筆 | Claude 本体 | （MCP なし。①の成果物を読んで書く） |
| ③ 校正 | textlint MCP | `mcp__textlint__lintText` / `mcp__textlint__getLintFixedTextContent` |
| ④ スライド | Marp MCP | `mcp__marp__create_presentation` / `mcp__marp__export_slide` |

> MCP ツール名が環境で異なる場合は `/mcp` または `claude mcp get <name>` で実名を確認して読み替える。

## 入出力規約（工程間はファイルで受け渡す）

リクエストごとに作業ディレクトリを切る。`<id>` は `YYYYMMDD-連番`（例 `20260616-001`）。

```
workspace/pipeline/<id>/
  request.json        ← 入力（テーマ・読者・トーン・文字数）
  state.json          ← 進捗状態（各工程 pending/running/done/failed）
  01-research.md      ← ① 出力（要約 + 出典URL）
  02-draft.md         ← ② 出力（記事ドラフト）
  03-lint.json        ← ③ 出力（textlint 結果）
  03-revised.md       ← ③ 出力（校正反映後の記事）
  04-slide.md         ← ④ 中間（Marp 用 Markdown）
  04-slide.html       ← ④ 出力（スライド・テスト版は HTML 固定）
```

`request.json` の形：
```json
{ "keyword": "テーマ", "persona": "初心者", "tone": "親しみやすい敬体", "length": "2000-2500" }
```

`state.json` の形：
```json
{
  "id": "20260616-001",
  "steps": {
    "research": { "status": "pending", "output": "01-research.md" },
    "write":    { "status": "pending", "output": "02-draft.md" },
    "proof":    { "status": "pending", "output": "03-revised.md" },
    "slide":    { "status": "pending", "output": "04-slide.html" }
  }
}
```

## 鉄則（サイレントフェイル禁止 / CLAUDE.md §2）

1. **各工程の最後に、自分の出力ファイルの「存在＋非空」を必ず確認する**（`test -s <file>`）。偽なら **その場で停止**し、`state.json` の当該 step を `failed` にして報告する。次工程に進まない。
2. **MCP がエラー（`isError:true`）や空応答を返したら成功扱いにしない。** 結果が薄い場合も「未取得」と明記し、捏造で埋めない。
3. **前工程の出力が無い／空なら、当該工程は実行しない**（依存ゲート）。
4. 失敗時は黙って続けず、何がどう失敗したかをマスターに報告する。

## 工程詳細

### ① リサーチ（DuckDuckGo MCP）

1. `request.json` の `keyword` で `mcp__duckduckgo__search` を呼ぶ（上位 5〜8 件）。
2. 有望な 2〜3 URL を `mcp__duckduckgo__fetch_content` で本文取得。
3. 要点（必須トピック・一次情報）と**出典URL**を `01-research.md` にまとめる。
4. **ゲート**：`test -s 01-research.md`。偽なら停止（フォールバックに Claude 標準 WebSearch を使う判断はマスター確認）。

### ② 執筆（Claude 本体）

1. `01-research.md` を読む（無ければ ① 失敗として停止）。
2. 検索意図に沿って見出し構成 → 本文化。`persona`/`tone`/`length` を反映。
3. 各見出しに具体例か数値を 1 つ入れる。出典が怪しい箇所は `【要ファクトチェック】`。
4. `02-draft.md` に書く。**ゲート**：`test -s 02-draft.md`。

### ③ 校正（textlint MCP）

1. `02-draft.md` の本文で `mcp__textlint__getLintFixedTextContent` を呼び、自動修正版を得る。
2. 併せて `mcp__textlint__lintText` で残課題（`results[]`）を取得し `03-lint.json` に保存。
3. 自動修正を反映し、敬体統一・冗長削除を確認して `03-revised.md` に書く。
4. **ゲート**：`test -s 03-revised.md`。`isError:true` のときは成功にせず停止。

### ④ スライド（Marp MCP）

1. `03-revised.md` から「制作過程の説明資料」用の Marp Markdown を組み、`04-slide.md` に書く（表紙 / 制作の流れ / 使ったAI / 記事要点）。
2. **主経路＝Marp CLI**：`npx marp --no-stdin 04-slide.md -o 04-slide.html` で **HTML** を出力（テスト版は PDF/PPTX を使わない＝Chromium 非依存）。`--no-stdin` 必須（無いと stdin 待ちでハング）。
   - ※ `marp-mcp` は内部の marp-cli 未検出で失敗する事例があるため主経路にしない。CLI を正とする。
3. 日本語フォント崩れ対策：Marp の CSS で `font-family` を明示（`system-ui` を避ける。例 `"Meiryo","Yu Gothic"`）。
4. **ゲート**：`test -s 04-slide.html`。

## 完了報告（機械ゲート必須）

「完成」と報告する前に、**必ず `node engine/verify-pipeline.mjs <id>` を実行し exit 0（PASS）を確認する**。
- exit 2（FAIL）なら完成扱い禁止。停止して原因を直し、PASS するまで報告しない。
- 自己申告だけの完了宣言は禁止（CLAUDE.md 大域規律「AI 自己規律を信用しない・機械検証で強制する」）。
- PASS 後に成果物パスを併記して報告する。

## 再実行（冪等）

各工程は冒頭で「自分の出力が既に存在し非空か」を確認し、ある場合はスキップして次へ進む（途中再開）。最初からやり直す場合は `<id>` ディレクトリを作り直す。

## スコープ外（将来）

- UI 連携：別途作る UI が `request.json` を置き、エンジンが `04-slide.html` 等を返すファイル介在 IF（`<id>` で分離）。
- SaaS 版：② 執筆の LLM を外部 API に差し替え。①③④ の外部連携はそのまま流用。
