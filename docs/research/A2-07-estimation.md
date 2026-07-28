# A2-⑦: 見積り工学（工数・コスト見積り／要件変更の影響管理）の深掘り

> ロードマップ葉 **A2-7** の成果物。採用領域⑦から、教材に組み込む**原則・道具・落とし穴**を出典つきで抽出する。
> 本領域は**概算アプリ D（要件を変えたら工数がどう動くか）**のロジックと、骨格 B の「依存・付け足し・可変100」運用を支える。

## 原則（何を使うか）
- **不確実性は時間で減る（Cone of Uncertainty）**：要件確定前の見積りは高低±4倍の幅を持つ。進むほど幅が縮む。→ アプリは"点"でなく"幅"で出すべき。
- **見積りは複数技法の併用**：専門家判断・類推（analogous）・パラメトリック（COCOMO 等）・ボトムアップ。単独に依存しない。
- **確率的見積り（Three-point / PERT）**：楽観(O)・最頻(M)・悲観(P)から `(O + 4M + P) / 6` で期待値、幅で信頼度を伝える。
- **要件が見積り精度を規定**：要件が曖昧なほど見積りは当たらない。要件の明確化が精度の前提。

## 道具（どう使うか）
- **パラメトリック（COCOMO）**：規模（コード量等）＋係数から工数を算出。ただし"規模の入力自体が推測"である点に注意。
- **三点見積り / PERT・モンテカルロ**：不確実性を確率分布で扱い、レンジと信頼度を出す。
- **類推・プランニングポーカー**：過去の類似案件・相対見積りで素早く当たりをつける。
- **要件変更の影響管理**：変更を「初期仕様・計画・スケジュール・要員」への影響として追跡し、見積りを更新する統制。→ **アプリの中核＝"要件を1つ変えたら工数がどう動くか"の即時再計算**。

## 落とし穴（避けること）
- **単一点見積り**：1つの数字で出すと外れる。幅・信頼度で示す（Cone of Uncertainty）。
- **スコープクリープ**：小さな追加を見積りに反映せず積み上がる。→ **付け足しは必ず見積りを更新**（教材の「可変100＝再凍結」と同型）。
- **アンカリング／計画錯誤**：最初の数字や楽観に引っ張られる。過去実績（類推）で補正する。
- **要件不明のまま確定見積り**：不完全な要件で"確定"を出さない。Standish CHAOS では原成功基準を満たすのは約31%。

## 教材への落とし込み（どの枝を支えるか）
- **D1（概算エンジン）**：三点見積り＋要件変更の影響再計算を、代表ケース（要件変更→工数）で実装するロジックの根拠。
- **D（アプリ全体）**：出力は"点"でなく"幅＋信頼度"（Cone of Uncertainty）にする設計指針。
- **B2（依存・付け足し・可変100）**：スコープクリープ統制＝付け足しを見積り・計画へ反映する運用ルールの裏づけ。

## 出典
- [Cone of Uncertainty（Wikipedia）](https://en.wikipedia.org/wiki/Cone_of_Uncertainty)
- [Guide to Project Estimation and Estimation Techniques（Galorath）](https://galorath.com/estimation/)
- [What is effort estimation in project management? [+Techniques]（ProofHub, 三点/PERT）](https://www.proofhub.com/articles/effort-estimation-in-project-management)
- [Toward an effort estimation model for software projects integrating risk（arXiv, 学術）](https://arxiv.org/pdf/1509.00602)

> 一次情報への格上げ候補（A3統合時）：Boehm, B.『Software Cost Estimation with COCOMO II』／McConnell, S.『Software Estimation: Demystifying the Black Art』。
