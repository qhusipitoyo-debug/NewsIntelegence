@echo off
setlocal
cd /d "%~dp0"
if not exist "bridge" mkdir "bridge"
set "LOG=%~dp0bridge\market-data.log"
set "GIT=git -c user.name=pitoyict13-droid -c user.email=pitoyict13@gmail.com"

echo [%date% %time%] refresh start >> "%LOG%"
node scripts\fetch-calendar.mjs >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] refresh failed - old data is kept >> "%LOG%"
  exit /b 1
)

%GIT% add data\calendar.json data\market.json data\forex.json data\crypto.json data\markets.json data\prenews.json data\indices.json data\reaction.json
%GIT% diff --cached --quiet
if not errorlevel 1 (
  echo [%date% %time%] data unchanged >> "%LOG%"
  exit /b 0
)

%GIT% commit -m "chore: refresh live market data" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] commit failed >> "%LOG%"
  exit /b 1
)

%GIT% pull --rebase --autostash >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] pull --rebase failed; data not pushed >> "%LOG%"
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
echo [%date% %time%] published market data >> "%LOG%"
exit /b 0
