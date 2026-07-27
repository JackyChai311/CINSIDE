"""AI 智能识别 Excel 表头字段映射。

调用 LLM（OpenAI 兼容接口），分析 Excel 表头和样例数据，
自动识别哪一列对应学生姓名、护照号、邮箱等标准字段。

这样不依赖硬编码的别名表，能适配任意 Excel 结构
（如 Student / 姓名 / Full Name / 申请人 等各种表头写法）。

如果未配置 LLM key，返回空映射，调用方回退到硬编码别名表。
"""
from __future__ import annotations

import json
import re

from ..config import settings

# 标准字段列表 + 描述（给 LLM 看）
_STANDARD_FIELDS = {
    "name": "申请人/学生姓名（英文、拼音或中文）",
    "passport_no": "护照号码",
    "nationality": "国籍",
    "birth_date": "出生日期",
    "gender": "性别",
    "passport_issue": "护照签发日期",
    "passport_expiry": "护照有效期",
    "email": "邮箱地址",
    "phone": "电话号码",
    "student_id": "学生 ID / 申请编号 / 流水号",
    "university_url": "大学申请页 URL",
    "university_name": "大学名称",
}

_DETECT_PROMPT = """你是一个 Excel 数据分析助手。下面是一个 Excel 文件的表头和前几行样例数据。

请分析每一列对应的标准字段，返回 JSON 格式的映射：
{{
  "原始列名1": "标准字段名",
  "原始列名2": "标准字段名"
}}

可用的标准字段：
{fields}

要求：
1. 严格按 JSON 输出，不要有任何额外文字或解释
2. 无法对应任何标准字段的列，值填 "unknown"
3. 姓名列（如 Student / Name / 姓名 / Full Name / Applicant 等）映射到 "name"
4. 同时分析列名和实际数据内容来判断
5. 表头为空的列，用 "列1" / "列2" ... 作为 key（按位置编号）

表头：{headers}

样例数据（前3行）：
{samples}
"""


def _build_prompt(headers: list[str], sample_rows: list[list]) -> str:
    fields_desc = "\n".join(f"- {k}: {v}" for k, v in _STANDARD_FIELDS.items())
    # 给空表头列编号
    display_headers = []
    for i, h in enumerate(headers):
        display_headers.append(h if h else f"列{i+1}")
    samples_str = "\n".join(
        f"行{i+1}: " + ", ".join(f"{display_headers[j]}={v}" for j, v in enumerate(row) if j < len(display_headers))
        for i, row in enumerate(sample_rows[:3])
    )
    return _DETECT_PROMPT.format(
        fields=fields_desc,
        headers=display_headers,
        samples=samples_str,
    )


def _parse_mapping(text: str, headers: list[str]) -> dict[str, str]:
    """从 LLM 响应中解析字段映射，并校验。"""
    if not text:
        return {}
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return {}
    try:
        raw = json.loads(m.group(0))
    except Exception:
        return {}

    # 把空表头列编号映射回原始空字符串 key
    result: dict[str, str] = {}
    for i, h in enumerate(headers):
        col_key = h if h else f"列{i+1}"
        field = raw.get(col_key) or raw.get(h) or ""
        field = str(field).strip().lower()
        if field in _STANDARD_FIELDS:
            result[h if h else ""] = field
    return result


async def ai_detect_column_mapping(
    headers: list[str],
    sample_rows: list[list],
) -> dict[str, str]:
    """调用 LLM 识别列映射。

    Args:
        headers: Excel 表头列表（空字符串表示该列无表头）
        sample_rows: 前 N 行样例数据（list of list）

    Returns:
        {原始列名(空字符串表示无表头): 标准字段名}
        失败或未配置 LLM 时返回空 dict。
    """
    if not settings.browser_use_llm_key:
        return {}

    try:
        import httpx
    except ImportError:
        return {}

    prompt = _build_prompt(headers, sample_rows)
    url = settings.browser_use_llm_base.rstrip("/") + "/chat/completions"
    headers_dict = {
        "Authorization": f"Bearer {settings.browser_use_llm_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": settings.browser_use_llm_model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, headers=headers_dict, json=payload)
            resp.raise_for_status()
            data = resp.json()
            text = data["choices"][0]["message"]["content"]
            return _parse_mapping(text, headers)
    except Exception as e:
        print(f"[excel_ai_parser] AI 识别失败，回退到硬编码别名: {e}")
        return {}
