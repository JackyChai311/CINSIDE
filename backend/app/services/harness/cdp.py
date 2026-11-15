"""极简 Chrome DevTools Protocol 客户端。

HARNESS 用它直接操控 Electron 里的 BrowserView（应用启动时已开
`--remote-debugging-port`，见 frontend/electron/main.cjs 的 CDP_PORT）。

为什么不用 browser-use / playwright：
  * browser-use 未安装且依赖极重（playwright + langchain）；
  * 我们只需要 4 个能力：执行 JS、截图、可信鼠标事件、可信键盘输入；
  * uvicorn[standard] 已带 `websockets`，零新增依赖即可连 CDP。

一个 CDPPage 对应一个页面 target 的 WebSocket（`/json/list` 里的
`webSocketDebuggerUrl`），不做 session/flatten 管理——够用且简单。
"""
from __future__ import annotations

import asyncio
import base64
import itertools
import json
import re
import time
from typing import Any

import httpx

# 截图 base64 动辄几 MB，默认 1MB 上限会直接掐断连接
_WS_MAX_SIZE = 64 * 1024 * 1024


class CDPError(RuntimeError):
    """CDP 调用失败（页面已关闭 / 命令报错 / 连接断开）。"""


class CDPTarget:
    """`/json/list` 里的一条页面 target。"""

    def __init__(self, raw: dict):
        self.id: str = raw.get("id") or ""
        self.type: str = raw.get("type") or ""
        self.title: str = raw.get("title") or ""
        self.url: str = raw.get("url") or ""
        self.ws_url: str = raw.get("webSocketDebuggerUrl") or ""

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return f"<CDPTarget {self.type} {self.url[:60]!r}>"

    def as_dict(self) -> dict:
        return {"id": self.id, "type": self.type, "title": self.title, "url": self.url}


async def list_targets(endpoint: str, timeout: float = 3.0) -> list[CDPTarget]:
    """列出浏览器可调试的 target（页面 / iframe / worker ...）。"""
    url = endpoint.rstrip("/") + "/json/list"
    try:
        # trust_env=False：本机 CDP 端点绝不能走系统代理（否则会 502 Bad Gateway）
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:  # 端口未开 / 未启动 / 非 CDP 端口
        raise CDPError(f"无法访问 CDP 端点 {url}：{e}") from e
    if not isinstance(data, list):
        raise CDPError(f"CDP 端点 {url} 返回了非预期数据")
    return [CDPTarget(item) for item in data if isinstance(item, dict)]


_DEV_UI_RE = re.compile(r"(?:localhost|127\.0\.0\.1):517\d")


def _is_internal(url: str) -> bool:
    """Electron 自己的 UI（React 界面 / DevTools）不算业务网页。

    开发版 vite 端口可能被占用而顺延到 5174/5175…，所以按 517x 整段排除，
    避免 HARNESS 把自己家的界面当成业务网页去点。
    """
    if not url:
        return True
    return url.startswith(
        ("about:", "chrome://", "devtools://", "chrome-extension://", "file://")
    ) or bool(_DEV_UI_RE.search(url))


async def resolve_page_target(
    endpoint: str,
    preferred_url: str = "",
    *,
    exclude_urls: list[str] | None = None,
) -> CDPTarget:
    """按 URL 匹配出要操控的页面 target。

    匹配顺序：
      1. URL 与 preferred_url 完全一致 / 前缀一致（用户选的就是这一页）
      2. URL 包含 preferred 的 host
      3. 第一个非 Electron 内部页
    """
    targets = [t for t in await list_targets(endpoint) if t.type == "page" and t.ws_url]
    if not targets:
        raise CDPError("CDP 上没有可用的页面 target（BrowserView 可能还没加载网页）")

    exclude = {u for u in (exclude_urls or []) if u}

    def _usable(t: CDPTarget) -> bool:
        if _is_internal(t.url):
            return False
        # 另一个 BrowserView 的页面不能被误选
        return not any(t.url and t.url == ex for ex in exclude)

    pool = [t for t in targets if _usable(t)] or targets

    if preferred_url:
        pref = preferred_url.split("#")[0]
        for t in pool:
            if t.url.split("#")[0] == pref:
                return t
        for t in pool:
            if t.url.startswith(pref) or pref.startswith(t.url):
                return t
        try:
            host = httpx.URL(pref).host
        except Exception:
            host = ""
        if host:
            for t in pool:
                if host in t.url:
                    return t
    for t in pool:
        if not _is_internal(t.url):
            return t
    return pool[0]


class CDPPage:
    """单页面 CDP 会话。"""

    def __init__(self, target: CDPTarget, timeout: float = 20.0):
        self.target = target
        self.timeout = timeout
        self._ws = None
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future] = {}
        self._reader_task: asyncio.Task | None = None
        self._connected_at = 0.0

    # ---------- 生命周期 ----------

    async def connect(self) -> "CDPPage":
        if self._ws is not None:
            return self
        import websockets

        try:
            self._ws = await asyncio.wait_for(
                websockets.connect(
                    self.target.ws_url,
                    max_size=_WS_MAX_SIZE,
                    open_timeout=self.timeout,
                    ping_interval=None,  # Electron 对 ping 偶尔不回，交给超时兜底
                ),
                timeout=self.timeout + 2,
            )
        except Exception as e:
            raise CDPError(f"连接页面失败（target 可能已销毁）：{e}") from e
        self._connected_at = time.time()
        self._reader_task = asyncio.create_task(self._reader())
        # 打开必要域；Page.enable 让导航事件可用，Runtime 用于 evaluate
        for domain in ("Page.enable", "Runtime.enable"):
            try:
                await self.send(domain)
            except CDPError:
                pass
        return self

    async def aclose(self) -> None:
        if self._reader_task:
            self._reader_task.cancel()
            self._reader_task = None
        ws, self._ws = self._ws, None
        if ws is not None:
            try:
                await ws.close()
            except Exception:
                pass
        for fut in self._pending.values():
            if not fut.done():
                fut.cancel()
        self._pending.clear()

    async def __aenter__(self) -> "CDPPage":
        return await self.connect()

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    @property
    def alive(self) -> bool:
        """连接是否还可用；发送/读取失败会主动置空，下一次调用即可触发重连。"""
        return self._ws is not None and not getattr(self._ws, "closed", False)

    async def _reader(self) -> None:
        ws = self._ws
        try:
            async for raw in ws:  # type: ignore[union-attr]
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                mid = msg.get("id")
                if mid is None:
                    continue  # 事件通知，暂不消费
                fut = self._pending.pop(int(mid), None)
                if fut and not fut.done():
                    if "error" in msg:
                        fut.set_exception(
                            CDPError(f"{msg['error'].get('message') or msg['error']}")
                        )
                    else:
                        fut.set_result(msg.get("result") or {})
        except asyncio.CancelledError:
            raise
        except Exception as e:
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(CDPError(f"CDP 连接中断：{e}"))
            self._pending.clear()
            self._ws = None

    # ---------- 命令 ----------

    async def send(self, method: str, timeout: float | None = None, **params) -> dict:
        if self._ws is None:
            raise CDPError("CDP 会话未连接")
        mid = next(self._ids)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[mid] = fut
        try:
            await self._ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        except Exception as e:
            self._pending.pop(mid, None)
            # 连接已断：置空让上层重连（页面刷新/关闭都会走到这里）
            self._ws = None
            raise CDPError(f"CDP 发送失败（连接可能已断开）：{e}") from e
        try:
            return await asyncio.wait_for(fut, timeout=timeout or self.timeout)
        except asyncio.TimeoutError:
            self._pending.pop(mid, None)
            raise CDPError(f"CDP 命令超时：{method}")

    async def evaluate(self, expression: str, *, await_promise: bool = True) -> Any:
        """在页面里执行 JS 并按值返回。JS 抛错时转成 CDPError。"""
        result = await self.send(
            "Runtime.evaluate",
            expression=expression,
            returnByValue=True,
            awaitPromise=await_promise,
            userGesture=True,
            includeCommandLineAPI=True,
        )
        if result.get("exceptionDetails"):
            det = result["exceptionDetails"]
            desc = (
                (det.get("exception") or {}).get("description")
                or det.get("text")
                or "页面脚本抛错"
            )
            raise CDPError(str(desc).strip())
        inner = result.get("result") or {}
        if inner.get("subtype") == "undefined" or "value" not in inner:
            return None
        return inner["value"]

    # ---------- 视觉 ----------

    async def screenshot(self, clip: dict | None = None, full_page: bool = False) -> str:
        """返回 PNG 的 base64（不含 data: 前缀）。"""
        params: dict[str, Any] = {"format": "png", "captureBeyondViewport": bool(full_page)}
        if clip:
            params["clip"] = {
                "x": float(clip.get("x", 0)),
                "y": float(clip.get("y", 0)),
                "width": max(1.0, float(clip.get("width", 1))),
                "height": max(1.0, float(clip.get("height", 1))),
                "scale": 1.0,
            }
        res = await self.send("Page.captureScreenshot", timeout=max(self.timeout, 30), **params)
        data = res.get("data") or ""
        if not data:
            raise CDPError("截图返回空数据")
        return data

    # ---------- 可信输入 ----------

    async def mouse_click(self, x: float, y: float, *, button: str = "left", clicks: int = 1) -> None:
        await self.send("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y, button="none")
        for i in range(max(1, clicks)):
            await self.send(
                "Input.dispatchMouseEvent",
                type="mousePressed",
                x=x,
                y=y,
                button=button,
                buttons=1 if button == "left" else 2,
                clickCount=i + 1,
            )
            await self.send(
                "Input.dispatchMouseEvent",
                type="mouseReleased",
                x=x,
                y=y,
                button=button,
                buttons=0,
                clickCount=i + 1,
            )

    async def mouse_move(self, x: float, y: float) -> None:
        await self.send("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y)

    async def mouse_wheel(self, x: float, y: float, delta_x: float = 0, delta_y: float = 0) -> None:
        await self.send(
            "Input.dispatchMouseEvent",
            type="mouseWheel",
            x=x,
            y=y,
            deltaX=delta_x,
            deltaY=delta_y,
        )

    async def insert_text(self, text: str) -> None:
        """走 IME 通道插入文本：React/Vue 受控组件能收到 input 事件。"""
        if text:
            await self.send("Input.insertText", text=text)

    async def press_key(self, key: str, modifiers: int = 0) -> None:
        code, vk = _key_info(key)
        await self.send(
            "Input.dispatchKeyEvent",
            type="keyDown",
            key=key,
            code=code,
            windowsVirtualKeyCode=vk,
            nativeVirtualKeyCode=vk,
            modifiers=modifiers,
        )
        await self.send(
            "Input.dispatchKeyEvent",
            type="keyUp",
            key=key,
            code=code,
            windowsVirtualKeyCode=vk,
            nativeVirtualKeyCode=vk,
            modifiers=modifiers,
        )

    async def navigate(self, url: str, timeout: float = 30.0) -> None:
        await self.send("Page.navigate", timeout=timeout, url=url)


_KEYMAP: dict[str, tuple[str, int]] = {
    "Enter": ("Enter", 13),
    "Tab": ("Tab", 9),
    "Escape": ("Escape", 27),
    "Backspace": ("Backspace", 8),
    "Delete": ("Delete", 46),
    "ArrowUp": ("ArrowUp", 38),
    "ArrowDown": ("ArrowDown", 40),
    "ArrowLeft": ("ArrowLeft", 37),
    "ArrowRight": ("ArrowRight", 39),
    "Home": ("Home", 36),
    "End": ("End", 35),
    "PageUp": ("PageUp", 33),
    "PageDown": ("PageDown", 34),
    "Space": ("Space", 32),
}


def _key_info(key: str) -> tuple[str, int]:
    if key in _KEYMAP:
        return _KEYMAP[key]
    upper = key.upper()
    if len(key) == 1 and key.isalpha():
        return (f"Key{upper}", ord(upper))
    if len(key) == 1 and key.isdigit():
        return (f"Digit{key}", ord(key))
    return (key, 0)


def data_url(png_base64: str) -> str:
    return "data:image/png;base64," + png_base64


def strip_data_url(url: str) -> str:
    if not url:
        return ""
    return url.split(",", 1)[1] if url.startswith("data:") and "," in url else url


def decode_png_size(png_base64: str) -> tuple[int, int]:
    """从 PNG 头里读出宽高（用于把截图尺寸告诉模型）。"""
    try:
        raw = base64.b64decode(png_base64[:64] + "=" * ((4 - len(png_base64[:64]) % 4) % 4))
        if raw[:8] == b"\x89PNG\r\n\x1a\n":
            import struct

            w, h = struct.unpack(">II", raw[16:24])
            return int(w), int(h)
    except Exception:
        pass
    return 0, 0
