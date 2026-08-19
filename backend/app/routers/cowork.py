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


class ClientPathIn(BaseModel):
    client_id: str
    path: str = ""  # 空 = 清除自定义位置，恢复 PATH 自动检测


class HumanTaskIn(BaseModel):
    id: str = ""
    title: str
    assignee: str = "未分配"
    status: str = "todo"
    note: str = ""
    file_path: str = ""       # 指定的本机文件绝对路径
    extract_note: str = ""    # 提取要求


class HumanTaskIdIn(BaseModel):
    id: str


class HumanExtractIn(BaseModel):
    task_id: str
    engine: str | None = None  # 可选临时指定 OCR 引擎


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


# ---- 客户端检测与位置设置 ----

@router.get("/clients")
async def detect_clients():
    """检测本机已安装的编码客户端（用户手动设置的位置优先于 PATH）。"""
    clients = await run_in_threadpool(cowork_service.detect_clients)
    return {"clients": clients}


@router.post("/clients/path")
async def set_client_path(req: ClientPathIn):
    """设置/清除客户端可执行文件位置。"""
    ok = await run_in_threadpool(cowork_service.save_client_path, req.client_id, req.path)
    if not ok:
        raise HTTPException(404, "客户端不存在")
    clients = await run_in_threadpool(cowork_service.detect_clients)
    return {"ok": True, "clients": clients}


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


# ---- 人工协作：任务看板 + 指定本地文件提取 ----

@router.get("/human/tasks")
def list_human_tasks():
    return {"tasks": cowork_service.list_human_tasks()}


@router.post("/human/tasks")
def save_human_task(req: HumanTaskIn):
    if not req.title.strip():
        raise HTTPException(400, "任务标题不能为空")
    if req.status not in ("todo", "doing", "done"):
        raise HTTPException(400, "无效的任务状态")
    saved = cowork_service.save_human_task(req.model_dump())
    return {"task": saved}


@router.post("/human/tasks/delete")
def delete_human_task(req: HumanTaskIdIn):
    ok = cowork_service.delete_human_task(req.id)
    if not ok:
        raise HTTPException(404, "任务不存在")
    return {"ok": True}


@router.post("/human/tasks/extract")
async def extract_human_task_file(req: HumanExtractIn):
    """按任务里指定的本机文件路径提取内容（搬运自 Hannsonus 的 filePath 模式）。

    执行者点击提取 → 后端读取该路径 → 复用 document_extract 提取全文与字段 → 结果回填任务。
    """
    task = cowork_service.get_human_task(req.task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    if not task.file_path.strip():
        raise HTTPException(400, "该任务未指定要提取的本地文件路径")

    p, err = cowork_service.check_human_extract_file(task.file_path)
    if err:
        raise HTTPException(400, err)

    content = p.read_bytes()
    fields = cowork_service.parse_extract_note(task.extract_note)
    from ..services.document_extract import extract_document
    try:
        result = await extract_document(content, p.name, fields or None, engine=req.engine)
    except RuntimeError as e:
        raise HTTPException(500, f"提取失败: {e}")
    except Exception as e:
        raise HTTPException(400, f"提取失败: {e}")

    updated = cowork_service.set_human_task_extract(
        req.task_id,
        text=result.get("text", ""),
        fields=result.get("fields") or {},
        method=result.get("method", ""),
    )
    from dataclasses import asdict
    return {"task": asdict(updated)}
