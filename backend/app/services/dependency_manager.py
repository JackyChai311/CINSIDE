"""依赖与外部工具管理：检测、安装 Python 包，下载安装 UMI-OCR。

职责：
1. 检测 markitdown / PyMuPDF / pillow-heif 等 Python 依赖是否可用
2. 通过 pip 一键安装缺失的 Python 包
3. 从 GitHub Release 下载 UMI-OCR 并解压到用户工具目录
4. 统一返回各依赖的安装状态供前端展示
"""
from __future__ import annotations

import importlib
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Callable

import httpx

from ..config import _USER_DATA_DIR, settings

# UMI-OCR GitHub 仓库
UMI_OCR_REPO_API = "https://api.github.com/repos/hiroi-sora/Umi-OCR/releases/latest"
# 国内镜像（蓝奏云解析不稳定，这里只作备用提示，实际下载走 GitHub）
UMI_OCR_MIRROR_URL = "https://hiroi-sora.lanzoul.com/s/umi-ocr"

# 需要检测的 Python 包：(import_name, pip_name, display_name)
PYTHON_DEPS = [
    ("markitdown", "markitdown[pdf]", "MarkItDown（Office/PDF 文档解析）"),
    ("fitz", "PyMuPDF", "PyMuPDF（PDF 渲染为图片）"),
    ("pillow_heif", "pillow-heif", "pillow-heif（HEIC/iPhone 照片解码）"),
]

# 工具安装目录（用户数据目录下）
TOOLS_DIR = _USER_DATA_DIR / "tools"
UMI_OCR_INSTALL_DIR = TOOLS_DIR / "Umi-OCR"

# 下载进度回调类型：(downloaded_bytes: int, total_bytes: int) -> None
ProgressCb = Callable[[int, int], None]


def get_tools_dir() -> Path:
    """获取（并创建）工具目录。"""
    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    return TOOLS_DIR


def check_python_dep(import_name: str) -> bool:
    """检测单个 Python 包是否可导入。"""
    try:
        importlib.import_module(import_name)
        return True
    except ImportError:
        return False


def check_all_python_deps() -> list[dict]:
    """检测所有 Python 依赖状态，返回列表。"""
    results = []
    for import_name, pip_name, display_name in PYTHON_DEPS:
        installed = check_python_dep(import_name)
        results.append({
            "key": import_name,
            "name": display_name,
            "pip_name": pip_name,
            "installed": installed,
        })
    return results


def install_python_deps(packages: list[str] | None = None) -> tuple[bool, str]:
    """通过 pip 安装指定的 Python 包。

    Args:
        packages: 要安装的 pip 包名列表。为 None 时安装所有缺失的依赖。

    Returns:
        (ok, message)
    """
    if packages is None:
        packages = [pip_name for _, pip_name, _ in PYTHON_DEPS if not check_python_dep(_)]

    if not packages:
        return True, "所有 Python 依赖已安装，无需操作。"

    # 用当前 Python 解释器执行 pip install
    cmd = [sys.executable, "-m", "pip", "install", "--upgrade", *packages]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,  # 5 分钟超时
            encoding="utf-8",
            errors="ignore",
        )
        if result.returncode == 0:
            # 验证安装
            still_missing = []
            for import_name, pip_name, display_name in PYTHON_DEPS:
                if pip_name in packages and not check_python_dep(import_name):
                    still_missing.append(display_name)
            if still_missing:
                return False, f"pip 执行成功但以下包仍无法导入：{', '.join(still_missing)}\n{result.stdout[-500:]}"
            return True, f"成功安装：{', '.join(packages)}"
        else:
            error_tail = (result.stderr or result.stdout or "")[-800:]
            return False, f"pip install 失败（退出码 {result.returncode}）：\n{error_tail}"
    except subprocess.TimeoutExpired:
        return False, "pip install 超时（5 分钟），请检查网络连接或手动执行 pip install。"
    except Exception as e:
        return False, f"执行 pip install 时出错：{e}"


def _get_umi_ocr_exe_in_dir(directory: Path) -> Path | None:
    """在指定目录中查找 Umi-OCR.exe（支持一层子目录，适配版本文件夹结构）。"""
    if not directory.is_dir():
        return None
    # 直接在目录下
    direct = directory / "Umi-OCR.exe"
    if direct.is_file():
        return direct
    # 在一层子目录中查找
    try:
        for sub in directory.iterdir():
            if sub.is_dir():
                candidate = sub / "Umi-OCR.exe"
                if candidate.is_file():
                    return candidate
    except Exception:
        pass
    return None


def check_umi_ocr_installed() -> dict:
    """检测 UMI-OCR 是否已安装（在工具目录或常见位置）。"""
    # 1. 先检查用户配置的路径
    configured = settings.umi_ocr_exe_path.strip()
    if configured and os.path.isfile(configured):
        return {"installed": True, "path": configured, "location": "configured"}

    # 2. 检查工具目录（一键下载的安装位置）
    tools_exe = _get_umi_ocr_exe_in_dir(UMI_OCR_INSTALL_DIR)
    if tools_exe:
        return {"installed": True, "path": str(tools_exe), "location": "tools"}

    # 3. 复用 document_extract 中的搜索逻辑
    try:
        from .document_extract import _find_umi_ocr_executable
        found = _find_umi_ocr_executable()
        if found:
            return {"installed": True, "path": found, "location": "system"}
    except Exception:
        pass

    return {"installed": False, "path": "", "location": "not_found"}


def _fetch_latest_umi_ocr_release() -> dict:
    """从 GitHub API 获取最新 UMI-OCR release 信息。

    返回:
        {"tag_name": ..., "assets": [{"name": ..., "browser_download_url": ..., "size": ...}, ...]}
    """
    headers = {"Accept": "application/vnd.github+json"}
    # 不带 token 也能访问公开 API（有限速 60次/小时，对单次下载足够）
    with httpx.Client(timeout=15.0, trust_env=False, follow_redirects=True) as client:
        resp = client.get(UMI_OCR_REPO_API, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    assets = []
    for a in data.get("assets", []):
        assets.append({
            "name": a.get("name", ""),
            "browser_download_url": a.get("browser_download_url", ""),
            "size": a.get("size", 0),
        })
    return {"tag_name": data.get("tag_name", ""), "assets": assets}


def _select_umi_ocr_asset(assets: list[dict]) -> dict | None:
    """从 release assets 中选择合适的 Windows 版本。

    优先级：PaddleOCR 版 .7z > RapidOCR 版 .7z > Paddle .zip > 任意 .7z > 任意 .zip
    """
    if not assets:
        return None

    # 按优先级排序：先 Paddle，再 Rapid；先 7z，再 zip
    def asset_priority(a: dict) -> tuple:
        name = a["name"].lower()
        engine_rank = 0 if "paddle" in name else (1 if "rapid" in name else 2)
        ext_rank = 0 if name.endswith(".7z") else (1 if name.endswith(".zip") else 9)
        return (engine_rank, ext_rank)

    valid = [a for a in assets if a["name"].lower().endswith((".7z", ".zip"))]
    if not valid:
        return None
    valid.sort(key=asset_priority)
    return valid[0]


def _download_file(url: str, dest: Path, progress_cb: ProgressCb | None = None) -> None:
    """流式下载文件到 dest，支持进度回调。"""
    with httpx.Client(timeout=httpx.Timeout(300.0, connect=30.0), trust_env=False, follow_redirects=True) as client:
        with client.stream("GET", url) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("content-length", 0))
            downloaded = 0
            with open(dest, "wb") as f:
                for chunk in resp.iter_bytes(chunk_size=1024 * 256):
                    f.write(chunk)
                    downloaded += len(chunk)
                    if progress_cb:
                        progress_cb(downloaded, total)


def _extract_archive(archive_path: Path, dest_dir: Path) -> None:
    """解压 .7z 或 .zip 到目标目录。"""
    suffix = archive_path.suffix.lower()

    if suffix == ".zip":
        with zipfile.ZipFile(archive_path, "r") as zf:
            zf.extractall(dest_dir)
    elif suffix == ".7z":
        # 尝试用 py7zr 解压
        try:
            import py7zr
            with py7zr.SevenZipFile(archive_path, mode="r") as z:
                z.extractall(path=str(dest_dir))
        except ImportError:
            # py7zr 未安装 → 先安装它再重试
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "py7zr"],
                capture_output=True,
                timeout=120,
                check=True,
            )
            import py7zr
            with py7zr.SevenZipFile(archive_path, mode="r") as z:
                z.extractall(path=str(dest_dir))
    else:
        raise RuntimeError(f"不支持的压缩格式：{suffix}")


def download_and_install_umi_ocr(progress_cb: ProgressCb | None = None) -> tuple[bool, str, str]:
    """下载并安装最新版 UMI-OCR 到工具目录。

    流程：
    1. 查询 GitHub 最新 release
    2. 选择合适的 Windows 安装包（PaddleOCR .7z）
    3. 下载到临时文件
    4. 解压到 TOOLS_DIR / Umi-OCR
    5. 验证 Umi-OCR.exe 存在
    6. 自动更新配置路径

    Returns:
        (ok, message, exe_path)
    """
    try:
        # 1. 获取最新版本信息
        if progress_cb:
            progress_cb(0, 0)
        release_info = _fetch_latest_umi_ocr_release()
        tag = release_info["tag_name"]
        asset = _select_umi_ocr_asset(release_info["assets"])

        if not asset:
            return False, (
                "未找到可用的 UMI-OCR Windows 安装包。\n"
                f"请手动前往下载：{UMI_OCR_MIRROR_URL}（国内蓝奏云）\n"
                "或 GitHub Releases 页面下载后解压。"
            ), ""

        asset_name = asset["name"]
        download_url = asset["browser_download_url"]
        size_mb = asset["size"] / (1024 * 1024)

        # 2. 准备目录
        get_tools_dir()
        # 清理旧的安装目录（如果存在）
        if UMI_OCR_INSTALL_DIR.exists():
            shutil.rmtree(UMI_OCR_INSTALL_DIR, ignore_errors=True)
        UMI_OCR_INSTALL_DIR.mkdir(parents=True, exist_ok=True)

        # 3. 下载
        archive_path = TOOLS_DIR / asset_name
        _download_file(download_url, archive_path, progress_cb)

        # 4. 解压
        _extract_archive(archive_path, UMI_OCR_INSTALL_DIR)

        # 5. 清理压缩包
        try:
            archive_path.unlink()
        except Exception:
            pass

        # 6. 查找解压后的 exe
        exe_path = _get_umi_ocr_exe_in_dir(UMI_OCR_INSTALL_DIR)
        if not exe_path:
            # 解压后可能多嵌套了一层目录，尝试搜索
            for item in UMI_OCR_INSTALL_DIR.rdir("Umi-OCR.exe"):
                exe_path = item
                break

        if not exe_path:
            return False, (
                f"UMI-OCR {tag} 下载解压完成，但未找到 Umi-OCR.exe。\n"
                f"解压目录：{UMI_OCR_INSTALL_DIR}\n"
                "请手动检查目录结构。"
            ), ""

        exe_str = str(exe_path)

        # 7. 自动更新配置
        settings.update_from_dict({"umi_ocr_exe_path": exe_str})
        try:
            settings.persist()
        except Exception:
            pass

        return True, (
            f"UMI-OCR {tag} 下载安装成功！\n"
            f"安装位置：{exe_str}\n"
            f"文件大小：{size_mb:.1f} MB\n"
            "路径已自动保存到设置。使用前请确保在 UMI-OCR 中开启「HTTP接口服务」（默认端口 1224）。"
        ), exe_str

    except httpx.HTTPStatusError as e:
        return False, f"下载失败（HTTP {e.response.status_code}）：{e}\n请检查网络连接，或手动从蓝奏云下载：{UMI_OCR_MIRROR_URL}", ""
    except httpx.RequestError as e:
        return False, f"网络请求失败：{e}\n如果无法访问 GitHub，可手动从蓝奏云下载：{UMI_OCR_MIRROR_URL}", ""
    except Exception as e:
        return False, f"下载安装 UMI-OCR 时出错：{e}", ""


def get_all_deps_status() -> dict:
    """返回所有依赖和工具的综合状态（供前端一次请求获取）。"""
    python_deps = check_all_python_deps()
    umi_ocr = check_umi_ocr_installed()

    python_all_installed = all(d["installed"] for d in python_deps)
    umi_online = False

    # 快速检测 UMI-OCR HTTP 服务是否在线
    if umi_ocr["installed"]:
        try:
            import asyncio
            from .document_extract import _check_umi_ocr_alive
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    # 在已有事件循环中不能直接 run_until_complete，返回 False 让前端单独检测
                    umi_online = False
                else:
                    umi_online = loop.run_until_complete(_check_umi_ocr_alive())
            except RuntimeError:
                # 没有事件循环，创建一个
                umi_online = asyncio.run(_check_umi_ocr_alive())
        except Exception:
            umi_online = False

    return {
        "python_deps": python_deps,
        "python_all_installed": python_all_installed,
        "umi_ocr": {
            **umi_ocr,
            "service_online": umi_online,
        },
        "tools_dir": str(TOOLS_DIR),
    }
