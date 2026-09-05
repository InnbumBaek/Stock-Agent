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
rem    RUN_ALL.cmd auto     묻지 않고 끝까지
rem    RUN_ALL.cmd noai     에이전트를 건너뛰고 숫자 리포트만
rem
rem  중간에 죽어도 다시 돌리면 이어서 갑니다. 원장이 이미 있으면
rem  40분짜리 최초 적재를 다시 하지 않고 하루치만 갱신합니다.
rem
rem  ---- 아래 둘은 SCHEDULE.cmd 가 부르는 것입니다. 손으로 누를
rem       일은 없지만, 자동 실행이 하는 일을 직접 확인하고 싶으면
rem       그대로 쳐 보셔도 됩니다.
rem
rem    RUN_ALL.cmd morning  리포트만 만든다        (평일 08:50)
rem    RUN_ALL.cmd close    시세 적재 + 금요일 분석 (평일 16:10)
rem
rem  대상 시장을 바꾸려면 아래 MARKET 을 KOSPI 로 고치십시오.
rem  네 갈래 전부 이 한 줄을 씁니다.
rem ===========================================================
set MARKET=KOSDAQ
set MODE=%~1
if "%MODE%"=="" set MODE=ask

if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set STAMP=%%i
set LOGNAME=runall
if /I "%MODE%"=="morning" set LOGNAME=morning
if /I "%MODE%"=="close" set LOGNAME=close
set LOG=%~dp0logs\%STAMP%-%LOGNAME%.log

where python >nul 2>&1
if errorlevel 1 (set PY=py) else (set PY=python)

rem  스케줄러가 부르는 두 갈래는 사람에게 물어보지 않고 곧장 갑니다.
if /I "%MODE%"=="morning" goto :auto_morning
if /I "%MODE%"=="close" goto :auto_close

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
  call :fail "필수 API 를 부르지 못했습니다." "위 진단을 보십시오. 전부 막혀 있으면 사내 방화벽입니다 - docs\NETWORK.md 를 전산팀에 주십시오."
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
node -e "const fs=require('fs');const p='config.json';let c={};try{c=JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){c={}};c.ki=Object.assign({},c.ki,{enabled:true});if(Array.isArray(c.watchlist)===false)c.watchlist=[];fs.writeFileSync(p,JSON.stringify(c,null,2));" >> "%LOG%" 2>&1
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
  call :say "     [알림] 분석이 실패했습니다. 지난 판정이 있으면 그대로 싣고 계속합니다."
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
call :say "   매일 자동으로 돌리시려면 SCHEDULE.cmd"
call :say "   기록은 logs\%STAMP%-runall.log"
goto :end

rem ---------------------------------------------------------- 실패 경로
:ingest_failed
popd
call :fail "원장 적재가 실패했습니다." "401 이 보이면 KRX 에서 '서비스별 URL 사용신청'을 안 하신 겁니다. 키 문제가 아닙니다."
goto :end

rem ==========================================================
rem  스케줄러 전용 - 평일 08:50  리포트만 만든다
rem
rem  여기서는 분석을 돌리지 않습니다. 에이전트 분석은 금요일 장
rem  마감 뒤(:auto_close)에 끝내 둡니다. 월요일 아침에 돌리면 회의
rem  직전에 한 시간이 걸리고, 그 분석이 보는 원장은 어차피 금요일
rem  종가입니다 - 주말에는 장이 안 열립니다.
rem
rem  그래서 월요일 회의 자료는 [금요일 종가 + 금요일 판정]이고,
rem  그것이 월요일 장 시작 전 시점의 최신입니다.
rem ==========================================================
:auto_morning
for /f %%i in ('powershell -NoProfile -Command "(Get-Date).DayOfWeek"') do set DOW=%%i
call :say "============================================"
call :say " %DATE% %TIME%  (%DOW%)  -  아침 리포트"
call :say "============================================"
if /I "%DOW%"=="Monday" call :say " ** 회의 있는 날 - 금요일 분석이 실린 자료를 만듭니다 **"
pushd stock-monitor
%PY% ki_monitor.py report --market %MARKET% --with-agents >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%
popd
if not "%RC%"=="0" (
  call :say "  [X] 리포트 생성 실패 - 위 기록의 마지막 줄을 보십시오."
  exit /b 1
)
call :say "완료"
exit /b 0

rem ==========================================================
rem  스케줄러 전용 - 평일 16:10  시세 적재, 금요일엔 분석까지
rem
rem  아침 08:50 에는 장이 안 열려 있어 당일 시세가 없습니다. 그래서
rem  적재는 장 마감 뒤에 돌립니다. 이게 없으면 아침 리포트가 매일
rem  하루씩 뒤처집니다.
rem
rem  ** 금요일에는 컴퓨터를 17:30 까지 켜 두십시오. **
rem ==========================================================
:auto_close
for /f %%i in ('powershell -NoProfile -Command "(Get-Date).DayOfWeek"') do set DOW=%%i
call :say "============================================"
call :say " %DATE% %TIME%  (%DOW%)  -  장 마감 적재"
call :say "============================================"
call :say "[1/2] 시세 적재 (%MARKET%)"
pushd stock-monitor
%PY% ki_monitor.py daily --market %MARKET% >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%
popd
if not "%RC%"=="0" (
  call :say "  [알림] 적재 보류 - 휴장일이면 정상입니다."
  call :say "      직전 영업일 원장으로 이어서 진행합니다."
)
if /I not "%DOW%"=="Friday" (
  call :say "[2/2] 에이전트 분석 생략 - 금요일에만 돌립니다."
  call :say "완료"
  exit /b 0
)
call :say "[2/2] 에이전트 분석 - 월요일 회의 자료용 (40분~1시간)"
call :say "      시작 %TIME%"
pushd trading-floor
node server\export-brief.js --run --mode algo >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%
popd
if not "%RC%"=="0" (
  call :say "  [알림] 분석 실패 - 지난주 판정이 그대로 실립니다."
  call :say "      월요일 회의 전에 RUN_ALL.cmd 를 직접 돌리십시오."
)
call :say "      종료 %TIME%"
call :say "완료"
exit /b 0

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
if /I "%MODE%"=="auto" goto :nopause
if /I "%MODE%"=="morning" goto :nopause
if /I "%MODE%"=="close" goto :nopause
pause
:nopause
endlocal
