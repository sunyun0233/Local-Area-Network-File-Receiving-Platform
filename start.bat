@echo off
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Python，请先安装 Python 3.8 或更高版本。
    pause
    exit /b 1
)

python -c "import flask, qrcode" >nul 2>nul
if errorlevel 1 (
    echo 首次运行，正在安装依赖...
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)

python server.py
if errorlevel 1 pause
