@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-LcaDemo.ps1" -Mode Judges
if errorlevel 1 pause
