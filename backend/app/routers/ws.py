"""WebSocket 路由：实时推送核验进度。"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..models import ScreenshotEvent, VerificationStep
from ..services.task_manager import get_task, subscribe, unsubscribe

router = APIRouter()


@router.websocket("/ws/verify/{task_id}")
async def ws_verify(websocket: WebSocket, task_id: str):
    await websocket.accept()

    # 先把已有进度回放
    t = get_task(task_id)
    if t:
        for s in t.steps:
            await websocket.send_json({"type": "step", "data": s.model_dump()})
        if t.finished_at:
            await websocket.send_json({"type": "done", "data": t.model_dump()})

    # 若任务已结束，直接关掉
    if t and t.finished_at:
        await websocket.close()
        return

    # 订阅后续进度
    q = subscribe(task_id)
    try:
        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=30.0)
                # 队列里可能放 VerificationStep 或 ScreenshotEvent
                if isinstance(event, ScreenshotEvent):
                    await websocket.send_json({"type": "screenshot", "data": event.model_dump()})
                elif isinstance(event, VerificationStep):
                    await websocket.send_json({"type": "step", "data": event.model_dump()})
                    if event.action in ("final", "error"):
                        # 推送最终结果再关闭
                        latest = get_task(task_id)
                        if latest:
                            await websocket.send_json({"type": "done", "data": latest.model_dump()})
                        await websocket.close()
                        return
                else:
                    # 兜底：未知事件类型，跳过
                    continue
            except asyncio.TimeoutError:
                # 心跳
                await websocket.send_json({"type": "ping"})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "data": {"message": str(e)}})
        except Exception:
            pass
    finally:
        unsubscribe(task_id, q)
