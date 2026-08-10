# build-web.ps1 — 製品を作り直して Web 配布（Vercel）へ反映する ワンコマンド
#
# 使い方（video-shorts フォルダで）:
#   powershell -ExecutionPolicy Bypass -File .\build-web.ps1
#
# やること:
#   1) dist を再生成（build-dist.mjs）
#   2) 製品を video-shorts.zip に梱包（install/ 配下・展開すると ai-editer-video-shorts フォルダ）
#   3) Vercel 本番（install-omega.vercel.app）へデプロイ
#
# 前提: node と vercel が PATH にあること（vercel はログイン済み）。
$ErrorActionPreference = "Stop"

$vs   = $PSScriptRoot                                   # …/products/kosespark/video-shorts
$dist = Join-Path $vs "..\dist\ai-editer-video-shorts"  # 生成先の製品ディレクトリ
$installDir = Join-Path $vs "install"
$zip  = Join-Path $installDir "video-shorts.zip"

Write-Host "==[1/3]== dist を再生成..." -ForegroundColor Cyan
node (Join-Path $vs "build-dist.mjs")
if ($LASTEXITCODE -ne 0) { throw "build-dist.mjs が失敗しました" }

Write-Host "==[2/3]== 製品を video-shorts.zip に梱包..." -ForegroundColor Cyan
if (-not (Test-Path $dist)) { throw "dist が見つかりません: $dist" }
$base = Join-Path $env:TEMP ("vspkg_" + (Get-Random))   # 毎回ユニーク（後始末は OS 任せ）
New-Item -ItemType Directory -Path $base -Force | Out-Null
Copy-Item -Path $dist -Destination $base -Recurse       # ai-editer-video-shorts ごとコピー
Compress-Archive -Path (Join-Path $base "ai-editer-video-shorts") -DestinationPath $zip -Force
$kb = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host "   → $zip ($kb KB)" -ForegroundColor Green

Write-Host "==[3/3]== Vercel 本番へデプロイ..." -ForegroundColor Cyan
Push-Location $installDir
try {
  vercel --prod --yes
  if ($LASTEXITCODE -ne 0) { throw "vercel デプロイが失敗しました" }
} finally {
  Pop-Location
}

Write-Host "`n完了。公開URL: https://install-omega.vercel.app/" -ForegroundColor Green
Write-Host "（同意→Next で最新の video-shorts.zip がダウンロードされます）"
