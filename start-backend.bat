@echo off
REM 启动后端 FastAPI（默认 mock agent，开箱即跑）
cd /d %~dp0backend
if not exist .env (
    copy .env.example .env >nul
    echo [info] 已从 .env.example 创建 .env，可按需修改
)
if not exist .venv (
    echo [info] 创建虚拟环境...
    py -m venv .venv
)
call .venv\Scripts\activate.bat
echo [info] 安装依赖...
py -m pip install -q -r requirements.txt
echo [info] 启动后端 http://localhost:8000
REM Windows 下 --reload 会强制使用 SelectorEventLoop，导致 browser-use 无法启动 Chrome 子进程
py -m uvicorn app.main:app --port 8000
