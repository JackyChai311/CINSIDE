"""文档提取路由：网页 PDF/图片下载提取 + 本地文件上传提取。

功能1：前端拾取网页元素拿到 href/src → POST /extract-url → MarkItDown/Vision OCR
功能2：前端选择本地文件 → POST /extract (multipart) → 同上
"""
from __future__ import annotations

import logging
import traceback
from typing import Optional

import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from ..services.document_extract import extract_document, preview_document, ocr_image_bytes
from ..services.doc_convert import convert_document

logger = logging.getLogger(__name__)


def _safe_err_msg(e: Exception, fallback: str = "未知错误") -> str:
    """确保异常消息不为空，方便前端展示。"""
    msg = str(e).strip()
    if msg:
        return msg
    # 空消息时用异常类型名作为兜底
    return f"{fallback}（{type(e).__name__}）"

router = APIRouter(prefix="/api/document", tags=["document"])


def _parse_fields(fields: Optional[str]) -> list[str]:
    if not fields:
        return []
    return [f.strip() for f in fields.split(",") if f.strip()]


@router.post("/preview")
async def preview_upload(
    file: UploadFile = File(...),
):
    """上传本地文件，仅生成预览图（不跑 OCR、不做字段提取，极快）。"""
    content = await file.read()
    if not content:
        raise HTTPException(400, "empty file")
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(400, "文件过大（>50MB）")
    try:
        result = await preview_document(content, file.filename or "upload.bin")
    except Exception as e:
        raise HTTPException(400, f"预览失败: {e}")
    return result


class PreviewUrlBody(BaseModel):
    url: str
    filename: Optional[str] = None


@router.post("/preview-url")
async def preview_from_url(body: PreviewUrlBody):
    """从网页 URL 下载文件，仅生成预览图（不跑 OCR）。"""
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
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(400, "文件过大（>50MB）")

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
            "image/tiff": ".tiff",
            "image/avif": ".avif",
            "image/heic": ".heic",
            "image/heif": ".heif",
        }
        # image/* 兜底为 .jpg（后端会按魔数重新识别真实类型，扩展名不重要）
        if ctype.startswith("image/"):
            ext = ext_map.get(ctype, ".jpg")
        else:
            ext = ext_map.get(ctype, ".bin")
        filename = f"download{ext}"
    try:
        result = await preview_document(content, filename)
    except Exception as e:
        raise HTTPException(400, f"预览失败: {e}")
    return result


@router.post("/extract")
async def extract_upload(
    file: UploadFile = File(...),
    fields: Optional[str] = Form(default=None),
    engine: Optional[str] = Form(default=None),
    force_ai_orient: bool = Form(default=False),
    force_viz: bool = Form(default=False),
):
    """上传本地文件（图片/PDF/Office），提取文字 + 可选字段结构化。

    engine: 可选，临时指定 OCR 引擎（"umi" 或 "vision"），不传则用全局设置。
    force_ai_orient: 强制 Vision 精判转正（高速模式 OCR 失败后的后台重试用）。
    """
    content = await file.read()
    if not content:
        raise HTTPException(400, "empty file")
    if len(content) > 30 * 1024 * 1024:
        raise HTTPException(400, "文件过大（>30MB）")
    try:
        result = await extract_document(content, file.filename or "upload.bin", _parse_fields(fields), engine=engine, force_ai_orient=force_ai_orient, force_viz=force_viz)
    except RuntimeError as e:
        msg = _safe_err_msg(e, "提取失败")
        logger.warning("文档提取 RuntimeError: %s\n%s", msg, traceback.format_exc())
        raise HTTPException(500, msg)
    except Exception as e:
        msg = _safe_err_msg(e, "提取失败")
        logger.error("文档提取异常: %s\n%s", msg, traceback.format_exc())
        raise HTTPException(400, f"提取失败: {msg}")
    return result


@router.post("/ocr-region")
async def ocr_region(
    file: UploadFile = File(...),
    engine: Optional[str] = Form(default=None),
):
    """框选区域文字识别：前端裁好的小图 → 纯 OCR → 拼接单行文本。

    不过 LLM、不做字段结构化——给「手动框选区域识别填入字段」用。
    engine: 可选，临时指定 OCR 引擎（"umi" 或 "vision"），不传则用全局设置。
    """
    content = await file.read()
    if not content:
        raise HTTPException(400, "empty file")
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(400, "图片过大（>20MB）")
    try:
        text, fallback = await ocr_image_bytes(content, engine=engine or None)
    except RuntimeError as e:
        msg = _safe_err_msg(e, "区域识别失败")
        logger.warning("区域OCR RuntimeError: %s", msg)
        raise HTTPException(500, msg)
    except Exception as e:
        msg = _safe_err_msg(e, "区域识别失败")
        logger.error("区域OCR异常: %s\n%s", msg, traceback.format_exc())
        raise HTTPException(400, f"区域识别失败: {msg}")
    # OCR 按行输出，字段值一般单行——拼成单行（空格分隔）方便直接填入字段框
    one_line = " ".join(t.strip() for t in (text or "").splitlines() if t.strip())
    return {"text": one_line, "raw_text": text, "fallback": fallback}


class ExtractUrlBody(BaseModel):
    url: str
    filename: Optional[str] = None
    fields: Optional[str] = None  # 逗号分隔的目标字段
    engine: Optional[str] = None  # 临时指定 OCR 引擎（"umi" 或 "vision"）
    force_ai_orient: bool = False  # 强制 Vision 精判转正（高速模式失败重试用）
    force_viz: bool = False  # 强制 VIZ 缺字段看图补提（高速模式后台补提缺字段用）


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
            "image/tiff": ".tiff",
            "image/avif": ".avif",
            "image/heic": ".heic",
            "image/heif": ".heif",
            "text/html": ".html",
        }
        # image/* 兜底为 .jpg（后端会按魔数重新识别真实类型）
        if ctype.startswith("image/"):
            ext = ext_map.get(ctype, ".jpg")
        else:
            ext = ext_map.get(ctype, ".bin")
        filename = f"download{ext}"

    try:
        result = await extract_document(content, filename, _parse_fields(body.fields), engine=body.engine, force_ai_orient=body.force_ai_orient, force_viz=body.force_viz)
    except RuntimeError as e:
        msg = _safe_err_msg(e, "提取失败")
        logger.warning("URL文档提取 RuntimeError: %s\n%s", msg, traceback.format_exc())
        raise HTTPException(500, msg)
    except Exception as e:
        msg = _safe_err_msg(e, "提取失败")
        logger.error("URL文档提取异常: %s\n%s", msg, traceback.format_exc())
        raise HTTPException(400, f"提取失败: {msg}")
    return result


class ConvertBody(BaseModel):
    data_b64: str = ""                 # base64 文件内容（不含 data: 前缀亦可）
    filename: str = "file.bin"
    target_format: str = "original"    # original | jpg | png | pdf
    target_kb: int = 0                 # 目标大小（KB），0=不限制
    source_url: Optional[str] = None   # 远端文件 URL：data_b64 为空时先下载再转换


@router.post("/convert")
async def convert_file(body: ConvertBody):
    """格式转换 + 压缩到目标大小（文件处理面板「导出」用）。"""
    import base64 as _b64

    content: bytes
    raw = (body.data_b64 or "").strip()
    if raw:
        # 允许传 dataURL，取逗号后部分
        if raw.startswith("data:") and "," in raw:
            raw = raw.split(",", 1)[1]
        try:
            content = _b64.b64decode(raw)
        except Exception:
            raise HTTPException(400, "base64 解码失败")
    else:
        url = (body.source_url or "").strip()
        if not url.startswith(("http://", "https://")):
            raise HTTPException(400, "empty data 且无有效 source_url")
        try:
            async with httpx.AsyncClient(timeout=60.0, follow_redirects=True, trust_env=False) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                content = resp.content
        except Exception as e:
            raise HTTPException(400, f"下载失败: {e}")
        if not content:
            raise HTTPException(400, "下载内容为空")
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(400, "文件过大（>50MB）")
    try:
        result = convert_document(content, body.filename or "file.bin", body.target_format, body.target_kb)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"转换失败: {e}")
    return {
        "data_b64": result.data_b64,
        "mime": result.mime,
        "ext": result.ext,
        "size": result.size,
        "width": result.width,
        "height": result.height,
        "reached": result.reached,
        "note": result.note,
        "pages": result.pages,
        "warnings": result.warnings,
    }
