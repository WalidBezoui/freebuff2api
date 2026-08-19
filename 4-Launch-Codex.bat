@echo off
title Codex CLI (DeepSeek V4 Flash)
cd /d "%~dp0"
echo ====================================================
echo    Codex CLI - Powered by DeepSeek V4 Flash
echo ====================================================
echo Provider: Freebuff Local (http://localhost:8787/v1)
echo Model   : deepseek/deepseek-v4-flash
echo ====================================================
echo.

codex -m deepseek/deepseek-v4-flash
pause
