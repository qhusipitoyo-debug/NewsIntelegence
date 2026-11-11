@echo off
cd /d "%~dp0"
git config pull.rebase true
git pull --rebase --autostash
if errorlevel 1 (
  echo.
  echo Pull gagal - executor grid tidak dijalankan. Periksa pesan di atas.
  pause
  exit /b 1
)
python scripts\mt5_grid_hft.py --interval 1 --news "https://raw.githubusercontent.com/pitoyict13-droid/aiterminaltrading/main/data/calendar.json" %*
if errorlevel 1 pause
