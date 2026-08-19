---
name: video-edit-checklist
description: Use when deciding which segments of a video-shorts job to keep (writing work/<jobId>/keep.json for video-shorts/src/edit-job.mjs), before running "node src/edit-job.mjs render <jobId>", or before reporting any edited video as finished, done, or 合格. Also trigger on requests like "編集して"「区間を決めて」「keep.json書いて」「検品して」「完成した」「レンダーして」「動画できた」 about a video-shorts job. Enforces the mandatory two-phase procedure (segment selection from units.json, then post-render inspection against docs/合格条件.md) so quality holds even when a future session has no memory of why this exists. A clean process exit from edit-job.mjs is not evidence of a good edit — do not skip this skill just because the command succeeded.
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
