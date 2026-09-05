@echo off
chcp 65001 >nul 2>&1
title Stock-Agent - 아침 리포트
cd /d "%~dp0"

rem ===========================================================
rem  평일 08:50 자동 실행 - 출근하면 리포트가 만들어져 있습니다.
rem
rem  월요일에만 에이전트 분석을 새로 돌립니다. 회수 판단은 하루만에
rem  바뀌는 성격이 아니고, 매일 돌리면 opus 호출이 주 880콜이 됩니다.
rem  화~금은 월요일 판정을 그대로 싣고 숫자만 새로 계산합니다.
rem
rem  대상 시장을 바꾸려면 아래 MARKET 을 KOSPI 로 고치십시오.
rem ===========================================================
set MARKET=KOSDAQ

if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyyMMdd')"') do set STAMP=%%i
for /f %%i in ('powershell -NoProfile -Command "(Get-Date).DayOfWeek"') do set DOW=%%i
set LOG=%~dp0logs\%STAMP%-morning.log

where python >nul 2>&1
if errorlevel 1 (set PY=py) else (set PY=python)

echo ============================================ >> "%LOG%" 2>&1
echo  %DATE% %TIME%  (%DOW%) >> "%LOG%" 2>&1
echo ============================================ >> "%LOG%" 2>&1

if /I "%DOW%"=="Monday" (
  echo [1/2] 에이전트 분석 - 월요일이라 새로 돌립니다 >> "%LOG%" 2>&1
  pushd trading-floor
  node server\export-brief.js --run --mode algo >> "%LOG%" 2>&1
  if errorlevel 1 echo   ^[!^] 분석이 실패했습니다. 지난 판정을 그대로 씁니다. >> "%LOG%" 2>&1
  popd
) else (
  echo [1/2] 에이전트 분석 생략 - 월요일에만 돌립니다 >> "%LOG%" 2>&1
)

echo [2/2] 리포트 생성 (%MARKET%) >> "%LOG%" 2>&1
pushd stock-monitor
%PY% ki_monitor.py report --market %MARKET% --with-agents >> "%LOG%" 2>&1
if errorlevel 1 (
  echo   ^[X^] 리포트 생성 실패 >> "%LOG%" 2>&1
  popd
  exit /b 1
)
popd

echo 완료 >> "%LOG%" 2>&1
exit /b 0
