@echo off
schtasks /Create /TN "aiterminaltrading-sync" /SC MINUTE /MO 30 /TR "\"%~dp0sync.bat\"" /F
if errorlevel 1 (
  echo Gagal membuat scheduled task.
  echo Jalankan file ini sebagai user pemilik folder proyek.
) else (
  echo Scheduled task "aiterminaltrading-sync" dibuat: git pull tiap 30 menit.
  echo Log: %~dp0bridge\sync.log
)
pause
