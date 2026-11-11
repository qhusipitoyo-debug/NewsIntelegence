@echo off
cd /d "%~dp0"
if not exist "bridge" mkdir "bridge"
git pull --rebase --autostash >> "bridge\sync.log" 2>&1
