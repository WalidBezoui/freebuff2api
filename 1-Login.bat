@echo off
title Freebuff Login and Token Extraction
cd /d "%~dp0"
echo ====================================================
echo        Freebuff Token Login and Extraction
echo ====================================================
echo.
python freebuff_tools\extract_freebuff.py login
echo.
pause
