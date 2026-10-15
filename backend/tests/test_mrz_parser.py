# -*- coding: utf-8 -*-
"""MRZ 纯逻辑单测：ICAO 9303 检查位 / 字符值 / 第二行修复 / 解析 / 归一化。

全部是 app/services/document_extract.py 里依赖无关的纯函数：
不联网、不需要 GPU、不需要 UMI-OCR。

已知歧义（不是 bug 修复，只是把现状锁住并显式记录）见
test_repair_dropped_character_* / test_repair_confusable_passport_digit_*。
"""
from app.services.document_extract import (
    _icao_check,
    _mrz_char_val,
    _normalize_for_compare,
    _parse_mrz,
    _repair_mrz_line2,
)

# MRZ 第一行（姓名区），配合下面自造的第二行使用
LINE1 = "P<RUSERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<"


def _build_line2(
    passport_no: str = "L898902C3",
    country: str = "RUS",
    birth: str = "740812",
    sex: str = "F",
    expiry: str = "120415",
    personal: str = "ZE184226B<<<<<",
) -> str:
    """按 ICAO 9303 TD3 布局拼一条「四个检查位全部真实成立」的第二行（44 字符）。

    检查位由 _icao_check 现算，所以这是真正的 known-good MRZ，而不是硬编码常量。
    """
    line = (
        passport_no
        + str(_icao_check(passport_no))
        + country
        + birth
        + str(_icao_check(birth))
        + sex
        + expiry
        + str(_icao_check(expiry))
        + personal
        + str(_icao_check(personal))
    )
    # 整体检查位：0-9 + 13-19 + 21-27 + 28-41（不含个人号检查位 42）
    line += str(_icao_check(line[0:10] + line[13:20] + line[21:28] + line[28:42]))
    return line


GOOD_LINE2 = _build_line2()
OVERALL_SRC = GOOD_LINE2[0:10] + GOOD_LINE2[13:20] + GOOD_LINE2[21:28] + GOOD_LINE2[28:42]


# ============ _mrz_char_val ============
def test_mrz_char_val_digits_letters_filler():
    assert _mrz_char_val("0") == 0
    assert _mrz_char_val("9") == 9
    assert _mrz_char_val("A") == 10
    assert _mrz_char_val("Z") == 35
    assert _mrz_char_val("<") == 0
    # 小写被 upper() 归一（OCR 偶发小写）
    assert _mrz_char_val("a") == 10
    assert _mrz_char_val("z") == 35


def test_mrz_char_val_rejects_non_mrz_chars():
    assert _mrz_char_val("*") == -1
    assert _mrz_char_val(" ") == -1
    assert _mrz_char_val(".") == -1
    assert _mrz_char_val("") == -1


def test_mrz_char_val_non_ascii_letter_is_not_rejected():
    """现状记录：非 ASCII 字母 isalpha() 为真，会走 ord()-55 分支而不是 -1。

    西里尔字母不应出现在 MRZ 里；这里锁住当前行为（不修改生产代码）。
    """
    assert _mrz_char_val("Я") == ord("Я") - 55


# ============ _icao_check ============
def test_icao_check_known_icao_values():
    """ICAO 9303 官方样例护照号 / 日期段的检查位。"""
    assert _icao_check("L898902C3") == 6
    assert _icao_check("740812") == 2
    assert _icao_check("120415") == 9
    assert _icao_check("ZE184226B<<<<<") == 1
    assert _icao_check("") == 0


def test_icao_check_weights_cycle_7_3_1():
    # 单字符：位置 0 权重 7
    assert _icao_check("1") == 7
    assert _icao_check("A") == 0  # 10*7 = 70 → 0
    assert _icao_check("B") == 7  # 11*7 = 77 → 7
    # 位置 1 权重 3，位置 2 权重 1
    assert _icao_check("01") == 3
    assert _icao_check("001") == 1
    # 位置 3 回到权重 7
    assert _icao_check("1000") == 7
    assert _icao_check("1000000") == 7


def test_icao_check_invalid_char_returns_minus_one():
    assert _icao_check("1*2") == -1
    assert _icao_check("A B") == -1
    assert _icao_check("AB<C.") == -1


# ============ 自造 known-good 行自检 ============
def test_generated_line2_is_valid_td3():
    assert len(GOOD_LINE2) == 44
    assert GOOD_LINE2[10:13] == "RUS"
    assert _icao_check(GOOD_LINE2[:9]) == int(GOOD_LINE2[9])
    assert _icao_check(GOOD_LINE2[13:19]) == int(GOOD_LINE2[19])
    assert _icao_check(GOOD_LINE2[21:27]) == int(GOOD_LINE2[27])
    assert _icao_check(OVERALL_SRC) == int(GOOD_LINE2[43])
    assert GOOD_LINE2 == "L898902C36RUS7408122F1204159ZE184226B<<<<<19"


# ============ _repair_mrz_line2 ============
def test_repair_returns_already_valid_line_unchanged():
    assert _repair_mrz_line2(GOOD_LINE2) == GOOD_LINE2


def test_repair_returns_too_short_line_unchanged():
    # <11 字符早退，原样返回
    assert _repair_mrz_line2("SHORT") == "SHORT"
    assert _repair_mrz_line2("1234567890") == "1234567890"
    assert _repair_mrz_line2("") == ""


def test_repair_fixes_corrupted_check_digit():
    """护照号检查位 6 被 OCR 认成视觉混淆字符 G → 必须修复回原行。"""
    broken = GOOD_LINE2[:9] + "G" + GOOD_LINE2[10:]
    assert broken != GOOD_LINE2
    assert _repair_mrz_line2(broken) == GOOD_LINE2


def test_repair_fixes_extra_character():
    """OCR 多认一个字符 → 单字符删除修复应还原原始行。"""
    broken = GOOD_LINE2[:3] + "8" + GOOD_LINE2[3:]
    assert len(broken) == 45
    assert _repair_mrz_line2(broken) == GOOD_LINE2


def test_repair_leaves_non_confusable_digit_error_unchanged():
    """8→7 不在视觉混淆表里：替换修复只接受混淆字符，宁缺毋错 → 不做修改。"""
    broken = GOOD_LINE2[:3] + "7" + GOOD_LINE2[4:]
    assert broken != GOOD_LINE2
    assert _repair_mrz_line2(broken) == broken


def test_repair_leaves_country_code_error_unchanged():
    """国家码 R0S 非法 → 所有变异都不满足 _ok() → 原样返回。"""
    broken = GOOD_LINE2[:11] + "0" + GOOD_LINE2[12:]
    assert _repair_mrz_line2(broken) == broken


def test_repair_leaves_line_with_non_iso_country_code_unchanged():
    """_ok() 要求国家码在 _ISO3_COUNTRY_CODES 白名单内。

    ICAO 官方样例行用的 UTO 只是示范码、不在白名单里，所以即使
    「护照号/日期检查位全部成立」也不会被当成可修复行，原样返回。
    """
    good_uto = _build_line2(country="UTO")
    assert len(good_uto) == 44
    assert _icao_check(good_uto[:9]) == int(good_uto[9])
    assert _repair_mrz_line2(good_uto) == good_uto


def test_repair_dropped_character_is_ambiguous_documented_behaviour():
    """现状记录（已知歧义，非认可）：

    OCR 丢一位时修复取「首个满足检查位的单字符插入」，而不是还原被丢的字符。
    L898902C3 丢掉第 4 位（'8'）后，把 '6' 插到行首得到的 6L89902C3 同样满足
    检查位（字符值差 21 恰好 ≡ 0 mod 10），于是护照号被“修”成了另一个值。
    """
    broken = GOOD_LINE2[:3] + GOOD_LINE2[4:]
    assert len(broken) == 43
    fixed = _repair_mrz_line2(broken)
    assert fixed == "6" + broken
    assert fixed != GOOD_LINE2


def test_repair_confusable_passport_digit_shifts_to_another_valid_number():
    """现状记录（已知歧义，非认可）：

    passport 第 4 位 8 被认成 B 时，修复器把行首 L 换成 I（L→I 的加权差与
    8→B 的加权差正好抵消），得到另一个检查位同样成立的护照号 I89B902C3。
    国籍/日期不受影响，但 passport_no 会变成错误值。
    """
    broken = GOOD_LINE2[:3] + "B" + GOOD_LINE2[4:]
    assert broken != GOOD_LINE2
    fixed = _repair_mrz_line2(broken)
    assert fixed == "I" + broken[1:]
    assert fixed != GOOD_LINE2


# ============ _parse_mrz ============
def test_parse_mrz_standard_td3_line():
    got = _parse_mrz(LINE1 + "\n" + GOOD_LINE2)
    assert got == {
        "surname": "ERIKSSON",
        "given_name": "ANNA MARIA",
        "name": "ERIKSSON ANNA MARIA",
        "nationality": "RUSSIAN",
        "passport_no": "L898902C3",
        "gender": "F",
        "birth_date": "1974-08-12",
        "passport_expiry": "2012-04-15",
    }


def test_parse_mrz_returns_empty_without_mrz():
    assert _parse_mrz("") == {}
    assert _parse_mrz("RUSSIAN FEDERATION\nSURNAME IVANOV\nGIVEN NAMES IVAN") == {}


def test_parse_mrz_ignores_broken_expiry_check_digit():
    """有效期检查位坏了但日期本身没坏 → 字段照常提取（解析不校验检查位）。"""
    broken = GOOD_LINE2[:27] + "S" + GOOD_LINE2[28:]
    got = _parse_mrz(LINE1 + "\n" + broken)
    assert got["passport_no"] == "L898902C3"
    assert got["birth_date"] == "1974-08-12"
    assert got["passport_expiry"] == "2012-04-15"
    assert got["gender"] == "F"


def test_parse_mrz_recovers_ocr_digit_confusion_in_dates():
    """日期段里的 PaddleOCR 混淆字符（7→T、1→I）在解析时被纠正。"""
    broken = GOOD_LINE2[:13] + "T" + GOOD_LINE2[14:21] + "I" + GOOD_LINE2[22:]
    assert "T" in broken[13:19] and "I" in broken[21:27]
    got = _parse_mrz(LINE1 + "\n" + broken)
    assert got["birth_date"] == "1974-08-12"
    assert got["passport_expiry"] == "2012-04-15"


def test_parse_mrz_accepts_confused_gender_code():
    """性别码被认成 E（应为 F）时仍要恢复性别，且不影响有效期。"""
    broken = GOOD_LINE2[:20] + "E" + GOOD_LINE2[21:]
    got = _parse_mrz(LINE1 + "\n" + broken)
    assert got["gender"] == "F"
    assert got["passport_expiry"] == "2012-04-15"


def test_parse_mrz_line1_without_filler_after_type():
    """OCR 把 P 后的 < 丢掉（PRUSERIKSSON<<...）→ 按第一行固定位拆国家码+姓氏。"""
    text = "PRUSERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\n" + GOOD_LINE2
    got = _parse_mrz(text)
    assert got["surname"] == "ERIKSSON"
    assert got["given_name"] == "ANNA MARIA"
    assert got["nationality"] == "RUSSIAN"
    assert got["passport_no"] == "L898902C3"


def test_parse_mrz_normalizes_lt_variants():
    """PaddleOCR 常见的 < 变体（«/＜/‹/く）必须归一成 < 后再解析。"""
    text = "P«RUSERIKSSON««ANNA＜MARIA‹‹‹‹‹‹‹‹‹‹‹‹‹‹‹\n" + GOOD_LINE2
    got = _parse_mrz(text)
    assert got["surname"] == "ERIKSSON"
    assert got["given_name"] == "ANNA MARIA"


def test_parse_mrz_merges_two_lines_without_separator():
    """两行 MRZ 被 OCR 合并成一行时仍能切出第二行。"""
    got = _parse_mrz(LINE1 + GOOD_LINE2)
    assert got["surname"] == "ERIKSSON"
    assert got["passport_no"] == "L898902C3"
    assert got["passport_expiry"] == "2012-04-15"


# ============ _normalize_for_compare ============
def test_normalize_for_compare_strips_and_uppercases():
    assert _normalize_for_compare("  Ivanov ") == "IVANOV"
    assert _normalize_for_compare("ivanov-ivan") == "IVANOVIVAN"
    assert _normalize_for_compare("a_b/c d") == "ABCD"
    assert _normalize_for_compare("") == ""
    assert _normalize_for_compare("   ") == ""
    # 非 ASCII 字母保留（只做大写与分隔符清理）
    assert _normalize_for_compare("Кузнецов") == "КУЗНЕЦОВ"


# ============ 修复告警：错的护照号不能静默 ============
# 背景：ICAO 检查位只能证明加权和 mod 10 成立，不能证明改对了。
# 同一组检查位下有大量等价解，_repair_mrz_line2 取的是"首个满足检查位的变异"，
# 因此可能把护照号改成另一个检查位同样成立的值。
# 既然无法从检查位判断对错，就要求：只要改动落在护照号本体（前 9 位）上，
# 必须打出 WARN 提示人工复核。
# 注意：这些测试只断言日志，**不改动也不放宽**任何返回值断言。


def test_repair_warns_when_passport_body_is_rewritten_by_insertion(capsys):
    """丢一位时把 '6' 插到行首同样满足检查位 → 护照号被改成另一个值，必须告警。"""
    broken = GOOD_LINE2[:3] + GOOD_LINE2[4:]
    fixed = _repair_mrz_line2(broken)
    err = capsys.readouterr().out
    assert "WARN" in err
    assert "改动了护照号本体" in err
    assert "人工复核" in err
    # 返回值仍与改动前一致（本次只加日志，未改行为）
    assert fixed == "6" + broken
    assert fixed[:9] != broken[:9]


def test_repair_warns_when_passport_body_is_rewritten_by_substitution(capsys):
    """8→B 被"修"成 L→I，得到另一个检查位成立但错误的护照号 → 必须告警。"""
    broken = GOOD_LINE2[:3] + "B" + GOOD_LINE2[4:]
    fixed = _repair_mrz_line2(broken)
    err = capsys.readouterr().out
    assert "WARN" in err
    assert "改动了护照号本体" in err
    assert fixed == "I" + broken[1:]


def test_repair_does_not_warn_when_only_check_digit_is_fixed(capsys):
    """只改了检查位（护照号本体未动）→ 不应告警，只保留普通修复日志。"""
    broken = GOOD_LINE2[:9] + "G" + GOOD_LINE2[10:]
    fixed = _repair_mrz_line2(broken)
    out = capsys.readouterr().out
    assert fixed == GOOD_LINE2
    assert "[MRZ-REPAIR]" in out
    assert "WARN" not in out


def test_repair_warns_when_no_repair_possible_and_checks_fail(capsys):
    """无法修复且检查位本就不成立 → 明确告警，避免自相矛盾的行被当成正常结果。"""
    broken = GOOD_LINE2[:3] + "7" + GOOD_LINE2[4:]
    fixed = _repair_mrz_line2(broken)
    err = capsys.readouterr().out
    assert fixed == broken  # 行为不变
    assert "WARN" in err
    assert "无法修复" in err
    assert "护照号检查位" in err


def test_repair_logs_nothing_extra_for_already_valid_line(capsys):
    """本来就合法的行直接返回，不打任何修复/告警日志。"""
    assert _repair_mrz_line2(GOOD_LINE2) == GOOD_LINE2
    assert capsys.readouterr().out == ""

