@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=4173"
if not "%~1"=="" set "PORT=%~1"
set "URL=http://localhost:%PORT%/"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 node。请先安装 Node.js 18+ 并确保它在 PATH 里。
  echo.
  pause
  exit /b 1
)

echo ======== 1/4 关闭 %PORT% 端口上残留的旧服务 ========
call :killport
echo.

echo ======== 2/4 构建前端产物 ========
node tools\build.mjs
if errorlevel 1 (
  echo [错误] 构建失败，已中止。
  echo.
  pause
  exit /b 1
)
echo.

echo ======== 3/4 启动静态服务器 ========
start "TankServer-%PORT%" /min node tools\serve.mjs dist
call :waitport
if errorlevel 1 (
  echo [错误] 服务器在 15 秒内没有就绪，请检查 %PORT% 端口是否被别的程序占用。
  echo.
  pause
  exit /b 1
)
echo 服务已就绪：%URL%
echo.

echo ======== 4/4 打开游戏网页 ========
start "" "%URL%"
echo 已打开 %URL%
echo.
echo 服务器跑在标题为 TankServer-%PORT% 的最小化窗口里；
echo 关掉那个窗口，或运行 stop-game.bat，就能停掉服务。
echo 调试用地址：%URL%?seed=20251022^&wind=3
echo 远端联调（两个标签页各开一次）：%URL%?mode=remote^&seat=left^&net=broadcast^&room=test
echo.
pause
exit /b 0

:killport
set "FOUND=0"
set "SEEN=,"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  echo !SEEN! | findstr /C:",%%P," >nul
  if errorlevel 1 (
    taskkill /PID %%P /F >nul 2>nul
    if errorlevel 1 (
      echo   [警告] PID %%P 结束失败，可能权限不足，请手动关闭该窗口。
    ) else (
      echo   已结束残留进程 PID %%P
    )
    set "SEEN=!SEEN!%%P,"
    set "FOUND=1"
  )
)
if "%FOUND%"=="0" echo   没有发现残留服务，直接启动。
exit /b 0

:waitport
for /l %%I in (1,1,15) do (
  timeout /t 1 /nobreak >nul
  netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul
  if not errorlevel 1 exit /b 0
)
exit /b 1