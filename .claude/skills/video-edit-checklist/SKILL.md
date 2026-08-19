---
name: video-edit-checklist
description: Use for the whole video-shorts editing loop in this repo. Trigger when starting or launching the local editing UI (「立ち上げて」「起動して」「UIを出して」「ローカルで動かして」), when a job becomes ready for segment selection (writing work/<jobId>/keep.json for video-shorts/src/edit-job.mjs), before running "node src/edit-job.mjs render <jobId>", and before reporting any edited video as finished, done, or 合格. Also triggers on 「編集して」「区間を決めて」「keep.json書いて」「検品して」「完成した」「レンダーして」「動画できた」. Covers three mandatory phases: arming the job watcher so submitted videos are never missed, selecting segments by reading units.json in full, and inspecting the rendered output against docs/合格条件.md. Launching the UI without arming the watcher, or a clean process exit from edit-job.mjs, is not evidence of anything — do not skip this skill because a command succeeded.
---

# 動画編集：区間選定と出力前検品

このスキルは `C:\Users\user\ai-editer` の video-shorts 案件専用。正本は次の3ファイルで、
このスキルは要点の地図でしかない。判断に迷ったら必ず原本を読むこと。

- **手順の正本**: `AGENTS.md`「【絶対項目・毎回】動画編集：内容決定はセッション自身が行い、出力前に検品する」節
- **合否判定の正本**: `docs/合格条件.md`（唯一の正。動画を通しで見て判定する）
- **切り方の物理の正本**: `docs/編集についての虎の巻.md`

## なぜこのスキルが要るか

2026-08-19、区間選定を毎回まっさらな使い捨てのAI呼び出し（この対話の文脈も虎の巻も合格条件も
持たない）に丸投げしていたところ、「その名も、コズム」が「も、コズム」になるような、
**この対話をしているセッションが実際に見れば一瞬で気づけるミス**を無人のまま出力していた。
マスターに「なぜ出力前にやらないのか」と問われ、答えられなかった。

このスキルの役割は、セッションが変わっても同じ2フェーズを必ず踏ませること。
「動いた」「エラーが出なかった」は合格の根拠にしない。

## フェーズ0：見張りを張る（UIが上がっていると分かった時点で、他の何より先に）

```
Monitor({
  command: "cd /c/Users/user/ai-editer/video-shorts && node server/watch-jobs.mjs",
  description: "動画編集ジョブの選定待ち・失敗・中止・停滞",
  persistent: true
})
```

`見張り開始: ...` の1行を**実際に受け取るまでは、張れていないものとして扱う**。
以後、`選定待ち <jobId> 文節<N> 指示「…」` が通知で届く。それが来たらフェーズ1に入る。
失敗・中止・停滞（投入から15分進んでいない）も同じ経路で届く。

**なぜこれが要るか**：ワーカーは `prepare`（文字起こし〜文節化）までしか自動実行せず、
正常終了時は `results.jsonl` に何も書かない。完了の合図はワーカーの黒い画面に出るだけで、
**このセッションには何も届かない。** 2026-08-19、それに気づかず prepare 済みのジョブ
（226文節）を放置し、待たされたマスターが中止を押した。見張りはその穴を塞ぐ唯一の線。

**外しやすい点（すべて実際に踏みうる）**

- **義務は「誰が起動したか」に依存しない。** マスターが自分で `起動.bat` を押した場合も、
  既に動いていた場合も同じ。`起動.bat` は見張りを張らない（ウィンドウ2枚を開くだけ）。
- **`起動.bat` が動いた ≠ 起動が終わった。** bat の「起動しました」はウィンドウ2枚の意味だけ。
- **ワーカーが出す `[worker] 見張りを開始します` は別物。** あれはワーカーが投入フォルダを
  見る話。これが出ていてもフェーズ0は終わっていない。
- **`Monitor` がツール一覧に無ければ `ToolSearch` で `select:Monitor` を読み込む。**
  **`Bash` のバックグラウンド実行で代用してはいけない**（常駐プロセスは終了しないので
  1行ごとの通知が届かず、「張ったつもり」で投入を取りこぼす＝直したかった不具合の再発）。
- 張れていない状態で「立ち上げました」「準備できました」「投入してください」
  「お待ちしています」の**いずれも言ってはいけない**。気づけないので嘘になる。

## フェーズ1：区間選定（render の前）

`work/<jobId>/units.json`（番号付き文節一覧）を**実際に全文読む**。「だいたいこの辺」で済ませない。

`docs/編集についての虎の巻.md`（どこで切るか）と `docs/合格条件.md`（何を残すか・何を捨てるか）
の基準に照らして、**このセッション自身が** `work/<jobId>/keep.json` を直接書く。

`keep.json` の形式: `{"keep": [[開始文節番号, 終了文節番号], ...], "applied": ["反映した指示"], "notApplied": ["反映できなかった指示とその理由"]}`

書いたら `node src/edit-job.mjs render <jobId>` を実行する。

## フェーズ2：出力前検品（完成報告の前・必須3点）

render が終わっても、それを「完成」としてユーザーに報告してはいけない。次の a〜c を**すべて**行う。
判断だけして出力を見ない、は禁止。

**a. 実際にコマを抜いて目で見る**
```
ffmpeg -ss <秒> -frames:v 1 -y frame.png
```
その後 Read ツールで画像を確認する。文字起こしの結果を読むだけで済ませない。

**b. 完成した動画をもう一度文字起こしし直して、実際に焼かれた音声・話の繋がりを確認する**
事前の判断（keep.json）が正しく実現されているとは限らない。無音スナップ・フィラー除去は
判断のあとに動くので、最終結果は別工程で検証しないと、判断と実物のズレに気づけない。

**c. `docs/合格条件.md` の共通チェックリスト10項目＋該当するモード別追加チェックに、
実際に見た内容で1つずつ照合する**
コードの内部状態やログを根拠にしない。動画を通しで見て YES/NO を答える。

## 不合格の扱い

**1つでも NO があれば、直して a〜c を最初からやり直す。** 「直したはず」で終わらせない。
直した後も再度コマ抜き・再文字起こし・チェックリスト照合をやる。

## サブエージェントへの委任は禁止（マスター指示 2026-08-19）

**フェーズ1・フェーズ2とも、サブエージェントに委任してはいけない。**
区間選定も検品も、この対話をしているセッション自身が、自分の目で行う。

理由は、このスキルが生まれた事故そのもの。丸投げ先はこの対話の文脈を持たないので、
実物を見れば一瞬で気づけるミスを素通しする。委任は「読んだつもり・見たつもり」を作り、
検品という工程の意味を消す。**自分で units.json を読み、自分でコマを抜いて見る。**
