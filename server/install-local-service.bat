@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title Browser Bridge - 本地服务安装

set "TASK_NAME=BrowserBridge"
set "SVC_PORT=8765"
set "PYW=%~dp0.venv\Scripts\pythonw.exe"
set "PY=%~dp0.venv\Scripts\python.exe"
set "SRV=%~dp0mcp_server.py"

echo ==============================================================
echo   Browser Bridge   本地服务一键安装
echo ==============================================================
echo.
echo   [必读] 这个脚本装的是「HTTP 模式的常驻服务」：
echo     一个进程同时提供
echo       ws://127.0.0.1:8765          给 Chrome 扩展
echo       http://127.0.0.1:8766/mcp    给所有 agent 会话
echo.
echo   装好之后所有会话共用这一个实例，不会再出现
echo   "第一个会话能用、第二个会话里工具不可用"的情况。
echo.
echo   [注意] 必须配套改一处配置：把 ~/.workbuddy/mcp.json 里的
echo     browser-bridge 改成 streamableHttp 指向
echo     http://127.0.0.1:8766/mcp
echo   片段见 mcp-config.snippet.json。
echo   不改的话 agent 仍会用 stdio 去抢 8765，抢不到就整个会话不可用。
echo.
echo   安装步骤：
echo     [1/4] 检查运行环境（已有 .venv 会直接复用）
echo     [2/4] 检查依赖（首次约 1-2 分钟）
echo     [3/4] 检查端口占用，再注册「登录后自动启动」
echo     [4/4] 启动服务并自检
echo.
echo   卸载：双击 uninstall-local-service.bat
echo.
echo   [说明] 本文件是 GBK 编码。用 UTF-8 存会让 cmd 把中文拆坏、
echo          半个汉字的后半截被当成命令执行，别再改成 UTF-8。
echo.
echo ==============================================================
echo.
pause

REM ==============================================================
REM  [1/4] 运行环境
REM
REM  顺序很重要：先看 .venv 能不能用，能用就直接复用。
REM  旧版是先查系统 Python，那样在 "venv 早就建好、但系统 Python
REM  不在 PATH 或版本过低" 的机器上会误报 "没找到 Python 3.10"，
REM  明明环境是好的却装不下去。
REM ==============================================================
echo [1/4] 检查运行环境 ...
set "ENV_OK="
if exist "%PY%" (
  "%PY%" -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>nul
  if not errorlevel 1 set "ENV_OK=1"
)

if defined ENV_OK (
  echo       复用已有虚拟环境（.venv 可用）
  goto :env_ready
)

echo       没有可用的 .venv，查找系统 Python ...
set "SYSPY="
where py >nul 2>nul && (
  py -3 -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>nul
  if not errorlevel 1 set "SYSPY=py -3"
)
if not defined SYSPY (
  where python >nul 2>nul && (
    python -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>nul
    if not errorlevel 1 set "SYSPY=python"
  )
)
if not defined SYSPY (
  echo.
  echo   [错误] 既没有可用的 .venv，也没找到 Python 3.10 或更高版本。
  echo.
  echo   两种解决办法，任选其一：
  echo     1] 安装 Python 3.10+，安装时勾选 Add python.exe to PATH
  echo        https://www.python.org/downloads/windows/
  echo     2] 找一台装好环境的机器，把整个 server 目录拷过来
  echo        .venv 跟着一起拷就能用，不依赖系统 Python。
  echo.
  echo   若公司电脑不允许装软件，见 docs 里的「内部分发与部署」一文。
  echo.
  pause
  exit /b 1
)
echo       找到系统 Python：%SYSPY%
echo       创建虚拟环境 .venv ...
%SYSPY% -m venv .venv
if errorlevel 1 (
  echo.
  echo   [错误] 创建虚拟环境失败。请确认 Python 安装完整（需要 venv 模块）。
  echo.
  pause
  exit /b 1
)

:env_ready
echo.

REM ==============================================================
REM  [2/4] 依赖（幂等：已经装过会很快返回）
REM ==============================================================
echo [2/4] 检查依赖 websockets / mcp ...
"%PY%" -c "import websockets, mcp" >nul 2>nul
if not errorlevel 1 (
  echo       依赖已就绪，跳过安装
  goto :deps_ready
)

echo       正在安装（首次约 1-2 分钟）...
"%PY%" -m pip install --upgrade pip --quiet --disable-pip-version-check
"%PY%" -m pip install -r requirements.txt --quiet --disable-pip-version-check -i https://pypi.org/simple/
if errorlevel 1 (
  echo.
  echo   [错误] 依赖安装失败。
  echo.
  echo   最常见原因是公司网络要走代理、或默认索引源不通。手动重试：
  echo     "%PY%" -m pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/
  echo.
  echo   若报 SSL 证书问题：
  echo     "%PY%" -m pip install -r requirements.txt --trusted-host pypi.org --trusted-host files.pythonhosted.org
  echo.
  pause
  exit /b 1
)

:deps_ready
echo       依赖就绪
echo.

REM ==============================================================
REM  [3/4] 端口检测 + 注册自启
REM
REM  先看 8765 被谁占着：本机可能已经有 agent 用 stdio 拉起的实例。
REM  那种情况下注册自启会把它顶掉（下次 agent 启动时端口被占、静默退出）。
REM ==============================================================
echo [3/4] 检查端口 %SVC_PORT% 与注册自启 ...
set "PORT_TAKEN="
set "SKIP_REG="
netstat -ano | findstr ":%SVC_PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 set "PORT_TAKEN=1"

if defined PORT_TAKEN (
  echo.
  echo   [注意] 端口 %SVC_PORT% 已被占用。占用者：
  echo.
  powershell -NoProfile -Command "$pids = (Get-NetTCPConnection -LocalPort %SVC_PORT% -State Listen -ErrorAction SilentlyContinue).OwningProcess; if ($pids) { Get-CimInstance Win32_Process | Where-Object { $pids -contains $_.ProcessId } | ForEach-Object { Write-Host ('     PID ' + $_.ProcessId + '   ' + $_.CommandLine) } }" 2>nul
  echo.
  echo   怎么看：
  echo     - 命令行里有 --http 或 --ws-only ：本服务已装过且在跑，会跳过注册
  echo     - 两者都没有                   ：多半是 agent 用 stdio 拉起的实例，
  echo       这种情况建议选 N，先把 agent 那边改成 HTTP 再回来装。
  echo.
  choice /C YN /N /M "  仍然注册「登录后自动启动」吗？(Y=注册 / N=跳过) "
  if errorlevel 2 set "SKIP_REG=1"
  echo.
)

if defined SKIP_REG (
  echo       已跳过注册自启
) else (
  schtasks /Create /TN "%TASK_NAME%" /TR "\"%PYW%\" \"%SRV%\" --http" /SC ONLOGON /RL LIMITED /DELAY 0000:20 /F >nul 2>nul
  if errorlevel 1 (
    echo       计划任务不可用，改用注册表自启 ...
    reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "%TASK_NAME%" /t REG_SZ /d "\"%PYW%\" \"%SRV%\" --http" /f >nul 2>nul
    if errorlevel 1 (
      echo.
      echo   [错误] 自启注册失败（计划任务与注册表都不行）。
      echo   可能被公司安全策略拦截。此时可每次手工双击 start-http-server.bat。
      echo.
      pause
      exit /b 1
    )
    echo       已写入注册表自启项
  ) else (
    echo       已创建计划任务 %TASK_NAME%（登录后延迟 20 秒启动）
  )
)
echo.

REM ==============================================================
REM  [4/4] 启动与自检
REM ==============================================================
echo [4/4] 启动服务并自检 ...
if defined PORT_TAKEN (
  echo       端口已在监听，不重复启动
) else (
  start "" "%PYW%" "%SRV%" --http
  echo       已启动，等待端口就绪 ...
  ping -n 6 127.0.0.1 >nul 2>&1
)

netstat -ano | findstr "127.0.0.1:%SVC_PORT%" | findstr LISTENING >nul
if errorlevel 1 (
  echo.
  echo   [警告] 没看到 %SVC_PORT% 在监听。手动排障（日志会打到屏幕）：
  echo          "%PY%" "%SRV%" --http
  echo.
  goto :done
)
echo       WS   %SVC_PORT% 已监听

set "HTTP_OK="
netstat -ano | findstr "127.0.0.1:8766" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 set "HTTP_OK=1"
if defined HTTP_OK (
  echo       HTTP 8766 已监听（agent 侧指向 http://127.0.0.1:8766/mcp）
) else (
  echo       [警告] HTTP 8766 没在监听，会话会连不上。
  echo              若版本较旧，可能撞上端口被静默忽略的 bug，
  echo              请更新到含 fix(mcp) 的版本后再试。
)

:done
echo.
echo ==============================================================
echo   安装完成
echo ==============================================================
echo.
echo   下一步：
echo     1] 把 ~/.workbuddy/mcp.json 的 browser-bridge 改成
echo        streamableHttp 指向 http://127.0.0.1:8766/mcp
echo     2] 重启 WorkBuddy
echo     3] 打开 Chrome 里的扩展，状态应显示已连接
echo.
echo   常用命令：
echo     查看任务： schtasks /Query /TN "%TASK_NAME%"
echo     完全卸载： 双击 uninstall-local-service.bat
echo.
echo   注意：别用任务管理器乱杀 python 进程，分不清是常驻服务还是
echo         agent 拉起的实例。用 uninstall-local-service.bat，
echo         它只终止带 --http 或 --ws-only 的进程。
echo.
echo ==============================================================
pause
