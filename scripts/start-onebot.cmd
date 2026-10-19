@echo off
rem CharacterLife - OneBot 11 launcher (Windows)
rem Usage: scripts\start-onebot.cmd [-Probe] [-ApiBase http://127.0.0.1:3000] ...
rem This wrapper only exists to bypass execution policy friction; all logic lives in start-onebot.ps1
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-onebot.ps1" %*
exit /b %ERRORLEVEL%
