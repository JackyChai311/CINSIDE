"""应用配置读写接口。"""
from __future__ import annotations

import json

import httpx
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..config import settings, SETTING_KEYS
from ..services.document_extract import ensure_umi_ocr_running, launch_umi_ocr, browse_umi_ocr_executable, open_umi_ocr_folder, check_markitdown_available
from ..services.dependency_manager import (
    download_and_install_umi_ocr,
    download_and_install_umi_ocr_stream,
    get_all_deps_status,
    install_officecli,
    install_python_deps,
    install_remotion,
)

router = APIRouter(prefix="/api/config", tags=["config"])


class AppSettings(BaseModel):
    agent_backend: str = "browser_use"
    vision_api_base: str = ""
    vision_api_key: str = ""
    vision_model: str = ""
    browser_use_llm_base: str = ""
    browser_use_llm_key: str = ""
    browser_use_llm_model: str = ""
    ocr_engine: str = "vision"
    umi_ocr_host: str = "127.0.0.1"
    umi_ocr_port: int = 1224
    umi_ocr_exe_path: str = ""
    beginner_mode: bool = False
    prevent_accidental_close: bool = False
    ui_scale: float = 1.0
    theme: str = "light"
    accent: str = "indigo"
    browser_brightness: float = 1.0


# 1x1 透明 PNG，用来检测模型是否接受 image_url
_TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


@router.get("/settings")
def get_settings():
    """返回前端设置面板需要的配置项。"""
    return settings.to_settings_dict()


@router.post("/settings")
def save_settings(body: AppSettings):
    """保存设置到内存并持久化到 .env。"""
    import time
    data = body.model_dump()
    # 备份当前内存值，persist 失败时回滚，避免"当前会话生效但重启丢失"的假象
    backup = {name: getattr(settings, name) for name in SETTING_KEYS}

    settings.update_from_dict(data)
    t0 = time.time()
    try:
        settings.persist()
    except RuntimeError as e:
        _rollback(backup)
        print(f"[save-settings] persist FAILED ({time.time()-t0:.2f}s): {e}", flush=True)
        return {"ok": False, "error": str(e)}
    except Exception as e:
        _rollback(backup)
        print(f"[save-settings] persist ERROR ({time.time()-t0:.2f}s): {e}", flush=True)
        return {"ok": False, "error": f"写入 .env 失败: {e}"}
    print(f"[save-settings] persist OK in {time.time()-t0:.3f}s", flush=True)
    return {"ok": True}


def _rollback(backup: dict) -> None:
    """persist 失败时把内存设置恢复到持久化前的值。"""
    for name, val in backup.items():
        setattr(settings, name, val)


@router.post("/test-vision")
async def test_vision():
    """检测当前 Vision 模型是否支持图片输入。"""
    if not settings.vision_api_key:
        return {"supports_images": False, "message": "未配置 Vision API Key"}
    if not settings.vision_api_base:
        return {"supports_images": False, "message": "未配置 Vision API Base URL"}
    if not settings.vision_model:
        return {"supports_images": False, "message": "未配置 Vision Model"}

    base = settings.vision_api_base.strip().rstrip("/")
    # 提前校验 URL 协议，避免 hhttps:// 这类拼写错误导致请求长时间挂起
    if not base.startswith(("http://", "https://")):
        return {"supports_images": False, "message": f"API Base URL 格式错误（应以 http:// 或 https:// 开头）：{base[:60]}"}
    url = base + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.vision_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": settings.vision_model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "图中有什么？请只回答“透明像素”或“无内容”。"},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{_TINY_PNG_B64}"}},
                ],
            }
        ],
        "max_tokens": 20,
        "temperature": 0.1,
    }

    try:
        async with httpx.AsyncClient(timeout=12.0, trust_env=False) as client:
            resp = await client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
            # 只要模型正常返回内容，就说明支持图片输入
            if data.get("choices"):
                return {"supports_images": True, "message": "该模型支持图片输入"}
            return {"supports_images": False, "message": "接口未返回 choices，可能不支持图片输入"}
    except httpx.HTTPStatusError as e:
        text = e.response.text or str(e)
        # 常见的 vision 不支持错误：BadRequest / model not found / image not supported
        return {"supports_images": False, "message": f"模型不支持图片输入或配置错误: {text[:200]}"}
    except Exception as e:
        return {"supports_images": False, "message": f"检测失败: {e}"}


@router.post("/test-umi-ocr")
async def test_umi_ocr():
    """检测 UMI-OCR 服务是否可用（未运行时尝试自动启动）。"""
    ok, msg = await ensure_umi_ocr_running()
    return {"ok": ok, "message": msg, "host": settings.umi_ocr_host, "port": settings.umi_ocr_port}


@router.post("/launch-umi-ocr")
async def api_launch_umi_ocr():
    """一键启动 UMI-OCR（用户主动点击按钮时调用，允许反复重试）。"""
    ok, msg = await launch_umi_ocr()
    return {"ok": ok, "message": msg, "exe_path": settings.umi_ocr_exe_path}


@router.post("/open-umi-ocr-folder")
async def api_open_umi_ocr_folder():
    """在系统文件管理器中打开 UMI-OCR 所在文件夹（选中其 exe），便于用户手动双击启动。"""
    ok, msg, exe_path = open_umi_ocr_folder()
    return {"ok": ok, "message": msg, "exe_path": exe_path}


@router.post("/browse-umi-ocr")
async def api_browse_umi_ocr():
    """弹出系统文件选择对话框，让用户选择 Umi-OCR.exe，并保存路径到配置。"""
    path = browse_umi_ocr_executable()
    if not path:
        return {"ok": False, "message": "已取消选择", "path": ""}
    # 持久化保存路径
    settings.update_from_dict({"umi_ocr_exe_path": path})
    settings.persist()
    return {"ok": True, "message": f"已选择：{path}", "path": path}


@router.post("/test-markitdown")
async def test_markitdown():
    """检测 MarkItDown（文档解析）和 PyMuPDF（PDF 渲染）是否可用。"""
    ok, msg = check_markitdown_available()
    return {"ok": ok, "message": msg}


# ============ 依赖与外部工具管理 ============

@router.get("/deps-status")
def deps_status():
    """返回所有 Python 依赖和外部工具（UMI-OCR）的安装状态。"""
    return get_all_deps_status()


@router.post("/install-python-deps")
def install_python_deps_endpoint():
    """一键安装/修复所有缺失的 Python 依赖（markitdown、PyMuPDF、pillow-heif）。"""
    ok, msg = install_python_deps()
    return {"ok": ok, "message": msg}


@router.post("/download-umi-ocr")
def download_umi_ocr_endpoint():
    """从 GitHub Release 下载并安装最新版 UMI-OCR 到用户工具目录。

    此操作可能耗时数分钟（下载约 100MB），同步执行，前端需显示加载状态。
    """
    ok, msg, exe_path = download_and_install_umi_ocr()
    return {"ok": ok, "message": msg, "exe_path": exe_path}


@router.get("/download-umi-ocr/stream")
async def download_umi_ocr_stream_endpoint():
    """SSE 流式下载安装 UMI-OCR，实时推送进度。"""
    from starlette.concurrency import iterate_in_threadpool

    sync_gen = download_and_install_umi_ocr_stream()

    async def event_stream():
        async for event in iterate_in_threadpool(sync_gen):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/install-remotion")
def install_remotion_endpoint():
    """通过 npm 在工具目录中安装 Remotion 视频渲染依赖。

    此操作可能耗时数分钟（下载约 100-200MB），同步执行，前端需显示加载状态。
    """
    ok, msg = install_remotion()
    return {"ok": ok, "message": msg}


@router.post("/install-officecli")
def install_officecli_endpoint():
    """通过 npm 在工具目录中安装 OfficeCLI 文档操作依赖。

    幻灯片任务需要 OfficeCLI 来读取和修改 PPT 文件。
    此操作可能耗时数十秒到数分钟（取决于网络），同步执行，前端需显示加载状态。
    """
    ok, msg = install_officecli()
    return {"ok": ok, "message": msg}


# ========== LOOP 卡片分享（GitHub Gist）==========

class ShareCreateRequest(BaseModel):
    template: dict


@router.post("/share/create")
async def share_create(req: ShareCreateRequest):
    """创建 GitHub Gist 分享，返回短码。"""
    from starlette.concurrency import run_in_threadpool
    from ..services.share_service import create_gist_share

    result = await run_in_threadpool(create_gist_share, req.template)
    return result


@router.get("/share/fetch")
async def share_fetch(code: str):
    """根据分享码获取 LOOP 卡片模板。"""
    from starlette.concurrency import run_in_threadpool
    from ..services.share_service import get_gist_share

    result = await run_in_threadpool(get_gist_share, code)
    return result
