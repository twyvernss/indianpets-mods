@echo off
REM Puts Node on PATH for the current cmd.exe session.
REM
REM Usage - note the CALL, which makes it run in your shell:
REM
REM   call tools\use-node.cmd
REM
REM Safe to run more than once.

where node >nul 2>&1
if %ERRORLEVEL%==0 (
    echo node already on PATH
    goto :eof
)

for %%D in (
    "C:\Temp\node\node-v24.21.0-win-x64"
    "C:\Program Files\nodejs"
    "%LOCALAPPDATA%\Programs\nodejs"
) do (
    if exist "%%~D\node.exe" (
        set "PATH=%%~D;%PATH%"
        echo node ready ^(from %%~D^)
        goto :eof
    )
)

echo No Node install found. Install Node 24+ from https://nodejs.org
echo or edit the list in this script.
