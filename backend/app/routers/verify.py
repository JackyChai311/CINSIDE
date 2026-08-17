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
    # 来源类型：excel/database=Excel 表格，passport=文件提取（OCR）——定性「缺件 vs 识别问题」的依据
    left_source: str = ""
    reasoning: str = ""


class LoopAnalysisCard(BaseModel):
    name: str = ""
    overall: str = ""
    summary: str = ""
    # 执行级错误（LOOP 步骤中断等）：与字段比对不一致是两类问题
    error: str = ""
    # 产生报告的流程：entry=录入/提取流，review=审查流
    flow: str = ""
    mismatches: list[LoopAnalysisMismatch] = []
    mrz_warnings: list[str] = []


# 常见 OCR 混淆字符对（单字符差异且命中即判定为识别误差）
_OCR_CONFUSE_PAIRS = {"O0", "0O", "I1", "1I", "l1", "1l", "Il", "lI", "S5", "5S", "B8", "8B", "Z2", "2Z", "G6", "6G", "U0", "0U"}


def _source_label(left_source: str) -> str:
    """来源类型 → 中文名（分析文案统一口径）。"""
    s = (left_source or "").lower()
    if s in ("excel", "database"):
        return "Excel"
    if s == "passport":
        return "文件提取"
    return "来源"


def classify_mismatch(m: LoopAnalysisMismatch) -> str:
    """把一条不一致项定性为固定类别，供 AI 提示词与本地兜底共用同一套判定语义：

    - 来源为空·Excel：表格该单元格没填 → 缺件/漏填
    - 来源为空·文件提取：证件文件里没提到该字段（缺件）或 OCR 未识别到（识别问题）
    - 页面为空：网页侧未读到值（未加载/选择器偏移/页面确实无此字段）
    - 仅格式差异：大小写/空格/连字符不同，实质一致
    - 截断：一侧明显是另一侧的前缀/子串 → 识别截断或页面显示不全
    - OCR 混淆：仅个别字符差异且命中 O/0、I/1 等混淆对 → 识别误差
    - 实质不一致：两侧都有值且确实不同 → 源数据与页面内容冲突，需人工裁定
    """
    src = (m.source_value or "").strip()
    tgt = (m.target_value or "").strip()
    src_name = _source_label(m.left_source)
    if not src and not tgt:
        return "两侧均为空：提取与页面都未读到值"
    if not src:
        if (m.left_source or "").lower() in ("excel", "database"):
            return f"{src_name}为空：表格中未填写该字段（缺件/漏填）"
        return f"{src_name}为空：证件文件中未提到该字段（缺件）或 OCR 未识别到（识别问题）"
    if not tgt:
        return "页面为空：网页未读到该字段（页面未加载完成/元素选择器偏移/页面确实无此字段）"
    norm_s = src.lower().replace(" ", "").replace("-", "").replace("'", "")
    norm_t = tgt.lower().replace(" ", "").replace("-", "").replace("'", "")
    if norm_s == norm_t:
        return "仅格式差异（大小写/空格/连字符），实质一致"
    if norm_s.startswith(norm_t) or norm_t.startswith(norm_s):
        longer, shorter = (src, tgt) if len(norm_s) > len(norm_t) else (tgt, src)
        return f"截断差异：「{shorter}」是「{longer}」的前段，较长一侧被截短（识别截断或显示不全）"
    # 编辑距离很小的单双字符差异 → 检查是否 OCR 混淆对
    if abs(len(src) - len(tgt)) <= 1:
        diffs = [f"{a}{b}" for a, b in zip(src, tgt) if a != b]
        if 0 < len(diffs) <= 2 and all(d in _OCR_CONFUSE_PAIRS for d in diffs):
            return "识别误差：差异字符命中 OCR 混淆对（如 O/0、I/1），实质大概率为同一值"
    return "实质不一致：来源与页面值确实不同，需人工裁定哪侧正确"


class LoopAnalysisRequest(BaseModel):
    cards: list[LoopAnalysisCard] = []
    # batch=整轮结束后的总体总结（默认，兼容旧调用）
    # card=LOOP 运行中单张问题卡片完成后的即时分析（实时追加到执行分析面板）
    mode: str = "batch"
    # 整轮总用时（毫秒，batch 模式可选）：AI 总结与本地兜底都会提到总用时/平均用时
    duration_ms: int | None = None


@router.post("/analysis/loop")
async def loop_analysis(body: LoopAnalysisRequest):
    """LOOP 执行分析。

    mode=batch：整轮结束后的总体总结（错误卡片点名、高频错误字段与可能原因）。
    mode=card：运行中单张问题卡片完成后的即时分析（该卡哪些字段不对、最可能原因），
               前端边跑边追加，实时反馈。

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

    # 用时格式化（秒 → "X分Y秒" / "X秒"）；平均用时 = 总用时 / 卡片数
    def _fmt_sec(sec: float) -> str:
        sec = max(1, round(sec))
        return f"{sec // 60} 分 {sec % 60} 秒" if sec >= 60 else f"{sec} 秒"

    duration_text = ""
    avg_text = ""
    if body.duration_ms is not None and body.duration_ms >= 0 and total > 0:
        total_sec = body.duration_ms / 1000
        duration_text = f"，总用时 {_fmt_sec(total_sec)}"
        avg_text = f"，平均每张 {_fmt_sec(total_sec / total)}"

    def local_summary() -> str:
        lines = [f"本次共处理 {total} 张卡片：{passed} 张通过，{review} 张有问题，{failed} 张需检查（缺件）{duration_text}{avg_text}。"]
        problem_cards = [c for c in cards if c.overall != "pass"]
        if problem_cards:
            lines += ["", "问题卡片："]
            for c in problem_cards[:10]:
                if c.error:
                    lines.append(f"· {c.name}：执行中断——{c.error}")
                    continue
                bad = [m for m in c.mismatches if m.label]
                if bad:
                    fields = "、".join(
                        f"{m.label}（{classify_mismatch(m)}）"
                        for m in bad[:4]
                    )
                    lines.append(f"· {c.name}：{fields}")
                elif c.summary:
                    lines.append(f"· {c.name}：{c.summary}")
        if top_fields:
            lines += [
                "",
                "高频问题字段：" + "、".join(f"{k}（{v} 张卡片）" for k, v in top_fields),
            ]
        mrz_cards = [c for c in cards if c.mrz_warnings]
        if mrz_cards:
            lines += ["", f"另有 {len(mrz_cards)} 张卡片存在 MRZ 交叉验证警告（机读区与视读区不一致，以 MRZ 为准），建议人工复核证件信息。"]
        return "\n".join(lines)

    def local_card_summary(c: LoopAnalysisCard) -> str:
        lines = []
        if c.error:
            lines.append(f"· 执行中断：{c.error}")
        if c.mismatches:
            for m in c.mismatches[:6]:
                lines.append(f"· {m.label}：{_source_label(m.left_source)}「{m.source_value or '空'}」 vs 页面「{m.target_value or '空'}」→ {classify_mismatch(m)}")
        elif c.mrz_warnings:
            lines += [f"· {w}" for w in c.mrz_warnings[:4]]
        elif c.summary:
            lines.append(f"· {c.summary}")
        elif not lines:
            lines.append("· 未发现不一致字段。")
        return "\n".join(lines)

    # LLM 配置：分析专用 key（ANALYSIS_API_*，未配置时逐项继承文本AI→Vision），
    # 与排版/识图分KEY，避免 LOOP 运行中逐卡分析与 OCR 流量互相限流
    base, key, model = settings.effective_analysis_llm()
    if not (base and key and model):
        if settings.browser_use_llm_base and settings.browser_use_llm_key and settings.browser_use_llm_model:
            base = settings.browser_use_llm_base.rstrip("/")
            key = settings.browser_use_llm_key
            model = settings.browser_use_llm_model

    single_mode = body.mode == "card" and cards
    if single_mode:
        # ---- 单卡即时分析（运行中实时追加）：只看这一张卡哪里有问题 ----
        c = cards[0]
        mismatch_lines = []
        for m in c.mismatches[:10]:
            # 每条不一致项附系统定性：AI 基于定性输出原因与建议，不再自由猜测
            line = (
                f"{m.label}: {_source_label(m.left_source)}「{m.source_value or '空'}」 vs 页面「{m.target_value or '空'}」（{m.match}）"
                f" → 定性：{classify_mismatch(m)}"
            )
            if m.reasoning:
                line += f" 说明：{m.reasoning}"
            mismatch_lines.append(line)
        prompt = (
            "以下是 LOOP 批量审查运行中刚完成的一张问题卡片数据。每条不一致项后已附系统定性（缺件/识别误差/实质不一致等），请基于定性分析而非重新猜测。用简洁中文（60~150字）输出该卡片的即时分析：\n"
            "1. 直接点名哪些字段有问题，引用系统定性；\n"
            "2. 按定性给出处置建议：缺件/漏填→通知申请人补交该材料；识别误差（OCR 混淆/截断）→人工核对证件原图即可，大概率非真实错误；页面为空→检查网页加载或映射选择器是否偏移；实质不一致→需人工裁定哪侧数据正确；\n"
            "3. 执行中断（如有 error）与字段不一致分开说明；如有 MRZ 警告需指出。\n"
            "直接给结论，不要寒暄，不要自我介绍，不要 Markdown 标题，可用「·」分条。\n\n"
            f"卡片【{c.name}】结论={c.overall}，流程={c.flow or '未知'}\n"
            + (f"执行错误：{c.error}\n" if c.error else "")
            + (f"摘要：{c.summary}\n" if c.summary else "")
            + ("不一致项：\n" + "\n".join(mismatch_lines) + "\n" if mismatch_lines else "")
            + (f"MRZ警告：{'；'.join(c.mrz_warnings[:3])}" if c.mrz_warnings else "")
        )
        max_tokens = 300
        local_fallback = local_card_summary(c)
    else:
        # ---- 整轮总体总结（结束后 / 手动重新生成）----
        stats = (
            f"共处理{total}张卡片，{passed}张通过，{review}张有问题，{failed}张需检查（缺件）"
            + duration_text + avg_text
            + "。高频问题字段："
            + ("、".join(f"{k}({v}张卡片)" for k, v in top_fields) if top_fields else "无")
        )
        card_lines = []
        for c in cards:
            entry = f"【{c.name}】结论={c.overall}"
            if c.error:
                entry += f"，执行中断：{c.error}"
            if c.mismatches:
                # 附系统定性：AI 总结时直接引用，保证「缺件 vs 识别问题」口径一致
                ms = "；".join(
                    f"{m.label}: {_source_label(m.left_source)}「{m.source_value}」vs 页面「{m.target_value}」({m.match})→ {classify_mismatch(m)}"
                    for m in c.mismatches[:8]
                )
                entry += f"，不一致项：{ms}"
            if c.mrz_warnings:
                entry += f"，MRZ警告：{'；'.join(c.mrz_warnings[:3])}"
            card_lines.append(entry)
        prompt = (
            "以下是一次 LOOP 批量审查的结果数据。每条不一致项后已附系统定性（缺件/识别误差/实质不一致等），请基于定性分析而非重新猜测。用简洁中文输出一段执行分析（150~250字），包含：\n"
            "1. 一句话总体结论（必须包含处理张数、总用时与平均每张用时，数据在下方统计里）；\n"
            "2. 哪几张卡片出了什么问题（点名卡片、字段与定性）；\n"
            "3. 高频错误字段与定性分布（如多为识别误差则整体数据可信度高，多为缺件则需批量通知补交）；\n"
            "4. 可执行的处置建议（按定性分类给出，例如：缺件→通知补交，识别误差→人工核对原图，页面为空→检查映射配置）。\n"
            "直接给结论，不要寒暄，不要自我介绍，不要 Markdown 标题，可用「·」分条。\n\n"
            f"统计：{stats}\n" + "\n".join(card_lines)
        )
        max_tokens = 600
        local_fallback = local_summary()

    if not (base and key and model):
        return {"text": local_fallback, "source": "local"}

    try:
        async with httpx.AsyncClient(timeout=45.0, trust_env=False) as client:
            resp = await client.post(
                base + "/chat/completions",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": max_tokens,
                    "temperature": 0.3,
                },
            )
            if resp.status_code == 404 and model != model.lower():
                # 端点模型名大小写敏感（SenseNova 对 DeepSeek-V4-Flash 报 "model is not found"）
                # → 小写重试一次，避免分析静默降级为本地统计摘要
                resp = await client.post(
                    base + "/chat/completions",
                    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                    json={
                        "model": model.lower(),
                        "messages": [{"role": "user", "content": prompt}],
                        "max_tokens": max_tokens,
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
    return {"text": local_fallback, "source": "local"}
