@echo off
REM 启动前端 Vite
cd /d %~dp0frontend
if not exist node_modules (
    echo [info] 安装依赖...
    call npm install
)
echo [info] 启动前端 http://localhost:5173
call npm run dev
