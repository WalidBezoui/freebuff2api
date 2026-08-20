@echo off
title Freebuff2API Local Server
cd /d "%~dp0"
echo ====================================================
echo             Freebuff2API Local Server
echo ====================================================
echo Base URL: http://localhost:8787/v1
echo API Key : (set FREEBUFF_API_KEY in .env — required since v1.9.2, no default key)
echo Health  : http://localhost:8787/healthz
echo ====================================================
echo.
node server.js
pause
