"""OfficeCLI Python 子进程封装。

通过 subprocess 调用 @officecli/officecli 的原生二进制，
实现 PPT/Word/Excel 文档的读取、修改、创建等操作。

开发环境：frontend/node_modules/@officecli/officecli/vendor/officecli.exe
打包环境：resources/officecli/officecli.exe（通过 electron-builder extraResources 分发）
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

# ---- 二进制路径查找 ----

_BIN_CACHE: str | None = None


def _get_resource_path(relative: str) -> Path:
    """兼容 PyInstaller 打包和开发环境的资源路径。"""
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
        # onedir 模式：exe 同级目录的 resources
        candidate = Path(sys.executable).resolve().parent / "resources" / relative
        if candidate.exists():
            return candidate
        return base / relative
    # 开发环境：backend/app/services/ -> 项目根目录
    return Path(__file__).resolve().parent.parent.parent.parent / relative


def _get_user_tools_dir() -> Path:
    """获取用户数据目录下的 tools 文件夹（一键下载安装位置）。"""
    from ..config import _USER_DATA_DIR
    return _USER_DATA_DIR / "tools"


def _find_officecli_bin() -> str | None:
    """查找 officecli 可执行文件路径。"""
    global _BIN_CACHE
    if _BIN_CACHE:
        return _BIN_CACHE

    # Windows 上是 .exe，其他平台无后缀
    exe_name = "officecli.exe" if sys.platform == "win32" else "officecli"

    candidates: list[Path] = [
        # 开发环境：frontend/node_modules
        _get_resource_path(f"frontend/node_modules/@officecli/officecli/vendor/{exe_name}"),
        # 用户工具目录（一键下载安装位置）
        _get_user_tools_dir() / "officecli" / "node_modules" / "@officecli" / "officecli" / "vendor" / exe_name,
        # 打包环境：resources/officecli/（backend exe 在 resources/backend/ 下，上一级即 resources/）
        Path(sys.executable).resolve().parent.parent / "officecli" / exe_name,
        # PyInstaller 临时目录
        Path(getattr(sys, "_MEIPASS", "")) / "officecli" / exe_name,
    ]

    for c in candidates:
        if c.exists():
            _BIN_CACHE = str(c)
            return _BIN_CACHE

    # 尝试 PATH
    path_bin = shutil.which("officecli")
    if path_bin:
        _BIN_CACHE = path_bin
        return _BIN_CACHE

    return None


def is_available() -> bool:
    """检查 OfficeCLI 是否可用。"""
    return _find_officecli_bin() is not None


def get_status() -> dict[str, Any]:
    """获取 OfficeCLI 状态信息。"""
    bin_path = _find_officecli_bin()
    return {
        "available": bin_path is not None,
        "bin_path": bin_path,
        "version": _get_version() if bin_path else None,
    }


def _get_version() -> str | None:
    try:
        result = _run(["--version"], timeout=10)
        return result.stdout.strip() or None
    except Exception:
        return None


# ---- 核心子进程执行 ----

def _run(
    args: list[str],
    *,
    timeout: int = 60,
    cwd: str | None = None,
) -> subprocess.CompletedProcess:
    """执行 officecli 命令。"""
    bin_path = _find_officecli_bin()
    if not bin_path:
        raise RuntimeError("OfficeCLI 不可用，请先安装 @officecli/officecli")

    cmd = [bin_path] + args
    # Windows 上隐藏控制台窗口
    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.CREATE_NO_WINDOW

    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        cwd=cwd,
        creationflags=creationflags,
    )


def _run_json(args: list[str], *, timeout: int = 60) -> dict[str, Any]:
    """执行 officecli 命令并解析 JSON 输出。"""
    result = _run(args, timeout=timeout)
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"OfficeCLI 命令失败: {err[:500]}")
    stdout = result.stdout.strip()
    if not stdout:
        return {}
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        # 某些命令可能在 JSON 前有日志输出，尝试提取第一个 { 或 [
        for i, ch in enumerate(stdout):
            if ch in "{[":
                try:
                    return json.loads(stdout[i:])
                except json.JSONDecodeError:
                    break
        raise RuntimeError(f"OfficeCLI 输出不是有效 JSON: {stdout[:300]}")


# ---- 文档操作封装 ----

def view_outline(file_path: str) -> dict[str, Any]:
    """获取文档大纲（PPT 返回 slides 列表）。"""
    return _run_json(["view", file_path, "outline", "--json"], timeout=30)


def view_text(file_path: str) -> str:
    """获取文档纯文本内容。"""
    result = _run(["view", file_path, "text"], timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"读取文本失败: {(result.stderr or '').strip()[:300]}")
    return result.stdout


def get_node(file_path: str, path: str) -> dict[str, Any]:
    """获取文档节点 JSON（支持 XPath 风格路径如 /slide[1]）。"""
    return _run_json(["get", file_path, path, "--json"], timeout=30)


def view_html(file_path: str, output_path: str | None = None) -> str:
    """渲染文档为 HTML。"""
    args = ["view", file_path, "html"]
    if output_path:
        args.extend(["-o", output_path])
    result = _run(args, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"HTML 渲染失败: {(result.stderr or '').strip()[:300]}")
    if output_path:
        return output_path
    return result.stdout


def view_screenshot(
    file_path: str,
    output_path: str,
    *,
    page: int | None = None,
    width: int = 1600,
    height: int = 1200,
) -> str:
    """渲染文档截图为 PNG。"""
    args = [
        "view", file_path, "screenshot",
        "-o", output_path,
        "--screenshot-width", str(width),
        "--screenshot-height", str(height),
    ]
    if page is not None:
        args.extend(["--page", str(page)])
    result = _run(args, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"截图失败: {(result.stderr or '').strip()[:300]}")
    return output_path


def create_document(file_path: str, doc_type: str = "pptx") -> bool:
    """创建空白文档。doc_type: pptx/docx/xlsx。"""
    result = _run(["create", file_path], timeout=15)
    return result.returncode == 0


def add_element(
    file_path: str,
    parent: str,
    element_type: str,
    props: dict[str, str] | None = None,
) -> bool:
    """添加元素到文档。"""
    args = ["add", file_path, parent, "--type", element_type]
    if props:
        for k, v in props.items():
            args.extend(["--prop", f"{k}={v}"])
    result = _run(args, timeout=15)
    return result.returncode == 0


def set_element(
    file_path: str,
    path: str,
    props: dict[str, str],
) -> bool:
    """设置元素属性。"""
    args = ["set", file_path, path]
    for k, v in props.items():
        args.extend(["--prop", f"{k}={v}"])
    result = _run(args, timeout=15)
    if result.returncode != 0:
        err = (result.stderr or "").strip()
        raise RuntimeError(f"set_element 失败 {path}: {err[:300]}")
    return True


def dump_element(file_path: str, path: str) -> list[dict[str, Any]]:
    """序列化文档子树为可重放的 batch 命令列表。"""
    result = _run(["dump", file_path, path], timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"dump 失败 {path}: {(result.stderr or '').strip()[:300]}")
    stdout = result.stdout.strip()
    if not stdout:
        return []
    try:
        data = json.loads(stdout)
        if isinstance(data, list):
            return data
        return []
    except json.JSONDecodeError:
        return []


def apply_batch(file_path: str, commands: list[dict[str, Any]]) -> bool:
    """从 JSON 命令列表执行批量操作。

    命令格式（OfficeCLI 原生 batch 格式）：
    [
      {"command": "add", "parent": "/slide[1]", "type": "shape", "props": {"text": "Hi"}},
      {"command": "set", "path": "/slide[1]/shape[1]", "props": {"bold": "true"}}
    ]
    """
    import tempfile
    tmp = Path(tempfile.gettempdir()) / f"cinside-batch-{os.getpid()}.json"
    try:
        tmp.write_text(json.dumps(commands, ensure_ascii=False), encoding="utf-8")
        result = _run(
            ["batch", file_path, "--input", str(tmp)],
            timeout=180,
        )
        if result.returncode != 0:
            err = (result.stderr or result.stdout or "").strip()
            raise RuntimeError(f"batch 执行失败: {err[:500]}")
        return True
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass


def save_document(file_path: str) -> bool:
    """将内存中的修改刷写到磁盘。"""
    result = _run(["save", file_path], timeout=15)
    return result.returncode == 0


def close_document(file_path: str) -> bool:
    """关闭文档驻留进程并刷写磁盘。"""
    result = _run(["close", file_path], timeout=15)
    return result.returncode == 0
