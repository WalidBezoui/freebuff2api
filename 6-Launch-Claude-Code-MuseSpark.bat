@echo off
title Claude Code (MuseSpark 1.3)
cd /d "%~dp0"
if "%FREEBUFF_API_KEY%"=="" set FREEBUFF_API_KEY=freebuff-master-key
echo ====================================================
echo      Claude Code - Powered by MuseSpark 1.3
echo ====================================================
echo Endpoint: https://freebuff-api-xi.vercel.app
echo API Key : %FREEBUFF_API_KEY%
echo Model   : meta/muse-spark-1.3-contributor (MuseSpark 1.3 Agent)
echo ====================================================
echo.

set ANTHROPIC_BASE_URL=https://freebuff-api-xi.vercel.app
set ANTHROPIC_API_KEY=%FREEBUFF_API_KEY%
set ANTHROPIC_MODEL=meta/muse-spark-1.3-contributor
set ANTHROPIC_SMALL_FAST_MODEL=deepseek/deepseek-v4-flash
set ANTHROPIC_DEFAULT_SONNET_MODEL=meta/muse-spark-1.3-contributor
set ANTHROPIC_DEFAULT_OPUS_MODEL=meta/muse-spark-1.3-contributor
set ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek/deepseek-v4-flash
set CLAUDE_CODE_EFFORT_LEVEL=high
set MAX_THINKING_TOKENS=32000
set CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=true
set CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
set ANTHROPIC_CUSTOM_MODEL_OPTION=meta/muse-spark-1.3-contributor
set ANTHROPIC_CUSTOM_MODEL_OPTION_NAME=MuseSpark 1.3 Agent

if exist "%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe" (
  "%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
) else (
  claude %*
)
pause
