@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
title Stock-Agent - 전체 실행
cd /d "%~dp0"

rem ===========================================================
rem  전체 과정을 한 번에 돌립니다.
rem
rem    RUN_ALL.cmd          물어보면서 진행 (처음이면 이것)
rem    RUN_ALL.cmd demo     에이전트를 데모(가짜 응답)로 - 무료
rem    RUN_ALL.cmd auto     묻지 않고 끝까지 - 스케줄러용
rem    RUN_ALL.cmd noai     에이전트를 건너뛰고 숫자 리포트만
rem
rem  중간에 죽어도 다시 돌리면 이어서 갑니다. 원장이 이미 있으면
rem  40분짜리 최초 적재를 다시 하지 않고 하루치만 갱신합니다.
rem ===========================================================
set MARKET=KOSDAQ
set MODE=%~1
if "%MODE%"=="" set MODE=ask

if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set STAMP=%%i
set LOG=%~dp0logs\%STAMP%-runall.log

where python >nul 2>&1
if errorlevel 1 (set PY=py) else (set PY=python)

call :say ""
call :say "  ==============================================="
call :say "   Stock-Agent 전체 실행   (기록: logs\%STAMP%-runall.log)"
call :say "  ==============================================="
call :say ""

rem ---------------------------------------------------------- 0. 환경
call :stage "0/5" "환경 점검"
where node >nul 2>&1
if errorlevel 1 (
  call :fail "Node 가 없습니다." "nodejs.org 에서 LTS 를 설치한 뒤 이 창을 닫고 새로 여십시오."
  goto :end
)
%PY% --version >nul 2>&1
if errorlevel 1 (
  call :fail "파이썬을 찾지 못했습니다." "python.org 에서 설치(Add to PATH 켜기) 후 창을 새로 여십시오."
  goto :end
)
%PY% -m pip install --quiet pandas numpy scipy requests lxml >> "%LOG%" 2>&1
if errorlevel 1 (
  call :fail "파이썬 패키지 설치 실패" "logs 폴더의 오늘 기록을 보십시오."
  goto :end
)
call :ok "Node · 파이썬 · 패키지"

rem ---------------------------------------------------------- 1. API
call :stage "1/5" "API 진단"
pushd stock-monitor
%PY% ki_monitor.py diagnose > "%TEMP%\sa_diag.txt" 2>&1
set DIAG=%ERRORLEVEL%
popd
type "%TEMP%\sa_diag.txt"
type "%TEMP%\sa_diag.txt" >> "%LOG%" 2>&1
if not "%DIAG%"=="0" (
  call :fail "필수 API 를 부르지 못했습니다." "위 진단을 보십시오. 전부 막혀 있으면 사내 방화벽입니다 - NETWORK.md 를 전산팀에 주십시오."
  goto :end
)
call :ok "필수 API 정상"

rem ---------------------------------------------------------- 2. 원장
call :stage "2/5" "원장"
if exist "stock-monitor\ki.sqlite" (
  call :say "     이미 있습니다. 하루치만 갱신합니다 (1~2분)"
  pushd stock-monitor
  %PY% ki_monitor.py daily --market %MARKET% >> "%LOG%" 2>&1
  popd
  call :ok "원장 갱신"
) else (
  call :say "     처음입니다. 최초 적재를 합니다 - 약 40분 걸립니다."
  call :say "     창을 닫지 마십시오. 한 번만 하면 됩니다."
  call :say ""
  pushd stock-monitor
  %PY% ki_monitor.py ingest --from 20250101 --universe KOSDAQ >> "%LOG%" 2>&1
  if errorlevel 1 goto :ingest_failed
  %PY% ki_monitor.py ingest --from 20250101 --universe KOSPI >> "%LOG%" 2>&1
  if errorlevel 1 goto :ingest_failed
  %PY% ki_monitor.py fundamentals --market KOSDAQ >> "%LOG%" 2>&1
  %PY% ki_monitor.py fundamentals --market KOSPI >> "%LOG%" 2>&1
  popd
  call :ok "원장 생성"
)

rem ---------------------------------------------------------- 3. 설정
call :stage "3/5" "원장 연동 켜기"
pushd trading-floor
node -e "const fs=require('fs');const p='config.json';let c={};try{c=JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){c={}};c.ki=Object.assign({},c.ki,{enabled:true});if(!Array.isArray(c.watchlist))c.watchlist=[];fs.writeFileSync(p,JSON.stringify(c,null,2));" >> "%LOG%" 2>&1
popd
call :ok "config.json"

rem ---------------------------------------------------------- 4. 에이전트
call :stage "4/5" "에이전트 분석"
if /I "%MODE%"=="noai" (
  call :say "     건너뜁니다 (noai). 지난 판정이 있으면 그대로 실립니다."
  goto :report
)
set AIARG=--run --mode algo
if /I "%MODE%"=="demo" set AIARG=--run --demo --mode algo
if /I "%MODE%"=="ask" (
  where claude >nul 2>&1
  if errorlevel 1 (
    call :say "     claude CLI 가 없어 데모로 돌립니다."
    call :say "     진짜로 돌리시려면 - 관리자 PowerShell 에서:"
    call :say "         npm install -g @anthropic-ai/claude-code"
    call :say "     그다음 아무 창에서 claude 를 한 번 실행해 로그인하십시오."
    set AIARG=--run --demo --mode algo
  ) else (
    call :say "     [1] 데모로 배선만 확인   (무료, 1분)"
    call :say "     [2] 실전 - claude 를 실제로 부릅니다  (종목당 수 분)"
    call :say "     [3] 건너뛰기"
    set /p CH=     번호를 넣고 Enter: 
    if "!CH!"=="1" set AIARG=--run --demo --mode algo
    if "!CH!"=="3" (
      call :say "     건너뜁니다."
      goto :report
    )
  )
)
call :say "     실행: node server\export-brief.js !AIARG!"
pushd trading-floor
node server\export-brief.js !AIARG! >> "%LOG%" 2>&1
if errorlevel 1 (
  call :say "     ^[!^] 분석이 실패했습니다. 지난 판정이 있으면 그대로 싣고 계속합니다."
) else (
  call :ok "에이전트 분석"
)
popd

rem ---------------------------------------------------------- 5. 리포트
:report
call :stage "5/5" "회의 자료"
pushd stock-monitor
%PY% ki_monitor.py report --market %MARKET% --with-agents >> "%LOG%" 2>&1
if errorlevel 1 (
  popd
  call :fail "리포트 생성 실패" "logs 폴더의 오늘 기록 마지막 줄을 보십시오."
  goto :end
)
for /f "delims=" %%f in ('dir /b /o-d out\KI_exit_*.html 2^>nul') do (
  call :ok "out\%%f"
  if /I not "%MODE%"=="auto" start "" "out\%%f"
  goto :done
)
:done
popd

call :say ""
call :say "  ==============================================="
call :say "   끝났습니다."
call :say "  ==============================================="
call :say ""
call :say "   매일 자동으로 돌리시려면 INSTALL_SCHEDULE.cmd"
call :say "   기록은 logs\%STAMP%-runall.log"
goto :end

rem ---------------------------------------------------------- 실패 경로
:ingest_failed
popd
call :fail "원장 적재가 실패했습니다." "401 이 보이면 KRX 에서 '서비스별 URL 사용신청'을 안 하신 겁니다. 키 문제가 아닙니다."
goto :end

rem ---------------------------------------------------------- 유틸
:say
echo %~1
echo %~1 >> "%LOG%" 2>&1
exit /b 0

:stage
call :say ""
call :say "  [%~1] %~2"
exit /b 0

:ok
call :say "      O  %~1"
exit /b 0

:fail
call :say ""
call :say "      X  %~1"
call :say "         %~2"
exit /b 0

:end
if /I not "%MODE%"=="auto" pause
endlocal
