import { getPaneExchangeApi } from "../components/BrowserPane";
import type { PaneSnapshot, WorkflowTemplate } from "../types";

/** 提取网址的 origin（协议+域名+端口）：主页链接或任意子目录链接都归一到同一 origin */
export function extractOrigin(url?: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.protocol.startsWith("http") && u.origin !== "null" ? u.origin : "";
  } catch {
    return "";
  }
}

export interface PaneOrigins {
  left: string[];
  right: string[];
}

/** 收集左右面板所有 TAB 的网页 origin（不限于激活 TAB：目标网站在后台 TAB 也能识别） */
export function collectPaneOrigins(): PaneOrigins {
  const originsOf = (side: "left" | "right"): string[] => {
    const api = getPaneExchangeApi(side);
    if (!api) return [];
    return Array.from(new Set((api.getWebTabs() || []).map((t) => extractOrigin(t.url)).filter(Boolean)));
  };
  return { left: originsOf("left"), right: originsOf("right") };
}

/**
 * 按记录的两侧网站 origin 判定当前左右帧是否被互换：
 * 模板保存时记录了「教学时左右两侧各是什么网站」，运行时看这些网站现在开在哪一侧。
 * 返回 true=已互换（需镜像）、false=未互换、null=无法判定（调用方回退其他依据）
 * 判定规则：网站「只在对面」= 互换证据；「只在本侧」= 未互换证据；
 * 两侧都有（重复 TAB）或都没开 → 不作为证据忽略（避免重复 TAB 稀释成混票导致判 ok）
 */
export function sideFrameByOrigins(
  rec: { left?: string; right?: string } | undefined,
  cur: PaneOrigins
): boolean | null {
  if (!rec) return null;
  const recL = extractOrigin(rec.left);
  const recR = extractOrigin(rec.right);
  let vote = 0; // 认为已互换的票数
  let hits = 0; // 成功定位到的网站数
  const judge = (origin: string, home: "left" | "right") => {
    if (!origin) return;
    const away = home === "left" ? "right" : "left";
    const inHome = cur[home].includes(origin);
    const inAway = cur[away].includes(origin);
    if (inHome && !inAway) hits++;
    else if (inAway && !inHome) { vote++; hits++; }
  };
  judge(recL, "left");
  judge(recR, "right");
  if (hits === 0) return null;
  if (vote * 2 === hits) return null; // 票数对半（冲突），无法判定
  return vote * 2 > hits;
}

/** origin 转主机名显示（去 www 前缀）：GROUP 标题行的网页名 */
export function hostOf(origin: string): string {
  try {
    const u = new URL(origin);
    return u.hostname.replace(/^www\./, "") || origin;
  } catch {
    return origin;
  }
}

/** 单个模板的 GROUP 面板快照：优先 groupPanes，旧模板回退 siteOrigins 推导（仅网页侧，无 Excel 名） */
export function templatePaneSnapshot(tpl: WorkflowTemplate): { left?: PaneSnapshot; right?: PaneSnapshot } | undefined {
  if (tpl.groupPanes && (tpl.groupPanes.left || tpl.groupPanes.right)) return tpl.groupPanes;
  const l = extractOrigin(tpl.siteOrigins?.left);
  const r = extractOrigin(tpl.siteOrigins?.right);
  if (!l && !r) return undefined;
  return {
    left: l ? { kind: "web", label: hostOf(l), origin: l } : undefined,
    right: r ? { kind: "web", label: hostOf(r), origin: r } : undefined,
  };
}

/** GROUP 成员聚合两侧面板快照：优先取最近更新的成员（同组各分支教的是同一对网页/Excel） */
export function groupPaneSnapshot(items: WorkflowTemplate[]): { left?: PaneSnapshot; right?: PaneSnapshot } | undefined {
  const sorted = [...items].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  for (const t of sorted) {
    const snap = templatePaneSnapshot(t);
    if (snap) return snap;
  }
  return undefined;
}

/** GROUP 面板校验结果：ok=正常 / missing=网页没开（禁止运行） / swapped=网页开对侧（左右反了） / unknown=无记录（跳过校验） */
export type GroupPaneStatus = "ok" | "missing" | "swapped" | "unknown";

/**
 * 运行 GROUP LOOP 前校验：模板记录的网页 origin 必须已在某个 BrowserPane 打开；开在反侧则左右反了。
 * 某网站两侧都有 TAB（重复 TAB）时不作为证据（既不算 keep 也不算 swap），避免混票漏判反转。
 */
export function checkGroupPanes(
  panes: { left?: PaneSnapshot; right?: PaneSnapshot } | undefined,
  cur: PaneOrigins
): { status: GroupPaneStatus; missing: string[] } {
  const missing: string[] = [];
  let swap = 0;
  let keep = 0;
  for (const side of ["left", "right"] as const) {
    const p = panes?.[side];
    if (!p || p.kind !== "web" || !p.origin) continue;
    const away = side === "left" ? "right" : "left";
    const here = cur[side].includes(p.origin);
    const there = cur[away].includes(p.origin);
    if (!here && !there) {
      missing.push(p.label || p.origin);
      continue;
    }
    if (there && !here) swap++;
    else if (here && !there) keep++;
    // here && there（两侧都有重复 TAB）：不作证据
  }
  if (missing.length > 0) return { status: "missing", missing };
  if (swap > 0 && keep === 0) return { status: "swapped", missing };
  return { status: "ok", missing };
}

export { originColorClass } from "./originColor";
