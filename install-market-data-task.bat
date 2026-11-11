@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-market-data-task.ps1"
if errorlevel 1 (
  echo.
  echo Gagal membuat scheduled task. Jalankan sebagai user pemilik folder proyek.
) else (
  echo.
  echo Data market akan dipublish otomatis tiap 15 menit.
)
pause
