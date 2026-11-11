@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-broker-quotes-task.ps1"
if errorlevel 1 (
  echo.
  echo Gagal membuat scheduled task. Jalankan sebagai user pemilik folder proyek.
) else (
  echo.
  echo MT5 harus terbuka dan login agar quote broker bisa dipublikasikan.
)
pause
