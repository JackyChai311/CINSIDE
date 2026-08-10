"""文档文字提取服务：MarkItDown（Office）+ Vision OCR（图片/扫描PDF）。

功能1/2 的核心依赖：
- DOCX/PPTX/XLSX/HTML 等 → 微软开源 MarkItDown 转 markdown 文本
- PNG/JPG/WEBP/BMP 等图片 → 配置的 Vision LLM 识别文字
- PDF（含扫描件）          → PyMuPDF 渲染为高 DPI 图片 → 预处理 → Vision OCR
- 提取出全文后，再用一次 Vision LLM 把目标字段结构化成 JSON（供左右对比 / 填入网页）

图像预处理（对所有走 Vision OCR 的输入生效，含 PDF 转出的图片）：
1. EXIF 自动旋转到正面（纠正手机拍摄方向）
2. 裁剪白边（基于缩略图快速检测 bbox，再按比例应用到原图，避免大图处理慢）
3. 大图降采样到最长边 2560px，平衡 OCR 准确率与上传带宽
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import httpx

from ..config import settings

# HEIC/HEIF（iPhone 拍摄照片）解码支持：注册到 PIL（未安装 pillow-heif 时静默跳过，
# 遇到 HEIC 文件会在 preprocess_image 给出明确错误提示）
try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:
    pass

# 容忍截断的图片文件（网页下载不完整时 Chromium 能显示但 PIL 默认拒解）
from PIL import ImageFile as _ImageFile

_ImageFile.LOAD_TRUNCATED_IMAGES = True

# 支持的图片扩展名（走 Vision OCR + 预处理）
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".heic", ".heif", ".avif"}
# PDF 扩展名（走 PyMuPDF 渲染 → 预处理 → Vision OCR）
PDF_EXTS = {".pdf"}
# 其余交给 MarkItDown（docx/pptx/xlsx/html/txt/md/csv...）

# 预处理参数
_WHITE_THRESH = 245      # 灰度 > 该值视为白边背景
_BBOX_DETECT_MAX = 512   # bbox 检测缩略图最长边（小图检测极快）
_MAX_OUTPUT_EDGE = 2560  # 输出图最长边上限（防止上传过大）
_MIN_KEEP_MARGIN = 8     # 裁剪时四周至少保留 8px 边距，避免贴边误裁
_BORDER_DIFF_THRESH = 30  # 边缘主色检测：与背景色差值 > 该值视为内容
_API_MAX_B64_LEN = 9_000_000  # Vision API 上传保护：base64 字符数上限（≈6.7MB 二进制）


def is_image_file(filename: str) -> bool:
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return ext in IMAGE_EXTS


def is_pdf_file(filename: str) -> bool:
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return ext in PDF_EXTS


# ============ 基于文件头（魔数）嗅探真实类型，扩展名/Content-Type 不可信时兜底 ============
# 参考：https://en.wikipedia.org/wiki/List_of_file_signatures
def _sniff_content_kind(content: bytes, filename: str = "") -> "str":
    """嗅探内容真实类型：'image' | 'pdf' | 'other'。
    优先级：魔数 > filename 扩展名；魔数检测失败时回退到扩展名判断。"""
    head = content[:32]
    # PDF: %PDF-
    if head.startswith(b"%PDF-"):
        return "pdf"
    # JPEG: FF D8 FF
    if head.startswith(b"\xff\xd8\xff"):
        return "image"
    # PNG: 89 50 4E 47 0D 0A 1A 0A
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image"
    # GIF: GIF87a / GIF89a
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image"
    # BMP: BM
    if head.startswith(b"BM"):
        return "image"
    # WEBP: RIFF....WEBP
    if len(head) >= 12 and head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return "image"
    # TIFF: II (little-endian) 或 MM (big-endian) + 2A/00 或 00/2A
    if head.startswith(b"II*\x00") or head.startswith(b"MM\x00*"):
        return "image"
    # HEIC/HEIF/AVIF: ISO BMFF 容器（ftyp box 偏移 4~8，brand 在 8~12）
    if _looks_like_heic(content):
        return "image"
    # 魔数未命中 → 回退到扩展名
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext in PDF_EXTS:
        return "pdf"
    if ext in IMAGE_EXTS:
        return "image"
    return "other"


# ============ 图片预处理：EXIF 旋转 + 裁白边 + 降采样 ============
def _content_bbox_by_border_color(img) -> tuple[int, int, int, int] | None:
    """边缘主色检测内容区域：采样四边 5% 条带的平均色作为背景色，
    与背景色差值超过 _BORDER_DIFF_THRESH 的像素视为内容，返回其 bbox。
    适用于非白底拍摄照片（深色/彩色桌面）的边框裁剪。检测失败返回 None。"""
    try:
        from PIL import Image, ImageChops, ImageStat

        rgb = img.convert("RGB")
        w, h = rgb.size
        if w < 16 or h < 16:
            return None
        mx = max(2, int(w * 0.05))
        my = max(2, int(h * 0.05))
        strips = (
            rgb.crop((0, 0, w, my)),      # 上
            rgb.crop((0, h - my, w, h)),  # 下
            rgb.crop((0, 0, mx, h)),      # 左
            rgb.crop((w - mx, 0, w, h)),  # 右
        )
        means = [ImageStat.Stat(s).mean for s in strips]
        bg = tuple(int(sum(m[i] for m in means) / len(means)) for i in range(3))
        diff = ImageChops.difference(rgb, Image.new("RGB", rgb.size, bg)).convert("L")
        return diff.point(lambda x: 255 if x > _BORDER_DIFF_THRESH else 0).getbbox()
    except Exception:
        return None


def _looks_like_heic(content: bytes) -> bool:
    """HEIC/HEIF 魔数检测：ISO BMFF 容器，brand 为 heic/heix/hevc/mif1/msf1 等。"""
    if len(content) < 12:
        return False
    return content[4:8] == b"ftyp" and content[8:12] in (
        b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1", b"heis", b"hevm",
    )


def preprocess_image(content: bytes) -> tuple[bytes, str | None]:
    """对图片做预处理：EXIF 自动旋转到正面 + 裁剪白边 + 限制最大尺寸。

    返回: (处理后的 JPEG bytes, base64 预览或 None)
    解码失败时抛出 RuntimeError（明确原因），不再原样透传给 API（会被拒收 400）。
    """
    try:
        from PIL import Image, ImageOps

        img = Image.open(io.BytesIO(content))
        img.load()  # 立即解码，尽早暴露截断/损坏问题（LOAD_TRUNCATED_IMAGES 已容忍部分截断）

        # 1. EXIF 自动旋转到正面（手机拍摄的照片方向纠正）
        img = ImageOps.exif_transpose(img)

        # 2. 转 RGB（去除 alpha 通道 / 调色板，方便后续处理）
        if img.mode != "RGB":
            img = img.convert("RGB")

        w, h = img.size

        # 3. 裁剪白边：先缩放到小图快速检测 bbox，再按比例还原到原图坐标
        #    避免 5000x5000 大图做 point() 极慢
        if w > _BBOX_DETECT_MAX or h > _BBOX_DETECT_MAX:
            scale = _BBOX_DETECT_MAX / max(w, h)
            small = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        else:
            small = img
            scale = 1.0

        gray = small.convert("L")
        # 阈值 _WHITE_THRESH：接近白色视为背景；非白即内容
        bbox = gray.point(lambda x: 0 if x > _WHITE_THRESH else 255).getbbox()

        # 白边检测失效（几乎整图都是"内容"，说明背景非白色，如深色/彩色桌面拍摄）
        # → 改用边缘主色检测：以四边平均色为背景色，色差超阈值视为内容
        sw, sh = small.size
        if bbox is None or (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) >= 0.97 * sw * sh:
            bbox = _content_bbox_by_border_color(small)
        # 检出区域过小（<4%）判定为误检（噪点/阴影），放弃裁剪保护
        if bbox is not None and (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) < 0.04 * sw * sh:
            bbox = None

        if bbox:
            # 把小图 bbox 坐标按比例还原到原图
            left = max(0, int(bbox[0] / scale) - _MIN_KEEP_MARGIN)
            upper = max(0, int(bbox[1] / scale) - _MIN_KEEP_MARGIN)
            right = min(w, int(bbox[2] / scale) + _MIN_KEEP_MARGIN)
            lower = min(h, int(bbox[3] / scale) + _MIN_KEEP_MARGIN)
            # 仅当确实裁掉一定边距时才 crop（避免无意义 crop 开销）
            if (left > 2 or upper > 2 or right < w - 2 or lower < h - 2):
                img = img.crop((left, upper, right, lower))

        # 4. 降采样：最长边超过 _MAX_OUTPUT_EDGE 时按比例缩小（节省 OCR 上传带宽）
        w2, h2 = img.size
        if max(w2, h2) > _MAX_OUTPUT_EDGE:
            ratio = _MAX_OUTPUT_EDGE / max(w2, h2)
            img = img.resize((max(1, int(w2 * ratio)), max(1, int(h2 * ratio))), Image.LANCZOS)

        # 5. 输出处理后的图片 bytes + base64 预览
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=92)
        processed = buf.getvalue()
        b64_preview = base64.b64encode(processed).decode()
        return processed, b64_preview
    except Exception as e:
        # 解码失败：给出明确原因（HEIC 缺解码器 / 文件损坏 / 格式不支持），
        # 不再把原始字节透传给 Vision API（无法解码会被拒收：400 invalid image base64 content）
        if _looks_like_heic(content):
            raise RuntimeError(
                "HEIC/HEIF 图片解码失败：请安装 pillow-heif（pip install pillow-heif），"
                "或先把照片转成 JPG/PNG 再提取"
            ) from e
        raise RuntimeError(
            f"图片无法解码（文件可能已损坏或格式不受支持）: {e}"
        ) from e


# ============ PDF 预处理：渲染为高 DPI 图片 → 旋转 + 裁白边 ============
def render_pdf_to_image(content: bytes, dpi: int = 200) -> tuple[bytes, str] | None:
    """用 PyMuPDF 把 PDF 渲染为图片，多页竖向拼接成一张长图。

    返回: (JPEG bytes, base64 预览) 或 None（PyMuPDF 不可用或渲染失败）
    dpi: 渲染分辨率，200 DPI 对扫描件足够清晰
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return None
    try:
        doc = fitz.open(stream=content, filetype="pdf")
        if doc.page_count == 0:
            doc.close()
            return None

        # 渲染每页为 PIL.Image，按比例渲染
        zoom = dpi / 72.0  # PDF 默认 72 DPI
        mat = fitz.Matrix(zoom, zoom)

        page_images = []
        for page in doc:
            # alpha=False 生成 RGB（白底），避免透明背景
            pix = page.get_pixmap(matrix=mat, alpha=False)
            img_bytes = pix.tobytes("png")
            from PIL import Image as _PILImage
            page_img = _PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
            page_images.append(page_img)
        doc.close()

        if not page_images:
            return None

        # 多页拼接：页数少时竖拼；页数多时用近似方阵网格拼接（间距 10px 白色）。
        # 避免竖拼出极端宽高比的"长条图"——部分 Vision API 会拒收（400 Bad Request），
        # 且超长图被 2560px 上限整体压缩后单页内容过小、OCR 不清。
        if len(page_images) == 1:
            combined = page_images[0]
        else:
            import math
            from PIL import Image as _PILImage
            n = len(page_images)
            cols = max(1, math.ceil(math.sqrt(n)))
            rows = math.ceil(n / cols)
            cell_w = max(im.width for im in page_images)
            cell_h = max(im.height for im in page_images)
            gap = 10
            combined = _PILImage.new(
                "RGB",
                (cols * cell_w + gap * (cols - 1), rows * cell_h + gap * (rows - 1)),
                (255, 255, 255),
            )
            for idx, im in enumerate(page_images):
                r, c = divmod(idx, cols)
                combined.paste(im, (c * (cell_w + gap), r * (cell_h + gap)))

        # 对拼接图应用同样的白边裁剪（PDF 页面常带扫描白边）
        gray = combined.convert("L")
        bbox = gray.point(lambda x: 0 if x > _WHITE_THRESH else 255).getbbox()
        if bbox:
            left, upper, right, lower = bbox
            left = max(0, left - _MIN_KEEP_MARGIN)
            upper = max(0, upper - _MIN_KEEP_MARGIN)
            right = min(combined.width, right + _MIN_KEEP_MARGIN)
            lower = min(combined.height, lower + _MIN_KEEP_MARGIN)
            if (left > 2 or upper > 2 or right < combined.width - 2 or lower < combined.height - 2):
                combined = combined.crop((left, upper, right, lower))

        # 限制最大尺寸（多页 PDF 拼接后可能非常大）
        w, h = combined.size
        if max(w, h) > _MAX_OUTPUT_EDGE:
            from PIL import Image as _PILImg2
            ratio = _MAX_OUTPUT_EDGE / max(w, h)
            combined = combined.resize((max(1, int(w * ratio)), max(1, int(h * ratio))), _PILImg2.LANCZOS)

        buf = io.BytesIO()
        combined.save(buf, format="JPEG", quality=92)
        processed = buf.getvalue()
        b64 = base64.b64encode(processed).decode()
        return processed, b64
    except Exception:
        return None


# ============ MarkItDown 提取（Office 文档） ============
def check_markitdown_available() -> tuple[bool, str]:
    """检测 MarkItDown 和 PyMuPDF 是否可用，返回 (ok, message)。"""
    try:
        from markitdown import MarkItDown  # noqa: F401
        md_ok = True
    except ImportError:
        md_ok = False

    try:
        import fitz  # PyMuPDF  # noqa: F401
        pdf_ok = True
    except ImportError:
        pdf_ok = False

    if md_ok and pdf_ok:
        return True, "MarkItDown 与 PDF 渲染均可用"
    parts = []
    if not md_ok:
        parts.append("MarkItDown 未安装")
    if not pdf_ok:
        parts.append("PyMuPDF 未安装（扫描件 PDF 将无法 OCR）")
    return False, "；".join(parts)


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
def _shrink_for_api(content: bytes) -> bytes:
    """确保图片 base64 后不超过 _API_MAX_B64_LEN：先逐步降 JPEG 质量，再按比例缩小。
    防止上传体积超限被 Vision API 拒收（400/413）。处理失败返回原内容。"""
    try:
        if len(base64.b64encode(content)) <= _API_MAX_B64_LEN:
            return content
        from PIL import Image

        img = Image.open(io.BytesIO(content)).convert("RGB")
        data = content
        for q in (85, 70, 55, 40):
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=q)
            data = buf.getvalue()
            if len(base64.b64encode(data)) <= _API_MAX_B64_LEN:
                return data
        # 质量到底仍超限 → 逐步缩小尺寸
        while max(img.size) > 800:
            img = img.resize((max(1, img.width * 3 // 4), max(1, img.height * 3 // 4)), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=40)
            data = buf.getvalue()
            if len(base64.b64encode(data)) <= _API_MAX_B64_LEN:
                break
        return data
    except Exception:
        return content


def _jitter_image_for_safety(content: bytes) -> bytes:
    """内容审核拦截时的图像扰动（两档）：
    1. 轻度：转灰度→RGB + 极小高斯模糊 + JPEG 重编码 —— 破坏指纹
    2. 激进：纯黑白二值化（Otsu 阈值）—— 消除人脸/灰阶细节，仅保留文字
    返回扰动后的 JPEG 字节；失败返回原内容。"""
    try:
        from PIL import Image, ImageFilter

        img = Image.open(io.BytesIO(content)).convert("L")
        # 轻度扰动先返回（由调用方使用）
        light = img.filter(ImageFilter.GaussianBlur(radius=0.4)).convert("RGB")
        buf = io.BytesIO()
        light.save(buf, format="JPEG", quality=88)
        return buf.getvalue()
    except Exception:
        return content


def _binarize_image_for_safety(content: bytes) -> bytes:
    """更激进的审核兜底：转纯黑白（Otsu 自适应阈值），彻底消除人脸/灰阶细节。
    对纯文字/护照 MRZ 依然可识别；对人脸类语义特征破坏严重，常可绕过审核。"""
    try:
        from PIL import Image, ImageOps

        img = Image.open(io.BytesIO(content)).convert("L")
        # 自动对比度，增强文字
        img = ImageOps.autocontrast(img, cutoff=2)
        # Otsu 二值化：用直方图找最优阈值
        hist = img.histogram()
        total = sum(hist)
        sum_total = sum(i * h for i, h in enumerate(hist))
        sum_bg, w_bg, w_fg, var_max, thr = 0.0, 0, 0, 0.0, 128
        for t in range(256):
            w_bg += hist[t]
            if w_bg == 0:
                continue
            w_fg = total - w_bg
            if w_fg == 0:
                break
            sum_bg += t * hist[t]
            mean_bg = sum_bg / w_bg
            mean_fg = (sum_total - sum_bg) / w_fg
            var_between = w_bg * w_fg * (mean_bg - mean_fg) ** 2
            if var_between > var_max:
                var_max = var_between
                thr = t
        bw = img.point(lambda p: 255 if p > thr else 0, mode="1").convert("RGB")
        buf = io.BytesIO()
        bw.save(buf, format="JPEG", quality=92)
        return buf.getvalue()
    except Exception:
        return content


async def _call_vision_ocr(b64_img: str, prompt: str) -> str:
    """统一 Vision OCR 调用，返回识别文本。失败抛出 RuntimeError（含中文友好提示）。"""
    if not settings.vision_api_base or not settings.vision_api_base.startswith(("http://", "https://")):
        raise RuntimeError("Vision API Base URL 未配置或格式不正确，请在设置中检查")
    if not settings.vision_model:
        raise RuntimeError("Vision Model 未配置，请在设置中检查")
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
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"}},
                ],
            }
        ],
        "temperature": 0.1,
    }
    try:
        async with httpx.AsyncClient(timeout=90.0, trust_env=False) as client:
            resp = await client.post(url, headers=headers, json=payload)
    except httpx.TimeoutException as e:
        raise RuntimeError(f"Vision API 请求超时（90秒），请检查网络或稍后重试: {e}") from e
    except httpx.ConnectError as e:
        raise RuntimeError(f"无法连接 Vision API（{url}），请检查网络或 API Base URL: {e}") from e
    except httpx.RequestError as e:
        raise RuntimeError(f"Vision API 网络请求失败: {e}") from e

    if resp.status_code != 200:
        detail = (resp.text or "").strip()[:400]
        # 常见错误翻译成中文
        hint = ""
        is_sensitive = False
        try:
            err = json.loads(detail).get("error", {}) if detail.startswith("{") else {}
            code = err.get("code")
            msg = (err.get("message") or "").lower()
            if code == 18 or "sensitive" in msg:
                is_sensitive = True
                hint = "（当前 Vision 模型判定图片为敏感内容被安全策略拦截——常见于证件照/人脸/身份证护照。" \
                       "可在设置里切换到不做内容审核的模型，例如智谱 GLM-4V-Plus，再重试）"
            elif "invalid image" in msg or code in (3, "3"):
                hint = "（图片内容无法解码，请检查文件是否损坏）"
            elif "model" in msg and ("not exist" in msg or "not found" in msg):
                hint = "（模型名称不存在，请在设置中检查 Vision Model）"
            elif "billing" in msg or "quota" in msg or "balance" in msg or code in (13, "13"):
                hint = "（API 额度不足或已欠费，请检查账号余额）"
            elif "rate" in msg and "limit" in msg:
                hint = "（触发频率限制，请稍后重试）"
            elif "maximum" in msg and "context" in msg:
                hint = "（图片过大超出上下文限制，请缩小图片后重试）"
        except Exception:
            pass
        raise RuntimeError(f"Vision OCR 失败（HTTP {resp.status_code}）: {detail}{hint}",
                           {"sensitive": is_sensitive})

    try:
        data = resp.json()
    except Exception as je:
        snippet = (resp.text or "")[:300]
        raise RuntimeError(f"Vision API 返回了无法解析的响应: {snippet!r}") from je
    # 容错解析响应结构
    try:
        choices = data.get("choices") if isinstance(data, dict) else None
        if not choices:
            # 部分 API 出错时返回 200 + {"error": {...}}
            err_info = data.get("error") if isinstance(data, dict) else None
            if err_info:
                err_msg = err_info.get("message") or str(err_info)
                raise RuntimeError(f"Vision API 返回错误: {err_msg}")
            raise RuntimeError(f"Vision API 响应缺少 choices 字段: {str(data)[:300]}")
        content = choices[0].get("message", {}).get("content", "")
        text = (content or "").strip()
    except (KeyError, IndexError, TypeError, AttributeError) as pe:
        raise RuntimeError(f"Vision API 响应结构异常: {str(data)[:300]}") from pe
    if not text:
        raise RuntimeError("OCR 未识别到文字（可能图片为空白或不含文字）")
    return text


# 标记是否已经尝试过自动启动 UMI-OCR（避免重复启动）
_umi_ocr_launch_attempted = False
_umi_ocr_process = None


def _find_umi_ocr_executable() -> str | None:
    """在常见安装路径中查找 UMI-OCR 可执行文件。优先使用用户配置的路径。"""
    # 1. 优先使用用户配置的路径
    configured = settings.umi_ocr_exe_path.strip()
    if configured and os.path.isfile(configured):
        return configured

    # 2. 检查一键下载安装目录（用户数据目录 / tools / Umi-OCR）
    try:
        from ..config import _USER_DATA_DIR
        tools_dir = _USER_DATA_DIR / "tools" / "Umi-OCR"
        if tools_dir.is_dir():
            # 直接在目录下
            direct = tools_dir / "Umi-OCR.exe"
            if direct.is_file():
                return str(direct)
            # 一层子目录（版本文件夹）
            for sub in tools_dir.iterdir():
                if sub.is_dir():
                    candidate = sub / "Umi-OCR.exe"
                    if candidate.is_file():
                        return str(candidate)
    except Exception:
        pass

    # Windows 下常见的 UMI-OCR 安装位置
    if sys.platform == "win32":
        possible_paths = [
            # 桌面/下载/文档等用户目录（大小写变体）
            str(Path.home() / "Desktop" / "Umi-OCR" / "Umi-OCR.exe"),
            str(Path.home() / "Desktop" / "Umi-OCR" / "umi-ocr.exe"),
            str(Path.home() / "Desktop" / "Umi-OCR" / "UmiOCR.exe"),
            str(Path.home() / "Desktop" / "umi-ocr" / "Umi-OCR.exe"),
            str(Path.home() / "Downloads" / "Umi-OCR" / "Umi-OCR.exe"),
            str(Path.home() / "Documents" / "Umi-OCR" / "Umi-OCR.exe"),
            # 程序 Files
            r"C:\Program Files\Umi-OCR\Umi-OCR.exe",
            r"C:\Program Files (x86)\Umi-OCR\Umi-OCR.exe",
            r"C:\Program Files\UmiOCR\Umi-OCR.exe",
            # D 盘常见位置
            r"D:\Umi-OCR\Umi-OCR.exe",
            r"D:\Program Files\Umi-OCR\Umi-OCR.exe",
            r"D:\Tools\Umi-OCR\Umi-OCR.exe",
            r"D:\Software\Umi-OCR\Umi-OCR.exe",
            # E 盘
            r"E:\Umi-OCR\Umi-OCR.exe",
            r"E:\Tools\Umi-OCR\Umi-OCR.exe",
            r"E:\Software\Umi-OCR\Umi-OCR.exe",
            # F 盘
            r"F:\Umi-OCR\Umi-OCR.exe",
            # C 盘根目录
            r"C:\Umi-OCR\Umi-OCR.exe",
        ]
        # 检查每个路径
        for path in possible_paths:
            if os.path.isfile(path):
                return path
        # 尝试在 PATH 中查找
        for exe_name in ["umi-ocr", "Umi-OCR", "UmiOCR"]:
            try:
                result = subprocess.run(
                    ["where", exe_name],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    encoding="utf-8",
                    errors="ignore",
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
                )
                if result.returncode == 0 and result.stdout.strip():
                    found = result.stdout.strip().split("\n")[0].strip()
                    if os.path.isfile(found):
                        return found
            except Exception:
                pass
        # 尝试搜索常见盘符下的 Umi-OCR 文件夹（含一级子目录，适配 Umi-OCR_Paddle_v2.1.5 等版本目录）
        for drive in ["C:\\", "D:\\", "E:\\", "F:\\"]:
            if os.path.isdir(drive):
                for folder in ["Umi-OCR", "UmiOCR", "umi-ocr"]:
                    base = os.path.join(drive, folder)
                    # 直接在根目录
                    candidate = os.path.join(base, "Umi-OCR.exe")
                    if os.path.isfile(candidate):
                        return candidate
                    # 在一级子目录中查找（版本文件夹）
                    if os.path.isdir(base):
                        try:
                            for sub in os.listdir(base):
                                sub_path = os.path.join(base, sub)
                                if os.path.isdir(sub_path):
                                    exe = os.path.join(sub_path, "Umi-OCR.exe")
                                    if os.path.isfile(exe):
                                        return exe
                        except Exception:
                            pass
    return None


def _try_launch_umi_ocr() -> bool:
    """尝试自动启动 UMI-OCR。返回是否成功启动。"""
    global _umi_ocr_launch_attempted, _umi_ocr_process
    if _umi_ocr_launch_attempted:
        return False
    _umi_ocr_launch_attempted = True

    exe_path = _find_umi_ocr_executable()
    if not exe_path:
        return False

    try:
        # 启动 UMI-OCR（GUI 程序，需正常显示窗口，不能用 SW_HIDE/CREATE_NO_WINDOW，否则 Qt 可能初始化失败）
        _umi_ocr_process = subprocess.Popen(
            [exe_path],
            cwd=os.path.dirname(exe_path),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print(f"[OCR] 已自动启动 UMI-OCR: {exe_path}")
        return True
    except Exception as e:
        print(f"[OCR] 启动 UMI-OCR 失败: {e}")
        return False


async def _wait_for_umi_ocr_ready(max_wait: float = 8.0) -> bool:
    """等待 UMI-OCR HTTP 服务就绪，最多等待 max_wait 秒。"""
    import time
    url = f"http://{settings.umi_ocr_host}:{settings.umi_ocr_port}/api/ocr"
    start = time.time()
    while time.time() - start < max_wait:
        try:
            async with httpx.AsyncClient(timeout=2.0, trust_env=False) as client:
                # 发一个空请求测试连接（服务未就绪会返回 4xx/5xx，但只要能连接上就说明服务启动了）
                resp = await client.post(url, json={"base64": ""})
                return True  # 不管返回什么，只要能连接上就行
        except Exception:
            await asyncio.sleep(0.8)
    return False


async def _call_umi_ocr(content: bytes) -> str:
    """调用本地 UMI-OCR 的 HTTP 接口识别图片，返回全部文字。

    UMI-OCR 需先在软件内开启「HTTP接口服务」（默认监听 127.0.0.1:1224），
    接口：POST /api/ocr，body {"base64": "<图片base64>"}，
    响应：{"code":100,"data":[{"text":...,"box":[...],"score":...},...]}。

    注意：图片已由 preprocess_image 预处理（EXIF旋转+裁白边+缩到2560px），
    PaddleOCR 内部检测模型会自行 resize，无需在此二次缩放，避免小字号
    MRZ 因二次压缩导致识别率下降。
    """
    url = f"http://{settings.umi_ocr_host}:{settings.umi_ocr_port}/api/ocr"
    b64 = base64.b64encode(content).decode()
    try:
        async with httpx.AsyncClient(timeout=60.0, trust_env=False) as client:
            resp = await client.post(url, json={"base64": b64})
            resp.raise_for_status()
            data = resp.json()
    except httpx.ConnectError as e:
        raise RuntimeError(
            f"UMI-OCR 连接失败（请确认已开启 UMI-OCR 的「HTTP接口服务」，地址 {settings.umi_ocr_host}:{settings.umi_ocr_port}）: {e}"
        ) from e
    except httpx.TimeoutException as e:
        raise RuntimeError(f"UMI-OCR 请求超时（60秒）: {e}") from e
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"UMI-OCR 返回错误状态（HTTP {e.response.status_code}）: {e}") from e
    except Exception as e:
        raise RuntimeError(
            f"UMI-OCR 调用失败（请确认已开启 UMI-OCR 的「HTTP接口服务」，地址 {settings.umi_ocr_host}:{settings.umi_ocr_port}）: {e}"
        ) from e

    code = data.get("code")
    print(f"[UMI-DEBUG] response code={code}, img_bytes={len(content)}, raw_data_type={type(data.get('data')).__name__}")
    # code 100 = 成功；101 = 图片中未找到文字（非致命错误，返回空串）
    if code == 101:
        print(f"[UMI-DEBUG] code=101 no text found. full response: {str(data)[:500]}")
        return ""
    if code != 100:
        print(f"[UMI-DEBUG] unexpected code. full response: {str(data)[:500]}")
        raise RuntimeError(f"UMI-OCR 返回异常: {str(data)[:300]}")

    # data 字段可能是列表（直接的文字块数组），也可能是含 outputs 键的字典
    raw_data = data.get("data")
    if isinstance(raw_data, list):
        outputs = raw_data
    elif isinstance(raw_data, dict):
        outputs = raw_data.get("outputs", []) or raw_data.get("textBlocks", []) or []
    else:
        outputs = []

    lines = [o.get("text", "") for o in outputs if isinstance(o, dict) and o.get("text")]
    text = "\n".join(lines).strip()
    print(f"[UMI-DEBUG] blocks={len(outputs)}, text_len={len(text)}, first200={text[:200]!r}")
    return text


async def _check_umi_ocr_alive() -> bool:
    """快速检测 UMI-OCR HTTP 服务是否在线（2秒超时）。"""
    url = f"http://{settings.umi_ocr_host}:{settings.umi_ocr_port}/api/ocr"
    try:
        async with httpx.AsyncClient(timeout=2.0, trust_env=False) as client:
            await client.post(url, json={"base64": ""})
            return True
    except Exception:
        return False


async def ensure_umi_ocr_running() -> tuple[bool, str]:
    """确保 UMI-OCR 服务可用：在线则直接返回；否则尝试自动启动。

    返回 (ok, message)。ok=True 时服务可调用；ok=False 时 message 含中文原因。
    """
    # 1. 先检测是否已在线
    if await _check_umi_ocr_alive():
        return True, "UMI-OCR 服务已在线"

    # 2. 未在线 → 尝试自动启动
    launched = _try_launch_umi_ocr()
    if not launched:
        return False, (
            f"未找到 UMI-OCR 程序，且服务未在 {settings.umi_ocr_host}:{settings.umi_ocr_port} 运行。\n"
            "请选择以下任一方式：\n"
            "1. 手动打开 UMI-OCR 软件，在设置中开启「HTTP接口服务」（默认端口 1224）\n"
            "2. 将 Umi-OCR.exe 放在桌面 / Program Files / D:\\Umi-OCR 等常见位置以便自动启动\n"
            "3. 或切换回「识图AI」引擎（需配置 Vision API Key）"
        )

    # 3. 已启动，等待服务就绪（首次启动加载 PaddleOCR 模型可能较慢）
    ready = await _wait_for_umi_ocr_ready(max_wait=30.0)
    if not ready:
        return False, (
            f"UMI-OCR 已启动但 HTTP 服务在 30 秒内未就绪（{settings.umi_ocr_host}:{settings.umi_ocr_port}）。\n"
            "请确认 UMI-OCR 设置中已开启「HTTP接口服务」，并检查端口是否为 1224。"
        )
    return True, "UMI-OCR 服务已启动并就绪"


async def launch_umi_ocr() -> tuple[bool, str]:
    """显式一键启动 UMI-OCR（供前端按钮调用）。

    与 ensure_umi_ocr_running 的区别：会重置"已尝试启动"标记，允许用户反复点击重试。
    返回 (ok, message)。
    """
    global _umi_ocr_launch_attempted

    # 已经在线就直接返回
    if await _check_umi_ocr_alive():
        return True, "UMI-OCR 服务已在线"

    # 重置启动标记，允许再次尝试
    _umi_ocr_launch_attempted = False

    exe_path = _find_umi_ocr_executable()
    if not exe_path:
        return False, (
            "未找到 UMI-OCR 程序。\n"
            "请点击「选择程序」按钮指定 Umi-OCR.exe 的位置，\n"
            "或将 Umi-OCR.exe 放在桌面 / Program Files / D:\\Umi-OCR 等常见位置。"
        )

    launched = _try_launch_umi_ocr()
    if not launched:
        return False, f"启动 UMI-OCR 失败：{exe_path}"

    ready = await _wait_for_umi_ocr_ready(max_wait=30.0)
    if not ready:
        return False, (
            f"UMI-OCR 已启动但 HTTP 服务在 30 秒内未就绪（{settings.umi_ocr_host}:{settings.umi_ocr_port}）。\n"
            "请确认 UMI-OCR 设置中已开启「HTTP接口服务」，并检查端口是否为 1224。"
        )

    # 启动成功后，将发现的路径持久化到配置
    if not settings.umi_ocr_exe_path:
        settings.update_from_dict({"umi_ocr_exe_path": exe_path})

    return True, f"UMI-OCR 已启动并就绪（{exe_path}）"


def browse_umi_ocr_executable() -> str | None:
    """弹出系统文件选择对话框，让用户选择 Umi-OCR.exe。返回选中的路径，取消则返回 None。"""
    if sys.platform != "win32":
        return None
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        path = filedialog.askopenfilename(
            title="选择 Umi-OCR.exe",
            filetypes=[("可执行文件", "*.exe"), ("所有文件", "*.*")],
        )
        root.destroy()
        return path if path else None
    except Exception as e:
        print(f"[OCR] 打开文件选择对话框失败: {e}")
        return None


async def _vision_ocr_bytes(content: bytes) -> str:
    """使用 Vision LLM 识别图片文字（含内容审核拦截重试链）。"""
    if not settings.vision_api_key:
        raise RuntimeError("未配置 Vision API，无法 OCR 图片（请在设置中填写 API Key，或切换到 UMI-OCR）")

    content = _shrink_for_api(content)
    prompt = (
        "请识别这张图片中的所有文字，并以纯文本形式返回。"
        "不要添加任何解释、翻译或格式标记，只输出识别到的原始文字内容。"
        "\n\n重要：如果图片是护照/证件，请特别注意识别底部MRZ区域（两行由大写字母、数字和'<', '<<'符号组成的行），"
        "必须准确识别所有'<'符号（单尖括号和连续尖括号'<<<'），这些符号用于分隔姓名等字段。"
        "MRZ行通常以字母'P'开头（护照），格式类似：P<COUNTRY<SURNAME<<GIVEN<NAME<<<<<<..."
    )

    b64_img = base64.b64encode(content).decode()
    try:
        return await _call_vision_ocr(b64_img, prompt)
    except RuntimeError as e:
        args = e.args
        extra = args[1] if len(args) > 1 and isinstance(args[1], dict) else {}
        if not extra.get("sensitive"):
            raise
        # 内容审核拦截 → 重试链：轻度扰动 → 纯黑白二值化（彻底消除人脸灰阶）
        for transform in (_jitter_image_for_safety, _binarize_image_for_safety):
            alt = transform(content)
            if alt == content:
                continue
            try:
                return await _call_vision_ocr(base64.b64encode(alt).decode(), prompt)
            except RuntimeError as e2:
                args2 = e2.args
                extra2 = args2[1] if len(args2) > 1 and isinstance(args2[1], dict) else {}
                if not extra2.get("sensitive"):
                    raise
                continue
        # 所有重试仍失败，抛出原始错误（含中文提示和模型切换建议）
        raise e


async def ocr_image_bytes(content: bytes, engine: str | None = None) -> tuple[str, dict | None]:
    """识别图片中的全部文字，返回 (文本, 回退信息)。
    - umi: 先尝试 UMI-OCR，失败自动回退 Vision；fallback 非 None 时说明发生了回退
    - vision: 直接用 Vision LLM

    engine 参数可临时覆盖 settings.ocr_engine（用于前端「用另一引擎重新提取」）。
    """
    active_engine = engine or settings.ocr_engine
    if active_engine == "umi":
        # 先快速检测 UMI-OCR 是否在线（不触发自动启动，避免等待30秒）
        umi_ok = await _check_umi_ocr_alive()
        if umi_ok:
            try:
                text = await _call_umi_ocr(content)
                return text, None
            except RuntimeError as umi_err:
                # UMI 在线但调用失败 → 回退 Vision
                umi_reason = str(umi_err)
        else:
            # UMI 不在线 → 尝试快速启动（最多等 8 秒），不成功就回退
            launched = _try_launch_umi_ocr()
            if launched:
                ready = await _wait_for_umi_ocr_ready(max_wait=8.0)
                if ready:
                    try:
                        text = await _call_umi_ocr(content)
                        return text, None
                    except RuntimeError as umi_err:
                        umi_reason = str(umi_err)
                else:
                    umi_reason = "UMI-OCR 启动超时"
            else:
                umi_reason = "UMI-OCR 未安装或无法启动"

        # UMI 失败 → 自动回退 Vision
        try:
            text = await _vision_ocr_bytes(content)
            return text, {
                "from": "umi_ocr",
                "to": "vision_ocr",
                "reason": umi_reason,
            }
        except RuntimeError as vision_err:
            # Vision 也失败，抛出包含两种引擎错误信息的异常
            raise RuntimeError(
                f"UMI-OCR 失败：{umi_reason}\n"
                f"自动切换 AI Vision 也失败：{vision_err}"
            ) from vision_err

    # === vision 引擎 ===
    text = await _vision_ocr_bytes(content)
    return text, None


# ============ MRZ 解析（护照机器可读区） ============
def _normalize_for_compare(s: str) -> str:
    """归一化字符串用于比较：去空格、转大写、去除多余符号。"""
    import re as _re_norm
    s = s.upper().strip()
    s = _re_norm.sub(r'[\s\-_/]+', '', s)
    return s


def _parse_mrz(text: str) -> dict[str, str]:
    """从OCR文本中解析护照MRZ区，提取 surname/given_name/name/passport_no/birth_date/gender/nationality 等字段。

    TD3（普通护照）MRZ格式：两行，每行44字符
    第1行: P[类型补充]<国家码><SURNAME<<GIVEN<NAMES<<<<<
           实际OCR中 < 常被识别为其他字符，格式可能不严格，需通过 << 定位
    第2行: 护照号(9)检查位(1)国家码(3)出生年(2)月(2)日(2)检查位(1)性别(1)失效年(2)月(2)日(2)检查位(1)个人号(14)检查位(1)整体检查位(1)

    如果识别成功返回 dict，未识别到返回空 dict。
    """
    import re as _re

    # 清洗OCR文本：去除多余空格，统一行分隔符，统一大写
    cleaned = text.replace("\r\n", "\n").replace("\r", "\n").upper()
    # 去除OCR可能产生的空格
    cleaned = _re.sub(r'[ \t]+', '', cleaned)

    # 把所有连续的非字母数字<的字符作为行分隔
    lines = [l.strip() for l in cleaned.split("\n") if l.strip()]

    # 在所有行中找MRZ第一行：包含 P< + 三字母国家码 + << 模式
    mrz_line1 = None
    mrz_line2 = None

    def _looks_like_mrz_line2(cand: str) -> bool:
        """MRZ第二行特征：全是大写字母/数字/<，长度>=28，包含F/M性别标记，有6位数字日期"""
        return (len(cand) >= 28 and _re.match(r'^[A-Z0-9<]+$', cand)
                and ("F" in cand or "M" in cand)
                and _re.search(r'\d{6}', cand) is not None)

    def _find_mrz_line1_in(text_line: str) -> str | None:
        """在一行文本中查找MRZ第一行的起始位置，返回从 P< 开始的子串。

        OCR常把MRZ和其他文字混在同一行（如 "...DATE 11.08.2030 P<RUSSTOKOLIAN<<..."），
        不能要求整行以P开头，而应在行内搜索 P<[A-Z]{3} 模式。
        """
        # 找 P< 后面紧跟3个大写字母（国家码）的位置
        for m in _re.finditer(r'P<[A-Z]{3}', text_line):
            start = m.start()
            candidate = text_line[start:]
            # 从 P< 开始，取连续的 MRZ 字符（字母/数字/<）直到遇到非MRZ字符
            mrz_chars = _re.match(r'[A-Z0-9<]+', candidate)
            if mrz_chars:
                extracted = mrz_chars.group(0)
                if "<<" in extracted and len(extracted) >= 20:
                    return extracted
        return None

    for i, line in enumerate(lines):
        found = _find_mrz_line1_in(line)
        if found:
            mrz_line1 = found
            # 在接下来的若干行中找MRZ第二行（OCR可能在两行MRZ之间插入噪声行）
            for j in range(i + 1, min(i + 6, len(lines))):
                cand = lines[j]
                if _looks_like_mrz_line2(cand):
                    mrz_line2 = cand
                    break
                # 噪声行可能只混入少量小写/杂字符：清洗后再判一次
                cand2 = _re.sub(r'[^A-Z0-9<]', '', cand)
                if cand2 != cand and _looks_like_mrz_line2(cand2):
                    mrz_line2 = cand2
                    break
            break

    # 回退0：如果MRZ第一行和第二行在同一行（OCR合并），尝试从mrz_line1中切出第二行
    if mrz_line1 and not mrz_line2:
        # 在mrz_line1中搜索第二行模式：9位字母数字+1位+3位国家码+6位数字+检查位+F/M+6位数字
        m2 = _re.search(r'([A-Z0-9]{9}[A-Z0-9<][A-Z]{3}\d{6}\d[FM]\d{6}[A-Z0-9<]*)', mrz_line1)
        if m2:
            mrz_line2 = m2.group(1)
            # 第一行截断到第二行开始之前
            l1_end = m2.start()
            if l1_end >= 20:
                mrz_line1 = mrz_line1[:l1_end]

    # 回退1：MRZ第一行本身可能因为超长需要在44字符附近截断（TD3每行44字符）
    if mrz_line1 and len(mrz_line1) > 50 and not mrz_line2:
        for cut in range(40, min(49, len(mrz_line1) - 28)):
            tail = mrz_line1[cut:]
            if _looks_like_mrz_line2(tail):
                mrz_line2 = tail
                mrz_line1 = mrz_line1[:cut]
                break

    # 回退2：全文正则搜索MRZ第二行模式（护照号9位+检查位+国家码3位+出生6位+检查位+性别+有效期6位）
    if mrz_line1 and not mrz_line2:
        flat = cleaned.replace("\n", "")
        m = _re.search(r'[A-Z0-9]{9}[A-Z0-9<][A-Z]{3}\d{6}\d[FM]\d{6}[A-Z0-9<]*', flat)
        if m:
            mrz_line2 = m.group(0)

    result: dict[str, str] = {}
    if not mrz_line1:
        return result

    line1 = mrz_line1

    # === 解析第一行 ===
    # 找到 << 的位置（surname和given name的分隔符）
    sep_idx = line1.find("<<")
    if sep_idx < 3:
        return result  # << 太靠前，无法解析

    # 提取surname：<< 之前，去掉开头的文档类型（P）和国家码（3位）以及分隔<
    surname_part = ""
    country_code = ""

    # 首先从第二行获取国家码（更可靠，位置固定在10-12位）
    if mrz_line2 and len(mrz_line2) >= 13:
        cc2 = mrz_line2[10:13]
        if _re.match(r'^[A-Z]{3}$', cc2):
            country_code = cc2

    pre_sep = line1[1:sep_idx]  # 跳过开头P，得到P到<<之间的内容

    if country_code:
        # 已知国家码，在pre_sep中找到它的位置，后面的字母就是surname
        cc_pos = pre_sep.find(country_code)
        if cc_pos >= 0:
            after_cc = pre_sep[cc_pos + 3:]
            # after_cc可能以<开头（分隔符），也可能直接是surname（OCR丢失<）
            # 去掉开头的非字母字符
            sur_start = 0
            while sur_start < len(after_cc) and not after_cc[sur_start].isalpha():
                sur_start += 1
            # 从sur_start开始取连续字母
            sur_match = _re.match(r'[A-Z]+', after_cc[sur_start:])
            if sur_match:
                surname_part = sur_match.group(0)

    if not surname_part:
        # 回退策略1：在pre_sep中寻找最后一个<，<后面的字母就是surname
        last_lt = pre_sep.rfind("<")
        if last_lt >= 0:
            after_lt = pre_sep[last_lt + 1:]
            sur_match = _re.match(r'[A-Z]+', after_lt)
            if sur_match:
                surname_part = sur_match.group(0)

    if not surname_part:
        # 回退策略2：找最后一个连续大写字母序列
        sur_matches = list(_re.finditer(r'[A-Z]{2,}', pre_sep))
        if sur_matches:
            # 如果有国家码，找国家码之后的字母序列
            if country_code:
                for m in sur_matches:
                    if m.start() >= pre_sep.find(country_code) + 3 if country_code in pre_sep else True:
                        surname_part = m.group(0)
                        break
            if not surname_part:
                # 取最后一个足够长的字母序列
                long_matches = [m for m in sur_matches if len(m.group(0)) >= 3]
                if long_matches:
                    surname_part = long_matches[-1].group(0)
                else:
                    surname_part = sur_matches[-1].group(0)

    if not surname_part:
        # 最终回退：跳过P和前3个字符（国家码位置），后面是surname直到<<或<
        after_p = line1[1:]
        if len(after_p) >= 3:
            rest = after_p[3:]
            # 跳过开头的非字母字符（可能是OCR错误识别的<变体）
            sur_start = 0
            while sur_start < len(rest) and not rest[sur_start].isalpha():
                sur_start += 1
            sur_match = _re.match(r'[A-Z]+', rest[sur_start:])
            if sur_match:
                surname_part = sur_match.group(0)
            else:
                surname_part = rest.lstrip("<").split("<")[0].split("<<")[0]

    # 如果已知国家码但surname开头包含了国家码的尾字母，需要裁剪
    if country_code and surname_part:
        # 检查surname是否错误地包含了国家码前缀
        # 常见情况：OCR把<RUS识别成NRUS，surname变成NRUSBYSTROVA
        # 国家码是RUS，但N是误识别的<
        if surname_part.startswith(country_code):
            pass  # 正确，国家码不在surname中
        elif country_code in surname_part:
            idx = surname_part.find(country_code)
            if idx > 0 and idx <= 2:
                # 国家码出现在surname开头附近，前面的是误识别字符，裁剪掉
                surname_part = surname_part[idx + 3:]

    # 提取given names：第一个<<之后到行尾（或下一个<<<结束标记）
    given_part = line1[sep_idx + 2:]
    # 找到连续的<<<之后的填充部分并截断
    fill_start = given_part.find("<<<")
    if fill_start >= 0:
        given_part = given_part[:fill_start]
    # OCR常在两行MRZ之间插入噪声（如 "EKATERINAMBA78036NORMOSXATH"），
    # MRZ第一行名字区只含字母和<，遇到数字说明已超出名字范围
    digit_pos = None
    for ci, ch in enumerate(given_part):
        if ch.isdigit():
            digit_pos = ci
            break
    if digit_pos is not None:
        given_part = given_part[:digit_pos]
    given_part = given_part.rstrip("<")
    given_name = given_part.replace("<", " ").strip()
    surname = surname_part.strip()

    if surname:
        result["surname"] = surname
    if given_name:
        result["given_name"] = given_name
    if surname or given_name:
        result["name"] = f"{surname} {given_name}".strip()

    # 国家码映射
    _COUNTRY_MAP = {
        "CHN": "CHINESE", "RUS": "RUSSIAN", "USA": "AMERICAN", "GBR": "BRITISH",
        "JPN": "JAPANESE", "KOR": "KOREAN", "DEU": "GERMAN", "FRA": "FRENCH",
        "CAN": "CANADIAN", "AUS": "AUSTRALIAN", "NLD": "DUTCH", "ESP": "SPANISH",
        "ITA": "ITALIAN", "SGP": "SINGAPOREAN", "MYS": "MALAYSIAN", "THA": "THAI",
        "VNM": "VIETNAMESE", "IDN": "INDONESIAN", "IND": "INDIAN", "UKR": "UKRAINIAN",
        "BLR": "BELARUSIAN", "KAZ": "KAZAKH", "UZB": "UZBEK", "TUR": "TURKISH",
        "PN": "RUSSIAN",  # 可能OCR把<RUS识别成NRUS
    }
    if country_code:
        country_code_clean = country_code.rstrip("<")
        if len(country_code_clean) >= 3:
            country_code_clean = country_code_clean[-3:]  # 取最后3个字母作为国家码
        if _re.match(r'^[A-Z]{3}$', country_code_clean):
            result["nationality"] = _COUNTRY_MAP.get(country_code_clean, country_code_clean)

    # === 解析第二行（如果存在）：护照号、出生日期、性别、有效期 ===
    if mrz_line2:
        line2 = mrz_line2
        # 护照号：前9位（字母数字，去掉末尾<填充）
        passport_no = line2[:9].rstrip("<")
        if _re.match(r'^[A-Z0-9]{4,}$', passport_no):
            result["passport_no"] = passport_no

        # 出生日期：YYMMDD 格式（在性别F/M前面的6位数字）
        # MRZ第二行TD3标准布局：护照号(9)检查位(1)国家码(3)出生日期(6)检查位(1)性别(1)有效期(6)...
        # 性别固定在位置20（0-indexed），优先取该位置，避免护照号中含F/M字母导致错位
        sex_pos = -1
        sex_char = ""
        if len(line2) > 20 and line2[20] in "FM":
            sex_pos = 20
            sex_char = line2[20]
        else:
            # 位置20不是F/M（OCR错位/缺字符）→ 在18-24窗口内搜索F/M
            window_match = _re.search(r'[FM]', line2[16:26]) if len(line2) >= 26 else None
            if window_match:
                sex_pos = 16 + window_match.start()
                sex_char = window_match.group(0)
            else:
                # 最终回退：全文搜索F/M（老逻辑，可能错位但聊胜于无）
                m_any = _re.search(r'[FM]', line2)
                if m_any:
                    sex_pos = m_any.start()
                    sex_char = m_any.group(0)
        if sex_pos >= 0:
            result["gender"] = sex_char
            # MRZ第二行格式：...出生日期(6位)检查位(1位)性别(1位)有效期(6位)检查位(1位)...
            # 出生日期在性别前：向前数7个位置取6位（跳过检查位）
            if sex_pos >= 7:
                birth_str = line2[sex_pos - 7:sex_pos - 1]
                if _re.match(r'^\d{6}$', birth_str):
                    byy = birth_str[:2]
                    bmm = birth_str[2:4]
                    bdd = birth_str[4:6]
                    byy_int = int(byy)
                    year_prefix = 19 if byy_int > 30 else 20
                    result["birth_date"] = f"{year_prefix}{byy}-{bmm}-{bdd}"

            # 有效期：性别后面直接是6位YYMMDD（后面是检查位）
            if sex_pos + 7 <= len(line2):
                expiry_str = line2[sex_pos + 1:sex_pos + 7]
                if _re.match(r'^\d{6}$', expiry_str):
                    eyy = expiry_str[:2]
                    emm = expiry_str[2:4]
                    edd = expiry_str[4:6]
                    result["passport_expiry"] = f"20{eyy}-{emm}-{edd}"

    return result


# ============ 字段结构化（从全文中提取目标字段） ============

# 目标字段的中文/英文说明，供 LLM 提示词使用
_FIELD_LABELS: dict[str, str] = {
    "surname": "姓（英文拼音，如 KUT）",
    "given_name": "名（英文拼音，如 AMIR）",
    "name": "姓名（完整姓名，如 KUT AMIR）",
    "passport_no": "护照号",
    "birth_date": "出生日期，格式 YYYY-MM-DD",
    "gender": "性别（M/F 或 男/女）",
    "nationality": "国籍（三字国家码或英文国名）",
    "passport_issue": "护照签发日期（Date of issue / 签发日期），格式 YYYY-MM-DD",
    "passport_expiry": "护照有效期至（Date of expiry / Expiry date / 有效期至 / Valid until），格式 YYYY-MM-DD",
    "issue_authority": "签发机关（Authority）",
    "issue_place": "签发地点（Place of issue）",
    "email": "电子邮箱",
    "phone": "电话号码",
}


def _extract_date_by_keywords(text: str, keywords: list[str]) -> str:
    """从 OCR 文本中根据关键词附近提取日期，返回 YYYY-MM-DD 或空串。

    用于在 MRZ 解析失败时作为回退，从 VIZ 可视区文字中提取日期。
    关键词中的空格在匹配时视为可选（OCR 常把 "Date of expiry" 识别成 "Dateof expiry"）。
    """
    if not text:
        return ""
    upper = text.upper()
    for kw in keywords:
        kw_up = kw.upper()
        # 把关键词按空格拆分，各部分分别转义后用 \s* 连接，
        # 容忍 OCR 丢失或多余空格（如 "Dateof expiry" 匹配 "Date of expiry"）
        parts = [re.escape(p) for p in kw_up.split() if p]
        kw_pattern = r'\s*'.join(parts)
        m = re.search(kw_pattern, upper)
        if not m:
            continue
        idx = m.start()
        # 取关键词后面 80 个字符作为搜索窗口
        window = text[idx: idx + 80]
        # 匹配各种日期格式
        # YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
        m = re.search(r'(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})', window)
        if m:
            y, mo, d = m.group(1), m.group(2).zfill(2), m.group(3).zfill(2)
            if 1900 <= int(y) <= 2100 and 1 <= int(mo) <= 12 and 1 <= int(d) <= 31:
                return f"{y}-{mo}-{d}"
        # DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY
        m = re.search(r'(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})', window)
        if m:
            d, mo, y = m.group(1).zfill(2), m.group(2).zfill(2), m.group(3)
            if 1900 <= int(y) <= 2100 and 1 <= int(mo) <= 12 and 1 <= int(d) <= 31:
                return f"{y}-{mo}-{d}"
        # DD MMM YYYY / DD MMMM YYYY (英文月份)
        m = re.search(
            r'(\d{1,2})\s*(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s*(\d{4})',
            window, re.IGNORECASE
        )
        if m:
            months = {'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04',
                      'MAY': '05', 'JUN': '06', 'JUL': '07', 'AUG': '08',
                      'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'}
            d = m.group(1).zfill(2)
            mo_str = m.group(0).upper()
            mo = next((v for k, v in months.items() if k in mo_str), '')
            y = m.group(2)
            if mo and 1900 <= int(y) <= 2100:
                return f"{y}-{mo}-{d}"
    return ""


def _extract_expiry_from_text(text: str) -> str:
    """从 OCR 文本中回退提取护照有效期至。"""
    return _extract_date_by_keywords(text, [
        "DATE OF EXPIRY", "EXPIRY DATE", "DATE OF EXPIRATION", "VALID UNTIL",
        "VALID THRU", "BESTEHEN BIS", "有效期至", "有效期", "失效日期",
    ])


def _extract_issue_from_text(text: str) -> str:
    """从 OCR 文本中回退提取护照签发日期。"""
    return _extract_date_by_keywords(text, [
        "DATE OF ISSUE", "ISSUED ON", "VALID FROM", "ISSUING DATE",
        "签发日期", "发证日期", "有效期开始",
    ])


def _scan_all_dates(text: str) -> list[str]:
    """扫描全文中所有合法日期，返回去重后的 YYYY-MM-DD 列表（按出现顺序）。

    支持格式：YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD / DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY。
    用于签发日/有效期其中一个已提到时的排除法推断。
    """
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()

    def _add(y: str, mo: str, d: str) -> None:
        try:
            yi, mi, di = int(y), int(mo), int(d)
        except ValueError:
            return
        if 1900 <= yi <= 2100 and 1 <= mi <= 12 and 1 <= di <= 31:
            val = f"{yi}-{str(mi).zfill(2)}-{str(di).zfill(2)}"
            if val not in seen:
                seen.add(val)
                found.append(val)

    for m in re.finditer(r'(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})', text):
        _add(m.group(1), m.group(2), m.group(3))
    for m in re.finditer(r'(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})', text):
        _add(m.group(3), m.group(2), m.group(1))
    return found


def _infer_missing_date_pair(text: str, issue: str, expiry: str,
                              birth_date: str = "") -> tuple[str, str]:
    """签发日/有效期互补推断：只提到一个时，从全文日期中排除法推断另一个。

    规则：
    - 有效期至(expiry)通常是未来日期或晚于签发日的日期（护照有效期一般5-10年）
    - 签发日(issue)通常早于有效期至，且晚于出生日期
    - 出生日期本身会被排除（避免把 birth_date 误判为 issue）
    返回 (issue, expiry)，已存在的保持不变。
    """
    if issue and expiry:
        return issue, expiry
    candidates = [d for d in _scan_all_dates(text) if d != birth_date]
    # 排除已经确定的那个值，避免重复分配
    known = issue or expiry
    pool = [d for d in candidates if d != known]
    if not pool:
        return issue, expiry

    if issue and not expiry:
        # 有效期应晚于签发日；优先选比签发日晚的，没有再选最大的
        later = [d for d in pool if d > issue]
        expiry = max(later) if later else ""
    elif expiry and not issue:
        # 签发日应早于有效期；优先选比有效期早的里面最大的（最接近签发时间）
        earlier = [d for d in pool if d < expiry]
        issue = max(earlier) if earlier else ""
    return issue, expiry


# ============ 本地正则/关键词字段提取（不依赖 Vision API） ============

# 各国护照常见字段标签的多语言关键词（OCR可能丢空格/混大小写，匹配时容忍）
_LABEL_SURNAME = [
    r"SURNAME", r"FAMILY\s*NAME", r"LAST\s*NAME",
    r"S[A-Z]?RNAME",  # OCR误拼：Pauthwa/Surname等
    r"ФАМИЛИЯ", r"ФАМИЛИЯ",  # 俄语
    r"姓", r"姓氏",
]
_LABEL_GIVEN = [
    r"GIVEN\s*NAMES?", r"FIRST\s*NAME", r"FORENAME",
    r"G[A-Z]{0,2}ENN?AMES?",  # OCR误拼：Gvennames/Gvennames/GIVENNAMES等
    r"ИМЯ", r"ИМЕНА",  # 俄语
    r"名", r"名字",
]
_LABEL_PASSPORT_NO = [
    r"PASSPORT\s*NO\.?", r"PASSPORT\s*NUMBER", r"DOCUMENT\s*NO\.?",
    r"Номер\s*паспорта", r"ПАСПОРТ",  # 俄语
    r"PASSPORTNO", r"PASSPORTNUMBER",
    r"护照号", r"护照号码",
]
_LABEL_NATIONALITY = [
    r"NATIONALITY", r"CITIZENSHIP",
    r"ГРАЖДАНСТВО", r"НАЦИОНАЛЬНОСТЬ",  # 俄语
    r"国籍",
]
_LABEL_BIRTH_DATE = [
    r"DATE\s*OF\s*BIRTH", r"BIRTH\s*DATE", r"DOB",
    r"ДАТА\s*РОЖДЕНИЯ",  # 俄语
    r"出生日期", r"生日",
]
_LABEL_GENDER = [
    r"SEX", r"GENDER",
    r"ПОЛ",  # 俄语
    r"性别",
]
_LABEL_ISSUE_DATE = [
    r"DATE\s*OF\s*ISSUE", r"ISSUED\s*ON", r"VALID\s*FROM", r"ISSUING\s*DATE",
    r"ДАТА\s*ВЫДАЧИ",  # 俄语
    r"签发日期", r"发证日期",
]
_LABEL_EXPIRY_DATE = [
    r"DATE\s*OF\s*EXPIRY", r"EXPIRY\s*DATE", r"DATE\s*OF\s*EXPIRATION",
    r"VALID\s*UNTIL", r"VALID\s*THRU", r"BESTEHEN\s*BIS",
    r"СРОК\s*ДЕЙСТВИЯ",  # 俄语
    r"有效期至", r"有效期", r"失效日期",
]
_LABEL_ISSUE_AUTHORITY = [
    r"AUTHORITY", r"ISSUING\s*AUTHORITY", r"ISSUED\s*BY",
    r"ОРГАН", r"ВЫДАН",  # 俄语
    r"签发机关", r"发照机关",
]
_LABEL_BIRTH_PLACE = [
    r"PLACE\s*OF\s*BIRTH", r"BIRTH\s*PLACE",
    r"МЕСТО\s*РОЖДЕНИЯ",  # 俄语
    r"出生地点", r"出生地",
]


def _extract_after_label(text_upper: str, labels: list[str]) -> str:
    """在文本中查找标签关键词，返回其后的第一个有意义值（字母/数字序列）。

    OCR 常把标签和值粘连（如 "SURNAMEDUPONT" 或 "ФАМИЛИЯИВАНОВ"），
    因此先尝试精确匹配标签后内容，再尝试在标签后取连续字母。
    """
    import re as _re
    for label in labels:
        # 标签后可能紧跟值（无分隔符），或有空格/冒号/换行
        # 使用宽松匹配：标签本身 + 可选的非字母字符（空格/冒号/斜杠等）+ 捕获值
        pattern = label + r"[\s:：/\\|]*([A-ZА-ЯЁ][A-ZА-ЯЁ\s\-']{1,40})"
        m = _re.search(pattern, text_upper)
        if m:
            val = m.group(1).strip().rstrip("<")
            # 去掉尾部可能粘连的下一个标签关键词
            for stop in ("NATIONALITY", "DATE", "SEX", "GENDER", "PLACE",
                         "AUTHORITY", "GIVEN", "PASSPORT", "ISSU",
                         "ГРАЖДАН", "ДАТА", "МЕСТО", "ОРГАН", "ПОЛ",
                         "ФАМИЛИЯ", "ИМЯ", "СРОК", "ТИП", "КОД"):
                idx = val.find(stop)
                if idx > 1:
                    val = val[:idx].strip()
            val = val.strip()
            if len(val) >= 2 and not val.isdigit():
                return val
    return ""


def _extract_latin_name_after_label(text_upper: str, labels: list[str]) -> str:
    """在标签后查找拉丁字母拼写的姓名（跳过西里尔字母/数字/噪声词）。

    护照OCR常在标签后先出现本国文字（西里尔/中文等），再出现拉丁字母拼写
    （如 "GVENNAMES ЕКАТЕРИНА EKATERINA"），需要取拉丁字母版本。
    搜索范围严格限制在当前标签与下一个已知标签之间，避免跨字段污染。
    """
    import re as _re
    # 下一个字段标签的起始模式（遇到这些说明当前字段值已结束）
    next_label_patterns = [
        r"PASSPORT", r"NATIONA[FL]", r"DATE[\sOF]", r"BIRTH", r"SEX",
        r"PLACE", r"ISSUE", r"EXPIR", r"AUTHOR", r"TYPE", r"CODE",
        r"GVENN?AMES?", r"GIVENN?AMES?", r"PAUTHWA", r"SURNAME",
        r"FEDERATION", r"PAXAA\w*", r"NACHOPT", r"P<",
        r"POCC\w+", r"AATAPOX", r"AAPAB", r"YUE", r"MECROP",
        r"HON/", r"NON/", r"DAMCT", r"X/F\s", r"M\s*/F",
    ]
    # 非姓名词黑名单
    skip_words = {"THE", "AND", "FOR", "RUS", "USA", "CHN", "TYPE",
                  "CODE", "FEDERATION", "REPUBLIC", "NUMBER", "NAME",
                  "SURNAME", "GIVEN", "NATIONAL", "PLACE", "BIRTH",
                  "ISSUE", "EXPIRY", "AUTHORITY", "HOUEE", "HOUU",
                  "MBA", "NORMOS", "MRA", "XATH", "VVA", "VVAGVENNAMES",
                  "CARSCAR", "KANMOOBAHO", "TN", "TYP", "RKNPNG",
                  "NACHOPT", "FEDERATIONRUS", "YEAR", "MONTH", "DAY",
                  "RUSSIANFEDERATION", "RUSSIANFEDERATI", "POCCMHCKAE",
                  "POCCMMCKAA", "RUSSIAN", "CHINESE", "AMERICAN"}

    def _looks_like_name(w: str) -> bool:
        if w in skip_words or w.isdigit() or len(w) < 3:
            return False
        # 连续4个以上辅音 → 西里尔OCR乱码
        if _re.search(r'[BCDFGHJKLMNPQRSTVWXYZ]{4,}', w):
            return False
        # 必须包含元音
        if not any(c in "AEIOU" for c in w):
            return False
        # 过滤全是OCR乱码特征的词（大量重复字母或奇怪序列）
        if _re.search(r'(.)\1{2,}', w):  # 3个以上相同字母连续
            return False
        return True

    for label in labels:
        pattern = label + r"[\s:：/\\|]*(.{1,150})"
        m = _re.search(pattern, text_upper)
        if not m:
            continue
        after = m.group(1)
        # 在换行处截断
        for ch in ("\n", "\r"):
            pos = after.find(ch)
            if pos >= 0:
                after = after[:pos]
        # 在下一个已知标签处截断
        earliest_cut = len(after)
        for nlp in next_label_patterns:
            nm = _re.search(nlp, after)
            if nm and nm.start() > 0 and nm.start() < earliest_cut:
                earliest_cut = nm.start()
        after = after[:earliest_cut]
        # 查找所有拉丁字母词
        words = _re.findall(r'[A-Z][A-Z\-]{1,30}', after)
        candidates = [w for w in words if _looks_like_name(w)]
        if candidates:
            # 在当前字段范围内，取最后一个合理候选（拉丁拼写在本国文字之后）
            return candidates[-1]
    return ""


def _extract_alphanum_after_label(text_upper: str, labels: list[str],
                                    min_len: int = 4, max_len: int = 20) -> str:
    """在标签后提取字母数字组合（如护照号）。"""
    import re as _re
    for label in labels:
        pattern = label + r"[\s:：/\\|]*([A-Z0-9]{" + str(min_len) + r"," + str(max_len) + r"})"
        m = _re.search(pattern, text_upper)
        if m:
            val = m.group(1).strip().rstrip("<")
            # 排除纯字母国家码（太短或全是字母且<=3）
            if len(val) >= min_len:
                return val
    return ""


def _extract_gender_near_label(text_upper: str) -> str:
    """在性别标签附近找 F/M。"""
    import re as _re
    for label in _LABEL_GENDER:
        pattern = label + r"[\s:：/\\|]*([FM])"
        m = _re.search(pattern, text_upper)
        if m:
            return m.group(1)
    # 回退：找 "SEX" 后 20 字符内的独立 F/M
    m = _re.search(r'(?:SEX|GENDER|ПОЛ|性别)[\s:：/\\|]{0,10}([FM])(?![A-ZА-ЯЁ])', text_upper)
    if m:
        return m.group(1)
    return ""


def _extract_local_fields(text: str, target_fields: list[str]) -> dict[str, str]:
    """纯本地正则/关键词字段提取，不依赖任何 API。

    作为 MRZ 和 Vision LLM 之后的兜底，从 OCR 文本中通过
    多语言标签关键词 + 日期模式 + 护照号模式提取字段。
    对俄语护照标签（Фамилия/Имя/Гражданство 等）也有支持。
    """
    if not text or not target_fields:
        return {}
    import re as _re
    upper = text.upper()
    result: dict[str, str] = {}

    # 姓名类（优先取拉丁字母拼写，跳过西里尔/噪声）
    if "surname" in target_fields:
        val = _extract_latin_name_after_label(upper, _LABEL_SURNAME)
        if not val:
            val = _extract_after_label(upper, _LABEL_SURNAME)
        if val:
            result["surname"] = val
    if "given_name" in target_fields:
        val = _extract_latin_name_after_label(upper, _LABEL_GIVEN)
        if not val:
            val = _extract_after_label(upper, _LABEL_GIVEN)
        if val:
            result["given_name"] = val
    if "name" in target_fields:
        sur = result.get("surname", "")
        giv = result.get("given_name", "")
        if sur or giv:
            result["name"] = f"{sur} {giv}".strip()

    # 护照号
    if "passport_no" in target_fields:
        val = _extract_alphanum_after_label(upper, _LABEL_PASSPORT_NO, min_len=5)
        if val:
            result["passport_no"] = val

    # 国籍
    if "nationality" in target_fields:
        val = _extract_after_label(upper, _LABEL_NATIONALITY)
        if val:
            # 清理常见OCR粘连
            val = val.split("DATE")[0].split("SEX")[0].split("PLACE")[0].strip()
            if len(val) >= 2:
                result["nationality"] = val

    # 性别
    if "gender" in target_fields:
        val = _extract_gender_near_label(upper)
        if val:
            result["gender"] = val

    # 出生日期
    if "birth_date" in target_fields:
        val = _extract_date_by_keywords(text, [
            "DATE OF BIRTH", "BIRTH DATE",
            "ДАТА РОЖДЕНИЯ", "出生日期",
        ])
        if val:
            result["birth_date"] = val

    # 签发日期
    if "passport_issue" in target_fields:
        val = _extract_date_by_keywords(text, [
            "DATE OF ISSUE", "ISSUED ON", "VALID FROM",
            "ДАТА ВЫДАЧИ", "签发日期",
        ])
        if val:
            result["passport_issue"] = val

    # 有效期
    if "passport_expiry" in target_fields:
        val = _extract_date_by_keywords(text, [
            "DATE OF EXPIRY", "EXPIRY DATE", "DATE OF EXPIRATION",
            "VALID UNTIL", "VALID THRU", "СРОК ДЕЙСТВИЯ",
            "有效期至", "有效期", "失效日期",
        ])
        if val:
            result["passport_expiry"] = val

    # 签发机关
    if "issue_authority" in target_fields:
        val = _extract_after_label(upper, _LABEL_ISSUE_AUTHORITY)
        if val:
            result["issue_authority"] = val

    # 出生地点
    if "issue_place" in target_fields or "birth_place" in target_fields:
        val = _extract_after_label(upper, _LABEL_BIRTH_PLACE)
        if val:
            if "issue_place" in target_fields:
                result["issue_place"] = val
            if "birth_place" in target_fields:
                result["birth_place"] = val

    # 邮箱
    if "email" in target_fields:
        m = _re.search(r'[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}', upper)
        if m:
            result["email"] = m.group(0)

    # 电话
    if "phone" in target_fields:
        m = _re.search(r'(?:\+?\d[\d\s\-()]{6,}\d)', upper)
        if m:
            result["phone"] = m.group(0).strip()

    return result


def _build_fields_prompt(text: str, target_fields: list[str]) -> str:
    # 为每个字段添加说明（如果有）
    field_specs = "\n".join(
        f'  "{f}": {_FIELD_LABELS.get(f, f)}' for f in target_fields
    )
    # 截断超长文本，避免超出上下文
    snippet = text[:6000]
    return f"""以下是一份文档（证件/表单/网页截图）中提取出的文字内容：

---
{snippet}
---

请从上述文字中提取以下字段的值：
{{
{field_specs}
}}

要求：
1. 严格以 JSON 对象返回，key 为字段名，value 为文档中对应的值（字符串）
2. 文档中找不到的字段返回空字符串 ""
3. 日期统一为 YYYY-MM-DD 格式
4. 不要输出任何 JSON 以外的内容
5. 如果是护照/证件，底部MRZ行（以P开头的那行，如 P<RUS<BYSTROVA<<ANNA<PAVLOVNA<<<...）中'<<'分隔的英文姓名也视为有效姓名来源：
   - surname（姓）：第一个<<之前的字母，如BYSTROVA
   - given_name（名）：第一个<<之后到行尾的字母，多个<分隔的部分都是名，如ANNA PAVLOVNA
   - name：姓 + 名的完整组合
6. 护照可视区通常印有签发日期(passport_issue)和有效期至(passport_expiry)，
   如 "Date of issue" / "签发日期" 对应 passport_issue，
   "Date of expiry" / "Expiry date" / "有效期至" / "Valid until" 对应 passport_expiry，
   请从OCR文本中识别填入。
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


# VIZ（护照可视区）专有字段：这些字段不在 MRZ 机读码里，只能从图片可视区读取。
# 当检测到护照 MRZ 时，对这些字段直接用 Vision LLM「看图」提取，比先 OCR 成文字再提取更可靠。
_VIZ_FIELDS = {"passport_issue", "passport_expiry", "issue_authority", "issue_place"}

_VIZ_FIELD_LABELS = {
    "passport_issue": "护照签发日期（证件有效开始时间），格式 YYYY-MM-DD",
    "passport_expiry": "护照有效期至（证件失效日期/Date of expiry），格式 YYYY-MM-DD",
    "issue_authority": "签发机关",
    "issue_place": "签发地点",
}


async def _extract_viz_fields_from_image(
    image_content: bytes, viz_fields: list[str]
) -> dict[str, str]:
    """直接看护照图片，提取 VIZ 可视区字段（签发日期等）。

    仅在检测到 MRZ（确认是护照）时调用，避免对非证件图片产生误识别。
    """
    if not viz_fields or not settings.vision_api_key:
        return {}
    b64_img = base64.b64encode(image_content).decode()
    field_specs = ",\n".join(
        f'  "{f}": "{_VIZ_FIELD_LABELS.get(f, f)}"' for f in viz_fields
    )
    prompt = (
        "这是一张护照/证件图片。请仔细查看证件上方可视区（非底部机读码MRZ），"
        "提取以下字段并以严格 JSON 返回，不要输出任何额外文字：\n"
        "{\n" + field_specs + "\n}\n\n"
        "要求：\n"
        "1. 日期统一转成 YYYY-MM-DD 格式：\n"
        "   - 签发日期(passport_issue)常见标注：Date of issue / 签发日期 / Valid from / 有效期开始\n"
        "   - 有效期至(passport_expiry)常见标注：Date of expiry / Expiry date / 有效期至 / 有效期 / Valid until / Bestehen bis\n"
        "2. 看不清或图片中没有该字段时返回空字符串 \"\"\n"
        "3. 只输出 JSON 对象"
    )
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
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"}},
                ],
            }
        ],
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
        return {}


# ============ 统一入口 ============
async def preview_document(content: bytes, filename: str) -> dict:
    """仅生成源文件预览图（不跑 OCR、不做字段提取，极快）。

    用途：网页下载后先显示文件预览，用户点「录入提取」再跑完整 OCR。
    返回: { filename, method, processed_image, text_preview? }
    method: "image" | "pdf_render" | "markitdown_text"
    processed_image: base64 JPEG 预览图（图片/PDF 有值）
    """
    processed_image: str | None = None
    method: str = ""
    text_preview: str | None = None

    # 基于魔数嗅探真实文件类型（扩展名/Content-Type 可能错误，例如下载链接无后缀）
    kind = _sniff_content_kind(content, filename)

    if kind == "image":
        # 图片：仅做预处理（EXIF 旋转 + 裁白边 + 降采样），不 OCR
        _, processed_image = preprocess_image(content)
        method = "image"

    elif kind == "pdf":
        # PDF：先尝试 MarkItDown 提取文字层（原生 PDF 可快速得到文本预览）
        try:
            text = _extract_with_markitdown(content, filename)
        except Exception:
            text = ""
        if text and len(text.strip()) >= 10:
            text_preview = text[:2000]  # 仅返回前 2000 字符预览
            method = "markitdown_text"
        # 同时渲染首页为预览图（无论有无文字层，都给用户一个可视化预览）
        rendered = render_pdf_to_image(content, dpi=150)  # 预览用稍低 DPI 更快
        if rendered is not None:
            _, processed_image = rendered
        if not method:
            method = "pdf_render"
    else:
        # Office 文档：用 MarkItDown 快速取文本预览，无图像
        try:
            text = _extract_with_markitdown(content, filename)
            if text:
                text_preview = text[:2000]
                method = "markitdown_text"
        except Exception:
            pass
        if not method:
            method = "unknown"

    return {
        "filename": filename,
        "method": method,
        "processed_image": processed_image,
        "text_preview": text_preview,
    }


async def extract_document(content: bytes, filename: str, target_fields: list[str] | None = None, engine: str | None = None) -> dict:
    """提取文档文字 + 可选的字段结构化。

    engine: 临时覆盖 OCR 引擎（"umi" 或 "vision"），不传则用 settings.ocr_engine。

    返回: { filename, method, text, fields, processed_image, fallback }
    method: "markitdown" | "vision_ocr" | "umi_ocr" | "pdf_ocr" | "pdf_umi_ocr"
    fallback: None 或 {from, to, reason} 表示引擎回退信息
    processed_image: base64 编码的预处理后图片预览（图片/PDF 有值）
    """
    active_engine = engine or settings.ocr_engine
    processed_image: str | None = None
    text: str = ""
    method: str = ""
    fallback: dict | None = None

    # 基于魔数嗅探真实文件类型（扩展名/Content-Type 可能错误）
    kind = _sniff_content_kind(content, filename)

    if kind == "image":
        # === 图片：预处理（EXIF 旋转 + 裁白边 + 降采样）→ OCR ===
        orig_len = len(content)
        content, processed_image = preprocess_image(content)
        try:
            from PIL import Image as _Img
            with _Img.open(io.BytesIO(content)) as _im:
                _w, _h = _im.size
            print(f"[EXTRACT-DEBUG] image preprocess: {orig_len}B -> {len(content)}B, size={_w}x{_h}, engine={active_engine}")
        except Exception as _e:
            print(f"[EXTRACT-DEBUG] image preprocess: {orig_len}B -> {len(content)}B, dim_read_fail={_e}, engine={active_engine}")
        text, fallback = await ocr_image_bytes(content, engine=engine)
        # 如果发生了回退，method 反映实际使用的引擎
        if fallback and fallback["to"] == "vision_ocr":
            method = "vision_ocr"
        else:
            method = "umi_ocr" if active_engine == "umi" else "vision_ocr"

    elif kind == "pdf":
        # === PDF：先试 MarkItDown 提取文字层（原生数字 PDF 最快） ===
        # === 无文字层（扫描件）→ PyMuPDF 渲染为图片 → 预处理 → OCR ===
        md_error = ""
        try:
            text = _extract_with_markitdown(content, filename)
        except Exception as md_exc:
            text = ""
            md_error = str(md_exc)
        if text and len(text.strip()) >= 10:
            # 文字层有效，直接用
            method = "markitdown"
            print(f"[EXTRACT-DEBUG] PDF 文字层提取成功: {filename}, {len(text)} 字符 (MarkItDown，无需OCR)")
        else:
            # 文字层为空或太短 → 扫描件 → 渲染为图片走 OCR
            print(f"[EXTRACT-DEBUG] PDF 无文字层（{len(text.strip()) if text else 0} 字符），渲染为图片走OCR: {filename}, engine={active_engine}")
            rendered = render_pdf_to_image(content, dpi=200)
            if rendered is None:
                # PyMuPDF 不可用，回退提示
                if not text:
                    raise RuntimeError(
                        "PDF 无文字层且 PyMuPDF 不可用，无法 OCR 扫描件（请安装 PyMuPDF）"
                    )
                method = "markitdown"
            else:
                content, processed_image = rendered
                text, fallback = await ocr_image_bytes(content, engine=engine)
                if fallback and fallback["to"] == "vision_ocr":
                    method = "pdf_ocr"
                else:
                    method = "pdf_umi_ocr" if active_engine == "umi" else "pdf_ocr"
                print(f"[EXTRACT-DEBUG] PDF OCR完成: {filename}, method={method}, {len(text)} 字符"
                      + (f", 回退: {fallback['from']}→{fallback['to']} ({fallback['reason']})" if fallback else ""))
                # 记录 MarkItDown 无文字层的回退
                if not fallback and md_error:
                    fallback = {"from": "markitdown", "to": method, "reason": f"MarkItDown 提取失败：{md_error}"}
                elif not fallback and not (text and len(text.strip()) >= 10):
                    pass  # MarkItDown 返回空文本（扫描件），这是正常回退
    else:
        # === 其他文档（docx/pptx/xlsx/html）→ MarkItDown ===
        try:
            text = _extract_with_markitdown(content, filename)
            method = "markitdown"
        except Exception as md_exc:
            # MarkItDown 失败：尝试用 LibreOffice 转 PDF 再 OCR（如果可用）
            raise RuntimeError(f"文档解析失败（{type(md_exc).__name__}）：{md_exc}。请确保文件格式正确或安装相应的解析库。")
        if not text:
            raise RuntimeError("文档解析未提取到文字")

    fields: dict[str, str] = {}
    mrz_warnings: list[str] = []
    mrz_fields: dict[str, str] = {}

    # 策略：MRZ优先（护照图片）。先尝试MRZ解析，覆盖到的字段直接用MRZ值，
    # 仅对MRZ未覆盖的目标字段才调用LLM字段提取，减少LLM调用次数、提升速度。
    _OCR_METHODS = ("vision_ocr", "pdf_ocr", "umi_ocr", "pdf_umi_ocr")
    # MRZ解析不依赖 target_fields，只要是OCR结果就尝试解析（即使未指定字段也存入fields）
    if method in _OCR_METHODS:
        try:
            mrz_fields = _parse_mrz(text)
        except Exception:
            mrz_fields = {}

    if target_fields:
        # 计算MRZ已覆盖的字段（有值即算覆盖）
        mrz_primary_fields = {"surname", "given_name", "name", "passport_no", "birth_date", "gender", "nationality", "passport_expiry"}
        mrz_covered = {k for k in target_fields if mrz_fields.get(k, "").strip()}

        # MRZ主字段直接填入
        for k in target_fields:
            if k in mrz_primary_fields and mrz_fields.get(k, "").strip():
                fields[k] = mrz_fields[k]

        # MRZ姓名清理：OCR常把MRZ两行之间的噪声粘连到名字中（如 "EKATERINAMBA78036"），
        # 当名字包含数字或异常长且无空格/<分隔时，从VIZ标签关键词重新提取干净姓名
        for name_field, label_list in (
            ("surname", _LABEL_SURNAME),
            ("given_name", _LABEL_GIVEN),
        ):
            if name_field not in target_fields:
                continue
            cur = fields.get(name_field, "")
            looks_noisy = (
                bool(cur) and (
                    any(c.isdigit() for c in cur)
                    or (len(cur) > 10 and " " not in cur and "<" not in cur)
                )
            )
            if looks_noisy:
                upper_text = text.upper()
                clean = _extract_latin_name_after_label(upper_text, label_list)
                if not clean:
                    clean = _extract_after_label(upper_text, label_list)
                if clean and len(clean) < len(cur) and not any(c.isdigit() for c in clean):
                    fields[name_field] = clean
        # 重新拼接 name
        if "name" in target_fields and (fields.get("surname") or fields.get("given_name")):
            fields["name"] = f"{fields.get('surname','')} {fields.get('given_name','')}".strip()

        # 检测到护照MRZ时，对 VIZ 可视区专有字段（签发日期/签发机关/签发地点）
        # 直接看图提取（这些字段不在MRZ里，看图比OCR文字更可靠）
        is_passport = bool(mrz_fields.get("passport_no") or mrz_fields.get("surname"))
        viz_targets = [
            k for k in target_fields
            if k in _VIZ_FIELDS and not mrz_fields.get(k, "").strip()
        ]
        if is_passport and viz_targets and method in _OCR_METHODS:
            viz_fields = await _extract_viz_fields_from_image(content, viz_targets)
            for k, v in viz_fields.items():
                if v.strip():
                    fields[k] = v

        # 仍未覆盖的字段交给文本 LLM 提取
        already_filled = set(k for k in target_fields if fields.get(k, "").strip())
        fields_for_llm = [k for k in target_fields if k not in mrz_covered and k not in already_filled]
        if fields_for_llm:
            llm_fields = await extract_fields_from_text(text, fields_for_llm)
            for k, v in llm_fields.items():
                if v.strip():
                    fields[k] = v

        # 本地正则/关键词兜底：对 MRZ/VIZ/LLM 都没提取到的字段，
        # 用多语言标签关键词从 OCR 文本中直接提取，不依赖任何 API。
        # 这保证了即使没有 Vision API key，UMI-OCR 也能提取护照字段。
        still_empty = [k for k in target_fields if not fields.get(k, "").strip()]
        if still_empty:
            local_fields = _extract_local_fields(text, still_empty)
            for k, v in local_fields.items():
                if v.strip() and not fields.get(k, "").strip():
                    fields[k] = v

        # 正则回退：对日期类字段（有效期至/签发日期），如果 MRZ/VIZ/LLM 都没提取到，
        # 直接从 OCR 文本中按关键词搜索日期，不依赖 LLM
        for k in target_fields:
            if fields.get(k, "").strip():
                continue
            if k == "passport_expiry":
                date_val = _extract_expiry_from_text(text)
                if date_val:
                    fields[k] = date_val
            elif k == "passport_issue":
                date_val = _extract_issue_from_text(text)
                if date_val:
                    fields[k] = date_val

        # 互补推断：签发日/有效期只提到一个时，从全文日期中排除法推断另一个
        # （护照可视区通常两个日期紧挨印刷，OCR 全文里都有，只是关键词定位可能漏一个）
        if "passport_issue" in target_fields or "passport_expiry" in target_fields:
            cur_issue = fields.get("passport_issue", "").strip()
            cur_expiry = fields.get("passport_expiry", "").strip()
            if not (cur_issue and cur_expiry):
                new_issue, new_expiry = _infer_missing_date_pair(
                    text, cur_issue, cur_expiry,
                    birth_date=fields.get("birth_date", "").strip(),
                )
                if "passport_issue" in target_fields and not cur_issue and new_issue:
                    fields["passport_issue"] = new_issue
                if "passport_expiry" in target_fields and not cur_expiry and new_expiry:
                    fields["passport_expiry"] = new_expiry

        # MRZ非主字段（如passport_expiry等扩展字段）补充
        for k, v in mrz_fields.items():
            if v.strip() and not fields.get(k, "").strip():
                fields[k] = v

    elif not target_fields and method in _OCR_METHODS:
        # 没指定target_fields时：MRZ + 本地关键词提取都尝试，存入fields供参考
        for k, v in mrz_fields.items():
            if v.strip():
                fields[k] = v
        # 对常见护照字段也做本地关键词提取（MRZ没覆盖到的字段）
        common_fields = ["surname", "given_name", "name", "passport_no",
                         "birth_date", "gender", "nationality",
                         "passport_issue", "passport_expiry",
                         "issue_authority", "issue_place"]
        still_empty = [k for k in common_fields if not fields.get(k, "").strip()]
        if still_empty:
            local_fields = _extract_local_fields(text, still_empty)
            for k, v in local_fields.items():
                if v.strip() and not fields.get(k, "").strip():
                    fields[k] = v

    return {
        "filename": filename,
        "method": method,
        "text": text,
        "fields": fields,
        "mrz_warnings": mrz_warnings,
        "processed_image": processed_image,
        "fallback": fallback,
    }
