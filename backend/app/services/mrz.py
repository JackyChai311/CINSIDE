"""MRZ（机读区）解析与校验位修复。

从 app/services/document_extract.py 拆分而来：这一组是**纯函数**，
不碰 OCR 引擎、进程管理、文件 IO 或网络，因此可以独立测试
（见 tests/test_mrz_parser.py）。

关于 re：本模块**不需要**在文件顶部 import re —— 各函数内部按原样保留了自己的
局部别名（`import re as _re` / `_re_norm`）。这是从原文件原样带过来的写法，
为降低搬迁风险未作改写。

约束：本模块**不得**反过来 import document_extract，否则形成循环导入。
_ISO3_COUNTRY_CODES 一并搬到这里，由 document_extract 反向 import 它。
"""
from __future__ import annotations


# ============ MRZ 解析（护照机器可读区） ============
def _normalize_for_compare(s: str) -> str:
    """归一化字符串用于比较：去空格、转大写、去除多余符号。"""
    import re as _re_norm
    s = s.upper().strip()
    s = _re_norm.sub(r'[\s\-_/]+', '', s)
    return s


def _mrz_char_val(ch: str) -> int:
    """ICAO MRZ 字符值：0-9→0-9，A-Z→10-35，<→0；非法字符返回 -1。"""
    if ch.isdigit():
        return int(ch)
    if ch.isalpha():
        return ord(ch.upper()) - 55
    if ch == "<":
        return 0
    return -1


def _icao_check(s: str) -> int:
    """ICAO 9303 检查位：字符值按 7,3,1 循环加权求和 mod 10。"""
    total = 0
    for i, ch in enumerate(s):
        v = _mrz_char_val(ch)
        if v < 0:
            return -1
        total += v * (7, 3, 1)[i % 3]
    return total % 10


_MRZ_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ<"


# OCR 视觉易混淆字符表（双向）：替换修复只接受混淆字符，避免把正确字符改错
_CONFUSABLE: dict[str, str] = {
    "0": "OQD", "O": "0QD", "Q": "0OD", "D": "0O",
    "1": "IL", "I": "1L", "L": "1I",
    "2": "Z", "Z": "2",
    "5": "S", "S": "5",
    "8": "B", "B": "8",
    "6": "G7", "G": "6",
    "7": "T16", "T": "7",
    "4": "A", "A": "4",
    "U": "V", "V": "U",
    "M": "N", "N": "M",
    "C": "G", "E": "F", "F": "E",
}


def _repair_mrz_line2(line2: str) -> str:
    """用 ICAO 检查位修复 MRZ 第二行的单字符 OCR 错误（丢字/错字/多字）。

    第二行前 10 位 = 护照号(9) + 检查位(1)。OCR 认错一位（如 7→6）或丢一位
    会导致后续所有固定位（国家码/日期/性别）整体错位，级联污染全部字段。
    尝试单字符 插入/替换/删除 变异，取同时满足以下条件者：
    检查位通过 + 国家码是合法 ISO 码 + 出生日期段为 6 位数字。
    无合格变异则原样返回。
    """
    if len(line2) < 11:
        return line2

    def _ok(cand: str) -> bool:
        # 护照号检查位
        if _icao_check(cand[:9]) != _mrz_char_val(cand[9]):
            return False
        cc = cand[10:13]
        if not (cc.isalpha() and len(cc) == 3 and cc in _ISO3_COUNTRY_CODES):
            return False
        dob = cand[13:19]
        if not (len(dob) == 6 and dob.isdigit()):
            return False
        # 出生日期检查位（位置19）
        if len(cand) >= 20 and _icao_check(cand[13:19]) != _mrz_char_val(cand[19]):
            return False
        # 有效期段（21-26 数字）+ 其检查位（位置27）
        if len(cand) >= 28:
            exp = cand[21:27]
            if not (exp.isdigit() and _icao_check(exp) == _mrz_char_val(cand[27])):
                return False
        # 整体检查位（位置43，覆盖 0-9 + 13-19 + 21-27 + 28-41，不含可选数据检查位42）
        if len(cand) >= 44:
            overall_src = cand[0:10] + cand[13:20] + cand[21:28] + cand[28:42]
            if _icao_check(overall_src) != _mrz_char_val(cand[43]):
                return False
        return True

    # 已正确则直接返回
    if _ok(line2):
        return line2

    def _finish(cand: str, how: str) -> str:
        """统一的返回出口，顺便把「不可证明正确」这件事显式暴露出来。

        为什么要告警：ICAO 检查位只能证明「按 7,3,1 加权求和 mod 10 成立」，
        并不能证明改对了。同一组检查位下存在大量等价解，例如：
          - L898902C3 丢掉一位后，把 '6' 插到行首得到的 6L89902C3 同样满足检查位；
          - 8→B 认错时，把行首 L 换成 I（加权差正好抵消）也能满足检查位。
        此时护照号会被"修"成另一个值 —— 因此只要改动落在护照号本体
        （前 9 位）上，就必须告警提示人工复核，不能让错值静默当成事实使用。
        """
        if cand[:9] != line2[:9]:
            print(
                f"[MRZ-REPAIR][WARN] {how} 改动了护照号本体: "
                f"'{line2[:9]}' → '{cand[:9]}'；检查位通过不能证明该值正确，请人工复核",
                flush=True,
            )
        else:
            print(f"[MRZ-REPAIR] {how} → {cand[:19]}", flush=True)
        return cand

    # 单字符插入（OCR 丢字，如 763890288 → 63890288）
    for pos in range(11):
        for ch in _MRZ_CHARS:
            cand = line2[:pos] + ch + line2[pos:]
            if _ok(cand):
                return _finish(cand, f"插入修复: 位置{pos} 插入'{ch}'")
    # 单字符替换（OCR 认错，如 8→B）：只接受视觉易混淆字符，避免把正确字符改错
    for pos in range(11):
        for ch in _CONFUSABLE.get(line2[pos], ""):
            cand = line2[:pos] + ch + line2[pos + 1:]
            if _ok(cand):
                return _finish(cand, f"替换修复: 位置{pos} '{line2[pos]}'→'{ch}'")
    # 单字符删除（OCR 多字）
    for pos in range(11):
        cand = line2[:pos] + line2[pos + 1:]
        if len(cand) >= 19 and _ok(cand):
            return _finish(cand, f"删除修复: 位置{pos} 删除'{line2[pos]}'")

    # 修复失败：原样返回。此时若检查位本就不成立，要明确告警而不是静默返回，
    # 否则调用方会把一条自相矛盾的 MRZ 当作正常结果继续解析。
    failed = []
    if len(line2) > 9 and _icao_check(line2[:9]) != _mrz_char_val(line2[9]):
        failed.append("护照号检查位")
    if len(line2) > 19 and _icao_check(line2[13:19]) != _mrz_char_val(line2[19]):
        failed.append("出生日期检查位")
    if len(line2) > 27 and line2[21:27].isdigit() and _icao_check(line2[21:27]) != _mrz_char_val(line2[27]):
        failed.append("有效期检查位")
    if failed:
        print(
            f"[MRZ-REPAIR][WARN] 无法修复，原样返回；校验失败的字段: {'/'.join(failed)}"
            f"（该行 MRZ 不可信）",
            flush=True,
        )
    return line2


def _parse_mrz(text: str) -> dict[str, str]:
    """从OCR文本中解析护照MRZ区，提取 surname/given_name/name/passport_no/birth_date/gender/nationality 等字段。

    TD3（普通护照）MRZ格式：两行，每行44字符
    第1行: P[类型补充]<国家码><SURNAME<<GIVEN<NAMES<<<<<
           实际OCR中 < 常被识别为其他字符，格式可能不严格，需通过 << 定位
    第2行: 护照号(9)检查位(1)国家码(3)出生年(2)月(2)日(2)检查位(1)性别(1)失效年(2)月(2)日(2)检查位(1)个人号(14)检查位(1)整体检查位(1)

    如果识别成功返回 dict，未识别到返回空 dict。
    """
    import re as _re

    # 清洗OCR文本：去除多余空格，统一行分隔符，统一大写
    cleaned = text.replace("\r\n", "\n").replace("\r", "\n").upper()
    # 去除OCR可能产生的空格
    cleaned = _re.sub(r'[ \t]+', '', cleaned)
    # PaddleOCR 常把 MRZ 填充符 < 识别为 unicode 变体（«/‹/〈/全角＜等），统一归一。
    # く/ク：PP-OCRv6 中文模型对连续填充符的高发误识（实测一整段<<<<<<<读成くくく…）
    for _lt_variant in ("«", "‹", "〈", "＜", "≪", "⋘", "く", "ク"):
        cleaned = cleaned.replace(_lt_variant, "<")

    # 把所有连续的非字母数字<的字符作为行分隔
    lines = [l.strip() for l in cleaned.split("\n") if l.strip()]

    # 在所有行中找MRZ第一行：包含 P< + 三字母国家码 + << 模式
    mrz_line1 = None
    mrz_line2 = None

    # MRZ 日期段（出生/有效期）在 OCR 中常见的数字混淆字符（0→O/Q/D，1→I/L，2→Z，5→S，8→B）
    _DIGITISH = r'[0-9OQILZSB]'

    def _looks_like_mrz_line2(cand: str) -> bool:
        """MRZ第二行特征：全是大写字母/数字/<，长度>=28，含6位日期段（容忍数字混淆）。
        性别码 F/M 可能被 OCR 误识（F→E/P、M→N/H），不再强制要求；
        两段 6 位日期段（出生+有效期）同时出现是更稳定的信号。"""
        if not (len(cand) >= 28 and _re.match(r'^[A-Z0-9<]+$', cand)):
            return False
        if len(_re.findall(_DIGITISH + r'{6}', cand)) >= 2:
            return True
        return ("F" in cand or "M" in cand) and _re.search(_DIGITISH + r'{6}', cand) is not None

    def _find_line2_after(idx: int) -> str | None:
        """在 lines[idx] 之后的若干行中找 MRZ 第二行（OCR 可能在两行 MRZ 之间插入噪声行）。"""
        for j in range(idx + 1, min(idx + 6, len(lines))):
            cand = lines[j]
            if _looks_like_mrz_line2(cand):
                return cand
            # 噪声行可能只混入少量小写/杂字符：清洗后再判一次
            cand2 = _re.sub(r'[^A-Z0-9<]', '', cand)
            if cand2 != cand and _looks_like_mrz_line2(cand2):
                return cand2
        return None

    def _find_mrz_line1_in(text_line: str) -> str | None:
        """在一行文本中查找MRZ第一行的起始位置，返回从 P< 开始的子串。

        OCR常把MRZ和其他文字混在同一行（如 "...DATE 11.08.2030 P<RUSSTOKOLIAN<<..."），
        不能要求整行以P开头，而应在行内搜索 P<[A-Z]{3} 模式。
        """
        # 找 P< 后面紧跟3个大写字母（国家码）的位置
        for m in _re.finditer(r'P<[A-Z]{3}', text_line):
            start = m.start()
            candidate = text_line[start:]
            # 从 P< 开始，取连续的 MRZ 字符（字母/数字/<）直到遇到非MRZ字符
            mrz_chars = _re.match(r'[A-Z0-9<]+', candidate)
            if mrz_chars:
                extracted = mrz_chars.group(0)
                if "<<" in extracted and len(extracted) >= 20:
                    return extracted
        return None

    for i, line in enumerate(lines):
        found = _find_mrz_line1_in(line)
        if found:
            mrz_line1 = found
            mrz_line2 = _find_line2_after(i)
            break

    # 回退：OCR 把 P 和国家码之间的 < 丢掉/误识别时，允许 P 直接跟三字母国家码
    # （需同时存在 << 分隔与足够长度，避免误匹配 PLEASE 等普通单词）
    if not mrz_line1:
        for i, line in enumerate(lines):
            for m in _re.finditer(r'P[A-Z]{3}', line):
                candidate = line[m.start():]
                mrz_chars = _re.match(r'[A-Z0-9<]+', candidate)
                if not mrz_chars:
                    continue
                extracted = mrz_chars.group(0)
                if "<<" in extracted and len(extracted) >= 20:
                    mrz_line1 = extracted
                    mrz_line2 = _find_line2_after(i)
                    break
            if mrz_line1:
                break

    # 回退0：如果MRZ第一行和第二行在同一行（OCR合并），尝试从mrz_line1中切出第二行
    if mrz_line1 and not mrz_line2:
        # 在mrz_line1中搜索第二行模式：9位字母数字+1位+3位国家码+6位日期+检查位+F/M+6位日期
        m2 = _re.search(r'([A-Z0-9]{9}[A-Z0-9<][A-Z]{3}' + _DIGITISH + r'{6}[0-9A-Z<][FM]' + _DIGITISH + r'{6}[A-Z0-9<]*)', mrz_line1)
        if m2:
            mrz_line2 = m2.group(1)
            # 第一行截断到第二行开始之前
            l1_end = m2.start()
            if l1_end >= 20:
                mrz_line1 = mrz_line1[:l1_end]

    # 回退1：MRZ第一行本身可能因为超长需要在44字符附近截断（TD3每行44字符）
    if mrz_line1 and len(mrz_line1) > 50 and not mrz_line2:
        for cut in range(40, min(49, len(mrz_line1) - 28)):
            tail = mrz_line1[cut:]
            if _looks_like_mrz_line2(tail):
                mrz_line2 = tail
                mrz_line1 = mrz_line1[:cut]
                break

    # 回退2：全文正则搜索MRZ第二行模式（护照号9位+检查位+国家码3位+出生6位+检查位+性别+有效期6位）
    if mrz_line1 and not mrz_line2:
        flat = cleaned.replace("\n", "")
        m = _re.search(r'[A-Z0-9]{9}[A-Z0-9<][A-Z]{3}' + _DIGITISH + r'{6}[0-9A-Z<][FM]' + _DIGITISH + r'{6}[A-Z0-9<]*', flat)
        if m:
            mrz_line2 = m.group(0)

    # ICAO 检查位修复：OCR 丢字/错字会让第二行固定位整体错位（国家码/日期全错），
    # 用检查位+国家码+出生日期三重约束自动纠回单字符错误
    if mrz_line2:
        mrz_line2 = _repair_mrz_line2(mrz_line2)

    result: dict[str, str] = {}
    if not mrz_line1:
        return result

    line1 = mrz_line1

    # === 解析第一行 ===
    # 找到 << 的位置（surname和given name的分隔符）
    sep_idx = line1.find("<<")
    if sep_idx < 3:
        return result  # << 太靠前，无法解析

    # 提取surname：<< 之前，去掉开头的文档类型（P）和国家码（3位）以及分隔<
    surname_part = ""
    country_code = ""

    # 首先从第二行获取国家码（更可靠，位置固定在10-12位）
    if mrz_line2 and len(mrz_line2) >= 13:
        cc2 = mrz_line2[10:13]
        if _re.match(r'^[A-Z]{3}$', cc2):
            country_code = cc2

    pre_sep = line1[1:sep_idx].lstrip("<")  # 跳过开头P和<，得到国家码+姓氏部分

    if country_code:
        # 已知国家码，在pre_sep中找到它的位置，后面的字母就是surname
        cc_pos = pre_sep.find(country_code)
        if cc_pos >= 0:
            after_cc = pre_sep[cc_pos + 3:]
            # after_cc可能以<开头（分隔符），也可能直接是surname（OCR丢失<）
            # 去掉开头的非字母字符
            sur_start = 0
            while sur_start < len(after_cc) and not after_cc[sur_start].isalpha():
                sur_start += 1
            # 从sur_start开始取连续字母
            sur_match = _re.match(r'[A-Z]+', after_cc[sur_start:])
            if sur_match:
                surname_part = sur_match.group(0)

    if not surname_part:
        # HARNESS：无第二行国家码时按第一行固定位拆：P< + 3位ISO国家码 + 姓氏。
        # 必须在「最后一个<」回退之前执行：单< BUG 时 pre_sep = "国家码+姓<名"
        # （RUSKULAGIN<GLEB），最后一个<后面是名字 GLEB 而不是姓
        cc1 = pre_sep[:3]
        if cc1 in _ISO3_COUNTRY_CODES:
            sur_match = _re.match(r'[A-Z]{2,}', pre_sep[3:].lstrip("<"))
            if sur_match:
                country_code = country_code or cc1
                surname_part = sur_match.group(0)
                print(f"[MRZ-HARNESS] 第一行国家码固定位拆分: {pre_sep} → 国家码={cc1}, 姓氏={surname_part}")

    if not surname_part:
        # 回退策略1：在pre_sep中寻找最后一个<，<后面的字母就是surname
        last_lt = pre_sep.rfind("<")
        if last_lt >= 0:
            after_lt = pre_sep[last_lt + 1:]
            sur_match = _re.match(r'[A-Z]+', after_lt)
            if sur_match:
                surname_part = sur_match.group(0)

    if not surname_part:
        # HARNESS：MRZ 第一行固定格式 = P< + 3位ISO国家码 + 姓氏。
        # 第二行国家码缺失/损坏时按第一行固定位直接拆
        # （RUSNIKUSHKINA<<ANNA → RUS + NIKUSHKINA），零成本、不依赖第二行
        pre_clean = pre_sep.rstrip("<")
        m1 = _re.match(r'^([A-Z]{3})([A-Z]{4,})$', pre_clean)
        if m1 and m1.group(1) in _ISO3_COUNTRY_CODES:
            country_code = country_code or m1.group(1)
            surname_part = m1.group(2)
            print(f"[MRZ-HARNESS] 第一行固定位拆分: {pre_clean} → 国家码={m1.group(1)}, 姓氏={m1.group(2)}")

    if not surname_part:
        # 回退策略2：找最后一个连续大写字母序列
        sur_matches = list(_re.finditer(r'[A-Z]{2,}', pre_sep))
        if sur_matches:
            # 如果有国家码，找国家码之后的字母序列
            if country_code:
                for m in sur_matches:
                    if m.start() >= pre_sep.find(country_code) + 3 if country_code in pre_sep else True:
                        surname_part = m.group(0)
                        break
            if not surname_part:
                # 取最后一个足够长的字母序列
                long_matches = [m for m in sur_matches if len(m.group(0)) >= 3]
                if long_matches:
                    surname_part = long_matches[-1].group(0)
                else:
                    surname_part = sur_matches[-1].group(0)

    if not surname_part:
        # 最终回退：跳过P和前3个字符（国家码位置），后面是surname直到<<或<
        after_p = line1[1:]
        if len(after_p) >= 3:
            rest = after_p[3:]
            # 跳过开头的非字母字符（可能是OCR错误识别的<变体）
            sur_start = 0
            while sur_start < len(rest) and not rest[sur_start].isalpha():
                sur_start += 1
            sur_match = _re.match(r'[A-Z]+', rest[sur_start:])
            if sur_match:
                surname_part = sur_match.group(0)
            else:
                surname_part = rest.lstrip("<").split("<")[0].split("<<")[0]

    # 如果已知国家码但surname开头包含了国家码的尾字母，需要裁剪
    if country_code and surname_part:
        # 检查surname是否错误地包含了国家码前缀
        # 常见情况：OCR把<RUS识别成NRUS，surname变成NRUSBYSTROVA
        # 国家码是RUS，但N是误识别的<
        if surname_part.startswith(country_code):
            pass  # 正确，国家码不在surname中
        elif country_code in surname_part:
            idx = surname_part.find(country_code)
            if idx > 0 and idx <= 2:
                # 国家码出现在surname开头附近，前面的是误识别字符，裁剪掉
                surname_part = surname_part[idx + 3:]

    # 提取given names：第一个<<之后到行尾（或下一个<<<结束标记）
    given_part = line1[sep_idx + 2:]
    # 找到连续的<<<之后的填充部分并截断
    fill_start = given_part.find("<<<")
    if fill_start >= 0:
        given_part = given_part[:fill_start]
    # OCR常在两行MRZ之间插入噪声（如 "EKATERINAMBA78036NORMOSXATH"），
    # MRZ第一行名字区只含字母和<，遇到数字说明已超出名字范围
    digit_pos = None
    for ci, ch in enumerate(given_part):
        if ch.isdigit():
            digit_pos = ci
            break
    if digit_pos is not None:
        given_part = given_part[:digit_pos]
    given_part = given_part.rstrip("<")
    given_name = given_part.replace("<", " ").strip()
    surname = surname_part.strip()

    # HARNESS：姓/名分隔符 << 被 OCR 读成单个 < 时（如 P<RUSKULAGIN<GLEB<<），
    # 上面的 sep_idx 会错误定位到名字后面的填充区，名字被并进姓区域 pre_sep
    # （KULAGIN<GLEB → 只解析出姓 KULAGIN，名 GLEB 丢失）。
    # 名字为空时从 pre_sep 的 < 分隔段恢复：跳过国家码和已解析的姓，剩余段即名字
    if not given_name and surname and pre_sep:
        segs = [s for s in pre_sep.split("<") if s and s.isalpha()]
        rest = segs[:]
        # 国家码常与姓粘连无<分隔（RUSKULAGIN）：剥掉前3字符国家码前缀
        if country_code and rest and rest[0].startswith(country_code) and len(rest[0]) > 3:
            rest[0] = rest[0][3:]
        elif country_code and rest and rest[0] == country_code:
            rest = rest[1:]
        if surname in rest:
            rest = rest[rest.index(surname) + 1:]
        if rest:
            given_name = " ".join(rest)
            print(f"[MRZ-HARNESS] 单<分隔恢复名字: {pre_sep} → 名字={given_name}")

    if surname:
        result["surname"] = surname
    if given_name:
        result["given_name"] = given_name
    if surname or given_name:
        result["name"] = f"{surname} {given_name}".strip()

    # 国家码映射
    _COUNTRY_MAP = {
        "CHN": "CHINESE", "RUS": "RUSSIAN", "USA": "AMERICAN", "GBR": "BRITISH",
        "JPN": "JAPANESE", "KOR": "KOREAN", "DEU": "GERMAN", "FRA": "FRENCH",
        "CAN": "CANADIAN", "AUS": "AUSTRALIAN", "NLD": "DUTCH", "ESP": "SPANISH",
        "ITA": "ITALIAN", "SGP": "SINGAPOREAN", "MYS": "MALAYSIAN", "THA": "THAI",
        "VNM": "VIETNAMESE", "IDN": "INDONESIAN", "IND": "INDIAN", "UKR": "UKRAINIAN",
        "BLR": "BELARUSIAN", "KAZ": "KAZAKH", "UZB": "UZBEK", "TUR": "TURKISH",
        "PN": "RUSSIAN",  # 可能OCR把<RUS识别成NRUS
    }
    if country_code:
        country_code_clean = country_code.rstrip("<")
        if len(country_code_clean) >= 3:
            country_code_clean = country_code_clean[-3:]  # 取最后3个字母作为国家码
        if _re.match(r'^[A-Z]{3}$', country_code_clean):
            result["nationality"] = _COUNTRY_MAP.get(country_code_clean, country_code_clean)

    # === 解析第二行（如果存在）：护照号、出生日期、性别、有效期 ===
    if mrz_line2:
        line2 = mrz_line2
        # 护照号：前9位（字母数字，去掉末尾<填充）
        passport_no = line2[:9].rstrip("<")
        if _re.match(r'^[A-Z0-9]{4,}$', passport_no):
            result["passport_no"] = passport_no

        # === 出生日期 / 性别 / 有效期（TD3标准布局：护照号9 检查位1 国家码3 出生6 检查位1 性别1 有效期6） ===
        # OCR 数字混淆纠正：MRZ 字体下 PaddleOCR 常把 0→O/Q/D、1→I/L、2→Z、5→S、8→B、6→G、7→T
        def _fix_ocr_digits(s: str) -> str:
            return (s.replace("O", "0").replace("Q", "0").replace("D", "0")
                     .replace("I", "1").replace("L", "1")
                     .replace("Z", "2").replace("S", "5").replace("B", "8")
                     .replace("G", "6").replace("T", "7"))

        def _valid_date6(s: str) -> bool:
            """6位 YYMMDD 合法性校验（防止从错误偏移截出垃圾日期）。"""
            if not _re.match(r'^\d{6}$', s):
                return False
            mm, dd = int(s[2:4]), int(s[4:6])
            return 1 <= mm <= 12 and 1 <= dd <= 31

        birth_str = ""
        expiry_str = ""
        sex_char = ""

        def _recover_sex(ch: str) -> str:
            """性别位字符恢复：MRZ 性别域只会是 F/M/<，OCR 常见误识 F→E/P、M→N/H，就近映射。"""
            if ch in "FM":
                return ch
            if ch in "EP":
                return "F"
            if ch in "NH":
                return "M"
            return ""

        def _match_dates_pattern(sex_inner: str, segment: str, anchored: bool) -> tuple[str, str, str] | None:
            """按 出生6+检查位+性别+有效期6 结构在 segment 中匹配，双日期校验通过才返回。
            anchored=True 时要求从 segment 起始处匹配（segment 为国家码之后的串）；
            anchored=False 时在 segment 全文搜「任意三字母 + 日期结构」。"""
            pat = r'(' + _DIGITISH + r'{6})[0-9A-Z<]([' + sex_inner + r'])(' + _DIGITISH + r'{6})'
            matches = [_re.match(pat, segment)] if anchored else _re.finditer(r'[A-Z]{3}' + pat, segment)
            for m in matches:
                if not m:
                    continue
                b = _fix_ocr_digits(m.group(1))
                e = _fix_ocr_digits(m.group(3))
                if _valid_date6(b) and _valid_date6(e):
                    return b, _recover_sex(m.group(2)), e
            return None

        hit: tuple[str, str, str] | None = None
        # 方案1：锚定已知国家码（第二行10-12位）之后结构化提取——对护照号移位/丢字符免疫。
        # 性别位先严（F/M）后宽（任意字母，OCR 误识 F→E、M→N 时仍能定位出生/有效期）。
        if country_code:
            cc_start = 9
            while not hit:
                cc_idx = line2.find(country_code, cc_start)
                if cc_idx < 0:
                    break
                tail = line2[cc_idx + 3:]
                hit = (_match_dates_pattern("FM", tail, anchored=True)
                       or _match_dates_pattern("A-Z<", tail, anchored=True))
                cc_start = cc_idx + 1
        # 方案2：固定位置（TD3 标准布局：出生13-18 检查位19 性别20 有效期21-26 检查位27）
        if not hit and len(line2) > 26:
            b2 = _fix_ocr_digits(line2[13:19])
            e2 = _fix_ocr_digits(line2[21:27])
            if _valid_date6(b2) and _valid_date6(e2):
                hit = (b2, _recover_sex(line2[20]), e2)
        # 方案3：全文结构化兜底（国家码未知时；任意三字母后接日期结构，日期校验防误锚）
        if not hit:
            hit = (_match_dates_pattern("FM", line2, anchored=False)
                   or _match_dates_pattern("A-Z<", line2, anchored=False))
        if hit:
            birth_str, sex_char, expiry_str = hit

        # 方案4：日期均失败时，仅在 16-26 窗口内搜 F/M 取性别（宁缺毋错，
        # 不用「全文任意F/M」错位回退——护照号含F/M时会截出错误日期）
        if not sex_char and len(line2) >= 26:
            wm = _re.search(r'[FM]', line2[16:26])
            if wm:
                sex_char = wm.group(0)

        if sex_char:
            result["gender"] = sex_char
        if _valid_date6(birth_str):
            byy, bmm, bdd = birth_str[:2], birth_str[2:4], birth_str[4:6]
            year_prefix = 19 if int(byy) > 30 else 20
            result["birth_date"] = f"{year_prefix}{byy}-{bmm}-{bdd}"
        if _valid_date6(expiry_str):
            eyy, emm, edd = expiry_str[:2], expiry_str[2:4], expiry_str[4:6]
            result["passport_expiry"] = f"20{eyy}-{emm}-{edd}"

    return result


# ISO 3166-1 alpha-3 国家/地区代码（用于拆分 "RUSNIKITA" 类粘连值）
_ISO3_COUNTRY_CODES = {
    "AFG", "ALB", "DZA", "AND", "AGO", "ATG", "ARG", "ARM", "AUS", "AUT",
    "AZE", "BHS", "BHR", "BGD", "BRB", "BLR", "BEL", "BLZ", "BEN", "BTN",
    "BOL", "BIH", "BWA", "BRA", "BRN", "BGR", "BFA", "BDI", "CPV", "KHM",
    "CMR", "CAN", "CAF", "TCD", "CHL", "CHN", "COL", "COM", "COD", "COG",
    "CRI", "CIV", "HRV", "CUB", "CYP", "CZE", "DNK", "DJI", "DMA", "DOM",
    "ECU", "EGY", "SLV", "GNQ", "ERI", "EST", "SWZ", "ETH", "FJI", "FIN",
    "FRA", "GAB", "GMB", "GEO", "DEU", "GHA", "GRC", "GRD", "GTM", "GIN",
    "GNB", "GUY", "HTI", "HND", "HUN", "ISL", "IND", "IDN", "IRN", "IRQ",
    "IRL", "ISR", "ITA", "JAM", "JPN", "JOR", "KAZ", "KEN", "KIR", "PRK",
    "KOR", "KWT", "KGZ", "LAO", "LVA", "LBN", "LSO", "LBR", "LBY", "LIE",
    "LTU", "LUX", "MDG", "MWI", "MYS", "MDV", "MLI", "MLT", "MHL", "MRT",
    "MUS", "MEX", "FSM", "MDA", "MCO", "MNG", "MNE", "MAR", "MOZ", "MMR",
    "NAM", "NRU", "NPL", "NLD", "NZL", "NIC", "NER", "NGA", "MKD", "NOR",
    "OMN", "PAK", "PLW", "PAN", "PNG", "PRY", "PER", "PHL", "POL", "PRT",
    "QAT", "ROU", "RUS", "RWA", "KNA", "LCA", "VCT", "WSM", "SMR", "STP",
    "SAU", "SEN", "SRB", "SYC", "SLE", "SGP", "SVK", "SVN", "SLB", "SOM",
    "ZAF", "SSD", "ESP", "LKA", "SDN", "SUR", "SWE", "CHE", "SYR", "TWN",
    "TJK", "TZA", "THA", "TLS", "TGO", "TON", "TTO", "TUN", "TUR", "TKM",
    "TUV", "UGA", "UKR", "ARE", "GBR", "USA", "URY", "UZB", "VUT", "VAT",
    "VEN", "VNM", "YEM", "ZMB", "ZWE",
}
