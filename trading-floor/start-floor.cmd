@echo off
chcp 65001 >nul 2>&1
rem PIXEL TRADING FLOOR launcher - opens browser and starts the server.
rem To change the agent model, uncomment the next line (default: opus)
rem set FLOOR_MODEL=sonnet
cd /d "%~dp0"
start "" "http://localhost:8000"
node server\server.js
