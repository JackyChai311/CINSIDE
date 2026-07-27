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
        # 打包后使用 %APPDATA%/CINSIDE 或 exe 同级目录
        appdata = os.environ.get("APPDATA")
        if appdata:
            user_dir = Path(appdata) / "CINSIDE"
        else:
            user_dir = Path(sys.executable).resolve().parent / "userdata"
        user_dir.mkdir(parents=True, exist_ok=True)
        return user_dir
    return _get_base_dir()


_BASE_DIR = _get_base_dir()
_USER_DATA_DIR = _get_user_data_dir()

# .env 文件路径：优先用户数据目录，其次基础目录
_ENV_PATH = _USER_DATA_DIR / ".env"
if not _ENV_PATH.exists():
    _ENV_PATH = _BASE_DIR / ".env"

try:
    from dotenv import load_dotenv, set_key

    if _ENV_PATH.exists():
        load_dotenv(_ENV_PATH)
except ImportError:
    set_key = None  # type: ignore[assignment]


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


# 前端设置面板可读写的一组配置项
SETTING_KEYS = {
    "agent_backend": "AGENT_BACKEND",
    "vision_api_base": "VISION_API_BASE",
    "vision_api_key": "VISION_API_KEY",
    "vision_model": "VISION_MODEL",
    "browser_use_llm_base": "BROWSER_USE_LLM_BASE",
    "browser_use_llm_key": "BROWSER_USE_LLM_KEY",
    "browser_use_llm_model": "BROWSER_USE_LLM_MODEL",
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

    def to_settings_dict(self) -> dict[str, str]:
        """返回前端设置面板需要读写的配置项。"""
        return {
            "agent_backend": self.agent_backend,
            "vision_api_base": self.vision_api_base,
            "vision_api_key": self.vision_api_key,
            "vision_model": self.vision_model,
            "browser_use_llm_base": self.browser_use_llm_base,
            "browser_use_llm_key": self.browser_use_llm_key,
            "browser_use_llm_model": self.browser_use_llm_model,
        }

    def update_from_dict(self, data: dict[str, str]) -> None:
        """根据前端提交更新内存中的配置。"""
        for name, env_key in SETTING_KEYS.items():
            if name in data:
                value = str(data[name] or "")
                setattr(self, name, value)
                os.environ[env_key] = value

    def persist(self) -> None:
        """把当前设置写回 backend/.env，下次启动仍生效。"""
        if set_key is None:
            raise RuntimeError("python-dotenv 未安装，无法保存设置")
        for name, env_key in SETTING_KEYS.items():
            set_key(_ENV_PATH, env_key, str(getattr(self, name) or ""))


settings = Settings()
