"""SLIDE STUDIO 视频合成：PPT 逐页导图 + TTS 配音 + ffmpeg 合成 MP4。

替代原 Remotion 方案（已移除）：
  * 逐页画面：OfficeCLI screenshot（slide.py 提供）或调用方给的图片序列；
  * 配音：Windows 自带 SAPI 语音（PowerShell System.Speech，零新增依赖）；
    没有配音的页按固定时长静帧；
  * 合成：ffmpeg（设置页可一键下载到工具目录，也认 PATH 里的 ffmpeg）。

另一路径「HTML 动画录屏」由 HARNESS 的 web_screenshot 连拍 + 本模块
frames_to_video 合成，同样不需要 Remotion。
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from ..config import _USER_DATA_DIR

# ffmpeg 安装目录（与 Umi-OCR / OfficeCLI 同一套工具目录约定）
TOOLS_DIR = _USER_DATA_DIR / "tools"
FFMPEG_INSTALL_DIR = TOOLS_DIR / "ffmpeg"
# BtbN 的 essentials 构建（GitHub Release，含 ffmpeg.exe，约 30-90MB）
FFMPEG_WIN_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
_GITHUB_MIRRORS = [
    "https://ghfast.top/",
    "https://gh-proxy.com/",
    "https://ghproxy.net/",
]


class VideoError(RuntimeError):
    """视频合成失败。"""


# ---------- ffmpeg 检测 / 安装 ----------


def find_ffmpeg() -> str:
    """工具目录优先，其次 PATH。找不到返回空串。"""
    local = FFMPEG_INSTALL_DIR / "ffmpeg.exe" if sys.platform == "win32" else FFMPEG_INSTALL_DIR / "ffmpeg"
    if local.exists():
        return str(local)
    # 解压后可能带一层子目录
    if FFMPEG_INSTALL_DIR.exists():
        for p in FFMPEG_INSTALL_DIR.rglob(local.name):
            return str(p)
    return shutil.which("ffmpeg") or ""


def check_ffmpeg_installed() -> dict:
    path = find_ffmpeg()
    version = ""
    if path:
        try:
            r = subprocess.run([path, "-version"], capture_output=True, text=True, timeout=10)
            first = (r.stdout or "").splitlines()
            version = first[0][:80] if first else ""
        except Exception:  # noqa: BLE001
            pass
    return {"installed": bool(path), "path": path, "version": version}


def install_ffmpeg() -> tuple[bool, str]:
    """下载 ffmpeg 静态构建并解压到工具目录（Windows）。"""
    if sys.platform != "win32":
        return False, "当前平台请用系统包管理器安装 ffmpeg（如 brew install ffmpeg）"
    if find_ffmpeg():
        return True, "ffmpeg 已可用，无需重复安装"
    import httpx

    FFMPEG_INSTALL_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = FFMPEG_INSTALL_DIR / "ffmpeg.zip"
    urls = [FFMPEG_WIN_URL] + [m + FFMPEG_WIN_URL for m in _GITHUB_MIRRORS]
    last_err = ""
    for url in urls:
        try:
            with httpx.Client(timeout=600.0, follow_redirects=True) as client:
                with client.stream("GET", url) as resp:
                    resp.raise_for_status()
                    with open(zip_path, "wb") as f:
                        for chunk in resp.iter_bytes(1 << 20):
                            f.write(chunk)
            break
        except Exception as e:  # noqa: BLE001
            last_err = f"{type(e).__name__}: {e}"
            zip_path.unlink(missing_ok=True)
    else:
        return False, f"下载 ffmpeg 失败（已尝试 GitHub 与镜像）：{last_err}"

    try:
        with zipfile.ZipFile(zip_path) as zf:
            # 只取 ffmpeg.exe（essentials 包里还有 ffprobe 等，一并解出 bin 目录）
            for name in zf.namelist():
                base = os.path.basename(name)
                if base in ("ffmpeg.exe", "ffprobe.exe"):
                    dest = FFMPEG_INSTALL_DIR / base
                    with zf.open(name) as src, open(dest, "wb") as out:
                        shutil.copyfileobj(src, out)
        zip_path.unlink(missing_ok=True)
    except Exception as e:  # noqa: BLE001
        return False, f"解压 ffmpeg 失败：{e}"

    if not find_ffmpeg():
        return False, "安装完成但未找到 ffmpeg.exe，请重试"
    return True, "ffmpeg 安装成功"


# ---------- TTS（Windows SAPI，零依赖） ----------


async def tts_to_wav(text: str, out_path: str, *, voice: str = "", rate: int = 0) -> dict:
    """把文字合成为 WAV。Windows 用 System.Speech；其他平台报错提示。

    rate: -10..10（语速偏移）；voice 留空用系统默认（中文系统默认中文语音）。
    """
    if sys.platform != "win32":
        raise VideoError("当前平台暂不支持内置 TTS，请提供音频文件")
    text = (text or "").strip()
    if not text:
        raise VideoError("配音文字为空")
    # 文字走临时文件，避免命令行转义/长度问题
    tmp = Path(out_path).with_suffix(".txt")
    tmp.write_text(text, encoding="utf-8")
    ps = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        f"$s.Rate = {max(-10, min(10, int(rate)))}; "
    )
    if voice:
        v = voice.replace("'", "''")
        ps += f"try {{ $s.SelectVoice('{v}') }} catch {{}}; "
    ps += (
        f"$s.SetOutputToWaveFile('{str(out_path)}'); "
        f"$t = [System.IO.File]::ReadAllText('{str(tmp)}', [System.Text.Encoding]::UTF8); "
        "$s.Speak($t); $s.Dispose()"
    )
    try:
        r = await asyncio.to_thread(
            subprocess.run,
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=180,
        )
        if r.returncode != 0 or not os.path.exists(out_path):
            raise VideoError(f"TTS 合成失败：{(r.stderr or '').strip()[:300]}")
        size = os.path.getsize(out_path)
        if size < 1000:
            raise VideoError("TTS 生成的音频异常（过小），请检查系统语音是否可用")
        return {"ok": True, "path": out_path, "bytes": size}
    finally:
        tmp.unlink(missing_ok=True)


def wav_duration(path: str) -> float:
    """读 WAV 头拿时长（秒）。非 WAV / 读失败返回 0。"""
    import wave

    try:
        with wave.open(path, "rb") as w:
            return w.getnframes() / float(w.getframerate() or 1)
    except Exception:  # noqa: BLE001
        return 0.0


# ---------- 合成 ----------


async def compose_video(
    pages: list[dict],
    out_path: str,
    *,
    fps: int = 30,
    width: int = 1280,
    height: int = 720,
) -> dict:
    """逐页（图片 + 可选配音）合成 MP4。

    pages: [{"image": png 路径, "audio": wav 路径或空, "duration": 无配音时的秒数}]
    每页时长 = 配音时长 + 0.4s 收尾；无配音用 duration（默认 4s）。
    """
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise VideoError("未找到 ffmpeg：请到「设置 → 依赖 → 视频合成」一键下载")
    if not pages:
        raise VideoError("没有可合成的页面")
    for i, p in enumerate(pages):
        if not p.get("image") or not os.path.exists(p["image"]):
            raise VideoError(f"第 {i + 1} 页缺少画面图片：{p.get('image')}")

    work = Path(tempfile.mkdtemp(prefix="cinside-video-"))
    try:
        segments: list[str] = []
        for i, p in enumerate(pages):
            audio = str(p.get("audio") or "")
            if audio and os.path.exists(audio):
                dur = wav_duration(audio) + 0.4
                if dur <= 0.5:
                    dur = float(p.get("duration") or 4)
                    audio = ""
            else:
                audio = ""
                dur = float(p.get("duration") or 4)
            dur = max(1.0, min(dur, 600.0))
            seg = str(work / f"seg-{i:03d}.mp4")
            # 统一分辨率/像素格式，保证 concat 无缝
            vf = (
                f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p"
            )
            cmd = [ffmpeg, "-y", "-loop", "1", "-i", str(p["image"])]
            if audio:
                cmd += ["-i", audio, "-af", "apad=pad_dur=0.4"]
            else:
                # 静默音轨：保证所有段都有音频流，concat 不炸
                cmd += ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]
            cmd += [
                "-vf", vf, "-r", str(fps), "-t", f"{dur:.2f}",
                "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-ar", "44100", "-ac", "2", "-shortest", seg,
            ]
            await _run_ffmpeg(cmd, timeout=300)
            segments.append(seg)

        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        if len(segments) == 1:
            await asyncio.to_thread(shutil.copyfile, segments[0], out_path)
        else:
            listing = work / "concat.txt"
            listing.write_text(
                "\n".join(f"file '{s}'" for s in segments), encoding="utf-8"
            )
            await _run_ffmpeg(
                [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(listing),
                 "-c", "copy", out_path],
                timeout=300,
            )
        if not os.path.exists(out_path) or os.path.getsize(out_path) < 10000:
            raise VideoError("合成输出异常（文件缺失或过小）")
        return {"ok": True, "path": out_path, "pages": len(pages), "bytes": os.path.getsize(out_path)}
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def frames_to_video(
    frames_dir: str,
    out_path: str,
    *,
    fps: int = 10,
    pattern: str = "frame-%05d.png",
    audio: str = "",
) -> dict:
    """HTML 动画录屏路径：连续帧 PNG → MP4（可选配音）。"""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise VideoError("未找到 ffmpeg：请到「设置 → 依赖 → 视频合成」一键下载")
    src = os.path.join(frames_dir, pattern)
    cmd = [ffmpeg, "-y", "-framerate", str(fps), "-i", src]
    if audio and os.path.exists(audio):
        cmd += ["-i", audio, "-c:a", "aac", "-shortest"]
    cmd += ["-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", out_path]
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    await _run_ffmpeg(cmd, timeout=600)
    if not os.path.exists(out_path):
        raise VideoError("帧序列合成失败：请确认帧文件按 frame-00001.png 连续编号")
    return {"ok": True, "path": out_path, "bytes": os.path.getsize(out_path)}


async def _run_ffmpeg(cmd: list[str], *, timeout: int) -> None:
    r = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, timeout=timeout
    )
    if r.returncode != 0:
        raise VideoError(f"ffmpeg 失败：{(r.stderr or '')[-400:]}")