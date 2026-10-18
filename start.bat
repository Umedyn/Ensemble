@echo off
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8000
  node tools\serve.mjs
) else (
  echo Ensemble is running at http://localhost:8000  ^(close this window to stop^)
  start "" http://localhost:8000
  python -m http.server 8000
)
