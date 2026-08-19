@echo off
title Stop Freebuff2API Server
cd /d "%~dp0"
echo ====================================================
echo             Stopping Freebuff2API Server
echo ====================================================
echo.

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8787" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo Server on port 8787 stopped!
echo.
pause
