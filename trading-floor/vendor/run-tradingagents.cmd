@echo off
REM ---------------------------------------------------------------------------
REM run-tradingagents.cmd  -  run a TradingAgents analysis via the local shim.
REM
REM Usage:   run-tradingagents.cmd [TICKER] [YYYY-MM-DD]
REM Example: run-tradingagents.cmd AAPL 2026-07-24
REM
REM Start the shim FIRST in another window:  start-shim.cmd
REM ---------------------------------------------------------------------------
cd /d "%~dp0"
call ta-venv\Scripts\activate.bat
python run-local.py %1 %2
