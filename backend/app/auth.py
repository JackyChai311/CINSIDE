"""进程间接口鉴权（共享令牌）。

## 为什么需要它

后端监听 127.0.0.1。渲染进程里的 BrowserView 使用 ``webSecurity: false``
加载**第三方学校网站**，而该设置会让页面**绕过 CORS 检查**。
因此任何被载入核验的第三方页面都可以直接 ``fetch`` 本机后端，读取：

- ``/api/config/settings`` —— 明文返回全部 5 个 API Key；
- ``/api/records``、``/api/verify/report/{id}`` —— 含护照号等个人数据。

CORS 白名单对此**无效**（webSecurity 关闭时浏览器不再执行 CORS 检查），
所以必须引入一个第三方页面拿不到的共享密钥：由 Electron 主进程在启动时
随机生成，经环境变量交给后端、经 preload 交给自家渲染进程。

## 令牌如何传递

- HTTP：请求头 ``X-CINSIDE-Token: <token>``；
- 查询串：``?token=<token>`` —— 给 WebSocket 用，
  因为浏览器 WebSocket API 无法自定义请求头。

## 三种模式（CINSIDE_API_AUTH）

- ``off``     —— 完全不校验（未配置令牌时的默认值，也是逃生开关）
- ``report``  —— 校验但只记日志、不拦截（**开发环境默认**：
                 保证开发期不会因为漏加请求头而整片功能失效）
- ``enforce`` —— 校验失败返回 403 / 关闭 WS（**生产环境默认**）

未设置 ``CINSIDE_API_TOKEN`` 时一律等价于 ``off``，
这样 ``python run.py`` 单独起后端、以及 pytest 都完全不受影响。
"""
from __future__ import annotations

import os
from urllib.parse import parse_qs

from starlette.responses import JSONResponse

# 环境变量名（Electron 主进程负责设置）
ENV_TOKEN = "CINSIDE_API_TOKEN"
ENV_MODE = "CINSIDE_API_AUTH"

# 受保护范围：/api 下的 HTTP 接口，以及 /ws 下的 WebSocket。
# /ws 必须一并覆盖 —— 它会推送护照等个人数据。
PROTECTED_PREFIXES = ("/api", "/ws")

# 免鉴权路径：
#   "/"            仅返回名称/版本，不含任何敏感信息
#   "/api/health"  仅返回 {ok, agent_backend}；渲染进程有 2 处用它做后端就绪探测，
#                  豁免它可以确保"连不上后端"这类基础能力永远不会被鉴权改坏
EXEMPT_PATHS = frozenset({"/", "/api/health"})

_VALID_MODES = frozenset({"off", "report", "enforce"})


def _read_token() -> str:
    return (os.environ.get(ENV_TOKEN) or "").strip()


def _read_mode(token: str) -> str:
    raw = (os.environ.get(ENV_MODE) or "").strip().lower()
    if not token:
        # 没有令牌就无从校验，强制 off（保证单独起后端/pytest 不受影响）
        return "off"
    if raw not in _VALID_MODES:
        # 显式给了令牌但模式非法/未设置 → 取最安全的生产默认值 enforce。
        # 开发环境由 Electron 主进程显式传 report，不依赖这里的兜底。
        return "enforce"
    return raw


# 模块级读取一次：Electron 在主进程启动后端时就通过 env 传入，运行期不会变
TOKEN = _read_token()
MODE = _read_mode(TOKEN)


def is_authorized(supplied: str | None) -> bool:
    """常量时间比较，避免按字符逐位试探。"""
    if not TOKEN or not supplied:
        return False
    import hmac

    return hmac.compare_digest(supplied, TOKEN)


def _extract_from_headers(scope) -> str | None:
    for key, value in scope.get("headers", []):
        if key == b"x-cinside-token":
            try:
                return value.decode("latin-1")
            except Exception:
                return None
    return None


def _extract_from_query(scope) -> str | None:
    qs = scope.get("query_string") or b""
    if not qs:
        return None
    try:
        params = parse_qs(qs.decode("latin-1"))
    except Exception:
        return None
    vals = params.get("token")
    return vals[0] if vals else None


def extract_token(scope) -> str | None:
    """请求头优先，其次查询串（WebSocket 只能走查询串）。"""
    return _extract_from_headers(scope) or _extract_from_query(scope)


def is_protected_path(path: str) -> bool:
    if path in EXEMPT_PATHS:
        return False
    return path.startswith(PROTECTED_PREFIXES)


def describe_mode() -> str:
    """给启动日志用的一行说明。"""
    if not TOKEN:
        return "未配置令牌 → 接口鉴权关闭（off）"
    return f"接口鉴权模式 = {MODE}（令牌已配置，长度 {len(TOKEN)}）"


class ApiAuthMiddleware:
    """纯 ASGI 中间件，对 http 与 websocket 都生效。

    用纯 ASGI 而不是 BaseHTTPMiddleware：后者拿不到 websocket 作用域，
    而 WebSocket 恰好也会推送护照相关数据，必须一并保护。
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        stype = scope.get("type")
        if MODE == "off" or stype not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "") or ""
        if not is_protected_path(path):
            await self.app(scope, receive, send)
            return

        if is_authorized(extract_token(scope)):
            await self.app(scope, receive, send)
            return

        _log_rejection(stype, path)

        if MODE == "report":
            # 只报告不拦截：开发期漏加请求头时功能照常，但日志里能看到
            await self.app(scope, receive, send)
            return

        if stype == "websocket":
            # 1008 = policy violation
            await send({"type": "websocket.close", "code": 1008})
            return

        response = JSONResponse(
            status_code=403,
            content={
                "detail": (
                    "缺少或无效的接口令牌。本接口仅允许 CINSIDE 自身进程调用；"
                    "若你在开发环境直接起后端，请设置 CINSIDE_API_AUTH=off。"
                )
            },
        )
        await response(scope, receive, send)


def _log_rejection(stype: str, path: str) -> None:
    tag = "REPORT-ONLY" if MODE == "report" else "BLOCKED"
    print(f"[api-auth][{tag}] 未通过令牌校验: {stype} {path}", flush=True)
