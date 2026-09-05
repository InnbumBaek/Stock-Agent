@echo off
chcp 65001 >nul 2>&1
title Stock-Agent - 장 마감 적재
cd /d "%~dp0"

rem ===========================================================
rem  평일 16:10 자동 실행
rem
rem   월~목 : 당일 확정 시세를 원장에 넣습니다.
rem   금    : 적재 + 에이전트 분석까지 (40분~1시간 더 걸립니다)
rem
rem  아침 08:50 에는 장이 안 열려 있어 당일 시세가 없습니다.
rem  그래서 적재는 장 마감 뒤에 돌립니다. 이게 없으면 아침 리포트가
rem  매일 하루씩 뒤처집니다.
rem
rem  분석을 금요일에 두는 이유 - 월요일 회의 자료를 주말 동안 완성해
rem  두기 위해서입니다. 월요일 아침에 돌리면 회의 직전에 한 시간이
rem  걸리고, 그 분석이 보는 원장은 어차피 금요일 종가입니다.
rem
rem  ** 금요일에는 컴퓨터를 17:30 까지 켜 두십시오. **
rem ===========================================================
set MARKET=KOSDAQ

if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set STAMP=%%i
set LOG=%~dp0logs\%STAMP%-close.log

where python >nul 2>&1
if errorlevel 1 (set PY=py) else (set PY=python)

echo ============================================ >> "%LOG%" 2>&1
echo  %DATE% %TIME% >> "%LOG%" 2>&1
echo ============================================ >> "%LOG%" 2>&1

for /f %%i in ('powershell -NoProfile -Command "(Get-Date).DayOfWeek"') do set DOW=%%i

echo [1/2] 시세 적재 (%MARKET%) >> "%LOG%" 2>&1
pushd stock-monitor
%PY% ki_monitor.py daily --market %MARKET% >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%
popd

if not "%RC%"=="0" (
  echo   ^[!^] 적재 보류 - 휴장일이면 정상입니다 >> "%LOG%" 2>&1
  echo       직전 영업일 원장으로 이어서 진행합니다. >> "%LOG%" 2>&1
)

if /I not "%DOW%"=="Friday" (
  echo [2/2] 에이전트 분석 생략 - 금요일에만 돌립니다 >> "%LOG%" 2>&1
  echo 완료 >> "%LOG%" 2>&1
  exit /b 0
)

echo [2/2] 에이전트 분석 - 월요일 회의 자료용 ^(40분~1시간^) >> "%LOG%" 2>&1
echo      시작 %TIME% >> "%LOG%" 2>&1
pushd trading-floor
node server\export-brief.js --run --mode algo >> "%LOG%" 2>&1
if errorlevel 1 (
  echo   ^[!^] 분석 실패 - 지난주 판정이 그대로 실립니다. >> "%LOG%" 2>&1
  echo       월요일 회의 전에 3_ANALYZE.cmd 를 직접 돌리십시오. >> "%LOG%" 2>&1
)
popd
echo      종료 %TIME% >> "%LOG%" 2>&1

echo 완료 >> "%LOG%" 2>&1
exit /b 0
