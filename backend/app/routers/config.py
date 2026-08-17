"""应用配置读写接口。"""
from __future__ import annotations

import json

import httpx
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..config import settings, SETTING_KEYS
from ..services.document_extract import ensure_umi_ocr_running, launch_umi_ocr, browse_umi_ocr_executable, open_umi_ocr_folder, check_markitdown_available
from ..services import gpu_detect
from ..services import gpu_ocr
from ..services.dependency_manager import (
    download_and_install_umi_ocr,
    download_and_install_umi_ocr_stream,
    get_all_deps_status,
    install_ocr_engine_deps,
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
    text_api_base: str = ""
    text_api_key: str = ""
    text_model: str = ""
    analysis_api_base: str = ""
    analysis_api_key: str = ""
    analysis_model: str = ""
    sensenova_api_base: str = "https://token.sensenova.cn/v1"
    sensenova_api_key: str = ""
    sensenova_model: str = "sensenova-u1-fast"
    browser_use_llm_base: str = ""
    browser_use_llm_key: str = ""
    browser_use_llm_model: str = ""
    ocr_engine: str = "vision"
    vision_auto_orient: bool = True
    vision_viz_fallback: bool = False
    umi_ocr_host: str = "127.0.0.1"
    umi_ocr_port: int = 1224
    umi_ocr_exe_path: str = ""
    beginner_mode: bool = False
    demo_site_enabled: bool = False
    prevent_accidental_close: bool = False
    loop_keep_awake: bool = False
    high_speed_mode: bool = False
    igpu_acceleration: bool = False
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
    # exclude_unset：只取请求体里真正出现的字段。
    # 否则 Pydantic 会给未传字段填模型默认值 → 部分更新请求把
    # API Key 等其他设置整体覆盖成空（前端全量保存不受影响）。
    data = body.model_dump(exclude_unset=True)
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


class ListModelsRequest(BaseModel):
    api_base: str = ""
    api_key: str = ""


@router.post("/list-models")
async def list_models(body: ListModelsRequest):
    """识别端点可用模型：填好 API Base URL + Key 后调 {base}/models 拉取模型列表。

    设置面板不再手输模型名——点「识别」由程序查该端点有哪些可用 AI 选项。
    兼容 base 不带 /v1 的写法（自动补试 {base}/v1/models）。
    """
    base = (body.api_base or "").strip().rstrip("/")
    key = (body.api_key or "").strip()
    if not base.startswith(("http://", "https://")):
        return {"ok": False, "error": "请先填写正确的 API Base URL（以 http:// 或 https:// 开头）"}
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    candidates = [base + "/models"]
    if not base.endswith("/v1"):
        candidates.append(base.rstrip("/") + "/v1/models")
    last_err = ""
    async with httpx.AsyncClient(timeout=15.0, trust_env=False) as client:
        for url in candidates:
            try:
                resp = await client.get(url, headers=headers)
                if resp.status_code == 404:
                    last_err = "端点无 /models 路由"
                    continue
                resp.raise_for_status()
                data = resp.json()
                # OpenAI 兼容格式 {"data": [{"id": ...}]}；个别服务直接返回数组
                items = data.get("data") if isinstance(data, dict) else data
                if not isinstance(items, list):
                    last_err = "端点返回格式不认识"
                    continue
                ids = sorted({str(m.get("id")) for m in items if isinstance(m, dict) and m.get("id")})
                if ids:
                    return {"ok": True, "models": ids}
                last_err = "端点未返回任何模型"
            except Exception as e:
                last_err = str(e)
    return {"ok": False, "error": f"识别失败：{last_err[:200]}"}


@router.post("/test-umi-ocr")
async def test_umi_ocr():
    """检测 UMI-OCR 服务是否可用（未运行时尝试自动启动）。"""
    ok, msg = await ensure_umi_ocr_running()
    return {"ok": ok, "message": msg, "host": settings.umi_ocr_host, "port": settings.umi_ocr_port}


class TestLLMRequest(BaseModel):
    """手写模型测试：三个字段留空时按已保存配置继承（分析→文本→识图 / 生图默认值）。"""
    api_base: str | None = None
    api_key: str | None = None
    model: str | None = None


@router.post("/test-analysis")
async def test_analysis(body: TestLLMRequest):
    """测试全局分析模型：按面板当前填写发一次极小 chat 请求，验证手写型号真实可用。"""
    base = (body.api_base or "").strip()
    key = (body.api_key or "").strip()
    model = (body.model or "").strip()
    eb, ek, em = settings.effective_analysis_llm()
    base = base or eb
    key = key or ek
    model = model or em
    if not (base and key and model):
        return {"ok": False, "message": "地址 / 密钥 / 模型不完整：请填写，或保存继承配置后再测"}
    base = base.rstrip("/")
    if not base.startswith(("http://", "https://")):
        return {"ok": False, "message": "API Base URL 格式错误（应以 http:// 或 https:// 开头）"}
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    # 端点模型名大小写敏感：404 时自动小写重试一次
    for m in dict.fromkeys(filter(None, (model, model.lower() if model != model.lower() else None))):
        try:
            async with httpx.AsyncClient(timeout=30.0, trust_env=False) as client:
                resp = await client.post(
                    base + "/chat/completions",
                    headers=headers,
                    json={"model": m, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 8, "temperature": 0.1},
                )
                if resp.status_code == 404 and m != m.lower():
                    continue
                resp.raise_for_status()
                if resp.json().get("choices"):
                    return {"ok": True, "message": f"模型 {m} 可用，分析任务就绪"}
                return {"ok": False, "message": "接口返回异常（无 choices），请检查地址与模型"}
        except httpx.HTTPStatusError as e:
            return {"ok": False, "message": f"HTTP {e.response.status_code}：{(e.response.text or str(e))[:160]}"}
        except Exception as e:
            return {"ok": False, "message": f"连接失败：{e}"}
    return {"ok": False, "message": f"端点无模型 {model}（404），请核对型号拼写"}


@router.post("/test-imagegen")
async def test_imagegen(body: TestLLMRequest):
    """测试生图模型：拉取端点 /models 核对手写型号是否存在（不实际生图，省时省配额）。"""
    base = (body.api_base or "").strip() or settings.sensenova_api_base or "https://token.sensenova.cn/v1"
    key = (body.api_key or "").strip() or settings.sensenova_api_key
    model = (body.model or "").strip() or settings.sensenova_model or "sensenova-u1-fast"
    if not key:
        return {"ok": False, "message": "未填写 API Key"}
    base = base.rstrip("/")
    if not base.startswith(("http://", "https://")):
        return {"ok": False, "message": "API Base URL 格式错误（应以 http:// 或 https:// 开头）"}
    try:
        async with httpx.AsyncClient(timeout=15.0, trust_env=False) as client:
            resp = await client.get(base + "/models", headers={"Authorization": f"Bearer {key}"})
            resp.raise_for_status()
            data = resp.json()
            items = data.get("data") if isinstance(data, dict) else data
            if not isinstance(items, list) or not items:
                return {"ok": False, "message": "端点未返回模型列表，无法预检；配置将在生成 PPT 时实际验证"}
            ids = {str(m.get("id")) for m in items if isinstance(m, dict) and m.get("id")}
            if any(i.lower() == model.lower() for i in ids):
                return {"ok": True, "message": f"模型 {model} 在端点可用（共 {len(ids)} 个模型）"}
            sample = "、".join(sorted(ids)[:6])
            return {"ok": False, "message": f"端点无 {model}，可用模型示例：{sample or '（列表为空）'}"}
    except Exception as e:
        return {"ok": False, "message": f"预检失败（端点可能不支持 /models）：{str(e)[:120]}；生成 PPT 时会实际验证"}


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


# ============ 显卡 / 核显检测 ============


@router.get("/gpu-info")
def gpu_info(refresh: bool = False):
    """检测显卡（含核显）与 CPU 信息 + 内置 OCR 引擎自检状态。

    local_engine：内置 RapidOCR 引擎（「核显加速」开关的实际执行者）。
    开关开启时本地识别改走内置引擎，自动适配 DirectML GPU（Intel/AMD/NVIDIA
    通用）；自检发现显卡乱码或更慢则锁定 CPU，绝不"开了加速反而变慢"。
    UMI-OCR 本身不支持 GPU 识别（官方开发计划中），此为绕开它的独立通路。
    """
    hw = gpu_detect.detect(refresh)
    engine = gpu_ocr.get_status()
    return {
        **hw,
        "gpu_ocr_supported": engine["backend"] == "directml",
        "local_engine": engine,
        "ocr_engine": settings.ocr_engine,
        "igpu_acceleration": settings.igpu_acceleration,
    }


@router.post("/gpu-selftest")
def gpu_selftest():
    """手动触发内置引擎 GPU 自检（设置面板「重新检测」用）。"""
    result = gpu_ocr.run_selftest()
    return {"ok": result["tested"], "engine": result}


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


@router.post("/install-ocr-engine-deps")
def install_ocr_engine_deps_endpoint():
    """一键安装 OCR 加速引擎（rapidocr + DirectML + OpenVINO，约 200MB，耗时数分钟）。

    安装成功后重置引擎缓存并重跑三选一自检（DirectML → OpenVINO → CPU），
    前端拿到的 message 即为最终自检状态。
    """
    from ..services import gpu_ocr

    ok, msg = install_ocr_engine_deps()
    selftest_detail = ""
    if ok and gpu_ocr._try_import():
        gpu_ocr.reset_for_reinstall()
        try:
            st = gpu_ocr.run_selftest()
            selftest_detail = st.get("detail", "")
        except Exception as e:
            selftest_detail = f"自检异常（{type(e).__name__}）"
    return {"ok": ok, "message": msg + (f"\n{selftest_detail}" if selftest_detail else "")}


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
