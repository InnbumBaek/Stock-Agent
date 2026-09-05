@echo off
chcp 65001 >nul 2>&1
title Stock-Agent - 자동 실행 등록
cd /d "%~dp0"

echo.
echo  ===============================================
echo   평일 자동 실행을 등록합니다
echo  ===============================================
echo.
echo   08:50  아침 리포트 생성  ^(평일 매일 · 비용 없음^)
echo   16:10  장 마감 시세 적재  ^(평일 매일^)
echo          + 금요일에는 에이전트 분석까지  ^(40분~1시간^)
echo.
echo   월요일 회의 자료는 금요일 밤에 이미 완성됩니다.
echo   월요일 08:50 은 그것을 리포트로 찍어 내기만 합니다.
echo.
echo   폴더를 옮기면 다시 등록해야 합니다. 지금 위치:
echo   %~dp0
echo.
pause

schtasks /Create /TN "StockAgent-Morning" /TR "\"%~dp05_MORNING.cmd\"" ^
  /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 08:50 /F
if errorlevel 1 goto :failed

schtasks /Create /TN "StockAgent-AfterClose" /TR "\"%~dp06_AFTER_CLOSE.cmd\"" ^
  /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 16:10 /F
if errorlevel 1 goto :failed

echo.
echo  ===============================================
echo   등록됐습니다.
echo  ===============================================
echo.
echo   확인:  schtasks /Query /TN "StockAgent-Morning"
echo   해제:  REMOVE_SCHEDULE.cmd
echo   기록:  logs 폴더
echo.
echo   * 컴퓨터가 꺼져 있으면 그 시각은 건너뜁니다.
echo     ^(켜져 있고 로그인돼 있어야 돕니다^)
echo   * 금요일에는 17:30 까지 켜 두십시오. 분석이 그때까지 돕니다.
echo.
echo   지금 한 번 돌려서 되는지 보시겠습니까?
choice /C YN /M "  아침 작업을 지금 실행"
if errorlevel 2 goto :end
schtasks /Run /TN "StockAgent-Morning"
echo.
echo   실행했습니다. logs 폴더의 오늘 날짜 파일을 열어 보십시오.
goto :end

:failed
echo.
echo  [X] 등록에 실패했습니다.
echo      이 창을 관리자 권한으로 다시 열어 보십시오.
echo      ^(파일 우클릭 - 관리자 권한으로 실행^)

:end
echo.
pause
