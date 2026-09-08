@echo off
setlocal

cd /d "%~dp0"
set "TARGET_DIR=vendor\esbuild-wasm"
set "PACKAGE_URL=https://unpkg.com/esbuild-wasm"
set "BROWSER_TMP=%TARGET_DIR%\browser.min.js.tmp"
set "WASM_TMP=%TARGET_DIR%\esbuild.wasm.tmp"

if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"

echo Downloading the latest esbuild-wasm browser module...
curl.exe --fail --location --retry 3 --retry-delay 1 "%PACKAGE_URL%/esm/browser.min.js" --output "%BROWSER_TMP%"
if errorlevel 1 goto :failed

echo Downloading the latest esbuild-wasm WebAssembly file...
curl.exe --fail --location --retry 3 --retry-delay 1 "%PACKAGE_URL%/esbuild.wasm" --output "%WASM_TMP%"
if errorlevel 1 goto :failed

move /y "%BROWSER_TMP%" "%TARGET_DIR%\browser.min.js" >nul
move /y "%WASM_TMP%" "%TARGET_DIR%\esbuild.wasm" >nul
echo esbuild-wasm files updated successfully.
exit /b 0

:failed
if exist "%BROWSER_TMP%" del /q "%BROWSER_TMP%"
if exist "%WASM_TMP%" del /q "%WASM_TMP%"
echo Failed to update esbuild-wasm files.
exit /b 1