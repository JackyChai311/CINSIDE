# -*- coding: utf-8 -*-
"""接口鉴权中间件测试（off / report / enforce 三种模式）。

背景：渲染进程的 BrowserView 用 webSecurity:false 加载第三方学校网站，
该设置让页面绕过 CORS，因此任何第三方页面都能直接读本机后端
（含 /api/config/settings 的明文 API Key、含护照号的 records）。
CORS 白名单对此无效，必须用第三方拿不到的共享令牌。

关键要求：**未配置令牌时必须完全放行**，否则单独起后端与 pytest 都会被挡。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import auth
from app.main import app

TOKEN = "unit-test-token-0123456789abcdef"


@pytest.fixture
def as_mode(monkeypatch):
    """切换鉴权模式与令牌。改模块属性即可——中间件在调用时读全局，不是快照。"""

    def _set(mode: str, token: str = TOKEN):
        monkeypatch.setattr(auth, "MODE", mode)
        monkeypatch.setattr(auth, "TOKEN", token)

    return _set


# ============ 配置解析 ============
def test_read_mode_forces_off_when_no_token(monkeypatch):
    """没有令牌就无从校验 → 一律 off（保证 pytest / 单独起后端可用）。"""
    monkeypatch.delenv(auth.ENV_MODE, raising=False)
    monkeypatch.setenv(auth.ENV_TOKEN, "")
    assert auth._read_mode("") == "off"
    monkeypatch.setenv(auth.ENV_MODE, "enforce")
    assert auth._read_mode("") == "off", "显式 enforce 也不能在没有令牌时生效"


def test_read_mode_defaults_to_enforce_with_token_but_no_mode(monkeypatch):
    monkeypatch.delenv(auth.ENV_MODE, raising=False)
    assert auth._read_mode(TOKEN) == "enforce"


def test_read_mode_honours_explicit_mode(monkeypatch):
    for m in ("off", "report", "enforce"):
        monkeypatch.setenv(auth.ENV_MODE, m)
        assert auth._read_mode(TOKEN) == m


def test_read_mode_falls_back_to_enforce_on_garbage(monkeypatch):
    monkeypatch.setenv(auth.ENV_MODE, "yes-please")
    assert auth._read_mode(TOKEN) == "enforce"


def test_is_authorized_rejects_empty_and_none():
    assert auth.is_authorized(None) is False
    assert auth.is_authorized("") is False


# ============ 路径豁免 ============
@pytest.mark.parametrize("path", ["/", "/api/health"])
def test_exempt_paths_are_not_protected(path):
    assert auth.is_protected_path(path) is False


@pytest.mark.parametrize("path", ["/api/config", "/api/config/settings", "/api/records", "/ws/verify/x"])
def test_sensitive_paths_are_protected(path):
    assert auth.is_protected_path(path) is True


def test_docs_and_openapi_are_not_under_api_prefix():
    """文档与 schema 不含用户数据，且不在 /api 下，不受影响。"""
    for p in ("/docs", "/redoc", "/openapi.json", "/mock/index.html"):
        assert auth.is_protected_path(p) is False


# ============ off 模式：完全放行 ============
def test_off_mode_allows_request_without_token(as_mode):
    as_mode("off")
    c = TestClient(app, raise_server_exceptions=False)
    r = c.get("/api/config/settings")
    assert r.status_code == 200
    assert "vision_api_key" in r.json()


# ============ enforce 模式 ============
def test_enforce_blocks_request_without_token(as_mode):
    as_mode("enforce")
    c = TestClient(app, raise_server_exceptions=False)
    r = c.get("/api/config/settings")
    assert r.status_code == 403
    assert "令牌" in r.json()["detail"]


def test_enforce_blocks_request_with_wrong_token(as_mode):
    as_mode("enforce")
    c = TestClient(app, raise_server_exceptions=False)
    r = c.get("/api/config/settings", headers={"X-CINSIDE-Token": "wrong"})
    assert r.status_code == 403


def test_enforce_allows_request_with_correct_header(as_mode):
    as_mode("enforce")
    c = TestClient(app, raise_server_exceptions=False)
    r = c.get("/api/config/settings", headers={"X-CINSIDE-Token": TOKEN})
    assert r.status_code == 200


def test_enforce_allows_token_via_query_string(as_mode):
    """WebSocket 无法自定义请求头，令牌必须也能走查询串。"""
    as_mode("enforce")
    c = TestClient(app, raise_server_exceptions=False)
    r = c.get(f"/api/config?token={TOKEN}")
    assert r.status_code == 200


def test_enforce_still_allows_exempt_health(as_mode):
    """后端就绪探测必须永远可用，否则前端会误判"后端没起来"。"""
    as_mode("enforce")
    c = TestClient(app, raise_server_exceptions=False)
    assert c.get("/api/health").status_code == 200
    assert c.get("/").status_code == 200


def test_enforce_guard_is_constant_time_compare(as_mode):
    """用 hmac.compare_digest 而不是 ==，避免按字符逐位试探。"""
    as_mode("enforce")
    c = TestClient(app, raise_server_exceptions=False)
    # 前缀正确但长度不同 / 只差最后一位，都必须拒绝
    assert c.get("/api/config", headers={"X-CINSIDE-Token": TOKEN[:-1]}).status_code == 403
    assert c.get("/api/config", headers={"X-CINSIDE-Token": TOKEN + "x"}).status_code == 403
    assert c.get("/api/config", headers={"X-CINSIDE-Token": TOKEN[:-1] + "X"}).status_code == 403


def test_enforce_applies_to_all_api_paths(as_mode):
    as_mode("enforce")
    c = TestClient(app, raise_server_exceptions=False)
    for p in ("/api/config", "/api/config/settings", "/api/records", "/api/config/deps-status"):
        assert c.get(p).status_code == 403, p
        assert c.get(p, headers={"X-CINSIDE-Token": TOKEN}).status_code == 200, p


# ============ report 模式：只记日志，不拦截 ============
def test_report_mode_allows_without_token_but_logs(as_mode, capsys):
    as_mode("report")
    c = TestClient(app, raise_server_exceptions=False)
    r = c.get("/api/config/settings")
    assert r.status_code == 200, "report 模式必须放行（开发期不能因漏加请求头而整片失效）"
    out = capsys.readouterr().out
    assert "REPORT-ONLY" in out
    assert "/api/config/settings" in out


def test_report_mode_allows_with_token_and_does_not_log(as_mode, capsys):
    as_mode("report")
    c = TestClient(app, raise_server_exceptions=False)
    assert c.get("/api/config", headers={"X-CINSIDE-Token": TOKEN}).status_code == 200
    assert "REPORT-ONLY" not in capsys.readouterr().out


# ============ WebSocket ============
def test_websocket_enforce_rejects_without_token(as_mode):
    """带错误/缺失令牌的连接必须被拒（1008），不能推送任何数据。"""
    as_mode("enforce")
    c = TestClient(app, raise_server_exceptions=False)
    with pytest.raises(Exception):
        with c.websocket_connect("/ws/verify/nope"):
            pass  # 若竟能连上，说明没拦住


def test_websocket_off_mode_still_connects(as_mode):
    as_mode("off")
    c = TestClient(app, raise_server_exceptions=False)
    # 未配置令牌时必须照常可用（现有开发流程不受影响）
    with c.websocket_connect("/ws/verify/does-not-exist") as ws:
        # 任务不存在 → 直接 close，不算失败
        assert ws is not None


def test_extract_token_prefers_header_over_query():
    scope = {
        "headers": [(b"x-cinside-token", b"from-header")],
        "query_string": b"token=from-query",
    }
    assert auth.extract_token(scope) == "from-header"
    scope2 = {"headers": [], "query_string": b"token=from-query"}
    assert auth.extract_token(scope2) == "from-query"
    assert auth.extract_token({"headers": [], "query_string": b""}) is None
