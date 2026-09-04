@echo off
REM ---------------------------------------------------------------------------
REM start-shim.cmd  -  launch the OpenAI-compatible Claude proxy (port 8787).
REM
REM Every /v1/chat/completions request is answered by `claude -p`, using the
REM machine's Claude Max subscription quota (no OpenAI API billing).
REM
REM Cheap/fast testing:   set SHIM_MODEL=haiku  &  start-shim.cmd
REM Change port:          set SHIM_PORT=9000    &  start-shim.cmd
REM ---------------------------------------------------------------------------
cd /d "%~dp0.."
if "%SHIM_MODEL%"=="" set SHIM_MODEL=opus
echo Starting claude-shim (model=%SHIM_MODEL%) ...
node server\claude-shim.js
