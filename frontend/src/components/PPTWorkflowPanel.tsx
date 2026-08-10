import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileText,
  Sparkles,
  Merge,
  CheckCircle2,
  Loader2,
  X,
  AlertCircle,
  RefreshCw,
  Cpu,
  Layers,
  Presentation,
  SendHorizontal,
  Paperclip,
  Bot,
  ChevronRight,
  ChevronDown,
  Type,
  PenLine,
  CheckCheck,
  CircleDot,
  LayoutGrid,
  Minus,
  Square,
  Clapperboard,
  Settings2,
  FolderOpen,
  FolderPlus,
  Bookmark,
} from "lucide-react";
import { api } from "../api/client";
import appIconPng from "../assets/app-icon.png";
import type {
  PPTFileSlides,
  PPTProgressEvent,
  PPTSection,
  PPTTextPatch,
} from "../types";
import {
  ReferenceRail,
  ReferenceLabelModal,
  ReferenceDropOverlay,
  buildReferenceContext,
} from "./ReferenceBookmarks";
import type { ReferenceBookmark, PendingReferenceFile } from "./ReferenceBookmarks";

interface SelectedFile {
  file_path: string;
  file_name: string;
  size: number;
}

// 工作流阶段定义（用于顶部进度条）
type PhaseId = "select" | "analyze" | "sections" | "merge" | "modify" | "apply";
interface PhaseDef {
  id: PhaseId;
  label: string;
  shortLabel: string;
  icon: typeof FileText;
}
const PHASES: PhaseDef[] = [
  { id: "select", label: "选择文件", shortLabel: "选择", icon: FileText },
  { id: "analyze", label: "解析 PPT", shortLabel: "解析", icon: Layers },
  { id: "sections", label: "识别章节", shortLabel: "章节", icon: Type },
  { id: "merge", label: "合并总览", shortLabel: "合并", icon: Merge },
  { id: "modify", label: "AI 修改", shortLabel: "修改", icon: PenLine },
  { id: "apply", label: "回填原 PPT", shortLabel: "回填", icon: CheckCheck },
];

export default function PPTWorkflowPanel({
  onBack,
  onOpenSettings,
}: {
  onBack: () => void;
  onOpenSettings: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 文件选择
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [directoryPath, setDirectoryPath] = useState("");
  const [enabledPaths, setEnabledPaths] = useState<Set<string>>(new Set());
  const [progressMap, setProgressMap] = useState<Record<string, PPTProgressEvent>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [aiInfo, setAiInfo] = useState<{ model: string; configured: boolean } | null>(null);

  // 模式：create=PPT制作（文字新建），batch=批量编辑PPT，video=PPT转视频（暂未实现）
  const [activeMode, setActiveMode] = useState<"create" | "batch" | "video">("create");
  // 按文字新建 PPT
  const [creating, setCreating] = useState(false);
  const [createdResult, setCreatedResult] = useState<{
    file_path: string;
    file_name: string;
    total_slides: number;
  } | null>(null);
  const [createText, setCreateText] = useState("");

  // 解析结果
  const [fileSlides, setFileSlides] = useState<PPTFileSlides[]>([]);

  // 章节
  const [sections, setSections] = useState<PPTSection[]>([]);
  const [readingScript, setReadingScript] = useState("");
  const [detectInstruction, setDetectInstruction] = useState("");
  const [detecting, setDetecting] = useState(false);

  // 合并
  const [merging, setMerging] = useState(false);
  const [mergedResult, setMergedResult] = useState<{
    file_path: string;
    file_name: string;
    total_slides: number;
  } | null>(null);

  // 修改
  const [instruction, setInstruction] = useState("");
  const [patches, setPatches] = useState<PPTTextPatch[]>([]);
  const [modifying, setModifying] = useState(false);

  // 回填
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{
    applied: number;
    failed: number;
    errors: string[];
  } | null>(null);

  // 聊天输入
  const [chatInput, setChatInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [inputFocused, setInputFocused] = useState(false);

  // 顶部「工作文件」下拉菜单
  const [showFileMenu, setShowFileMenu] = useState(false);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showFileMenu) return;
    const onDown = (e: MouseEvent) => {
      if (fileMenuRef.current && !fileMenuRef.current.contains(e.target as Node)) {
        setShowFileMenu(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowFileMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [showFileMenu]);

  // ---- 参考资料书签（拖拽 PPT/PDF 打标签，挂在屏幕左侧供 AI 参考） ----
  const REF_STORAGE_KEY = "cinside_ppt_references_v1";
  const [referenceBookmarks, setReferenceBookmarks] = useState<ReferenceBookmark[]>(() => {
    try {
      const raw = localStorage.getItem(REF_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as ReferenceBookmark[];
      }
    } catch { /* ignore */ }
    return [];
  });
  const [pendingRefFiles, setPendingRefFiles] = useState<PendingReferenceFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);

  // 持久化到 localStorage
  useEffect(() => {
    try {
      localStorage.setItem(REF_STORAGE_KEY, JSON.stringify(referenceBookmarks));
    } catch { /* ignore */ }
  }, [referenceBookmarks]);

  const openReferenceLabelModal = useCallback((files: PendingReferenceFile[]) => {
    if (!files.length) return;
    // 去重：已存在的路径不再重复添加
    setReferenceBookmarks((prev) => {
      const existing = new Set(prev.map((b) => b.file_path));
      const fresh = files.filter((f) => !existing.has(f.file_path));
      if (fresh.length === 0) {
        setError("这些文件已经在参考栏中了");
        return prev;
      }
      setPendingRefFiles(fresh);
      return prev;
    });
  }, []);

  const handleConfirmRefs = useCallback((bookmarks: ReferenceBookmark[]) => {
    setReferenceBookmarks((prev) => [...prev, ...bookmarks]);
    setPendingRefFiles([]);
  }, []);

  const handleRemoveRef = useCallback((id: string) => {
    setReferenceBookmarks((prev) => prev.filter((b) => b.id !== id));
  }, []);

  // 通过文件选择器添加参考文件（左侧栏 + 号）
  const handlePickReferenceFiles = useCallback(async () => {
    try {
      const result = await window.electronAPI?.pickReferenceFiles?.();
      if (result?.canceled || !result?.files?.length) return;
      const pending: PendingReferenceFile[] = result.files
        .filter((f) => /\.(ppt|pptx|pdf)$/i.test(f.file_name))
        .map((f) => ({
          file_name: f.file_name,
          file_path: f.file_path,
          file_type: /\.pdf$/i.test(f.file_name) ? "pdf" : "ppt",
          size: f.size,
        }));
      openReferenceLabelModal(pending);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "选择文件失败");
    }
  }, [openReferenceLabelModal]);

  // 拖拽处理
  const extractDroppedFiles = useCallback((e: React.DragEvent): PendingReferenceFile[] => {
    const items = e.dataTransfer.files;
    if (!items || items.length === 0) return [];
    const pending: PendingReferenceFile[] = [];
    for (let i = 0; i < items.length; i++) {
      const file = items[i];
      const name = file.name || "";
      if (!/\.(ppt|pptx|pdf)$/i.test(name)) continue;
      // Electron：通过 preload 获取真实磁盘路径
      const filePath = window.electronAPI?.getPathForFile?.(file) || (file as unknown as { path?: string }).path || "";
      if (!filePath) continue;
      pending.push({
        file_name: name,
        file_path: filePath,
        file_type: /\.pdf$/i.test(name) ? "pdf" : "ppt",
        size: file.size,
      });
    }
    return pending;
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types?.includes("Files")) return;
    e.preventDefault();
    dragCounter.current += 1;
    setDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types?.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types?.includes("Files")) return;
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types?.includes("Files")) return;
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    const pending = extractDroppedFiles(e);
    if (pending.length === 0) {
      setError("请拖入 PPT / PPTX / PDF 文件作为参考");
      return;
    }
    openReferenceLabelModal(pending);
  }, [extractDroppedFiles, openReferenceLabelModal]);

  // ---- 文件选择 ----
  const handlePickFiles = useCallback(async () => {
    setError(null);
    try {
      const result = await window.electronAPI?.pickPptFiles?.();
      if (result?.canceled || !result?.files?.length) return;
      const newFiles = result.files.filter(
        (f) => !selectedFiles.some((s) => s.file_path === f.file_path)
      );
      setSelectedFiles((prev) => [...prev, ...newFiles]);
      setEnabledPaths((prev) => {
        const next = new Set(prev);
        newFiles.forEach((f) => next.add(f.file_path));
        return next;
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "选择文件失败");
    }
  }, [selectedFiles]);

  const handlePickDirectory = useCallback(async () => {
    setError(null);
    try {
      const result = await window.electronAPI?.pickPptDirectory?.();
      if (result?.canceled || !result?.rootPath) return;
      setDirectoryPath(result.rootPath);
      const pptFiles = (result.files || [])
        .filter((f) => /\.(ppt|pptx)$/i.test(f.name))
        .map((f) => ({
          file_path: f.file_path || `${result.rootPath}/${f.relativePath}`,
          file_name: f.name,
          size: f.size,
        }));
      setSelectedFiles((prev) => {
        const existing = new Set(prev.map((p) => p.file_path));
        const added = pptFiles.filter((f) => !existing.has(f.file_path));
        setEnabledPaths((ep) => {
          const next = new Set(ep);
          added.forEach((f) => next.add(f.file_path));
          return next;
        });
        return [...prev, ...added];
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "选择目录失败");
    }
  }, []);

  const handleRemoveFile = useCallback((path: string) => {
    setSelectedFiles((prev) => prev.filter((f) => f.file_path !== path));
    setEnabledPaths((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const toggleFileEnabled = useCallback((path: string) => {
    setEnabledPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  useEffect(() => {
    api.pptAiInfo().then(setAiInfo).catch(() => {});
  }, []);

  // ---- 解析文件 ----
  const handleAnalyze = useCallback(async () => {
    const paths = selectedFiles
      .filter((f) => enabledPaths.has(f.file_path))
      .map((f) => f.file_path);
    if (!paths.length) {
      setError("请至少勾选一个 PPT 文件");
      return;
    }
    setAnalyzing(true);
    setLoading(true);
    setError(null);
    setProgressMap({});
    try {
      const files = await api.pptAnalyzeStream(paths, (ev) => {
        setProgressMap((prev) => ({ ...prev, [ev.file]: ev }));
      });
      setFileSlides(files);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "解析失败");
    } finally {
      setAnalyzing(false);
      setLoading(false);
    }
  }, [selectedFiles, enabledPaths]);

  // ---- AI 识别章节 ----
  const runDetect = useCallback(async (instructionText: string) => {
    if (!fileSlides.length) return;
    setDetecting(true);
    setLoading(true);
    setError(null);
    setDetectInstruction(instructionText);
    try {
      const res = await api.pptDetectSections(fileSlides, instructionText);
      setSections(res.sections);
      setReadingScript(res.readingScript);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Section 识别失败");
    } finally {
      setDetecting(false);
      setLoading(false);
    }
  }, [fileSlides]);

  const handleSectionNameChange = useCallback((idx: number, name: string) => {
    setSections((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], name };
      return next;
    });
  }, []);

  // ---- 合并 ----
  const handleMerge = useCallback(async () => {
    if (!sections.length) return;
    setMerging(true);
    setLoading(true);
    setError(null);
    try {
      const res = await api.pptMerge(sections);
      setMergedResult(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "合并失败");
    } finally {
      setMerging(false);
      setLoading(false);
    }
  }, [sections]);

  // ---- AI 修改 ----
  const runModify = useCallback(async (instructionText: string) => {
    setModifying(true);
    setLoading(true);
    setError(null);
    setInstruction(instructionText);
    setPatches([]);
    try {
      const res = await api.pptModify(sections, instructionText);
      setPatches(res.patches);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "AI 修改失败");
    } finally {
      setModifying(false);
      setLoading(false);
    }
  }, [sections]);

  // ---- 回填 ----
  const handleApply = useCallback(async () => {
    if (!patches.length) return;
    setApplying(true);
    setLoading(true);
    setError(null);
    try {
      const res = await api.pptApply(patches);
      setApplyResult(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "回填失败");
    } finally {
      setApplying(false);
      setLoading(false);
    }
  }, [patches]);

  // ---- 重置 ----
  const handleReset = useCallback(() => {
    setSelectedFiles([]);
    setDirectoryPath("");
    setEnabledPaths(new Set());
    setProgressMap({});
    setAnalyzing(false);
    setFileSlides([]);
    setSections([]);
    setReadingScript("");
    setMergedResult(null);
    setDetectInstruction("");
    setInstruction("");
    setPatches([]);
    setApplyResult(null);
    setCreatedResult(null);
    setCreating(false);
    setCreateText("");
    setError(null);
    setChatInput("");
  }, []);

  // ---- 按文字新建 PPT ----
  const handleCreateFromText = useCallback(async (text: string) => {
    setCreating(true);
    setLoading(true);
    setError(null);
    setCreatedResult(null);
    setCreateText(text);
    try {
      // 把左侧参考栏中的文件标注与说明注入到 AI 上下文
      const refCtx = buildReferenceContext(referenceBookmarks);
      const prompt = refCtx ? `${refCtx}\n\n---\n\n用户需求：${text}` : text;
      const res = await api.pptCreateFromText(prompt);
      setCreatedResult(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "生成 PPT 失败");
    } finally {
      setCreating(false);
      setLoading(false);
    }
  }, [referenceBookmarks]);

  // ---- 发送聊天消息 ----
  const handleSend = useCallback(() => {
    const text = chatInput.trim();
    if (!text) return;

    if (activeMode === "video") {
      // PPT 转视频暂未实现
      setError("PPT 转视频功能暂未开放，可先选择「PPT 制作」或「批量编辑 PPT」。");
      return;
    }

    setChatInput("");

    if (activeMode === "create") {
      // PPT 制作：直接按文字新建 PPT
      handleCreateFromText(text);
      return;
    }

    // 批量编辑 PPT：需要先选择文件
    if (fileSlides.length === 0) {
      setError("请先点击左侧回形针选择 PPT 文件，再进行批量编辑。");
      return;
    }

    if (sections.length === 0) {
      // 首次指令 → 识别章节
      runDetect(text);
    } else if (!mergedResult) {
      // 已有章节但未合并 → 重新识别
      runDetect(text);
    } else {
      // 已合并 → AI 修改
      runModify(text);
    }
  }, [chatInput, activeMode, fileSlides.length, sections.length, mergedResult, runDetect, runModify, handleCreateFromText]);

  // 自动滚到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [selectedFiles.length, analyzing, fileSlides.length, detecting, sections.length, merging, mergedResult, modifying, patches.length, applying, applyResult, error, creating, createdResult, createText]);

  // textarea 自适应高度
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
    }
  }, [chatInput]);

  const totalSlides = useMemo(
    () => sections.reduce((sum, s) => sum + s.parts.reduce((a, p) => a + p.slides.length, 0), 0),
    [sections]
  );

  // 当前所处阶段
  const currentPhase: PhaseId = useMemo(() => {
    if (applyResult) return "apply";
    if (patches.length > 0 || modifying) return "modify";
    if (mergedResult || merging) return "merge";
    if (sections.length > 0 || detecting) return "sections";
    if (fileSlides.length > 0 || analyzing) return "analyze";
    return "select";
  }, [applyResult, patches.length, modifying, mergedResult, merging, sections.length, detecting, fileSlides.length, analyzing]);

  // 输入框 placeholder
  const inputPlaceholder = useMemo(() => {
    if (activeMode === "video") return "向 AI 描述要生成的视频内容（即将上线）…";
    if (activeMode === "create") return "输入主题或大纲，AI 帮你生成一份新 PPT…";
    if (fileSlides.length === 0) return "请先选择 PPT 文件，再告诉 AI 怎么批量编辑…";
    if (sections.length === 0) return "告诉 AI 怎么拆分章节，例如：帮我把读课文部分拆出来";
    if (!mergedResult) return "输入新的拆分要求重新识别，或点击下方按钮生成合并总览…";
    if (patches.length === 0) return "告诉 AI 需要修改什么，例如：统一术语、修正错别字…";
    return "输入新的修改要求，或点击回填按钮写回原 PPT…";
  }, [activeMode, fileSlides.length, sections.length, mergedResult, patches.length]);

  const canSend = chatInput.trim().length > 0 && !loading;

  return (
    <div
      className="ppt-workspace h-full flex flex-col relative"
      style={{ background: "transparent" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 大气背景：渐变光斑 */}
      <div className="ppt-atmosphere" aria-hidden>
        <div className="ppt-blob ppt-blob-1" />
        <div className="ppt-blob ppt-blob-2" />
        <div className="ppt-blob ppt-blob-3" />
        <div className="ppt-grain" />
      </div>

      {/* 拖拽放入参考文件的遮罩 */}
      <ReferenceDropOverlay visible={dragOver} />

      {/* 左侧参考资料书签栏 */}
      <ReferenceRail
        bookmarks={referenceBookmarks}
        onRemove={handleRemoveRef}
        onPickFiles={handlePickReferenceFiles}
      />

      {/* ============ 自定义标题栏（与网页任务一致：可拖动 + 窗口控件） ============ */}
      <div
        className="flex shrink-0 items-center justify-between border-b border-slate-200/60 bg-white/80 px-3 py-1 relative z-20"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <img
            src={appIconPng}
            alt="CINSIDE icon"
            className="h-5 w-5"
          />
          <LogoWordmark className="h-5 logo-wordmark" />
          <div className="w-px h-4 bg-slate-200 mx-1" />
          <button
            onClick={onBack}
            className="flex items-center justify-center w-7 h-7 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition-colors"
            title="切换任务类型"
          >
            <LayoutGrid size={18} />
          </button>
        </div>
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <button
            onClick={() => window.electronAPI?.windowMinimize()}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
            title="最小化"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => window.electronAPI?.windowMaximize()}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
            title="最大化/还原"
          >
            <Square className="h-3 w-3" />
          </button>
          <button
            onClick={() => window.electronAPI?.windowClose()}
            className="rounded p-1 text-slate-400 hover:bg-rose-100 hover:text-rose-600 transition-colors"
            title="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ============ 顶部工具栏（与网页任务一致：glass-frame） ============ */}
      <header className="ppt-toolbar glass-frame relative z-20 flex shrink-0 items-center gap-2 border-b border-white/40 px-3 py-1">
        <div className="flex items-baseline gap-2">
          <h1 className="ppt-title text-sm font-bold text-slate-800 tracking-tight">幻灯片任务</h1>
          <span className="text-[10px] uppercase tracking-[0.2em] text-slate-400 font-medium hidden sm:inline">Slide Studio</span>
        </div>
        {aiInfo && !aiInfo.configured && (
          <div
            className="flex items-center gap-1 ml-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors"
            style={{
              background: "rgba(245,158,11,.12)",
              color: "#b45309",
              border: "1px solid rgba(245,158,11,.25)",
            }}
            title="AI 未配置，请在设置中配置"
          >
            <Cpu size={11} />
            AI 未配置
          </div>
        )}
        <div className="flex-1 flex justify-center">
          <div className="ppt-mode-segment flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100/70 ring-1 ring-slate-200/60">
            <button
              onClick={() => setActiveMode("create")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                activeMode === "create"
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <Sparkles size={13} />
              PPT 制作
            </button>
            <button
              onClick={() => setActiveMode("batch")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                activeMode === "batch"
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <Presentation size={13} />
              批量编辑 PPT
            </button>
            <button
              onClick={() => setActiveMode("video")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                activeMode === "video"
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <Clapperboard size={13} />
              PPT 转视频
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {/* 工作文件选择 */}
          <div ref={fileMenuRef} className="relative">
            <button
              onClick={() => setShowFileMenu((v) => !v)}
              className={`relative flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 transition-all ${
                showFileMenu
                  ? "bg-white text-slate-800 ring-slate-300 shadow-sm"
                  : "bg-white/70 text-slate-600 ring-slate-200 hover:bg-white hover:text-slate-800"
              }`}
              title="选择工作文件（PPT）"
            >
              <FolderOpen className="h-3 w-3" />
              工作文件
              {selectedFiles.length > 0 && (
                <span className="ml-0.5 inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-brand-500 px-1 text-[9px] font-bold leading-none text-white">
                  {selectedFiles.length}
                </span>
              )}
              <ChevronDown className={`h-3 w-3 transition-transform ${showFileMenu ? "rotate-180" : ""}`} />
            </button>
            {showFileMenu && (
              <div className="ppt-file-menu absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-lg bg-white/95 py-1 text-[11px] shadow-lg ring-1 ring-slate-200">
                <button
                  onClick={() => {
                    setShowFileMenu(false);
                    setActiveMode("batch");
                    void handlePickFiles();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
                >
                  <FolderOpen className="h-3.5 w-3.5 text-slate-400" />
                  选择 PPT 文件
                </button>
                <button
                  onClick={() => {
                    setShowFileMenu(false);
                    setActiveMode("batch");
                    void handlePickDirectory();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
                >
                  <FolderPlus className="h-3.5 w-3.5 text-slate-400" />
                  选择文件夹
                </button>
              </div>
            )}
          </div>

          {/* 设定 */}
          <button
            onClick={onOpenSettings}
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-white/70 hover:text-slate-600"
            title="设置"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* 阶段进度条（仅批量编辑流程开始时显示） */}
      {activeMode === "batch" && (selectedFiles.length > 0 || fileSlides.length > 0 || analyzing) && (
        <div className="ppt-phase-tracker shrink-0 px-5 py-2.5 border-b border-slate-200/40 bg-white/30 backdrop-blur-sm relative z-10">
        <div className="max-w-3xl mx-auto flex items-center">
          {PHASES.map((phase, idx) => {
            const isCurrent = phase.id === currentPhase;
            const isDone = PHASES.findIndex((p) => p.id === currentPhase) > idx;
            const isReached = isCurrent || isDone;
            return (
              <div key={phase.id} className="flex items-center flex-1 last:flex-none">
                <div
                  className={`ppt-phase-item flex items-center gap-1.5 px-2 py-1 rounded-lg transition-all duration-500 ${
                    isCurrent ? "ppt-phase-current" : ""
                  } ${isDone ? "ppt-phase-done" : ""} ${!isReached ? "opacity-50" : ""}`}
                >
                  <div className={`ppt-phase-dot relative flex items-center justify-center w-5 h-5 rounded-full shrink-0 transition-all`}>
                    {isDone ? (
                      <CheckCircle2 size={14} className="text-emerald-500" />
                    ) : isCurrent ? (
                      <>
                        <span className="ppt-phase-pulse absolute inset-0 rounded-full" />
                        <CircleDot size={14} className="text-violet-600 relative" />
                      </>
                    ) : (
                      <phase.icon size={11} className="text-slate-400" />
                    )}
                  </div>
                  <span className={`text-xs font-medium ${isCurrent ? "text-violet-700" : isDone ? "text-emerald-700" : "text-slate-500"}`}>
                    {phase.shortLabel}
                  </span>
                </div>
                {idx < PHASES.length - 1 && (
                  <div className="flex-1 h-px mx-1 relative bg-slate-200/60 overflow-hidden">
                    <div
                      className={`absolute inset-0 origin-left transition-transform duration-700 ${
                        isDone ? "scale-x-100 bg-gradient-to-r from-emerald-300 to-violet-400" : "scale-x-0 bg-violet-400"
                      }`}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="mx-5 mt-3 flex items-start gap-2.5 px-4 py-3 rounded-xl bg-rose-50/80 border border-rose-200/80 text-sm text-rose-700 shrink-0 backdrop-blur-sm chat-msg-enter relative z-10">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-rose-500" />
          <span className="flex-1 leading-relaxed">{error}</span>
          <button onClick={() => setError(null)} className="p-0.5 rounded-md hover:bg-rose-100/80 transition-colors">
            <X size={14} className="text-rose-400 hover:text-rose-600" />
          </button>
        </div>
      )}

      {/* 聊天区域 */}
      <main ref={scrollRef} className="flex-1 overflow-auto relative z-10">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {/* 用户新建 PPT 的文字输入 */}
          {createText && (creating || createdResult) && (
            <UserMessage text={createText} />
          )}

          {/* 新建 PPT 生成中 */}
          {creating && (
            <AIMessage>
              <SkeletonLoader text="正在生成 PPT…" />
            </AIMessage>
          )}

          {/* 新建 PPT 完成 */}
          {createdResult && !creating && (
            <AIMessage>
              <div className="ppt-success-banner flex items-center gap-3 p-3.5 bg-violet-50/60 border border-violet-200/60 rounded-xl">
                <div className="w-9 h-9 rounded-lg bg-violet-100 flex items-center justify-center shrink-0">
                  <CheckCircle2 size={18} className="text-violet-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-violet-800">PPT 已生成</div>
                  <div className="text-xs text-violet-600 truncate">
                    {createdResult.file_name} · {createdResult.total_slides} 页
                  </div>
                </div>
                <button
                  onClick={handleReset}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-violet-700 bg-white border border-violet-200 rounded-lg hover:bg-violet-50 transition-all shrink-0"
                >
                  <RefreshCw size={12} />
                  新建一份
                </button>
              </div>
            </AIMessage>
          )}

          {/* 用户选择的文件 */}
          {activeMode === "batch" && selectedFiles.length > 0 && fileSlides.length === 0 && !analyzing && (
            <UserMessage>
              <div className="space-y-1.5 min-w-[280px]">
                <div className="text-[10px] uppercase tracking-[0.18em] text-white/60 font-medium mb-1.5">
                  已选文件 · {enabledPaths.size}/{selectedFiles.length}
                </div>
                {selectedFiles.map((f) => {
                  const enabled = enabledPaths.has(f.file_path);
                  return (
                    <div
                      key={f.file_path}
                      onClick={() => toggleFileEnabled(f.file_path)}
                      className={`group flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-all text-sm ${
                        enabled ? "bg-white/20" : "bg-white/10 opacity-50"
                      }`}
                    >
                      <FileText size={14} className="shrink-0" />
                      <span className="flex-1 truncate">{f.file_name}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRemoveFile(f.file_path); }}
                        className="p-0.5 rounded hover:bg-white/20 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
              <button
                onClick={handleAnalyze}
                disabled={!enabledPaths.size}
                className="mt-3 inline-flex items-center gap-1.5 px-4 py-1.5 bg-white text-violet-700 text-xs font-semibold rounded-lg hover:bg-violet-50 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                解析 {enabledPaths.size} 个 PPT
                <ChevronRight size={13} />
              </button>
            </UserMessage>
          )}

          {/* 解析进度 */}
          {activeMode === "batch" && analyzing && (
            <AIMessage>
              <div className="flex items-center gap-2.5 mb-3">
                <Loader2 size={16} className="animate-spin text-violet-500" />
                <span className="text-sm font-medium text-slate-700">正在解析 PPT…</span>
              </div>
              <AnalyzeProgress
                files={selectedFiles.filter((f) => enabledPaths.has(f.file_path))}
                progressMap={progressMap}
              />
            </AIMessage>
          )}

          {/* 解析完成 — AI 确认 + 文件列表 */}
          {activeMode === "batch" && fileSlides.length > 0 && sections.length === 0 && !detecting && (
            <AIMessage>
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle2 size={16} className="text-emerald-500" />
                <span className="text-sm font-medium text-slate-700">
                  已解析 {fileSlides.length} 个文件，共{" "}
                  <span className="ppt-stat-num">{fileSlides.reduce((a, f) => a + f.slides.length, 0)}</span> 张幻灯片
                </span>
              </div>
              <p className="text-xs text-slate-500 mb-3 ml-6">
                告诉我你想怎么拆分章节，或直接点击下方按钮让 AI 自动识别。
              </p>
              <div className="space-y-1 mb-3 ml-6">
                {fileSlides.map((f) => (
                  <div key={f.file_id} className="flex items-center gap-2 text-xs text-slate-500">
                    <FileText size={12} className="text-slate-400" />
                    <span className="flex-1 truncate">{f.file_name}</span>
                    <span className="ppt-tag-ghost">{f.slides.length} 页</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5 ml-6 mb-3">
                {["按教学环节拆分", "提取读课文部分", "只保留练习题"].map((s) => (
                  <button
                    key={s}
                    onClick={() => { setChatInput(s); textareaRef.current?.focus(); }}
                    className="ppt-chip px-2.5 py-1 text-xs text-violet-600 bg-violet-50 hover:bg-violet-100 rounded-lg border border-violet-200/50 transition-all hover:-translate-y-0.5"
                  >
                    {s}
                  </button>
                ))}
              </div>
              <button
                onClick={() => runDetect("")}
                className="ml-6 inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-violet-600 to-purple-600 text-white text-sm font-medium rounded-xl shadow-md shadow-violet-500/20 hover:shadow-lg hover:shadow-violet-500/25 hover:-translate-y-0.5 transition-all"
              >
                <Sparkles size={14} />
                自动识别章节
              </button>
            </AIMessage>
          )}

          {/* 用户的拆分指令 */}
          {detectInstruction && (sections.length > 0 || detecting) && (
            <UserMessage text={detectInstruction} />
          )}

          {/* AI 识别中 */}
          {detecting && (
            <AIMessage>
              <SkeletonLoader text="正在识别章节…" />
            </AIMessage>
          )}

          {/* 章节识别结果 — 电影胶片式 */}
          {sections.length > 0 && !merging && (
            <AIMessage>
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle2 size={16} className="text-emerald-500" />
                <span className="text-sm font-medium text-slate-700">
                  识别到 <span className="ppt-stat-num">{sections.length}</span> 个章节 · <span className="ppt-stat-num">{totalSlides}</span> 页
                </span>
              </div>
              <div className="space-y-2 mb-4">
                {sections.map((section, si) => (
                  <SectionFilmCard
                    key={si}
                    index={si}
                    section={section}
                    onNameChange={(name) => handleSectionNameChange(si, name)}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => runDetect(detectInstruction)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-all"
                >
                  <RefreshCw size={12} />
                  重新识别
                </button>
                <button
                  onClick={handleMerge}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-gradient-to-r from-violet-600 to-purple-600 text-white text-sm font-semibold rounded-xl shadow-md shadow-violet-500/20 hover:shadow-lg hover:shadow-violet-500/25 hover:-translate-y-0.5 transition-all"
                >
                  <Merge size={14} />
                  生成合并总览
                  <ChevronRight size={14} />
                </button>
              </div>
            </AIMessage>
          )}

          {/* 合并中 */}
          {merging && (
            <AIMessage>
              <SkeletonLoader text="正在合并 PPT…" />
            </AIMessage>
          )}

          {/* 合并完成 */}
          {mergedResult && !modifying && patches.length === 0 && !applying && (
            <AIMessage>
              <div className="ppt-success-banner flex items-center gap-3 p-3.5 bg-emerald-50/60 border border-emerald-200/60 rounded-xl mb-3">
                <div className="w-9 h-9 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
                  <CheckCircle2 size={18} className="text-emerald-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-emerald-800">合并成功</div>
                  <div className="text-xs text-emerald-600 truncate">{mergedResult.file_name} · {mergedResult.total_slides} 页</div>
                </div>
              </div>
              {readingScript && (
                <details className="mb-3 group">
                  <summary className="text-xs text-slate-500 cursor-pointer hover:text-violet-600 transition-colors flex items-center gap-1.5">
                    <FileText size={12} />
                    查看阅读稿
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto p-3 bg-slate-50/60 border border-slate-100 rounded-lg text-[11px] text-slate-600 whitespace-pre-wrap font-mono leading-relaxed">
                    {readingScript}
                  </pre>
                </details>
              )}
              <p className="text-xs text-slate-500 mb-3">
                在下方输入框告诉 AI 需要修改什么，然后发送即可。
              </p>
            </AIMessage>
          )}

          {/* 用户的修改指令 */}
          {instruction && (patches.length > 0 || modifying) && (
            <UserMessage text={instruction} />
          )}

          {/* AI 修改中 */}
          {modifying && (
            <AIMessage>
              <SkeletonLoader text="正在生成修改方案…" />
            </AIMessage>
          )}

          {/* 修改方案结果 — 编辑式 diff */}
          {patches.length > 0 && !applying && !applyResult && (
            <AIMessage>
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle2 size={16} className="text-emerald-500" />
                <span className="text-sm font-medium text-slate-700">
                  找到 <span className="ppt-stat-num">{patches.length}</span> 处修改
                </span>
              </div>
              <div className="max-h-72 overflow-auto space-y-2 mb-4 pr-1 scrollbar-tiny">
                {patches.map((p, i) => (
                  <PatchDiffCard key={i} patch={p} index={i} />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => runModify(instruction)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-all"
                >
                  <RefreshCw size={12} />
                  重新生成
                </button>
                <button
                  onClick={handleApply}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-gradient-to-r from-emerald-500 to-teal-600 text-white text-sm font-semibold rounded-xl shadow-md shadow-emerald-500/20 hover:shadow-lg hover:shadow-emerald-500/30 hover:-translate-y-0.5 transition-all"
                >
                  <CheckCircle2 size={14} />
                  一键回填到原 PPT
                  <ChevronRight size={14} />
                </button>
              </div>
            </AIMessage>
          )}

          {/* 回填中 */}
          {applying && (
            <AIMessage>
              <SkeletonLoader text="正在回填到原 PPT…" spinnerClass="text-emerald-500" />
            </AIMessage>
          )}

          {/* 回填完成 */}
          {applyResult && (
            <AIMessage>
              <div className="ppt-final-card flex flex-col items-center text-center py-4">
                <div className="ppt-final-icon w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-100 to-teal-100 flex items-center justify-center mb-3">
                  <CheckCircle2 size={28} className="text-emerald-500" />
                </div>
                <div className="text-base font-bold text-slate-800 mb-1">回填完成</div>
                <p className="text-sm text-slate-500 mb-4">
                  成功修改 <b className="text-emerald-600">{applyResult.applied}</b> 处
                  {applyResult.failed > 0 && (
                    <>，失败 <b className="text-rose-500">{applyResult.failed}</b> 处</>
                  )}
                  ，已原位写回 PPT 文件。
                </p>
                {applyResult.errors.length > 0 && (
                  <details className="w-full mb-4 text-left">
                    <summary className="text-xs text-rose-600 cursor-pointer hover:underline">错误详情</summary>
                    <div className="mt-2 max-h-32 overflow-auto space-y-1">
                      {applyResult.errors.map((err, i) => (
                        <div key={i} className="text-[11px] text-rose-600 bg-rose-50/80 px-2.5 py-1.5 rounded-lg border border-rose-100">
                          {err}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                <button
                  onClick={handleReset}
                  className="inline-flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-violet-600 to-purple-600 text-white text-sm font-semibold rounded-xl shadow-lg shadow-violet-500/25 hover:shadow-xl hover:shadow-violet-500/30 hover:-translate-y-0.5 transition-all"
                >
                  <RefreshCw size={15} />
                  处理新文件
                </button>
              </div>
            </AIMessage>
          )}
        </div>
      </main>

      {/* 底部输入栏 */}
      <footer
        className={`ppt-input-footer shrink-0 px-5 py-3 relative z-10 transition-all ${
          inputFocused ? "ppt-input-focused" : ""
        }`}
      >
        <div className="max-w-3xl mx-auto">
          <div className="ppt-input-shell flex items-end gap-2 p-2 rounded-2xl transition-all">
            {activeMode === "batch" && (
              <button
                onClick={handlePickFiles}
                className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-all shrink-0"
                title="添加 PPT 文件"
              >
                <Paperclip size={18} />
              </button>
            )}
            <textarea
              ref={textareaRef}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={inputPlaceholder}
              rows={1}
              className="flex-1 bg-transparent border-none outline-none resize-none text-sm text-slate-800 placeholder:text-slate-400 py-2 leading-relaxed"
            />
            <button
              onClick={handleSend}
              disabled={!canSend}
              className="ppt-send-btn p-2 rounded-xl bg-slate-900 text-white hover:bg-slate-800 active:scale-95 transition-all disabled:opacity-30 disabled:cursor-not-allowed disabled:active:scale-100 shrink-0"
            >
              <SendHorizontal size={17} />
            </button>
          </div>
          <div className="flex items-center justify-between mt-1.5 px-1 gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {referenceBookmarks.length > 0 && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-700 ring-1 ring-brand-200/60"
                  title="参考文件已附加，AI 生成时会参考其中的要求"
                >
                  <Bookmark className="h-2.5 w-2.5" />
                  {referenceBookmarks.length} 份参考
                </span>
              )}
              <span className="text-[10px] text-slate-400 truncate">
                {activeMode === "video"
                  ? "输入内容生成演示视频（即将上线）"
                  : activeMode === "create"
                  ? "直接输入主题或大纲，AI 生成新 PPT（可拖入 PPT/PDF 作为参考）"
                  : fileSlides.length === 0
                  ? "请先选择文件进行批量编辑，或切换到「PPT 制作」直接新建"
                  : "按 Enter 发送 · Shift+Enter 换行"}
              </span>
            </div>
            {activeMode === "batch" && selectedFiles.length > 0 && fileSlides.length === 0 && (
              <button
                onClick={handleAnalyze}
                disabled={!enabledPaths.size}
                className="text-[11px] text-slate-600 hover:text-slate-800 font-medium disabled:opacity-40"
              >
                或点击此处开始解析 {enabledPaths.size} 个文件 →
              </button>
            )}
          </div>
        </div>
      </footer>

      {/* 拖入文件后打标签的弹窗 */}
      {pendingRefFiles.length > 0 && (
        <ReferenceLabelModal
          files={pendingRefFiles}
          onConfirm={handleConfirmRefs}
          onCancel={() => setPendingRefFiles([])}
        />
      )}

      <style>{`
        /* ===== 大气背景：渐变光斑 ===== */
        .ppt-workspace { isolation: isolate; }
        .ppt-atmosphere {
          position: absolute;
          inset: 0;
          pointer-events: none;
          overflow: hidden;
          z-index: 0;
        }
        .ppt-blob {
          position: absolute;
          border-radius: 50%;
          filter: blur(60px);
          opacity: 0.55;
          animation: ppt-blob-float 18s ease-in-out infinite;
        }
        .ppt-blob-1 {
          width: 480px; height: 480px;
          top: -120px; left: -80px;
          background: radial-gradient(circle at 30% 30%, rgba(139,92,246,.35), transparent 70%);
        }
        .ppt-blob-2 {
          width: 520px; height: 520px;
          top: 30%; right: -150px;
          background: radial-gradient(circle at 70% 30%, rgba(217,70,239,.22), transparent 70%);
          animation-delay: -6s;
        }
        .ppt-blob-3 {
          width: 460px; height: 460px;
          bottom: -140px; left: 30%;
          background: radial-gradient(circle at 50% 50%, rgba(99,102,241,.20), transparent 70%);
          animation-delay: -12s;
        }
        @keyframes ppt-blob-float {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(30px, -20px) scale(1.05); }
          66% { transform: translate(-20px, 25px) scale(0.96); }
        }
        /* 颗粒纹理：极轻的噪点 */
        .ppt-grain {
          position: absolute;
          inset: 0;
          opacity: 0.025;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
          mix-blend-mode: overlay;
        }

        /* ===== 顶栏标题：editorial 衬线 ===== */
        .ppt-title {
          font-family: "Georgia", "Songti SC", "STSong", "Source Han Serif SC", "Noto Serif CJK SC", serif;
          letter-spacing: -0.01em;
        }

        /* ===== 阶段进度条 ===== */
        .ppt-phase-tracker { font-feature-settings: "tnum"; }
        .ppt-phase-item { position: relative; }
        .ppt-phase-current { background: rgba(139, 92, 246, .08); }
        .ppt-phase-pulse {
          background: rgba(139, 92, 246, .25);
          animation: ppt-phase-ping 1.6s cubic-bezier(0, 0, 0.2, 1) infinite;
        }
        @keyframes ppt-phase-ping {
          0% { transform: scale(1); opacity: .8; }
          80%, 100% { transform: scale(1.8); opacity: 0; }
        }

        /* ===== 欢迎区域 ===== */
        .ppt-welcome { position: relative; }
        .ppt-welcome-eyebrow {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.22em;
          text-transform: uppercase;
          color: #a78bfa;
          margin-bottom: 6px;
        }
        .ppt-feature-card { position: relative; overflow: hidden; }
        .ppt-feature-num {
          position: absolute;
          top: 4px; right: 6px;
          font-family: "Georgia", "Songti SC", serif;
          font-size: 11px;
          color: rgba(139, 92, 246, .25);
          font-weight: 700;
        }
        .ppt-feature-card:hover .ppt-feature-num { color: rgba(139, 92, 246, .55); }

        /* ===== 数字徽章 ===== */
        .ppt-stat-num {
          font-family: "Georgia", "Songti SC", serif;
          font-weight: 700;
          color: #6d28d9;
          font-feature-settings: "tnum";
        }
        .ppt-tag-ghost {
          font-size: 10px;
          background: rgba(148, 163, 184, .12);
          color: #64748b;
          padding: 1px 6px;
          border-radius: 4px;
          font-feature-settings: "tnum";
        }

        /* ===== 章节 — 电影胶片卡 ===== */
        .ppt-film-card {
          position: relative;
          border: 1px solid rgba(148, 163, 184, .25);
          border-radius: 14px;
          overflow: hidden;
          background: rgba(255, 255, 255, .55);
          transition: all .3s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .ppt-film-card:hover {
          border-color: rgba(139, 92, 246, .35);
          box-shadow: 0 8px 24px -8px rgba(139, 92, 246, .18);
          transform: translateY(-1px);
        }
        .ppt-film-perfs {
          position: relative;
          height: 14px;
          background: linear-gradient(to bottom, rgba(15, 23, 42, .04), rgba(15, 23, 42, .02));
          display: flex;
          align-items: center;
          justify-content: space-around;
          padding: 0 6px;
        }
        .ppt-film-perfs::before,
        .ppt-film-perfs::after {
          content: "";
          flex: 1;
          height: 4px;
          background-image: radial-gradient(circle, rgba(255,255,255,.85) 30%, transparent 32%);
          background-size: 14px 4px;
          background-repeat: repeat-x;
          background-position: center;
          filter: drop-shadow(0 1px 0 rgba(15,23,42,.06));
        }
        .ppt-film-perfs-top { border-bottom: 1px dashed rgba(148, 163, 184, .25); }
        .ppt-film-perfs-bottom { border-top: 1px dashed rgba(148, 163, 184, .25); }
        .ppt-film-body { padding: 8px 12px 10px; }
        .ppt-film-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 6px;
        }
        .ppt-film-num {
          width: 22px;
          height: 22px;
          border-radius: 6px;
          background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
          color: white;
          font-family: "Georgia", "Songti SC", serif;
          font-size: 11px;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          box-shadow: 0 2px 6px -2px rgba(124, 58, 237, .45);
        }
        .ppt-film-title-input {
          flex: 1;
          font-size: 14px;
          font-weight: 600;
          color: #1e293b;
          background: transparent;
          border: none;
          outline: none;
          border-radius: 6px;
          padding: 2px 6px;
          transition: all .2s;
        }
        .ppt-film-title-input:focus {
          background: rgba(255,255,255,.85);
          box-shadow: 0 0 0 2px rgba(139, 92, 246, .22);
        }
        .ppt-film-meta {
          font-size: 10px;
          color: #64748b;
          background: rgba(148, 163, 184, .12);
          padding: 2px 8px;
          border-radius: 999px;
          flex-shrink: 0;
          font-feature-settings: "tnum";
        }
        .ppt-film-strip {
          display: flex;
          gap: 4px;
          overflow-x: auto;
          padding: 4px 0 2px;
        }
        .ppt-film-strip::-webkit-scrollbar { height: 3px; }
        .ppt-film-frame {
          position: relative;
          min-width: 38px;
          height: 28px;
          background: linear-gradient(135deg, rgba(139,92,246,.08), rgba(217,70,239,.06));
          border: 1px solid rgba(139, 92, 246, .15);
          border-radius: 4px;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 9px;
          color: rgba(124, 58, 237, .55);
          font-family: "Georgia", "Songti SC", serif;
          font-weight: 700;
        }
        .ppt-film-frame::before {
          content: "";
          position: absolute;
          top: 2px; left: 2px; right: 2px;
          height: 1px;
          background: rgba(255,255,255,.5);
          border-radius: 1px;
        }
        .ppt-film-part {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 3px 0;
          font-size: 11px;
        }
        .ppt-film-part-dot {
          width: 4px;
          height: 4px;
          border-radius: 50%;
          background: rgba(148, 163, 184, .5);
          flex-shrink: 0;
        }
        .ppt-film-part-name {
          flex: 1;
          color: #475569;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ppt-film-part-range {
          color: #94a3b8;
          font-feature-settings: "tnum";
          font-size: 10px;
        }

        /* ===== Patch diff 卡片 ===== */
        .ppt-patch-card {
          position: relative;
          border: 1px solid rgba(148, 163, 184, .2);
          border-radius: 12px;
          padding: 10px 12px;
          background: rgba(255, 255, 255, .55);
          transition: all .25s ease;
        }
        .ppt-patch-card:hover {
          border-color: rgba(139, 92, 246, .3);
          background: rgba(255, 255, 255, .75);
        }
        .ppt-patch-header {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 8px;
        }
        .ppt-patch-num {
          width: 18px;
          height: 18px;
          border-radius: 5px;
          background: rgba(139, 92, 246, .12);
          color: #7c3aed;
          font-family: "Georgia", "Songti SC", serif;
          font-size: 10px;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .ppt-patch-file {
          font-size: 11px;
          font-weight: 500;
          color: #475569;
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ppt-patch-slide {
          font-size: 10px;
          background: rgba(148, 163, 184, .14);
          color: #475569;
          padding: 1px 6px;
          border-radius: 4px;
          flex-shrink: 0;
          font-feature-settings: "tnum";
        }
        .ppt-patch-diff {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          gap: 6px;
          align-items: stretch;
        }
        .ppt-patch-side {
          padding: 6px 8px;
          border-radius: 8px;
          font-size: 11px;
          line-height: 1.5;
          word-break: break-word;
        }
        .ppt-patch-before {
          background: rgba(244, 63, 94, .08);
          color: #9f1239;
          text-decoration: line-through;
          text-decoration-color: rgba(244, 63, 94, .35);
        }
        .ppt-patch-after {
          background: rgba(16, 185, 129, .08);
          color: #065f46;
        }
        .ppt-patch-arrow {
          display: flex;
          align-items: center;
          justify-content: center;
          color: #94a3b8;
        }
        .ppt-patch-label {
          font-size: 9px;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          margin-bottom: 2px;
          opacity: 0.7;
        }

        /* ===== 成功横幅 ===== */
        .ppt-success-banner {
          position: relative;
          overflow: hidden;
        }
        .ppt-success-banner::after {
          content: "";
          position: absolute;
          top: -50%; right: -20%;
          width: 200px; height: 200px;
          background: radial-gradient(circle, rgba(16,185,129,.15), transparent 70%);
          pointer-events: none;
        }

        /* ===== 最终完成卡 ===== */
        .ppt-final-card { position: relative; }
        .ppt-final-icon {
          position: relative;
          box-shadow: 0 8px 24px -8px rgba(16, 185, 129, .45);
        }
        .ppt-final-icon::after {
          content: "";
          position: absolute;
          inset: -6px;
          border-radius: 18px;
          border: 1px solid rgba(16, 185, 129, .25);
          animation: ppt-final-ring 2.4s ease-out infinite;
        }
        @keyframes ppt-final-ring {
          0% { transform: scale(0.95); opacity: 1; }
          100% { transform: scale(1.3); opacity: 0; }
        }

        /* ===== 输入栏 ===== */
        .ppt-input-footer { transition: background-color .2s ease, border-color .2s ease; }
        .ppt-input-shell {
          background: rgba(255, 255, 255, .35);
          border: 1px solid rgba(255, 255, 255, .55);
          backdrop-filter: blur(12px) saturate(140%);
          -webkit-backdrop-filter: blur(12px) saturate(140%);
          box-shadow:
            0 1px 0 0 rgba(255, 255, 255, .65) inset,
            0 4px 18px -6px rgba(31, 41, 55, .18);
          transition: background-color .2s ease, border-color .2s ease, box-shadow .2s ease;
        }
        .ppt-input-shell:hover {
          background: rgba(255, 255, 255, .45);
          border-color: rgba(255, 255, 255, .7);
        }
        .ppt-input-focused .ppt-input-shell {
          background: rgba(255, 255, 255, .5);
          border-color: rgba(139, 92, 246, .4);
          box-shadow:
            0 1px 0 0 rgba(255, 255, 255, .7) inset,
            0 0 0 3px rgba(139, 92, 246, .12),
            0 6px 22px -6px rgba(139, 92, 246, .25);
        }
        .ppt-send-btn { position: relative; }
        html[data-theme="dark"] .ppt-send-btn {
          background-color: #f1f5f9;
          color: #0f172a;
        }
        html[data-theme="dark"] .ppt-send-btn:hover {
          background-color: #e2e8f0;
        }

        /* ===== 进入动画 ===== */
        @keyframes ppt-fade-in-up {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .chat-msg-enter {
          animation: ppt-fade-in-up 0.4s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @keyframes ppt-progress-shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .ppt-progress-shimmer::after {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(90deg, transparent, rgba(255,255,255,.4), transparent);
          animation: ppt-progress-shimmer 1.8s ease-in-out infinite;
        }

        /* ===== Skeleton shimmer ===== */
        .ppt-skeleton {
          background: linear-gradient(
            90deg,
            rgba(148, 163, 184, .08) 0%,
            rgba(148, 163, 184, .18) 50%,
            rgba(148, 163, 184, .08) 100%
          );
          background-size: 200% 100%;
          animation: ppt-shimmer 1.4s ease-in-out infinite;
        }
        @keyframes ppt-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }

        /* ===== 暗色主题适配 ===== */
        html[data-theme="dark"] .ppt-blob-1 {
          background: radial-gradient(circle at 30% 30%, rgba(139,92,246,.30), transparent 70%);
          opacity: 0.6;
        }
        html[data-theme="dark"] .ppt-blob-2 {
          background: radial-gradient(circle at 70% 30%, rgba(217,70,239,.18), transparent 70%);
          opacity: 0.6;
        }
        html[data-theme="dark"] .ppt-blob-3 {
          background: radial-gradient(circle at 50% 50%, rgba(99,102,241,.22), transparent 70%);
          opacity: 0.6;
        }
        html[data-theme="dark"] .ppt-grain { opacity: 0.04; }
        html[data-theme="dark"] .ppt-film-card {
          background: rgba(30, 41, 59, .55);
          border-color: rgba(148, 163, 184, .15);
        }
        html[data-theme="dark"] .ppt-film-card:hover {
          border-color: rgba(139, 92, 246, .35);
          box-shadow: 0 8px 24px -8px rgba(0, 0, 0, .35);
        }
        html[data-theme="dark"] .ppt-film-perfs {
          background: linear-gradient(to bottom, rgba(0,0,0,.18), rgba(0,0,0,.08));
        }
        html[data-theme="dark"] .ppt-film-perfs::before,
        html[data-theme="dark"] .ppt-film-perfs::after {
          background-image: radial-gradient(circle, rgba(15,22,41,.85) 30%, transparent 32%);
        }
        html[data-theme="dark"] .ppt-film-perfs-top { border-bottom-color: rgba(148, 163, 184, .15); }
        html[data-theme="dark"] .ppt-film-perfs-bottom { border-top-color: rgba(148, 163, 184, .15); }
        html[data-theme="dark"] .ppt-film-title-input { color: #e2e8f0; }
        html[data-theme="dark"] .ppt-film-title-input:focus {
          background: rgba(15, 22, 41, .6);
          box-shadow: 0 0 0 2px rgba(139, 92, 246, .3);
        }
        html[data-theme="dark"] .ppt-film-meta { background: rgba(148, 163, 184, .15); color: #94a3b8; }
        html[data-theme="dark"] .ppt-film-frame {
          background: linear-gradient(135deg, rgba(139,92,246,.14), rgba(217,70,239,.08));
          border-color: rgba(139, 92, 246, .2);
          color: rgba(196, 181, 253, .7);
        }
        html[data-theme="dark"] .ppt-film-part-name { color: #cbd5e1; }
        html[data-theme="dark"] .ppt-film-part-range { color: #64748b; }
        html[data-theme="dark"] .ppt-patch-card {
          background: rgba(30, 41, 59, .55);
          border-color: rgba(148, 163, 184, .15);
        }
        html[data-theme="dark"] .ppt-patch-card:hover {
          background: rgba(30, 41, 59, .75);
          border-color: rgba(139, 92, 246, .3);
        }
        html[data-theme="dark"] .ppt-patch-num {
          background: rgba(139, 92, 246, .18);
          color: #c4b5fd;
        }
        html[data-theme="dark"] .ppt-patch-file { color: #cbd5e1; }
        html[data-theme="dark"] .ppt-patch-slide {
          background: rgba(148, 163, 184, .15);
          color: #94a3b8;
        }
        html[data-theme="dark"] .ppt-patch-before {
          background: rgba(244, 63, 94, .14);
          color: #fda4af;
        }
        html[data-theme="dark"] .ppt-patch-after {
          background: rgba(16, 185, 129, .14);
          color: #6ee7b7;
        }
        html[data-theme="dark"] .ppt-patch-arrow { color: #64748b; }
        html[data-theme="dark"] .ppt-phase-current { background: rgba(139, 92, 246, .14); }
        html[data-theme="dark"] .ppt-feature-card {
          background: rgba(30, 41, 59, .5);
          border-color: rgba(148, 163, 184, .12);
        }
        html[data-theme="dark"] .ppt-feature-card:hover {
          background: rgba(30, 41, 59, .75);
          border-color: rgba(139, 92, 246, .3);
        }
        html[data-theme="dark"] .ppt-tag-ghost {
          background: rgba(148, 163, 184, .15);
          color: #94a3b8;
        }
        html[data-theme="dark"] .ppt-skeleton {
          background: linear-gradient(
            90deg,
            rgba(148, 163, 184, .08) 0%,
            rgba(148, 163, 184, .2) 50%,
            rgba(148, 163, 184, .08) 100%
          );
          background-size: 200% 100%;
        }
        html[data-theme="dark"] .ppt-stat-num { color: #c4b5fd; }
        html[data-theme="dark"] .ppt-input-shell {
          background: rgba(30, 41, 59, .4);
          border-color: rgba(255, 255, 255, .14);
          box-shadow:
            0 1px 0 0 rgba(255, 255, 255, .06) inset,
            0 4px 18px -8px rgba(0, 0, 0, .5);
        }
        html[data-theme="dark"] .ppt-input-shell:hover {
          background: rgba(30, 41, 59, .55);
          border-color: rgba(255, 255, 255, .22);
        }
        html[data-theme="dark"] .ppt-input-focused .ppt-input-shell {
          background: rgba(30, 41, 59, .6);
          border-color: rgba(139, 92, 246, .45);
          box-shadow:
            0 1px 0 0 rgba(255, 255, 255, .08) inset,
            0 0 0 3px rgba(139, 92, 246, .18),
            0 6px 22px -6px rgba(0, 0, 0, .55);
        }
        html[data-theme="dark"] .ppt-file-menu {
          background: rgba(30, 41, 59, .92);
          border-color: rgba(255, 255, 255, .1);
          box-shadow: 0 8px 28px -8px rgba(0, 0, 0, .6);
        }
        html[data-theme="dark"] .ppt-file-menu button {
          color: #cbd5e1;
        }
        html[data-theme="dark"] .ppt-file-menu button:hover {
          background: rgba(148, 163, 184, .12);
          color: #f1f5f9;
        }
        html[data-theme="dark"] .ppt-file-menu button svg {
          color: #94a3b8;
        }

        /* 响应式：窄屏收起阶段标签 */
        @media (max-width: 640px) {
          .ppt-phase-item span { display: none; }
          .ppt-phase-current span { display: inline; }
        }

        /* ===== 参考资料书签栏 ===== */
        .ref-rail-scroll { scrollbar-width: none; }
        .ref-rail-scroll::-webkit-scrollbar { width: 0; display: none; }
        @keyframes ref-card-in {
          from { opacity: 0; transform: translateX(-6px) scale(.98); }
          to { opacity: 1; transform: translateX(0) scale(1); }
        }
        .animate-ref-card-in {
          animation: ref-card-in .18s cubic-bezier(.22,1,.36,1) both;
        }
      `}</style>
    </div>
  );
}

// ---- LogoWordmark（与 App.tsx 保持一致的内联副本） ----
function LogoWordmark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 520 120" width="100%" height="100%" className={className} aria-label="CINSIDE">
      <text x="10" y="90"
            fontFamily="Arial Black, Impact, 'Segoe UI', sans-serif"
            fontSize="80"
            fontWeight="900"
            fill="currentColor">CINSIDE</text>
      <rect x="420" y="20" width="6" height="70" fill="#8a2be2" rx="1">
        <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite" />
      </rect>
      <rect x="435" y="80" width="30" height="6" fill="#8a2be2" rx="1">
        <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite" />
      </rect>
    </svg>
  );
}

// ---- AI 消息气泡 ----
function AIMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="chat-msg-enter flex gap-3">
      <div className="ppt-ai-avatar w-8 h-8 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shrink-0 shadow-md shadow-violet-500/20">
        <Bot size={16} className="text-white" />
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        {children}
      </div>
      <style>{`
        .ppt-ai-avatar { position: relative; overflow: hidden; }
        .ppt-ai-avatar::after {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(135deg, rgba(255,255,255,.25) 0%, transparent 50%);
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}

// ---- 用户消息气泡 ----
function UserMessage({ text, children }: { text?: string; children?: React.ReactNode }) {
  return (
    <div className="chat-msg-enter flex gap-3 justify-end">
      <div className="flex flex-col items-end gap-1.5 max-w-[85%]">
        {text && (
          <div className="px-4 py-2.5 bg-gradient-to-br from-violet-600 to-purple-600 text-white text-sm rounded-2xl rounded-tr-md shadow-md shadow-violet-500/20 leading-relaxed whitespace-pre-wrap break-words">
            {text}
          </div>
        )}
        {children && (
          <div className="px-4 py-3 bg-gradient-to-br from-violet-600 to-purple-600 text-white text-sm rounded-2xl rounded-tr-md shadow-md shadow-violet-500/20">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Skeleton 加载（替换原 spinner）----
function SkeletonLoader({ text, spinnerClass = "text-violet-500" }: { text: string; spinnerClass?: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2.5">
        <Loader2 size={16} className={`animate-spin ${spinnerClass}`} />
        <span className="text-sm text-slate-600">{text}</span>
      </div>
      <div className="space-y-1.5 pl-6">
        <div className="ppt-skeleton h-2.5 rounded-full w-3/4" />
        <div className="ppt-skeleton h-2.5 rounded-full w-1/2" />
      </div>
    </div>
  );
}

// ---- 章节电影胶片卡 ----
function SectionFilmCard({
  index,
  section,
  onNameChange,
}: {
  index: number;
  section: PPTSection;
  onNameChange: (name: string) => void;
}) {
  const totalSlides = section.parts.reduce((a, p) => a + p.slides.length, 0);
  // 取该章节前若干张幻灯片的标题作为胶片帧预览
  const frames = section.parts.flatMap((p) => p.slides).slice(0, 12);

  return (
    <div className="ppt-film-card">
      <div className="ppt-film-perfs ppt-film-perfs-top" />
      <div className="ppt-film-body">
        <div className="ppt-film-header">
          <span className="ppt-film-num">{index + 1}</span>
          <input
            value={section.name}
            onChange={(e) => onNameChange(e.target.value)}
            className="ppt-film-title-input"
            placeholder="章节名称"
          />
          <span className="ppt-film-meta">
            {section.parts.length} 片段 · {totalSlides} 页
          </span>
        </div>
        {/* 胶片帧预览 */}
        {frames.length > 0 && (
          <div className="ppt-film-strip">
            {frames.map((s, i) => (
              <div key={i} className="ppt-film-frame" title={s.title || `第 ${s.index} 页`}>
                {s.index}
              </div>
            ))}
            {totalSlides > frames.length && (
              <div className="ppt-film-frame" style={{ background: "transparent", border: "1px dashed rgba(148,163,184,.3)", color: "rgba(148,163,184,.7)" }}>
                +{totalSlides - frames.length}
              </div>
            )}
          </div>
        )}
        {/* 片段列表 */}
        <div className="divide-y divide-slate-100/60 mt-1">
          {section.parts.map((part, pi) => (
            <div key={pi} className="ppt-film-part">
              <div className="ppt-film-part-dot" />
              <span className="ppt-film-part-name">{part.file_name}</span>
              <span className="ppt-film-part-range">
                P{part.slide_start}–{part.slide_end}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="ppt-film-perfs ppt-film-perfs-bottom" />
    </div>
  );
}

// ---- 修改方案 diff 卡片 ----
function PatchDiffCard({ patch, index }: { patch: PPTTextPatch; index: number }) {
  return (
    <div className="ppt-patch-card">
      <div className="ppt-patch-header">
        <span className="ppt-patch-num">{index + 1}</span>
        <FileText size={11} className="text-slate-400 shrink-0" />
        <span className="ppt-patch-file">{patch.file_name}</span>
        <span className="ppt-patch-slide">P{patch.slide}</span>
      </div>
      <div className="ppt-patch-diff">
        <div className="ppt-patch-side ppt-patch-before">
          <div className="ppt-patch-label">原文</div>
          {patch.text}
        </div>
        <div className="ppt-patch-arrow">
          <ChevronRight size={14} />
        </div>
        <div className="ppt-patch-side ppt-patch-after">
          <div className="ppt-patch-label">改为</div>
          {patch.new_text}
        </div>
      </div>
    </div>
  );
}

// ---- 解析进度子组件 ----
function AnalyzeProgress({
  files,
  progressMap,
}: {
  files: SelectedFile[];
  progressMap: Record<string, PPTProgressEvent>;
}) {
  const doneCount = files.filter((f) => progressMap[f.file_name]?.status === "done").length;
  const percent = files.length ? Math.round((doneCount / files.length) * 100) : 0;
  const activeFile = files.find((f) => {
    const s = progressMap[f.file_name]?.status;
    return s && s !== "done" && s !== "error";
  });

  const statusLabel: Record<string, string> = {
    parsing: "解析中",
    outline: "读取大纲",
    markitdown: "提取文本",
    done: "完成",
    error: "错误",
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="flex justify-between text-xs mb-1.5">
          <span className="text-slate-500 font-medium">总进度</span>
          <span className="text-slate-600 font-semibold tabular-nums">
            {doneCount} / {files.length} · {percent}%
          </span>
        </div>
        <div className="h-2 bg-slate-100 rounded-full overflow-hidden relative">
          <div
            className="h-full bg-gradient-to-r from-violet-500 via-purple-500 to-violet-500 rounded-full transition-all duration-500 ease-out relative overflow-hidden ppt-progress-shimmer"
            style={{ width: `${percent}%` }}
          />
        </div>
        {activeFile && (
          <div className="mt-1 text-[11px] text-violet-500 font-medium truncate">
            正在处理：{activeFile.file_name}
          </div>
        )}
      </div>
      <div className="space-y-1 max-h-48 overflow-auto pr-1 scrollbar-tiny">
        {files.map((f) => {
          const p = progressMap[f.file_name];
          const status = p?.status || "waiting";
          const isDone = status === "done";
          const isError = status === "error";
          const isActive = !isDone && !isError && p;
          return (
            <div
              key={f.file_path}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-all ${
                isDone
                  ? "bg-emerald-50/50"
                  : isError
                  ? "bg-rose-50/50"
                  : isActive
                  ? "bg-violet-50/50"
                  : "bg-slate-50/50"
              }`}
            >
              {isDone ? (
                <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
              ) : isError ? (
                <AlertCircle size={13} className="text-rose-500 shrink-0" />
              ) : isActive ? (
                <Loader2 size={13} className="text-violet-500 animate-spin shrink-0" />
              ) : (
                <div className="w-3 h-3 rounded-full border-2 border-slate-200 shrink-0" />
              )}
              <span className={`flex-1 truncate ${isDone ? "text-slate-600" : isError ? "text-rose-700" : "text-slate-700"}`}>
                {f.file_name}
              </span>
              {p?.slides != null && isDone && (
                <span className="text-[10px] text-emerald-600 bg-emerald-100/60 px-1.5 py-0.5 rounded font-medium shrink-0">
                  {p.slides} 页
                </span>
              )}
              {isActive && (
                <span className="text-[10px] text-violet-600 bg-violet-100/60 px-1.5 py-0.5 rounded font-medium shrink-0">
                  {statusLabel[status] || "处理中"}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
