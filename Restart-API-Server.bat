@echo off
title Restart Freebuff2API Server
cd /d "%~dp0"
echo ====================================================
echo            Restarting Freebuff2API Server
echo ====================================================
echo.

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8787" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo Starting fresh server on http://localhost:8787/v1 ...
echo.
node server.js
pause
