@echo off
rem ============================================================
rem  IndexTTS2 patch installer launcher
rem
rem  KEEP THIS FILE PURE ASCII AND CRLF.
rem  cmd.exe decodes .bat bytes with the OEM code page, so a
rem  UTF-8 Chinese .bat turns into garbage on a GBK console:
rem    't' is not recognized as an internal or external command
rem    'XX' is not recognized ...
rem  All Chinese text is printed by install.py instead (Python
rem  writes to the console through the Unicode API, no mojibake).
rem ============================================================
setlocal EnableExtensions
cd /d "%~dp0"

set "PYEXE="
set "PYARGS="

if exist "%~dp0runtime\python.exe" set "PYEXE=%~dp0runtime\python.exe"
if not defined PYEXE if exist "%~dp0..\runtime\python.exe" set "PYEXE=%~dp0..\runtime\python.exe"
if not defined PYEXE call :probe py -3
if not defined PYEXE call :probe python
if not defined PYEXE call :probe python3

if not defined PYEXE (
  echo [ERROR] Python not found.
  echo.
  echo  - Extract the whole zip into the IndexTTS2 package folder, so that
  echo    runtime\python.exe can be found next to this .bat; or
  echo  - install Python 3 and run again; or
  echo  - run it manually from the package root:
  echo        runtime\python.exe install.py --target "path\to\IndexTTS2"
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0install.py" (
  echo [ERROR] install.py is missing next to this .bat.
  echo         Extract the whole zip again and keep the folder as it is.
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0payload" (
  echo [ERROR] payload folder is missing.
  echo         Extract the whole zip again and do not move files out.
  echo.
  pause
  exit /b 1
)

echo [INFO] Python : %PYEXE% %PYARGS%
echo [INFO] Folder : %CD%
echo.

"%PYEXE%" %PYARGS% "%~dp0install.py" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo [ERROR] install.py failed with exit code %RC% . See the messages above.
) else (
  echo [DONE] Patch applied. Start the app with start_server.bat as usual.
)
echo.
pause
exit /b %RC%

:probe
rem %1 = command name, %2 = optional first argument (e.g. -3 for py)
where %1 >nul 2>nul
if errorlevel 1 exit /b 0
set "PYEXE=%1"
set "PYARGS=%2"
exit /b 0
