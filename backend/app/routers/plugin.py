"""外挂插件路由：提取源/操作页配置、体外循环启停、记录查询。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Query
from fastapi.responses import JSONResponse

from ..services import plugin_loop

router = APIRouter(prefix="/api/plugin")


@router.get("/tabs")
async def get_tabs(cdp_url: str = Query(default="")):
    """列出外部 Chrome 标签页（需 Chrome 以 --remote-debugging-port 启动）。"""
    try:
        tabs = await plugin_loop.list_chrome_tabs(cdp_url or None)
        return {"ok": True, "tabs": tabs}
    except Exception as e:
        return JSONResponse({"ok": False, "error": (
            f"无法连接外部 Chrome（{plugin_loop.DEFAULT_CDP_URL}）。"
            "请用 --remote-debugging-port=9223 启动 Chrome，或点击悬浮条上的「启动受控Chrome」。"
            f" 详细: {e}"
        )}, status_code=200)


@router.get("/config")
def get_config():
    return plugin_loop.get_config()


@router.post("/config")
def set_config(data: dict[str, Any] = Body(...)):
    return plugin_loop.set_config(data)


@router.get("/status")
def get_status():
    return plugin_loop.get_status()


@router.post("/start")
async def start():
    try:
        return await plugin_loop.start()
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)


@router.post("/stop")
async def stop():
    return await plugin_loop.stop()


@router.get("/records")
def get_records():
    return {"records": plugin_loop.get_records()}


@router.delete("/records")
def delete_records():
    plugin_loop.clear_records()
    return {"ok": True}
