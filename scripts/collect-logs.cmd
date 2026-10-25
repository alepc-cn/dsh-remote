@echo off
rem dsh-remote: collect diagnostic logs into one folder (works even when DSH cannot start).
rem Usage: double-click this file. Output goes to Desktop\dsh-remote-logs-<timestamp>
setlocal
set STAMP=%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%-%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%
set STAMP=%STAMP: =0%
set OUT=%USERPROFILE%\Desktop\dsh-remote-logs-%STAMP%
mkdir "%OUT%" 2>nul

echo Collecting dsh-remote logs...
if exist "%USERPROFILE%\.dsh\dsh-remote.log" copy /y "%USERPROFILE%\.dsh\dsh-remote.log" "%OUT%\" >nul
if exist "%USERPROFILE%\.dsh\dsh-remote.log.1" copy /y "%USERPROFILE%\.dsh\dsh-remote.log.1" "%OUT%\" >nul
if exist "%USERPROFILE%\.dsh\dsh-remote.log.2" copy /y "%USERPROFILE%\.dsh\dsh-remote.log.2" "%OUT%\" >nul
copy /y "%USERPROFILE%\.dsh\remote-devices.json" "%OUT%\" >nul 2>nul

echo Collecting DSH desktop logs...
if exist "%APPDATA%\@deepseek-ai\dsh-desktop\logs" (
  mkdir "%OUT%\dsh-desktop-logs" 2>nul
  copy /y "%APPDATA%\@deepseek-ai\dsh-desktop\logs\*.log" "%OUT%\dsh-desktop-logs\" >nul 2>nul
)

echo Collecting environment info...
(
  echo date: %DATE% %TIME%
  echo hostname: %COMPUTERNAME%
  echo dsh_home: %USERPROFILE%\.dsh
  echo.
  echo --- plugin version ---
  type "%USERPROFILE%\.dsh\profiles\desktop\node_modules\@local\dsh-remote\package.json" 2>nul
  echo.
  echo --- desktop app ---
  dir "%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe" 2>nul
) > "%OUT%\environment.txt"

powershell -NoProfile -Command "Compress-Archive -Path '%OUT%\*' -DestinationPath '%OUT%.zip' -Force" 2>nul
echo.
echo Done. Logs are in:
echo   %OUT%
if exist "%OUT%.zip" echo Zip: %OUT%.zip
pause
