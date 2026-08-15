"""显卡 / 核显硬件检测（Windows PowerShell CIM）。

供设置面板展示与 gpu_ocr 自检共用。结果会话级缓存；refresh=True 强制重查。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys

_CACHE: dict | None = None


def classify_gpu(name: str) -> tuple[str, bool]:
    """按显卡名称判断 (vendor, 是否核显)。名称启发式，覆盖常见命名：

    Intel: Iris Xe / UHD / HD Graphics / GMA（核显）；Arc A370/A770…（独显）；
           "Arc Graphics" 无型号 = Meteor Lake 核显。
    AMD:   Radeon(TM) Graphics / Vega（老核显）；Radeon 610M/780M（新 APU 核显，
           三位数字+M）；RX 前缀 = 独显（"RX Vega 8 Graphics" 例外，是核显）。
    NVIDIA: 全部按独显处理。
    """
    n = (name or "").lower()
    if not n:
        return "unknown", False
    if "nvidia" in n or "geforce" in n or "quadro" in n or "tesla" in n or re.search(r"\b(rtx|gtx)\b", n):
        return "nvidia", False
    if "intel" in n or "iris" in n or "uhd" in n or "hd graphics" in n or "arc" in n or "gma" in n:
        if "arc" in n:
            # Arc 独显带 A+三位型号（A370/A580/A770…）；无型号的 "Arc Graphics" 是 Meteor Lake 核显
            integrated = re.search(r"a\s?\d{3}", n) is None
        else:
            integrated = True
        return "intel", integrated
    if "amd" in n or "radeon" in n or "ati" in n:
        # "RX Vega n Graphics"（老 APU 核显）虽带 RX 但有 Graphics 后缀 → 核显
        if "vega" in n and "graphics" in n:
            return "amd", True
        integrated = "rx" not in n and (
            "graphics" in n or "vega" in n or re.search(r"\d{3}\s?m\b", n) is not None
        )
        return "amd", integrated
    return "unknown", False


def _detect_sync() -> dict:
    if sys.platform != "win32":
        return {"ok": False, "platform": sys.platform, "error": "仅支持 Windows 检测", "gpus": [], "has_igpu": False}
    try:
        ps = (
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
            "$g=Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,Status;"
            "$c=Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors;"
            "@{gpus=@($g);cpu=$c}|ConvertTo-Json -Depth 4 -Compress"
        )
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True, encoding="utf-8", errors="replace", timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        raw = json.loads(proc.stdout) if proc.stdout.strip() else {}
    except Exception as e:
        return {"ok": False, "platform": sys.platform, "error": f"硬件检测失败: {e}", "gpus": [], "has_igpu": False}

    gpus = []
    for item in raw.get("gpus") or []:
        name = str(item.get("Name") or "").strip()
        if not name:
            continue
        vendor, integrated = classify_gpu(name)
        gpus.append({
            "name": name,
            "vendor": vendor,
            "integrated": integrated,
            "driver_version": str(item.get("DriverVersion") or ""),
            "status": str(item.get("Status") or ""),
        })
    cpu_raw = raw.get("cpu") or {}
    cpu = {
        "name": str(cpu_raw.get("Name") or "").strip(),
        "physical_cores": cpu_raw.get("NumberOfCores") or 0,
        "logical_cores": cpu_raw.get("NumberOfLogicalProcessors") or 0,
    }
    igpu = next((g for g in gpus if g["integrated"]), None)
    return {
        "ok": True,
        "platform": sys.platform,
        "gpus": gpus,
        "igpu": igpu,
        "has_igpu": igpu is not None,
        "cpu": cpu,
    }


def detect(refresh: bool = False) -> dict:
    """带缓存的硬件检测入口。"""
    global _CACHE
    if _CACHE is None or refresh:
        _CACHE = _detect_sync()
    return _CACHE


def get_primary_gpu_name() -> str:
    """主 GPU 名（优先核显，其次第一块），供日志展示。"""
    info = detect()
    gpus = info.get("gpus") or []
    igpu = info.get("igpu")
    if igpu:
        return igpu["name"]
    return gpus[0]["name"] if gpus else ""
