"""文档文字提取服务：MarkItDown（Office）+ Vision OCR（图片/扫描PDF）。

功能1/2 的核心依赖：
- DOCX/PPTX/XLSX/HTML 等 → 微软开源 MarkItDown 转 markdown 文本
- PNG/JPG/WEBP/BMP 等图片 → 配置的 Vision LLM 识别文字
- PDF（含扫描件）          → PyMuPDF 渲染为高 DPI 图片 → 预处理 → Vision OCR
- 提取出全文后，再用一次 Vision LLM 把目标字段结构化成 JSON（供左右对比 / 填入网页）

图像预处理（对所有走 Vision OCR 的输入生效，含 PDF 转出的图片）：
1. EXIF 自动旋转到正面（纠正手机拍摄方向）
2. 裁剪白边（基于缩略图快速检测 bbox，再按比例应用到原图，避免大图处理慢）
3. 大图降采样到最长边 2560px，平衡 OCR 准确率与上传带宽
"""
from __future__ import annotations

import base64
import io
import json
import re

import httpx

from ..config import settings

# 支持的图片扩展名（走 Vision OCR + 预处理）
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
# PDF 扩展名（走 PyMuPDF 渲染 → 预处理 → Vision OCR）
PDF_EXTS = {".pdf"}
# 其余交给 MarkItDown（docx/pptx/xlsx/html/txt/md/csv...）

# 预处理参数
_WHITE_THRESH = 245      # 灰度 > 该值视为白边背景
_BBOX_DETECT_MAX = 512   # bbox 检测缩略图最长边（小图检测极快）
_MAX_OUTPUT_EDGE = 2560  # 输出图最长边上限（防止上传过大）
_MIN_KEEP_MARGIN = 8     # 裁剪时四周至少保留 8px 边距，避免贴边误裁


def is_image_file(filename: str) -> bool:
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return ext in IMAGE_EXTS


def is_pdf_file(filename: str) -> bool:
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return ext in PDF_EXTS


# ============ 图片预处理：EXIF 旋转 + 裁白边 + 降采样 ============
def preprocess_image(content: bytes) -> tuple[bytes, str | None]:
    """对图片做预处理：EXIF 自动旋转到正面 + 裁剪白边 + 限制最大尺寸。

    返回: (处理后的 JPEG bytes, base64 预览或 None)
    如果 PIL 不可用或处理失败，返回原始内容。
    """
    try:
        from PIL import Image, ImageOps

        img = Image.open(io.BytesIO(content))

        # 1. EXIF 自动旋转到正面（手机拍摄的照片方向纠正）
        img = ImageOps.exif_transpose(img)

        # 2. 转 RGB（去除 alpha 通道 / 调色板，方便后续处理）
        if img.mode != "RGB":
            img = img.convert("RGB")

        w, h = img.size

        # 3. 裁剪白边：先缩放到小图快速检测 bbox，再按比例还原到原图坐标
        #    避免 5000x5000 大图做 point() 极慢
        if w > _BBOX_DETECT_MAX or h > _BBOX_DETECT_MAX:
            scale = _BBOX_DETECT_MAX / max(w, h)
            small = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        else:
            small = img
            scale = 1.0

        gray = small.convert("L")
        # 阈值 _WHITE_THRESH：接近白色视为背景；非白即内容
        bbox = gray.point(lambda x: 0 if x > _WHITE_THRESH else 255).getbbox()

        if bbox:
            # 把小图 bbox 坐标按比例还原到原图
            left = max(0, int(bbox[0] / scale) - _MIN_KEEP_MARGIN)
            upper = max(0, int(bbox[1] / scale) - _MIN_KEEP_MARGIN)
            right = min(w, int(bbox[2] / scale) + _MIN_KEEP_MARGIN)
            lower = min(h, int(bbox[3] / scale) + _MIN_KEEP_MARGIN)
            # 仅当确实裁掉一定边距时才 crop（避免无意义 crop 开销）
            if (left > 2 or upper > 2 or right < w - 2 or lower < h - 2):
                img = img.crop((left, upper, right, lower))

        # 4. 降采样：最长边超过 _MAX_OUTPUT_EDGE 时按比例缩小（节省 OCR 上传带宽）
        w2, h2 = img.size
        if max(w2, h2) > _MAX_OUTPUT_EDGE:
            ratio = _MAX_OUTPUT_EDGE / max(w2, h2)
            img = img.resize((max(1, int(w2 * ratio)), max(1, int(h2 * ratio))), Image.LANCZOS)

        # 5. 输出处理后的图片 bytes + base64 预览
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=92)
        processed = buf.getvalue()
        b64_preview = base64.b64encode(processed).decode()
        return processed, b64_preview
    except Exception:
        # PIL 不可用或处理失败，返回原始内容
        b64_preview = base64.b64encode(content).decode()
        return content, b64_preview


# ============ PDF 预处理：渲染为高 DPI 图片 → 旋转 + 裁白边 ============
def render_pdf_to_image(content: bytes, dpi: int = 200) -> tuple[bytes, str] | None:
    """用 PyMuPDF 把 PDF 渲染为图片，多页竖向拼接成一张长图。

    返回: (JPEG bytes, base64 预览) 或 None（PyMuPDF 不可用或渲染失败）
    dpi: 渲染分辨率，200 DPI 对扫描件足够清晰
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return None
    try:
        doc = fitz.open(stream=content, filetype="pdf")
        if doc.page_count == 0:
            doc.close()
            return None

        # 渲染每页为 PIL.Image，按比例渲染
        zoom = dpi / 72.0  # PDF 默认 72 DPI
        mat = fitz.Matrix(zoom, zoom)

        page_images = []
        for page in doc:
            # alpha=False 生成 RGB（白底），避免透明背景
            pix = page.get_pixmap(matrix=mat, alpha=False)
            img_bytes = pix.tobytes("png")
            from PIL import Image as _PILImage
            page_img = _PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
            page_images.append(page_img)
        doc.close()

        if not page_images:
            return None

        # 多页竖向拼接（间距 10px 白色，避免跨页内容粘连）
        if len(page_images) == 1:
            combined = page_images[0]
        else:
            from PIL import Image as _PILImage
            total_w = max(im.width for im in page_images)
            total_h = sum(im.height for im in page_images) + 10 * (len(page_images) - 1)
            combined = _PILImage.new("RGB", (total_w, total_h), (255, 255, 255))
            y = 0
            for im in page_images:
                combined.paste(im, (0, y))
                y += im.height + 10

        # 对拼接图应用同样的白边裁剪（PDF 页面常带扫描白边）
        gray = combined.convert("L")
        bbox = gray.point(lambda x: 0 if x > _WHITE_THRESH else 255).getbbox()
        if bbox:
            left, upper, right, lower = bbox
            left = max(0, left - _MIN_KEEP_MARGIN)
            upper = max(0, upper - _MIN_KEEP_MARGIN)
            right = min(combined.width, right + _MIN_KEEP_MARGIN)
            lower = min(combined.height, lower + _MIN_KEEP_MARGIN)
            if (left > 2 or upper > 2 or right < combined.width - 2 or lower < combined.height - 2):
                combined = combined.crop((left, upper, right, lower))

        # 限制最大尺寸（多页 PDF 拼接后可能非常大）
        w, h = combined.size
        if max(w, h) > _MAX_OUTPUT_EDGE:
            from PIL import Image as _PILImg2
            ratio = _MAX_OUTPUT_EDGE / max(w, h)
            combined = combined.resize((max(1, int(w * ratio)), max(1, int(h * ratio))), _PILImg2.LANCZOS)

        buf = io.BytesIO()
        combined.save(buf, format="JPEG", quality=92)
        processed = buf.getvalue()
        b64 = base64.b64encode(processed).decode()
        return processed, b64
    except Exception:
        return None


# ============ MarkItDown 提取（Office 文档） ============
def _extract_with_markitdown(content: bytes, filename: str) -> str:
    """用 MarkItDown 把 PDF/Office/HTML 转成 markdown 文本。"""
    try:
        from markitdown import MarkItDown
    except ImportError as e:
        raise RuntimeError("未安装 markitdown，请执行: pip install 'markitdown[pdf]'") from e

    md = MarkItDown()
    # MarkItDown 需要文件流 + 扩展名提示
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ".pdf"
    stream = io.BytesIO(content)
    result = md.convert_stream(stream, file_extension=ext)
    text = (result.text_content or "").strip()
    return text


# ============ Vision OCR（图片） ============
async def ocr_image_bytes(content: bytes) -> str:
    """调用 Vision LLM 识别图片中的全部文字，返回纯文本。"""
    if not settings.vision_api_key:
        raise RuntimeError("未配置 Vision API，无法 OCR 图片（请在设置中填写 API Key）")

    b64_img = base64.b64encode(content).decode()
    url = settings.vision_api_base.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.vision_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": settings.vision_model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "请识别这张图片中的所有文字，并以纯文本形式返回。"
                        "不要添加任何解释、翻译或格式标记，只输出识别到的原始文字内容。"
                        "\n\n重要：如果图片是护照/证件，请特别注意识别底部MRZ区域（两行由大写字母、数字和'<', '<<'符号组成的行），"
                        "必须准确识别所有'<'符号（单尖括号和连续尖括号'<<<'），这些符号用于分隔姓名等字段。"
                        "MRZ行通常以字母'P'开头（护照），格式类似：P<COUNTRY<SURNAME<<GIVEN<NAME<<<<<<...",
                    },
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"}},
                ],
            }
        ],
        "temperature": 0.1,
    }
    async with httpx.AsyncClient(timeout=90.0, trust_env=False) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        text = (data["choices"][0]["message"]["content"] or "").strip()
        if not text:
            raise RuntimeError("OCR 未识别到文字")
        return text


# ============ MRZ 解析（护照机器可读区） ============
def _normalize_for_compare(s: str) -> str:
    """归一化字符串用于比较：去空格、转大写、去除多余符号。"""
    import re as _re_norm
    s = s.upper().strip()
    s = _re_norm.sub(r'[\s\-_/]+', '', s)
    return s


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

    # 把所有连续的非字母数字<的字符作为行分隔
    lines = [l.strip() for l in cleaned.split("\n") if l.strip()]

    # 在所有行中找MRZ第一行：包含 << 且以P开头
    mrz_line1 = None
    mrz_line2 = None
    for i, line in enumerate(lines):
        if line.startswith("P") and "<<" in line and len(line) >= 20:
            mrz_line1 = line
            # 在接下来的1-2行中找MRZ第二行
            for j in range(i + 1, min(i + 3, len(lines))):
                cand = lines[j]
                # MRZ第二行特征：全是大写字母/数字/<，长度>=30，包含F/M性别标记，有6位数字日期
                if (len(cand) >= 30 and _re.match(r'^[A-Z0-9<]+$', cand)
                        and ("F" in cand or "M" in cand)
                        and _re.search(r'\d{6}', cand)):
                    mrz_line2 = cand
                    break
            break

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

    pre_sep = line1[1:sep_idx]  # 跳过开头P，得到P到<<之间的内容

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
        # 回退策略1：在pre_sep中寻找最后一个<，<后面的字母就是surname
        last_lt = pre_sep.rfind("<")
        if last_lt >= 0:
            after_lt = pre_sep[last_lt + 1:]
            sur_match = _re.match(r'[A-Z]+', after_lt)
            if sur_match:
                surname_part = sur_match.group(0)

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
    given_part = given_part.rstrip("<")
    given_name = given_part.replace("<", " ").strip()
    surname = surname_part.strip()

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

        # 出生日期：YYMMDD 格式（在性别F/M前面的6位数字）
        # 找F或M的位置，前面6位是出生日期（中间隔1位检查位）
        sex_match = _re.search(r'[FM]', line2)
        if sex_match:
            sex_pos = sex_match.start()
            sex_char = sex_match.group(0)
            result["gender"] = sex_char
            # MRZ第二行格式：...出生日期(6位)检查位(1位)性别(1位)有效期(6位)检查位(1位)...
            # 出生日期在性别前：向前数7个位置取6位（跳过检查位）
            if sex_pos >= 7:
                birth_str = line2[sex_pos - 7:sex_pos - 1]
                if _re.match(r'^\d{6}$', birth_str):
                    byy = birth_str[:2]
                    bmm = birth_str[2:4]
                    bdd = birth_str[4:6]
                    byy_int = int(byy)
                    year_prefix = 19 if byy_int > 30 else 20
                    result["birth_date"] = f"{year_prefix}{byy}-{bmm}-{bdd}"

            # 有效期：性别后面直接是6位YYMMDD（后面是检查位）
            if sex_pos + 7 <= len(line2):
                expiry_str = line2[sex_pos + 1:sex_pos + 7]
                if _re.match(r'^\d{6}$', expiry_str):
                    eyy = expiry_str[:2]
                    emm = expiry_str[2:4]
                    edd = expiry_str[4:6]
                    result["passport_expiry"] = f"20{eyy}-{emm}-{edd}"

    return result


# ============ 字段结构化（从全文中提取目标字段） ============
def _build_fields_prompt(text: str, target_fields: list[str]) -> str:
    fields_desc = "、".join(target_fields)
    # 截断超长文本，避免超出上下文
    snippet = text[:6000]
    return f"""以下是一份文档（证件/表单/网页截图）中提取出的文字内容：

---
{snippet}
---

请从上述文字中提取以下字段的值：{fields_desc}

要求：
1. 严格以 JSON 对象返回，key 为字段名，value 为文档中对应的值（字符串）
2. 文档中找不到的字段返回空字符串 ""
3. 日期统一为 YYYY-MM-DD 格式
4. 不要输出任何 JSON 以外的内容
5. 如果是护照/证件，底部MRZ行（以P开头的那行，如 P<RUS<BYSTROVA<<ANNA<PAVLOVNA<<<...）中'<<'分隔的英文姓名也视为有效姓名来源：
   - surname（姓）：第一个<<之前的字母，如BYSTROVA
   - given_name（名）：第一个<<之后到行尾的字母，多个<分隔的部分都是名，如ANNA PAVLOVNA
   - name：姓 + 名的完整组合
"""


def _parse_json_fields(text: str) -> dict[str, str]:
    if not text:
        return {}
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return {}
    try:
        data = json.loads(m.group(0))
        return {str(k): str(v).strip() for k, v in data.items()}
    except Exception:
        return {}


async def extract_fields_from_text(text: str, target_fields: list[str]) -> dict[str, str]:
    """用 Vision LLM 从文档全文中提取目标字段（结构化 JSON）。"""
    if not target_fields:
        return {}
    if not settings.vision_api_key:
        return {f: "" for f in target_fields}

    url = settings.vision_api_base.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.vision_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": settings.vision_model,
        "messages": [{"role": "user", "content": _build_fields_prompt(text, target_fields)}],
        "temperature": 0.1,
    }
    try:
        async with httpx.AsyncClient(timeout=60.0, trust_env=False) as client:
            resp = await client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"] or ""
            return _parse_json_fields(content)
    except Exception:
        return {f: "" for f in target_fields}


# ============ 统一入口 ============
async def preview_document(content: bytes, filename: str) -> dict:
    """仅生成源文件预览图（不跑 OCR、不做字段提取，极快）。

    用途：网页下载后先显示文件预览，用户点「录入提取」再跑完整 OCR。
    返回: { filename, method, processed_image, text_preview? }
    method: "image" | "pdf_render" | "markitdown_text"
    processed_image: base64 JPEG 预览图（图片/PDF 有值）
    """
    processed_image: str | None = None
    method: str = ""
    text_preview: str | None = None

    if is_image_file(filename):
        # 图片：仅做预处理（EXIF 旋转 + 裁白边 + 降采样），不 OCR
        _, processed_image = preprocess_image(content)
        method = "image"

    elif is_pdf_file(filename):
        # PDF：先尝试 MarkItDown 提取文字层（原生 PDF 可快速得到文本预览）
        try:
            text = _extract_with_markitdown(content, filename)
        except Exception:
            text = ""
        if text and len(text.strip()) >= 10:
            text_preview = text[:2000]  # 仅返回前 2000 字符预览
            method = "markitdown_text"
        # 同时渲染首页为预览图（无论有无文字层，都给用户一个可视化预览）
        rendered = render_pdf_to_image(content, dpi=150)  # 预览用稍低 DPI 更快
        if rendered is not None:
            _, processed_image = rendered
        if not method:
            method = "pdf_render"
    else:
        # Office 文档：用 MarkItDown 快速取文本预览，无图像
        try:
            text = _extract_with_markitdown(content, filename)
            if text:
                text_preview = text[:2000]
                method = "markitdown_text"
        except Exception:
            pass
        if not method:
            method = "unknown"

    return {
        "filename": filename,
        "method": method,
        "processed_image": processed_image,
        "text_preview": text_preview,
    }


async def extract_document(content: bytes, filename: str, target_fields: list[str] | None = None) -> dict:
    """提取文档文字 + 可选的字段结构化。

    返回: { filename, method, text, fields, processed_image }
    method: "markitdown" | "vision_ocr" | "pdf_ocr"
    processed_image: base64 编码的预处理后图片预览（图片/PDF 有值）
    """
    processed_image: str | None = None
    text: str = ""
    method: str = ""

    if is_image_file(filename):
        # === 图片：预处理（EXIF 旋转 + 裁白边 + 降采样）→ Vision OCR ===
        content, processed_image = preprocess_image(content)
        text = await ocr_image_bytes(content)
        method = "vision_ocr"

    elif is_pdf_file(filename):
        # === PDF：先试 MarkItDown 提取文字层（原生数字 PDF 最快） ===
        # === 无文字层（扫描件）→ PyMuPDF 渲染为图片 → 预处理 → Vision OCR ===
        try:
            text = _extract_with_markitdown(content, filename)
        except Exception:
            text = ""
        if text and len(text.strip()) >= 10:
            # 文字层有效，直接用
            method = "markitdown"
        else:
            # 文字层为空或太短 → 扫描件 → 渲染为图片走 OCR
            rendered = render_pdf_to_image(content, dpi=200)
            if rendered is None:
                # PyMuPDF 不可用，回退提示
                if not text:
                    raise RuntimeError(
                        "PDF 无文字层且 PyMuPDF 不可用，无法 OCR 扫描件（请安装 PyMuPDF）"
                    )
                method = "markitdown"
            else:
                content, processed_image = rendered
                text = await ocr_image_bytes(content)
                method = "pdf_ocr"
    else:
        # === 其他文档（docx/pptx/xlsx/html）→ MarkItDown ===
        text = _extract_with_markitdown(content, filename)
        method = "markitdown"
        if not text:
            raise RuntimeError("MarkItDown 未提取到文字")

    fields: dict[str, str] = {}
    mrz_warnings: list[str] = []
    mrz_fields: dict[str, str] = {}

    # 策略：MRZ优先（护照图片）。先尝试MRZ解析，覆盖到的字段直接用MRZ值，
    # 仅对MRZ未覆盖的目标字段才调用LLM字段提取，减少LLM调用次数、提升速度。
    if target_fields and method in ("vision_ocr", "pdf_ocr"):
        try:
            mrz_fields = _parse_mrz(text)
        except Exception:
            mrz_fields = {}

    if target_fields:
        # 计算MRZ已覆盖的字段（有值即算覆盖）
        mrz_primary_fields = {"surname", "given_name", "name", "passport_no", "birth_date", "gender", "nationality", "passport_expiry"}
        mrz_covered = {k for k in target_fields if mrz_fields.get(k, "").strip()}
        fields_for_llm = [k for k in target_fields if k not in mrz_covered]

        # MRZ主字段直接填入
        for k in target_fields:
            if k in mrz_primary_fields and mrz_fields.get(k, "").strip():
                fields[k] = mrz_fields[k]

        # 仅对MRZ未覆盖的字段调用LLM提取
        if fields_for_llm:
            llm_fields = await extract_fields_from_text(text, fields_for_llm)
            for k, v in llm_fields.items():
                if v.strip():
                    # MRZ主字段已存在时以MRZ为准；非主字段或MRZ为空时用LLM值
                    if k in mrz_primary_fields and fields.get(k, "").strip():
                        # MRZ有值且LLM也有值但不一致，记录警告
                        if _normalize_for_compare(v) != _normalize_for_compare(fields[k]):
                            mrz_warnings.append(f"{k}: 上方识别为「{v}」，MRZ识别为「{fields[k]}」，已以MRZ为准")
                    else:
                        fields[k] = v

        # MRZ非主字段（如passport_expiry等扩展字段）补充
        for k, v in mrz_fields.items():
            if v.strip() and not fields.get(k, "").strip():
                fields[k] = v

    elif not target_fields and method in ("vision_ocr", "pdf_ocr"):
        # 没指定target_fields时也尝试MRZ，存入fields供参考
        for k, v in mrz_fields.items():
            if v.strip():
                fields[k] = v

    return {
        "filename": filename,
        "method": method,
        "text": text,
        "fields": fields,
        "mrz_warnings": mrz_warnings,
        "processed_image": processed_image,
    }
