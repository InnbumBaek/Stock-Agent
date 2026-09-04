@echo off
chcp 65001 >nul 2>&1
title 원장 만들기 (최초 1회 - 약 40분)
cd /d "%~dp0stock-monitor"

echo.
echo  ===============================================
echo   원장(ki.sqlite)을 만듭니다 - 최초 1회
echo   포트폴리오사를 분석하려면 이것이 있어야 합니다
echo  ===============================================
echo.
echo  약 40분 걸립니다. 창을 닫지 마십시오.
echo.
pause

where python >nul 2>&1
if errorlevel 1 (set PY=py) else (set PY=python)

echo.
echo  [1/5] 파이썬 패키지 설치
%PY% -m pip install --quiet pandas numpy scipy requests lxml
if errorlevel 1 (
  echo  [X] 설치 실패. 파이썬이 설치돼 있는지 확인하십시오.
  echo      https://www.python.org  ^(설치할 때 Add to PATH 를 켜십시오^)
  pause
  exit /b 1
)

echo.
echo  [2/5] 준비 상태 점검
%PY% ki_monitor.py doctor
echo.
echo  위에 X 가 있으면 여기서 멈추고 알려 주십시오.
pause

echo.
echo  [3/5] 코스닥 시세 적재 (약 15분)
%PY% ki_monitor.py ingest --from 20250101 --universe KOSDAQ
if errorlevel 1 goto :failed

echo.
echo  [4/5] 코스피 시세 적재 (약 15분)
%PY% ki_monitor.py ingest --from 20250101 --universe KOSPI
if errorlevel 1 goto :failed

echo.
echo  [5/5] 재무 적재 (약 10분)
%PY% ki_monitor.py fundamentals --market KOSDAQ
%PY% ki_monitor.py fundamentals --market KOSPI

echo.
echo  원장 연동을 켭니다.
cd /d "%~dp0trading-floor"
node -e "const fs=require('fs');const p='config.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));c.ki=Object.assign({},c.ki,{enabled:true});fs.writeFileSync(p,JSON.stringify(c,null,2));console.log('  config.json - 원장 연동 켬');"

echo.
echo  ===============================================
echo   끝났습니다. 이제 3_ANALYZE.cmd 를 실행하십시오.
echo  ===============================================
pause
exit /b 0

:failed
echo.
echo  [X] 적재가 실패했습니다.
echo      401 이 보이면 KRX 에서 '서비스별 URL 사용신청'을 안 하신 겁니다.
echo      키 발급과 사용신청은 별개입니다.
pause
exit /b 1
