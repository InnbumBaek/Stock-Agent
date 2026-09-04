@echo off
chcp 65001 >nul 2>&1
title 에이전트 분석 - 포트폴리오사
cd /d "%~dp0trading-floor"

echo.
echo  ===============================================
echo   에이전트 16명이 포트폴리오사를 분석합니다
echo  ===============================================
echo.
echo  config.json 의 워치리스트를 대상으로 돕니다.
echo  종목당 claude opus 를 최대 16번 부릅니다 - 수 분씩 걸립니다.
echo.

where claude >nul 2>&1
if errorlevel 1 (
  echo  [!] claude CLI 가 없습니다. 데모(가짜 응답)로 배선만 확인합니다.
  echo.
  pause
  node server\export-brief.js --run --demo --mode algo
  goto :done
)

echo  [1] 배선 확인 - 데모로 한 번  ^(무료^)
echo  [2] 실전 - claude 를 실제로 부릅니다  ^(시간·비용^)
echo.
set /p CHOICE=  번호를 넣고 Enter:

if "%CHOICE%"=="1" (
  node server\export-brief.js --run --demo --mode algo
) else (
  node server\export-brief.js --run --mode algo
)

:done
echo.
echo  끝났습니다. 이제 4_REPORT.cmd 를 실행하십시오.
pause
