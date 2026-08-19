@echo off
title Claude Code (Freebuff)
cd /d "%~dp0"
echo ====================================================
echo             Claude Code - Powered by Freebuff
echo ====================================================
echo Endpoint: http://localhost:8787
echo API Key : freebuff-default-key
echo ====================================================
echo.

set ANTHROPIC_BASE_URL=http://localhost:8787
set ANTHROPIC_API_KEY=freebuff-default-key

if exist "%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe" (
  "%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
) else (
  claude %*
)
pause
