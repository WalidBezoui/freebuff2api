@echo off
title Codex CLI (MuseSpark 1.3)
cd /d "%~dp0"
if "%FREEBUFF_API_KEY%"=="" set FREEBUFF_API_KEY=freebuff-master-key
echo ====================================================
echo    Codex CLI - Powered by MuseSpark 1.3
echo ====================================================
echo Vercel  : https://freebuff-api-xi.vercel.app/v1
echo Local   : http://localhost:8787/v1  (run 2-Start-API-Server.bat)
echo Model   : meta/muse-spark-1.3-contributor
echo Auth    : %FREEBUFF_API_KEY% (set env FREEBUFF_API_KEY; provider wired in ~/.codex/config.toml)
echo ====================================================
echo.

codex -m meta/muse-spark-1.3-contributor
pause
