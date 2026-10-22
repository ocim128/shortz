@echo off
setlocal
rem ============================================================
rem  ShortZ - kill running instance, then start the app (dev)
rem  Can be launched from any working directory.
rem ============================================================
cd /d "%~dp0"

echo === ShortZ restart ===

rem --- [1/2] stop running instances --------------------------------
rem  - ShortZ.exe            packaged/installer/portable builds
rem  - electron.exe          dev instance FROM THIS REPO only
rem    (matched by path, so other apps' Electron is untouched)
echo Stopping running instances...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ShortZ.exe' -or ($_.Name -eq 'electron.exe' -and $_.ExecutablePath -like '*shortz*') } | ForEach-Object { Write-Host ('      stopped PID ' + $_.ProcessId + '  ' + $_.Name); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

rem give the OS a moment to release files + the app's singleton lock
rem (stale instances make the next launch exit silently - NOTES-B)
rem (ping-wait works with or without a console; timeout.exe errors when stdin is redirected)
ping -n 3 127.0.0.1 >nul

rem --- [2/2] start the app ------------------------------------------
rem  env trap (NOTES-C): if ELECTRON_RUN_AS_NODE is set, electron
rem  boots as plain node and the app dies at startup - clear it.
set ELECTRON_RUN_AS_NODE=

echo Starting ShortZ (pnpm dev)...
call pnpm --dir "%~dp0." dev

endlocal
