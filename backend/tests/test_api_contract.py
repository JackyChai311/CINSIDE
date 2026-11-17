# -*- coding: utf-8 -*-
"""FastAPI 接口契约测试（characterization tests）。

目的：93 个路由端点目前**没有任何 response_model**，全部返回裸 dict。
没有 response_model 意味着响应结构无 schema、无校验，前后端契约只靠
frontend/src/types.ts 手抄维护，已经出现过漂移。

这组测试把"当前真实响应结构"固化成断言，作用是：
1. 端点被误删/改名、或响应字段被意外改动时立刻红灯；
2. 为后续「给端点逐个补 response_model」提供安全网 ——
   FastAPI 的 response_model 会**按 schema 过滤响应字段**，
   若前端依赖了 schema 之外的字段就会被静默丢掉，这组测试能当场发现。

注意：只断言 key 集合与类型，**不断言任何密钥的值**，也不打印响应内容。
部分断言锁定的是反直觉的现状（已注明），改之前请先确认是有意为之。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app, settings

# 不使用 `with TestClient(app)`：不进入上下文就不会触发 lifespan/startup，
# 从而避免启动时后台跑的 GPU/OCR 自检线程，让测试保持快速且确定性。
client = TestClient(app, raise_server_exceptions=False)


# ============ 路由盘点：端点被误删/改名时能发现 ============
# 当前 openapi 暴露的 86 个唯一路径快照（93 个路由装饰器；
# /api/config/settings、/api/upload/excel 等路径同时挂 GET 与 POST）。
#
# 刻意只做「子集」断言而不是「完全相等」：
#   - 新增端点 → 测试仍然通过，不需要改这里（避免给日常开发制造摩擦）；
#   - 删除或改名端点 → 立刻失败，这正是危险方向。
KNOWN_PATHS = frozenset(
    {
        "/",
        "/api/archive/export",
        "/api/archive/import",
        "/api/config",
        "/api/config/browse-umi-ocr",
        "/api/config/deps-status",
        "/api/config/download-umi-ocr",
        "/api/config/download-umi-ocr/stream",
        "/api/config/gpu-info",
        "/api/config/gpu-selftest",
        "/api/config/install-ocr-engine-deps",
        "/api/config/install-officecli",
        "/api/config/install-python-deps",
        "/api/config/install-ffmpeg",
        "/api/config/launch-umi-ocr",
        "/api/config/list-models",
        "/api/config/open-umi-ocr-folder",
        "/api/config/settings",
        "/api/config/share/create",
        "/api/config/share/fetch",
        "/api/config/test-analysis",
        "/api/config/test-imagegen",
        "/api/config/test-markitdown",
        "/api/config/test-umi-ocr",
        "/api/config/test-vision",
        "/api/cowork/clients",
        "/api/cowork/clients/path",
        "/api/cowork/dispatch",
        "/api/cowork/human/tasks",
        "/api/cowork/human/tasks/delete",
        "/api/cowork/human/tasks/extract",
        "/api/cowork/profile",
        "/api/cowork/skills",
        "/api/cowork/skills/delete",
        "/api/cowork/tasks",
        "/api/cowork/tasks/{task_id}",
        "/api/document/convert",
        "/api/document/extract",
        "/api/document/extract-url",
        "/api/document/ocr-region",
        "/api/document/preview",
        "/api/document/preview-url",
        "/api/health",
        "/api/plugin/config",
        "/api/plugin/records",
        "/api/plugin/start",
        "/api/plugin/status",
        "/api/plugin/stop",
        "/api/plugin/tabs",
        "/api/ppt/ai-info",
        "/api/ppt/analyze",
        "/api/ppt/analyze-stream",
        "/api/ppt/analyze-style",
        "/api/ppt/apply",
        "/api/ppt/create-from-text",
        "/api/ppt/create-from-text-stream",
        "/api/ppt/detect-sections",
        "/api/ppt/draft-outline",
        "/api/ppt/draft-outline-stream",
        "/api/ppt/import-local",
        "/api/ppt/merge",
        "/api/ppt/modify",
        "/api/ppt/page-count",
        "/api/ppt/refine-slide",
        "/api/ppt/screenshot",
        "/api/ppt/slide-elements",
        "/api/ppt/status",
        "/api/ppt/style-presets",
        "/api/ppt/update-elements",
        "/api/records",
        "/api/records-right",
        "/api/records/{record_id}/avatar",
        "/api/records/{record_id}/fields",
        "/api/upload/excel",
        "/api/upload/excel-export",
        "/api/upload/excel-export-hl",
        "/api/upload/excel-right",
        "/api/upload/excel-source",
        "/api/upload/passport/{record_id}",
        "/api/verify",
        "/api/verify/analysis/loop",
        "/api/verify/configurable",
        "/api/verify/report/{task_id}",
        "/api/verify/report/{task_id}/excel",
        "/api/verify/{task_id}",
        "/api/verify/{task_id}/continue",
    }
)


def test_openapi_exposes_at_least_the_expected_endpoint_count():
    paths = app.openapi()["paths"]
    assert len(paths) >= 86, f"端点数量异常减少：{len(paths)}"


def test_no_known_endpoint_disappeared():
    """86 个已知路径必须全部仍在。缺失 = 端点被删或改名，属于破坏性变更。"""
    missing = KNOWN_PATHS - set(app.openapi()["paths"])
    assert not missing, f"以下端点消失或被改名: {sorted(missing)}"


def test_all_routers_are_actually_mounted():
    """确认 9 个 router 都真的 include 进来了。

    提醒：include_router 在 app.routes 顶层生成的是 _IncludedRouter 中间对象，
    直接遍历 app.routes 只看到 21 项，会误判为"路由没挂上"。
    """
    from app.routers import archive, config, cowork, document, plugin, ppt, upload, verify, ws

    total = sum(len(m.router.routes) for m in (upload, verify, config, document, ppt, cowork, archive, plugin, ws))
    # 94 = 93 + /api/upload/excel-load-path（HARNESS 派单对象按路径载入表格）
    assert total == 94, f"router 内路由总数应为 94，实际 {total}"


# ============ 基础端点响应结构 ============
def test_root_response_shape():
    r = client.get("/")
    assert r.status_code == 200
    body = r.json()
    assert sorted(body.keys()) == ["agent", "name", "version"]
    assert isinstance(body["name"], str)
    assert isinstance(body["agent"], str)


def test_health_response_shape():
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert sorted(body.keys()) == ["agent_backend", "ok"]
    assert body["ok"] is True
    assert isinstance(body["agent_backend"], str)


def test_api_config_response_shape():
    r = client.get("/api/config")
    assert r.status_code == 200
    body = r.json()
    assert sorted(body.keys()) == [
        "agent_backend",
        "browser_use_configured",
        "settings",
        "vision_configured",
    ]
    # 这两个是 bool 而不是原始密钥 —— 只有它们适合直接断言
    assert isinstance(body["vision_configured"], bool)
    assert isinstance(body["browser_use_configured"], bool)
    assert isinstance(body["settings"], dict)


# ============ 设置端点：锁定 key 集合（含一处安全现状，见注释） ============
_SETTINGS_KEYS = {
    "accent",
    "agent_backend",
    "analysis_api_base",
    "analysis_api_key",
    "analysis_model",
    "browser_brightness",
    "browser_use_llm_base",
    "browser_use_llm_key",
    "browser_use_llm_model",
    "demo_site_enabled",
    "expert_mode",
    "harness_cdp_url",
    "harness_max_steps",
    "harness_vision",
    "high_speed_mode",
    "igpu_acceleration",
    "loop_keep_awake",
    "ocr_engine",
    "prevent_accidental_close",
    "sensenova_api_base",
    "sensenova_api_key",
    "sensenova_model",
    "text_api_base",
    "text_api_key",
    "text_model",
    "theme",
    "ui_scale",
    "umi_ocr_exe_path",
    "umi_ocr_host",
    "umi_ocr_port",
    "vision_api_base",
    "vision_api_key",
    "vision_auto_orient",
    "vision_model",
    "vision_viz_fallback",
}


def test_settings_endpoint_key_set_is_stable():
    """GET /api/config/settings 返回 35 个键。

    ⚠️ 安全现状（有意锁定，不是认可）：该响应**明文包含全部 5 个 API Key**
    （vision_api_key / text_api_key / analysis_api_key /
    browser_use_llm_key / sensenova_api_key）。这是设置面板回显所必需的，
    但意味着任何能访问 127.0.0.1:8000 的本地进程都能读到用户的密钥；
    且渲染进程侧的 BrowserView 使用了 webSecurity:false，
    使其加载的第三方网页可绕过 CORS 读取本响应。
    若要改为掩码/鉴权，请连带更新本测试并确认设置面板仍能正常工作。
    """
    r = client.get("/api/config/settings")
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == _SETTINGS_KEYS
    # 只断言"存在这些 key"，绝不断言其值，避免测试输出泄漏密钥
    for k in ("vision_api_key", "text_api_key", "analysis_api_key", "sensenova_api_key"):
        assert k in body


def test_deps_status_response_shape():
    r = client.get("/api/config/deps-status")
    assert r.status_code == 200
    assert sorted(r.json().keys()) == [
        "ffmpeg",
        "ocr_engine_all_installed",
        "ocr_engine_deps",
        "officecli",
        "python_all_installed",
        "python_deps",
        "tools_dir",
        "umi_ocr",
    ]


def test_gpu_info_response_shape():
    r = client.get("/api/config/gpu-info")
    assert r.status_code == 200
    assert sorted(r.json().keys()) == [
        "cpu",
        "gpu_ocr_supported",
        "gpus",
        "has_igpu",
        "igpu",
        "igpu_acceleration",
        "local_engine",
        "ocr_engine",
        "ok",
        "platform",
    ]


# ============ 错误路径 ============
def test_unknown_path_returns_404():
    assert client.get("/api/definitely-not-a-real-endpoint").status_code == 404


def test_wrong_method_returns_405():
    assert client.post("/api/health").status_code == 405


def test_unhandled_exception_returns_json_detail(monkeypatch):
    """全局兜底处理器应把未捕获异常转成 JSON（而非纯文本 500）。

    main.py 里注册了 @app.exception_handler(Exception)，目的是把真实异常
    类型/信息带给前端（例如 PermissionError：文件被 Excel/WPS 占用）。
    这里让 settings.to_settings_dict 抛错，触发 /api/config 走兜底分支。
    """

    def _boom():
        raise RuntimeError("boom-for-test")

    monkeypatch.setattr(settings, "to_settings_dict", _boom)
    r = client.get("/api/config")
    assert r.status_code == 500
    body = r.json()
    assert "detail" in body
    # 契约：detail 里带异常类型名，前端据此显示更有用的提示
    assert "RuntimeError" in body["detail"]
    assert "boom-for-test" in body["detail"]


# ============ CORS ============
def test_cors_allows_configured_local_origin():
    r = client.options(
        "/api/health",
        headers={
            "Origin": settings.frontend_origin,
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.status_code in (200, 204)
    assert r.headers.get("access-control-allow-origin") == settings.frontend_origin


def test_cors_does_not_allow_arbitrary_remote_origin():
    """第三方站点不在白名单内 → 不应回显它的 Origin。

    这是设置端点密钥的一道防线；注意 webSecurity:false 的 BrowserView
    会绕过 CORS（见 test_settings_endpoint_key_set_is_stable 的说明）。
    """
    r = client.options(
        "/api/health",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.headers.get("access-control-allow-origin") != "https://evil.example.com"


# ============ 启动钩子（不触发真实 GPU 自检） ============
def test_startup_hook_runs_without_real_selftest(monkeypatch):
    """用 with 进入上下文会真正跑 lifespan；把自检换成 no-op，
    验证启动钩子本身不会再抛错。"""
    import app.services.gpu_ocr as gpu_ocr

    called = {"n": 0}

    def _fake():
        called["n"] += 1

    monkeypatch.setattr(gpu_ocr, "start_background_selftest", _fake)
    with TestClient(app, raise_server_exceptions=False) as c:
        assert c.get("/api/health").status_code == 200
    assert called["n"] == 1
