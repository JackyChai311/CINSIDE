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
  ChevronRight,
  ChevronDown,
  Type,
  PenLine,
  CheckCheck,
  CircleDot,
  LayoutGrid,
  Columns,
  Minus,
  Square,
  Clapperboard,
  Settings2,
  FolderOpen,
  FolderPlus,
  Bookmark,
  Plus,
  Lock,
} from "lucide-react";
import { api } from "../api/client";
import appIconPng from "../assets/app-icon.png";
import type {
  PPTFileSlides,
  PPTOutlineSlide,
  PPTProgressEvent,
  PPTSection,
  PPTStyleProfile,
  PPTTextPatch,
} from "../types";
import {
  ReferenceLabelModal,
  ReferenceDropOverlay,
  ReferenceLibraryModal,
  buildReferenceContext,
  TAG_META,
  fileIcon,
  fileTypeMeta,
  detectFileType,
} from "./ReferenceBookmarks";
import { OutlineBoard } from "./OutlineBoard";
import type { ReferenceBookmark, PendingReferenceFile } from "./ReferenceBookmarks";
import SlidePreviewTray from "./SlidePreviewTray";
import CreateStreamBoard, {
  type StreamSlide,
  type StreamActive,
} from "./CreateStreamBoard";

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

// 解析输入中的 @引用：提取被提及的参考文件，并生成仅针对它们的参考上下文；
// 若没有 @引用，则沿用原有行为（附加全部参考文件）。
// mentioned 为显式 @ 提及的文件列表（即使为空也不回退），用于触发懒解析等。
function resolveMentions(
  text: string,
  bookmarks: ReferenceBookmark[]
): { cleanText: string; refCtx: string; mentioned: ReferenceBookmark[] } {
  const mentioned: ReferenceBookmark[] = [];
  let clean = text;
  for (const b of bookmarks) {
    const token = `@${b.file_name}`;
    if (clean.includes(token)) {
      mentioned.push(b);
      clean = clean.split(token).join("");
    }
  }
  clean = clean.replace(/@\S+/g, "").trim();
  const refs = mentioned.length ? mentioned : bookmarks;
  const refCtx = buildReferenceContext(refs).trim();
  return { cleanText: clean, refCtx, mentioned };
}

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
  // 批量编辑：文件勾选确认后才解封输入框
  const [batchConfirmed, setBatchConfirmed] = useState(false);

  // 模式：create=PPT制作（文字新建），batch=批量编辑PPT，video=PPT转视频（暂未实现）
  const [activeMode, setActiveMode] = useState<"create" | "batch" | "video">("create");
  // 幻灯片预览窗口数量（1/2/3）
  const [previewSlots, setPreviewSlots] = useState(1);
  // 各预览槽位当前显示的文件 id（由 SlidePreviewTray 上报，用于参考预览时保持原槽位）
  const slotFileIdsRef = useRef<(string | null)[]>([]);
  // 打开参考预览时指定各槽位初始显示的文件 id
  const [previewInitialFileIds, setPreviewInitialFileIds] = useState<(string | null)[]>([]);
  // 按文字新建 PPT
  const [creating, setCreating] = useState(false);
  const [createdResult, setCreatedResult] = useState<{
    file_path: string;
    file_name: string;
    total_slides: number;
  } | null>(null);
  const [createText, setCreateText] = useState("");
  // 流式生成看板：AI 逐步放置文字元素
  const [streamSlides, setStreamSlides] = useState<StreamSlide[]>([]);
  const [streamActive, setStreamActive] = useState<StreamActive | null>(null);
  const [streamDone, setStreamDone] = useState(false);
  // 风格选择："auto"=AI 自动选 / 预设风格 name
  // 参考 PPT 的风格不再在上传时即时拆解，而是在用户 @ 引用该 PPT 时懒解析，结果缓存于此
  const [stylePresets, setStylePresets] = useState<PPTStyleProfile[]>([]);
  const [styleChoice, setStyleChoice] = useState<string>("auto");
  const [styleCache, setStyleCache] = useState<Record<string, PPTStyleProfile>>({});
  const [parsingStyleFor, setParsingStyleFor] = useState<string | null>(null);
  // AI 实际采用的风格名（大纲事件回传，用于展示）
  const [appliedStyleName, setAppliedStyleName] = useState("");

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
  const [showRefLibrary, setShowRefLibrary] = useState(false);
  const [outlineDraft, setOutlineDraft] = useState<{ text: string; style: PPTStyleProfile | null } | null>(null);
  const [outlineKey, setOutlineKey] = useState(0);
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

  // 从参考资料库弹窗点击「引用」：把 @文件名 插入输入框光标位置
  const handleInsertMention = useCallback((b: ReferenceBookmark) => {
    const token = `@${b.file_name} `;
    const ta = textareaRef.current;
    if (ta) {
      const start = ta.selectionStart ?? chatInput.length;
      const end = ta.selectionEnd ?? chatInput.length;
      const next = chatInput.slice(0, start) + token + chatInput.slice(end);
      setChatInput(next);
      requestAnimationFrame(() => {
        ta.focus();
        const pos = start + token.length;
        ta.setSelectionRange(pos, pos);
      });
    } else {
      setChatInput((prev) => (prev ? `${prev} ${token}` : token));
    }
    setShowRefLibrary(false);
  }, [chatInput]);

  // 从左侧参考栏打开某个参考文件的预览：加到预览文件列表，并自动把窗口数调到 2，
  // 且新窗口指向该参考文件、原窗口保持当前预览的文件。
  const handlePreviewRef = useCallback(async (bookmark: ReferenceBookmark) => {
    setError(null);
    try {
      const refId = `ref_${bookmark.id}`;
      // 获取参考文件页数（PPT / PDF）
      const { page_count } = await api.pptPageCount(bookmark.file_path);
      // 将参考文件加入 fileSlides（含正确页数）
      setFileSlides((prev) => {
        if (prev.some((f) => f.file_id === refId)) {
          // 已存在则仅校正页数
          return prev.map((f) =>
            f.file_id === refId
              ? {
                  ...f,
                  slides: Array.from({ length: page_count }, (_, i) => ({
                    index: i + 1,
                    path: "",
                    title: `第 ${i + 1} 页`,
                    texts: [],
                  })),
                }
              : f
          );
        }
        return [
          ...prev,
          {
            file_id: refId,
            file_name: bookmark.file_name,
            file_path: bookmark.file_path,
            slides: Array.from({ length: page_count }, (_, i) => ({
              index: i + 1,
              path: "",
              title: `第 ${i + 1} 页`,
              texts: [],
            })),
          },
        ];
      });
      // 左侧预览窗聚焦该参考文件（单窗口 = 左侧参考预览，右侧继续制作 PPT）
      setPreviewInitialFileIds([refId]);
      setPreviewSlots(1);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "无法预览参考文件");
    }
  }, []);

  // 通过文件选择器添加参考文件（左侧栏 + 号）
  const handlePickReferenceFiles = useCallback(async () => {
    try {
      const result = await window.electronAPI?.pickReferenceFiles?.();
      if (result?.canceled || !result?.files?.length) return;
      const pending: PendingReferenceFile[] = result.files
        .filter((f) => /\.(ppt|pptx|pdf|png|jpe?g|gif|webp|bmp|svg)$/i.test(f.file_name))
        .map((f) => ({
          file_name: f.file_name,
          file_path: f.file_path,
          file_type: detectFileType(f.file_name),
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
      if (!/\.(ppt|pptx|pdf|png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) continue;
      // Electron：通过 preload 获取真实磁盘路径
      const filePath = window.electronAPI?.getPathForFile?.(file) || (file as unknown as { path?: string }).path || "";
      if (!filePath) continue;
      pending.push({
        file_name: name,
        file_path: filePath,
        file_type: detectFileType(name),
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
  const handlePickFiles = useCallback(async (autoAnalyze = false) => {
    setError(null);
    try {
      const result = await window.electronAPI?.pickPptFiles?.();
      if (result?.canceled || !result?.files?.length) return;
      const newFiles = result.files.filter(
        (f) => !selectedFiles.some((s) => s.file_path === f.file_path)
      );
      if (newFiles.length === 0) return;
      setSelectedFiles((prev) => [...prev, ...newFiles]);
      setEnabledPaths((prev) => {
        const next = new Set(prev);
        newFiles.forEach((f) => next.add(f.file_path));
        return next;
      });
      // PPT 制作模式：选完文件后自动解析以显示三槽预览
      if (autoAnalyze && newFiles.length > 0) {
        const paths = newFiles.map((f) => f.file_path);
        setAnalyzing(true);
        setLoading(true);
        setProgressMap({});
        try {
          const files = await api.pptAnalyzeStream(paths, (ev) => {
            setProgressMap((prev) => ({ ...prev, [ev.file]: ev }));
          });
          setFileSlides((prev) => {
            const existing = new Set(prev.map((f) => f.file_path));
            const fresh = files.filter((f) => !existing.has(f.file_path));
            return [...prev, ...fresh];
          });
        } catch (e: unknown) {
          setError(e instanceof Error ? e.message : "解析失败");
        } finally {
          setAnalyzing(false);
          setLoading(false);
        }
      }
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
    api.pptStylePresets().then((r) => setStylePresets(r.presets)).catch(() => {});
  }, []);

  // 当前显式选择的风格（null = AI 自动；@ 提及的参考 PPT 风格在发送时懒解析后叠加）
  const activeStyle: PPTStyleProfile | null =
    styleChoice === "auto"
      ? null
      : stylePresets.find((p) => p.name === styleChoice) ?? null;

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
      const { cleanText, refCtx } = resolveMentions(instructionText, referenceBookmarks);
      const promptText = refCtx ? `${refCtx}\n\n---\n\n用户指令：${cleanText}` : cleanText;
      const res = await api.pptDetectSections(fileSlides, promptText);
      setSections(res.sections);
      setReadingScript(res.readingScript);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Section 识别失败");
    } finally {
      setDetecting(false);
      setLoading(false);
    }
  }, [fileSlides, referenceBookmarks]);

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
      const { cleanText, refCtx } = resolveMentions(instructionText, referenceBookmarks);
      const promptText = refCtx ? `${refCtx}\n\n---\n\n用户指令：${cleanText}` : cleanText;
      const res = await api.pptModify(sections, promptText);
      setPatches(res.patches);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "AI 修改失败");
    } finally {
      setModifying(false);
      setLoading(false);
    }
  }, [sections, referenceBookmarks]);

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
    setOutlineDraft(null);
    setStreamSlides([]);
    setStreamActive(null);
    setStreamDone(false);
    setAppliedStyleName("");
    setError(null);
    setChatInput("");
    setBatchConfirmed(false);
  }, []);

  // 下载生成的 PPT 文件
  const handleDownload = useCallback(() => {
    if (!createdResult?.file_path) return;
    // 使用 Electron 的 shell.openPath 打开文件所在目录
    window.electronAPI?.showItemInFolder?.(createdResult.file_path);
  }, [createdResult]);

  // 切换模式时重置批量确认状态
  const handleModeSwitch = useCallback((mode: "create" | "batch" | "video") => {
    setActiveMode(mode);
    if (mode === "batch") setBatchConfirmed(false);
  }, []);

  // ---- 批量编辑：确认勾选的文件并开始解析 ----
  const handleBatchConfirm = useCallback(async () => {
    const paths = selectedFiles
      .filter((f) => enabledPaths.has(f.file_path))
      .map((f) => f.file_path);
    if (!paths.length) {
      setError("请至少勾选一个 PPT 文件");
      return;
    }
    setBatchConfirmed(true);
    setAnalyzing(true);
    setLoading(true);
    setError(null);
    setProgressMap({});
    try {
      const files = await api.pptAnalyzeStream(paths, (ev) => {
        setProgressMap((prev) => ({ ...prev, [ev.file]: ev }));
      });
      setFileSlides((prev) => {
        const existing = new Set(prev.map((f) => f.file_path));
        const fresh = files.filter((f) => !existing.has(f.file_path));
        return [...prev, ...fresh];
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "解析失败");
      setBatchConfirmed(false);
    } finally {
      setAnalyzing(false);
      setLoading(false);
    }
  }, [selectedFiles, enabledPaths]);

  // ---- 按文字新建 PPT（流式：实时显示 AI 一步步放置文字元素） ----
  const handleCreateFromText = useCallback(async (
    text: string,
    styleToUse: PPTStyleProfile | null,
    confirmedSlides?: PPTOutlineSlide[],
    addBackground?: boolean
  ) => {
    setCreating(true);
    setLoading(true);
    setError(null);
    setCreatedResult(null);
    setStreamSlides([]);
    setStreamActive(null);
    setStreamDone(false);
    setCreateText(text);
    try {
      const res = await api.pptCreateFromTextStream(
        text,
        (ev) => {
          if (ev.type === "outline") {
            if (ev.style?.display_name) setAppliedStyleName(ev.style.display_name);
            setStreamSlides(
              ev.slides.map((s, i) => ({
                slide: i + 1,
                title: "",
                bullets: [],
                image: (s.image_prompt ? "generating" : "none") as StreamSlide["image"],
              }))
            );
          } else if (ev.type === "add_text") {
            setStreamActive({ slide: ev.slide, element: ev.element });
            setStreamSlides((prev) =>
              prev.map((s) => {
                if (s.slide !== ev.slide) return s;
                if (ev.element === "title") return { ...s, title: ev.text };
                return { ...s, bullets: [...s.bullets, ev.text] };
              })
            );
          } else if (ev.type === "add_decor") {
            setStreamSlides((prev) =>
              prev.map((s) => (s.slide === ev.slide ? { ...s, decor: ev.element } : s))
            );
          } else if (ev.type === "add_image") {
            setStreamSlides((prev) =>
              prev.map((s) => (s.slide === ev.slide ? { ...s, image: ev.status } : s))
            );
          } else if (ev.type === "screenshot") {
            setStreamSlides((prev) =>
              prev.map((s) => (s.slide === ev.slide ? { ...s, frame: ev.image_data } : s))
            );
          }
        },
        styleToUse,
        confirmedSlides ?? null,
        addBackground ?? false
      );

      if (!res) throw new Error("生成结果为空");
      setStreamDone(true);
      setCreatedResult(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "生成 PPT 失败");
    } finally {
      setCreating(false);
      setLoading(false);
    }
  }, []);

  // ---- 发送前准备：解析 @ 引用 + 懒解析参考 PPT 风格，然后弹出大纲确认 ----
  const prepareAndDraftOutline = useCallback(async (rawText: string) => {
    setError(null);
    setCreateText(rawText);

    const { cleanText, refCtx, mentioned } = resolveMentions(rawText, referenceBookmarks);
    const prompt = refCtx ? `${refCtx}\n\n---\n\n用户需求：${cleanText}` : cleanText;

    let styleToUse = activeStyle;
    const mentionedPpts = mentioned.filter((b) => b.file_type === "ppt");
    if (mentionedPpts.length > 0) {
      const justParsed: Record<string, PPTStyleProfile> = {};
      for (const b of mentionedPpts) {
        const cached = styleCache[b.file_path] || justParsed[b.file_path];
        if (cached) {
          if (!styleToUse) styleToUse = cached;
          continue;
        }
        setParsingStyleFor(b.file_path);
        try {
          const res = await api.pptAnalyzeStyle(b.file_path);
          justParsed[b.file_path] = res.style;
          setStyleCache((prev) => ({ ...prev, [b.file_path]: res.style }));
          if (!styleToUse) styleToUse = res.style;
        } catch (e) {
          setError(e instanceof Error ? `参考风格拆解失败：${e.message}` : "参考风格拆解失败");
        } finally {
          setParsingStyleFor(null);
        }
      }
    }

    setOutlineDraft({ text: prompt, style: styleToUse });
    setOutlineKey((k) => k + 1);
  }, [referenceBookmarks, activeStyle, styleCache]);

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
      // PPT 制作：先出大纲供用户编辑确认，再生成
      prepareAndDraftOutline(text);
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
  }, [chatInput, activeMode, fileSlides.length, sections.length, mergedResult, runDetect, runModify, prepareAndDraftOutline]);

  // ---- 输入框 @ 引用参考文件 ----
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStart, setMentionStart] = useState(0); // 当前 @ 在输入文本中的起始索引
  const [mentionActive, setMentionActive] = useState(0); // 下拉列表中高亮项
  const mentionRef = useRef<HTMLDivElement>(null);

  // 过滤后的可引用文件列表
  const mentionFiltered = useMemo(() => {
    if (referenceBookmarks.length === 0) return [];
    const q = mentionQuery.trim().toLowerCase();
    if (!q) return referenceBookmarks;
    return referenceBookmarks.filter((b) => b.file_name.toLowerCase().includes(q));
  }, [referenceBookmarks, mentionQuery]);

  const closeMention = useCallback(() => {
    setMentionOpen(false);
    setMentionQuery("");
  }, []);

  // 在输入框内容变化时检测末尾的 @ 并打开下拉
  const handleChatChange = useCallback(
    (value: string) => {
      setChatInput(value);
      const caret = textareaRef.current?.selectionStart ?? value.length;
      // 从光标往前找最近的 @，要求 @ 与该位置之间没有空格/换行
      let start = -1;
      for (let i = caret - 1; i >= 0; i--) {
        const ch = value[i];
        if (ch === "@") {
          start = i;
          break;
        }
        if (ch === " " || ch === "\n") break;
      }
      if (start >= 0) {
        const query = value.slice(start + 1, caret);
        setMentionStart(start);
        setMentionQuery(query);
        setMentionActive(0);
        setMentionOpen(true);
      } else {
        closeMention();
      }
    },
    [closeMention]
  );

  // 选中某个参考文件，写入 @文件名
  const applyMention = useCallback(
    (b: ReferenceBookmark) => {
      const before = chatInput.slice(0, mentionStart);
      const after = chatInput.slice(textareaRef.current?.selectionStart ?? chatInput.length);
      const next = `${before}@${b.file_name} ${after}`;
      setChatInput(next);
      closeMention();
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          const pos = before.length + b.file_name.length + 2;
          ta.focus();
          ta.setSelectionRange(pos, pos);
        }
      });
    },
    [chatInput, mentionStart, closeMention]
  );

  // 下拉的键盘导航与 @ 选择
  const handleChatKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const isMentionActive = mentionOpen && mentionFiltered.length > 0;
      if (isMentionActive) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionActive((i) => (i + 1) % mentionFiltered.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionActive((i) => (i - 1 + mentionFiltered.length) % mentionFiltered.length);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          applyMention(mentionFiltered[mentionActive]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeMention();
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [mentionOpen, mentionFiltered, mentionActive, applyMention, closeMention, handleSend]
  );

  // 点击下拉外部时关闭
  useEffect(() => {
    if (!mentionOpen) return;
    const onDown = (e: MouseEvent) => {
      if (mentionRef.current && !mentionRef.current.contains(e.target as Node)) {
        closeMention();
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [mentionOpen, closeMention]);

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
    if (activeMode === "batch" && !batchConfirmed) return "请先在上方勾选文件并确认，再开始对话…";
    if (fileSlides.length === 0) return "请先选择 PPT 文件，再告诉 AI 怎么批量编辑…";
    if (sections.length === 0) return "告诉 AI 怎么拆分章节，例如：帮我把读课文部分拆出来";
    if (!mergedResult) return "输入新的拆分要求重新识别，或点击下方按钮生成合并总览…";
    if (patches.length === 0) return "告诉 AI 需要修改什么，例如：统一术语、修正错别字…";
    return "输入新的修改要求，或点击回填按钮写回原 PPT…";
  }, [activeMode, batchConfirmed, fileSlides.length, sections.length, mergedResult, patches.length]);

  // 批量编辑模式：未确认文件前输入框锁定
  const inputLocked = activeMode === "batch" && !batchConfirmed;
  const canSend = chatInput.trim().length > 0 && !loading && !inputLocked;

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
              onClick={() => handleModeSwitch("create")}
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
              onClick={() => handleModeSwitch("batch")}
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
              onClick={() => handleModeSwitch("video")}
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
          {/* 预览窗口数量三态按钮 */}
          <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-white/70 ring-1 ring-slate-200/60" title="幻灯片预览窗口数量：1个/2个/3个">
            {[
              { n: 1, Icon: Square },
              { n: 2, Icon: Columns },
              { n: 3, Icon: LayoutGrid },
            ].map(({ n, Icon }) => (
              <button
                key={n}
                onClick={() => setPreviewSlots(n)}
                className={`flex h-5 w-5 items-center justify-center rounded transition-all ${
                  previewSlots === n
                    ? "bg-brand-500 text-white shadow-sm"
                    : "text-slate-500 hover:bg-white hover:text-slate-800"
                }`}
              >
                <Icon className="h-3 w-3" />
              </button>
            ))}
          </div>

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
                    handleModeSwitch("batch");
                    setBatchConfirmed(false);
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
                    handleModeSwitch("batch");
                    setBatchConfirmed(false);
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

      {/* ===== 主体：左侧预览窗 + 右侧制作区（单窗口时仅右侧，有预览文件时自动切双窗口） ===== */}
      <div className="ppt-body flex flex-1 overflow-hidden relative z-10">
        {/* 左侧预览窗：参考预览 / 生成的 PPT */}
        {fileSlides.length > 0 && (
          <div className="ppt-preview-dock shrink-0">
            <SlidePreviewTray
              files={fileSlides}
              slotCount={previewSlots}
              initialFileIds={previewInitialFileIds}
              onSlotsChange={(ids) => { slotFileIdsRef.current = ids; }}
            />
          </div>
        )}

        {/* 右侧制作区（聊天 + 生成看板） */}
        <main ref={scrollRef} className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">

          {/* 用户新建 PPT 的文字输入 */}
          {createText && (creating || createdResult || outlineDraft) && (
            <UserMessage text={createText} />
          )}

          {/* 内联大纲面板：流式展示 AI 写大纲过程，完成后可编辑确认 */}
          {outlineDraft && !creating && (
            <AIMessage>
              <OutlineBoard
                key={outlineKey}
                text={outlineDraft.text}
                onConfirm={(slides, addBackground) => {
                  const { text, style } = outlineDraft;
                  setOutlineDraft(null);
                  handleCreateFromText(text, style, slides, addBackground);
                }}
                onRegenerate={() => setOutlineKey((k) => k + 1)}
                onCancel={() => {
                  setOutlineDraft(null);
                  setCreateText("");
                }}
              />
            </AIMessage>
          )}

          {/* 新建 PPT：生成中实时展示放置过程；完成后看板合并为居中查看器（不再消失/跳侧栏）
              外层突破 max-w-3xl 窄容器，让幻灯片画面充分利用两侧宽度 */}
          {(creating || (createdResult && streamSlides.length > 0)) && (
            <div className="relative left-1/2 -translate-x-1/2 w-[min(1180px,calc(100vw-3rem))]">
              <AIMessage>
                <CreateStreamBoard
                  slides={streamSlides}
                  active={streamActive}
                  done={streamDone}
                  fileName={createdResult?.file_name}
                  filePath={createdResult?.file_path}
                  onFrameUpdate={(slide, img) =>
                    setStreamSlides((prev) =>
                      prev.map((s) => (s.slide === slide ? { ...s, frame: img } : s))
                    )
                  }
                  onReset={streamDone ? handleReset : undefined}
                  onDownload={streamDone ? handleDownload : undefined}
                />
              </AIMessage>
            </div>
          )}

          {/* ==== 批量编辑：文件选择面板 ==== */}
          {activeMode === "batch" && !batchConfirmed && !analyzing && (
            <div className="batch-file-panel">
              {selectedFiles.length === 0 ? (
                /* 空状态：添加文件 */
                <button
                  onClick={() => handlePickFiles()}
                  className="batch-empty-zone w-full flex flex-col items-center justify-center gap-3 py-16 px-6 rounded-2xl border-2 border-dashed border-slate-200 hover:border-violet-300 hover:bg-violet-50/30 transition-all group cursor-pointer"
                >
                  <div className="w-14 h-14 rounded-2xl bg-slate-50 group-hover:bg-violet-100 flex items-center justify-center transition-all">
                    <Plus size={26} className="text-slate-400 group-hover:text-violet-500" />
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-semibold text-slate-700 group-hover:text-violet-700">
                      添加 PPT 文件
                    </div>
                    <div className="text-xs text-slate-400 mt-1">
                      点击选择，或从工作文件中添加
                    </div>
                  </div>
                </button>
              ) : (
                /* 文件列表：勾选确认 */
                <div className="batch-file-list-panel rounded-2xl border border-slate-200/80 bg-white/70 backdrop-blur-sm overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
                    <div className="flex items-center gap-2">
                      <Presentation size={15} className="text-violet-500" />
                      <span className="text-sm font-semibold text-slate-700">工作区文件</span>
                      <span className="text-xs text-slate-400">
                        已勾选 {enabledPaths.size}/{selectedFiles.length}
                      </span>
                    </div>
                    <button
                      onClick={() => handlePickFiles()}
                      className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-violet-600 hover:bg-violet-50 rounded-lg transition-all"
                    >
                      <Plus size={13} />
                      添加
                    </button>
                  </div>
                  <div className="max-h-[340px] overflow-auto p-2 space-y-1">
                    {selectedFiles.map((f) => {
                      const enabled = enabledPaths.has(f.file_path);
                      return (
                        <label
                          key={f.file_path}
                          className={`batch-file-row flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all ${
                            enabled
                              ? "bg-violet-50/70 ring-1 ring-violet-200/60"
                              : "hover:bg-slate-50"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={() => toggleFileEnabled(f.file_path)}
                            className="w-4 h-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500 cursor-pointer"
                          />
                          <div className="w-8 h-8 rounded-lg bg-violet-100/70 flex items-center justify-center shrink-0">
                            <FileText size={15} className="text-violet-500" />
                          </div>
                          <span className="flex-1 truncate text-sm text-slate-700">
                            {f.file_name}
                          </span>
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              handleRemoveFile(f.file_path);
                            }}
                            className="p-1 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-all"
                          >
                            <X size={14} />
                          </button>
                        </label>
                      );
                    })}
                  </div>
                  <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 bg-slate-50/50">
                    <button
                      onClick={() => {
                        const allEnabled = selectedFiles.every((f) =>
                          enabledPaths.has(f.file_path)
                        );
                        setEnabledPaths((prev) => {
                          const next = new Set(prev);
                          if (allEnabled) {
                            selectedFiles.forEach((f) => next.delete(f.file_path));
                          } else {
                            selectedFiles.forEach((f) => next.add(f.file_path));
                          }
                          return next;
                        });
                      }}
                      className="text-xs text-slate-500 hover:text-violet-600 transition-colors"
                    >
                      {selectedFiles.every((f) => enabledPaths.has(f.file_path))
                        ? "取消全选"
                        : "全选"}
                    </button>
                    <button
                      onClick={handleBatchConfirm}
                      disabled={!enabledPaths.size}
                      className="flex items-center gap-1.5 px-5 py-2 bg-violet-600 text-white text-sm font-semibold rounded-xl hover:bg-violet-700 active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
                    >
                      确认并解析
                      <ChevronRight size={15} />
                    </button>
                  </div>
                </div>
              )}
            </div>
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
      </div>

      {/* 底部输入栏 */}
      <footer
        className={`ppt-input-footer shrink-0 px-5 py-3 relative z-10 transition-all ${
          inputFocused ? "ppt-input-focused" : ""
        }`}
      >
        <div className="max-w-3xl mx-auto">
          {/* 风格选择行：AI 自动 / 预制教育风格 / 上传参考 PPT 拆解 */}
          {activeMode === "create" && (
            <div className="ppt-style-row">
              <span className="ppt-style-label">风格</span>
              <button
                className={`ppt-style-chip ${styleChoice === "auto" ? "ppt-style-chip-on" : ""}`}
                onClick={() => setStyleChoice("auto")}
                title="AI 根据主题自动挑选最合适的教育风格"
              >
                <Sparkles size={10} />
                AI 自动
              </button>
              {stylePresets.map((p) => (
                <button
                  key={p.name}
                  className={`ppt-style-chip ${styleChoice === p.name ? "ppt-style-chip-on" : ""}`}
                  onClick={() => setStyleChoice(p.name)}
                  title={p.style_notes}
                >
                  <span className="ppt-style-dots">
                    {p.palette.slice(0, 3).map(([accent]) => (
                      <i key={accent} style={{ background: accent }} />
                    ))}
                  </span>
                  {p.display_name}
                </button>
              ))}
              {appliedStyleName && (creating || streamDone) && (
                <span className="ppt-style-applied">已采用「{appliedStyleName}」</span>
              )}
            </div>
          )}
          <div className="ppt-input-shell relative flex items-end gap-2 p-2 rounded-2xl transition-all">
            {(activeMode === "batch" || activeMode === "create" || activeMode === "video") && (
              <button
                onClick={() => {
                  if (activeMode === "create") {
                    // PPT 制作模式：回形针与拖拽效果一致——添加为参考文件（走打标签流程）
                    handlePickReferenceFiles();
                  } else {
                    handlePickFiles(activeMode !== "batch");
                  }
                }}
                className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-all shrink-0"
                title={activeMode === "create" ? "添加 PPT/PDF 作为参考" : "添加 PPT 文件进行预览"}
              >
                <Paperclip size={18} />
              </button>
            )}
            <textarea
              ref={textareaRef}
              value={chatInput}
              onChange={(e) => handleChatChange(e.target.value)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              onKeyDown={handleChatKeyDown}
              placeholder={inputPlaceholder}
              rows={1}
              disabled={inputLocked}
              className={`flex-1 bg-transparent border-none outline-none resize-none text-sm text-slate-800 placeholder:text-slate-400 py-2 leading-relaxed ${
                inputLocked ? "opacity-50 cursor-not-allowed" : ""
              }`}
            />
            {/* @ 引用参考文件下拉 */}
            {mentionOpen && mentionFiltered.length > 0 && (
              <div
                ref={mentionRef}
                className="absolute bottom-full left-0 mb-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white/95 shadow-xl backdrop-blur-md z-40"
                style={{ animation: "ppt-mention-in .15s ease-out" }}
              >
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100">
                  <span className="text-[10px] font-medium text-slate-400">引用参考文件</span>
                  <span className="text-[10px] text-slate-300">↑↓选择 · Enter确认 · Esc关闭</span>
                </div>
                <div className="max-h-52 overflow-y-auto py-1">
                  {mentionFiltered.map((b, i) => {
                    const Icon = fileIcon(b.file_type);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applyMention(b);
                        }}
                        onMouseEnter={() => setMentionActive(i)}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                          i === mentionActive ? "bg-brand-50 text-brand-700" : "text-slate-600"
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <span className="truncate font-medium">{b.file_name}</span>
                        <span className="ml-auto shrink-0 text-[10px] text-slate-400">{TAG_META[b.tag].label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <button
              onClick={handleSend}
              disabled={!canSend}
              className="ppt-send-btn p-2 rounded-xl bg-slate-900 text-white hover:bg-slate-800 active:scale-95 transition-all disabled:opacity-30 disabled:cursor-not-allowed disabled:active:scale-100 shrink-0"
            >
              <SendHorizontal size={17} />
            </button>
          </div>
          <div className="flex items-center justify-between mt-1.5 px-1 gap-2">
            <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
              {activeMode === "create" && referenceBookmarks.length > 0 ? (
                <>
                  {referenceBookmarks.map((b) => {
                    const Icon = fileIcon(b.file_type);
                    const tm = fileTypeMeta(b.file_type);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => setShowRefLibrary(true)}
                        className={`group inline-flex shrink-0 items-center gap-1 rounded-full pl-1 pr-2 py-0.5 text-[10px] font-medium ring-1 transition-all ${tm.bg} ${tm.fg} ring-current/10 hover:ring-current/30`}
                        title={`${TAG_META[b.tag].label} · ${b.file_name}\n${b.description}`}
                      >
                        <span className={`flex h-4 w-4 items-center justify-center rounded-full bg-white/70 ${tm.fg}`}>
                          <Icon className="h-2.5 w-2.5" />
                        </span>
                        <span className="max-w-[100px] truncate">{b.file_name}</span>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveRef(b.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.stopPropagation();
                              handleRemoveRef(b.id);
                            }
                          }}
                          className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full opacity-0 group-hover:opacity-100 hover:bg-black/10 transition-opacity"
                        >
                          <X className="h-2.5 w-2.5" />
                        </span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => setShowRefLibrary(true)}
                    className="inline-flex shrink-0 items-center justify-center h-5 w-5 rounded-full bg-slate-50 text-slate-400 ring-1 ring-slate-200/60 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                    title="参考资料库"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                </>
              ) : activeMode === "create" ? (
                <button
                  type="button"
                  onClick={() => setShowRefLibrary(true)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-slate-50 text-slate-500 ring-1 ring-slate-200/60 hover:bg-slate-100 transition-colors"
                  title="查看已保存的参考资料与 PPT 模板"
                >
                  <Bookmark className="h-2.5 w-2.5" />
                  参考资料库
                </button>
              ) : null}
              <span className="text-[10px] text-slate-400 truncate flex items-center gap-1">
                {inputLocked && <Lock size={10} className="shrink-0" />}
                {activeMode === "video"
                  ? "可添加 PPT 预览幻灯片，或输入内容描述视频（即将上线）"
                  : activeMode === "create"
                  ? "直接输入主题或大纲，AI 生成新 PPT（可拖入 PPT/PDF/图片 作为参考）"
                  : inputLocked
                  ? "请先在上方勾选文件并点击「确认并解析」"
                  : fileSlides.length === 0
                  ? "请先选择文件进行批量编辑，或切换到「PPT 制作」直接新建"
                  : "按 Enter 发送 · Shift+Enter 换行"}
              </span>
            </div>
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

      {/* 参考资料库弹窗：已保存参考资料 + PPT 模板 */}
      {showRefLibrary && (
        <ReferenceLibraryModal
          bookmarks={referenceBookmarks}
          templates={stylePresets}
          activeTemplateName={styleChoice}
          onSelectTemplate={(name) => {
            setStyleChoice(name);
            setShowRefLibrary(false);
          }}
          onRemove={handleRemoveRef}
          onPreview={handlePreviewRef}
          onInsertMention={handleInsertMention}
          onPickFiles={handlePickReferenceFiles}
          onClose={() => setShowRefLibrary(false)}
        />
      )}

      <style>{`
        /* ===== 风格选择行 ===== */
        .ppt-style-row {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
          padding: 0 4px 8px;
        }
        .ppt-style-label {
          font-size: 10px;
          font-weight: 600;
          color: #94a3b8;
          margin-right: 2px;
        }
        .ppt-style-chip {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 11px;
          font-weight: 500;
          color: #475569;
          background: rgba(255, 255, 255, 0.7);
          border: 1px solid #e2e8f0;
          padding: 3px 10px;
          border-radius: 999px;
          cursor: pointer;
          transition: all 0.18s;
        }
        .ppt-style-chip:hover:not(:disabled) {
          border-color: #c4b5fd;
          color: #6d28d9;
          background: #faf5ff;
        }
        .ppt-style-chip:disabled { opacity: 0.6; cursor: default; }
        .ppt-style-chip-on {
          color: #6d28d9;
          background: #f5f3ff;
          border-color: #a78bfa;
          box-shadow: 0 1px 4px rgba(124, 58, 237, 0.15);
        }
        .ppt-style-dots { display: inline-flex; gap: 2px; }
        .ppt-style-dots i {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          display: block;
        }
        .ppt-style-applied {
          font-size: 10px;
          color: #059669;
          background: #ecfdf5;
          border: 1px solid #a7f3d0;
          padding: 2px 8px;
          border-radius: 999px;
        }
        /* ===== 主体：左侧预览窗 + 右侧制作区 ===== */
        .ppt-body { min-width: 0; }
        .ppt-preview-dock {
          width: clamp(320px, 32vw, 480px);
          border-right: 1px solid #e2e8f0;
          background: rgba(248, 250, 252, 0.6);
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          overflow-y: auto;
          padding: 14px;
          animation: ppt-dock-in 0.28s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .ppt-preview-dock .spt-root {
          width: 100%;
          left: 0;
          transform: none;
        }
        @keyframes ppt-dock-in {
          from { opacity: 0; transform: translateX(-16px); }
          to { opacity: 1; transform: translateX(0); }
        }
        /* 参考预览在窄窗内：不让文件选择器溢出 */
        .ppt-preview-dock .spt-slot-topbar,
        .ppt-preview-dock .spt-navbar { padding-left: 8px; padding-right: 8px; }

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
        .ppt-phase-current { background: transparent; }
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
        @keyframes ppt-mention-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
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
        html[data-theme="dark"] .ppt-phase-current { background: transparent; }
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

// ---- AI 消息气泡（无头像，内容直接铺开） ----
function AIMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="chat-msg-enter">
      <div className="min-w-0">
        {children}
      </div>
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
