@echo off
rem QQ Agent launcher - ONE QQ account (this is the normal one for most people).
rem It starts ONLY account A, even if a second account (data-2) is configured.
rem
rem NOTE: keep this file ASCII-only + CRLF (cmd parses .bat in GBK on Chinese Windows).
rem
rem 2026-09-22 (user: "there is still a cmd window that will not close"):
rem   The leftover console was kept alive by the APP (Electron attaches to the console it
rem   was started from). Now the real work happens in launch.ps1, started with a HIDDEN
rem   console, so nothing visible is left behind. Need to read the output? pass /keep.
if /i "%~1"=="/keep" goto visible
if /i "%~1"=="--hidden" goto visible

powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch.ps1" -Mode single
exit

:visible
echo [debug] starting with a visible console (mode: single) ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" -Mode single
echo [debug] done. Launch log: data\logs\launch-log.txt
if /i "%~1"=="/keep" pause
exit
