@echo off
title AI-Editer

rem ---------------------------------------------------------------
rem AI-Editer をダブルクリック1回で起動する。
rem   1. 前回の残りプロセスを片付ける
rem   2. 中継サーバーを別ウィンドウで起動
rem   3. 編集ワーカーを別ウィンドウで起動
rem   4. サーバーが応答したらブラウザを開く
rem 詳しい手順・困ったときは docs\ui-startup-navi.md
rem このファイルは Shift-JIS で保存すること（UTF-8 だと cmd が日本語を読めず壊れる）
rem ---------------------------------------------------------------

cd /d "%~dp0video-shorts"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [エラー] Node.js が見つかりません。
  echo Node.js をインストールしてから、もう一度このファイルを実行してください。
  echo.
  pause
  exit /b 1
)

echo 前回の残りを片付けています...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -like '*server/index.mjs*' -or $_.CommandLine -like '*job-worker*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1

echo サーバーを起動しています...
start "AI-Editer サーバー" cmd /k node server/index.mjs

echo 編集ワーカーを起動しています...
start "AI-Editer 編集の進行" cmd /k node server/job-worker.mjs

echo 起動を待っています...
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 40;$i++){ try{ Invoke-WebRequest -Uri 'http://127.0.0.1:5178/api/health' -UseBasicParsing -TimeoutSec 2 | Out-Null; $ok=$true; break }catch{ Start-Sleep -Milliseconds 500 } }; if(-not $ok){ exit 1 }"
if errorlevel 1 (
  echo.
  echo [エラー] サーバーが起動しませんでした。
  echo 「AI-Editer サーバー」のウィンドウに出ているメッセージを確認してください。
  echo.
  pause
  exit /b 1
)

start "" http://127.0.0.1:5178

echo.
echo 起動しました。ブラウザで操作してください。
echo 編集の進み具合は「AI-Editer 編集の進行」のウィンドウに出ます。
echo 終わるときは、開いた2つのウィンドウを閉じてください。
echo.
timeout /t 5 /nobreak >nul
exit /b 0
