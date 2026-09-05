@echo off
chcp 65001 >nul 2>&1
title Stock-Agent - 자동 실행
cd /d "%~dp0"

rem ===========================================================
rem  평일 자동 실행을 등록하거나 해제합니다.
rem
rem  등록되는 것은 둘이고, 둘 다 RUN_ALL.cmd 를 부릅니다.
rem
rem    08:50  RUN_ALL.cmd morning   리포트만 (비용 없음)
rem    16:10  RUN_ALL.cmd close     시세 적재 + 금요일엔 분석까지
rem
rem  폴더를 옮기면 등록된 경로가 어긋납니다. 옮기신 뒤에는 이
rem  파일을 한 번 더 돌려 주십시오. 같은 이름으로 덮어씁니다.
rem ===========================================================

echo.
echo  ===============================================
echo   Stock-Agent 자동 실행
echo  ===============================================
echo.
echo   08:50  아침 리포트 생성  ^(평일 매일 . 비용 없음^)
echo   16:10  장 마감 시세 적재  ^(평일 매일^)
echo          + 금요일에는 에이전트 분석까지  ^(40분~1시간^)
echo.
echo   월요일 회의 자료는 금요일 밤에 이미 완성됩니다.
echo   월요일 08:50 은 그것을 리포트로 찍어 내기만 합니다.
echo.
echo   지금 위치: %~dp0
echo.
echo   [1] 등록   [2] 해제   [3] 지금 상태만 보기   [4] 그만두기
echo.
choice /C 1234 /N /M "  번호를 누르십시오: "
if errorlevel 4 goto :end
if errorlevel 3 goto :show
if errorlevel 2 goto :remove

rem ---------------------------------------------------------- 등록
:install
echo.
schtasks /Create /TN "StockAgent-Morning" /TR "\"%~dp0RUN_ALL.cmd\" morning" ^
  /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 08:50 /F
if errorlevel 1 goto :failed

schtasks /Create /TN "StockAgent-AfterClose" /TR "\"%~dp0RUN_ALL.cmd\" close" ^
  /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 16:10 /F
if errorlevel 1 goto :failed

echo.
echo  ===============================================
echo   등록됐습니다.
echo  ===============================================
echo.
echo   기록:  logs 폴더 ^(-morning.log . -close.log^)
echo   해제:  이 파일을 다시 열어 [2]
echo.
echo   * 컴퓨터가 꺼져 있으면 그 시각은 건너뜁니다.
echo     ^(켜져 있고 로그인돼 있어야 돕니다^)
echo   * 금요일에는 17:30 까지 켜 두십시오. 분석이 그때까지 돕니다.
echo   * 원장이 아직 없다면 RUN_ALL.cmd 를 한 번 끝까지 돌리십시오.
echo     원장이 있어야 아침 리포트가 나옵니다.
echo.
echo   지금 한 번 돌려서 되는지 보시겠습니까?
choice /C YN /M "  아침 작업을 지금 실행"
if errorlevel 2 goto :end
schtasks /Run /TN "StockAgent-Morning"
echo.
echo   실행했습니다. logs 폴더의 오늘 날짜 -morning.log 를 열어 보십시오.
goto :end

rem ---------------------------------------------------------- 해제
:remove
echo.
schtasks /Delete /TN "StockAgent-Morning" /F
schtasks /Delete /TN "StockAgent-AfterClose" /F
echo.
echo  해제했습니다. RUN_ALL.cmd 는 그대로 남아 있으니
echo  손으로는 계속 쓸 수 있습니다.
goto :end

rem ---------------------------------------------------------- 상태
:show
echo.
schtasks /Query /TN "StockAgent-Morning" 2>nul
if errorlevel 1 echo   아침 작업: 등록돼 있지 않습니다.
echo.
schtasks /Query /TN "StockAgent-AfterClose" 2>nul
if errorlevel 1 echo   마감 작업: 등록돼 있지 않습니다.
goto :end

rem ---------------------------------------------------------- 실패
:failed
echo.
echo  [X] 등록에 실패했습니다.
echo      이 창을 관리자 권한으로 다시 열어 보십시오.
echo      ^(파일 우클릭 - 관리자 권한으로 실행^)

:end
echo.
pause
