@echo off
rem CharacterLife OneBot service control. Run without arguments for help.
node "%~dp0cl.ts" %*
exit /b %ERRORLEVEL%
