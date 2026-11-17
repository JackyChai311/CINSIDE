"""SLIDE STUDIO 对象：用 OfficeCLI 真实操作 PPT 文件。

与 web.py / excel_book.py 同一套约定：
  * 每个方法返回 dict，失败抛 SlideError（工具层转成 {"ok": false, "error": ...}）；
  * 编辑发生在**工作副本**上，slide_export 才写回用户指定路径（默认源文件旁的 _SLIDE 副本）；
  * 所有 OfficeCLI 调用都是同步子进程，用线程池包装避免卡住事件循环。
"""
from __future__ import annotations

import asyncio
import os
import shutil
import time
from pathlib import Path

from .. import officecli


class SlideError(RuntimeError):
    """PPT 操作失败（文件不存在 / OfficeCLI 不可用 / 命令报错）。"""


def _require_officecli() -> None:
    if not officecli.is_available():
        raise SlideError("OfficeCLI 未安装：请到「设置 → 依赖」一键安装 OfficeCLI 后重试")


class SlideTarget:
    """一个 PPT 工作副本 + 它的操作原语。"""

    def __init__(self, source_path: str, *, work_dir: str, label: str = "PPT"):
        self.source_path = str(Path(source_path).resolve())
        self.label = label
        self.work_dir = work_dir
        self.work_path = ""
        self.exported_path = ""

    # ---------- 生命周期 ----------

    async def open(self) -> dict:
        _require_officecli()
        if not os.path.exists(self.source_path):
            raise SlideError(f"文件不存在：{self.source_path}")
        ext = Path(self.source_path).suffix.lower()
        if ext not in (".ppt", ".pptx"):
            raise SlideError(f"不是 PPT 文件：{self.source_path}")
        os.makedirs(self.work_dir, exist_ok=True)
        self.work_path = os.path.join(self.work_dir, f"work{ext}")
        await asyncio.to_thread(shutil.copyfile, self.source_path, self.work_path)
        return await self.summary()

    async def summary(self) -> dict:
        """页数 + 每页标题/正文摘要（给模型的初始观察）。"""
        self._require_open()
        outline = await asyncio.to_thread(officecli.view_outline, self.work_path)
        slides = _outline_slides(outline)
        text = ""
        try:
            text = await asyncio.to_thread(officecli.view_text, self.work_path)
        except Exception:  # noqa: BLE001 - 文本提取失败不阻断结构观察
            pass
        return {
            "file": os.path.basename(self.source_path),
            "slides": len(slides),
            "titles": [s.get("title") or f"第{i + 1}页" for i, s in enumerate(slides)][:60],
            "text_preview": (text or "")[:3000],
        }

    # ---------- 读取 ----------

    async def read_slide(self, slide: int) -> dict:
        """单页全部文本（含形状路径，供修改定位）。"""
        self._require_open()
        node = await asyncio.to_thread(officecli.get_node, self.work_path, f"/slide[{slide}]")
        texts: list[dict] = []
        _collect_texts(node, texts)
        return {"slide": slide, "texts": texts[:120], "total_texts": len(texts)}

    # ---------- 修改 ----------

    async def set_text(self, slide: int, path: str, text: str) -> dict:
        self._require_open()
        full = path if path.startswith("/") else f"/slide[{slide}]/{path}"
        await asyncio.to_thread(officecli.set_element, self.work_path, full, {"text": text})
        return {"ok": True, "slide": slide, "path": full}

    async def add_text(
        self, slide: int, text: str, *, x: str = "1in", y: str = "1in",
        w: str = "8in", h: str = "1in", font_size: str = "24",
    ) -> dict:
        self._require_open()
        props = {"x": x, "y": y, "w": w, "h": h, "text": text, "fontSize": font_size}
        ok = await asyncio.to_thread(
            officecli.add_element, self.work_path, f"/slide[{slide}]", "textbox", props
        )
        if not ok:
            raise SlideError(f"第 {slide} 页添加文本框失败")
        return {"ok": True, "slide": slide}

    async def add_slide(self, after: int = 0, title: str = "", body: str = "") -> dict:
        """在 after 页之后插入新页（0=最前）。返回新页页码。"""
        self._require_open()
        summary = await self.summary()
        total = int(summary.get("slides") or 0)
        pos = max(0, min(int(after), total))
        ok = await asyncio.to_thread(
            officecli.add_element, self.work_path, "/", "slide", {"index": str(pos + 1)}
        )
        if not ok:
            raise SlideError("新增幻灯片失败")
        new_no = pos + 1
        if title:
            try:
                await self.add_text(new_no, title, x="0.6in", y="0.5in", w="12in", h="1in", font_size="32")
            except SlideError:
                pass
        if body:
            try:
                await self.add_text(new_no, body, x="0.6in", y="1.8in", w="12in", h="4.5in", font_size="20")
            except SlideError:
                pass
        return {"ok": True, "slide": new_no, "total": total + 1}

    async def screenshot(self, slide: int, *, width: int = 1280, height: int = 720) -> str:
        """渲染单页为 PNG，返回文件路径（视频合成 / 视觉核对用）。"""
        self._require_open()
        os.makedirs(self.work_dir, exist_ok=True)
        out = os.path.join(self.work_dir, f"slide-{slide:03d}.png")
        await asyncio.to_thread(
            officecli.view_screenshot, self.work_path, out, page=slide, width=width, height=height
        )
        if not os.path.exists(out):
            raise SlideError(f"第 {slide} 页截图未生成")
        return out

    # ---------- 交付 ----------

    async def export(self, path: str = "") -> dict:
        self._require_open()
        await asyncio.to_thread(officecli.save_document, self.work_path)
        if not path:
            src = Path(self.source_path)
            path = str(src.with_name(f"{src.stem}_SLIDE_{time.strftime('%H%M%S')}{src.suffix}"))
        target = Path(path)
        if target.suffix.lower() not in (".ppt", ".pptx"):
            target = target.with_suffix(".pptx")
        target.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(shutil.copyfile, self.work_path, str(target))
        self.exported_path = str(target)
        return {"ok": True, "path": str(target)}

    # ---------- 内部 ----------

    def _require_open(self) -> None:
        if not self.work_path or not os.path.exists(self.work_path):
            raise SlideError("PPT 工作副本未打开")


def _outline_slides(outline: dict) -> list[dict]:
    """从 OfficeCLI outline JSON 里拿 slides 数组（兼容不同包裹层级）。"""
    if isinstance(outline, dict):
        for key in ("slides", "pages", "children"):
            v = outline.get(key)
            if isinstance(v, list):
                return [x for x in v if isinstance(x, dict)]
        data = outline.get("data")
        if isinstance(data, dict):
            return _outline_slides(data)
    return []


def _collect_texts(node: object, out: list[dict]) -> None:
    """递归收集 paragraph / table-cell 文本节点（与 ppt_service 同一约定）。"""
    if not isinstance(node, dict):
        return
    if node.get("type") in ("paragraph", "table-cell"):
        t = node.get("text", "")
        if isinstance(t, str) and t.strip():
            out.append({"path": node.get("path", ""), "text": t})
    children = node.get("children")
    if isinstance(children, list):
        for c in children:
            _collect_texts(c, out)