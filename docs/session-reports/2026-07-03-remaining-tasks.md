# kosespark video-shorts 残タスク詳細（2026-07-03・次セッション必読）

> branch: master ／ 直近 commit: `52313dc63`
> 各タスクに**受け入れ基準（数値/状態）**を付す。基準を満たすまで「完了」と報告しない。

## 0. このセッションで完了（commit 52313dc63・実測ゲート通過済）
- A/V同期を**全クリップ 0.0ms** に根治（2段シーク＋`-bf 0`＋`setpts=PTS-STARTPTS`）。旧21ms残留・個体差33msを解消。
- 縦/横ヒアリングを**機械強制**（`init --orient <縦|横>` 必須）。画面録画は横で文字を残す。
- 余韻パディング常時オン（前0.5/後0.8s・env調整可）。
- 細切れ結合（`TOPIC_MIN_SEC` 既定180s）＋区間端の無音スナップ（新規 `src/snap-boundaries.mjs`）。45分素材で **13本→7本**。
- digest の `parseJson` をエピローグ耐性化（JSON後の説明文でのクラッシュ根治）。
- 完成物: `output/画面録画-2026-07-02-140528/`（横・7本・全offset 0.0ms・1920×1080）。

---

## 1. 残タスク（優先度順）

### ✅ [完了 2026-07-03] R-1 配布版 `dist/` への反映（設定ドリフト）
- 対応: `pipeline.mjs` / `src/{select-segments,reverse-match,snap-boundaries,srt-builder,subtitle-styles,render-vertical,concat,select-modes,digest-editor}.mjs` / `src/{transcribe,transcribe_groq,check-groq-key}.py` を dist へ反映。`diff` で開発版と完全一致・dist側 `node --check`/`py_compile` 全EXIT 0を確認。
- 備考: dist は digest モード自体が丸ごと未反映の旧世代だったため、当初想定の4ファイルより広い範囲（依存閉包全体）の反映が必要だった。`README.md`（客向け構築指示書）は用途が別物のため対象外のまま。`gen-editor-html.mjs` は pipeline.mjs から未参照のため反映不要と判断。

### ✅ [完了 2026-07-03] R-2 topic 選定プロンプトの改善（Webアプリ化検討の結果、方針を修正）
- 方針転換: `pipeline.mjs cmdSelect` はもともと「客と話しているClaude Code自身が `llm-request.md` を読み `llm-response.json` を書く」設計（`server/claude-select.mjs` のサブプロセス自動選定は別のWebアプリ用経路・今回不使用と確定）。よって「自動化」ではなく「Claude Codeが毎回ブレなく大きな単位で選べるようプロンプトを改善する」対応に修正。
- 対応: `src/select-modes.mjs` の topic fragment を「大きなテーマ単位でまとめる」指示に書き換え済み。
- 対象: `src/select-modes.mjs`

### ◐ [2026-07-04] R-3 digest 品質（堅牢化＋プロンプト改善は完了・score80は素材上限で未達）
- 完了: (1)parseJson崩れ・claude -pタイムアウトでも best を返し完走する堅牢化（旧実装は例外死し best 破棄。commit前の実測でrevise時JSON崩れ→全体クラッシュを再現・根治）。(2)critic を観点別配点(掴み/流れ/密度/山場/締め 各20点)化し revise へ現在score・目標・最弱観点をフィードバック。旧58固定→66〜71へ底上げ。(3)`DIGEST_MODEL`/`DIGEST_MAX_ITER` でモデル・反復を env 化（sonnet・1反復で約4分完走 vs opus・3反復10〜20分）。
- 未達: score≥80 は stress-digest(ペットライブ)で 55〜71 にブレ届かず＝**素材の面白さが天井でコード解決不能**。80強制は無限ループ化するため best採用で完走する現設計が妥当。
- 対象: `src/digest-editor.mjs`

### ✅ [完了 2026-07-04] R-4 文字起こし後補正（誤変換辞書）
- 対応: `transcript.json` 生成直後（パイプラインの単一真実源）で `src/term-corrections.json` の誤→正辞書を `words[].w` と `segments[].text` の両方へ適用（字幕・区間選定・逆マッチングの全下流に一貫）。`transcribe.py` に `load_corrections`/`apply_corrections` を追加、`tests/transcribe-corrections-check.py` で ALL PASS。既知医療例(椎間板系)を初期登録。
- 運用: 客ごとの固有名詞・専門用語は term-corrections.json に追記（正解が明確な語のみ・誤爆防止）。stress-digest はペット素材で医療誤変換なし＝実素材の医療用語0件検証は素材揃い次第。
- 対象: `src/transcribe.py`・`src/term-corrections.json`

### ✅ [完了 2026-07-04] R-5 未修正の小バグ3件（Check-out検証パネル指摘・修正済）
- `reverse-match.mjs`: `matchOne` に走査開始位置 `minCharPos` 引数を追加、`resolveSegments` が topic 経路のみ直前マッチ末尾以降から探索し同一フレーズ2回出現の2つ目を拾う（digest は preserveOrder で下限伝播せず据え置き）。smoke.mjs に二重出現ケース追加（15 PASS）。既存 topic 素材で resolveSegments 出力が修正前と完全一致（回帰なし・13区間）。
- `concat.mjs`: `runFfmpeg` で非 ENOENT の spawn エラー（EACCES 等）も真因 `r.error.message` を throw し握り潰し解消。
- `digest-editor.mjs`: `--model` 再試行判定の正規表現を連語一致化（"invalid JSON"/"unknown error" で誤マッチせず・model 無効語のみ）。

### ✅ [完了 2026-07-04] R-6 検証ヘルパ `src/av-verify.mjs`（新規作成）
- `node src/av-verify.mjs <clip>` が v:0/a:0 の start_time 差を ms 表示し `< 5ms` で PASS(exit0)/FAIL(exit1)。既存 0.0ms clip で PASS・音声100msずらし clip で FAIL(78ms) を実機確認。dist は pipeline 未参照のため対象外。

### ✅ [完了 2026-07-03] R-7 Check-out 検証パネル指摘（commit 52313dc63 への advisory・全4件修正済）
- **R-7a** `mergeShortSegments` に隣接ギャップ判定（`maxGapSec=3`既定）を追加。除外区間を跨ぐ結合を防止。実素材(`画面録画-2026-07-02-140528`)の回帰テストで、従来誤って結合されていた約39秒ギャップが正しく分割されることを実測確認。
- **R-7b** `pipeline.mjs` の `snapToSilence` を `mode!=="digest"` ブロック内に移動しガード。
- **R-7c** 余韻パディングも同ブロック内に移動しガード（digestは抑制）。`stress-digest` 素材で14区間・パディングなしを実測確認。
- **R-7d** `TOPIC_MIN_SEC` に `Number.isFinite` チェックを追加、NaN/0以下は既定180へフォールバック。単体確認済。

### ✅ [完了 2026-07-04] R-8 mergeShortSegmentsのmaxGapSec固定値3秒（Check-out検証パネル指摘・advisory→修正済）
- 対応: `pipeline.mjs` で `process.env.TOPIC_MERGE_GAP_MAX`（既定3・`Number.isFinite`ガードでNaN/0以下は既定3にフォールバック）を算出し `mergeShortSegments(resolved, MIN_SEC, MAX_GAP)` へ渡すよう変更。`snap-boundaries.mjs` のJSDocにも env調整可能な旨を明記。
- 実データ閾値検証（ffmpegレンダリング省略・選定→逆マッチ→結合ロジックのみで区間数を計測）:
  - `work/stress-topic`（16候補・61分素材）: gap=2s→16区間 / gap=3s(既定)→15区間 / gap=5s→15区間
  - `work/画面録画-2026-07-02-140528`（13候補・topic）: gap=2s/3s(既定)/5s いずれも7区間（変化なし）
  - 判断: 2件の実素材で既定値3秒は5秒（より許容的な設定）と同じ結果を示し、過剰な細切れ再発は確認されなかった。2秒まで狭めると1件多く細切れ化（stress-topicで16→15の差）。**既定値3秒は妥当と判断し変更なし**。
- 単体テスト: `tests/smoke.mjs` に `maxGapSec` の狭め/既定値ケースを追加（`node tests/smoke.mjs` 13 PASS）。
- 回帰確認: `work/画面録画-2026-07-02-140528` をenv未設定で再レンダリングし、7本・A/V offset 0.0ms（clip1実測）を維持。
- 対象: `src/snap-boundaries.mjs`（`mergeShortSegments`）・`pipeline.mjs`

### ✅ [完了 2026-07-04] R-9 CLIP_PAD_HEAD/TAILのNaN伝播バグ（新規検出）
- `pipeline.mjs`余韻パディングが不正env値でNaN伝播しうる問題をR-7dと同じ`Number.isFinite`ガードで修正。`CLIP_PAD_HEAD=abc`等の実行確認済み。

---

## 2. 中長期（B表・P0ゲート後 or 別周回）
- **Webアプリ版は保留・今回は不使用（2026-07-03マスター確定）**: `webapp-mockup/`・`server/`は削除せず現状維持。
- モデル階層化（B表#3）／`claude -p`のcwd不整合（`server/claude-select.mjs`・B表#4）／超長尺digestのchunk理解（B表#7）／Groq 25MB超分割投入（B表#8）。
- 画質: 素材解像度が天井。高解像度素材でないと精細化不可＝コード解決不能。
- **2026-07-04監査advisory（保留webapp/server経路・backlog）**: `claude-select.mjs`/`digest-editor.mjs`のプロンプト埋込にサニタイズなし／`server/index.mjs`アップロードにサイズ・拡張子検証なし。実配布時に着手。

## 3. P0 ゲート状況
- ⛔ **即死仮説#1（非エンジニア素人が導入・操作できる）は解決検証完了（マスター確定 2026-07-04）。この検証は二度と提案しない**（hypotheses.md #1=✅）。ブロッカー解除。

## 4. 引継ぎ前提（実機・検証手順）
- 実験素材: `work/画面録画-2026-07-02-140528`（横・7本・完成）／`work/stress-topic`（縦16本）／`work/stress-digest`（digest例・score58）。work/ output/ は gitignore。
- 音ズレ検証の数値ゲート: `ffprobe -select_streams v:0/a:0 -show_entries stream=start_time` の **V/A offset < 5ms**（目標0.0ms）。マスターの耳が二段目。
- 縦横/字幕/モードは `init` 必須引数（機械強制・前回引き継ぎ禁止＝毎回ヒアリング）。
- レンダは全区間一括。`node pipeline.mjs render <workDir> [--no-sub]`。余韻・結合・スナップは cmdRender が自動適用。
