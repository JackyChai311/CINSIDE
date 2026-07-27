"""应用配置读写接口。"""
from __future__ import annotations

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

from ..config import settings

router = APIRouter(prefix="/api/config", tags=["config"])


class AppSettings(BaseModel):
    agent_backend: str = "browser_use"
    vision_api_base: str = ""
    vision_api_key: str = ""
    vision_model: str = ""
    browser_use_llm_base: str = ""
    browser_use_llm_key: str = ""
    browser_use_llm_model: str = ""


# 1x1 透明 PNG，用来检测模型是否接受 image_url
_TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


@router.get("/settings")
def get_settings():
    """返回前端设置面板需要的配置项。"""
    return settings.to_settings_dict()


@router.post("/settings")
def save_settings(body: AppSettings):
    """保存设置到内存并持久化到 .env。"""
    data = body.model_dump()
    settings.update_from_dict(data)
    try:
        settings.persist()
    except RuntimeError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True}


@router.post("/test-vision")
async def test_vision():
    """检测当前 Vision 模型是否支持图片输入。"""
    if not settings.vision_api_key:
        return {"supports_images": False, "message": "未配置 Vision API Key"}
    if not settings.vision_api_base:
        return {"supports_images": False, "message": "未配置 Vision API Base URL"}
    if not settings.vision_model:
        return {"supports_images": False, "message": "未配置 Vision Model"}

    url = settings.vision_api_base.rstrip("/") + "/chat/completions"
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
        async with httpx.AsyncClient(timeout=30.0, trust_env=False) as client:
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
