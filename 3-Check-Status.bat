@echo off
title Freebuff Live Account and Quota Monitor
cd /d "%~dp0"
python freebuff_tools\monitor_status.py
pause
