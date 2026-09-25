@echo off
rem QQ Agent launcher - TWO QQ accounts (two windows, one per account).
rem Account A -> data\ ; account B -> data-2\ (created automatically if missing).
rem
rem NOTE: keep this file ASCII-only + CRLF (see the single-account launcher).
rem 2026-09-22: the real work happens in launch.ps1 with a HIDDEN console, so the
rem leftover-cmd problem is gone. Need to read the output? pass /keep.
if /i "%~1"=="/keep" goto visible
if /i "%~1"=="--hidden" goto visible

powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch.ps1" -Mode dual
exit

:visible
echo [debug] starting with a visible console (mode: dual) ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" -Mode dual
echo [debug] done. Launch log: launch-log.txt
if /i "%~1"=="/keep" pause
exit
