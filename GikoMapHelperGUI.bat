@echo off
where node >NUL 2>NUL
if errorlevel 1 (
    echo Node.js is required to run GikoMapHelper but was not found.
    echo Download and install it from https://nodejs.org ^(the LTS version is fine^), then run this again.
    echo.
    pause
    exit /b 1
)
node "%~dp0GikoMapHelperGUI.cjs"
pause
