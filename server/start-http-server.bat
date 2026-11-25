@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

title Browser Bridge - 常驻服务（HTTP 模式）

set "PY=%~dp0.venv\Scripts\python.exe"
set "SRV=%~dp0mcp_server.py"
set "WS_PORT=8765"
set "HTTP_PORT=8766"

echo ==============================================================
echo   Browser Bridge   常驻服务（HTTP 模式）
echo ==============================================================
echo.
echo   这个模式和默认的区别：
echo.
echo     默认（stdio）：每个 agent 会话都自己拉起一个进程去抢 8765，
echo                    只有一个能成功，其余直接退出 —— 所以在第二个会话里
echo                    看到的 browser_* 工具是"不可用"的。
echo.
echo     HTTP 模式   ：只跑一个常驻实例，同时提供
echo                      · ws://127.0.0.1:8765   给 Chrome 扩展
echo                      · http://127.0.0.1:8766/mcp   给所有 agent 会话
echo                    多个会话指向同一个实例，不再抢端口。
echo.
echo   前提：agent 那边要把 MCP 配置改成 streamableHttp
echo         （见 mcp-config.snippet.json 里的 http 版本）
echo.
echo   本窗口不要关。关掉 = 服务停止。
echo   想让它开机自动起，用 install-local-service.bat。
echo.
echo ==============================================================
echo.

if not exist "%PY%" (
  echo   [错误] 没找到 .venv，请先双击 install.bat 安装依赖。
  echo.
  pause
  exit /b 1
)

echo   检查端口占用 ...
netstat -ano | findstr ":%WS_PORT%" | findstr LISTENING >nul
if not errorlevel 1 (
  echo.
  echo   [注意] %WS_PORT% 已在监听 —— 说明已经有一个服务在跑
  echo          （可能是某个 agent 会话拉起的 stdio 实例，也可能是上一次的常驻服务）。
  echo          一个端口只能有一个服务，这个实例会启动失败。
  echo.
  echo          占用者：
  powershell -NoProfile -Command "$pids=(Get-NetTCPConnection -LocalPort %WS_PORT% -State Listen -ErrorAction SilentlyContinue).OwningProcess; if($pids){Get-CimInstance Win32_Process | Where-Object {$pids -contains $_.ProcessId} | ForEach-Object {Write-Host ('     PID ' + $_.ProcessId + '  ' + $_.CommandLine)}}" 2>nul
  echo.
  echo          要改成 HTTP 常驻模式，先停掉那个实例：
  echo            · 若是 agent 拉起的：先关掉那个会话 / 重启 WorkBuddy
  echo            · 若是手工起的：双击 stop-server.bat
  echo.
  pause
  exit /b 1
)

echo       %WS_PORT% 空闲，开始启动 ...
echo.
echo   ------------------------------------------------------------
echo   启动后请确认这条日志出现（端口是 8766，不是 8000）：
echo     以 Streamable HTTP 方式启动 MCP：http://127.0.0.1:8766/mcp
echo   ------------------------------------------------------------
echo.

"%PY%" "%SRV%" --http

echo.
echo   服务已退出。
pause
