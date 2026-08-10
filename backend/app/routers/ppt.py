"""PPT 幻灯片任务 API 路由。

提供 PPT section 拆分、合并、AI 修改、回填等接口。
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from ..config import settings
from ..services import officecli, ppt_service

router = APIRouter(prefix="/api/ppt", tags=["ppt"])


# ---- 请求/响应模型 ----

class AnalyzeRequest(BaseModel):
    file_paths: list[str] = Field(..., description="本地 PPT 文件绝对路径列表")


class DetectSectionsRequest(BaseModel):
    files: list[dict[str, Any]] = Field(..., description="analyze 返回的文件幻灯片结构")
    instruction: str = Field("", description="用户对章节拆分/提取的自然语言指令")


class MergeRequest(BaseModel):
    sections: list[dict[str, Any]] = Field(..., description="detect-sections 返回的 section 结构")


class ModifyRequest(BaseModel):
    sections: list[dict[str, Any]]
    instruction: str = ""


class ApplyPatchesRequest(BaseModel):
    patches: list[dict[str, Any]]


class CreateFromTextRequest(BaseModel):
    text: str = Field(..., description="用户输入的文字（大纲/要点/正文）")


class ScreenshotRequest(BaseModel):
    file_path: str
    page: int = 1


class ImportLocalRequest(BaseModel):
    file_paths: list[str] = Field(default_factory=list)
    directory: str = ""


# ---- 接口 ----

@router.get("/status")
def get_status():
    """检查 OfficeCLI 是否可用。"""
    return officecli.get_status()


@router.post("/import-local")
def import_local(req: ImportLocalRequest):
    """导入本地 PPT 文件（支持直接指定路径或扫描目录）。"""
    file_paths: list[str] = list(req.file_paths)

    # 如果指定了目录，递归扫描
    if req.directory:
        dir_path = Path(req.directory)
        if not dir_path.exists():
            raise HTTPException(400, f"目录不存在: {req.directory}")
        for ext in ("*.ppt", "*.pptx"):
            for p in dir_path.rglob(ext):
                fp = str(p.resolve())
                if fp not in file_paths:
                    file_paths.append(fp)

    # 验证文件存在且是 PPT
    valid: list[dict[str, str]] = []
    for fp in file_paths:
        p = Path(fp)
        if not p.exists():
            continue
        if p.suffix.lower() not in (".ppt", ".pptx"):
            continue
        valid.append({
            "file_path": str(p.resolve()),
            "file_name": p.name,
            "size": p.stat().st_size,
        })

    return {"files": valid, "count": len(valid)}


@router.post("/analyze")
async def analyze(req: AnalyzeRequest):
    """解析多个 PPT 文件的幻灯片及文本节点。"""
    if not officecli.is_available():
        raise HTTPException(503, "OfficeCLI 不可用，请先安装依赖")
    try:
        result = await run_in_threadpool(ppt_service.analyze_files, req.file_paths)
        return {"files": result}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"解析失败: {e}")


@router.post("/analyze-stream")
async def analyze_stream(req: AnalyzeRequest):
    """SSE 流式解析 PPT，实时推送每个文件的处理进度。"""
    if not officecli.is_available():
        raise HTTPException(503, "OfficeCLI 不可用，请先安装依赖")

    queue: asyncio.Queue[dict] = asyncio.Queue()
    loop = asyncio.get_event_loop()

    def _progress_cb(idx: int, total: int, name: str, status: str, extra: dict) -> None:
        loop.call_soon_threadsafe(
            queue.put_nowait,
            {"index": idx, "total": total, "file": name, "status": status, **extra},
        )

    def _run() -> None:
        try:
            files = ppt_service.analyze_files(req.file_paths, progress_cb=_progress_cb)
            loop.call_soon_threadsafe(queue.put_nowait, {"type": "done", "files": files})
        except Exception as e:
            loop.call_soon_threadsafe(
                queue.put_nowait, {"type": "error", "message": str(e)}
            )

    loop.run_in_executor(None, _run)

    async def event_gen():
        while True:
            event = await queue.get()
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            if event.get("type") in ("done", "error"):
                break

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/ai-info")
def ai_info():
    """返回 PPT 任务使用的 AI 配置（与网页任务共用同一套）。"""
    return {
        "shared": True,
        "provider": settings.browser_use_llm_base,
        "model": settings.browser_use_llm_model,
        "configured": bool(settings.browser_use_llm_key),
    }


@router.post("/create-from-text")
async def create_from_text(req: CreateFromTextRequest):
    """根据用户输入的文字生成一份新 PPT。"""
    if not officecli.is_available():
        raise HTTPException(503, "OfficeCLI 不可用")
    if not req.text.strip():
        raise HTTPException(400, "请输入要生成 PPT 的文字内容")
    try:
        result = await ppt_service.create_from_text(req.text)
        return result
    except Exception as e:
        raise HTTPException(500, f"生成 PPT 失败: {e}")


@router.post("/detect-sections")
async def detect_sections(req: DetectSectionsRequest):
    """AI 识别每个 PPT 的 section 章节。"""
    try:
        sections = await ppt_service.detect_sections(req.files, req.instruction)
        reading_script = ppt_service.build_reading_script(sections)
        return {"sections": sections, "readingScript": reading_script}
    except Exception as e:
        raise HTTPException(500, f"Section 识别失败: {e}")


@router.post("/merge")
async def merge(req: MergeRequest):
    """将各 section 合并为一个总览 PPT。"""
    if not officecli.is_available():
        raise HTTPException(503, "OfficeCLI 不可用")
    try:
        result = await run_in_threadpool(ppt_service.build_merged_ppt, req.sections)
        return result
    except Exception as e:
        raise HTTPException(500, f"合并失败: {e}")


@router.post("/modify")
async def modify(req: ModifyRequest):
    """AI 统一修改内容，返回补丁列表。"""
    try:
        patches = await ppt_service.modify_content(req.sections, req.instruction)
        return {"patches": patches, "count": len(patches)}
    except Exception as e:
        raise HTTPException(500, f"AI 修改失败: {e}")


@router.post("/apply")
async def apply_patches(req: ApplyPatchesRequest):
    """将补丁原位写回各原始 PPT。"""
    if not officecli.is_available():
        raise HTTPException(503, "OfficeCLI 不可用")
    try:
        result = await run_in_threadpool(ppt_service.apply_patches, req.patches)
        return result
    except Exception as e:
        raise HTTPException(500, f"回填失败: {e}")


@router.post("/screenshot")
async def screenshot(req: ScreenshotRequest):
    """为 PPT 指定页生成截图。"""
    if not os.path.exists(req.file_path):
        raise HTTPException(404, f"文件不存在: {req.file_path}")
    try:
        img_path = await run_in_threadpool(
            ppt_service.take_screenshot, req.file_path, req.page
        )
        return {"image_path": img_path}
    except Exception as e:
        raise HTTPException(500, f"截图失败: {e}")
