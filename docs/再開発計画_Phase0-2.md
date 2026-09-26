# 再開発計画 Phase 0〜2（承認待ち）

作成: 2026-09-26 / 入力: 「AI Editor 再開発計画提案書」（2026-09-26）
位置づけ: 提案書 §10 の「最初のセッションでやること」1〜5 の成果物。**このファイルに書いた変更は、まだ1行も実装していない。**
マスターの承認後に Phase 0 から着手する。

読んだもの: `CLAUDE.md` → `AGENTS.md` → `docs/handoff.md` → `docs/編集についての虎の巻.md` → `docs/合格条件.md` → 提案書。
加えて `video-shorts/src/`・`server/` の実コードと、`browser-use/video-use`（HEAD `b877063`）の `SKILL.md` と `helpers/*.py`。

---

## 1. 現行の処理経路（実コードから）

```
[UI] ui/app.js ──POST──▶ server/job-submit.mjs ──append──▶ .runtime/chat-inbox.jsonl
                                                               │ 0.5秒ごとに読み直す
                                                               ▼
                                         server/job-worker.mjs（直列キュー。prepare だけ起動）
                                                               │ spawn
                                                               ▼
 edit-job.mjs prepare <jobId>                                    (edit-job.mjs:849-908)
   1 transcribe.py（Groq があれば Groq、無ければ Whisper）→ work/<id>/transcript.json
   2 ai-caption-fix.mjs：claude -p で誤字修正（失敗しても続行）→ transcript.json を書き換え
   3 detectSilences：ffmpeg silencedetect=-30dB:d=0.15   → silences.json
   4 groupIntoPhrases：BudouX 文節化＋無音0.3秒以上で分割 → units.json（{i,start,end,w}）
   ★ここで自動処理は止まる。results.jsonl には何も書かない
                                                               │
 server/watch-jobs.mjs（Monitor で常駐）が units.json 出現を「選定待ち」として知らせる
                                                               ▼
 セッション本人が units.json を全文読む → work/<id>/keep.json を手で書く
   {"keep":[[開始文節,終了文節],...], "applied":[...], "notApplied":[...]}
                                                               ▼
 edit-job.mjs render <jobId>                                     (edit-job.mjs:916-1015)
   a keep の文節番号 → units の start/end に変換（ここは決定論的。AI は時刻を書かない）
   b snapRanges：実測無音へ寄せる（前後の捨てた文節は越えない）      (:427-471)
   c planFillerCuts + subtractCuts：母音性フィラーを区間から抜く     (filler-cut.mjs)
   d decision.json を書く
   e buildAssFile：字幕 ASS（BudouX 文節で2行以内に詰める）          (:715-761)
   f renderFinal：1本の filter_complex（trim/atrim/afade20ms/concat
      → 縦型なら letterbox → subtitles）で1回だけエンコード          (:788-834)
   g results.jsonl に done を追記 → UI の SSE（server/job-events.mjs）が完了を拾う
```

UI が「処理中のまま止まる」のは、prepare 完了から render 完了までの間、UI が知る手段が
`results.jsonl` しかないため（`job-events.mjs` は結果行の有無しか見ない）。

---

## 2. 既知不具合と該当箇所

| 不具合（handoff ②③） | 該当コード | 今回わかったこと |
|---|---|---|
| **特定区間の音声が欠落し、別の文言になる**（「きれいに切り分けてくれちゃうんです」→「切ります」） | `renderFinal`（`edit-job.mjs:788-834`）と、その手前の `subtractCuts`（`filler-cut.mjs:131-152`） | 下の 2-1 参照。**合成素材では再現しなかった。** 原因候補は2つに絞れた（どちらも【曖昧】＝実素材で未確認） |
| 無音スナップが語の途中で切る | `snapToSilence` / `isInsideAnyWord`（`:256-285`） | 文節単位の判定に直し済み（2026-08-19〜20）。ただし**フィラー除去は今も部分語（1文字）単位で判定している**＝同じ根本原因が残っている（2-1 候補A） |
| `reframe.py` が Windows で WinError 206 | `reframe.py:139-163 _crop_x_expr` | フレーム数ぶんの `if(eq(n,…))` を入れ子にした式を `-vf` に渡している。長さはフレーム数に比例する |
| 字幕が数字・カタカナ語の途中で割れる | `breakLongToken`（`:594-608`）/ BudouX | 1文節が1行に入らないとき文字単位で折る実装。句読点が無いため早期区切りも効かない（`:633-640`） |
| UI が処理中のまま止まる | `job-worker.mjs:118-172` / `job-events.mjs` | 途中状態（選定待ち・承認待ち）を UI に渡す線が無い |

### 2-1. 音声欠落バグ：今回の再現実験

`renderFinal` と**同じフィルタ構成**を、時刻ごとに周波数が一意に決まる合成音（チャープ）入りの60秒素材で実行し、
各区間の中身を1サンプル単位で元と照合した（ffmpeg 6.1.1 / Linux。スクリプトはリポジトリ外）。

| 条件 | 結果 |
|---|---|
| 7区間・時系列順 | 全区間、中身は元と完全一致（誤差0）。**欠落なし** |
| 7区間・並べ替え（山場を先頭） | 同上。ffmpeg が「100/1000 buffers queued」と警告するが欠落なし |
| 繋ぎ目 | **区間の境目ごとに最大約27〜33msの無音が挟まる**。音声全長が期待値より45ms長い |

繋ぎ目の無音は、`trim`（映像）がフレーム単位（30fpsなら33.3ms刻み）で切れ、`atrim`（音声）はサンプル単位で
切れるため、映像の方が長くなった区間で `concat` が音声を無音で埋めることによる。

**ここから言えること**
- フィルタ構成そのものが語を丸ごと消す、という仮説は、この実験の範囲では否定された。
- 残る候補は2つ（どちらも【曖昧】。実素材の `decision.json` を見れば判定できる）:
  - **候補A（有力）: フィラー除去の誤爆。** Groq の日本語 word は1文字単位に近い（handoff ②の教訓）。
    `filler-cut.mjs:21` の `CLASS_A` は **1文字の「あ」「え」「ん」にも一致する**ので、
    「くれちゃう**ん**です」の「ん」が単独の語になっていれば、フィラーとして抜かれうる。
    切り口は近くの無音の端（±0.15秒）まで広がり、語中の誤検出無音（0.15〜0.3秒、実測済み）もその「端」になりうる。
    `subtractCuts` は1区間を細切れにし、細切れごとに 20ms のフェードと上記の最大33msの無音が入る。
  - **候補B: 実素材固有の条件。** 可変フレームレート、音声の start_time が0でない、Windows 版 ffmpeg の版差など。
    合成素材ではどれも再現していない。
- 確認手順は Phase 0-2 に書いた。

---

## 3. video-use との比較（実コードで確認した事実）

提案書は「video-use は EDL 中心・区間ごとの安全なレンダリング」と整理しているが、実コードには
提案書の方針と**逆のもの**がある。取り込むのは考え方だけにする、という提案書の判断は妥当。

| 項目 | video-use（実コード） | ai-editer 現行 | 方針 |
|---|---|---|---|
| EDL | `ranges[{source,start,end,beat,quote,reason}]`。**LLM が秒数を直接書く**。バリデータ無し（SKILL.md L286-307） | keep.json に文節番号。秒数はコードが決める | **現行の方が安全。** EDL の形だけ借り、AI は ID しか書かない（提案書 §5 と同じ） |
| packed transcript | 0.5秒以上の無音か話者交替で区切り、`[002.52-005.36] S0 本文` の1行形式（pack_transcripts.py L38-122） | units.json は1文節1行のJSON。文の単位が無い | 文節の上に「発話（文）」の層を足し、`[開始文節-終了文節]` 付きの読み物を作る |
| timeline view | フレーム帯＋波形（RMS）＋0.4秒以上の無音帯＋語ラベルを1枚のPNGに（numpy/PIL） | 無し | 取り込む（Phase 4）。PIL 依存の可否は要相談 |
| 切り出し | 区間ごとに `-ss` で切り出して再エンコード → concat demuxer `-c copy`（render.py L248-401） | 1本の filter_complex | 区間ごと方式へ寄せる（Phase 2）。ただし下記の補正を足す |
| 繋ぎ目の音 | 30ms フェード（L285-286）。クロスフェード無し | 20ms フェード。クロスフェード無し | 合格条件 §4 の 5〜10ms に合わせる |
| 境界の無音スナップ | **コードは無い。** プロンプトで「30〜200ms 余白を付けろ」と指示するだけ | 実測無音へ寄せるコードあり | **現行の方が進んでいる。** 残す |
| AAC の先頭無音・A/V ずれ | 対処コード無し | `av-verify.mjs` はあるが**どこからも呼ばれていない** | 中間は PCM 音声にし、AAC 化は最後の1回だけにする |
| ラウドネス | 2パス loudnorm I=-14 / TP=-1 / LRA=11（L529-531） | 無し | Phase 5 で取り込む |
| 検品 | SKILL.md の指示のみ。**再文字起こしは禁止**（Hard Rule 9） | AGENTS.md で再文字起こしを義務化 | ai-editer の方針（再文字起こし必須）を維持 |
| STT | ElevenLabs Scribe 固定。差し替え口なし | Groq / Whisper | 現行維持（提案書どおり） |

---

## 4. ファイルの4分類

| 分類 | ファイル | 理由 |
|---|---|---|
| **そのまま残す** | `server/`（`job-submit`・`job-cancel`・`multipart`・`file-sink`・`safe-path` 系・`runtime-paths`・`static-files`・`media-server`・`http-utils`・`index`）、`src/atomic-json.mjs`、`src/safe-path.mjs`、`src/env-file.mjs`、`src/transcribe.py`、`src/transcribe_groq.py`、`src/check-groq-key.py`、`src/timing.mjs`、`src/subtitle-styles.mjs`、`src/fonts/`、`src/vendor/budoux/`、`src/face_mosaic.py`、`src/face_choices.py`、`src/apply_mosaic_cli.py`、`src/apply-mosaic-stage.mjs`、`server/watch-jobs.mjs` | 安全対策・実運用で直した資産。編集コアの再設計とは独立 |
| **分離して残す** | `src/edit-job.mjs`（1028行） | 下の「分け方」参照。関数の中身は変えずに移す |
| | `src/filler-cut.mjs` | 判定の単位を「1文字の語」から「文節」へ変える（Phase 2） |
| | `src/srt-builder.mjs`（`wordsInRange`・`assTime` だけ使用） | 字幕モジュールへ寄せる |
| | `src/av-verify.mjs` | 未使用。QC から呼ぶ形で生かす |
| | `server/job-worker.mjs` | 状態を細かく書き出す形に（Phase 7） |
| **置き換える** | `renderFinal`（`edit-job.mjs:788-834`） | 区間ごと切り出し＋結合へ（Phase 2） |
| | `reframe.py` の `_crop_x_expr` | 巨大な式をやめる（Phase 6） |
| | keep.json | editorial_plan.json へ。移行期間は変換器で両方受け付ける |
| **削除候補**（承認後・参照ゼロを再確認してから） | `src/export-presets.mjs`・`src/job-id.mjs`・`src/term-dictionary.mjs`（どこからも import されていない）、`src/reframe_cli.py`（呼び出し元なし）、`demo-ui/`、`EDIT_BIBLE_SUMMARY`（`edit-job.mjs:55-96`、どこからも使われていない） | 旧経路の残骸。`ai-caption-fix.mjs`・`claude-run.mjs` 内の `reverse-match.mjs`/`digest-editor.mjs` への言及も、既に存在しないファイルを指すコメント |

`edit-job.mjs` の分け方（案。提案書 §7 の構成に合わせる）:

```
src/ingest/   transcribe（:196-204）, detectSilences（:207-225）, probeDimensions（:476-489）
src/script/   groupIntoPhrases ほか（:232-408）, pack（新規）
src/editorial/ plan-schema（新規）, resolve-edl（新規）, boundary（snapToSilence/snapRanges :256-471）
src/render/   segment-renderer（新規）, concat（新規）, subtitles（:524-761）, portrait（letterbox）
src/qc/       av-verify（既存）, retranscribe（新規）
src/edit-job.mjs  CLI の入口だけ残す（prepare / render。コマンド名は変えない）
```

---

## 5. 提案書の前提と実態の食い違い（先に共有しておくこと）

1. **モザイクと顔追跡クロップは、今の Web UI 経路（`edit-job.mjs`）に繋がっていない。**
   縦型は letterbox（黒帯で囲むだけ）。提案書 Phase 0 の「現在正常に動いているモザイク・portrait を記録する」は、
   モザイクと顔追跡については「単体では動くが、編集経路には未接続」と記録することになる。
2. **`video-shorts` にはテストも CI も無い。** `package.json` に `test` スクリプトが無く、`.github/workflows/` も無い。
   AGENTS.md の Testing 節（`pnpm -r test` 必須）と実態が食い違っている。冒頭のマスター決定（CI をゲートにしない）とは矛盾しないが、
   **退行を防ぐ手段が今は何も無い**ので、Phase 0 で最小のテストを置くことを提案する。
3. **誤字修正（prepare の 2）は今も使い捨ての `claude -p` が行っている。** AGENTS.md の絶対項目が禁じているのは
   「内容判断と検品の委任」なので規則違反ではないが、マスター指示原文の「台本をAIが読む→台本をAIが誤字を直す」を
   このセッション本人がやるべきかは、判断をいただきたい（§7 の質問2）。
4. 虎の巻 §8 は、既に削除されたファイル（`reverse-match.mjs` 等）の違反一覧になっている。
   原則（§1〜§7）は今も正で、§8 だけが古い。書き換えるかどうかはマスター判断（AGENTS.md は「虎の巻が正」としているため、勝手に直さない）。

---

## 6. Phase 0〜2 の具体的な変更案

### Phase 0 — 現状固定と再現（コードの動作は変えない）

| # | やること | 変更するファイル | 終わったと言える状態 |
|---|---|---|---|
| 0-1 | **合成素材による音声完全性テスト**を追加。2-1 の実験を固定化する：チャープ入り素材を ffmpeg で生成（コミットしない）→ render と同じ関数で書き出し → 各区間の中身の一致と、繋ぎ目の無音の長さを測る | `video-shorts/tests/audio-integrity.mjs`（新規）、`package.json` に `test` | 現行実装で「中身は一致・繋ぎ目に最大33msの無音」が数値で出る（＝今の挙動を記録できている） |
| 0-2 | **実素材での切り分け**（マスターのPCで実行。素材がリポジトリに無いため）。`render` に切り分け用の引数を足す：`--no-snap` / `--no-filler`。区間6付近（文節121-137）だけを keep に入れて4通り書き出し、それぞれを再文字起こしする | `edit-job.mjs`（引数の追加のみ） | 4通りのうちどれで「きれいに切り分けてくれちゃうんです」が崩れるかが分かる。合わせて `decision.json` の `fillerCuts` にその付近の「ん」「あ」「え」があるかを見る |
| 0-3 | **今の良いところの記録**：字幕（縦・横）、letterbox、中止、UI の各挙動を、同じ実素材で1本ずつ書き出し、コマを抜いて保存 | コード変更なし（`docs/handoff.md` に記録） | 後のフェーズで比べる基準ができている |

### Phase 1 — 編集データを EDL 中心へ（出力される動画は変えない）

| # | やること | 変更するファイル |
|---|---|---|
| 1-1 | `editorial_plan.json` の形を決めて検査する関数を作る（提案書 §5.1 の形。`fromUnit`/`toUnit`/`role`/`reason`。**時刻の欄は置かない**＝書いてあったらエラー） | `src/editorial/plan-schema.mjs`（新規） |
| 1-2 | keep.json → editorial_plan.json の変換器。移行期間は両方受け付ける | 同上 |
| 1-3 | **resolver**：plan → `edl.json`（v2）。今 `renderMain` の中にある「文節番号→時刻」「無音スナップ」「フィラー除去」をここへ移す。中身は変えない | `src/editorial/resolve-edl.mjs`・`boundary.mjs`（`edit-job.mjs` から移動） |
| 1-4 | `render` は `edl.json` だけを読んで書き出す形にする。`decision.json` は edl.json に統合 | `edit-job.mjs` |
| 1-5 | **承認の区切りを入れる**：`node src/edit-job.mjs plan <jobId>` で、採用する文節の本文を順番どおりに並べた「台本案」を表示・保存。render は承認済みの印が無いと動かない | `edit-job.mjs` |

完了確認: 同じ keep.json から、旧経路と新経路で**同じ区間の edl.json**が出る（時刻の完全一致）。0-1 のテストが引き続き通る。

### Phase 2 — 音声・カットエンジンの作り直し（最優先）

| # | やること | 根拠 |
|---|---|---|
| 2-1 | **フィラー判定の単位を文節にする**。1文字の語ではなく、`groupIntoPhrases` の文節全体が母音性フィラーである場合だけ候補にする | 0-2 の結果が候補A なら、これが直接の修正。候補Aでなくても、無音判定で既に踏んだのと同じ誤りなので直す |
| 2-2 | **区間の端を映像のフレーム境界にそろえる**（resolver 側で、開始は切り下げ・終了は切り上げ＝広く取る側。虎の巻 原則3） | 2-1 の実験で見つけた「繋ぎ目ごとに最大33msの無音」を無くす |
| 2-3 | **区間ごとに切り出す**：1区間ずつ、映像は H.264、音声は **PCM（無圧縮）** の中間ファイルにし、音声の長さを映像のフレーム数ぴったりに合わせる | 中間で AAC を使わないので、AAC の先頭無音（priming）の問題が境目に出ない。1区間だけ作り直して原因を切り分けられる |
| 2-4 | 中間ファイルを結合し、**AAC への変換は最後の1回だけ**行う。縦型・字幕はこの結合後に掛ける | 再エンコードの回数は今と同じ1回＋中間。速度は実測して報告する |
| 2-5 | 繋ぎ目のフェードを 20ms → 5〜10ms に（合格条件 §4 の数値。最終値は実聴で決める） | 虎の巻 §3-5（長いフェードは語頭を痩せさせる） |
| 2-6 | 無音を**足さない**ことを確認する（元の間を残すだけ。虎の巻 原則4） | 今の実装も足していないが、2-3 の方式で崩れないことを 0-1 のテストで見る |

完了確認（提案書 §8 の音声部分）:
- 0-1 のテストで、全区間の中身が一致し、**繋ぎ目の無音が1ms未満**になる。
- 0-2 と同じ実素材・同じ keep で書き出し、**再文字起こしで「きれいに切り分けてくれちゃうんです」がそのまま出る**。
- `av-verify.mjs` で A/V のずれ 5ms 未満。
- 合格条件の共通10項目を、実際に見て・聞いて照合する（AGENTS.md の絶対項目どおり、この確認は委任しない）。

**Phase 3 以降（packed transcript・timeline view・QC・字幕移植・reframe・UI）は、Phase 2 が終わってから改めて提案する。**

---

## 7. マスターに判断をいただきたいこと

1. この Phase 0〜2 の進め方でよいか（とくに 0-2 はマスターの PC での実行が必要）。
2. 誤字修正（prepare の 2）を、今の `claude -p` のまま残すか、このセッションが台本を読んで直す形に変えるか。
3. `video-shorts` に最小のテスト（0-1）を置いてよいか。CI のゲートにはせず、手元で回すだけの想定。
4. §4 の削除候補を消してよいか。
5. 虎の巻 §8（削除済みファイルの違反一覧）を現行コードに合わせて書き換えてよいか。

---

## 出典

- 参考実装: https://github.com/browser-use/video-use （MIT。HEAD `b877063` を読んだ）
  - https://github.com/browser-use/video-use/blob/main/SKILL.md
  - https://github.com/browser-use/video-use/blob/main/helpers/render.py
  - https://github.com/browser-use/video-use/blob/main/helpers/pack_transcripts.py
  - https://github.com/browser-use/video-use/blob/main/helpers/timeline_view.py
  - https://github.com/browser-use/video-use/blob/main/helpers/transcribe.py
- 現行プロジェクト: https://github.com/rahiseko-alt/ai-editer
