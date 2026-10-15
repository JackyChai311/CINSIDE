/**
 * formatNormalize 单元测试：锁定现有纯逻辑行为，不改变实现。
 */
import { describe, it, expect } from "vitest";
import {
  toHalfwidth,
  normalizePhone,
  looksLikePhone,
  looksLikePassportNo,
  parseDateCandidates,
  looksLikeDate,
  normalizeText,
  normalizeNationality,
  valuesEquivalent,
  extractMethodLabel,
  isOcrMethod,
  isUmiMethod,
  isVisionMethod,
} from "./formatNormalize";

describe("toHalfwidth", () => {
  it("把全角数字转成半角 ASCII", () => {
    expect(toHalfwidth("０１２３４５６７８９")).toBe("0123456789");
  });

  it("把全角字母转成半角 ASCII", () => {
    expect(toHalfwidth("ＡＢＣａｂｃ")).toBe("ABCabc");
  });

  it("把全角符号转成半角 ASCII", () => {
    expect(toHalfwidth("！＠＃＄％")).toBe("!@#$%");
  });

  it("覆盖 U+FF01 与 U+FF5E 两个区间边界", () => {
    expect(toHalfwidth("\uFF01")).toBe("!");
    expect(toHalfwidth("\uFF5E")).toBe("~");
    expect(toHalfwidth("～！")).toBe("~!");
  });

  it("把全角空格 U+3000 转成普通空格", () => {
    expect(toHalfwidth("　")).toBe(" ");
    expect(toHalfwidth("ａ　ｂ")).toBe("a b");
  });

  it("不动普通 ASCII 空白（Tab / 换行）", () => {
    expect(toHalfwidth("a\tb\nc")).toBe("a\tb\nc");
  });

  it("保留中文汉字与中文专属标点（U+3002 不在 FF01-FF5E 区间）", () => {
    expect(toHalfwidth("你好世界")).toBe("你好世界");
    expect(toHalfwidth("中文。测试")).toBe("中文。测试");
  });

  it("中文文本里的全角逗号（U+FF0C）按区间规则转成 ASCII 逗号", () => {
    expect(toHalfwidth("你好，世界")).toBe("你好,世界");
  });

  it("已是 ASCII 的字符串原样返回", () => {
    expect(toHalfwidth("Hello, World! 123")).toBe("Hello, World! 123");
  });

  it("空字符串返回空字符串", () => {
    expect(toHalfwidth("")).toBe("");
  });
});

describe("normalizePhone", () => {
  it("去掉所有非数字字符", () => {
    expect(normalizePhone("+7 926 768 21 74")).toBe("9267682174");
    expect(normalizePhone("7 (926) 768-21-74")).toBe("9267682174");
  });

  it("俄罗斯 7/8 前缀互换：11 位号码去掉首位", () => {
    expect(normalizePhone("89267682174")).toBe("9267682174");
    expect(normalizePhone("79267682174")).toBe("9267682174");
  });

  it("先剥离国际前缀 00", () => {
    expect(normalizePhone("007992676821 74")).toBe("9267682174");
  });

  it("中国 +86 的 13 位号码去掉国家码", () => {
    expect(normalizePhone("+86 138 0013 8000")).toBe("13800138000");
  });

  it("超过 11 位时取后 10 位", () => {
    expect(normalizePhone("1234567890123")).toBe("4567890123");
  });

  it("11 位但首位不是 7/8 时原样返回", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("15551234567");
  });

  it("10 位及更短的数字原样返回", () => {
    expect(normalizePhone("9267682174")).toBe("9267682174");
    expect(normalizePhone("12345")).toBe("12345");
  });

  it("先清除零宽/方向控制等不可见字符再归一", () => {
    expect(normalizePhone("\u200E+7 926 768 21 74\u200E")).toBe("9267682174");
    expect(normalizePhone("\uFEFF+7 926 768 21 74")).toBe("9267682174");
  });

  it("全角数字先转半角后参与归一", () => {
    expect(normalizePhone("８９２６７６８２１７４")).toBe("9267682174");
  });

  it("没有数字或空串返回空串", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone("abc")).toBe("");
    expect(normalizePhone("+()-. ")).toBe("");
  });

  it("只有 00 前缀时归一结果为空串", () => {
    expect(normalizePhone("00")).toBe("");
  });
});

describe("looksLikePhone", () => {
  it("纯数字或带分隔符的电话形态为 true", () => {
    expect(looksLikePhone("9267682174")).toBe(true);
    expect(looksLikePhone("+7 (926) 768-21-74")).toBe(true);
    expect(looksLikePhone("1 2 3 4 5 6 7")).toBe(true);
  });

  it("日期形态也返回 true（所以 valuesEquivalent 必须单独排除日期）", () => {
    expect(looksLikePhone("12.11.2008")).toBe(true);
  });

  it("数字不足 7 位或超过 15 位为 false", () => {
    expect(looksLikePhone("12345")).toBe(false);
    expect(looksLikePhone("1234567890123456")).toBe(false);
  });

  it("含字母等非电话字符为 false", () => {
    expect(looksLikePhone("abc1234567")).toBe(false);
  });

  it("空串或纯空白为 false", () => {
    expect(looksLikePhone("")).toBe(false);
    expect(looksLikePhone("   ")).toBe(false);
  });
});

describe("looksLikePassportNo", () => {
  it("双方都是 6 位以上、数字占比 >= 70% 时为 true", () => {
    expect(looksLikePassportNo("123456", "654321")).toBe(true);
    expect(looksLikePassportNo("AB1234567", "AB1234567")).toBe(true);
    expect(looksLikePassportNo("6712345678", "+79005674322")).toBe(true);
  });

  it("任一方数字少于 6 位为 false", () => {
    expect(looksLikePassportNo("12345", "123456")).toBe(false);
    expect(looksLikePassportNo("ABC123", "ABC123")).toBe(false);
    expect(looksLikePassportNo("", "123456")).toBe(false);
  });

  it("数字占比低于 70% 为 false", () => {
    expect(looksLikePassportNo("1234567abcdefgh", "1234567abcdefgh")).toBe(false);
  });

  it("全角数字先转半角后仍算数字", () => {
    expect(looksLikePassportNo("１２３４５６", "１２３４５６")).toBe(true);
  });
});

describe("parseDateCandidates", () => {
  it("中文日期格式", () => {
    expect(parseDateCandidates("2008年11月12日")).toEqual(["2008-11-12"]);
    expect(parseDateCandidates("2008年1月2日")).toEqual(["2008-01-02"]);
  });

  it("中文日期可出现在长文本中间（正则未锚定）", () => {
    expect(parseDateCandidates("出生日期：2008年11月12日")).toEqual(["2008-11-12"]);
  });

  it("年在前的 ISO 类格式无歧义", () => {
    expect(parseDateCandidates("2008-11-12")).toEqual(["2008-11-12"]);
    expect(parseDateCandidates("2008/11/12")).toEqual(["2008-11-12"]);
    expect(parseDateCandidates("2008.11.12")).toEqual(["2008-11-12"]);
  });

  it("日在前/月在前且都 <= 12 时给出两种候选（Set 插入顺序）", () => {
    expect(parseDateCandidates("12.11.2008")).toEqual(["2008-11-12", "2008-12-11"]);
  });

  it("第一段 > 12 时必为 日-月-年", () => {
    expect(parseDateCandidates("25.11.2008")).toEqual(["2008-11-25"]);
  });

  it("第二段 > 12 时必为 月-日-年", () => {
    expect(parseDateCandidates("11/25/2008")).toEqual(["2008-11-25"]);
  });

  it("英文月份：日 月 年", () => {
    expect(parseDateCandidates("12 Mar 2008")).toEqual(["2008-03-12"]);
    expect(parseDateCandidates("12 May 2008")).toEqual(["2008-05-12"]);
  });

  it("英文月份：月 日, 年", () => {
    expect(parseDateCandidates("March 12, 2008")).toEqual(["2008-03-12"]);
  });

  it("无法识别的英文月份词不产生候选", () => {
    expect(parseDateCandidates("12 Foo 2008")).toEqual([]);
  });

  it("年份/月份/日期越界时不产生候选", () => {
    expect(parseDateCandidates("1850-01-01")).toEqual([]);
    expect(parseDateCandidates("2008-13-01")).toEqual([]);
    expect(parseDateCandidates("2008-01-32")).toEqual([]);
  });

  it("空串与无法解析的文本返回空数组", () => {
    expect(parseDateCandidates("")).toEqual([]);
    expect(parseDateCandidates("   ")).toEqual([]);
    expect(parseDateCandidates("hello")).toEqual([]);
  });
});

describe("looksLikeDate", () => {
  it("能解析出候选即为 true", () => {
    expect(looksLikeDate("2008-11-12")).toBe(true);
    expect(looksLikeDate("12.11.2008")).toBe(true);
    expect(looksLikeDate("2008年11月12日")).toBe(true);
  });

  it("解析不出候选即为 false", () => {
    expect(looksLikeDate("")).toBe(false);
    expect(looksLikeDate("hello")).toBe(false);
    expect(looksLikeDate("12345")).toBe(false);
  });
});

describe("normalizeText", () => {
  it("压缩空白 + trim + 小写", () => {
    expect(normalizeText("  Hello   World  ")).toBe("hello world");
    expect(normalizeText("A\tB\nC")).toBe("a b c");
  });

  it("全角转半角后再小写", () => {
    expect(normalizeText("ＡＢＣ")).toBe("abc");
    expect(normalizeText("　全角　空格　")).toBe("全角 空格");
  });

  it("清除零宽等不可见字符", () => {
    expect(normalizeText("RUSKHAN\u200B  KRISTINA")).toBe("ruskhan kristina");
  });

  it("空串返回空串", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText("   ")).toBe("");
  });
});

describe("normalizeNationality", () => {
  it("同一国家的三字码/英文名/形容词/中文名归一为同一个锚点", () => {
    expect(normalizeNationality("RUS")).toBe("rus");
    expect(normalizeNationality("Russia")).toBe("rus");
    expect(normalizeNationality("RUSSIAN FEDERATION")).toBe("rus");
    expect(normalizeNationality("俄罗斯")).toBe("rus");
  });

  it("其它国家锚点", () => {
    expect(normalizeNationality("中国")).toBe("chn");
    expect(normalizeNationality("China")).toBe("chn");
    expect(normalizeNationality("Deutschland")).toBe("deu");
    expect(normalizeNationality("USA")).toBe("usa");
    expect(normalizeNationality("South Korea")).toBe("kor");
  });

  it("全角输入先转半角再识别", () => {
    expect(normalizeNationality("ＵＳＡ")).toBe("usa");
  });

  it("结尾的 . , ; 被清掉后再匹配", () => {
    expect(normalizeNationality("RUSSIA.")).toBe("rus");
    expect(normalizeNationality("china;")).toBe("chn");
  });

  it("认不出的值（含带点缩写的 U.S.A.）返回空串", () => {
    expect(normalizeNationality("Atlantis")).toBe("");
    expect(normalizeNationality("U.S.A.")).toBe("");
    expect(normalizeNationality("")).toBe("");
    expect(normalizeNationality("   ")).toBe("");
  });
});

describe("valuesEquivalent", () => {
  it("完全相同（trim 后）即等价", () => {
    expect(valuesEquivalent("", "abc", "abc")).toBe(true);
    expect(valuesEquivalent("", "  abc  ", "abc")).toBe(true);
    expect(valuesEquivalent("", "", "")).toBe(true);
  });

  it("一方为空、另一方非空不等价", () => {
    expect(valuesEquivalent("", "", "abc")).toBe(false);
    expect(valuesEquivalent("name", "", "LI NA")).toBe(false);
  });

  it("电话字段：不同写法的同一号码等价", () => {
    expect(valuesEquivalent("phone", "+7 926 768 21 74", "7 (926) 768-21-74")).toBe(true);
    expect(valuesEquivalent("phone", "+7 926 768 21 74", "8 926 768-21-74")).toBe(true);
    expect(valuesEquivalent("手机", "+86 138 0013 8000", "13800138000")).toBe(true);
  });

  it("无字段提示时按值形态推断电话等价", () => {
    expect(valuesEquivalent("", "9267682174", "89267682174")).toBe(true);
  });

  it("不同号码不等价", () => {
    expect(valuesEquivalent("phone", "+7 926 768 21 74", "+7 926 768 21 75")).toBe(false);
  });

  it("电话字段不会把日期值判成等价", () => {
    expect(valuesEquivalent("phone", "+7 926 768 21 74", "12.11.2008")).toBe(false);
  });

  it("日期字段：不同格式的同一日期等价（护照形态被日期字段名排除）", () => {
    expect(valuesEquivalent("birth_date", "2008/11/12", "2008-11-12")).toBe(true);
    expect(valuesEquivalent("dob", "12.11.2008", "2008年11月12日")).toBe(true);
  });

  it("日期字段：候选集合无交集时不等价", () => {
    expect(valuesEquivalent("dob", "01.02.2008", "05.06.2008")).toBe(false);
  });

  it("邮箱字段：忽略大小写", () => {
    expect(valuesEquivalent("email", "A@Gmail.com", "a@gmail.com")).toBe(true);
    expect(valuesEquivalent("邮箱", "a@x.com", "b@x.com")).toBe(false);
    expect(valuesEquivalent("", "A@Gmail.com", "a@gmail.com")).toBe(true);
  });

  it("姓名字段：忽略全部空格差异", () => {
    expect(valuesEquivalent("name", "LI NA", "LINA")).toBe(true);
    expect(valuesEquivalent("姓名", "Sofia  Kochukova", "sofia kochukova")).toBe(true);
    expect(valuesEquivalent("name", "LI NA", "LI NAN")).toBe(false);
  });

  it("国籍字段：三字码 = 英文国名 = 中文名", () => {
    expect(valuesEquivalent("nationality", "RUS", "Russian Federation")).toBe(true);
    expect(valuesEquivalent("nationality", "中国", "CHN")).toBe(true);
    expect(valuesEquivalent("nationality", "CHN", "俄罗斯")).toBe(false);
  });

  it("通用文本：忽略大小写与空白", () => {
    expect(valuesEquivalent("", "Hello", "hello")).toBe(true);
    expect(valuesEquivalent("", "Hello  World", "hello world")).toBe(true);
  });

  it("短字符串只接受完全相等（不做互相包含）", () => {
    expect(valuesEquivalent("", "RUSSIA", "COUNTRY RUSSIA")).toBe(false);
  });

  it("长字符串允许互相包含", () => {
    expect(valuesEquivalent("", "Please enter your full name here", "enter your full name")).toBe(true);
    expect(valuesEquivalent("", "Please enter your full name here", "enter your full address")).toBe(false);
  });

  it("证件号：双方相同但含非数字噪声时判为错值", () => {
    expect(valuesEquivalent("", "AB1234567", "AB1234567")).toBe(false);
  });

  it("证件号：纯数字相等即等价，数字噪声不一致则不等价", () => {
    expect(valuesEquivalent("passport_no", "1234567890", "1234567890")).toBe(true);
    expect(valuesEquivalent("passport_no", "1234567890", "1234567891")).toBe(false);
    expect(valuesEquivalent("passport_no", "1234567890", "123456789O")).toBe(false);
  });
});

describe("extractMethodLabel", () => {
  it("vision_ocr / pdf_ocr / markitdown 的固定标签", () => {
    expect(extractMethodLabel("vision_ocr")).toBe("AI Vision");
    expect(extractMethodLabel("pdf_ocr")).toBe("AI Vision（PDF扫描件）");
    expect(extractMethodLabel("markitdown")).toBe("文档解析");
  });

  it("umi_ocr 按已使用的 OCR 引擎显示", () => {
    expect(extractMethodLabel("umi_ocr")).toBe("OCR");
    expect(extractMethodLabel("umi_ocr", "gpu")).toBe("OCR（GPU）");
    expect(extractMethodLabel("umi_ocr", "umi")).toBe("OCR（UMI）");
    expect(extractMethodLabel("umi_ocr", "other")).toBe("OCR");
  });

  it("pdf_umi_ocr 按已使用的 OCR 引擎显示扫描件标签", () => {
    expect(extractMethodLabel("pdf_umi_ocr")).toBe("OCR（PDF扫描件）");
    expect(extractMethodLabel("pdf_umi_ocr", "gpu")).toBe("OCR（GPU·扫描件）");
    expect(extractMethodLabel("pdf_umi_ocr", "umi")).toBe("OCR（UMI·扫描件）");
  });

  it("未知方法原样返回，空方法返回「未知」", () => {
    expect(extractMethodLabel("some_new_method")).toBe("some_new_method");
    expect(extractMethodLabel("")).toBe("未知");
  });
});

describe("OCR / UMI / Vision 方法判定", () => {
  it("isOcrMethod 覆盖四种 OCR 方法", () => {
    expect(isOcrMethod("vision_ocr")).toBe(true);
    expect(isOcrMethod("umi_ocr")).toBe(true);
    expect(isOcrMethod("pdf_ocr")).toBe(true);
    expect(isOcrMethod("pdf_umi_ocr")).toBe(true);
    expect(isOcrMethod("markitdown")).toBe(false);
    expect(isOcrMethod("")).toBe(false);
  });

  it("isUmiMethod 只认本地 UMI-OCR 引擎", () => {
    expect(isUmiMethod("umi_ocr")).toBe(true);
    expect(isUmiMethod("pdf_umi_ocr")).toBe(true);
    expect(isUmiMethod("vision_ocr")).toBe(false);
    expect(isUmiMethod("pdf_ocr")).toBe(false);
    expect(isUmiMethod("markitdown")).toBe(false);
  });

  it("isVisionMethod 只认 Vision AI 引擎", () => {
    expect(isVisionMethod("vision_ocr")).toBe(true);
    expect(isVisionMethod("pdf_ocr")).toBe(true);
    expect(isVisionMethod("umi_ocr")).toBe(false);
    expect(isVisionMethod("pdf_umi_ocr")).toBe(false);
    expect(isVisionMethod("markitdown")).toBe(false);
  });
});
