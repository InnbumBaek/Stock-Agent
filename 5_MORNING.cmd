@echo off
chcp 65001 >nul 2>&1
title Stock-Agent - 아침 리포트
cd /d "%~dp0"

rem ===========================================================
rem  평일 08:50 자동 실행 - 출근하면 리포트가 만들어져 있습니다.
rem
rem  여기서는 분석을 돌리지 않습니다. 리포트만 만듭니다.
rem
rem  에이전트 분석은 금요일 장 마감 뒤에 끝내 둡니다(6_AFTER_CLOSE).
rem  월요일 아침에 돌리면 회의 직전에 40분~1시간이 걸리고, 그 분석이
rem  보는 원장은 어차피 금요일 종가입니다. 주말에는 장이 안 열립니다.
rem
rem  그래서 월요일 회의 자료는 [금요일 종가 + 금요일 판정]이고,
rem  그것이 월요일 장 시작 전 시점의 최신입니다.
rem
rem  대상 시장을 바꾸려면 아래 MARKET 을 KOSPI 로 고치십시오.
rem ===========================================================
set MARKET=KOSDAQ

if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set STAMP=%%i
for /f %%i in ('powershell -NoProfile -Command "(Get-Date).DayOfWeek"') do set DOW=%%i
set LOG=%~dp0logs\%STAMP%-morning.log

where python >nul 2>&1
if errorlevel 1 (set PY=py) else (set PY=python)

echo ============================================ >> "%LOG%" 2>&1
echo  %DATE% %TIME%  (%DOW%) >> "%LOG%" 2>&1
echo ============================================ >> "%LOG%" 2>&1

if /I "%DOW%"=="Monday" (
  echo  ** 회의 있는 날 - 금요일 분석이 실린 자료를 만듭니다 ** >> "%LOG%" 2>&1
)

echo 리포트 생성 (%MARKET%) >> "%LOG%" 2>&1
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
