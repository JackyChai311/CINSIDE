"""文档文字提取服务：MarkItDown（PDF/Office）+ Vision OCR（图片）。

功能1/2 的核心依赖：
- PDF/DOCX/PPTX/XLSX/HTML 等 → 微软开源 MarkItDown 转 markdown 文本
- PNG/JPG/WEBP/BMP 等图片     → 配置的 Vision LLM（与护照 OCR 同一套 API）识别文字
- 提取出全文后，再用一次 Vision LLM 把目标字段结构化成 JSON（供左右对比 / 填入网页）
"""
from __future__ import annotations

import base64
import io
import json
import re

import httpx

from ..config import settings

# 支持的图片扩展名（走 Vision OCR）
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
# 其余交给 MarkItDown（pdf/docx/pptx/xlsx/html/txt/md/csv...）


def is_image_file(filename: str) -> bool:
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return ext in IMAGE_EXTS


# ============ MarkItDown 提取（PDF/Office 文档） ============
def _extract_with_markitdown(content: bytes, filename: str) -> str:
    """用 MarkItDown 把 PDF/Office/HTML 转成 markdown 文本。"""
    try:
        from markitdown import MarkItDown
    except ImportError as e:
        raise RuntimeError("未安装 markitdown，请执行: pip install 'markitdown[pdf]'") from e

    md = MarkItDown()
    # MarkItDown 需要文件流 + 扩展名提示
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ".pdf"
    stream = io.BytesIO(content)
    result = md.convert_stream(stream, file_extension=ext)
    text = (result.text_content or "").strip()
    return text


# ============ Vision OCR（图片） ============
async def ocr_image_bytes(content: bytes) -> str:
    """调用 Vision LLM 识别图片中的全部文字，返回纯文本。"""
    if not settings.vision_api_key:
        raise RuntimeError("未配置 Vision API，无法 OCR 图片（请在设置中填写 API Key）")

    b64_img = base64.b64encode(content).decode()
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
                    {
                        "type": "text",
                        "text": "请识别这张图片中的所有文字，并以纯文本形式返回。"
                        "不要添加任何解释、翻译或格式标记，只输出识别到的原始文字内容。",
                    },
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"}},
                ],
            }
        ],
        "temperature": 0.1,
    }
    async with httpx.AsyncClient(timeout=90.0, trust_env=False) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        text = (data["choices"][0]["message"]["content"] or "").strip()
        if not text:
            raise RuntimeError("OCR 未识别到文字")
        return text


# ============ 字段结构化（从全文中提取目标字段） ============
def _build_fields_prompt(text: str, target_fields: list[str]) -> str:
    fields_desc = "、".join(target_fields)
    # 截断超长文本，避免超出上下文
    snippet = text[:6000]
    return f"""以下是一份文档（证件/表单/网页截图）中提取出的文字内容：

---
{snippet}
---

请从上述文字中提取以下字段的值：{fields_desc}

要求：
1. 严格以 JSON 对象返回，key 为字段名，value 为文档中对应的值（字符串）
2. 文档中找不到的字段返回空字符串 ""
3. 日期统一为 YYYY-MM-DD 格式
4. 不要输出任何 JSON 以外的内容
"""


def _parse_json_fields(text: str) -> dict[str, str]:
    if not text:
        return {}
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return {}
    try:
        data = json.loads(m.group(0))
        return {str(k): str(v).strip() for k, v in data.items()}
    except Exception:
        return {}


async def extract_fields_from_text(text: str, target_fields: list[str]) -> dict[str, str]:
    """用 Vision LLM 从文档全文中提取目标字段（结构化 JSON）。"""
    if not target_fields:
        return {}
    if not settings.vision_api_key:
        return {f: "" for f in target_fields}

    url = settings.vision_api_base.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.vision_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": settings.vision_model,
        "messages": [{"role": "user", "content": _build_fields_prompt(text, target_fields)}],
        "temperature": 0.1,
    }
    try:
        async with httpx.AsyncClient(timeout=60.0, trust_env=False) as client:
            resp = await client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"] or ""
            return _parse_json_fields(content)
    except Exception:
        return {f: "" for f in target_fields}


# ============ 统一入口 ============
async def extract_document(content: bytes, filename: str, target_fields: list[str] | None = None) -> dict:
    """提取文档文字 + 可选的字段结构化。

    返回: { filename, method, text, fields }
    method: "markitdown" | "vision_ocr"
    """
    if is_image_file(filename):
        text = await ocr_image_bytes(content)
        method = "vision_ocr"
    else:
        text = _extract_with_markitdown(content, filename)
        method = "markitdown"
        # PDF 扫描件可能无文字层 → 回退 Vision OCR（转图片由前端/用户自行处理，这里提示）
        if not text:
            raise RuntimeError("MarkItDown 未提取到文字（可能是无文字层的扫描件，请改用图片）")

    fields: dict[str, str] = {}
    if target_fields:
        fields = await extract_fields_from_text(text, target_fields)

    return {
        "filename": filename,
        "method": method,
        "text": text,
        "fields": fields,
    }
