@echo off
setlocal enabledelayedexpansion

REM Get current directory
set "currentDir=%cd%"

REM Change to 'config' subfolder
if exist "%currentDir%\config" (
    cd "%currentDir%\config"
    echo Now in config folder: %cd%
) else (
    echo The 'config' folder does not exist in the current directory.
    goto :eof
)

set "currentDir=%cd%"


REM Get FQDN (fallback to NetBIOS name if needed)
for /f "tokens=2 delims==" %%i in ('"wmic computersystem get domain /value"') do set "domain=%%i"
set "computerName=%COMPUTERNAME%"
set "fqdn=%computerName%.%domain%"

REM Check if folder with FQDN exists
if exist "%currentDir%\%fqdn%" (
    set "sourceDir=%currentDir%\%fqdn%"
) else if exist "%currentDir%\%computerName%" (
    set "sourceDir=%currentDir%\%computerName%"
) else (
    echo No matching folder found for FQDN or NetBIOS name.
    goto :eof
)

echo Copying files and subfolders from: %sourceDir%

REM Copy recursively all files and folders to current directory
xcopy "%sourceDir%\*" "%currentDir%\" /E /I /Y /Q

echo Copy completed.
endlocal
