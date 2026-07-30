/**
 * 网页元素屏蔽规则持久化存储
 * 按 hostname 分组，存储 CSS selector 数组
 * 仿照 skills.ts 的 localStorage 模式
 */

const STORAGE_KEY = "cinside_block_rules";
const SIDEBAR_COLLAPSE_KEY = "cinside_sidebar_auto_collapse";

export type BlockMode = "hide" | "collapse";

/**
 * 自动侧边栏折叠用的 CSS 选择器集合
 * 匹配常见侧边栏元素：aside、含 sidebar/sidenav/side-bar/left-panel 等类名或 id 的元素
 * 用 [attr*="value" i] 大小写不敏感匹配
 * 注：不折叠所有 nav（避免误伤顶部导航），只折叠明确含侧边栏特征的元素
 */
export const SIDEBAR_AUTO_SELECTORS: string[] = [
  "aside",
  '[class*="sidebar" i]',
  '[class*="side-bar" i]',
  '[class*="sidenav" i]',
  '[class*="side-nav" i]',
  '[class*="side-menu" i]',
  '[class*="left-panel" i]',
  '[class*="leftpanel" i]',
  '[class*="left-menu" i]',
  '[class*="leftmenu" i]',
  '[class*="right-panel" i]',
  '[class*="rightpanel" i]',
  '[class*="right-menu" i]',
  '[class*="rightmenu" i]',
  '[id*="sidebar" i]',
  '[id*="sidenav" i]',
  '[id*="side-bar" i]',
  '[id*="leftmenu" i]',
  '[id*="leftpanel" i]',
  '[id*="rightmenu" i]',
  '[id*="rightpanel" i]',
];

/** 读取指定 host 是否启用自动侧边栏折叠 */
export function getSidebarAutoCollapse(host: string): boolean {
  try {
    const raw = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
    if (!raw) return false;
    const map = JSON.parse(raw);
    if (typeof map !== "object" || map === null) return false;
    return !!map[host];
  } catch {
    return false;
  }
}

/** 设置指定 host 的自动侧边栏折叠开关，持久化到 localStorage */
export function setSidebarAutoCollapse(host: string, enabled: boolean): void {
  try {
    const raw = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
    let map: Record<string, boolean> = {};
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) map = parsed;
    }
    if (enabled) {
      map[host] = true;
    } else {
      delete map[host];
    }
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

export interface BlockRule {
  selector: string;
  label: string;
  createdAt: number;
  /** "hide" = display:none 完全隐藏; "collapse" = 折叠到零宽度，可通过展开按钮恢复 */
  mode?: BlockMode;
}

/** 按 hostname 分组的规则表 */
type BlockRuleMap = Record<string, BlockRule[]>;

function loadAll(): BlockRuleMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as BlockRuleMap;
  } catch {
    return {};
  }
}

function saveAll(map: BlockRuleMap) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

/** 从 URL 提取 hostname */
export function getHost(url: string): string {
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

/** 获取指定 hostname 的屏蔽规则 */
export function getBlockRules(host: string): BlockRule[] {
  return loadAll()[host] || [];
}

/** 添加一条屏蔽规则 */
export function addBlockRule(host: string, selector: string, label: string, mode: BlockMode = "hide"): BlockRule[] {
  const map = loadAll();
  const rules = map[host] || [];
  // 去重：相同 selector 不重复添加
  if (rules.some((r) => r.selector === selector)) return rules;
  rules.push({ selector, label, createdAt: Date.now(), mode });
  map[host] = rules;
  saveAll(map);
  return rules;
}

/** 删除一条屏蔽规则 */
export function removeBlockRule(host: string, selector: string): BlockRule[] {
  const map = loadAll();
  const rules = (map[host] || []).filter((r) => r.selector !== selector);
  if (rules.length > 0) {
    map[host] = rules;
  } else {
    delete map[host]; // 无规则的 host 直接清除
  }
  saveAll(map);
  return rules;
}

/** 生成屏蔽 CSS 字符串 */
export function buildBlockCSS(rules: BlockRule[]): string {
  if (rules.length === 0) return "";
  const selectors = rules.map((r) => r.selector).join(",\n");
  return `${selectors} { display: none !important; }`;
}
