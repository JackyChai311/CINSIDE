/**
 * 格式等价比对模块（Format Equivalence Skill）
 *
 * 专门处理"语义相同但格式不同"的比对场景，避免把纯格式差异误判为错误：
 *   电话: "+7 926 768 21 74" = "7 (926) 768-21-74" = "89267682174"
 *   日期: "2008/11/12" = "2008-11-12" = "12.11.2008" = "2008年11月12日"
 *   邮箱: "A@Gmail.com" = "a@gmail.com"
 *   姓名: "Sofia  Kochukova" = "sofia kochukova"
 */

/** 判断字段名是否属于某类型 */
function fieldMatches(field: string, patterns: RegExp): boolean {
  return patterns.test((field || "").toLowerCase());
}

const PHONE_FIELD_RE = /phone|tel|mobile|contact.*number|guardian.*phone|手机|电话/;
const DATE_FIELD_RE = /date|dob|birth|issue|expiry|expire|日期/;
const EMAIL_FIELD_RE = /email|mail|邮箱|邮件/;
const NAME_FIELD_RE = /name|姓名|名字/;
const NATIONALITY_FIELD_RE = /nationality|citizenship|citizen|国籍/;

/** 不可见字符：零宽空格/连接符/方向控制符/字节序标记
 *  （网页常用 U+200E 等包裹电话号码保持排版，视觉与正常文本完全一样，但会让字符串比对假不一致） */
const INVISIBLE_CHARS_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** 全角转半角：全角数字/字母/符号（U+FF01-FF5E）转 ASCII，全角空格（U+3000）转普通空格 */
export function toHalfwidth(s: string): string {
  return (s || "").replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");
}

/** 比对前清洗：去不可见字符 + 全角转半角（不改变可见内容，只消除网页排版噪声） */
function cleanComparable(value: string): string {
  return toHalfwidth((value || "").replace(INVISIBLE_CHARS_RE, ""));
}

/** 电话归一化：去非数字 → 国家码前缀等价处理（取核心10-11位） */
export function normalizePhone(value: string): string {
  let digits = cleanComparable(value).replace(/\D/g, "");
  if (!digits) return "";
  // 处理国际前缀 00：0079... → 79...
  if (digits.startsWith("00")) digits = digits.slice(2);
  // 俄罗斯号码习惯：7/8 互换（+7 926... = 8926...），核心取后10位
  // 中国 +86：8613xxxxxxxxx → 13xxxxxxxxx
  if (digits.startsWith("86") && digits.length === 13) return digits.slice(2);
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    return digits.slice(1); // 后10位
  }
  if (digits.length > 11) return digits.slice(-10);
  return digits;
}

/** 判断值是否长得像电话（>=7位数字且含电话字符） */
export function looksLikePhone(value: string): boolean {
  const v = cleanComparable(value).trim();
  if (!v) return false;
  const digits = v.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  // 必须几乎全是电话字符：数字、空格、+、-、(、)、.
  return /^[\d\s+\-().]+$/.test(v);
}

/** 判断两个值都像证件号形态：以数字为主（6+位数字），其余字符不超过 30% */
export function looksLikePassportNo(a: string, b: string): boolean {
  const both = [cleanComparable(a), cleanComparable(b)];
  for (const v of both) {
    const digits = v.replace(/\D/g, "").length;
    if (digits < 6) return false;
    if (digits < v.length * 0.7) return false; // 数字占比 < 70% 不像证件号
  }
  return true;
}

/** 日期解析：返回所有可能的 YYYY-MM-DD 候选（歧义日期多种解释） */
export function parseDateCandidates(value: string): string[] {
  const s = (value || "").trim();
  if (!s) return [];
  const out = new Set<string>();
  const pad = (n: string | number) => String(n).padStart(2, "0");
  const push = (y: number, m: number, d: number) => {
    if (y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      out.add(`${y}-${pad(m)}-${pad(d)}`);
    }
  };

  // 中文格式：2008年11月12日
  let m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (m) push(+m[1], +m[2], +m[3]);

  // ISO 类：2008-11-12 / 2008/11/12 / 2008.11.12（年在前面无歧义）
  m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) push(+m[1], +m[2], +m[3]);

  // 日在前或月在前：12.11.2008 / 11/12/2008
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    if (a > 12) {
      push(y, b, a); // 必为 日-月-年
    } else if (b > 12) {
      push(y, a, b); // 必为 月-日-年
    } else {
      push(y, b, a); // 歧义：两种都算候选
      push(y, a, b);
    }
  }

  // 英文月份：12 Mar 2008 / March 12, 2008
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  m = s.match(/(\d{1,2})[-\s]?([A-Za-z]{3,9})[-\s,]?(\d{4})/);
  if (m) {
    const mon = months[m[2].slice(0, 3).toLowerCase()];
    if (mon) push(+m[3], mon, +m[1]);
  }
  m = s.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const mon = months[m[1].slice(0, 3).toLowerCase()];
    if (mon) push(+m[3], mon, +m[2]);
  }

  return Array.from(out);
}

/** 判断值是否长得像日期 */
export function looksLikeDate(value: string): boolean {
  return parseDateCandidates(value).length > 0;
}

/** 通用文本归一化：去不可见字符 + 全角转半角 + 压缩空白 + 小写 */
export function normalizeText(value: string): string {
  return cleanComparable(value).replace(/\s+/g, " ").trim().toLowerCase();
}

/** 国籍别名组：同一国家的三字码/英文国名/国籍形容词/中文名（组首=三字码，作归一锚点）。
 *  比对常识：RUS = RUSSIA = RUSSIAN = 俄罗斯，同理其他国家。 */
const NATIONALITY_GROUPS: string[][] = [
  ["rus", "russia", "russian", "russian federation", "俄罗斯"],
  ["chn", "china", "chinese", "中国"],
  ["usa", "united states", "united states of america", "american", "america", "us", "u s", "美国"],
  ["gbr", "united kingdom", "british", "britain", "great britain", "uk", "u k", "english", "英国"],
  ["ukr", "ukraine", "ukrainian", "乌克兰"],
  ["blr", "belarus", "belarusian", "白俄罗斯"],
  ["kaz", "kazakhstan", "kazakh", "kazakhstani", "哈萨克", "哈萨克斯坦"],
  ["uzb", "uzbekistan", "uzbek", "乌兹别克", "乌兹别克斯坦"],
  ["kgz", "kyrgyzstan", "kyrgyz", "吉尔吉斯", "吉尔吉斯斯坦"],
  ["tjk", "tajikistan", "tajik", "塔吉克", "塔吉克斯坦"],
  ["tkm", "turkmenistan", "turkmen", "土库曼", "土库曼斯坦"],
  ["aze", "azerbaijan", "azerbaijani", "阿塞拜疆"],
  ["arm", "armenia", "armenian", "亚美尼亚"],
  ["geo", "georgia", "georgian", "格鲁吉亚"],
  ["mda", "moldova", "moldovan", "摩尔多瓦"],
  ["jpn", "japan", "japanese", "日本"],
  ["kor", "south korea", "republic of korea", "korea", "korean", "韩国"],
  ["prk", "north korea", "north korean", "dprk", "朝鲜"],
  ["mng", "mongolia", "mongolian", "蒙古"],
  ["ind", "india", "indian", "印度"],
  ["idn", "indonesia", "indonesian", "印度尼西亚", "印尼"],
  ["mys", "malaysia", "malaysian", "马来西亚"],
  ["sgp", "singapore", "singaporean", "新加坡"],
  ["tha", "thailand", "thai", "泰国"],
  ["vnm", "vietnam", "viet nam", "vietnamese", "越南"],
  ["phl", "philippines", "filipino", "philippine", "菲律宾"],
  ["mmr", "myanmar", "burma", "burmese", "缅甸"],
  ["khm", "cambodia", "cambodian", "柬埔寨"],
  ["lao", "laos", "laotian", "老挝"],
  ["pak", "pakistan", "pakistani", "巴基斯坦"],
  ["bgd", "bangladesh", "bangladeshi", "孟加拉国"],
  ["lka", "sri lanka", "sri lankan", "斯里兰卡"],
  ["npl", "nepal", "nepali", "nepalese", "尼泊尔"],
  ["afg", "afghanistan", "afghan", "阿富汗"],
  ["irn", "iran", "iranian", "伊朗"],
  ["irq", "iraq", "iraqi", "伊拉克"],
  ["tur", "turkey", "turkish", "土耳其"],
  ["sau", "saudi arabia", "saudi", "沙特", "沙特阿拉伯"],
  ["are", "united arab emirates", "uae", "u a e", "emirati", "阿联酋"],
  ["isr", "israel", "israeli", "以色列"],
  ["egy", "egypt", "egyptian", "埃及"],
  ["nga", "nigeria", "nigerian", "尼日利亚"],
  ["zaf", "south africa", "south african", "南非"],
  ["ken", "kenya", "kenyan", "肯尼亚"],
  ["deu", "germany", "german", "deutschland", "德国"],
  ["fra", "france", "french", "法国"],
  ["ita", "italy", "italian", "意大利"],
  ["esp", "spain", "spanish", "西班牙"],
  ["prt", "portugal", "portuguese", "葡萄牙"],
  ["nld", "netherlands", "dutch", "holland", "荷兰"],
  ["bel", "belgium", "belgian", "比利时"],
  ["che", "switzerland", "swiss", "瑞士"],
  ["aut", "austria", "austrian", "奥地利"],
  ["pol", "poland", "polish", "波兰"],
  ["cze", "czech republic", "czechia", "czech", "捷克"],
  ["svk", "slovakia", "slovak", "斯洛伐克"],
  ["hun", "hungary", "hungarian", "匈牙利"],
  ["rou", "romania", "romanian", "罗马尼亚"],
  ["bgr", "bulgaria", "bulgarian", "保加利亚"],
  ["grc", "greece", "greek", "希腊"],
  ["srb", "serbia", "serbian", "塞尔维亚"],
  ["hrv", "croatia", "croatian", "克罗地亚"],
  ["swe", "sweden", "swedish", "瑞典"],
  ["nor", "norway", "norwegian", "挪威"],
  ["dnk", "denmark", "danish", "丹麦"],
  ["fin", "finland", "finnish", "芬兰"],
  ["irl", "ireland", "irish", "爱尔兰"],
  ["est", "estonia", "estonian", "爱沙尼亚"],
  ["lva", "latvia", "latvian", "拉脱维亚"],
  ["ltu", "lithuania", "lithuanian", "立陶宛"],
  ["can", "canada", "canadian", "加拿大"],
  ["mex", "mexico", "mexican", "墨西哥"],
  ["bra", "brazil", "brazilian", "巴西"],
  ["arg", "argentina", "argentine", "argentinian", "阿根廷"],
  ["col", "colombia", "colombian", "哥伦比亚"],
  ["per", "peru", "peruvian", "秘鲁"],
  ["chl", "chile", "chilean", "智利"],
  ["cub", "cuba", "cuban", "古巴"],
  ["ven", "venezuela", "venezuelan", "委内瑞拉"],
  ["aus", "australia", "australian", "澳大利亚"],
  ["nzl", "new zealand", "new zealander", "新西兰"],
  ["twn", "taiwan", "taiwanese", "台湾"],
  ["hkg", "hong kong", "香港"],
];

/** 国籍归一：识别为已知国家 → 返回三字码锚点；认不出 → 返回 ""（走通用文本比对兜底） */
export function normalizeNationality(value: string): string {
  const v = normalizeText(value).replace(/[.,;]+$/, "").trim();
  if (!v) return "";
  for (const group of NATIONALITY_GROUPS) {
    if (group.includes(v)) return group[0];
  }
  return "";
}

/**
 * 格式等价判断：两个值在语义上是否相等（允许格式差异）。
 * field 用于类型提示（可为空字符串，此时按值形态自动推断）。
 */
export function valuesEquivalent(field: string, a: string, b: string): boolean {
  const va = cleanComparable(a).trim();
  const vb = cleanComparable(b).trim();

  // 护照号/证件号/学号：先校验（含等值情况——双方相同但都含非数字噪声 → 错值）
  // 排除日期：passport_expiry/passport_issue 字段名含 passport 但值是日期；
  // 且 looksLikePassportNo 会把 YYYY-MM-DD（8位数字/10字符=80%）误判为证件号形态
  // 两层排除：字段名含 date 相关关键字（passport_expiry/birth_date）+ 值形态是日期（2008-07-17）
  // 再排除电话形态：+79005674322 这类带 + 的电话同样满足证件号形态（11位数字/91%占比），
  // 进入证件号分支会被「同值含非数字噪声 → 错值」规则误杀（+ 被当噪声）；显式证件字段不受此豁免
  const PASSPORT_FIELD_RE = /passport|passnum|pass_no|pass no|护照|证件号|学号|id_no|student_id|idnum/i;
  const isDateField = fieldMatches(field, DATE_FIELD_RE);
  const bothDates = looksLikeDate(va) && looksLikeDate(vb);
  const isPassField = fieldMatches(field, PASSPORT_FIELD_RE);
  const phoneish = !isPassField && (fieldMatches(field, PHONE_FIELD_RE) || (looksLikePhone(va) && looksLikePhone(vb)));
  if ((isPassField || looksLikePassportNo(va, vb)) && !isDateField && !bothDates && !phoneish) {
    if (va === vb) {
      // 双方相同但都含非数字噪声（如 67NO0906781）→ 视为错值（OCR/Excel 同源噪声）
      return va === va.replace(/\D/g, "");
    }
    if (!va || !vb) return false;
    const vaPure = /^\d+$/.test(va);
    const vbPure = /^\d+$/.test(vb);
    if (vaPure && vbPure) return va === vb;
    // 一方纯数字、一方含非数字 → 错值（如 0→O、3→NO 噪声），不等价
    if (vaPure !== vbPure) return false;
    // 双方都含非数字：直接比较（忽略大小写）
    return va.toLowerCase() === vb.toLowerCase();
  }

  if (va === vb) return true;
  if (!va || !vb) return false;

  // 1. 电话等价（字段提示或形态推断；排除日期形态如 12.11.2008，它也含数字和点）
  if (fieldMatches(field, PHONE_FIELD_RE) || (looksLikePhone(va) && looksLikePhone(vb) && !looksLikeDate(va) && !looksLikeDate(vb))) {
    const na = normalizePhone(va);
    const nb = normalizePhone(vb);
    if (na && nb) {
      if (na === nb) return true;
      // 一方是另一方的后缀（长短号、含/不含国家码）
      if (na.length >= 7 && nb.length >= 7 && (na.endsWith(nb) || nb.endsWith(na))) return true;
      return false;
    }
  }

  // 2. 日期等价（字段提示或形态推断）
  if (fieldMatches(field, DATE_FIELD_RE) || (looksLikeDate(va) && looksLikeDate(vb))) {
    const ca = parseDateCandidates(va);
    const cb = parseDateCandidates(vb);
    if (ca.length > 0 && cb.length > 0) {
      return ca.some((d) => cb.includes(d));
    }
  }

  // 3. 邮箱等价
  if (fieldMatches(field, EMAIL_FIELD_RE) || (va.includes("@") && vb.includes("@"))) {
    return va.toLowerCase() === vb.toLowerCase();
  }

  // 3.5 姓名等价：忽略全部空格差异（OCR 常丢/增空格，"LI NA" = "LINA"、"RUSKHAN  KRISTINA" = "RUSKHAN KRISTINA"），
  // 不限长度——短名字走通用文本的 <12 字符完全相等判据会被空格误伤
  if (fieldMatches(field, NAME_FIELD_RE)) {
    const na = normalizeText(va).replace(/\s+/g, "");
    const nb = normalizeText(vb).replace(/\s+/g, "");
    if (na && na === nb) return true;
  }

  // 3.6 国籍等价：三字码 = 英文国名 = 国籍形容词（RUS = RUSSIA = RUSSIAN = 俄罗斯），
  // 双方都识别为已知国家时按归一锚点比较；认不出的落回通用文本比对
  if (fieldMatches(field, NATIONALITY_FIELD_RE)) {
    const nna = normalizeNationality(va);
    const nnb = normalizeNationality(vb);
    if (nna && nnb) return nna === nnb;
  }

  // 4. 通用文本：压缩空白 + 忽略大小写 + 互相包含
  const na = normalizeText(va);
  const nb = normalizeText(vb);
  if (na === nb) return true;
  // 对于较短的字符串（如国家码、证件号、代码等），只接受完全相等；
  // 一方包含另一方容易误伤（例如 "RUSSIA" 被 "COUNTRY RUSSIA" 错误包含）。
  if (na.length < 12 || nb.length < 12) return false;
  const naCompact = na.replace(/\s+/g, "");
  const nbCompact = nb.replace(/\s+/g, "");
  return naCompact.includes(nbCompact) || nbCompact.includes(naCompact);
}

// ============ 文档提取方式标签 ============

/** 提取方式 → 用户可见的中文标签。
 *  ocrBackend：umi 通道实际引擎（"gpu"=内置加速引擎，"umi"=UMI-OCR），
 *  有值时标签如实显示 OCR（GPU）/ OCR（UMI）——GPU 兜底成 UMI 也标 UMI。 */
export function extractMethodLabel(method: string, ocrBackend?: string): string {
  const be = ocrBackend === "gpu" ? "GPU" : ocrBackend === "umi" ? "UMI" : "";
  switch (method) {
    case "vision_ocr":
      return "AI Vision";
    case "umi_ocr":
      return be ? `OCR（${be}）` : "OCR";
    case "pdf_ocr":
      return "AI Vision（PDF扫描件）";
    case "pdf_umi_ocr":
      return be ? `OCR（${be}·扫描件）` : "OCR（PDF扫描件）";
    case "markitdown":
      return "文档解析";
    default:
      return method || "未知";
  }
}

/** 是否为 OCR 类提取方式（图片/扫描件走 OCR 引擎） */
export function isOcrMethod(method: string): boolean {
  return method === "vision_ocr" || method === "umi_ocr"
    || method === "pdf_ocr" || method === "pdf_umi_ocr";
}

/** 是否为本地 UMI-OCR 引擎 */
export function isUmiMethod(method: string): boolean {
  return method === "umi_ocr" || method === "pdf_umi_ocr";
}

/** 是否为 Vision AI 引擎 */
export function isVisionMethod(method: string): boolean {
  return method === "vision_ocr" || method === "pdf_ocr";
}
