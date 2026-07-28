"""文档文字提取服务：MarkItDown（PDF/Office）+ Vision OCR（图片）。

功能1/2 的核心依赖：
- PDF/DOCX/PPTX/XLSX/HTML 等 → 微软开源 MarkItDown 转 markdown 文本
- PNG/JPG/WEBP/BMP 等图片     → 配置的 Vision LLM（与护照 OCR 同一套 API）识别文字
- 提取出全文后，再用一次 Vision LLM 把目标字段结构化成 JSON（供左右对比 / 填入网页）

图片预处理：自动旋转到正面（EXIF 方向）+ 裁剪白边，提升 OCR 识别率。
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


# ============ 图片预处理：自动旋转 + 裁剪白边 ============
def preprocess_image(content: bytes) -> tuple[bytes, str | None]:
    """对图片做预处理：EXIF 自动旋转到正面 + 裁剪白边。

    返回: (处理后的图片 bytes, base64 预览或 None)
    如果 PIL 不可用或处理失败，返回原始内容。
    """
    try:
        from PIL import Image, ImageOps

        img = Image.open(io.BytesIO(content))

        # 1. EXIF 自动旋转到正面（手机拍摄的照片方向纠正）
        img = ImageOps.exif_transpose(img)

        # 2. 转 RGB（去除 alpha 通道，方便后续处理）
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGB")

        # 3. 裁剪白边：用 getbbox 检测非白色内容区域
        #    先转灰度，再反转，bbox 即为有内容区域
        gray = img.convert("L")
        # 阈值 245：接近白色视为背景
        bbox = gray.point(lambda x: 0 if x > 245 else 255).getbbox()
        if bbox:
            # bbox = (left, upper, right, lower)
            # 只在边距 > 10px 时裁剪，避免误裁
            margin = 10
            left, upper, right, lower = bbox
            w, h = img.size
            if (left > margin or upper > margin or
                    right < w - margin or lower < h - margin):
                img = img.crop(bbox)

        # 4. 输出处理后的图片 bytes + base64 预览
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=92)
        processed = buf.getvalue()
        b64_preview = base64.b64encode(processed).decode()
        return processed, b64_preview
    except Exception:
        # PIL 不可用或处理失败，返回原始内容
        b64_preview = base64.b64encode(content).decode()
        return content, b64_preview


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

    返回: { filename, method, text, fields, processed_image }
    method: "markitdown" | "vision_ocr"
    processed_image: base64 编码的预处理后图片预览（仅图片文件有值）
    """
    processed_image: str | None = None

    if is_image_file(filename):
        # 图片：先预处理（自动旋转到正面 + 裁剪白边），再 OCR
        content, processed_image = preprocess_image(content)
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
        "processed_image": processed_image,
    }
