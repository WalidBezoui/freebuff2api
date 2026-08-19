@echo off
title Freebuff2API Local Server
cd /d "%~dp0"
echo ====================================================
echo             Freebuff2API Local Server
echo ====================================================
echo Base URL: http://localhost:8787/v1
echo API Key : freebuff-default-key
echo Health  : http://localhost:8787/healthz
echo ====================================================
echo.
node server.js
pause
