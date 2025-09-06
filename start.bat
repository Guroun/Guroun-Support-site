@echo off
setlocal
chcp 65001 >nul

title Guroun Support Server
cd /d %~dp0
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-fund --no-audit
)

echo Starting support server on http://localhost:3000
echo Press Ctrl+C to stop the server.
call npm run start

echo.
echo Server stopped or exited. Press any key to close this window.
pause >nul 