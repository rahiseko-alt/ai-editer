# KoseSpark テスト・レビュー・デバッグ提案書

- 実施日: 2026-07-27
- 対象: `products/kosespark`
- 判定基準: 正しさ、配布再現性、セキュリティ、障害時の停止性、UX、アクセシビリティ
- 総合判定: **FAIL / リリース阻害あり**

## 1. 結論

現行の配布を一旦停止し、配布物、配布skill、説明導線を同一の正本から作り直す必要がある。

現行の主要な販売対象であるチャット駆動CLI版には、次の即時阻害がある。

1. 公開ZIPが現行 `dist` より古く、修正済みの字幕タイミング不具合を含む。
2. 配布skillの `init` コマンドに必須の `--mode`、`--sub`、`--orient` がなく、新規ジョブを開始できない。
3. ダウンロード案内が、配布物に存在しない `setup.html` を開くよう指示している。
4. 配布ビルドが未追跡の `skill/` を残したまま再利用し、古い指示や改変物をZIPへ混入できる。

ローカルWeb版は現状 `dist` から除外された実験経路だが、再配布できる状態ではない。画面上のカット方法と出力サイズが処理系へ反映されず、セキュリティ境界、同時実行、モバイル表示にも阻害級の欠陥がある。

## 2. 実施体制

- `web-design-quality-gate`: アクセシビリティ、レスポンシブ、品質ゲート
- `browser:control-in-app-browser`: ローカルUIの375px / 1440px実表示検証
- `explore-agent`: 構成、配布経路、テスト範囲、正本ずれ
- `code-reviewer`: ロジック、異常系、競合、停止性
- `security-reviewer`: 外部送信、プロンプト注入、localhost API、秘密情報
- `verify-agent`: 構文、テスト、500行制限、配布ハッシュ、版刻印

## 3. 機械検証

| 検証 | 結果 | 判定 |
|---|---:|---|
| `node tests/smoke.mjs` | 16 PASS / 0 FAIL | PASS |
| `python tests/transcribe-corrections-check.py` | 全件PASS | PASS |
| `node tests/render-check.mjs` | MP4生成、1080x1920、縦型、音声AAC | PASS |
| 追跡対象JS/MJSの `node --check` | 失敗0 | PASS |
| `node scripts/check-secret-patterns.mjs` | 検出0 | PASS。ただしGroq形式未対応 |
| ソース500行上限 | 違反0、最大454行 | PASS |
| ソースと現行distの対象ファイルSHA-256 | 欠落・余剰・不一致0 | PASS |
| dist版刻印と現行HEAD | `dist/version.txt` が旧版 | FAIL |
| 公開ZIPと現行dist | ZIPがさらに旧版 | FAIL |
| `node webapp-mockup/measure.mjs` | 最小文字11.5px、EXIT 1 | FAIL |
| 375x812実表示 | 右カラムが約96pxへ圧縮、文字・操作が崩壊 | FAIL |
| `npm audit --audit-level=moderate` | High 5、Moderate 4 | FAIL |

`render-check` は生成物を書き込むため、テスト実行時に無視対象の `output/_render-check` を使用した。ユーザー素材 `work/hensyu01` は処理していない。

## 4. P0 Blocking

### P0-1 公開ZIPが旧実装

根拠:

- 現行 `dist/kosespark-video-shorts/version.txt` は `d0206e9`。
- 公開用 `video-shorts/install/video-shorts.zip` 内は `2debe4b`。
- ZIP内の `render-vertical.mjs` は旧2段シークを含み、現行ソースで修正済みの字幕先行問題が残っている。

影響:

- 購入者は、開発側で修正済みの不具合を含むパッケージを受け取る。
- リポジトリ上のテストPASSが、公開物の品質を保証しない。

提案:

- 公開ZIPを即時差し替え対象とする。
- ZIP展開後の全ファイルをmanifestと照合し、現行HEADの版刻印と一致しなければデプロイを拒否する。

### P0-2 配布skillの手順ではジョブを作れない

根拠:

- `dist/.../skill/video-shorts/SKILL.md:28` は `node pipeline.mjs init "<動画パス>"` を実行する。
- `video-shorts/pipeline.mjs:64-80` は `--mode`、`--sub`、`--orient` を必須にしている。
- 配布skillは字幕をレンダ直前に質問する旧手順のままで、モードと縦横のヒアリングがない。

影響:

- 新規導入直後の最初の操作が必ずEXIT 1になる。
- 製品自治憲法で必須化した「毎回の3項目ヒアリング」を配布物自身が破る。

提案:

- 配布skillを追跡対象の正本へ移す。
- 手順冒頭で編集モード、字幕、縦横を質問し、回答を1回の `init` へ渡す。
- クリーン展開環境で、skill記載コマンドをそのまま実行する契約テストを追加する。

### P0-3 配布案内と実物が矛盾

根拠:

- `video-shorts/install/index.html:50,58` は `setup.html` を開くよう案内する。
- `docs/web-distribution-flow.md` も同じ導線を正本としている。
- `video-shorts/build-dist.mjs:49-59` は `setup.html` を削除し、UIとinstallを配布対象外にする。
- `install/user-manual.html` は `init` を省略し、配布されない `ui/index.html` を案内する。
- 同意取得について `docs/sales-flow.md` と `docs/web-distribution-flow.md` が衝突している。

影響:

- 購入者は存在しないファイルを探す。
- 同意記録、セットアップ、実行手順の責任境界が不明になる。

提案:

- 配布導線を1本に決定し、正本を1ファイルへ統合する。
- ZIP内容のリンク切れと説明書の全コマンドを自動検証する。

### P0-4 レンダ失敗を成功として終了する

根拠:

- `video-shorts/pipeline.mjs:244-265` は各クリップのffmpeg/probe失敗をログだけにして継続する。
- 全クリップ失敗でも `candidates.json` を書き、stateを `rendered` にしてEXIT 0となる。
- サーバーはそのEXIT 0を受けて `done` を通知する。

影響:

- 出力0本でも成功表示になる。
- サイレントフェイル禁止ルールに反する。

提案:

- 必須クリップの失敗を集約し、1件でも失敗した場合のポリシーを明示する。
- 少なくとも全件失敗、出力0件、ffprobe不正は非0終了とする。

### P0-5 Web UIの設定が生成物へ反映されない

根拠:

- UIは `sub`、`cut`、`size` を送る。
- `server/pipeline-runner.mjs:241-247` が作るstateには `mode`、`sub`、`orient` がない。
- `opts.cut` と `opts.size` は後段で使われない。
- 分数と本数の値はリクエストに送られない。
- UIにある1:1、4:5はレンダラーに実装がない。

影響:

- 「16:9」「1:1」「4:5」「分数」「本数」を選んでも、実際は既定のtopic / portraitで処理される。
- ユーザーが確認した条件と成果物が一致しない。

提案:

- サポートする設定契約を定義し、未実装選択肢はUIから除去する。
- 画面選択、state、CLI引数、実出力解像度をE2Eで1対1照合する。

### P0-6 外部送信表示が実処理と矛盾

根拠:

- Web UIは「このPCの中だけで処理されます（外部に送りません）」と表示する。
- 実処理は文字起こし全文を `claude -p` へ渡す。
- Groqを選択した場合は音声も外部へ送る。

影響:

- 機密動画をローカル完結と誤認して投入する可能性がある。
- 利用者への説明と実際のデータフローが一致しない。

提案:

- ローカル処理と外部送信を工程別に正確に表示する。
- Groq利用、Claude選定、送信データ、保存期間を実行前に明示し、同意を取る。

## 5. P1 High

| ID | 問題 | 根拠と影響 | 推奨対応 |
|---|---|---|---|
| P1-1 | 非信頼文字起こしをagentへ直接投入 | 動画内命令が `claude -p` へ入り、ツールと全環境変数を継承する。プロンプト注入とローカル情報参照の危険 | ツール無効、環境変数allowlist、隔離cwd、非命令データ境界、敵対入力テスト |
| P1-2 | localhost APIが無認証 | Origin/Host/CSRF、容量、形式、レート制限なしで保存と子プロセス起動 | 起動時トークン、Origin/Host検証、magic byte、上限、レート制限 |
| P1-3 | 同名アップロード競合 | 実行中判定より前に同じ `input.*` をtruncateする | UUID job ID、先行予約、一時ファイル、atomic rename |
| P1-4 | 推測可能IDで成果物取得 | SSE、候補JSON、生成動画にジョブ認可がない | 暗号学的IDとジョブ別トークン |
| P1-5 | 一部チャンク失敗を成功扱い | 1チャンク失敗でも他が成功すると欠落を黙って確定する | incomplete状態、再試行、全チャンク完了ゲート |
| P1-6 | 再起動後SSEが永久待機 | job状態がメモリのみで、再接続は `unknown` のまま | 起動時reconcile、interrupted状態、再開/失敗通知 |
| P1-7 | Writer完了ゲートが弱い | `03-lint.json` 欠落・不正やseverity 2を成功認定できる | 必須JSON schema、未解決errorで非0終了 |
| P1-8 | 同名CLIジョブが状態を共有 | basenameだけでwork/outputを決める | UUIDまたはcontent hashを付与 |
| P1-9 | reverse matchが遠隔語を連結 | 前方語と100秒後の後方語を1クリップにできる | 最大gap、順序、連続性、coverage閾値 |
| P1-10 | 配布ビルドが残骸を保持 | 未追跡 `skill/` を削除せずZIPへ入れる | 空staging、allowlist copy、余剰拒否、manifest署名 |
| P1-11 | 依存脆弱性 | `npm audit`: High 5、Moderate 4 | 修正版更新、lock再生成、顧客入力経路の再監査 |
| P1-12 | 可変依存を事前承認で実行 | `uvx`無指定版、`npx -y ...@latest` | バージョンとhash固定、初回同意 |

## 6. P2 Medium / UX

| ID | 問題 | 推奨対応 |
|---|---|---|
| P2-1 | JSONを最終pathへ直接truncate書込み | sibling tempへ書き、fsync後atomic rename |
| P2-2 | A/V verifierがストリーム欠落を0秒扱い | 空出力をnullにし、必須stream欠落をFAIL |
| P2-3 | ASS時刻の100センチ秒繰上げ不備 | 総センチ秒を丸めてから時分秒へ分解 |
| P2-4 | ジョブと成果物にTTL/容量管理がない | クォータ、TTL cleanup、接続数上限 |
| P2-5 | 375pxで2カラムを維持して崩壊 | モバイルは1カラム化し、プレビューを後段へ移動 |
| P2-6 | 最小文字が11.5px | 13px以上、主要説明は14px以上へ統一 |
| P2-7 | 選択chipのARIA状態が未同期 | `aria-pressed` またはradio semanticsを全選択肢で同期 |
| P2-8 | modalのフォーカス管理なし | 開始時focus、focus trap、Escape、閉じた後のfocus復帰 |
| P2-9 | Writerは固定サンプルUI | デモ表示を明示し、製品機能と誤認させない |

## 7. テスト不足

現在のsmokeテストは主要な純粋関数を確認できているが、製品事故につながる境界を覆っていない。

追加が必要なテスト:

1. 配布skillの全コマンドをクリーン展開先で実行する契約テスト
2. ZIPとdistとHEADのversion/hash/余剰ファイル照合
3. `init` 必須3回答とstate保存
4. landscape、字幕あり/なし、実字幕タイミング、素材末尾、無音声
5. digest `--target-min` と尺是正ループ
6. 1件失敗、全件失敗、出力0件での非0終了
7. 同名ファイルの並行投入、サーバー再起動、SSE再接続
8. upload上限、magic byte、Origin/Host、認可、rate limit
9. プロンプト注入、外部命令、秘密文字列のredaction
10. 375、768、1280、1920pxでのレスポンシブとキーボード操作
11. Writerの正常、欠落、破損、lint error fixture

## 8. 推奨修正順

### Phase 0 配布停止と事実固定

- 公開ZIPの差し替えまで販売・再配布を停止する。
- 現行HEAD、dist、ZIP、公開URLのhashを記録する。
- 外部送信表示を訂正する。

### Phase 1 配布チェーン再構築

- skillを追跡正本へ移す。
- 空stagingからallowlist方式でdistとZIPを生成する。
- 手順書、同意、セットアップ、実ファイルを一本化する。
- manifest/version/link/commandのゲートを追加する。

### Phase 2 正しさと停止性

- render失敗、部分チャンク失敗、同名ジョブ、atomic stateを修正する。
- state schemaへmode/sub/orientを必須化する。
- UI未実装設定を実装または撤去する。

### Phase 3 セキュリティ境界

- Claude子プロセスをtoolなし、環境allowlist、隔離cwdで実行する。
- localhost APIへtoken、Origin/Host、認可、容量、形式、rate/TTLを追加する。
- Groq秘密検出とredactionを追加する。
- 可変バージョン依存を固定する。

### Phase 4 UXと回帰試験

- モバイルを1カラムへ変更する。
- 選択ARIA、modal focus、最小文字を修正する。
- 全受け入れ基準をCIで実行する。

## 9. リリース受け入れ基準

- クリーンな作業ディレクトリから1コマンドでdistとZIPを生成できる。
- ZIPの版刻印がビルド対象HEADと一致し、全hash一致、余剰0、欠落0。
- 配布skillの記載だけで3項目ヒアリングから生成完了まで進める。
- 説明書が参照する全ファイルとコマンドが実在し、クリーンPC相当で通る。
- 画面の全選択値がstateと実出力へ一致する。未実装選択肢は0。
- クリップ全失敗、部分失敗、破損state、再起動で成功表示しない。
- 外部送信先、送信データ、保存場所、料金条件の表示が実処理と一致する。
- 非信頼文字起こしからローカルファイル、環境変数、ツールを参照できない。
- localhost APIは認可、Origin/Host、サイズ、形式、rate、TTLの各ゲートを持つ。
- `npm audit` のHigh/Criticalが0、または到達不能性と受容判断が記録されている。
- 375pxから1920pxまで重なりと横切れがなく、キーボードのみで完遂できる。
- 主要テスト、配布契約テスト、セキュリティ回帰がすべてEXIT 0。

## 10. 判定

**現行CLI配布: FAIL / 公開ZIP差し替えまでリリース停止。**

**ローカルWeb版: FAIL / 実験用途に限定し、配布対象へ戻さない。**

正常系の純粋関数と縦型レンダリングには動作実績がある。一方、購入者が触る配布物、失敗時の停止、設定の契約、データ送信説明、localhost境界が弱い。優先すべきは新機能ではなく、配布物の正本化と「失敗を成功と呼ばない」機械ゲートである。
