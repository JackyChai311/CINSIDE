"""应用配置。所有可调参数集中在此。"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


def _get_base_dir() -> Path:
    """获取基础目录，兼容开发环境和打包环境。"""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parent.parent


def _get_user_data_dir() -> Path:
    """获取用户数据目录（用于上传文件、配置等可写内容）。"""
    if getattr(sys, "frozen", False):
        if sys.platform == "darwin":
            # macOS: ~/Library/Application Support/CINSIDE
            user_dir = Path.home() / "Library" / "Application Support" / "CINSIDE"
        elif sys.platform == "win32":
            # Windows: %APPDATA%/CINSIDE
            appdata = os.environ.get("APPDATA")
            if appdata:
                user_dir = Path(appdata) / "CINSIDE"
            else:
                user_dir = Path(sys.executable).resolve().parent / "userdata"
        else:
            # Linux: ~/.config/CINSIDE 或 ~/.local/share/CINSIDE
            xdg_config = os.environ.get("XDG_CONFIG_HOME")
            if xdg_config:
                user_dir = Path(xdg_config) / "CINSIDE"
            else:
                user_dir = Path.home() / ".config" / "CINSIDE"
        user_dir.mkdir(parents=True, exist_ok=True)
        return user_dir
    return _get_base_dir()


_BASE_DIR = _get_base_dir()
_USER_DATA_DIR = _get_user_data_dir()

# .env 路径：始终使用用户数据目录（可写持久化）。
# 生产环境安装目录（Program Files 等）可能只读，绝不能把 .env 指向那里，
# 否则 persist 写盘失败 → 当前会话生效但重启丢失。
_ENV_PATH = _USER_DATA_DIR / ".env"

# 若用户目录无 .env，但基础目录有旧配置，则一次性迁移过来（复制而非改写原文件）
_LEGACY_ENV = _BASE_DIR / ".env"
if not _ENV_PATH.exists() and _LEGACY_ENV.exists():
    try:
        import shutil
        shutil.copy2(_LEGACY_ENV, _ENV_PATH)
    except Exception:
        pass

try:
    from dotenv import load_dotenv, set_key

    if _ENV_PATH.exists():
        load_dotenv(_ENV_PATH)
except ImportError:
    set_key = None  # type: ignore[assignment]


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def _env_bool(key: str, default: bool = False) -> bool:
    val = os.environ.get(key)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


def _env_float(key: str, default: float = 1.0) -> float:
    val = os.environ.get(key)
    if val is None:
        return default
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


# 前端设置面板可读写的一组配置项
SETTING_KEYS = {
    "agent_backend": "AGENT_BACKEND",
    "vision_api_base": "VISION_API_BASE",
    "vision_api_key": "VISION_API_KEY",
    "vision_model": "VISION_MODEL",
    "browser_use_llm_base": "BROWSER_USE_LLM_BASE",
    "browser_use_llm_key": "BROWSER_USE_LLM_KEY",
    "browser_use_llm_model": "BROWSER_USE_LLM_MODEL",
    "sensenova_api_key": "SENSENOVA_API_KEY",
    "ocr_engine": "OCR_ENGINE",
    "umi_ocr_host": "UMI_OCR_HOST",
    "umi_ocr_port": "UMI_OCR_PORT",
    "umi_ocr_exe_path": "UMI_OCR_EXE_PATH",
    "beginner_mode": "BEGINNER_MODE",
    "prevent_accidental_close": "PREVENT_ACCIDENTAL_CLOSE",
    "ui_scale": "UI_SCALE",
    "theme": "THEME",
    "accent": "ACCENT",
    "browser_brightness": "BROWSER_BRIGHTNESS",
}

# theme 允许值
VALID_THEMES = {"light", "dark"}
# accent 允许值
VALID_ACCENTS = {"indigo", "sky", "emerald", "rose", "violet", "amber"}

# 非字符串类型字段的类型映射（.env 中统一存字符串，读取时转换）
_SETTING_TYPES: dict[str, type] = {
    "beginner_mode": bool,
    "prevent_accidental_close": bool,
    "ui_scale": float,
    "browser_brightness": float,
    "umi_ocr_port": int,
}


@dataclass
class Settings:
    # === Agent 选择 ===
    # mock | browser_use | hermes | openclaw
    agent_backend: str = field(default_factory=lambda: _env("AGENT_BACKEND", "mock"))

    # === Vision LLM (护照 OCR) ===
    # 使用 OpenAI 兼容接口，可接 GLM-4V / Qwen-VL / OpenAI 等
    vision_api_base: str = field(default_factory=lambda: _env("VISION_API_BASE", "https://open.bigmodel.cn/api/paas/v4"))
    vision_api_key: str = field(default_factory=lambda: _env("VISION_API_KEY", ""))
    vision_model: str = field(default_factory=lambda: _env("VISION_MODEL", "glm-4v-plus"))

    # === Browser Use Agent ===
    browser_use_llm_base: str = field(default_factory=lambda: _env("BROWSER_USE_LLM_BASE", "https://open.bigmodel.cn/api/paas/v4"))
    browser_use_llm_key: str = field(default_factory=lambda: _env("BROWSER_USE_LLM_KEY", ""))
    browser_use_llm_model: str = field(default_factory=lambda: _env("BROWSER_USE_LLM_MODEL", "glm-4-plus"))

    # === SenseNova U1 Fast 生图（PPT 配图） ===
    sensenova_api_key: str = field(default_factory=lambda: _env("SENSENOVA_API_KEY", ""))

    # === 文档/护照 OCR 引擎 ===
    # vision: 识图AI（Vision LLM，需配置 vision_api_key）
    # umi: 本地 UMI-OCR（离线 PaddleOCR，走 UMI-OCR 的 HTTP 接口）
    ocr_engine: str = field(default_factory=lambda: _env("OCR_ENGINE", "vision"))
    # UMI-OCR HTTP 接口地址（需在 UMI-OCR 中开启「HTTP接口服务」）
    umi_ocr_host: str = field(default_factory=lambda: _env("UMI_OCR_HOST", "127.0.0.1"))
    umi_ocr_port: int = field(default_factory=lambda: int(_env("UMI_OCR_PORT", "1224")))
    # UMI-OCR 可执行文件路径（为空则自动搜索常见位置）
    umi_ocr_exe_path: str = field(default_factory=lambda: _env("UMI_OCR_EXE_PATH", ""))
    browser_use_headless: bool = field(default_factory=lambda: _env("BROWSER_USE_HEADLESS", "false").lower() == "true")
    # Chrome / Chromium 可执行路径；空则让 browser-use 自行查找
    browser_use_executable: str = field(default_factory=lambda: _env("BROWSER_USE_EXECUTABLE", ""))
    # 是否使用视觉（截图决策）；flash-lite 等弱视觉模型可关掉
    browser_use_vision: bool = field(default_factory=lambda: _env("BROWSER_USE_VISION", "false").lower() == "true")
    # 单任务最大步数
    browser_use_max_steps: int = field(default_factory=lambda: int(_env("BROWSER_USE_MAX_STEPS", "30")))
    # 连接 Electron 等已运行浏览器的 CDP endpoint（例如 http://localhost:9222）
    browser_use_cdp_url: str = field(default_factory=lambda: _env("BROWSER_USE_CDP_URL", ""))

    # === Hermes Agent ===
    hermes_api_base: str = field(default_factory=lambda: _env("HERMES_API_BASE", "http://localhost:8001"))

    # === OpenClaw Agent ===
    openclaw_bin: str = field(default_factory=lambda: _env("OPENCLAW_BIN", "openclaw"))
    openclaw_profile: str = field(default_factory=lambda: _env("OPENCLAW_PROFILE", "openclaw"))

    # === 文件存储 ===
    upload_dir: str = field(default_factory=lambda: _env("UPLOAD_DIR", str(_USER_DATA_DIR / "_uploads")))
    sample_dir: str = field(default_factory=lambda: _env("SAMPLE_DIR", str(_BASE_DIR.parent / "samples")))

    # === CORS ===
    frontend_origin: str = field(default_factory=lambda: _env("FRONTEND_ORIGIN", "http://localhost:5173"))

    # === UI 偏好（前端设置面板） ===
    # 新手模式：true=显示步骤引导，false=直接使用字段对比面板
    beginner_mode: bool = field(default_factory=lambda: _env_bool("BEGINNER_MODE", False))
    # 防误关：true=关闭按钮最小化到托盘
    prevent_accidental_close: bool = field(default_factory=lambda: _env_bool("PREVENT_ACCIDENTAL_CLOSE", False))
    # 整体 UI 缩放比例（0.6~1.6）
    ui_scale: float = field(default_factory=lambda: _env_float("UI_SCALE", 1.0))
    # 主题：light=浅色 / dark=深色
    theme: str = field(default_factory=lambda: _env("THEME", "light"))
    # 主色调：indigo / sky / emerald / rose / violet / amber
    accent: str = field(default_factory=lambda: _env("ACCENT", "indigo"))
    # BrowserPane 网页亮度（0.3~2.0，1.0=原始亮度）
    browser_brightness: float = field(default_factory=lambda: _env_float("BROWSER_BRIGHTNESS", 1.0))

    # === LOOP 卡片分享（GitHub Gist）===
    # GitHub Personal Access Token，需 gist 权限；留空则只能用离线分享码
    github_gist_token: str = field(default_factory=lambda: _env("GITHUB_GIST_TOKEN", ""))

    def to_settings_dict(self) -> dict:
        """返回前端设置面板需要读写的配置项。"""
        return {
            "agent_backend": self.agent_backend,
            "vision_api_base": self.vision_api_base,
            "vision_api_key": self.vision_api_key,
            "vision_model": self.vision_model,
            "browser_use_llm_base": self.browser_use_llm_base,
            "browser_use_llm_key": self.browser_use_llm_key,
            "browser_use_llm_model": self.browser_use_llm_model,
            "sensenova_api_key": self.sensenova_api_key,
            "ocr_engine": self.ocr_engine,
            "umi_ocr_host": self.umi_ocr_host,
            "umi_ocr_port": self.umi_ocr_port,
            "umi_ocr_exe_path": self.umi_ocr_exe_path,
            "beginner_mode": self.beginner_mode,
            "prevent_accidental_close": self.prevent_accidental_close,
            "ui_scale": self.ui_scale,
            "theme": self.theme,
            "accent": self.accent,
            "browser_brightness": self.browser_brightness,
        }

    def _coerce_value(self, name: str, raw):
        """将前端传来的值转换为字段对应的 Python 类型。"""
        target_type = _SETTING_TYPES.get(name, str)
        if target_type is bool:
            if isinstance(raw, bool):
                return raw
            if isinstance(raw, str):
                return raw.strip().lower() in ("1", "true", "yes", "on")
            return bool(raw)
        if target_type is float:
            try:
                return float(raw)
            except (TypeError, ValueError):
                return 1.0
        if target_type is int:
            try:
                return int(raw)
            except (TypeError, ValueError):
                return 0
        return str(raw or "")

    def update_from_dict(self, data: dict) -> None:
        """根据前端提交更新内存中的配置。"""
        for name, env_key in SETTING_KEYS.items():
            if name in data:
                value = self._coerce_value(name, data[name])
                # 主题/主色调校验，非法值回退默认
                if name == "theme" and value not in VALID_THEMES:
                    value = "light"
                if name == "accent" and value not in VALID_ACCENTS:
                    value = "indigo"
                setattr(self, name, value)
                # os.environ 只接受字符串
                os.environ[env_key] = str(value) if not isinstance(value, bool) else ("true" if value else "false")

    def persist(self) -> None:
        """把当前设置写回 .env，下次启动仍生效。"""
        if set_key is None:
            raise RuntimeError("python-dotenv 未安装，无法保存设置")
        for name, env_key in SETTING_KEYS.items():
            value = getattr(self, name)
            if isinstance(value, bool):
                str_value = "true" if value else "false"
            else:
                str_value = str(value or "")
            set_key(_ENV_PATH, env_key, str_value)


settings = Settings()
