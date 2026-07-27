"""比对引擎：字段归一化 + 模糊匹配。"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Literal

from ..models import FieldComparison

try:
    from rapidfuzz import fuzz
    _HAS_FUZZ = True
except ImportError:
    _HAS_FUZZ = False


def _norm_date(s: str) -> str:
    """把各种日期格式归一成 YYYY-MM-DD。"""
    s = (s or "").strip()
    if not s:
        return ""
    # 常见分隔符统一
    s = s.replace("/", "-").replace(".", "-").replace(" ", "")
    # 15-MAR-2024 / 15Mar2024
    m = re.match(r"^(\d{1,2})-([A-Za-z]{3,})-(\d{4})$", s)
    if m:
        try:
            d, mon, y = m.groups()
            dt = datetime.strptime(f"{d} {mon} {y}", "%d %b %Y")
            return dt.strftime("%Y-%m-%d")
        except Exception:
            pass
    # 2024年3月15日
    m = re.match(r"^(\d{4})年(\d{1,2})月(\d{1,2})日$", s)
    if m:
        y, mo, d = m.groups()
        return f"{y}-{int(mo):02d}-{int(d):02d}"
    # 2024-3-15
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", s)
    if m:
        y, mo, d = m.groups()
        return f"{y}-{int(mo):02d}-{int(d):02d}"
    # 15-3-2024 / 15.3.2024（日在前）
    m = re.match(r"^(\d{1,2})-(\d{1,2})-(\d{4})$", s)
    if m:
        d, mo, y = m.groups()
        # 第一个数 > 12 必为日；否则按日-月-年（俄/欧习惯）
        return f"{y}-{int(mo):02d}-{int(d):02d}"
    return s


def _norm_name(s: str) -> str:
    """姓名归一：全大写 + 单空格。"""
    s = (s or "").strip().upper()
    s = re.sub(r"\s+", " ", s)
    return s


def _norm_email(s: str) -> str:
    return (s or "").strip().lower()


def _norm_phone(s: str) -> str:
    """电话归一：去非数字 → 国家码前缀等价处理。

    "+7 926 768 21 74" = "7 (926) 768-21-74" = "89267682174" → 核心10位
    """
    digits = re.sub(r"\D", "", s or "")
    if not digits:
        return ""
    if digits.startswith("00"):
        digits = digits[2:]
    # 中国 +86：8613xxxxxxxxx → 13xxxxxxxxx
    if digits.startswith("86") and len(digits) == 13:
        return digits[2:]
    # 俄罗斯习惯 7/8 互换：取后10位
    if len(digits) == 11 and digits[0] in ("7", "8"):
        return digits[1:]
    if len(digits) > 11:
        return digits[-10:]
    return digits


def _looks_like_phone(s: str) -> bool:
    v = (s or "").strip()
    if not v or not re.fullmatch(r"[\d\s+\-().]+", v):
        return False
    digits = re.sub(r"\D", "", v)
    return 7 <= len(digits) <= 15


def _norm_generic(s: str) -> str:
    return (s or "").strip()


def normalize(field: str, value: str) -> str:
    v = (value or "").strip()
    if not v:
        return ""
    if field in ("birth_date", "passport_issue", "passport_expiry"):
        return _norm_date(v)
    if field == "name":
        return _norm_name(v)
    if field == "email":
        return _norm_email(v)
    if field == "passport_no":
        return v.upper().replace(" ", "")
    # 日期形态的值优先（如 2008/11/12 vs 2008-11-12；12.11.2008 也含数字和点，易被误判为电话）
    if re.match(r"^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$", v) or re.match(r"^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$", v):
        return _norm_date(v)
    # 电话类字段或值形态像电话：格式差异不算错误
    if "phone" in field or "tel" in field or _looks_like_phone(v):
        return _norm_phone(v)
    return _norm_generic(v)


def _fuzzy_ratio(a: str, b: str) -> float:
    """返回 0-1 相似度。"""
    if not a or not b:
        return 0.0
    if _HAS_FUZZ:
        return fuzz.ratio(a, b) / 100.0
    # 回退：简单字符级 Jaccard
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _decide_evidence_source(excel_value: str, passport_value: str) -> str:
    """决定该字段的左侧证据来源：护照（权威证件）> Excel > 无。"""
    if (passport_value or "").strip():
        return "passport"
    if (excel_value or "").strip():
        return "excel"
    return "none"


def compare_field(
    field: str,
    excel_value: str,
    passport_value: str,
    website_value: str,
    website_label: str | None = None,
    selector_hint: str | None = None,
) -> FieldComparison:
    """三源比对单个字段，并标注证据来源。"""
    ne = normalize(field, excel_value)
    np = normalize(field, passport_value)
    nw = normalize(field, website_value)

    note_parts: list[str] = []
    evidence_source = _decide_evidence_source(excel_value, passport_value)

    # 网站值为空：missing
    if not nw:
        return FieldComparison(
            field=field,
            excel_value=excel_value,
            passport_value=passport_value,
            website_value=website_value,
            match="missing",
            note="网站上该字段为空",
            website_label=website_label,
            selector_hint=selector_hint,
            evidence_source=evidence_source,
        )

    # 网站值 vs excel
    if ne and nw == ne:
        e_match: Literal["match", "partial", "mismatch"] = "match"
    elif ne and _fuzzy_ratio(ne, nw) >= 0.9:
        e_match = "partial"
        note_parts.append(f"与 Excel 相似度{_fuzzy_ratio(ne, nw)*100:.0f}%")
    else:
        e_match = "mismatch"
        if ne:
            note_parts.append("与 Excel 不一致")

    # 网站值 vs passport
    if np and nw == np:
        p_match: Literal["match", "partial", "mismatch"] = "match"
    elif np and _fuzzy_ratio(np, nw) >= 0.9:
        p_match = "partial"
        note_parts.append(f"与护照相似度{_fuzzy_ratio(np, nw)*100:.0f}%")
    else:
        p_match = "mismatch"
        if np:
            note_parts.append("与护照不一致")

    # 综合
    if e_match == "match" and (p_match == "match" or not np):
        overall = "match"
    elif e_match == "mismatch" and (p_match == "mismatch" or not np):
        overall = "mismatch"
    elif "mismatch" in (e_match, p_match):
        overall = "mismatch"
    elif "partial" in (e_match, p_match):
        overall = "partial"
    else:
        overall = "unknown"

    return FieldComparison(
        field=field,
        excel_value=excel_value,
        passport_value=passport_value,
        website_value=website_value,
        match=overall,
        note="；".join(note_parts) or None,
        website_label=website_label,
        selector_hint=selector_hint,
        evidence_source=evidence_source,
    )
