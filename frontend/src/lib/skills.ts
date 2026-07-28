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

export function updateSkillMeta(id: string, patch: { name?: string; icon?: string }) {
  const skills = loadSkills();
  const idx = skills.findIndex((s) => s.id === id);
  if (idx >= 0) {
    skills[idx] = { ...skills[idx], ...patch, updatedAt: Date.now() };
    saveSkills(skills);
  }
}

export function getSkillById(id: string): WorkflowTemplate | null {
  const skills = loadSkills();
  return skills.find((s) => s.id === id) || null;
}
