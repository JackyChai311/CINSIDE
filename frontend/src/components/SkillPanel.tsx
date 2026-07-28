import { useState, type DragEvent } from "react";
import { Check, Play, Pencil, Trash2, X, Sparkles } from "lucide-react";
import type { WorkflowTemplate, AppMode } from "../types";
import { loadSkills, deleteSkill, updateSkillMeta, getDefaultIcons } from "../lib/skills";

interface SkillPanelProps {
  open: boolean;
  onClose: () => void;
  onRunSkill: (tpl: WorkflowTemplate) => void;
  onSkillsChange?: () => void;
}

const MODE_LABELS: Record<AppMode, { label: string; color: string }> = {
  loop: { label: "全流程", color: "bg-indigo-100 text-indigo-700" },
  review: { label: "审查", color: "bg-sky-100 text-sky-700" },
  entry: { label: "录入", color: "bg-violet-100 text-violet-700" },
};

const SKILL_DRAG_MIME = "application/x-cinside-skill-id";

export default function SkillPanel({ open, onClose, onRunSkill, onSkillsChange }: SkillPanelProps) {
  const [skills, setSkills] = useState<WorkflowTemplate[]>(() => loadSkills());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editIcon, setEditIcon] = useState("");
  const [showIconPicker, setShowIconPicker] = useState(false);

  const refresh = () => {
    setSkills(loadSkills());
    onSkillsChange?.();
  };

  const handleDelete = (id: string) => {
    deleteSkill(id);
    refresh();
  };

  const startEdit = (skill: WorkflowTemplate) => {
    setEditingId(skill.id);
    setEditName(skill.name);
    setEditIcon(skill.icon || "🔍");
    setShowIconPicker(false);
  };

  const saveEdit = () => {
    if (!editingId || !editName.trim()) return;
    updateSkillMeta(editingId, { name: editName.trim(), icon: editIcon });
    setEditingId(null);
    refresh();
  };

  const cancelEdit = () => {
    setEditingId(null);
    setShowIconPicker(false);
  };

  const handleDragStart = (e: DragEvent, skill: WorkflowTemplate) => {
    e.dataTransfer.setData(SKILL_DRAG_MIME, skill.id);
    e.dataTransfer.effectAllowed = "copy";
    const ghost = document.createElement("div");
    ghost.textContent = skill.icon || "🔍";
    ghost.style.cssText = "position:fixed;top:-9999px;font-size:32px;pointer-events:none;";
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 16, 16);
    requestAnimationFrame(() => document.body.removeChild(ghost));
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[min(560px,calc(100vw-2rem))] max-h-[80vh] overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-200 bg-gradient-to-r from-indigo-50 to-violet-50 px-4 py-3">
          <Sparkles className="h-5 w-5 text-indigo-600" />
          <span className="text-sm font-semibold text-slate-800">SKILL 管理</span>
          <span className="ml-auto text-[11px] text-slate-500">{skills.length} 个技能 · 拖拽到人物卡片可单卡执行</span>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-3">
          {skills.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Sparkles className="mb-3 h-10 w-10 text-slate-200" />
              <p className="text-sm text-slate-500">还没有保存任何 SKILL</p>
              <p className="mt-1 text-[11px] text-slate-400">配置好步骤后，点「保存为 SKILL」即可复用</p>
            </div>
          ) : (
            <div className="space-y-2">
              {skills.map((skill) => {
                const modeInfo = MODE_LABELS[skill.mode];
                const stepCount = skill.dataSourceMarks.length + skill.reviewMarks.length + skill.entryMarks.length;
                const isEditing = editingId === skill.id;

                return (
                  <div
                    key={skill.id}
                    className={[
                      "flex items-center gap-2 rounded-xl border bg-white p-3 shadow-sm transition-all",
                      isEditing
                        ? "border-indigo-300 ring-2 ring-indigo-200"
                        : "border-slate-200 hover:border-indigo-300 hover:shadow-md cursor-grab active:cursor-grabbing",
                    ].join(" ")}
                    draggable={!isEditing}
                    onDragStart={(e) => !isEditing && handleDragStart(e, skill)}
                  >
                    {isEditing ? (
                      <>
                        <button
                          onClick={() => setShowIconPicker(!showIconPicker)}
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-2xl hover:bg-slate-100"
                        >
                          {editIcon}
                        </button>
                        <div className="flex-1">
                          <input
                            autoFocus
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }}
                            className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200"
                          />
                          {showIconPicker && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {getDefaultIcons().map((ic) => (
                                <button
                                  key={ic}
                                  onClick={() => { setEditIcon(ic); setShowIconPicker(false); }}
                                  className={`flex h-8 w-8 items-center justify-center rounded-md text-lg transition-all ${editIcon === ic ? "bg-indigo-100 ring-2 ring-indigo-400" : "bg-slate-50 hover:bg-slate-100"}`}
                                >
                                  {ic}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={saveEdit}
                          className="rounded-md p-1.5 text-emerald-600 hover:bg-emerald-50"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-50 to-violet-50 text-2xl select-none">
                          {skill.icon || "🔍"}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium text-slate-800">{skill.name}</span>
                            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium ${modeInfo.color}`}>
                              {modeInfo.label}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-[10px] text-slate-400">
                            <span>{stepCount} 步</span>
                            <span>·</span>
                            <span>{new Date(skill.updatedAt || skill.createdAt).toLocaleDateString("zh-CN")}</span>
                            <span>·</span>
                            <span className="text-indigo-400">拖到卡片执行</span>
                          </div>
                        </div>
                        <button
                          onClick={() => onRunSkill(skill)}
                          className="flex items-center gap-1 rounded-lg bg-brand-600 px-3 py-1.5 text-[11px] font-medium text-white transition-all hover:bg-brand-700"
                          title="批量执行此 SKILL（所有卡片）"
                        >
                          <Play className="h-3 w-3" />
                          批量
                        </button>
                        <button
                          onClick={() => startEdit(skill)}
                          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                          title="编辑名称和图标"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(skill.id)}
                          className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                          title="删除"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export { SKILL_DRAG_MIME };
