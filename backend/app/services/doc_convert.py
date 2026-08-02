"""文件格式转换 + 压缩到目标大小（供文件处理面板「导出」使用）。

能力：
- 图片 ↔ 图片：JPG/PNG 互转，迭代降质量/缩尺寸直到 ≤ 目标大小
- 图片 → PDF：单页 PDF 输出（Pillow）
- PDF → 图片：渲染第一页（PyMuPDF）
- PDF → PDF：重渲染压缩（扫描件场景：DPI 降级 + JPEG 质量降级）

依赖（fitz / PIL）采用懒加载：只在真正调用对应格式转换时才 import，
缺失时抛清晰的 RuntimeError，不影响其他不使用本模块的路由（如 Excel 上传）。
"""
from __future__ import annotations

import base64
import io
from dataclasses import dataclass, field

SUPPORTED_FORMATS = {"jpg", "png", "pdf", "original"}


def _require_pil():
    try:
        from PIL import Image
    except ImportError as e:
        raise RuntimeError("缺少依赖 Pillow，请执行: pip install Pillow") from e
    return Image


def _require_fitz():
    try:
        import fitz  # PyMuPDF
    except ImportError as e:
        raise RuntimeError("缺少依赖 PyMuPDF，请执行: pip install PyMuPDF") from e
    return fitz


@dataclass
class ConvertResult:
    data_b64: str
    mime: str
    ext: str
    size: int               # 输出字节数
    width: int = 0
    height: int = 0
    reached: bool = True    # 是否压到目标大小以内
    note: str = ""
    pages: int = 1
    warnings: list[str] = field(default_factory=list)


def _is_pdf(filename: str, content: bytes) -> bool:
    return filename.lower().endswith(".pdf") or content[:5] == b"%PDF-"


def _open_image(content: bytes):
    Image = _require_pil()
    img = Image.open(io.BytesIO(content))
    img.load()
    return img


def _flatten(img, bg=(255, 255, 255)):
    """JPG/PDF 不支持透明通道，铺白底。"""
    Image = _require_pil()
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        base = Image.new("RGB", img.size, bg)
        base.paste(img, mask=img.split()[-1])
        return base
    if img.mode != "RGB":
        return img.convert("RGB")
    return img


def _save_jpg(img, quality: int) -> bytes:
    buf = io.BytesIO()
    _flatten(img).save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
    return buf.getvalue()


def _save_png(img) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _shrink(img, ratio: float):
    w, h = img.size
    Image = _require_pil()
    return img.resize((max(1, int(w * ratio)), max(1, int(h * ratio))), Image.LANCZOS)


def _compress_image_to_target(img, fmt: str, target_bytes: int):
    """迭代压缩图片到目标大小：先降质量（仅 JPG），再缩尺寸。"""
    cur = img
    quality_steps = [85, 75, 65, 55, 45, 35, 28, 22]
    shrink_rounds = 12

    if fmt == "png":
        data = _save_png(cur)
        if len(data) <= target_bytes:
            return data, cur, True
        for _ in range(shrink_rounds):
            cur = _shrink(cur, 0.85)
            if max(cur.size) < 600:
                break
            data = _save_png(cur)
            if len(data) <= target_bytes:
                return data, cur, True
        return data, cur, len(data) <= target_bytes

    # jpg：先纯降质量
    for q in quality_steps:
        data = _save_jpg(cur, q)
        if len(data) <= target_bytes:
            return data, cur, True
    # 再缩尺寸 + 降质量
    for _ in range(shrink_rounds):
        cur = _shrink(cur, 0.85)
        if max(cur.size) < 500:
            break
        for q in (55, 40, 28):
            data = _save_jpg(cur, q)
            if len(data) <= target_bytes:
                return data, cur, True
    return data, cur, len(data) <= target_bytes


def _pdf_first_page_image(doc, dpi: int = 200):
    Image = _require_pil()
    page = doc.load_page(0)
    pix = page.get_pixmap(dpi=dpi)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def _pdf_pages_to_pdf(doc, dpi: int, quality: int) -> bytes:
    """把 PDF 每页重渲染为 JPEG 后合成新 PDF（扫描件压缩）。"""
    fitz = _require_fitz()
    out = fitz.open()
    for i in range(len(doc)):
        pix = doc.load_page(i).get_pixmap(dpi=dpi)
        Image = _require_pil()
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        jpg = _save_jpg(img, quality)
        rect = doc.load_page(i).rect
        new_page = out.new_page(width=rect.width, height=rect.height)
        new_page.insert_image(rect, stream=jpg)
    buf = io.BytesIO()
    out.save(buf, garbage=4, deflate=True)
    out.close()
    return buf.getvalue()


def _compress_pdf_to_target(doc, target_bytes: int) -> tuple[bytes, bool]:
    # 先试无损优化
    buf = io.BytesIO()
    doc.save(buf, garbage=4, deflate=True, clean=True)
    data = buf.getvalue()
    if len(data) <= target_bytes:
        return data, True
    # 重渲染：DPI 与质量逐级下降
    for dpi, quality in [(200, 70), (170, 60), (150, 50), (130, 45), (110, 40), (90, 35)]:
        data = _pdf_pages_to_pdf(doc, dpi, quality)
        if len(data) <= target_bytes:
            return data, True
    return data, len(data) <= target_bytes


def convert_document(
    content: bytes,
    filename: str,
    target_format: str = "original",
    target_kb: int = 0,
) -> ConvertResult:
    """主入口：格式转换 + 可选压缩到 target_kb（0=不限制大小）。"""
    fmt = (target_format or "original").lower()
    if fmt == "jpeg":
        fmt = "jpg"
    if fmt not in SUPPORTED_FORMATS:
        raise ValueError(f"不支持的格式: {target_format}")

    target_bytes = max(0, int(target_kb)) * 1024
    src_is_pdf = _is_pdf(filename, content)
    warnings: list[str] = []

    # 不转格式且不压缩 → 原样返回（不需要 Pillow/PyMuPDF）
    if fmt == "original" and target_bytes <= 0:
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
        mime = "application/pdf" if src_is_pdf else f"image/{ext}"
        return ConvertResult(base64.b64encode(content).decode(), mime, ext, len(content))

    out_fmt = fmt
    if fmt == "original":
        out_fmt = "pdf" if src_is_pdf else "jpg"

    # ============ PDF 输入 ============
    if src_is_pdf:
        fitz = _require_fitz()
        doc = fitz.open(stream=content, filetype="pdf")
        try:
            pages = len(doc)
            if out_fmt == "pdf":
                if target_bytes > 0 and len(content) > target_bytes:
                    data, reached = _compress_pdf_to_target(doc, target_bytes)
                else:
                    buf = io.BytesIO()
                    doc.save(buf, garbage=4, deflate=True)
                    data, reached = buf.getvalue(), True
                return ConvertResult(
                    base64.b64encode(data).decode(), "application/pdf", "pdf",
                    len(data), reached=reached, pages=pages,
                    note="PDF 已优化" if reached else "已压到极限仍超目标大小",
                    warnings=[] if reached else ["无法压到目标大小，已输出最小体积"],
                )
            # PDF → 图片（第一页）
            if pages > 1:
                warnings.append(f"PDF 共 {pages} 页，仅导出第 1 页")
            img = _pdf_first_page_image(doc)
        finally:
            doc.close()
        if target_bytes > 0:
            data, img, reached = _compress_image_to_target(img, out_fmt, target_bytes)
        else:
            data = _save_jpg(img, 88) if out_fmt == "jpg" else _save_png(img)
            reached = True
        w, h = img.size
        return ConvertResult(
            base64.b64encode(data).decode(),
            "image/jpeg" if out_fmt == "jpg" else "image/png",
            out_fmt, len(data), w, h, reached,
            warnings=warnings + ([] if reached else ["无法压到目标大小，已输出最小体积"]),
        )

    # ============ 图片输入 ============
    try:
        img = _open_image(content)
    except Exception as e:
        raise ValueError(f"无法识别的文件类型: {e}")

    if out_fmt == "pdf":
        # 图片 → PDF：如需压缩，先压成 JPG 再嵌入
        if target_bytes > 0:
            jpg, img2, _ = _compress_image_to_target(_flatten(img), "jpg", max(target_bytes - 4096, 20 * 1024))
            Image = _require_pil()
            page_img = Image.open(io.BytesIO(jpg))
        else:
            page_img = _flatten(img)
        buf = io.BytesIO()
        page_img.convert("RGB").save(buf, "PDF", resolution=150.0)
        data = buf.getvalue()
        reached = target_bytes <= 0 or len(data) <= target_bytes
        w, h = page_img.size
        return ConvertResult(
            base64.b64encode(data).decode(), "application/pdf", "pdf",
            len(data), w, h, reached,
            warnings=[] if reached else ["无法压到目标大小，已输出最小体积"],
        )

    if target_bytes > 0:
        data, img, reached = _compress_image_to_target(img, out_fmt, target_bytes)
    else:
        data = _save_jpg(_flatten(img), 90) if out_fmt == "jpg" else _save_png(img)
        reached = True
    w, h = img.size
    return ConvertResult(
        base64.b64encode(data).decode(),
        "image/jpeg" if out_fmt == "jpg" else "image/png",
        out_fmt, len(data), w, h, reached,
        warnings=[] if reached else ["无法压到目标大小，已输出最小体积"],
    )
