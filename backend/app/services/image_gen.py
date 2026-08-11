"""SenseNova U1 Fast 生图服务。

专供信息图（Infographics）生成，用于 PPT 配图。
接口：POST https://token.sensenova.cn/v1/images/generations（OpenAI 兼容）
注意：返回的图片 URL 是临时链接（1 小时有效），必须立即下载到本地。
"""
from __future__ import annotations

import tempfile
import time
from pathlib import Path

import httpx

from ..config import settings

_API_BASE = "https://token.sensenova.cn/v1"
_MODEL = "sensenova-u1-fast"
# U1 Fast 默认 2752x1536（16:9），正好适配 PPT 画幅
_TIMEOUT = 180.0


def is_available() -> bool:
    """是否已配置生图 API Key。"""
    return bool(settings.sensenova_api_key.strip())


async def generate_image(prompt: str, *, prefix: str = "pptimg") -> str | None:
    """生成一张图并下载到本地临时目录，返回本地文件路径；失败返回 None。

    prompt: 图像描述（信息图风格效果最佳）
    """
    if not is_available():
        return None
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(
                f"{_API_BASE}/images/generations",
                headers={
                    "Authorization": f"Bearer {settings.sensenova_api_key.strip()}",
                    "Content-Type": "application/json",
                },
                json={"model": _MODEL, "prompt": prompt},
            )
            if resp.status_code != 200:
                print(f"[IMAGE-GEN] 生图失败 HTTP {resp.status_code}: {resp.text[:200]}", flush=True)
                return None
            data = resp.json()
            url = (data.get("data") or [{}])[0].get("url")
            if not url:
                print(f"[IMAGE-GEN] 响应无图片 URL: {str(data)[:200]}", flush=True)
                return None
            # 临时链接 1 小时有效，立即下载
            img_resp = await client.get(url)
            if img_resp.status_code != 200:
                print(f"[IMAGE-GEN] 图片下载失败 HTTP {img_resp.status_code}", flush=True)
                return None
            out = Path(tempfile.gettempdir()) / f"cinside-{prefix}-{int(time.time() * 1000)}.png"
            out.write_bytes(img_resp.content)
            print(f"[IMAGE-GEN] 图片已保存: {out} ({len(img_resp.content) // 1024}KB)", flush=True)
            return str(out)
    except Exception as e:
        print(f"[IMAGE-GEN] 生图异常: {e}", flush=True)
        return None
