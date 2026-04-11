@echo off
title OCR Desktop
color 0A
cd /d "%~dp0"

set "LOCAL_NODE_DIR="
for /d %%D in (".tools\node\node-v*-win-x64") do set "LOCAL_NODE_DIR=%%~fD"
if defined LOCAL_NODE_DIR (
    set "PATH=%LOCAL_NODE_DIR%;%PATH%"
)

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js not found.
    echo Install Node.js from https://nodejs.org or place a portable copy in .tools\node\
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)

if not exist "data" mkdir data
if not exist "data\uploads" mkdir data\uploads

start "" "node_modules\electron\dist\electron.exe" .
