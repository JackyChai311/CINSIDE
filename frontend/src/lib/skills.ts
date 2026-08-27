import type { FieldMapping, PickedMark, WorkflowTemplate } from "../types";

const STORAGE_KEY = "cinside_skills";

/** 左右互换面板内容后，模板内记录的左右归属需要镜像翻转才能继续正确执行（marks.side 与 mappings.web_side 同步翻转） */
export function mirrorTemplateSides(tpl: WorkflowTemplate): WorkflowTemplate {
  const flipMark = (m: PickedMark): PickedMark => ({ ...m, side: m.side === "left" ? "right" : "left" });
  return {
    ...tpl,
    dataSourceMarks: tpl.dataSourceMarks.map(flipMark),
    reviewMarks: tpl.reviewMarks.map(flipMark),
    entryMarks: tpl.entryMarks.map(flipMark),
    mappings: tpl.mappings?.map((mp: FieldMapping) => ({ ...mp, web_side: mp.web_side === "left" ? "right" : "left" })),
    // 网站记录也属于帧描述：左右镜像时两侧 origin 同步互换
    siteOrigins: tpl.siteOrigins ? { left: tpl.siteOrigins.right, right: tpl.siteOrigins.left } : undefined,
    // GROUP 面板快照同样属于帧描述：镜像时左右两侧身份互换
    groupPanes: tpl.groupPanes ? { left: tpl.groupPanes.right, right: tpl.groupPanes.left } : undefined,
  };
}

/**
 * 运行/展示模板前按会话互换状态对齐左右帧：
 * 模板保存时的互换标记（tpl.flipped）与当前会话互换状态（flipped）不一致 → 镜像返回（落库数据不动）
 */
export function frameAlignedTemplate(tpl: WorkflowTemplate, flipped: boolean): WorkflowTemplate {
  return (tpl.flipped ?? false) !== flipped ? mirrorTemplateSides(tpl) : tpl;
}

const DEFAULT_ICONS = ["🔍", "📋", "✅", "📝", "🎓", "🏫", "📊", "🔑", "📧", "🖋️", "📄", "🗂️", "🎯", "⚡", "🔄", "📌"];

export function getDefaultIcons(): string[] {
  return DEFAULT_ICONS;
}

export function loadSkills(): WorkflowTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as WorkflowTemplate[];
  } catch {
    return [];
  }
}

function saveSkills(skills: WorkflowTemplate[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(skills));
}

export function saveSkill(tpl: WorkflowTemplate): WorkflowTemplate {
  const skills = loadSkills();
  const existing = skills.findIndex((s) => s.id === tpl.id);
  const toSave = { ...tpl, updatedAt: Date.now() };
  if (existing >= 0) {
    skills[existing] = toSave;
  } else {
    skills.unshift(toSave);
  }
  saveSkills(skills);
  return toSave;
}

export function deleteSkill(id: string) {
  const skills = loadSkills().filter((s) => s.id !== id);
  saveSkills(skills);
}

export function updateSkillMeta(id: string, patch: { name?: string; description?: string; icon?: string; iconImage?: string | null; group?: string | null }) {
  const skills = loadSkills();
  const idx = skills.findIndex((s) => s.id === id);
  if (idx >= 0) {
    // 先构建设置字段（不包含 null 的 iconImage / group）
    const { iconImage, group, ...rest } = patch;
    const next: WorkflowTemplate = { ...skills[idx], ...rest, updatedAt: Date.now() };
    if (typeof iconImage === "string") next.iconImage = iconImage;
    // iconImage 为 null 表示清除自定义图片
    if (iconImage === null) delete next.iconImage;
    // group 为 null 表示移出分组；非空字符串表示加入分组
    if (typeof group === "string" && group.trim()) next.group = group.trim();
    else if (group === null) delete next.group;
    skills[idx] = next;
    saveSkills(skills);
  }
}

/** 批量设置分组：ids 中所有模板归入 group；group 为 null 表示移出分组 */
export function setSkillsGroup(ids: string[], group: string | null) {
  const skills = loadSkills();
  const idSet = new Set(ids);
  for (let i = 0; i < skills.length; i++) {
    if (!idSet.has(skills[i].id)) continue;
    const next: WorkflowTemplate = { ...skills[i], updatedAt: Date.now() };
    if (typeof group === "string" && group.trim()) next.group = group.trim();
    else if (group === null) delete next.group;
    skills[i] = next;
  }
  saveSkills(skills);
}

/** 所有已使用的分组名（去重，按名称排序） */
export function listSkillGroups(): string[] {
  const set = new Set<string>();
  for (const s of loadSkills()) {
    const g = s.group?.trim();
    if (g) set.add(g);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export function getSkillById(id: string): WorkflowTemplate | null {
  const skills = loadSkills();
  return skills.find((s) => s.id === id) || null;
}

/** 导入一个模板（通常来自分享码），返回导入后的模板 */
export function importSkill(tpl: WorkflowTemplate): WorkflowTemplate {
  return saveSkill(tpl);
}

/** 判断本地是否已存在同 ID 的模板 */
export function hasSkill(id: string): boolean {
  return loadSkills().some((s) => s.id === id);
}
