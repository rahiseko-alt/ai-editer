# video-shorts — 長編動画を縦型/横型ショートに自動編集

> **最初にお読みください**：導入の前に、同梱の `install/consent.html` をブラウザで開き、外部サービス・AI利用の同意事項をご確認のうえ同意してください。同意すると「控え（同意の証拠）」がダウンロードされます。**この控えは保管してください**（構築を代行でご依頼の場合は担当者にお渡しください）。同意後、下記の手順でセットアップに進みます。

長編の動画（mp4）から「面白い区間」を AI が選び、縦型（SNS リール向け）または横型ショートを字幕付きで自動生成するツールです。お使いの PC 上で動作し、動画は外部に送られません（文字起こしを高速化する場合のみ、あなたの鍵で Groq に音声を送ります）。

## できること

- 長編動画 → 見どころショート（複数本）を自動生成
- 話題ごと（topic）／面白い所だけ（digest）の2モード
- 縦型（1080×1920）／横型（1920×1080）の選択
- 字幕の ON/OFF・派手エフェクト（glitch/neon/shake）
- 生成した候補をブラウザで確認して採用/破棄（歩留まり 30〜50% 前提）

## 動かすのに必要なもの（初回のみ・無料）

| ソフト | 用途 | 入手 |
|---|---|---|
| Node.js 18 以上 | 本体の実行 | https://nodejs.org （LTS 版を推奨） |
| Python 3.12 | 文字起こし | https://www.python.org/downloads/ |
| ffmpeg / ffprobe | 動画処理 | https://ffmpeg.org （Windows は winget/choco でも可） |

インストール後、ターミナルで `node -v` / `python --version` / `ffmpeg -version` が表示されれば準備完了です。

## セットアップ

```bash
# 1. Python ライブラリを入れる（文字起こし用・無料）
pip install -r requirements.txt
```

文字起こしは既定で **お使いの PC 上（無料・ローカル）** で動きます。鍵の設定は不要です。

### （任意）文字起こしを高速化したい場合だけ Groq 鍵を設定

ローカル文字起こしは無料ですが CPU 依存で時間がかかります。速くしたい場合のみ、あなたの Groq アカウントの鍵を設定できます（無料枠 1 日 8 時間）。

1. https://console.groq.com/keys にログインし「API Key」を作成する
2. `video-shorts/.env` というファイルを作り、次の 1 行だけ書く（鍵はこのファイル以外に貼らないでください）:
   ```
   GROQ_API_KEY=gsk_（作成した鍵）
   ```
3. 鍵が有効か確認する:
   ```bash
   python src/check-groq-key.py   # [OK] 有効 / [NG] まだ無効（対処ヒント付き）
   ```

> 鍵を設定しなくても、無効でも、ネットが切れても、自動でローカル文字起こしに切り替わるので止まりません。

## 使い方

```bash
# 1. 文字起こし
python src/transcribe.py 入力動画.mp4 work/myvideo/transcript.json
# 2. 区間選定（AI が見どころを選ぶ）
node pipeline.mjs select work/myvideo
# 3. レンダリング（ショート生成）
node pipeline.mjs render work/myvideo
# 4. ブラウザで候補を確認して採用/破棄
#    ui/index.html を開く
```

## 文字起こしの種類（自動で最適を選択）

| 種類 | 中身 | 速度の目安 | 鍵 | 費用 |
|---|---|---|---|---|
| ローカル（既定） | PC 上の whisper | 1時間の動画で約60分 | 不要 | 無料 |
| Groq（任意） | クラウド高速文字起こし | 1時間の音声で約17秒 | 要 `GROQ_API_KEY` | あなたの Groq 無料枠内・超過分は $0.04/時 |

## 派手エフェクトを付ける（任意）

```bash
node src/apply-effect.mjs 入力.mp4 <glitch|neon|shake> 出力.mp4
```

| 種類 | 効果 |
|---|---|
| glitch | 色収差＋ノイズ（デジタルバグ風） |
| neon | 発光＋極彩色 |
| shake | ズーム＋カメラ揺れ（勢い） |

## うまくいかない時

| 症状 | 対処 |
|---|---|
| `ffmpeg not found` | ffmpeg を入れ直し、`ffmpeg -version` が出るか確認 |
| 文字起こしが遅い | ローカルは CPU 依存。速くするには Groq 鍵を設定（上記） |
| Groq が `[NG]` | 鍵をコピーし直す。console.groq.com で鍵を再作成。それでも無効なら鍵設定を消せば無料のローカルで動く |
| 字幕の誤変換 | `src/term-corrections.json` に「誤→正」を追記すると次回から補正される |
| 候補が少ない/微妙 | 歩留まり 30〜50% は仕様。ui で採用分だけ使う |

## アーキテクチャ（技術参考）

```
入力mp4
  → transcribe.py       文字起こし（word 単位・JSON）
  → select-segments.mjs AI が「残すテキスト＋見出し」を選定（秒数は AI に出させない）
  →  reverse-match.mjs  残すテキストを word 単位に逆照合し start/end 確定
  → render-vertical.mjs FFmpeg で縦/横化＋字幕焼き（音声は無劣化コピー）
  → 候補が生成される
  → ui/                 人間が採用/破棄
```

主要ファイル: `pipeline.mjs`（全体制御）/ `src/transcribe.py`（文字起こし）/ `src/select-segments.mjs`（区間選定）/ `src/reverse-match.mjs`（秒数確定）/ `src/render-vertical.mjs`（縦横化・字幕焼き）/ `src/digest-editor.mjs`（digest モードの台本再構成）。
