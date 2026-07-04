# 文字起こし速度実測 — Groq vs local（2026-07-02）

## 条件
- 入力: `video-shorts/work/talk-16x9/input.mp4`（48.669 秒・日本語）
- コマンド: `python src/transcribe.py <in> <out> --backend {groq|local} --lang ja`
- 端末: GPU 非搭載 Windows（local は CPU int8）

## 結果

| 項目 | GROQ (whisper-large-v3-turbo) | LOCAL (faster-whisper small/CPU int8) |
|---|---|---|
| 処理時間（real） | **5.4 秒** | 53.8 秒 |
| 速度差 | 約 10 倍速 | 基準 |
| words | 159（word 粒度あり） | 160 |
| segments | 10 | 5 |
| duration 認識 | 48.669s | 48.669s |

## 判定（plan ステップ1・5）
- Groq は **word-level timestamp を返す** → reverse-match.mjs 互換を確認（plan ステップ1 PASS）。
- 48.7 秒動画で 5.4s vs 53.8s ＝ **約 10 倍速**。1 時間動画換算で従来 約60分 → 数分。
- 鍵は別 Google アカウントで発行した gsk_（56 文字）が有効。従来 401 の主因は .env に古い無効鍵が残っていたこと（検証時に .env が環境変数より優先されるため）。

## end-to-end 通電（2026-07-02 後半・PASS）

- Groq 経路で transcribe(6.8s) → select → 逆マッチ(confidence 1.0) → render まで通電。
- 生成物: `output/talk-16x9-groq/candidates.json` + `short-01-3日坊主を終わらせる5分習慣術.mp4`（1080×1920・34.06s・字幕なし）。

## 複数本同時投入の実測（2026-07-02 後半・PASS）

- 同一 48.7s 動画 ×3 本を Groq バックエンドで**同時**投入（CLI 並列）。

| 動画 | 処理時間（real） |
|---|---|
| 1本のみ（基準） | 6.8 秒 |
| 3本同時 #1 | 8.5 秒 |
| 3本同時 #2 | 7.5 秒 |
| 3本同時 #3 | 10.3 秒 |

- 中央値 8.5 秒＝**3本同時でも各本ほぼ一定**（直列なら約20秒。クラウド側並列が効いている）。plan ステップ6 の完了条件 PASS。
- `server/pipeline-runner.mjs` に並列制御を実装: **Groq 鍵あり=並列許可／鍵なし(local)=FIFO で1本ずつ直列**（CPU 取り合い防止）。構文チェック OK・320行（500行ゲート内）。local 直列キューのサーバ実機3本投入テストは未実行。
