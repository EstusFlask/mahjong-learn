@echo off
setlocal
set "NO_PAUSE="
if /i "%~1"=="-NoPause" set "NO_PAUSE=1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
    echo Installation completed.
) else (
    echo Installation failed. Review the message above and .runtime\install.log.
)
if not defined NO_PAUSE pause
exit /b %EXIT_CODE%
