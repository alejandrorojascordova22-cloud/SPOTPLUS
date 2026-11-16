@echo off
cd /d "%~dp0.."
if not exist "venv\Scripts\python.exe" (
  echo ERROR: No se encontro venv\Scripts\python.exe
  pause
  exit /b 1
)
set PYTHONUTF8=1
venv\Scripts\python.exe -X utf8 -m backend.analista.escaner
if errorlevel 1 echo ERROR: El escaner termino con codigo %ERRORLEVEL%.
pause
