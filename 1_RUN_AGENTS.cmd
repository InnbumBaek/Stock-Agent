@echo off
chcp 65001 >nul 2>&1
title PIXEL TRADING FLOOR - 에이전트 실행
cd /d "%~dp0trading-floor"

echo.
echo  ===============================================
echo   에이전트 데스크를 켭니다
echo  ===============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo  [X] Node 가 설치돼 있지 않습니다.
  echo      https://nodejs.org 에서 LTS 를 설치한 뒤 다시 실행하십시오.
  echo.
  pause
  exit /b 1
)

where claude >nul 2>&1
if errorlevel 1 (
  echo  [!] claude CLI 가 없습니다. 데모 모드로만 돌아갑니다.
  echo      브라우저 주소 끝에 ?demo=1 을 붙이십시오:
  echo        http://localhost:8000/?demo=1
  echo.
) else (
  echo  [O] claude CLI 확인
  echo.
)

echo  브라우저가 열립니다. 창을 닫으면 서버가 꺼집니다.
echo.
start "" "http://localhost:8000"
node server\server.js

echo.
echo  서버가 멈췄습니다.
pause
