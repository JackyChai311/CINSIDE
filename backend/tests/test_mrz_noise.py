# -*- coding: utf-8 -*-
"""MRZ 噪声样本鲁棒性验证（原 backend/test_mrz_noise.py 迁入 tests/）。

覆盖 UMI-OCR (PaddleOCR) 在护照 MRZ 上的典型噪声：
1. 标准 TD3（基准）
2. 日期段数字混淆（0→O、1→I、8→B、5→S）
3. < 变体（«、‹、＜）
4. 性别码误识（F→E、M→N）——有效期仍必须提取到
5. line1 丢 <（P 直接跟国家码）
6. MRZ 两行被合并成一行
7. 两行之间插入噪声行
8. MRZ 与 VIZ 可视区文字混合
9. 有效期关键词提取（法文撇号丢失变体）

断言与原脚本的 _check()/main() 完全一致：CASES 逐字段 all-equal，
KEYWORD_CASES 有效期必须相等、签发日仅在 want_issue 非空时断言。
用例名（含中文）原样保留在数据里，pytest id 用 ASCII 避免 GBK 控制台打印问题。
"""
import pytest

from app.services.document_extract import (
    _extract_expiry_from_text,
    _extract_issue_from_text,
    _parse_mrz,
)

# 标准 TD3 MRZ（44 字符/行）
# line2: 护照号750123456 + 检查位7 + RUS + 出生900315 + 检查位2 + F + 有效期301108 + 检查位4 + 个人号14位< + 0 + 0
L1 = "P<RUSBYSTROVA<<ANNA<PAVLOVNA<<<<<<<<<<<<<<<<<<<"
L2 = "7501234567RUS9003152F3011084<<<<<<<<<<<<<<00"

EXPECT = {
    "surname": "BYSTROVA",
    "given_name": "ANNA PAVLOVNA",
    "passport_no": "750123456",
    "birth_date": "1990-03-15",
    "gender": "F",
    "nationality": "RUSSIAN",
    "passport_expiry": "2030-11-08",
}

CASES: list[tuple[str, str, dict[str, str]]] = [
    (
        "1.标准TD3",
        f"{L1}\n{L2}",
        EXPECT,
    ),
    (
        "2.日期数字混淆(0→O,1→I,8→B)",
        f"{L1}\n7501234567RUS9O03I52F3O110B4<<<<<<<<<<<<<<00",
        EXPECT,  # 出生 9O03I5→900315，有效期 3O110B→301108
    ),
    (
        "3.<变体(«＜‹)",
        "P«RUSBYSTROVA««ANNA＜PAVLOVNA‹‹‹‹‹‹‹‹‹‹‹‹‹‹‹\n" + L2,
        EXPECT,
    ),
    (
        "4.性别码误识F→E",
        f"{L1}\n7501234567RUS9003152E3011084<<<<<<<<<<<<<<00",
        EXPECT,  # E→F 恢复；关键是有效期不能丢
    ),
    (
        "5.line1丢<",
        "PRUSBYSTROVA<<ANNA<PAVLOVNA<<<<<<<<<<<<<<<<<<<\n" + L2,
        EXPECT,
    ),
    (
        "6.两行合并成一行",
        L1 + L2,
        EXPECT,
    ),
    (
        "7.两行之间插噪声行",
        f"{L1}\nSOME NOISE 123 PAGE\n{L2}",
        EXPECT,
    ),
    (
        "8.MRZ与VIZ文字混合",
        "RUSSIAN FEDERATION\nSURNAME BYSTROVA\nGIVEN NAMES ANNA PAVLOVNA\n"
        f"DATE OF BIRTH 15.03.1990\n{L1}\n{L2}\nPAGE 01",
        EXPECT,
    ),
    (
        "9.有效期数字混淆+性别M→N",
        "P<CHNZHANG<<WEI<<<<<<<<<<<<<<<<<<<<<<<<<<<\n"
        "E123456789CHN8S05011N2S12256<<<<<<<<<<<<<<<0",
        {
            "surname": "ZHANG",
            "given_name": "WEI",
            "passport_no": "E12345678",
            "birth_date": "1985-05-01",
            "gender": "M",
            "nationality": "CHINESE",
            "passport_expiry": "2025-12-25",
        },
    ),
]

KEYWORD_CASES: list[tuple[str, str, str, str]] = [
    # (用例名, 文本, 期望有效期, 期望签发日)
    (
        "10.有效期关键词-法文撇号丢失",
        "DATE D'EXPIRATION\n08.11.2030\nDATE DE DELIVRANCE 09.11.2020",
        "2030-11-08",
        "2020-11-09",
    ),
    (
        "11.有效期关键词-德文",
        "GÜLTIG BIS 08.11.2030\nAUSSTELLUNGSDATUM 09.11.2020",
        "2030-11-08",
        "2020-11-09",
    ),
    (
        "12.有效期关键词-粘连无空格",
        "DATEOFEXPIRY:2030-11-08",
        "2030-11-08",
        "",
    ),
]

CASE_IDS = [
    "case01_standard_td3",
    "case02_date_digit_confusion",
    "case03_lt_variants",
    "case04_sex_F_to_E",
    "case05_line1_missing_lt",
    "case06_two_lines_merged",
    "case07_noise_line_between",
    "case08_mixed_with_viz",
    "case09_expiry_confusion_sex_M_to_N",
]

KEYWORD_IDS = [
    "case10_expiry_keyword_french_apostrophe_lost",
    "case11_expiry_keyword_german",
    "case12_expiry_keyword_no_space",
]


@pytest.mark.parametrize("name, text, expect", CASES, ids=CASE_IDS)
def test_parse_mrz_noise_case(name, text, expect):
    """每个噪声样本都必须解析出全部期望字段（等价于原脚本的 _check()）。"""
    got = _parse_mrz(text)
    for key, want in expect.items():
        actual = got.get(key, "")
        assert actual == want, f"{name} 字段 {key}: 期望 {want!r}, 实际 {actual!r}（完整解析={got}）"


@pytest.mark.parametrize("name, text, want_expiry, want_issue", KEYWORD_CASES, ids=KEYWORD_IDS)
def test_keyword_date_extraction(name, text, want_expiry, want_issue):
    """VIZ 关键词回退：有效期必须命中；签发日仅在有期望值时校验（同原脚本）。"""
    expiry = _extract_expiry_from_text(text)
    issue = _extract_issue_from_text(text)
    assert expiry == want_expiry, f"{name} 有效期: 期望 {want_expiry!r}, 实际 {expiry!r}"
    if want_issue:
        assert issue == want_issue, f"{name} 签发日: 期望 {want_issue!r}, 实际 {issue!r}"
