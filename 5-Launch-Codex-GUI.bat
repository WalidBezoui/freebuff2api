@echo off
title Codex Desktop GUI (Freebuff)
cd /d "%~dp0"
if "%FREEBUFF_API_KEY%"=="" set FREEBUFF_API_KEY=freebuff-default-key
echo ====================================================
echo             Launching Codex Desktop GUI
echo ====================================================
echo.
codex app
pause
