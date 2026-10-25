@echo off
rem Double-click launcher for Windows: installs on first run, starts the stack, opens the browser.
cd /d "%~dp0"
if not exist "backend\.venv" (
  echo First run: installing dependencies. This takes a few minutes.
  call npm run setup || goto :error
)
start "" cmd /c "timeout /t 12 >nul & start http://127.0.0.1:5173"
call npm run dev
goto :eof
:error
echo Setup failed. See the messages above.
pause
