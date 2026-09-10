@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer, then try again.
  echo https://nodejs.org/
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with npm, then try again.
  pause
  exit /b 1
)

if not exist "node_modules\.bin\tsc.cmd" (
  echo First launch: installing ProviderDock dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :failed
)

echo Building ProviderDock...
call npm run build
if errorlevel 1 goto :failed

echo Starting ProviderDock in the background...
if /i "%~1"=="--no-open" (
  powershell.exe -NoLogo -NoProfile -NonInteractive -Command "Start-Process -FilePath 'node.exe' -ArgumentList @('dist\cli.js','dashboard') -WorkingDirectory '%CD%' -WindowStyle Hidden"
) else (
  powershell.exe -NoLogo -NoProfile -NonInteractive -Command "Start-Process -FilePath 'node.exe' -ArgumentList @('dist\cli.js','dashboard','--open') -WorkingDirectory '%CD%' -WindowStyle Hidden"
)
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo ProviderDock could not start. The error message is shown above.
pause
exit /b 1
