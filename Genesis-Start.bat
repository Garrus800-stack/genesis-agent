@echo off
title Genesis
echo.
echo   GENESIS
echo   =======
echo.

:: Check if node_modules exists
if not exist "node_modules" (
    echo [SETUP] First run - executing bootstrap...
    node src/kernel/bootstrap.js
    if errorlevel 1 (
        echo [ERROR] Bootstrap failed.
        pause
        exit /b 1
    )
)

:: Check Ollama
curl -s http://127.0.0.1:11434/api/tags >nul 2>&1
if errorlevel 1 (
    echo [WARN] Ollama not reachable. Start Ollama first!
    echo        Starting anyway...
)

echo [START] Launching Genesis...
npx electron .
