@echo off
:: LOCRIUM Manual Code Signing Script
::
:: Signs the built output artefacts in dist\ using signtool.exe.
:: Reads certificate credentials from environment variables — never hardcode them.
::
:: Required environment variables:
::   LOCRIUM_CERT_PATH  — Full path to your PFX/P12 certificate
::   LOCRIUM_CERT_PASS  — Certificate password
::
:: Usage:
::   set LOCRIUM_CERT_PATH=C:\certs\locrium.pfx
::   set LOCRIUM_CERT_PASS=YourSecurePassword
::   scripts\sign.bat
::
:: Optionally set SIGNTOOL_PATH if signtool.exe is not on PATH:
::   set SIGNTOOL_PATH=C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe

setlocal enabledelayedexpansion

:: ── Validate inputs ──────────────────────────────────────────────────────────

if "%LOCRIUM_CERT_PATH%"=="" (
    echo [sign] ERROR: LOCRIUM_CERT_PATH is not set.
    echo [sign] Set it to the absolute path of your PFX certificate:
    echo [sign]   set LOCRIUM_CERT_PATH=C:\path\to\locrium.pfx
    exit /b 1
)

if not exist "%LOCRIUM_CERT_PATH%" (
    echo [sign] ERROR: Certificate file not found: %LOCRIUM_CERT_PATH%
    exit /b 1
)

:: ── Locate signtool.exe ──────────────────────────────────────────────────────

if "%SIGNTOOL_PATH%"=="" (
    set SIGNTOOL_PATH=signtool.exe
)

:: ── Resolve dist\ relative to this script ───────────────────────────────────

set SCRIPT_DIR=%~dp0
set DIST_DIR=%SCRIPT_DIR%..\dist

:: ── Sign both artefacts ──────────────────────────────────────────────────────

set TIMESTAMP_URL=http://timestamp.digicert.com
set SIGNED_COUNT=0
set FAILED_COUNT=0

for %%F in ("%DIST_DIR%\Locrium.exe" "%DIST_DIR%\LocriumSetup.exe") do (
    if exist "%%F" (
        echo [sign] Signing: %%~nxF
        "%SIGNTOOL_PATH%" sign ^
            /f "%LOCRIUM_CERT_PATH%" ^
            /p "%LOCRIUM_CERT_PASS%" ^
            /tr "%TIMESTAMP_URL%" ^
            /td sha256 ^
            /fd sha256 ^
            /q ^
            "%%F"
        if !errorlevel! neq 0 (
            echo [sign] ERROR: Failed to sign %%~nxF
            set /a FAILED_COUNT+=1
        ) else (
            echo [sign] Signed OK: %%~nxF
            set /a SIGNED_COUNT+=1

            echo [sign] Verifying: %%~nxF
            "%SIGNTOOL_PATH%" verify /pa /q "%%F"
            if !errorlevel! neq 0 (
                echo [sign] WARNING: Verification failed for %%~nxF
            ) else (
                echo [sign] Verified OK: %%~nxF
            )
        )
    ) else (
        echo [sign] Skipping ^(not found^): %%~nxF
    )
)

:: ── Summary ──────────────────────────────────────────────────────────────────

echo.
echo [sign] Signed: %SIGNED_COUNT% file(s)
if %FAILED_COUNT% gtr 0 (
    echo [sign] FAILED: %FAILED_COUNT% file(s)
    exit /b 1
)

echo [sign] All done. Place the signed files in your distribution channel.
endlocal
