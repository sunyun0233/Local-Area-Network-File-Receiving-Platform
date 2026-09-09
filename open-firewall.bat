@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo 正在检查 Python...
where python >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Python，无法读取端口配置。
    pause
    exit /b 1
)

set "PORT=8000"
if exist config.json (
    for /f "usebackq delims=" %%p in (`python -c "import json;print(json.load(open('config.json', encoding='utf-8')).get('port', 8000))"`) do set "PORT=%%p"
)

echo 正在为 TCP 端口 %PORT% 添加入站规则（本操作需要管理员权限）...
netsh advfirewall firewall delete rule name="局域网文件接收平台" >nul 2>nul
netsh advfirewall firewall add rule name="局域网文件接收平台" dir=in action=allow protocol=TCP localport=%PORT%

if errorlevel 1 (
    echo.
    echo [提示] 添加失败。请右键本脚本，选择“以管理员身份运行”后重试。
) else (
    echo.
    echo 完成！防火墙已允许局域网访问端口 %PORT%。
)
pause
