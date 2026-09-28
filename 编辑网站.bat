@echo off
chcp 65001 >nul
title Portfolio Editor - Niu Luxiang
cd /d "%~dp0"

set "NODEEXE="

rem ---- 1) node on PATH ----
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODEEXE=%%~$PATH:I"

rem ---- 2) usual install locations ----
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODEEXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

rem ---- 3) fall back to the runtime bundled with this machine ----
if not defined NODEEXE if exist "D:\New Folder\node.exe" set "NODEEXE=D:\New Folder\node.exe"

if not defined NODEEXE (
  echo.
  echo   ------------------------------------------------------------
  echo    Node.js was not found, so the editor cannot start.
  echo.
  echo    Please open  https://nodejs.org
  echo    Install the LTS version, then double-click this file again.
  echo   ------------------------------------------------------------
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting the local editor. Your browser will open by itself.
echo   Keep this window open while you edit. Close it when you are done.
echo.

"%NODEEXE%" "tools\editor-server.mjs" --open
set "CODE=%errorlevel%"

echo.
if not "%CODE%"=="0" (
  echo   The editor stopped with error code %CODE%.
) else (
  echo   Editor closed. Your website files are untouched.
)
echo.
pause
