@echo off
chcp 65001 >nul 2>&1
title Stock-Agent - 자동 실행 해제
echo.
echo  자동 실행을 해제합니다.
echo.
schtasks /Delete /TN "StockAgent-Morning" /F
schtasks /Delete /TN "StockAgent-AfterClose" /F
echo.
echo  해제했습니다. 스크립트는 그대로 남아 있으니 수동으로는 계속 쓸 수 있습니다.
echo.
pause
