@echo off
rem dsh-remote: emergency reset.
rem Use when DSH cannot start / keeps crashing after switching devices.
rem It closes DSH, backs up Local/Session Storage (device-switch state), then starts DSH again.
setlocal
set STAMP=%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%-%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%
set STAMP=%STAMP: =0%
set BASE=%APPDATA%\@deepseek-ai\dsh-desktop
set EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe

echo === dsh-remote emergency reset ===
echo Closing DeepSeek Harness...
taskkill /IM "DeepSeek Harness.exe" /F >nul 2>&1
timeout /t 8 /nobreak >nul

if exist "%BASE%\Local Storage" (
  move "%BASE%\Local Storage" "%BASE%\Local Storage.bak-reset-%STAMP%" >nul 2>&1
  echo Backed up: Local Storage.bak-reset-%STAMP%
)
if exist "%BASE%\Session Storage" (
  move "%BASE%\Session Storage" "%BASE%\Session Storage.bak-reset-%STAMP%" >nul 2>&1
  echo Backed up: Session Storage.bak-reset-%STAMP%
)

if exist "%EXE%" (
  echo Starting DeepSeek Harness...
  start "" "%EXE%"
) else (
  echo ERROR: DeepSeek Harness.exe not found at:
  echo   %EXE%
  echo Please start it manually.
)

echo Done. If DSH still fails, run the log collector:
echo   %USERPROFILE%\.dsh\dsh-remote-collect-logs.cmd
pause
