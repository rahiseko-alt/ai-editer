# UI起動ナビ（マスターの手元 Windows で画面を開く手順の正）

このファイルが**唯一の正**である。マスターから「UIで編集したい」「画面を出したい」に類する
指示を受けた AI は、**このファイルの手順をそのまま、番号ごと省略せずに**提示する。
手順を思い出しで書き直すこと・要約すること・途中のステップを飛ばすことを禁じる。

## なぜ固定するのか（2026-08-15 の実地の失敗）

同じ起動作業で 2 回連続して詰まった。

1. 1回目: サーバが古い UI のままだった（更新手順が抜けていた）。
2. 2回目: `ERR_CONNECTION_REFUSED`。原因はマスターが `C:\Users\user`（リポジトリの外）に
   いたこと。AI 側が「リポジトリのフォルダで」としか書かず、**移動するコマンドを書かなかった**。

どちらも AI が毎回その場で手順を組み立てていたために起きた。手順を固定し、
**場所を覚える必要も、どこにいるかを判断する必要も無くす**のがこのファイルの目的である。

## 手順（この5つ。番号も文言も変えない）

### ステップ0：すべてのターミナルを閉じる

開いている PowerShell / コマンドプロンプトを**全部**閉じる。

- 古いサーバが残っているとポートを掴んだままになり、新しい方が起動できない。
- 前回の作業ディレクトリが残っていると、どこにいるか分からないまま実行してしまう。

### ステップ1：PowerShell を新しく開く

### ステップ2：次のブロックをまるごと貼って Enter

```powershell
Get-NetTCPConnection -LocalPort 5178 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
$repo = Get-ChildItem -Path $HOME -Recurse -Depth 4 -Directory -Filter ai-editer -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if (-not $repo) { Write-Host "リポジトリが見つかりません。クローン先を教えてください。" -ForegroundColor Red } else { Set-Location $repo; Write-Host "場所: $repo" -ForegroundColor Green; git checkout main; git pull; Write-Host ("ブランチ: " + (git rev-parse --abbrev-ref HEAD) + " / 版: " + (git rev-parse --short HEAD)) -ForegroundColor Green; node video-shorts/server/index.mjs }
```

この1ブロックが「残っているサーバを止める → リポジトリを探す → 移動する → **main へ切り替える** →
更新する → いまのブランチと版を表示する → 起動する」を全部やる。
**マスターがパスもブランチ名も覚えておく必要は無い。**

> `git checkout main` は 2026-08-15 に追加した。これが無かったため、マスターの手元が古い作業ブランチ
> (`claude/ui-p2-quality`) のままで、`git pull` がそのブランチだけを更新し、刷新後の画面が出なかった。

### ステップ3：この1行が出れば成功

```
[ai-editer] server listening on http://127.0.0.1:5178
```

**先頭が `[ai-editer]` であることまで確認する。** ここが `[kosespark]` になっていたら、
古いブランチのまま動いている（改称前の版）。ステップ2をやり直す。

出ていなければ**起動していない**。ステップ5へ。

### ステップ4：ターミナルは開いたまま、ブラウザで開く

http://127.0.0.1:5178

古い見た目のままなら `Ctrl + Shift + R`（強制再読み込み）。

### ステップ5：うまくいかないときに AI へ渡すもの

**ターミナルの出力をそのまま貼る。** 要約しない。AI は出力を見るまで原因を言わない。

`claude` の起動に失敗している疑いがあるときだけ、追加でこれを実行して出力を貼る。

```powershell
node video-shorts/scripts/diagnose-claude.mjs
```

## AI 側の規律

- **出力を見る前に原因を言わない。** 2026-08-15 に、原因を確かめずに対処を2回続けて指示して
  外した（`docs/failures.md` 参照）。症状が説明できないうちは対処を提案しない。
- **手順は省略しない。** 「前と同じです」で済ませず、毎回ステップ0から全文を出す。
  マスターがどの状態から始めるかは AI には分からない。
- **移動を伴う手順では、必ず移動するコマンドを書く。** 「〜のフォルダで」という指示だけを
  書かない。これが 2026-08-15 の `ERR_CONNECTION_REFUSED` の直接の原因である。
- **このファイルを更新したら、手順の変更点をマスターへ伝える。** 黙って変えない。
