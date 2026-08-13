# 2026-08-13 セキュリティ徹底監査

対象: `video-shorts`（AI-Editer）STAGE-1 全体。前回監査
（`docs/audits/2026-07-27-kosespark-test-review-proposal.md`）以降に追加された編集系機能
（字幕手直しAPI・用語辞書・焼き直し・AI字幕校正・トリム・リフレーム・顔モザイク）を含む最新コードに対して実施。

実施方法: 3体の調査サブエージェント（HTTPサーバ層／コマンド実行・メディア処理層／秘密情報・AI連携・テスト基盤）
による並列調査 → 発見の実コード裏取り → 深刻度が高・中の発見について実機PoCで再現確認。

## 脅威モデル

現行 STAGE-1 は「1台のPCで動くローカルツール」。想定する攻撃者は次の3者。

1. **同一PC上の悪意あるWebページ**（ブラウザで開いただけ）— CSRF / DNS rebinding / トークン窃取
2. **同一PC上の別プロセス・別ユーザー** — `127.0.0.1` へ直接到達できる。トークン・成果物の横取り
3. **入力データそのもの**（動画・音声・文字起こし・字幕・LLM出力）— プロンプトインジェクション、
   ffmpeg filtergraph injection、ASS制御文字、パス注入

STAGE-2（ブラウザ公開）は `frozen` のため、そこで初めて効く問題は将来の葉として言及するに留め、今回は直さない。

## 発見一覧

深刻度は上記脅威モデル基準。「PoC」欄は実機で再現確認した方法。

### 高

#### H-1: JSONボディにサイズ上限が無い
- 位置: `server/index.mjs:133-140`（`readBody`）、使用箇所 `:516`（PUT captions）、`:548`（POST terms）
- 内容: `Content-Length` も累積受信バイト数も見ずに、リクエストボディを無制限にメモリへ連結する。
- **PoC実施・再現確認済み**: 実サーバを起動し `POST /api/jobs` で正規のジョブを作成、発行された `jobToken` で
  `PUT /api/jobs/:id/captions` へ80MB(83,886,101バイト)のJSONボディを送信。413等の拒否は一切発生せず、
  サーバは全量を受信・バッファしてから（トランスクリプト未生成のため）404を返した。アップロード専用の
  `MAX_UPLOAD_BYTES`(500MB, `security.mjs:105`)はマルチパート系のみに効き、JSON系エンドポイントには
  一切効かないことを確認した。

#### H-2: 焼き直しAPIが同時実行ゲート・レート制限・クォータを全て素通りする
- 位置: `server/index.mjs:571-587`（`handleRecaption`）、`pipeline-runner.mjs:260`（`concurrencyGate`）、
  `src/recaption-stage.mjs:78`（一時ファイル名）
- 内容: `handleRecaption` は `isRunning(id)`（パイプライン本編が実行中か）しか見ず、`recaptionStage` を
  直接 await する。`concurrencyGate`(`pipeline-runner.mjs:318`)は `startJob` の `exec()` にのみ適用され、
  `handleRecaption` には一切配線されていない。
- **確認方法**: コードレビューで実証。`recaptionStage` は1本のジョブにつき固定のファイル名
  `${outDir}/${c.file}.recaption-tmp.mp4`（`recaption-stage.mjs:78`）を使うため、同一ジョブへ2つの
  焼き直しリクエストを同時に送ると、両方の `recaptionStage()` 呼び出しが同じ一時ファイルへ競合して
  書き込む（レース）。さらに `handlePostJobs` が課すレート制限・クォータ・同時実行数上限のいずれも
  効かないため、`recaption` エンドポイントへの連打で ffmpeg プロセスを無制限に spawn できる。
  実機での完全な連打再現は正規パイプライン完走（実文字起こし込み）が前提となるため、Phase 3 の E2E
  テスト（`security-recaption-flood-check.mjs`）で完全自動化された形の再現に置き換える。

#### H-3: APIキー漏洩の導管が構造的に開いている
- 位置: `pipeline-runner.mjs:143-179`（`spawnAndLog`）、`:287-313`（エラーハンドラ）、`:381`（transcribe呼び出し）
- 内容: `spawnAndLog` は子プロセスへ `env: process.env` を丸ごと渡す（`GROQ_API_KEY`・`ANTHROPIC_API_KEY`を含む）。
  子のstderrは1行ずつ即座にSSEへbroadcastされ、異常終了時はstderr先頭400バイトが `Error.message` に
  載り、**SSEとディスク上の `work/<id>/state.json` の両方**へ永続化される。
- 確認方法: コードレビューで実証。現状Python側（`transcribe_groq.py`, `check-groq-key.py`）は例外の型と
  文字列のみを出力し鍵を出さないことを確認したが、「出さない」ことを守る機械検査は存在しない。将来
  Python側やGroq/faster-whisperのSDKが例外に鍵を含めるよう変わった場合、無検査でSSE・ディスクへ
  漏れる導管が現存する。Phase 3の `security-secret-redaction-check.mjs` で、鍵をわざとstderrへ出す
  偽pythonを差して「漏れないこと」を対照実験付きで機械検証する。

#### H-4: 共有 `/tmp` に予測可能な名前の一時ファイルを作り、symlinkを追う
- 位置: `src/concat.mjs:31,36,38`
- **PoC実施・再現確認済み**: `vs-concat-${process.pid}-${clips.length}.txt` というファイル名は
  プロセスIDとクリップ本数だけで決まる。攻撃者役として、実行前にこのパスへ被害者ファイルを指す
  symlinkを設置した状態で `concatClips([c1, c2], outPath)` を呼んだところ、被害者ファイルの内容が
  `fs.writeFileSync` によって完全に上書きされたことを確認した（元の内容
  `"ORIGINAL CONTENT - should not be overwritten"` が `file '/tmp/clip1-...'\nfile '/tmp/clip2-...'` に
  置き換わった）。同一PC上の別プロセス・別ユーザーが `/tmp` に書き込める環境では、
  video-shorts実行ユーザー権限での任意ファイル上書きが成立する。

### 中

#### M-1: 静的配信にHost/Origin検査が無く、起動時トークンが無認証で取得できる
- 位置: `server/index.mjs:595-599`（`/api/`のみに検査を限定）、`:173-182`（トークン注入）
- **PoC実施・再現確認済み**: 実サーバへ `Host: evil.example.com` を付けて `GET /` を送信したところ、
  ステータス200・本文に `window.__AI_EDITOR_TOKEN__` として実際の起動時トークンがそのまま埋め込まれて
  返ってきたことを確認した（返送されたトークンと実際の起動時トークンの一致まで確認済み）。同一PC上の
  任意プロセスが `curl` 一発で起動時トークンを取得できる状態にある。

#### M-2: セキュリティヘッダが皆無
- 位置: `server/` 全体
- 確認方法: `grep -rn "Content-Security-Policy\|X-Content-Type-Options\|X-Frame-Options\|Referrer-Policy" server/` が0件であることを確認。
  CSP・nosniff・X-Frame-Options・Referrer-Policyがサーバ・HTMLとも一切設定されていない。
  クライアント側の `esc()` エスケープが一箇所でも崩れれば、多層防御なしに即トークン奪取へ直結する。

#### M-3: ジョブトークンが平文でディスクに永続化される
- 位置: `server/security.mjs:72-75`
- 内容: `work/<id>/job-token.txt` に平文で書き込まれ、TTL(既定24時間)まで残る。`work/` を読める
  ローカルプロセスは全ジョブの成果物へアクセスできる。コードを読んで確認済み（PoC省略、実装が明示的）。

#### M-4: レート制限が `"global"` 固定キー・`/api/jobs` のみに適用
- 位置: `server/index.mjs:63,212`
- 内容: `jobsRateLimiter.allow("global")` はバケットが1つのみ。他6エンドポイント(SSE・candidates・
  captions・terms・recaption・clips)には一切レート制限が無い。誰か1人が10req/60sを消費すると、
  正規利用者の投稿も429になる。コードレビューで確認済み。

#### M-5: 1ジョブのトークンで全ジョブ共有の用語辞書へ書き込める
- 位置: `server/index.mjs:559-562`, `src/term-dictionary.mjs:115-127`
- 内容: `POST /api/jobs/:id/terms` は全ジョブ共有の `src/term-corrections.json` へ単純文字列置換を
  永続的に追記する。件数上限は無い。ソースコード中のコメント(`index.mjs:554-558`)に「2026-08-09の
  マスター決定により意図的な設計」と明記されているため、今回は「直す」ではなく「基準を明文化し、
  上限だけ追加する」方向で扱う（Phase 2で判断）。

#### M-6: `docs/key-management-policy.md` が主張する「三重ガード」のうち2つが実在しない
- 位置: `docs/key-management-policy.md:22`
- **PoC実施・再現確認済み**: `secret-write-gate.mjs` を `find . -iname "*secret-write*"` で検索した
  ところ、リポジトリ全体で0件（実在しない）。`.claude/settings.json` の中身を確認したところ
  `hooks`(Stop/SessionStart)のみで、`permissions.deny` ブロックは存在しない。実在するのは
  ルート`.gitignore`の1枚のみ。ドキュメントは「三重ガード」と主張しているが実態は「一重」である。

#### M-7: SSEのジョブトークンがURLクエリに出る
- 位置: `server/security.mjs:34`, `webapp-mockup/app.js:23-28`
- 内容: `EventSource` がカスタムヘッダを付けられない制約に由来する構造的な設計。アクセスログ・
  ブラウザ履歴・Refererにジョブトークンが残る。コードレビューで確認済み。

#### M-8: AIの隔離作業場所が共有 `/tmp` の予測可能なパス
- 位置: `src/claude-safety.mjs:43-47`（`createIsolatedCwd`）
- **PoC実施・再現確認済み**: 親ディレクトリ `os.tmpdir()/video-shorts-claude-cwd` が固定名であることを
  利用し、実行前にそのパスへ攻撃者制御ディレクトリを指すsymlinkを設置した状態で
  `createIsolatedCwd("victim-job-123")` を呼んだところ、返されたパスの実体(`fs.realpathSync`)が
  攻撃者制御ディレクトリ配下(`/tmp/attacker-target-xxx/victim-job-123`)を指していることを確認した。
  **これは done 済みの葉 `P1-1-C`（AIの作業場所を隔離する）が主張する「他のお客様のファイルに触れない」
  という保証を、同一PC上の別プロセス・別ユーザーが崩せることを意味する。** 既存 criteria の凍結解除は
  せず、新しい葉として起票する（下記 Phase 2 方針）。

### 低（起票するが、優先度は次点）

| ID | 内容 | 位置 |
|---|---|---|
| L-1 | 静的配信・クリップ配信が`realpath`未解決でsymlinkを追う（現状リンクは0件） | `server/index.mjs:157-166,408-413` |
| L-2 | `path.extname(name)`が未サニタイズのままパスへ連結（traversalは現状不成立） | `server/index.mjs:252` |
| L-3 | `Accept-Ranges: bytes`を返しながらRangeを処理しない | `server/index.mjs:414-420` |
| L-4 | `headersTimeout`/`requestTimeout`未設定 | `server/index.mjs:698-709` |
| L-5 | `jobs` Map・SSE購読者Setに上限が無い | `pipeline-runner.mjs:26,88` |
| L-6 | `isAllowedHost`が`:port`必須のためPORT=80運用で全API 401 | `server/security.mjs:92-95` |
| L-7 | テスト固定ポート59196が2ファイルで重複 | `tests/smoke.mjs:999`, `tests/caption-recaption-ocr-check.mjs:60` |
| L-8 | `G-TESTINFRA-ESCAPEPATH-B`がdoing・evidence空のまま | `docs/roadmap.html` |
| L-9 | 開発用計測ツールの`execSync`テンプレート補間（到達不能・配布物対象外） | `webapp-mockup/measure.mjs:381` |
| L-10 | `gsap.min.js`同梱の取得元・版・チェックサム記録が無い | `webapp-mockup/vendor/gsap.min.js` |

## 適切に防御されていることを確認した項目（回帰テストで固定する）

- パストラバーサル対策（`..`／絶対パス／URLエンコード／二重エンコード／兄弟ディレクトリ）— `safeId`/`safeFile`/`serveStatic`のprefix検査
- `timingSafeEqual`によるトークン比較
- アップロードサイズ上限とmagic byte検証（チャンクまたぎ対応）
- クロスオリジンCSRF対策（Origin検査＋秘密トークン）
- クライアント側XSSエスケープ（`webapp-mockup/app.js`の`esc()`）
- `shell: true`/`shell=True`が`src/`・`server/`に0件
- `claude`起動口が`src/claude-run.mjs`ちょうど1箇所であることのソース走査検査
- `--tools ""` + `--strict-mcp-config` + env allowlist + tmpdir cwd の多層防御（cwdの予測可能性を除く。M-8参照）
- `escAss`によるASSオーバーライドタグ封じ、`clipName`によるLLM出力のファイル名サニタイズ
- ffmpegフィルタ文字列にユーザー由来の値が直接入る経路が無い（`apply-effect.mjs`の3プリセットは固定文字列、パスは`escapeFilterPath`が2段エスケープ）
- SSRFなし（外向き通信は`api.anthropic.com`とGroqのみ、URL固定）
- TLS検証を無効化している箇所が0件
- `127.0.0.1`バインド

## 対応方針・実施結果

`docs/roadmap.html` の `G-P1` 配下へ `P1-13`〜`P1-19` を原子分解して起票し、criteria/verifyを凍結した。
凍結前に `basis-reviewer` サブエージェントによる敵対的レビューを受け、当初案にあった原子性違反（複数の
独立した受入事実を1葉にまとめていた箇所）と網羅性不足（M-2の一部・M-4がどの葉にも起票されていなかった
点）の反証を受けて構成を是正した。最終的に P1-13〜P1-18 の24葉（`doing`）と P1-19 の4葉（`todo`・backlog）
を追加した。M-8は既存の`P1-1-C`のcriteria/verify本文は書き換えず、新しい葉(`P1-18-B`)として起票し、
`P1-1-C`のdetailへ参照を追記した。

M-5（用語辞書の上限）・M-7（SSEトークンのURL露出）・L-3（Range未対応）・L-6（PORT=80での認可破綻）は
UX・互換性とのトレードオフを伴う設計判断が必要なため、`P1-19`としてbacklog化し今回のスコープには
含めなかった。

高・中の全項目（H-1〜H-4、M-1〜M-4、M-6、M-8）について実装で修正し、対応するセキュリティE2Eテスト
（`video-shorts/tests/security-*-check.mjs`、全12ファイル）を新設した。各テストは、実装前(H-1は
`readBody`の上限チェックを一時的に無効化、H-4/M-8は本物のsymlink先回り攻撃を実際に再現)の状態に対して
確実にFAILし、修正後の実装に対してPASSすることを確認済み（"probed"探り）。既存の48本の回帰テスト
（`pnpm --filter video-shorts test`）にも新規テストを追記し、全体が緑であることを確認した。

M-3（ジョブトークンの平文永続化）はハッシュ保存へ変更し、既存テスト4本（`caption-api-check.mjs`・
`restart-reconnect-check.mjs`・`caption-recaption-ocr-check.mjs`・`recaption-human-vs-ai-check.mjs`・
`smoke.mjs`）の素材準備コードも新しい契約に合わせて更新した。L-7（テスト固定ポート59196の重複）も
`caption-recaption-ocr-check.mjs`側を59208へ変更して解消した。
