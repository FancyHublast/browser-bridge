@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

title Browser Bridge - 卸载本地服务

set "TASK_NAME=BrowserBridge"
set "SVC_PORT=8765"

echo ==============================================================
echo   Browser Bridge   卸载本地服务
echo ==============================================================
echo.
echo   会移除：开机自启项 + 正在运行的后台服务
echo   会保留：.venv 虚拟环境与依赖（想彻底清干净就手动删掉 .venv 目录）
echo.
echo ==============================================================
echo.
pause

echo [1/4] 结束计划任务 ...
schtasks /End /TN "%TASK_NAME%" >nul 2>nul && (echo       已结束) || (echo       没有正在运行的任务实例)

echo [2/4] 删除自启注册 ...
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>nul && (echo       已删除计划任务) || (echo       没有计划任务需要删除)
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "%TASK_NAME%" /f >nul 2>nul && (echo       已删除注册表自启项) || (echo       没有注册表自启项需要删除)

echo [3/4] 清理残留进程 ...
REM 只终止命令行里含 mcp_server.py 且带 --http / --ws-only 的进程。
REM 这样不会误伤 WorkBuddy 通过 MCP 拉起的 stdio 实例（它两个都没有）。
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*mcp_server.py*' -and ($_.CommandLine -like '*--http*' -or $_.CommandLine -like '*--ws-only*') };" ^
  "if ($p) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Host ('       已结束 ' + $p.Count + ' 个服务进程') } else { Write-Host '       没有残留进程' }" 2>nul

echo [4/4] 确认端口已释放 ...
ping -n 3 127.0.0.1 >nul 2>&1
netstat -ano | findstr "127.0.0.1:%SVC_PORT%" | findstr LISTENING >nul
if errorlevel 1 (
  echo       端口 %SVC_PORT% 已释放
) else (
  echo       [提示] 端口 %SVC_PORT% 仍在监听。
  echo              如果不是本脚本启动的服务，很可能是 WorkBuddy 的 MCP 客户端
  echo              拉起的实例（那个不该在这里杀，杀了会断掉当前会话的浏览器能力）。
  echo              确认是谁占用：netstat -ano ^| findstr :%SVC_PORT%
)

echo.
echo ==============================================================
echo   卸载完成
echo ==============================================================
echo.
echo   注意：Chrome 里的扩展没有被卸载。
echo   不需要了就去 chrome://extensions 手动移除。
echo.
pause
