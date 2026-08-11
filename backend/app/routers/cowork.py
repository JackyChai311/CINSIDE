"""Cowork Studio API 路由。

提供：
- 技能库 CRUD
- 客户端检测（codex / cc / trae / 千问）
- 用户风格画像读写
- 任务派发（SSE 流式推送品控进度）
- 历史任务查询
"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from ..services import cowork_service

router = APIRouter(prefix="/api/cowork", tags=["cowork"])


# ---- 请求模型 ----

class SkillIn(BaseModel):
    id: str = ""
    name: str
    description: str = ""
    content: str = ""
    category: str = "general"


class SkillIdIn(BaseModel):
    id: str


class ProfileIn(BaseModel):
    text: str = ""
    append: str = ""


class DispatchIn(BaseModel):
    instruction: str = Field(..., description="任务指令")
    skill_ids: list[str] = Field(default_factory=list)
    client_ids: list[str] = Field(default_factory=list)
    max_rounds: int = Field(2, ge=1, le=5)
    timeout: int = Field(600, ge=30, le=1800)


# ---- 技能库 ----

@router.get("/skills")
def list_skills():
    return {"skills": cowork_service.list_skills()}


@router.post("/skills")
def save_skill(skill: SkillIn):
    saved = cowork_service.save_skill(skill.model_dump())
    return {"skill": saved}


@router.post("/skills/delete")
def delete_skill(req: SkillIdIn):
    ok = cowork_service.delete_skill(req.id)
    if not ok:
        raise HTTPException(404, "技能不存在")
    return {"ok": True}


# ---- 客户端检测 ----

@router.get("/clients")
async def detect_clients():
    """检测本机已安装的编码客户端。"""
    clients = await run_in_threadpool(cowork_service.detect_clients)
    return {"clients": clients}


# ---- 用户风格画像 ----

@router.get("/profile")
def get_profile():
    return {"profile": cowork_service.get_profile()}


@router.post("/profile")
def set_profile(req: ProfileIn):
    if req.append:
        text = cowork_service.update_profile(req.append)
    else:
        text = cowork_service.set_profile(req.text)
    return {"profile": text}


# ---- 任务派发（SSE 流式）----

@router.post("/dispatch")
async def dispatch(req: DispatchIn):
    """派发任务给选定客户端，SSE 实时推送进度。"""
    if not req.instruction.strip():
        raise HTTPException(400, "任务指令不能为空")
    if not req.client_ids:
        raise HTTPException(400, "请至少选择一个客户端")

    queue: asyncio.Queue[dict] = asyncio.Queue()
    loop = asyncio.get_event_loop()

    def _progress_cb(ev: dict) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, ev)

    async def _run() -> None:
        try:
            await cowork_service.dispatch_task(
                instruction=req.instruction,
                skill_ids=req.skill_ids,
                client_ids=req.client_ids,
                max_rounds=req.max_rounds,
                timeout_per_client=req.timeout,
                progress_cb=_progress_cb,
            )
        except Exception as e:
            await queue.put({"type": "error", "message": str(e)})

    loop.create_task(_run())

    async def event_gen():
        while True:
            ev = await queue.get()
            yield f"data: {json.dumps(ev, ensure_ascii=False, default=str)}\n\n"
            if ev.get("type") in ("done", "error"):
                break

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---- 历史任务 ----

@router.get("/tasks")
def list_tasks(limit: int = 20):
    return {"tasks": cowork_service.list_recent_tasks(limit)}


@router.get("/tasks/{task_id}")
def get_task(task_id: str):
    task = cowork_service.get_task(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    return task
