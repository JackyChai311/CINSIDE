"""MRZ 噪声样本鲁棒性验证脚本（非 pytest，直接运行）。

用法:
    .venv\\Scripts\\python.exe test_mrz_noise.py

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
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.services.document_extract import (
    _parse_mrz,
    _extract_expiry_from_text,
    _extract_issue_from_text,
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


def _check(name: str, got: dict[str, str], expect: dict[str, str]) -> bool:
    ok = True
    for k, want in expect.items():
        g = got.get(k, "")
        if g != want:
            print(f"  [FAIL] {name} 字段 {k}: 期望 {want!r}, 实际 {g!r}")
            ok = False
    return ok


def main() -> int:
    failures = 0
    for name, text, expect in CASES:
        got = _parse_mrz(text)
        if _check(name, got, expect):
            print(f"  [OK]   {name}")
        else:
            failures += 1
            print(f"         原始文本: {text!r}")
            print(f"         解析结果: {got}")

    for name, text, want_expiry, want_issue in KEYWORD_CASES:
        expiry = _extract_expiry_from_text(text)
        issue = _extract_issue_from_text(text)
        ok = True
        if expiry != want_expiry:
            print(f"  [FAIL] {name} 有效期: 期望 {want_expiry!r}, 实际 {expiry!r}")
            ok = False
        if want_issue and issue != want_issue:
            print(f"  [FAIL] {name} 签发日: 期望 {want_issue!r}, 实际 {issue!r}")
            ok = False
        if ok:
            print(f"  [OK]   {name}")
        else:
            failures += 1

    print()
    if failures:
        print(f"共 {failures} 个用例失败")
        return 1
    print("全部用例通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
