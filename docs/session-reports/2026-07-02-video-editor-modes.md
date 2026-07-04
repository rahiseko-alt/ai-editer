# kosespark 引継ぎ 2026-07-02 — video-shorts 編集モード再編＋ダイジェストAIエージェント化

> branch: master ／ 次セッションは本ファイルを先頭から Read してから着手すること。
> **マスター指示（厳守）**: 次セッションは **(1) まず実験 → (2) その後に改善** の順で進める。いきなり改善に入らない。

## 🔴 最重要（今セッションの確定事項）

1. **編集モードは2択に確定**: `topic`（話題毎・全編カバー・時系列・1トピック1本）／`digest`（面白い所だけ・**AI編集エージェント**が台本再構成→1本連結）。**旧`short`は廃止**（話題毎と役割重複）。
2. **ダイジェスト＝AI編集エージェント**（`src/digest-editor.mjs`）: `claude -p`（Opus pin）で 全体理解→台本再構成（並べ替え可・声と言葉は逐語のまま）→批評→修正の**検証修正ループ**（テキスト上・最大3反復）→ 最終1本だけ台本順に連結。実証済: 61分→121秒、13区間を非時系列に再構成、confidence全1.0。
3. **レンダは boxblur 廃止済**（素材そのまま scale+pad の縦型化が既定）。20秒あたり48s→7s（約7倍速）。
4. **導入時ヒアリング機械強制**（`init` が `--mode`/`--sub` 必須・未指定エラー）は維持。字幕は毎回確認・前回引き継ぎ禁止。

## A. 次セッションの手順（マスター指示）

### (1) まず実験
- 実素材で topic と digest を通しで動かし、**特にダイジェストの仕上がり品質を体感**する。
- 手順（CLI）: `node pipeline.mjs init <mp4> --mode <topic|digest> --sub <on|off>` → `python src/transcribe.py <mp4> work/<id>/transcript.json --backend groq --lang ja` → `node pipeline.mjs select work/<id>` → `node pipeline.mjs render work/<id>`。
- 既存の実験素材と transcript が再利用可: `work/stress-insta-61m/transcript.json`（61分・12073語）、`work/insta-digest/`（digest完成例・score56）。
- レンダ前に**字幕有無をマスターに確認**（毎回質問ルール）。

### (2) その後に改善（下記「判明している問題」を優先度順に）

## B. 判明している問題と改善点

| # | 問題 | 詳細 | 改善案 | 優先 |
|---|---|---|---|---|
| 1 | **ダイジェスト完成度が低い** | 批評スコアが3反復でも56点（合格閾値80未満）。仕組みは正常だが質が届かない | draft/critic/reviseプロンプト調整・反復上限UP・閾値見直し・批評観点の再設計。`DIGEST_MAX_ITER`/`DIGEST_PASS_SCORE` 環境変数で調整可 | H |
| 2 | **文字起こし精度（Groq turbo）** | 医療/固有名詞を誤変換（椎間板→「追患版」、膝蓋骨脱臼→「室外骨打球」）。日本語WER約21% | 字幕ありにするなら用語辞書で後補正必須。精度モード(whisper-large-v3)や外部字幕AIの選択肢 | H（字幕時） |
| 3 | **選定段のモデル未最適化** | 話題毎の選定はキーレス=セッション最上位/サーバ=`claude -p`既定任せ。機械的分割に上位モデルは過剰 | モード別モデル階層化（split系=中位・digest=Opusはpin済）。`server/claude-select.mjs` に `--model` 追加 | M |
| 4 | **claude -p のCLAUDE.md汚染** | `claude -p` がプロジェクト憲法を読むと司令塔ペルソナ化し「JSON返せ」を乗っ取り拒否する。digest-editorは**中立cwd起動で回避済** | `server/claude-select.mjs` も同経路。中立cwd化を検討（未対応・潜在バグ） | M |
| 5 | **話題毎の長尺レンダ** | blur廃止後も RTF約0.4で再エンコード必要（話題毎は長尺クリップになりがち） | 縦素材(insta等)で無変換 `-c copy` 切り出しの余地。字幕なし時のみ | L |
| 6 | **web アプリUI 未対応** | 現状CLI/チャットのみ。2モードのUI配線・ヒアリングUI未実装 | 次周回（当初からスコープ外） | L |
| 7 | **超長尺（数時間）ダイジェスト** | digest-editorは全文1コール。61分はOK、数時間はプロンプト過大 | chunk理解→マージ（未実装・ログ明示済） | L |
| 8 | **Groq 25MB超の分割投入** | 32kbps mp3で約100分まで25MB内。それ超は未対応 | ffmpeg分割投入（未実装） | L |

## B-2. Check-out 検証パネル指摘（2026-07-02・全て advisory＝blocking なし）

| # | file | 種別 | 指摘 | 改善 | 優先 |
|---|---|---|---|---|---|
| 9 | digest-editor.mjs:31 | SEC | `claude -p` にツール制限なし＋cwd=tmpでproject denylist失効＋env全継承。音声内の自然言語→transcript→プロンプト生埋め込みで**間接プロンプトインジェクション**の余地（実行可否は権限設定依存でadvisory） | 子claudeはテキスト→JSONのみでツール不要 → `--disallowed-tools`（Bash/Write/WebFetch等）or `--permission-mode plan` 付与＋envを必要最小に絞る | H |
| 10 | reverse-match.mjs:40 | LOGIC | `matchOne` は indexOf で常に**最初の出現位置**のみ返す。digestが同一フレーズを2箇所で選ぶと start/end 同値→dedupeで片方黙殺（preserveOrderと矛盾） | 出現位置を順に消費する等で重複フレーズを区別。digest再構成の質に影響 | M |
| 11 | concat.mjs:11-14 | LOGIC | spawnSync が ENOENT 以外の r.error（EACCES等）を握り潰し、エラーメッセージ空で `ffmpeg concat 失敗: ` になり真因消失 | `r.error.message` を err に含める（2行修正） | L |
| 12 | digest-editor.mjs:43-48 | LOGIC | `/model|unknown|invalid/i` が緩く無関係な"model"警告にも誤マッチしうる | 判定を厳格化（終了コード＋特定文言） | L |

## C. 実装済みファイル（今セッション・全てコミット済）

| commit | 内容 |
|---|---|
| ff2a87e30 | Groq音声抽出＋timeout/retry（長尺・接続断解消） |
| e7c70503f | 3モード＋ヒアリング機械強制（初版） |
| d82768594 | レンダ高速化（boxblur廃止・約7倍速） |
| 46b16aa3e | モード再編（short廃止）＋ダイジェストAI編集エージェント |

- `src/digest-editor.mjs`（新規・145行）: 編集エージェント本体。`claude -p`中立cwd起動・draft/critic/revise。
- `src/select-modes.mjs`: topic/digest の2モード定義。
- `src/reverse-match.mjs`: `resolveSegments(…, {preserveOrder})` 追加（digestは台本順保持）。
- `src/render-vertical.mjs`: plain縦型化（blur廃止）。
- `src/concat.mjs`: ダイジェスト連結（ffmpeg concat・copy失敗時再エンコード）。
- `pipeline.mjs`: init必須引数・cmdSelect digest分岐・cmdRender順序保持concat・カバー率ログ。

## D. 環境・注意

- Groq鍵: `.env`（git追跡外・環境変数優先）。優先順位は Node/Python 実装で統一済（崩すな）。
- `claude -p` はサブスクログイン継承でコスト0。`--strict-mcp-config`＋中立cwd必須。
- work/ output/ は gitignore。テスト成果物（`work/insta-short`=旧ショート78本途中, `work/insta-digest`, `work/vt-*`, `work/stress-*`）が残存。不要なら整理可。
- 別作業班ファイル（`src/gen-editor-html.mjs`・`docs/`）はコミット対象外（巻き込むな）。

## E. 次セッション初手

1. 本ファイルと `~/.claude/plans/twinkly-herding-lighthouse.md`（完遂）を Read。
2. マスターに実験素材を確認 → topic/digest を実走（字幕有無は毎回確認）。
3. ダイジェスト品質を体感 → B表の優先度Hから改善着手。
