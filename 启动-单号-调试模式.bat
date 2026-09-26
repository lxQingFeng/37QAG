@echo off
rem Troubleshooting launcher - same as running the single launcher with /keep:
rem it keeps a VISIBLE console so you can read PowerShell / Node errors.
rem Normal starts should use the single-account launcher instead.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" -Mode single
echo [debug] exited. Log: data\logs\launch-log.txt
pause >nul
exit