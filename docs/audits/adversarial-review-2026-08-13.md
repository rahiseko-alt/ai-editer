# AI-Editer 敵対的コードレビュー報告書

- 対象リポジトリ: `rahiseko-alt/ai-editer`
- 対象コミット: `f0ef1a955832687adc1311aa0d7cbb6e8804139d`
- 実施日: 2026-08-13
- 実施方法: 独立した3エージェントを2巡使用し、主担当がコード経路と最小PoCを再検証
- 変更範囲: 本報告書のみ。製品コード、テスト、ロードマップは変更していない

## 結論

新規のリリース阻害事項を P1 14件、P2 10件確認した。特に、成果物ディレクトリ外へのファイル操作、配布物への未追跡ファイル混入、秘密情報の伏字漏れ、字幕再焼き直しによる編集消失、Windows日本語パスでのモザイク全面停止は、出荷前に解消すべきである。

重大度は次の意味で使用する。

- P0: 即時停止が必要な致命的問題
- P1: リリースを止めるべき高重大度問題
- P2: リリース前または直後に修正すべき問題

## P1: リリース阻害事項

### 1. candidates manifestから成果物境界外を上書き・移動できる

`candidates.json`の`file`を検証せず、`path.join()`した値を読み取り、出力、`rename()`へ使用している。`../../...`を含むmanifestにより、recaptionでは成果物外の既存ファイルをMP4で置換でき、mosaicでは境界外ファイルの読み取り・移動が可能になる。

- 該当: `video-shorts/src/recaption-stage.mjs:59-101`
- 該当: `video-shorts/src/apply-mosaic-stage.mjs:83-97,129-135`
- 修正案: basename限定、拡張子固定、絶対パスと区切り文字の拒否、解決後パスのcontainment検査、I/O直前の再検査

### 2. 字幕再焼き直しでトリム編集と出力条件が失われる

初回renderは`snapStart`、`keep`、fps、sample rate、解像度ガードを使うが、manifestには元の`start/end/duration`しか保存しない。recaptionは元区間をそのまま再renderし、production stateに存在しない`srcW/srcH`も参照する。

4秒入力を1秒へ詰めた再現ケースで、recaption後の動画が4.000秒へ戻ることを確認した。

- 該当: `video-shorts/pipeline.mjs:218-245,366-379`
- 該当: `video-shorts/src/recaption-stage.mjs:53-86`
- 修正案: 確定したrender planとcanvasをmanifestへ永続化し、初回とrecaptionで同じrender関数・同じ計画を使用する

### 3. 実行中または待機中のrecaptionをTTL掃除が削除できる

`activeJobIds()`は通常ジョブの`RUNNING_STAGES`だけを返し、別Setの`recaptioningJobs`を含めない。TTL境界を越えたジョブの字幕を再焼き直し中、毎時sweepがwork/outputを削除できる。共有実行ゲートで待機している間も同様である。

- 該当: `video-shorts/server/pipeline-runner.mjs:68-73,298-318`
- 該当: `video-shorts/server/index.mjs:83-95`
- 修正案: 通常ジョブとrecaptionの実行中・待機中IDを保護集合へ統合し、sweep側でもleaseを確認する

### 4. 配布allowlistが未追跡ファイルを製品ZIPへ混入させる

`src/`、`tests/`、`skill/`をディレクトリ単位で再帰コピーするため、除外regexに当たらない未追跡ファイルもdistへ入る。未追跡の`src/customer-secret.txt`がdistへコピーされることを再現した。現在の検査は侵入ファイルを出力先distにだけ置くため、この経路を検出しない。

- 該当: `video-shorts/build-dist.mjs:76-95,107-118`
- 該当: `video-shorts/tests/dist-slim-check.mjs:139-172`
- 修正案: `git ls-files`またはファイル単位manifestから生成し、未追跡ファイルとsymlinkをfail closedにする

### 5. 秘密情報の伏字がストリームのチャンク境界で破れる

stdout/stderrをチャンク単位で`redactSecrets()`へ渡した後に結合する。APIキーが2チャンクへ分割されると、どちらにも完全一致せず、結合後に元の鍵が復元される。そのエラー文字列はSSEと`state.json`へ流れ得る。複数の分割位置で漏洩を再現した。

- 該当: `video-shorts/server/pipeline-runner.mjs:176-214,356-382`
- 該当: `video-shorts/tests/security-secret-redaction-check.mjs:46-53`
- 修正案: 最大秘密長マイナス1のtailを保持するstreaming redactorを使い、永続化・broadcast直前にも再度伏字化する

### 6. モザイク確定がクラッシュセーフではない

元動画をstashへ移動した後、呼び出し側が`candidates.json`を直接truncate上書きする。移動後からmanifest更新前に停止すると旧manifestは存在しないファイルを指す。書き込み途中の停止ではJSON自体が壊れる。

- 該当: `video-shorts/src/apply-mosaic-stage.mjs:120-160`
- 該当: `video-shorts/server/pipeline-runner.mjs:560-569`
- 修正案: atomic JSON writeに加え、版付き成果物、journal、単一current pointerによるrecoverable commitを採用する

### 7. 公開ユーザーマニュアルの手順では処理を完走できない

公開マニュアルは`pipeline init`を実行せずに`select`へ進むため、`state.json がありません`で終了する。また、配布対象外の`ui/index.html`を開くよう案内している。

- 該当: `video-shorts/install/user-manual.html:70-88,106`
- 該当: `video-shorts/pipeline.mjs:55-58,135-139`
- 該当: `video-shorts/build-dist.mjs:7-8`
- 修正案: 正本SKILLと手順を同期し、展開済みdistだけを使う利用手順E2Eを追加する

### 8. Windowsの日本語設置パスで顔モザイクが起動できない

Windows版OpenCVのONNX path APIへ日本語を含む絶対パスを直接渡している。対象モデルが存在し、サイズも正しい状態で`FaceDetectorYN.create()`が`Can't read ONNX file`となることを再現した。同じモデルをASCIIパスへコピーすると成功する。

- 該当: `video-shorts/src/face_mosaic.py:110-118,142-149,165-170`
- 修正案: モデルをASCII限定の安全なcacheへbyte copyしてロードし、画像は`np.fromfile`と`cv2.imdecode`で読む

### 9. HDR/10-bit入力をWeb・SNS互換形式へ変換していない

render出力に`-pix_fmt yuv420p`がなく、HDRからSDRへのtone mappingとBT.709変換もない。10-bit/BT.2020入力を通すと、出力も`High 10`、`yuv420p10le`、BT.2020のままになることを再現した。配信先によって再生拒否、暗部沈み、色化けが発生し得る。

- 該当: `video-shorts/src/render-vertical.mjs:141-151`
- 修正案: SDR納品なら`zscale`と`tonemap`を用いてBT.709/yuv420pへ変換する。HDR維持なら別のcodec/profile契約として扱う

### 10. SSEの初期イベントと再接続契約が壊れている

`startJob()`はPOST応答前に初期進捗や順番待ちをbroadcastできるが、UIがEventSourceを作るのは応答後である。またUIはサーバーの業務エラーとEventSourceのtransport errorを同じ`error`リスナーで扱い、常に`es.close()`するため自動再接続しない。イベントID、再送、購読時snapshotもない。

- 該当: `video-shorts/webapp-mockup/app.js:407-454`
- 該当: `video-shorts/server/pipeline-runner.mjs:32-52,87-108,389-398`
- 該当: `video-shorts/server/index.mjs:388-440`
- 修正案: 業務エラーを別イベント名へ分離し、transport errorではcloseしない。購読直後snapshotまたはevent IDと再送bufferを実装する

### 11. キャンセルAPIとメディア工程のdeadlineがない

`spawnAndLog`、ffmpeg、ffprobe、ローカル文字起こしに工程別タイムアウトがなく、SSE切断は購読解除だけで子プロセスを止めない。キャンセルrouteも存在しない。1個の子プロセス停止で実行枠が恒久占有され、local経路では後続全ジョブが待機する。

- 該当: `video-shorts/server/pipeline-runner.mjs:176-214,338-400,420-579`
- 該当: `video-shorts/src/render-vertical.mjs:184-260`
- 該当: `video-shorts/server/index.mjs:707-799`
- 修正案: job単位AbortController、child registry、キャンセルAPI、工程別deadline、process-tree停止、`cancelled/timeout`終端stateを追加する

### 12. 字幕保存と焼き直しが競合し、双方200でも動画が古い字幕になる

recaptionは開始時に字幕編集を一度だけsnapshotする。その後もPUT `/captions`を受理するため、新しい字幕の保存に成功しても進行中の動画は古いsnapshotで生成される。UIも字幕保存Promiseを待たずに焼き直しを開始できる。

- 該当: `video-shorts/src/recaption-stage.mjs:53-88`
- 該当: `video-shorts/server/index.mjs:588-619,650-675`
- 該当: `video-shorts/webapp-mockup/app.js:595-623,650-658`
- 修正案: 字幕revisionを導入してrecaption終了時にCAS確認する。簡易策はrecaption中のPUT拒否とUIロック

### 13. 主導線の動画アップロードがキーボードから到達不能

可視のアップロード領域はフォーカス不能な`label`で、紐づくfile inputには`hidden`がある。ChromeのTab順とaccessibility treeに主操作が現れず、キーボード利用者は動画選択を開始できない。

- 該当: `video-shorts/webapp-mockup/index.html:38-42`
- 該当: `video-shorts/webapp-mockup/styles-cards.css:70-90`
- 修正案: 可視のbutton/inputを主操作にするか、labelへ適切なrole、tabindex、Enter/Space処理を実装する

### 14. 閲覧できない契約書への包括同意を要求している

同意画面は「AI顧問契約書 第10版の内容を確認し、同意」と要求するが、確定本文またはリンクがない。リポジトリ内の候補文書も「客向け・素案」「要マスター確定」と明記されている。

- 該当: `video-shorts/install/consent.html:18-19,68`
- 該当: `docs/terms-and-liability.md:1-3`
- 修正案: 確定した版番号付き契約書を表示またはリンクし、そのhashをreceiptへ含める。取得不能時は同意操作を無効にする

## P2: 修正が必要な事項

### 15. 再起動時にディスクstateを無視し、完了済みジョブもinterruptedになる

メモリのjobs Mapに無い場合、`state.json`を読まず一律`interrupted`を生成する。doneもメモリだけで永続化しない。さらに親が古いstateオブジェクトを書き戻して子プロセスが追加したフィールドを消す経路がある。

- 該当: `video-shorts/server/pipeline-runner.mjs:87-105,529-531,548-549,577-579`
- 修正案: state遷移を一箇所へ集約し、毎回read-merge-atomic-writeする。done/errorを永続化して再接続時に復元する

### 16. PCなしクラウド利用用フックが配布物に含まれない

`start-here.md`は`.claude/hooks/session-start.sh`が自動導入済みと説明するが、配布allowlistに`.claude`がない。フック自体もリポジトリ配置の`video-shorts/requirements.txt`を前提とし、dist直下の配置と一致しない。CIは完全なcheckout上でだけフックを検査する。

- 該当: `video-shorts/start-here.md:6`
- 該当: `video-shorts/build-dist.mjs:107-118`
- 該当: `.claude/hooks/session-start.sh:47`
- 該当: `.github/workflows/ci.yml:173-197`

### 17. Windowsを対象にしながら品質ゲートがWindowsで実行不能

package scriptはPython検査を`python3`固定で起動する。Windowsでは`python`が利用可能でも`python3`が失敗する。またstate atomic検査がWindows絶対パスを生のESM importへ埋め込み、`ERR_UNSUPPORTED_ESM_URL_SCHEME`になる。実測は2 PASS / 1 FAILで、CIはUbuntuだけである。

- 該当: `video-shorts/package.json:5`
- 該当: `video-shorts/tests/state-atomic-write-check.mjs:83-86`
- 該当: `.github/workflows/ci.yml:13,125-127,173-175,202-206`

### 18. 外部ツール版固定検査が必須workflowを見落とす

`roadmap-required.yml`はffmpegを版指定なしでapt installするが、固定検査は`ci.yml`と`measure-leak-rate.yml`しか走査しない。この不整合がある状態で検査は20 PASSとなった。

- 該当: `.github/workflows/roadmap-required.yml:68-75`
- 該当: `video-shorts/tests/external-tool-version-pin-check.mjs:62-79`
- 修正案: 全workflowを再帰走査し、apt/pip/npxの無指定導入を拒否する

### 19. 実行待ちqueueとjobs Mapに上限・回収がない

queueは待ち件数の上限がなく、終了済みjobsもMapから削除されない。レート制限内で継続投入されるとclosure、購読状態、ジョブディレクトリが蓄積する。

- 該当: `video-shorts/server/pipeline-runner.mjs:27-30,273-292,384-399`
- 修正案: queue上限、待機TTL、cancel、terminal job回収、接続数とジョブ総数の上限を追加する

### 20. 非正方形SAR素材を横につぶす

probeはsample/display aspect ratioを取得せず、coded width/heightだけでfitした後`setsar=1`にする。display 16:9の720x480/SAR 32:27素材をlandscapeへrenderすると、人物や文字が横圧縮され左右に不要な黒帯が付く。

- 該当: `video-shorts/src/render-vertical.mjs:123-126,207-234`
- 修正案: SAR/DARをprobeし、display pixel寸法へ正規化してからfit/padする

### 21. 低解像度canvasでも字幕トークンが固定で画面外へ切れる

拡大ガードはcanvasを360x640などへ縮めるが、font size、outline、marginは1080x1920向け固定値のままである。360x640、bold、20字の単一wordをrenderしたPoCでは字幕pixelが左右端へ接触しclipした。

- 該当: `video-shorts/src/subtitle-styles.mjs:11-45`
- 該当: `video-shorts/src/srt-builder.mjs:86-100,152-169`
- 修正案: 全style tokenをcanvas比でscaleし、grapheme/display width単位で長いtokenを分割する

### 22. 「編集できません」ダイアログがフォーカスを取得しない

no-speech等で表示されるカードは見た目がダイアログだが、既存のfocus trapへ接続されず、`aria-modal`もない。焦点は背面に残り、理由や再選択ボタンへ確実に到達できない。

- 該当: `video-shorts/webapp-mockup/index.html:281-298`
- 該当: `video-shorts/webapp-mockup/app.js:348-367`

### 23. 結果タブの表示とARIA状態が矛盾する

タブクリック時にpanelと`.is-on`だけを切り替え、`aria-selected`を更新しない。「使わない候補」を表示しても読み上げでは「採用候補」が選択されたままになる。Arrow/Home/Endとroving tabindexもない。

- 該当: `video-shorts/webapp-mockup/index.html:199-203`
- 該当: `video-shorts/webapp-mockup/app.js:265-271`

### 24. SSEがバックプレッシャを無視する

`res.write()`のfalseを無視し、子stdout/stderrの各行を全購読者へ送り続ける。遅い購読者のresponse bufferへログが蓄積し、複数購読でメモリ消費が増幅する。

- 該当: `video-shorts/server/index.mjs:417-440`
- 該当: `video-shorts/server/pipeline-runner.mjs:32-45,176-200`
- 修正案: `drain`まで送信を止め、進捗をcoalesceし、ログを上限付きring bufferにする

## 補足所見

### 同意完了後のフォーカスと通知

Chrome実測で同意完了後の`activeElement`がBODYへ落ちた。receiptはrole/aria-liveを持たず、hidden状態の長文へ先に値を入れてから表示するため、読み上げ利用者へ完了を確実に通知できない。

- 該当: `video-shorts/install/consent.js:114-125`
- 該当: `video-shorts/install/consent.html:76-89`

### 無音声素材でtrim filterが存在しない音声streamを参照する

無音声動画に`keep`を渡して`renderClip()`を実行すると、filtergraphが`[0:a]`を参照してffmpegが失敗することを再現した。通常の自動処理では先にno-speech判定されるためP1には数えていないが、render関数単体の契約としては不整合である。

- 該当: `video-shorts/src/trim-plan.mjs:339-371`
- 該当: `video-shorts/src/render-vertical.mjs:120-140`

### partial render failureをUIが成功として扱う

一部区間だけrenderに失敗しても`candidates.json.incomplete`へ反映されるのはselect段の失敗だけであり、runnerはdoneをbroadcastする。UIは生成本数が減った理由を示せない。

- 該当: `video-shorts/pipeline.mjs:387-428`
- 該当: `video-shorts/server/pipeline-runner.mjs:577-579`

### digest最終成果物をWeb UIが使用しない

candidates APIは`digest`を返すが、UIは`data.candidates`だけを`fillResults()`へ渡し、連結済みdigestを表示しない。

- 該当: `video-shorts/webapp-mockup/app.js:428-435`

### 同一端末プロセスに対する起動tokenの信頼境界

localhost Hostを名乗れる同一端末プロセスは静的indexから起動tokenを取得できる。これはブラウザのcross-origin対策とは別の設計問題であり、同一端末プロセスまで敵対者に含める場合は、OS ACLで保護した資格情報、IPC、または明示pairingが必要になる。

- 該当: `video-shorts/server/index.mjs:232-241,701-704`
- 該当: `video-shorts/server/security.mjs:100-105`

## 既知項目として新規件数から除外したもの

- VFR素材の非ゼロ開始で実フレームPTSと音声開始がずれる問題。PoCでは100ms差が出たが、`docs/roadmap.html`のE-3に既知事項として明記済み
- topic選定およびAI字幕補正でも文字起こしがClaudeへ送られる一方、同意説明がdigest送信だけを強調する問題。既存の外部送信・同意課題P0-6として扱われているため新規件数には含めない
- 既存backlogのM-5、M-7、L-3、L-6

## 実施した裏取り

- `node video-shorts/tests/smoke.mjs`: 97 PASS / 0 FAIL
- `pnpm audit --audit-level moderate`: 既知脆弱性なし
- `node video-shorts/tests/external-tool-version-pin-check.mjs`: 20 PASS。ただし未固定workflowを見落とす偽緑を確認
- `node video-shorts/tests/state-atomic-write-check.mjs`: Windowsで2 PASS / 1 FAIL
- 未追跡ファイルを入力元`src/`へ置くdist混入PoC: 再現
- APIキーを複数位置でチャンク分割する伏字PoC: 再現
- trim済みclipのrecaption duration PoC: 4.000秒へ復元
- 無音声動画とtrim filterの実ffmpeg実行: `[0:a]`不在で失敗
- 日本語絶対パスからOpenCV ONNXロード: 失敗。ASCIIパスでは成功
- 10-bit/BT.2020素材の実render: High 10/yuv420p10le出力を確認
- SAR、低解像度字幕、VFR非ゼロ開始: 実メディアPoCで確認
- ChromeでuploadのTab到達性、ダイアログfocus、ARIA tab、同意完了focusを確認
- 追跡対象の作業ツリーに製品コード変更なし

## 推奨修正順序

1. manifest path境界、配布manifest、秘密伏字の3件を先に修正する
2. render plan永続化、recaption/字幕revision、TTL保護、mosaic transactionをまとめて状態整合性として修正する
3. Windows日本語パス、HDR、SAR、低解像度字幕を実メディアfixture付きで修正する
4. SSE snapshot/reconnect、キャンセル、deadline、backpressureを一つのjob lifecycle設計として修正する
5. 公開マニュアル、配布フック、同意画面、契約書、キーボード操作をdist E2Eで固定する
6. UbuntuとWindowsのCI matrixを必須gateへ追加する
