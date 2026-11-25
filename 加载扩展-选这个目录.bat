@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

title Browser Bridge - 加载扩展（别选错目录）

set "EXT_DIR=%~dp0extension"
if "%EXT_DIR:~-1%"=="\" set "EXT_DIR=%EXT_DIR:~0,-1%"

echo ==============================================================
echo   Browser Bridge   加载扩展
echo ==============================================================
echo.

if not exist "%EXT_DIR%\manifest.json" (
  echo   [错误] 找不到 extension\manifest.json
  echo.
  echo   本脚本必须和 extension 文件夹放在同一层。
  echo   当前查找位置：%EXT_DIR%
  echo.
  pause
  exit /b 1
)

echo   要加载的目录（已复制到剪贴板）：
echo.
echo     %EXT_DIR%
echo.

REM 把路径塞进剪贴板 —— 待会儿在「选择文件夹」对话框里直接 Ctrl+V 粘贴，
REM 省得一层层点进去（这是选错目录最常见的原因）。
echo %EXT_DIR%| clip

echo --------------------------------------------------------------
echo   ★ 常见错误：选成了外层 browser-bridge 目录
echo.
echo     外层目录里没有 manifest.json，Chrome 会报
echo     「清单文件缺失或不可读取 / 无法加载清单」。
echo     manifest.json 在 extension\ 里面，必须选它。
echo --------------------------------------------------------------
echo.
echo   接下来三步：
echo     1. 本脚本会打开 chrome://extensions
echo     2. 打开右上角「开发者模式」
echo     3. 点「加载已解压的扩展程序」-^> 在弹出的选择框里按 Ctrl+V 粘贴路径
echo        （粘贴后按回车，再点「选择文件夹」）
echo.
echo   如果加载后扩展 ID 不是下面这个，说明你选错目录了：
echo     ejajjndahiklljjjpnmefhmbinaegkdc
echo.
pause

start "" chrome.exe "chrome://extensions" 2>nul
if errorlevel 1 (
  echo   [提示] 没能自动打开 Chrome，请手动在地址栏输入：chrome://extensions
)

echo.
echo   剪贴板内容 = %EXT_DIR%
echo   可随时按 Ctrl+V 粘贴使用。
echo.
pause
