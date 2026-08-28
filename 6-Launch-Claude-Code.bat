@echo off
title Claude Code (Freebuff)
cd /d "%~dp0"
if "%FREEBUFF_API_KEY%"=="" set FREEBUFF_API_KEY=freebuff-default-key
echo ====================================================
echo             Claude Code - Powered by Freebuff
echo ====================================================
echo Endpoint: https://freebuff2api-walid-bezouis-projects-fc73dfba.vercel.app
echo API Key : %FREEBUFF_API_KEY%  (set env FREEBUFF_API_KEY — required since v1.9.2)
echo Model   : deepseek/deepseek-v4-flash (effort max, small-fast-model = flash)
echo ====================================================
echo.

set ANTHROPIC_BASE_URL=https://freebuff2api-walid-bezouis-projects-fc73dfba.vercel.app
set ANTHROPIC_API_KEY=%FREEBUFF_API_KEY%
set ANTHROPIC_MODEL=deepseek/deepseek-v4-flash
set ANTHROPIC_SMALL_FAST_MODEL=deepseek/deepseek-v4-flash
set ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek/deepseek-v4-flash
set ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek/deepseek-v4-flash
set ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek/deepseek-v4-flash
set CLAUDE_CODE_EFFORT_LEVEL=max
set MAX_THINKING_TOKENS=32000
set CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=true
set CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
set ANTHROPIC_CUSTOM_MODEL_OPTION=deepseek/deepseek-v4-flash
set ANTHROPIC_CUSTOM_MODEL_OPTION_NAME=DeepSeek V4 Flash (max)

if exist "%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe" (
  "%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
) else (
  claude %*
)
pause