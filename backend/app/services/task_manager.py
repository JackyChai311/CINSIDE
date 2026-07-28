"""任务管理器：内存态存储 + 异步执行核验任务。

实际项目里应该换成 Redis / DB 持久化，MVP 用内存足够。
"""
from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from ..agents import ConfigurableAgent, get_agent
from ..models import (
    ApplicantRecord,
    FieldComparison,
    PassportData,
    ScreenshotEvent,
    VerificationReport,
    VerificationReportEntry,
    VerificationResult,
    VerificationStep,
    WorkflowConfig,
)
from ..services.comparison import compare_field
from ..services.vision_verify import verify_entry


@dataclass
class _Store:
    """内存存储。"""
    records: dict[str, ApplicantRecord] = field(default_factory=dict)
    passports: dict[str, PassportData] = field(default_factory=dict)  # record_id -> PassportData
    right_records: dict[str, ApplicantRecord] = field(default_factory=dict)  # 右侧参考Excel数据
    tasks: dict[str, VerificationResult] = field(default_factory=dict)
    reports: dict[str, VerificationReport] = field(default_factory=dict)  # task_id -> 新格式报告
    # 每个 task 的进度订阅者（WebSocket 连接）
    subscribers: dict[str, list[asyncio.Queue]] = field(default_factory=dict)
    # 人工暂停步骤的继续信号
    continue_events: dict[str, asyncio.Event] = field(default_factory=dict)


store = _Store()


# ========== 数据源管理 ==========
def upsert_records(records: list[ApplicantRecord]) -> None:
    for r in records:
        store.records[r.record_id] = r


def upsert_passport(record_id: str, p: PassportData) -> None:
    p.record_id = record_id
    store.passports[record_id] = p


def list_records() -> list[ApplicantRecord]:
    return list(store.records.values())


def get_record(rid: str) -> Optional[ApplicantRecord]:
    return store.records.get(rid)


def get_passport(rid: str) -> Optional[PassportData]:
    return store.passports.get(rid)


# ========== 右侧参考Excel管理 ==========
def upsert_right_records(records: list[ApplicantRecord]) -> None:
    store.right_records.clear()
    for r in records:
        store.right_records[r.record_id] = r


def list_right_records() -> list[ApplicantRecord]:
    return list(store.right_records.values())


def clear_right_records() -> None:
    store.right_records.clear()


# ========== 任务进度推送 ==========
def subscribe(task_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    store.subscribers.setdefault(task_id, []).append(q)
    return q


def unsubscribe(task_id: str, q: asyncio.Queue) -> None:
    if task_id in store.subscribers:
        try:
            store.subscribers[task_id].remove(q)
        except ValueError:
            pass


async def _emit(task_id: str, step: VerificationStep) -> None:
    for q in store.subscribers.get(task_id, []):
        await q.put(step)


async def emit_screenshot(task_id: str, event: ScreenshotEvent) -> None:
    """向 task 的所有订阅者推送一帧截图。供 Agent 在 step 回调里调用。"""
    for q in store.subscribers.get(task_id, []):
        await q.put(event)


# ========== 核验主流程 ==========
async def run_verification(record_id: str, university_url: Optional[str] = None) -> str:
    """启动一次核验，返回 task_id。"""
    rec = store.records.get(record_id)
    if not rec:
        raise ValueError(f"record {record_id} not found")

    url = university_url or rec.university_url or "http://localhost:5050"
    task_id = f"task-{uuid.uuid4().hex[:8]}"
    result = VerificationResult(
        task_id=task_id,
        record_id=record_id,
        university_url=url,
        started_at=datetime.now().isoformat(timespec="seconds"),
    )
    store.tasks[task_id] = result

    asyncio.create_task(_run_task(task_id, record_id, url))
    return task_id


async def _run_task(task_id: str, record_id: str, university_url: str) -> None:
    result = store.tasks[task_id]
    rec = store.records[record_id]
    passport = store.passports.get(record_id)

    try:
        agent = get_agent()
        # 注入 task_id，让 Agent 内部的截图回调能推送到正确的订阅者
        agent.task_id = task_id  # type: ignore[attr-defined]
        async for step in agent.verify(
            record_id=record_id,
            university_url=university_url,
            expected_fields=rec.fields,
        ):
            result.steps.append(step)
            await _emit(task_id, step)

        # 构建比对表
        extracted: dict[str, str] = {f.name: f.value for f in agent.extracted_fields}
        # 构建 field -> WebsiteInput 映射（带 label + selector），用于按页面框对比
        input_map = {wi.matched_field: wi for wi in agent.extracted_inputs if wi.matched_field}
        comparisons: list[FieldComparison] = []
        # 用 excel 字段为主序，加上 passport 多出的字段
        all_fields: list[str] = list(rec.fields.keys())
        if passport:
            for k in passport.fields.keys():
                if k not in all_fields:
                    all_fields.append(k)
        for fname in all_fields:
            wi = input_map.get(fname)
            comparisons.append(compare_field(
                field=fname,
                excel_value=rec.fields.get(fname, ""),
                passport_value=passport.fields.get(fname, "") if passport else "",
                website_value=extracted.get(fname, ""),
                website_label=wi.label if wi else None,
                selector_hint=wi.selector_hint if wi else None,
            ))
        result.comparisons = comparisons

        # 用比对结果更新 input_boxes 的 match_status，再推一张带颜色的最终截图
        try:
            boxes = getattr(agent, "input_boxes", []) or []
            vw, vh = getattr(agent, "viewport_size", (None, None))
            if boxes:
                # 构建 selector -> match_status 和 field -> match_status 映射
                sel_to_status: dict[str, str] = {}
                field_to_status: dict[str, str] = {}
                for c in comparisons:
                    if c.selector_hint:
                        sel_to_status[c.selector_hint] = c.match
                    field_to_status[c.field] = c.match
                # 更新每个 box 的 match_status
                for box in boxes:
                    # 优先用 selector 匹配
                    if box.selector and box.selector in sel_to_status:
                        box.match_status = sel_to_status[box.selector]
                    elif box.field and box.field in field_to_status:
                        box.match_status = field_to_status[box.field]
                    else:
                        # 没有对应字段比对的框，保持 pending
                        pass
                # 推最终带颜色的截图（用 agent 存的最后一张截图）
                from ..models import ScreenshotEvent
                last_shot = getattr(agent, "last_screenshot", None)
                if last_shot:
                    final_event = ScreenshotEvent(
                        step=10000,  # 比对完成后的最终更新
                        screenshot=last_shot,
                        url=university_url,
                        title="核验完成",
                        action_hint="比对完成：绿色=一致，红色=不一致",
                        boxes=boxes,
                        viewport_width=vw,
                        viewport_height=vh,
                    )
                    await emit_screenshot(task_id, final_event)
        except Exception as e:
            # 截图叠加失败不影响主流程
            pass

        # 总体结论
        statuses = [c.match for c in comparisons if c.match != "unknown"]
        if not statuses:
            result.overall = "review"
        elif all(s == "match" for s in statuses):
            result.overall = "pass"
        elif any(s == "mismatch" for s in statuses):
            result.overall = "fail"
        else:
            result.overall = "review"

        result.finished_at = datetime.now().isoformat(timespec="seconds")
        # 收尾事件
        await _emit(task_id, VerificationStep(
            step=len(result.steps) + 1,
            action="final",
            description=f"核验完成：{result.overall}",
            detail=f"{len(comparisons)} 个字段比对，{sum(1 for c in comparisons if c.match == 'mismatch')} 个不一致",
        ))

    except Exception as e:
        result.error = str(e)
        result.finished_at = datetime.now().isoformat(timespec="seconds")
        await _emit(task_id, VerificationStep(
            step=len(result.steps) + 1,
            action="error",
            description="任务异常",
            success=False,
            detail=str(e),
        ))


def get_task(task_id: str) -> Optional[VerificationResult]:
    return store.tasks.get(task_id)


def list_tasks() -> list[VerificationResult]:
    return list(store.tasks.values())


# ========== 可配置工作流验证（新） ==========
def get_continue_event(task_id: str) -> asyncio.Event:
    """获取或创建某任务的人工继续信号。"""
    if task_id not in store.continue_events:
        store.continue_events[task_id] = asyncio.Event()
    return store.continue_events[task_id]


def signal_continue(task_id: str) -> bool:
    """发送继续信号；返回是否成功。"""
    ev = store.continue_events.get(task_id)
    if not ev:
        return False
    ev.set()
    return True


async def run_configurable_verification(config: WorkflowConfig) -> str:
    """启动一次用户配置的工作流验证，返回 task_id。"""
    rec = store.records.get(config.record_id) if config.record_id else None
    if not rec and not config.expected_fields:
        raise ValueError(f"record {config.record_id} not found and no expected_fields provided")

    task_id = f"task-{uuid.uuid4().hex[:8]}"
    report = VerificationReport(
        task_id=task_id,
        record_id=config.record_id or "",
        record_name=rec.fields.get("name", "") if rec else "",
        university_url=config.university_url,
        started_at=datetime.now().isoformat(timespec="seconds"),
    )
    store.reports[task_id] = report
    # 同时兼容旧 tasks 列表
    store.tasks[task_id] = VerificationResult(
        task_id=task_id,
        record_id=config.record_id,
        university_url=config.university_url,
        started_at=report.started_at,
    )
    # 预创建继续信号，供人工步骤使用
    store.continue_events[task_id] = asyncio.Event()

    asyncio.create_task(_run_configurable_task(task_id, config))
    return task_id


async def _run_configurable_task(task_id: str, config: WorkflowConfig) -> None:
    report = store.reports[task_id]
    result = store.tasks[task_id]
    rec = store.records.get(config.record_id) if config.record_id else None
    passport = store.passports.get(config.record_id) if rec else None

    try:
        agent = ConfigurableAgent()
        agent.task_id = task_id
        agent.set_workflow_config(config)

        # 合并左侧数据源：Excel + 护照 + 数据库字段；无记录时直接用 expected_fields
        left_values: dict[str, str] = dict(config.expected_fields) if config.expected_fields else {}
        if rec:
            for k, v in rec.fields.items():
                left_values.setdefault(k, v)
        if passport:
            for k, v in passport.fields.items():
                left_values.setdefault(k, v)

        async for step in agent.verify(
            record_id=config.record_id or "",
            university_url=config.university_url,
            expected_fields=left_values,
        ):
            result.steps.append(step)
            await _emit(task_id, step)

        # 按 mapping 逐个验证
        # agent.extracted_fields 是以 right_selector 为 key 存入的，WebsiteField.selector_hint 即 right_selector
        extracted_map = {f.selector_hint or f.name: f for f in agent.extracted_fields}
        entries: list[VerificationReportEntry] = []
        for mp in config.mappings:
            wf = extracted_map.get(mp.right_selector)
            right_value = wf.value if wf else ""

            # 找左侧值
            left_value = ""
            if mp.left_source == "passport" and passport:
                left_value = passport.fields.get(mp.left_field, "")
            elif mp.left_source in ("excel", "database", "manual") and rec:
                left_value = rec.fields.get(mp.left_field, "")
            elif mp.left_source in ("excel", "database", "manual") and config.expected_fields:
                left_value = config.expected_fields.get(mp.left_field, "")

            entry = await verify_entry(
                right_value=right_value,
                left_value=left_value,
                right_label=mp.right_label,
                left_field=mp.left_field,
                method=mp.verify_method,
            )
            entry.mapping_id = mp.mapping_id
            entry.right_selector = mp.right_selector
            entry.left_source = mp.left_source
            entries.append(entry)

        report.entries = entries

        # 总体结论
        statuses = [e.match for e in entries if e.match != "unknown"]
        if not statuses:
            report.overall = "review"
        elif all(s == "match" for s in statuses):
            report.overall = "pass"
        elif any(s in ("mismatch", "error") for s in statuses):
            report.overall = "fail"
        else:
            report.overall = "review"

        report.finished_at = datetime.now().isoformat(timespec="seconds")
        result.finished_at = report.finished_at

        summary = (
            f"共 {len(entries)} 个字段，"
            f"一致 {sum(1 for e in entries if e.match == 'match')}，"
            f"不一致 {sum(1 for e in entries if e.match == 'mismatch')}，"
            f"缺失 {sum(1 for e in entries if e.match == 'missing')}，"
            f"错误 {sum(1 for e in entries if e.match == 'error')}"
        )
        report.summary = summary

        await _emit(task_id, VerificationStep(
            step=len(result.steps) + 1,
            action="final",
            description=f"验证完成：{report.overall}",
            detail=summary,
        ))

    except Exception as e:
        report.error = str(e)
        report.finished_at = datetime.now().isoformat(timespec="seconds")
        result.error = str(e)
        result.finished_at = report.finished_at
        await _emit(task_id, VerificationStep(
            step=len(result.steps) + 1,
            action="error",
            description="任务异常",
            success=False,
            detail=str(e),
        ))


def get_report(task_id: str) -> Optional[VerificationReport]:
    return store.reports.get(task_id)


def list_reports() -> list[VerificationReport]:
    return list(store.reports.values())
