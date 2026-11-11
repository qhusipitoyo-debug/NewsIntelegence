@echo off
cd /d "%~dp0"
git config pull.rebase true
git pull --rebase --autostash
if errorlevel 1 (
  echo.
  echo Pull gagal - eksekutor tidak dijalankan. Periksa pesan di atas.
  pause
  exit /b 1
)
python scripts\mt5_autoexec.py --interval 60 --remote %*
if errorlevel 1 pause
