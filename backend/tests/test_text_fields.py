# -*- coding: utf-8 -*-
"""text_fields 纯函数测试（日期抽取 + 本地标签字段提取）。

这些函数从 app/services/document_extract.py 拆出，全部是纯字符串处理，
不需要 OCR 引擎 / 网络 / 文件系统，因此可以独立快速测试。

本文件是**特征测试**：断言的是拆分当时**实际观测到的行为**（先用探针脚本
逐条取真实输出，再写断言），目的是把这个纯函数模块的现状固化下来，
使后续继续拆分或修改时能立刻发现行为变化。

⚠️ 其中若干条锁定的是**看起来不对**的行为，已单独标注「已知可疑行为」。
它们都是拆分**之前就存在**的（已用"搬移前后 33 条指纹逐条比对、0 处不一致"
证明行为未变），此处只做记录，不代表认可。改动它们属于产品决策。
"""
from __future__ import annotations

import re as _re

from app.services import text_fields as tf

# ============ _extract_date_by_keywords ============


def test_extract_date_by_keywords_slash_and_iso():
    assert tf._extract_date_by_keywords("EXPIRY 15/03/2024", [r"EXPIRY"]) == "2024-03-15"
    assert tf._extract_date_by_keywords("EXPIRY 2024-03-15", [r"EXPIRY"]) == "2024-03-15"


def test_extract_date_by_keywords_month_name_without_separator():
    # 15MARCH2024（月份单词紧贴数字）能解析
    assert tf._extract_date_by_keywords("EXPIRY 15MARCH2024", [r"EXPIRY"]) == "2024-03-15"


def test_extract_date_by_keywords_returns_empty_when_no_date():
    assert tf._extract_date_by_keywords("EXPIRY NONE", [r"EXPIRY"]) == ""
    assert tf._extract_date_by_keywords("", [r"EXPIRY"]) == ""


def test_extract_date_by_keywords_known_suspicious_behaviour():
    """已知可疑行为（拆分前即如此，仅记录）：

    1. 带连字符的月份名 `15-MAR-2024` 解析不出来，返回空串 ——
       而同格式用空格分隔（`15 MAR 2024`）时由 _extract_expiry_from_text 可解析。
    2. 关键词内部丢空格（OCR 常见：DATEOFEXPIRY）时也返回空串，
       尽管函数 docstring 声称"关键词中的空格在匹配时视为可选"。
    3. 中文全日期 `2024年03月15日` 解析不出来（只有 `2024-03-15` 这类能解析），
       对中文证件场景是个缺口。
    """
    assert tf._extract_date_by_keywords("DATE OF EXPIRY 15-MAR-2024 SURNAME KUT", [r"DATE\s*OF\s*EXPIRY"]) == ""
    assert tf._extract_date_by_keywords("DATEOFEXPIRY 15.03.2024", [r"DATE\s*OF\s*EXPIRY"]) == ""
    assert tf._extract_date_by_keywords("有效期至 2024年03月15日", [r"有效期至"]) == ""


# ============ _scan_all_dates ============


def test_scan_all_dates_normalizes_mixed_formats_in_order():
    assert tf._scan_all_dates("A 1974-08-12 B 12.04.2015 C 01/02/2003") == [
        "1974-08-12",
        "2015-04-12",
        "2003-02-01",
    ]


def test_scan_all_dates_empty_when_none():
    assert tf._scan_all_dates("no dates here") == []


# ============ _infer_missing_date_pair ============


def test_infer_missing_date_pair_keeps_present_side():
    assert tf._infer_missing_date_pair("ISSUE 2015-04-12", "2015-04-12", "", "") == ("2015-04-12", "")
    assert tf._infer_missing_date_pair("EXP 2015-04-12", "", "2015-04-12", "") == ("", "2015-04-12")


def test_infer_missing_date_pair_both_empty():
    assert tf._infer_missing_date_pair("", "", "", "") == ("", "")


# ============ _extract_expiry_from_text / _extract_issue_from_text ============


def test_extract_expiry_from_text_variants():
    assert tf._extract_expiry_from_text("DATE OF EXPIRY 15 MAR 2024") == "2024-03-15"
    # 法语撇号被 OCR 丢掉仍能匹配
    assert tf._extract_expiry_from_text("DATE D EXPIRATION 15/03/2024") == "2024-03-15"


def test_extract_issue_from_text_variants():
    assert tf._extract_issue_from_text("DATE OF ISSUE 12/04/2015") == "2015-04-12"
    assert tf._extract_issue_from_text("签发日期 2015-04-12") == "2015-04-12"


# ============ _extract_after_label ============


def test_extract_after_label_basic():
    assert tf._extract_after_label("SURNAME KUT GIVEN AMIR", tf._LABEL_SURNAME) == "KUT"


def test_extract_after_label_no_match():
    assert tf._extract_after_label("SOMETHING ELSE", tf._LABEL_SURNAME) == ""


# ============ _extract_alphanum_after_label ============


def test_extract_alphanum_after_label_passport_no():
    assert tf._extract_alphanum_after_label("PASSPORT NO. AB1234567 X", tf._LABEL_PASSPORT_NO) == "AB1234567"


# ============ _extract_latin_name_after_label ============


def test_latin_name_newline_and_colon_layouts_work():
    labels = tf._LABEL_SURNAME
    assert tf._extract_latin_name_after_label("SURNAME\nKUT\nGIVEN NAMES\nAMIR", labels) == "KUT"
    assert tf._extract_latin_name_after_label("SURNAME: KUT\nGIVEN NAMES: AMIR", labels) == "KUT"
    assert tf._extract_latin_name_after_label("SURNAME KUT", labels) == "KUT"


def test_latin_name_given_names():
    assert tf._extract_latin_name_after_label("GIVEN NAMES AMIR", tf._LABEL_GIVEN) == "AMIR"


def test_latin_name_known_suspicious_behaviour():
    """已知可疑行为（拆分前即如此，仅记录）——这几条会**取到错误的值**：

    1. 多个标签挤在同一行时取到的是后一个字段的值：
       `SURNAME KUT GIVEN NAMES AMIR` → `AMIR`（应为 KUT）。
    2. 换行布局下正常（KUT），所以是否出错取决于版式 —— 同一份内容
       因为分隔符不同而结果不同。
    3. `SURNAME<<KUT<<AMIR`（MRZ 式）→ `AMIR`（应为 KUT）。
    4. 最值得注意：标签自身带空格且用斜杠并列时
       `SURNAME / FAMILY NAME\\nKUT\\n...` → `FAMILY`，
       即把**标签里的第二个单词**当成了值。这类标签行在真实证件上很常见。
    5. `_extract_local_fields` 会继承上述行为（见下方对应测试）。

    真实证件多为「标签一行、值一行」，因此 (2) 的正常路径是主路径；
    但 (4) 属于常见版式，值得后续单独评估。
    """
    labels = tf._LABEL_SURNAME
    assert tf._extract_latin_name_after_label("SURNAME KUT GIVEN NAMES AMIR", labels) == "AMIR"
    assert tf._extract_latin_name_after_label("SURNAME<<KUT<<AMIR", labels) == "AMIR"
    assert tf._extract_latin_name_after_label("SURNAME / FAMILY NAME\nKUT\nGIVEN NAMES\nAMIR", labels) == "FAMILY"


# ============ _extract_gender_near_label ============


def test_extract_gender_near_label_latin():
    assert tf._extract_gender_near_label("SEX M") == "M"


def test_extract_gender_near_label_chinese_not_supported():
    """已知缺口（拆分前即如此）：中文「性别 女」取不到值。"""
    assert tf._extract_gender_near_label("性别 女") == ""


# ============ _rescue_segmented_number ============


def test_rescue_segmented_number_returns_input_unchanged_for_these_cases():
    """现状记录：下列输入均原样返回（未做任何拼接）。

    即该函数在这些分段场景下**没有**把它"救"回来 —— 只是没有更差。
    """
    assert tf._rescue_segmented_number("PASSPORT AB 123 4567", "AB 123 4567") == "AB 123 4567"
    assert tf._rescue_segmented_number("x", "AB123 4567") == "AB123 4567"
    assert tf._rescue_segmented_number("x", "AB 1234567") == "AB 1234567"


# ============ _extract_custom_field ============


def test_extract_custom_field_takes_value_after_label():
    assert tf._extract_custom_field("MY FIELD VALUE HERE", "MY FIELD") == "FIELD VALUE HERE"


def test_extract_custom_field_empty_text():
    assert tf._extract_custom_field("", "X") == ""


# ============ _extract_local_fields ============


def test_extract_local_fields_multi_field_single_line():
    text = (
        "SURNAME KUT GIVEN NAMES AMIR PASSPORT NO. AB1234567 NATIONALITY RUSSIAN "
        "SEX M DATE OF BIRTH 1974-08-12 DATE OF EXPIRY 2024-03-15"
    )
    got = tf._extract_local_fields(
        text,
        ["surname", "given_name", "passport_no", "nationality", "gender", "birth_date", "passport_expiry"],
    )
    assert got == {
        "surname": "AMIR",  # ⚠️ 已知可疑：应为 KUT，见 test_latin_name_known_suspicious_behaviour
        "given_name": "AMIR",
        "passport_no": "AB1234567",
        "nationality": "RUSSIAN",
        "gender": "M",
        "birth_date": "1974-08-12",
        "passport_expiry": "2024-03-15",
    }


def test_extract_local_fields_newline_layout_gets_surname_right():
    got = tf._extract_local_fields("SURNAME\nKUT\nGIVEN NAMES\nAMIR\nPASSPORT NO.\nAB1234567", ["surname", "given_name", "passport_no"])
    assert got == {"surname": "KUT", "given_name": "AMIR", "passport_no": "AB1234567"}


def test_extract_local_fields_empty_text():
    assert tf._extract_local_fields("", ["surname"]) == {}


# ============ 结构约束 ============


def test_module_does_not_import_document_extract():
    """防止循环导入回归：text_fields 不得反向依赖 document_extract。

    （拆分时 document_extract 会 import text_fields；若两边互相 import，
      就会形成循环导入，表现为难以定位的 ImportError。）
    """
    import inspect

    src = inspect.getsource(tf)
    assert not _re.search(r"^\s*from\s+\.\s*document_extract\s+import", src, _re.M)
    assert not _re.search(r"^\s*from\s+\.document_extract\s+import", src, _re.M)
    assert not _re.search(r"^\s*import\s+.*document_extract", src, _re.M)


def test_label_tables_are_non_empty_lists():
    """标签表都是非空正则串列表（防止误改成字符串导致逐字符匹配）。"""
    for name in (
        "_LABEL_SURNAME",
        "_LABEL_GIVEN",
        "_LABEL_PASSPORT_NO",
        "_LABEL_NATIONALITY",
        "_LABEL_GENDER",
        "_LABEL_ISSUE_AUTHORITY",
        "_LABEL_BIRTH_PLACE",
        "_KNOWN_FIELDS",
        "_GENERIC_LABEL_STOPS",
    ):
        table = getattr(tf, name)
        assert isinstance(table, (list, set, tuple)), name
        assert len(table) > 0, name
