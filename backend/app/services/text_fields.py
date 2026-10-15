"""从 OCR 文本中抽取字段（不依赖 Vision API，也不依赖 MRZ）。

从 app/services/document_extract.py 拆分而来，包含两块原本就相邻的逻辑：
1. 按关键词在文本中定位日期（签发日期 / 有效期等）；
2. 按多语言标签表做本地正则字段提取（姓/名/护照号/国籍/性别/签发机关/出生地
   以及自定义字段），入口是 _extract_local_fields()。

这些都是纯字符串处理：不碰 PIL、不发行网络请求、不读写文件、没有模块级可变状态，
因此可以独立测试（见 tests/test_text_fields.py）。

约束：本模块**不得**反过来 import document_extract，否则形成循环导入。

关于 re：本模块**需要**在顶部 import re —— 日期那几个函数用的是裸 re.xxx
（与 mrz.py 不同，那边全是函数内局部别名）。
"""
from __future__ import annotations

import re


# ============ 日期抽取 ============

def _extract_date_by_keywords(text: str, keywords: list[str]) -> str:
    """从 OCR 文本中根据关键词附近提取日期，返回 YYYY-MM-DD 或空串。

    用于在 MRZ 解析失败时作为回退，从 VIZ 可视区文字中提取日期。
    关键词中的空格在匹配时视为可选（OCR 常把 "Date of expiry" 识别成 "Dateof expiry"）。
    撇号先归一化删除（法语 "DATE D'EXPIRATION" OCR 常变成 "D EXPIRATION"/"DEXPIRATION"）。
    """
    if not text:
        return ""
    upper = text.upper().replace("'", "").replace("'", "").replace("`", "")
    for kw in keywords:
        kw_up = kw.upper().replace("'", "")
        # 把关键词按空格拆分，各部分分别转义后用 \s* 连接，
        # 容忍 OCR 丢失或多余空格（如 "Dateof expiry" 匹配 "Date of expiry"）
        parts = [re.escape(p) for p in kw_up.split() if p]
        kw_pattern = r'\s*'.join(parts)
        m = re.search(kw_pattern, upper)
        if not m:
            continue
        idx = m.start()
        # 取关键词后面 100 个字符作为搜索窗口（OCR 换行/噪声可能拉大标签与值的距离）
        window = text[idx: idx + 100]
        # 匹配各种日期格式
        # YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
        m = re.search(r'(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})', window)
        if m:
            y, mo, d = m.group(1), m.group(2).zfill(2), m.group(3).zfill(2)
            if 1900 <= int(y) <= 2100 and 1 <= int(mo) <= 12 and 1 <= int(d) <= 31:
                return f"{y}-{mo}-{d}"
        # DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY
        m = re.search(r'(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})', window)
        if m:
            d, mo, y = m.group(1).zfill(2), m.group(2).zfill(2), m.group(3)
            if 1900 <= int(y) <= 2100 and 1 <= int(mo) <= 12 and 1 <= int(d) <= 31:
                return f"{y}-{mo}-{d}"
        # DD MMM YYYY / DD MMMM YYYY (英文月份)
        m = re.search(
            r'(\d{1,2})\s*(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s*(\d{4})',
            window, re.IGNORECASE
        )
        if m:
            months = {'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04',
                      'MAY': '05', 'JUN': '06', 'JUL': '07', 'AUG': '08',
                      'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'}
            d = m.group(1).zfill(2)
            mo_str = m.group(0).upper()
            mo = next((v for k, v in months.items() if k in mo_str), '')
            y = m.group(2)
            if mo and 1900 <= int(y) <= 2100:
                return f"{y}-{mo}-{d}"
    return ""


def _extract_expiry_from_text(text: str) -> str:
    """从 OCR 文本中回退提取护照有效期至。"""
    return _extract_date_by_keywords(text, [
        "DATE OF EXPIRY", "EXPIRY DATE", "DATE OF EXPIRATION", "VALID UNTIL",
        "VALID THRU", "BESTEHEN BIS", "有效期至", "有效期", "失效日期",
        # 法/德/西/意等双语护照常见标注
        "DATE D'EXPIRATION", "DEXPIRATION", "EXPIRATION",
        "GÜLTIG BIS", "GULTIG BIS", "VERFALLSDATUM",
        "FECHA DE CADUCIDAD", "FECHA DE VENCIMIENTO", "VENCIMIENTO", "CADUCIDAD",
        "DATA DI SCADENZA", "SCADENZA", "VALABLE JUSQU", "VALIDE JUSQU",
        "EXPIRY",
    ])


def _extract_issue_from_text(text: str) -> str:
    """从 OCR 文本中回退提取护照签发日期。"""
    return _extract_date_by_keywords(text, [
        "DATE OF ISSUE", "ISSUED ON", "VALID FROM", "ISSUING DATE",
        "签发日期", "发证日期", "有效期开始",
        # 法/德/西/意等双语护照常见标注
        "DATE DE DELIVRANCE", "DELIVRANCE",
        "AUSSTELLUNGSDATUM", "AUSGESTELLT",
        "FECHA DE EXPEDICION", "EXPEDICION",
        "DATA DI RILASCIO", "RILASCIO",
    ])


def _scan_all_dates(text: str) -> list[str]:
    """扫描全文中所有合法日期，返回去重后的 YYYY-MM-DD 列表（按出现顺序）。

    支持格式：YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD / DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY。
    用于签发日/有效期其中一个已提到时的排除法推断。
    """
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()

    def _add(y: str, mo: str, d: str) -> None:
        try:
            yi, mi, di = int(y), int(mo), int(d)
        except ValueError:
            return
        if 1900 <= yi <= 2100 and 1 <= mi <= 12 and 1 <= di <= 31:
            val = f"{yi}-{str(mi).zfill(2)}-{str(di).zfill(2)}"
            if val not in seen:
                seen.add(val)
                found.append(val)

    for m in re.finditer(r'(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})', text):
        _add(m.group(1), m.group(2), m.group(3))
    for m in re.finditer(r'(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})', text):
        _add(m.group(3), m.group(2), m.group(1))
    return found


def _infer_missing_date_pair(text: str, issue: str, expiry: str,
                              birth_date: str = "") -> tuple[str, str]:
    """签发日/有效期互补推断：只提到一个时，从全文日期中排除法推断另一个。

    规则：
    - 有效期至(expiry)通常是未来日期或晚于签发日的日期（护照有效期一般5-10年）
    - 签发日(issue)通常早于有效期至，且晚于出生日期
    - 出生日期本身会被排除（避免把 birth_date 误判为 issue）
    返回 (issue, expiry)，已存在的保持不变。
    """
    if issue and expiry:
        return issue, expiry
    candidates = [d for d in _scan_all_dates(text) if d != birth_date]
    # 排除已经确定的那个值，避免重复分配
    known = issue or expiry
    pool = [d for d in candidates if d != known]
    if not pool:
        return issue, expiry

    if issue and not expiry:
        # 有效期应晚于签发日；优先选比签发日晚的，没有再选最大的
        later = [d for d in pool if d > issue]
        expiry = max(later) if later else ""
    elif expiry and not issue:
        # 签发日应早于有效期；优先选比有效期早的里面最大的（最接近签发时间）
        earlier = [d for d in pool if d < expiry]
        issue = max(earlier) if earlier else ""
    return issue, expiry


# ============ 本地正则/关键词字段提取（不依赖 Vision API） ============

# 各国护照常见字段标签的多语言关键词（OCR可能丢空格/混大小写，匹配时容忍）
_LABEL_SURNAME = [
    r"SURNAME", r"FAMILY\s*NAME", r"LAST\s*NAME",
    r"S[A-Z]?RNAME",  # OCR误拼：Pauthwa/Surname等
    r"ФАМИЛИЯ", r"ФАМИЛИЯ",  # 俄语
    r"姓", r"姓氏",
]
_LABEL_GIVEN = [
    r"GIVEN\s*NAMES?", r"FIRST\s*NAME", r"FORENAME",
    r"G[A-Z]{0,2}ENN?AMES?",  # OCR误拼：Gvennames/Gvennames/GIVENNAMES等
    r"ИМЯ", r"ИМЕНА",  # 俄语
    r"名", r"名字",
]
_LABEL_PASSPORT_NO = [
    r"PASSPORT\s*NO\.?", r"PASSPORT\s*NUMBER", r"DOCUMENT\s*NO\.?",
    r"Номер\s*паспорта", r"ПАСПОРТ",  # 俄语
    r"PASSPORTNO", r"PASSPORTNUMBER",
    r"护照号", r"护照号码",
]
_LABEL_NATIONALITY = [
    r"NATIONALITY", r"CITIZENSHIP",
    r"ГРАЖДАНСТВО", r"НАЦИОНАЛЬНОСТЬ",  # 俄语
    r"国籍",
]
_LABEL_GENDER = [
    r"SEX", r"GENDER",
    r"ПОЛ",  # 俄语
    r"性别",
]
_LABEL_ISSUE_AUTHORITY = [
    r"AUTHORITY", r"ISSUING\s*AUTHORITY", r"ISSUED\s*BY",
    r"ОРГАН", r"ВЫДАН",  # 俄语
    r"签发机关", r"发照机关",
]
_LABEL_BIRTH_PLACE = [
    r"PLACE\s*OF\s*BIRTH", r"BIRTH\s*PLACE",
    r"МЕСТО\s*РОЖДЕНИЯ",  # 俄语
    r"出生地点", r"出生地",
]


def _extract_after_label(text_upper: str, labels: list[str]) -> str:
    """在文本中查找标签关键词，返回其后的第一个有意义值（字母/数字序列）。

    OCR 常把标签和值粘连（如 "SURNAMEDUPONT" 或 "ФАМИЛИЯИВАНОВ"），
    因此先尝试精确匹配标签后内容，再尝试在标签后取连续字母。
    """
    import re as _re
    for label in labels:
        # 标签后可能紧跟值（无分隔符），或有空格/冒号/换行
        # 使用宽松匹配：标签本身 + 可选的非字母字符（空格/冒号/斜杠等）+ 捕获值
        # 值字符集含数字/句点/括号/逗号：俄语签发机关如
        # "ГУ МВД РОССИИ ПО Г. МОСКВЕ" / "ОТДЕЛЕНИЕМ УФМС ... ОБЛ." 需要这些字符
        pattern = label + r"[\s:：/\\|]*([A-ZА-ЯЁ][A-ZА-ЯЁ0-9.\-,()'\s]{1,60})"
        m = _re.search(pattern, text_upper)
        if m:
            val = m.group(1).strip().rstrip("<").rstrip(".").rstrip(",")
            # 去掉尾部可能粘连的下一个标签关键词
            for stop in ("NATIONALITY", "DATE", "SEX", "GENDER", "PLACE",
                         "AUTHORITY", "GIVEN", "PASSPORT", "ISSU",
                         "ГРАЖДАН", "ДАТА", "МЕСТО", "ОРГАН", "ПОЛ",
                         "ФАМИЛИЯ", "ИМЯ", "СРОК", "ТИП", "КОД"):
                idx = val.find(stop)
                if idx > 1:
                    val = val[:idx].strip()
            val = val.strip().rstrip(".").rstrip(",")
            if len(val) >= 2 and not val.isdigit():
                return val
    return ""


def _extract_latin_name_after_label(text_upper: str, labels: list[str]) -> str:
    """在标签后查找拉丁字母拼写的姓名（跳过西里尔字母/数字/噪声词）。

    护照OCR常在标签后先出现本国文字（西里尔/中文等），再出现拉丁字母拼写
    （如 "GVENNAMES ЕКАТЕРИНА EKATERINA"），需要取拉丁字母版本。
    搜索范围严格限制在当前标签与下一个已知标签之间，避免跨字段污染。
    """
    import re as _re
    # 下一个字段标签的起始模式（遇到这些说明当前字段值已结束）
    next_label_patterns = [
        r"PASSPORT", r"NATIONA[FL]", r"DATE[\sOF]", r"BIRTH", r"SEX",
        r"PLACE", r"ISSUE", r"EXPIR", r"AUTHOR", r"TYPE", r"CODE",
        r"GVENN?AMES?", r"GIVENN?AMES?", r"PAUTHWA", r"SURNAME",
        r"FEDERATION", r"PAXAA\w*", r"NACHOPT", r"P<",
        r"POCC\w+", r"AATAPOX", r"AAPAB", r"YUE", r"MECROP",
        r"HON/", r"NON/", r"DAMCT", r"X/F\s", r"M\s*/F",
    ]
    # 非姓名词黑名单
    skip_words = {"THE", "AND", "FOR", "RUS", "USA", "CHN", "TYPE",
                  "CODE", "FEDERATION", "REPUBLIC", "NUMBER", "NAME",
                  "SURNAME", "GIVEN", "NATIONAL", "PLACE", "BIRTH",
                  "ISSUE", "EXPIRY", "AUTHORITY", "HOUEE", "HOUU",
                  "MBA", "NORMOS", "MRA", "XATH", "VVA", "VVAGVENNAMES",
                  "CARSCAR", "KANMOOBAHO", "TN", "TYP", "RKNPNG",
                  "NACHOPT", "FEDERATIONRUS", "YEAR", "MONTH", "DAY",
                  "RUSSIANFEDERATION", "RUSSIANFEDERATI", "POCCMHCKAE",
                  "POCCMMCKAA", "RUSSIAN", "CHINESE", "AMERICAN"}

    def _looks_like_name(w: str) -> bool:
        if w in skip_words or w.isdigit() or len(w) < 3:
            return False
        # 连续4个以上辅音 → 西里尔OCR乱码
        if _re.search(r'[BCDFGHJKLMNPQRSTVWXYZ]{4,}', w):
            return False
        # 必须包含元音
        if not any(c in "AEIOU" for c in w):
            return False
        # 过滤全是OCR乱码特征的词（大量重复字母或奇怪序列）
        if _re.search(r'(.)\1{2,}', w):  # 3个以上相同字母连续
            return False
        return True

    for label in labels:
        pattern = label + r"[\s:：/\\|]*(.{1,150})"
        m = _re.search(pattern, text_upper)
        if not m:
            continue
        after = m.group(1)
        # 在换行处截断
        for ch in ("\n", "\r"):
            pos = after.find(ch)
            if pos >= 0:
                after = after[:pos]
        # 在下一个已知标签处截断
        earliest_cut = len(after)
        for nlp in next_label_patterns:
            nm = _re.search(nlp, after)
            if nm and nm.start() > 0 and nm.start() < earliest_cut:
                earliest_cut = nm.start()
        after = after[:earliest_cut]
        # 查找所有拉丁字母词
        words = _re.findall(r'[A-Z][A-Z\-]{1,30}', after)
        candidates = [w for w in words if _looks_like_name(w)]
        if candidates:
            # 在当前字段范围内，取最后一个合理候选（拉丁拼写在本国文字之后）
            return candidates[-1]
    return ""


def _extract_alphanum_after_label(text_upper: str, labels: list[str],
                                    min_len: int = 4, max_len: int = 20) -> str:
    """在标签后提取字母数字组合（如护照号）。

    支持护照印刷常见的"分段号码"：如 "PASSPORT NO 76 312345"（号码被空格拆成两段）。
    合并规则：仅当后续段为【纯数字】时才合并（避免把 DATE/SEX 等下一个标签词粘进来）。
    """
    import re as _re
    for label in labels:
        # 首段字母数字；后续段仅纯数字（同行空格分隔，最多再并 2 段）
        pattern = (label + r"[\s:：/\\|]*([A-Z0-9]+)((?:[ \t]+\d+){0,2})")
        m = _re.search(pattern, text_upper)
        if m:
            first = m.group(1).rstrip("<")
            merged = (first + (m.group(2) or "").replace(" ", "").replace("\t", "")).rstrip("<")
            # 优先用合并值（如 76+312345 → 76312345）；超长则回退首段
            for val in (merged, first):
                if min_len <= len(val) <= max_len:
                    # 排除纯字母国家码（太短或全是字母且<=3）
                    if not (val.isalpha() and len(val) <= 3):
                        return val
        # 回退：合并匹配失败时按原逻辑取单段
        pattern_single = label + r"[\s:：/\\|]*([A-Z0-9]{" + str(min_len) + r"," + str(max_len) + r"})"
        m2 = _re.search(pattern_single, text_upper)
        if m2:
            val = m2.group(1).strip().rstrip("<")
            if len(val) >= min_len:
                return val
    return ""


def _extract_gender_near_label(text_upper: str) -> str:
    """在性别标签附近找 F/M。"""
    import re as _re
    for label in _LABEL_GENDER:
        pattern = label + r"[\s:：/\\|]*([FM])"
        m = _re.search(pattern, text_upper)
        if m:
            return m.group(1)
    # 回退：找 "SEX" 后 20 字符内的独立 F/M
    m = _re.search(r'(?:SEX|GENDER|ПОЛ|性别)[\s:：/\\|]{0,10}([FM])(?![A-ZА-ЯЁ])', text_upper)
    if m:
        return m.group(1)
    return ""


def _rescue_segmented_number(text_upper: str, val: str, max_len: int = 20) -> str:
    """若 val 是全文中某个更长"字母数字串（允许空格/制表符分段）"的子串，返回更长合并值。
    修复 OCR/正则把 '76 312345' 截断成 '6312345' 一类的首段丢失问题。"""
    import re as _re
    if not val or len(val) < 4:
        return val
    best = val
    for m in _re.finditer(r"[A-Z0-9]+(?:[ \t]+\d+)+", text_upper):
        merged = _re.sub(r"[ \t]+", "", m.group(0))
        if len(best) < len(merged) <= max_len and val in merged:
            best = merged
    return best


# 本地已经显式处理的字段集合（自定义字段才能进入通用标签匹配）
_KNOWN_FIELDS = {
    "surname", "given_name", "name", "passport_no", "birth_date", "gender",
    "nationality", "passport_issue", "passport_expiry", "issue_authority",
    "issue_place", "birth_place", "email", "phone",
}

# 通用标签匹配时需要跳过的"过泛"词，避免把 NO/NAME 等当唯一标签到处命中
_GENERIC_LABEL_STOPS = {
    "NO", "NUMBER", "NUM", "N", "ID", "SN", "REFERENCE", "REF", "CODE",
    "NAME", "DATE", "PASSPORT", "NATIO", "SEX", "GENDER", "PLACE", "BIRTH",
    "ISSUE", "EXPIR", "TYPE", "TEL", "PHONE", "EMAIL", "ADDR", "ADDRESS",
}


def _extract_custom_field(text_upper: str, field_name: str) -> str:
    """按自定义字段名做本地标签匹配提取（不依赖 LLM）。

    field_name 常同时含中文与英文标签，如 "申请编号 Applicant No."。
    将字段名拆成多个候选标签（整体 + 各分段），逐个在 OCR 文本中查找，
    取标签后紧邻的字母数字值。用于用户在步骤设置里保存的非标准字段。
    """
    import re as _re
    if not text_upper or not field_name:
        return ""

    # 1. 候选标签：整体去空格 + 分段（按空格/斜杠/顿号/逗号切分）
    labels: list[str] = []
    whole = _re.sub(r"[\s/，,、:：.。#]+", "", field_name).upper()
    if whole:
        labels.append(whole)
    for part in _re.split(r"[\s/，,、:：]+", field_name):
        part = part.strip().upper()
        if part and part not in labels:
            labels.append(part)
    # 去掉过泛的短标签（如 NO），避免误命中
    labels = [lb for lb in labels if lb not in _GENERIC_LABEL_STOPS]

    for label in labels:
        if len(label) < 2:
            continue
        # 标签后跟可选分隔符 + 字母数字值（含 . / - 空格 分段）
        pattern = _re.escape(label) + r"[\s:：/\\|]*([A-Z0-9][A-Z0-9.\-/ ]{1,40})"
        m = _re.search(pattern, text_upper)
        if not m:
            continue
        val = m.group(1).strip().rstrip(".").rstrip("<")
        if not val:
            continue
        # 去掉值开头的 NO./NUMBER/SN 等前缀（如 "APPLICANT NO. 123456" 用 APPLICANT 标签时
        # 抓到 "NO. 123456"，冒号前不含于字符集导致截断，需剥离 "NO." 前缀取真实值）
        pre = _re.match(r'(?:NO[.]?\s*|NUMBER\s*|NUM\.?\s*|SN[.:]?\s*|ID[.:]?\s*|REF[.:]?\s*)', val)
        if pre:
            val = val[pre.end():].strip()
        # 在下一个字段标签处截断（避免粘连下一字段）
        for stop in ("DATE", "NUMBER", "PASSPORT", "NAME", "NATION",
                     "SEX", "GENDER", "PLACE", "BIRTH", "ISSU", "EXPIR",
                     "TYPE", "CODE", "TEL", "PHONE", "EMAIL"):
            idx = val.find(stop)
            if idx > 1:
                val = val[:idx].strip()
                break
        # 校验值合法性：至少 2 位，且不是纯标点/纯空
        if len(val) >= 2 and any(c.isalnum() for c in val):
            return val
    return ""


def _extract_local_fields(text: str, target_fields: list[str]) -> dict[str, str]:
    """纯本地正则/关键词字段提取，不依赖任何 API。

    作为 MRZ 和 Vision LLM 之后的兜底，从 OCR 文本中通过
    多语言标签关键词 + 日期模式 + 护照号模式提取字段。
    对俄语护照标签（Фамилия/Имя/Гражданство 等）也有支持。
    """
    if not text or not target_fields:
        return {}
    import re as _re
    upper = text.upper()
    result: dict[str, str] = {}

    # 姓名类（优先取拉丁字母拼写，跳过西里尔/噪声）
    if "surname" in target_fields:
        val = _extract_latin_name_after_label(upper, _LABEL_SURNAME)
        if not val:
            val = _extract_after_label(upper, _LABEL_SURNAME)
        if val:
            result["surname"] = val
    if "given_name" in target_fields:
        val = _extract_latin_name_after_label(upper, _LABEL_GIVEN)
        if not val:
            val = _extract_after_label(upper, _LABEL_GIVEN)
        if val:
            result["given_name"] = val
    if "name" in target_fields:
        sur = result.get("surname", "")
        giv = result.get("given_name", "")
        if sur or giv:
            result["name"] = f"{sur} {giv}".strip()

    # 护照号
    if "passport_no" in target_fields:
        val = _extract_alphanum_after_label(upper, _LABEL_PASSPORT_NO, min_len=5)
        if val:
            # 交叉验证：若全文存在包含该值的更长分段号码（如 "76 312345"），用更长值
            val = _rescue_segmented_number(upper, val)
        if val:
            result["passport_no"] = val

    # 国籍
    if "nationality" in target_fields:
        val = _extract_after_label(upper, _LABEL_NATIONALITY)
        if val:
            # 清理常见OCR粘连
            val = val.split("DATE")[0].split("SEX")[0].split("PLACE")[0].strip()
            if len(val) >= 2:
                result["nationality"] = val

    # 性别
    if "gender" in target_fields:
        val = _extract_gender_near_label(upper)
        if val:
            result["gender"] = val

    # 出生日期
    if "birth_date" in target_fields:
        val = _extract_date_by_keywords(text, [
            "DATE OF BIRTH", "BIRTH DATE",
            "ДАТА РОЖДЕНИЯ", "出生日期",
        ])
        if val:
            result["birth_date"] = val

    # 签发日期
    if "passport_issue" in target_fields:
        val = _extract_date_by_keywords(text, [
            "DATE OF ISSUE", "ISSUED ON", "VALID FROM",
            "ДАТА ВЫДАЧИ", "签发日期",
        ])
        if val:
            result["passport_issue"] = val

    # 有效期
    if "passport_expiry" in target_fields:
        val = _extract_date_by_keywords(text, [
            "DATE OF EXPIRY", "EXPIRY DATE", "DATE OF EXPIRATION",
            "VALID UNTIL", "VALID THRU", "СРОК ДЕЙСТВИЯ",
            "有效期至", "有效期", "失效日期",
        ])
        if val:
            result["passport_expiry"] = val

    # 签发机关
    if "issue_authority" in target_fields:
        val = _extract_after_label(upper, _LABEL_ISSUE_AUTHORITY)
        if val:
            result["issue_authority"] = val

    # 出生地点
    if "issue_place" in target_fields or "birth_place" in target_fields:
        val = _extract_after_label(upper, _LABEL_BIRTH_PLACE)
        if val:
            if "issue_place" in target_fields:
                result["issue_place"] = val
            if "birth_place" in target_fields:
                result["birth_place"] = val

    # 邮箱
    if "email" in target_fields:
        m = _re.search(r'[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}', upper)
        if m:
            result["email"] = m.group(0)

    # 电话
    if "phone" in target_fields:
        m = _re.search(r'(?:\+?\d[\d\s\-()]{6,}\d)', upper)
        if m:
            result["phone"] = m.group(0).strip()

    # 自定义字段（非标准字段）：按字段名做本地标签匹配兜底，不依赖 LLM
    for f in target_fields:
        if f in result or f in _KNOWN_FIELDS:
            continue
        try:
            val = _extract_custom_field(upper, f)
        except Exception:
            val = ""
        if val:
            result[f] = val

    return result
