@echo off
chcp 65001 >nul 2>&1
title Stock-Agent - 장 마감 적재
cd /d "%~dp0"

rem ===========================================================
rem  평일 16:10 자동 실행 - 당일 확정 시세를 원장에 넣습니다.
rem
rem  아침 08:50 에는 장이 안 열려 있어 당일 시세가 없습니다.
rem  그래서 적재는 장 마감 뒤에 따로 돌립니다. 이게 없으면
rem  아침 리포트가 매일 하루씩 뒤처집니다.
rem ===========================================================
set MARKET=KOSDAQ

if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyyMMdd')"') do set STAMP=%%i
set LOG=%~dp0logs\%STAMP%-close.log

where python >nul 2>&1
if errorlevel 1 (set PY=py) else (set PY=python)

echo ============================================ >> "%LOG%" 2>&1
echo  %DATE% %TIME% >> "%LOG%" 2>&1
echo ============================================ >> "%LOG%" 2>&1

pushd stock-monitor
%PY% ki_monitor.py daily --market %MARKET% >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%
popd

if not "%RC%"=="0" (
  echo   ^[X^] 적재 실패 - 휴장일이면 정상입니다 >> "%LOG%" 2>&1
  exit /b 1
)
echo 완료 >> "%LOG%" 2>&1
exit /b 0
