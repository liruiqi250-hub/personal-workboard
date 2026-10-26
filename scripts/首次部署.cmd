@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" -DownloadNode -SkipInstall -OpenBrowser
if errorlevel 1 pause
