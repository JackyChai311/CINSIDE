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
from pathlib import Path

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
    slide: dict | None = None  # {path, label} — SLIDE STUDIO 的 PPT 对象
    studio: str = "web"  # web / slide / cowork：前端据此自动切换到对应 STUDIO
    context_note: str = ""  # cowork 技能库 + 风格画像（入队时组装）
    max_steps: int = 120
    vision: bool = False
    # 用户确认过的流程（含 steps）；执行时注入提示词，卡片上也能展开看
    plan: dict | None = None

    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    status: str = "queued"  # queued | running | done | error | canceled
    steps: int = 0
    summary: str = ""
    error: str = ""
    actions: list[str] = field(default_factory=list)
    # 固化后的工作流配方（开荒成功后生成；回放/介入用）
    recipe: list[dict] = field(default_factory=list)
    # 对话记录：主聊天框按卡片展示的思考/动作/结果/追问/回答时间线
    transcript: list[dict] = field(default_factory=list)
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
        d["slide_label"] = (self.slide or {}).get("label", "")
        d["slide_path"] = (self.slide or {}).get("path", "")
        return d

    def add_transcript(self, role: str, kind: str, text: str, step: int = 0) -> None:
        """追加一条对话记录（内存上限 400 条；落盘由 _save_transcript 负责）。"""
        text = (text or "").strip()
        if not text:
            return
        entry = {
            "ts": time.time(),
            "role": role,      # user | agent | system
            "kind": kind,      # instruction | thought | action | result | ask | answer | final | error | phase
            "text": text[:2000],
            "step": step,
        }
        self.transcript.append(entry)
        del self.transcript[:-400]
        _save_transcript(self.id, self.transcript)

    def persistable(self) -> dict:
        return {
            "id": self.id,
            "instruction": self.instruction,
            "web": self.web,
            "excel": self.excel,
            "slide": self.slide,
            "studio": self.studio,
            "context_note": self.context_note,
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


# ---------- 对话记录落盘（每卡片一个文件，重启后仍可回看） ----------


def _transcript_path(task_id: str) -> str:
    folder = os.path.join(settings.upload_dir, "_harness", "transcripts")
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, f"{task_id}.json")


def _save_transcript(task_id: str, entries: list[dict]) -> None:
    try:
        with open(_transcript_path(task_id), "w", encoding="utf-8") as f:
            json.dump(entries, f, ensure_ascii=False)
    except OSError:
        pass


def _load_transcript(task_id: str) -> list[dict]:
    try:
        with open(_transcript_path(task_id), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def get_transcript(task_id: str) -> list[dict]:
    """卡片的对话记录：内存优先（运行中最新），否则读落盘文件。"""
    task = get(task_id)
    if task and task.transcript:
        return task.transcript
    return _load_transcript(task_id)


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
        task = QueuedTask(
            instruction=str(raw.get("instruction") or ""),
            web=raw.get("web") if isinstance(raw.get("web"), dict) else None,
            excel=raw.get("excel") if isinstance(raw.get("excel"), dict) else None,
            slide=raw.get("slide") if isinstance(raw.get("slide"), dict) else None,
            studio=str(raw.get("studio") or "web"),
            context_note=str(raw.get("context_note") or ""),
            max_steps=int(raw.get("max_steps") or settings.harness_max_steps),
            vision=bool(raw.get("vision")),
            plan=raw.get("plan") if isinstance(raw.get("plan"), dict) else None,
            id=str(raw.get("id") or uuid.uuid4().hex[:12]),
            created_at=float(raw.get("created_at") or time.time()),
        )
        # 恢复对话记录（重启前已发生的讨论不丢）
        task.transcript = _load_transcript(task.id)
        QUEUE.append(task)


# ---------- 增删查 ----------


def enqueue(
    instruction: str,
    web: dict | None,
    excel: dict | None,
    max_steps: int | None = None,
    vision: bool | None = None,
    plan: dict | None = None,
    slide: dict | None = None,
    studio: str = "web",
    context_note: str = "",
) -> QueuedTask:
    task = QueuedTask(
        instruction=instruction.strip(),
        web=web,
        excel=excel,
        slide=slide,
        studio=studio if studio in ("web", "slide", "cowork") else "web",
        context_note=context_note[:6000],
        max_steps=max(1, min(max_steps or settings.harness_max_steps, 500)),
        vision=settings.harness_vision if vision is None else bool(vision),
        plan=plan,
    )
    QUEUE.append(task)
    task.add_transcript("user", "instruction", task.instruction)
    if task.plan and isinstance(task.plan.get("steps"), list) and task.plan["steps"]:
        task.add_transcript(
            "system", "phase",
            f"已确认执行流程（{len(task.plan['steps'])} 步）：{task.plan.get('title') or ''}",
        )
    _trim()
    _save()
    ensure_worker()
    return task


def get(task_id: str) -> QueuedTask | None:
    return next((t for t in QUEUE if t.id == task_id), None)


def list_tasks() -> list[dict]:
    """新的排前面：卡片区第一眼看到刚安排的任务。

    列表不带 transcript（对话记录按卡片单独拉取，避免轮询负载膨胀）。
    """
    out = []
    for t in sorted(QUEUE, key=lambda t: t.created_at, reverse=True):
        d = t.as_dict()
        d.pop("transcript", None)
        d["transcript_count"] = len(t.transcript)
        out.append(d)
    return out


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
        task.add_transcript("user", "answer", text or "（已跳过）")
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
    step = int(ev.get("step") or ev.get("index") or 0)
    if kind == "step":
        task.steps = int(ev.get("index") or 0)
    elif kind == "thought":
        task.add_transcript("agent", "thought", str(ev.get("text") or ""), step)
    elif kind == "tool_call":
        line = f"#{ev.get('step')} {ev.get('summary') or ev.get('name') or ''}".strip()
        task.actions.append(line)
        del task.actions[:-6]
        task.add_transcript("agent", "action", str(ev.get("summary") or ev.get("name") or ""), step)
    elif kind == "tool_result":
        # 失败的动作要让用户在对话里看到原因；成功只记一行结果摘要
        result = ev.get("result") or {}
        if not ev.get("ok", True):
            task.add_transcript(
                "system", "result",
                f"✗ {ev.get('name') or '动作'} 失败：{str(result.get('error') or '')[:300]}", step,
            )
    elif kind == "phase":
        task.add_transcript("system", "phase", str(ev.get("message") or ""), step)
    elif kind == "warn":
        task.add_transcript("system", "result", f"⚠ {ev.get('message') or ''}", step)
    elif kind == "ask":
        task.ask = {"question": ev.get("question") or "", "options": ev.get("options") or []}
        task.add_transcript("agent", "ask", str(ev.get("question") or ""), step)
    elif kind == "final":
        task.summary = str(ev.get("summary") or "")
        task.status = "done"
        task.finished_at = time.time()
        task.ask = None
        task.add_transcript("agent", "final", task.summary, step)
    elif kind == "error":
        task.error = str(ev.get("message") or "未知错误")
        task.status = "error"
        task.finished_at = time.time()
        task.ask = None
        task.add_transcript("system", "error", task.error, step)
    elif kind == "stopped":
        task.summary = task.summary or "已被用户停止"
        task.status = "canceled"
        task.finished_at = time.time()
        task.ask = None
        task.add_transcript("system", "phase", "已被用户停止", step)


async def _execute(task: QueuedTask) -> None:
    task.status = "running"
    task.started_at = time.time()
    task.steps = 0
    task.actions.clear()
    task.summary = ""
    task.error = ""
    task.ask = None
    _save()

    async def emit(ev: dict) -> None:
        _apply_event(task, ev)
        _save()

    # 批量模式：网页+表格名单任务 → 开荒一条 → 固化配方 → 工具回放其余 → 失败才介入
    if task.studio == "web" and task.web and task.excel:
        try:
            await _execute_batch(task, emit)
            return
        except Exception as e:  # noqa: BLE001 - 批量编排失败回退单次 LLM 执行
            task.add_transcript("system", "phase", f"批量编排不可用（{e}），回退为 HARNESS 逐条执行")
            task.status = "running"
            task.finished_at = 0.0

    session = _new_session_for(task)
    task.session_id = session.task_id
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
            task.add_transcript(
                "agent" if task.status == "done" else "system",
                "final" if task.status == "done" else "error",
                task.summary or task.error or "任务结束",
            )
        _save()


def _new_session_for(task: QueuedTask, **extra) -> runner.HarnessSession:
    return runner.new_session(
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
        slide=runner.SlideBinding(
            path=str((task.slide or {}).get("path") or ""),
            label=str((task.slide or {}).get("label") or "PPT"),
        )
        if task.slide
        else None,
        studio=task.studio,
        context_note=task.context_note,
        max_steps=task.max_steps,
        vision=task.vision,
        plan=task.plan,
        **extra,
    )


async def _execute_batch(task: QueuedTask, emit) -> None:
    """开荒 → 固化 → 回放 → 介入。HARNESS 只跑第一条和失败条，其余由 CINSIDE 工具直接回放。"""
    from . import replay
    from .excel_book import ExcelTarget
    from .web import WebTarget

    excel = ExcelTarget(
        str((task.excel or {}).get("path") or ""),
        work_dir=runner._work_dir(task.id),  # noqa: SLF001
        label=str((task.excel or {}).get("label") or "Excel"),
    )
    await excel.open()
    header, roster = await replay.read_roster(excel)
    if len(roster) < 2:
        raise RuntimeError("名单不足 2 条，无需批量")

    task.add_transcript(
        "system", "phase",
        f"任务名单共 {len(roster)} 条（{('、'.join(header[:8]))}）。HARNESS 先开荒第 1 条，跑通后固化工作流，其余 {len(roster) - 1} 条由工具直接回放。",
    )
    await emit({"type": "phase", "phase": "roster", "message": f"名单 {len(roster)} 条：开荒第 1 条"})

    web = WebTarget(
        settings.effective_harness_cdp(),
        str((task.web or {}).get("url") or ""),
        label=str((task.web or {}).get("label") or "网页"),
        exclude_urls=list((task.web or {}).get("exclude_urls") or []),
    )
    # 批量任务同样先把网页缩到合适比例（本来就合适则不动），避免宽表单字段被截断看不见
    try:
        fit = await web.autofit_zoom()
        if fit.get("changed"):
            task.add_transcript(
                "system", "phase",
                f"已把网页缩放到 {int(round(float(fit.get('applied') or 1) * 100))}%（宽度适配视口）",
            )
    except Exception:  # noqa: BLE001 - 缩放失败不阻断批量
        pass

    # ---- 1) 开荒：LLM 真实跑通第一条，动作录制 ----
    recorder = replay.RecipeRecorder()
    first = roster[0]
    pioneer_note = (
        f"这是批量任务的开荒阶段。任务名单共 {len(roster)} 条，你只处理第 1 条：\n"
        f"{json.dumps(first, ensure_ascii=False)}\n"
        "要求：\n"
        "1. 用最少、最确定的动作把这一条完整跑通（填写→提交→确认成功）。\n"
        "2. 你的每个成功动作会被录制成工作流配方，其余条目将由工具按配方自动回放，"
        "所以不要用与这一条数据无关的一次性动作（如关闭随机弹窗以外的探索性点击）。\n"
        "3. 遇到弹窗/Cookie 提示等公共障碍可以处理，它们也会进配方。\n"
        "4. 跑通第一条就 task_done，不要继续处理其它条目。"
    )
    session = _new_session_for(task, pioneer_note=pioneer_note, recorder=recorder)
    task.session_id = session.task_id
    try:
        await runner.run(session, emit)
    finally:
        task.session_id = ""
    if session.status != "done":
        raise RuntimeError(f"开荒失败：{session.summary or session.status}")
    if not recorder.calls:
        raise RuntimeError("开荒没有录到可回放的动作")

    # ---- 2) 固化：ref → 选择器，行值 → 占位符 ----
    recipe = await replay.solidify(recorder, web, first)
    task.recipe = recipe
    task.add_transcript(
        "system", "phase",
        f"工作流已固化（{len(recipe)} 步）。开始批量回放剩余 {len(roster) - 1} 条，不再逐条调用 AI。",
    )
    await emit({"type": "phase", "phase": "replay", "message": f"配方 {len(recipe)} 步，开始回放"})

    # ---- 3) 回放其余条目；失败条交 HARNESS 介入 ----
    ok_count = 1  # 开荒那条已成功
    failed: list[str] = []
    for idx, row in enumerate(roster[1:], start=2):
        if task.status != "running":
            break
        task.steps = idx
        res = await replay.replay_row(
            recipe, row, idx + 1, web=web, excel=excel, emit=emit, index=idx, total=len(roster),
        )
        if res["ok"]:
            ok_count += 1
            continue
        # ---- 4) 介入：HARNESS 处理这条，并更新配方 ----
        task.add_transcript(
            "system", "phase",
            f"第 {idx} 条回放失败（{res['error']}），HARNESS 介入处理。",
        )
        fix_note = (
            f"批量回放第 {idx}/{len(roster)} 条失败：{res['error']}。\n"
            f"这一条的数据：{json.dumps(row, ensure_ascii=False)}\n"
            f"已固化的工作流配方：{json.dumps(recipe, ensure_ascii=False)[:3000]}\n"
            "请观察当前页面，把这一条完整处理完（从失败处继续，必要时重做整条）。"
            "你的动作会被重新录制用于修正配方。处理完这一条就 task_done。"
        )
        fix_recorder = replay.RecipeRecorder()
        fix_session = _new_session_for(task, pioneer_note=fix_note, recorder=fix_recorder)
        task.session_id = fix_session.task_id
        try:
            await runner.run(fix_session, emit)
        finally:
            task.session_id = ""
        if fix_session.status == "done":
            ok_count += 1
            # 用介入 run 的动作修正配方（整条重录，选择器重新解析）
            if fix_recorder.calls:
                try:
                    new_recipe = await replay.solidify(fix_recorder, web, row)
                    if new_recipe:
                        recipe = new_recipe
                        task.recipe = recipe
                        task.add_transcript("system", "phase", "配方已按介入结果修正，继续回放。")
                except Exception:  # noqa: BLE001
                    pass
        else:
            failed.append(f"第 {idx} 条：{fix_session.summary or fix_session.status}")

    # ---- 收尾：导出表格 + 汇报 ----
    try:
        src = Path(excel.source_path)
        dest = str(src.with_name(f"{src.stem}_BATCH_{time.strftime('%H%M%S')}.xlsx"))
        exported = await excel.save_as(dest)
        if exported.get("saved"):
            task.add_transcript("system", "phase", f"表格已导出：{exported['saved']}")
    except Exception:  # noqa: BLE001
        pass
    await web.aclose()

    summary = (
        f"批量完成：{ok_count}/{len(roster)} 条成功（开荒 1 条 + 工具回放，"
        f"HARNESS 仅在失败时介入）。"
        + (f"失败 {len(failed)} 条：{'；'.join(failed[:5])}" if failed else "全部成功。")
    )
    task.status = "done"
    task.summary = summary
    task.finished_at = time.time()
    task.add_transcript("agent", "final", summary)
    await emit({"type": "final", "summary": summary})
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
