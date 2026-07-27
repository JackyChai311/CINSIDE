"""Vision API 字段验证服务。

支持两种判定方式：
1. 规则判定（exact / contains）—— 不调用 API，本地完成
2. Vision 判定（vision / ocr）—— 调用多模态 LLM，返回是否一致 + 理由
"""
from __future__ import annotations

import base64
import json
import re
from typing import Literal

import httpx

from ..config import settings
from ..models import VerificationReportEntry


_MATCH_MAP = {
    "一致": "match",
    "相同": "match",
    "match": "match",
    "true": "match",
    "不同": "mismatch",
    "不一致": "mismatch",
    "mismatch": "mismatch",
    "false": "mismatch",
    "缺失": "missing",
    "missing": "missing",
    "错误": "error",
    "error": "error",
    "未知": "unknown",
    "unknown": "unknown",
}


def _normalize(text: str | None) -> str:
    if text is None:
        return ""
    return str(text).strip()


def _rule_verify(
    right_value: str,
    left_value: str,
    method: Literal["exact", "contains"],
) -> tuple[str, str]:
    """本地规则判定，返回 (match, reasoning)。"""
    r = _normalize(right_value)
    l = _normalize(left_value)
    if not r and not l:
        return "match", "两侧均为空"
    if not r:
        return "missing", "右侧值为空"
    if not l:
        return "missing", "左侧值为空"
    if method == "exact":
        if r.lower() == l.lower():
            return "match", f"完全一致: {r}"
        return "mismatch", f"不一致: 右侧={r}, 左侧={l}"
    if method == "contains":
        if l.lower() in r.lower() or r.lower() in l.lower():
            return "match", f"互相包含: 右侧={r}, 左侧={l}"
        return "mismatch", f"不包含: 右侧={r}, 左侧={l}"
    return "unknown", "未知规则"


def _parse_verdict(text: str | None) -> tuple[str, str]:
    """从 LLM 响应中解析 verdict 和 reasoning。"""
    if not text:
        return "unknown", "LLM 无响应"
    text_lower = text.lower()
    # 优先找 JSON 块
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try:
            data = json.loads(m.group(0))
            verdict_raw = str(data.get("verdict", "unknown")).lower()
            reasoning = data.get("reasoning") or data.get("reason") or text
            return _MATCH_MAP.get(verdict_raw, "unknown"), str(reasoning)
        except Exception:
            pass
    # 否则从文本中推断
    for keyword, status in [
        ("一致", "match"),
        ("相同", "match"),
        ("match", "match"),
        ("不同", "mismatch"),
        ("不一致", "mismatch"),
        ("mismatch", "mismatch"),
        ("缺失", "missing"),
        ("missing", "missing"),
    ]:
        if keyword in text_lower:
            return status, text.strip()
    return "unknown", text.strip()


def _build_text_prompt(right_value: str, left_value: str, right_label: str | None, left_field: str) -> str:
    return (
        "你是一个数据核验助手。请判断以下两个值是否表示同一信息。"
        "右侧是学校系统中该字段的值，左侧是期望值。\n\n"
        f"字段: {right_label or left_field}\n"
        f"右侧值: {_normalize(right_value) or '(空)'}\n"
        f"左侧期望值: {_normalize(left_value) or '(空)'}\n\n"
        "请考虑：\n"
        "- 大小写差异（如 Chinese vs CHINESE）视为一致\n"
        "- 格式差异（如 1995/03/15 vs 1995-03-15）视为一致\n"
        "- 全角半角、多余空格、标点差异通常视为一致\n"
        "- 只有实质性内容差异才视为不一致\n\n"
        '请用 JSON 返回：{"verdict": "match|mismatch|missing|unknown", "reasoning": "理由"}'
    )


async def _vision_verify_text(
    right_value: str,
    left_value: str,
    right_label: str | None,
    left_field: str,
) -> tuple[str, str]:
    """调用 Vision LLM 判断两个文本值是否表示同一信息。"""
    if not settings.vision_api_key:
        # 未配置 Vision API，回退到规则
        return _rule_verify(right_value, left_value, "exact")

    prompt = _build_text_prompt(right_value, left_value, right_label, left_field)

    url = settings.vision_api_base.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.vision_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": settings.vision_model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
    }

    try:
        async with httpx.AsyncClient(timeout=60.0, trust_env=False) as client:
            resp = await client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
            text = data["choices"][0]["message"]["content"]
            return _parse_verdict(text)
    except Exception as e:
        return "error", f"Vision API 调用失败: {e}"


async def _vision_ocr_verify(
    image_base64: str,
    left_value: str,
    right_label: str | None,
    left_field: str,
) -> tuple[str, str]:
    """对图片 OCR 提取文本，再与左侧值做 Vision 对比。"""
    if not settings.vision_api_key:
        return "error", "未配置 Vision API，无法 OCR"

    url = settings.vision_api_base.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.vision_api_key}",
        "Content-Type": "application/json",
    }

    # 第一步：OCR 提取图片中的文字
    ocr_prompt = (
        "请识别这张图片中的所有文字，并以纯文本形式返回。"
        "不要添加任何解释，只输出识别到的文字内容。"
    )
    ocr_payload = {
        "model": settings.vision_model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": ocr_prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_base64}"}},
                ],
            }
        ],
        "temperature": 0.1,
    }

    try:
        async with httpx.AsyncClient(timeout=60.0, trust_env=False) as client:
            resp = await client.post(url, headers=headers, json=ocr_payload)
            resp.raise_for_status()
            data = resp.json()
            ocr_text = data["choices"][0]["message"]["content"].strip()
            if not ocr_text:
                return "missing", "OCR 未识别到文字"

            # 第二步：用 Vision 对比 OCR 结果和左侧期望值
            compare_prompt = _build_text_prompt(ocr_text, left_value, right_label, left_field)
            compare_payload = {
                "model": settings.vision_model,
                "messages": [{"role": "user", "content": compare_prompt}],
                "temperature": 0.1,
            }
            resp2 = await client.post(url, headers=headers, json=compare_payload)
            resp2.raise_for_status()
            data2 = resp2.json()
            verdict_text = data2["choices"][0]["message"]["content"]
            match, reasoning = _parse_verdict(verdict_text)
            return match, f"OCR识别: {ocr_text}; {reasoning}"
    except Exception as e:
        return "error", f"OCR/Vision API 调用失败: {e}"


def _is_base64_image(value: str) -> bool:
    """粗略判断一段字符串是否为截图/图片 base64（OCR 来源）。"""
    if not value:
        return False
    if value.startswith("data:image"):
        return True
    # 截图 base64 通常很长且纯 base64 字符
    if len(value) > 200 and re.match(r"^[A-Za-z0-9+/=]+$", value):
        return True
    return False


async def verify_entry(
    right_value: str,
    left_value: str,
    right_label: str | None,
    left_field: str,
    method: Literal["smart", "exact", "contains", "vision", "ocr"],
) -> VerificationReportEntry:
    """对单个字段执行验证，返回报告条目。"""
    # 空值快速处理：右侧没提取到就不应该算匹配
    if not right_value or not right_value.strip():
        return VerificationReportEntry(
            right_selector="",
            right_label=right_label,
            left_source="",
            left_field=left_field,
            right_value=right_value,
            left_value=left_value,
            match="missing",
            reasoning="右侧网页未提取到值，无法比对",
        )
    if not left_value or not left_value.strip():
        return VerificationReportEntry(
            right_selector="",
            right_label=right_label,
            left_source="",
            left_field=left_field,
            right_value=right_value,
            left_value=left_value,
            match="review",
            reasoning="左侧期望值为空，请检查数据源",
        )

    # 兼容旧数据：vision/ocr 归为智能匹配，contains 归为精确匹配
    if method in ("contains",):
        match, reasoning = _rule_verify(right_value, left_value, "exact")
    elif method in ("exact",):
        match, reasoning = _rule_verify(right_value, left_value, "exact")
    elif method == "ocr":
        match, reasoning = await _vision_ocr_verify(right_value, left_value, right_label, left_field)
    elif method in ("smart", "vision"):
        # 智能匹配：图片 base64 自动 OCR，文本直接走 Vision 判定
        if _is_base64_image(right_value):
            match, reasoning = await _vision_ocr_verify(right_value, left_value, right_label, left_field)
        else:
            match, reasoning = await _vision_verify_text(right_value, left_value, right_label, left_field)
    else:
        match, reasoning = await _vision_verify_text(right_value, left_value, right_label, left_field)

    return VerificationReportEntry(
        right_selector="",
        right_label=right_label,
        left_source="",
        left_field=left_field,
        right_value=right_value,
        left_value=left_value,
        match=match,  # type: ignore[arg-type]
        reasoning=reasoning,
    )
