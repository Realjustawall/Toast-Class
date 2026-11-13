@echo off
setlocal
cd /d "%~dp0"

echo Starting the local Toast classroom preview from %CD%...
echo Runtime files, temporary files, and npm cache stay under this E: drive project.
echo.

where node.exe >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found on PATH. Install Node.js on E: and add its bin folder to PATH.
  pause
  exit /b 1
)

if not exist ".local\runtime\user-test-classroom.json" (
  echo ERROR: The saved test account is missing: .local\runtime\user-test-classroom.json
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-native-preview.ps1"
if errorlevel 1 (
  echo.
  echo ERROR: The local preview could not start. Review logs in .local\runtime.
  pause
  exit /b 1
)

echo.
echo Opening the saved test classroom. Sign in with the account in:
echo %CD%\.local\runtime\user-test-classroom.json
echo The password remains in that local E: drive file and is not printed here.
start "" "http://localhost:4173/#classroom/eb803738-7a0e-4e49-b250-06acd34e71fb"
echo.
pause
endlocal
