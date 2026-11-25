@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo  Browser Bridge - 服务端依赖安装
echo ============================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 python 命令。
  echo 请先安装 Python 3.10 或以上，并确保安装时勾选了 "Add Python to PATH"。
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [1/3] 创建虚拟环境 .venv ...
  python -m venv .venv
  if errorlevel 1 (
    echo [错误] 创建虚拟环境失败。
    pause
    exit /b 1
  )
) else (
  echo [1/3] 虚拟环境已存在，跳过创建。
)

echo [2/3] 升级 pip ...
".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet

echo [3/3] 安装依赖 websockets / mcp ...
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo [错误] 依赖安装失败。可尝试换一个索引源重试：
  echo   .venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.org/simple/
  echo   .venv\Scripts\python.exe -m pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/
  pause
  exit /b 1
)

echo.
echo ============================================
echo  安装完成。
echo.
echo  手工排障（推荐先跑这个，确认服务端正常）：
echo    .venv\Scripts\python.exe mcp_server.py --ws-only
echo.
echo  正常使用：不用手工启动，agent 会通过 MCP 自动拉起 mcp_server.py
echo ============================================
pause
