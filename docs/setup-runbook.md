# AI-Editer Writer テスト版 — 導入 Runbook（客の Claude Code へ設置）

> 用途：マスターが導入サービス（60分）で**客の Claude Code デスクトップ版**に AI-Editer Writer を設置する手順。
> 前提モデル：呼び出すのは客自身の Claude Code。AI-Editer は「パッケージ＋設定」を入れるだけ（API を代理・再販しない）。
> 全工程キーレス（API 鍵不要）。本 Runbook の全コマンドは Session で実機検証済み（2026-06-16）。

## 設置するもの（パッケージ一式）

客のプロジェクトフォルダ直下に以下を配置する：

| ファイル | 役割 |
|---|---|
| `.mcp.json` | 外部AIツール3つ（duckduckgo / textlint / marp）の接続定義（鍵なし） |
| `package.json` | textlint＋日本語プリセット＋marp-cli の依存 |
| `.textlintrc.json` | 日本語校正ルール |
| `engine/PIPELINE.md` | 4工程の手順書（Claude が読んで実行） |
| `engine/verify-pipeline.mjs` | 完成判定の機械ゲート |
| `.claude/settings.local.json` | MCP事前承認（`enabledMcpjsonServers`） |
| `.gitignore` | node_modules / workspace / 秘密の除外 |

## 手順（番号順・上から実行）

### 1. 前提ランタイム確認

```
node -v        # v18 以上
npx -v
uv --version   # 無ければ https://docs.astral.sh/uv/ で導入
```

不足があればここで導入する。無いまま先へ進まない。

### 2. パッケージ配置

上表のファイルを客のプロジェクト直下にコピーする。

### 3. 依存インストール

```
npm install
uv tool install duckduckgo-mcp-server
```

- `npm install`：textlint・プリセット・marp-cli が `node_modules` に入る。
- `uv tool install`：DuckDuckGo MCP を恒久インストール（初回接続失敗の予防。必須）。

### 4. MCP 承認と接続確認

`.claude/settings.local.json` に以下があること（事前承認＝起動時ダイアログ回避）：

```json
{ "enabledMcpjsonServers": ["duckduckgo", "textlint", "marp"] }
```

Claude Code を一度再起動 → 接続確認：

```
claude mcp list
```

`duckduckgo / textlint / marp` が3つとも **✔ Connected** であること。失敗時は `claude mcp get <名前>` で診断（初回はダウンロードで数十秒かかる→再実行で接続）。

### 5. 動作確認（必須・ここを飛ばすな）

客のチャットで次を指示：

```
engine/PIPELINE.md に従って「（任意のテーマ）」でライター記事を1本、調査→執筆→校正→スライドまで通して
```

完了後、**機械ゲートで合否判定**（自己申告で完成にしない）：

```
node engine/verify-pipeline.mjs <id>
```

`[verify] PASS` かつ exit 0 なら設置成功。`FAIL`（exit 2）なら原因を直すまで引き渡さない。

### 6. 客への引き渡し

- 使い方：「テーマを言うだけで記事＋制作過程スライドが出る」こと、成果物は `workspace/pipeline/<id>/` に出ることを説明。
- 中身（DuckDuckGo＝調査 / Claude＝執筆 / textlint＝校正 / Marp＝スライド）を隠さず説明（複数AIが分業している事実）。

## トラブルシュート

| 症状 | 対処 |
|---|---|
| `claude mcp list` で Failed to connect | 初回ダウンロード。数十秒後に再実行。uv/npx が PATH にあるか確認 |
| Marp が stdin 待ちでハング | `npx marp --no-stdin ...` を使う（手順書は CLI 主経路・`--no-stdin` 必須） |
| MCP 承認ダイアログが分かりにくい | `settings.local.json` の `enabledMcpjsonServers` で事前承認済みにする（手順4） |
| textlint が無反応 | `.textlintrc.json` と日本語プリセットが `node_modules` にあるか（`npm install` 済か）確認 |
| hook で `require is not defined` | `package.json` に `"type": "module"` を入れない（CommonJS hook を壊す） |

## video-shorts を併設する場合（任意）

- Python 依存: `pip install -r video-shorts/requirements.txt`（faster-whisper / groq）。
- 文字起こしバックエンド（local / groq / auto）と `GROQ_API_KEY` の設定・鍵の疎通確認（`python src/check-groq-key.py`）は **`video-shorts/README.md`「文字起こしバックエンド」節が正本**。本 Runbook には転記しない。
- 鍵は客自身の Groq アカウントで発行し `video-shorts/.env`（git 追跡外）に置く。鍵なしでも local で全機能動作（遅いだけ・複数本同時は不可）。

## スコープ外（本番化で別途）

- 障害対応 Runbook（稼働後）→ `docs/standards/templates/runbook-template.md` を P4 で作成。
- 外部API課金を伴う構成（Gemini/GPT 等）に拡張する場合は §2 鍵管理方針の確定が前提。テスト版はキーレスのため対象外。
