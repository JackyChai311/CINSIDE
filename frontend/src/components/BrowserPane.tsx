import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ExternalLink,
  FileSpreadsheet,
  Globe,
  Loader2,
  MousePointerClick,
  Plus,
  RefreshCw,
  Search,
  SquareArrowOutUpRight,
  Upload,
  X,
} from "lucide-react";
import type { ViewSide } from "../electron";

interface Props {
  side: ViewSide;
  title: string;
  subtitle?: string;
  url: string;
  onUrlChange: (url: string) => void;
  /** 是否处于元素选择模式（影响光标和提示） */
  picking: boolean;
  /** 选择模式时点击元素的回调 */
  onPickedElement?: (info: PickedElementInfo) => void;
  /** 核验状态：用于外框颜色（绿=一致 / 红=不一致） */
  verifyStatus?: "idle" | "scanning" | "match" | "mismatch";
  /** 是否禁用 URL 输入（核验中） */
  disabled?: boolean;
  /** 空状态提示 */
  emptyHint?: string;
  children?: React.ReactNode;
  /** 脱离模式：使用 detachedView* API 而非 view* */
  detachedSide?: string;
  /** 脱离按钮回调 */
  onDetach?: () => void;
  /** 在标题栏右侧额外渲染的内容（非tabs模式下使用） */
  headerExtra?: React.ReactNode;
  /** 是否有弹窗（window.open）激活 */
  popupActive?: boolean;
  /** 关闭弹窗回调 */
  onClosePopup?: () => void;
  /** 是否启用多标签页 */
  enableTabs?: boolean;
  /** 支持网页/Excel视图切换（左侧面板使用） */
  enableViewSwitch?: boolean;
  /** 当前视图模式 */
  viewMode?: "web" | "excel";
  /** 视图切换回调 */
  onViewModeChange?: (mode: "web" | "excel") => void;
  /** Excel标签标题（enableViewSwitch时使用） */
  excelTabTitle?: string;
  /** 是否有Excel数据（控制Excel模式是否显示Tab） */
  hasExcelData?: boolean;
  /** 当前Excel文件名（用于Tab显示） */
  excelFileName?: string;
  /** 请求添加Excel文件回调（点击+按钮时触发） */
  onRequestAddExcel?: () => void;
  /** Excel模式下的空状态内容（无数据时显示） */
  excelEmptyState?: React.ReactNode;
  /** Web模式下的空状态内容（无URL时显示） */
  webEmptyState?: React.ReactNode;
  /** 新标签页标题（如"CINSIDE SEARCH"），设置后在Web空状态显示居中搜索页 */
  newTabTitle?: string;
}

interface BrowserTab {
  id: string;
  url: string;
  title?: string;
}

export interface PickedElementInfo {
  selector: string;
  label: string;
  value: string;
  tag: string;
  type: string;
  text: string;
  isContentEditable?: boolean;
  rect: { x: number; y: number; width: number; height: number };
  /** 链接地址（A 元素或其最近的祖先 A），文档提取用 */
  href?: string;
  /** 图片地址（IMG 元素或其子 IMG），文档提取用 */
  src?: string;
}

const STATUS_RING: Record<NonNullable<Props["verifyStatus"]>, string> = {
  idle: "ring-slate-200/60",
  scanning: "ring-sky-400/70 animate-glow-pulse",
  match: "ring-emerald-400/80",
  mismatch: "ring-rose-400/80",
};

const STATUS_BAR: Record<NonNullable<Props["verifyStatus"]>, { text: string; cls: string }> = {
  idle: { text: "", cls: "" },
  scanning: { text: "AI 正在核对…", cls: "bg-sky-500/90 text-white" },
  match: { text: "全部一致", cls: "bg-emerald-500/90 text-white" },
  mismatch: { text: "存在不一致", cls: "bg-rose-500/90 text-white" },
};

export default function BrowserPane({
  side,
  title,
  subtitle,
  url,
  onUrlChange,
  picking,
  onPickedElement,
  verifyStatus = "idle",
  disabled,
  emptyHint,
  children,
  detachedSide,
  onDetach,
  headerExtra,
  popupActive,
  onClosePopup,
  enableTabs = false,
  enableViewSwitch = false,
  viewMode = "web",
  onViewModeChange,
  excelTabTitle = "数据源",
  hasExcelData = false,
  excelFileName,
  onRequestAddExcel,
  excelEmptyState,
  webEmptyState,
  newTabTitle,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const inViewRef = useRef(inView);
  const urlRef = useRef(url);
  const rafRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [inputUrl, setInputUrl] = useState(url);
  const lastBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const loadedUrlRef = useRef<string>("");

  // 多标签页状态（web模式和excel模式各自独立tabs）
  const [webTabs, setWebTabs] = useState<BrowserTab[]>(() => [{ id: "tab-0", url: url || "" }]);
  const [activeTabId, setActiveTabId] = useState<string>("tab-0");
  const [isAddingTab, setIsAddingTab] = useState(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const tabIdCounter = useRef(1);

  // Excel模式的tabs从props派生：有数据时显示一个tab，无数据时空数组
  const excelTabs: BrowserTab[] = hasExcelData
    ? [{ id: "excel-tab-0", url: excelFileName || excelTabTitle, title: excelFileName || excelTabTitle }]
    : [];

  // 当前模式下的tabs
  const isWebMode = viewMode === "web";
  const tabs = isWebMode ? webTabs : excelTabs;
  // 已加载URL的tab（Web模式过滤空url，Excel模式全部算已加载）
  const loadedTabs = isWebMode
    ? tabs.filter((t) => t.url && t.url.trim() !== "")
    : tabs;
  // 当前激活的tab
  const activeTab = tabs.find((t) => t.id === activeTabId) || (tabs.length > 0 ? tabs[0] : null);

  inViewRef.current = inView;
  urlRef.current = enableTabs ? (isWebMode ? (activeTab?.url || "") : "") : url;

  // 当前实际URL（tabs模式用activeTab.url，否则用prop url；Excel模式无URL）
  const currentUrl = enableTabs
    ? (isWebMode ? (activeTab?.url || "") : "")
    : url;

  // url prop 变化时同步：tabs模式下更新当前web tab的url，非tabs模式同步到输入框
  useEffect(() => {
    if (!enableTabs) {
      setInputUrl(url);
      return;
    }
    if (!isWebMode) return;
    // tabs web模式：如果父组件设置了url（如DEMO按钮），同步到activeTab
    if (url && activeTab && url !== activeTab.url) {
      setWebTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, url } : t)));
      setInputUrl(url);
    }
  }, [url, enableTabs, activeTabId, isWebMode]);

  // 切换viewMode时，重置编辑/添加状态，同步activeTabId
  useEffect(() => {
    if (!enableTabs || !enableViewSwitch) return;
    if (isWebMode) {
      const firstWeb = webTabs.find((t) => t.url && t.url.trim() !== "") || webTabs[0];
      if (firstWeb) {
        setActiveTabId(firstWeb.id);
        setInputUrl(firstWeb.url);
        if (firstWeb.url && window.electronAPI) {
          loadedUrlRef.current = "";
        }
      }
    } else {
      if (hasExcelData) {
        setActiveTabId("excel-tab-0");
      }
      setInputUrl("");
      setIsAddingTab(false);
      setEditingTabId(null);
    }
  }, [viewMode, enableTabs, enableViewSwitch]);

  // Excel数据加载/清空时，同步activeTabId
  useEffect(() => {
    if (!enableTabs || !enableViewSwitch || isWebMode) return;
    if (hasExcelData && activeTabId !== "excel-tab-0") {
      setActiveTabId("excel-tab-0");
    }
  }, [hasExcelData, enableTabs, enableViewSwitch, isWebMode, activeTabId]);

  // tabs模式下切换tab时，同步inputUrl到当前tab的url（编辑模式除外）
  useEffect(() => {
    if (!enableTabs) return;
    if (editingTabId) return;
    if (isAddingTab) return;
    if (isWebMode && activeTab) {
      setInputUrl(activeTab.url);
    } else if (!isWebMode) {
      setInputUrl("");
    }
  }, [activeTabId, enableTabs, isWebMode]);

  // 把 BrowserView 的位置同步给主进程，相同 bounds 不重复发送
  const sync = useCallback(() => {
    if (!window.electronAPI || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const winH = window.innerHeight;
    let x = Math.round(rect.x);
    let y = Math.round(rect.y);
    let w = Math.round(rect.width);
    let h = Math.round(rect.height);
    if (y < 0) {
      h += y;
      y = 0;
    }
    if (y + h > winH) {
      h = winH - y;
    }
    const viewSide = detachedSide || side;
    const api = window.electronAPI;
    if (w <= 0 || h <= 0 || !inViewRef.current || !urlRef.current) {
      if (lastBoundsRef.current !== null) {
        if (detachedSide) api.detachedViewHide(detachedSide);
        else api.viewHide(side);
        lastBoundsRef.current = null;
      }
      return;
    }
    const last = lastBoundsRef.current;
    if (last && last.x === x && last.y === y && last.width === w && last.height === h) {
      return;
    }
    lastBoundsRef.current = { x, y, width: w, height: h };
    if (detachedSide) {
      api.detachedViewShow(detachedSide, { x, y, width: w, height: h }, urlRef.current);
    } else {
      api.viewShow(side, { x, y, width: w, height: h }, urlRef.current);
    }
  }, [side, detachedSide]);

  useEffect(() => {
    const el = containerRef.current;
    const scrollEl = scrollRef.current;
    if (!el || !window.electronAPI) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const next = entry.isIntersecting && (entry.intersectionRatio ?? 0) > 0.1;
        setInView((prev) => (prev === next ? prev : next));
      },
      { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] }
    );
    observer.observe(el);

    const scheduleSync = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        sync();
      });
    };

    const onResize = () => scheduleSync();
    window.addEventListener("resize", onResize);
    scrollEl?.addEventListener("scroll", scheduleSync, { passive: true });

    // 监听容器自身尺寸/位置变化（面板开闭时容器会resize）
    const resizeObserver = new ResizeObserver(() => scheduleSync());
    resizeObserver.observe(el);
    // 同时监听父元素（scrollRef），确保面板拖拽时立即触发sync
    if (scrollEl && scrollEl !== el) {
      resizeObserver.observe(scrollEl);
    }

    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("resize", onResize);
      scrollEl?.removeEventListener("scroll", scheduleSync);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (detachedSide) window.electronAPI?.detachedViewHide(detachedSide);
      else window.electronAPI?.viewHide(side);
    };
  }, [side, detachedSide, sync]);

  useEffect(() => {
    sync();
  }, [sync, inView, currentUrl, isWebMode, enableViewSwitch]);

  // 显式加载 URL：当 url 变化且非 tab 直接加载时调用 viewLoad
  // 用 loadedUrlRef 跟踪上次加载的 URL，避免重复加载
  useEffect(() => {
    if (!window.electronAPI || !currentUrl) return;
    if (currentUrl === loadedUrlRef.current) return;
    loadedUrlRef.current = currentUrl;
    setLoading(true);
    if (detachedSide) window.electronAPI.detachedViewLoad(detachedSide, currentUrl);
    else window.electronAPI.viewLoad(side, currentUrl);
  }, [currentUrl, side, detachedSide]);

  // 监听 BrowserView 加载事件（did-start-loading / did-stop-loading）
  useEffect(() => {
    if (!window.electronAPI) return;
    const off = window.electronAPI.onViewMessage((msg: { side: string; payload?: { kind?: string; loading?: boolean } }) => {
      if (msg.side !== side) return;
      if (msg.payload?.kind === "view-loading") {
        setLoading(!!msg.payload.loading);
      }
    });
    return () => off?.();
  }, [side]);

  // 监听来自该 side 的元素选择消息
  useEffect(() => {
    if (!window.electronAPI || !picking || !onPickedElement) return;
    console.log(`[BrowserPane:${side}] picking=true, 注册 element-picked 监听器`);
    window.electronAPI?.rendererLog?.(`[BrowserPane:${side}] picking=true, 注册 element-picked 监听器`);
    const off = window.electronAPI.onViewMessage((msg) => {
      console.log(`[BrowserPane:${side}] onViewMessage: side=${msg.side} kind=${msg.payload?.kind}`);
      window.electronAPI?.rendererLog?.(`[BrowserPane:${side}] onViewMessage: side=${msg.side} kind=${msg.payload?.kind}`);
      if (msg.side !== side) return;
      if (msg.payload?.kind === "element-picked") {
        const p = msg.payload as unknown as PickedElementInfo & { kind: string };
        console.log(`[BrowserPane:${side}] 收到 element-picked:`, { tag: p.tag, selector: p.selector });
        window.electronAPI?.rendererLog?.(`[BrowserPane:${side}] 收到 element-picked: tag=${p.tag} selector=${p.selector}`);
        onPickedElement({
          selector: p.selector,
          label: p.label,
          value: p.value,
          tag: p.tag,
          type: p.type,
          text: p.text,
          isContentEditable: p.isContentEditable,
          rect: p.rect,
        });
      }
    });
    return () => off?.();
  }, [picking, side, onPickedElement]);

  // 激活/取消元素选择模式（脱离模式走 detached API）
  useEffect(() => {
    if (!window.electronAPI) return;
    console.log(`[BrowserPane:${side}] picking useEffect: picking=${picking}, detachedSide=${detachedSide || "null"}`);
    window.electronAPI?.rendererLog?.(`[BrowserPane:${side}] picking useEffect: picking=${picking}`);
    if (picking) {
      if (detachedSide) window.electronAPI.detachedViewStartPicking(detachedSide);
      else window.electronAPI.viewStartPicking(side);
      // 弹窗也同步激活拾取
      if (popupActive) window.electronAPI.popupStartPicking(side);
    } else {
      if (detachedSide) window.electronAPI.detachedViewStopPicking(detachedSide);
      else window.electronAPI.viewStopPicking(side);
      if (popupActive) window.electronAPI.popupStopPicking(side);
    }
  }, [picking, side, detachedSide, popupActive]);

  const normalizeUrl = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^localhost(:\d+)?(\/|$)/i.test(trimmed) || /^127\.0\.0\.1(:\d+)?(\/|$)/.test(trimmed)) {
      return "http://" + trimmed;
    }
    if (/^[\w.-]+(:\d+)?(\/|$)/.test(trimmed) && !trimmed.includes(" ")) {
      return "https://" + trimmed;
    }
    return trimmed;
  };

  const openPage = () => {
    if (!isWebMode) return;
    if (!window.electronAPI || !inputUrl) return;
    const targetUrl = normalizeUrl(inputUrl);
    if (!targetUrl) return;
    setInputUrl(targetUrl);
    if (enableTabs) {
      if (isAddingTab) {
        const newId = `tab-${tabIdCounter.current++}`;
        setWebTabs((prev) => [...prev, { id: newId, url: targetUrl }]);
        setActiveTabId(newId);
        setIsAddingTab(false);
      } else if (editingTabId) {
        setWebTabs((prev) => prev.map((t) => (t.id === editingTabId ? { ...t, url: targetUrl } : t)));
        setActiveTabId(editingTabId);
        setEditingTabId(null);
      } else {
        setWebTabs((prev) => {
          if (prev.length === 0 || (prev.length === 1 && !prev[0].url)) {
            return [{ id: activeTabId || "tab-0", url: targetUrl }];
          }
          return prev.map((t) => (t.id === activeTabId ? { ...t, url: targetUrl } : t));
        });
      }
    }
    onUrlChange(targetUrl);
    loadedUrlRef.current = targetUrl;
    // 立即更新 urlRef 并触发 sync，确保 BrowserView 在 loadURL 的同时被显示，
    // 而不是等 useEffect 重新渲染后才 show（那时页面可能已加载完却看不到）
    urlRef.current = targetUrl;
    setLoading(true);
    if (detachedSide) window.electronAPI.detachedViewLoad(detachedSide, targetUrl);
    else window.electronAPI.viewLoad(side, targetUrl);
    sync();
  };

  const reload = () => {
    if (!isWebMode) return;
    const targetUrl = enableTabs ? activeTab?.url : url;
    if (!window.electronAPI || !targetUrl) return;
    setLoading(true);
    loadedUrlRef.current = "";
    if (detachedSide) window.electronAPI.detachedViewExecuteJS(detachedSide, "location.reload();");
    else window.electronAPI.viewExecuteJS(side, "location.reload();");
  };

  // Tab 操作函数
  const startAddTab = () => {
    if (!isWebMode) {
      // Excel模式：触发添加上传Excel回调
      onRequestAddExcel?.();
      return;
    }
    setIsAddingTab(true);
    setEditingTabId(null);
    setInputUrl("");
  };

  const switchTab = (tabId: string) => {
    if (tabId === activeTabId) return;
    setIsAddingTab(false);
    setEditingTabId(null);
    setActiveTabId(tabId);
    const targetTab = tabs.find((t) => t.id === tabId);
    if (isWebMode && targetTab?.url && window.electronAPI) {
      loadedUrlRef.current = targetTab.url;
      urlRef.current = targetTab.url;
      onUrlChange(targetTab.url);
      setLoading(true);
      if (detachedSide) window.electronAPI.detachedViewLoad(detachedSide, targetTab.url);
      else window.electronAPI.viewLoad(side, targetTab.url);
      sync();
    }
  };

  const startEditTab = (tabId: string) => {
    if (!isWebMode) return;
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    setEditingTabId(tabId);
    setIsAddingTab(false);
    setInputUrl(tab.url);
    setActiveTabId(tabId);
  };

  const closeTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isWebMode) return; // Excel tabs 不通过UI关闭
    setWebTabs((prev) => {
      if (prev.length <= 1) {
        setActiveTabId("tab-0");
        setInputUrl("");
        setIsAddingTab(false);
        setEditingTabId(null);
        loadedUrlRef.current = "";
        onUrlChange("");
        return [{ id: "tab-0", url: "" }];
      }
      const idx = prev.findIndex((t) => t.id === tabId);
      const next = prev.filter((t) => t.id !== tabId);
      if (tabId === activeTabId || tabId === editingTabId) {
        const newActive = next[Math.max(0, idx - 1)] || next[0];
        setActiveTabId(newActive.id);
        setEditingTabId(null);
        setIsAddingTab(false);
        setInputUrl(newActive.url);
        if (window.electronAPI && newActive.url) {
          loadedUrlRef.current = newActive.url;
          onUrlChange(newActive.url);
          setLoading(true);
          if (detachedSide) window.electronAPI.detachedViewLoad(detachedSide, newActive.url);
          else window.electronAPI.viewLoad(side, newActive.url);
        } else if (!newActive.url) {
          loadedUrlRef.current = "";
          onUrlChange("");
        }
      }
      return next;
    });
  };

  // 切换视图模式
  const switchViewMode = (mode: "web" | "excel") => {
    if (!onViewModeChange) return;
    if (mode === viewMode) return;
    setIsAddingTab(false);
    setEditingTabId(null);
    onViewModeChange(mode);
    if (mode === "web") {
      onUrlChange(activeTab?.url || "");
    } else {
      onUrlChange("");
    }
  };

  // 从URL推导tab标题
  const getTabTitle = (tabUrl: string): string => {
    if (!tabUrl) return "新标签页";
    try {
      const u = new URL(tabUrl);
      return u.hostname.replace(/^www\./, "") || tabUrl;
    } catch {
      return tabUrl.length > 25 ? tabUrl.slice(0, 25) + "…" : tabUrl;
    }
  };

  // 取消添加/编辑
  const cancelTabInput = () => {
    setIsAddingTab(false);
    setEditingTabId(null);
    if (activeTab) {
      setInputUrl(activeTab.url);
    }
  };

  const status = STATUS_BAR[verifyStatus];

  return (
    <div className={`relative flex h-full flex-col overflow-hidden rounded-lg bg-white/40 backdrop-blur-xl ring-1 ${STATUS_RING[verifyStatus]} transition-[box-shadow,background-color] duration-300`}>
      {/* 顶部：标题 + URL/Tab融合区域 + 操作（紧凑单行） */}
      <div className="glass-frame flex items-center gap-2 border-b border-white/40 px-2 py-1">
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="truncate text-[11px] font-semibold text-slate-700">{title}</span>
          {!enableViewSwitch && headerExtra}
        </div>
        {picking && (
          <span className="ml-0.5 inline-flex shrink-0 items-center gap-0.5 rounded-full bg-brand-500/15 px-1.5 py-0.5 text-[9px] font-medium text-brand-700 animate-glow-pulse">
            <MousePointerClick className="h-2.5 w-2.5" />
            点击拾取
          </span>
        )}
        {popupActive && (
          <span className="ml-0.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-700">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
            弹窗
            {onClosePopup && (
              <button
                onClick={onClosePopup}
                className="ml-0.5 rounded-full p-0.5 hover:bg-amber-500/30"
                title="关闭弹窗"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            )}
          </span>
        )}

        {/* URL/Tab/视图切换 融合区域 */}
        {enableTabs ? (
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {/* 视图切换按钮（网页/Excel） */}
            {enableViewSwitch && (
              <>
                <button
                  onClick={() => switchViewMode("web")}
                  className={[
                    "flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-all",
                    isWebMode
                      ? "bg-brand-600 text-white shadow-sm"
                      : "bg-white/30 text-slate-500 hover:bg-white/50 hover:text-slate-600",
                  ].join(" ")}
                  title="网页视图"
                >
                  <Globe className="h-2.5 w-2.5" />
                  网页
                </button>
                <button
                  onClick={() => switchViewMode("excel")}
                  className={[
                    "flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-all",
                    !isWebMode
                      ? "bg-emerald-600 text-white shadow-sm"
                      : "bg-white/30 text-slate-500 hover:bg-white/50 hover:text-slate-600",
                  ].join(" ")}
                  title="Excel 视图"
                >
                  <FileSpreadsheet className="h-2.5 w-2.5" />
                  Excel
                </button>
                <div className="mx-0.5 h-4 w-px bg-slate-200/80" />
              </>
            )}

            {/* Web模式：URL Tabs */}
            {isWebMode && (
              <>
                {loadedTabs.length > 0 ? (
                  <>
                    {loadedTabs.map((tab) => {
                      const isActive = tab.id === activeTabId && !isAddingTab && editingTabId !== tab.id;
                      const isDimmed = isAddingTab || (editingTabId && editingTabId !== tab.id);
                      return (
                        <div key={tab.id} className="flex shrink-0 items-center">
                          {editingTabId === tab.id ? (
                            <div className="flex items-center gap-0.5 rounded-md border border-brand-300 bg-white px-1.5 py-0.5 shadow-sm ring-1 ring-brand-200">
                              <input
                                autoFocus
                                value={inputUrl}
                                onChange={(e) => setInputUrl(e.target.value)}
                                disabled={disabled}
                                placeholder="输入网址"
                                className="w-[160px] bg-transparent text-[11px] text-slate-700 outline-none"
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") openPage();
                                  if (e.key === "Escape") cancelTabInput();
                                }}
                                onBlur={() => {
                                  if (inputUrl) openPage();
                                  else cancelTabInput();
                                }}
                              />
                              {loading && <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-brand-500" />}
                            </div>
                          ) : (
                            <button
                              onClick={(e) => {
                                if ((e.target as HTMLElement).closest("[data-close-btn]")) return;
                                switchTab(tab.id);
                              }}
                              className={[
                                "group flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all max-w-[160px]",
                                isActive
                                  ? "bg-white/90 text-slate-700 shadow-sm ring-1 ring-white/80"
                                  : "bg-white/30 text-slate-500 hover:bg-white/50 hover:text-slate-600",
                                isDimmed ? "opacity-40 pointer-events-none" : "",
                              ].join(" ")}
                              title={tab.url}
                            >
                              <Globe className={`h-2.5 w-2.5 shrink-0 ${isActive ? "text-brand-500" : "text-slate-400"}`} />
                              <span className="truncate">{getTabTitle(tab.url)}</span>
                              <span
                                data-close-btn
                                onClick={(e) => closeTab(tab.id, e)}
                                className="ml-0.5 rounded p-0.5 opacity-0 pointer-events-none transition-opacity hover:bg-slate-200 group-hover:opacity-100 group-hover:pointer-events-auto"
                              >
                                <X className="h-2.5 w-2.5" />
                              </span>
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {isAddingTab ? (
                      <div className="flex items-center gap-0.5 rounded-md border border-brand-300 bg-white px-1.5 py-0.5 shadow-sm ring-1 ring-brand-200">
                        <Globe className="h-2.5 w-2.5 shrink-0 text-brand-400" />
                        <input
                          autoFocus
                          value={inputUrl}
                          onChange={(e) => setInputUrl(e.target.value)}
                          disabled={disabled}
                          placeholder="输入URL，Enter打开"
                          className="w-[160px] bg-transparent text-[11px] text-slate-700 outline-none placeholder:text-slate-400"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") openPage();
                            if (e.key === "Escape") cancelTabInput();
                          }}
                          onBlur={() => {
                            if (inputUrl) openPage();
                            else cancelTabInput();
                          }}
                        />
                        {loading && <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-brand-500" />}
                      </div>
                    ) : (
                      <button
                        onClick={startAddTab}
                        className="shrink-0 rounded-md p-0.5 text-slate-400 transition-colors hover:bg-white/60 hover:text-brand-600"
                        title="新建标签页"
                        disabled={disabled}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-white/60 bg-white/50 px-1.5 py-0.5">
                    <input
                      value={inputUrl}
                      onChange={(e) => setInputUrl(e.target.value)}
                      disabled={disabled}
                      placeholder="输入网址"
                      className="min-w-0 flex-1 bg-transparent text-[11px] text-slate-700 outline-none placeholder:text-slate-400"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") openPage();
                      }}
                    />
                    {loading && <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-brand-500" />}
                  </div>
                )}
              </>
            )}

            {/* Excel模式：Excel Tab标签 */}
            {!isWebMode && (
              <>
                {loadedTabs.map((tab) => {
                  const isActive = tab.id === activeTabId;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => switchTab(tab.id)}
                      className={[
                        "flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all max-w-[160px]",
                        isActive
                          ? "bg-white/90 text-emerald-700 shadow-sm ring-1 ring-white/80"
                          : "bg-white/30 text-slate-500 hover:bg-white/50 hover:text-slate-600",
                      ].join(" ")}
                      title={tab.title || tab.url || excelTabTitle}
                    >
                      <FileSpreadsheet className={`h-2.5 w-2.5 shrink-0 ${isActive ? "text-emerald-500" : "text-slate-400"}`} />
                      <span className="truncate">{tab.title || tab.url || excelTabTitle}</span>
                    </button>
                  );
                })}
                {/* 始终显示+按钮用于添加Excel */}
                <button
                  onClick={startAddTab}
                  className="shrink-0 rounded-md p-0.5 text-slate-400 transition-colors hover:bg-white/60 hover:text-emerald-600"
                  title="添加 Excel/CSV 文件"
                  disabled={disabled}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </div>
        ) : (
          // 非tabs模式：普通URL输入框
          <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-white/60 bg-white/50 px-1.5 py-0.5">
            <input
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              disabled={disabled}
              placeholder="输入网址"
              className="min-w-0 flex-1 bg-transparent text-[11px] text-slate-700 outline-none placeholder:text-slate-400"
              onKeyDown={(e) => {
                if (e.key === "Enter") openPage();
              }}
            />
            {loading && <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-brand-500" />}
          </div>
        )}

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            onClick={reload}
            disabled={!currentUrl || disabled || isAddingTab || !!editingTabId || !isWebMode}
            className="rounded p-0.5 text-slate-400 hover:bg-white/60 hover:text-slate-600 disabled:opacity-40"
            title="刷新"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </button>
          {!enableTabs && (
            <button
              onClick={openPage}
              disabled={!inputUrl || disabled}
              className="rounded p-0.5 text-slate-400 hover:bg-white/60 hover:text-brand-600 disabled:opacity-40"
              title="打开"
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
          {onDetach && (
            <button
              onClick={onDetach}
              className="rounded p-0.5 text-slate-400 hover:bg-white/60 hover:text-brand-600"
              title="脱离到独立窗口"
            >
              <SquareArrowOutUpRight className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* 内容区：Web容器和Excel容器始终挂载，通过hidden切换可见性。
          这样ResizeObserver不会失效，切换到Excel时BrowserView会因container尺寸为0而自动隐藏。 */}
      <div ref={scrollRef} className={`relative min-h-0 flex-1 overflow-hidden ${isWebMode || !enableViewSwitch ? "" : "hidden"}`}>
        <div ref={containerRef} className="absolute inset-0 bg-white">
          {!window.electronAPI && (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-slate-400">
              <Globe className="h-8 w-8 text-slate-300" />
              <p>
                {emptyHint || "Electron 模式下才会显示真实浏览器"}
              </p>
            </div>
          )}
          {!currentUrl && window.electronAPI && isWebMode && (
            webEmptyState || (newTabTitle ? (
              <div className="flex h-full flex-col items-center justify-center gap-6 px-8">
                <h1
                  className="text-4xl font-black tracking-tight text-slate-800 sm:text-5xl"
                  style={{ fontFamily: "'Inter', 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', sans-serif" }}
                >
                  {newTabTitle}
                </h1>
                <div className="w-full max-w-xl">
                  <div className="group flex items-center gap-2 rounded-full border-2 border-slate-200 bg-white px-5 py-3 shadow-sm transition-all focus-within:border-brand-400 focus-within:shadow-md">
                    <Search className="h-5 w-5 shrink-0 text-slate-400 group-focus-within:text-brand-500" />
                    <input
                      type="text"
                      value={inputUrl}
                      onChange={(e) => setInputUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") openPage();
                      }}
                      placeholder="输入网址或搜索词，按回车访问"
                      className="flex-1 bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400"
                      autoFocus
                    />
                    {inputUrl && (
                      <button
                        onClick={() => setInputUrl("")}
                        className="rounded p-0.5 text-slate-300 hover:text-slate-500"
                        title="清除"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={openPage}
                      disabled={!inputUrl.trim()}
                      className={[
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all",
                        inputUrl.trim()
                          ? "bg-brand-600 text-white hover:bg-brand-700"
                          : "bg-slate-100 text-slate-300",
                      ].join(" ")}
                      title="前往"
                    >
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  </div>
                  <p className="mt-2 text-center text-[11px] text-slate-400">
                    无需输入 https://，直接输入网址即可，例如 baidu.com
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-slate-400">
                <Globe className="h-8 w-8 text-slate-300" />
                <p>输入网址后按 Enter 打开</p>
              </div>
            ))
          )}
        </div>

        {/* 核验中的扫描线动画 */}
        {verifyStatus === "scanning" && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="scan-line" />
          </div>
        )}

        {/* 核验状态条 */}
        {status.text && (
          <div className={`pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-full px-3 py-0.5 text-[11px] font-medium shadow-sm ${status.cls}`}>
            {status.text}
          </div>
        )}

        {/* 自定义覆盖层（非视图切换模式下的children作为覆盖层） */}
        {children && !enableViewSwitch && (
          <div className="pointer-events-none absolute inset-0 z-10">{children}</div>
        )}
      </div>

      {/* Excel容器：始终挂载，通过hidden切换 */}
      {enableViewSwitch && (
        <div className={`relative min-h-0 flex-1 overflow-hidden bg-white ${isWebMode ? "hidden" : ""}`}>
          {hasExcelData ? children : (excelEmptyState || (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-xs text-slate-400">
              <Upload className="h-10 w-10 text-slate-300" />
              <p>点击上方 + 按钮上传 Excel/CSV 文件</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


