@echo off
chcp 65001 >nul 2>&1
title 회의 자료 만들기
cd /d "%~dp0stock-monitor"

where python >nul 2>&1
if errorlevel 1 (set PY=py) else (set PY=python)

echo.
echo  ===============================================
echo   회의 자료(HTML)를 만듭니다
echo  ===============================================
echo.

%PY% ki_monitor.py report --market KOSDAQ --with-agents
if errorlevel 1 (
  echo.
  echo  [X] 실패했습니다. 2_SETUP_LEDGER.cmd 를 먼저 끝내셨는지 확인하십시오.
  pause
  exit /b 1
)

echo.
echo  out 폴더에 HTML 이 만들어졌습니다. 엽니다.
for /f "delims=" %%f in ('dir /b /o-d out\KI_exit_*.html 2^>nul') do (
  start "" "out\%%f"
  goto :opened
)
echo  [!] out 폴더에서 HTML 을 찾지 못했습니다.
:opened
pause
