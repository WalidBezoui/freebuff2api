@echo off
title Codex CLI (DeepSeek V4 Flash)
cd /d "%~dp0"
if "%FREEBUFF_API_KEY%"=="" set FREEBUFF_API_KEY=freebuff-default-key
echo ====================================================
echo    Codex CLI - Powered by DeepSeek V4 Flash
echo ====================================================
echo Vercel  : https://freebuff2api-walid-bezouis-projects-fc73dfba.vercel.app/v1
echo Local   : http://localhost:8787/v1  (run 2-Start-API-Server.bat)
echo Model   : deepseek/deepseek-v4-flash
echo Auth    : %FREEBUFF_API_KEY% (set env FREEBUFF_API_KEY; provider wired in ~/.codex/config.toml)
echo ====================================================
echo.

codex -m deepseek/deepseek-v4-flash
pause
