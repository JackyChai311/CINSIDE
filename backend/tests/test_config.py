# -*- coding: utf-8 -*-
"""配置单测：Settings._coerce_value 类型转换 + 文本/分析 LLM 回退链。

注意：app/config.py 的字段用 field(default_factory=lambda: _env(...)) 在实例化时
读环境变量，所以这里一律「先构造 Settings()，再直接 setattr 覆盖」，
不依赖 os.environ（构造后赋值即可完全决定被测字段）。
"""
import os

import pytest

from app.config import SETTING_KEYS, VALID_ACCENTS, VALID_THEMES, Settings


def _settings(**overrides) -> Settings:
    """构造 Settings 并逐项覆盖字段（避免环境变量影响断言）。"""
    s = Settings()
    for name, value in overrides.items():
        setattr(s, name, value)
    return s


def _llm_settings(**overrides) -> Settings:
    """给三组 LLM 字段一个确定基线，再按需覆盖。"""
    base = dict(
        vision_api_base="https://vision.example/v4",
        vision_api_key="VK",
        vision_model="glm-4v",
        text_api_base="",
        text_api_key="",
        text_model="",
        analysis_api_base="",
        analysis_api_key="",
        analysis_model="",
    )
    base.update(overrides)
    return _settings(**base)


# ============ to_settings_dict / SETTING_KEYS 一致性 ============
def test_to_settings_dict_covers_exactly_setting_keys():
    """设置面板读写键与 SETTING_KEYS 必须一一对应（漏一个就会丢配置）。"""
    d = _settings().to_settings_dict()
    assert set(d) == set(SETTING_KEYS)
    assert len(d) == len(SETTING_KEYS)


# ============ _coerce_value: bool ============
@pytest.mark.parametrize("raw", ["1", "true", "TRUE", "  true  ", "yes", "Yes", "on", "ON", True, 1, 2, [0]])
def test_coerce_bool_truthy(raw):
    assert _settings()._coerce_value("demo_site_enabled", raw) is True


@pytest.mark.parametrize("raw", ["0", "false", "FALSE", "no", "off", "", "  ", "maybe", "2", False, 0, None, []])
def test_coerce_bool_falsy(raw):
    assert _settings()._coerce_value("demo_site_enabled", raw) is False


@pytest.mark.parametrize("name", ["prevent_accidental_close", "loop_keep_awake", "high_speed_mode", "igpu_acceleration",
                                  "vision_auto_orient", "vision_viz_fallback", "expert_mode"])
def test_coerce_bool_applies_to_every_bool_setting(name):
    s = _settings()
    assert s._coerce_value(name, "on") is True
    assert s._coerce_value(name, "off") is False


# ============ _coerce_value: float / int / str ============
@pytest.mark.parametrize(
    "raw, expected",
    [("1.25", 1.25), ("0.6", 0.6), (1, 1.0), (1.5, 1.5), (True, 1.0)],
)
def test_coerce_float_valid(raw, expected):
    assert _settings()._coerce_value("ui_scale", raw) == expected


@pytest.mark.parametrize("raw", ["abc", "", "  ", None, "1,25"])
def test_coerce_float_invalid_falls_back_to_default(raw):
    # 非法输入 → 1.0（不是抛异常）
    assert _settings()._coerce_value("ui_scale", raw) == 1.0
    assert _settings()._coerce_value("browser_brightness", raw) == 1.0


@pytest.mark.parametrize("raw, expected", [("1224", 1224), (1224, 1224), ("0", 0), (True, 1)])
def test_coerce_int_valid(raw, expected):
    assert _settings()._coerce_value("umi_ocr_port", raw) == expected


@pytest.mark.parametrize("raw", ["abc", "", None, "12.9", "1e3"])
def test_coerce_int_invalid_falls_back_to_zero(raw):
    assert _settings()._coerce_value("umi_ocr_port", raw) == 0


@pytest.mark.parametrize(
    "raw, expected",
    [("dark", "dark"), ("", ""), (None, ""), (123, "123"), ("abc", "abc")],
)
def test_coerce_str_fields(raw, expected):
    assert _settings()._coerce_value("theme", raw) == expected


def test_coerce_str_falsy_non_string_becomes_empty():
    """现状记录：返回 str(raw or "") → 数字 0 是 falsy，被转成 "" 而不是 "0"。"""
    s = _settings()
    assert s._coerce_value("theme", 0) == ""
    assert s._coerce_value("ocr_engine", 0) == ""


def test_coerce_unknown_key_falls_back_to_str():
    s = _settings()
    assert s._coerce_value("vision_api_base", 123) == "123"
    assert s._coerce_value("not_a_setting_at_all", None) == ""


# ============ update_from_dict ============
def test_update_from_dict_coerces_types_and_mirrors_to_env(monkeypatch):
    # 先埋好「旧值」再调用（monkeypatch 会在用例结束后恢复）：
    # 注意 UMI_OCR_PORT / UI_SCALE 的旧值必须是能被构造期类型转换接受的字符串。
    for env_key, seed in (
        ("DEMO_SITE_ENABLED", "false"),
        ("UI_SCALE", "1.0"),
        ("UMI_OCR_PORT", "1224"),
        ("OCR_ENGINE", "vision"),
    ):
        monkeypatch.setenv(env_key, seed)

    s = _llm_settings()
    s.update_from_dict(
        {
            "demo_site_enabled": "yes",
            "ui_scale": "1.25",
            "umi_ocr_port": "1225",
            "ocr_engine": "umi",
        }
    )

    assert s.demo_site_enabled is True
    assert s.ui_scale == 1.25
    assert s.umi_ocr_port == 1225
    assert s.ocr_engine == "umi"
    # 布尔写进环境变量时统一成 "true"/"false"
    assert os.environ["DEMO_SITE_ENABLED"] == "true"
    assert os.environ["UI_SCALE"] == "1.25"
    assert os.environ["UMI_OCR_PORT"] == "1225"
    assert os.environ["OCR_ENGINE"] == "umi"


def test_update_from_dict_rejects_invalid_theme_and_accent(monkeypatch):
    monkeypatch.setenv("THEME", "dark")
    monkeypatch.setenv("ACCENT", "rose")

    s = _llm_settings(theme="dark", accent="rose")
    s.update_from_dict({"theme": "neon", "accent": "not-a-colour"})

    assert s.theme == "light"
    assert s.accent == "indigo"
    assert s.theme in VALID_THEMES
    assert s.accent in VALID_ACCENTS
    assert os.environ["THEME"] == "light"
    assert os.environ["ACCENT"] == "indigo"


def test_update_from_dict_keeps_valid_theme_and_accent(monkeypatch):
    monkeypatch.setenv("THEME", "light")
    monkeypatch.setenv("ACCENT", "indigo")

    s = _llm_settings()
    s.update_from_dict({"theme": "dark", "accent": "emerald"})

    assert s.theme == "dark"
    assert s.accent == "emerald"
    assert os.environ["THEME"] == "dark"
    assert os.environ["ACCENT"] == "emerald"


def test_update_from_dict_ignores_unknown_keys(monkeypatch):
    s = _llm_settings()
    s.update_from_dict({"definitely_not_a_setting": "boom"})
    assert not hasattr(s, "definitely_not_a_setting")


# ============ effective_text_llm ============
def test_effective_text_llm_inherits_vision_when_text_empty():
    s = _llm_settings()
    assert s.effective_text_llm() == ("https://vision.example/v4", "VK", "glm-4v")


def test_effective_text_llm_inherits_vision_when_text_whitespace():
    s = _llm_settings(text_api_base="   ", text_api_key=" ", text_model="\t")
    assert s.effective_text_llm() == ("https://vision.example/v4", "VK", "glm-4v")


def test_effective_text_llm_model_only_override_keeps_vision_base_and_key():
    """同一把 key 只换模型名的常见用法。"""
    s = _llm_settings(text_model="deepseek-flash")
    assert s.effective_text_llm() == ("https://vision.example/v4", "VK", "deepseek-flash")


def test_effective_text_llm_own_config_strips_trailing_slash():
    s = _llm_settings(
        text_api_base="http://text.example/v1/",
        text_api_key="TK",
        text_model="deepseek-flash",
    )
    assert s.effective_text_llm() == ("http://text.example/v1", "TK", "deepseek-flash")


@pytest.mark.parametrize("bad_base", ["ftp://text.example/v1", "text.example/v1", "//text.example", "/v1"])
def test_effective_text_llm_requires_http_scheme(bad_base):
    """base 必须以 http:// 或 https:// 开头，否则整体视为未配置。"""
    s = _llm_settings(text_api_base=bad_base, text_api_key="TK", text_model="flash")
    assert s.effective_text_llm() == ("", "", "")


def test_effective_text_llm_requires_key():
    s = _llm_settings(text_api_key="", vision_api_key="")
    assert s.effective_text_llm() == ("", "", "")


def test_effective_text_llm_requires_model():
    s = _llm_settings(text_model="", vision_model="")
    assert s.effective_text_llm() == ("", "", "")


# ============ effective_analysis_llm ============
def test_effective_analysis_llm_inherits_vision_when_all_empty():
    s = _llm_settings()
    assert s.effective_analysis_llm() == ("https://vision.example/v4", "VK", "glm-4v")


def test_effective_analysis_llm_inherits_text_before_vision():
    s = _llm_settings(text_api_base="https://text.example/v1", text_api_key="TK", text_model="flash")
    assert s.effective_analysis_llm() == ("https://text.example/v1", "TK", "flash")


def test_effective_analysis_llm_own_config_strips_trailing_slash():
    s = _llm_settings(
        text_api_base="https://text.example/v1",
        text_api_key="TK",
        text_model="flash",
        analysis_api_base="https://analysis.example/v2/",
        analysis_api_key="AK",
        analysis_model="reasoner",
    )
    assert s.effective_analysis_llm() == ("https://analysis.example/v2", "AK", "reasoner")


def test_effective_analysis_llm_falls_back_field_by_field():
    """逐项回退：分析只配了 base/model 时，key 从文本AI 借。"""
    s = _llm_settings(
        text_api_base="https://text.example/v1",
        text_api_key="TK",
        text_model="flash",
        analysis_api_base="https://analysis.example/v2",
        analysis_api_key="",
        analysis_model="reasoner",
    )
    assert s.effective_analysis_llm() == ("https://analysis.example/v2", "TK", "reasoner")


def test_effective_analysis_llm_inherits_vision_model_when_text_model_empty():
    s = _llm_settings(analysis_api_base="https://analysis.example/v2", analysis_api_key="AK", analysis_model="")
    assert s.effective_analysis_llm() == ("https://analysis.example/v2", "AK", "glm-4v")


@pytest.mark.parametrize("bad_base", ["ftp://analysis.example", "analysis.example", "javascript:alert(1)"])
def test_effective_analysis_llm_requires_http_scheme(bad_base):
    s = _llm_settings(analysis_api_base=bad_base, analysis_api_key="AK", analysis_model="reasoner")
    assert s.effective_analysis_llm() == ("", "", "")


def test_effective_analysis_llm_requires_key_and_model():
    s = _llm_settings(vision_api_key="", analysis_api_base="https://analysis.example", analysis_model="reasoner")
    assert s.effective_analysis_llm() == ("", "", "")
    s2 = _llm_settings(vision_model="", text_model="", analysis_api_base="https://analysis.example",
                       analysis_api_key="AK", analysis_model="")
    assert s2.effective_analysis_llm() == ("", "", "")
