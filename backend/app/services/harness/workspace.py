"""COWORK STUDIO 工作区：协作任务的本地文件读写对象。

统一 HARNESS 底座后，AI 协作不再把任务派发给外部 CLI 客户端各自为战——
HARNESS 自己在工作区里产出成果文件（报告 / 代码 / 文案），
技能库与风格画像注入系统提示词，产出即交付。

安全边界：所有读写都锁在工作区目录内（拒绝 .. 与绝对路径逃逸）。
"""
from __future__ import annotations

import asyncio
import time
from pathlib import Path


class WorkspaceError(RuntimeError):
    """工作区操作失败。"""


_MAX_READ = 200_000  # 单文件读取上限（字符）
_MAX_WRITE = 2_000_000


class WorkspaceTarget:
    """一个协作任务的工作目录。"""

    def __init__(self, work_dir: str, *, label: str = "协作工作区"):
        self.root = Path(work_dir).resolve()
        self.label = label
        self.root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, rel: str) -> Path:
        rel = (rel or "").strip().replace("\\", "/")
        if not rel:
            raise WorkspaceError("文件路径为空")
        p = (self.root / rel).resolve()
        if not str(p).startswith(str(self.root)):
            raise WorkspaceError(f"路径越界（只允许工作区内）：{rel}")
        return p

    async def list_files(self) -> dict:
        def _scan() -> list[dict]:
            out = []
            for p in sorted(self.root.rglob("*")):
                if p.is_file():
                    out.append({
                        "path": str(p.relative_to(self.root)).replace("\\", "/"),
                        "bytes": p.stat().st_size,
                    })
                if len(out) >= 200:
                    break
            return out

        files = await asyncio.to_thread(_scan)
        return {"ok": True, "root": str(self.root), "files": files, "total": len(files)}

    async def read(self, rel: str) -> dict:
        p = self._resolve(rel)
        if not p.exists():
            raise WorkspaceError(f"文件不存在：{rel}")
        if p.stat().st_size > 8_000_000:
            raise WorkspaceError("文件过大（>8MB），请用更小的文件")
        text = await asyncio.to_thread(p.read_text, encoding="utf-8", errors="replace")
        truncated = len(text) > _MAX_READ
        return {"ok": True, "path": rel, "text": text[:_MAX_READ], "truncated": truncated}

    async def write(self, rel: str, text: str, *, append: bool = False) -> dict:
        if len(text) > _MAX_WRITE:
            raise WorkspaceError("单次写入过大（>2MB），请分块")
        p = self._resolve(rel)

        def _write() -> int:
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, "a" if append else "w", encoding="utf-8") as f:
                f.write(text)
            return p.stat().st_size

        size = await asyncio.to_thread(_write)
        return {"ok": True, "path": rel, "bytes": size, "appended": append}

    async def export(self, rel: str, dest: str = "") -> dict:
        """把工作区里的成果文件复制到用户可见位置（默认下载目录）。"""
        p = self._resolve(rel)
        if not p.exists():
            raise WorkspaceError(f"文件不存在：{rel}")
        if not dest:
            dl = Path.home() / "Downloads"
            base = dl if dl.is_dir() else self.root
            dest = str(base / f"{p.stem}_COWORK_{time.strftime('%H%M%S')}{p.suffix}")
        target = Path(dest)
        target.parent.mkdir(parents=True, exist_ok=True)

        def _copy() -> None:
            import shutil

            shutil.copyfile(p, target)

        await asyncio.to_thread(_copy)
        return {"ok": True, "path": str(target)}