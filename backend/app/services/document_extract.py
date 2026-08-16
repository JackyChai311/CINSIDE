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
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import threading
import time
from collections import OrderedDict
from pathlib import Path

import httpx

from ..config import settings, _USER_DATA_DIR

# HEIC/HEIF（iPhone 拍摄照片）解码支持：注册到 PIL（未安装 pillow-heif 时静默跳过，
# 遇到 HEIC 文件会在 preprocess_image 给出明确错误提示）
try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:
    pass


# 提取/转正日志落盘：终端输出刷太快或用户自启进程拿不到 stdout 时，
# 事后仍能从日志文件排查（转正为什么没生效、耗时在哪一段）
_LOG_MAX_BYTES = 2 * 1024 * 1024  # 超过 2MB 自动清空重写，防无限膨胀


def _flog(msg: str) -> None:
    try:
        p = _USER_DATA_DIR / "extract.log"
        if p.exists() and p.stat().st_size > _LOG_MAX_BYTES:
            p.unlink()
        with p.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except Exception:
        pass  # 日志失败绝不影响主流程

# 容忍截断的图片文件（网页下载不完整时 Chromium 能显示但 PIL 默认拒解）
from PIL import ImageFile as _ImageFile
from PIL import Image as _PILImage

_ImageFile.LOAD_TRUNCATED_IMAGES = True

# 放宽超大图片限制：网页下载的高分辨率 PNG（证件扫描/高清图）常超过 PIL 默认
# 上限（约 1.79 亿像素），否则解码会抛 DecompressionBombError → 被误判为"PNG 解码失败"。
# 设一个足够大的上限（10 亿像素），preprocess 后续会降采样，避免真正的大图被误拒。
_PILImage.MAX_IMAGE_PIXELS = 1_000_000_000

# 支持的图片扩展名（走 Vision OCR + 预处理）
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".heic", ".heif", ".avif"}
# PDF 扩展名（走 PyMuPDF 渲染 → 预处理 → Vision OCR）
PDF_EXTS = {".pdf"}
# 其余交给 MarkItDown（docx/pptx/xlsx/html/txt/md/csv...）

# 预处理参数
_WHITE_THRESH = 245      # 灰度 > 该值视为白边背景
_BBOX_DETECT_MAX = 512   # bbox 检测缩略图最长边（小图检测极快）
_MAX_OUTPUT_EDGE = 2560  # 输出图最长边上限（防止上传过大）
_DRAFT_EDGE = 4096       # 解码前降采样目标最长边：超大图（常见高清 PNG 扫描件）先缩到该边再解码
_MIN_KEEP_MARGIN = 16    # 裁剪时四周至少保留 16px 边距，避免贴边误裁（保护边缘首字符）
_BORDER_DIFF_THRESH = 20  # 边缘主色检测：与背景色差值 > 该值视为内容（调低以保护浅色印刷字符不被裁掉）
_API_MAX_B64_LEN = 9_000_000  # Vision API 上传保护：base64 字符数上限（≈6.7MB 二进制）
_VISION_OCR_MAX_EDGE = 1792  # Vision 投喂图最长边上限（CamScanner harness：压缩提速，MRZ 字符仍 15~30px 高足够清晰）
_VISION_OCR_JPEG_Q = 85      # Vision 投喂 JPEG 质量（85 对 OCR 无损，体积比 92 小很多）
_UMI_OCR_MAX_EDGE = 1600     # UMI 投喂图最长边上限（Paddle det 内部仅 ~960px 输入，1600px 时 MRZ 字符仍有 ~25-35px 高，识别无损）

# 小字文档放大重试（OCR 前增强）：
# Vision 首次识别结果过短（很可能是字太小/内容占比小导致识别不清）时，
# 把图片放大后重试一次，取更完整的结果。对分块式视觉编码器可显著提升小字识别率。
_ZOOM_RETRY_MIN_CHARS = 40        # 首次识别文本少于该字符数 → 触发放大重试
_ZOOM_SCALE = 1.6                 # 放大倍数（LANCZOS，最高放大到像素预算以内）
_ZOOM_PIXEL_BUDGET = 16_000_000   # 放大后像素上限（≈4096×4096），防止 base64 超限


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


def _crop_content_margin(img):
    """CamScanner 式裁边：去掉四周空白区域，只保留主要内容。

    双保险检测：白底用灰度阈值；白阈值失效（灰底扫描件/深色桌面拍摄）回退
    边缘主色检测。检出区域过小（<4%，噪点/阴影误检）则放弃裁剪。
    大图先缩到 512px 小图检测 bbox 再按比例还原，避免全图 point() 慢。
    失败/无内容可裁时原样返回。
    """
    try:
        from PIL import Image
        w, h = img.size

        if w > _BBOX_DETECT_MAX or h > _BBOX_DETECT_MAX:
            scale = _BBOX_DETECT_MAX / max(w, h)
            small = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        else:
            small = img
            scale = 1.0

        gray = small.convert("L")
        # 阈值 _WHITE_THRESH：接近白色视为背景；非白即内容
        bbox = gray.point(lambda x: 0 if x > _WHITE_THRESH else 255).getbbox()

        # 白边检测失效（几乎整图都是"内容"，说明背景非白色）→ 边缘主色检测
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
        return img
    except Exception:
        return img


def preprocess_image(content: bytes) -> tuple[bytes, str | None]:
    """对图片做预处理：EXIF 自动旋转到正面 + 裁剪白边 + 限制最大尺寸。

    返回: (处理后的 JPEG bytes, base64 预览或 None)
    解码失败时抛出 RuntimeError（明确原因），不再原样透传给 API（会被拒收 400）。
    """
    try:
        from PIL import Image, ImageOps

        img = Image.open(io.BytesIO(content))
        # 超大图（如高清 PNG 扫描件）先按目标边降采样再解码：
        # 避免整幅全尺寸解码导致的慢/内存峰值（LOOP 超时多因此）。draft 只解码所需尺寸。
        try:
            w0, h0 = img.size
            if max(w0, h0) > _DRAFT_EDGE:
                img.draft("RGB", (_DRAFT_EDGE, _DRAFT_EDGE))
        except Exception:
            pass
        img.load()  # 立即解码，尽早暴露截断/损坏问题（LOAD_TRUNCATED_IMAGES 已容忍部分截断）

        # 1. EXIF 自动旋转到正面（手机拍摄的照片方向纠正）
        img = ImageOps.exif_transpose(img)

        # 2. 转 RGB（去除 alpha 通道 / 调色板，方便后续处理）
        if img.mode != "RGB":
            img = img.convert("RGB")

        w, h = img.size

        # 3. CamScanner 式裁边：白阈值 + 边缘主色双保险，去掉四周空白
        img = _crop_content_margin(img)

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
        # 解码失败：给出明确原因（HEIC 缺解码器 / 文件损坏 / 格式不支持 / 超大图），
        # 不再把原始字节透传给 Vision API（无法解码会被拒收：400 invalid image base64 content）
        head = content[:16].hex() if content else "(empty)"
        print(f"[preprocess] 图片解码失败: {e} | size={len(content)} | head16={head}", flush=True)
        if isinstance(e, _PILImage.DecompressionBombError):
            raise RuntimeError(
                f"图片像素过大无法解码（{e}）。请改用较小尺寸的 PNG/JPG 再提取"
            ) from e
        if _looks_like_heic(content):
            raise RuntimeError(
                "HEIC/HEIF 图片解码失败：请安装 pillow-heif（pip install pillow-heif），"
                "或先把照片转成 JPG/PNG 再提取"
            ) from e
        raise RuntimeError(
            f"图片无法解码（文件可能已损坏或格式不受支持，字节头 {head}）: {e}"
        ) from e


# ============ AI 自动转正 + 小图放大（OCR 前增强） ============
# 场景：用户上传的 PDF/图片常是横放/倒置且内容占比小（如 A4 页中嵌一小张证件）。
# 本地投影法粗判文字横竖 → 需精确角度时调 Vision 判断（0/90/180/270）→ PIL 转正；
# 内容图最长边不足 _MIN_OCR_EDGE 时上采样放大，让 OCR 能识别小字。
_MIN_OCR_EDGE = 1600     # 内容图最长边下限：低于则上采样放大，提升小字 OCR 识别率
_MAX_UPSCALE = 3.0       # 放大倍数上限（避免过度插值产生伪影）
_ORIENT_CACHE_MAX = 1000  # 朝向缓存上限（内存与落盘同限；按原始文件 hash，同文件预览/提取只检测一次）
_orientation_cache: dict[str, int] = {}
# 同文件 Vision 朝向检测 in-flight 去重：预览与正式提取并行发出时，只调一次 Vision，
# 后到的一方 await 同一个 Future 拿结果（否则同一张图会并发调两次识图 AI）
_orientation_inflight: dict[str, asyncio.Future] = {}

# Vision 朝向结果落盘（重启不丢）：后端重启后内存缓存清零，GEAR 4（转正开）每轮对
# 同一批文件重新调 Vision（2~10s/张，API 抖动时超时重试可达 60~120s）——
# 「GEAR 4 裁剪预览等半天」的元凶。转正角度对同一文件永远相同，属稳定判定，
# 固化复用与「粗判猜测值不固化」约束不冲突（这里只存 Vision 精判结果）。
_ORIENT_CACHE_FILE = _USER_DATA_DIR / "orient_cache.json"


def _orient_cache_load() -> dict[str, int]:
    try:
        if _ORIENT_CACHE_FILE.exists():
            data = json.loads(_ORIENT_CACHE_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {str(k): int(v) for k, v in data.items() if str(v) in ("0", "90", "180", "270")}
    except Exception:
        pass
    return {}


def _orient_cache_save() -> None:
    try:
        items = list(_orientation_cache.items())
        if len(items) > _ORIENT_CACHE_MAX:
            items = items[-_ORIENT_CACHE_MAX:]
        _ORIENT_CACHE_FILE.write_text(
            json.dumps(dict(items), ensure_ascii=False), encoding="utf-8"
        )
    except Exception:
        pass  # 落盘失败不影响主流程


_orientation_cache.update(_orient_cache_load())


def _text_row_variance(img) -> float:
    """水平文本行结构评分：二值化后逐行黑像素数的方差。
    文字水平排列时，有字行/行间隙交替 → 方差大；文字竖排（图横放）时方差小。"""
    gray = img.convert("L")
    w, h = gray.size
    if w < 32 or h < 32:
        return 0.0
    data = gray.tobytes()
    thr = sum(data) / len(data)
    bw = gray.point(lambda x: 0 if x < thr else 255)
    bdata = bw.tobytes()
    row_dark = [bdata[y * w:(y + 1) * w].count(0) for y in range(h)]
    n = len(row_dark)
    mean = sum(row_dark) / n
    return sum((c - mean) ** 2 for c in row_dark) / n


def _local_orientation_guess(img) -> tuple[str, bool]:
    """本地投影法判断文字横竖。返回 ("horizontal" | "vertical" | "unknown", 是否高置信)。
    局限：无法区分 0°/180°、90°/270°（投影结构相同），精确角度需 Vision。"""
    try:
        from PIL import Image
        small = img.copy()
        small.thumbnail((384, 384), Image.LANCZOS)
        s0 = _text_row_variance(small)
        s90 = _text_row_variance(small.transpose(Image.ROTATE_90))
        lo, hi = min(s0, s90), max(s0, s90)
        if hi < 1.0:  # 几乎无内容（空白图）
            return ("unknown", False)
        ratio = hi / (lo + 1e-6)
        if ratio < 1.25:
            return ("unknown", False)
        return (("horizontal" if s0 >= s90 else "vertical"), ratio >= 1.6)
    except Exception:
        return ("unknown", False)


async def _vision_detect_rotation(img) -> int:
    """调 Vision 判断文字朝向，返回需【顺时针】旋转的角度（0/90/180/270）。失败返回 0。"""
    try:
        from PIL import Image
        small = img.copy()
        small.thumbnail((640, 640), Image.LANCZOS)
        buf = io.BytesIO()
        small.save(buf, format="JPEG", quality=80)
        b64 = base64.b64encode(buf.getvalue()).decode()
        prompt = (
            "判断这张图片中文字内容的朝向。请回答：需要将图片顺时针旋转多少度"
            "（只能是 0、90、180、270 之一），文字才能变成正常的水平阅读方向？\n"
            "只返回 JSON：{\"rotate\": 角度数字}，不要输出任何其他内容。"
            "图中无文字或无法判断时返回 {\"rotate\": 0}。"
        )
        text = await _call_vision_ocr(b64, prompt)
        m = re.search(r'"?rotate"?\s*[:：]\s*(\d+)', text)
        angle = int(m.group(1)) if m else -1
        if angle not in (0, 90, 180, 270):
            m2 = re.search(r"\b(0|90|180|270)\b", text)
            angle = int(m2.group(1)) if m2 else 0
        print(f"[ORIENT] Vision 朝向检测: rotate={angle} (raw={text[:80]!r})")
        return angle
    except Exception as e:
        print(f"[ORIENT] Vision 朝向检测失败（保持原方向）: {e}")
        return 0


async def _vision_detect_rotation_shared(img, cache_key: str | None) -> int:
    """Vision 朝向检测（同文件并发去重）。

    预览与正式提取并行到达且缓存都未命中时，第一个请求发起检测并登记 Future，
    后到的直接 await 同一 Future——整张图只调一次识图 AI，双方拿到同一个角度。
    """
    if not cache_key:
        return await _vision_detect_rotation(img)
    fut = _orientation_inflight.get(cache_key)
    if fut is not None:
        return await fut
    loop = asyncio.get_running_loop()
    fut = loop.create_future()
    _orientation_inflight[cache_key] = fut
    try:
        angle = await _vision_detect_rotation(img)
        if not fut.done():
            fut.set_result(angle)
        return angle
    except BaseException as e:
        # 发起方失败/被取消也要唤醒等待方（否则等待方永久挂起）
        if not fut.done():
            fut.set_exception(e)
        raise
    finally:
        _orientation_inflight.pop(cache_key, None)


async def ai_orient_and_enhance(content: bytes, cache_key: str | None = None, allow_vision: bool = True) -> tuple[bytes, str | None]:
    """AI 自动转正（文字朝向检测）+ 小图放大，让 OCR 更好识别。

    流程：本地投影法粗判横竖 → 非明确水平时调 Vision 精确判断（0/90/180/270）→ PIL 转正
    → 内容图最长边 < _MIN_OCR_EDGE 时上采样放大（≤3x），便于 OCR 识别小字。

    cache_key: 原始文件 hash，朝向结果按文件缓存（同文件的预览/正式提取只检测一次）。
    allow_vision: False 时不调 Vision，只做本地粗判且不写缓存。
    预览与正式提取默认都传 True：预览先到则发起检测并写缓存，正式提取命中缓存零等待；
    两者并行时通过 in-flight Future 共享同一次调用——总耗时与只有一方检测相同。
    返回 (处理后 JPEG bytes, base64 预览)；处理失败返回 (原 content, None)。

    注意：解码/旋转/放大/编码等 CPU 重活都放线程池执行，避免阻塞事件循环
    （否则并发请求——如 Excel 解析——会被卡到超时）。
    """
    try:
        img, (orientation, confident) = await asyncio.to_thread(_orient_decode_and_guess, content)

        # 1. 朝向检测（带文件级缓存：预览与正式提取复用同一次判断结果）
        # 日志升级：本地粗判结果/缓存命中/每条决策路径全部落终端 + extract.log，
        # 否则"图片没转正"无从排查（比如粗判误报 horizontal 静默跳过）
        rotated = 0
        # 缓存读取守卫：与写入守卫对称——只有「AI 自动转正」开着时才允许命中缓存。
        # 否则跨档串档：第2档（转正开）跑完缓存了 Vision 的 rotate=90，换第3/5档
        # （转正关）重跑同文件 → 命中旧缓存照样转 90°，关掉的开关形同虚设。
        if cache_key and settings.vision_auto_orient and allow_vision and cache_key in _orientation_cache:
            rotated = _orientation_cache[cache_key]
            _flog(f"[ORIENT] 命中缓存 cache={cache_key} → rotate={rotated}")
        else:
            # 朝向是否调 Vision 只由「AI 自动转正」开关决定（开关是唯一权威）：
            # 高速模式开启时前端会自动把开关关掉提速；用户手动重新打开 = 明确要转正，必须照办
            if not settings.vision_auto_orient or not allow_vision:
                # 开关关闭（或预览模式）时：跳过 Vision 朝向检测（省 2~10 秒/张）。
                # 本地投影法仍做粗判：明确竖排时按惯例转 90°，其余保持原方向。
                if orientation == "vertical" and confident:
                    rotated = 90
                _flog(
                    f"[ORIENT] {'预览模式' if not allow_vision else 'AI转正已关闭'}: "
                    f"本地粗判={orientation} 高置信={confident} → rotated={rotated}（不调Vision）"
                )
            elif settings.vision_api_key and settings.vision_api_base:
                # 开关开 → 一律 Vision 精判 0/90/180/270。粗判 horizontal 也必须调：
                # 投影法分不出 180° 倒置（倒置后文字行仍水平），低置信 horizontal 连
                # "行是横的"都不确定。之前对 coarse=horizontal 跳过 Vision 正是
                # 「开着转正却不转」的元凶（第1/2/4档全部受害）。
                _t = time.perf_counter()
                rotated = await _vision_detect_rotation_shared(img, cache_key)
                _flog(f"[ORIENT] AI转正开启: 粗判={orientation} 高置信={confident} → Vision 精判 rotate={rotated}（耗时 {time.perf_counter() - _t:.1f}s）")
            elif orientation == "vertical" and confident:
                # 开关开但未配置 Vision API：本地只能确定"文字竖着"，按扫描件常见朝向顺时针转 90°
                rotated = 90
                _flog("[ORIENT] 无Vision配置：粗判竖排，默认顺时针转 90°")
            else:
                _flog(f"[ORIENT] 粗判={orientation} 且无Vision配置 → 保持原方向 rotated=0")
            # 缓存写入守卫：只固化 Vision 精判结果（开关开 + 已配置 Vision API + 正式提取）。
            # 开关关闭/未配置 Vision 时的本地粗判（如 vertical→90 是猜测，Vision 可能判 0）绝不写缓存——
            # 否则用户重新打开转正（或补配 API）后，同文件命中脏缓存永远不再精判。
            # 预览模式（allow_vision=False）同样不写：粗判结果不固化，正式提取时仍走 Vision 精判。
            if cache_key and allow_vision and settings.vision_auto_orient and settings.vision_api_key and settings.vision_api_base:
                while len(_orientation_cache) >= _ORIENT_CACHE_MAX:
                    _orientation_cache.pop(next(iter(_orientation_cache)))
                _orientation_cache[cache_key] = rotated
                _orient_cache_save()

        return await asyncio.to_thread(_orient_apply, img, rotated)
    except Exception as e:
        print(f"[ORIENT] 转正/放大失败（使用原图）: {e}")
        return content, None


def _orient_decode_and_guess(content: bytes) -> tuple:
    """解码图片 + 本地投影法粗判文字横竖（同步重活，在线程池中执行）。"""
    from PIL import Image
    img = Image.open(io.BytesIO(content)).convert("RGB")
    return img, _local_orientation_guess(img)


def _orient_apply(img, rotated: int) -> tuple[bytes, str | None]:
    """按朝向转正 + 小图放大 + JPEG 编码（同步重活，在线程池中执行）。"""
    from PIL import Image
    if rotated:
        img = img.rotate(-rotated, expand=True)  # PIL rotate 为逆时针，取负即顺时针
        print(f"[ORIENT] 已按文字朝向转正：顺时针 {rotated}°，尺寸 {img.size[0]}x{img.size[1]}")

    # 小图放大：最长边不足 _MIN_OCR_EDGE → 上采样（OCR 对过小字识别率差）
    w, h = img.size
    if 0 < max(w, h) < _MIN_OCR_EDGE:
        ratio = min(_MIN_OCR_EDGE / max(w, h), _MAX_UPSCALE)
        if ratio > 1.05:
            new_size = (int(w * ratio), int(h * ratio))
            img = img.resize(new_size, Image.LANCZOS)
            print(f"[ORIENT] 内容图偏小，已放大 {ratio:.1f}x：{w}x{h} → {new_size[0]}x{new_size[1]}（便于 OCR 识别）")

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    out = buf.getvalue()
    return out, base64.b64encode(out).decode()


# ============ PDF 预处理：渲染为高 DPI 图片 → 旋转 + 裁白边 ============
def render_pdf_to_image(content: bytes, dpi: int = 200, max_pages: int = 0) -> tuple[bytes, str] | None:
    """用 PyMuPDF 把 PDF 渲染为图片，多页竖向拼接成一张长图。

    返回: (JPEG bytes, base64 预览) 或 None（PyMuPDF 不可用或渲染失败）
    dpi: 渲染分辨率，200 DPI 对扫描件足够清晰
    max_pages: 最多渲染几页（0=全部；预览只传 1 渲染首页，速度大幅提升）
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
        from PIL import Image as _PILImage
        for idx, page in enumerate(doc):
            if max_pages > 0 and idx >= max_pages:
                break
            # alpha=False 生成 RGB（白底），避免透明背景
            pix = page.get_pixmap(matrix=mat, alpha=False)
            # 直接从 pixmap 原始像素构建 PIL 图：跳过 PNG 编码→解码往返（每页快数倍）
            page_img = _PILImage.frombytes(
                "RGB", (pix.width, pix.height), pix.samples, "raw", "RGB", pix.stride, 1
            )
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

        # CamScanner 式裁边（白阈值 + 边缘主色双保险）：扫描 PDF 常带大片白边/灰底纸边，
        # 裁掉后 Vision/OCR 处理的都是有效内容，识别更快更准
        combined = _crop_content_margin(combined)

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


def _extract_pdf_text_pymupdf(content: bytes) -> str:
    """用 PyMuPDF 直接提取 PDF 文字层（比 MarkItDown/pdfminer 快数倍）。

    用于 PDF 文字层快速检测：原生数字 PDF 毫秒级出文本；扫描件无文字层时
    也几乎瞬间返回空串，不会像 pdfminer 那样在扫描件上空跑十几秒。
    PyMuPDF 不可用或解析失败返回空串（调用方回退 MarkItDown）。
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return ""
    try:
        doc = fitz.open(stream=content, filetype="pdf")
        parts = [page.get_text("text") for page in doc]
        doc.close()
        return "\n".join(parts).strip()
    except Exception:
        return ""


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


def _shrink_for_vision_ocr(content: bytes) -> bytes:
    """Vision 投喂前的 CamScanner 式 harness：再裁边 → 最长边 1792px → JPEG q85。

    Vision 模型响应时间随图像尺寸/体积显著上涨，1792px 对证件文字/MRZ 足够
    （MRZ 字符仍 15~30px 高）。已有图无需变更时原样返回（避免多余重编码损失）。
    失败返回原内容。
    """
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(content)).convert("RGB")
        orig_w, orig_h = img.size
        orig_bytes = len(content)

        # 1. CamScanner 式裁边（预览/预处理已裁过一次，这里兜底：经转正放大的图可能又带边）
        cropped = _crop_content_margin(img)
        changed = cropped.size != img.size
        img = cropped

        # 2. 最长边压到 _VISION_OCR_MAX_EDGE
        w, h = img.size
        if max(w, h) > _VISION_OCR_MAX_EDGE:
            ratio = _VISION_OCR_MAX_EDGE / max(w, h)
            img = img.resize((max(1, int(w * ratio)), max(1, int(h * ratio))), Image.LANCZOS)
            changed = True

        if not changed:
            return content

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=_VISION_OCR_JPEG_Q)
        out = buf.getvalue()
        if len(out) >= len(content):
            return content
        print(f"[VISION-HARNESS] 投喂前压缩：{orig_w}x{orig_h} {orig_bytes}B → {img.size[0]}x{img.size[1]} {len(out)}B（裁边+压尺寸）", flush=True)
        return out
    except Exception:
        return content


def _shrink_for_umi_ocr(content: bytes) -> bytes:
    """UMI 投喂前的 CamScanner 式 harness：再裁边 → 最长边 1600px。

    Paddle det 模型内部输入仅 ~960px，投喂 2560px 大图只会让 UMI 内部
    resize + det/cls/rec 全链路变慢（CPU 上可到数十秒，顶爆 60s 超时
    → 触发 Vision 保底回退反而更慢）。1600px 时护照 MRZ 字符仍有
    ~25-35px 高，识别率无损。无需变更时原样返回。失败返回原内容。
    """
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(content)).convert("RGB")
        orig_w, orig_h = img.size
        orig_bytes = len(content)

        cropped = _crop_content_margin(img)
        changed = cropped.size != img.size
        img = cropped

        w, h = img.size
        if max(w, h) > _UMI_OCR_MAX_EDGE:
            ratio = _UMI_OCR_MAX_EDGE / max(w, h)
            img = img.resize((max(1, int(w * ratio)), max(1, int(h * ratio))), Image.LANCZOS)
            changed = True

        if not changed:
            return content

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=88)
        out = buf.getvalue()
        if len(out) >= len(content):
            return content
        print(f"[UMI-HARNESS] 投喂前压缩：{orig_w}x{orig_h} {orig_bytes}B → {img.size[0]}x{img.size[1]} {len(out)}B（裁边+压尺寸，Paddle处理更快）", flush=True)
        return out
    except Exception:
        return content


def _crop_by_ocr_boxes(content: bytes, boxes: list, ocr_size: tuple[int, int]) -> bytes:
    """按 OCR 文本框联合区域裁图（CamScanner 内容定位的最可靠方式）。

    边缘/阈值裁边对灰底扫描件、渐变阴影背景会失效（整图被判为内容），
    而文本框坐标就是"内容在哪"的地面真相。裁出的文本区域用于：
    ① VIZ 看图（小图 Vision 响应快数倍且更准）；② 预览显示。

    boxes 为 UMI 返回的投喂图坐标系文本框；先按比例还原到 content
    原坐标再裁。裁掉面积不足 8% 或任何失败时原样返回。
    """
    try:
        if not boxes or not ocr_size or ocr_size[0] <= 0 or ocr_size[1] <= 0:
            return content
        from PIL import Image
        img = Image.open(io.BytesIO(content)).convert("RGB")
        fw, fh = img.size
        sx, sy = fw / ocr_size[0], fh / ocr_size[1]

        xs: list[float] = []
        ys: list[float] = []
        for b in boxes:
            if not isinstance(b, (list, tuple)) or not b:
                continue
            # 兼容两种格式：[[x,y],[x,y],[x,y],[x,y]] 或 [x1,y1,x2,y2,...]
            pts = b if isinstance(b[0], (list, tuple)) else [b[i:i + 2] for i in range(0, len(b), 2)]
            for p in pts:
                if len(p) >= 2:
                    xs.append(float(p[0]) * sx)
                    ys.append(float(p[1]) * sy)
        if not xs:
            return content

        m = max(24, int(max(fw, fh) * 0.02))  # 四周留 2% 边距，保护贴边首字符
        left = max(0, int(min(xs)) - m)
        upper = max(0, int(min(ys)) - m)
        right = min(fw, int(max(xs)) + m)
        lower = min(fh, int(max(ys)) + m)
        # 裁掉不足 8% 面积时无意义，跳过
        if (right - left) * (lower - upper) > 0.92 * fw * fh:
            return content

        img = img.crop((left, upper, right, lower))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)
        out = buf.getvalue()
        print(f"[BOX-CROP] 按OCR文本框裁切：{fw}x{fh} → {img.size[0]}x{img.size[1]}（{len(boxes)}个文本框，去除空白背景）", flush=True)
        return out
    except Exception:
        return content


def _zoom_image_for_ocr(content: bytes) -> bytes:
    """小字增强：按比例放大图片（LANCZOS）并重编码为 JPEG。
    放大目标受 _ZOOM_PIXEL_BUDGET 约束（避免 base64 超限）；无法放大或失败返回原内容。"""
    try:
        from PIL import Image as _ZImg
        img = _ZImg.open(io.BytesIO(content)).convert("RGB")
        w, h = img.size
        # 放大倍数 = min(目标倍数, 像素预算允许的倍数)；≤1 说明原图已大到无法再放大
        budget_factor = (_ZOOM_PIXEL_BUDGET / (w * h)) ** 0.5 if w * h > 0 else 1.0
        scale = min(_ZOOM_SCALE, budget_factor)
        if scale <= 1.0:
            return content
        nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
        if (nw, nh) == (w, h):
            return content
        img = img.resize((nw, nh), _ZImg.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=92)
        out = buf.getvalue()
        # 兜底：重编码后仍超 base64 上限则放弃放大
        if len(base64.b64encode(out)) > _API_MAX_B64_LEN:
            return content
        print(f"[OCR] 小字增强：放大 {scale:.2f}x：{w}x{h} → {nw}x{nh}（{len(content)}B → {len(out)}B）")
        return out
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
        async with httpx.AsyncClient(timeout=240.0, trust_env=False) as client:
            resp = await client.post(url, headers=headers, json=payload)
    except httpx.TimeoutException as e:
        raise RuntimeError(f"Vision API 请求超时（240秒），请检查网络或稍后重试: {e}") from e
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


# ============ UMI-OCR 假死自愈机制 ============
# 症状：Umi-OCR.exe 进程在、端口 1224 也在 LISTENING，但 TCP 连接超时不 accept
# （长时间高强度 OCR 后偶发，进程内存掉到几十 MB 的僵尸态）。
# 自愈链路：健康检查失败 + 进程存在 → 强杀假死进程 → 重置启动标志 → 自动重新拉起。
# 自愈冷却：60s 内最多自愈一次，防止瞬时网络抖动触发连环重启。

def _find_umi_ocr_pids() -> list[int]:
    """查所有 Umi-OCR.exe 进程 PID（tasklist CSV 解析）。"""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq Umi-OCR.exe", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=5,
        ).stdout
    except Exception:
        return []
    pids: list[int] = []
    for line in out.splitlines():
        # CSV 行形如: "Umi-OCR.exe","35020","Console","1","27,720 K"
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower().startswith("umi-ocr"):
            try:
                pids.append(int(parts[1]))
            except ValueError:
                pass
    return pids


def _kill_hung_umi_ocr() -> bool:
    """强杀假死的 UMI-OCR 进程（进程在但 HTTP 不响应时调用）。

    杀掉后重置自动启动标志，让 _try_launch_umi_ocr 能重新拉起。
    返回是否杀到了进程（没杀到 = 本来就没在跑，不是假死）。
    """
    global _umi_ocr_launch_attempted, _umi_ocr_process
    pids = _find_umi_ocr_pids()
    if not pids:
        return False
    killed = False
    for pid in pids:
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=10)
            killed = True
            print(f"[OCR] 自愈：强杀假死 Umi-OCR 进程 PID={pid}", flush=True)
            _flog(f"[OCR] 自愈：强杀假死 Umi-OCR 进程 PID={pid}")
        except Exception as e:
            print(f"[OCR] 自愈：强杀 PID={pid} 失败: {e}", flush=True)
    if killed:
        _umi_ocr_launch_attempted = False  # 解锁，允许重新自动启动
        _umi_ocr_process = None
        time.sleep(1.5)  # 等端口释放
    return killed


# 自愈冷却时间戳（monotonic）：60s 内不重复自愈
_umi_heal_at: float = -1e9


def _auto_heal_umi_ocr() -> None:
    """同步自愈入口（供 executor / 直接调用）：杀假死进程并重新拉起。

    带冷却：60s 内最多执行一次，防止健康检查抖动引发连环重启。
    """
    global _umi_heal_at
    now = time.monotonic()
    if now - _umi_heal_at < 60.0:
        return
    _umi_heal_at = now
    try:
        if _kill_hung_umi_ocr():
            print("[OCR] 自愈：假死进程已清除，重新拉起 UMI-OCR...", flush=True)
            _flog("[OCR] 自愈：假死进程已清除，重新拉起 UMI-OCR")
            _try_launch_umi_ocr()
    except Exception as e:
        print(f"[OCR] 自愈流程异常: {e}", flush=True)


def _mark_umi_offline() -> None:
    """真实请求连接失败时失效在线缓存（避免 30s 内继续往假死端口投喂）。"""
    global _umi_alive_at, _umi_alive_val
    _umi_alive_at = time.monotonic()
    _umi_alive_val = False


# ============ OCR 结果 LRU 缓存 ============
# key = sha1(缩放后的投喂字节)。预览裁切与正式提取、重跑/换挡前的重复识别
# 都命中同一 key，省一次全图 OCR（内置引擎 2~5s、UMI 更慢）。
# 字节哈希做 key 无失效问题；LRU 上限 64 张（文本+框坐标约几百 KB 量级）。
# 条目第 4 位记录产出该结果的引擎（gpu/umi）——命中时如实还原，GPU 兜底成
# UMI 的缓存结果仍标 umi。
_OCR_CACHE_MAX = 64
_ocr_cache: OrderedDict[str, tuple[str, list, tuple[int, int], str]] = OrderedDict()
_ocr_cache_lock = threading.Lock()

# 最近一次 umi 通道识别实际使用的引擎："gpu"（内置加速引擎）| "umi"（UMI-OCR HTTP）。
# 提取完成后由 extract_document 捕获进响应（前端显示 GPU/UMI 用）。
_last_ocr_backend: str = ""


def _ocr_cache_put(key: str, text: str, boxes: list, ocr_size: tuple[int, int], backend: str) -> None:
    with _ocr_cache_lock:
        _ocr_cache[key] = (text, boxes, ocr_size, backend)
        _ocr_cache.move_to_end(key)
        while len(_ocr_cache) > _OCR_CACHE_MAX:
            _ocr_cache.popitem(last=False)


# 进行中的识别（in-flight 去重）：key 与 LRU 相同，value 为结果 Future。
# 预览裁切与正式提取对同一张图并发首发时（LOOP 开始的标准场景），两个请求
# 各跑一遍全图 OCR 且在推理锁/UMI 单任务上排队——等待时间直接翻倍。
# 后到者 await 同一个 Future，整图只识别一次。
_ocr_inflight: "dict[str, asyncio.Future]" = {}
# UMI 在线状态节流缓存（_check_umi_ocr_alive 用，30s TTL）
_umi_alive_at: float | None = None
_umi_alive_val: bool = True


async def _call_umi_ocr(content: bytes, want_boxes: bool = False):
    """调用本地 UMI-OCR 的 HTTP 接口识别图片，返回全部文字。

    UMI-OCR 需先在软件内开启「HTTP接口服务」（默认监听 127.0.0.1:1224），
    接口：POST /api/ocr，body {"base64": "<图片base64>"}，
    响应：{"code":100,"data":[{"text":...,"box":[...],"score":...},...]}。

    注意：投喂前经 _shrink_for_umi_ocr 处理（再裁边 + 最长边 1600px 上限）——
    2560px 大图在 Paddle CPU 上可跑数十秒顶爆超时；1600px 时 MRZ 字符
    仍有 ~25-35px 高，识别率无损。

    want_boxes=True 时返回 (text, boxes, ocr_size)：boxes 为文本框坐标
    （投喂图坐标系，供按文本区域裁图用），ocr_size 为投喂图 (w, h)。

    结果缓存：LRU（完成后写入）+ in-flight Future（进行中共享）——
    同一投喂字节无论串行重跑还是并发首发，都只识别一次。
    """
    global _last_ocr_backend
    # CamScanner harness：投喂前裁边 + 压到 1600px（2560px 大图在 Paddle CPU 上
    # 可跑数十秒顶爆 60s 超时 → 触发 Vision 保底反而更慢）
    content = await asyncio.to_thread(_shrink_for_umi_ocr, content)

    cache_key = hashlib.sha1(content).hexdigest()
    with _ocr_cache_lock:
        hit = _ocr_cache.get(cache_key)
        if hit is not None:
            _ocr_cache.move_to_end(cache_key)
            _flog(f"[OCR-CACHE] 命中：省一次全图识别（{len(hit[0])} 字符）")
            _last_ocr_backend = hit[3]
            return (hit[0], hit[1], hit[2]) if want_boxes else hit[0]

    # in-flight 去重：同图识别正在进行 → 共享同一次调用（超时语义与直接调用一致）
    inflight = _ocr_inflight.get(cache_key)
    if inflight is not None:
        text, boxes, ocr_size, backend = await inflight
        _last_ocr_backend = backend
        _flog(f"[OCR-INFLIGHT] 并发命中：复用进行中的识别（{len(text)} 字符）")
        return (text, boxes, ocr_size) if want_boxes else text

    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    _ocr_inflight[cache_key] = fut
    try:
        text, boxes, ocr_size, backend = await _ocr_run(content, cache_key)
        fut.set_result((text, boxes, ocr_size, backend))
        _last_ocr_backend = backend
        return (text, boxes, ocr_size) if want_boxes else text
    except BaseException as e:
        if not fut.done():
            # Future 语义上不接收 CancelledError，统一转 RuntimeError；无并发等待者
            # 时立刻消费一次异常，避免 "exception was never retrieved" 警告
            fut.set_exception(e if isinstance(e, Exception) else RuntimeError(f"OCR 进行中被中断: {type(e).__name__}"))
            fut.exception()
        raise
    finally:
        _ocr_inflight.pop(cache_key, None)


async def _ocr_run(content: bytes, cache_key: str) -> tuple[str, list, tuple[int, int], str]:
    """执行一次识别（核显加速→内置引擎，否则 UMI-OCR HTTP），写 LRU。

    返回 (text, boxes, ocr_size, backend)：backend 为 "gpu"（内置加速引擎）
    或 "umi"（UMI-OCR，含 GPU 失败兜底），由调用方如实携带到响应。
    """
    # 「核显加速」= 引擎切换开关（十期定稿）：开 = 内置 RapidOCR 引擎
    # （DirectML/OpenVINO 自检择优）真跑；关 = 纯 UMI-OCR（此路径不动）。
    # 内置引擎失败时仍回退 UMI 保命（依赖未装/自检不过/推理异常）。
    # 精度参考（真实证件图 A/B 实测，2026-08-15，1600px 投喂）：
    #   内置 PP-OCRv6 small：34 块 / 369 字符 / 1.3s
    #   UMI（Paddle v4）：42 块 / 631 字符 / 2.9s
    # 内置漏检 ~20% 文本行、字符量少 40%——开关打开前用户已知晓精度取舍。
    # 空结果不落缓存（与 UMI code=101 同策略）：空往往是暂时性识别异常
    # （引擎半初始化/极端图），缓存了会让该图永远提取失败、裁切无坐标。
    if settings.igpu_acceleration:
        try:
            from .gpu_ocr import ocr_bytes

            text, boxes, ocr_size = await asyncio.to_thread(ocr_bytes, content)
            if text.strip():
                _ocr_cache_put(cache_key, text, boxes, ocr_size, "gpu")
            return text, boxes, ocr_size, "gpu"
        except Exception as e:
            print(f"[GPU-OCR] 内置引擎失败，回退 UMI-OCR: {type(e).__name__}: {e}", flush=True)
            _flog(f"[GPU-OCR] 内置引擎失败，回退 UMI-OCR: {type(e).__name__}: {e}")

    url = f"http://{settings.umi_ocr_host}:{settings.umi_ocr_port}/api/ocr"
    b64 = base64.b64encode(content).decode()
    # 裸 base64（与 v0.6.8 一致）：不传 options.limit_side_len。
    # 曾试过 {"ocr.limit_side_len": 999999} 强制 UMI 用完整 1600px 识别——理论是
    # 防 UMI 内部 960px 压缩丢小字框，实测适得其反：UMI 在 1600px 全图跑 det
    # 每张慢 2~3 倍（批量 LOOP 明显劣化），且 det 框变碎导致裁切退化。
    # UMI 流水线本就是 det（缩放图找框）→ 坐标映射回原图 → rec 从原图裁块识别，
    # 小字识别率不受 det 缩放影响；960 默认值是 UMI 多年调好的均衡档。
    try:
        async with httpx.AsyncClient(timeout=60.0, trust_env=False) as client:
            resp = await client.post(url, json={"base64": b64})
            resp.raise_for_status()
            data = resp.json()
    except httpx.ConnectError as e:
        # 假死/离线：失效在线缓存 + 后台自愈（杀假死进程并重新拉起，带 60s 冷却）
        _mark_umi_offline()
        asyncio.get_running_loop().run_in_executor(None, _auto_heal_umi_ocr)
        raise RuntimeError(
            f"UMI-OCR 连接失败（已触发自动恢复，稍后将重试；若持续失败请确认 UMI-OCR 的「HTTP接口服务」已开启，地址 {settings.umi_ocr_host}:{settings.umi_ocr_port}）: {e}"
        ) from e
    except httpx.TimeoutException as e:
        _mark_umi_offline()
        asyncio.get_running_loop().run_in_executor(None, _auto_heal_umi_ocr)
        raise RuntimeError(f"UMI-OCR 请求超时（60秒，已触发自动恢复）: {e}") from e
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"UMI-OCR 返回错误状态（HTTP {e.response.status_code}）: {e}") from e
    except Exception as e:
        raise RuntimeError(
            f"UMI-OCR 调用失败（请确认已开启 UMI-OCR 的「HTTP接口服务」，地址 {settings.umi_ocr_host}:{settings.umi_ocr_port}）: {e}"
        ) from e

    code = data.get("code")
    print(f"[UMI-DEBUG] response code={code}, img_bytes={len(content)}, raw_data_type={type(data.get('data')).__name__}")
    # code 100 = 成功；101 = 图片中未找到文字（非致命错误，返回空串；不落缓存）
    if code == 101:
        print(f"[UMI-DEBUG] code=101 no text found. full response: {str(data)[:500]}")
        return "", [], (0, 0), "umi"
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

    # 文本框坐标（投喂图坐标系）：供按文本区域裁图（CamScanner 内容定位）。
    # 无论 want_boxes 都解析（纯内存操作零成本），保证缓存条目完整。
    boxes: list = [o.get("box") for o in outputs if isinstance(o, dict) and o.get("box")]
    try:
        from PIL import Image as _BImg
        with _BImg.open(io.BytesIO(content)) as _bim:
            ocr_size = (_bim.size[0], _bim.size[1])
    except Exception:
        ocr_size = (0, 0)
    _ocr_cache_put(cache_key, text, boxes, ocr_size, "umi")
    return text, boxes, ocr_size, "umi"


async def _check_umi_ocr_alive(force: bool = False) -> bool:
    """快速检测 UMI-OCR HTTP 服务是否在线（2秒超时，结果缓存 30s 节流）。

    _ocr_run 每张图都要判断 UMI 在线与否来选引擎，不节流的话 UMI 离线时
    每张图都要白等一次 2s 超时才落内置引擎。
    force=True 绕过缓存（手动「重新检测」/ 自愈入口用）。
    """
    global _umi_alive_at, _umi_alive_val
    now = time.monotonic()
    if not force and _umi_alive_at is not None and now - _umi_alive_at < 30.0:
        return _umi_alive_val
    url = f"http://{settings.umi_ocr_host}:{settings.umi_ocr_port}/api/ocr"
    try:
        async with httpx.AsyncClient(timeout=2.0, trust_env=False) as client:
            await client.post(url, json={"base64": ""})
            _umi_alive_val = True
    except Exception:
        _umi_alive_val = False
    _umi_alive_at = now
    return _umi_alive_val


async def ensure_umi_ocr_running() -> tuple[bool, str]:
    """确保 UMI-OCR 服务可用：在线则直接返回；否则自愈（杀假死进程）后自动启动。

    返回 (ok, message)。ok=True 时服务可调用；ok=False 时 message 含中文原因。
    """
    # 1. 先检测是否已在线（force 绕过缓存：本入口是手动触发/自愈路径，必须探真实状态）
    if await _check_umi_ocr_alive(force=True):
        return True, "UMI-OCR 服务已在线"

    # 1.5 假死自愈：进程存在但 HTTP 不响应 → 强杀（内部会重置自动启动标志）
    if _kill_hung_umi_ocr():
        print("[OCR] 自愈：清除假死 Umi-OCR 进程，准备重新启动", flush=True)
        _flog("[OCR] 自愈：清除假死 Umi-OCR 进程，准备重新启动")

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

    # 3. 已启动，等待服务就绪（首次启动加载 PaddleOCR 模型可能较慢，需 1 分钟左右）
    ready = await _wait_for_umi_ocr_ready(max_wait=60.0)
    if not ready:
        return False, (
            f"UMI-OCR 已启动但 HTTP 服务在 60 秒内未就绪（{settings.umi_ocr_host}:{settings.umi_ocr_port}）。\n"
            "首次启动需要加载识别模型，请稍等片刻后点击「重新检测」；\n"
            "若仍不行，请打开 UMI-OCR 窗口，在设置中确认已开启「HTTP接口服务」，端口为 1224。"
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

    ready = await _wait_for_umi_ocr_ready(max_wait=120.0)
    if not ready:
        return False, (
            f"UMI-OCR 已启动但 HTTP 服务在 120 秒内未就绪（{settings.umi_ocr_host}:{settings.umi_ocr_port}）。\n"
            "首次启动需加载识别模型（约 1~2 分钟），请稍等片刻后点击「重新检测」。\n"
            "若仍失败：请切换到 UMI-OCR 窗口，在「设置」中开启「HTTP接口服务」，端口保持 1224；"
            "或确认 Umi-OCR.exe 路径正确（当前：{exe}）。".format(exe=exe_path)
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


def open_umi_ocr_folder() -> tuple[bool, str, str]:
    """在系统文件管理器中打开 UMI-OCR 所在文件夹（并选中其可执行文件），便于用户手动双击启动。

    返回 (是否成功找到并打开, 提示信息, exe 路径或空串)。
    """
    exe_path = _find_umi_ocr_executable()
    if not exe_path:
        return False, "未找到 UMI-OCR 可执行文件，请先下载安装或手动选择程序。", ""
    folder = os.path.dirname(exe_path)
    try:
        if sys.platform == "win32":
            # explorer /select,<path>：打开文件夹并选中该文件
            subprocess.Popen(
                ["explorer", "/select,", exe_path],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", exe_path])
        else:
            subprocess.Popen(["xdg-open", folder])
        return True, f"已打开 UMI-OCR 所在文件夹：{folder}", exe_path
    except Exception as e:
        print(f"[OCR] 打开 UMI-OCR 文件夹失败: {e}")
        return False, f"打开文件夹失败：{e}，请手动到该位置双击 Umi-OCR.exe：{folder}", exe_path


async def _vision_ocr_bytes(content: bytes) -> str:
    """使用 Vision LLM 识别图片文字（含内容审核拦截重试链 + 小字放大重试）。"""
    if not settings.vision_api_key:
        raise RuntimeError("未配置 Vision API，无法 OCR 图片（请在设置中填写 API Key，或切换到 UMI-OCR）")

    # CamScanner harness：投喂前裁边 + 压到 1792px/q85（超限保护也在此链上兜底）
    content = await asyncio.to_thread(_shrink_for_vision_ocr, content)
    content = await asyncio.to_thread(_shrink_for_api, content)
    prompt = (
        "请识别这张图片中的所有文字，并以纯文本形式返回。"
        "不要添加任何解释、翻译或格式标记，只输出识别到的原始文字内容。"
        "\n\n重要：如果图片是护照/证件，请特别注意识别底部MRZ区域（两行由大写字母、数字和'<', '<<'符号组成的行），"
        "必须准确识别所有'<'符号（单尖括号和连续尖括号'<<<'），这些符号用于分隔姓名等字段。"
        "MRZ行通常以字母'P'开头（护照），格式类似：P<COUNTRY<SURNAME<<GIVEN<NAME<<<<<<..."
    )

    async def _try_ocr(img_bytes: bytes) -> str:
        """对单张图片做一次 OCR 调用（含内容审核拦截重试链）。"""
        b64_img = base64.b64encode(img_bytes).decode()
        try:
            return await _call_vision_ocr(b64_img, prompt)
        except RuntimeError as e:
            args = e.args
            extra = args[1] if len(args) > 1 and isinstance(args[1], dict) else {}
            if not extra.get("sensitive"):
                raise
            # 内容审核拦截 → 重试链：轻度扰动 → 纯黑白二值化（彻底消除人脸灰阶）
            for transform in (_jitter_image_for_safety, _binarize_image_for_safety):
                alt = await asyncio.to_thread(transform, img_bytes)
                if alt == img_bytes:
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

    text = await _try_ocr(content)
    # 小字增强：首次识别结果过短（很可能是字太小/内容占比小导致识别不清）
    # → 放大图片后再识别一次，取更完整的结果
    if len(text.strip()) < _ZOOM_RETRY_MIN_CHARS:
        zoomed = await asyncio.to_thread(_zoom_image_for_ocr, content)
        if zoomed != content:
            try:
                text2 = await _try_ocr(zoomed)
                if len(text2.strip()) > len(text.strip()):
                    print(f"[OCR] 小字放大重试成功：{len(text.strip())}→{len(text2.strip())} 字符")
                    text = text2
            except RuntimeError as _zoom_err:
                print(f"[OCR] 小字放大重试失败（{_zoom_err}），保留原结果（{len(text.strip())} 字符）")
    return text


async def ocr_image_bytes(
    content: bytes, engine: str | None = None, boxes_out: dict | None = None
) -> tuple[str, dict | None]:
    """识别图片中的全部文字，返回 (文本, 回退信息)。
    - umi: 先尝试 UMI-OCR，失败自动回退 Vision；fallback 非 None 时说明发生了回退
    - vision: 直接用 Vision LLM

    engine 参数可临时覆盖 settings.ocr_engine（用于前端「用另一引擎重新提取」）。
    boxes_out: 传入 dict 时，UMI 成功路径会把文本框坐标（boxes）和投喂图尺寸
    （ocr_size）写进去（供按文本区域裁图），不产生额外 UMI 调用。
    """
    active_engine = engine or settings.ocr_engine
    if active_engine == "umi":
        # 先快速检测 UMI-OCR 是否在线（不触发自动启动，避免等待30秒）
        umi_ok = await _check_umi_ocr_alive()
        if umi_ok:
            try:
                if boxes_out is not None:
                    text, _boxes, _osize = await _call_umi_ocr(content, want_boxes=True)
                    if _boxes:
                        boxes_out["boxes"] = _boxes
                        boxes_out["ocr_size"] = _osize
                else:
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
                        if boxes_out is not None:
                            text, _boxes, _osize = await _call_umi_ocr(content, want_boxes=True)
                            if _boxes:
                                boxes_out["boxes"] = _boxes
                                boxes_out["ocr_size"] = _osize
                        else:
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
            _flog(f"[OCR-FALLBACK] umi_ocr → vision_ocr：{umi_reason}")
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
    try:
        text = await _vision_ocr_bytes(content)
        return text, None
    except RuntimeError as vision_err:
        # Vision 失败 → 回退 UMI-OCR（双向互兜）
        umi_reason = ""
        umi_ok = await _check_umi_ocr_alive()
        if umi_ok:
            try:
                text = await _call_umi_ocr(content)
                _flog(f"[OCR-FALLBACK] vision_ocr → umi_ocr：{vision_err}")
                return text, {"from": "vision_ocr", "to": "umi_ocr", "reason": str(vision_err)}
            except RuntimeError as umi_err:
                umi_reason = str(umi_err)
        else:
            launched = _try_launch_umi_ocr()
            if launched and await _wait_for_umi_ocr_ready(max_wait=8.0):
                try:
                    text = await _call_umi_ocr(content)
                    _flog(f"[OCR-FALLBACK] vision_ocr → umi_ocr：{vision_err}")
                    return text, {"from": "vision_ocr", "to": "umi_ocr", "reason": str(vision_err)}
                except RuntimeError as umi_err:
                    umi_reason = str(umi_err)
            else:
                umi_reason = "UMI-OCR 未安装或无法启动"
        raise RuntimeError(
            f"AI Vision 失败：{vision_err}\n"
            f"自动切换 UMI-OCR 也失败：{umi_reason}"
        ) from vision_err


# 整页横躺自愈触发线：页型图（宽高比 0.35~2.8）OCR 文本少于该字符数时怀疑文字横躺。
# 护照/证件整页正常识别通常 250+ 字符；横躺误识只余噪声（实测 DARIA 案 85 字符）。
_SIDWAYS_RESCUE_MIN_CHARS = 120


async def _ocr_sideways_rescue(
    content: bytes, engine: str | None = None, boxes_out: dict | None = None
) -> tuple[bytes, str, dict | None]:
    """整页 OCR 出口兜底：结果可疑过短时按 90/270/180 度重识别，取显著更优者。

    背景：第5档（高速·无转正）关闭 Vision 转正后，本地投影粗判对部分竖排
    扫描页失手（投影法分不清护照页的行结构），横躺图直接喂 OCR 产出乱码，
    乱码再进 LRU 缓存 → 后续轮次秒级复用垃圾、字段全空（DARIA 卡片案）。
    此处在 OCR 调用点自愈：页型图且文本 < 120 字符 → 逐角度重试，
    转正后文本 ≥ 1.4 倍且过 120 字符线才采纳，并同步回写 boxes_out
    （坐标与旋转后图片一致，下游 BOX-CROP / MRZ 补扫直接可用）。

    正向稀疏页无副作用：转角度只会更短，原结果保留；重复投喂经 LRU 秒回，
    自愈本身只在首次多 1~3 次识别（每次 2~3 秒）。
    """
    boxes_out = boxes_out if boxes_out is not None else {}
    text, fallback = await ocr_image_bytes(content, engine=engine, boxes_out=boxes_out)
    try:
        from PIL import Image as _Img

        with _Img.open(io.BytesIO(content)) as _im:
            w, h = _im.size
    except Exception:
        return content, text, fallback
    aspect = w / max(h, 1)
    if not (0.35 <= aspect <= 2.8):
        return content, text, fallback  # 条幅/长图（如 MRZ 底条）不适用
    if len((text or "").strip()) >= _SIDWAYS_RESCUE_MIN_CHARS:
        return content, text, fallback  # 文本量正常，无需自愈

    base_len = len((text or "").strip())
    for deg in (90, 270, 180):
        try:
            from PIL import Image as _Img

            with _Img.open(io.BytesIO(content)) as _im:
                rot = _im.rotate(-deg, expand=True)  # 负角=顺时针，与转正逻辑同约定
            buf = io.BytesIO()
            rot.save(buf, format="JPEG", quality=92)
            rot_bytes = buf.getvalue()
        except Exception:
            continue
        tmp: dict = {}
        try:
            t, fb = await ocr_image_bytes(rot_bytes, engine=engine, boxes_out=tmp)
        except Exception:
            continue
        t_len = len((t or "").strip())
        if t_len >= _SIDWAYS_RESCUE_MIN_CHARS and t_len > base_len * 1.4:
            msg = f"[OCR-RESCUE] 检出横躺文本：顺时针转 {deg}° 重识别 {t_len} 字符（原 {base_len}）"
            print(msg, flush=True)
            _flog(msg)
            boxes_out.clear()
            boxes_out.update(tmp)
            return rot_bytes, t, (fb or fallback)
    return content, text, fallback


# ============ MRZ 解析（护照机器可读区） ============
def _normalize_for_compare(s: str) -> str:
    """归一化字符串用于比较：去空格、转大写、去除多余符号。"""
    import re as _re_norm
    s = s.upper().strip()
    s = _re_norm.sub(r'[\s\-_/]+', '', s)
    return s


def _mrz_char_val(ch: str) -> int:
    """ICAO MRZ 字符值：0-9→0-9，A-Z→10-35，<→0；非法字符返回 -1。"""
    if ch.isdigit():
        return int(ch)
    if ch.isalpha():
        return ord(ch.upper()) - 55
    if ch == "<":
        return 0
    return -1


def _icao_check(s: str) -> int:
    """ICAO 9303 检查位：字符值按 7,3,1 循环加权求和 mod 10。"""
    total = 0
    for i, ch in enumerate(s):
        v = _mrz_char_val(ch)
        if v < 0:
            return -1
        total += v * (7, 3, 1)[i % 3]
    return total % 10


_MRZ_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ<"

# OCR 视觉易混淆字符表（双向）：替换修复只接受混淆字符，避免把正确字符改错
_CONFUSABLE: dict[str, str] = {
    "0": "OQD", "O": "0QD", "Q": "0OD", "D": "0O",
    "1": "IL", "I": "1L", "L": "1I",
    "2": "Z", "Z": "2",
    "5": "S", "S": "5",
    "8": "B", "B": "8",
    "6": "G7", "G": "6",
    "7": "T16", "T": "7",
    "4": "A", "A": "4",
    "U": "V", "V": "U",
    "M": "N", "N": "M",
    "C": "G", "E": "F", "F": "E",
}


def _repair_mrz_line2(line2: str) -> str:
    """用 ICAO 检查位修复 MRZ 第二行的单字符 OCR 错误（丢字/错字/多字）。

    第二行前 10 位 = 护照号(9) + 检查位(1)。OCR 认错一位（如 7→6）或丢一位
    会导致后续所有固定位（国家码/日期/性别）整体错位，级联污染全部字段。
    尝试单字符 插入/替换/删除 变异，取同时满足以下条件者：
    检查位通过 + 国家码是合法 ISO 码 + 出生日期段为 6 位数字。
    无合格变异则原样返回。
    """
    if len(line2) < 11:
        return line2

    def _ok(cand: str) -> bool:
        # 护照号检查位
        if _icao_check(cand[:9]) != _mrz_char_val(cand[9]):
            return False
        cc = cand[10:13]
        if not (cc.isalpha() and len(cc) == 3 and cc in _ISO3_COUNTRY_CODES):
            return False
        dob = cand[13:19]
        if not (len(dob) == 6 and dob.isdigit()):
            return False
        # 出生日期检查位（位置19）
        if len(cand) >= 20 and _icao_check(cand[13:19]) != _mrz_char_val(cand[19]):
            return False
        # 有效期段（21-26 数字）+ 其检查位（位置27）
        if len(cand) >= 28:
            exp = cand[21:27]
            if not (exp.isdigit() and _icao_check(exp) == _mrz_char_val(cand[27])):
                return False
        # 整体检查位（位置43，覆盖 0-9 + 13-19 + 21-27 + 28-41，不含可选数据检查位42）
        if len(cand) >= 44:
            overall_src = cand[0:10] + cand[13:20] + cand[21:28] + cand[28:42]
            if _icao_check(overall_src) != _mrz_char_val(cand[43]):
                return False
        return True

    # 已正确则直接返回
    if _ok(line2):
        return line2

    # 单字符插入（OCR 丢字，如 763890288 → 63890288）
    for pos in range(11):
        for ch in _MRZ_CHARS:
            cand = line2[:pos] + ch + line2[pos:]
            if _ok(cand):
                print(f"[MRZ-REPAIR] 插入修复: 位置{pos} 插入'{ch}' → {cand[:19]}")
                return cand
    # 单字符替换（OCR 认错，如 8→B）：只接受视觉易混淆字符，避免把正确字符改错
    for pos in range(11):
        for ch in _CONFUSABLE.get(line2[pos], ""):
            cand = line2[:pos] + ch + line2[pos + 1:]
            if _ok(cand):
                print(f"[MRZ-REPAIR] 替换修复: 位置{pos} '{line2[pos]}'→'{ch}' → {cand[:19]}")
                return cand
    # 单字符删除（OCR 多字）
    for pos in range(11):
        cand = line2[:pos] + line2[pos + 1:]
        if len(cand) >= 19 and _ok(cand):
            print(f"[MRZ-REPAIR] 删除修复: 位置{pos} 删除'{line2[pos]}' → {cand[:19]}")
            return cand
    return line2


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
    # PaddleOCR 常把 MRZ 填充符 < 识别为 unicode 变体（«/‹/〈/全角＜等），统一归一。
    # く/ク：PP-OCRv6 中文模型对连续填充符的高发误识（实测一整段<<<<<<<读成くくく…）
    for _lt_variant in ("«", "‹", "〈", "＜", "≪", "⋘", "く", "ク"):
        cleaned = cleaned.replace(_lt_variant, "<")

    # 把所有连续的非字母数字<的字符作为行分隔
    lines = [l.strip() for l in cleaned.split("\n") if l.strip()]

    # 在所有行中找MRZ第一行：包含 P< + 三字母国家码 + << 模式
    mrz_line1 = None
    mrz_line2 = None

    # MRZ 日期段（出生/有效期）在 OCR 中常见的数字混淆字符（0→O/Q/D，1→I/L，2→Z，5→S，8→B）
    _DIGITISH = r'[0-9OQILZSB]'

    def _looks_like_mrz_line2(cand: str) -> bool:
        """MRZ第二行特征：全是大写字母/数字/<，长度>=28，含6位日期段（容忍数字混淆）。
        性别码 F/M 可能被 OCR 误识（F→E/P、M→N/H），不再强制要求；
        两段 6 位日期段（出生+有效期）同时出现是更稳定的信号。"""
        if not (len(cand) >= 28 and _re.match(r'^[A-Z0-9<]+$', cand)):
            return False
        if len(_re.findall(_DIGITISH + r'{6}', cand)) >= 2:
            return True
        return ("F" in cand or "M" in cand) and _re.search(_DIGITISH + r'{6}', cand) is not None

    def _find_line2_after(idx: int) -> str | None:
        """在 lines[idx] 之后的若干行中找 MRZ 第二行（OCR 可能在两行 MRZ 之间插入噪声行）。"""
        for j in range(idx + 1, min(idx + 6, len(lines))):
            cand = lines[j]
            if _looks_like_mrz_line2(cand):
                return cand
            # 噪声行可能只混入少量小写/杂字符：清洗后再判一次
            cand2 = _re.sub(r'[^A-Z0-9<]', '', cand)
            if cand2 != cand and _looks_like_mrz_line2(cand2):
                return cand2
        return None

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
            mrz_line2 = _find_line2_after(i)
            break

    # 回退：OCR 把 P 和国家码之间的 < 丢掉/误识别时，允许 P 直接跟三字母国家码
    # （需同时存在 << 分隔与足够长度，避免误匹配 PLEASE 等普通单词）
    if not mrz_line1:
        for i, line in enumerate(lines):
            for m in _re.finditer(r'P[A-Z]{3}', line):
                candidate = line[m.start():]
                mrz_chars = _re.match(r'[A-Z0-9<]+', candidate)
                if not mrz_chars:
                    continue
                extracted = mrz_chars.group(0)
                if "<<" in extracted and len(extracted) >= 20:
                    mrz_line1 = extracted
                    mrz_line2 = _find_line2_after(i)
                    break
            if mrz_line1:
                break

    # 回退0：如果MRZ第一行和第二行在同一行（OCR合并），尝试从mrz_line1中切出第二行
    if mrz_line1 and not mrz_line2:
        # 在mrz_line1中搜索第二行模式：9位字母数字+1位+3位国家码+6位日期+检查位+F/M+6位日期
        m2 = _re.search(r'([A-Z0-9]{9}[A-Z0-9<][A-Z]{3}' + _DIGITISH + r'{6}[0-9A-Z<][FM]' + _DIGITISH + r'{6}[A-Z0-9<]*)', mrz_line1)
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
        m = _re.search(r'[A-Z0-9]{9}[A-Z0-9<][A-Z]{3}' + _DIGITISH + r'{6}[0-9A-Z<][FM]' + _DIGITISH + r'{6}[A-Z0-9<]*', flat)
        if m:
            mrz_line2 = m.group(0)

    # ICAO 检查位修复：OCR 丢字/错字会让第二行固定位整体错位（国家码/日期全错），
    # 用检查位+国家码+出生日期三重约束自动纠回单字符错误
    if mrz_line2:
        mrz_line2 = _repair_mrz_line2(mrz_line2)

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

    pre_sep = line1[1:sep_idx].lstrip("<")  # 跳过开头P和<，得到国家码+姓氏部分

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
        # HARNESS：无第二行国家码时按第一行固定位拆：P< + 3位ISO国家码 + 姓氏。
        # 必须在「最后一个<」回退之前执行：单< BUG 时 pre_sep = "国家码+姓<名"
        # （RUSKULAGIN<GLEB），最后一个<后面是名字 GLEB 而不是姓
        cc1 = pre_sep[:3]
        if cc1 in _ISO3_COUNTRY_CODES:
            sur_match = _re.match(r'[A-Z]{2,}', pre_sep[3:].lstrip("<"))
            if sur_match:
                country_code = country_code or cc1
                surname_part = sur_match.group(0)
                print(f"[MRZ-HARNESS] 第一行国家码固定位拆分: {pre_sep} → 国家码={cc1}, 姓氏={surname_part}")

    if not surname_part:
        # 回退策略1：在pre_sep中寻找最后一个<，<后面的字母就是surname
        last_lt = pre_sep.rfind("<")
        if last_lt >= 0:
            after_lt = pre_sep[last_lt + 1:]
            sur_match = _re.match(r'[A-Z]+', after_lt)
            if sur_match:
                surname_part = sur_match.group(0)

    if not surname_part:
        # HARNESS：MRZ 第一行固定格式 = P< + 3位ISO国家码 + 姓氏。
        # 第二行国家码缺失/损坏时按第一行固定位直接拆
        # （RUSNIKUSHKINA<<ANNA → RUS + NIKUSHKINA），零成本、不依赖第二行
        pre_clean = pre_sep.rstrip("<")
        m1 = _re.match(r'^([A-Z]{3})([A-Z]{4,})$', pre_clean)
        if m1 and m1.group(1) in _ISO3_COUNTRY_CODES:
            country_code = country_code or m1.group(1)
            surname_part = m1.group(2)
            print(f"[MRZ-HARNESS] 第一行固定位拆分: {pre_clean} → 国家码={m1.group(1)}, 姓氏={m1.group(2)}")

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

    # HARNESS：姓/名分隔符 << 被 OCR 读成单个 < 时（如 P<RUSKULAGIN<GLEB<<），
    # 上面的 sep_idx 会错误定位到名字后面的填充区，名字被并进姓区域 pre_sep
    # （KULAGIN<GLEB → 只解析出姓 KULAGIN，名 GLEB 丢失）。
    # 名字为空时从 pre_sep 的 < 分隔段恢复：跳过国家码和已解析的姓，剩余段即名字
    if not given_name and surname and pre_sep:
        segs = [s for s in pre_sep.split("<") if s and s.isalpha()]
        rest = segs[:]
        # 国家码常与姓粘连无<分隔（RUSKULAGIN）：剥掉前3字符国家码前缀
        if country_code and rest and rest[0].startswith(country_code) and len(rest[0]) > 3:
            rest[0] = rest[0][3:]
        elif country_code and rest and rest[0] == country_code:
            rest = rest[1:]
        if surname in rest:
            rest = rest[rest.index(surname) + 1:]
        if rest:
            given_name = " ".join(rest)
            print(f"[MRZ-HARNESS] 单<分隔恢复名字: {pre_sep} → 名字={given_name}")

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

        # === 出生日期 / 性别 / 有效期（TD3标准布局：护照号9 检查位1 国家码3 出生6 检查位1 性别1 有效期6） ===
        # OCR 数字混淆纠正：MRZ 字体下 PaddleOCR 常把 0→O/Q/D、1→I/L、2→Z、5→S、8→B、6→G、7→T
        def _fix_ocr_digits(s: str) -> str:
            return (s.replace("O", "0").replace("Q", "0").replace("D", "0")
                     .replace("I", "1").replace("L", "1")
                     .replace("Z", "2").replace("S", "5").replace("B", "8")
                     .replace("G", "6").replace("T", "7"))

        def _valid_date6(s: str) -> bool:
            """6位 YYMMDD 合法性校验（防止从错误偏移截出垃圾日期）。"""
            if not _re.match(r'^\d{6}$', s):
                return False
            mm, dd = int(s[2:4]), int(s[4:6])
            return 1 <= mm <= 12 and 1 <= dd <= 31

        birth_str = ""
        expiry_str = ""
        sex_char = ""

        def _recover_sex(ch: str) -> str:
            """性别位字符恢复：MRZ 性别域只会是 F/M/<，OCR 常见误识 F→E/P、M→N/H，就近映射。"""
            if ch in "FM":
                return ch
            if ch in "EP":
                return "F"
            if ch in "NH":
                return "M"
            return ""

        def _match_dates_pattern(sex_inner: str, segment: str, anchored: bool) -> tuple[str, str, str] | None:
            """按 出生6+检查位+性别+有效期6 结构在 segment 中匹配，双日期校验通过才返回。
            anchored=True 时要求从 segment 起始处匹配（segment 为国家码之后的串）；
            anchored=False 时在 segment 全文搜「任意三字母 + 日期结构」。"""
            pat = r'(' + _DIGITISH + r'{6})[0-9A-Z<]([' + sex_inner + r'])(' + _DIGITISH + r'{6})'
            matches = [_re.match(pat, segment)] if anchored else _re.finditer(r'[A-Z]{3}' + pat, segment)
            for m in matches:
                if not m:
                    continue
                b = _fix_ocr_digits(m.group(1))
                e = _fix_ocr_digits(m.group(3))
                if _valid_date6(b) and _valid_date6(e):
                    return b, _recover_sex(m.group(2)), e
            return None

        hit: tuple[str, str, str] | None = None
        # 方案1：锚定已知国家码（第二行10-12位）之后结构化提取——对护照号移位/丢字符免疫。
        # 性别位先严（F/M）后宽（任意字母，OCR 误识 F→E、M→N 时仍能定位出生/有效期）。
        if country_code:
            cc_start = 9
            while not hit:
                cc_idx = line2.find(country_code, cc_start)
                if cc_idx < 0:
                    break
                tail = line2[cc_idx + 3:]
                hit = (_match_dates_pattern("FM", tail, anchored=True)
                       or _match_dates_pattern("A-Z<", tail, anchored=True))
                cc_start = cc_idx + 1
        # 方案2：固定位置（TD3 标准布局：出生13-18 检查位19 性别20 有效期21-26 检查位27）
        if not hit and len(line2) > 26:
            b2 = _fix_ocr_digits(line2[13:19])
            e2 = _fix_ocr_digits(line2[21:27])
            if _valid_date6(b2) and _valid_date6(e2):
                hit = (b2, _recover_sex(line2[20]), e2)
        # 方案3：全文结构化兜底（国家码未知时；任意三字母后接日期结构，日期校验防误锚）
        if not hit:
            hit = (_match_dates_pattern("FM", line2, anchored=False)
                   or _match_dates_pattern("A-Z<", line2, anchored=False))
        if hit:
            birth_str, sex_char, expiry_str = hit

        # 方案4：日期均失败时，仅在 16-26 窗口内搜 F/M 取性别（宁缺毋错，
        # 不用「全文任意F/M」错位回退——护照号含F/M时会截出错误日期）
        if not sex_char and len(line2) >= 26:
            wm = _re.search(r'[FM]', line2[16:26])
            if wm:
                sex_char = wm.group(0)

        if sex_char:
            result["gender"] = sex_char
        if _valid_date6(birth_str):
            byy, bmm, bdd = birth_str[:2], birth_str[2:4], birth_str[4:6]
            year_prefix = 19 if int(byy) > 30 else 20
            result["birth_date"] = f"{year_prefix}{byy}-{bmm}-{bdd}"
        if _valid_date6(expiry_str):
            eyy, emm, edd = expiry_str[:2], expiry_str[2:4], expiry_str[4:6]
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
    撇号先归一化删除（法语 "DATE D'EXPIRATION" OCR 常变成 "D EXPIRATION"/"DEXPIRATION"）。
    """
    if not text:
        return ""
    upper = text.upper().replace("'", "").replace("'", "").replace("`", "")
    for kw in keywords:
        kw_up = kw.upper().replace("'", "")
        # 把关键词按空格拆分，各部分分别转义后用 \s* 连接，
        # 容忍 OCR 丢失或多余空格（如 "Dateof expiry" 匹配 "Date of expiry"）
        parts = [re.escape(p) for p in kw_up.split() if p]
        kw_pattern = r'\s*'.join(parts)
        m = re.search(kw_pattern, upper)
        if not m:
            continue
        idx = m.start()
        # 取关键词后面 100 个字符作为搜索窗口（OCR 换行/噪声可能拉大标签与值的距离）
        window = text[idx: idx + 100]
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
        # 法/德/西/意等双语护照常见标注
        "DATE D'EXPIRATION", "DEXPIRATION", "EXPIRATION",
        "GÜLTIG BIS", "GULTIG BIS", "VERFALLSDATUM",
        "FECHA DE CADUCIDAD", "FECHA DE VENCIMIENTO", "VENCIMIENTO", "CADUCIDAD",
        "DATA DI SCADENZA", "SCADENZA", "VALABLE JUSQU", "VALIDE JUSQU",
        "EXPIRY",
    ])


def _extract_issue_from_text(text: str) -> str:
    """从 OCR 文本中回退提取护照签发日期。"""
    return _extract_date_by_keywords(text, [
        "DATE OF ISSUE", "ISSUED ON", "VALID FROM", "ISSUING DATE",
        "签发日期", "发证日期", "有效期开始",
        # 法/德/西/意等双语护照常见标注
        "DATE DE DELIVRANCE", "DELIVRANCE",
        "AUSSTELLUNGSDATUM", "AUSGESTELLT",
        "FECHA DE EXPEDICION", "EXPEDICION",
        "DATA DI RILASCIO", "RILASCIO",
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
    r"DATE\s*DE\s*DELIVRANCE", r"DELIVRANCE",  # 法语
    r"AUSSTELLUNGSDATUM",  # 德语
    r"FECHA\s*DE\s*EXPEDICION",  # 西语
    r"DATA\s*DI\s*RILASCIO",  # 意语
    r"签发日期", r"发证日期",
]
_LABEL_EXPIRY_DATE = [
    r"DATE\s*OF\s*EXPIRY", r"EXPIRY\s*DATE", r"DATE\s*OF\s*EXPIRATION",
    r"VALID\s*UNTIL", r"VALID\s*THRU", r"BESTEHEN\s*BIS",
    r"СРОК\s*ДЕЙСТВИЯ",  # 俄语
    r"DATE\s*D.EXPIRATION", r"DEXPIRATION",  # 法语（撇号OCR常丢失）
    r"G[UÜ]LTIG\s*BIS", r"VERFALLSDATUM",  # 德语
    r"FECHA\s*DE\s*(CADUCIDAD|VENCIMIENTO)", r"VENCIMIENTO",  # 西语
    r"DATA\s*DI\s*SCADENZA", r"SCADENZA",  # 意语
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
        # 值字符集含数字/句点/括号/逗号：俄语签发机关如
        # "ГУ МВД РОССИИ ПО Г. МОСКВЕ" / "ОТДЕЛЕНИЕМ УФМС ... ОБЛ." 需要这些字符
        pattern = label + r"[\s:：/\\|]*([A-ZА-ЯЁ][A-ZА-ЯЁ0-9.\-,()'\s]{1,60})"
        m = _re.search(pattern, text_upper)
        if m:
            val = m.group(1).strip().rstrip("<").rstrip(".").rstrip(",")
            # 去掉尾部可能粘连的下一个标签关键词
            for stop in ("NATIONALITY", "DATE", "SEX", "GENDER", "PLACE",
                         "AUTHORITY", "GIVEN", "PASSPORT", "ISSU",
                         "ГРАЖДАН", "ДАТА", "МЕСТО", "ОРГАН", "ПОЛ",
                         "ФАМИЛИЯ", "ИМЯ", "СРОК", "ТИП", "КОД"):
                idx = val.find(stop)
                if idx > 1:
                    val = val[:idx].strip()
            val = val.strip().rstrip(".").rstrip(",")
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
    """在标签后提取字母数字组合（如护照号）。

    支持护照印刷常见的"分段号码"：如 "PASSPORT NO 76 312345"（号码被空格拆成两段）。
    合并规则：仅当后续段为【纯数字】时才合并（避免把 DATE/SEX 等下一个标签词粘进来）。
    """
    import re as _re
    for label in labels:
        # 首段字母数字；后续段仅纯数字（同行空格分隔，最多再并 2 段）
        pattern = (label + r"[\s:：/\\|]*([A-Z0-9]+)((?:[ \t]+\d+){0,2})")
        m = _re.search(pattern, text_upper)
        if m:
            first = m.group(1).rstrip("<")
            merged = (first + (m.group(2) or "").replace(" ", "").replace("\t", "")).rstrip("<")
            # 优先用合并值（如 76+312345 → 76312345）；超长则回退首段
            for val in (merged, first):
                if min_len <= len(val) <= max_len:
                    # 排除纯字母国家码（太短或全是字母且<=3）
                    if not (val.isalpha() and len(val) <= 3):
                        return val
        # 回退：合并匹配失败时按原逻辑取单段
        pattern_single = label + r"[\s:：/\\|]*([A-Z0-9]{" + str(min_len) + r"," + str(max_len) + r"})"
        m2 = _re.search(pattern_single, text_upper)
        if m2:
            val = m2.group(1).strip().rstrip("<")
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


def _rescue_segmented_number(text_upper: str, val: str, max_len: int = 20) -> str:
    """若 val 是全文中某个更长"字母数字串（允许空格/制表符分段）"的子串，返回更长合并值。
    修复 OCR/正则把 '76 312345' 截断成 '6312345' 一类的首段丢失问题。"""
    import re as _re
    if not val or len(val) < 4:
        return val
    best = val
    for m in _re.finditer(r"[A-Z0-9]+(?:[ \t]+\d+)+", text_upper):
        merged = _re.sub(r"[ \t]+", "", m.group(0))
        if len(best) < len(merged) <= max_len and val in merged:
            best = merged
    return best


# 本地已经显式处理的字段集合（自定义字段才能进入通用标签匹配）
_KNOWN_FIELDS = {
    "surname", "given_name", "name", "passport_no", "birth_date", "gender",
    "nationality", "passport_issue", "passport_expiry", "issue_authority",
    "issue_place", "birth_place", "email", "phone",
}

# 通用标签匹配时需要跳过的"过泛"词，避免把 NO/NAME 等当唯一标签到处命中
_GENERIC_LABEL_STOPS = {
    "NO", "NUMBER", "NUM", "N", "ID", "SN", "REFERENCE", "REF", "CODE",
    "NAME", "DATE", "PASSPORT", "NATIO", "SEX", "GENDER", "PLACE", "BIRTH",
    "ISSUE", "EXPIR", "TYPE", "TEL", "PHONE", "EMAIL", "ADDR", "ADDRESS",
}


def _extract_custom_field(text_upper: str, field_name: str) -> str:
    """按自定义字段名做本地标签匹配提取（不依赖 LLM）。

    field_name 常同时含中文与英文标签，如 "申请编号 Applicant No."。
    将字段名拆成多个候选标签（整体 + 各分段），逐个在 OCR 文本中查找，
    取标签后紧邻的字母数字值。用于用户在步骤设置里保存的非标准字段。
    """
    import re as _re
    if not text_upper or not field_name:
        return ""

    # 1. 候选标签：整体去空格 + 分段（按空格/斜杠/顿号/逗号切分）
    labels: list[str] = []
    whole = _re.sub(r"[\s/，,、:：.。#]+", "", field_name).upper()
    if whole:
        labels.append(whole)
    for part in _re.split(r"[\s/，,、:：]+", field_name):
        part = part.strip().upper()
        if part and part not in labels:
            labels.append(part)
    # 去掉过泛的短标签（如 NO），避免误命中
    labels = [lb for lb in labels if lb not in _GENERIC_LABEL_STOPS]

    for label in labels:
        if len(label) < 2:
            continue
        # 标签后跟可选分隔符 + 字母数字值（含 . / - 空格 分段）
        pattern = _re.escape(label) + r"[\s:：/\\|]*([A-Z0-9][A-Z0-9.\-/ ]{1,40})"
        m = _re.search(pattern, text_upper)
        if not m:
            continue
        val = m.group(1).strip().rstrip(".").rstrip("<")
        if not val:
            continue
        # 去掉值开头的 NO./NUMBER/SN 等前缀（如 "APPLICANT NO. 123456" 用 APPLICANT 标签时
        # 抓到 "NO. 123456"，冒号前不含于字符集导致截断，需剥离 "NO." 前缀取真实值）
        pre = _re.match(r'(?:NO[.]?\s*|NUMBER\s*|NUM\.?\s*|SN[.:]?\s*|ID[.:]?\s*|REF[.:]?\s*)', val)
        if pre:
            val = val[pre.end():].strip()
        # 在下一个字段标签处截断（避免粘连下一字段）
        for stop in ("DATE", "NUMBER", "PASSPORT", "NAME", "NATION",
                     "SEX", "GENDER", "PLACE", "BIRTH", "ISSU", "EXPIR",
                     "TYPE", "CODE", "TEL", "PHONE", "EMAIL"):
            idx = val.find(stop)
            if idx > 1:
                val = val[:idx].strip()
                break
        # 校验值合法性：至少 2 位，且不是纯标点/纯空
        if len(val) >= 2 and any(c.isalnum() for c in val):
            return val
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
            # 交叉验证：若全文存在包含该值的更长分段号码（如 "76 312345"），用更长值
            val = _rescue_segmented_number(upper, val)
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

    # 自定义字段（非标准字段）：按字段名做本地标签匹配兜底，不依赖 LLM
    for f in target_fields:
        if f in result or f in _KNOWN_FIELDS:
            continue
        try:
            val = _extract_custom_field(upper, f)
        except Exception:
            val = ""
        if val:
            result[f] = val

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
7. 姓名类字段（name/surname/given_name）必须取完整单词/完整姓名，严禁只取片段或后缀：
   - 错误示例：DZHUMANIAZOVA 只取 "OBA"、IVANOVA 只取 "OVA"、PETROV 只取 "OV"
   - 文档同时存在西里尔文等非拉丁原文（如 ДЖУМАНИЯЗОВА）和拉丁转写（DZHUMANIAZOVA，
     含MRZ行）时，一律取拉丁字母版本，不要返回非拉丁文字的值
   - 完整拼写拿不准时优先从 MRZ 行取（P< 开头那行是官方拉丁转写，最可靠）
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


# 姓名类字段：值必须是完整词，片段（俄语姓转写后缀 -OVA/-OBA 等）自动修复
_NAME_FIELDS = {"surname", "given_name", "name"}


def _heal_name_fragments(fields: dict[str, str], text: str) -> dict[str, str]:
    """姓名片段自愈：LLM 偶尔只取到姓名的后缀片段（如把 DZHUMANIAZOVA 取成 OBA）。
    若姓名字段值过短（≤6字符）、本身不是 OCR 文本中的独立完整词、
    但恰是文本中某个更长拉丁词的后缀，则替换为该完整词。"""
    if not fields or not text:
        return fields
    tokens = set(re.findall(r"[A-Z]{2,}", text.upper()))
    for f in _NAME_FIELDS:
        v = (fields.get(f) or "").strip()
        if not v or len(v) > 6:
            continue
        vu = re.sub(r"[^A-Z]", "", v.upper())
        # <3 字母的短值（LI/WU 等合法拼音姓）不修；俄语姓后缀 OVA/OBA/EVA 均 ≥3
        if len(vu) < 3 or vu in tokens:
            continue  # 本身就是文本中的完整词，不动
        # 西里尔 В 常被 OCR 读成拉丁 B（ДЖУМАНИЯЗОВА → ...OBA），
        # 后缀匹配同时尝试 V↔B 互换的两种写法
        variants = {vu, vu.replace("V", "B"), vu.replace("B", "V")}
        candidates = [t for t in tokens if len(t) > len(vu) + 2 and t.endswith(tuple(variants))]
        if candidates:
            best = max(candidates, key=len)
            msg = f"[EXTRACT-HEAL] {f}: 姓名片段 {v!r} → 完整词 {best!r}"
            print(msg, flush=True)
            _flog(msg)
            fields[f] = best
    return fields


# 文本 LLM 并发上限：两遍式流水线下多人文件的 DeepSeek 排版在后台并行堆积，
# 不限流会集中打到 API 触发限速（429 重试反而更慢）。3 并发实测兼顾吞吐与稳定
_llm_semaphore = asyncio.Semaphore(3)


async def extract_fields_from_text(text: str, target_fields: list[str]) -> dict[str, str]:
    """用文本 LLM 从文档全文中提取目标字段（结构化 JSON）。

    优先用轻量文本模型（如 DeepSeek-V4-Flash，settings.text_model）做纯文字排版，
    未单独配置时回退 Vision 模型——纯文字任务文本模型更快更省。
    """
    if not target_fields:
        return {}
    base, key, model = settings.effective_text_llm()
    if not key:
        print(f"[EXTRACT-DEBUG] 未配置 API Key，跳过 LLM 字段提取（{len(target_fields)} 个字段将走本地关键词兜底）: {target_fields}")
        return {f: "" for f in target_fields}

    async with _llm_semaphore:
        return await _extract_fields_from_text_inner(text, target_fields, base, key, model)


async def _extract_fields_from_text_inner(text: str, target_fields: list[str], base: str, key: str, model: str) -> dict[str, str]:
    """实际 LLM 调用（已过并发闸门）。"""

    url = base + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": _build_fields_prompt(text, target_fields)}],
        "temperature": 0.1,
    }
    try:
        async with httpx.AsyncClient(timeout=240.0, trust_env=False) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code == 404 and model != model.lower():
                # 端点模型名大小写敏感（SenseNova 对 DeepSeek-V4-Flash 报 "model is not found"）
                # → 小写重试一次，避免排版静默失败走本地兜底
                print(f"[EXTRACT-WARN] 模型 {model} 404，改小写 {model.lower()} 重试")
                payload["model"] = model.lower()
                resp = await client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"] or ""
            parsed = _parse_json_fields(content)
            if not parsed:
                print(f"[EXTRACT-WARN] LLM 字段提取返回了无法解析的内容: {content[:200]!r}")
            return _heal_name_fragments(parsed, text)
    except Exception as e:
        print(f"[EXTRACT-WARN] LLM 字段提取失败（{type(e).__name__}）: {e} —— 这些字段将走本地关键词兜底: {target_fields}")
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


def _shrink_for_viz(content: bytes, max_side: int = 1280) -> bytes:
    """VIZ 看图前的主动缩图：最长边压到 max_side（默认1280）。

    与 _shrink_for_api（只在超 base64 上限时被动缩）不同，这里主动缩小——
    签发日期/机关等大字字段 1280px 足够看清，而 Vision 模型处理 2560px 大图
    的响应时间往往是 1280px 的数倍。失败返回原内容。
    """
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(content)).convert("RGB")
        w, h = img.size
        if max(w, h) <= max_side:
            return content
        ratio = max_side / max(w, h)
        img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=88)
        print(f"[VIZ] 看图前缩图：{w}x{h} → {img.size[0]}x{img.size[1]}（{len(content)}B → {len(buf.getvalue())}B，Vision响应更快）")
        return buf.getvalue()
    except Exception:
        return content


async def _extract_viz_fields_from_image(
    image_content: bytes, viz_fields: list[str]
) -> dict[str, str]:
    """直接看护照图片，提取 VIZ 可视区字段（签发日期等）。

    仅在检测到 MRZ（确认是护照）时调用，避免对非证件图片产生误识别。
    """
    if not viz_fields:
        return {}
    if not settings.vision_api_key:
        print(f"[EXTRACT-DEBUG] VIZ 字段 {viz_fields} 需要 Vision API Key 看图提取，未配置，跳过（将走文本关键词兜底）")
        return {}
    # 主动缩图：日期/机关字段 1280px 足够，大幅缩短 Vision 响应时间
    image_content = await asyncio.to_thread(_shrink_for_viz, image_content)
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
        _viz_t0 = time.perf_counter()
        async with httpx.AsyncClient(timeout=240.0, trust_env=False) as client:
            resp = await client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
        print(f"[VIZ-TIME] 看图提取 {viz_fields}: {time.perf_counter() - _viz_t0:.2f}s", flush=True)
        content = data["choices"][0]["message"]["content"] or ""
        parsed = _parse_json_fields(content)
        if not parsed:
            print(f"[EXTRACT-WARN] VIZ 看图提取返回了无法解析的内容: {content[:200]!r}")
        return parsed
    except Exception as e:
        print(f"[EXTRACT-WARN] VIZ 看图字段提取失败（{type(e).__name__}）: {e} —— 字段: {viz_fields}")
        return {}


def _crop_bottom_band(content: bytes) -> bytes:
    """裁出图片底部 30% 并放大 2 倍（用于 MRZ 补扫），返回 JPEG 字节。

    放大后最长边受 _UMI_OCR_MAX_EDGE 约束：放大的目的只是让 MRZ 小字
    达到可识别高度，超过全图尺寸的放大对 Paddle 毫无增益、白白变慢。
    """
    from PIL import Image
    img = Image.open(io.BytesIO(content)).convert("RGB")
    w, h = img.size
    if w < 100 or h < 100:
        return b""
    band = img.crop((0, int(h * 0.70), w, h))
    band = band.resize((band.width * 2, band.height * 2), Image.LANCZOS)
    bw, bh = band.size
    if max(bw, bh) > _UMI_OCR_MAX_EDGE:
        ratio = _UMI_OCR_MAX_EDGE / max(bw, bh)
        band = band.resize((max(1, int(bw * ratio)), max(1, int(bh * ratio))), Image.LANCZOS)
    buf = io.BytesIO()
    band.save(buf, format="JPEG", quality=92)
    return buf.getvalue()


def _crop_top_band(content: bytes) -> bytes:
    """裁出图片顶部 40% 并放大 2 倍（用于 VIZ 可视区姓名补扫），返回 JPEG 字节。

    与 _crop_bottom_band 对称：护照上半部是 VIZ 可视区（姓名/标签），
    底部 MRZ 被裁出画面时，姓名仍可从这里放大重扫读出。
    """
    from PIL import Image
    img = Image.open(io.BytesIO(content)).convert("RGB")
    w, h = img.size
    if w < 100 or h < 100:
        return b""
    band = img.crop((0, 0, w, int(h * 0.40)))
    band = band.resize((band.width * 2, band.height * 2), Image.LANCZOS)
    bw, bh = band.size
    if max(bw, bh) > _UMI_OCR_MAX_EDGE:
        ratio = _UMI_OCR_MAX_EDGE / max(bw, bh)
        band = band.resize((max(1, int(bw * ratio)), max(1, int(bh * ratio))), Image.LANCZOS)
    buf = io.BytesIO()
    band.save(buf, format="JPEG", quality=92)
    return buf.getvalue()


async def _viz_top_rescan(text: str, content: bytes, active_engine: str) -> str:
    """MRZ 机读区不在画面/未识别时，裁顶部 40% 放大 2 倍重扫 VIZ 可视区姓名。

    常见场景：护照照片底部被裁（MRZ 出画），上半部仍有 SURNAME/GIVEN NAMES
    标签和姓名。补扫文本并入后，本地标签提取和文本 LLM 即可从中取到姓名。
    仅 umi 引擎且文档像护照（或原文已含姓名标签）时执行；补扫结果含
    姓名标签或成串拉丁词才返回，否则返回空串（不污染原文本）。
    """
    if active_engine != "umi" or not text:
        return ""
    upper = text.upper()
    looks_passport = bool(re.search(r"P<[A-Z]{3}", upper)) or any(
        kw in upper for kw in ("PASSPORT", "PASSEPORT", "PASAPORTE", "REISEPASS", "ПАСПОРТ", "护照")
    )
    has_name_label = any(re.search(p, upper) for p in (*_LABEL_SURNAME, *_LABEL_GIVEN))
    if not (looks_passport or has_name_label):
        return ""
    band_bytes = await asyncio.to_thread(_crop_top_band, content)
    if not band_bytes:
        return ""
    try:
        band_text = await _call_umi_ocr(band_bytes)
    except Exception as e:
        print(f"[VIZ-RESCAN] 上半部姓名补扫失败（忽略）: {e}")
        return ""
    if not band_text:
        return ""
    bu = band_text.upper()
    hit_label = any(re.search(p, bu) for p in (*_LABEL_SURNAME, *_LABEL_GIVEN))
    hit_latin_run = bool(re.search(r"[A-Z]{3,}(?:\s+[A-Z]{2,}){1,}", bu))
    if hit_label or hit_latin_run:
        print(f"[VIZ-RESCAN] 上半部补扫命中姓名区（{len(band_text)} 字符），并入文本")
        return band_text
    return ""


async def _mrz_bottom_rescan(text: str, content: bytes, active_engine: str) -> str:
    """全图 OCR 后，裁底部 30% 放大 2 倍再扫一次 UMI-OCR 找 MRZ 机读区。

    护照底部 MRZ 字号小密度高，全图扫描时容易漏行或认错字符
    （如 7→6、姓氏被截断粘到国籍码）。裁切放大后字符高度翻倍，
    PaddleOCR 识别率显著提升。仅 umi 引擎且文档像护照时执行；
    补扫结果含有效 MRZ 行（P<国籍码）才返回，否则返回空串。
    """
    if active_engine != "umi" or not text:
        return ""
    upper = text.upper()
    looks_passport = bool(re.search(r"P<[A-Z]{3}", upper)) or any(
        kw in upper for kw in ("PASSPORT", "PASSEPORT", "PASAPORTE", "REISEPASS", "ПАСПОРТ", "护照")
    )
    if not looks_passport:
        return ""
    band_bytes = await asyncio.to_thread(_crop_bottom_band, content)
    if not band_bytes:
        return ""
    try:
        band_text = await _call_umi_ocr(band_bytes)
    except Exception as e:
        print(f"[MRZ-RESCAN] 底部补扫失败（忽略）: {e}")
        return ""
    if band_text and re.search(r"P<[A-Z]{3}", band_text.upper()):
        print(f"[MRZ-RESCAN] 补扫命中 MRZ（{len(band_text)} 字符），并入文本")
        return band_text
    return ""


def _split_stuck_country_prefix(value: str) -> tuple[str, str] | None:
    """拆分 "RUSNIKITA" 这类粘连值：3 位 ISO 国家码 + 大写姓名。

    PaddleOCR 检测模型常把护照上相邻两列（国籍 RUS 与姓名 NIKITA）
    框进同一个文本块导致粘连。返回 (国家码, 剩余部分)，不符合粘连特征返回 None。
    """
    v = (value or "").strip().upper()
    if len(v) < 7:  # 3 位国家码 + 至少 4 位姓名
        return None
    code, rest = v[:3], v[3:]
    # 排除国籍形容词（RUSSIAN/INDIAN/MEXICAN/TURKISH/KAZAKHSTANI 等）：
    # 它们同样呈 "ISO码+大写字母" 形态，但不是粘连值
    if rest.endswith(("IAN", "ESE", "ISH", "CAN", "ANI")):
        return None
    if code in _ISO3_COUNTRY_CODES and rest.isalpha() and len(rest) >= 4:
        return code, rest
    return None


def _repair_stuck_nationality(fields: dict[str, str]) -> None:
    """修复 OCR 粘连：国籍码与姓名粘成一格（RUSNIKITA）时拆回两个字段。"""
    nat = fields.get("nationality", "").strip()
    if nat:
        split = _split_stuck_country_prefix(nat)
        if split:
            code, rest = split
            fields["nationality"] = code
            print(f"[EXTRACT-DEBUG] 拆分粘连国籍值: {nat} → nationality={code}, 剩余={rest}")
            # 姓名字段为空时，剩余部分填入 surname/name
            if not fields.get("surname", "").strip() and not fields.get("given_name", "").strip():
                fields["surname"] = rest
                fields["name"] = rest
        return
    # 国籍为空但姓名带国家码前缀 → 反向拆分
    for key in ("surname", "name"):
        val = fields.get(key, "").strip()
        split = _split_stuck_country_prefix(val) if val else None
        if split:
            code, rest = split
            fields["nationality"] = code
            if key == "surname":
                fields["surname"] = rest
                if not fields.get("name", "").strip():
                    fields["name"] = rest
            else:
                fields["name"] = rest
            print(f"[EXTRACT-DEBUG] 拆分粘连姓名值: {val} → nationality={code}, {key}={rest}")
            break


# ISO 3166-1 alpha-3 国家/地区代码（用于拆分 "RUSNIKITA" 类粘连值）
_ISO3_COUNTRY_CODES = {
    "AFG", "ALB", "DZA", "AND", "AGO", "ATG", "ARG", "ARM", "AUS", "AUT",
    "AZE", "BHS", "BHR", "BGD", "BRB", "BLR", "BEL", "BLZ", "BEN", "BTN",
    "BOL", "BIH", "BWA", "BRA", "BRN", "BGR", "BFA", "BDI", "CPV", "KHM",
    "CMR", "CAN", "CAF", "TCD", "CHL", "CHN", "COL", "COM", "COD", "COG",
    "CRI", "CIV", "HRV", "CUB", "CYP", "CZE", "DNK", "DJI", "DMA", "DOM",
    "ECU", "EGY", "SLV", "GNQ", "ERI", "EST", "SWZ", "ETH", "FJI", "FIN",
    "FRA", "GAB", "GMB", "GEO", "DEU", "GHA", "GRC", "GRD", "GTM", "GIN",
    "GNB", "GUY", "HTI", "HND", "HUN", "ISL", "IND", "IDN", "IRN", "IRQ",
    "IRL", "ISR", "ITA", "JAM", "JPN", "JOR", "KAZ", "KEN", "KIR", "PRK",
    "KOR", "KWT", "KGZ", "LAO", "LVA", "LBN", "LSO", "LBR", "LBY", "LIE",
    "LTU", "LUX", "MDG", "MWI", "MYS", "MDV", "MLI", "MLT", "MHL", "MRT",
    "MUS", "MEX", "FSM", "MDA", "MCO", "MNG", "MNE", "MAR", "MOZ", "MMR",
    "NAM", "NRU", "NPL", "NLD", "NZL", "NIC", "NER", "NGA", "MKD", "NOR",
    "OMN", "PAK", "PLW", "PAN", "PNG", "PRY", "PER", "PHL", "POL", "PRT",
    "QAT", "ROU", "RUS", "RWA", "KNA", "LCA", "VCT", "WSM", "SMR", "STP",
    "SAU", "SEN", "SRB", "SYC", "SLE", "SGP", "SVK", "SVN", "SLB", "SOM",
    "ZAF", "SSD", "ESP", "LKA", "SDN", "SUR", "SWE", "CHE", "SYR", "TWN",
    "TJK", "TZA", "THA", "TLS", "TGO", "TON", "TTO", "TUN", "TUR", "TKM",
    "TUV", "UGA", "UKR", "ARE", "GBR", "USA", "URY", "UZB", "VUT", "VAT",
    "VEN", "VNM", "YEM", "ZMB", "ZWE",
}


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
    # 朝向检测缓存 key（同一原始文件的预览/正式提取只检测一次朝向）
    file_hash = hashlib.sha1(content).hexdigest()[:16]

    # 基于魔数嗅探真实文件类型（扩展名/Content-Type 可能错误，例如下载链接无后缀）
    kind = _sniff_content_kind(content, filename)

    if kind == "image":
        # 图片：预处理（EXIF 旋转 + 裁白边 + 降采样）→ AI 转正 + 放大，不 OCR
        # allow_vision=True：预览也走 Vision 精判转正（与正式提取同一结果），
        # 检测结果写入缓存 + in-flight 去重——预览先到则发起检测，正式提取
        # 命中缓存零等待；两者并行时共享同一次调用，总耗时不多加
        processed, processed_image = await asyncio.to_thread(preprocess_image, content)
        oriented, orient_b64 = await ai_orient_and_enhance(processed, cache_key=file_hash, allow_vision=True)
        if orient_b64:
            processed_image = orient_b64
        # umi 引擎：按 OCR 文本框裁切预览（CamScanner 内容定位）——
        # 边缘裁边对灰底/渐变背景失效时，文本框坐标是内容位置的地面真相。
        # 代价一次全图识别（内置引擎 ~0.5s、UMI ~2s；结果进 LRU，正式提取直接复用）
        # 核显加速开启时无需 UMI 在线（内置引擎不依赖 UMI 进程）
        if settings.ocr_engine == "umi" and oriented and (
            settings.igpu_acceleration or await _check_umi_ocr_alive()
        ):
            try:
                _, p_boxes, p_size = await _call_umi_ocr(oriented, want_boxes=True)
                if p_boxes:
                    cropped = await asyncio.to_thread(_crop_by_ocr_boxes, oriented, p_boxes, p_size)
                    if cropped is not oriented:
                        processed_image = base64.b64encode(cropped).decode()
            except Exception as _pe:
                print(f"[PREVIEW] 文本框裁切预览失败（忽略，用整图预览）: {_pe}")
        method = "image"

    elif kind == "pdf":
        # PDF：先用 PyMuPDF 快速提取文字层（原生 PDF 毫秒级；扫描件瞬间返回空）
        text = await asyncio.to_thread(_extract_pdf_text_pymupdf, content)
        if not text:
            # PyMuPDF 取不到（未安装或解析异常）→ 回退 MarkItDown
            try:
                text = await asyncio.to_thread(_extract_with_markitdown, content, filename)
            except Exception:
                text = ""
        if text and len(text.strip()) >= 10:
            text_preview = text[:2000]  # 仅返回前 2000 字符预览
            method = "markitdown_text"
        # 同时渲染首页为预览图（无论有无文字层，都给用户一个可视化预览）
        # max_pages=1：预览只需首页，多页 PDF 不再全部渲染拼接，速度大幅提升
        rendered = await asyncio.to_thread(render_pdf_to_image, content, 150, 1)
        if rendered is not None:
            # AI 转正 + 放大后再作为预览（解决扫描件横放/内容过小）
            # allow_vision=True：与正式提取共享朝向检测（缓存 + in-flight 去重），预览也是转正的
            _, orient_b64 = await ai_orient_and_enhance(rendered[0], cache_key=file_hash, allow_vision=True)
            processed_image = orient_b64 or rendered[1]
        if not method:
            method = "pdf_render"
    else:
        # Office 文档：用 MarkItDown 快速取文本预览，无图像
        try:
            text = await asyncio.to_thread(_extract_with_markitdown, content, filename)
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
    # umi 通道实际使用的引擎（"gpu"=内置加速引擎 / "umi"=UMI-OCR），响应携带供前端显示
    ocr_backend = ""
    # 阶段计时：定位单文件处理慢在哪一段（[EXTRACT-TIME] 日志）
    _t0 = time.perf_counter()
    # OCR 文本框坐标（UMI 成功路径回填）：按文本区域裁图（CamScanner 内容定位）用
    boxes_out: dict = {}
    # processed_image 是否已按文本框裁切（VIZ 路径会先裁，避免重复裁切）
    _preview_box_cropped = False

    def _stage_ms(stage: str) -> None:
        line = f"[EXTRACT-TIME] {filename} {stage}: {time.perf_counter() - _t0:.2f}s (累计)"
        print(line, flush=True)
        _flog(line)
    # 朝向检测缓存 key（与 preview_document 共享，同文件只检测一次朝向）
    file_hash = hashlib.sha1(content).hexdigest()[:16]

    # 基于魔数嗅探真实文件类型（扩展名/Content-Type 可能错误）
    kind = _sniff_content_kind(content, filename)

    if kind == "image":
        # === 图片：预处理（EXIF 旋转 + 裁白边 + 降采样）→ OCR ===
        orig_len = len(content)
        content, processed_image = await asyncio.to_thread(preprocess_image, content)
        _stage_ms("预处理(EXIF/裁边/降采样)")
        # AI 自动转正 + 小图放大（扫描件常横放/内容占比小，转正放大后 OCR 更准）
        # 朝向是否调 Vision 由「AI 自动转正」开关决定（settings.vision_auto_orient）：
        # 开=Vision 精判 0/90/180/270（本地投影法分不出 180° 倒置和 90/270 方向）；
        # 关=全本地，仅高置信竖排转 90°，绝不调识图 AI。
        content, orient_b64 = await ai_orient_and_enhance(
            content, cache_key=file_hash, allow_vision=True
        )
        if orient_b64:
            processed_image = orient_b64
        _stage_ms("AI转正/放大")
        try:
            from PIL import Image as _Img
            with _Img.open(io.BytesIO(content)) as _im:
                _w, _h = _im.size
            print(f"[EXTRACT-DEBUG] image preprocess: {orig_len}B -> {len(content)}B, size={_w}x{_h}, engine={active_engine}")
        except Exception as _e:
            print(f"[EXTRACT-DEBUG] image preprocess: {orig_len}B -> {len(content)}B, dim_read_fail={_e}, engine={active_engine}")
        # boxes_out：UMI 成功时带回文本框坐标（不产生额外调用），供按文本区域裁图
        # 横躺自愈：无转正档位下粗判失手的整页图，在此兜底转角重识别（DARIA 案）
        content, text, fallback = await _ocr_sideways_rescue(content, engine, boxes_out)
        ocr_backend = _last_ocr_backend  # 实际引擎：gpu（内置加速）| umi（UMI-OCR/兜底）
        _stage_ms(f"OCR({active_engine})")
        if fallback:
            print(f"[EXTRACT-DEBUG] OCR 回退: {fallback['from']}→{fallback['to']} ({fallback['reason']})")
        # 如果发生了回退，method 反映实际使用的引擎（面板徽章如实显示，不撒谎）
        if fallback:
            method = fallback["to"]  # "umi_ocr" | "vision_ocr"
        else:
            method = "umi_ocr" if active_engine == "umi" else "vision_ocr"

    elif kind == "pdf":
        # === PDF：先用 PyMuPDF 快速提取文字层（原生数字 PDF 毫秒级） ===
        # === 文字层过短（扫描件/垃圾文字层）→ PyMuPDF 渲染为图片 → 预处理 → OCR ===
        md_error = ""
        text = await asyncio.to_thread(_extract_pdf_text_pymupdf, content)
        if not text:
            # PyMuPDF 取不到（未安装/解析异常）→ 回退 MarkItDown
            try:
                text = await asyncio.to_thread(_extract_with_markitdown, content, filename)
            except Exception as md_exc:
                text = ""
                md_error = str(md_exc)
        # 垃圾文字层守卫：扫描件 PDF 常带几个~几十个字符的噪声文字层（页眉/水印/乱码），
        # 不足以构成有效内容，必须走 OCR（护照等正常文字层通常有数百字符）
        _PDF_TEXT_LAYER_MIN = 50
        if text and len(text.strip()) >= _PDF_TEXT_LAYER_MIN:
            # 文字层有效，直接用
            method = "markitdown"
            print(f"[EXTRACT-DEBUG] PDF 文字层提取成功: {filename}, {len(text)} 字符 (MarkItDown，无需OCR)")
        else:
            # 文字层为空或为垃圾 → 渲染为图片走 OCR
            print(f"[EXTRACT-DEBUG] PDF 文字层过短（{len(text.strip()) if text else 0} 字符 < {_PDF_TEXT_LAYER_MIN}），渲染为图片走OCR: {filename}, engine={active_engine}")
            rendered = await asyncio.to_thread(render_pdf_to_image, content, 200)
            if rendered is None:
                # PyMuPDF 不可用，回退提示
                if not text:
                    raise RuntimeError(
                        "PDF 无文字层且 PyMuPDF 不可用，无法 OCR 扫描件（请安装 PyMuPDF）"
                    )
                method = "markitdown"
            else:
                content, processed_image = rendered
                # AI 自动转正 + 小图放大（扫描件常横放/内容占比小，转正放大后 OCR 更准）
                # 朝向是否调 Vision 由「AI 自动转正」开关统一决定（与图片路径一致）
                content, orient_b64 = await ai_orient_and_enhance(
                    content, cache_key=file_hash, allow_vision=True
                )
                if orient_b64:
                    processed_image = orient_b64
                ocr_text = ""
                try:
                    # 横躺自愈：无转正档位下粗判失手的整页图，在此兜底转角重识别（DARIA 案）
                    content, ocr_text, fallback = await _ocr_sideways_rescue(content, engine, boxes_out)
                    ocr_backend = _last_ocr_backend  # 实际引擎：gpu（内置加速）| umi（UMI-OCR/兜底）
                except RuntimeError:
                    if text and text.strip():
                        # OCR 双引擎都失败，但文字层尚有内容 → 用文字层兜底，不让整个提取失败
                        print(f"[EXTRACT-DEBUG] PDF OCR 失败，回退使用文字层文本（{len(text.strip())} 字符）")
                        method = "markitdown"
                        fallback = None
                    else:
                        raise
                if method != "markitdown":
                    if not ocr_text.strip() and text.strip():
                        # OCR 没识别到文字但文字层有内容 → 文字层兜底
                        print(f"[EXTRACT-DEBUG] PDF OCR 未识别到文字，回退使用文字层文本（{len(text.strip())} 字符）")
                        method = "markitdown"
                        fallback = None
                    else:
                        text = ocr_text
                        # 回退时 method 反映实际使用的引擎（徽章如实显示）
                        if fallback:
                            method = "pdf_ocr" if fallback["to"] == "vision_ocr" else "pdf_umi_ocr"
                        else:
                            method = "pdf_umi_ocr" if active_engine == "umi" else "pdf_ocr"
                        print(f"[EXTRACT-DEBUG] PDF OCR完成: {filename}, method={method}, {len(text)} 字符"
                              + (f", 回退: {fallback['from']}→{fallback['to']} ({fallback['reason']})" if fallback else ""))
                        # 记录 MarkItDown 无文字层的回退
                        if not fallback and md_error:
                            fallback = {"from": "markitdown", "to": method, "reason": f"MarkItDown 提取失败：{md_error}"}
    else:
        # === 其他文档（docx/pptx/xlsx/html）→ MarkItDown ===
        try:
            text = await asyncio.to_thread(_extract_with_markitdown, content, filename)
            method = "markitdown"
        except Exception as md_exc:
            # MarkItDown 失败：尝试用 LibreOffice 转 PDF 再 OCR（如果可用）
            raise RuntimeError(f"文档解析失败（{type(md_exc).__name__}）：{md_exc}。请确保文件格式正确或安装相应的解析库。")
        if not text:
            raise RuntimeError("文档解析未提取到文字")

    fields: dict[str, str] = {}
    mrz_warnings: list[str] = []
    mrz_fields: dict[str, str] = {}

    # 策略：MRZ优先（护照）。先尝试MRZ解析，覆盖到的字段直接用MRZ值，
    # 仅对MRZ未覆盖的目标字段才调用LLM字段提取，减少LLM调用次数、提升速度。
    _OCR_METHODS = ("vision_ocr", "pdf_ocr", "umi_ocr", "pdf_umi_ocr")
    # UMI-OCR MRZ 底部补扫：全图扫描漏行/认错时，裁底部 30% 放大 2 倍重扫并入文本
    if method in _OCR_METHODS and text:
        band_text = await _mrz_bottom_rescan(text, content, active_engine)
        if band_text:
            text = text + "\n" + band_text
        _stage_ms("MRZ底部补扫")
        # MRZ 未入画/未识别（解析不出姓名字段）→ VIZ 可视区姓名兜底：
        # 裁顶部 40% 放大重扫上半部姓名区（护照照片常被裁掉底部，姓名仍在画面上部），
        # 补扫文本并入后由本地标签提取/文本 LLM 从中取姓名
        if active_engine == "umi":
            try:
                _probe = _parse_mrz(text)
            except Exception:
                _probe = {}
            if not (_probe.get("surname") or _probe.get("given_name")):
                top_text = await _viz_top_rescan(text, content, active_engine)
                if top_text:
                    text = text + "\n" + top_text
                    _stage_ms("VIZ上半部姓名补扫")
    # MRZ解析是纯本地正则、零成本，对任何路径的文本都尝试
    # （含 markitdown 文字层——原生护照 PDF 的文字层里同样带 MRZ 两行）
    if text:
        try:
            mrz_fields = _parse_mrz(text)
        except Exception as _mrz_exc:
            print(f"[EXTRACT-WARN] MRZ 解析异常（{type(_mrz_exc).__name__}）: {_mrz_exc}")
            mrz_fields = {}
        if mrz_fields:
            print(f"[EXTRACT-DEBUG] MRZ 解析命中字段: {sorted(mrz_fields.keys())}")

    if target_fields:
        # 计算MRZ已覆盖的字段（有值即算覆盖）
        mrz_primary_fields = {"surname", "given_name", "name", "passport_no", "birth_date", "gender", "nationality", "passport_expiry"}
        mrz_covered = {k for k in target_fields if mrz_fields.get(k, "").strip()}

        # MRZ主字段直接填入
        for k in target_fields:
            if k in mrz_primary_fields and mrz_fields.get(k, "").strip():
                fields[k] = mrz_fields[k]

        # MRZ姓名清理：OCR常把MRZ两行之间的噪声粘连到名字中（如 "EKATERINAMBA78036"），
        # 当名字包含数字或异常长且无空格/<分隔时，从VIZ标签关键词重新提取干净姓名。
        # 原则：MRZ 是 ICAO 官方拉丁转写，姓名以此为准——VIZ 可视区只用来清洗粘连，
        # 其候选值若是 MRZ 值的片段（如 OBA ← DZHUMANIAZOVA）一律拒绝。
        # 阈值18：俄语姓拉丁转写常达13~17字母（DZHUMANIAZOVA/KRZHIZHANOVSKY），
        # >10 会把正常长姓误判成噪声，再从可视区抓个后缀片段反过来污染正确值
        for name_field, label_list in (
            ("surname", _LABEL_SURNAME),
            ("given_name", _LABEL_GIVEN),
        ):
            if name_field not in target_fields:
                continue
            cur = fields.get(name_field, "")
            has_digit = bool(cur) and any(c.isdigit() for c in cur)
            overlong = bool(cur) and len(cur) > 18 and " " not in cur and "<" not in cur
            if has_digit or overlong:
                upper_text = text.upper()
                clean = _extract_latin_name_after_label(upper_text, label_list)
                if not clean:
                    clean = _extract_after_label(upper_text, label_list)
                if not (clean and len(clean) < len(cur) and not any(c.isdigit() for c in clean)):
                    continue
                # 片段自检：候选值是原值的子串片段（如把 DZHUMANIAZOVA 换成其后缀 OBA）
                cand_alpha = re.sub(r"[^A-Z]", "", clean.upper())
                cur_alpha = re.sub(r"[^A-Z]", "", cur.upper())
                is_fragment = bool(
                    cand_alpha
                    and len(cur_alpha) - len(cand_alpha) >= 4
                    and cand_alpha in cur_alpha
                )
                if is_fragment:
                    if overlong and not has_digit:
                        # 原值无数字：它本来就是完整长姓，不是噪声，保留原值
                        print(f"[MRZ-NAME] {name_field}: 候选 {clean!r} 是原值 {cur!r} 的片段，保留原值", flush=True)
                        continue
                    # 原值带数字（第二行粘连）：取原值的纯字母前缀（即 MRZ 官方转写），
                    # 不接受来自可视区的片段
                    print(f"[MRZ-NAME] {name_field}: 行2粘连，取MRZ字母前缀 {cur_alpha!r}（拒绝片段 {clean!r}）", flush=True)
                    fields[name_field] = cur_alpha
                    continue
                fields[name_field] = clean
        # 重新拼接 name
        if "name" in target_fields and (fields.get("surname") or fields.get("given_name")):
            fields["name"] = f"{fields.get('surname','')} {fields.get('given_name','')}".strip()

        # 检测到护照特征时，对 VIZ 可视区专有字段（签发日期/签发机关/签发地点）
        # 直接看图提取（这些字段不在MRZ里，看图比OCR文字更可靠）。
        # 门控放宽：MRZ 整体失败（OCR 噪声导致行检测不到）时，只要文本像护照也触发。
        upper_text = text.upper()
        is_passport = bool(
            mrz_fields.get("passport_no") or mrz_fields.get("surname")
            or re.search(r"P<[A-Z]{3}", upper_text)
            or any(kw in upper_text for kw in ("PASSPORT", "PASSEPORT", "PASAPORTE", "REISEPASS", "护照"))
        )
        if is_passport and not mrz_fields and method in _OCR_METHODS:
            mrz_warnings.append(
                "识别到护照特征但 MRZ 机读区解析失败（底部两行可能被裁切/模糊），"
                "以下字段全部来自可视区兜底提取，请核对"
            )

        # 本地正则/关键词提取前置（毫秒级、零 API 调用）：
        # 标准证件/表单（标签清晰）本地就能填满全部字段 → 后面的 VIZ 看图与
        # 文本 LLM 完全不调用，OCR 出文字后结果立即返回，不再白等 AI。
        still_empty = [k for k in target_fields if not fields.get(k, "").strip()]
        if still_empty:
            local_fields = _extract_local_fields(text, still_empty)
            for k, v in local_fields.items():
                if v.strip() and not fields.get(k, "").strip():
                    fields[k] = v

        # 正则回退：对日期类字段（有效期至/签发日期），如果 MRZ/本地没提取到，
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

        # 仍未覆盖的字段：文本优先，VIZ 看图只兜底
        # （SENSENOVA 看图推理常需 1~2 分钟，而 OCR 文本里通常已有签发日期/地点——
        #   DeepSeek 文本排版几秒即回，先文本后看图，看图只在文本真没有时触发）
        already_filled = set(k for k in target_fields if fields.get(k, "").strip())
        fields_for_llm = [k for k in target_fields if k not in mrz_covered and k not in already_filled]

        # 1) DeepSeek 文本排版（快）：先把 OCR 文本里的字段抓出来
        llm_fields: dict[str, str] = {}
        if fields_for_llm:
            llm_fields = await extract_fields_from_text(text, fields_for_llm)
        for k, v in llm_fields.items():
            if v.strip() and not fields.get(k, "").strip():
                fields[k] = v

        # 2) 互补推断（本地毫秒级）：签发日/有效期只提到一个时，从全文日期中排除法推断另一个
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

        # 3) VIZ 看图兜底（分级触发）：
        #   - 默认（开关关）：仅「单字段补提」——所选引擎是 UMI-OCR 且其他字段都齐、
        #     只缺 1 项时，调识图AI只补这一项（一次调用几秒~几十秒，不拖整批；
        #     引擎设置不变，下一张卡片仍走 UMI-OCR）
        #   - 开关开：所有缺失的 VIZ 字段都看图补提（极致准确率模式，多字段慢）
        viz_targets = [
            k for k in target_fields
            if k in _VIZ_FIELDS and not fields.get(k, "").strip()
        ]
        viz_fields: dict[str, str] = {}
        if viz_targets and is_passport and not settings.vision_viz_fallback:
            if len(viz_targets) == 1 and active_engine == "umi":
                msg = f"[VIZ] UMI-OCR 其他字段齐全，仅缺「{viz_targets[0]}」→ 识图AI 单字段补提（下一张卡片仍为 UMI-OCR）"
                print(msg, flush=True)
                _flog(msg)
            else:
                msg = f"[VIZ] 看图兜底已关闭，跳过识图AI看图（缺失 {len(viz_targets)} 项: {viz_targets}）"
                print(msg, flush=True)
                _flog(msg)
                viz_targets = []

        viz_image: bytes | None = None
        if is_passport and viz_targets:
            if method in _OCR_METHODS:
                viz_image = content  # OCR 路径：content 已是预处理后的图片字节
                # CamScanner 内容定位：按 OCR 文本框联合区域裁切后再给 VIZ 看图——
                # 大图小字时 Vision 只看文本区（响应快数倍且更准），
                # 同时提取预览也换成裁切图（用户在面板里看到的就是去空白版本）
                if boxes_out.get("boxes"):
                    cropped = await asyncio.to_thread(
                        _crop_by_ocr_boxes, content, boxes_out["boxes"], boxes_out["ocr_size"]
                    )
                    if cropped is not content:
                        viz_image = cropped
                        processed_image = base64.b64encode(cropped).decode()
                        _preview_box_cropped = True
            elif method == "markitdown" and kind == "pdf":
                # 原生 PDF 文字层路径：渲染页面为图片再看图提取
                rendered = await asyncio.to_thread(render_pdf_to_image, content, 200)
                if rendered is not None:
                    viz_image = rendered[0]
                    if processed_image is None:
                        processed_image = rendered[1]

        if viz_image is not None:
            # 60 秒上限：VIZ 是兜底手段，超时跳过（字段留空 → 对比时标缺失），
            # 不让单个字段拖死整批 LOOP。SENSENOVA 正常时几秒~几十秒返回
            try:
                viz_fields = await asyncio.wait_for(
                    _extract_viz_fields_from_image(viz_image, viz_targets), timeout=60.0
                )
            except asyncio.TimeoutError:
                print(f"[VIZ-TIME] 看图兜底超时（60s），跳过字段: {viz_targets}", flush=True)
                viz_fields = {}
            for k, v in viz_fields.items():
                if v.strip() and not fields.get(k, "").strip():
                    fields[k] = v
        _stage_ms(f"文本LLM+VIZ兜底(viz={sorted(viz_fields.keys())})")

        # MRZ非主字段（如passport_expiry等扩展字段）补充——
        # 只补 target_fields 内请求的字段：调用方（LOOP 执行期）只传绑定元素，
        # 未请求的字段（如已删除的国籍/签发地）不能从 MRZ 悄悄塞回来
        for k, v in mrz_fields.items():
            if k in target_fields and v.strip() and not fields.get(k, "").strip():
                fields[k] = v

    elif not target_fields and (method in _OCR_METHODS or mrz_fields):
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

    # 统一按 OCR 文本框裁切提取预览（与 preview_document 行为一致）：
    # 跑动中预览是按文本框裁好的紧凑图，正式提取若不裁，卡片完成后面板
    # 会「放回」裁切前的大图。VIZ 路径上面已裁过（_preview_box_cropped），此处只补其余路径。
    if boxes_out.get("boxes") and method in _OCR_METHODS and not _preview_box_cropped:
        try:
            cropped = await asyncio.to_thread(
                _crop_by_ocr_boxes, content, boxes_out["boxes"], boxes_out["ocr_size"]
            )
            if cropped is not content:
                processed_image = base64.b64encode(cropped).decode()
        except Exception as _ce:
            print(f"[EXTRACT] 文本框裁切预览失败（忽略，用整图）: {_ce}", flush=True)

    # OCR 粘连修复：PaddleOCR 常把相邻两列框进同一文本块（如国籍 RUS 与姓名粘成 RUSNIKITA），
    # 在返回前统一拆分回两个字段
    _repair_stuck_nationality(fields)
    _stage_ms(f"完成(method={method})")

    return {
        "filename": filename,
        "method": method,
        "ocr_backend": ocr_backend,
        "text": text,
        "fields": fields,
        "mrz_warnings": mrz_warnings,
        "processed_image": processed_image,
        "fallback": fallback,
    }
