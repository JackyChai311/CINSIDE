"""HARNESS 任务队列（个人桌面的「待执行卡片」）。

设计取舍：
  * **串行执行**：同一个浏览器视图只能被一个智能体遥控，多个任务同时跑会互相点错。
    队列保证「排队 → 一个个来」，用户只管往里丢卡片。
  * **持久化**：卡片落到 `_uploads/_harness/queue.json`。应用重启后未跑完的卡片还在
    （重新标记为 queued），不会因为关个窗口就白安排。
  * **可观测**：每个任务保留最近几条动作摘要与步数，卡片上就能看出「它现在在干什么」。
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import asdict, dataclass, field

from ...config import settings
from . import runner

# 内存里最多保留多少张已结束的卡片（够回看，不至于无限增长）
_MAX_KEEP = 40
# 队列 worker 轮询间隔（秒）：没有任务时的空转成本
_IDLE_TICK = 1.0

_worker: asyncio.Task | None = None


@dataclass
class QueuedTask:
    """一张待执行卡片。"""

    instruction: str
    web: dict | None = None  # {url, label, exclude_urls}
    excel: dict | None = None  # {path, label}
    max_steps: int = 40
    vision: bool = False
    # 用户确认过的流程（含 steps）；执行时注入提示词，卡片上也能展开看
    plan: dict | None = None

    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    status: str = "queued"  # queued | running | done | error | canceled
    steps: int = 0
    summary: str = ""
    error: str = ""
    actions: list[str] = field(default_factory=list)
    ask: dict | None = None  # {question, options}
    session_id: str = ""
    created_at: float = field(default_factory=time.time)
    started_at: float = 0.0
    finished_at: float = 0.0

    # ---------- 序列化 ----------

    def as_dict(self) -> dict:
        d = asdict(self)
        d["session_id"] = "" if self.status != "running" else self.session_id
        d["web_url"] = (self.web or {}).get("url", "")
        d["web_label"] = (self.web or {}).get("label", "")
        d["excel_label"] = (self.excel or {}).get("label", "")
        d["excel_path"] = (self.excel or {}).get("path", "")
        return d

    def persistable(self) -> dict:
        return {
            "id": self.id,
            "instruction": self.instruction,
            "web": self.web,
            "excel": self.excel,
            "max_steps": self.max_steps,
            "vision": self.vision,
            "plan": self.plan,
            "created_at": self.created_at,
        }


QUEUE: list[QueuedTask] = []


# ---------- 持久化 ----------


def _store_path() -> str:
    folder = os.path.join(settings.upload_dir, "_harness")
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, "queue.json")


def _save() -> None:
    """只落地没跑完的卡片；已结束的留在内存里回看即可。"""
    try:
        data = [t.persistable() for t in QUEUE if t.status in ("queued", "running")]
        with open(_store_path(), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
    except OSError:
        pass


def _load() -> None:
    try:
        with open(_store_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return
    if not isinstance(data, list):
        return
    for raw in data:
        if not isinstance(raw, dict) or not raw.get("instruction"):
            continue
        QUEUE.append(
            QueuedTask(
                instruction=str(raw.get("instruction") or ""),
                web=raw.get("web") if isinstance(raw.get("web"), dict) else None,
                excel=raw.get("excel") if isinstance(raw.get("excel"), dict) else None,
                max_steps=int(raw.get("max_steps") or settings.harness_max_steps),
                vision=bool(raw.get("vision")),
                plan=raw.get("plan") if isinstance(raw.get("plan"), dict) else None,
                id=str(raw.get("id") or uuid.uuid4().hex[:12]),
                created_at=float(raw.get("created_at") or time.time()),
            )
        )


# ---------- 增删查 ----------


def enqueue(
    instruction: str,
    web: dict | None,
    excel: dict | None,
    max_steps: int | None = None,
    vision: bool | None = None,
    plan: dict | None = None,
) -> QueuedTask:
    task = QueuedTask(
        instruction=instruction.strip(),
        web=web,
        excel=excel,
        max_steps=max(1, min(max_steps or settings.harness_max_steps, 120)),
        vision=settings.harness_vision if vision is None else bool(vision),
        plan=plan,
    )
    QUEUE.append(task)
    _trim()
    _save()
    ensure_worker()
    return task


def get(task_id: str) -> QueuedTask | None:
    return next((t for t in QUEUE if t.id == task_id), None)


def list_tasks() -> list[dict]:
    """新的排前面：卡片区第一眼看到刚安排的任务。"""
    return [t.as_dict() for t in sorted(QUEUE, key=lambda t: t.created_at, reverse=True)]


def cancel(task_id: str) -> dict:
    task = get(task_id)
    if not task:
        return {"ok": False, "message": "任务不存在"}
    if task.status == "queued":
        task.status = "canceled"
        task.finished_at = time.time()
        task.summary = "已取消（还没轮到执行）"
        _save()
        return {"ok": True, "status": task.status}
    if task.status == "running":
        sess = runner.get_session(task.session_id)
        if sess:
            sess.request_stop()
            return {"ok": True, "status": "stopping"}
        task.status = "canceled"
        task.finished_at = time.time()
        _save()
        return {"ok": True, "status": "canceled"}
    return {"ok": False, "message": "任务已结束"}


def discard(task_id: str) -> dict:
    """把卡片从桌面移除（运行中的先停止）。"""
    task = get(task_id)
    if not task:
        return {"ok": False, "message": "任务不存在"}
    if task.status == "running":
        sess = runner.get_session(task.session_id)
        if sess:
            sess.request_stop()
    QUEUE.remove(task)
    _save()
    return {"ok": True}


def answer(task_id: str, text: str) -> dict:
    task = get(task_id)
    if not task:
        return {"ok": False, "message": "任务不存在"}
    sess = runner.get_session(task.session_id)
    if not sess:
        return {"ok": False, "message": "任务已结束或还没开始"}
    ok = sess.answer(text)
    if ok:
        task.ask = None
    return {"ok": ok}


def clear_finished() -> dict:
    keep = [t for t in QUEUE if t.status in ("queued", "running")]
    removed = len(QUEUE) - len(keep)
    QUEUE[:] = keep
    _save()
    return {"ok": True, "removed": removed}


def _trim() -> None:
    if len(QUEUE) <= _MAX_KEEP:
        return
    finished = [t for t in QUEUE if t.status not in ("queued", "running")]
    for t in finished[: max(0, len(QUEUE) - _MAX_KEEP)]:
        QUEUE.remove(t)


# ---------- 执行 ----------


def _next_queued() -> QueuedTask | None:
    return next((t for t in QUEUE if t.status == "queued"), None)


def _apply_event(task: QueuedTask, ev: dict) -> None:
    kind = ev.get("type")
    if kind == "step":
        task.steps = int(ev.get("index") or 0)
    elif kind == "tool_call":
        line = f"#{ev.get('step')} {ev.get('summary') or ev.get('name') or ''}".strip()
        task.actions.append(line)
        del task.actions[:-6]
    elif kind == "ask":
        task.ask = {"question": ev.get("question") or "", "options": ev.get("options") or []}
    elif kind == "final":
        task.summary = str(ev.get("summary") or "")
        task.status = "done"
        task.finished_at = time.time()
        task.ask = None
    elif kind == "error":
        task.error = str(ev.get("message") or "未知错误")
        task.status = "error"
        task.finished_at = time.time()
        task.ask = None
    elif kind == "stopped":
        task.summary = task.summary or "已被用户停止"
        task.status = "canceled"
        task.finished_at = time.time()
        task.ask = None


async def _execute(task: QueuedTask) -> None:
    task.status = "running"
    task.started_at = time.time()
    task.steps = 0
    task.actions.clear()
    task.summary = ""
    task.error = ""
    task.ask = None
    _save()

    session = runner.new_session(
        instruction=task.instruction,
        web=runner.WebBinding(
            endpoint=settings.effective_harness_cdp(),
            url=str((task.web or {}).get("url") or ""),
            label=str((task.web or {}).get("label") or "网页"),
            exclude_urls=list((task.web or {}).get("exclude_urls") or []),
        )
        if task.web
        else None,
        excel=runner.ExcelBinding(
            path=str((task.excel or {}).get("path") or ""),
            label=str((task.excel or {}).get("label") or "Excel"),
        )
        if task.excel
        else None,
        max_steps=task.max_steps,
        vision=task.vision,
        plan=task.plan,
    )
    task.session_id = session.task_id

    async def emit(ev: dict) -> None:
        _apply_event(task, ev)
        _save()

    try:
        await runner.run(session, emit)
    finally:
        task.session_id = ""
        # runner 已经把结局写进事件流；这里兜底（比如进程级异常）
        if task.status == "running":
            task.status = "error" if session.status == "error" else "done"
            task.summary = task.summary or session.summary
            task.error = task.error or (session.summary if session.status == "error" else "")
            task.finished_at = time.time()
        _save()


async def _worker_loop() -> None:
    while True:
        try:
            task = _next_queued()
            if task is None:
                await asyncio.sleep(_IDLE_TICK)
                continue
            # 手动发起的一次性任务正在跑：等它收工（同一个浏览器不能并行遥控）
            waited = 0.0
            while runner.ACTIVE and waited < 600:
                await asyncio.sleep(0.6)
                waited += 0.6
            if task.status != "queued":
                continue
            await _execute(task)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - worker 不能死
            await asyncio.sleep(1.5)


def ensure_worker() -> None:
    """确保后台 worker 活着（必须在事件循环里调用）。"""
    global _worker
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if _worker is None or _worker.done():
        _worker = loop.create_task(_worker_loop())


_load()
