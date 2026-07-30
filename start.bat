@echo off
title Naturan WhatsApp Siparis Bildirim Paneli
cd /d "%~dp0"

echo.
echo =============================================================
echo    Naturan WhatsApp Siparis Bildirim Paneli Baslatiliyor...
echo =============================================================
echo.

python public\server.py

pause
