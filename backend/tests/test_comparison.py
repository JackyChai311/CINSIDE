# -*- coding: utf-8 -*-
"""比对引擎单测：字段归一化 + 模糊匹配 + 三源比对决策（app/services/comparison.py）。

纯逻辑，不联网、不需要模型。少数「现状记录」用例在 docstring 里显式标注了
与直觉不一致的地方（例如 surname 不做大小写归一、某源为空时的整体判定）。
"""
import pytest

from app.services.comparison import (
    _decide_evidence_source,
    _fuzzy_ratio,
    _looks_like_phone,
    _norm_date,
    _norm_email,
    _norm_name,
    _norm_phone,
    compare_field,
    normalize,
)


# ============ _norm_date ============
@pytest.mark.parametrize(
    "raw, expected",
    [
        ("2008-07-17", "2008-07-17"),
        ("2008/7/17", "2008-07-17"),
        ("2008.07.17", "2008-07-17"),
        ("2024-3-15", "2024-03-15"),
        ("15.07.2008", "2008-07-15"),
        ("15-3-2024", "2024-03-15"),
        ("15-MAR-2024", "2024-03-15"),
        ("2024年3月15日", "2024-03-15"),
        (" 17.07.2008 ", "2008-07-17"),
    ],
)
def test_norm_date_formats(raw, expected):
    assert _norm_date(raw) == expected


def test_norm_date_empty_and_unrecognized_passthrough():
    assert _norm_date("") == ""
    assert _norm_date(None) == ""
    # 认不出的形态原样返回（不做猜测）
    assert _norm_date("not-a-date") == "not-a-date"
    assert _norm_date("15Mar2024") == "15Mar2024"


def test_norm_date_day_month_year_order_is_always_dmy_for_two_number_prefix():
    """现状记录：两段数字短年形态一律按「日-月-年」解释（不看第一个数是否 >12）。

    这与代码注释「第一个数 > 12 必为日；否则按日-月-年」的描述相比更简单：
    实现里没有分支，12-11-2008 也会被当成 12 日 11 月。
    """
    assert _norm_date("12-11-2008") == "2008-11-12"
    assert _norm_date("25-11-2008") == "2008-11-25"


# ============ _norm_name / _norm_email ============
def test_norm_name_uppercases_and_collapses_spaces():
    assert _norm_name("  ivanov   ivan ") == "IVANOV IVAN"
    assert _norm_name("Ivanov\tIvan") == "IVANOV IVAN"
    assert _norm_name(None) == ""
    assert _norm_name("") == ""


def test_norm_email_lowercases():
    assert _norm_email("  A@B.COM ") == "a@b.com"
    assert _norm_email(None) == ""


# ============ _norm_phone ============
@pytest.mark.parametrize(
    "raw, expected",
    [
        ("+7 926 768 21 74", "9267682174"),
        ("7 (926) 768-21-74", "9267682174"),
        ("89267682174", "9267682174"),
        ("8-926-768-21-74", "9267682174"),
        ("8613800138000", "13800138000"),
        ("13800138000", "13800138000"),
        ("00447800123456", "7800123456"),
        ("12345678901234567890", "1234567890"),
        ("", ""),
        (None, ""),
        ("abc", ""),
    ],
)
def test_norm_phone(raw, expected):
    assert _norm_phone(raw) == expected


# ============ _looks_like_phone ============
@pytest.mark.parametrize(
    "raw, expected",
    [
        ("+7 926 768 21 74", True),
        ("(926)768-21-74", True),
        ("1234567", True),
        ("123456789012345", True),
        ("123456", False),
        ("1234567890123456", False),
        ("abc", False),
        ("", False),
        ("+7 926 768 21 74 ext 12", False),
    ],
)
def test_looks_like_phone(raw, expected):
    assert _looks_like_phone(raw) is expected


def test_looks_like_phone_accepts_date_shaped_values():
    """现状记录：12.11.2008 这种日期形态也「像电话」。

    真正拦下它的是 normalize() 里更靠前的日期形态判断（见 normalize 用例），
    而不是这个判定函数本身。
    """
    assert _looks_like_phone("12.11.2008") is True
    assert normalize("student_id", "12.11.2008") == "2008-11-12"


# ============ normalize ============
def test_normalize_empty_always_empty():
    for field in ("surname", "name", "birth_date", "passport_no", "email", "phone", "whatever"):
        assert normalize(field, "") == ""
        assert normalize(field, None) == ""


def test_normalize_by_field():
    assert normalize("birth_date", "2008/7/17") == "2008-07-17"
    assert normalize("passport_issue", "2008/7/17") == "2008-07-17"
    assert normalize("passport_expiry", "17.07.2008") == "2008-07-17"
    assert normalize("name", "  ivanov   ivan ") == "IVANOV IVAN"
    assert normalize("email", "A@B.com") == "a@b.com"
    assert normalize("passport_no", " ab 123 ") == "AB123"
    assert normalize("phone", "+7 926 768 21 74") == "9267682174"
    assert normalize("telephone", "+7 926 768 21 74") == "9267682174"


def test_normalize_date_shaped_value_wins_over_phone_detection():
    # 值形态像日期时优先按日期归一（避免被电话规则吃掉）
    assert normalize("student_id", "2008.11.12") == "2008-11-12"


def test_normalize_phone_shaped_value_under_any_field():
    assert normalize("student_id", "+7 926 768 21 74") == "9267682174"


def test_normalize_generic_field_is_case_sensitive_strip_only():
    """现状记录：国籍/姓氏等普通字段只 strip，不做大小写或空格归一。

    只有 name/email/passport_no 和日期类字段有专门归一；因此
    surname "Ivanov" vs "IVANOV" 会被判成不一致（见 compare_field 用例）。
    """
    assert normalize("surname", "  Ivanov  ") == "Ivanov"
    assert normalize("nationality", "  Russia ") == "Russia"
    assert normalize("nationality", "russia") == "russia"


# ============ _fuzzy_ratio ============
def test_fuzzy_ratio_bounds_and_empties():
    assert _fuzzy_ratio("IVANOV IVAN", "IVANOV IVAN") == 1.0
    assert _fuzzy_ratio("", "IVANOV") == 0.0
    assert _fuzzy_ratio("IVANOV", "") == 0.0
    assert _fuzzy_ratio("", "") == 0.0


def test_fuzzy_ratio_partial_similarity():
    # 多一个空格 → 仍然高度相似（>=0.9 是「partial」的门槛）
    assert _fuzzy_ratio("IVANOV IVAN", "IVANOV  IVAN") >= 0.9
    # 一个字符不同 → rapidfuzz 比值 2*2/6 = 2/3（未装 rapidfuzz 时是 Jaccard，故这里只测区间）
    ratio = _fuzzy_ratio("ABC", "ABD")
    assert pytest.approx(ratio, abs=0.2) == 2 / 3


# ============ _decide_evidence_source ============
def test_decide_evidence_source_prefers_passport():
    assert _decide_evidence_source("excel-val", "passport-val") == "passport"
    assert _decide_evidence_source("excel-val", "") == "excel"
    assert _decide_evidence_source("excel-val", "   ") == "excel"
    assert _decide_evidence_source("", "") == "none"
    assert _decide_evidence_source("", None) == "none"


# ============ compare_field ============
def test_compare_field_all_three_equal_is_match():
    r = compare_field("surname", "Ivanov", "Ivanov", "Ivanov")
    assert r.match == "match"
    assert r.note is None
    assert r.evidence_source == "passport"
    # 原始值原样回传（归一化只用于比较）
    assert (r.excel_value, r.passport_value, r.website_value) == ("Ivanov", "Ivanov", "Ivanov")


def test_compare_field_name_normalized_case_insensitive():
    r = compare_field("name", "Ivanov Ivan", "IVANOV IVAN", "ivanov  ivan")
    assert r.match == "match"
    assert r.evidence_source == "passport"


def test_compare_field_website_matches_excel_without_passport():
    r = compare_field("surname", "Ivanov", "", "Ivanov")
    assert r.match == "match"
    assert r.note is None
    assert r.evidence_source == "excel"


def test_compare_field_empty_website_is_missing():
    r = compare_field("surname", "Ivanov", "Ivanov", "")
    assert r.match == "missing"
    assert r.note == "网站上该字段为空"
    assert r.evidence_source == "passport"


def test_compare_field_disagrees_with_both_sources():
    r = compare_field("surname", "Ivanov", "Petrov", "Sidorov")
    assert r.match == "mismatch"
    assert r.note == "与 Excel 不一致；与护照不一致"
    assert r.evidence_source == "passport"


def test_compare_field_disagrees_with_excel_only():
    r = compare_field("surname", "Ivanov", "", "Petrov")
    assert r.match == "mismatch"
    assert r.note == "与 Excel 不一致"
    assert r.evidence_source == "excel"


def test_compare_field_partial_when_both_sources_fuzzily_close():
    r = compare_field("name", "IVANOV IVAN", "IVANOV IVAN", "IVANOV IVA")
    assert r.match == "partial"
    assert "与 Excel 相似度" in r.note
    assert "与护照相似度" in r.note


def test_compare_field_passes_through_website_label_and_selector():
    r = compare_field("surname", "Ivanov", "", "Ivanov", website_label="Family Name", selector_hint="#surname")
    assert r.website_label == "Family Name"
    assert r.selector_hint == "#surname"


def test_compare_field_website_only_is_mismatch_with_no_evidence():
    """现状记录：左侧两个来源都为空、网站上却填了值时，结果是 mismatch 而不是
    unknown/missing，且 evidence_source == "none"（没有可用来核对的左侧证据）。

    这是当前实现的行为（e_match/p_match 在归一化值为空时都落到 "mismatch" 分支），
    这里只锁定现状，不做修正。
    """
    r = compare_field("surname", "", "", "Ivanov")
    assert r.match == "mismatch"
    assert r.evidence_source == "none"
    assert r.note is None


def test_compare_field_website_equals_passport_but_excel_empty_is_mismatch():
    """现状记录：网站值与「权威的护照值」完全一致，只因为 Excel 侧为空，
    整体仍被判成 mismatch（第三种分支优先于 partial/一致判断）。

    锁现状，非认可。
    """
    r = compare_field("surname", "", "Ivanov", "Ivanov")
    assert r.match == "mismatch"
    assert r.evidence_source == "passport"


def test_compare_field_fuzzy_close_to_excel_only_is_mismatch():
    """现状记录：与 Excel 相似度 91%（达到 partial 门槛），但因护照侧为空，
    整体仍被判成 mismatch；note 里却写着「与 Excel 相似度91%」。

    锁现状，非认可。
    """
    r = compare_field("surname", "Ivanov", "", "Ivano")
    assert r.match == "mismatch"
    assert r.note is not None and r.note.startswith("与 Excel 相似度")


def test_compare_field_surname_case_difference_is_mismatch():
    """现状记录：surname 不做大小写归一 → "Ivanov" vs "IVANOV" 判为不一致。

    生产上 surname 通常由 Excel/护照同源提供，故未暴露；锁现状，非认可。
    """
    r = compare_field("surname", "Ivanov", "Ivanov", "IVANOV")
    assert r.match == "mismatch"
