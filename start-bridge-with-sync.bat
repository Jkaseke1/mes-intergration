@echo off
echo Starting MES Bridge Worker with Stock Sync...
echo.

REM Start stock sync scheduler in background
start "Stock Sync Scheduler" cmd /k "cd /d %~dp0events && node stockSyncScheduler.js"

REM Wait 2 seconds
timeout /t 2 /nobreak >nul

REM Start bridge worker
start "Bridge Worker" cmd /k "cd /d %~dp0events && node bridgeworker.js"

echo.
echo ✅ Both services started!
echo    - Stock Sync Scheduler (syncs every hour)
echo    - Bridge Worker (processes events)
echo.
echo Close the command windows to stop the services.
pause
