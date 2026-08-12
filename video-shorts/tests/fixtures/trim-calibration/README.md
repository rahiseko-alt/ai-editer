# trim-calibration — G-EDIT-TRIM-A/B/C/D/E の凍結済み素材

`G-EDIT-TRIM-B`（無音・言い淀みカットでフィラーが本当に消えたか）の判定に使う
**しきい値を決めるための素材**であり、`G-EDIT-TRIM-A/C/D/E` も同じ素材・同じ区間表を使う
（design値の一貫性のため）。実装より先に凍結してあります。

**2026-08-12 軌道修正C-7反証(2)(3)是正で作り直した**（旧素材はindex1/7が同じ語「こんにちは」の
重複で片方消失を検出できず、言い淀みと語の長さも完全分離しており単純な長さしきい値の偽実装を
弾けなかった）。index0〜5は旧素材と設計値(秒)が完全一致し、index6/7だけを差し替えている。
詳細は `calibration.json` の `_readme` と各セグメントの `note` を参照。

同日、`G-EDIT-TRIM-B/C` の照合方法も「探す側と同じ長さの窓を滑らせるDTW」から
「開始・終了位置自由(subsequence)DTW」へ全面作り直した(反証(1)是正)。旧方式はフィラー音声の
75〜90%が残っていても検出できない構造上の欠陥を持っていた。新実装は
`video-shorts/tests/trim-filler-match-check.py`（MFCC抽出・subsequence DTWとも numpy のみで実装。
scipy/librosa等の追加依存なし）。判定対象の出力音声は
`video-shorts/tests/trim-filler-audio-helper.mjs` が本物の `buildTrimFilters`（`src/trim-plan.mjs`）
を呼んで作る。

## なぜ凍結が要るか

しきい値を「実装してから決める」と、分離しやすいフィラー区間や語の組を後から選べます。
その結果、検出漏れを許す値にすれば何でも「消えている」と判定できてしまいます。
AGENTS.md が禁じる「作業の途中で自分に都合よく緩める」に当たるため、素材と区間を先に固定します。

## 中身

| ファイル | 役割 |
|---|---|
| `calibration.flac` | 校正用の音声。可逆圧縮なので、AAC 再エンコード前の基準音として使える |
| `calibration.json` | 音声の SHA-256、各区間の種別・テキスト・開始秒・終了秒、(i)(ii) に使う区間の指定 |

`espeak-ng 1.51`（voice=ja, speed=150）で各語を個別に合成し、語間に 0.5 秒の無音を挟んで
設計時刻へ配置しています。**区間は推定値ではなく設計値**です。

## 使い方（着手時）

`docs/roadmap.html` の `G-EDIT-TRIM-B` の `verify` に従い、この素材と `calibration.json` に
列挙された区間**だけ**を使って (i)(ii) を測り、その中点をしきい値とします。
他の素材や別の区間を持ち込まないでください。

## 差し替えるとき

素材を差し替えた時点で校正はやり直しです。`calibration.json` の SHA-256 と、
`docs/roadmap.html` の `verify` に書かれた SHA-256 の両方を更新してください。
