import type { WorkflowTemplate } from "../types";

const STORAGE_KEY = "cinside_skills";

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

export function updateSkillMeta(id: string, patch: { name?: string; description?: string; icon?: string; iconImage?: string | null }) {
  const skills = loadSkills();
  const idx = skills.findIndex((s) => s.id === id);
  if (idx >= 0) {
    // 先构建设置字段（不包含 null 的 iconImage）
    const { iconImage, ...rest } = patch;
    const next: WorkflowTemplate = { ...skills[idx], ...rest, updatedAt: Date.now() };
    if (typeof iconImage === "string") next.iconImage = iconImage;
    // iconImage 为 null 表示清除自定义图片
    if (iconImage === null) delete next.iconImage;
    skills[idx] = next;
    saveSkills(skills);
  }
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
