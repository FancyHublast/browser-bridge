@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo  Browser Bridge - 手工启动服务端
echo ============================================
echo.

if not exist ".venv\Scripts\python.exe" (
  echo [错误] 没找到 .venv。请先双击 install.bat 装依赖。
  pause
  exit /b 1
)

echo 正在检查 8765 端口...
netstat -ano | findstr "127.0.0.1:8765" | findstr LISTENING >nul
if not errorlevel 1 (
  echo.
  echo [提示] 8765 端口已经有人在监听了 —— 服务端已经在跑。
  echo        如果你没手工起过，那就是 WorkBuddy 的 MCP 客户端拉起来的，
  echo        此时不需要再起第二个（会因端口占用直接退出）。
  echo        想确认是谁占的：netstat -ano ^| findstr 8765
  echo.
  pause
  exit /b 0
)

echo 端口空闲，启动中（这个窗口关掉 = 服务停止）...
echo.
".venv\Scripts\python.exe" mcp_server.py --ws-only

echo.
echo 服务已退出。
pause
