"""文档提取路由：网页 PDF/图片下载提取 + 本地文件上传提取。

功能1：前端拾取网页元素拿到 href/src → POST /extract-url → MarkItDown/Vision OCR
功能2：前端选择本地文件 → POST /extract (multipart) → 同上
"""
from __future__ import annotations

from typing import Optional

import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from ..services.document_extract import extract_document

router = APIRouter(prefix="/api/document", tags=["document"])


def _parse_fields(fields: Optional[str]) -> list[str]:
    if not fields:
        return []
    return [f.strip() for f in fields.split(",") if f.strip()]


@router.post("/extract")
async def extract_upload(
    file: UploadFile = File(...),
    fields: Optional[str] = Form(default=None),
):
    """上传本地文件（图片/PDF/Office），提取文字 + 可选字段结构化。"""
    content = await file.read()
    if not content:
        raise HTTPException(400, "empty file")
    if len(content) > 30 * 1024 * 1024:
        raise HTTPException(400, "文件过大（>30MB）")
    try:
        result = await extract_document(content, file.filename or "upload.bin", _parse_fields(fields))
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    except Exception as e:
        raise HTTPException(400, f"提取失败: {e}")
    return result


class ExtractUrlBody(BaseModel):
    url: str
    filename: Optional[str] = None
    fields: Optional[str] = None  # 逗号分隔的目标字段


@router.post("/extract-url")
async def extract_from_url(body: ExtractUrlBody):
    """从网页 URL 下载 PDF/图片并提取文字 + 可选字段结构化。"""
    url = (body.url or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "仅支持 http(s) URL")

    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True, trust_env=False) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            content = resp.content
    except Exception as e:
        raise HTTPException(400, f"下载失败: {e}")

    if not content:
        raise HTTPException(400, "下载内容为空")
    if len(content) > 30 * 1024 * 1024:
        raise HTTPException(400, "文件过大（>30MB）")

    # 推断文件名：优先用户给的 → URL 路径 → content-type
    filename = (body.filename or "").strip()
    if not filename:
        from urllib.parse import unquote, urlparse
        path_name = unquote(urlparse(url).path.rsplit("/", 1)[-1])
        filename = path_name if "." in path_name else ""
    if not filename or "." not in filename:
        ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
        ext_map = {
            "application/pdf": ".pdf",
            "image/png": ".png",
            "image/jpeg": ".jpg",
            "image/webp": ".webp",
            "image/gif": ".gif",
            "image/bmp": ".bmp",
            "text/html": ".html",
        }
        filename = f"download{ext_map.get(ctype, '.pdf')}"

    try:
        result = await extract_document(content, filename, _parse_fields(body.fields))
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    except Exception as e:
        raise HTTPException(400, f"提取失败: {e}")
    return result
