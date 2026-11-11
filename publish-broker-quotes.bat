@echo off
setlocal
cd /d "%~dp0"
if not exist "bridge" mkdir "bridge"
set "LOG=%~dp0bridge\broker-quotes.log"
set "GIT=git -c user.name=pitoyict13-droid -c user.email=pitoyict13@gmail.com"

echo [%date% %time%] publish start >> "%LOG%"
python scripts\mt5_quotes.py --quiet >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] MT5 export failed - old quote file kept >> "%LOG%"
  exit /b 1
)

%GIT% add data\forex-broker.json
%GIT% diff --cached --quiet
if not errorlevel 1 (
  echo [%date% %time%] broker quotes unchanged >> "%LOG%"
  exit /b 0
)

%GIT% commit -m "bot: refresh MT5 broker quotes" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] commit failed >> "%LOG%"
  exit /b 1
)

%GIT% pull --rebase --autostash >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] pull --rebase failed; resolve manually >> "%LOG%"
  exit /b 1
)

for /l %%i in (1,1,3) do (
  %GIT% push >> "%LOG%" 2>&1
  if not errorlevel 1 goto :pushed
  echo [%date% %time%] push attempt %%i failed, retrying >> "%LOG%"
  timeout /t 15 /nobreak >nul
  %GIT% pull --rebase --autostash >> "%LOG%" 2>&1
)

echo [%date% %time%] push failed after 3 attempts >> "%LOG%"
exit /b 1

:pushed
echo [%date% %time%] published broker quotes >> "%LOG%"
exit /b 0
