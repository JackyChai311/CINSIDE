"""核验任务路由。"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from ..models import WorkflowConfig
from ..services.report_excel import generate_excel, generate_filename
from ..services.task_manager import (
    get_record,
    get_report,
    get_task,
    list_tasks,
    run_configurable_verification,
    run_verification,
    signal_continue,
)

router = APIRouter(prefix="/api/verify", tags=["verify"])


class VerifyRequest(BaseModel):
    record_id: str
    university_url: Optional[str] = None


@router.post("")
async def start_verify(req: VerifyRequest):
    """触发一次核验，立即返回 task_id，后续通过 WebSocket 跟进进度。"""
    rec = get_record(req.record_id)
    if not rec:
        raise HTTPException(404, f"record {req.record_id} not found")
    try:
        task_id = await run_verification(req.record_id, req.university_url)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"task_id": task_id, "record_id": req.record_id}


@router.get("/{task_id}")
def get_result(task_id: str):
    t = get_task(task_id)
    if not t:
        raise HTTPException(404, "task not found")
    return t.model_dump()


@router.get("")
def list_all():
    return {"tasks": [t.model_dump() for t in list_tasks()]}


# ========== 可配置工作流验证（新） ==========

@router.post("/configurable")
async def start_configurable_verify(config: WorkflowConfig):
    """启动用户配置的工作流验证。"""
    rec = get_record(config.record_id)
    if not rec:
        raise HTTPException(404, f"record {config.record_id} not found")
    try:
        task_id = await run_configurable_verification(config)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"task_id": task_id, "record_id": config.record_id, "mode": "configurable"}


@router.get("/report/{task_id}")
def get_verification_report(task_id: str):
    report = get_report(task_id)
    if not report:
        raise HTTPException(404, "report not found")
    return report.model_dump()


@router.post("/{task_id}/continue")
def continue_manual_step(task_id: str):
    """当工作流遇到 manual 步骤时，由前端调用以继续执行。"""
    if signal_continue(task_id):
        return {"ok": True, "task_id": task_id}
    raise HTTPException(404, "task not found or not waiting for manual step")


@router.get("/report/{task_id}/excel")
def download_excel_report(task_id: str):
    report = get_report(task_id)
    if not report:
        raise HTTPException(404, "report not found")
    data = generate_excel(report)
    filename = generate_filename(report)
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
