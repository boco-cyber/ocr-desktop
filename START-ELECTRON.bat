@echo off
title OCR Desktop
color 0A
cd /d "%~dp0"

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)

if not exist "data" mkdir data
if not exist "data\uploads" mkdir data\uploads

start "" "node_modules\electron\dist\electron.exe" .
