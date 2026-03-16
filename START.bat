@echo off
title OCR Desktop
color 0A

echo.
echo  ========================================
echo   OCR Desktop - AI-powered OCR Tool
echo  ========================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found!
    echo  Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo  Installing dependencies (first run only, may take a few minutes)...
    call npm install
    if %errorlevel% neq 0 (
        echo  [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

if not exist "data" mkdir data
if not exist "data\uploads" mkdir data\uploads

echo  Starting server on http://localhost:3444
echo  Opening browser...
echo.
start "" "http://localhost:3444"
node server.js

pause
