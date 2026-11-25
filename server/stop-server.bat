@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo  Browser Bridge - 停止服务端
echo ============================================
echo.

set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "127.0.0.1:8765" ^| findstr LISTENING') do (
  echo 发现监听进程 PID=%%p，正在结束...
  taskkill /PID %%p /F >nul 2>nul
  set FOUND=1
)

if "!FOUND!"=="0" (
  echo 8765 端口没人监听，服务端本来就没在跑。
) else (
  echo.
  echo 已停止。8765 端口现在空出来了。
  echo 提醒：WorkBuddy 重启时会自动拉起服务端，不需要你再手工启动。
)

echo.
pause
