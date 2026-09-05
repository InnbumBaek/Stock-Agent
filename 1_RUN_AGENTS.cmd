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
  echo  [X] Node 가 없습니다. 에이전트 화면은 Node 로 돕니다.
  echo      ^(파이썬은 나중에 원장 만들 때 쓰고, 지금은 안 씁니다^)
  echo.
  where choco >nul 2>&1
  if errorlevel 1 (
    echo      https://nodejs.org 에서 LTS 를 받아 설치하십시오.
  ) else (
    echo      초콜리티가 있으니 이게 제일 빠릅니다.
    echo      관리자 권한 PowerShell 을 열고:
    echo.
    echo          choco install nodejs-lts -y
    echo.
  )
  echo      설치한 뒤에는 이 창을 닫고 새로 열어야 합니다 ^(PATH 반영^).
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
