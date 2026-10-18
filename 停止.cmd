@echo off
chcp 65001 >nul
cd /d "%~dp0"
node src/stop.mjs
if errorlevel 1 pause
