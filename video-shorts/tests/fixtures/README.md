# テスト固定素材（顔モザイク）

`tests/face-mosaic-check.py` が使う固定素材。**顔検出は実在の顔でしか検証できない**ため、
権利上クリーンな public domain 画像から顔部分だけを切り出して置いている。

| ファイル | 内容 | 期待する検出数 |
|---|---|---|
| `face-one.png` | 顔1つ | 1 |
| `face-two.png` | 顔2つを横に並べたもの | 2 |

## 出典とライセンス

いずれも **NASA が撮影した public domain（パブリックドメイン）の宇宙飛行士公式ポートレート**を
Wikimedia Commons 経由で取得し、顔の周辺を切り出して高さ240pxへ縮小したもの。

- `face-one.png` … Neil Armstrong の公式ポートレート（`Neil_Armstrong_pose.jpg`）より
- `face-two.png` … 上記に Buzz Aldrin の公式ポートレート（`Buzz_Aldrin.jpg`）を並べたもの

NASA の著作物は原則としてパブリックドメインであり、再配布・改変に制限はない。

## 動画の固定素材を置かない理由

`video-shorts/.gitignore` が `*.mp4` と `samples/` を除外しているため、動画はコミットできない。
動きのある場面が要るテスト（M-1-B / M-1-C）は、**この静止画をテスト内で移動させて合成する**
ことで再現している。素材が無くても誰でも同じ結果を再現できる。
