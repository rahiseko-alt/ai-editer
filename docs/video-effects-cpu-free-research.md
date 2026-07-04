# 動画エフェクト技術リサーチ（CPU環境・完全無料に限定）

- 日付: 2026-06-16
- 用途: video-shorts（長編→縦型ショート自動編集）への味付け候補
- **出典:** 外部AIツール（agent-ag）生成レポートをマスター経由で受領。
  - ⚠️ **元の `C:\Users\user\Desktop\vibe-base\agent-ag\research-cpu-free\report.md` は実在を確認できなかった**（`find` で0件）。本ファイルが正本。
  - ⚠️ **各 GitHub URL・ライセンス・動作は未検証**（【未検証】）。採用前に実在とライセンスを各自確認すること（調査品質ルール: 裏付けなし排除）。
- 制約: CPU動作・オープンソース/フリーライセンスのみ。

---

## 1. 吹き出し（チャットバブル/ダイアログ）アニメーション

ブラウザ標準描画（HTML/CSS/SVG/JS）のみでCPU軽量動作する手法。**動画に焼くには別途レンダリング（Remotion等）が必要**な点に注意。

| # | 技術 | 仕組み | ライセンス | 出典(未検証) |
|---|------|--------|-----------|------|
| ① | SVG Gooey Filter | `feGaussianBlur`でぼかし→`feColorMatrix`でアルファのコントラストを急峻化し、要素が「磁石のように合体」する液体エフェクト | CSS/SVG標準（無料） | — |
| ② | Animal Crossing 風 揺れ枠 | `feTurbulence`(ノイズ)+`feDisplacementMap`(変位)をCSS `@keyframes`でループ変化させ枠線を揺らす | SVG標準（無料） | github.com/PedroPastel/fc06ad4b... |
| ③ | Comical-JS | アメコミ調吹き出しをSVGで動的描画。尻尾先端を口元座標に吸着・伸縮 | MIT | github.com/BloomBooks/comical-js |
| ④ | wc-bubble | Vanilla JS の軽量 WebComponent。CSS変数で出現イージング/バウンド/ディレイ制御 | MIT | github.com/yishiashia/wc-bubble |

### ① Gooey Filter 実装例（受領コードのまま・未検証）
```html
<svg style="position:absolute;width:0;height:0">
  <defs>
    <filter id="gooey-bubble">
      <feGaussianBlur in="SourceGraphic" stdDeviation="10" result="blur"/>
      <feColorMatrix in="blur" mode="matrix"
        values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9" result="gooey"/>
      <feComposite in="SourceGraphic" in2="gooey" operator="atop"/>
    </filter>
  </defs>
</svg>
```
`.bubble-container { filter: url('#gooey-bubble'); }` で適用。本体divと尻尾divが近づくと合体する。

---

## 2. FFmpeg 動画エフェクト（CPU・無料）

| # | 技術 | 内容 | ライセンス | 現実性(video-shorts) |
|---|------|------|-----------|------|
| ① | FFmpeg標準 `xfade` | プラグイン不要・40種以上のトランジション(pixelize/circleopen/dissolve/wipe等)。CPU | LGPL/GPL（無料） | ◎ すぐ足せる |
| ② | MoviePy (Python) | 全フレームをNumPy配列化しピクセル操作（RGBチャンネルshift=色収差グリッチ等）。FFmpegパイプ出力 | MIT | △ 全フレーム処理でCPU重い |
| ③ | FFglitch | ビットストリームの動きベクトル/Pフレームを改ざんし本物のDatamoshing | GPL | △ カスタムビルド要・環境重い |
| ④ | Remotion | React+CSS/SVGで動画をコード記述→Puppeteer+FFmpegでMP4化。WebGL不使用ならCPUのみ | 独自(個人/小規模無料) | ✕→吹き出し焼きはこれが必要だが別アーキ |

### ① xfade コマンド例
```bash
ffmpeg -i v1.mp4 -i v2.mp4 -filter_complex \
  "xfade=transition=pixelize:duration=1.5:offset=5" output.mp4
```
- `transition`: pixelize / circleopen / wiperect / dissolve など
- `offset`: トランジション開始秒。**入力の解像度・fps・カラーフォーマット統一が必須**

---

## 3. video-shorts への適用評価（kosespark 担当の所見）

- **xfade（①FFmpeg標準）が最も即効・低リスク。** 現状は各トピックを単一区間で切り出しているため、トピック内に複数カットを繋ぐ構成にした時に効く。無料・CPU・依存追加なし。
- **吹き出し字幕は重い。** 現パイプラインは ASS 字幕を ffmpeg で焼く方式。揺れる吹き出しは ASS では不可で、Remotion で字幕レイヤーを別レンダリングして合成する大工事になる。費用対効果は要検討。
- **グリッチ（MoviePy/FFglitch）は実験向き。** 10分素材の全フレーム処理はCPUで非現実的。短い区間（生成済みショート）になら適用余地あり。
- 採用判断は実機で出した6本（`output/sample6-17/`）の出来を見てから（マスター指示: 選択肢1）。

---

## 4. 残課題（採用前にやること）
1. 各 GitHub URL の実在・ライセンス・最終更新を確認（【未検証】を外す）
2. xfade のプロトタイプを video-shorts に1本通して検証
3. 吹き出し字幕を本気でやるなら Remotion の別建て可否をPで判断
