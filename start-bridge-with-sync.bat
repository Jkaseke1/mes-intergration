@echo off
echo Starting MES Bridge Worker with Stock Sync...
echo.

REM Start bridge worker (it forks the stock sync scheduler automatically)
start "Bridge Worker" cmd /k "cd /d %~dp0events && node bridgeworker.js"

echo.
echo ✅ Bridge Worker started!
echo    - Bridge Worker (processes events every 30 seconds)
echo    - Stock Sync Scheduler is started automatically by the bridge worker
echo.
echo Close the command window to stop both services.
pause
