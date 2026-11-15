"""HARNESS API：双对象（网页 + Excel）Computer Use。

端点：
  GET  /api/harness/status              运行前自检（LLM / CDP / 步数 / 视觉开关）
  GET  /api/harness/targets             可绑定的对象清单（网页页面 + Excel 数据源）
  POST /api/harness/run                 启动任务，SSE 推送「思考 / 动作 / 结果 / 截图」
  POST /api/harness/{task_id}/stop      停止
  POST /api/harness/{task_id}/answer    回答 ask_user 提问
  GET  /api/harness/tasks               最近任务

任务队列（个人桌面的待执行卡片，串行执行、落盘持久化）：
  POST   /api/harness/queue              安排任务 → 一张卡片
  GET    /api/harness/queue              全部卡片
  POST   /api/harness/queue/{id}/cancel  取消 / 停止
  POST   /api/harness/queue/{id}/answer  回答卡片上的追问
  DELETE /api/harness/queue/{id}         从桌面移除
  POST   /api/harness/queue/clear        清理已结束
  POST   /api/harness/queue/resume       重新拉起 worker（重启后恢复）
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..services.harness import planner, runner, scheduler
from ..services.harness.cdp import CDPError, list_targets
from ..services.harness.excel_book import ExcelError, ExcelTarget

router = APIRouter(prefix="/api/harness", tags=["harness"])

# SSE 心跳：长时间没有事件时补一个注释行，避免浏览器/代理把连接判死
_PING_INTERVAL = 15.0


# ---------- 模型 ----------


class WebTargetIn(BaseModel):
    url: str = ""
    label: str = "网页"
    exclude_urls: list[str] = Field(default_factory=list)


class ExcelTargetIn(BaseModel):
    path: str = ""
    label: str = "Excel"


class RunIn(BaseModel):
    instruction: str = Field(..., description="自然语言任务")
    web: Optional[WebTargetIn] = None
    excel: Optional[ExcelTargetIn] = None
    max_steps: Optional[int] = None
    vision: Optional[bool] = None


class AnswerIn(BaseModel):
    answer: str = ""


class QueueIn(BaseModel):
    """个人桌面「安排任务」：一张卡片。"""

    instruction: str = Field(..., description="自然语言任务")
    web: Optional[WebTargetIn] = None
    excel: Optional[ExcelTargetIn] = None
    max_steps: Optional[int] = None
    vision: Optional[bool] = None
    # 用户确认过的流程；带上就按流程执行
    plan: Optional[dict] = None


class PlanIn(BaseModel):
    """让 HARNESS 先出流程（不执行）。"""

    instruction: str = Field(..., description="自然语言任务")
    web: Optional[WebTargetIn] = None
    excel: Optional[ExcelTargetIn] = None


class PlanReviseIn(BaseModel):
    """让 HARNESS 按意见改流程。"""

    plan: dict = Field(default_factory=dict)
    request: str = Field(..., description="修改意见")
    instruction: str = ""
    web: Optional[WebTargetIn] = None
    excel: Optional[ExcelTargetIn] = None


# ---------- 自检 / 对象发现 ----------


@router.get("/status")
async def status():
    base, key, model = settings.effective_harness_llm()
    endpoint = settings.effective_harness_cdp()
    cdp_ok, cdp_msg, pages = False, "", []
    if endpoint:
        try:
            targets = await list_targets(endpoint)
            pages = [t.as_dict() for t in targets if t.type == "page"]
            cdp_ok = True
            cdp_msg = f"{len(pages)} 个可调试页面"
        except CDPError as e:
            cdp_msg = str(e)
    else:
        cdp_msg = "未配置 CDP 端点（HARNESS_CDP_URL / BROWSER_USE_CDP_URL）"
    return {
        "llm_ready": bool(base and key),
        "llm_model": model,
        "llm_base": base,
        "cdp_endpoint": endpoint,
        "cdp_ready": cdp_ok,
        "cdp_message": cdp_msg,
        "pages": pages,
        "max_steps": settings.harness_max_steps,
        "vision": settings.harness_vision,
    }


def _excel_sources() -> list[dict]:
    """收集可绑定的 Excel 数据源：当前载入的左右表格 + samples 目录。"""
    out: list[dict] = []
    try:
        from .upload import LEFT_SOURCE, RIGHT_SOURCE
    except Exception:  # pragma: no cover - 极端导入失败也不该 500
        LEFT_SOURCE, RIGHT_SOURCE = {}, {}

    for side, src, label in (
        ("left", LEFT_SOURCE, "左侧数据源（当前载入）"),
        ("right", RIGHT_SOURCE, "右侧表格（当前载入）"),
    ):
        path = src.get("path") or ""
        filename = src.get("filename") or (os.path.basename(path) if path else "")
        if not filename:
            continue
        # 浏览器上传的表格只有字节没有路径：落一份临时文件，让它同样可被 HARNESS 绑定
        # （HARNESS 全程读写工作副本，源文件只读，落盘不影响用户数据）
        if not path and src.get("bytes"):
            try:
                src_dir = os.path.join(settings.upload_dir, "_harness", "_sources")
                os.makedirs(src_dir, exist_ok=True)
                tmp_path = os.path.join(src_dir, os.path.basename(filename) or f"{side}.xlsx")
                with open(tmp_path, "wb") as f:
                    f.write(src["bytes"])
                path = tmp_path
            except OSError:
                path = ""
        out.append(
            {
                "id": f"loaded-{side}",
                "label": label,
                "filename": filename,
                "path": path,
                "kind": src.get("kind") or "bytes",
                "editable": bool(path and os.path.exists(path)),
            }
        )

    sample_dir = settings.sample_dir
    if sample_dir and os.path.isdir(sample_dir):
        for name in sorted(os.listdir(sample_dir))[:20]:
            if name.lower().endswith((".xlsx", ".xlsm", ".csv")):
                out.append(
                    {
                        "id": f"sample-{name}",
                        "label": "示例文件",
                        "filename": name,
                        "path": os.path.join(sample_dir, name),
                        "kind": "path",
                        "editable": True,
                    }
                )
    return out


@router.get("/targets")
async def targets():
    """返回可绑定的网页页面与 Excel 数据源。"""
    endpoint = settings.effective_harness_cdp()
    pages: list[dict] = []
    cdp_error = ""
    if endpoint:
        try:
            for t in await list_targets(endpoint):
                if t.type != "page":
                    continue
                if t.url.startswith(("devtools://", "chrome://", "chrome-extension://")):
                    continue
                pages.append(
                    {
                        "id": t.id,
                        "title": t.title or "（无标题）",
                        "url": t.url,
                        "internal": t.url.startswith(("about:", "file://"))
                        or "localhost:5173" in t.url
                        or "127.0.0.1:5173" in t.url,
                    }
                )
        except CDPError as e:
            cdp_error = str(e)
    else:
        cdp_error = "未配置 CDP 端点"
    return {
        "pages": [p for p in pages if not p["internal"]],
        "all_pages": pages,
        "cdp_error": cdp_error,
        "excel_sources": _excel_sources(),
    }


@router.post("/excel/inspect")
async def inspect_excel(body: ExcelTargetIn):
    """绑定前先看一眼文件：工作表、表头、行数。"""
    if not body.path or not os.path.exists(body.path):
        raise HTTPException(400, f"文件不存在：{body.path}")
    target = ExcelTarget(body.path, work_dir=_harness_tmp(), label=body.label)
    try:
        await target.open()
        summary = await target.summary()
    except ExcelError as e:
        raise HTTPException(400, str(e))
    return {"summary": summary}


def _harness_tmp() -> str:
    d = os.path.join(settings.upload_dir, "_harness", "_inspect")
    os.makedirs(d, exist_ok=True)
    return d


# ---------- 运行 ----------


@router.post("/run")
async def run_task(body: RunIn):
    """启动 HARNESS 任务，SSE 流式推送执行过程。"""
    instruction = (body.instruction or "").strip()
    if not instruction:
        raise HTTPException(400, "任务描述不能为空")
    if not body.web and not body.excel:
        raise HTTPException(400, "请至少选中一个对象（网页或 Excel）")

    endpoint = settings.effective_harness_cdp()
    if body.web and not endpoint:
        raise HTTPException(400, "网页对象需要 CDP 端点：请确认通过 Electron 启动（开发版 9223 / 正式版 9222）")
    if body.excel and not body.excel.path:
        raise HTTPException(400, "Excel 对象缺少文件路径")
    if body.excel and not os.path.exists(body.excel.path):
        raise HTTPException(400, f"Excel 文件不存在：{body.excel.path}")

    # 同一时刻只允许一个 HARNESS 任务：两个任务同时操控同一个 BrowserView 会互相打架
    if runner.ACTIVE:
        running = next(iter(runner.ACTIVE.values()))
        raise HTTPException(409, f"已有 HARNESS 任务在执行（{running.task_id}），请先停止它")

    session = runner.new_session(
        instruction=instruction,
        web=runner.WebBinding(
            endpoint=endpoint,
            url=(body.web.url if body.web else ""),
            label=(body.web.label if body.web else "网页"),
            exclude_urls=(body.web.exclude_urls if body.web else []),
        )
        if body.web
        else None,
        excel=runner.ExcelBinding(path=body.excel.path, label=body.excel.label) if body.excel else None,
        max_steps=max(1, min(body.max_steps or settings.harness_max_steps, 120)),
        vision=settings.harness_vision if body.vision is None else bool(body.vision),
    )

    queue: asyncio.Queue[dict] = asyncio.Queue()
    loop = asyncio.get_event_loop()

    async def emit(ev: dict) -> None:
        await queue.put(ev)

    async def _run() -> None:
        await runner.run(session, emit)

    loop.create_task(_run())

    async def event_gen():
        # 首个事件把 task_id 交给前端（停止/回答要用）
        yield f"data: {json.dumps({'type': 'accepted', 'taskId': session.task_id}, ensure_ascii=False)}\n\n"
        while True:
            try:
                ev = await asyncio.wait_for(queue.get(), timeout=_PING_INTERVAL)
            except asyncio.TimeoutError:
                yield ": ping\n\n"
                continue
            yield f"data: {json.dumps(ev, ensure_ascii=False, default=str)}\n\n"
            if ev.get("type") in ("final", "error", "stopped"):
                break

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/{task_id}/stop")
def stop_task(task_id: str):
    sess = runner.get_session(task_id)
    if not sess:
        return {"ok": False, "message": "任务已结束或不存在"}
    sess.request_stop()
    return {"ok": True}


@router.post("/{task_id}/answer")
def answer_task(task_id: str, body: AnswerIn):
    sess = runner.get_session(task_id)
    if not sess:
        raise HTTPException(404, "任务已结束或不存在")
    ok = sess.answer(body.answer)
    return {"ok": ok}


@router.get("/tasks")
def list_tasks(limit: int = 20):
    return {"tasks": runner.recent_sessions(limit)}


# ---------- 任务队列（个人桌面的待执行卡片） ----------


async def _autofill_web(web: WebTargetIn) -> WebTargetIn:
    """卡片只说了「用网页」，没指定是哪个页面：自动挑当前唯一的可调试页面。"""
    if web.url:
        return web
    endpoint = settings.effective_harness_cdp()
    if not endpoint:
        return web
    try:
        targets = await list_targets(endpoint)
    except CDPError:
        return web
    pages = [t for t in targets if t.type == "page" and t.url]
    if len(pages) == 1:
        web.url = pages[0].url
        web.label = web.label if web.label and web.label != "网页" else (pages[0].title or "网页")
    return web


def _web_dict(web: Optional[WebTargetIn]) -> dict | None:
    if not web:
        return None
    return {"url": web.url, "label": web.label or "网页", "exclude_urls": web.exclude_urls}


def _excel_dict(excel: Optional[ExcelTargetIn]) -> dict | None:
    if not excel:
        return None
    return {"path": excel.path, "label": excel.label or "Excel"}


@router.post("/plan")
async def make_plan(body: PlanIn):
    """先出流程：观察真实页面 + 表格，返回一条可核对、可修改的步骤清单（不执行）。"""
    instruction = (body.instruction or "").strip()
    if not instruction:
        raise HTTPException(400, "任务描述不能为空")
    if not body.web and not body.excel:
        raise HTTPException(400, "请至少绑定一个对象（网页或 Excel）")
    if body.web:
        body.web = await _autofill_web(body.web)
    try:
        plan = await planner.draft_plan(instruction, _web_dict(body.web), _excel_dict(body.excel))
    except RuntimeError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001 - 规划失败要让用户看到原因
        raise HTTPException(500, f"生成流程失败：{type(e).__name__}: {e}") from e
    plan["instruction"] = instruction
    return {"ok": True, "plan": plan}


@router.post("/plan/revise")
async def revise_plan(body: PlanReviseIn):
    """让 HARNESS 按用户意见改流程。"""
    request = (body.request or "").strip()
    if not request:
        raise HTTPException(400, "请说明要怎么改")
    if body.web:
        body.web = await _autofill_web(body.web)
    current = dict(body.plan or {})
    current["instruction"] = body.instruction or current.get("instruction") or ""
    try:
        plan = await planner.revise_plan(
            current, request, _web_dict(body.web), _excel_dict(body.excel)
        )
    except RuntimeError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"修改流程失败：{type(e).__name__}: {e}") from e
    plan["instruction"] = current["instruction"]
    return {"ok": True, "plan": plan}


@router.post("/queue")
async def queue_add(body: QueueIn):
    """安排一个任务：立刻变成一张待执行卡片，按顺序自动跑。"""
    instruction = (body.instruction or "").strip()
    if not instruction:
        raise HTTPException(400, "任务描述不能为空")
    if not body.web and not body.excel:
        raise HTTPException(400, "请至少绑定一个对象（网页或 Excel），否则 HARNESS 无从下手")

    if body.web:
        endpoint = settings.effective_harness_cdp()
        if not endpoint:
            raise HTTPException(400, "网页对象需要 CDP 端点：请确认通过 Electron 启动")
        body.web = await _autofill_web(body.web)
    if body.excel:
        if not body.excel.path:
            raise HTTPException(400, "Excel 对象缺少文件路径")
        if not os.path.exists(body.excel.path):
            raise HTTPException(400, f"Excel 文件不存在：{body.excel.path}")

    task = scheduler.enqueue(
        instruction=instruction,
        web=_web_dict(body.web),
        excel=_excel_dict(body.excel),
        max_steps=body.max_steps,
        vision=body.vision,
        plan=body.plan if isinstance(body.plan, dict) else None,
    )
    return {"ok": True, "task": task.as_dict()}


@router.get("/queue")
def queue_list():
    return {"tasks": scheduler.list_tasks()}


@router.post("/queue/resume")
def queue_resume():
    """应用重启后，手动（或前端自动）把队列重新跑起来。"""
    scheduler.ensure_worker()
    return {"ok": True}


@router.post("/queue/clear")
def queue_clear():
    return scheduler.clear_finished()


@router.post("/queue/{task_id}/cancel")
def queue_cancel(task_id: str):
    return scheduler.cancel(task_id)


@router.post("/queue/{task_id}/answer")
def queue_answer(task_id: str, body: AnswerIn):
    return scheduler.answer(task_id, body.answer)


@router.delete("/queue/{task_id}")
def queue_discard(task_id: str):
    return scheduler.discard(task_id)
