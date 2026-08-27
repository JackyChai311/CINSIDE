import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ClipboardEvent, type ChangeEvent } from "react";
import { Check, Play, Pencil, Trash2, X, Sparkles, GitBranch, ImagePlus, Search, Layers, Share2, KeyRound, Copy, Download, Loader2, Wifi, WifiOff, RefreshCw, FolderOpen, FolderPlus, CheckSquare, Globe, FileSpreadsheet } from "lucide-react";
import type { WorkflowTemplate, AppMode } from "../types";
import { loadSkills, deleteSkill, updateSkillMeta, setSkillsGroup, listSkillGroups, getDefaultIcons, importSkill, frameAlignedTemplate } from "../lib/skills";
import { groupPaneSnapshot, originColorClass } from "../lib/paneLinks";
import { encodeShareCode, decodeShareCode } from "../lib/skillShare";
import { api } from "../api/client";

interface SkillPanelProps {
  open: boolean;
  onClose: () => void;
  onRunSkill: (tpl: WorkflowTemplate) => void;
  onEditFlow?: (tpl: WorkflowTemplate) => void;
  onSkillsChange?: () => void;
  /** 会话左右互换状态：布局标签按当前物理帧显示（模板帧不一致时镜像文字） */
  layoutFlipped?: boolean;
  /** 应用模式：显示"应用"按钮替代"执行"，点击后将模板步骤加载到当前设置 */
  applyMode?: boolean;
  /** 应用模式下点击"应用"按钮的回调 */
  onApplySkill?: (tpl: WorkflowTemplate) => void;
}

const MODE_LABELS: Record<AppMode, { label: string; color: string }> = {
  loop: { label: "全流程", color: "bg-slate-100 text-slate-600" },
  review: { label: "审查", color: "bg-slate-100 text-slate-600" },
  entry: { label: "录入", color: "bg-slate-100 text-slate-600" },
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

export default function SkillPanel({ open, onClose, onRunSkill, onEditFlow, onSkillsChange, applyMode, onApplySkill, layoutFlipped = false }: SkillPanelProps) {
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

  // 分享码状态
  const [shareSkill, setShareSkill] = useState<WorkflowTemplate | null>(null);
  const [shareCode, setShareCode] = useState("");
  const [shareEncoding, setShareEncoding] = useState(false);
  const [shareError, setShareError] = useState("");
  const [shareCopied, setShareCopied] = useState(false);
  const [shareMode, setShareMode] = useState<"online" | "offline">("online");
  const [shareOnlineCode, setShareOnlineCode] = useState("");
  const [shareOfflineCode, setShareOfflineCode] = useState("");
  const [shareOnlineError, setShareOnlineError] = useState("");
  // 导入码状态
  const [importOpen, setImportOpen] = useState(false);
  const [importCode, setImportCode] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importSuccess, setImportSuccess] = useState("");

  // 刷新按钮的旋转反馈
  const [refreshSpin, setRefreshSpin] = useState(false);

  // 批量分组模式：勾选多个 LOOP 归入同一个 GROUP
  const [groupSelectMode, setGroupSelectMode] = useState(false);
  const [groupSelIds, setGroupSelIds] = useState<Set<string>>(new Set());
  const [newGroupName, setNewGroupName] = useState("");
  const [showNewGroupInput, setShowNewGroupInput] = useState(false);

  const toggleGroupSelectMode = () => {
    setGroupSelectMode((v) => !v);
    setGroupSelIds(new Set());
    setShowNewGroupInput(false);
    setNewGroupName("");
  };

  const toggleGroupSel = (id: string) => {
    setGroupSelIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applyGroup = (group: string | null) => {
    if (groupSelIds.size === 0) return;
    setSkillsGroup(Array.from(groupSelIds), group);
    refresh();
    toggleGroupSelectMode();
  };

  const refresh = () => {
    setSkills(loadSkills());
    onSkillsChange?.();
  };

  const handleManualRefresh = () => {
    refresh();
    setRefreshSpin(true);
    setTimeout(() => setRefreshSpin(false), 600);
  };

  // 面板打开时重新读取技能列表，保证刚保存的卡片立即可见
  useEffect(() => {
    if (open) {
      setSkills(loadSkills());
    }
  }, [open]);

  const handleDelete = (id: string) => {
    deleteSkill(id);
    refresh();
  };

  const handleShare = async (skill: WorkflowTemplate) => {
    setShareSkill(skill);
    setShareCode("");
    setShareError("");
    setShareCopied(false);
    setShareOnlineCode("");
    setShareOfflineCode("");
    setShareOnlineError("");
    setShareMode("online");
    setShareEncoding(true);

    // 同时发起：GitHub 联网短码 + 离线码（离线码作为兜底，立即可用）
    const offlinePromise = encodeShareCode(skill).then((code) => {
      setShareOfflineCode(code);
      return code;
    }).catch(() => "");

    try {
      const resp = await api.createShare(skill);
      if (resp.ok && resp.code) {
        setShareOnlineCode(resp.code);
        setShareCode(resp.code);
      } else {
        setShareOnlineError(resp.error || "联网分享不可用");
        setShareMode("offline");
      }
    } catch (e: any) {
      setShareOnlineError(e?.message || "联网分享失败");
      setShareMode("offline");
    }

    try {
      const offline = await offlinePromise;
      if (!shareOnlineCode) {
        setShareCode(offline);
      }
    } catch {
      // 离线码也失败才报错
      if (!shareOnlineCode) {
        setShareError("生成分享码失败");
      }
    } finally {
      setShareEncoding(false);
    }
  };

  const switchShareMode = (mode: "online" | "offline") => {
    setShareMode(mode);
    setShareCode(mode === "online" ? shareOnlineCode : shareOfflineCode);
    setShareCopied(false);
  };

  const handleCopyCode = async () => {
    if (!shareCode) return;
    try {
      await navigator.clipboard.writeText(shareCode);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      const ta = document.getElementById("share-code-area") as HTMLTextAreaElement | null;
      ta?.select();
      document.execCommand("copy");
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    }
  };

  const closeShare = () => {
    setShareSkill(null);
    setShareCode("");
    setShareError("");
    setShareCopied(false);
    setShareOnlineCode("");
    setShareOfflineCode("");
    setShareOnlineError("");
  };

  const openImport = () => {
    setImportOpen(true);
    setImportCode("");
    setImportError("");
    setImportSuccess("");
  };

  const buildTemplateFromShareData = (data: any): WorkflowTemplate => {
    const now = Date.now();
    return {
      id: `tpl_${now}_${Math.random().toString(36).slice(2, 8)}`,
      name: String(data?.name || "未命名模板"),
      description: data?.description,
      icon: data?.icon,
      iconImage: data?.iconImage,
      createdAt: now,
      updatedAt: now,
      mode: data?.mode || "loop",
      dataSourceMarks: Array.isArray(data?.dataSourceMarks) ? data.dataSourceMarks : [],
      reviewMarks: Array.isArray(data?.reviewMarks) ? data.reviewMarks : [],
      entryMarks: Array.isArray(data?.entryMarks) ? data.entryMarks : [],
      mappings: Array.isArray(data?.mappings) ? data.mappings : undefined,
      customTextEntries: Array.isArray(data?.customTextEntries) ? data.customTextEntries : undefined,
      flowGraph: data?.flowGraph,
      hasSearchSteps: !!data?.hasSearchSteps,
      hasSubmitStep: !!data?.hasSubmitStep,
    };
  };

  const handleImport = async () => {
    const code = importCode.trim();
    if (!code) {
      setImportError("请粘贴分享码");
      return;
    }
    setImporting(true);
    setImportError("");
    setImportSuccess("");
    try {
      let template: WorkflowTemplate | null = null;

      // CSG: 开头 = GitHub 联网短码
      if (code.toUpperCase().startsWith("CSG:")) {
        const resp = await api.fetchShare(code);
        if (!resp.ok || !resp.template) {
          setImportError(resp.error || "获取分享失败");
          return;
        }
        template = buildTemplateFromShareData(resp.template);
      } else if (code.toUpperCase().startsWith("CSL1:")) {
        // CSL1: 开头 = 离线 base64 码
        const result = await decodeShareCode(code);
        if (!result.ok || !result.template) {
          setImportError(result.error || "解析分享码失败");
          return;
        }
        template = result.template;
      } else if (/^[0-9a-f]{20,}$/i.test(code)) {
        // 纯 hex（gist ID），尝试联网获取
        const resp = await api.fetchShare(`CSG:${code}`);
        if (resp.ok && resp.template) {
          template = buildTemplateFromShareData(resp.template);
        } else {
          setImportError(resp.error || "未找到该分享码对应的卡片");
          return;
        }
      } else {
        setImportError("无法识别的分享码格式（应以 CSG: 或 CSL1: 开头）");
        return;
      }

      if (template) {
        importSkill(template);
        refresh();
        setImportSuccess(`已导入：${template.name}`);
        setTimeout(() => {
          setImportOpen(false);
          setImportCode("");
          setImportSuccess("");
        }, 1200);
      }
    } catch (e: any) {
      setImportError(e?.message || "导入失败");
    } finally {
      setImporting(false);
    }
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

  // 按 GROUP 分节：同组放一起（带标题），未分组的排在最后另起一行（无标题）
  const skillSections = useMemo(() => {
    const gmap = new Map<string, WorkflowTemplate[]>();
    const ungrouped: WorkflowTemplate[] = [];
    for (const s of filteredSkills) {
      const g = s.group?.trim();
      if (g) {
        if (!gmap.has(g)) gmap.set(g, []);
        gmap.get(g)!.push(s);
      } else {
        ungrouped.push(s);
      }
    }
    const secs: { key: string; title: string | null; items: WorkflowTemplate[] }[] = Array.from(gmap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, items]) => ({ key: `g:${name}`, title: name, items }));
    if (ungrouped.length > 0) secs.push({ key: "ungrouped", title: null, items: ungrouped });
    return secs;
  }, [filteredSkills]);

  // 布局说明：从模板拾取标记推导左右两侧各是网页还是 Excel（按当前互换帧对齐，互换后标签跟着翻转）
  const layoutOf = (t: WorkflowTemplate): string => {
    const all = [...(t.dataSourceMarks || []), ...(t.reviewMarks || []), ...(t.entryMarks || [])];
    const excelSide0 = all.find((m) => m.source === "excel")?.side;
    const excelSide = ((t.flipped ?? false) !== layoutFlipped && excelSide0)
      ? (excelSide0 === "left" ? "right" : "left")
      : excelSide0;
    if (excelSide === "left") return "左Excel · 右网页";
    if (excelSide === "right") return "左网页 · 右Excel";
    const webSide0 = all.find((m) => m.source === "web")?.side;
    const webSide = ((t.flipped ?? false) !== layoutFlipped && webSide0)
      ? (webSide0 === "left" ? "right" : "left")
      : webSide0;
    if (webSide === "left") return "仅左侧网页";
    if (webSide === "right") return "仅右侧网页";
    return "";
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md" onClick={onClose}>
      <div
        className="skill-panel-root w-[min(960px,calc(100vw-2rem))] max-h-[86vh] overflow-hidden rounded-3xl glass-strong shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：标题 + 搜索栏 */}
        <div className="relative border-b border-slate-200 bg-white/70 px-6 pt-5 pb-5 dark:border-white/10 dark:bg-transparent">
          <div className="relative flex items-center gap-3.5">
            <div className="relative flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-900 text-white dark:bg-white dark:text-slate-900">
              {applyMode ? <Layers className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-bold tracking-tight text-slate-800 dark:text-slate-100">{applyMode ? "应用 LOOP 模板" : "循环管理"}</h2>
              <p className="mt-0.5 text-[12px] text-slate-500 dark:text-slate-400">
                {applyMode
                  ? `${skills.length} 个模板 · 选择一个将其步骤加载到当前设置`
                  : `${skills.length} 个技能 · 拖拽到人物卡片可单卡执行 · Ctrl+V / 拖入图片换图标`}
              </p>
            </div>
            <button
              onClick={handleManualRefresh}
              className="ml-auto flex h-9 items-center gap-1.5 rounded-xl bg-white/60 px-3 text-[12px] font-medium text-slate-600 shadow-sm ring-1 ring-slate-200 backdrop-blur-sm transition-all hover:bg-white hover:text-slate-900 dark:bg-slate-900/40 dark:text-slate-300 dark:ring-white/5 dark:hover:bg-slate-800/60 dark:hover:text-slate-100"
              title="刷新技能列表"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshSpin ? "animate-spin" : ""}`} />
              刷新
            </button>
            {!applyMode && (
              <button
                onClick={toggleGroupSelectMode}
                className={[
                  "flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-medium shadow-sm ring-1 backdrop-blur-sm transition-all",
                  groupSelectMode
                    ? "bg-indigo-600 text-white ring-indigo-500 hover:bg-indigo-700"
                    : "bg-white/60 text-slate-600 ring-slate-200 hover:bg-white hover:text-slate-900 dark:bg-slate-900/40 dark:text-slate-300 dark:ring-white/5 dark:hover:bg-slate-800/60 dark:hover:text-slate-100",
                ].join(" ")}
                title="批量选择 LOOP 归入同一个 GROUP 分组"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {groupSelectMode ? "退出分组" : "分组"}
              </button>
            )}
            <button
              onClick={openImport}
              className="flex items-center gap-1.5 rounded-xl bg-white/60 px-3 py-2 text-[12px] font-medium text-slate-600 shadow-sm ring-1 ring-slate-200 backdrop-blur-sm transition-all hover:bg-white hover:text-slate-900 dark:bg-slate-900/40 dark:text-slate-300 dark:ring-white/5 dark:hover:bg-slate-800/60 dark:hover:text-slate-100"
              title="输入分享密钥导入 LOOP 卡片"
            >
              <KeyRound className="h-3.5 w-3.5" />
              导入密钥
            </button>
            <button
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-full text-slate-400 transition-all hover:bg-white/10 hover:text-slate-600 dark:hover:text-slate-200"
              title="关闭"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          {/* 搜索框 */}
          <div className="relative mt-4">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索技能名称或介绍…"
              className="w-full rounded-xl border border-slate-200 bg-white/60 py-2.5 pl-10 pr-10 text-[13px] text-slate-700 dark:text-slate-200 shadow-sm outline-none backdrop-blur-sm transition placeholder:text-slate-400 focus:border-slate-400 focus:bg-white/80 focus:ring-2 focus:ring-slate-200 dark:bg-slate-900/40 dark:border-white/5 dark:focus:bg-slate-900/60"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-300"
                title="清空搜索"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* 批量分组操作栏 */}
        {groupSelectMode && (
          <div className="shrink-0 border-b border-indigo-100 bg-indigo-50/60 px-5 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-indigo-700">
                <CheckSquare className="h-3.5 w-3.5" />
                已选 {groupSelIds.size} 个 LOOP
              </span>
              <span className="h-4 w-px bg-indigo-200" />
              <span className="text-[11px] text-slate-500">归入：</span>
              {listSkillGroups().map((g) => (
                <button
                  key={g}
                  onClick={() => applyGroup(g)}
                  disabled={groupSelIds.size === 0}
                  className="rounded-lg bg-white px-2.5 py-1 text-[11px] font-medium text-indigo-700 ring-1 ring-indigo-200 transition-all hover:bg-indigo-600 hover:text-white disabled:opacity-40"
                  title={`将选中的 ${groupSelIds.size} 个 LOOP 归入分组「${g}」`}
                >
                  {g}
                </button>
              ))}
              {showNewGroupInput ? (
                <span className="flex items-center gap-1.5">
                  <input
                    autoFocus
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newGroupName.trim()) applyGroup(newGroupName.trim());
                      if (e.key === "Escape") { setShowNewGroupInput(false); setNewGroupName(""); }
                    }}
                    placeholder="输入新分组名"
                    className="w-36 rounded-lg border border-indigo-300 px-2.5 py-1 text-[12px] focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200"
                  />
                  <button
                    onClick={() => { if (newGroupName.trim()) applyGroup(newGroupName.trim()); }}
                    disabled={!newGroupName.trim() || groupSelIds.size === 0}
                    className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
                  >
                    确定
                  </button>
                  <button
                    onClick={() => { setShowNewGroupInput(false); setNewGroupName(""); }}
                    className="rounded-lg px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-200/60"
                  >
                    取消
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setShowNewGroupInput(true)}
                  disabled={groupSelIds.size === 0}
                  className="flex items-center gap-1 rounded-lg border border-dashed border-indigo-300 px-2.5 py-1 text-[11px] font-medium text-indigo-600 transition-all hover:bg-white disabled:opacity-40"
                  title="新建分组并把选中的 LOOP 归入"
                >
                  <FolderPlus className="h-3.5 w-3.5" /> 新建分组
                </button>
              )}
              <span className="h-4 w-px bg-indigo-200" />
              <button
                onClick={() => applyGroup(null)}
                disabled={groupSelIds.size === 0}
                className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-500 transition-all hover:bg-white hover:text-rose-600 disabled:opacity-40"
                title="把选中的 LOOP 移出当前分组"
              >
                移出分组
              </button>
              <button
                onClick={toggleGroupSelectMode}
                className="ml-auto rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-500 transition-all hover:bg-white"
              >
                完成
              </button>
            </div>
          </div>
        )}

        <div className="max-h-[calc(86vh-150px)] overflow-y-auto bg-slate-50 p-5 scrollbar-thin dark:bg-slate-900/60">
          {filteredSkills.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              {keyword ? (
                <>
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 dark:bg-white/5">
                    <Search className="h-7 w-7 text-slate-300 dark:text-slate-600" />
                  </div>
                  <p className="text-sm font-medium text-slate-500 dark:text-slate-400">没有找到匹配 "{search}" 的技能</p>
                  <p className="mt-1.5 text-[12px] text-slate-400 dark:text-slate-500">换个关键词试试，或清空搜索查看全部</p>
                </>
              ) : (
                <>
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 dark:bg-white/5">
                    <Sparkles className="h-7 w-7 text-slate-400" />
                  </div>
                  <p className="text-sm font-medium text-slate-500 dark:text-slate-400">还没有保存任何技能</p>
                  <p className="mt-1.5 text-[12px] text-slate-400 dark:text-slate-500">配置好步骤后，点「保存为技能」即可复用</p>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-5">
              {skillSections.map((sec) => (
                <div key={sec.key}>
                  {sec.title && (
                    <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
                      <FolderOpen className="h-3.5 w-3.5 text-indigo-500" />
                      <span className="text-[12px] font-semibold text-indigo-600 dark:text-indigo-300">{sec.title}</span>
                      <span className="text-[10px] text-slate-400">{sec.items.length} 个LOOP</span>
                      {(() => {
                        const labels = Array.from(new Set(sec.items.map(layoutOf).filter(Boolean)));
                        const label = labels.length === 1 ? labels[0] : labels.length > 1 ? "混合布局" : "";
                        if (!label) return null;
                        return (
                          <span
                            className="flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-white/5 dark:text-slate-400"
                            title="该组 LOOP 的面板布局（左侧 · 右侧）"
                          >
                            {label}
                          </span>
                        );
                      })()}
                      {(() => {
                        // GROUP 两侧面板标识：网页侧配色显示网页名（运行前校验网页名对不对），Excel 侧显示具体 Excel 文件名
                        const raw = groupPaneSnapshot(sec.items);
                        if (!raw || (!raw.left && !raw.right)) return null;
                        const gFlip = (sec.items[0]?.flipped ?? false) !== layoutFlipped;
                        const panes = { left: gFlip ? raw.right : raw.left, right: gFlip ? raw.left : raw.right };
                        return (
                          <span className="flex flex-wrap items-center gap-1" title="该 GROUP 绑定的两侧面板：运行 LOOP 前会校验网页是否已打开、左右是否反了">
                            {(["left", "right"] as const).map((side) => {
                              const p = panes[side];
                              if (!p) return null;
                              if (p.kind === "web" && p.origin) {
                                return (
                                  <span key={side} className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${originColorClass(p.origin)}`} title={`GROUP 网页：${p.label}（${side === "left" ? "左" : "右"}侧）· 运行前校验已打开`}>
                                    <Globe className="h-2.5 w-2.5 shrink-0" />
                                    <span className="max-w-[130px] truncate">{p.label}</span>
                                  </span>
                                );
                              }
                              return (
                                <span key={side} className="flex items-center gap-1 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30" title={`GROUP Excel：${p.label}（${side === "left" ? "左" : "右"}侧）`}>
                                  <FileSpreadsheet className="h-2.5 w-2.5 shrink-0" />
                                  <span className="max-w-[130px] truncate">{p.label}</span>
                                </span>
                              );
                            })}
                          </span>
                        );
                      })()}
                      <div className="ml-2 h-px min-w-4 flex-1 bg-slate-200/80 dark:bg-white/5" />
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {sec.items.map((skill) => {
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
                      "group relative flex items-stretch gap-3 overflow-hidden rounded-2xl border bg-white/70 p-0 shadow-sm backdrop-blur-sm transition-all duration-200",
                      "dark:bg-slate-800/40 dark:border-white/5",
                      isEditing
                        ? "border-slate-300 ring-2 ring-slate-300/60 items-center dark:border-slate-500/40 dark:ring-slate-500/20"
                        : applyMode
                          ? "border-slate-200/60 hover:border-slate-300 hover:shadow-lg hover:shadow-slate-900/5 hover:-translate-y-0.5 dark:border-white/5 dark:hover:border-white/20 dark:hover:shadow-black/20 cursor-pointer"
                          : "border-slate-200/60 hover:border-slate-300 hover:shadow-lg hover:shadow-slate-900/5 hover:-translate-y-0.5 dark:border-white/5 dark:hover:border-white/20 dark:hover:shadow-black/20",
                      !isEditing && !applyMode && "cursor-grab active:cursor-grabbing",
                      isImgDragOver && !isEditing ? "ring-2 ring-slate-400/60 border-slate-400/60" : "",
                      groupSelectMode && groupSelIds.has(skill.id) ? "ring-2 ring-indigo-500 border-indigo-400 dark:ring-indigo-400" : "",
                      groupSelectMode && !isEditing ? "cursor-pointer" : "",
                    ].filter(Boolean).join(" ")}
                    draggable={!isEditing && !applyMode && !groupSelectMode}
                    onClick={() => { if (groupSelectMode && !isEditing) toggleGroupSel(skill.id); }}
                    onDragStart={(e) => !isEditing && !applyMode && !groupSelectMode && handleDragStart(e, skill)}
                    onDragOver={(e) => !applyMode && handleCardDragOver(e, skill.id)}
                    onDragLeave={(e) => !applyMode && handleCardDragLeave(e, skill.id)}
                    onDrop={(e) => !applyMode && handleCardDrop(e, skill.id)}
                    onPaste={(e) => handleCardPaste(e, skill.id)}
                    onDoubleClick={() => { if (applyMode && !isEditing && onApplySkill) { onApplySkill(skill); } }}
                    tabIndex={0}
                  >
                    {/* 分组选择模式：右上角勾选指示 */}
                    {groupSelectMode && !isEditing && (
                      <div
                        className={[
                          "absolute right-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border transition-all",
                          groupSelIds.has(skill.id)
                            ? "border-indigo-600 bg-indigo-600 text-white"
                            : "border-slate-300 bg-white/80 text-transparent",
                        ].join(" ")}
                      >
                        <Check className="h-3 w-3" />
                      </div>
                    )}
                    {/* 左侧自定义图标图片（非编辑态 + 有图） */}
                    {!isEditing && currentIconImage ? (
                      <div className="relative -my-0 -ml-0 w-24 shrink-0 overflow-hidden rounded-l-2xl">
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
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-white/10 dark:to-slate-900/20" />
                        <button
                          onClick={(e) => { e.stopPropagation(); clearSkillIconImage(skill.id); }}
                          className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-slate-900/60 text-white backdrop-blur-sm transition-all hover:bg-rose-500 opacity-0 group-hover:opacity-100"
                          title="移除图片图标"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ) : null}

                    {isEditing ? (
                      <>
                        {/* 编辑态：图标预览区 */}
                        <div
                          className="relative h-12 w-14 shrink-0 overflow-hidden rounded-xl m-4"
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
                                className="h-full w-full object-cover rounded-xl"
                              />
                              <button
                                onClick={(e) => { e.stopPropagation(); setEditIconImage(null); }}
                                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-slate-900/70 text-white hover:bg-rose-500 backdrop-blur-sm"
                                title="移除图片"
                              >
                                <X className="h-2.5 w-2.5" />
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => setShowIconPicker(!showIconPicker)}
                              className="flex h-full w-full items-center justify-center rounded-xl bg-slate-50 text-2xl hover:bg-slate-100 dark:bg-white/5 dark:hover:bg-white/10 transition-all"
                            >
                              {editIcon}
                            </button>
                          )}
                        </div>
                        <div className="flex-1 py-4 pr-2">
                          <input
                            autoFocus
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }}
                            className="w-full rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900/50 px-3 py-1.5 text-sm font-medium text-slate-800 dark:text-slate-200 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200 transition-all"
                          />
                          <textarea
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value.slice(0, 80))}
                            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); } if (e.key === "Escape") cancelEdit(); }}
                            rows={2}
                            maxLength={80}
                            placeholder="填写介绍（最多80字）"
                            className="mt-2 w-full resize-none rounded-lg border border-slate-200 dark:border-white/10 bg-white/50 dark:bg-slate-900/30 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200 transition-all"
                          />
                          <div className={`mt-1 text-right text-[10px] ${editDesc.length >= 80 ? "text-rose-500" : "text-slate-400"}`}>
                            {editDesc.length}/80
                          </div>
                          {showIconPicker && !editIconImage && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {getDefaultIcons().map((ic) => (
                                <button
                                  key={ic}
                                  onClick={() => { setEditIcon(ic); setShowIconPicker(false); }}
                                  className={`flex h-9 w-9 items-center justify-center rounded-lg text-xl transition-all ${editIcon === ic ? "bg-slate-200 dark:bg-white/10 ring-2 ring-slate-400" : "bg-slate-50 dark:bg-white/5 hover:bg-slate-100 dark:hover:bg-white/10"}`}
                                >
                                  {ic}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col gap-1 pr-3 py-4">
                          <button
                            onClick={saveEdit}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                          <button
                            onClick={cancelEdit}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </>
                    ) : currentIconImage ? (
                      /* 有图非编辑态 */
                      <>
                        <div className="flex min-w-0 flex-1 flex-col py-4 pr-4 pl-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-[18px] font-bold tracking-tight text-slate-800 dark:text-slate-100">{skill.name}</span>
                            <span className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold ${modeInfo.color} dark:bg-opacity-20 dark:text-opacity-90`}>
                              {modeInfo.label}
                            </span>
                            {skill.group?.trim() && (
                              <span className="shrink-0 rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300" title={`分组：${skill.group.trim()}`}>
                                {skill.group.trim()}
                              </span>
                            )}
                          </div>
                          <div className="mt-2 flex-1">
                            {skill.description ? (
                              <p className="line-clamp-2 break-words text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">{skill.description}</p>
                            ) : null}
                          </div>
                          <div className="mt-3 flex items-end justify-between gap-2">
                            <div className="flex items-center gap-2 text-[12px] text-slate-400 dark:text-slate-500">
                              <span className="font-medium">{stepCount} 步</span>
                              <span className="opacity-50">·</span>
                              <span>{new Date(skill.updatedAt || skill.createdAt).toLocaleDateString("zh-CN")}</span>
                            </div>
                            <div className={`flex shrink-0 items-center gap-1 ${groupSelectMode ? "pointer-events-none opacity-40" : ""}`}>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleShare(skill); }}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-all hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-300 opacity-70 group-hover:opacity-100"
                                title="生成分享密钥"
                              >
                                <Share2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); startEdit(skill); }}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-all hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-300 opacity-70 group-hover:opacity-100"
                                title="编辑"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDelete(skill.id); }}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-all hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-500/10 dark:hover:text-rose-400 opacity-70 group-hover:opacity-100"
                                title="删除"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); onEditFlow?.(skill); }}
                                className="flex h-8 items-center gap-1.5 rounded-lg bg-white/70 dark:bg-white/5 px-2.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 ring-1 ring-slate-200 dark:ring-white/10 transition-all hover:bg-slate-100 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-slate-100"
                                title="编辑流程"
                              >
                                <GitBranch className="h-3 w-3" />
                                流程
                              </button>
                              {applyMode ? (
                                <button
                                  onClick={(e) => { e.stopPropagation(); onApplySkill?.(skill); }}
                                  className="flex h-8 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-[11px] font-semibold text-white shadow-sm transition-all hover:bg-slate-700 active:scale-95"
                                  title="应用此模板的步骤到当前设置"
                                >
                                  <Layers className="h-3 w-3" />
                                  应用
                                </button>
                              ) : (
                                <button
                                  onClick={(e) => { e.stopPropagation(); onRunSkill(skill); }}
                                  className="flex h-8 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-[11px] font-semibold text-white shadow-sm transition-all hover:bg-slate-700 active:scale-95"
                                  title="执行"
                                >
                                  <Play className="h-3 w-3 fill-current" />
                                  执行
                                </button>
                              )}
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
                          className="group/ico relative -my-0 -ml-0 flex w-20 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-l-2xl bg-slate-50 dark:bg-white/5 text-3xl select-none transition-all hover:bg-slate-100 dark:hover:bg-white/10"
                          title="点击上传图片"
                        >
                          <div className="relative z-10 transition-transform group-hover/ico:scale-110">{currentIcon}</div>
                          <div className="absolute inset-0 bg-gradient-to-t from-black/0 via-black/0 to-black/0 group-hover/ico:from-black/10 group-hover/ico:via-black/0 group-hover/ico:to-black/0 transition-all" />
                          <span className="absolute inset-0 flex items-center justify-center bg-slate-900/60 text-white opacity-0 transition-all group-hover/ico:opacity-100 backdrop-blur-sm">
                            <ImagePlus className="h-5 w-5" />
                          </span>
                        </button>
                        <div className="flex min-w-0 flex-1 flex-col py-4 pr-4">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[17px] font-bold tracking-tight text-slate-800 dark:text-slate-100">{skill.name}</span>
                            <span className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold ${modeInfo.color} dark:bg-opacity-20 dark:text-opacity-90`}>
                              {modeInfo.label}
                            </span>
                            {skill.group?.trim() && (
                              <span className="shrink-0 rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300" title={`分组：${skill.group.trim()}`}>
                                {skill.group.trim()}
                              </span>
                            )}
                          </div>
                          <div className="mt-1.5 flex-1">
                            {skill.description ? (
                              <p className="line-clamp-2 break-words text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">{skill.description}</p>
                            ) : null}
                          </div>
                          <div className="mt-3 flex items-end justify-between gap-2">
                            <div className="flex items-center gap-2 text-[12px] text-slate-400 dark:text-slate-500">
                              <span className="font-medium">{stepCount} 步</span>
                              <span className="opacity-50">·</span>
                              <span>{new Date(skill.updatedAt || skill.createdAt).toLocaleDateString("zh-CN")}</span>
                            </div>
                            <div className={`flex shrink-0 items-center gap-1 ${groupSelectMode ? "pointer-events-none opacity-40" : ""}`}>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleShare(skill); }}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-all hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-300 opacity-70 group-hover:opacity-100"
                                title="生成分享密钥"
                              >
                                <Share2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); startEdit(skill); }}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-all hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-300 opacity-70 group-hover:opacity-100"
                                title="编辑"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDelete(skill.id); }}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-all hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-500/10 dark:hover:text-rose-400 opacity-70 group-hover:opacity-100"
                                title="删除"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); onEditFlow?.(skill); }}
                                className="flex h-8 items-center gap-1.5 rounded-lg bg-white/70 dark:bg-white/5 px-2.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 ring-1 ring-slate-200 dark:ring-white/10 transition-all hover:bg-slate-100 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-slate-100"
                                title="编辑流程"
                              >
                                <GitBranch className="h-3 w-3" />
                                流程
                              </button>
                              {applyMode ? (
                                <button
                                  onClick={(e) => { e.stopPropagation(); onApplySkill?.(skill); }}
                                  className="flex h-8 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-[11px] font-semibold text-white shadow-sm transition-all hover:bg-slate-700 active:scale-95"
                                  title="应用此模板的步骤到当前设置"
                                >
                                  <Layers className="h-3 w-3" />
                                  应用
                                </button>
                              ) : (
                                <button
                                  onClick={(e) => { e.stopPropagation(); onRunSkill(skill); }}
                                  className="flex h-8 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-[11px] font-semibold text-white shadow-sm transition-all hover:bg-slate-700 active:scale-95"
                                  title="执行"
                                >
                                  <Play className="h-3 w-3 fill-current" />
                                  执行
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
                  </div>
                </div>
              ))}
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

      {/* 分享密钥模态框 */}
      {shareSkill && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={closeShare}
        >
          <div
            className="w-[min(560px,calc(100vw-2rem))] rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white dark:bg-white dark:text-slate-900">
                <Share2 className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">分享 LOOP 卡片</h3>
                <p className="mt-0.5 text-[12px] text-slate-500 dark:text-slate-400">
                  将下方密钥发给他人，对方在「导入密钥」中粘贴即可获得「{shareSkill.name}」
                </p>
              </div>
              <button
                onClick={closeShare}
                className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4">
              {shareEncoding ? (
                <div className="flex items-center justify-center gap-2 rounded-xl bg-slate-50 py-8 text-[13px] text-slate-400 dark:bg-slate-900/40">
                  <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
                  正在生成分享密钥…
                </div>
              ) : shareError ? (
                <div className="rounded-xl bg-rose-50 py-6 text-center text-[13px] text-rose-600 dark:bg-rose-500/10 dark:text-rose-400">
                  {shareError}
                </div>
              ) : (
                <>
                  {/* 在线/离线切换 */}
                  {(shareOnlineCode || shareOnlineError) && shareOfflineCode && (
                    <div className="mb-3 flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-900/50">
                      <button
                        onClick={() => switchShareMode("online")}
                        disabled={!shareOnlineCode}
                        className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-all ${
                          shareMode === "online"
                            ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100"
                            : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                        } ${!shareOnlineCode ? "cursor-not-allowed opacity-40" : ""}`}
                      >
                        <Wifi className="h-3.5 w-3.5" />
                        联网短码
                      </button>
                      <button
                        onClick={() => switchShareMode("offline")}
                        className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-all ${
                          shareMode === "offline"
                            ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100"
                            : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                        }`}
                      >
                        <WifiOff className="h-3.5 w-3.5" />
                        离线码
                      </button>
                    </div>
                  )}

                  {shareMode === "online" && shareOnlineError && !shareOnlineCode && (
                    <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                      联网分享不可用：{shareOnlineError}
                    </div>
                  )}

                  {shareMode === "online" && shareOnlineCode && (
                    <div className="mb-2 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                      <Wifi className="h-3 w-3" />
                      联网短码 · 对方只需联网即可导入，无需其他配置
                    </div>
                  )}
                  {shareMode === "offline" && (
                    <div className="mb-2 flex items-center gap-1.5 text-[11px] text-slate-400">
                      <WifiOff className="h-3 w-3" />
                      离线码 · 无需联网，但密钥较长
                    </div>
                  )}

                  <textarea
                    id="share-code-area"
                    readOnly
                    value={shareCode}
                    rows={shareMode === "online" ? 2 : 5}
                    className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-700 outline-none dark:border-white/10 dark:bg-slate-900/50 dark:text-slate-300"
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => (e.currentTarget as HTMLTextAreaElement).select()}
                  />
                  <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
                    <span>
                      {shareMode === "online" ? `短码长度：${shareCode.length} 字符` : `密钥长度：${(shareCode.length / 1024).toFixed(1)} KB`}
                    </span>
                    <span>已自动剥离本地文件内容</span>
                  </div>
                  <button
                    onClick={handleCopyCode}
                    className={`mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm transition-all active:scale-[0.98] ${
                      shareCopied
                        ? "bg-emerald-500"
                        : "bg-slate-900 hover:bg-slate-700"
                    }`}
                  >
                    {shareCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {shareCopied ? "已复制到剪贴板" : "复制密钥"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 导入密钥模态框 */}
      {importOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => !importing && setImportOpen(false)}
        >
          <div
            className="w-[min(560px,calc(100vw-2rem))] rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white dark:bg-white dark:text-slate-900">
                <KeyRound className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">导入 LOOP 卡片</h3>
                <p className="mt-0.5 text-[12px] text-slate-500 dark:text-slate-400">
                  粘贴他人分享的密钥（CSG: 联网短码 或 CSL1: 离线码），即可获取 LOOP 卡片
                </p>
              </div>
              <button
                onClick={() => !importing && setImportOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4">
              <textarea
                value={importCode}
                onChange={(e) => { setImportCode(e.target.value); setImportError(""); }}
                placeholder="在此粘贴分享密钥（CSG: 联网短码 或 CSL1: 离线码）…"
                rows={5}
                disabled={importing}
                className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-slate-400 focus:ring-2 focus:ring-slate-200 dark:border-white/10 dark:bg-slate-900/50 dark:text-slate-300 dark:placeholder:text-slate-600"
              />
              {importError && (
                <p className="mt-2 text-[12px] text-rose-500">{importError}</p>
              )}
              {importSuccess && (
                <p className="mt-2 flex items-center gap-1 text-[12px] text-emerald-600 dark:text-emerald-400">
                  <Check className="h-3.5 w-3.5" />
                  {importSuccess}
                </p>
              )}
              <button
                onClick={handleImport}
                disabled={importing || !importCode.trim()}
                className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm transition-all hover:bg-slate-700 active:scale-[0.98] disabled:opacity-50"
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {importing ? "正在导入…" : "导入卡片"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { SKILL_DRAG_MIME };
