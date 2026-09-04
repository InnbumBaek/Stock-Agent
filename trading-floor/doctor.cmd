@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo Running PIXEL TRADING FLOOR doctor...
echo.
node server\doctor.js
echo.
echo ----------------------------------------
echo Copy everything above and send it back.
echo ----------------------------------------
pause
