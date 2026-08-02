import { useCallback, useState, type DragEvent, type ClipboardEvent } from "react";
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

/** 把 File/Blob 读成 dataURL */
function readFileAsDataURL(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function SkillPanel({ open, onClose, onRunSkill, onSkillsChange }: SkillPanelProps) {
  const [skills, setSkills] = useState<WorkflowTemplate[]>(() => loadSkills());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editIcon, setEditIcon] = useState("");
  const [editIconImage, setEditIconImage] = useState<string | null | undefined>(undefined);
  const [showIconPicker, setShowIconPicker] = useState(false);
  // 正在悬停图片拖拽的 skill id
  const [imgDragOverId, setImgDragOverId] = useState<string | null>(null);

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
    setEditIconImage(skill.iconImage);
    setShowIconPicker(false);
  };

  const saveEdit = () => {
    if (!editingId || !editName.trim()) return;
    const patch: { name: string; icon: string; iconImage?: string | null } = {
      name: editName.trim(),
      icon: editIcon || "🔍",
    };
    // iconImage 显式设置：undefined=不修改；null=清除；string=新图片
    if (editIconImage === null) patch.iconImage = null;
    else if (editIconImage) patch.iconImage = editIconImage;
    updateSkillMeta(editingId, patch);
    setEditingId(null);
    refresh();
  };

  const cancelEdit = () => {
    setEditingId(null);
    setShowIconPicker(false);
    setEditIconImage(undefined);
  };

  /** 给指定 skill 设置自定义图标图片（dataURL） */
  const setSkillIconImage = useCallback((id: string, dataUrl: string) => {
    updateSkillMeta(id, { iconImage: dataUrl });
    refresh();
  }, []);

  /** 移除指定 skill 的自定义图标图片 */
  const clearSkillIconImage = useCallback((id: string) => {
    updateSkillMeta(id, { iconImage: null });
    refresh();
  }, []);

  /** 卡片接收图片粘贴（焦点在卡片上时 Ctrl+V） */
  const handleCardPaste = (e: ClipboardEvent, skillId: string) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          e.stopPropagation();
          readFileAsDataURL(f).then((url) => { if (url) setSkillIconImage(skillId, url); });
          return;
        }
      }
    }
  };

  /** 卡片接收图片拖放：只在有图片文件时拦截 */
  const handleCardDragOver = (e: DragEvent, skillId: string) => {
    if (editingId) return;
    const files = Array.from(e.dataTransfer.files || []);
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (imgDragOverId !== skillId) setImgDragOverId(skillId);
    }
  };
  const handleCardDragLeave = (e: DragEvent, skillId: string) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      if (imgDragOverId === skillId) setImgDragOverId(null);
    }
  };
  const handleCardDrop = (e: DragEvent, skillId: string) => {
    if (editingId) return;
    const files = Array.from(e.dataTransfer.files || []);
    const img = files.find((f) => f.type.startsWith("image/"));
    if (imgDragOverId) setImgDragOverId(null);
    if (img) {
      e.preventDefault();
      e.stopPropagation();
      readFileAsDataURL(img).then((url) => { if (url) setSkillIconImage(skillId, url); });
    }
  };

  const handleDragStart = (e: DragEvent, skill: WorkflowTemplate) => {
    e.dataTransfer.setData(SKILL_DRAG_MIME, skill.id);
    e.dataTransfer.effectAllowed = "copy";
    const ghost = document.createElement("div");
    if (skill.iconImage) {
      const im = document.createElement("img");
      im.src = skill.iconImage;
      im.style.cssText = "width:56px;height:56px;object-fit:cover;border-radius:10px;";
      ghost.appendChild(im);
    } else {
      ghost.textContent = skill.icon || "🔍";
      ghost.style.fontSize = "32px";
    }
    ghost.style.cssText += "position:fixed;top:-9999px;pointer-events:none;";
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 28, 28);
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
          <span className="ml-auto text-[11px] text-slate-500">{skills.length} 个技能 · 拖拽到人物卡片可单卡执行 · Ctrl+V/拖入图片换图标</span>
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
                const isImgDragOver = imgDragOverId === skill.id;
                const currentIcon = isEditing ? editIcon : (skill.icon || "🔍");
                const currentIconImage = isEditing ? editIconImage : skill.iconImage;

                return (
                  <div
                    key={skill.id}
                    className={[
                      "relative flex items-center gap-2 overflow-hidden rounded-xl border bg-white p-3 shadow-sm transition-all",
                      isEditing
                        ? "border-indigo-300 ring-2 ring-indigo-200"
                        : "border-slate-200 hover:border-indigo-300 hover:shadow-md",
                      !isEditing && "cursor-grab active:cursor-grabbing",
                      isImgDragOver && !isEditing ? "ring-2 ring-indigo-400 border-indigo-400" : "",
                    ].filter(Boolean).join(" ")}
                    draggable={!isEditing}
                    onDragStart={(e) => !isEditing && handleDragStart(e, skill)}
                    onDragOver={(e) => handleCardDragOver(e, skill.id)}
                    onDragLeave={(e) => handleCardDragLeave(e, skill.id)}
                    onDrop={(e) => handleCardDrop(e, skill.id)}
                    onPaste={(e) => handleCardPaste(e, skill.id)}
                    tabIndex={0}
                  >
                    {/* 左侧自定义图标图片（仅非编辑态显示渐隐图；编辑态在按钮里预览） */}
                    {!isEditing && currentIconImage ? (
                      <div className="relative h-12 w-20 shrink-0 -m-3 mr-1 self-stretch overflow-hidden rounded-l-xl">
                        <img
                          src={currentIconImage}
                          alt=""
                          draggable={false}
                          className="h-full w-full object-cover"
                          style={{
                            WebkitMaskImage: "linear-gradient(to right, black 0%, black 60%, rgba(0,0,0,0.55) 82%, transparent 100%)",
                            maskImage: "linear-gradient(to right, black 0%, black 60%, rgba(0,0,0,0.55) 82%, transparent 100%)",
                            WebkitMaskRepeat: "no-repeat",
                            maskRepeat: "no-repeat",
                          }}
                        />
                        <button
                          onClick={(e) => { e.stopPropagation(); clearSkillIconImage(skill.id); }}
                          className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-slate-900/60 text-white opacity-0 transition-opacity hover:bg-rose-600 group-hover:opacity-100"
                          style={{ opacity: 1 /* 始终显示，便于识别可点击 */ }}
                          title="移除图片图标"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    ) : null}

                    {isEditing ? (
                      <>
                        {/* 编辑态：图标预览区（可点emoji或显示自定义图，支持粘贴/拖入图片） */}
                        <div
                          className="relative h-10 w-12 shrink-0 overflow-hidden rounded-lg"
                          onPaste={(e) => {
                            const items = e.clipboardData?.items;
                            if (!items) return;
                            for (const it of items) {
                              if (it.type.startsWith("image/")) {
                                const f = it.getAsFile();
                                if (f) {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  readFileAsDataURL(f).then((url) => { if (url) setEditIconImage(url); });
                                  return;
                                }
                              }
                            }
                          }}
                          onDragOver={(e) => {
                            const files = Array.from(e.dataTransfer.files || []);
                            if (files.some((x) => x.type.startsWith("image/"))) e.preventDefault();
                          }}
                          onDrop={(e) => {
                            const files = Array.from(e.dataTransfer.files || []);
                            const img = files.find((x) => x.type.startsWith("image/"));
                            if (img) {
                              e.preventDefault();
                              e.stopPropagation();
                              readFileAsDataURL(img).then((url) => { if (url) setEditIconImage(url); });
                            }
                          }}
                          tabIndex={0}
                          title="点击选 emoji，或 Ctrl+V/拖入图片"
                        >
                          {editIconImage ? (
                            <>
                              <img
                                src={editIconImage}
                                alt=""
                                className="h-full w-full object-cover"
                                style={{
                                  WebkitMaskImage: "linear-gradient(to right, black 0%, black 70%, transparent 100%)",
                                  maskImage: "linear-gradient(to right, black 0%, black 70%, transparent 100%)",
                                  WebkitMaskRepeat: "no-repeat",
                                  maskRepeat: "no-repeat",
                                }}
                              />
                              <button
                                onClick={(e) => { e.stopPropagation(); setEditIconImage(null); }}
                                className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-full bg-slate-900/70 text-white hover:bg-rose-600"
                                title="移除图片（保存后还原为 emoji）"
                              >
                                <X className="h-2.5 w-2.5" />
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => setShowIconPicker(!showIconPicker)}
                              className="flex h-full w-full items-center justify-center rounded-lg bg-gradient-to-br from-indigo-50 to-violet-50 text-2xl hover:bg-slate-100"
                            >
                              {editIcon}
                            </button>
                          )}
                        </div>
                        <div className="flex-1">
                          <input
                            autoFocus
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }}
                            className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200"
                          />
                          {showIconPicker && !editIconImage && (
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
                          {editIconImage && (
                            <div className="mt-1 text-[10px] text-slate-400">已设为图片图标（Ctrl+V/拖入可更换）</div>
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
                        {/* 非编辑态 & 无自定义图：显示 emoji 占位 */}
                        {!currentIconImage && (
                          <span
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-50 to-violet-50 text-2xl select-none"
                            onPaste={(e) => handleCardPaste(e, skill.id)}
                          >
                            {currentIcon}
                          </span>
                        )}
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
                          title="编辑名称和图标（Ctrl+V/拖入图片换图标）"
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
