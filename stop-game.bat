@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=4173"
if not "%~1"=="" set "PORT=%~1"
echo 正在关闭 %PORT% 端口上的游戏服务器...
set "FOUND=0"
set "SEEN=,"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  echo !SEEN! | findstr /C:",%%P," >nul
  if errorlevel 1 (
    taskkill /PID %%P /F >nul 2>nul
    if errorlevel 1 (
      echo   [警告] PID %%P 结束失败，可能权限不足，请手动关闭该窗口。
    ) else (
      echo   已结束进程 PID %%P
    )
    set "SEEN=!SEEN!%%P,"
    set "FOUND=1"
  )
)
if "%FOUND%"=="0" echo   没有发现正在运行的服务。
echo 完成。
echo.
pause