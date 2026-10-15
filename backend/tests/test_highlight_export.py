# -*- coding: utf-8 -*-
"""导出 Excel 高亮端到端：复合中文表头 + LOOP 报告 highlights → 单元格填色。

原 backend/test_highlight_e2e.py 是同一场景的手工观察脚本（只 print、无 assert），
按任务要求保持原样不动；这里把它的观察结果固化成真正的断言（不联网、不写文件，
openpyxl 只在内存工作簿上操作）。
"""
from openpyxl import Workbook

from app.models import ApplicantRecord
from app.routers.upload import _apply_records_to_first_sheet

RED = "FFC7CE"       # mismatch / error
AMBER = "FFEB9C"     # missing / partial
YELLOW = "FFFF00"    # fixed（用户已修复）

# 列号（1-based，与下面 HEADERS 顺序一致）
COL = {
    "student_id": 1,
    "surname": 2,
    "given_name": 3,
    "passport_no": 4,
    "birth_date": 5,
    "nationality": 6,
    "lo": 7,
}

HEADERS = ["申请编号", "姓 Family Name", "名 Given Name", "护照号码", "出生日期", "国籍", "LO"]

# 模拟前端发来的 highlights（left_field 是规范字段名）
HIGHLIGHTS = {
    "rec-001": {  # 第 1 行：用户已修复 → 黄色
        "surname": "fixed",
        "passport_no": "fixed",
    },
    "rec-002": {  # 第 2 行：未修复问题 → 红色（birth_date 缺失 → 琥珀）
        "surname": "mismatch",
        "name": "mismatch",
        "passport_no": "mismatch",
        "birth_date": "missing",
        "nationality": "mismatch",
    },
}


def _build_workbook() -> Workbook:
    """与用户 Excel 相同结构的表头（复合中英文）+ 两行数据。"""
    wb = Workbook()
    ws = wb.active
    ws.append(HEADERS)
    ws.append(["APP-001", "Syn-Khir", "Alisa", "670906781", "2008-07-17", "Russia", "RU"])
    ws.append(["APP-002", "Ivanov", "Ivan", "67NO0906781", "2005-03-22", "Russia", "RU"])
    return wb


def _records() -> list[ApplicantRecord]:
    """模拟 store.records（解析器会存原始 key + 规范 key）。"""
    return [
        ApplicantRecord(record_id="rec-001", source="excel", fields={
            "申请编号": "APP-001", "姓 Family Name": "Syn-Khir", "名 Given Name": "Alisa",
            "护照号码": "670906781", "出生日期": "2008-07-17", "国籍": "Russia", "LO": "RU",
            "surname": "Syn-Khir", "given_name": "Alisa", "passport_no": "670906781",
            "birth_date": "2008-07-17", "nationality": "Russia", "name": "Syn-Khir Alisa",
        }),
        ApplicantRecord(record_id="rec-002", source="excel", fields={
            "申请编号": "APP-002", "姓 Family Name": "Ivanov", "名 Given Name": "Ivan",
            "护照号码": "67NO0906781", "出生日期": "2005-03-22", "国籍": "Russia", "LO": "RU",
            "surname": "Ivanov", "given_name": "Ivan", "passport_no": "67NO0906781",
            "birth_date": "2005-03-22", "nationality": "Russia", "name": "Ivanov Ivan",
        }),
    ]


def _fill_code(ws, row: int, column: int):
    """返回单元格填充色的后 6 位（如 'FFC7CE'），未填色返回 None。"""
    fill = ws.cell(row=row, column=column).fill
    if fill is None or not fill.patternType:
        return None
    rgb = getattr(getattr(fill, "fgColor", None), "rgb", None)
    return rgb[-6:] if isinstance(rgb, str) else None


def test_highlights_land_on_expected_columns():
    wb = _build_workbook()
    written = _apply_records_to_first_sheet(wb, _records(), HIGHLIGHTS)
    assert written == 2

    ws = wb.active

    # 第 2 行（rec-001）：fixed → 亮黄，只落在 surname / passport_no 两列
    assert _fill_code(ws, 2, COL["surname"]) == YELLOW
    assert _fill_code(ws, 2, COL["passport_no"]) == YELLOW
    for key in ("student_id", "given_name", "birth_date", "nationality", "lo"):
        assert _fill_code(ws, 2, COL[key]) is None, f"row2 {key} 不该着色"

    # 第 3 行（rec-002）：mismatch → 红；missing → 琥珀
    assert _fill_code(ws, 3, COL["surname"]) == RED
    assert _fill_code(ws, 3, COL["passport_no"]) == RED
    assert _fill_code(ws, 3, COL["nationality"]) == RED
    assert _fill_code(ws, 3, COL["birth_date"]) == AMBER
    for key in ("student_id", "given_name", "lo"):
        assert _fill_code(ws, 3, COL[key]) is None, f"row3 {key} 不该着色"


def test_values_are_written_back_to_the_matching_columns():
    wb = _build_workbook()
    _apply_records_to_first_sheet(wb, _records(), None)
    ws = wb.active
    assert ws.cell(row=2, column=COL["surname"]).value == "Syn-Khir"
    assert ws.cell(row=2, column=COL["passport_no"]).value == "670906781"
    assert ws.cell(row=3, column=COL["passport_no"]).value == "67NO0906781"
    assert ws.cell(row=3, column=COL["nationality"]).value == "Russia"


def test_without_highlights_nothing_is_coloured():
    wb = _build_workbook()
    written = _apply_records_to_first_sheet(wb, _records(), {})
    assert written == 2
    ws = wb.active
    for row in (2, 3):
        for column in range(1, len(HEADERS) + 1):
            assert _fill_code(ws, row, column) is None, f"({row},{column}) 不该着色"


def test_name_only_highlight_does_not_leak_to_other_columns():
    """现状记录：LOOP 报告的规范字段 "name" 在这张表上没有对应列
    （表里只有「姓 Family Name」「名 Given Name」），因此它不会给任何列上色，
    也不会因为模糊匹配误伤「名 Given Name」。
    """
    wb = _build_workbook()
    _apply_records_to_first_sheet(wb, _records(), {"rec-001": {"name": "mismatch"}})
    ws = wb.active
    for key in COL:
        assert _fill_code(ws, 2, COL[key]) is None, f"row2 {key} 不该着色"


def test_authoritative_column_map_disables_fuzzy_matching():
    """column_map（解析期权威映射）非空时，未被映射的列一律不着色。

    这是防止「身份 Student Type」里的 student 把 name 高亮打到无关列的事故保护。
    """
    wb = _build_workbook()
    column_map = {"护照号码": "passport_no"}
    _apply_records_to_first_sheet(
        wb,
        _records(),
        {"rec-001": {"surname": "mismatch", "passport_no": "mismatch"}},
        column_map,
    )
    ws = wb.active
    assert _fill_code(ws, 2, COL["passport_no"]) == RED
    assert _fill_code(ws, 2, COL["surname"]) is None
