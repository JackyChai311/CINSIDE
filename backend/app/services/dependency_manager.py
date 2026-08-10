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

# GitHub 下载加速镜像（国内回退用），按顺序尝试
_GITHUB_MIRRORS = [
    "https://ghfast.top/",
    "https://gh-proxy.com/",
    "https://ghproxy.net/",
    "https://gh.llkk.cc/",
    "https://mirror.ghproxy.com/",
]

# 已知最新版本（API 完全不可用时的兜底）
_KNOWN_LATEST_TAG = "v2.1.5"
_KNOWN_LATEST_ASSETS = [
    {"name": "Umi-OCR_Paddle_v2.1.5.7z.exe", "size": 134293725},
    {"name": "Umi-OCR_Rapid_v2.1.5.7z.exe", "size": 130000000},
]

# 需要检测的 Python 包：(import_name, pip_name, display_name)
PYTHON_DEPS = [
    ("markitdown", "markitdown[pdf]", "MarkItDown（Office/PDF 文档解析）"),
    ("fitz", "PyMuPDF", "PyMuPDF（PDF 渲染为图片）"),
    ("pillow_heif", "pillow-heif", "pillow-heif（HEIC/iPhone 照片解码）"),
]

# 工具安装目录（用户数据目录下）
TOOLS_DIR = _USER_DATA_DIR / "tools"
UMI_OCR_INSTALL_DIR = TOOLS_DIR / "Umi-OCR"

# Remotion 视频渲染工具（npm 包，安装在独立目录）
REMOTION_INSTALL_DIR = TOOLS_DIR / "remotion"
REMOTION_PACKAGES = [
    "remotion",
    "@remotion/cli",
    "@remotion/renderer",
    "@remotion/bundler",
    "react",
    "react-dom",
]
REMOTION_MARKER_FILE = REMOTION_INSTALL_DIR / "node_modules" / "remotion" / "package.json"

# OfficeCLI 文档操作工具（npm 包 @officecli/officecli，安装在独立目录）
OFFICECLI_INSTALL_DIR = TOOLS_DIR / "officecli"
OFFICECLI_PACKAGE = "@officecli/officecli"
OFFICECLI_MARKER_FILE = (
    OFFICECLI_INSTALL_DIR / "node_modules" / "@officecli" / "officecli" / "package.json"
)

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

    API 失败时回退到内置已知版本信息，保证一键下载始终可用。

    返回:
        {"tag_name": ..., "assets": [{"name": ..., "browser_download_url": ..., "size": ...}, ...]}
    """
    headers = {"Accept": "application/vnd.github+json"}
    try:
        with httpx.Client(timeout=15.0, trust_env=True, follow_redirects=True) as client:
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
        if assets:
            return {"tag_name": data.get("tag_name", ""), "assets": assets}
    except Exception:
        pass

    # 兜底：使用内置已知版本构造 release 信息
    tag = _KNOWN_LATEST_TAG
    base = f"https://github.com/hiroi-sora/Umi-OCR/releases/download/{tag}"
    assets = []
    for a in _KNOWN_LATEST_ASSETS:
        assets.append({
            "name": a["name"],
            "browser_download_url": f"{base}/{a['name']}",
            "size": a.get("size", 0),
        })
    return {"tag_name": tag, "assets": assets}


def _build_download_candidates(github_url: str) -> list[tuple[str, str]]:
    """根据 GitHub 直链构造所有候选下载地址（直连 + 镜像）。

    Returns:
        [(label, url), ...]，按优先级排列。
    """
    candidates: list[tuple[str, str]] = [("GitHub 直连", github_url)]
    for mirror in _GITHUB_MIRRORS:
        candidates.append((f"镜像 {mirror}", mirror.rstrip("/") + "/" + github_url))
    return candidates


def _is_windows_asset(name: str) -> bool:
    """判断文件名是否为 Windows 可下载的压缩包（.7z / .7z.exe / .zip）。"""
    lower = name.lower()
    # 排除明确的非 Windows / 非桌面平台文件
    excludes = ("linux", "mac", "darwin", ".deb", ".rpm", ".appimage", ".dmg", "arm64", "aarch64")
    if any(x in lower for x in excludes):
        return False
    return lower.endswith((".7z", ".7z.exe", ".zip"))


def _asset_ext_rank(name: str) -> int:
    """扩展名优先级：7z(含自解压) > zip。"""
    lower = name.lower()
    if lower.endswith(".7z") or lower.endswith(".7z.exe"):
        return 0
    if lower.endswith(".zip"):
        return 1
    return 9


def _select_umi_ocr_asset(assets: list[dict]) -> dict | None:
    """从 release assets 中选择合适的 Windows 版本。

    优先级：PaddleOCR 版 > RapidOCR 版；7z（含 .7z.exe 自解压）> zip。
    """
    if not assets:
        return None

    def asset_priority(a: dict) -> tuple:
        name = a["name"].lower()
        engine_rank = 0 if "paddle" in name else (1 if "rapid" in name else 2)
        return (engine_rank, _asset_ext_rank(name))

    valid = [a for a in assets if _is_windows_asset(a["name"])]
    if not valid:
        return None
    valid.sort(key=asset_priority)
    return valid[0]


def _download_file(url: str, dest: Path, progress_cb: ProgressCb | None = None) -> None:
    """流式下载文件到 dest，支持进度回调。"""
    with httpx.Client(timeout=httpx.Timeout(300.0, connect=30.0), trust_env=True, follow_redirects=True) as client:
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


def _download_with_fallback(
    candidates: list[tuple[str, str]],
    dest: Path,
    progress_cb: ProgressCb | None = None,
) -> str:
    """依次尝试候选下载地址，第一个成功即返回。

    Returns:
        成功使用的候选标签。
    Raises:
        RuntimeError: 所有候选均失败。
    """
    errors: list[str] = []
    for label, url in candidates:
        try:
            _download_file(url, dest, progress_cb)
            # 校验下载的文件非空且大于 1MB（正常安装包约 130MB）
            if dest.exists() and dest.stat().st_size > 1024 * 1024:
                return label
            errors.append(f"{label}：下载文件过小或为空")
            if dest.exists():
                dest.unlink(missing_ok=True)
        except Exception as e:
            errors.append(f"{label}：{e}")
            if dest.exists():
                dest.unlink(missing_ok=True)
    raise RuntimeError("所有下载通道均失败：\n" + "\n".join(errors))


def _try_silent_sfx_extract(sfx_path: Path, dest_dir: Path) -> bool:
    """尝试以静默方式运行 .7z.exe 自解压包。返回是否成功。"""
    if os.name != "nt":
        return False
    try:
        result = subprocess.run(
            [str(sfx_path), "-y", f"-o{dest_dir}"],
            cwd=str(sfx_path.parent),
            capture_output=True,
            timeout=180,
        )
        if result.returncode == 0:
            # 验证是否真的解压出了内容
            if any(dest_dir.iterdir()):
                return True
    except Exception:
        pass
    return False


def _extract_7z_via_py7zr(archive_path: Path, dest_dir: Path) -> None:
    """用 py7zr 解压 .7z 文件（自动处理自解压 .7z.exe 的签名偏移）。"""
    try:
        import py7zr
    except ImportError:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "py7zr"],
            capture_output=True,
            timeout=120,
            check=True,
        )
        import py7zr

    file_name = archive_path.name.lower()
    is_sfx = file_name.endswith(".7z.exe")

    if is_sfx:
        # 自解压包：7z 数据前有一段 PE 引导程序，需要定位 7z 魔数
        # 7z 签名: 37 7A BC AF 27 1C
        sig = b"\x37\x7a\xbc\xaf\x27\x1c"
        with open(archive_path, "rb") as f:
            data = f.read()
        idx = data.find(sig)
        if idx < 0:
            raise RuntimeError("自解压包中未找到 7z 签名，无法解压")
        # 复制一份纯 .7z 文件到临时位置
        pure_7z = archive_path.with_suffix(".sfx.7z")
        try:
            with open(pure_7z, "wb") as f:
                f.write(data[idx:])
            with py7zr.SevenZipFile(pure_7z, mode="r") as z:
                z.extractall(path=str(dest_dir))
        finally:
            pure_7z.unlink(missing_ok=True)
    else:
        with py7zr.SevenZipFile(archive_path, mode="r") as z:
            z.extractall(path=str(dest_dir))


def _extract_archive(archive_path: Path, dest_dir: Path) -> None:
    """解压 .7z / .7z.exe（自解压）/ .zip 到目标目录。"""
    file_name = archive_path.name.lower()

    if file_name.endswith(".zip"):
        with zipfile.ZipFile(archive_path, "r") as zf:
            zf.extractall(dest_dir)
        return

    if file_name.endswith(".7z") or file_name.endswith(".7z.exe"):
        # 对于 .7z.exe：优先静默运行自解压（最可靠），失败则用 py7zr 解析
        if file_name.endswith(".7z.exe"):
            if _try_silent_sfx_extract(archive_path, dest_dir):
                return
        _extract_7z_via_py7zr(archive_path, dest_dir)
        return

    raise RuntimeError(f"不支持的压缩格式：{archive_path.suffix}")


def download_and_install_umi_ocr(progress_cb: ProgressCb | None = None) -> tuple[bool, str, str]:
    """下载并安装最新版 UMI-OCR 到工具目录。

    流程：
    1. 查询 GitHub 最新 release（API 失败时用内置已知版本兜底）
    2. 选择合适的 Windows 安装包（PaddleOCR，.7z.exe 自解压优先）
    3. 依次尝试 GitHub 直连 + 多个国内加速镜像下载
    4. 静默自解压（失败则用 py7zr 解析）到 TOOLS_DIR / Umi-OCR
    5. 验证 Umi-OCR.exe 存在
    6. 自动更新配置路径

    Returns:
        (ok, message, exe_path)
    """
    try:
        # 1. 获取最新版本信息（API 失败自动回退到内置已知版本）
        if progress_cb:
            progress_cb(0, 0)
        release_info = _fetch_latest_umi_ocr_release()
        tag = release_info["tag_name"]
        asset = _select_umi_ocr_asset(release_info["assets"])

        if not asset:
            # 即使筛选失败，也用已知版本兜底
            tag = _KNOWN_LATEST_TAG
            base = f"https://github.com/hiroi-sora/Umi-OCR/releases/download/{tag}"
            asset = {
                "name": _KNOWN_LATEST_ASSETS[0]["name"],
                "browser_download_url": f"{base}/{_KNOWN_LATEST_ASSETS[0]['name']}",
                "size": _KNOWN_LATEST_ASSETS[0]["size"],
            }

        asset_name = asset["name"]
        download_url = asset["browser_download_url"]
        size_mb = asset.get("size", 0) / (1024 * 1024)

        # 2. 准备目录
        get_tools_dir()
        if UMI_OCR_INSTALL_DIR.exists():
            shutil.rmtree(UMI_OCR_INSTALL_DIR, ignore_errors=True)
        UMI_OCR_INSTALL_DIR.mkdir(parents=True, exist_ok=True)

        # 3. 构造所有候选下载地址（直连 + 镜像），依次尝试
        candidates = _build_download_candidates(download_url)
        archive_path = TOOLS_DIR / asset_name
        used_label = _download_with_fallback(candidates, archive_path, progress_cb)

        # 4. 解压
        _extract_archive(archive_path, UMI_OCR_INSTALL_DIR)

        # 5. 清理压缩包
        try:
            archive_path.unlink()
        except Exception:
            pass

        # 6. 查找解压后的 exe（支持多层嵌套目录）
        exe_path = _get_umi_ocr_exe_in_dir(UMI_OCR_INSTALL_DIR)
        if not exe_path:
            for item in UMI_OCR_INSTALL_DIR.rglob("Umi-OCR.exe"):
                if item.is_file():
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

        size_info = f"（约 {size_mb:.0f} MB，通过{used_label}下载）" if size_mb > 0 else f"（通过{used_label}下载）"
        return True, (
            f"UMI-OCR {tag} 下载安装成功！\n"
            f"安装位置：{exe_str}\n"
            f"文件大小：{size_info}\n"
            "路径已自动保存到设置。使用前请确保在 UMI-OCR 中开启「HTTP接口服务」（默认端口 1224）。"
        ), exe_str

    except Exception as e:
        return False, (
            f"下载安装 UMI-OCR 失败：{e}\n\n"
            f"你也可以手动下载：\n"
            f"1. 蓝奏云镜像（国内推荐）：{UMI_OCR_MIRROR_URL}\n"
            f"2. GitHub Releases：https://github.com/hiroi-sora/Umi-OCR/releases\n"
            f"下载后解压，在设置中选择 Umi-OCR.exe 即可。"
        ), ""


def download_and_install_umi_ocr_stream():
    """流式版本：yield 进度事件字典，供 SSE endpoint 使用。

    在后台线程中执行下载，通过队列实时推送进度到生成器。

    事件格式：
      {"stage": "fetching",    "message": "..."}
      {"stage": "downloading", "downloaded": n, "total": n, "mirror": "...", "message": "..."}
      {"stage": "extracting",  "message": "..."}
      {"stage": "done",        "ok": true, "message": "...", "exe_path": "..."}
      {"stage": "error",       "ok": false, "message": "..."}
    """
    import queue
    import threading

    q: queue.Queue = queue.Queue()
    SENTINEL = {"_done": True}

    def _worker():
        """后台线程：执行下载并通过队列推送进度。"""
        try:
            q.put({"stage": "fetching", "message": "正在获取最新版本信息…"})

            # 用短超时获取版本信息，失败立即用已知版本兜底
            release_info = None
            try:
                with httpx.Client(timeout=6.0, trust_env=True, follow_redirects=True) as client:
                    resp = client.get(
                        UMI_OCR_REPO_API,
                        headers={"Accept": "application/vnd.github+json"},
                    )
                    resp.raise_for_status()
                    data = resp.json()
                    assets = []
                    for a in data.get("assets", []):
                        assets.append({
                            "name": a.get("name", ""),
                            "browser_download_url": a.get("browser_download_url", ""),
                            "size": a.get("size", 0),
                        })
                    if assets:
                        release_info = {"tag_name": data.get("tag_name", ""), "assets": assets}
            except Exception:
                pass

            if not release_info:
                # 兜底：使用内置已知版本
                tag = _KNOWN_LATEST_TAG
                base = f"https://github.com/hiroi-sora/Umi-OCR/releases/download/{tag}"
                release_info = {
                    "tag_name": tag,
                    "assets": [
                        {
                            "name": a["name"],
                            "browser_download_url": f"{base}/{a['name']}",
                            "size": a.get("size", 0),
                        }
                        for a in _KNOWN_LATEST_ASSETS
                    ],
                }

            tag = release_info["tag_name"]
            asset = _select_umi_ocr_asset(release_info["assets"])

            if not asset:
                tag = _KNOWN_LATEST_TAG
                base = f"https://github.com/hiroi-sora/Umi-OCR/releases/download/{tag}"
                asset = {
                    "name": _KNOWN_LATEST_ASSETS[0]["name"],
                    "browser_download_url": f"{base}/{_KNOWN_LATEST_ASSETS[0]['name']}",
                    "size": _KNOWN_LATEST_ASSETS[0]["size"],
                }

            asset_name = asset["name"]
            download_url = asset["browser_download_url"]
            total_size = int(asset.get("size", 0))

            get_tools_dir()
            if UMI_OCR_INSTALL_DIR.exists():
                shutil.rmtree(UMI_OCR_INSTALL_DIR, ignore_errors=True)
            UMI_OCR_INSTALL_DIR.mkdir(parents=True, exist_ok=True)

            # 镜像优先（国内 GitHub 直连经常超时），直连作为后备
            all_candidates = _build_download_candidates(download_url)
            # 把镜像排到前面：GitHub 直连放最后
            mirror_candidates = [(l, u) for l, u in all_candidates if "GitHub 直连" not in l]
            direct_candidates = [(l, u) for l, u in all_candidates if "GitHub 直连" in l]
            candidates = mirror_candidates + direct_candidates

            archive_path = TOOLS_DIR / asset_name
            used_label = ""
            errors: list[str] = []

            for i, (label, url) in enumerate(candidates):
                try:
                    q.put({
                        "stage": "downloading",
                        "downloaded": 0,
                        "total": total_size,
                        "mirror": label,
                        "message": f"正在通过{label}下载（{total_size / (1024*1024):.0f} MB）…",
                    })

                    last_emitted_pct = -1

                    def _on_progress(downloaded: int, total: int, _label=label):
                        nonlocal last_emitted_pct
                        if total > 0:
                            pct = int(downloaded * 100 / total)
                            if pct >= last_emitted_pct + 2:
                                last_emitted_pct = pct
                                q.put({
                                    "stage": "downloading",
                                    "downloaded": downloaded,
                                    "total": total,
                                    "mirror": _label,
                                    "message": f"正在通过{_label}下载… {pct}%",
                                })

                    # 短连接超时（8s），读超时给足（300s）
                    with httpx.Client(
                        timeout=httpx.Timeout(300.0, connect=8.0),
                        trust_env=True,
                        follow_redirects=True,
                    ) as client:
                        with client.stream("GET", url) as resp:
                            resp.raise_for_status()
                            stream_total = int(resp.headers.get("content-length", 0)) or total_size
                            downloaded = 0
                            with open(archive_path, "wb") as f:
                                for chunk in resp.iter_bytes(chunk_size=1024 * 256):
                                    f.write(chunk)
                                    downloaded += len(chunk)
                                    _on_progress(downloaded, stream_total)

                    if archive_path.exists() and archive_path.stat().st_size > 1024 * 1024:
                        used_label = label
                        final_size = archive_path.stat().st_size
                        q.put({
                            "stage": "downloading",
                            "downloaded": final_size,
                            "total": final_size,
                            "mirror": label,
                            "message": "下载完成，正在解压…",
                        })
                        break
                    errors.append(f"{label}：下载文件过小或为空")
                    if archive_path.exists():
                        archive_path.unlink(missing_ok=True)
                except Exception as e:
                    errors.append(f"{label}：{e}")
                    if archive_path.exists():
                        archive_path.unlink(missing_ok=True)

                if i < len(candidates) - 1:
                    next_label = candidates[i + 1][0]
                    q.put({
                        "stage": "downloading",
                        "downloaded": 0,
                        "total": total_size,
                        "mirror": next_label,
                        "message": f"{label}失败，正在尝试{next_label}…",
                    })

            if not used_label:
                raise RuntimeError("所有下载通道均失败：\n" + "\n".join(errors))

            q.put({"stage": "extracting", "message": "正在解压安装包，请稍候…"})
            _extract_archive(archive_path, UMI_OCR_INSTALL_DIR)

            try:
                archive_path.unlink()
            except Exception:
                pass

            exe_path = _get_umi_ocr_exe_in_dir(UMI_OCR_INSTALL_DIR)
            if not exe_path:
                for item in UMI_OCR_INSTALL_DIR.rglob("Umi-OCR.exe"):
                    if item.is_file():
                        exe_path = item
                        break

            if not exe_path:
                q.put({
                    "stage": "error",
                    "ok": False,
                    "message": (
                        f"UMI-OCR {tag} 下载解压完成，但未找到 Umi-OCR.exe。\n"
                        f"解压目录：{UMI_OCR_INSTALL_DIR}"
                    ),
                })
                return

            exe_str = str(exe_path)
            settings.update_from_dict({"umi_ocr_exe_path": exe_str})
            try:
                settings.persist()
            except Exception:
                pass

            q.put({
                "stage": "done",
                "ok": True,
                "message": (
                    f"UMI-OCR {tag} 安装成功！\n"
                    f"路径已自动保存。使用前请在 UMI-OCR 中开启「HTTP接口服务」（默认端口 1224）。"
                ),
                "exe_path": exe_str,
            })

        except Exception as e:
            q.put({
                "stage": "error",
                "ok": False,
                "message": (
                    f"下载安装失败：{e}\n\n"
                    f"可手动下载：\n"
                    f"1. 蓝奏云镜像（国内推荐）：{UMI_OCR_MIRROR_URL}\n"
                    f"2. GitHub Releases：https://github.com/hiroi-sora/Umi-OCR/releases"
                ),
            })
        finally:
            q.put(SENTINEL)

    t = threading.Thread(target=_worker, daemon=True)
    t.start()

    while True:
        try:
            event = q.get(timeout=1.0)
        except Exception:
            # queue.Empty：继续等，保持生成器活跃
            continue
        if "_done" in event:
            break
        yield event


# ─── Remotion 视频渲染工具 ───────────────────────────────────────

def check_remotion_installed() -> dict:
    """检查 Remotion 是否已安装（通过 node_modules 中的标记文件）。"""
    installed = REMOTION_MARKER_FILE.exists()
    version = ""
    if installed:
        try:
            import json
            data = json.loads(REMOTION_MARKER_FILE.read_text(encoding="utf-8"))
            version = data.get("version", "")
        except Exception:
            pass
    return {
        "installed": installed,
        "path": str(REMOTION_INSTALL_DIR),
        "version": version,
    }


def install_remotion() -> tuple[bool, str]:
    """通过 npm 在独立目录中安装 Remotion 及其渲染所需依赖。

    Returns:
        (success, message)
    """
    import shutil
    import subprocess

    npm = shutil.which("npm")
    if not npm:
        return False, "未找到 npm，请先安装 Node.js（建议 v18+）"

    try:
        REMOTION_INSTALL_DIR.mkdir(parents=True, exist_ok=True)

        # 如果没有 package.json，先初始化
        pkg_json = REMOTION_INSTALL_DIR / "package.json"
        if not pkg_json.exists():
            init = subprocess.run(
                [npm, "init", "-y"],
                cwd=str(REMOTION_INSTALL_DIR),
                capture_output=True,
                text=True,
                timeout=30,
            )
            if init.returncode != 0:
                return False, f"npm init 失败：{init.stderr.strip() or init.stdout.strip()}"

        # 安装 Remotion 及渲染依赖
        install_cmd = [npm, "install", *REMOTION_PACKAGES]
        result = subprocess.run(
            install_cmd,
            cwd=str(REMOTION_INSTALL_DIR),
            capture_output=True,
            text=True,
            timeout=600,
        )

        if result.returncode != 0:
            err = (result.stderr or result.stdout or "").strip()
            return False, f"npm install 失败：{err[-500:]}"

        # 验证标记文件
        if not REMOTION_MARKER_FILE.exists():
            return False, "安装已完成但未找到 remotion 包文件，请检查网络或重试"

        version = ""
        try:
            import json
            data = json.loads(REMOTION_MARKER_FILE.read_text(encoding="utf-8"))
            version = data.get("version", "")
        except Exception:
            pass

        msg = "Remotion 安装成功"
        if version:
            msg += f"（v{version}）"
        return True, msg

    except subprocess.TimeoutExpired:
        return False, "安装超时（超过 10 分钟），请检查网络后重试"
    except Exception as e:
        return False, f"安装 Remotion 时出错：{e}"


def check_officecli_installed() -> dict:
    """检查 OfficeCLI 是否已安装（通过 node_modules 中的标记文件）。"""
    installed = OFFICECLI_MARKER_FILE.exists()
    version = ""
    if installed:
        try:
            import json
            data = json.loads(OFFICECLI_MARKER_FILE.read_text(encoding="utf-8"))
            version = data.get("version", "")
        except Exception:
            pass
    return {
        "installed": installed,
        "path": str(OFFICECLI_INSTALL_DIR),
        "version": version,
    }


def install_officecli() -> tuple[bool, str]:
    """通过 npm 在独立目录中安装 @officecli/officecli。

    Returns:
        (success, message)
    """
    npm = shutil.which("npm")
    if not npm:
        return False, "未找到 npm，请先安装 Node.js（建议 v18+）"

    try:
        OFFICECLI_INSTALL_DIR.mkdir(parents=True, exist_ok=True)

        # 如果没有 package.json，先初始化
        pkg_json = OFFICECLI_INSTALL_DIR / "package.json"
        if not pkg_json.exists():
            init = subprocess.run(
                [npm, "init", "-y"],
                cwd=str(OFFICECLI_INSTALL_DIR),
                capture_output=True,
                text=True,
                timeout=30,
            )
            if init.returncode != 0:
                return False, f"npm init 失败：{init.stderr.strip() or init.stdout.strip()}"

        # 安装 @officecli/officecli
        result = subprocess.run(
            [npm, "install", OFFICECLI_PACKAGE],
            cwd=str(OFFICECLI_INSTALL_DIR),
            capture_output=True,
            text=True,
            timeout=600,
        )

        if result.returncode != 0:
            err = (result.stderr or result.stdout or "").strip()
            return False, f"npm install 失败：{err[-500:]}"

        # 验证标记文件
        if not OFFICECLI_MARKER_FILE.exists():
            return False, "安装已完成但未找到 officecli 包文件，请检查网络或重试"

        version = ""
        try:
            import json
            data = json.loads(OFFICECLI_MARKER_FILE.read_text(encoding="utf-8"))
            version = data.get("version", "")
        except Exception:
            pass

        msg = "OfficeCLI 安装成功"
        if version:
            msg += f"（v{version}）"
        return True, msg

    except subprocess.TimeoutExpired:
        return False, "安装超时（超过 10 分钟），请检查网络后重试"
    except Exception as e:
        return False, f"安装 OfficeCLI 时出错：{e}"


def get_all_deps_status() -> dict:
    """返回所有依赖和工具的综合状态（供前端一次请求获取）。"""
    python_deps = check_all_python_deps()
    umi_ocr = check_umi_ocr_installed()
    remotion = check_remotion_installed()
    officecli = check_officecli_installed()

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
        "remotion": remotion,
        "officecli": officecli,
        "tools_dir": str(TOOLS_DIR),
    }
