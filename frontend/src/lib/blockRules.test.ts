/**
 * blockRules 单元测试。
 *
 * 该模块的读写走 localStorage；node 环境下没有 localStorage，
 * 因此这里注入一个极小的内存版 Storage（只记录原始字符串，不含业务逻辑），
 * 用来验证模块自身的真实行为（去重、删空清键、损坏数据兜底等）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SIDEBAR_AUTO_SELECTORS,
  getSidebarAutoCollapse,
  setSidebarAutoCollapse,
  getHost,
  getBlockRules,
  addBlockRule,
  removeBlockRule,
  buildBlockCSS,
} from "./blockRules";

const RULES_KEY = "cinside_block_rules";
const COLLAPSE_KEY = "cinside_sidebar_auto_collapse";

/** 极简内存 Storage：仅原样保存字符串，行为等价于浏览器的最小实现 */
function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    get length(): number {
      return map.size;
    },
    clear(): void {
      map.clear();
    },
    getItem(key: string): string | null {
      return map.get(key) ?? null;
    },
    key(index: number): string | null {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      map.delete(key);
    },
    setItem(key: string, value: string): void {
      map.set(key, String(value));
    },
  };
}

/** 读取原始存储内容（断言「未写入/已清键」这类行为用） */
function readJSON<T>(key: string): T {
  const raw = localStorage.getItem(key);
  if (raw === null) throw new Error(`期望 localStorage 中存在 ${key}`);
  return JSON.parse(raw) as T;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SIDEBAR_AUTO_SELECTORS", () => {
  it("是 21 项非空选择器常量", () => {
    expect(SIDEBAR_AUTO_SELECTORS).toHaveLength(21);
    for (const sel of SIDEBAR_AUTO_SELECTORS) {
      expect(typeof sel).toBe("string");
      expect(sel.trim().length).toBeGreaterThan(0);
    }
  });

  it("覆盖 aside 以及 class/id 的侧边栏特征匹配", () => {
    expect(SIDEBAR_AUTO_SELECTORS).toContain("aside");
    expect(SIDEBAR_AUTO_SELECTORS).toContain('[class*="sidebar" i]');
    expect(SIDEBAR_AUTO_SELECTORS).toContain('[class*="left-panel" i]');
    expect(SIDEBAR_AUTO_SELECTORS).toContain('[id*="rightpanel" i]');
  });
});

describe("getHost", () => {
  it("取 hostname：去端口、hostname 小写化", () => {
    expect(getHost("https://Example.COM:8443/apply?x=1")).toBe("example.com");
    expect(getHost("http://localhost:5173/")).toBe("localhost");
  });

  it("无法解析的 URL 返回 unknown", () => {
    expect(getHost("not a url")).toBe("unknown");
    expect(getHost("")).toBe("unknown");
  });

  it("没有 hostname 的 URL（file:）返回 unknown", () => {
    expect(getHost("file:///C:/tmp/a.html")).toBe("unknown");
  });
});

describe("屏蔽规则读写", () => {
  it("初始没有任何规则", () => {
    expect(getBlockRules("a.com")).toEqual([]);
  });

  it("addBlockRule 返回新数组并持久化，mode 默认 hide", () => {
    const rules = addBlockRule("a.com", "div.ad", "广告");
    expect(rules).toHaveLength(1);
    expect(rules[0].selector).toBe("div.ad");
    expect(rules[0].label).toBe("广告");
    expect(rules[0].mode).toBe("hide");
    expect(typeof rules[0].createdAt).toBe("number");
    expect(getBlockRules("a.com")).toEqual(rules);
  });

  it("可以指定 collapse 模式", () => {
    const rules = addBlockRule("a.com", "div.side", "侧栏", "collapse");
    expect(rules[0].mode).toBe("collapse");
    expect(getBlockRules("a.com")[0].mode).toBe("collapse");
  });

  it("相同 selector 去重：不重复添加且保留原有 label", () => {
    addBlockRule("a.com", "div.ad", "广告");
    const again = addBlockRule("a.com", "div.ad", "另一个标签");
    expect(again).toHaveLength(1);
    expect(again[0].label).toBe("广告");
    expect(getBlockRules("a.com")).toHaveLength(1);
  });

  it("多条规则按添加顺序追加，host 之间互不影响", () => {
    addBlockRule("a.com", "#x", "X");
    addBlockRule("a.com", "#y", "Y");
    addBlockRule("b.com", "#z", "Z");

    expect(getBlockRules("a.com").map((r) => r.selector)).toEqual(["#x", "#y"]);
    expect(getBlockRules("b.com").map((r) => r.selector)).toEqual(["#z"]);
    expect(getBlockRules("c.com")).toEqual([]);
  });

  it("removeBlockRule 返回剩余规则，删空后该 host 的键被清除", () => {
    addBlockRule("a.com", "#x", "X");
    addBlockRule("a.com", "#y", "Y");

    const rest = removeBlockRule("a.com", "#x");
    expect(rest.map((r) => r.selector)).toEqual(["#y"]);
    expect(getBlockRules("a.com").map((r) => r.selector)).toEqual(["#y"]);

    const emptied = removeBlockRule("a.com", "#y");
    expect(emptied).toEqual([]);
    expect(getBlockRules("a.com")).toEqual([]);

    const raw = readJSON<Record<string, unknown>>(RULES_KEY);
    expect("a.com" in raw).toBe(false);
  });

  it("删除不存在的 selector 不报错，其余规则保持不变", () => {
    addBlockRule("a.com", "#x", "X");
    const rules = removeBlockRule("a.com", "#nope");
    expect(rules.map((r) => r.selector)).toEqual(["#x"]);
    expect(getBlockRules("a.com").map((r) => r.selector)).toEqual(["#x"]);
  });

  it("存储内容损坏或非对象时按空规则处理", () => {
    localStorage.setItem(RULES_KEY, "{not json");
    expect(getBlockRules("a.com")).toEqual([]);

    localStorage.setItem(RULES_KEY, "null");
    expect(getBlockRules("a.com")).toEqual([]);

    localStorage.setItem(RULES_KEY, "123");
    expect(getBlockRules("a.com")).toEqual([]);
  });

  it("损坏内容下仍可新增规则", () => {
    localStorage.setItem(RULES_KEY, "{not json");
    const rules = addBlockRule("a.com", "#x", "X");
    expect(rules).toHaveLength(1);
    expect(getBlockRules("a.com").map((r) => r.selector)).toEqual(["#x"]);
  });
});

describe("buildBlockCSS", () => {
  it("空规则返回空字符串", () => {
    expect(buildBlockCSS([])).toBe("");
  });

  it("单条规则生成 display:none 规则块", () => {
    expect(buildBlockCSS([{ selector: "div.ad", label: "广告", createdAt: 1 }])).toBe("div.ad { display: none !important; }");
  });

  it("多条规则用逗号加换行连接", () => {
    const css = buildBlockCSS([
      { selector: "#a", label: "A", createdAt: 1 },
      { selector: "#b", label: "B", createdAt: 2, mode: "collapse" },
    ]);
    expect(css).toBe("#a,\n#b { display: none !important; }");
  });
});

describe("侧边栏自动折叠开关", () => {
  it("默认关闭", () => {
    expect(getSidebarAutoCollapse("a.com")).toBe(false);
    expect(localStorage.getItem(COLLAPSE_KEY)).toBeNull();
  });

  it("开启后为 true 并按 host 持久化", () => {
    setSidebarAutoCollapse("a.com", true);
    expect(getSidebarAutoCollapse("a.com")).toBe(true);
    expect(readJSON<Record<string, boolean>>(COLLAPSE_KEY)).toEqual({ "a.com": true });
  });

  it("关闭时只删除该 host，其它 host 保留", () => {
    setSidebarAutoCollapse("a.com", true);
    setSidebarAutoCollapse("b.com", true);
    setSidebarAutoCollapse("a.com", false);

    expect(getSidebarAutoCollapse("a.com")).toBe(false);
    expect(getSidebarAutoCollapse("b.com")).toBe(true);
    expect(readJSON<Record<string, boolean>>(COLLAPSE_KEY)).toEqual({ "b.com": true });
  });

  it("重复开启是幂等的", () => {
    setSidebarAutoCollapse("a.com", true);
    setSidebarAutoCollapse("a.com", true);
    expect(readJSON<Record<string, boolean>>(COLLAPSE_KEY)).toEqual({ "a.com": true });
  });

  it("空字符串或 null 内容视为未开启", () => {
    localStorage.setItem(COLLAPSE_KEY, "");
    expect(getSidebarAutoCollapse("a.com")).toBe(false);
    localStorage.setItem(COLLAPSE_KEY, "null");
    expect(getSidebarAutoCollapse("a.com")).toBe(false);
  });

  it("损坏或非对象内容按未开启处理", () => {
    localStorage.setItem(COLLAPSE_KEY, "{not json");
    expect(getSidebarAutoCollapse("a.com")).toBe(false);

    localStorage.setItem(COLLAPSE_KEY, "42");
    expect(getSidebarAutoCollapse("a.com")).toBe(false);
  });

  it("已存对象按真值判断：0/空串为 false，非空值为 true", () => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify({ "a.com": 0, "b.com": "yes" }));
    expect(getSidebarAutoCollapse("a.com")).toBe(false);
    expect(getSidebarAutoCollapse("b.com")).toBe(true);
  });

  it("写入时遇到损坏内容不抛错，且保持原值不覆盖", () => {
    localStorage.setItem(COLLAPSE_KEY, "{not json");
    expect(() => setSidebarAutoCollapse("a.com", true)).not.toThrow();
    expect(localStorage.getItem(COLLAPSE_KEY)).toBe("{not json");
    expect(getSidebarAutoCollapse("a.com")).toBe(false);
  });
});
