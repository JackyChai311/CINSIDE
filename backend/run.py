"""CINSIDE 后端启动入口（PyInstaller 打包用）。

用绝对导入 `from app.main import app`，确保 `app.main` 作为包模块被导入，
这样 main.py 内部的相对导入（from .config import ...）才能正常工作。
"""
import sys
from pathlib import Path

# 打包后：cinside-backend.exe 同级目录是基础目录
# 开发时：backend/ 目录是基础目录
if getattr(sys, "frozen", False):
    BASE_DIR = Path(sys.executable).resolve().parent
else:
    BASE_DIR = Path(__file__).resolve().parent

# 把基础目录加入 sys.path，确保 `from app.xxx import` 能工作
sys.path.insert(0, str(BASE_DIR))

import argparse
import uvicorn
from app.main import app  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="CINSIDE Backend Server")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind to")
    args = parser.parse_args()

    print(f"[cinside-backend] Starting server on {args.host}:{args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
