@echo off
REM Double-click to launch the app with hot reload (like a play button).
setlocal
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0app"
echo Launching EasyIntroModder (dev)... first launch compiles, then a window opens.
call npm run tauri dev
echo.
echo (App closed.) Press any key to exit.
pause >nul
