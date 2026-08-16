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

const PHONE_FIELD_RE = /phone|tel|mobile|contact.*number|guardian.*phone/;
const DATE_FIELD_RE = /date|dob|birth|issue|expiry|expire/;
const EMAIL_FIELD_RE = /email|mail/;

/** 电话归一化：去非数字 → 国家码前缀等价处理（取核心10-11位） */
export function normalizePhone(value: string): string {
  let digits = (value || "").replace(/\D/g, "");
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
  const v = (value || "").trim();
  if (!v) return false;
  const digits = v.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  // 必须几乎全是电话字符：数字、空格、+、-、(、)、.
  return /^[\d\s+\-().]+$/.test(v);
}

/** 判断两个值都像证件号形态：以数字为主（6+位数字），其余字符不超过 30% */
export function looksLikePassportNo(a: string, b: string): boolean {
  const both = [a, b];
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

/** 通用文本归一化：压缩空白 + 小写 */
export function normalizeText(value: string): string {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 格式等价判断：两个值在语义上是否相等（允许格式差异）。
 * field 用于类型提示（可为空字符串，此时按值形态自动推断）。
 */
export function valuesEquivalent(field: string, a: string, b: string): boolean {
  const va = (a || "").trim();
  const vb = (b || "").trim();

  // 护照号/证件号/学号：先校验（含等值情况——双方相同但都含非数字噪声 → 错值）
  // 排除日期：passport_expiry/passport_issue 字段名含 passport 但值是日期；
  // 且 looksLikePassportNo 会把 YYYY-MM-DD（8位数字/10字符=80%）误判为证件号形态
  // 两层排除：字段名含 date 相关关键字（passport_expiry/birth_date）+ 值形态是日期（2008-07-17）
  const PASSPORT_FIELD_RE = /passport|passnum|pass_no|pass no|护照|证件号|学号|id_no|student_id|idnum/i;
  const isDateField = fieldMatches(field, DATE_FIELD_RE);
  const bothDates = looksLikeDate(va) && looksLikeDate(vb);
  if ((fieldMatches(field, PASSPORT_FIELD_RE) || looksLikePassportNo(va, vb)) && !isDateField && !bothDates) {
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
