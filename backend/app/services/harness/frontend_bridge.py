"""HARNESS ↔ CINSIDE LOOP 桥（前端执行器代办通道）。

HARNESS 的 LLM 循环跑在后端，而 CINSIDE 真正的自动化引擎
（人物卡片 / WorkflowTemplate / executeTemplateForRecord / runBatch，
含前置点击、绑定输入、挂件、文件提取、收尾点击的完整 CIRCLE）在前端渲染进程里。
本模块提供一条「后端工具 → 前端执行器」的请求/回执通道：

  1. HARNESS 工具调用 → call_frontend(tool, args) 挂一个 Future；
  2. 前端 App 轮询 GET /api/harness/bridge/pending 拿到请求，
     用真正的 LOOP 引擎执行（生成卡片/建模板/试跑第一张/批量回放）；
  3. 前端 POST /api/harness/bridge/result 回执 → Future 完成 → 工具返回给 LLM。

同一时刻只有一个 HARNESS 任务在跑（scheduler 串行），请求按序下发即可。
"""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field

# 单个请求最长等待（批量回放可能很久）
_CALL_TIMEOUT = 3600.0
# 未被领取的请求过期时间：前端长时间不取（页面关了）就不再堆积
_PENDING_TTL = 120.0


class BridgeError(RuntimeError):
    pass


@dataclass
class BridgeCall:
    id: str
    tool: str
    args: dict
    created_at: float = field(default_factory=time.time)
    future: asyncio.Future | None = None


# 待领取请求（前端轮询取走）与等待回执的 future（取走后仍按 id 可回执）
_PENDING: list[BridgeCall] = []
_WAITING: dict[str, asyncio.Future] = {}


async def call_frontend(tool: str, args: dict, timeout: float = _CALL_TIMEOUT) -> dict:
    """HARNESS 工具侧：把一次调用交给前端 LOOP 执行器，等回执。"""
    call = BridgeCall(id=uuid.uuid4().hex[:12], tool=tool, args=args)
    call.future = asyncio.get_running_loop().create_future()
    _PENDING.append(call)
    _WAITING[call.id] = call.future
    try:
        return await asyncio.wait_for(call.future, timeout=timeout)
    except asyncio.TimeoutError:
        raise BridgeError(
            f"前端 LOOP 执行器 {int(timeout)} 秒内没有回执（{tool}）。"
            "请确认 CINSIDE 主窗口开着且没有被挂起。"
        ) from None
    finally:
        if call in _PENDING:
            _PENDING.remove(call)
        _WAITING.pop(call.id, None)


def take_pending() -> list[dict]:
    """前端轮询：取走待执行请求（取走即出队，结果按 id 回执）。"""
    now = time.time()
    out: list[dict] = []
    for call in list(_PENDING):
        _PENDING.remove(call)
        if now - call.created_at > _PENDING_TTL:
            if call.future and not call.future.done():
                call.future.set_exception(
                    BridgeError("前端执行器长时间未领取请求（页面可能已关闭）")
                )
            continue
        out.append({"id": call.id, "tool": call.tool, "args": call.args})
    return out


def submit_result(call_id: str, result: dict) -> bool:
    """前端回执：按请求 id 完成 Future。未知/已完成 id 幂等返回 False。"""
    fut = _WAITING.get(call_id)
    if fut is None or fut.done():
        return False
    fut.set_result(result)
    return True


def has_waiters() -> bool:
    """是否有 HARNESS 工具正在等前端回执（前端据此决定轮询频率）。"""
    return bool(_WAITING)