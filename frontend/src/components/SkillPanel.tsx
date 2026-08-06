import { useCallback, useMemo, useRef, useState, type DragEvent, type ClipboardEvent, type ChangeEvent } from "react";
import { Check, Play, Pencil, Trash2, X, Sparkles, GitBranch, ImagePlus, Search } from "lucide-react";
import type { WorkflowTemplate, AppMode } from "../types";
import { loadSkills, deleteSkill, updateSkillMeta, getDefaultIcons } from "../lib/skills";

interface SkillPanelProps {
  open: boolean;
  onClose: () => void;
  onRunSkill: (tpl: WorkflowTemplate) => void;
  onEditFlow?: (tpl: WorkflowTemplate) => void;
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

export default function SkillPanel({ open, onClose, onRunSkill, onEditFlow, onSkillsChange }: SkillPanelProps) {
  const [skills, setSkills] = useState<WorkflowTemplate[]>(() => loadSkills());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editIcon, setEditIcon] = useState("");
  const [editIconImage, setEditIconImage] = useState<string | null | undefined>(undefined);
  const [showIconPicker, setShowIconPicker] = useState(false);
  // 正在悬停图片拖拽的 skill id
  const [imgDragOverId, setImgDragOverId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // 每个卡片单独的文件选择 input ref
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingSkillId = useRef<string | null>(null);

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
    setEditDesc(skill.description || "");
    setEditIconImage(skill.iconImage);
    setShowIconPicker(false);
  };

  const saveEdit = () => {
    if (!editingId || !editName.trim()) return;
    const patch: { name: string; description?: string; icon: string; iconImage?: string | null } = {
      name: editName.trim(),
      icon: editIcon || "🔍",
    };
    const desc = editDesc.trim().slice(0, 80);
    if (desc) patch.description = desc;
    else patch.description = "";
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

  /** 点击图标区域：弹出文件选择框给指定 skill 上传图片 */
  const handlePickImage = (skillId: string) => {
    pendingSkillId.current = skillId;
    fileInputRef.current?.click();
  };

  /** 文件输入框变化：读取所选图片设置图标 */
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const skillId = pendingSkillId.current;
    e.target.value = "";
    if (file && file.type.startsWith("image/") && skillId) {
      readFileAsDataURL(file).then((url) => { if (url) setSkillIconImage(skillId, url); });
    }
    pendingSkillId.current = null;
  };

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

  const keyword = search.trim().toLowerCase();
  const filteredSkills = useMemo(() => {
    if (!keyword) return skills;
    return skills.filter((s) =>
      s.name.toLowerCase().includes(keyword) ||
      (s.description || "").toLowerCase().includes(keyword)
    );
  }, [skills, keyword]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[min(960px,calc(100vw-2rem))] max-h-[86vh] overflow-hidden rounded-3xl bg-white shadow-2xl ring-1 ring-black/5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：标题 + 搜索栏 */}
        <div className="relative overflow-hidden border-b border-slate-200/70 bg-gradient-to-br from-indigo-50 via-violet-50 to-fuchsia-50 px-5 pt-4 pb-4">
          {/* 装饰光斑 */}
          <div className="pointer-events-none absolute -top-16 -right-12 h-40 w-40 rounded-full bg-indigo-200/40 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-10 -left-10 h-32 w-32 rounded-full bg-fuchsia-200/40 blur-3xl" />
          <div className="relative flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-500/30">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-display text-lg font-bold tracking-tight text-slate-900">循环管理</h2>
              <p className="text-[11px] text-slate-500">{skills.length} 个技能 · 拖拽到人物卡片可单卡执行 · Ctrl+V / 拖入图片换图标</p>
            </div>
            <button
              onClick={onClose}
              className="ml-auto flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-white/60 hover:text-slate-700"
              title="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {/* 搜索框 */}
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索技能名称或介绍…"
              className="w-full rounded-xl border border-white/80 bg-white/80 py-2 pl-9 pr-9 text-[13px] text-slate-700 shadow-sm outline-none ring-1 ring-slate-200/60 backdrop-blur transition placeholder:text-slate-400 focus:border-indigo-300 focus:bg-white focus:ring-2 focus:ring-indigo-200"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                title="清空搜索"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="max-h-[calc(86vh-138px)] overflow-y-auto p-4">
          {filteredSkills.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              {keyword ? (
                <>
                  <Search className="mb-3 h-10 w-10 text-slate-200" />
                  <p className="text-sm text-slate-500">没有找到匹配 "{search}" 的技能</p>
                  <p className="mt-1 text-[11px] text-slate-400">换个关键词试试，或清空搜索查看全部</p>
                </>
              ) : (
                <>
                  <Sparkles className="mb-3 h-10 w-10 text-slate-200" />
                  <p className="text-sm text-slate-500">还没有保存任何 SKILL</p>
                  <p className="mt-1 text-[11px] text-slate-400">配置好步骤后，点「保存为 SKILL」即可复用</p>
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {filteredSkills.map((skill) => {
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
                      "relative flex items-stretch gap-2.5 overflow-hidden rounded-2xl border bg-white p-4 shadow-sm transition-all",
                      isEditing
                        ? "border-indigo-300 ring-2 ring-indigo-200 items-center"
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
                    {/* 左侧自定义图标图片（非编辑态 + 有图） */}
                    {!isEditing && currentIconImage ? (
                      <div className="relative -my-4 -ml-4 w-32 shrink-0 overflow-hidden rounded-l-2xl">
                        <img
                          src={currentIconImage}
                          alt=""
                          draggable={false}
                          className="h-full w-full object-cover"
                          style={{
                            WebkitMaskImage: "linear-gradient(to right, black 0%, black 82%, rgba(0,0,0,0.6) 94%, transparent 100%)",
                            maskImage: "linear-gradient(to right, black 0%, black 82%, rgba(0,0,0,0.6) 94%, transparent 100%)",
                            WebkitMaskRepeat: "no-repeat",
                            maskRepeat: "no-repeat",
                          }}
                        />
                        <button
                          onClick={(e) => { e.stopPropagation(); clearSkillIconImage(skill.id); }}
                          className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-slate-900/60 text-white transition-colors hover:bg-rose-600"
                          title="移除图片图标"
                        >
                          <X className="h-3 w-3" />
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
                          <textarea
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value.slice(0, 80))}
                            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); } if (e.key === "Escape") cancelEdit(); }}
                            rows={3}
                            maxLength={80}
                            placeholder="填写介绍（最多80字）"
                            className="mt-1.5 w-full resize-none rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200"
                          />
                          <div className={`mt-0.5 text-right text-[10px] ${editDesc.length >= 80 ? "text-rose-500" : "text-slate-400"}`}>
                            {editDesc.length}/80
                          </div>
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
                    ) : currentIconImage ? (
                      /* 有图非编辑态：右侧标题/描述，底部左为元数据、右为操作按钮 */
                      <>
                        <div className="flex min-w-0 flex-1 flex-col py-0.5">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-display text-[19px] font-bold tracking-tight text-slate-900">{skill.name}</span>
                            <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${modeInfo.color}`}>
                              {modeInfo.label}
                            </span>
                          </div>
                          <div className="mt-2 flex-1">
                            {skill.description ? (
                              <p className="line-clamp-2 break-words text-[13px] leading-relaxed text-slate-500">{skill.description}</p>
                            ) : null}
                          </div>
                          <div className="mt-2 flex items-end justify-between gap-2">
                            <div className="flex items-center gap-2 text-[12px] text-slate-400">
                              <span>{stepCount} 步</span>
                              <span>·</span>
                              <span>{new Date(skill.updatedAt || skill.createdAt).toLocaleDateString("zh-CN")}</span>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                onClick={(e) => { e.stopPropagation(); startEdit(skill); }}
                                className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                                title="编辑标题、介绍和图标"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDelete(skill.id); }}
                                className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                                title="删除"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); onEditFlow?.(skill); }}
                                className="flex h-7 items-center gap-1 rounded-lg bg-violet-50 px-2 text-[11px] font-medium text-violet-700 ring-1 ring-violet-200 transition-all hover:bg-violet-100"
                                title="打开流程图编辑器"
                              >
                                <GitBranch className="h-3 w-3" />
                                流程
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); onRunSkill(skill); }}
                                className="flex h-7 items-center gap-1 rounded-lg bg-brand-600 px-2.5 text-[11px] font-medium text-white shadow-sm transition-all hover:bg-brand-700"
                                title="批量执行此循环"
                              >
                                <Play className="h-3 w-3" />
                                执行
                              </button>
                            </div>
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        {/* 非编辑态 & 无自定义图：左侧 emoji 占位 */}
                        <button
                          onClick={(e) => { e.stopPropagation(); handlePickImage(skill.id); }}
                          onPaste={(e) => handleCardPaste(e, skill.id)}
                          className="group relative -my-4 -ml-4 flex w-14 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-l-2xl bg-gradient-to-br from-indigo-50 to-violet-50 text-2xl select-none hover:ring-2 hover:ring-indigo-300"
                          title="点击上传图片，或 Ctrl+V / 拖入图片"
                        >
                          {currentIcon}
                          <span className="absolute inset-0 flex items-center justify-center bg-slate-900/50 text-white opacity-0 transition-opacity group-hover:opacity-100">
                            <ImagePlus className="h-5 w-5" />
                          </span>
                        </button>
                        <div className="flex min-w-0 flex-1 flex-col py-0.5">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-display text-lg font-semibold tracking-tight text-slate-900">{skill.name}</span>
                            <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${modeInfo.color}`}>
                              {modeInfo.label}
                            </span>
                          </div>
                          <div className="mt-1.5 flex-1">
                            {skill.description ? (
                              <p className="line-clamp-2 break-words text-[13px] leading-relaxed text-slate-500">{skill.description}</p>
                            ) : null}
                          </div>
                          <div className="mt-2 flex items-end justify-between gap-2">
                            <div className="flex items-center gap-2 text-[12px] text-slate-400">
                              <span>{stepCount} 步</span>
                              <span>·</span>
                              <span>{new Date(skill.updatedAt || skill.createdAt).toLocaleDateString("zh-CN")}</span>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                onClick={(e) => { e.stopPropagation(); startEdit(skill); }}
                                className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                                title="编辑标题、介绍和图标"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDelete(skill.id); }}
                                className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                                title="删除"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); onEditFlow?.(skill); }}
                                className="flex h-7 items-center gap-1 rounded-lg bg-violet-50 px-2 text-[11px] font-medium text-violet-700 ring-1 ring-violet-200 transition-all hover:bg-violet-100"
                                title="打开流程图编辑器"
                              >
                                <GitBranch className="h-3 w-3" />
                                流程
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); onRunSkill(skill); }}
                                className="flex h-7 items-center gap-1 rounded-lg bg-brand-600 px-2.5 text-[11px] font-medium text-white shadow-sm transition-all hover:bg-brand-700"
                                title="批量执行此循环"
                              >
                                <Play className="h-3 w-3" />
                                执行
                              </button>
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
    </div>
  );
}

export { SKILL_DRAG_MIME };
