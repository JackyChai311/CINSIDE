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
    style: dict[str, Any] | None = Field(None, description="参考风格（analyze-style 返回的 StyleProfile），为空则 AI 自动选风格")
    slides: list[dict[str, Any]] | None = Field(None, description="用户已编辑确认的大纲；传入则跳过 AI 大纲生成，直接按此大纲创建 PPT")
    add_background: bool = Field(False, description="为每页生成基于该页内容的图片背景板")


class DraftOutlineRequest(BaseModel):
    text: str = Field(..., description="用户输入的文字或主题")


class AnalyzeStyleRequest(BaseModel):
    file_path: str = Field(..., description="参考 PPT 文件绝对路径")


class SlideElementsRequest(BaseModel):
    file_path: str
    slide: int = Field(..., ge=1)


class UpdateElementsRequest(BaseModel):
    file_path: str
    slide: int = Field(..., ge=1)
    updates: list[dict[str, Any]] = Field(..., description='[{"path":"shape[2]","props":{"x":"1.0in",...}}]')


class RefineSlideRequest(BaseModel):
    file_path: str
    slide: int = Field(..., ge=1)
    instruction: str = Field(..., description="只针对该页的修改指令")


class ScreenshotRequest(BaseModel):
    file_path: str
    page: int = 1


class PageCountRequest(BaseModel):
    file_path: str


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


@router.post("/draft-outline")
async def draft_outline(req: DraftOutlineRequest):
    """AI 仅生成 PPT 大纲（含 section 分组、每页标题/摘要/要点），不创建文件。

    用户可在前端编辑后再调用 create-from-text-stream 确认生成。
    """
    if not req.text.strip():
        raise HTTPException(400, "请输入主题或文字内容")
    try:
        result = await ppt_service.draft_outline(req.text)
        return result
    except Exception as e:
        raise HTTPException(500, f"大纲生成失败: {e}")


@router.post("/draft-outline-stream")
async def draft_outline_stream(req: DraftOutlineRequest):
    """流式生成大纲：逐 token 推送 LLM 输出，完成后推送结构化结果。

    SSE 事件：
      {"type":"token","text":"..."}
      {"type":"done","style":"...","slides":[...]}
      {"type":"error","message":"..."}
    """
    if not req.text.strip():
        raise HTTPException(400, "请输入主题或文字内容")

    async def event_gen():
        async for ev in ppt_service.draft_outline_stream(req.text):
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/create-from-text-stream")
async def create_from_text_stream(req: CreateFromTextRequest):
    """按文字新建 PPT，并通过 SSE 实时推送每一步放置文字元素的过程。

    事件：
      {"type":"outline","slides":[{title,bullets}]}
      {"type":"add_text","slide":N,"element":"title"|"bullet","text":...}
      {"type":"screenshot","slide":N,"image_data":...}
      {"type":"done", result...} / {"type":"error","message":...}
    """
    if not officecli.is_available():
        raise HTTPException(503, "OfficeCLI 不可用")
    if not req.text.strip():
        raise HTTPException(400, "请输入要生成 PPT 的文字内容")

    queue: asyncio.Queue[dict] = asyncio.Queue()
    loop = asyncio.get_event_loop()

    def _progress_cb(event: dict) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, event)

    async def _run() -> None:
        try:
            result = await ppt_service.create_from_text_stream(
                req.text, _progress_cb,
                style_override=req.style,
                slides_override=req.slides,
                add_background=req.add_background,
            )
            await queue.put({"type": "done", "result": result})
        except Exception as e:
            await queue.put({"type": "error", "message": str(e)})

    loop.create_task(_run())

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
    """为 PPT 指定页生成截图，返回 base64 data URL。"""
    if not os.path.exists(req.file_path):
        raise HTTPException(404, f"文件不存在: {req.file_path}")
    try:
        import base64
        img_path = await run_in_threadpool(
            ppt_service.take_screenshot, req.file_path, req.page
        )
        with open(img_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        return {"image_data": f"data:image/png;base64,{b64}", "image_path": img_path}
    except Exception as e:
        raise HTTPException(500, f"截图失败: {e}")


@router.post("/page-count")
async def page_count(req: PageCountRequest):
    """获取参考文件页数（PPT / PDF）。"""
    if not os.path.exists(req.file_path):
        raise HTTPException(404, f"文件不存在: {req.file_path}")
    try:
        count = await run_in_threadpool(ppt_service.get_page_count, req.file_path)
        return {"page_count": count}
    except Exception as e:
        raise HTTPException(500, f"获取页数失败: {e}")


# ---- 风格库 / 参考风格拆解 ----

@router.get("/style-presets")
def style_presets():
    """列出全部预制教育风格。"""
    from ..services.ppt_styles import list_presets
    return {"presets": list_presets()}


@router.post("/analyze-style")
async def analyze_style(req: AnalyzeStyleRequest):
    """拆解参考 PPT 的视觉风格（截图 → 识图 AI → StyleProfile）。"""
    if not officecli.is_available():
        raise HTTPException(503, "OfficeCLI 不可用")
    if not os.path.exists(req.file_path):
        raise HTTPException(404, f"文件不存在: {req.file_path}")
    try:
        style = await ppt_service.analyze_style(req.file_path)
        return {"style": style}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"风格拆解失败: {e}")


# ---- 单页元素编辑 ----

@router.post("/slide-elements")
async def slide_elements(req: SlideElementsRequest):
    """获取某页全部元素（供前端拖拽编辑）。"""
    if not officecli.is_available():
        raise HTTPException(503, "OfficeCLI 不可用")
    try:
        return await run_in_threadpool(
            ppt_service.get_slide_elements, req.file_path, req.slide
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"读取元素失败: {e}")


@router.post("/update-elements")
async def update_elements(req: UpdateElementsRequest):
    """批量更新某页元素属性（拖拽位置 / 双击改文字），返回最新截图。"""
    if not officecli.is_available():
        raise HTTPException(503, "OfficeCLI 不可用")
    try:
        result = await run_in_threadpool(
            ppt_service.update_slide_elements, req.file_path, req.slide, req.updates
        )
        # 更新成功后回传最新截图，前端立即刷新画面
        if result["applied"]:
            import base64
            img_path = await run_in_threadpool(
                ppt_service.take_screenshot, req.file_path, req.slide
            )
            with open(img_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("ascii")
            result["image_data"] = f"data:image/png;base64,{b64}"
        return result
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"更新元素失败: {e}")


@router.post("/refine-slide")
async def refine_slide(req: RefineSlideRequest):
    """AI 指令只改某一页，返回最新截图。"""
    if not officecli.is_available():
        raise HTTPException(503, "OfficeCLI 不可用")
    if not req.instruction.strip():
        raise HTTPException(400, "请输入修改指令")
    try:
        return await ppt_service.refine_slide(
            req.file_path, req.slide, req.instruction
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"修改本页失败: {e}")
