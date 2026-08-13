"""核验任务路由。"""
from __future__ import annotations

from collections import Counter
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from ..config import settings
from ..models import WorkflowConfig
from ..services.report_excel import generate_excel, generate_filename
from ..services.task_manager import (
    get_record,
    get_report,
    get_task,
    list_tasks,
    run_configurable_verification,
    run_verification,
    signal_continue,
)

router = APIRouter(prefix="/api/verify", tags=["verify"])


class VerifyRequest(BaseModel):
    record_id: str
    university_url: Optional[str] = None


@router.post("")
async def start_verify(req: VerifyRequest):
    """触发一次核验，立即返回 task_id，后续通过 WebSocket 跟进进度。"""
    rec = get_record(req.record_id)
    if not rec:
        raise HTTPException(404, f"record {req.record_id} not found")
    try:
        task_id = await run_verification(req.record_id, req.university_url)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"task_id": task_id, "record_id": req.record_id}


@router.get("/{task_id}")
def get_result(task_id: str):
    t = get_task(task_id)
    if not t:
        raise HTTPException(404, "task not found")
    return t.model_dump()


@router.get("")
def list_all():
    return {"tasks": [t.model_dump() for t in list_tasks()]}


# ========== 可配置工作流验证（新） ==========

@router.post("/configurable")
async def start_configurable_verify(config: WorkflowConfig):
    """启动用户配置的工作流验证。"""
    rec = get_record(config.record_id)
    if not rec:
        raise HTTPException(404, f"record {config.record_id} not found")
    try:
        task_id = await run_configurable_verification(config)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"task_id": task_id, "record_id": config.record_id, "mode": "configurable"}


@router.get("/report/{task_id}")
def get_verification_report(task_id: str):
    report = get_report(task_id)
    if not report:
        raise HTTPException(404, "report not found")
    return report.model_dump()


@router.post("/{task_id}/continue")
def continue_manual_step(task_id: str):
    """当工作流遇到 manual 步骤时，由前端调用以继续执行。"""
    if signal_continue(task_id):
        return {"ok": True, "task_id": task_id}
    raise HTTPException(404, "task not found or not waiting for manual step")


@router.get("/report/{task_id}/excel")
def download_excel_report(task_id: str):
    report = get_report(task_id)
    if not report:
        raise HTTPException(404, "report not found")
    data = generate_excel(report)
    filename = generate_filename(report)
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ========== LOOP 执行分析（执行结束后 AI 异步总结） ==========

class LoopAnalysisMismatch(BaseModel):
    label: str = ""
    source_value: str = ""
    target_value: str = ""
    match: str = ""
    reasoning: str = ""


class LoopAnalysisCard(BaseModel):
    name: str = ""
    overall: str = ""
    summary: str = ""
    mismatches: list[LoopAnalysisMismatch] = []
    mrz_warnings: list[str] = []


class LoopAnalysisRequest(BaseModel):
    cards: list[LoopAnalysisCard] = []


@router.post("/analysis/loop")
async def loop_analysis(body: LoopAnalysisRequest):
    """LOOP 审查结束后的执行分析：总结各卡片错误、高频错误字段与可能原因。

    优先调用已配置的 LLM（browser_use_llm，回退 vision）生成自然语言分析；
    未配置或调用失败时返回本地统计摘要，保证功能始终可用。
    """
    cards = body.cards
    total = len(cards)
    passed = sum(1 for c in cards if c.overall == "pass")
    review = sum(1 for c in cards if c.overall == "review")
    failed = sum(1 for c in cards if c.overall == "fail")

    # 高频问题字段统计（每张卡片同一字段只计一次）
    field_counter: Counter[str] = Counter()
    for c in cards:
        seen: set[str] = set()
        for m in c.mismatches:
            key = m.label or "未知字段"
            if key not in seen:
                field_counter[key] += 1
                seen.add(key)
    top_fields = field_counter.most_common(5)

    def local_summary() -> str:
        lines = [f"本次共审查 {total} 张卡片：{passed} 张全部一致，{review} 张需复核，{failed} 张失败。"]
        problem_cards = [c for c in cards if c.overall != "pass"]
        if problem_cards:
            lines += ["", "问题卡片："]
            for c in problem_cards[:10]:
                bad = [m for m in c.mismatches if m.label]
                if bad:
                    fields = "、".join(
                        f"{m.label}（来源「{m.source_value or '空'}」≠ 页面「{m.target_value or '空'}」）"
                        for m in bad[:4]
                    )
                    lines.append(f"· {c.name}：{fields}")
                elif c.summary:
                    lines.append(f"· {c.name}：{c.summary}")
        if top_fields:
            lines += [
                "",
                "高频问题字段：" + "、".join(f"{k}（{v} 张卡片）" for k, v in top_fields),
                "可能原因：网页元素未加载完成导致读取为空、字段映射选择器发生偏移、或源数据与页面数据确实不一致。",
            ]
        mrz_cards = [c for c in cards if c.mrz_warnings]
        if mrz_cards:
            lines += ["", f"另有 {len(mrz_cards)} 张卡片存在 MRZ 交叉验证警告，建议人工复核证件信息。"]
        return "\n".join(lines)

    # LLM 配置：优先 browser_use_llm，回退 vision（均为 OpenAI 兼容接口）
    base = (settings.browser_use_llm_base or "").rstrip("/")
    key = settings.browser_use_llm_key or ""
    model = settings.browser_use_llm_model or ""
    if not (base and key and model):
        if settings.vision_api_base and settings.vision_api_key and settings.vision_model:
            base = settings.vision_api_base.rstrip("/")
            key = settings.vision_api_key
            model = settings.vision_model
    if not (base and key and model):
        return {"text": local_summary(), "source": "local"}

    stats = (
        f"共{total}张卡片，{passed}张通过，{review}张需复核，{failed}张失败。高频问题字段："
        + ("、".join(f"{k}({v}张卡片)" for k, v in top_fields) if top_fields else "无")
    )
    card_lines = []
    for c in cards:
        entry = f"【{c.name}】结论={c.overall}"
        if c.mismatches:
            ms = "；".join(
                f"{m.label}: 来源「{m.source_value}」vs 页面「{m.target_value}」({m.match})"
                for m in c.mismatches[:8]
            )
            entry += f"，不一致项：{ms}"
        if c.mrz_warnings:
            entry += f"，MRZ警告：{'；'.join(c.mrz_warnings[:3])}"
        card_lines.append(entry)
    prompt = (
        "以下是一次 LOOP 批量审查的结果数据。请用简洁中文输出一段执行分析（150~250字），包含：\n"
        "1. 一句话总体结论；\n"
        "2. 哪几张卡片出了什么错（点名卡片和字段）；\n"
        "3. 高频错误字段；\n"
        "4. 最可能的原因（例如：网页未加载完成、映射选择器偏移、源数据本身有误）。\n"
        "直接给结论，不要寒暄，不要自我介绍，不要用 Markdown 标题，可用「·」分条。\n\n"
        f"统计：{stats}\n" + "\n".join(card_lines)
    )
    try:
        async with httpx.AsyncClient(timeout=45.0, trust_env=False) as client:
            resp = await client.post(
                base + "/chat/completions",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 600,
                    "temperature": 0.3,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "").strip()
            if text:
                return {"text": text, "source": "ai"}
    except Exception:
        pass
    return {"text": local_summary(), "source": "local"}
