"""FastAPI 入口。"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path


def get_resource_path(relative_path: str) -> Path:
    """获取资源路径，兼容开发环境和 PyInstaller 打包后的环境。"""
    if getattr(sys, "frozen", False):
        # PyInstaller 打包后：
        # - sys._MEIPASS 是单文件模式的临时解压目录
        # - 对于单目录模式（onedir），可执行文件所在目录是基础目录
        base_path = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    else:
        # 开发环境：backend/ 目录
        base_path = Path(__file__).resolve().parent.parent
    return base_path / relative_path


# Windows 上 browser-use 调用 asyncio.create_subprocess_exec 需要 ProactorEventLoop
# uvicorn --reload 在某些情况下会拿到 SelectorEventLoop，这里强制还原
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    print(f"[init] event loop policy set to {asyncio.get_event_loop_policy().__class__.__name__}")

# 让 `from app.xxx import` 也能工作（直接 python -m app.main 或 uvicorn app.main:app）
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# 在导入 config 之前加载 .env，让 .env 里的变量覆盖默认值
# 打包后 .env 应该在 exe 同级目录
try:
    from dotenv import load_dotenv
    env_paths = [
        get_resource_path(".env"),
        Path(sys.executable).resolve().parent / ".env",
    ]
    for env_path in env_paths:
        if env_path.exists():
            load_dotenv(env_path)
            print(f"[init] loaded .env from {env_path}")
            break
except ImportError:
    pass

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .routers import config, document, plugin, ppt, upload, verify, ws

app = FastAPI(title="CINSIDE 核验平台", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin, "http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(upload.router)
app.include_router(verify.router)
app.include_router(ws.router)
app.include_router(config.router)
app.include_router(document.router)
app.include_router(plugin.router)
app.include_router(ppt.router)


@app.on_event("startup")
async def _log_loop():
    loop = asyncio.get_running_loop()
    print(f"[startup] event loop type: {type(loop).__name__}", flush=True)


# mock 大学页面挂在 /mock 路径，用 StaticFiles 提供
# 打包后：resources/mock-university/ 或 exe 同级目录的 mock-university/
_MOCK_DIR = None
for _candidate in [
    get_resource_path("mock-university"),
    Path(sys.executable).resolve().parent / "mock-university",
    Path(sys.executable).resolve().parent.parent / "mock-university",
    Path(__file__).resolve().parent.parent.parent / "mock-university",
]:
    if _candidate.exists():
        _MOCK_DIR = _candidate
        break
if _MOCK_DIR:
    print(f"[init] mock dir: {_MOCK_DIR}")
    app.mount("/mock", StaticFiles(directory=str(_MOCK_DIR), html=True), name="mock")

# DEMO 页面：左侧数据源 admin / 右侧审查流 review / 右侧录入流 entry / 新录入系统 fill-demo
_DEMO_DIR = None
for _candidate in [
    get_resource_path("demo-pages"),
    Path(sys.executable).resolve().parent / "demo-pages",
    Path(sys.executable).resolve().parent.parent / "demo-pages",
    Path(__file__).resolve().parent.parent.parent / "demo-pages",
]:
    if _candidate.exists():
        _DEMO_DIR = _candidate
        break
if _DEMO_DIR:
    print(f"[init] demo dir: {_DEMO_DIR}")
    _admin_dir = _DEMO_DIR / "admin"
    _review_dir = _DEMO_DIR / "review"
    _entry_dir = _DEMO_DIR / "entry"
    _fill_demo_dir = _DEMO_DIR / "fill-demo"
    if _admin_dir.exists():
        app.mount("/demo-admin", StaticFiles(directory=str(_admin_dir), html=True), name="demo-admin")
    if _review_dir.exists():
        app.mount("/demo-review", StaticFiles(directory=str(_review_dir), html=True), name="demo-review")
    if _entry_dir.exists():
        app.mount("/demo-entry", StaticFiles(directory=str(_entry_dir), html=True), name="demo-entry")
    if _fill_demo_dir.exists():
        app.mount("/demo-fill", StaticFiles(directory=str(_fill_demo_dir), html=True), name="demo-fill")


@app.get("/")
def root():
    return {"name": "CINSIDE 核验平台", "version": "0.1.0", "agent": settings.agent_backend}


@app.get("/api/health")
def health():
    return {"ok": True, "agent_backend": settings.agent_backend}


@app.get("/api/config")
def get_config():
    """前端用来显示当前 Agent 后端与完整设置。"""
    return {
        "agent_backend": settings.agent_backend,
        "vision_configured": bool(settings.vision_api_key),
        "browser_use_configured": bool(settings.browser_use_llm_key),
        "settings": settings.to_settings_dict(),
    }


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="CINSIDE Backend Server")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind to")
    args = parser.parse_args()

    print(f"[cinside-backend] Starting server on {args.host}:{args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
