import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowLeftRight,
  Bot,
  BookMarked,
  Check,
  CheckCircle2,
  ClipboardCheck,
  ClipboardEdit,
  Clock,
  Crosshair,
  Database,
  EyeOff,
  FileDown,
  FileSpreadsheet,
  FileText,
  Globe,
  GraduationCap,
  KeyRound,
  LayoutGrid,
  Library,
  ListChecks,
  Loader2,
  Maximize2,
  Minus,
  MousePointerClick,
  PanelBottom,
  PanelLeft,
  PanelLeftClose,
  Play,
  Plus,
  Repeat2,
  Rotate3D,
  RotateCw,
  Save,
  Settings2,
  ShieldCheck,
  SkipForward,
  Sparkles,
  Square,
  Trash2,
  Type,
  Upload,
  UserCircle,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { api, subscribeTask } from "./api/client";
import appIconPng from "./assets/app-icon.png";
import DocExportDialog from "./components/DocExportDialog";
import PPTWorkflowPanel from "./components/PPTWorkflowPanel";
import CoworkStudio from "./components/CoworkStudio";
import TaskSelector from "./components/TaskSelector";
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
import type {
  AnalysisSegment,
  AppConfig,
  AppMode,
  AppSettings,
  ApplicantRecord,
  BatchResult,
  BatchStatus,
  DocCompareEntry,
  DocExtractState,
  FieldComparison,
  FieldMapping,
  FieldMatch,
  LivePair,
  Overall,
  PickedMark,
  QueuedTask,
  ScreenshotEvent,
  TeachingPhase,
  VerificationReport,
  VerificationReportEntry,
  VerificationResult,
  VerificationStep,
  WorkflowConfig,
  WorkflowStep,
  WorkflowTemplate,
} from "./types";
import { FIELD_LABELS, OVERALL_LABELS, OVERALL_STYLES } from "./types";
import type { CalendarRole, WidgetDef } from "./types";
import { normalizeText, parseDateCandidates, valuesEquivalent, isUmiMethod, extractMethodLabel } from "./utils/formatNormalize";
import WidgetExtractPanel, { type WidgetBinding, type WidgetTestResult } from "./components/WidgetExtractPanel";
import {
  buildCalendarPanelFromSeedScript,
  buildCalendarSetScript,
  buildWidgetCalendarMirrorScript,
  buildInlineOptionSelectScript,
  buildDayCellCollectScript,
  buildInlineOptionSnapshotScript,
  buildOptionPanelFromSeedScript,
  buildOptionSelectScript,
  buildWidgetCloseScript,
  buildWidgetEnsureOpenScript,
  buildWidgetReadScript,
  buildWidgetSnapshotScript,
  type CalendarMirrorAction,
  type CalendarSetResult,
  type OptionSelectResult,
  type WidgetReadResult,
  type WidgetSnapshotResult,
} from "./lib/widgetScripts";
import LeftPanel from "./components/LeftPanel";
import type { AISphereState } from "./components/AISphere";
import BrowserPane, { type PickedElementInfo } from "./components/BrowserPane";
import ExcelView, { type ExcelPickedField } from "./components/ExcelView";
import BlankExcel from "./components/BlankExcel";
import ElementSelectBar, { type PickTarget, type CustomTextEntry } from "./components/ElementSelectBar";
import ResultsPanel from "./components/ResultsPanel";
import type { ExtractSummaryItem } from "./components/ResultsPanel";
import SettingsModal from "./components/SettingsModal";
import OfficecliRequiredModal from "./components/OfficecliRequiredModal";
import DocFillDialog from "./components/DocFillDialog";
import SkillPanel from "./components/SkillPanel";
import LoopEditor from "./components/LoopEditor";
import BreakpointDialog from "./components/BreakpointDialog";
import SaveSkillDialog from "./components/SaveSkillDialog";
import CredentialsPanel from "./components/CredentialsPanel";
import DocLocalExtractConfig from "./components/DocLocalExtractConfig";
import { saveSkill, getSkillById, loadSkills } from "./lib/skills";
import { getBlockRules, addBlockRule, removeBlockRule, getHost, type BlockRule, SIDEBAR_AUTO_SELECTORS, getSidebarAutoCollapse, setSidebarAutoCollapse } from "./lib/blockRules";
import { getAllCredentials, addCredential, removeCredential, type Credential } from "./lib/credentials";
import type { ViewSide } from "./electron";

// 统一日志：同时输出到 console 和主进程日志文件
const rlog = (...args: unknown[]) => {
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log(msg);
  window.electronAPI?.rendererLog?.(msg);
};

// 清洗选择器：剔除拾取/高亮模式注入的 cinside-* 临时类
// 这些类只在拾取时存在于 DOM 上，执行时已被移除，含它们的选择器会匹配失败
// 同时剔除动画瞬态类：如 lightgallery 的 lg-start-zoom/lg-start-show 只在打开动画期间存在，
// 教学拾取时恰好录下它们，执行时类已被移除，选择器永远匹配不到
const sanitizeSelector = (sel: string): string =>
  (sel || "")
    .replace(/\.cinside-[a-z0-9_-]+/gi, "")
    .replace(/\.lg-start-(?:zoom|show)\b/gi, "");

/** 兜底：模板未保存 mappings 时，从审查类 marks 反推字段映射（老模板/未同步映射的提取元素条目），
 *  保证 LOOP 运行时「字段对比」区域和逐字段比对有数据 */
const deriveMappingsFromMarks = (marks: PickedMark[]): FieldMapping[] => {
  const out: FieldMapping[] = [];
  for (const m of marks) {
    if (m.clickPhase || m.docExtract || m.docExtractClick || m.fileOp || m.panelAction) continue;
    if (m.action !== "pick" && m.action !== "input") continue;
    if (!m.selector || m.selector.includes("://")) continue;
    if (out.some((x) => x.right_selector === m.selector)) continue;
    const isPass = m.source === "passport";
    const leftSource: FieldMapping["left_source"] = m.excelField ? "excel" : isPass ? "passport" : m.value ? "manual" : "excel";
    const leftField = m.excelField || (isPass ? (m.variableField || "") : (m.value || m.variableField || ""));
    if (!leftField) continue;
    const cleanLabel = (m.label || "").replace(/^(审查|录入|输入)\s*·\s*/, "").split(" ← ")[0].trim();
    out.push({
      right_selector: m.selector,
      right_label: cleanLabel || m.selector,
      right_input_type: m.type || null,
      left_source: leftSource,
      left_field: leftField,
      verify_method: "smart",
      web_side: m.side === "left" ? "left" : "right",
      widget: m.widget || undefined,
    });
  }
  return out;
};

/** 运行展示用步骤标签：input 步骤的「输入」前缀按流程纠正为「审查/录入」（审查流不显示“输入”字样，用字严谨；兼容历史模板） */
const markDisplayLabel = (m: PickedMark): string => {
  const raw = m.label || m.inputTarget || m.selector;
  if (m.action === "input") return raw.replace(/^输入/, m.workflow === "entry" ? "录入" : "审查");
  return raw;
};

/** 取模板有效映射：优先模板自带 mappings，缺失时从 marks 反推 */
const getTemplateMappings = (tpl: WorkflowTemplate): FieldMapping[] =>
  tpl.mappings && tpl.mappings.length > 0
    ? tpl.mappings
    : deriveMappingsFromMarks([...tpl.dataSourceMarks, ...tpl.reviewMarks, ...tpl.entryMarks]);

/** 将 data URL 转换为 File 对象（用于下载文件 OCR 提取） */
function dataUrlToFile(dataUrl: string, filename: string): File {
  const arr = dataUrl.split(",");
  const mime = arr[0].match(/:(.*?);/)?.[1] || "application/octet-stream";
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) u8arr[n] = bstr.charCodeAt(n);
  return new File([u8arr], filename, { type: mime });
}

// 深度查询辅助函数（注入页面执行）：支持 ' >>> ' 分段穿透 shadowRoot / iframe contentDocument
// 用法：在注入脚本开头拼接 ${DEEP_QUERY_HELPER}，然后用 __cinsideDeepQuery(sel) 替代 document.querySelector(sel)
const DEEP_QUERY_HELPER = `function __cinsideDeepQuery(sel) {
  if (!sel) return null;
  if (sel.indexOf('>>>') === -1) { try { return document.querySelector(sel); } catch (e) { return null; } }
  var segs = sel.split('>>>');
  var ctx = document;
  var el = null;
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i].trim();
    if (!s) return null;
    try { el = ctx.querySelector(s); } catch (e) { return null; }
    if (!el) return null;
    if (i < segs.length - 1) {
      var next = null;
      try { if (el.shadowRoot) next = el.shadowRoot; } catch (e) {}
      if (!next) { try { if (el.contentDocument) next = el.contentDocument; } catch (e) {} }
      if (!next) return null;
      ctx = next;
    }
  }
  return el;
};`;

// 页面中第一个可输入框的通用选择器（querySelector 取文档序第一个匹配项）
const FIRST_INPUT_SELECTOR =
  'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=reset]):not([type=image]), textarea, [contenteditable="true"]';

// ============ 点击展开型控件（选项/日历）：模块级辅助 ============
/** 日历角色 → CalendarControls 字段名 */
const WIDGET_ROLE_TO_FIELD: Record<string, string> = {
  header: "headerSelector",
  year: "yearSelector",
  month: "monthSelector",
  prevYear: "prevYearSelector",
  nextYear: "nextYearSelector",
  prevMonth: "prevMonthSelector",
  nextMonth: "nextMonthSelector",
  dayCell: "dayCellSelector",
};

/** 日历引导式拾取：依次引导用户在网页日历上标注各按钮位置 */
const CALENDAR_GUIDE_STEPS: Array<{ role: CalendarRole; label: string; required: boolean }> = [
  { role: "header", label: "年月显示区（如 2024年1月）", required: true },
  { role: "prevMonth", label: "上一月按钮 ‹", required: true },
  { role: "nextMonth", label: "下一月按钮 ›", required: true },
  { role: "prevYear", label: "上一年按钮 «（若无则跳过）", required: false },
  { role: "nextYear", label: "下一年按钮 »（若无则跳过）", required: false },
  { role: "dayCell", label: "日格子（拖拽框选一片 / 逐个点选，点「完成」结束）", required: true },
];

/** 控件快照失败原因 → 人类可读提示 */
const WIDGET_SNAPSHOT_REASONS: Record<string, string> = {
  trigger_not_found: "未在网页中找到该元素，请重新拾取",
  panel_not_found: "点击后未检测到展开的面板，请确认点的是「可展开的框框」",
  options_empty: "面板展开后未识别到选项，请确认这是点击展开选项的控件",
  container_not_found: "未在网页中找到该元素，请重新拾取",
  inline_options_not_found: "未识别到选项按钮组：请直接点选「男/女」这类选项区域中的某一个选项",
  collect_error: "选项收集失败，请尝试点选更靠近选项按钮的位置",
  not_option_panel: "点的位置不是选项面板，请点开下拉后点选其中的选项区域",
  seed_not_found: "未在网页中找到该元素，请重新点选",
};

/**
 * 日格子选择器泛化：用户「重选」点到的是某一个具体日期格（选择器带 :nth-of-type 等序数定位），
 * 泛化为匹配所有同类日格子的选择器，否则翻月后只能点当初点的那一个格子。
 */
function generalizeDayCellSelector(sel: string): string {
  if (!sel) return sel;
  // 只处理最后一个 shadow/iframe 段的最后一段路径
  const shadowSegs = sel.split(">>>");
  const lastSeg = shadowSegs[shadowSegs.length - 1];
  const parts = lastSeg.split(">").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return sel;
  let last = parts[parts.length - 1];
  last = last
    .replace(/:nth-(of-type|child|last-of-type|last-child)\([^)]*\)/g, "")
    .replace(/:first-(of-type|child)/g, "")
    .replace(/:last-(of-type|child)/g, "");
  if (!last) last = "*";
  parts[parts.length - 1] = last;
  shadowSegs[shadowSegs.length - 1] = parts.join(" > ");
  return shadowSegs.join(" >>> ");
}

/** TS 侧年月文本粗校验：文本中是否包含可解析的年月（与注入脚本 __wsParseYearMonth 对应，含式匹配） */
function containsYearMonthText(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (/\d{4}\s*年\s*\d{1,2}\s*月/.test(t)) return true;
  if (/\d{4}\s*[-\/.]\s*\d{1,2}(?!\d)/.test(t)) return true;
  if (/\d{1,2}\s*月\s*\d{4}/.test(t)) return true;
  if (/[A-Za-z]{3,9}[a-z]*\s*,?\s*\d{4}/.test(t)) return true;
  if (/\d{4}\s*,?\s*[A-Za-z]{3,9}/.test(t)) return true;
  return false;
}

const DEFAULT_SETTINGS: AppSettings = {
  agent_backend: "browser_use",
  vision_api_base: "",
  vision_api_key: "",
  vision_model: "",
  text_api_base: "",
  text_api_key: "",
  text_model: "",
  browser_use_llm_base: "",
  browser_use_llm_key: "",
  browser_use_llm_model: "",
  ocr_engine: "vision",
  vision_auto_orient: true,
  umi_ocr_host: "127.0.0.1",
  umi_ocr_port: 1224,
  prevent_accidental_close: false,
  loop_keep_awake: false,
  high_speed_mode: false,
  ui_scale: 1.0,
  beginner_mode: false,
  theme: "light",
  accent: "indigo",
  browser_brightness: 1.0,
};

type VerifyStatus = "idle" | "scanning" | "match" | "mismatch";

function getDetachMode(): string | null {
  const params = new URLSearchParams(window.location.search);
  const d = params.get("detach");
  return d || null;
}

// ============ UI缩放共享Hook：Ctrl+滚轮调整整体UI比例（供所有窗口/面板使用） ============
// 使用Electron原生 webFrame.setZoomFactor() 在Chromium底层缩放整个渲染进程，
// 所有坐标系统自动保持一致，getBoundingClientRect()返回的值与BrowserView.setBounds()需要的DIP坐标完全匹配。
function useApplyUiScale() {
  useEffect(() => {
    const applyZoom = (z: number) => {
      window.cinsideZoom?.setFactor(z);
      // 延迟触发 resize，确保 zoom 已生效再让 BrowserPane 重新计算坐标
      setTimeout(() => window.dispatchEvent(new Event("resize")), 16);
      setTimeout(() => window.dispatchEvent(new Event("resize")), 100);
    };

    // 初始化：读取localStorage中的缩放值并立即应用
    let current = 1.0;
    try {
      const saved = localStorage.getItem("cinside-ui-scale");
      const val = saved ? parseFloat(saved) : 1.0;
      if (!isNaN(val)) current = Math.max(0.6, Math.min(1.6, val));
    } catch {}
    applyZoom(current);

    let ctrlPressed = false;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Ctrl" || e.ctrlKey) ctrlPressed = true;
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Ctrl" || !e.ctrlKey) ctrlPressed = false;
    };
    const handleBlur = () => { ctrlPressed = false; };
    const handleWheel = (e: WheelEvent) => {
      if (!ctrlPressed) return;
      if ((window as any).__cinsideFlowEditorOpen) return;
      const delta = e.deltaY < 0 ? 0.05 : -0.05;
      const next = Math.max(0.6, Math.min(1.6, Math.round((current + delta) * 20) / 20));
      if (next !== current) {
        current = next;
        applyZoom(current);
        try { localStorage.setItem("cinside-ui-scale", next.toString()); } catch {}
      }
    };
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "cinside-ui-scale" && e.newValue) {
        const val = parseFloat(e.newValue);
        if (!isNaN(val)) {
          const clamped = Math.max(0.6, Math.min(1.6, val));
          if (clamped !== current) {
            current = clamped;
            applyZoom(current);
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("wheel", handleWheel, { passive: true });
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);
}

// ============ 脱离模式：左侧数据源面板 ============
function DetachedLeftPanel() {
  useApplyUiScale();
  const [records, setRecords] = useState<ApplicantRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    document.title = "数据源";
  }, []);

  useEffect(() => {
    api.listRecords()
      .then((r) => setRecords(r.records))
      .catch((e) => console.warn("detach list records failed", e));
  }, []);

  useEffect(() => {
    if (!window.electronAPI) return;
    const off = window.electronAPI.onPanelState((state: unknown) => {
      const s = state as { selectedId?: string | null; records?: ApplicantRecord[] } | null;
      if (s && typeof s === "object") {
        if (s.records) setRecords(s.records);
        if ("selectedId" in s) setSelectedId(s.selectedId ?? null);
      }
    });
    return off;
  }, []);

  const handleSelect = (id: string) => {
    setSelectedId(id);
    window.electronAPI?.panelSendAction("select-record", id);
  };

  const handleRefresh = async () => {
    try {
      const r = await api.listRecords();
      setRecords(r.records);
    } catch (e) {
      console.warn("detach refresh failed", e);
    }
    window.electronAPI?.panelSendAction("refresh-records");
  };

  const handleClear = async () => {
    // 只清空验证/任务状态，保留 Excel 数据
    setSelectedId(null);
    window.electronAPI?.panelSendAction("clear-records");
  };

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex shrink-0 items-center border-b border-slate-200/60 bg-white/80 px-3 py-1"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <span className="text-xs font-medium text-slate-600">数据源</span>
      </div>
      <div className="min-h-0 flex-1">
        <LeftPanel
          records={records}
          selectedId={selectedId}
          onSelect={handleSelect}
          onRefresh={handleRefresh}
          onClear={handleClear}
        />
      </div>
    </div>
  );
}

// ============ 脱离模式：底部核验结果面板 ============
function DetachedBottomPanel({ onFieldPanelActive, fieldSetupToggleSignal }: { onFieldPanelActive?: () => void; fieldSetupToggleSignal?: number }) {
  useApplyUiScale();
  const [record, setRecord] = useState<ApplicantRecord | null>(null);
  const [mappings, setMappings] = useState<FieldMapping[]>([]);
  const [comparisons, setComparisons] = useState<FieldComparison[]>([]);
  const [resultPresent, setResultPresent] = useState(false);
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [loopReports, setLoopReports] = useState<VerificationReport[]>([]);
  const [steps, setSteps] = useState<VerificationStep[]>([]);
  const [shots, setShots] = useState<ScreenshotEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [pickedMarks, setPickedMarks] = useState<PickedMark[]>([]);
  const [replaying, setReplaying] = useState(false);
  const [replayCursor, setReplayCursor] = useState(0);
  const logEndRef = useRef<HTMLDivElement>(null);
  // 教学步骤面板状态
  const [teachingPhase, setTeachingPhase] = useState<TeachingPhase>("idle");
  const [appMode, setAppMode] = useState<AppMode>("loop");
  const [selectMode, setSelectMode] = useState(false);
  const [hasSearchSteps, setHasSearchSteps] = useState(false);
  const [hasSubmitStep, setHasSubmitStep] = useState(false);
  const [dataSourceCount, setDataSourceCount] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);
  const [entryCount, setEntryCount] = useState(0);
  // ElementSelectBar 所需状态（由主窗口广播）
  const [pickTarget, setPickTarget] = useState<PickTarget>("right");
  const [rightPicked, setRightPicked] = useState<PickedElementInfo | null>(null);
  const [leftPicked, setLeftPicked] = useState<PickedElementInfo | null>(null);
  const [excelFields, setExcelFields] = useState<string[]>([]);
  const [mappingCount, setMappingCount] = useState(0);
  const [pendingAction, setPendingAction] = useState<"none" | "input" | "click">("none");
  const [selectedExcelColumn, setSelectedExcelColumn] = useState<string | null>(null);
  const [rightBindColumn, setRightBindColumn] = useState<string | null>(null);
  const [bindInputSide, setBindInputSide] = useState<"left" | "right" | "both" | null>(null);
  const [nextClickLabel, setNextClickLabel] = useState<string | null>(null);
  const [addingStepMode, setAddingStepMode] = useState<"review" | "entry" | null>(null);
  const [addingClickMode, setAddingClickMode] = useState(false);
  const [addingClickPhase, setAddingClickPhaseState] = useState<"pre" | "mid" | "post" | null>(null);
  const [addingDocExtractMode, setAddingDocExtractMode] = useState(false);
  const [bindStepCount, setBindStepCount] = useState(0);
  const [preClickCount, setPreClickCount] = useState(0);
  const [processClickCount, setProcessClickCount] = useState(0);
  const [postClickCount, setPostClickCount] = useState(0);
  const [docExtractStepCount, setDocExtractStepCount] = useState(0);
  const [hasBoundInputs, setHasBoundInputs] = useState(false);
  const [hasConfirmClick, setHasConfirmClick] = useState(false);
  const [cardsGenerated, setCardsGenerated] = useState(false);
  const [rowRange, setRowRange] = useState<{ start: number; end: number } | null>(null);
  const [hasCheckedBatch, setHasCheckedBatch] = useState(false);
  const [beginnerMode, setBeginnerMode] = useState(true);

  useEffect(() => {
    document.title = "核验结果";
  }, []);

  useEffect(() => {
    if (!window.electronAPI) return;
    const off = window.electronAPI.onPanelState((state: unknown) => {
      const s = state as {
        record?: ApplicantRecord | null;
        mappings?: FieldMapping[];
        comparisons?: FieldComparison[];
        resultPresent?: boolean;
        report?: VerificationReport | null;
        loopReports?: VerificationReport[];
        steps?: VerificationStep[];
        shots?: ScreenshotEvent[];
        running?: boolean;
        pickedMarks?: PickedMark[];
        replaying?: boolean;
        replayCursor?: number;
        teachingPhase?: TeachingPhase;
        appMode?: AppMode;
        selectMode?: boolean;
        hasSearchSteps?: boolean;
        hasSubmitStep?: boolean;
        dataSourceCount?: number;
        reviewCount?: number;
        entryCount?: number;
        pickTarget?: PickTarget;
        rightPicked?: PickedElementInfo | null;
        leftPicked?: PickedElementInfo | null;
        excelFields?: string[];
        mappingCount?: number;
        pendingAction?: "none" | "input" | "click";
        selectedExcelColumn?: string | null;
        rightBindColumn?: string | null;
        bindInputSide?: "left" | "right" | "both" | null;
        nextClickLabel?: string | null;
        addingStepMode?: "review" | "entry" | null;
        addingClickMode?: boolean;
        addingClickPhase?: "pre" | "mid" | "post" | null;
        addingDocExtractMode?: boolean;
        bindStepCount?: number;
        preClickCount?: number;
        processClickCount?: number;
        postClickCount?: number;
        docExtractStepCount?: number;
        hasBoundInputs?: boolean;
        hasConfirmClick?: boolean;
        cardsGenerated?: boolean;
        rowRange?: { start: number; end: number } | null;
        hasCheckedBatch?: boolean;
        beginnerMode?: boolean;
      } | null;
      if (!s || typeof s !== "object") return;
      if ("record" in s) setRecord(s.record ?? null);
      if ("mappings" in s) setMappings(s.mappings ?? []);
      if ("comparisons" in s) setComparisons(s.comparisons ?? []);
      if ("resultPresent" in s) setResultPresent(Boolean(s.resultPresent));
      if ("report" in s) setReport(s.report ?? null);
      if ("loopReports" in s) setLoopReports(s.loopReports ?? []);
      if ("steps" in s) setSteps(s.steps ?? []);
      if ("shots" in s) setShots(s.shots ?? []);
      if ("running" in s) setRunning(Boolean(s.running));
      if ("pickedMarks" in s) setPickedMarks(s.pickedMarks ?? []);
      if ("replaying" in s) setReplaying(Boolean(s.replaying));
      if ("replayCursor" in s) setReplayCursor(Number(s.replayCursor ?? 0));
      if ("teachingPhase" in s) setTeachingPhase(s.teachingPhase ?? "idle");
      if ("appMode" in s) setAppMode(s.appMode ?? "loop");
      if ("selectMode" in s) setSelectMode(Boolean(s.selectMode));
      if ("hasSearchSteps" in s) setHasSearchSteps(Boolean(s.hasSearchSteps));
      if ("hasSubmitStep" in s) setHasSubmitStep(Boolean(s.hasSubmitStep));
      if ("dataSourceCount" in s) setDataSourceCount(Number(s.dataSourceCount ?? 0));
      if ("reviewCount" in s) setReviewCount(Number(s.reviewCount ?? 0));
      if ("entryCount" in s) setEntryCount(Number(s.entryCount ?? 0));
      if ("pickTarget" in s) setPickTarget(s.pickTarget ?? "right");
      if ("rightPicked" in s) setRightPicked(s.rightPicked ?? null);
      if ("leftPicked" in s) setLeftPicked(s.leftPicked ?? null);
      if ("excelFields" in s) setExcelFields(s.excelFields ?? []);
      if ("mappingCount" in s) setMappingCount(Number(s.mappingCount ?? 0));
      if ("pendingAction" in s) setPendingAction(s.pendingAction ?? "none");
      if ("selectedExcelColumn" in s) setSelectedExcelColumn(s.selectedExcelColumn ?? null);
      if ("rightBindColumn" in s) setRightBindColumn(s.rightBindColumn ?? null);
      if ("bindInputSide" in s) setBindInputSide(s.bindInputSide ?? null);
      if ("nextClickLabel" in s) setNextClickLabel(s.nextClickLabel ?? null);
      if ("addingStepMode" in s) setAddingStepMode(s.addingStepMode ?? null);
      if ("addingClickMode" in s) setAddingClickMode(Boolean(s.addingClickMode));
      if ("addingClickPhase" in s) setAddingClickPhaseState(s.addingClickPhase ?? null);
      if ("addingDocExtractMode" in s) setAddingDocExtractMode(Boolean(s.addingDocExtractMode));
      if ("bindStepCount" in s) setBindStepCount(Number(s.bindStepCount ?? 0));
      if ("preClickCount" in s) setPreClickCount(Number(s.preClickCount ?? 0));
      if ("processClickCount" in s) setProcessClickCount(Number(s.processClickCount ?? 0));
      if ("postClickCount" in s) setPostClickCount(Number(s.postClickCount ?? 0));
      if ("docExtractStepCount" in s) setDocExtractStepCount(Number(s.docExtractStepCount ?? 0));
      if ("hasBoundInputs" in s) setHasBoundInputs(Boolean(s.hasBoundInputs));
      if ("hasConfirmClick" in s) setHasConfirmClick(Boolean(s.hasConfirmClick));
      if ("cardsGenerated" in s) setCardsGenerated(Boolean(s.cardsGenerated));
      if ("rowRange" in s) setRowRange(s.rowRange ?? null);
      if ("hasCheckedBatch" in s) setHasCheckedBatch(Boolean(s.hasCheckedBatch));
      if ("beginnerMode" in s) setBeginnerMode(s.beginnerMode !== false);
    });
    // 主动请求主窗口广播当前状态（解决广播早于监听注册的时序竞态）
    window.electronAPI?.panelSendAction("request-state", "bottom");
    return off;
  }, []);

  const handleRemoveMapping = (index: number) => {
    window.electronAPI?.panelSendAction("remove-mapping", index);
  };

  // 脱离小窗口：步骤设置模式下，新手模式默认显示「步骤设置·元素选择」，点切换看「字段映射」；非新手模式直接显示字段对比
  const [bottomView, setBottomView] = useState<"steps" | "results">("results");
  useEffect(() => {
    if (selectMode) setBottomView(beginnerMode ? "steps" : "results");
  }, [selectMode, beginnerMode]);

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex shrink-0 items-center gap-2 border-b border-slate-200/60 bg-white/80 px-3 py-1"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <span className="text-xs font-medium text-slate-600">核验结果</span>
        {selectMode && beginnerMode && (
          <div
            className="flex items-center gap-0.5 rounded-md bg-slate-100 p-0.5"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <button
              onClick={() => setBottomView("steps")}
              className={[
                "rounded px-2 py-0.5 text-[10px] font-medium transition-all",
                bottomView === "steps" ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-700",
              ].join(" ")}
            >
              步骤设置
            </button>
            <button
              onClick={() => setBottomView("results")}
              className={[
                "rounded px-2 py-0.5 text-[10px] font-medium transition-all",
                bottomView === "results" ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-700",
              ].join(" ")}
            >
              字段映射
            </button>
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 新手模式：默认全屏显示 ElementSelectBar；切换才看 ResultsPanel。非新手模式：直接显示 ResultsPanel */}
        {selectMode && beginnerMode && bottomView === "steps" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white/95 p-1.5 backdrop-blur-sm">
            <ElementSelectBar
              active={selectMode}
              pickTarget={pickTarget}
              rightPicked={rightPicked}
              leftPicked={leftPicked}
              excelFields={excelFields}
              mappingCount={mappingCount}
              onCancel={() => window.electronAPI?.panelSendAction("exit-select-mode", undefined)}
              onPickLeftFromWeb={() => window.electronAPI?.panelSendAction("pick-left-from-web", undefined)}
              onPickLeftFromExcel={() => window.electronAPI?.panelSendAction("pick-left-from-excel", undefined)}
              onResetRound={() => window.electronAPI?.panelSendAction("reset-round", undefined)}
              onSave={(m) => window.electronAPI?.panelSendAction("save-mapping", m)}
              teachingPhase={teachingPhase}
              pendingAction={pendingAction}
              appMode={appMode}
              dataSourceCount={dataSourceCount}
              reviewCount={reviewCount}
              entryCount={entryCount}
              hasBoundInputs={hasBoundInputs}
              hasConfirmClick={hasConfirmClick}
              onAdvanceTeaching={() => window.electronAPI?.panelSendAction("teaching-advance", undefined)}
              onAbortTeaching={() => window.electronAPI?.panelSendAction("teaching-abort", undefined)}
              onRequestQuickSave={() => window.electronAPI?.panelSendAction("quick-save-loop", undefined)}
              onRequestSaveSkill={() => window.electronAPI?.panelSendAction("save-skill", undefined)}
              onDirectRun={() => window.electronAPI?.panelSendAction("direct-run", undefined)}
              selectedExcelColumn={selectedExcelColumn}
              rightBindColumn={rightBindColumn}
              onRightBindColumnChange={(col) => window.electronAPI?.panelSendAction("set-right-bind-column", col)}
              bindInputSide={bindInputSide}
              nextClickLabel={nextClickLabel}
              onStartBindInputs={() => window.electronAPI?.panelSendAction("start-bind-inputs", undefined)}
              onExitBindInputs={() => window.electronAPI?.panelSendAction("exit-bind-inputs", undefined)}
              bindStepCount={bindStepCount}
              onStartConfirmPerson={() => window.electronAPI?.panelSendAction("start-confirm-person", undefined)}
              onStartAddReviewSteps={() => window.electronAPI?.panelSendAction("start-add-review-steps", undefined)}
              onStartAddEntrySteps={() => window.electronAPI?.panelSendAction("start-add-entry-steps", undefined)}
              onExitAddingStepMode={() => window.electronAPI?.panelSendAction("exit-adding-step-mode", undefined)}
              addingStepMode={addingStepMode}
              addingClickMode={addingClickMode}
              addingClickPhase={addingClickPhase}
              preClickCount={preClickCount}
              processClickCount={processClickCount}
              postClickCount={postClickCount}
              onStartAddPreClick={() => window.electronAPI?.panelSendAction("start-add-pre-click", undefined)}
              onStartAddProcessClick={() => window.electronAPI?.panelSendAction("start-add-process-click", undefined)}
              onStartAddPostClick={() => window.electronAPI?.panelSendAction("start-add-post-click", undefined)}
              onExitAddClickMode={() => window.electronAPI?.panelSendAction("exit-add-click-mode", undefined)}
              onSwapSide={() => window.electronAPI?.panelSendAction("swap-side", undefined)}
              onUndo={() => window.electronAPI?.panelSendAction("undo", undefined)}
              canUndo={pickedMarks.length > 0}
              addingDocExtractMode={addingDocExtractMode}
              docExtractStepCount={docExtractStepCount}
              onStartAddDocExtract={() => window.electronAPI?.panelSendAction("start-add-doc-extract", undefined)}
              onExitAddDocExtractMode={() => window.electronAPI?.panelSendAction("exit-add-doc-extract-mode", undefined)}
              onDocFileExtract={() => window.electronAPI?.panelSendAction("doc-file-extract", undefined)}
              cardsGenerated={cardsGenerated}
              rowRange={rowRange}
            />
          </div>
        ) : (
          <div className="relative min-h-0 flex-1">
            <ResultsPanel
              comparisons={comparisons}
              resultPresent={resultPresent}
              report={report}
              loopReports={loopReports}
              shots={shots}
              steps={steps}
              running={running}
              appMode={appMode}
              addingStepMode={addingStepMode}
              onSaveToBatch={() => window.electronAPI?.panelSendAction("save-to-batch", undefined)}
              hasCheckedBatch={hasCheckedBatch}
              records={record ? [record] : []}
              onSelectRecord={(id) => window.electronAPI?.panelSendAction("select-record", id)}
              selectMode={selectMode}
              onFieldPanelActive={onFieldPanelActive}
              fieldSetupToggleSignal={fieldSetupToggleSignal}
              onRefresh={() => window.electronAPI?.panelSendAction("refresh-workspace", undefined)}
            />
            {/* 步骤设置面板：下面板分离后，TeachingGuide 在此渲染（而非主窗口）（仅新手模式） */}
            {beginnerMode && teachingPhase !== "idle" && !selectMode && (
              <TeachingGuide
                phase={teachingPhase}
                appMode={appMode}
                pickedMarks={pickedMarks}
                hasSearchSteps={hasSearchSteps}
                hasSubmitStep={hasSubmitStep}
                dataSourceCount={dataSourceCount}
                reviewCount={reviewCount}
                entryCount={entryCount}
                onAdvance={() => window.electronAPI?.panelSendAction("teaching-advance", undefined)}
                onRequestSave={() => window.electronAPI?.panelSendAction("save-skill", undefined)}
                onAbort={() => window.electronAPI?.panelSendAction("teaching-abort", undefined)}
                onBack={() => window.electronAPI?.panelSendAction("teaching-back", undefined)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============ 脱离模式：浏览器面板 ============
function DetachedBrowserPanel({ detachSide }: { detachSide: "browser-left" | "browser-right" }) {
  useApplyUiScale();
  const [url, setUrl] = useState<string>("");
  const [picking, setPicking] = useState(false);
  const [popupActive, setPopupActive] = useState(false);
  const [brightness, setBrightness] = useState<number>(1.0);
  const side: ViewSide = detachSide === "browser-left" ? "left" : "right";
  const title = detachSide === "browser-left" ? "数据源网页" : "学校系统";

  useEffect(() => {
    document.title = title;
  }, [title]);

  // 拉取设置中的网页亮度
  useEffect(() => {
    api.getSettings()
      .then((s) => {
        const v = Number(s.browser_brightness);
        if (!isNaN(v) && v > 0) setBrightness(Math.max(0.3, Math.min(2.0, v)));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!window.electronAPI) return;
    const off = window.electronAPI.onPanelState((state: unknown) => {
      const s = state as { url?: string; picking?: boolean } | null;
      if (s && typeof s === "object") {
        if (typeof s.url === "string") setUrl(s.url);
        if (typeof s.picking === "boolean") setPicking(s.picking);
      }
    });
    // 主动请求主窗口广播当前状态（解决广播早于监听注册的时序竞态）
    window.electronAPI?.panelSendAction("request-state", detachSide);
    return off;
  }, [detachSide]);

  // 监听弹窗创建/关闭
  useEffect(() => {
    if (!window.electronAPI) return;
    const offCreated = window.electronAPI.onPopupCreated((data) => {
      if (data.parentSide === side) setPopupActive(true);
    });
    const offClosed = window.electronAPI.onPopupClosed((data) => {
      if (data.parentSide === side) setPopupActive(false);
    });
    return () => {
      offCreated();
      offClosed();
    };
  }, [side]);

  const handleUrlChange = (newUrl: string) => {
    setUrl(newUrl);
    window.electronAPI?.panelSendAction("set-url", { side, url: newUrl });
  };

  // 脱离窗口中拾取到元素 → 回传给主窗口
  const handlePickedElement = (info: PickedElementInfo) => {
    window.electronAPI?.panelSendAction("detached-element-picked", { side, info });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <BrowserPane
          side={side}
          title={title}
          url={url}
          onUrlChange={handleUrlChange}
          picking={picking}
          onPickedElement={handlePickedElement}
          detachedSide={detachSide}
          popupActive={popupActive}
          brightness={brightness}
          enableTabs={detachSide === "browser-right"}
          onClosePopup={() => window.electronAPI?.popupClose(side)}
        />
      </div>
    </div>
  );
}

// ============ 脱离模式：Excel 视图面板 ============
function DetachedExcelPanel() {
  useApplyUiScale();
  const [records, setRecords] = useState<ApplicantRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickedMarks, setPickedMarks] = useState<PickedMark[]>([]);
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Excel 视图";
  }, []);

  useEffect(() => {
    api.listRecords()
      .then((r) => setRecords(r.records))
      .catch((e) => console.warn("detach excel list failed", e));
  }, []);

  useEffect(() => {
    if (!window.electronAPI) return;
    const off = window.electronAPI.onPanelState((state: unknown) => {
      const s = state as { records?: ApplicantRecord[]; selectedId?: string | null; pickedMarks?: PickedMark[]; selectedExcelColumn?: string | null } | null;
      if (s && typeof s === "object") {
        if (s.records) setRecords(s.records);
        if ("selectedId" in s) setSelectedId(s.selectedId ?? null);
        if ("pickedMarks" in s) setPickedMarks(s.pickedMarks ?? []);
        if ("selectedExcelColumn" in s) setSelectedColumn(s.selectedExcelColumn ?? null);
      }
    });
    return off;
  }, []);

  // 脱离窗口内点击单元格 → 发送给主窗口
  const handlePicked = (info: ExcelPickedField) => {
    window.electronAPI?.panelSendAction("excel-picked-field", info);
  };

  const handleSelectColumn = (field: string | null) => {
    setSelectedColumn(field);
    window.electronAPI?.panelSendAction("excel-select-column", field);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <ExcelView
          records={records}
          selectedId={selectedId}
          picking
          onPickedField={handlePicked}
          pickedMarks={pickedMarks}
          selectedColumn={selectedColumn}
          onSelectColumn={handleSelectColumn}
        />
      </div>
    </div>
  );
}

export default function App() {
  const [records, setRecords] = useState<ApplicantRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 点击字段对比面板后置 true，激活仅面板内可用的快捷键（W/R/T/F/E/G/Q） */
  const [fieldPanelActive, setFieldPanelActive] = useState(false);
  /** L 快捷键信号：递增时切换字段对比面板的「步骤设置/结果显示」模式 */
  const [fieldSetupToggleSignal, setFieldSetupToggleSignal] = useState(0);
  // LOOP 分段提取：Excel 行范围框选（0-based 闭区间）与人物卡片生成状态
  // 人物卡片只在用户框选好 LOOP 行范围后一键生成，而非上传 Excel 即全量生成
  const [rowRange, setRowRange] = useState<{ start: number; end: number } | null>(null);
  const [cardsGenerated, setCardsGenerated] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  // 设置的最新快照：供 executeMark 等不依赖 settings 的 useCallback 闭包读取（避免闭包过期拿到旧开关值）
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // 切换文档/护照 OCR 识别引擎（识图AI ↔ UMI-OCR），即时保存到后端
  const handleChangeOcrEngine = useCallback(async (engine: "vision" | "umi") => {
    const next = { ...settings, ocr_engine: engine };
    setSettings(next);
    setConfig((c) => (c ? { ...c, settings: next } : c));
    // 切换引擎后清除后台OCR缓存，避免复用到旧引擎的结果
    bgOcrResultRef.current = null;
    try {
      // 只发增量：全量 settings 是本组件启动时加载的快照，可能滞后于后端
      // （如别处刚改过转正/加速开关），全量回存会把旧值覆盖回去
      await api.saveSettings({ ocr_engine: engine });
    } catch (e) {
      console.error("[ocrEngine] 保存失败", e);
    }
  }, [settings]);
  // 整体UI缩放（Ctrl+滚轮调控，范围0.6~1.6，步长0.05）
  const [uiScale, setUiScale] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("cinside-ui-scale");
      const val = saved ? parseFloat(saved) : 1.0;
      return isNaN(val) ? 1.0 : Math.max(0.6, Math.min(1.6, val));
    } catch {
      return 1.0;
    }
  });
  const uiScaleRef = useRef(uiScale);
  uiScaleRef.current = uiScale;
  const brightnessRafRef = useRef<number>(0);
  const scaleRafRef = useRef<number>(0);
  const pendingBrightnessRef = useRef<number>(1.0);
  const pendingScaleRef = useRef<number>(1.0);
  const ctrlPressedRef = useRef(false);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [backendReady, setBackendReady] = useState(!window.electronAPI);
  // 任务类型：select=选择页，web=网页任务，ppt=幻灯片任务，cowork=协作任务
  const [taskType, setTaskType] = useState<"select" | "web" | "ppt" | "cowork">("select");
  const switchTaskType = useCallback((t: "select" | "web" | "ppt" | "cowork") => {
    setTaskType(t);
  }, []);
  // OfficeCLI 未安装提示弹窗（点击幻灯片任务时触发）
  const [officecliModalOpen, setOfficecliModalOpen] = useState(false);
  const [officecliChecking, setOfficecliChecking] = useState(false);
  const handleTaskSelect = useCallback(async (t: "web" | "ppt" | "cowork") => {
    if (t === "ppt") {
      // 进入幻灯片任务前检查 OfficeCLI 是否可用
      setOfficecliChecking(true);
      try {
        const status = await api.pptStatus();
        if (status.available) {
          switchTaskType("ppt");
        } else {
          setOfficecliModalOpen(true);
        }
      } catch {
        // 检查失败也弹窗，让用户可以尝试安装
        setOfficecliModalOpen(true);
      } finally {
        setOfficecliChecking(false);
      }
    } else if (t === "cowork") {
      switchTaskType("cowork");
    } else {
      switchTaskType("web");
    }
  }, [switchTaskType]);
  const [showSettings, setShowSettings] = useState(false);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(true);
  const [hasRunOnce, setHasRunOnce] = useState(false);
  const [executionPanelOpen, setExecutionPanelOpen] = useState(false); // 右侧执行进度面板
  const [edgeButtonVisible, setEdgeButtonVisible] = useState(false); // 气泡消失后才显示侧边按钮
  // 面板脱离：true 表示该面板被弹出到独立窗口，主窗口不渲染对应区域
  const [leftDetached, setLeftDetached] = useState(false);
  const [bottomDetached, setBottomDetached] = useState(false);
  const [browserLeftDetached, setBrowserLeftDetached] = useState(false);
  const [browserRightDetached, setBrowserRightDetached] = useState(false);
  // 聚焦下方：激活时隐藏上方两个 BrowserPane，下方审查面板三列铺满整屏
  const [focusBottomMode, setFocusBottomMode] = useState(false);
  // Excel 视图脱离
  const [excelDetached, setExcelDetached] = useState(false);
  // 弹窗（window.open 拦截）：记录哪个 side 的弹窗处于激活状态
  const [popupSide, setPopupSide] = useState<ViewSide | null>(null);
  // 左侧视图模式：网页 / Excel
  const [leftViewMode, setLeftViewMode] = useState<"web" | "excel">("web");
  // 右侧视图模式：网页 / Excel
  const [rightViewMode, setRightViewMode] = useState<"web" | "excel">("web");
  // 空白表格（可填写、可导出）
  const [leftBlankExcel, setLeftBlankExcel] = useState(false);
  const [rightBlankExcel, setRightBlankExcel] = useState(false);
  // 右侧Excel数据
  const [rightRecords, setRightRecords] = useState<ApplicantRecord[]>([]);
  const [rightExcelUploading, setRightExcelUploading] = useState(false);
  const rightExcelInputRef = useRef<HTMLInputElement>(null);
  // 右侧 Excel 作为 LOOP 数据源：行范围框选 / 卡片已生成 / 选中列（LOOP 列拖拽框选用）
  const [rightRowRange, setRightRowRange] = useState<{ start: number; end: number } | null>(null);
  const [rightCardsGenerated, setRightCardsGenerated] = useState(false);
  const [rightSelectedColumn, setRightSelectedColumn] = useState<string | null>(null);
  // ref 持有最新 rightSelectedColumn：右侧 Excel 作为数据源时，绑定输入框填值用它做 LOOP 列兜底
  const rightSelectedColumnRef = useRef<string | null>(null);
  rightSelectedColumnRef.current = rightSelectedColumn;
  // 常用网页收藏（左右侧分开存储，各自持久化到 localStorage）
  // 左侧通常为数据源/Excel 系统，右侧通常为审查目标网页，收藏内容不同
  const [leftFavoriteSites, setLeftFavoriteSites] = useState<{ name: string; url: string }[]>(() => {
    try {
      const raw = localStorage.getItem("cinside-favorite-sites-left");
      if (raw) return JSON.parse(raw);
      // 旧版共享数据迁移：首次读取旧 key 作为左侧初始值
      const legacy = localStorage.getItem("cinside-favorite-sites");
      return legacy ? JSON.parse(legacy) : [];
    } catch { return []; }
  });
  const [rightFavoriteSites, setRightFavoriteSites] = useState<{ name: string; url: string }[]>(() => {
    try {
      const raw = localStorage.getItem("cinside-favorite-sites-right");
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const handleAddFavoriteSite = (side: "left" | "right") => (name: string, url: string) => {
    const setFn = side === "left" ? setLeftFavoriteSites : setRightFavoriteSites;
    const storageKey = side === "left" ? "cinside-favorite-sites-left" : "cinside-favorite-sites-right";
    setFn(prev => {
      const next = [...prev, { name, url }];
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const handleRemoveFavoriteSite = (side: "left" | "right") => (url: string) => {
    const setFn = side === "left" ? setLeftFavoriteSites : setRightFavoriteSites;
    const storageKey = side === "left" ? "cinside-favorite-sites-left" : "cinside-favorite-sites-right";
    setFn(prev => {
      const next = prev.filter(s => s.url !== url);
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
      return next;
    });
  };
// 教学模式中选中的 Excel 列，作为 LOOP 变量（对每行记录重复执行）
const [selectedExcelColumn, setSelectedExcelColumn] = useState<string | null>(null);
// ref 始终持有最新 selectedExcelColumn，供 onLeftPicked/onRightPicked 读取，避免闭包陷阱
const selectedExcelColumnRef = useRef(selectedExcelColumn);
selectedExcelColumnRef.current = selectedExcelColumn;

// 右侧网页绑定输入时使用的 Excel 列（null = 跟随 LOOP 列）
// 左侧网页绑定输入始终用 LOOP 列；右侧学习系统可能搜同一行的其他列（如护照号）
const [rightBindColumn, setRightBindColumn] = useState<string | null>(null);
const rightBindColumnRef = useRef(rightBindColumn);
rightBindColumnRef.current = rightBindColumn;

// 录入流的「来源字段值」：第一次点击网页上的字段时捕获其值，第二次点击输入框时把该值复制填入。
// 优先于 Excel 列值使用（用户意图：把第一次点击的字段内容复制到之后点击的输入框）。
const sourceFieldValueRef = useRef<string>("");
// 录入流的「来源字段名」（用于 mark 的 label 展示，可选）
const sourceFieldLabelRef = useRef<string>("");

  // 两个浏览器面板的宽度比例（左侧面板百分比）
  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(50);
  const draggingRef = useRef(false);

  // 底部审查面板的高度比例（百分比），审查流操作时自动收窄
  const [bottomPanelHeight, setBottomPanelHeight] = useState<number>(20);
  const vDraggingRef = useRef(false);
  // 双击最大化前的高度记录（用于还原）
  const prevBottomHeightRef = useRef<number | null>(null);

  // 教学侧边面板：宽度比例（百分比）和左右位置
  const [teachingPanelWidth, setTeachingPanelWidth] = useState<number>(33);
  const [teachingPanelSide, setTeachingPanelSide] = useState<"left" | "right">("left");
  const teachingDragRef = useRef(false);

  // 两个网页的 URL
  // 数据源网页默认 DEMO 地址（模拟原 admin 数据源站点）
  // 左侧默认打开 DEMO 数据源管理页面（后端静态服务）
  const [leftUrl, setLeftUrl] = useState<string>("");
  const [rightUrl, setRightUrl] = useState<string>("http://localhost:8000/demo-fill/");

  // 元素屏蔽功能
  const [blockPickingSide, setBlockPickingSide] = useState<ViewSide | null>(null);
  // 自动侧边栏折叠：按 `${side}:${host}` 存储勾选状态
  const [sidebarAutoCollapse, setSidebarAutoCollapseState] = useState<Record<string, boolean>>({});
  const [blockRulesState, setBlockRulesState] = useState<Record<string, BlockRule[]>>({});
  const [showBlockPanel, setShowBlockPanel] = useState<ViewSide | null>(null);

  // 账号密码凭证
  const [credentials, setCredentials] = useState<Credential[]>(() => getAllCredentials());
  const [showCredentialsPanel, setShowCredentialsPanel] = useState<ViewSide | null>(null);
  // 两段式粘贴状态：当前激活的凭证 id 和步骤
  const [activePasteId, setActivePasteId] = useState<string | null>(null);
  const [pasteStep, setPasteStep] = useState<0 | 1>(0);

  // 元素选择模式
  const [selectMode, setSelectMode] = useState(false);
  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;
  const [pickTarget, setPickTarget] = useState<PickTarget>("right");
  const [rightPicked, setRightPicked] = useState<PickedElementInfo | null>(null);
  const [leftPicked, setLeftPicked] = useState<PickedElementInfo | null>(null);
  const rightPickedRef = useRef<PickedElementInfo | null>(null);
  rightPickedRef.current = rightPicked;
  // 右侧 Excel 数据源模式：右面板显示 Excel、左面板显示学校系统网页。
  // 此模式下「比对目标」元素在左网页，映射保存时 web_side="left"。
  const rightExcelMode = rightRecords.length > 0 && rightViewMode === "excel" && !rightBlankExcel && leftViewMode === "web";
  const rightExcelModeRef = useRef(false);
  rightExcelModeRef.current = rightExcelMode;
  // rightPicked 槽位中网页元素的实际所在侧（默认 right；右侧Excel模式下左网页元素占此槽位）
  const rightPickedSideRef = useRef<"left" | "right">("right");
  // 视图模式 ref（供 useCallback 内读取最新值）
  const leftViewModeRef = useRef(leftViewMode);
  leftViewModeRef.current = leftViewMode;
  const rightViewModeRef = useRef(rightViewMode);
  rightViewModeRef.current = rightViewMode;
  const [mappings, setMappings] = useState<FieldMapping[]>([]);
  const mappingsRef = useRef<FieldMapping[]>([]);
  mappingsRef.current = mappings;
  // ElementSelectBar 通知：当前双侧已选好、可以保存映射
  const [canSaveMapping, setCanSaveMapping] = useState(false);

  // 头像提取模式（左侧浏览器拾取头像元素）
  const [avatarMode, setAvatarMode] = useState(false);
  const [avatarPicked, setAvatarPicked] = useState<PickedElementInfo | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);

  // 数据源操作下拉菜单（已废弃：改为按钮直接进入拾取模式，state 保留用于教学流程兼容）
  // const [dataSourceMenuOpen, setDataSourceMenuOpen] = useState(false);


  const [replaying, setReplaying] = useState(false);
  const [replayCursor, setReplayCursor] = useState(0);
  const replayStopRef = useRef(false);

  // 键盘快捷键触发的待执行动作：input（S 键）/ click（空格键）
  // - input：下一次点击取元素值并填入目标输入框（自动关闭）
  // - click：下一次点击真正触发 element.click()（自动关闭）
  const [pendingAction, setPendingAction] = useState<"none" | "input" | "click">("none");
  // input 模式的目标（按 S 时的最后一个右侧网页输入框 mark）
  const [inputTarget, setInputTarget] = useState<PickedMark | null>(null);
  // S 输入模式下待填入的值（点击 Excel 单元格或左侧网页元素后记录，按 Enter 时才真正填入网页框）
  const [pendingInputValue, setPendingInputValue] = useState<string | null>(null);
  // 待填入值对应的 Excel 字段名（用于变量标记和显示），网页取值时可能为 null
  const [pendingInputField, setPendingInputField] = useState<string | null>(null);

  // 用 ref 保存上述 input 模式状态，避免事件回调闭包捕获旧值
  const pendingActionRef = useRef(pendingAction);
  pendingActionRef.current = pendingAction;
  const inputTargetRef = useRef(inputTarget);
  inputTargetRef.current = inputTarget;
  const pendingInputValueRef = useRef(pendingInputValue);
  pendingInputValueRef.current = pendingInputValue;
  const pendingInputFieldRef = useRef(pendingInputField);
  pendingInputFieldRef.current = pendingInputField;

  // 教学模式分步向导：灵活绑定输入框/点击（"both"=左右侧皆可，"left"/"right"=旧引导流程保留）
  const [bindInputSide, setBindInputSide] = useState<"left" | "right" | "both" | null>(null);
  const bindInputSideRef = useRef(bindInputSide);
  bindInputSideRef.current = bindInputSide;
  // 下一次 click 动作的特殊标签（如“确认人物”）
  const [nextClickLabel, setNextClickLabel] = useState<string | null>(null);
  const nextClickLabelRef = useRef(nextClickLabel);
  nextClickLabelRef.current = nextClickLabel;
// 步骤4：正在添加循环体步骤的模式（review / entry / null）
const [addingStepMode, setAddingStepMode] = useState<"review" | "entry" | null>(null);
// ref 始终持有最新 addingStepMode，供 onLeftPicked/onRightPicked 读取，避免闭包陷阱
const addingStepModeRef = useRef(addingStepMode);
addingStepModeRef.current = addingStepMode;
// 当前配置的循环步骤类型（审查/录入），支持混合模式交替添加
const [currentLoopStepType, setCurrentLoopStepType] = useState<"review" | "entry">("review");
const currentLoopStepTypeRef = useRef(currentLoopStepType);
currentLoopStepTypeRef.current = currentLoopStepType;
// 步骤3之后：正在添加点击按钮的模式（连续添加多个点击动作）
const [addingClickMode, setAddingClickMode] = useState(false);
const addingClickModeRef = useRef(addingClickMode);
addingClickModeRef.current = addingClickMode;
// 当前添加的点击阶段：pre=前置点击(搜索/进入，步骤3)，mid=过程点击(点击NEXT等，步骤4)，post=收尾点击(保存/返回，步骤5)
const [addingClickPhase, setAddingClickPhase] = useState<"pre" | "mid" | "post" | null>(null);
const addingClickPhaseRef = useRef(addingClickPhase);
addingClickPhaseRef.current = addingClickPhase;
// 文件提取模式：点击网页图片/PDF → OCR 提取（点左侧元素=录入提取，点右侧=审查提取）
const [addingDocExtractMode, setAddingDocExtractMode] = useState(false);
const addingDocExtractModeRef = useRef(addingDocExtractMode);
addingDocExtractModeRef.current = addingDocExtractMode;
// 文件提取来源选择：null=未选择，"choose"=选择来源类型，"web"=网页提取中，"local"=本地文件配置中
const [docExtractSource, setDocExtractSource] = useState<null | "choose" | "web" | "local">(null);
const docExtractSourceRef = useRef(docExtractSource);
docExtractSourceRef.current = docExtractSource;
// 文件提取配置后是否展示"文件处理+提取元素"两栏分屏（点击"提取元素"后开启）
const [docExtractSplitView, setDocExtractSplitView] = useState(false);
const docExtractSplitViewRef = useRef(docExtractSplitView);
docExtractSplitViewRef.current = docExtractSplitView;
// 标记下一次 addingDocExtractMode 变 false 时不要重置分屏（用于从分屏中添加控件时保持文件处理面板可见）
const preserveSplitViewRef = useRef(false);
// 源文件预览（嵌套在文件提取配置面板里的持久预览窗口；字段送「提取元素」后仍保留）
const [docSourcePreview, setDocSourcePreview] = useState<{
  imageUrl: string;
  filename: string;
  method: string;
} | null>(null);
const docSourcePreviewRef = useRef(docSourcePreview);
docSourcePreviewRef.current = docSourcePreview;
// 退出文件提取模式时自动关闭两栏分屏并清空预览（从分屏中添加控件时除外）
useEffect(() => {
  if (!addingDocExtractMode) {
    if (!preserveSplitViewRef.current) {
      setDocExtractSplitView(false);
    }
    preserveSplitViewRef.current = false;
    setDocSourcePreview(null);
    // 清除网页提取内嵌结果，防止退出模式后浮动审查面板（DocExtractReviewPanel）
    // 因条件 !(addingDocExtractMode && docExtractSource === "web") 变 true 而弹
    // 出到右侧 BrowserPane 位置形成"分身"。提取结果已保存在 docExtractsByRecord 中。
    setDocExtractPanel(null);
    setSameNameImages(null);
  }
}, [addingDocExtractMode]);
// 网页下载提取过程的反馈状态（idle=等待, downloading=下载中, preview=预览就绪, ocr=OCR中, success=提取成功, post-click=添加收尾点击中, error=失败）
type DocWebStatus =
  | { phase: "idle" }
  | { phase: "downloading"; filename: string; received: number; total: number; percent: number }
  | { phase: "preview"; filename: string; size: number }
  | { phase: "ocr"; filename: string }
  | { phase: "success"; filename: string; size: number }
  | { phase: "post-click"; filename: string }
  | { phase: "error"; message: string; filename?: string }
  | { phase: "fallback-scanning"; message?: string }
  | { phase: "fallback-downloading"; total: number; current: number; currentFile?: string }
  | { phase: "fallback-review"; files: Array<{ filename: string; dataUrl: string; size: number; mime: string; matched: boolean; selected?: boolean }>; side: "left" | "right"; recordKey?: string; recordName?: string };
const [docWebStatus, setDocWebStatus] = useState<DocWebStatus>({ phase: "idle" });
const docWebStatusRef = useRef<DocWebStatus>(docWebStatus);
docWebStatusRef.current = docWebStatus;
// 保底机制跳过时保留下载的文件（按 record_id），供事后在「文件处理」面板人工查看/重新提取
const [fallbackFilesByRecord, setFallbackFilesByRecord] = useState<Record<string, Array<{ filename: string; dataUrl: string; size: number; mime: string; matched: boolean }>>>({});
// 本次 LOOP 中因保底自动跳过而需要人工检查的 record_id 集合（跑完标记为需检查/review）
const needsManualRef = useRef<Set<string>>(new Set());
// 暂存已下载但尚未触发 OCR 的文件数据（预览后点击「录入提取」才消费）
const pendingWebFileRef = useRef<{ dataUrl: string; filename: string; size: number; side: "left" | "right" } | null>(null);
// 后台OCR预提取结果缓存（LOOP模式下下载后立即开OCR，结果缓存供triggerWebExtract复用）
// engine 字段记录缓存结果使用的 OCR 引擎，切换引擎后缓存自动失效
// promise 字段：高速模式下 OCR 在后台跑，promise 尚未落定时 triggerWebExtract/join 等 await 它
const bgOcrResultRef = useRef<{
  dataUrl: string; engine: string;
  result?: Awaited<ReturnType<typeof api.extractDocumentFile>>;
  promise?: Promise<Awaited<ReturnType<typeof api.extractDocumentFile>>>;
} | null>(null);
// 高速模式：各记录后台 OCR 的落定 Promise（含状态写入），按 record_id 分组——
// 两遍式流水线下 pass1 连续下载多人，join 移到 pass2 逐人执行，必须按人隔离防串
const bgOcrPromisesRef = useRef<Map<string, Array<Promise<unknown>>>>(new Map());
// 高速模式：延后执行的文件一致性校验（下错文件时才触发保底，捕获当时的回退步数），同样按 record_id 分组
const pendingFileVerifyRef = useRef<Map<string, () => Promise<void>>>(new Map());
// 两遍式 pass1（deferCompare）进行中标记：文件提取的 OCR+DeepSeek 无条件后台化，
// 不依赖高速模式开关——两遍式流水线本身的并行语义，任何档位下 pass1 都不许内联等 AI
const passDeferActiveRef = useRef(false);
// 保底机制：等待人工确认文件的 Promise resolve
const fallbackWaitResolveRef = useRef<((file: { filename: string; dataUrl: string; size: number; mime: string } | null) => void) | null>(null);
// LOOP执行时当前记录的开头点击步骤数（供保底机制回退页面用）
const currentPreClickCountRef = useRef(0);
// 保底机制处于活动阶段（扫描/下载/人工审查）：强制渲染文件提取面板让人工可见
const docFallbackActive = docWebStatus.phase === "fallback-scanning"
  || docWebStatus.phase === "fallback-downloading"
  || docWebStatus.phase === "fallback-review";
// 当前执行步骤的日志前缀（用于把阶段进展实时写回运行中卡片的步骤 detail）
const liveStepPrefixRef = useRef<string | null>(null);
// LOOP 运行期逐对填入卡片的字段对比/录入数据（一对一对填入效果）
const [livePairs, setLivePairs] = useState<{ recordId: string; pairs: LivePair[] }>({ recordId: "", pairs: [] });
  // 逐人比对历史：LOOP 运行中已完成的卡片可随时展开查看对比结果（livePairs 只保留当前人）
  const [livePairsHistory, setLivePairsHistory] = useState<Record<string, LivePair[]>>({});
  const livePairsRef = useRef(livePairs);
  const loopReportsRef = useRef<VerificationReport[]>([]);
  useEffect(() => { livePairsRef.current = livePairs; }, [livePairs]);
  // 把当前人的逐对对比归档进历史（切人/重置时调用，保证已完成卡片可随时回看）
  const archiveLivePairs = useCallback(() => {
    const cur = livePairsRef.current;
    if (cur.recordId && cur.pairs.length > 0) {
      setLivePairsHistory((prev) => ({ ...prev, [cur.recordId]: cur.pairs }));
    }
  }, []);
// 本地文件提取：已上传的文件列表
const [docLocalFiles, setDocLocalFiles] = useState<File[]>([]);
// 本地文件提取：用于匹配文件名的字段（绑定的 Excel 字段）
const [docFileBindField, setDocFileBindField] = useState<string | null>(null);
// 本地文件选择 input ref
const docLocalFileInputRef = useRef<HTMLInputElement>(null);
// 本地文件提取（目录模式）：根目录绝对路径
const [docLocalRootPath, setDocLocalRootPath] = useState<string | null>(null);
// 本地文件提取（目录模式）：目录内文件列表（相对路径）
const [docLocalDirFiles, setDocLocalDirFiles] = useState<Array<{ relativePath: string; name: string; size: number; ext: string }>>([]);
// 本地文件提取（目录模式）：用户点选的样本文件相对路径
const [docLocalSamplePath, setDocLocalSamplePath] = useState<string | null>(null);
// 本地文件提取（目录模式）：推断出的路径模板（如 {student_id}/护照）
const [docLocalPattern, setDocLocalPattern] = useState<string | null>(null);
// 自定义文本模式：在步骤4中添加用户自定义文本框，关联网页元素后用于审查/录入
const [customTextMode, setCustomTextMode] = useState(false);
const customTextModeRef = useRef(false);
customTextModeRef.current = customTextMode;
const [customTextEntries, setCustomTextEntries] = useState<CustomTextEntry[]>([]);
const customTextEntriesRef = useRef<CustomTextEntry[]>([]);
customTextEntriesRef.current = customTextEntries;
const [customTextPickingId, setCustomTextPickingId] = useState<string | null>(null);
const customTextPickingIdRef = useRef<string | null>(null);
customTextPickingIdRef.current = customTextPickingId;
// 提取元素条目绑定 Excel 列：armed 状态下点击右侧 Excel 单元格即绑定该列（LOOP 逐行取值）
const [excelBindEntryId, setExcelBindEntryId] = useState<string | null>(null);
const excelBindEntryIdRef = useRef<string | null>(null);
excelBindEntryIdRef.current = excelBindEntryId;
// 提取元素面板 TAB 切换请求：配置哪个功能就自动切到对应 TAB（支持 widgetTabId 滚动到具体控件）
const [extractTabRequest, setExtractTabRequest] = useState<{ tab: "doc" | "custom" | "widget"; widgetTabId?: string; ts: number } | null>(null);
// 提取元素面板 TAB 顺序：谁先设置谁排前（FIFO），保存 LOOP 后顺序随步骤保留
const [extractTabOrder, setExtractTabOrder] = useState<Array<"doc" | "custom" | "widget">>([]);
// 统一入口：请求切换 TAB 的同时把该 TAB 追加到 FIFO 顺序末尾（已在顺序中则不动）
const requestExtractTab = useCallback((tab: "doc" | "custom" | "widget", widgetTabId?: string) => {
  setExtractTabRequest({ tab, widgetTabId, ts: Date.now() });
  setExtractTabOrder((prev) => (prev.includes(tab) ? prev : [...prev, tab]));
}, []);
// 控件绑定左网页取值时，请求提取元素面板进入左右分栏（保持控件面板可见）
const [splitWidgetRequest, setSplitWidgetRequest] = useState(0);
// 控件提取模式：点击展开型控件（选项控件/日历控件）的提取、标注与绑定
const [widgetExtractMode, setWidgetExtractMode] = useState(false);
const widgetExtractModeRef = useRef(false);
widgetExtractModeRef.current = widgetExtractMode;
// 正在拾取触发框的控件类型（null=未在拾取）
const [widgetPickKind, setWidgetPickKind] = useState<"option" | "calendar" | null>(null);
const widgetPickKindRef = useRef<"option" | "calendar" | null>(null);
widgetPickKindRef.current = widgetPickKind;
// 控件快照执行中 / 失败提示
const [widgetSnapshotBusy, setWidgetSnapshotBusy] = useState(false);
const [widgetSnapshotError, setWidgetSnapshotError] = useState<string | null>(null);
// 草稿控件（快照完成待绑定保存）+ 草稿绑定
const [widgetDraft, setWidgetDraft] = useState<WidgetDef | null>(null);
const widgetDraftRef = useRef<WidgetDef | null>(null);
widgetDraftRef.current = widgetDraft;
const [widgetDraftBinding, setWidgetDraftBinding] = useState<WidgetBinding>({ leftSource: "excel", leftField: "" });
const widgetDraftBindingRef = useRef<WidgetBinding>({ leftSource: "excel", leftField: "" });
widgetDraftBindingRef.current = widgetDraftBinding;
// 正在重选日历角色的 key（"draft:prevMonth" 或 "saved:<selector>:prevMonth"）
const [widgetRolePickingKey, setWidgetRolePickingKey] = useState<string | null>(null);
const widgetRolePickingKeyRef = useRef<string | null>(null);
widgetRolePickingKeyRef.current = widgetRolePickingKey;
// 日历引导式拾取：当前步骤索引（null=未在引导式拾取，0~N=正在拾取第 N 步）
const [calPickStepIdx, setCalPickStepIdx] = useState<number | null>(null);
const calPickStepIdxRef = useRef<number | null>(null);
calPickStepIdxRef.current = calPickStepIdx;
// 日格子多选：引导到日格子步骤时，用户可连续点选多个日格子，点「完成」结束（收集各选择器覆盖全部日格子）
const [calDayCellPicks, setCalDayCellPicks] = useState<Array<{ text: string; selector: string }>>([]);
const calDayCellPicksRef = useRef<Array<{ text: string; selector: string }>>([]);
calDayCellPicksRef.current = calDayCellPicks;
// 日历手动面板点选兜底：快照未检测到面板时，用户手动点开日历并点选面板
const [calPanelPickFailed, setCalPanelPickFailed] = useState(false);
const [calPanelPickMode, setCalPanelPickMode] = useState<"idle" | "await-open" | "picking">("idle");
const calPanelPickModeRef = useRef<"idle" | "await-open" | "picking">("idle");
calPanelPickModeRef.current = calPanelPickMode;
// Enter 键快捷保存映射：ElementSelectBar 在 canSave 时将 handleSave 挂到此 ref
const mappingSaveTriggerRef = useRef<(() => void) | null>(null);
const calFailTriggerRef = useRef<{ selector: string; label: string; kind: "option" | "calendar"; side?: "left" | "right" } | null>(null);
// 手动面板兜底当前针对的控件类型（UI 文案/图标分支用）
const [panelPickKind, setPanelPickKind] = useState<"option" | "calendar" | null>(null);
// 正在重选单个选项的 key（"draft:option:0" 或 "saved:<selector>:option:2"）
const [widgetOptionPickingKey, setWidgetOptionPickingKey] = useState<string | null>(null);
const widgetOptionPickingKeyRef = useRef<string | null>(null);
widgetOptionPickingKeyRef.current = widgetOptionPickingKey;
// 正在从左侧网页拾取来源的 key（"draft" 或 "saved:<selector>"）
const [widgetLeftPickingKey, setWidgetLeftPickingKey] = useState<string | null>(null);
const widgetLeftPickingKeyRef = useRef<string | null>(null);
widgetLeftPickingKeyRef.current = widgetLeftPickingKey;
// 正在从「提取结果」拾取护照字段的 key（"draft" 或 "saved:<selector>"）
const [widgetPassportPickingKey, setWidgetPassportPickingKey] = useState<string | null>(null);
const widgetPassportPickingKeyRef = useRef<string | null>(null);
widgetPassportPickingKeyRef.current = widgetPassportPickingKey;
// 控件试跑结果 / 执行中
const [widgetTestResults, setWidgetTestResults] = useState<Record<string, WidgetTestResult>>({});
const [widgetTestBusyKey, setWidgetTestBusyKey] = useState<string | null>(null);
// 日历镜像：每个卡片当前显示的年月（与网页真实日历实时同步）
const [widgetCalendarState, setWidgetCalendarState] = useState<Record<string, { year: number; month: number } | null>>({});
const [widgetCalendarBusyKey, setWidgetCalendarBusyKey] = useState<string | null>(null);
// 文件提取审查面板数据（原图 + 提取字段框 + 同名图片对比）
/** 单个引擎的提取结果（用于双引擎对比） */
type DocPanelResult = {
  imageUrl: string;
  filename: string;
  method: string;
  /** umi 通道实际引擎：gpu=内置加速引擎，umi=UMI-OCR（含 GPU 兜底） */
  ocr_backend?: string;
  text: string;
  fields: Record<string, string>;
  fallback?: { from: string; to: string; reason: string } | null;
};

const [docExtractPanel, setDocExtractPanel] = useState<(DocPanelResult & {
  side: "left" | "right";
  workflow: "entry" | "review";
  /** 原始文件 dataUrl，用于切换引擎重新提取 */
  sourceDataUrl: string;
  /** 目标字段列表 */
  targetFields: string[];
  /** 备用引擎结果（UMI 与 Vision 互相切换时保存另一引擎结果） */
  altResult?: DocPanelResult | null;
}) | null>(null);
// docExtractPanel 更新时同步源文件预览（仅非空时；null 不清空，保留最后一次的预览）
useEffect(() => {
  if (docExtractPanel) {
    setDocSourcePreview({
      imageUrl: docExtractPanel.imageUrl,
      filename: docExtractPanel.filename,
      method: docExtractPanel.method,
    });
  }
}, [docExtractPanel]);
// 将后端 extractDocumentFile 返回结果转为可在 <img> 中显示的预览 URL：
// - processed_image 存在时（PDF 扫描件渲染后 / 图片旋转裁剪后）用它（需要补 data:image/jpeg;base64, 前缀）
// - 否则回退到原始文件 URL（普通图片可直接显示；原始 PDF 无法用 <img> 直接渲染）
const toPreviewImageUrl = (rawUrl: string, processed?: string | null) => {
  if (processed) return `data:image/jpeg;base64,${processed}`;
  return rawUrl;
};
// 文件导出对话框开关（文件提取预览面板 →「导出」）
const [docExportOpen, setDocExportOpen] = useState(false);
// 绑定上传模式：从文件提取预览面板点「绑定上传」→ 拾取网页 file input → 确认后生成上传步骤
const [uploadBindMode, setUploadBindMode] = useState(false);
const uploadBindModeRef = useRef(false);
uploadBindModeRef.current = uploadBindMode;
// 绑定上传来源：文件提取步骤 mark id（执行时从该槽位取文件）；null=取最近一次提取的文件
const [uploadBindSourceMarkId, setUploadBindSourceMarkId] = useState<string | null>(null);
const uploadBindSourceMarkIdRef = useRef<string | null>(null);
uploadBindSourceMarkIdRef.current = uploadBindSourceMarkId;
// 绑定上传确认对话框数据（拾取到 file input 后弹出，确认格式/压缩设置）
const [uploadBindDraft, setUploadBindDraft] = useState<{
  side: "left" | "right";
  selector: string;          // file input 的 selector
  clickedSelector: string;   // 用户实际点击的元素 selector（显示用）
  label: string;
  accept: string;
  sourceMarkId: string | null;
  sourceLabel: string;
} | null>(null);
// LOOP 执行时：文件提取步骤产出文件的运行时槽位（markId → 文件），供上传步骤取文件
// dataUrl=本地文件/下载捕获的内容；url=网页 URL 直提模式（上传时由后端下载）
const docRuntimeFileSlotsRef = useRef<Record<string, { dataUrl?: string; url?: string; filename: string }>>({});

// ===== 一键直传模式 =====
const [quickUploadMode, setQuickUploadMode] = useState(false);
const quickUploadModeRef = useRef(false);
quickUploadModeRef.current = quickUploadMode;
// 待上传的文件数据（点击按钮时存入 ref，拾取到元素后使用）
const quickUploadFileRef = useRef<{ dataUrl: string; filename: string } | null>(null);
// LOOP 执行时：最近一次提取的文件（上传步骤未绑定来源时的兜底）
const lastDocRuntimeFileRef = useRef<{ dataUrl?: string; url?: string; filename: string; markId: string } | null>(null);
  // 完成教学后自动开始 LOOP 批量执行
  const [startBatchAfterTeaching, setStartBatchAfterTeaching] = useState(false);

  // === ?????? ===
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "available" | "downloading" | "downloaded" | "error">("idle");
  const [updateInfo, setUpdateInfo] = useState<{ version: string } | null>(null);
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("");

  // 已拾取的元素标记列表（按顺序编号 1, 2, 3...）
  const [pickedMarks, setPickedMarks] = useState<PickedMark[]>([]);
  // ref 始终持有最新 pickedMarks，供 recyclePickedMark 等回调读取，避免闭包陷阱
  const pickedMarksRef = useRef(pickedMarks);
  pickedMarksRef.current = pickedMarks;
  // 每侧最近一次拾取是否来自弹窗（addPickedMark 据此打 inPopup 标记）
  const pickFromPopupRef = useRef<Record<ViewSide, boolean>>({ left: false, right: false });
  // 前置点击数量（步骤3：搜索/进入）
  const preClickCount = useMemo(() => pickedMarks.filter((m) => m.action === "click" && m.clickPhase === "pre").length, [pickedMarks]);
  // 过程点击数量（步骤4：点击NEXT等中间步骤）
  const processClickCount = useMemo(() => pickedMarks.filter((m) => m.action === "click" && m.clickPhase === "mid").length, [pickedMarks]);
  // 收尾点击数量（步骤5：保存/返回）
  const postClickCount = useMemo(() => pickedMarks.filter((m) => m.action === "click" && m.clickPhase === "post").length, [pickedMarks]);
  // 文件提取步骤的断点状态（取所有 docExtract mark 的断点，有一个总是 always 就显示 always）
  const docBreakpoint = useMemo<"always" | "on-error" | undefined>(() => {
    const docMarks = pickedMarks.filter((m) => m.docExtract);
    if (docMarks.length === 0) return undefined;
    if (docMarks.some((m) => m.breakpoint === "always")) return "always";
    if (docMarks.some((m) => m.breakpoint === "on-error")) return "on-error";
    return undefined;
  }, [pickedMarks]);
  // 循环切换文件提取步骤的断点：无→强制→条件→无
  const toggleDocBreakpoint = useCallback(() => {
    setPickedMarks((prev) => {
      const docMarks = prev.filter((m) => m.docExtract);
      if (docMarks.length === 0) return prev;
      // 以第一个 docExtract mark 的当前状态为基准循环
      const cur = docMarks[0].breakpoint;
      const next = cur === undefined ? "always" : cur === "always" ? "on-error" : undefined;
      return prev.map((m) => (m.docExtract ? { ...m, breakpoint: next } : m));
    });
  }, []);
  const addPickedMark = useCallback(
    (mark: Omit<PickedMark, "id" | "order" | "createdAt">) => {
      setPickedMarks((prev) => {
        const order = prev.length + 1;
        const id = `mk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        // 弹窗内拾取的元素：打上 inPopup 标记（Excel 来源不打，执行时路由到弹窗 view）
        const mSide = mark.side === "left" ? "left" : "right";
        const inPopup = mark.inPopup ?? (mark.source !== "excel" && pickFromPopupRef.current[mSide] ? true : undefined);
        return [...prev, { ...mark, inPopup, id, order, createdAt: Date.now() }];
      });
    },
    []
  );
  const clearPickedMarks = useCallback(() => setPickedMarks([]), []);
  /** 文件处理按钮点击记录：作为外围步骤显示在字段对比 STEPS 与流程图中（执行时 no-op，仅步骤设置态记录） */
  const recordFileOp = useCallback(
    (op: "extract" | "export", detail: string) => {
      if (!selectModeRef.current) return;
      addPickedMark({
        side: "right",
        source: "web",
        selector: `fileop://${op}`,
        label: `文件处理 · ${detail}`,
        workflow: "data-source",
        action: "click",
        recordId: selectedId || undefined,
        fileOp: op,
        tag: "",
        type: "",
      });
    },
    [addPickedMark, selectedId]
  );
  const removePickedMark = useCallback((id: string) => {
    setPickedMarks((prev) => {
      const filtered = prev.filter((m) => m.id !== id);
      // 重新编号
      return filtered.map((m, i) => ({ ...m, order: i + 1 }));
    });
  }, []);

  // 回收节点：再次点击已放置的节点（同 side + selector）时删除对应 mark，而非重复放置
  // 使用 ref 读取最新 pickedMarks，避免 React 批量更新导致的闭包陷阱
  // 同一个 selector 可能同时有 input + click 两个 mark（右侧绑定自动追加确认人物），需全部移除
  const recyclePickedMark = useCallback((side: ViewSide, selector: string) => {
    const current = pickedMarksRef.current;
    const matching = current.filter((m) => m.side === side && m.selector === selector);
    if (matching.length === 0) return false;
    // 移除所有匹配的 mark
    matching.forEach((m) => removePickedMark(m.id));
    // 如果回收的是当前 S 输入目标，同步清除目标状态
    if (inputTargetRef.current && inputTargetRef.current.selector === selector && inputTargetRef.current.side === side) {
      setInputTarget(null);
      inputTargetRef.current = null;
    }
    // 回收「绑定输入框」流程中的输入节点：保持在灵活绑定模式（both），左右侧都可继续点
    // 仅在当前正处于绑定流程中时才回退，避免普通教学模式下误入绑定流程
    const hadBindInput = matching.some((m) => m.action === "input" && m.variableField);
    if (hadBindInput && bindInputSideRef.current) {
      setBindInputSide("both");
      setPickTarget(null);
      setTimeout(() => {
        if (bindInputSideRef.current) {
          window.electronAPI?.viewStartPicking("left");
          window.electronAPI?.viewStartPicking("right");
        }
      }, 200);
    }
    // 回收「确认人物」点击节点（非自动追加的）：恢复确认人物模式，让用户重新选择
    // 如果是绑定流程中自动追加的确认人物（与 input 同时存在），不恢复确认人物模式
    const hadStandaloneConfirm = matching.some(
      (m) => m.action === "click" && m.label.startsWith("确认人物") && !hadBindInput
    );
    if (hadStandaloneConfirm) {
      setNextClickLabel("确认人物");
      setPendingAction("click");
    }
    // 回收普通点击按钮（非确认人物）：如果正在添加点击模式，保持点击模式继续添加
    const hadNormalClick = matching.some(
      (m) => m.action === "click" && !m.label.startsWith("确认人物")
    );
    if (hadNormalClick && addingClickModeRef.current) {
      const currentPhase = addingClickPhaseRef.current;
      setNextClickLabel(currentPhase === "post" ? "收尾点击" : currentPhase === "mid" ? "过程点击" : "前置点击");
      setPendingAction("click");
      setPickTarget(side);
      setTimeout(() => {
        window.electronAPI?.viewStartPicking(side);
      }, 200);
    }
    return true;
  }, [removePickedMark]);

  // ============ 教学模式 & 批量执行 ============
  // 应用模式：审查流（搜索并对比）/ 录入流（填入学校网站新增表单）
  const [appMode, setAppMode] = useState<AppMode>("loop");
  // 教学阶段：idle 未开始 / data-source 教数据源处理 / review 教审查流操作 / entry 教录入流操作 / done 教学完成
  const [teachingPhase, setTeachingPhase] = useState<TeachingPhase>("idle");
  // 已保存的流程模板（教学完成后生成）
  const [workflowTemplate, setWorkflowTemplate] = useState<WorkflowTemplate | null>(null);
  // ref 始终持有最新的 workflowTemplate，避免 setState 异步导致的读取旧值
  const workflowTemplateRef = useRef<WorkflowTemplate | null>(null);
  workflowTemplateRef.current = workflowTemplate;
  // 持久化模板 ref：保存最近一次成功构建/执行的模板，
  // 不会因切换记录、状态重置等原因被清空，供"查看"按钮做最终兜底
  const lastTemplateRef = useRef<WorkflowTemplate | null>(null);
  // 批量执行状态
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchCursor, setBatchCursor] = useState(-1); // 当前执行的卡片索引（-1 = 未开始）
  const [batchMarkCursor, setBatchMarkCursor] = useState<{ recordIndex: number; markOrder: number } | null>(null); // 当前执行的 mark
  const [batchResults, setBatchResults] = useState<Record<string, BatchResult>>({});
  const [batchTargets, setBatchTargets] = useState<ApplicantRecord[]>([]); // 本次LOOP的执行顺序（从选中卡片开始）
  /** 执行阶段：idle=未执行，marks=执行点击/输入步骤，verify=逐字段审查，done=完成 */
  const [execPhase, setExecPhase] = useState<"idle" | "marks" | "verify" | "done">("idle");
  /** 当前审查的字段索引（在mappings中的位置），-1=未在审查 */
  const [verifyFieldIdx, setVerifyFieldIdx] = useState(-1);
  /** 每个审查字段的结果，key=mappings索引 */
  const [reviewFieldResults, setReviewFieldResults] = useState<Record<number, FieldMatch>>({});
  /** 当前正在 LOOP 执行的记录 id（驱动 Excel 平滑滚动定位） */
  const [execRecordId, setExecRecordId] = useState<string | null>(null);
  const batchStopRef = useRef(false);
  const runBatchRef = useRef<((tplOverride?: WorkflowTemplate, targetIds?: string[]) => Promise<void>) | null>(null);
  // 防重入：LOOP 批量执行期间为 true，任何重复触发（双击/effect 重放/IPC 重复投递）直接忽略
  const runBatchInFlightRef = useRef(false);

  // ===== LOOP 审查期 Excel 联动：平滑滚动到当前行 + 聚焦比对单元格 =====
  // 当前比对的映射（verify 阶段有效）
  const activeVerifyMapping = execPhase === "verify" && verifyFieldIdx >= 0 ? mappings[verifyFieldIdx] : undefined;
  // Excel 侧当前比对列（仅左侧值来自 Excel 时才联动）
  const excelActiveField = activeVerifyMapping && activeVerifyMapping.left_source === "excel" && activeVerifyMapping.left_field
    ? activeVerifyMapping.left_field
    : null;
  // 当前比对单元格状态：结果未出=pending，已出=match/mismatch/missing
  const excelActiveFieldStatus: "pending" | "match" | "mismatch" | "missing" | null = (() => {
    if (!excelActiveField) return null;
    const r = reviewFieldResults[verifyFieldIdx];
    if (r === "match" || r === "mismatch" || r === "missing") return r;
    if (r === "error" || r === "partial") return "mismatch";
    return "pending";
  })();
  // 当前记录已完成比对的列→结果（保持已比对单元格着色）
  const excelFieldResults = useMemo(() => {
    const out: Record<string, "match" | "mismatch" | "missing"> = {};
    if (execPhase !== "verify" && execPhase !== "done") return out;
    mappings.forEach((m, i) => {
      if (m.left_source !== "excel" || !m.left_field) return;
      const r = reviewFieldResults[i];
      if (r === "match" || r === "mismatch" || r === "missing") out[m.left_field] = r;
      else if (r === "error" || r === "partial") out[m.left_field] = "mismatch";
    });
    return out;
  }, [mappings, reviewFieldResults, execPhase]);

  // ============ 断点暂停机制 ============
  /** 断点弹窗的 UI 状态（null=未暂停） */
  const [breakpointState, setBreakpointState] = useState<import("./components/BreakpointDialog").BreakpointInfo | null>(null);
  /** Promise resolver：执行引擎在此等待，用户点继续后 resolve */
  const breakpointResolveRef = useRef<(() => void) | null>(null);
  /** 记录当前 LOOP 的总记录数（断点弹窗显示用） */
  const breakpointTotalRef = useRef(0);
  /**
   * 触发断点暂停：执行引擎调用后返回 Promise，直到用户点继续才 resolve。
   * 用于在 executeTemplateForRecord 的步骤循环中插入人工检查点。
   */
  const waitForBreakpointRef = useRef<(info: Omit<import("./components/BreakpointDialog").BreakpointInfo, "triggeredAt" | "recordTotal">) => Promise<void>>(
    async () => { throw new Error("waitForBreakpoint not initialized"); }
  );
  waitForBreakpointRef.current = (info) => {
    return new Promise<void>((resolve) => {
      breakpointResolveRef.current = resolve;
      setBreakpointState({
        ...info,
        recordTotal: breakpointTotalRef.current,
        triggeredAt: Date.now(),
      });
    });
  };
  /** 用户点击"继续执行" */
  const continueFromBreakpoint = useCallback(() => {
    breakpointResolveRef.current?.();
    breakpointResolveRef.current = null;
    setBreakpointState(null);
  }, []);
  const [logSignal, setLogSignal] = useState(0); // 递增触发ResultsPanel切换到日志tab
  /** 已勾选的卡片记录 ID 集合（用于批量跑 LOOP） */
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  /** 适配LOOP到勾选卡片：打开 SkillPanel 时标记，选中后只跑勾选的卡片 */
  const adaptLoopToCheckedRef = useRef(false);

  // ============ 任务队列：多段批量执行 ============
  const [taskQueue, setTaskQueue] = useState<QueuedTask[]>([]);
  const [queueRunning, setQueueRunning] = useState(false); // 队列是否正在执行
  const [queueCursor, setQueueCursor] = useState(-1); // 当前执行的任务索引（-1 = 未开始）
  const queueStopRef = useRef(false); // 用户是否点击了停止队列
  const runQueueRef = useRef<(() => Promise<void>) | null>(null);
  const [queueSignal, setQueueSignal] = useState(0); // 递增触发ResultsPanel切换到任务队列tab

  // ============ SKILL 技能模板系统 ============
  const [showSkillPanel, setShowSkillPanel] = useState(false);
  /** 流程图编辑器：正在编辑的模板 */
  const [editingFlowTemplate, setEditingFlowTemplate] = useState<WorkflowTemplate | null>(null);
  const [showSaveSkill, setShowSaveSkill] = useState(false);
  const [showApplyLoop, setShowApplyLoop] = useState(false);
  const [saveSkillRunAfter, setSaveSkillRunAfter] = useState(false); // 保存后是否立即执行
  const [skillVersion, setSkillVersion] = useState(0); // 递增触发刷新

  // ============ 外挂插件：屏幕边缘悬浮条（AI 体外循环） ============
  const [dockOpen, setDockOpen] = useState(false);
  useEffect(() => {
    window.electronAPI?.dockIsOpen?.().then(setDockOpen).catch(() => {});
    return window.electronAPI?.onDockState?.((d) => setDockOpen(!!d.open));
  }, []);
  const toggleDock = useCallback(async () => {
    try {
      const r = await window.electronAPI?.dockToggle?.();
      if (r) setDockOpen(!!r.open);
    } catch {
      /* 非 Electron 环境忽略 */
    }
  }, []);

  // ============ 功能1：网页文档提取（PDF/图片 → OCR/文档解析 → 左右对比） ============
  const [docPickMode, setDocPickMode] = useState(false); // 文档拾取模式：点击右侧网页的 PDF 链接/图片
  const docPickModeRef = useRef(docPickMode);
  docPickModeRef.current = docPickMode;
  // 按人物卡片(recordId)组织的多文件提取状态：每张卡片可有多份文件，TAB切换
  const [docExtractsByRecord, setDocExtractsByRecord] = useState<Record<string, DocExtractState[]>>({});
  const [activeDocIndex, setActiveDocIndex] = useState(0); // 当前选中查看的文件索引
  const docExtractsByRecordRef = useRef(docExtractsByRecord);
  docExtractsByRecordRef.current = docExtractsByRecord;
  const [docExtracting, setDocExtracting] = useState(false);
  const [docSignal, setDocSignal] = useState(0); // 递增触发 ResultsPanel 切换到文档对比tab
  // 当前卡片的提取文件列表 + 激活文件（selected 在下方定义，需延迟计算）
  const docExtractRef = useRef<DocExtractState | null>(null);

  // ============ 功能2：本地文件提取 → 人工审核 → 填入右侧网页 ============
  const [docFillData, setDocFillData] = useState<{
    filename: string;
    method: string;
    text: string;
    fields: Record<string, string>;
    fallback?: { from: string; to: string; reason: string } | null;
  } | null>(null);
  const [docFilling, setDocFilling] = useState(false);

  // ============ 功能3：单卡 LOOP 执行（点击人物卡片 → 自动导航到该人页面） ============
  const [singleRunning, setSingleRunning] = useState(false);

  // 审查流操作时自动收窄底部面板，退出后恢复用户之前的高度；教学模式下自动打开面板
  const savedBottomHeightRef = useRef<number>(20);
  const savedLeftPanelOpenRef = useRef<boolean>(true);
  useEffect(() => {
    if (selectMode) {
      // 进入选择模式：自动打开底部面板，保存当前高度并收窄
      setBottomPanelOpen(true);
      savedBottomHeightRef.current = bottomPanelHeight;
      setBottomPanelHeight(34);
      // 自动收起左侧任务卡片面板，腾出浏览器操作空间
      if (!leftDetached) {
        savedLeftPanelOpenRef.current = leftPanelOpen;
        setLeftPanelOpen(false);
      }
    } else {
      // 退出选择模式：恢复到用户之前的高度和侧边栏状态
      setBottomPanelHeight(savedBottomHeightRef.current);
      if (!leftDetached && savedLeftPanelOpenRef.current) {
        setLeftPanelOpen(true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectMode]);

  // === ???????? ===
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.getAppVersion().then(v => setAppVersion(v)).catch(() => {});
    const offAvailable = window.electronAPI.onUpdateAvailable((info) => {
      setUpdateInfo({ version: info.version });
      setUpdateStatus("available");
      setUpdateError(null);
    });
    const offNotAvailable = window.electronAPI.onUpdateNotAvailable(() => {
      setUpdateStatus("idle");
    });
    const offProgress = window.electronAPI.onUpdateDownloadProgress((progress) => {
      setUpdateStatus("downloading");
      setUpdateProgress(Math.round(progress.percent || 0));
    });
    const offDownloaded = window.electronAPI.onUpdateDownloaded((info) => {
      setUpdateInfo({ version: info.version });
      setUpdateStatus("downloaded");
      setUpdateProgress(100);
    });
    const offError = window.electronAPI.onUpdateError((err) => {
      setUpdateError(err.message);
      setUpdateStatus("error");
    });
    return () => {
      offAvailable?.();
      offNotAvailable?.();
      offProgress?.();
      offDownloaded?.();
      offError?.();
    };
  }, []);

  // pendingAction=click：执行真实点击（element.click()）
  const performRealClick = useCallback(async (side: ViewSide, selector: string, inPopup?: boolean) => {
    if (!window.electronAPI) return;
    try {
      const script = `
        ${DEEP_QUERY_HELPER}
        (function() {
          // 清掉拾取器的吞点击标记：performRealClick 的 el.click() 是程序化真实点击，
          // 若上一帧拾取刚完成（__cinsideJustPicked=true），此 click 会被拾取器误吞导致失效。
          try { window.__cinsideJustPicked = false; } catch(e) {}
          var el = null;
          try { el = __cinsideDeepQuery(${JSON.stringify(sanitizeSelector(selector))}); } catch(e) { el = null; }
          if (!el) return { ok: false, reason: 'not_found' };
          try { el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch(e) {}
          var orig = el.style.outline;
          var origOffset = el.style.outlineOffset;
          var origShadow = el.style.boxShadow;
          var origTrans = el.style.transition;
          el.style.transition = 'outline 0.15s ease-out, box-shadow 0.15s ease-out';
          el.style.outline = '3px solid #10b981';
          el.style.outlineOffset = '2px';
          el.style.boxShadow = '0 0 0 6px rgba(16,185,129,0.2)';
          setTimeout(function() {
            el.style.outline = orig || '';
            el.style.outlineOffset = origOffset || '';
            el.style.boxShadow = origShadow || '';
            el.style.transition = origTrans || '';
          }, 800);
          el.click();
          return { ok: true, tag: el.tagName };
        })();
      `;
      const result = inPopup
        ? await window.electronAPI.popupExecuteJS(side, script)
        : await window.electronAPI.viewExecuteJS(side, script);
      // 等待一小段时间让点击生效和页面开始响应
      await new Promise((r) => setTimeout(r, 300));
      return result;
    } catch (e) {
      console.warn("[performRealClick] 失败", e);
    }
  }, []);

  // pendingAction=input：把 value 填入目标输入框 selector
  // 返回 { ok, reason, foundValue } 便于调用方判断是否成功
  const performInputValue = useCallback(async (targetSide: ViewSide, targetSelector: string, value: string, inPopup?: boolean): Promise<{ ok: boolean; reason?: string; [key: string]: unknown }> => {
    if (!window.electronAPI) return { ok: false, reason: "no-electron" };
    try {
      const script = `
        ${DEEP_QUERY_HELPER}
        (function() {
          var el = null;
          try { el = __cinsideDeepQuery(${JSON.stringify(sanitizeSelector(targetSelector))}); } catch(e) { el = null; }
          if (!el) return { ok: false, reason: 'not_found', selector: ${JSON.stringify(sanitizeSelector(targetSelector))} };

          try { el.focus({ preventScroll: true }); } catch(e) {}
          var isContentEditable = el.contentEditable === 'true';
          var text = ${JSON.stringify(value)};

          // 先清空旧值
          if (isContentEditable) {
            el.textContent = '';
          } else {
            // 用原生 setter 清空，确保 React/Vue 等框架能感知
            var nativeSetter = el.tagName === 'TEXTAREA'
              ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
              : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            if (nativeSetter && nativeSetter.set) {
              nativeSetter.set.call(el, '');
            } else {
              el.value = '';
            }
          }
          try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch(e) {}

          // 优先尝试“粘贴”式插入：能触发网页对 paste 事件的监听
          var inserted = false;
          try {
            // 选中文本并尝试 insertText 命令（多数框架能识别）
            if (!isContentEditable) {
              try { el.select(); } catch(e) {}
            }
            inserted = document.execCommand('insertText', false, text);
          } catch(e) { inserted = false; }

          // 如果 insertText 没生效，回退到逐字模拟键盘输入
          var setOk = el.value === text || el.textContent === text;
          if (!inserted || !setOk) {
            for (var i = 0; i < text.length; i++) {
              var char = text[i];
              var keyCode = char.charCodeAt(0);
              var keyOpts = { key: char, code: '', keyCode: keyCode, charCode: keyCode, which: keyCode, bubbles: true, cancelable: true, view: window };
              try { el.dispatchEvent(new KeyboardEvent('keydown', keyOpts)); } catch(e) {}
              try { el.dispatchEvent(new KeyboardEvent('keypress', keyOpts)); } catch(e) {}
              if (isContentEditable) {
                el.textContent += char;
              } else {
                if (nativeSetter && nativeSetter.set) {
                  nativeSetter.set.call(el, el.value + char);
                } else {
                  el.value += char;
                }
              }
              try { el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: char })); } catch(e) { el.dispatchEvent(new Event('input', { bubbles: true })); }
              try { el.dispatchEvent(new KeyboardEvent('keyup', keyOpts)); } catch(e) {}
            }
          }

          // 补发 paste 事件，让对 paste 敏感的网页也能感知
          try {
            var dt = new DataTransfer();
            dt.setData('text/plain', text);
            el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
          } catch(e) {}

          try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
          try { el.dispatchEvent(new Event('blur', { bubbles: true })); } catch(e) {}

          setOk = el.value === text || el.textContent === text;

          // 视觉确认：绿色粗 outline（直接设在元素上，滚动时自动跟随）
          var orig = el.style.outline;
          var origOffset = el.style.outlineOffset;
          var origShadow = el.style.boxShadow;
          var origTrans = el.style.transition;
          el.style.transition = 'outline 0.15s ease-out, box-shadow 0.15s ease-out';
          el.style.outline = '4px solid #22c55e';
          el.style.outlineOffset = '2px';
          el.style.boxShadow = '0 0 0 6px rgba(34,197,94,0.2)';
          setTimeout(function() {
            el.style.outline = orig || '';
            el.style.outlineOffset = origOffset || '';
            el.style.boxShadow = origShadow || '';
            el.style.transition = origTrans || '';
          }, 2500);
          return { ok: true, reason: 'ok', tag: el.tagName, currentValue: el.value || el.textContent || '', setOk: setOk };
        })();
      `;
      const result = (inPopup
        ? await window.electronAPI.popupExecuteJS(targetSide, script)
        : await window.electronAPI.viewExecuteJS(targetSide, script)) as { ok: boolean; reason?: string; [key: string]: unknown } | null;
      console.log("[performInputValue] 结果:", result);
      return result || { ok: false, reason: "no-result" };
    } catch (e) {
      console.warn("[performInputValue] 失败", e);
      return { ok: false, reason: String(e) };
    }
  }, []);

  // ============ 等待指定 view 页面加载完成（LOOP 每条记录重置网页后用） ============
  // loadURL 是 fire-and-forget，这里轮询 document.readyState 直到页面可用，再稳定一小段等 SPA 渲染
  const waitViewReady = useCallback(async (side: ViewSide, timeoutMs = 12000) => {
    if (!window.electronAPI) return;
    const deadline = Date.now() + timeoutMs;
    // 先等一小段让 loadURL 真正开始导航
    await new Promise((r) => setTimeout(r, 200));
    while (Date.now() < deadline) {
      try {
        const state = await window.electronAPI.viewExecuteJS(side, "document.readyState");
        if (state === "complete" || state === "interactive") {
          // 再稳定一会儿，等 SPA 首屏渲染出输入框/按钮
          await new Promise((r) => setTimeout(r, 500));
          return;
        }
      } catch {
        // 导航中脚本上下文被销毁，继续轮询
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    console.warn(`[waitViewReady] ${side} 等待页面加载超时`);
  }, []);

  // ============ 网络容错：断网检测 / 等待恢复 / 页面稳定 ============
  /** 检查网页在线状态（JS执行失败说明页面可能在跳转，不算断网） */
  const checkViewOnline = useCallback(async (side: ViewSide): Promise<boolean> => {
    if (!window.electronAPI) return true;
    try {
      const r = await window.electronAPI.viewExecuteJS(side, "(function(){ return navigator.onLine; })()");
      return r !== false;
    } catch {
      return true;
    }
  }, []);

  /** 断网时等待恢复：每2s轮询，最多 timeoutMs；恢复返回 true，超时返回 false */
  const waitNetworkRestore = useCallback(async (side: ViewSide, timeoutMs = 30000): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await checkViewOnline(side)) return true;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }, [checkViewOnline]);

  /** 点击后等待页面稳定：readyState 到 complete，最多 maxMs（页面跳转/慢加载容错） */
  const waitPageSettled = useCallback(async (side: ViewSide, maxMs = 3000) => {
    if (!window.electronAPI) return;
    const start = Date.now();
    // 先给导航/渲染一个起步时间
    await new Promise((r) => setTimeout(r, 200));
    while (Date.now() - start < maxMs) {
      try {
        const r = await window.electronAPI.viewExecuteJS(side, "document.readyState");
        if (r === "complete") {
          // 再短等一会让 SPA/弹窗渲染
          await new Promise((res) => setTimeout(res, 400));
          return;
        }
      } catch {
        // 导航中脚本上下文被销毁，继续等
      }
      await new Promise((res) => setTimeout(res, 300));
    }
  }, []);

  /** 等待元素出现：慢渲染/弹窗延迟加载时轮询，最多 maxMs，找到返回 true */
  const waitElementAppear = useCallback(async (side: ViewSide, selector: string, maxMs = 6000, inPopup?: boolean): Promise<boolean> => {
    if (!window.electronAPI) return false;
    const start = Date.now();
    const script = `${DEEP_QUERY_HELPER}(function(){ try { return !!__cinsideDeepQuery(${JSON.stringify(sanitizeSelector(selector))}); } catch(e) { return false; } })()`;
    while (Date.now() - start < maxMs) {
      try {
        const found = inPopup
          ? await window.electronAPI.popupExecuteJS(side, script)
          : await window.electronAPI.viewExecuteJS(side, script);
        if (found) return true;
      } catch {
        // 页面导航中，继续等
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }, []);

  // 回放：按顺序依次执行所有 pickedMarks
  // 对每个节点：在对应 view 上滚动到元素 + 高亮 + 模拟点击
  const stopReplay = useCallback(() => {
    replayStopRef.current = true;
    setReplaying(false);
  }, []);

  const replayAll = useCallback(async () => {
    if (pickedMarks.length === 0 || replaying) return;
    replayStopRef.current = false;
    setReplaying(true);
    setReplayCursor(0);

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    try {
      for (const mark of pickedMarks) {
        if (replayStopRef.current) break;
        setReplayCursor(mark.order);

        // Excel 类型：仅闪烁徽章（无网页元素可操作）
        if (mark.source === "excel" && mark.action !== "input") {
          await sleep(800);
          continue;
        }

        // input 动作：把 value 填入目标输入框（inputTarget）
        if (mark.action === "input" && mark.inputTarget && mark.value !== undefined) {
          try {
            await performInputValue("right", mark.inputTarget, mark.value);
            console.log(`[replay #${mark.order}] 输入 → ${mark.inputTarget}`, mark.value);
          } catch (e) {
            console.warn(`[replay #${mark.order}] 输入失败`, e);
          }
          await sleep(1200);
          continue;
        }

        // click 动作：真正触发 element.click()
        if (mark.action === "click") {
          const side: ViewSide = mark.side === "left" ? "left" : "right";
          try {
            const script = `
              ${DEEP_QUERY_HELPER}
              (function() {
                var el = null;
                try { el = __cinsideDeepQuery(${JSON.stringify(mark.selector)}); } catch(e) { el = null; }
                if (!el) return { ok: false };
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                var orig = el.style.outline;
                var origOffset = el.style.outlineOffset;
                var origShadow = el.style.boxShadow;
                var origTrans = el.style.transition;
                el.style.transition = 'outline 0.15s ease-out, box-shadow 0.15s ease-out';
                el.style.outline = '3px solid #10b981';
                el.style.outlineOffset = '2px';
                el.style.boxShadow = '0 0 0 6px rgba(16,185,129,0.2)';
                setTimeout(function() {
                  el.style.outline = orig || '';
                  el.style.outlineOffset = origOffset || '';
                  el.style.boxShadow = origShadow || '';
                  el.style.transition = origTrans || '';
                  el.click();
                }, 400);
                return { ok: true };
              })();
            `;
            await window.electronAPI?.viewExecuteJS(side, script);
            console.log(`[replay #${mark.order}] 点击 → ${mark.selector}`);
          } catch (e) {
            console.warn(`[replay #${mark.order}] 点击失败`, e);
          }
          // 等待页面响应/跳转
          await sleep(1800);
          continue;
        }

        // pick 动作（默认）：滚动到元素 + 高亮
        const side: ViewSide = mark.side === "left" ? "left" : "right";
        const sel = mark.selector;
        if (sel && window.electronAPI) {
          try {
            // 滚动到元素并高亮
            const script = `
              ${DEEP_QUERY_HELPER}
              (function() {
                var el = null;
                try { el = __cinsideDeepQuery(${JSON.stringify(sel)}); } catch(e) { el = null; }
                if (!el) return { ok: false, reason: 'not_found' };
                el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
                // 短暂闪烁（橙色outline直接设在元素上，滚动时自动跟随）
                var orig = el.style.outline;
                var origOffset = el.style.outlineOffset;
                var origShadow = el.style.boxShadow;
                var origTrans = el.style.transition;
                el.style.transition = 'outline 0.15s ease-out, box-shadow 0.15s ease-out';
                el.style.outline = '3px solid #f59e0b';
                el.style.outlineOffset = '2px';
                el.style.boxShadow = '0 0 0 6px rgba(245,158,11,0.2)';
                setTimeout(function() {
                  el.style.outline = orig || '';
                  el.style.outlineOffset = origOffset || '';
                  el.style.boxShadow = origShadow || '';
                  el.style.transition = origTrans || '';
                }, 1200);
                return { ok: true, tag: el.tagName, type: el.getAttribute('type') || '' };
              })();
            `;
            const result = await window.electronAPI.viewExecuteJS(side, script);
            console.log(`[replay #${mark.order}]`, mark.label, result);
          } catch (e) {
            console.warn(`[replay #${mark.order}] 执行失败`, e);
          }
        }

        // 头像类型：重新截图并保存
        if (mark.source === "avatar" && mark.rect && mark.recordId && window.electronAPI) {
          try {
            const result = await window.electronAPI.viewCaptureElement("left", mark.rect);
            if (result?.ok && result.dataUrl) {
              const base64 = result.dataUrl.split(",", 2)[1] || result.dataUrl;
              await api.updateAvatar(mark.recordId, base64);
              setRecords((prev) =>
                prev.map((r) =>
                  r.record_id === mark.recordId ? { ...r, avatar: base64 } : r
                )
              );
            }
          } catch (e) {
            console.warn(`[replay #${mark.order}] 头像重截失败`, e);
          }
        }

        await sleep(1200);
      }
    } finally {
      setReplaying(false);
      setReplayCursor(0);
    }
  }, [pickedMarks, replaying, performInputValue]);

  // 核验状态
  const [running, setRunning] = useState(false);

  // 运行开始时隐藏侧边按钮，气泡全部消失后再显示
  const isAnyRunning = running || singleRunning || batchRunning || queueRunning;
  // 供异步回调（OCR完成等）同步判断当前是否在执行期，避免闭包拿到旧值
  const isAnyRunningRef = useRef(isAnyRunning);
  isAnyRunningRef.current = isAnyRunning;
  useEffect(() => {
    if (isAnyRunning) setEdgeButtonVisible(false);
  }, [isAnyRunning]);
  // 运行结束后兜底显示按钮：延迟 2.5s（等气泡消散动画跑完），不依赖 onAllGone 回调是否触发
  useEffect(() => {
    if (!isAnyRunning && hasRunOnce) {
      const t = setTimeout(() => setEdgeButtonVisible(true), 2500);
      return () => clearTimeout(t);
    }
  }, [isAnyRunning, hasRunOnce]);

  // LOOP/批量执行期间关闭文件提取审查浮层：提取结果已存入 docExtractsByRecord
  // （文件处理面板可见），浮层弹出会遮挡右侧 BrowserPane 并阻断网页点击
  useEffect(() => {
    if (!isAnyRunning) return;
    setDocExtractPanel(null);
    setSameNameImages(null);
  }, [isAnyRunning]);

  // LOOP 运行不息屏：设置开启时，执行期间阻止电脑息屏/休眠，结束后自动恢复
  useEffect(() => {
    if (!window.electronAPI?.setPowerSave) return;
    window.electronAPI.setPowerSave(isAnyRunning && settings.loop_keep_awake === true).catch(() => {});
  }, [isAnyRunning, settings.loop_keep_awake]);

  const [steps, setSteps] = useState<VerificationStep[]>([]);
  const [shots, setShots] = useState<ScreenshotEvent[]>([]);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [report, setReport] = useState<VerificationReport | null>(null);
  // LOOP 批量执行时按人物拆分的报告（每人一个），用于验证报告 Tab 的卡片化展示
  const [loopReports, setLoopReports] = useState<VerificationReport[]>([]);
  useEffect(() => { loopReportsRef.current = loopReports; }, [loopReports]);
  const [error, setError] = useState<string | null>(null);
  // 成功提示：绿色 toast，2.5 秒后自动收回
  const [success, setSuccess] = useState<string | null>(null);
  const successTimerRef = useRef<number | null>(null);
  const setSuccessToast = useCallback((msg: string) => {
    if (successTimerRef.current != null) window.clearTimeout(successTimerRef.current);
    setSuccess(msg);
    successTimerRef.current = window.setTimeout(() => {
      setSuccess(null);
      successTimerRef.current = null;
    }, 2500);
  }, []);
  useEffect(() => {
    return () => {
      if (successTimerRef.current != null) window.clearTimeout(successTimerRef.current);
    };
  }, []);
  // 警告提示：琥珀色 toast，5 秒后自动收回（OCR 引擎回退等需要用户知晓的事件）
  const [warn, setWarn] = useState<string | null>(null);
  const warnTimerRef = useRef<number | null>(null);
  const setWarnToast = useCallback((msg: string) => {
    if (warnTimerRef.current != null) window.clearTimeout(warnTimerRef.current);
    setWarn(msg);
    warnTimerRef.current = window.setTimeout(() => {
      setWarn(null);
      warnTimerRef.current = null;
    }, 5000);
  }, []);
  useEffect(() => {
    return () => {
      if (warnTimerRef.current != null) window.clearTimeout(warnTimerRef.current);
    };
  }, []);
  // OCR 引擎回退提示：所选引擎识别失败自动切换到另一引擎时，弹警告让用户知晓。
  // 监听 client.ts 派发的全局事件——所有提取入口（本地/网页下载/LOOP/备用引擎）统一覆盖
  useEffect(() => {
    const handler = (e: Event) => {
      const f = (e as CustomEvent<{ from: string; to: string; reason: string }>).detail;
      if (!f) return;
      setWarnToast(
        `${extractMethodLabel(f.from)} 识别失败，已自动切换 ${extractMethodLabel(f.to)}：${f.reason || "未知错误"}`
      );
    };
    window.addEventListener("cinside:ocr-fallback", handler);
    return () => window.removeEventListener("cinside:ocr-fallback", handler);
  }, [setWarnToast]);

  // 监听模态覆盖层退出事件，触发 resize 让 BrowserPane 重新同步显示 BrowserView
  useEffect(() => {
    if (!window.electronAPI) return;
    const off = window.electronAPI.onModalOverlayExited(() => {
      setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
      setTimeout(() => window.dispatchEvent(new Event("resize")), 300);
    });
    return off;
  }, []);

  const [waitingManual, setWaitingManual] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<VerifyStatus>("idle");
  // 每条记录的核验结论：record_id -> overall（pass/fail/review）
  const [recordResults, setRecordResults] = useState<Record<string, Overall>>({});
  // ---- 执行分析：LOOP 运行中每张问题卡片完成即实时追加一段 AI 分析，整轮结束再补总结段 ----
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysisAvailable, setAnalysisAvailable] = useState(false);
  const [analysisSegments, setAnalysisSegments] = useState<AnalysisSegment[]>([]);
  /** 任一分段在生成中（球体同步为 processing 动画） */
  const analysisLoading = analysisSegments.some((s) => s.loading);
  /** 批量总结请求序号：防止旧响应覆盖新总结段 */
  const analysisSeqRef = useRef(0);
  // ---- AI 球体（左侧面板 AI 角色）：手动讲解态（点击卡片触发）优先于自动状态 ----
  const [aiManual, setAiManual] = useState<AISphereState | null>(null);
  const aiManualTimerRef = useRef<number | null>(null);
  // 自动状态：LOOP 运行中 / AI 分析中 > 有问题告警 > 待命
  const aiAuto = useMemo<AISphereState>(() => {
    if (batchRunning || singleRunning || queueRunning || analysisLoading) return "processing";
    const failedCount = Object.values(batchResults).filter((r) => r.status === "failed").length;
    const reviewCount = Object.values(recordResults).filter((o) => o === "fail" || o === "review").length;
    return failedCount > 0 || reviewCount > 0 ? "alert" : "idle";
  }, [batchRunning, singleRunning, queueRunning, analysisLoading, batchResults, recordResults]);
  const aiSphereState: AISphereState = aiManual ?? aiAuto;
  const taskIdRef = useRef("");
  const wsRef = useRef<WebSocket | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // 卡片池 state 提前声明，供 selected 查找（卡片池模式下卡片 record_id 带后缀，不在 records 里）
  const [cardPool, setCardPool] = useState<ApplicantRecord[]>([]);

  // 卡片自定义图片：record_id -> base64 dataURL，用户可通过 Ctrl+V 或拖拽设置，持久化到 localStorage
  const [cardImages, setCardImages] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem("cinside-card-images");
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  });
  const setCardImage = useCallback((recordId: string, dataUrl: string) => {
    setCardImages((prev) => {
      const next = { ...prev, [recordId]: dataUrl };
      try { localStorage.setItem("cinside-card-images", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  const clearCardImage = useCallback((recordId: string) => {
    setCardImages((prev) => {
      if (!(recordId in prev)) return prev;
      const next = { ...prev };
      delete next[recordId];
      try { localStorage.setItem("cinside-card-images", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // 当前选中卡片：优先从卡片池查找（卡片池模式），回退到原始 records（兼容旧流程）
  const selected = cardPool.find((r) => r.record_id === selectedId) || records.find((r) => r.record_id === selectedId) || null;

  // 当前卡片的提取文件列表 + 激活文件（依赖 selected，需在 selected 定义后计算）
  const currentRecordId = selected?.record_id || "_default";
  const currentDocExtracts = docExtractsByRecord[currentRecordId] || [];
  const safeDocIndex = currentDocExtracts.length > 0 ? Math.min(activeDocIndex, currentDocExtracts.length - 1) : 0;
  const currentDocExtract = currentDocExtracts[safeDocIndex] || null;
  // 切换卡片时重置到第一个文件
  useEffect(() => { setActiveDocIndex(0); }, [currentRecordId]);
  docExtractRef.current = currentDocExtract;
  // 按记录ID合并所有文件的字段（用于比对/变量解析）
  const getRecordDocFields = useCallback((recordId: string): Record<string, string> => {
    const extracts = docExtractsByRecordRef.current[recordId] || [];
    const merged: Record<string, string> = {};
    for (const ext of extracts) Object.assign(merged, ext.fields);
    return merged;
  }, []);

  // ============ 完成 S 输入：把待填入的值真正写入网页框 ============
  // 用户规定流程：S → 点网页框 → 点 Excel → 按 Enter/Esc 完成填入
  // Enter 和 Esc 在此处等价，都执行填入并回到"搭建节点"状态（保持 selectMode）
  // 关键：先关闭拾取模式 → 等待网页稳定 → 执行填值 → 确认结果 → 清除状态
  const commitInput = useCallback(async () => {
    // 用 ref 读取最新状态
    const currentPendingAction = pendingActionRef.current;
    const currentPendingInputValue = pendingInputValueRef.current;
    const currentInputTarget = inputTargetRef.current;
    const currentPendingInputField = pendingInputFieldRef.current;

    console.log("[commitInput] 触发", { currentPendingAction, currentPendingInputValue, currentInputTarget });

    if (currentPendingAction !== "input") return;
    // 没有待填入的值或目标：直接退出 input 模式
    if (currentPendingInputValue == null || !currentInputTarget) {
      setPendingAction("none");
      setInputTarget(null);
      setPendingInputValue(null);
      setPendingInputField(null);
      setError("未选择要填入的值，已退出输入模式");
      return;
    }

    const valueToFill = currentPendingInputValue;
    const targetSelector = currentInputTarget.selector;
    const targetLabel = currentInputTarget.label;
    const excelField = currentPendingInputField;

    // 1. 先关闭右侧网页的拾取模式，避免拾取脚本干扰填值
    //    （setPendingAction 会触发 picking=false → viewStopPicking，但 IPC 是异步的）
    //    直接显式调用 viewStopPicking 确保先执行
    try {
      await window.electronAPI?.viewStopPicking("right");
    } catch (e) {
      console.warn("[commitInput] viewStopPicking 失败", e);
    }
    // 2. 短暂等待，让网页从拾取状态恢复
    await new Promise((r) => setTimeout(r, 150));

    // 3. 执行填值
    const result = await performInputValue("right", targetSelector, valueToFill);
    console.log("[commitInput] 填值结果:", result);

    // 4. 记录到操作列表
    const workflow: "data-source" | "review" | "entry" =
      teachingPhase === "data-source" ? "data-source" :
      teachingPhase === "entry" ? "entry" : "review";
    addPickedMark({
      side: "right",
      source: "excel",
      selector: targetSelector,
      label: excelField
        ? `${workflow === "entry" ? "录入" : "审查"}「${valueToFill.slice(0, 18)}${valueToFill.length > 18 ? "…" : ""}」← Excel「${excelField}」 · 变量:${excelField}`
        : `${workflow === "entry" ? "录入" : "审查"}「${valueToFill.slice(0, 18)}${valueToFill.length > 18 ? "…" : ""}」← 网页`,
      value: valueToFill,
      workflow,
      action: "input",
      inputTarget: targetSelector,
      inputTargetLabel: targetLabel,
      recordId: selected?.record_id,
      excelField: excelField || undefined,
      variableField: excelField || undefined,
    });

    // 5. 成功时高亮目标输入框并显示临时浮标（去掉顶部 Toast，只保留会消失的视觉反馈）
    if (result?.ok) {
      try {
        window.electronAPI?.viewHighlightBoxes("right", [
          {
            selector: targetSelector,
            status: "match",
            label: `已填入：${valueToFill.slice(0, 18)}${valueToFill.length > 18 ? "…" : ""}`,
          },
        ]);
        setTimeout(() => window.electronAPI?.viewClearHighlight("right"), 2500);
      } catch (e) {
        // ignore
      }
    } else {
      setError(
        `填入失败：${result?.reason || "未知原因"}${
          result?.reason === "not_found" ? `（选择器：${targetSelector.slice(0, 60)}）` : ""
        }`
      );
    }

    // 6. 填值成功后进入连续输入模式：自动回到“选源”状态，等用户点下一个 Excel/网页值
    if (result?.ok) {
      setPickTarget("left");
      setPendingAction("input");
      pendingActionRef.current = "input";
    } else {
      // 失败则退出输入模式
      setPickTarget(null);
      setPendingAction("none");
      pendingActionRef.current = "none";
    }
    setInputTarget(null);
    inputTargetRef.current = null;
    setPendingInputValue(null);
    pendingInputValueRef.current = null;
    setPendingInputField(null);
    pendingInputFieldRef.current = null;
  }, [
    performInputValue, addPickedMark, teachingPhase, selected, setError,
  ]);

  const refreshRecords = async () => {
    setLoadingRecords(true);
    try {
      const r = await api.listRecords();
      setRecords(r.records);
      // 记录刷新后重置框选范围（让用户重新框选新段），但不清空已有卡片池
      setRowRange(null);
      // 如果当前没有选中记录，或选中的记录在新列表中不存在，自动选择第一条
      // 确保 LOOP 第一行始终可用（绑定输入框时填入 previewValue）
      if (!selectedId || !r.records.find((x) => x.record_id === selectedId)) {
        setSelectedId(r.records[0]?.record_id || null);
      }
    } catch (e) {
      console.warn("list records failed", e);
    } finally {
      setLoadingRecords(false);
    }
  };

  const clearRecords = async () => {
    // 清空人物卡片及卡片绑定状态（保留 Excel 原始数据，可重新框选生成卡片）
    rlog("[clearRecords] 清空人物卡片");
    setSelectedId(null);
    setRowRange(null);
    setCardPool([]);
    setCardLoopMap({});
    setCheckedIds(new Set());
    setRunCursor(null);
    setCardsGenerated(false);
    // 卡片自定义图片持久化在 localStorage，一并清理
    setCardImages({});
    try { localStorage.removeItem("cinside-card-images"); } catch {}
    // 与卡片绑定的文件提取结果随卡片删除一并清理
    setDocExtractsByRecord({});
    setDocExtractPanel(null);
    setSameNameImages(null);
  };

  // 左侧人物卡片池：支持从不同 Excel / 不同段持续追加，卡片数量越来越多
  // cardPool state 已在上方提前声明（供 selected 查找）

  // 卡片-LOOP 关联映射：record_id -> { loopId, loopName, setAt }
  // 当用户在群组面板选择"自定义"或"适配已有循环"后，群组内所有卡片关联该 LOOP
  // 有 LOOP 的卡片自动聚拢到列表前部（按设置时间升序），无 LOOP 的卡片排后
  const [cardLoopMap, setCardLoopMap] = useState<Record<string, { loopId: string; loopName: string; setAt: number }>>({});
  // 执行游标：控制"运行"按钮只跑前 N 张已设置 LOOP 的卡片；null 表示跑全部
  const [runCursor, setRunCursor] = useState<number | null>(null);

  /** 字段列手动映射：标准字段名 -> Excel 原始列 key（当 AI/别名识别失败时由用户手动指定） */
  const [fieldColumnMap, setFieldColumnMap] = useState<Record<string, string>>({});
  const handleFieldColumnMapChange = useCallback((field: string, columnKey: string | null) => {
    setFieldColumnMap((prev) => {
      const next = { ...prev };
      if (columnKey === null) {
        delete next[field];
      } else {
        next[field] = columnKey;
      }
      return next;
    });
  }, []);
  /** 按标准字段取记录显示值：优先标准字段，其次 fieldColumnMap 手动/自动映射的列（解决俄文/中文列名识别不到姓名的问题） */
  const getRecordFieldValue = useCallback((rec: ApplicantRecord | undefined, field: "name" | "passport_no" | "student_id"): string => {
    if (!rec) return "";
    const direct = rec.fields[field];
    if (direct && direct.trim()) return direct.trim();
    const mapped = fieldColumnMap[field];
    if (mapped) {
      const v = rec.fields[mapped];
      if (v && v.trim()) return v.trim();
    }
    return "";
  }, [fieldColumnMap]);
  /** 取卡片显示名：name → fullname → 映射的姓名列 → passport_no → student_id → record_id */
  const getRecordDisplayName = useCallback((rec: ApplicantRecord | undefined): string => {
    if (!rec) return "";
    return getRecordFieldValue(rec, "name")
      || (rec.fields.fullname || "").trim()
      || getRecordFieldValue(rec, "passport_no")
      || getRecordFieldValue(rec, "student_id")
      || rec.record_id;
  }, [getRecordFieldValue]);
  /** 后端自动识别的列映射（原始列名 -> 标准字段名），用于过滤Excel表头中的别名列和自动初始化fieldColumnMap */
  const [detectedColumnMap, setDetectedColumnMap] = useState<Record<string, string>>({});

  // 已绑定到提取元素条目/输入步骤的 Excel 列集合（用于 Excel 视图表头高亮，明确绑定状态）
  const boundExcelFields = useMemo(() => {
    const s = new Set<string>();
    for (const e of customTextEntries) {
      if (e.excelField) s.add(e.excelField);
    }
    for (const m of pickedMarks) {
      const f = m.excelField || m.variableField;
      if (f) s.add(f);
    }
    // 审查/录入映射里来源为 Excel 的列（如文件提取字段 ↔ Excel 列对比）：同样属于已绑定列
    for (const mp of mappings) {
      if (mp.left_source === "excel" && mp.left_field) s.add(mp.left_field);
    }
    return s;
  }, [customTextEntries, pickedMarks, mappings]);

  // cardRecords：已保存批次放顶部（按保存时间setAt升序，第一批最上，第二批紧随其后），未保存卡片放底部
  const cardRecords = useMemo(() => {
    // 收集所有批次，按保存时间排序
    const loopOrderMap: Record<string, number> = {};
    const batchSetAt: Record<string, number> = {};
    for (const r of cardPool) {
      const info = cardLoopMap[r.record_id];
      if (info && !(info.loopId in batchSetAt)) {
        batchSetAt[info.loopId] = info.setAt;
      }
    }
    const sortedLoopIds = Object.keys(batchSetAt).sort((a, b) => batchSetAt[a] - batchSetAt[b]);
    sortedLoopIds.forEach((id, idx) => { loopOrderMap[id] = idx; });

    // 按顺序收集每个批次的卡片（保持cardPool内的相对顺序）
    const result: ApplicantRecord[] = [];
    const placedLoopIds = new Set<string>();
    for (const loopId of sortedLoopIds) {
      if (placedLoopIds.has(loopId)) continue;
      placedLoopIds.add(loopId);
      for (const rr of cardPool) {
        if (cardLoopMap[rr.record_id]?.loopId === loopId) {
          result.push(rr);
        }
      }
    }
    // 最后追加未保存的卡片
    for (const r of cardPool) {
      if (!cardLoopMap[r.record_id]) {
        result.push(r);
      }
    }
    return result;
  }, [cardPool, cardLoopMap]);

  // 已设置 LOOP 的卡片数（用于游标范围上限）
  const loopCardCount = useMemo(
    () => cardPool.filter((r) => cardLoopMap[r.record_id]).length,
    [cardPool, cardLoopMap]
  );

  // 一键生成人物卡片：ExcelView 内部已完成行范围切片 + 深拷贝 + 唯一 record_id，
  // 这里只负责追加到卡片池（App 不再持有 rowRange 来切片，避免框选触发 App 重渲染）
  const generateCards = useCallback((newCards: ApplicantRecord[]) => {
    if (newCards.length === 0) return;
    setCardPool((prev) => [...prev, ...newCards]);
    setCardsGenerated(true);
    setSelectedId(newCards[0].record_id);
    setSuccessToast(`已追加 ${newCards.length} 张人物卡片（共 ${cardPool.length + newCards.length} 张）`);
  }, [cardPool.length, setSuccessToast]);

  // 重新框选：清除已生成卡片池，回到框选状态
  const resetCards = useCallback(() => {
    setCardsGenerated(false);
    setRowRange(null);
    setCardPool([]);
    setCardLoopMap({});
    setRunCursor(null);
    // 清理已删除卡片绑定的文件提取结果，避免内存泄漏
    setDocExtractsByRecord({});
    setDocExtractPanel(null);
    setSameNameImages(null);
  }, []);

  // 右侧 Excel：按框选行范围生成人物卡片（与左侧共用卡片池）
  const generateRightCards = useCallback((newCards: ApplicantRecord[]) => {
    if (newCards.length === 0) return;
    setCardPool((prev) => [...prev, ...newCards]);
    setRightCardsGenerated(true);
    setSelectedId(newCards[0].record_id);
    setSuccessToast(`已追加 ${newCards.length} 张人物卡片（共 ${cardPool.length + newCards.length} 张）`);
  }, [cardPool.length, setSuccessToast]);

  // 右侧 Excel：清空卡片，重新框选
  const resetRightCards = useCallback(() => {
    setRightCardsGenerated(false);
    setRightRowRange(null);
    setCardPool([]);
    setCardLoopMap({});
    setRunCursor(null);
    setDocExtractsByRecord({});
    setDocExtractPanel(null);
    setSameNameImages(null);
  }, []);

  // ============ 任务队列操作 ============
  // 把当前完整配置（卡片+步骤+网页URL）拍快照加入队列
  const addToQueue = useCallback(() => {
    if (cardRecords.length === 0) {
      setError("请先在 Excel 视图框选 LOOP 行范围并点击「一键生成卡片」");
      return;
    }
    if (!workflowTemplate) {
      setError("请先完成教学流程配置步骤（LOOP流程）");
      return;
    }
    // 深拷贝卡片数据，避免后续操作影响快照
    const snapshotRecords = cardRecords.map((r) => ({ ...r, fields: { ...r.fields } }));
    const snapshotTemplate: WorkflowTemplate = {
      ...workflowTemplate,
      dataSourceMarks: [...workflowTemplate.dataSourceMarks],
      reviewMarks: [...workflowTemplate.reviewMarks],
      entryMarks: [...workflowTemplate.entryMarks],
    };
    const newTask: QueuedTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: `任务 ${taskQueue.length + 1}（${snapshotRecords.length} 张卡片）`,
      createdAt: Date.now(),
      mode: appMode,
      cardRecords: snapshotRecords,
      workflowTemplate: snapshotTemplate,
      leftUrl,
      rightUrl,
      status: "pending",
    };
    setTaskQueue((prev) => [...prev, newTask]);
    setQueueSignal((s) => s + 1); // 自动切换到队列tab让用户看到
    rlog(`[queue] 添加任务: ${newTask.name}, 卡片数=${snapshotRecords.length}, rightUrl=${rightUrl}`);
  }, [cardRecords, workflowTemplate, appMode, leftUrl, rightUrl, taskQueue.length]);

  // 删除队列项
  const removeFromQueue = useCallback((id: string) => {
    setTaskQueue((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // 重命名队列项
  const renameQueueTask = useCallback((id: string, name: string) => {
    setTaskQueue((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t)));
  }, []);

  // 清空队列
  const clearQueue = useCallback(() => {
    if (queueRunning) {
      queueStopRef.current = true;
    }
    setTaskQueue([]);
    setQueueCursor(-1);
  }, [queueRunning]);

  // 停止队列执行
  const stopQueue = useCallback(() => {
    queueStopRef.current = true;
    batchStopRef.current = true; // 同时停止当前任务内部的批量执行
    breakpointResolveRef.current?.();
    breakpointResolveRef.current = null;
    setBreakpointState(null);
  }, []);

  // 从BrowserPane Excel模式上传文件
  const browserExcelInputRef = useRef<HTMLInputElement>(null);
  const [browserExcelUploading, setBrowserExcelUploading] = useState(false);
  const handleBrowserExcelUpload = async (file: File) => {
    setBrowserExcelUploading(true);
    try {
      const r = await api.uploadExcel(file);
      // Electron 下 File.path 可用：登记本地路径，导出时原地写回原文件
      const fp = (file as File & { path?: string }).path;
      if (fp) api.setExcelSource("left", fp, file.name).catch(() => {});
      if (r.count === 0) {
        alert("Excel 文件为空或没有有效数据行，请检查文件内容。");
      } else {
        // 保存后端自动识别的列映射，并反转初始化fieldColumnMap（标准字段 -> 原始列名）
        setDetectedColumnMap(r.detected_column_map || {});
        const autoMap: Record<string, string> = {};
        Object.entries(r.detected_column_map || {}).forEach(([origCol, stdField]) => {
          autoMap[stdField] = origCol;
        });
        setFieldColumnMap((prev) => ({ ...autoMap, ...prev })); // 手动映射优先覆盖自动映射

        await refreshRecords();
        setRowRange(null);
        setCardsGenerated(false);
        setLeftViewMode("excel");
        console.log(`[BrowserExcel] 已导入 ${r.count} 条记录，自动识别字段:`, r.detected_column_map);
      }
    } catch (e: any) {
      console.warn("Excel upload failed", e);
      alert(`Excel 解析失败：${e?.message || e}`);
    } finally {
      setBrowserExcelUploading(false);
    }
  };

  const handleRightExcelUpload = async (file: File) => {
    setRightExcelUploading(true);
    try {
      const r = await api.uploadExcelRight(file);
      const fp = (file as File & { path?: string }).path;
      if (fp) api.setExcelSource("right", fp, file.name).catch(() => {});
      if (r.records.length === 0) {
        alert("Excel 文件为空或没有有效数据行，请检查文件内容。");
      } else {
        setRightRecords(r.records);
        setRightViewMode("excel");
        console.log(`[RightExcel] 已导入 ${r.count} 条参考记录`);
      }
    } catch (e: any) {
      console.warn("Right Excel upload failed", e);
      alert(`Excel 解析失败：${e?.message || e}`);
    } finally {
      setRightExcelUploading(false);
    }
  };

  const handleCloseLeftExcel = async () => {
    await api.clearRecords();
    setRecords([]);
    setSelectedId(null);
    setRowRange(null);
    setCardsGenerated(false);
    setLeftViewMode("web");
  };

  const handleCloseRightExcel = async () => {
    await api.clearRightRecords();
    setRightRecords([]);
    setRightViewMode("web");
  };

  // 加载后端配置（含已保存的设置）；后端启动有延迟，需在就绪后重新拉取
  const loadConfig = useCallback(async () => {
    try {
      const c = await api.getConfig();
      setConfig(c);
      const loaded = c.settings || DEFAULT_SETTINGS;
      setSettings(loaded);
      // 同步 UI 缩放到已保存值（localStorage 可能与后端不一致，以后端为准）
      if (typeof loaded.ui_scale === "number" && loaded.ui_scale !== uiScaleRef.current) {
        const s = Math.max(0.6, Math.min(1.6, loaded.ui_scale));
        setUiScale(s);
        uiScaleRef.current = s;
        try { localStorage.setItem("cinside-ui-scale", s.toString()); } catch {}
      }
    } catch {
      /* 后端未就绪，等待 onBackendReady / 健康检查轮询后重试 */
    }
  }, []);

  useEffect(() => {
    loadConfig();
    refreshRecords();

    if (window.electronAPI) {
      window.electronAPI.backendStatus().then((ready) => {
        if (ready) {
          setBackendReady(true);
          loadConfig();
          refreshRecords();
        }
      });
      window.electronAPI.onBackendReady(() => {
        setBackendReady(true);
        loadConfig();
        refreshRecords();
      });
    }

    // 兜底：轮询健康检查，防止 IPC 事件丢失或后端为上一实例残留
    let configLoaded = false;
    const poll = setInterval(async () => {
      try {
        const res = await fetch("http://localhost:8000/api/health", { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          setBackendReady(true);
          if (!configLoaded) {
            configLoaded = true;
            loadConfig();
          }
          clearInterval(poll);
        }
      } catch {
        /* 继续轮询 */
      }
    }, 2000);
    return () => clearInterval(poll);
  }, [loadConfig]);

  // 防误关设置变化时同步给主进程
  useEffect(() => {
    window.electronAPI?.setPreventClose(!!settings.prevent_accidental_close);
  }, [settings.prevent_accidental_close]);

  // 主题外观：明暗 + 主色调 → 应用到根元素 data 属性
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("no-transitions");
    root.setAttribute("data-theme", settings.theme === "dark" ? "dark" : "light");
    root.setAttribute("data-accent", settings.accent || "indigo");
    void root.offsetWidth;
    const raf = requestAnimationFrame(() => root.classList.remove("no-transitions"));
    return () => cancelAnimationFrame(raf);
  }, [settings.theme, settings.accent]);

  // ============ 整体UI缩放：Ctrl+滚轮调控 ============
  useEffect(() => {
    // 跟踪Ctrl键状态
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Ctrl" || e.ctrlKey) {
        ctrlPressedRef.current = true;
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Ctrl" || !e.ctrlKey) {
        ctrlPressedRef.current = false;
      }
    };
    // 窗口失焦时重置Ctrl状态
    const handleBlur = () => {
      ctrlPressedRef.current = false;
    };
    // 滚轮事件：Ctrl按下时调整整体UI缩放（passive，不阻塞 BrowserView 滚轮）
    const handleWheel = (e: WheelEvent) => {
      if (!ctrlPressedRef.current) return;
      // 流程图编辑器打开时，让其内部自己处理缩放，不触发整体UI缩放
      if ((window as any).__cinsideFlowEditorOpen) return;
      
      const current = uiScaleRef.current;
      // 向上滚动放大，向下滚动缩小，步长0.05
      const delta = e.deltaY < 0 ? 0.05 : -0.05;
      const next = Math.max(0.6, Math.min(1.6, Math.round((current + delta) * 20) / 20));
      
      if (next !== current) {
        setUiScale(next);
        uiScaleRef.current = next;
        try {
          localStorage.setItem("cinside-ui-scale", next.toString());
        } catch {}
        // zoom改变后触发resize，让BrowserView等组件重新计算bounds
        window.dispatchEvent(new Event("resize"));
      }
    };
    // 监听detached窗口的zoom变化
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "cinside-ui-scale" && e.newValue) {
        const val = parseFloat(e.newValue);
        if (!isNaN(val)) {
          const clamped = Math.max(0.6, Math.min(1.6, val));
          if (clamped !== uiScaleRef.current) {
            uiScaleRef.current = clamped;
            setUiScale(clamped);
            window.dispatchEvent(new Event("resize"));
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("wheel", handleWheel, { passive: true });
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  // 使用 webFrame.setZoomFactor 缩放整个渲染进程
  // webFrame.setZoomFactor 后需要延迟触发 resize，确保 zoom 已生效再让 BrowserPane 重新计算坐标
  useEffect(() => {
    window.cinsideZoom?.setFactor(uiScale);
    const t1 = setTimeout(() => window.dispatchEvent(new Event("resize")), 16);
    const t2 = setTimeout(() => window.dispatchEvent(new Event("resize")), 100);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [uiScale]);

  // 切换记录时重置 URL 和状态
  useEffect(() => {
    // 保留验证结果（result/report/steps/shots）：切换卡片后验证面板内容不丢失，便于回看与对比；
    // 开始新的核验时这些状态会被覆盖。
    setError(null);
    setVerifyStatus("idle");
    setMappings([]);
    wsRef.current?.close();
    wsRef.current = null;
    // 已完成教学（存在持久化模板）时，不清除 pickedMarks 和 running 状态，
    // 否则会导致"查看"按钮找不到步骤而报错
    if (!lastTemplateRef.current) {
      setRunning(false);
      setPickedMarks([]);
    }
    // 切换卡片时不重置左右 BrowserView 的 URL，保留用户已打开的页面
    // 仅在右侧为空且当前卡片有 university_url 时设置
    setRightUrl((prev) => prev || selected?.university_url || "");
    // 清除高亮
    window.electronAPI?.viewClearHighlight("right");
    taskIdRef.current = "";
  }, [selected?.record_id]);

  // pickedMarks 变化时，在网页视图上画带顺序编号的高亮框
  useEffect(() => {
    if (!window.electronAPI) return;
    const leftBoxes = pickedMarks
      .filter((m) => m.side === "left" && m.source !== "excel")
      .map((m) => ({
        selector: m.selector,
        status: (m.source === "avatar" ? "missing" : "pending") as
          | "missing" | "pending" | "match" | "mismatch" | "partial" | "unknown",
        label: `${m.order} · ${m.label}`,
      }));
    const rightBoxes = pickedMarks
      .filter((m) => m.side === "right")
      .map((m) => ({
        selector: m.selector,
        status: "match" as const,
        label: `${m.order} · ${m.label}`,
      }));
    // 先清除再画，避免残留
    window.electronAPI.viewClearHighlight("left").catch(() => {});
    window.electronAPI.viewClearHighlight("right").catch(() => {});
    if (leftBoxes.length > 0) {
      window.electronAPI.viewHighlightBoxes("left", leftBoxes).catch(() => {});
    }
    if (rightBoxes.length > 0) {
      window.electronAPI.viewHighlightBoxes("right", rightBoxes).catch(() => {});
    }
    // 脱离的浏览器面板也同步高亮
    if (browserLeftDetached) {
      window.electronAPI.detachedViewClearHighlight("browser-left").catch(() => {});
      if (leftBoxes.length > 0) {
        window.electronAPI.detachedViewHighlightBoxes("browser-left", leftBoxes).catch(() => {});
      }
    }
    if (browserRightDetached) {
      window.electronAPI.detachedViewClearHighlight("browser-right").catch(() => {});
      if (rightBoxes.length > 0) {
        window.electronAPI.detachedViewHighlightBoxes("browser-right", rightBoxes).catch(() => {});
      }
    }
    // 弹窗（window.open）也同步高亮
    if (popupSide === "left") {
      window.electronAPI.popupClearHighlight("left").catch(() => {});
      if (leftBoxes.length > 0) {
        window.electronAPI.popupHighlightBoxes("left", leftBoxes).catch(() => {});
      }
    }
    if (popupSide === "right") {
      window.electronAPI.popupClearHighlight("right").catch(() => {});
      if (rightBoxes.length > 0) {
        window.electronAPI.popupHighlightBoxes("right", rightBoxes).catch(() => {});
      }
    }
  }, [pickedMarks, browserLeftDetached, browserRightDetached, popupSide]);

  // ============ 下载捕获事件监听（教学模式：文件提取网页下载） ============
  useEffect(() => {
    if (!window.electronAPI) return;
    const removeStarted = window.electronAPI.onDownloadStarted((data) => {
      if (!addingDocExtractModeRef.current) return;
      rlog(`[download-started] side=${data.side}, filename=${data.filename}`);
      setDocWebStatus({ phase: "downloading", filename: data.filename, received: 0, total: 0, percent: 0 });
      setSameNameImages(null);
    });

    const removeProgress = window.electronAPI.onDownloadProgress((data) => {
      if (!addingDocExtractModeRef.current) return;
      setDocWebStatus((prev) => {
        // 仅在已进入 downloading 态时更新进度（避免乱序）
        if (prev.phase !== "downloading") return prev;
        if (prev.filename !== data.filename) return prev;
        return {
          phase: "downloading",
          filename: data.filename,
          received: data.received,
          total: data.total,
          percent: data.percent,
        };
      });
    });

    const removeCaptured = window.electronAPI.onDownloadCaptured((data) => {
      const inDocExtract = addingDocExtractModeRef.current;
      const inNavClick = addingClickModeRef.current && (addingClickPhaseRef.current === "pre" || addingClickPhaseRef.current === "mid");
      // 仅在文件提取教学模式 或 前置/过程点击模式 中处理
      if (!inDocExtract && !inNavClick) return;
      rlog(`[download-captured] side=${data.side}, filename=${data.filename}, size=${data.size}, inDocExtract=${inDocExtract}, inNavClick=${inNavClick}`);

      // 将最后一个导航点击（前置/过程点击 或 文件提取开头/过程点击，且尚未升级为docExtract）标记升级为下载触发步骤
      // 注意排除 panelAction 标记（如「录入提取」面板按钮步骤），避免多文件序列中被错误升级
      setPickedMarks((prev) => {
        const marks = [...prev];
        for (let i = marks.length - 1; i >= 0; i--) {
          const m = marks[i];
          const isNavClick = (m.docExtractClick && m.docExtractClickPhase !== "post") || m.clickPhase === "pre" || m.clickPhase === "mid";
          if (isNavClick && !m.docExtract && !m.panelAction) {
            marks[i] = {
              ...m,
              docExtract: true,
              docSource: "web-download",
              label: `文件下载提取 · ${data.filename}`,
            };
            break;
          }
        }
        return marks;
      });

      // 若来自前置/过程点击模式：自动进入文件提取网页模式并打开「文件处理+提取元素」分屏预览
      if (!inDocExtract) {
        setAddingDocExtractMode(true);
        setDocExtractSource("web");
        setDocExtractSplitView(true);
        setBottomPanelOpen(true);
        // 重置文件提取面板状态（从点击模式自动进入时初始化）
        setDocExtractPanel(null);
        setSameNameImages(null);
        bgOcrResultRef.current = null;
        setSuccessToast(`检测到下载「${data.filename}」，已自动开启文件预览`);
      }

      // 先做轻量预览（不跑 OCR），预览就绪后用户点击「录入提取」再触发 OCR
      const file = dataUrlToFile(data.dataUrl, data.filename);
      api.previewDocumentFile(file)
        .then((previewResult) => {
          // 暂存原始文件数据，等待用户点击「录入提取」
          pendingWebFileRef.current = {
            dataUrl: data.dataUrl,
            filename: data.filename,
            size: data.size,
            side: data.side as "left" | "right",
          };
          // 显示源文件预览
          setDocSourcePreview({
            imageUrl: `data:image/jpeg;base64,${previewResult.processed_image}`,
            filename: previewResult.filename,
            method: previewResult.method,
          });
          // 清空之前的提取结果（如有）
          setDocExtractPanel(null);
          setSameNameImages(null);
          // 状态：预览就绪
          setDocWebStatus({ phase: "preview", filename: data.filename, size: data.size });
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          setDocWebStatus({ phase: "error", message: `预览失败：${msg}`, filename: data.filename });
          setError(`文件预览失败: ${msg}`);
        });

      // 重新激活下载捕获（允许用户继续添加更多提取序列）
      window.electronAPI?.setDownloadCapture(data.side as "left" | "right", true).catch(() => {});
    });

    const removeFailed = window.electronAPI.onDownloadFailed((data) => {
      if (!addingDocExtractModeRef.current) return;
      rlog(`[download-failed] side=${data.side}, filename=${data.filename}`);
      const msg = data.error || data.state || "未知错误";
      setDocWebStatus({ phase: "error", message: `下载失败：${msg}`, filename: data.filename });
      setError(`下载捕获失败: ${msg}`);
      // 重新激活下载捕获
      window.electronAPI?.setDownloadCapture(data.side as "left" | "right", true).catch(() => {});
    });

    return () => {
      removeStarted?.();
      removeProgress?.();
      removeCaptured?.();
      removeFailed?.();
    };
  }, [mappings, selected, setSuccessToast, setError]);

  // 日志自动滚到底
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [steps]);

  // ============ 元素选择模式 ============
  const enterSelectMode = (targetPhase?: TeachingPhase) => {
    setSelectMode(true);
    setRightPicked(null);
    setLeftPicked(null);
    // 根据 appMode 决定初始光晕方向：
    // - review（审查）：先右后左 → 初始 right
    // - entry（录入）：先左后右 → 初始 left
    // - loop（全流程）：无固定方向，等待用户操作（绑定输入框/添加步骤）→ null
    const isBeginner = settings.beginner_mode !== false;
    const initialTarget: PickTarget =
      appMode === "review" ? "right" : appMode === "entry" ? "left" : null;
    setPickTarget(isBeginner ? initialTarget : null);
    // 已选中 LOOP 列时，进入步骤设置自动切到左侧网页视图，方便拾取网页元素
    if (selectedExcelColumnRef.current && leftViewMode === "excel") {
      setLeftViewMode("web");
      setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
    }
    // 新手模式：进入元素选择模式即自动进入对应教学阶段
    // 非新手模式：不启动步骤仪表引导，直接使用字段对比面板
    if (isBeginner && (teachingPhase === "idle" || teachingPhase === "done")) {
      const phase: TeachingPhase =
        targetPhase || (appMode === "entry" ? "entry" : "data-source");
      setTeachingPhase(phase);
      setWorkflowTemplate(null);
      setBatchResults({});
      setError(null);
    }
    // 根据初始 pickTarget 启动对应侧的拾取脚本（新手模式）
    // 非新手模式：不自动启动拾取，等待用户点击具体按钮后再启动
    setTimeout(() => {
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      if (isBeginner && initialTarget === "left") {
        window.electronAPI?.viewStartPicking("left");
      } else if (isBeginner && initialTarget === "right") {
        window.electronAPI?.viewStartPicking("right");
      }
    }, 300);
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setPickTarget(null);
    setRightPicked(null);
    setLeftPicked(null);
    // 退出元素选择模式即退出教学（未保存时）
    if (teachingPhase !== "idle" && teachingPhase !== "done") {
      setTeachingPhase("idle");
      setWorkflowTemplate(null);
      setPendingAction("none");
      setInputTarget(null);
      setPendingInputValue(null);
      setPendingInputField(null);
    }
    // 如果用户通过 S 键/空格键添加了 pickedMarks 但没有通过"保存映射"按钮
    // 生成 mappings，则自动从 pickedMarks 中提取 mappings，使"开始核验"可点击。
    setMappings((prevMappings) => {
      if (prevMappings.length > 0) return prevMappings;

      // 1) S 输入模式：action==="input" 且有 inputTarget 和 excelField/variableField
      const fromInput: FieldMapping[] = pickedMarks
        .filter(
          (m) =>
            m.action === "input" &&
            m.inputTarget &&
            (m.excelField || m.variableField)
        )
        .map((m) => ({
          right_selector: m.inputTarget!,
          right_label: m.inputTargetLabel || m.label,
          left_source: "excel" as const,
          left_field: (m.excelField || m.variableField)!,
          verify_method: "smart" as const,
        }));

      // 2) 普通元素选择模式：网页 pick + 数据源 pick 成对提取为映射
      // 支持两种布局：标准（右网页目标+左侧来源）、右侧Excel模式（左网页目标+右Excel来源）
      const fromPicks: FieldMapping[] = [];
      let pendingWebTarget: PickedMark | null = null;  // 网页目标元素（所在侧=web_side）
      let pendingExcelSrc: PickedMark | null = null;   // Excel 数据源单元格（左/右 Excel）
      for (const m of pickedMarks) {
        if (m.action === "input" || m.action === "click") {
          // 遇到其他动作，清空未配对的暂存
          pendingWebTarget = null;
          pendingExcelSrc = null;
          continue;
        }
        if (m.action !== "pick") continue;
        const isExcel = m.source === "excel" || m.tag === "excel-cell";
        if (isExcel) {
          if (pendingWebTarget) {
            // 网页目标已定 → 配对（web_side=目标元素所在侧）
            fromPicks.push({
              right_selector: pendingWebTarget.selector,
              right_label: pendingWebTarget.label || pendingWebTarget.selector,
              left_source: "excel",
              left_field: m.excelField || m.selector,
              verify_method: "smart" as const,
              web_side: pendingWebTarget.side,
            });
            pendingWebTarget = null;
          } else {
            pendingExcelSrc = m;
          }
          continue;
        }
        if (m.side === "right") {
          // 右网页元素 = 比对目标
          if (pendingExcelSrc) {
            fromPicks.push({
              right_selector: m.selector,
              right_label: m.label || m.selector,
              left_source: "excel",
              left_field: pendingExcelSrc.excelField || pendingExcelSrc.selector,
              verify_method: "smart" as const,
              web_side: "right",
            });
            pendingExcelSrc = null;
          } else {
            pendingWebTarget = m;
          }
        } else {
          // 左网页元素：右侧Excel源在等待 → 左网页是比对目标（web_side=left）
          if (pendingExcelSrc && pendingExcelSrc.side === "right") {
            fromPicks.push({
              right_selector: m.selector,
              right_label: m.label || m.selector,
              left_source: "excel",
              left_field: pendingExcelSrc.excelField || pendingExcelSrc.selector,
              verify_method: "smart" as const,
              web_side: "left",
            });
            pendingExcelSrc = null;
          } else if (pendingWebTarget && pendingWebTarget.side === "right") {
            // 原有语义：右网页目标 + 左网页源（database）
            fromPicks.push({
              right_selector: pendingWebTarget.selector,
              right_label: pendingWebTarget.label || pendingWebTarget.selector,
              left_source: "database",
              left_field: m.selector,
              verify_method: "smart" as const,
              web_side: "right",
            });
            pendingWebTarget = null;
          } else if (!pendingWebTarget) {
            // 左网页先选：暂存为目标候选（等待右Excel源）
            pendingWebTarget = m;
          }
        }
      }

      const extracted = [...fromInput, ...fromPicks];
      // 去重：同一个 right_selector 只保留一条
      const seen = new Set<string>();
      const deduped = extracted.filter((m) => {
        if (seen.has(m.right_selector)) return false;
        seen.add(m.right_selector);
        return true;
      });
      return deduped;
    });
    // 退出选择模式后面板高度会变化，触发 resize 让 BrowserPane 的
    // ResizeObserver 重新同步 BrowserView 位置，防止原生视图覆盖 header 按钮
    setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
  };

  // ============ 头像提取模式 ============
  const enterAvatarMode = () => {
    if (!selected) return;
    // 头像提取依赖网页拾取，强制切到网页视图
    setLeftViewMode("web");
    setAvatarMode(true);
    setAvatarPicked(null);
  };

  const exitAvatarMode = () => {
    setAvatarMode(false);
    setAvatarPicked(null);
  };

  // ============ 教学模式控制函数（在 exitAvatarMode/exitSelectMode/setError 之后定义） ============

  // 开始教学：根据 appMode 进入不同阶段
  // - review 模式：先 data-source（教数据源补全），再 review（教审查点击对比）
  // - entry 模式：直接 entry（教填表+提交），不需要数据源阶段
  const startTeaching = useCallback(() => {
    if (!selected) {
      setError("请先选中一张申请人卡片作为教学样本");
      return;
    }
    setPickedMarks([]);
    setTeachingPhase(appMode === "entry" ? "entry" : "data-source");
    setWorkflowTemplate(null);
    setBatchResults({});
    setError(null);
    // 重新教学时自动进入元素选择模式
    setSelectMode(true);
    setPickTarget("right");
    setRightPicked(null);
    setLeftPicked(null);
  }, [selected, setError, appMode]);

  // 数据源处理教完，进入审查流操作阶段
  const advanceToReviewPhase = useCallback(() => {
    setTeachingPhase("review");
    // 退出当前可能的拾取模式
    setPendingAction("none");
    setInputTarget(null);
    setBindInputSide(null);
    setNextClickLabel(null);
  }, []);

  /** 统一退出所有设置模式（绑定输入框/添加点击/审查录入/文件提取/控件提取/自定义文本） */
  const exitAllSetupModes = useCallback(() => {
    rlog("[exitAllSetupModes] 退出所有设置模式");
    setBindInputSide(null);
    setAddingClickMode(false);
    setAddingClickPhase(null);
    setAddingStepMode(null);
    setAddingDocExtractMode(false);
    setDocExtractSource(null);
    setCustomTextMode(false);
    setCustomTextPickingId(null);
    setWidgetExtractMode(false);
    setWidgetPickKind(null);
    setWidgetRolePickingKey(null);
    setWidgetLeftPickingKey(null);
    setWidgetPassportPickingKey(null);
    setWidgetDraft(null);
    setWidgetSnapshotError(null);
    setCalPanelPickMode("idle");
    setCalPanelPickFailed(false);
    setPanelPickKind(null);
    setCalDayCellPicks([]);
    setCalPickStepIdx(null);
    setPendingAction("none");
    setInputTarget(null);
    setNextClickLabel(null);
    setPickTarget(null);
    setRightPicked(null);
    setLeftPicked(null);
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    // 关闭下载捕获（前置/过程点击模式开启的），避免残留
    window.electronAPI?.setDownloadCapture("left", false).catch(() => {});
    window.electronAPI?.setDownloadCapture("right", false).catch(() => {});
  }, []);

  /** 刷新工作区：清空网页高光/光标、步骤设置、字段对比，但不刷新 Excel 记录 */
  const refreshWorkspace = useCallback(() => {
    rlog("[refreshWorkspace] 清空光标/步骤/字段对比");
    // 退出所有设置模式（停止拾取、关闭下载捕获等）
    exitAllSetupModes();
    // 清空网页高光
    window.electronAPI?.viewHighlightBoxes("left", []).catch(() => {});
    window.electronAPI?.viewHighlightBoxes("right", []).catch(() => {});
    // 清空步骤标记与映射
    setPickedMarks([]);
    setMappings([]);
    setRightPicked(null);
    setLeftPicked(null);
    // 清空提取相关状态（注意：文件提取结果 docExtractsByRecord / docExtractPanel / sameNameImages
    // 与人物卡片绑定，不在刷新时清空，仅在删除卡片或手动移除文件时清理）
    setCustomTextEntries([]);
    sourceFieldValueRef.current = "";
    sourceFieldLabelRef.current = "";
    // 清空验证结果与步骤
    setSteps([]);
    setShots([]);
    setResult(null);
    setReport(null);
    setLoopReports([]);
    setError(null);
    setSuccessToast("已清空光标、步骤设置和字段对比");
  }, [exitAllSetupModes, setSuccessToast]);

  // 教学模式向导：开始灵活绑定（左右侧皆可）
  // 进入「灵活绑定」模式后：点任意侧输入框 = 绑定选中的 Excel 列并真实填入第一行值；
  // 点其他元素 = 真实点击并记录为点击步骤；左右侧均可、次数不限，直到用户点「完成」。
  // 支持 toggle：若已在绑定模式，点击按钮则退出所有设置模式
  const startBindBothInputs = useCallback(() => {
    // Toggle：如果已在绑定输入框模式，则退出所有模式
    if (bindInputSideRef.current) {
      rlog("[startBindBothInputs] 已在绑定模式，退出所有设置模式");
      exitAllSetupModes();
      return;
    }
    // 先退出所有其他模式（互斥）
    exitAllSetupModes();
    const col = selectedExcelColumnRef.current;
    rlog("[startBindBothInputs] 开始灵活绑定, selectedExcelColumn=", col);
    // 切到网页视图，否则左侧网页被 Excel 视图遮挡，用户无法点击输入框
    setLeftViewMode("web");
    setBindInputSide("both");
    setPickTarget(null); // 不限定侧，左右网页都可点击
    setPendingAction("none");
    setInputTarget(null);
    setPendingInputValue(null);
    setPendingInputField(null);
    setNextClickLabel(null);
    // 触发 resize 让 BrowserPane 的 IntersectionObserver 重新检测可见性并调用 viewShow
    setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
    // 切换视图后 BrowserView 需要重新显示，延迟注入左右两侧拾取脚本
    setTimeout(() => {
      if (bindInputSideRef.current === "both") {
        rlog("[startBindBothInputs] 注入左右两侧拾取脚本");
        window.electronAPI?.viewStartPicking("left");
        window.electronAPI?.viewStartPicking("right");
        // 开启右键菜单模式：绑定输入时右键点输入框可选择其他 Excel 列
        window.electronAPI?.viewSetBindInputMode("left", true).catch(() => {});
        window.electronAPI?.viewSetBindInputMode("right", true).catch(() => {});
      }
    }, 500);
  }, [exitAllSetupModes]);

  // 退出灵活绑定模式
  const exitBindInputs = useCallback(() => {
    rlog("[exitBindInputs] 退出灵活绑定模式");
    setBindInputSide(null);
    setPickTarget(null);
    // 关闭右键菜单模式
    window.electronAPI?.viewSetBindInputMode("left", false).catch(() => {});
    window.electronAPI?.viewSetBindInputMode("right", false).catch(() => {});
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
  }, []);

  // 教学模式向导：开始"确认人物"点击步骤
  const startConfirmPerson = useCallback(() => {
    rlog("[startConfirmPerson] 激活搜索/确认人物点击模式");
    setNextClickLabel("搜索");
    setPendingAction("click");
    setBindInputSide(null);
    setPickTarget(null);
    setTimeout(() => {
      if (pendingActionRef.current === "click") {
        window.electronAPI?.viewStartPicking("left");
        window.electronAPI?.viewStartPicking("right");
      }
    }, 300);
  }, []);

  // 教学模式向导：添加审查步骤到 LOOP 循环体
  // 审查映射流程（先右后左）：右侧选核对元素 → 左侧选来源（网页/Excel）→ 保存映射
  const startAddingReviewSteps = useCallback(() => {
    // Toggle：已在审查模式则退出
    if (addingStepModeRef.current === "review") {
      rlog("[startAddingReviewSteps] 已在审查模式，退出所有设置模式");
      exitAllSetupModes();
      return;
    }
    // 先退出其他模式（前置/过程/收尾点击、录入步骤等），保证互斥
    exitAllSetupModes();
    rlog("[startAddingReviewSteps] 进入审查步骤添加模式（先右后左）");
    setCurrentLoopStepType("review");
    setTeachingPhase("review");
    setAddingStepMode("review");
    setBindInputSide(null);
    setPendingAction("none");
    setInputTarget(null);
    setNextClickLabel(null);
    // 右侧Excel模式：比对目标在左网页，从左侧开始拾取
    const targetSide = rightExcelModeRef.current ? "left" : "right";
    setPickTarget(targetSide);
    setRightPicked(null);
    setLeftPicked(null);
    setError(null);
    if (!selectMode) setSelectMode(true);
    setTimeout(() => {
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      if (targetSide === "left" && leftViewModeRef.current === "web") {
        window.electronAPI?.viewStartPicking("left");
      } else if (targetSide === "right" && rightViewModeRef.current === "web") {
        window.electronAPI?.viewStartPicking("right");
      }
    }, 300);
  }, [setError, selectMode, exitAllSetupModes]);

  // 教学模式向导：添加录入步骤到 LOOP 循环体
  // 录入映射流程（先左后右）：左侧选来源（网页/Excel）→ 右侧选输入框 → 保存映射
  const startAddingEntrySteps = useCallback(() => {
    // Toggle：已在录入模式则退出
    if (addingStepModeRef.current === "entry") {
      rlog("[startAddingEntrySteps] 已在录入模式，退出所有设置模式");
      exitAllSetupModes();
      return;
    }
    // 先退出其他模式（前置/过程/收尾点击、审查步骤等），保证互斥
    exitAllSetupModes();
    rlog("[startAddingEntrySteps] 进入录入步骤添加模式（先左后右）");
    setCurrentLoopStepType("entry");
    setTeachingPhase("entry");
    setAddingStepMode("entry");
    setBindInputSide(null);
    setPendingAction("none");
    setInputTarget(null);
    setNextClickLabel(null);
    // 右侧Excel模式：来源在右侧 Excel（单元格点击拾取），目标输入框在左网页
    const fromRightExcel = rightExcelModeRef.current;
    setPickTarget(fromRightExcel ? "right" : "left");
    setRightPicked(null);
    setLeftPicked(null);
    setError(null);
    if (!selectMode) setSelectMode(true);
    setTimeout(() => {
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      if (!fromRightExcel && leftViewModeRef.current === "web") {
        window.electronAPI?.viewStartPicking("left");
      }
    }, 300);
  }, [setError, selectMode, exitAllSetupModes]);

  // 切换当前步骤类型（审查/录入），用于混合模式复杂任务
  const switchLoopStepType = useCallback((type: "review" | "entry") => {
    if (currentLoopStepTypeRef.current === type) return;
    rlog(`[switchLoopStepType] 切换步骤类型: ${currentLoopStepTypeRef.current} → ${type}`);
    setCurrentLoopStepType(type);
    // 如果当前正在添加步骤模式，重置拾取状态并切换拾取侧
    if (addingStepModeRef.current) {
      setAddingStepMode(type);
      setTeachingPhase(type);
      setRightPicked(null);
      setLeftPicked(null);
      setBindInputSide(null);
      setPendingAction("none");
      setError(null);
      const targetSide = type === "entry" ? "left" : "right";
      setPickTarget(targetSide as PickTarget);
      setTimeout(() => {
        if (type === "entry") {
          window.electronAPI?.viewStopPicking("right").catch(() => {});
          window.electronAPI?.viewStartPicking("left");
        } else {
          window.electronAPI?.viewStopPicking("left").catch(() => {});
          window.electronAPI?.viewStartPicking("right");
        }
      }, 200);
    }
  }, []);

  // 退出添加步骤模式
  const exitAddingStepMode = useCallback(() => {
    setAddingStepMode(null);
    setPendingAction("none");
    setInputTarget(null);
    setNextClickLabel(null);
    setAddingClickMode(false);
    setCanSaveMapping(false);
    mappingSaveTriggerRef.current = null;
    // 提取元素面板：清空 FIFO TAB 顺序（新一轮步骤设置重新排队）
    setExtractTabOrder([]);
    // 同时退出文件提取模式（审查子步骤），停止右侧拾取
    if (addingDocExtractModeRef.current) {
      setAddingDocExtractMode(false);
      window.electronAPI?.viewStopPicking("right").catch(() => {});
    }
    // 同时退出自定义文本模式
    if (customTextModeRef.current) {
      setCustomTextMode(false);
      setCustomTextEntries([]);
      setCustomTextPickingId(null);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
    }
    // 同时退出控件提取模式（保留已保存的控件映射，丢弃草稿与拾取状态）
    if (widgetExtractModeRef.current) {
      setWidgetExtractMode(false);
      setWidgetPickKind(null);
      setWidgetRolePickingKey(null);
      setWidgetLeftPickingKey(null);
      setWidgetPassportPickingKey(null);
      setWidgetDraft(null);
      setWidgetSnapshotError(null);
      // 若从文件处理分屏中添加控件，保存步骤后退出分屏，恢复三栏默认布局
      setDocExtractSplitView(false);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
    }
    setPickTarget(null);
    setRightPicked(null);
    setLeftPicked(null);
  }, []);

  // 统一的人物卡片选择 handler：选中卡片 + 退出设置模式 + 切换到结果视图，
  // 确保点击卡片时文件处理面板显示该卡片绑定的提取文件和字段
  const handleSelectCard = useCallback((id: string) => {
    setSelectedId(id);
    setBottomPanelOpen(true);
    exitAddingStepMode();
    setDocExtractSplitView(false);
    setDocExtractPanel(null);
    setDocSourcePreview(null);
    setDocSignal((s) => s + 1);

    // AI 球体：点击已跑过 LOOP 的卡片 → 触发讲解动画（粒子向外涌动数秒）
    const rep = [...loopReports].reverse().find((r) => r.record_id === id);
    const batch = batchResults[id];
    if (rep || batch) {
      if (aiManualTimerRef.current) window.clearTimeout(aiManualTimerRef.current);
      setAiManual("speaking");
      aiManualTimerRef.current = window.setTimeout(() => setAiManual(null), 5000);
    }
  }, [exitAddingStepMode, loopReports, batchResults]);

  // === 自定义文本模式 ===
  const toggleCustomText = useCallback(() => {
    if (customTextModeRef.current) {
      rlog("[toggleCustomText] 已在自定义文本模式，退出所有设置模式");
      exitAllSetupModes();
      return;
    }
    exitAllSetupModes();
    setCustomTextMode(true);
    // 提取元素面板自动切到「自定义文本」TAB
    requestExtractTab("custom");
    // 自动放置一个空白例子，用户无需先点「添加文本」
    setCustomTextEntries((prev) => {
      const hasManual = prev.some((e) => e.source !== "doc");
      if (hasManual) return prev;
      const id = `ct-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return [...prev, { id, name: "", text: "", source: "manual" as const, createdAt: Date.now() }];
    });
  }, [exitAllSetupModes]);

  const addCustomTextEntry = useCallback(() => {
    const id = `ct-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setCustomTextEntries((prev) => [...prev, { id, name: "", text: "", source: "manual", createdAt: Date.now() }]);
  }, []);

  /** 文件提取预览面板：勾选字段送到「提取元素」面板（转为自定义文本条目，沿用拾取关联/保存步骤机制） */
  const sendDocFieldsToExtractPanel = useCallback((fields: Record<string, string>) => {
    const baseTs = Date.now();
    const entries = Object.entries(fields)
      .filter(([, v]) => v)
      .map(([f, v], idx) => ({
        id: `ct-${baseTs}-${Math.random().toString(36).slice(2, 7)}-${f}`,
        name: FIELD_LABELS[f] || f,
        text: v,
        source: "doc" as const,
        docField: f,
        createdAt: baseTs + idx,
      }));
    if (entries.length === 0) return;
    setCustomTextEntries((prev) => [...prev, ...entries]);
    setCustomTextMode(true);
    // 文件处理按钮点击记录到字段对比 STEPS（外围步骤，执行时 no-op）
    recordFileOp("extract", `提取元素（送 ${entries.length} 个字段到「提取元素」面板）`);
    // 提取元素面板自动切到「文件提取」TAB
    requestExtractTab("doc");
    setDocExtractPanel(null);
    setSameNameImages(null);
    // 提取完成：重置来源字段值，后续绑定输入框时恢复使用 LOOP/Excel 字段
    sourceFieldValueRef.current = "";
    sourceFieldLabelRef.current = "";
    // 关闭内联结果视图，切换到「文件处理+提取元素」两栏分屏模式
    setDocExtractSplitView(true);
    setBottomPanelOpen(true);
    setSuccessToast(`已送 ${entries.length} 个字段到「提取元素」面板，请逐个拾取关联网页元素后保存为步骤`);
  }, [setSuccessToast, recordFileOp]);

  /** 解析文件提取条目对应的 OCR 字段 key：
   *  docField 属性 → id 尾段（FIELD_LABELS 命中）→ FIELD_LABELS 按名称反查 → name 原样 */
  const resolveDocFieldKey = useCallback((e: CustomTextEntry): string => {
    let fk = e.docField || "";
    if (!fk) {
      const tail = e.id.split("-").pop() || "";
      if (FIELD_LABELS[tail]) fk = tail;
    }
    if (!fk) {
      const hit = Object.entries(FIELD_LABELS).find(([, lbl]) => lbl === e.name);
      if (hit) fk = hit[0];
    }
    return fk || e.name;
  }, []);

  /** LOOP/执行期文件提取的目标字段：
   *  优先取「提取元素」面板中绑定 Excel 列的 doc 条目——用户配置 LOOP 时真正关联的元素，
   *  未绑定的条目不提取（提取面板只显示绑定元素，后端 LLM/VIZ 兜底字段更少也省时间）；
   *  没有绑定条目时回退 mappings.left_field；都没有才用默认证件字段全集 */
  const computeDocTargetFields = useCallback((maps: FieldMapping[], entries?: CustomTextEntry[]): string[] => {
    const DEFAULTS = ["surname", "given_name", "name", "passport_no", "birth_date", "issue_place", "nationality", "gender", "passport_issue", "issue_authority"];
    const list = entries || customTextEntriesRef.current;
    const bound = Array.from(new Set(
      list.filter((e) => e.source === "doc" && e.excelField).map((e) => resolveDocFieldKey(e)).filter(Boolean)
    ));
    if (bound.length > 0) return bound;
    const mapped = Array.from(new Set(maps.map((m) => m.left_field).filter(Boolean)));
    return mapped.length > 0 ? mapped : DEFAULTS;
  }, [resolveDocFieldKey]);

  /** 网页模式：预览就绪后用户点击「录入提取」触发 OCR 识别（若后台已预提取则直接复用）
   *  overrideRecordId：批量执行时显式传入当前记录 id（避免闭包中 selected 过期导致字段提交到错误记录）
   *  高速模式下后台 OCR 可能仍在跑：缓存命中时 await 其 promise 复用结果，不重复发起请求 */
  const triggerWebExtract = useCallback(async (overrideRecordId?: string) => {
    const pending = pendingWebFileRef.current;
    if (!pending) return;
    const rid = overrideRecordId || selected?.record_id || "_default";
    // 进入 OCR 阶段
    setDocWebStatus({ phase: "ocr", filename: pending.filename });

    // 计算目标字段列表（缓存路径和非缓存路径都需要）：优先只提取「提取元素」面板绑定 Excel 列的元素
    const targetFields = computeDocTargetFields(mappings);

    // 检查是否有后台预提取的OCR结果可以直接复用（引擎必须一致，否则视为缓存失效）
    const cached = bgOcrResultRef.current;
    if (cached && cached.dataUrl === pending.dataUrl && cached.engine === (settings.ocr_engine || "vision")) {
      // 高速模式缓存可能尚未落定：等同一个 promise（含 docExtractsByRecord 写入）完成后复用
      let result: Awaited<ReturnType<typeof api.extractDocumentFile>>;
      if (cached.result) {
        result = cached.result;
      } else if (cached.promise) {
        rlog(`[triggerWebExtract] 复用后台OCR进行中任务: ${pending.filename} (engine=${cached.engine})`);
        result = await cached.promise;
      } else {
        return;
      }
      rlog(`[triggerWebExtract] 复用后台OCR缓存结果: ${pending.filename} (engine=${cached.engine})`);
      // 内存保护：有裁剪图时 source/file_url 只存文件名（去重/类型判断用），不存原图 dataUrl
      const hasProc = !!result.processed_image;
      const newExtract: DocExtractState = {
        filename: result.filename,
        method: result.method,
        text: result.text,
        fields: result.fields,
        entries: [],
        source: hasProc ? pending.filename : pending.dataUrl,
        file_url: hasProc ? pending.filename : pending.dataUrl,
        processed_image: result.processed_image,
        mrz_warnings: result.mrz_warnings,
        fallback: result.fallback,
      };
      setDocExtractsByRecord((prev) => {
        const arr = prev[rid] || [];
        const filtered = arr.filter((e) => e.file_url !== newExtract.file_url);
        return { ...prev, [rid]: [...filtered, newExtract] };
      });
      setActiveDocIndex(999);
      // 执行期不弹浮动审查面板（结果已入 docExtractsByRecord），否则点击停止后浮层会冒出来
      if (!isAnyRunningRef.current) {
        setDocExtractPanel({
          imageUrl: toPreviewImageUrl(pending.dataUrl, result.processed_image),
          filename: result.filename,
          method: result.method,
          text: result.text,
          fields: result.fields,
          side: pending.side,
          workflow: pending.side === "left" ? "entry" : "review",
          fallback: result.fallback,
          sourceDataUrl: pending.dataUrl,
          targetFields,
          altResult: null,
        });
        setDocExtractActiveTab("primary");
      }
      setDocWebStatus({ phase: "success", filename: result.filename, size: pending.size });
      setSuccessToast(`文件提取完成：${result.filename}`);
      pendingWebFileRef.current = null;
      bgOcrResultRef.current = null;
      return;
    }

    // 没有缓存，正常执行OCR
    const file = dataUrlToFile(pending.dataUrl, pending.filename);
    const extractP = api.extractDocumentFile(file, targetFields)
      .then((result) => {
        // 内存保护：有裁剪图时 source/file_url 只存文件名（去重/类型判断用），不存原图 dataUrl
        const hasProc = !!result.processed_image;
        const newExtract: DocExtractState = {
          filename: result.filename,
          method: result.method,
          text: result.text,
          fields: result.fields,
          entries: [],
          source: hasProc ? pending.filename : pending.dataUrl,
          file_url: hasProc ? pending.filename : pending.dataUrl,
          processed_image: result.processed_image,
          mrz_warnings: result.mrz_warnings,
          fallback: result.fallback,
        };
        setDocExtractsByRecord((prev) => {
          const arr = prev[rid] || [];
          const filtered = arr.filter((e) => e.file_url !== newExtract.file_url);
          return { ...prev, [rid]: [...filtered, newExtract] };
        });
        setActiveDocIndex(999);
        // 执行期不弹浮动审查面板（结果已入 docExtractsByRecord），否则点击停止后浮层会冒出来
        if (!isAnyRunningRef.current) {
          setDocExtractPanel({
            imageUrl: toPreviewImageUrl(pending.dataUrl, result.processed_image),
            filename: result.filename,
            method: result.method,
            ocr_backend: result.ocr_backend,
            text: result.text,
            fields: result.fields,
            side: pending.side,
            workflow: pending.side === "left" ? "entry" : "review",
            fallback: result.fallback,
            sourceDataUrl: pending.dataUrl,
            targetFields,
            altResult: null,
          });
          setDocExtractActiveTab("primary");
        }
        setDocWebStatus({ phase: "success", filename: result.filename, size: pending.size });
        setSuccessToast(`文件提取完成：${result.filename}`);
        // 清空暂存
        pendingWebFileRef.current = null;
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setDocWebStatus({ phase: "error", message: msg, filename: pending.filename });
        setError(`文件提取失败: ${msg}`);
      });
    // LOOP 运行期（高速模式）：录入提取自发的 OCR 也纳入本记录 join 队列，字段对比前等它落定
    if (isAnyRunningRef.current) {
      const arr = bgOcrPromisesRef.current.get(rid) || [];
      arr.push(extractP.catch(() => {}));
      bgOcrPromisesRef.current.set(rid, arr);
    }
  }, [mappings, selected, setSuccessToast, setError, computeDocTargetFields]);

  /** 双引擎对比：当前激活的 Tab（primary=主结果，alt=备用引擎结果） */
  const [docExtractActiveTab, setDocExtractActiveTab] = useState<"primary" | "alt">("primary");
  /** 双引擎对比：备用引擎重新提取中 */
  const [docAltExtracting, setDocAltExtracting] = useState(false);

  /**
   * 用另一引擎重新提取（双引擎对比）：
   * - 若当前主结果是 UMI，点击后用 Vision 重新提取，结果存入 altResult
   * - 若当前主结果是 Vision，点击后用 UMI 重新提取，结果存入 altResult
   * 支持两种来源：dataUrl（本地上传/下载捕获）和 web URL（网页直提）
   */
  const reExtractWithAltEngine = useCallback(() => {
    const panel = docExtractPanel;
    if (!panel || !panel.sourceDataUrl || docAltExtracting) return;

    // 判断当前主结果使用的引擎，决定备用引擎
    const currentIsUmi = isUmiMethod(panel.method);
    const altEngine: "umi" | "vision" = currentIsUmi ? "vision" : "umi";

    setDocAltExtracting(true);

    const source = panel.sourceDataUrl;
    const isDataUrl = source.startsWith("data:");
    const apiCall = isDataUrl
      ? api.extractDocumentFile(dataUrlToFile(source, panel.filename), panel.targetFields, altEngine)
      : api.extractDocumentUrl(source, panel.targetFields, panel.filename, altEngine);

    apiCall
      .then((result) => {
        const altResult: DocPanelResult = {
          imageUrl: toPreviewImageUrl(source, result.processed_image),
          filename: result.filename,
          method: result.method,
          text: result.text,
          fields: result.fields,
          fallback: result.fallback,
        };
        setDocExtractPanel((prev) => prev ? { ...prev, altResult } : prev);
        setDocExtractActiveTab("alt");
        setSuccessToast(`${extractMethodLabel(result.method)} 提取完成，可切换对比`);
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`${extractMethodLabel(altEngine === "umi" ? "umi_ocr" : "vision_ocr")} 提取失败: ${msg}`);
      })
      .finally(() => {
        setDocAltExtracting(false);
      });
  }, [docExtractPanel, docAltExtracting, setSuccessToast, setError]);

  /** 「录入提取」按钮点击入口：文件提取网页模式教学中，先记录为一个过程点击步骤
   *  （panelAction=doc-web-extract，执行时回放=再次调用 triggerWebExtract 提交文件字段），再执行提取 */
  const handleTriggerWebExtractClick = useCallback(() => {
    const pending = pendingWebFileRef.current;
    if (
      addingDocExtractModeRef.current &&
      docExtractSourceRef.current === "web" &&
      docWebStatusRef.current?.phase === "preview" &&
      pending
    ) {
      const side = pending.side;
      const workflow: "entry" | "review" = side === "left" ? "entry" : "review";
      // 判断是否处于过程/前置点击模式中（从过程点击触发下载后自动进入文件提取的情况）
      const inNavClick = addingClickModeRef.current &&
        (addingClickPhaseRef.current === "pre" || addingClickPhaseRef.current === "mid");
      addPickedMark({
        side,
        source: "web",
        selector: "panel://doc-web-extract",
        label: `文件提取过程点击 · 录入提取（${pending.filename}）`,
        workflow,
        action: "click",
        recordId: selected?.record_id,
        docExtractClick: true,
        docExtractClickPhase: "mid",
        panelAction: "doc-web-extract",
        clickPhase: inNavClick ? (addingClickPhaseRef.current as "pre" | "mid") : "mid",
        inPopup: false,
      });
      setSuccessToast("已记录过程点击：录入提取（执行时将自动点击该按钮提交文件字段）");
    }
    triggerWebExtract();
  }, [triggerWebExtract, addPickedMark, selected, setSuccessToast]);

  /** 网页提取失败后重试：根据失败阶段决定重试策略 */
  const retryWebExtract = useCallback(() => {
    const status = docWebStatusRef.current;
    if (status?.phase !== "error") return;
    const pending = pendingWebFileRef.current;
    if (pending) {
      // 文件已下载但 OCR/提取失败 → 清除缓存，重新执行 OCR
      bgOcrResultRef.current = null;
      rlog(`[retryWebExtract] 重试 OCR 提取: ${pending.filename}`);
      triggerWebExtract();
    } else {
      // 下载阶段失败 → 重置为 idle，让用户重新点击网页元素触发下载
      rlog(`[retryWebExtract] 下载失败，重置状态等待重新点击`);
      setDocWebStatus({ phase: "idle" });
    }
  }, [triggerWebExtract]);

  const removeCustomTextEntry = useCallback((id: string) => {
    setCustomTextEntries((prev) => prev.filter((e) => e.id !== id));
    if (customTextPickingIdRef.current === id) {
      setCustomTextPickingId(null);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
    }
  }, []);

  const renameCustomTextEntry = useCallback((id: string, name: string) => {
    setCustomTextEntries((prev) => prev.map((e) => (e.id === id ? { ...e, name } : e)));
  }, []);

  const updateCustomTextEntry = useCallback((id: string, text: string) => {
    setCustomTextEntries((prev) => prev.map((e) => (e.id === id ? { ...e, text } : e)));
  }, []);

  const setCustomTextWorkflow = useCallback((id: string, workflow: "review" | "entry") => {
    setCustomTextEntries((prev) => prev.map((e) => (e.id === id ? { ...e, workflow } : e)));
  }, []);

  /** 进入/取消条目的 Excel 列绑定态：armed 后点击右侧 Excel 单元格即绑定该列 */
  const bindExcelForEntry = useCallback((id: string) => {
    setExcelBindEntryId((prev) => {
      const next = prev === id ? null : id;
      excelBindEntryIdRef.current = next;
      return next;
    });
  }, []);

  /** 解除条目的 Excel 列绑定（恢复为固定值） */
  const clearEntryExcelField = useCallback((id: string) => {
    setCustomTextEntries((prev) => prev.map((e) => (e.id === id ? { ...e, excelField: undefined } : e)));
    setExcelBindEntryId((prev) => (prev === id ? null : prev));
  }, []);

  const pickForCustomText = useCallback((id: string) => {
    customTextModeRef.current = true;
    customTextPickingIdRef.current = id;
    setCustomTextMode(true);
    setCustomTextPickingId(id);
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    setTimeout(() => {
      window.electronAPI?.viewStartPicking("left").catch(() => {});
      window.electronAPI?.viewStartPicking("right").catch(() => {});
    }, 100);
  }, []);

  const saveCustomTextSteps = useCallback(() => {
    const savedStepType = currentLoopStepTypeRef.current;
    let saved = 0;
    const newlySavedIds: string[] = [];
    customTextEntries.forEach((entry) => {
      if (!entry.text || !entry.selector || entry.saved) return;
      // 每个条目按自身的 workflow 保存（未设置时跟随全局）
      const entryWorkflow = entry.workflow || savedStepType;
      currentLoopStepTypeRef.current = entryWorkflow;
      // right_label 只用拾取到的元素标签；框框名字（entry.name）不参与保存，仅在 UI 显示
      // 绑定了 Excel 列时：来源改为 excel 列（LOOP 逐行取值，saveMapping 会自动转为 variableField）
      saveMapping({
        right_selector: entry.selector,
        right_label: entry.label || entry.selector,
        right_input_type: entry.type || null,
        left_source: entry.excelField ? "excel" : "manual",
        left_field: entry.excelField || entry.text,
        verify_method: "smart",
        web_side: entry.side || "right",
      });
      newlySavedIds.push(entry.id);
      saved++;
    });
    // 恢复全局步骤类型
    currentLoopStepTypeRef.current = savedStepType;
    if (saved > 0) {
      // 标记已保存的条目，保留在面板中
      setCustomTextEntries((prev) =>
        prev.map((e) => (newlySavedIds.includes(e.id) ? { ...e, saved: true } : e))
      );
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customTextEntries]);

  // 提取元素面板的条目按来源分两类：doc=文件提取送来的字段，manual=手动添加的自定义文本
  const docEntries = useMemo(() => customTextEntries.filter((e) => e.source === "doc"), [customTextEntries]);
  const manualEntries = useMemo(() => customTextEntries.filter((e) => e.source !== "doc"), [customTextEntries]);

  // 自定义文本/文件提取条目共用渲染器（统一面板：紫色=文件提取，蓝色=自定义文本；序号全局 FIFO 连续编号）
  const renderExtractEntries = useCallback((
    list: CustomTextEntry[],
    opts: {
      headerText?: string;
      showAdd: boolean;
      emptyHint?: string;
      unified?: boolean;
      /** 控件取值拾取模式：true 时卡片可点击作为控件取值来源 */
      widgetPickActive?: boolean;
      /** 控件取值拾取回调 */
      onWidgetPickEntry?: (entry: CustomTextEntry) => void;
      /** 控件取值拾取取消回调 */
      onWidgetPickCancel?: () => void;
    }
  ) => {
    // 按 createdAt FIFO 排序（无时间戳的排最后）；序号在整个列表内连续编号
    const sorted = [...list].sort((a, b) => (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER));
    const readyCount = sorted.filter((e) => e.text && e.selector && !e.saved).length;
    return (
    <div className="flex h-full flex-col">
      {/* 可滚动区域：提示条 + 条目列表 + 添加按钮 */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-1.5 flex flex-col gap-2 scroll-smooth">
      {opts.widgetPickActive && (
        <div className="mb-0.5 flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
          <Crosshair className="h-3 w-3" />
          <span>点击字段卡片作为控件取值（或在左侧网页点选元素）</span>
          <button
            onClick={(e) => { e.stopPropagation(); opts.onWidgetPickCancel?.(); }}
            className="ml-auto rounded px-1.5 py-0.5 text-[9px] text-amber-600 hover:bg-amber-100"
          >
            取消
          </button>
        </div>
      )}
      {opts.headerText && (
        <div className="mb-0.5 flex items-center gap-1 text-[10px] font-bold text-violet-800">
          <Type className="h-3 w-3 text-violet-700" />
          {opts.headerText}
        </div>
      )}
      {sorted.length === 0 && opts.emptyHint && (
        <p className="text-[9px] text-slate-500">{opts.emptyHint}</p>
      )}
      {sorted.map((entry, seqIdx) => {
        const isDoc = entry.source === "doc";
        // 紫色系（violet）= 文件提取字段；蓝色系（sky/blue）= 自定义文本
        const pickActive = isDoc
          ? "border-violet-400 bg-violet-100/80 ring-1 ring-violet-300 animate-pulse"
          : "border-sky-400 bg-sky-100/80 ring-1 ring-sky-300 animate-pulse";
        const borderLinked = isDoc ? "border-violet-200 bg-violet-50/60" : "border-sky-200 bg-sky-50/60";
        const borderIdle = isDoc ? "border-violet-100 bg-violet-50/30" : "border-sky-100 bg-sky-50/30";
        const widgetPickHover = isDoc
          ? "cursor-pointer hover:border-violet-400 hover:bg-violet-100/70 hover:shadow-sm hover:ring-1 hover:ring-violet-300"
          : "cursor-pointer hover:border-sky-400 hover:bg-sky-100/70 hover:shadow-sm hover:ring-1 hover:ring-sky-300";
        const numBadge = isDoc ? "bg-violet-500" : "bg-sky-500";
        const nameText = isDoc ? "text-violet-600" : "text-sky-600";
        const namePlaceholder = isDoc ? "placeholder:text-violet-300" : "placeholder:text-sky-300";
        const divider = isDoc ? "bg-violet-100/80" : "bg-sky-100/80";
        const assocBadge = isDoc ? "bg-violet-100 text-violet-700 ring-violet-200" : "bg-sky-100 text-sky-700 ring-sky-200";
        const assocText = isDoc ? "text-violet-500/80" : "text-sky-500/80";
        const pickHint = isDoc ? "text-violet-600" : "text-sky-600";
        const pickBtnActive = isDoc ? "bg-violet-500 text-white" : "bg-sky-500 text-white";
        const isWidgetPickingThis = opts.widgetPickActive && !!entry.text;
        return (
        <div
          key={entry.id}
          onClick={isWidgetPickingThis ? () => opts.onWidgetPickEntry?.(entry) : undefined}
          className={`relative w-full rounded-lg border-2 px-2.5 py-2 transition-all ${
            customTextPickingId === entry.id
              ? pickActive
              : entry.selector
              ? borderLinked
              : borderIdle
          } ${isWidgetPickingThis ? widgetPickHover : opts.widgetPickActive ? "cursor-not-allowed opacity-60" : ""}`}
        >
          {/* 控件拾取模式：十字光标图标提示 */}
          {isWidgetPickingThis && (
            <div className={`absolute -left-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full ${isDoc ? "bg-violet-500" : "bg-sky-500"} text-white ring-2 ring-white`}>
              <Crosshair className="h-2.5 w-2.5" />
            </div>
          )}
          {/* 左上角来源标记 */}
          <div className="absolute left-1.5 top-1.5 flex shrink-0 items-center">
            <span
              className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[8px] font-bold ${
                isDoc ? "bg-violet-100 text-violet-600" : "bg-sky-100 text-sky-600"
              }`}
            >
              {isDoc ? <FileText className="h-2 w-2" /> : <Type className="h-2 w-2" />}
              {isDoc ? "文件" : "自定义"}
            </span>
          </div>
          {/* 右上角徽章：已拾取 / 拾取中 */}
          <div className="absolute right-1.5 top-1.5 flex shrink-0 items-center gap-1">
            {entry.saved && !customTextPickingId && !opts.widgetPickActive && (
              <span
                className="inline-flex items-center rounded-md bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700 ring-1 ring-emerald-200 max-w-[130px] truncate"
                title="已保存为步骤"
              >
                已保存
              </span>
            )}
            {entry.selector && !entry.saved && customTextPickingId !== entry.id && !opts.widgetPickActive && (
              <span
                className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[9px] font-medium ring-1 max-w-[130px] truncate ${assocBadge}`}
                title={`${entry.side === "left" ? "左" : "右"}侧：${entry.label || entry.selector}`}
              >
                关联
              </span>
            )}
          </div>
          {/* 第一行：FIFO 序号 + 框框名字 */}
          <div className="mb-1 mt-3.5 flex items-center gap-1 pr-16">
            <span
              className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full ${numBadge} text-[8px] font-bold text-white`}
              title={`第 ${seqIdx + 1} 个设置（先设置先执行）`}
            >
              {seqIdx + 1}
            </span>
            {opts.widgetPickActive ? (
              <span className={`w-full truncate px-0.5 py-0.5 text-[11px] font-bold ${nameText}`}>
                {entry.name || "（未命名）"}
              </span>
            ) : (
            <input
              value={entry.name}
              onChange={(e) => renameCustomTextEntry(entry.id, e.target.value)}
              placeholder="框框名字…（仅显示，不参与录入/审查）"
              className={`w-full bg-transparent px-0.5 py-0.5 text-[11px] font-bold outline-none ${nameText} ${namePlaceholder}`}
              onClick={(e) => isWidgetPickingThis && e.stopPropagation()}
            />
            )}
          </div>
          {/* 分隔线 */}
          <div className={`mb-1 h-px w-full ${divider}`} />
          {/* 第二行：实际内容值 */}
          {opts.widgetPickActive ? (
            <div className="min-h-[32px] w-full px-0.5 py-0.5 text-[11px] leading-snug text-slate-700 break-words">
              {entry.text || <span className="text-slate-300">（空）</span>}
            </div>
          ) : (
          <textarea
            value={entry.text}
            onChange={(e) => updateCustomTextEntry(entry.id, e.target.value)}
            placeholder="输入实际内容…（用于审查对比或录入填入）"
            rows={2}
            className="w-full resize-none bg-transparent px-0.5 py-0.5 text-[11px] leading-snug text-slate-700 outline-none placeholder:text-slate-300"
            onClick={(e) => isWidgetPickingThis && e.stopPropagation()}
          />
          )}
          {/* 拾取提示 / 关联详情 */}
          <div className="mt-0.5">
            {customTextPickingId === entry.id ? (
              <span className={`text-[9px] animate-pulse ${pickHint}`}>
                请在网页中点击目标元素…
              </span>
            ) : opts.widgetPickActive ? (
              entry.text ? (
                <span className={`text-[9px] ${isDoc ? "text-violet-500" : "text-sky-500"}`}>
                  点击卡片取此值 → 填入控件
                </span>
              ) : (
                <span className="text-[9px] text-slate-400">请先填写内容</span>
              )
            ) : entry.selector ? (
              <span
                className={`text-[9px] truncate block ${assocText}`}
                title={`${entry.side === "left" ? "左" : "右"}侧网页：${entry.label || entry.selector}`}
              >
                {entry.side === "left" ? "左" : "右"}侧元素：{entry.label || entry.selector}
              </span>
            ) : null}
            {/* 已绑定 Excel 列提示（LOOP 逐行取值） */}
            {entry.excelField && (
              <span className="mt-0.5 inline-flex items-center gap-1 text-[9px] font-medium text-emerald-600">
                <FileSpreadsheet className="h-2.5 w-2.5" />
                Excel列「{entry.excelField}」· 逐行取值
                <button
                  onClick={(e) => { e.stopPropagation(); clearEntryExcelField(entry.id); }}
                  className="rounded px-0.5 text-slate-400 hover:bg-rose-100 hover:text-rose-600"
                  title="解除 Excel 列绑定（恢复为固定值）"
                >
                  ✕
                </button>
              </span>
            )}
          </div>
          {/* 底部操作按钮（控件拾取模式下隐藏，避免误操作） */}
          {!opts.widgetPickActive && (
          <div className="mt-1.5 flex items-center gap-1">
            {/* 审核/录入模式切换 */}
            {(() => {
              const wf = entry.workflow || currentLoopStepType;
              const isEntry = wf === "entry";
              return (
                <div className="inline-flex overflow-hidden rounded-md border border-slate-200 bg-slate-100">
                  <button
                    onClick={(e) => { e.stopPropagation(); setCustomTextWorkflow(entry.id, "review"); }}
                    className={`px-1.5 py-0.5 text-[9px] font-semibold transition-colors ${
                      !isEntry ? "bg-amber-500 text-white" : "text-slate-500 hover:bg-slate-200"
                    }`}
                    title="审查模式：拾取网页元素进行字段对比"
                  >
                    审查
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setCustomTextWorkflow(entry.id, "entry"); }}
                    className={`px-1.5 py-0.5 text-[9px] font-semibold transition-colors ${
                      isEntry ? "bg-sky-500 text-white" : "text-slate-500 hover:bg-slate-200"
                    }`}
                    title="录入模式：拾取输入框并直接填入文本"
                  >
                    录入
                  </button>
                </div>
              );
            })()}
            <button
              onClick={(e) => { e.stopPropagation(); pickForCustomText(entry.id); }}
              disabled={!!customTextPickingId && customTextPickingId !== entry.id}
              className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
                customTextPickingId === entry.id
                  ? pickBtnActive
                  : entry.selector
                  ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                  : "bg-slate-200 text-slate-600 hover:bg-slate-300"
              } disabled:opacity-40`}
              title={entry.selector ? "重新选择关联元素" : "点击后在网页中拾取目标元素"}
            >
              <MousePointerClick className="h-2.5 w-2.5" />
              {entry.selector ? "重选" : "拾取"}
            </button>
            {/* 绑定 Excel 列：armed 后点击 Excel 单元格完成绑定；已绑定后按钮变为「取消绑定」 */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (entry.excelField && excelBindEntryId !== entry.id) {
                  clearEntryExcelField(entry.id);
                } else {
                  bindExcelForEntry(entry.id);
                }
              }}
              disabled={!!customTextPickingId && customTextPickingId !== entry.id}
              className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
                excelBindEntryId === entry.id
                  ? "bg-emerald-500 text-white animate-pulse"
                  : entry.excelField
                  ? "bg-emerald-500 text-white hover:bg-rose-500"
                  : "bg-slate-200 text-slate-600 hover:bg-slate-300"
              } disabled:opacity-40`}
              title={excelBindEntryId === entry.id ? "请点击 Excel 中的一列完成绑定（再点一次取消）" : entry.excelField ? `已成功绑定 Excel 列「${entry.excelField}」（LOOP 时逐行取该列值）· 点击取消绑定` : "绑定 Excel 列：LOOP 时按每张卡片该行该列的值审查/录入"}
            >
              <FileSpreadsheet className="h-2.5 w-2.5" />
              {excelBindEntryId === entry.id ? "点Excel列…" : entry.excelField ? `已绑「${entry.excelField}」· 取消绑定` : "绑Excel"}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); removeCustomTextEntry(entry.id); }}
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium text-slate-400 transition-colors hover:bg-rose-100 hover:text-rose-600"
              title="删除此文本框"
            >
              <Trash2 className="h-2.5 w-2.5" />
              删除
            </button>
          </div>
          )}
        </div>
        );
      })}
      {/* 内联添加按钮：紧贴在最后一个条目下方，点击新增空白例子 */}
      {opts.showAdd && !opts.widgetPickActive && (
        <button
          onClick={addCustomTextEntry}
          className="flex w-full shrink-0 items-center justify-center gap-1 rounded-lg border-2 border-dashed border-sky-200 bg-sky-50/30 py-2 text-[10px] font-medium text-sky-500 transition-all hover:border-sky-400 hover:bg-sky-50 hover:text-sky-600"
        >
          <Plus className="h-3 w-3" />
          添加文本
        </button>
      )}
      </div>
      {/* 固定底部栏：保存按钮 + 就绪计数，不随条目滚动 */}
      <div className="flex shrink-0 items-center gap-1.5 border-t border-slate-100 px-2 py-1">
        {readyCount > 0 && (
          <button
            onClick={saveCustomTextSteps}
            className="inline-flex items-center gap-0.5 rounded-md bg-brand-600 px-2 py-0.5 text-[10px] font-medium text-white transition-all hover:bg-brand-700"
          >
            <Save className="h-2.5 w-2.5" />
            保存为{addingStepMode === "review" ? "审查" : "录入"}步骤
          </button>
        )}
        <span className="ml-auto text-[9px] text-slate-400">
          {readyCount}/{sorted.length} 已就绪
        </span>
      </div>
    </div>
    );
  }, [customTextPickingId, addingStepMode, renameCustomTextEntry, updateCustomTextEntry, pickForCustomText, removeCustomTextEntry, addCustomTextEntry, saveCustomTextSteps, setCustomTextWorkflow, currentLoopStepType, excelBindEntryId, bindExcelForEntry, clearEntryExcelField]);

  // 控件拾取左侧面板条目：通过 ref 间接调用，解决函数定义顺序问题（真正实现在 testWidget/updateSavedWidgetBinding 之后）
  const onWidgetPickExtractEntryRef = useRef<((entry: CustomTextEntry) => void) | null>(null);
  const onWidgetPickExtractEntryWrapper = useCallback((entry: CustomTextEntry) => {
    onWidgetPickExtractEntryRef.current?.(entry);
  }, []);
  const cancelWidgetPickRef = useRef<(() => void) | null>(null);
  const cancelWidgetPickWrapper = useCallback(() => {
    cancelWidgetPickRef.current?.();
  }, []);

  // 自定义文本 TAB 内容（保留供 ElementSelectBar 使用；ResultsPanel 使用下方统一面板）
  const customTextContent = useMemo(() => {
    // 有条目时始终可渲染（由 ResultsPanel 的 设置/结果 开关控制显隐）
    if (!customTextMode && manualEntries.length === 0) return null;
    const wgPickActive = !!widgetLeftPickingKey;
    return renderExtractEntries(manualEntries, {
      headerText: "自定义文本 — 补充 Excel 和数据源网页上都没有的信息",
      showAdd: true,
      emptyHint: "点击下方「添加」创建文本框：上方输入框是框框名字（仅显示），下方是实际内容（参与审查/录入）",
      widgetPickActive: wgPickActive,
      onWidgetPickEntry: wgPickActive ? onWidgetPickExtractEntryWrapper : undefined,
      onWidgetPickCancel: wgPickActive ? cancelWidgetPickWrapper : undefined,
    });
  }, [customTextMode, manualEntries, renderExtractEntries, widgetLeftPickingKey, onWidgetPickExtractEntryWrapper, cancelWidgetPickWrapper]);

  // 文件提取 TAB 内容（保留供其他位置使用；ResultsPanel 使用下方统一面板）
  const docFieldsContent = useMemo(() => {
    if (docEntries.length === 0) return null;
    const wgPickActive = !!widgetLeftPickingKey;
    return renderExtractEntries(docEntries, {
      headerText: "文件提取字段 — 来自文件/图片识别，拾取关联网页元素后保存为步骤",
      showAdd: false,
      widgetPickActive: wgPickActive,
      onWidgetPickEntry: wgPickActive ? onWidgetPickExtractEntryWrapper : undefined,
      onWidgetPickCancel: wgPickActive ? cancelWidgetPickWrapper : undefined,
    });
  }, [docEntries, renderExtractEntries, widgetLeftPickingKey, onWidgetPickExtractEntryWrapper, cancelWidgetPickWrapper]);

  // 提取元素面板统一内容：文件提取字段(紫色) + 自定义文本(蓝色)，按 FIFO 合并显示，无需 TAB 切换
  const unifiedFieldsContent = useMemo(() => {
    // 始终返回内容（包含空状态和添加按钮），不再返回 null
    const wgPickActive = !!widgetLeftPickingKey;
    return renderExtractEntries(customTextEntries, {
      showAdd: true,
      widgetPickActive: wgPickActive,
      onWidgetPickEntry: wgPickActive ? onWidgetPickExtractEntryWrapper : undefined,
      onWidgetPickCancel: wgPickActive ? cancelWidgetPickWrapper : undefined,
    });
  }, [customTextEntries, renderExtractEntries, widgetLeftPickingKey, onWidgetPickExtractEntryWrapper, cancelWidgetPickWrapper]);

  // 提取元素汇总（字段对比设置态「提取元素」小卡片）：文件提取步骤 + 面板条目 + 控件，按设置时间 FIFO
  const extractStepSummary = useMemo<ExtractSummaryItem[]>(() => {
    const items: ExtractSummaryItem[] = [];
    // 0. 文件处理按钮操作记录（送字段到提取元素面板 / 导出文件，执行时 no-op）
    for (const m of pickedMarks) {
      if (!m.fileOp) continue;
      const opLabel = m.fileOp === "extract" ? "送字段到提取元素" : m.fileOp === "export" ? "导出文件" : "绑定上传";
      items.push({
        id: m.id || `fileop-${m.order}`,
        kind: "doc",
        name: "文件处理",
        detail: m.label || opLabel,
        saved: true,
        ts: m.createdAt ?? Number.MAX_SAFE_INTEGER,
        side: m.side,
      });
    }
    // 1. 文件提取步骤（pickedMarks 中带 docExtract 标记：网页提取/网页下载/本地文件）
    for (const m of pickedMarks) {
      if (!m.docExtract) continue;
      const srcLabel = m.docSource === "local" ? "本地文件" : m.docSource === "web-download" ? "网页下载" : "网页提取";
      items.push({
        id: m.id || `doc-step-${m.order}`,
        kind: "doc",
        name: srcLabel,
        detail: m.label || m.selector,
        saved: true,
        ts: m.createdAt ?? Number.MAX_SAFE_INTEGER,
        selector: m.selector,
        side: m.side,
      });
    }
    // 2. 提取元素面板条目（文件提取字段 + 自定义文本，含未保存的）
    for (const e of customTextEntries) {
      items.push({
        id: e.id,
        kind: e.source === "doc" ? "doc" : "custom",
        name: e.source === "doc" ? "文件字段" : "自定义文本",
        detail: e.name ? `${e.name}：${e.text}` : e.text || "（空）",
        saved: !!e.saved,
        ts: e.createdAt ?? Number.MAX_SAFE_INTEGER,
        selector: e.selector,
        side: e.side,
      });
    }
    // 3. 控件（已保存 + 草稿）
    for (const m of mappings) {
      if (!m.widget) continue;
      const w = m.widget;
      const mark = pickedMarks.find((mk) => mk.widget && mk.selector === m.right_selector);
      items.push({
        id: `widget-${m.right_selector}`,
        kind: "widget",
        name: w.kind === "calendar" ? "日历控件" : "选项控件",
        detail: w.triggerLabel || m.right_label || m.right_selector,
        saved: true,
        ts: mark?.createdAt ?? Number.MAX_SAFE_INTEGER,
        selector: w.triggerSelector || m.right_selector,
        side: "right",
      });
    }
    if (widgetDraft) {
      items.push({
        id: "widget-draft",
        kind: "widget",
        name: widgetDraft.kind === "calendar" ? "日历控件" : "选项控件",
        detail: `${widgetDraft.triggerLabel || "未命名"}（配置中）`,
        saved: false,
        ts: Date.now(),
        selector: widgetDraft.triggerSelector,
        side: "right",
      });
    }
    // FIFO：谁先设置谁排前（无时间戳的排最后）
    return items.sort((a, b) => a.ts - b.ts);
  }, [pickedMarks, customTextEntries, mappings, widgetDraft]);

  // 重置当前映射选择轮次：根据当前步骤模式回到初始拾取侧
  // 审查模式（先右后左）：回到 right；录入模式（先左后右）：回到 left
  // 右侧Excel模式：审查回到左网页 / 录入回到右侧 Excel
  const resetMappingRound = useCallback(() => {
    setRightPicked(null);
    setLeftPicked(null);
    rightPickedSideRef.current = "right";
    const isEntry = currentLoopStepTypeRef.current === "entry";
    const target: PickTarget = rightExcelModeRef.current
      ? (isEntry ? "right" : "left")
      : (isEntry ? "left" : "right");
    setPickTarget(target);
    setTimeout(() => {
      if (target === "left") {
        window.electronAPI?.viewStopPicking("right").catch(() => {});
        if (leftViewModeRef.current === "web") window.electronAPI?.viewStartPicking("left");
      } else {
        window.electronAPI?.viewStopPicking("left").catch(() => {});
        if (rightViewModeRef.current === "web") window.electronAPI?.viewStartPicking("right");
      }
    }, 200);
  }, []);

  // 切换到左侧网页拾取：停止右侧拾取，启动左侧拾取
  const pickLeftFromWeb = useCallback(() => {
    setPickTarget("left");
    setTimeout(() => {
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      window.electronAPI?.viewStartPicking("left");
    }, 100);
  }, []);

  // 切换到左侧 Excel 拾取：停止两侧网页拾取
  const pickLeftFromExcel = useCallback(() => {
    setPickTarget(null);
    setLeftPicked(null);
    setTimeout(() => {
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
    }, 100);
  }, []);

  // 撤销最后一步（删除最后一个 pickedMark，或退出当前子模式）
  const undoLastStep = useCallback(() => {
    // 1. 如果当前处于文件提取配置子面板，先退出文件提取配置
    if (addingDocExtractMode) {
      setAddingDocExtractMode(false);
      setDocExtractSource(null);
      setDocLocalFiles([]);
      setDocFileBindField(null);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      window.electronAPI?.viewClearHighlight("left").catch(() => {});
      window.electronAPI?.viewClearHighlight("right").catch(() => {});
      window.electronAPI?.setDownloadCapture("left", false).catch(() => {});
      window.electronAPI?.setDownloadCapture("right", false).catch(() => {});
      return;
    }
    // 2. 如果处于添加点击任务子模式，退出点击模式
    if (addingClickMode) {
      setAddingClickMode(false);
      setPendingAction("none");
      setNextClickLabel(null);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      return;
    }
    // 3. 如果处于绑定输入框子模式，退出绑定模式
    if (bindInputSide) {
      setBindInputSide(null);
      setPendingAction("none");
      setInputTarget(null);
      setRightPicked(null);
      setLeftPicked(null);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      window.electronAPI?.viewClearHighlight("left").catch(() => {});
      window.electronAPI?.viewClearHighlight("right").catch(() => {});
      return;
    }
    // 4. 否则删除最后一个 pickedMark
    const last = pickedMarks[pickedMarks.length - 1];
    if (last) removePickedMark(last.id);
  }, [pickedMarks, removePickedMark, addingDocExtractMode, addingClickMode, bindInputSide]);

  // ============ 文件提取模式（审查步骤子步骤）：选择来源 → 网页提取/本地文件提取 → OCR ============
  // 轻量打开"选择文件提取来源"面板（不退出其他设置模式，用于文件面板为空时自动展示）
  const openDocChoosePanel = useCallback(() => {
    if (addingDocExtractModeRef.current) return;
    setAddingDocExtractMode(true);
    setDocExtractSource("choose");
    setDocLocalFiles([]);
    setDocFileBindField(selectedExcelColumn || null);
    setPendingAction("none");
    setPickTarget(null);
    setNextClickLabel(null);
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
  }, [selectedExcelColumn]);

  // 开始文件提取（toggle：已激活则退出所有模式）
  const startAddDocExtract = useCallback(() => {
    // Toggle：如果已在文件提取模式，退出所有
    if (addingDocExtractModeRef.current) {
      rlog("[startAddDocExtract] 已在文件提取模式，退出所有设置模式");
      exitAllSetupModes();
      return;
    }
    // 先退出所有其他模式（互斥）
    exitAllSetupModes();
    rlog("[startAddDocExtract] 打开文件提取来源选择");
    setAddingDocExtractMode(true);
    setDocExtractSource("choose");
    setDocLocalFiles([]);
    setDocFileBindField(selectedExcelColumn || null);
    setPendingAction("none");
    setPickTarget(null);
    setNextClickLabel(null);
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
  }, [selectedExcelColumn, exitAllSetupModes]);

  // 选择网页提取来源 → 多步点击 + 下载捕获模式
  const chooseDocExtractWeb = useCallback(() => {
    rlog("[docExtract] 选择网页提取来源（多步点击 + 下载捕获）");
    setDocExtractSource("web");
    setDocWebStatus({ phase: "idle" });
    setDocExtractPanel(null);
    setSameNameImages(null);
    // 开启双侧下载捕获：用户点击多个元素后，任一侧触发下载都会被捕获
    window.electronAPI?.setDownloadCapture("left", true).catch(() => {});
    window.electronAPI?.setDownloadCapture("right", true).catch(() => {});
    // 开启双侧拾取：允许用户点击网页元素记录导航步骤
    setTimeout(() => {
      if (addingDocExtractModeRef.current && docExtractSourceRef.current === "web") {
        window.electronAPI?.viewStartPicking("right");
        window.electronAPI?.viewStartPicking("left");
      }
    }, 300);
    setSuccessToast("网页提取模式：请依次点击网页元素导航到下载按钮，下载会自动捕获");
  }, [setSuccessToast]);

  // 选择本地文件提取来源
  const chooseDocExtractLocal = useCallback(() => {
    rlog("[docExtract] 选择本地文件提取来源");
    setDocExtractSource("local");
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
  }, []);

  // 触发本地文件选择对话框
  const triggerDocLocalFilePick = useCallback(() => {
    docLocalFileInputRef.current?.click();
  }, []);

  // 处理本地文件选择（保留兼容：多选文件模式）
  const handleDocLocalFilesSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setDocLocalFiles((prev) => {
      // 过滤重名文件
      const existingNames = new Set(prev.map((f) => f.name));
      const newFiles = files.filter((f) => !existingNames.has(f.name));
      return [...prev, ...newFiles];
    });
    // 重置 input 以便可以重复选择相同文件
    e.target.value = "";
  }, []);

  // 删除一个已上传的本地文件
  const removeDocLocalFile = useCallback((name: string) => {
    setDocLocalFiles((prev) => prev.filter((f) => f.name !== name));
  }, []);

  // === 目录模式：选择本地文件夹 ===
  const pickLocalDirectory = useCallback(async () => {
    if (!window.electronAPI?.pickLocalDirectory) return;
    const result = await window.electronAPI.pickLocalDirectory();
    if (result.canceled || !result.rootPath) return;
    setDocLocalRootPath(result.rootPath);
    setDocLocalDirFiles(result.files);
    setDocLocalSamplePath(null);
    setDocLocalPattern(null);
    rlog(`[docExtract] 选择目录: ${result.rootPath}, ${result.files.length} 个文件`);
  }, []);

  // === 目录模式：点选样本文件，自动推断路径模板 ===
  // 逻辑：取样本文件相对路径 → 去扩展名 → 分段 → 匹配 Excel 字段值 → 替换为 {field} 占位符
  const selectDocLocalSample = useCallback((relativePath: string) => {
    setDocLocalSamplePath(relativePath);
    if (!docFileBindField) {
      setDocLocalPattern(null);
      return;
    }
    // 去掉扩展名
    const noExt = relativePath.replace(/\.[^.]+$/, "");
    const segments = noExt.split("/");
    // 收集所有 Excel 记录中该字段的值，用于匹配路径段
    const fieldValues = new Set<string>();
    records.forEach((r) => {
      const v = r.fields?.[docFileBindField];
      if (v && String(v).trim()) fieldValues.add(String(v).trim());
    });
    // 遍历路径段，找到第一个等于某个字段值的段，替换为 {field}
    let found = false;
    const patternSegments = segments.map((seg) => {
      if (!found && fieldValues.has(seg)) {
        found = true;
        return `{${docFileBindField}}`;
      }
      return seg;
    });
    // 如果没匹配到字段值，默认替换第一段（通常是学号目录名）
    if (!found && segments.length > 1) {
      patternSegments[0] = `{${docFileBindField}}`;
    }
    setDocLocalPattern(patternSegments.join("/"));
    rlog(`[docExtract] 样本: ${relativePath} → 模板: ${patternSegments.join("/")}`);
  }, [docFileBindField, records]);

  // 确认本地文件提取配置：保存为一个 mark
  const confirmDocLocalExtract = useCallback(() => {
    // 目录模式：根目录 + 路径模板
    if (docLocalRootPath && docLocalPattern && docFileBindField) {
      const side: "left" | "right" = addingStepMode === "entry" ? "left" : "right";
      const workflow: "entry" | "review" = addingStepMode === "entry" ? "entry" : "review";
      addPickedMark({
        side,
        source: "web",
        selector: `local-doc-extract:${docFileBindField}`,
        label: `本地文件提取 · 路径模板「${docLocalPattern}」（根目录 ${docLocalDirFiles.length} 文件）`,
        workflow,
        action: "click",
        recordId: selected?.record_id,
        docExtract: true,
        docSource: "local",
        docFileField: docFileBindField,
        docLocalRootPath,
        docLocalPattern,
        docLocalSamplePath: docLocalSamplePath || undefined,
      });
      setSuccessToast(`已添加本地文件提取：模板「${docLocalPattern}」，LOOP 执行时自动按字段匹配`);
      setAddingDocExtractMode(false);
      setDocExtractSource(null);
      setDocLocalFiles([]);
      setDocFileBindField(null);
      setDocLocalRootPath(null);
      setDocLocalDirFiles([]);
      setDocLocalSamplePath(null);
      setDocLocalPattern(null);
      // 保存后切换到结果模式，方便用户查看已提取文件
      setDocSignal((s) => s + 1);
      setBottomPanelOpen(true);
      return;
    }
    // 兼容旧模式：多选文件
    if (docLocalFiles.length === 0) {
      setError("请先选择文件夹或上传文件");
      return;
    }
    if (!docFileBindField) {
      setError("请选择用于匹配文件名的字段");
      return;
    }
    const side: "left" | "right" = addingStepMode === "entry" ? "left" : "right";
    const workflow: "entry" | "review" = addingStepMode === "entry" ? "entry" : "review";
    const fileNames = docLocalFiles.map((f) => f.name);
    addPickedMark({
      side,
      source: "web",
      selector: `local-doc-extract:${docFileBindField}`,
      label: `本地文件提取 · 按「${docFileBindField}」匹配（${docLocalFiles.length} 个文件）`,
      workflow,
      action: "click",
      recordId: selected?.record_id,
      docExtract: true,
      docSource: "local",
      docFileField: docFileBindField,
      docLocalFiles: fileNames.map((n) => ({ name: n })),
    });
    setSuccessToast(`已添加本地文件提取步骤：按「${docFileBindField}」字段匹配 ${docLocalFiles.length} 个文件`);
    setAddingDocExtractMode(false);
    setDocExtractSource(null);
    setDocLocalFiles([]);
    setDocFileBindField(null);
    // 保存后切换到结果模式，方便用户查看已提取文件
    setDocSignal((s) => s + 1);
    setBottomPanelOpen(true);
  }, [docLocalRootPath, docLocalPattern, docLocalSamplePath, docLocalDirFiles.length, docFileBindField, docLocalFiles, addingStepMode, selected, addPickedMark, setError, setSuccessToast]);

  const exitAddDocExtractMode = useCallback(() => {
    setAddingDocExtractMode(false);
    setDocExtractSource(null);
    setDocLocalFiles([]);
    setDocFileBindField(null);
    setDocLocalRootPath(null);
    setDocLocalDirFiles([]);
    setDocLocalSamplePath(null);
    setDocLocalPattern(null);
    setDocWebStatus({ phase: "idle" });
    setDocExtractPanel(null);
    setDocExtractSplitView(false);
    setDocSourcePreview(null);
    setSameNameImages(null);
    pendingWebFileRef.current = null;
    // 切换 ResultsPanel 到结果模式：重置 fieldSetupMode / docSetupMode，
    // 确保已提取的文件和字段在文件处理面板中可见（绑定到当前人物卡片）
    setDocSignal((s) => s + 1);
    setBottomPanelOpen(true);
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    window.electronAPI?.popupStopPicking("left").catch(() => {});
    window.electronAPI?.popupStopPicking("right").catch(() => {});
    // 关闭下载捕获
    window.electronAPI?.setDownloadCapture("left", false).catch(() => {});
    window.electronAPI?.setDownloadCapture("right", false).catch(() => {});
  }, []);

  /** 网页提取成功后，开始添加过程点击（提取后的中间步骤） */
  const startDocExtractPostClicks = useCallback(() => {
    const lastStatus = docWebStatusRef.current;
    if (lastStatus.phase !== "success") return;
    setDocWebStatus({ phase: "post-click", filename: lastStatus.filename || "" });
    // 过程点击阶段关闭下载捕获，避免误触发下载
    window.electronAPI?.setDownloadCapture("left", false).catch(() => {});
    window.electronAPI?.setDownloadCapture("right", false).catch(() => {});
    setSuccessToast("过程点击模式：请点击网页上的元素作为提取后的中间步骤（如翻页、继续下载下一个），ESC 退出");
    setTimeout(() => {
      if (addingDocExtractModeRef.current && docExtractSourceRef.current === "web" && docWebStatusRef.current.phase === "post-click") {
        window.electronAPI?.viewStartPicking("right");
        window.electronAPI?.viewStartPicking("left");
      }
    }, 300);
  }, [setSuccessToast]);

  /** 从收尾点击模式切回开头点击模式（补添导航步骤） */
  const startDocExtractPreClicks = useCallback(() => {
    setDocWebStatus((prev) => prev.phase === "post-click" ? { phase: "idle" } : prev);
    window.electronAPI?.setDownloadCapture("left", true).catch(() => {});
    window.electronAPI?.setDownloadCapture("right", true).catch(() => {});
    setSuccessToast("开头点击模式：继续点击网页元素导航到下载按钮");
    setTimeout(() => {
      if (addingDocExtractModeRef.current && docExtractSourceRef.current === "web") {
        window.electronAPI?.viewStartPicking("right");
        window.electronAPI?.viewStartPicking("left");
      }
    }, 300);
  }, [setSuccessToast]);

  /** 在指定side上多次延迟重启picking，解决页面导航/慢加载后光标消失的问题 */
  const ensureDocExtractPicking = useCallback((side: "left" | "right") => {
    const delays = [400, 1000, 2000, 3500];
    delays.forEach((delay) => {
      setTimeout(() => {
        if (!addingDocExtractModeRef.current || docExtractSourceRef.current !== "web") return;
        const phase = docWebStatusRef.current?.phase;
        // 在开头点击(idle/downloading)或收尾点击(post-click)阶段保持picking
        if (phase !== "idle" && phase !== "downloading" && phase !== "post-click") return;
        // 重新注入picking脚本（主进程did-finish-load也会重注入，这里是保险）
        window.electronAPI?.viewStartPicking(side).catch(() => {});
      }, delay);
    });
  }, []);

  /** 撤销最后一次网页提取点击：删除该步骤mark + 浏览器回退 + 保持picking光标 */
  const undoDocExtractClick = useCallback(async () => {
    if (!addingDocExtractModeRef.current || docExtractSourceRef.current !== "web") return;
    // 从后往前找最后一个 docExtractClick 标记（优先撤销当前阶段的点击）
    const marks = pickedMarksRef.current;
    const curPhase = docWebStatusRef.current?.phase;
    const wantPhase = curPhase === "post-click" ? "post" : "pre";
    let targetMark = [...marks].reverse().find(
      (m) => m.docExtractClick && m.docExtractClickPhase === wantPhase && !m.docExtract
    );
    // 如果当前阶段没有可撤销的，尝试撤销任意阶段的docExtractClick
    if (!targetMark) {
      targetMark = [...marks].reverse().find((m) => m.docExtractClick && !m.docExtract);
    }
    if (!targetMark) {
      setSuccessToast("没有可撤销的点击步骤");
      return;
    }
    rlog(`[docExtract] 撤销点击: ${targetMark.label} (${targetMark.selector}), phase=${targetMark.docExtractClickPhase}`);
    // 1. 删除该步骤
    removePickedMark(targetMark.id);
    // 2. 浏览器回退（不关闭picking，让did-navigate自动重注入picker脚本）
    try {
      const side = targetMark.side;
      const res = await window.electronAPI?.viewGoBack(side);
      if (!res?.ok) {
        rlog(`[docExtract] 无法回退: ${res?.reason || "未知原因"}，仅删除步骤记录`);
      }
    } catch (e) {
      rlog(`[docExtract] 回退失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    // 3. 如果撤销的是最后一步（触发了下载的那步），重置状态回idle
    setDocWebStatus((prev) => {
      if (prev.phase === "downloading" || prev.phase === "preview" || prev.phase === "ocr") {
        return { phase: "idle" };
      }
      return prev;
    });
    // 4. 延迟重启picking（回退需要时间加载页面）
    ensureDocExtractPicking(targetMark.side);
    setSuccessToast(`已撤销：${targetMark.label}`);
  }, [removePickedMark, setSuccessToast, ensureDocExtractPicking]);

  /** 纯浏览器回退（不撤销步骤），用于点错元素页面导航了但想返回继续 */
  const docExtractGoBack = useCallback(async () => {
    if (!addingDocExtractModeRef.current || docExtractSourceRef.current !== "web") return;
    // 回退双侧（点击可能发生在任意一侧）
    const sides: ("left" | "right")[] = ["left", "right"];
    for (const side of sides) {
      try {
        const res = await window.electronAPI?.viewGoBack(side);
        if (res?.ok) {
          rlog(`[docExtract] 浏览器回退 side=${side}`);
          ensureDocExtractPicking(side);
        }
      } catch (e) {
        rlog(`[docExtract] 回退失败 side=${side}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setSuccessToast("已返回上一页，可继续点击");
  }, [setSuccessToast, ensureDocExtractPicking]);

  /** 强制恢复拾取光标：恢复光标、同步下载捕获状态，确保与当前点击阶段(开头/收尾)完全连贯 */
  const forceResumeDocPicking = useCallback(() => {
    if (!addingDocExtractModeRef.current || docExtractSourceRef.current !== "web") return;
    const phase = docWebStatusRef.current?.phase;
    const isPostPhase = phase === "post-click";
    rlog(`[docExtract] 强制恢复拾取光标, phase=${phase}`);
    // 根据当前阶段同步下载捕获状态：开头点击阶段开启下载捕获，收尾点击阶段关闭
    const enableCapture = !isPostPhase && (phase === "idle" || phase === "downloading");
    window.electronAPI?.setDownloadCapture("left", enableCapture).catch(() => {});
    window.electronAPI?.setDownloadCapture("right", enableCapture).catch(() => {});
    // 双侧 + 弹窗都重启 picking
    window.electronAPI?.viewStartPicking("left").catch(() => {});
    window.electronAPI?.viewStartPicking("right").catch(() => {});
    window.electronAPI?.popupStartPicking("left").catch(() => {});
    window.electronAPI?.popupStartPicking("right").catch(() => {});
    // 延迟再重试，确保慢页面/导航中页面也能恢复
    [400, 1200, 2500].forEach((delay) => {
      setTimeout(() => {
        if (!addingDocExtractModeRef.current || docExtractSourceRef.current !== "web") return;
        const latestPhase = docWebStatusRef.current?.phase;
        if (latestPhase !== "idle" && latestPhase !== "downloading" && latestPhase !== "post-click") return;
        window.electronAPI?.viewStartPicking("left").catch(() => {});
        window.electronAPI?.viewStartPicking("right").catch(() => {});
      }, delay);
    });
    setSuccessToast(
      isPostPhase
        ? "已恢复拾取光标（收尾点击模式），继续点击网页元素作为闭环操作"
        : "已恢复拾取光标（开头点击模式），继续点击网页元素导航到下载按钮"
    );
  }, [setSuccessToast]);

  // ============ 绑定上传：把文件槽位的文件填入网页 file input ============
  /** 从文件提取预览面板点「绑定上传」：记录来源槽位 → 关闭面板 → 激活双侧拾取 */
  const startBindUpload = useCallback(() => {
    // 优先绑定最近创建的文件提取步骤 mark
    const sourceMark = [...pickedMarksRef.current].reverse().find((m) => m.docExtract);
    setUploadBindSourceMarkId(sourceMark?.id || null);
    setUploadBindMode(true);
    setDocExtractPanel(null);
    setSameNameImages(null);
    rlog(`[uploadBind] 开始绑定上传, sourceMarkId=${sourceMark?.id || "（最近一次提取）"}`);
    setTimeout(() => {
      if (uploadBindModeRef.current) {
        window.electronAPI?.viewStartPicking("left");
        window.electronAPI?.viewStartPicking("right");
      }
    }, 200);
    setSuccessToast("绑定上传：请点击网页上的文件上传框（或上传按钮），ESC 取消");
  }, [setSuccessToast]);

  /** 取消绑定上传模式 */
  const cancelBindUpload = useCallback(() => {
    setUploadBindMode(false);
    setUploadBindSourceMarkId(null);
    setUploadBindDraft(null);
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
  }, []);

  /** 取消一键直传模式 */
  const cancelQuickUpload = useCallback(() => {
    setQuickUploadMode(false);
    quickUploadFileRef.current = null;
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    window.electronAPI?.popupStopPicking("left").catch(() => {});
    window.electronAPI?.popupStopPicking("right").catch(() => {});
  }, []);

  /** 开始一键直传：保存文件数据 → 开启拾取模式 → 等待点击网页上传框 */
  const startQuickUpload = useCallback((fileData: { dataUrl: string; filename: string }) => {
    quickUploadFileRef.current = fileData;
    setQuickUploadMode(true);
    setDocExtractPanel(null);
    setSameNameImages(null);
    // 取消其他拾取模式
    setUploadBindMode(false);
    setUploadBindDraft(null);
    setSuccessToast("一键直传：请点击网页上的文件上传框或上传按钮，ESC 取消");
    setTimeout(() => {
      if (quickUploadModeRef.current) {
        window.electronAPI?.viewStartPicking("left");
        window.electronAPI?.viewStartPicking("right");
      }
    }, 200);
  }, [setSuccessToast]);

  /** 一键直传模式下拾取到元素：识别 file input → 立即填入文件 */
  const handleQuickUploadPick = useCallback(async (side: "left" | "right", info: PickedElementInfo) => {
    const fileData = quickUploadFileRef.current;
    if (!fileData) {
      cancelQuickUpload();
      return;
    }
    const isFileInput = info.tag === "input" && (info.type || "").toLowerCase() === "file";
    const fileSel = isFileInput ? info.selector : (info.fileInputSelector || "");
    const fromPopup = !!info.fromPopup;
    rlog(`[quickUpload] picked side=${side}, isFileInput=${isFileInput}, fileSel=${fileSel}, fromPopup=${fromPopup}`);
    if (!fileSel) {
      setError("未识别到文件上传框（input[type=file]），请点击上传按钮或上传区域");
      setTimeout(() => {
        if (quickUploadModeRef.current) {
          window.electronAPI?.viewStartPicking(side);
        }
      }, 200);
      return;
    }
    // 停止拾取
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    window.electronAPI?.popupStopPicking("left").catch(() => {});
    window.electronAPI?.popupStopPicking("right").catch(() => {});

    // 解析 base64 和 mime
    const commaIdx = fileData.dataUrl.indexOf(",");
    const mime = (commaIdx >= 0 ? fileData.dataUrl.slice(5, commaIdx).split(";")[0] : "") || "application/octet-stream";
    const b64 = commaIdx >= 0 ? fileData.dataUrl.slice(commaIdx + 1) : "";

    try {
      const result = fromPopup
        ? await window.electronAPI?.popupQuickUpload(side, fileSel, fileData.filename, mime, b64)
        : await window.electronAPI?.viewQuickUpload(side, fileSel, fileData.filename, mime, b64);
      if (result?.ok) {
        setSuccessToast(`已上传：${result.name}（${(result.size || 0) / 1024 >= 1 ? ((result.size || 0) / 1024).toFixed(1) + " KB" : (result.size || 0) + " B"}）`);
      } else {
        setError(`直传失败：${result?.reason || result?.error || "未知原因"}`);
      }
    } catch (e) {
      setError(`直传失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setQuickUploadMode(false);
      quickUploadFileRef.current = null;
    }
  }, [cancelQuickUpload, setError, setSuccessToast]);

  /** 绑定上传模式下拾取到元素：识别 file input → 弹确认对话框 */
  const handleUploadBindPick = useCallback((side: "left" | "right", info: PickedElementInfo) => {
    const isFileInput = info.tag === "input" && (info.type || "").toLowerCase() === "file";
    const fileSel = isFileInput ? info.selector : (info.fileInputSelector || "");
    const accept = isFileInput ? (info.accept || "") : (info.fileInputAccept || "");
    rlog(`[uploadBind] picked side=${side}, isFileInput=${isFileInput}, fileSel=${fileSel}`);
    if (!fileSel) {
      setError("未识别到文件上传框（input[type=file]），请点击上传按钮或上传区域");
      // 保持模式继续拾取
      setTimeout(() => {
        if (uploadBindModeRef.current) {
          window.electronAPI?.viewStartPicking(side);
        }
      }, 200);
      return;
    }
    // 停止拾取，弹确认对话框
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    const sourceMark = uploadBindSourceMarkIdRef.current
      ? pickedMarksRef.current.find((m) => m.id === uploadBindSourceMarkIdRef.current)
      : null;
    setUploadBindDraft({
      side,
      selector: fileSel,
      clickedSelector: info.selector,
      label: info.label || info.tag || "上传框",
      accept,
      sourceMarkId: uploadBindSourceMarkIdRef.current,
      sourceLabel: sourceMark?.label || "最近一次提取的文件",
    });
  }, [setError]);

  /** 确认绑定上传：生成 docUpload 步骤 mark */
  const confirmUploadBind = useCallback((opts: { compressKb: number; format: string }) => {
    const draft = uploadBindDraft;
    if (!draft) return;
    const workflow: "entry" | "review" = draft.side === "left" ? "entry" : "review";
    addPickedMark({
      side: draft.side,
      source: "web",
      selector: draft.selector,
      label: `文件上传 · ${draft.label}${opts.compressKb > 0 ? `（压到 ${opts.compressKb}KB）` : ""}`,
      workflow,
      action: "click",
      recordId: selected?.record_id,
      docUpload: true,
      uploadSourceMarkId: draft.sourceMarkId || undefined,
      uploadCompressKb: opts.compressKb > 0 ? opts.compressKb : undefined,
      uploadFormat: opts.format !== "original" ? opts.format : undefined,
      uploadAccept: draft.accept || undefined,
    });
    setSuccessToast(`已添加文件上传步骤：${draft.label}${opts.compressKb > 0 ? `，上传前压缩到 ${opts.compressKb}KB` : ""}`);
    setUploadBindMode(false);
    setUploadBindSourceMarkId(null);
    setUploadBindDraft(null);
  }, [uploadBindDraft, selected, addPickedMark, setSuccessToast]);

  /** 网页提取点击处理：记录导航点击步骤，区分开头(pre)和收尾(post)点击 */
  const handleDocExtractClick = useCallback(async (side: "left" | "right", info: PickedElementInfo) => {
    const curPhase = docWebStatusRef.current?.phase;
    const isPostPhase = curPhase === "post-click";
    rlog(`[docExtractClick] side=${side}, tag=${info.tag}, selector=${info.selector}, phase=${isPostPhase ? "post" : "pre"}`);
    const workflow: "entry" | "review" = side === "left" ? "entry" : "review";
    addPickedMark({
      side,
      source: "web",
      selector: info.selector,
      label: isPostPhase
        ? `文件提取过程点击 · ${info.label || info.tag || "元素"}`
        : `文件提取点击 · ${info.label || info.tag || "元素"}`,
      workflow,
      action: "click",
      recordId: selected?.record_id,
      rect: info.rect,
      tag: info.tag,
      type: info.type,
      docExtractClick: true,
      docExtractClickPhase: isPostPhase ? "mid" : "pre",
      clickPhase: isPostPhase ? "mid" : "pre",
      inPopup: !!info.fromPopup,
    });
    // 真实点击该元素（让网页导航/响应）
    // ⚠️ 必须 await：performRealClick 内部 el.click() 产生的合成 click 事件，
    // 若此时 viewStartPicking 已重新注入 picker（__cinsidePickerActive=true），
    // 合成 click 会被 picker 的 onPick 拦截导致点击失效。
    if (info.selector) await performRealClick(side, info.selector, !!info.fromPopup);
    if (!isPostPhase) {
      // 开头点击阶段：重新激活下载捕获（上一次点击可能未触发下载，保持捕获状态）
      window.electronAPI?.setDownloadCapture(side, true).catch(() => {});
    }
    // 多次延迟重启picking，覆盖页面导航/慢加载场景，避免光标消失
    ensureDocExtractPicking(side);
    // 弹窗内点击也要保持picking
    if (info.fromPopup) {
      [400, 1000, 2000].forEach((delay) => {
        setTimeout(() => {
          if (addingDocExtractModeRef.current && docExtractSourceRef.current === "web") {
            const phase = docWebStatusRef.current?.phase;
            if (phase === "post-click" || phase === "idle" || phase === "downloading") {
              window.electronAPI?.popupStartPicking(side).catch(() => {});
            }
          }
        }, delay);
      });
    }
  }, [selected, addPickedMark, performRealClick, ensureDocExtractPicking]);

  /** 文件提取拾取处理：拿到图片/PDF URL → 记录步骤 → 调后端 OCR → 弹审查面板 */
  const handleDocExtractPick = useCallback(async (side: "left" | "right", info: PickedElementInfo) => {
    const url = info.src || info.href || "";
    rlog(`[docExtract] side=${side}, url=${url}, tag=${info.tag}`);
    if (!url || !/^https?:\/\//.test(url)) {
      setError("请点击图片（IMG）或 PDF/文件链接（A），未识别到可提取的文件地址");
      // 保持模式继续拾取
      setTimeout(() => {
        if (addingDocExtractModeRef.current) {
          window.electronAPI?.viewStartPicking(side);
        }
      }, 200);
      return;
    }
    const workflow: "entry" | "review" = side === "left" ? "entry" : "review";
    // 记录为循环体步骤：左侧=录入提取，右侧=审查提取
    addPickedMark({
      side,
      source: "web",
      selector: info.selector,
      label: `文件提取 · ${info.label || info.tag || "文档"}`,
      workflow,
      action: "click",
      recordId: selected?.record_id,
      rect: info.rect,
      tag: info.tag,
      type: info.type,
      docExtract: true,
      docSource: "web",
      docUrl: url,
    });
    // 目标字段：优先只提取「提取元素」面板绑定 Excel 列的元素，否则回退 mappings / 默认证件字段
    const targetFields = computeDocTargetFields(mappings);
    // 调后端提取并弹审查面板（异步，不阻塞继续拾取）
    api.extractDocumentUrl(url, targetFields)
      .then((result) => {
        // 内联构建对比条目（避免前向引用 buildDocEntries）
        const norm = (s: string) => (s || "").trim().toLowerCase().replace(/\s+/g, "");
        const entries: DocCompareEntry[] = targetFields.map((f) => {
          const leftVal = selected?.fields?.[f] || "";
          const rightVal = result.fields[f] || "";
          const l = norm(leftVal);
          const r = norm(rightVal);
          let match: FieldMatch = "mismatch";
          if (!r) match = "missing";
          else if (!l) match = "unknown";
          else if (l === r) match = "match";
          else if (l.includes(r) || r.includes(l)) match = "partial";
          return {
            field: f,
            label: FIELD_LABELS[f] || f,
            left_value: leftVal,
            right_value: rightVal,
            match,
          };
        });
        // 同步更新文件处理面板（验证报告 > 文件处理 + 提取元素）
        // 追加到当前卡片的文件列表（支持多文件 TAB 切换）
        // 内存保护：有裁剪图时 source/file_url 只存文件名（去重/类型判断用），不存原图 dataUrl
        const hasProc = !!result.processed_image;
        const newExtract: DocExtractState = {
          filename: result.filename,
          method: result.method,
          text: result.text,
          fields: result.fields,
          entries,
          source: hasProc ? (result.filename || url) : url,
          file_url: hasProc ? (result.filename || url) : url,
          processed_image: result.processed_image,
          mrz_warnings: result.mrz_warnings,
          fallback: result.fallback,
        };
        const rid = selected?.record_id || "_default";
        setDocExtractsByRecord((prev) => {
          const arr = prev[rid] || [];
          // 同名同URL的文件不重复添加
          const filtered = arr.filter((e) => e.file_url !== newExtract.file_url || e.filename !== newExtract.filename);
          return { ...prev, [rid]: [...filtered, newExtract] };
        });
        setActiveDocIndex(999); // 切到最新（会被 safeDocIndex 钳制到最后一项）
        setDocSignal((s) => s + 1);
        setDocExtractPanel({
          imageUrl: toPreviewImageUrl(url, result.processed_image),
          filename: result.filename,
          method: result.method,
          text: result.text,
          fields: result.fields,
          side,
          workflow,
          fallback: result.fallback,
          sourceDataUrl: url,
          targetFields,
          altResult: null,
        });
        setDocExtractActiveTab("primary");
        rlog(`[docExtract] 提取完成: ${result.filename} (${result.method})`);
      })
      .catch((e) => {
        setError(`文件提取失败: ${e instanceof Error ? e.message : String(e)}`);
      });
    // 保持文件提取模式，继续右侧拾取
    setTimeout(() => {
      if (addingDocExtractModeRef.current) {
        window.electronAPI?.viewStartPicking("right");
      }
    }, 200);
  }, [mappings, selected, addPickedMark, setError, computeDocTargetFields]);

  // ============ 查找同名图片：按当前记录姓名在左右网页查找匹配图片，左右对比 ============
  const [sameNameImages, setSameNameImages] = useState<{ left: string[]; right: string[] } | null>(null);
  const [findingSameName, setFindingSameName] = useState(false);
  const findSameNameImages = useCallback(async () => {
    if (!window.electronAPI) return;
    const name = (
      selected?.fields?.name ||
      docExtractPanel?.fields?.name ||
      [docExtractPanel?.fields?.surname, docExtractPanel?.fields?.given_name].filter(Boolean).join(" ") ||
      ""
    ).trim();
    if (!name) {
      setError("当前无姓名信息，无法查找同名图片");
      return;
    }
    setFindingSameName(true);
    setSameNameImages(null);
    try {
      const script = `(function() {
        var name = ${JSON.stringify(name)};
        var results = [];
        var imgs = document.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) {
          var im = imgs[i];
          var alt = im.alt || '';
          var title = im.title || '';
          var src = '';
          try { src = im.currentSrc || im.src || ''; } catch(e) { src = im.src || ''; }
          var holder = im.closest('td,tr,li,div,figure,a');
          var parentText = holder ? (holder.textContent || '').replace(/\\s+/g, '') : '';
          if (!src) continue;
          if (alt.indexOf(name) >= 0 || title.indexOf(name) >= 0
              || src.indexOf(encodeURIComponent(name)) >= 0
              || parentText.indexOf(name.replace(/\\s+/g, '')) >= 0) {
            if (results.indexOf(src) < 0) results.push(src);
          }
        }
        return results.slice(0, 6);
      })();`;
      const [leftRes, rightRes] = await Promise.all([
        window.electronAPI.viewExecuteJS("left", script).catch(() => []),
        window.electronAPI.viewExecuteJS("right", script).catch(() => []),
      ]);
      setSameNameImages({
        left: Array.isArray(leftRes) ? leftRes : [],
        right: Array.isArray(rightRes) ? rightRes : [],
      });
      rlog(`[sameName] 姓名="${name}" 左侧找到 ${Array.isArray(leftRes) ? leftRes.length : 0} 张, 右侧 ${Array.isArray(rightRes) ? rightRes.length : 0} 张`);
    } catch (e) {
      setError(`查找同名图片失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFindingSameName(false);
    }
  }, [selected, docExtractPanel, setError]);

  // 点击阶段显示标签
  const clickPhaseLabel = useCallback((phase: "pre" | "mid" | "post") => {
    return phase === "post" ? "收尾点击" : phase === "mid" ? "过程点击" : "前置点击";
  }, []);

  // 开始添加点击按钮：phase=pre(前置点击/搜索进入，步骤3) / mid(过程点击/点击NEXT等，步骤4) / post(收尾点击/保存返回，步骤5)
  // 支持 toggle：若当前已在相同phase的点击模式，则退出所有设置模式
  const startAddClickStep = useCallback((phase: "pre" | "mid" | "post" = "pre", side?: "left" | "right" | "both") => {
    // Toggle：如果已在相同phase的点击添加模式，退出所有
    if (addingClickModeRef.current && addingClickPhaseRef.current === phase) {
      rlog(`[startAddClickStep] 已在${phase}点击模式，退出所有设置模式`);
      exitAllSetupModes();
      return;
    }
    // 先退出所有其他模式（互斥）
    exitAllSetupModes();
    rlog(`[startAddClickStep] 激活添加${phase === "pre" ? "前置" : phase === "mid" ? "过程" : "收尾"}点击按钮模式（两侧皆可）`);
    setAddingClickMode(true);
    setAddingClickPhase(phase);
    setNextClickLabel(phase === "pre" ? "前置点击" : phase === "mid" ? "过程点击" : "收尾点击");
    setPendingAction("click");
    setPickTarget(null);
    // 前置/过程点击模式下同时开启下载捕获：点击到下载元素时自动打开文件处理预览
    if (phase === "pre" || phase === "mid") {
      window.electronAPI?.setDownloadCapture("left", true).catch(() => {});
      window.electronAPI?.setDownloadCapture("right", true).catch(() => {});
      rlog(`[startAddClickStep] ${phase}点击模式：已开启下载捕获（点击下载会自动开文件预览）`);
    }
    setTimeout(() => {
      if (addingClickModeRef.current) {
        // 默认两侧都激活，用户想点哪侧就点哪侧；若显式传 side 则只激活那一侧
        if (!side || side === "both" || side === "left") window.electronAPI?.viewStartPicking("left");
        if (!side || side === "both" || side === "right") window.electronAPI?.viewStartPicking("right");
      }
    }, 300);
  }, [exitAllSetupModes]);

  // 退出添加点击按钮模式
  const exitAddClickMode = useCallback(() => {
    setAddingClickMode(false);
    setAddingClickPhase(null);
    setNextClickLabel(null);
    setPendingAction("none");
    setPickTarget(null);
    // 关闭下载捕获（前置/过程点击模式开启的）
    window.electronAPI?.setDownloadCapture("left", false).catch(() => {});
    window.electronAPI?.setDownloadCapture("right", false).catch(() => {});
  }, []);

  // 教学完成：把 pickedMarks 按当前 appMode 保存为模板
  const finishTeaching = useCallback(() => {
    // 智能分类：带clickPhase(pre/mid/post)的点击归入dataSource，其余按workflow字段分类
    const dataSourceMarks = pickedMarks.filter((m) =>
      (m.action === "click" || m.action === "input") &&
      (m.clickPhase === "pre" || m.clickPhase === "mid" || m.clickPhase === "post" || m.workflow === "data-source")
    );
    const reviewMarks = pickedMarks.filter((m) => !m.clickPhase && m.workflow === "review");
    const entryMarks = pickedMarks.filter((m) => !m.clickPhase && m.workflow === "entry");
    // LOOP 模式：检查是否包含以 Excel 变量作为输入的搜索步骤
    const hasSearchSteps = pickedMarks.some(
      (m) => m.action === "input" && !!m.variableField
    );
    // 录入流：检查是否包含提交步骤（最后一个 click 动作视为提交）
    const hasSubmitStep = entryMarks.some((m) => m.action === "click");
    if (appMode === "loop" && !hasSearchSteps) {
      setError("警告：教学流程中未检测到搜索步骤，批量执行时可能无法定位其他学生。建议在 LOOP 中先选中 Excel 列，再点击网页输入框并点击搜索按钮。");
    }
    if (appMode === "entry" && !hasSubmitStep) {
      setError("警告：录入流教学未检测到点击保存/提交按钮的步骤，批量执行时不会自动提交。建议在教学末尾按空格+点保存按钮。");
    }
    const tpl: WorkflowTemplate = {
      id: `tpl-${Date.now()}`,
      name: `${appMode === "entry" ? "录入" : "LOOP"}模板 ${new Date().toLocaleString("zh-CN")}`,
      createdAt: Date.now(),
      sourceRecordId: selected?.record_id,
      mode: appMode,
      dataSourceMarks,
      reviewMarks,
      entryMarks,
      hasSearchSteps,
      hasSubmitStep,
    };
    setWorkflowTemplate(tpl);
    workflowTemplateRef.current = tpl; // 同步更新 ref，确保立即可读
    lastTemplateRef.current = tpl; // 持久化保存，防止被状态重置清空
    setTeachingPhase("done");
    // 退出所有拾取/教学模式
    setPendingAction("none");
    setInputTarget(null);
    setBindInputSide(null);
    setNextClickLabel(null);
    setAddingStepMode(null);
    setAddingClickMode(false);
    setPickTarget(null);
    setRightPicked(null);
    setLeftPicked(null);
    setSelectMode(false);
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    window.electronAPI?.viewClearHighlight("left").catch(() => {});
    window.electronAPI?.viewClearHighlight("right").catch(() => {});
    if (avatarMode) exitAvatarMode();
    // 若是从"自定义（勾选卡片）"入口进入的教学，完成后把 LOOP 关联到勾选的卡片
    if (checkedIds.size > 0) {
      // 持久化保存 tpl 到 skills 列表，确保后续游标运行时 getSkillById 能找到
      // （第二批教学完成会覆盖 workflowTemplateRef，第一批的 tpl 必须持久化才能保留）
      saveSkill(tpl);
      setSkillVersion((v) => v + 1);
      const now = Date.now();
      setCardLoopMap((prev) => {
        const next = { ...prev };
        checkedIds.forEach((id) => {
          next[id] = { loopId: tpl.id, loopName: tpl.name, setAt: now };
        });
        return next;
      });
    }
    return tpl;
  }, [pickedMarks, selected, selectMode, avatarMode, setError, appMode, checkedIds]);

  // 教学模式向导：完成教学并立即开始 LOOP 批量执行
  const finishTeachingAndRunBatch = useCallback(() => {
    const tpl = finishTeaching();
    // 直接把模板传给 runBatch，不等 React state commit，彻底消除竞态
    if (tpl && runBatchRef.current) {
      console.log("[finishTeachingAndRunBatch] 直接调用 runBatch(tpl)");
      // 若是从"自定义（勾选卡片）"入口进入的教学，只跑勾选的卡片
      const ids = checkedIds.size > 0 ? Array.from(checkedIds) : undefined;
      runBatchRef.current(tpl, ids);
    } else {
      console.error("[finishTeachingAndRunBatch] tpl 或 runBatchRef.current 为空!", !!tpl, !!runBatchRef.current);
    }
  }, [finishTeaching, checkedIds]);

  /**
   * 收集「提取元素」面板中已配置（内容+关联元素齐全）但未点「保存为步骤」的条目，转为步骤 marks
   * 按创建时间 FIFO 排序，保证先设置的先执行；保存 LOOP / 保存到批次时自动收纳，同一网站只需手动记录一次
   * 注意：新步骤一律插在收尾点击之前，收尾点击重新编号排最后，保证 LOOP 始终以收尾点击闭环
   */
  const collectPendingExtractMarks = useCallback((): {
    extraMarks: PickedMark[];
    pendingEntries: CustomTextEntry[];
    /** 收纳后用于构建模板/同步状态的完整 marks（新步骤插在收尾点击前） */
    marksWithExtras: PickedMark[];
    /** 收纳条目对应的字段映射（模板自包含 mappings 用） */
    pendingMappings: FieldMapping[];
  } => {
    const pendingEntries = customTextEntries
      .filter((e) => !e.saved && e.text && e.selector)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    if (pendingEntries.length === 0) {
      return { extraMarks: [], pendingEntries, marksWithExtras: pickedMarks, pendingMappings: [] };
    }
    const stepType = currentLoopStepTypeRef.current;
    const isEntryStep = stepType === "entry";
    const nowTs = Date.now();
    // 收尾点击必须保持最后：新步骤排在非收尾步骤之后、收尾点击之前
    const isPostClick = (m: PickedMark) => m.action === "click" && m.clickPhase === "post";
    const nonPost = pickedMarks.filter((m) => !isPostClick(m));
    const postMarks = pickedMarks.filter(isPostClick);
    const baseOrder = nonPost.reduce((max, m) => Math.max(max, m.order ?? 0), 0);
    const extraMarks: PickedMark[] = pendingEntries.map((entry, i) => ({
      id: `mk-${nowTs}-auto-${i}-${Math.random().toString(36).slice(2, 7)}`,
      order: baseOrder + i + 1,
      createdAt: nowTs,
      side: "right" as const,
      source: entry.excelField ? ("excel" as const) : ("web" as const),
      selector: entry.selector!,
      label: entry.excelField
        ? `${isEntryStep ? "录入" : "审查"} · ${entry.label || entry.selector} ← Excel「${entry.excelField}」`
        : `${isEntryStep ? "录入" : "审查"} · ${entry.label || entry.selector} ← 固定值「${entry.text}」`,
      value: entry.text,
      workflow: stepType,
      action: (isEntryStep ? "input" : "pick") as "input" | "pick",
      recordId: selected?.record_id,
      tag: "",
      type: "",
      inputTarget: isEntryStep ? entry.selector : undefined,
      inputTargetLabel: isEntryStep ? (entry.label || entry.selector) : undefined,
      // 绑定 Excel 列：LOOP 运行时按当前卡片行的该列取值（executeMark 变量替换）
      variableField: isEntryStep && entry.excelField ? entry.excelField : undefined,
      excelField: entry.excelField || undefined,
    }));
    // 收尾点击重新编号到新步骤之后（保持彼此相对顺序）
    const renumberedPosts = postMarks.map((m, j) => ({ ...m, order: baseOrder + extraMarks.length + j + 1 }));
    const marksWithExtras = [...nonPost, ...extraMarks, ...renumberedPosts];
    const pendingMappings: FieldMapping[] = pendingEntries.map((entry) => ({
      right_selector: entry.selector!,
      right_label: entry.label || entry.selector!,
      right_input_type: entry.type || null,
      left_source: entry.excelField ? "excel" : "manual",
      left_field: entry.excelField || entry.text,
      verify_method: "smart",
      web_side: entry.side || "right",
    }));
    return { extraMarks, pendingEntries, marksWithExtras, pendingMappings };
  }, [customTextEntries, pickedMarks, selected]);

  /** 映射合并：按 right_selector 去重（后者覆盖前者） */
  const mergeMappings = (base: FieldMapping[], extra: FieldMapping[]): FieldMapping[] => {
    if (extra.length === 0) return base;
    const next = [...base];
    for (const m of extra) {
      const idx = next.findIndex((x) => x.right_selector === m.right_selector);
      if (idx >= 0) next[idx] = m;
      else next.push(m);
    }
    return next;
  };

  /** 把自动收纳的提取元素条目同步到映射列表，并标记为已保存（面板中保留显示） */
  const markPendingEntriesSaved = useCallback((pendingEntries: CustomTextEntry[], pendingMappings: FieldMapping[]) => {
    if (pendingEntries.length === 0) return;
    setMappings((prev) => mergeMappings(prev, pendingMappings));
    const savedIds = new Set(pendingEntries.map((e) => e.id));
    setCustomTextEntries((prev) => prev.map((e) => (savedIds.has(e.id) ? { ...e, saved: true } : e)));
  }, []);

  /**
   * 保存当前步骤配置到这批勾选的卡片（分割批次用）
   * - 构建当前 pickedMarks 为 tpl 并持久化到 skills 列表
   * - 把 tpl 关联到勾选的卡片（cardLoopMap），触发自动聚拢排序
   * - 清空 pickedMarks 但保留教学状态，方便用户继续为下一批卡片配置新步骤
   */
  const handleSaveToBatch = useCallback(() => {
    if (checkedIds.size === 0) {
      setError("请先勾选一批卡片再保存");
      return;
    }
    // 自动收纳「提取元素」面板中未保存的条目（FIFO，插在收尾点击之前）
    const { pendingEntries, marksWithExtras, pendingMappings } = collectPendingExtractMarks();
    const allMarks = marksWithExtras;
    if (allMarks.length === 0) {
      setError("请先配置至少一个步骤再保存");
      return;
    }
    // 构建模板（复用 buildTemplateFromMarks 的分类逻辑）
    const dataSourceMarks = allMarks.filter((m) =>
      (m.action === "click" || m.action === "input") &&
      (m.clickPhase === "pre" || m.clickPhase === "mid" || m.clickPhase === "post" || m.workflow === "data-source")
    );
    const reviewMarks = allMarks.filter((m) => !m.clickPhase && m.workflow === "review");
    const entryMarks = allMarks.filter((m) => !m.clickPhase && m.workflow === "entry");
    const hasSearchSteps = allMarks.some((m) => m.action === "input" && !!m.variableField);
    const hasSubmitStep = entryMarks.some((m) => m.action === "click");
    const tpl: WorkflowTemplate = {
      id: `tpl-${Date.now()}`,
      name: `LOOP批次 ${new Date().toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
      createdAt: Date.now(),
      sourceRecordId: selected?.record_id,
      mode: appMode,
      dataSourceMarks,
      reviewMarks,
      entryMarks,
      mappings: (() => {
        const merged = mergeMappings(mappings, pendingMappings);
        return merged.length > 0 ? merged : undefined;
      })(),
      hasSearchSteps,
      hasSubmitStep,
    };
    // 持久化保存 tpl（确保游标运行时 getSkillById 能找到）
    saveSkill(tpl);
    setSkillVersion((v) => v + 1);
    // 提取元素条目：同步映射 + 标记已保存
    markPendingEntriesSaved(pendingEntries, pendingMappings);
    // 关联到勾选的卡片
    const now = Date.now();
    setCardLoopMap((prev) => {
      const next = { ...prev };
      checkedIds.forEach((id) => {
        next[id] = { loopId: tpl.id, loopName: tpl.name, setAt: now };
      });
      return next;
    });
    setSuccessToast(`已保存到 ${checkedIds.size} 张卡片：${tpl.name}`);
    // 清空步骤标记和勾选，重置教学交互状态到idle，方便选下一批重新开始配置
    // 注意：selectedExcelColumn/cardsGenerated 等全局配置保留，不需要每批重选
    setPickedMarks([]);
    setMappings([]);
    setCheckedIds(new Set());
    setTeachingPhase("idle");
    setSelectMode(false);
    setPickTarget(null);
    setRightPicked(null);
    setLeftPicked(null);
    setWorkflowTemplate(null);
    setPendingAction("none");
    setAvatarMode(false);
    setBindInputSide(null);
    setNextClickLabel(null);
    setAddingStepMode(null);
    setAddingClickMode(false);
    setAddingClickPhase(null);
    setAddingDocExtractMode(false);
  }, [checkedIds, pickedMarks, cardLoopMap, selected, appMode, mappings, setError, setSuccessToast, collectPendingExtractMarks, markPendingEntriesSaved]);

  // ============ SKILL 保存与执行 ============
  const buildTemplateFromMarks = useCallback((
    name: string,
    icon?: string,
    opts?: { marks?: PickedMark[]; mappings?: FieldMapping[] }
  ): WorkflowTemplate => {
    // 智能分类：带clickPhase(pre/post)的点击归入dataSource，其余按workflow字段分类
    const allMarks = opts?.marks ?? pickedMarks;
    const tplMappings = opts?.mappings ?? mappings;
    const dataSourceMarks = allMarks.filter((m) =>
      (m.action === "click" || m.action === "input") &&
      (m.clickPhase === "pre" || m.clickPhase === "mid" || m.clickPhase === "post" || m.workflow === "data-source")
    );
    const reviewMarks = allMarks.filter((m) => !m.clickPhase && m.workflow === "review");
    const entryMarks = allMarks.filter((m) => !m.clickPhase && m.workflow === "entry");
    const hasSearchSteps = allMarks.some((m) => m.action === "input" && !!m.variableField);
    const hasSubmitStep = entryMarks.some((m) => m.action === "click");
    return {
      id: `skill-${Date.now()}`,
      name,
      icon: icon || "🔍",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceRecordId: selected?.record_id,
      mode: appMode,
      dataSourceMarks,
      reviewMarks,
      entryMarks,
      mappings: tplMappings.length > 0 ? tplMappings : undefined,
      // 提取元素面板条目随模板保存：分享密钥/应用模板后完整复现（含 Excel 列绑定）
      customTextEntries: customTextEntries.length > 0 ? customTextEntries : undefined,
      hasSearchSteps,
      hasSubmitStep,
    };
  }, [pickedMarks, selected, appMode, mappings, customTextEntries]);

  const handleSaveSkill = useCallback((name: string, icon: string, runAfter?: boolean) => {
    // 自动收纳「提取元素」面板中已配置但未保存的条目（FIFO，插在收尾点击之前），确保保存的 LOOP 模板包含全部步骤
    const { extraMarks, pendingEntries, marksWithExtras, pendingMappings } = collectPendingExtractMarks();
    const mergedMappings = mergeMappings(mappings, pendingMappings);
    const tpl = buildTemplateFromMarks(name, icon, { marks: marksWithExtras, mappings: mergedMappings });
    const saved = saveSkill(tpl);
    // 同步状态：marks 入库（含收尾点击重新编号）+ 条目标记已保存
    if (extraMarks.length > 0) {
      setPickedMarks(marksWithExtras);
      markPendingEntriesSaved(pendingEntries, pendingMappings);
    }
    setWorkflowTemplate(saved);
    workflowTemplateRef.current = saved; // 同步更新 ref
    lastTemplateRef.current = saved; // 持久化保存
    setTeachingPhase("done");
    setPendingAction("none");
    setInputTarget(null);
    setBindInputSide(null);
    setNextClickLabel(null);
    setAddingStepMode(null);
    setAddingClickMode(false);
    setPickTarget(null);
    setRightPicked(null);
    setLeftPicked(null);
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    window.electronAPI?.viewClearHighlight("left").catch(() => {});
    window.electronAPI?.viewClearHighlight("right").catch(() => {});
    setSelectMode(false);
    if (avatarMode) exitAvatarMode();
    setShowSaveSkill(false);
    setSkillVersion((v) => v + 1);
    if ((runAfter ?? saveSkillRunAfter) && runBatchRef.current) {
      runBatchRef.current(saved);
    }
    setSaveSkillRunAfter(false);
  }, [buildTemplateFromMarks, selectMode, avatarMode, exitSelectMode, exitAvatarMode, saveSkillRunAfter, collectPendingExtractMarks, markPendingEntriesSaved]);

  /** 快速保存 Loop：自动命名，不弹窗 */
  const handleQuickSaveLoop = useCallback(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const autoName = `Loop_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    handleSaveSkill(autoName, "🔄");
  }, [handleSaveSkill]);

  const handleRunSkill = useCallback((tpl: WorkflowTemplate) => {
    setWorkflowTemplate(tpl);
    workflowTemplateRef.current = tpl; // 同步更新 ref
    lastTemplateRef.current = tpl; // 持久化保存
    setTeachingPhase("done");
    setShowSkillPanel(false);
    // 若是从"适配LOOP到勾选卡片"入口打开的，只跑勾选的卡片
    const ids = adaptLoopToCheckedRef.current ? Array.from(checkedIds) : undefined;
    // 适配入口下，同时把 LOOP 关联到勾选的卡片（触发自动聚拢排序）
    if (adaptLoopToCheckedRef.current && ids) {
      const now = Date.now();
      setCardLoopMap((prev) => {
        const next = { ...prev };
        ids.forEach((id) => {
          next[id] = { loopId: tpl.id, loopName: tpl.name, setAt: now };
        });
        return next;
      });
    }
    adaptLoopToCheckedRef.current = false;
    if (runBatchRef.current) {
      runBatchRef.current(tpl, ids);
    }
  }, [checkedIds]);

  /**
   * 应用已保存的 LOOP 模板到当前步骤设置：
   * 清空现有步骤与映射，加载模板中的所有 marks 和 mappings，
   * 自动进入设置模式以便用户查看/编辑步骤。
   */
  const handleApplyLoop = useCallback((tpl: WorkflowTemplate) => {
    setShowApplyLoop(false);
    // 清空当前工作区（退出拾取模式、清空高光、步骤、映射等）
    refreshWorkspace();
    // 切换到模板对应的模式
    setAppMode(tpl.mode);
    // 合并模板中的所有步骤，重新编号 order 和生成新 id（避免与历史状态冲突）
    const now = Date.now();
    const mergedMarks: PickedMark[] = [
      ...tpl.dataSourceMarks,
      ...tpl.reviewMarks,
      ...tpl.entryMarks,
    ].map((m, i) => ({
      ...m,
      id: `mk-${now}-${i}`,
      order: i + 1,
    }));
    setPickedMarks(mergedMarks);
    // 恢复字段映射
    if (tpl.mappings && tpl.mappings.length > 0) {
      setMappings(tpl.mappings);
    }
    // 恢复提取元素面板条目（自定义文本 + 文件提取字段，含 Excel 列绑定）
    if (tpl.customTextEntries && tpl.customTextEntries.length > 0) {
      setCustomTextEntries(tpl.customTextEntries);
    }
    // 同步当前工作模板引用（便于后续保存/运行）
    setWorkflowTemplate(tpl);
    workflowTemplateRef.current = tpl;
    lastTemplateRef.current = tpl;
    setSuccessToast(`已应用 LOOP 模板：${tpl.name}（${mergedMarks.length} 个步骤）`);
  }, [refreshWorkspace, setSuccessToast]);

  /**
   * 勾选卡片后点"自定义"：进入「步骤设置 · 元素选择」模式
   * 以勾选的第一张卡片作为教学样本（selectedId 切到它，输入框绑定时填入它的数据）
   * 教学完成后（finishTeaching）自动把 LOOP 关联到这批勾选的卡片
   */
  const handleRunCheckedLoop = useCallback(() => {
    if (checkedIds.size === 0) return;
    // 按卡片池当前顺序取勾选的第一张卡作为教学样本
    const firstChecked = cardRecords.find((r) => checkedIds.has(r.record_id));
    if (!firstChecked) {
      setError("未找到勾选的卡片");
      return;
    }
    // 切到第一张勾选卡作为教学样本
    setSelectedId(firstChecked.record_id);
    // 启动教学（步骤设置模式），以该卡为样本，重置教学交互状态
    // 注意：selectedExcelColumn 是全局LOOP列配置，保留不重置；cards 已存在无需重复生成
    setPickedMarks([]);
    setMappings([]);
    setTeachingPhase(appMode === "entry" ? "entry" : "data-source");
    setWorkflowTemplate(null);
    setBatchResults({});
    setError(null);
    setSelectMode(true);
    setCardsGenerated(true);
    // 已选中 LOOP 列时自动切到网页视图，方便拾取网页元素
    if (selectedExcelColumnRef.current && leftViewMode === "excel") {
      setLeftViewMode("web");
      setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
    }
    setPendingAction("none");
    setAvatarMode(false);
    setBindInputSide(null);
    setNextClickLabel(null);
    setAddingStepMode(null);
    setAddingClickMode(false);
    setAddingClickPhase(null);
    setAddingDocExtractMode(false);
    // loop 模式下不限定初始拾取侧（等用户选 Excel 列后绑定输入框）；review 用 right；entry 用 left
    setPickTarget(appMode === "review" ? "right" : appMode === "entry" ? "left" : null);
    setRightPicked(null);
    setLeftPicked(null);
    setSuccessToast(`已进入步骤设置，样本：${firstChecked.fields.name || firstChecked.fields.fullname || firstChecked.fields.passport_no || firstChecked.record_id}（共 ${checkedIds.size} 张勾选）`);
  }, [checkedIds, cardRecords, appMode, setError, setSuccessToast, leftViewMode]);

  /** 勾选卡片后打开已保存 LOOP 列表，选择适配 */
  const handleAdaptLoopToChecked = useCallback(() => {
    if (checkedIds.size === 0) return;
    adaptLoopToCheckedRef.current = true;
    setShowSkillPanel(true);
  }, [checkedIds]);

  /** 游标运行：跑前 N 张已设置 LOOP 的卡片（按 setAt 升序），多 LOOP 分组串联执行 */
  const handleRunLoopsWithCursor = useCallback(async () => {
    const loopCards = cardRecords.filter((r) => cardLoopMap[r.record_id]);
    if (loopCards.length === 0) {
      setError("请先在群组面板设置 LOOP 再运行");
      return;
    }
    const N = runCursor ?? loopCards.length;
    const targets = loopCards.slice(0, Math.max(1, Math.min(N, loopCards.length)));
    // 按 loopId 分组（保持 setAt 顺序）
    const groups = new Map<string, { tpl: WorkflowTemplate; ids: string[] }>();
    const currentTpl = workflowTemplateRef.current ?? lastTemplateRef.current;
    for (const r of targets) {
      const info = cardLoopMap[r.record_id];
      if (!info) continue;
      const tpl = currentTpl && currentTpl.id === info.loopId
        ? currentTpl
        : getSkillById(info.loopId);
      if (!tpl) continue;
      if (!groups.has(info.loopId)) groups.set(info.loopId, { tpl, ids: [] });
      groups.get(info.loopId)!.ids.push(r.record_id);
    }
    if (groups.size === 0) {
      setError("未找到关联的 LOOP 模板，请重新设置");
      return;
    }
    // 串联执行每组（单组直接调用，多组按顺序执行）
    for (const [, g] of groups) {
      await runBatchRef.current?.(g.tpl, g.ids);
    }
  }, [cardRecords, cardLoopMap, runCursor]);

  /** 清除某张卡片的 LOOP 关联（取消其参与游标运行） */
  const handleClearCardLoop = useCallback((recordId: string) => {
    setCardLoopMap((prev) => {
      const next = { ...prev };
      delete next[recordId];
      return next;
    });
  }, []);

  /** 清除所有卡片的 LOOP 关联 */
  const handleClearAllCardLoops = useCallback(() => {
    setCardLoopMap({});
    setRunCursor(null);
  }, []);

  // 中止教学
  const abortTeaching = useCallback(() => {
    setTeachingPhase("idle");
    setWorkflowTemplate(null);
    setPendingAction("none");
    setInputTarget(null);
    setBindInputSide(null);
    setNextClickLabel(null);
    setAddingStepMode(null);
    setAddingClickMode(false);
    setStartBatchAfterTeaching(false);
    if (selectMode) exitSelectMode();
    if (avatarMode) exitAvatarMode();
  }, [selectMode, avatarMode]);

  // 教学阶段回退（上一步）
  // loop 模式：entry → review → data-source → idle(abort)
  // entry 模式：entry → idle(abort)
  // 回退时清空当前阶段添加的 pickedMarks，保留之前阶段的
  const goBackTeachingPhase = useCallback(() => {
    // 先立即清除网页高亮，避免蓝框残留
    window.electronAPI?.viewClearHighlight("left").catch(() => {});
    window.electronAPI?.viewClearHighlight("right").catch(() => {});
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    // 关闭下载捕获
    window.electronAPI?.setDownloadCapture("left", false).catch(() => {});
    window.electronAPI?.setDownloadCapture("right", false).catch(() => {});
    // 清除文件提取配置状态
    setAddingDocExtractMode(false);
    setDocExtractSource(null);
    setDocLocalFiles([]);
    setDocFileBindField(null);
    // 清空当前阶段的拾取状态和动作模式
    setPendingAction("none");
    setInputTarget(null);
    setBindInputSide(null);
    setNextClickLabel(null);
    setAddingStepMode(null);
    setAddingClickMode(false);
    setRightPicked(null);
    setLeftPicked(null);
    setPickTarget(null);

    setTeachingPhase((cur) => {
      if (cur === "idle" || cur === "done") return cur;

      if (appMode === "entry") {
        // entry 模式：entry → idle（等同 abort，但保留已配置的 marks 以便重新进入）
        // 这里直接 abort
        setWorkflowTemplate(null);
        setPickedMarks([]);
        setBatchResults({});
        if (selectMode) exitSelectMode();
        if (avatarMode) exitAvatarMode();
        return "idle";
      }

      // loop 模式阶段链：data-source → review → entry
      if (cur === "entry") {
        // 回退到 review：清空 entry 阶段的 marks
        setPickedMarks((prev) => prev.filter((m) => m.workflow !== "entry"));
        return "review";
      }
      if (cur === "review") {
        // 回退到 data-source：清空 review 阶段的 marks
        setPickedMarks((prev) => prev.filter((m) => m.workflow !== "review"));
        return "data-source";
      }
      if (cur === "data-source") {
        // 回退到 idle：abort
        setWorkflowTemplate(null);
        setPickedMarks([]);
        setBatchResults({});
        if (selectMode) exitSelectMode();
        if (avatarMode) exitAvatarMode();
        return "idle";
      }
      return cur;
    });
  }, [appMode, selectMode, avatarMode]);

  // 停止批量执行
  const stopBatch = useCallback(() => {
    rlog("[batch] 用户请求停止 LOOP");
    batchStopRef.current = true;
    // 如果正在断点暂停中，resolve Promise 让执行循环能检测到 batchStopRef 并退出
    breakpointResolveRef.current?.();
    breakpointResolveRef.current = null;
    setBreakpointState(null);
    setBatchRunning(false);
  }, []);

  // ============ 开始新 LOOP：完全重置所有 LOOP 相关状态 ============
  // 跑完一个 LOOP 后，用户想跑其他 LOOP 时调用，确保之前的设置/结果不影响后续
  // 保留：Excel 数据（cardRecords）、左侧网页 URL、右侧网页 URL、收藏网站等环境配置
  // 清空：模板、拾取节点、批量结果、报告、日志、核验状态、字段映射、选中卡片
  const startNewLoop = useCallback(() => {
    if (batchRunning) return; // 执行中不允许重置
    setWorkflowTemplate(null);
    workflowTemplateRef.current = null;
    lastTemplateRef.current = null;
    setPickedMarks([]);
    setTeachingPhase("idle");
    setAddingStepMode(null);
    setAddingClickMode(false);
    setBatchResults({});
    setBatchCursor(-1);
    setBatchMarkCursor(null);
    setBatchTargets([]);
    setReport(null);
    setLoopReports([]);
    setResult(null);
    setSteps([]);
    setVerifyStatus("idle");
    setRecordResults({});
    setMappings([]);
    setSelectedId(null);
    setPendingAction("none");
    setInputTarget(null);
    setBindInputSide(null);
    setNextClickLabel(null);
    setPickTarget(null);
    setRightPicked(null);
    setLeftPicked(null);
    setStartBatchAfterTeaching(false);
    setError(null);
    if (selectMode) exitSelectMode();
    if (avatarMode) exitAvatarMode();
    // 清除 BrowserView 上的高亮
    window.electronAPI?.viewClearHighlight("left").catch(() => {});
    window.electronAPI?.viewClearHighlight("right").catch(() => {});
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
  }, [batchRunning, selectMode, avatarMode]);

  // ============ 变量识别：检查 value 是否等于当前卡片的某个字段值 ============
  // 如果是，则记录该字段名，批量执行时自动替换为其他卡片的对应字段值
  const detectVariableField = useCallback(
    (value: string): string | undefined => {
      if (!selected || !value) return undefined;
      const v = String(value).trim();
      if (!v) return undefined;
      // 检查 Excel 字段值
      for (const [field, fv] of Object.entries(selected.fields)) {
        if (fv && String(fv).trim() === v) {
          return field;
        }
      }
      // 检查护照字段
      if (selected.passport_fields) {
        for (const [field, fv] of Object.entries(selected.passport_fields)) {
          if (fv && String(fv).trim() === v) {
            return field;
          }
        }
      }
      return undefined;
    },
    [selected]
  );

  /** 等待下载完成（LOOP 执行时用）：开启捕获 → 等待 download-captured 事件 → 返回文件数据
   *  智能超时：下载未启动 60s 超时；启动后 300s 总超时；有进度时 60s 无新进度才超时。
   *  修复：部分网络环境下（JPG/PNG 等图片、慢网）下载可能明显 >30s，固定 30s 会导致
   *  误超时→触发保底→导航走→下载被干扰→AI Vision 拿不到文件。统一放宽给足容错。
   */
  const waitForDownload = useCallback(async (side: "left" | "right", timeoutMs = 60000): Promise<{ filename: string; dataUrl: string; size: number; mime: string }> => {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      let overallTimer: ReturnType<typeof setTimeout>;
      let downloadStarted = false;
      let lastProgressBytes = -1;

      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(overallTimer);
        removeCaptured?.();
        removeFailed?.();
        removeStarted?.();
        removeProgress?.();
      };
      const onCaptured = (data: { side: string; filename: string; dataUrl: string; size: number; mime: string }) => {
        if (settled || data.side !== side) return;
        settled = true;
        cleanup();
        resolve(data);
      };
      const onFailed = (data: { side: string; filename: string; error?: string; state?: string }) => {
        if (settled || data.side !== side) return;
        settled = true;
        cleanup();
        reject(new Error(`下载失败: ${data.error || data.state || "unknown"}`));
      };
      // 下载已开始：延长总超时到 300s，重置无进度计时器
      const onStarted = (data: { side: string; filename: string }) => {
        if (settled || data.side !== side) return;
        if (!downloadStarted) {
          downloadStarted = true;
          rlog(`[waitForDownload] 下载已开始: ${data.filename}，延长超时至 300s`);
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error("下载超时（启动后60s无新进度）"));
        }, 60000);
      };
      // 下载进度更新：重置无进度计时器
      const onProgress = (data: { side: string; filename: string; received: number; total: number; percent: number }) => {
        if (settled || data.side !== side) return;
        // 只在收到新字节时重置计时器
        if (data.received !== lastProgressBytes) {
          lastProgressBytes = data.received;
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error("下载超时（60s无新进度）"));
          }, 60000);
        }
      };
      const removeCaptured = window.electronAPI?.onDownloadCaptured(onCaptured);
      const removeFailed = window.electronAPI?.onDownloadFailed(onFailed);
      const removeStarted = window.electronAPI?.onDownloadStarted?.(onStarted);
      const removeProgress = window.electronAPI?.onDownloadProgress?.(onProgress);

      // 初始超时：60s 内未检测到下载开始
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("下载超时（60s内未检测到下载）"));
      }, timeoutMs);
      // 总超时兜底：300s 无论如何都超时
      overallTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("下载超时（300s总超时）"));
      }, 300000);

      // 确保下载捕获已开启
      window.electronAPI?.setDownloadCapture(side, true).catch(() => {});
    });
  }, []);

  // 检测并抓取"点击后直接预览图片"的页面（无下载按钮的场景）：
  // 弹窗或同标签页跳转到图片URL时，主动按URL下载，返回文件数据；非直览页返回 null
  const grabDirectPreviewFile = useCallback(async (side: "left" | "right"): Promise<{ filename: string; dataUrl: string; size: number; mime: string } | null> => {
    if (!window.electronAPI) return null;
    // 给页面跳转/弹窗加载留时间
    await new Promise((r) => setTimeout(r, 1500));
    const detectScript = `
      (function() {
        try {
          var ct = (document.contentType || '').toLowerCase();
          var url = location.href;
          var isImgDoc = ct.indexOf('image/') === 0;
          var imgEl = null;
          if (document.body) {
            var visibleKids = [];
            for (var i = 0; i < document.body.children.length; i++) {
              var k = document.body.children[i];
              var tag = (k.tagName || '').toUpperCase();
              if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'META') continue;
              visibleKids.push(k);
            }
            // Chrome 内置图片查看器：body 只含一个 img
            if (visibleKids.length === 1 && (visibleKids[0].tagName || '').toUpperCase() === 'IMG') {
              isImgDoc = true;
              imgEl = visibleKids[0];
            }
            // URL 以图片扩展名结尾且页面仅一张图，也按直览页处理
            if (!isImgDoc && /\\.(jpg|jpeg|png|gif|bmp|webp)([?#].*)?$/i.test(url)) {
              var imgs = document.body.getElementsByTagName('img');
              if (imgs.length === 1) { isImgDoc = true; imgEl = imgs[0]; }
            }
          }
          if (!isImgDoc) return { ok: false };
          var imgUrl = (imgEl && (imgEl.currentSrc || imgEl.src)) || url;
          if (!/^https?:/i.test(imgUrl)) return { ok: false };
          return { ok: true, url: imgUrl };
        } catch(e) { return { ok: false }; }
      })();
    `;
    // 1) 先查弹窗（window.open / target=_blank 打开的图片预览）
    try {
      const popupRes = (await window.electronAPI.popupExecuteJS(side, detectScript)) as { ok?: boolean; url?: string } | undefined;
      if (popupRes && popupRes.ok && popupRes.url) {
        const dl = await window.electronAPI.viewDownloadSingleUrl(side, popupRes.url, 20000);
        if (dl?.ok && dl.dataUrl) {
          window.electronAPI.popupClose(side).catch(() => {});
          return { filename: dl.filename || "image.jpg", dataUrl: dl.dataUrl, size: dl.size || 0, mime: dl.mime || "image/jpeg" };
        }
      }
    } catch { /* 无弹窗或检测失败，继续查主视图 */ }
    // 2) 再查主视图（同标签页跳转到图片）
    try {
      const mainRes = (await window.electronAPI.viewExecuteJS(side, detectScript)) as { ok?: boolean; url?: string } | undefined;
      if (mainRes && mainRes.ok && mainRes.url) {
        const dl = await window.electronAPI.viewDownloadSingleUrl(side, mainRes.url, 20000);
        if (dl?.ok && dl.dataUrl) {
          // 同标签页跳转：抓取后返回上一页，保证 LOOP 后续步骤仍在原页面执行
          window.electronAPI.viewGoBack(side).catch(() => {});
          return { filename: dl.filename || "image.jpg", dataUrl: dl.dataUrl, size: dl.size || 0, mime: dl.mime || "image/jpeg" };
        }
      }
    } catch { /* 检测失败按无直览页处理 */ }
    return null;
  }, []);

  /** ============ 文件提取保底机制 ============ */
  // 从记录中提取用于匹配的关键词（姓名、护照号、学号等）
  const getRecordMatchKeywords = useCallback((record: ApplicantRecord): string[] => {
    const keywords: string[] = [];
    const add = (v: unknown) => {
      if (v == null) return;
      const s = String(v).trim().toLowerCase();
      if (s.length >= 2) keywords.push(s);
    };
    // 优先匹配的字段
    add(record.fields["name"]);
    add(record.fields["passport_no"]);
    add(record.fields["student_id"]);
    add(record.fields["surname"]);
    add(record.fields["given_name"]);
    add(record.fields["id_number"]);
    // 添加护照号的无空格版本
    const passport = String(record.fields["passport_no"] || "").replace(/\s/g, "");
    if (passport.length >= 4) keywords.push(passport.toLowerCase());
    // 姓名拼音（如果有）
    const name = String(record.fields["name"] || "");
    if (/[a-zA-Z]/.test(name)) {
      keywords.push(name.replace(/\s+/g, "").toLowerCase());
    }
    return Array.from(new Set(keywords));
  }, []);

  // 检查文件名是否匹配记录关键词
  const filenameMatchesRecord = useCallback((filename: string, keywords: string[]): boolean => {
    const lower = filename.toLowerCase();
    for (const kw of keywords) {
      if (lower.includes(kw)) return true;
    }
    return false;
  }, []);

  // 对下载的文件进行快速OCR预览，用于匹配（只提取前几页文字，不做完整字段提取）
  const quickPreviewForMatch = useCallback(async (dataUrl: string, filename: string, keywords: string[]): Promise<boolean> => {
    try {
      const file = dataUrlToFile(dataUrl, filename);
      const result = await api.previewDocumentFile(file);
      const text = (result.text_preview || "").toLowerCase();
      if (text) {
        for (const kw of keywords) {
          if (text.includes(kw)) return true;
        }
      }
      return false;
    } catch (e) {
      rlog(`[fallback] 快速预览匹配失败: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }, []);

  // 把当前执行步骤的阶段进展实时写回运行卡片的步骤 detail（下载中/OCR中/保底中…）
  const updateLiveStepDetail = useCallback((note: string) => {
    const prefix = liveStepPrefixRef.current;
    if (!prefix) return;
    setSteps((prev) => {
      for (let k = prev.length - 1; k >= 0; k--) {
        const s = prev[k];
        if (s.description?.startsWith(prefix)) {
          const next = [...prev];
          next[k] = { ...s, detail: note };
          return next;
        }
      }
      return prev;
    });
  }, []);

  // 保底下载：回退到前置页面，扫描所有可下载链接，批量下载，尝试匹配
  const runDocExtractFallback = useCallback(async (
    side: "left" | "right",
    record: ApplicantRecord,
    preClickCount: number
  ): Promise<{ filename: string; dataUrl: string; size: number; mime: string } | "manual-review"> => {
    rlog(`[fallback] 启动文件提取保底机制, side=${side}, preClickCount=${preClickCount}`);

    // 步骤1：更新UI状态为扫描中（并强制展开下面板，让人工能看到保底进展/审查界面）
    setDocWebStatus({ phase: "fallback-scanning", message: "保底机制：回退页面并扫描可下载文件..." });
    setBottomPanelOpen(true);
    updateLiveStepDetail("文件与学生不匹配，保底机制扫描中…");

    // 读取当前页面URL（用于空白页检测）
    const readCurrentUrl = async (): Promise<string> => {
      try {
        const res = await window.electronAPI?.viewExecuteJS(side, "location.href");
        return typeof res === "string" ? res : "";
      } catch { return ""; }
    };
    let backedCount = 0; // 成功回退次数（失败时按此前进恢复，防止网页停在白屏）
    // 前进一步（viewGoForward 可能不存在于旧版本，做了防御）
    const goForwardOnce = async (): Promise<boolean> => {
      try {
        const res = await window.electronAPI?.viewGoForward?.(side);
        return !!res?.ok;
      } catch { return false; }
    };
    // 回退一步；若退成空白页（about:blank/chrome-error）则立即前进一步恢复并停止回退
    const goBackGuarded = async (settleMs: number): Promise<boolean> => {
      try {
        const res = await window.electronAPI?.viewGoBack(side);
        if (!res?.ok) return false;
        backedCount++;
        await new Promise(r => setTimeout(r, settleMs));
        const url = await readCurrentUrl();
        if (!url || url === "about:blank" || url.startsWith("chrome-error")) {
          rlog(`[fallback] 回退到空白页(${url || "empty"})，前进一步恢复并停止回退`);
          await goForwardOnce();
          backedCount = Math.max(0, backedCount - 1);
          await new Promise(r => setTimeout(r, 600));
          return false;
        }
        return true;
      } catch { return false; }
    };
    // 保底失败时：按回退步数前进恢复页面，避免网页停留在白屏导致后续步骤全挂
    const restorePage = async () => {
      rlog(`[fallback] 保底失败，前进恢复页面（回退了 ${backedCount} 步）`);
      for (let i = 0; i < backedCount; i++) {
        if (!(await goForwardOnce())) break;
        await new Promise(r => setTimeout(r, 400));
      }
      backedCount = 0;
    };

    // 步骤2：回退页面（回到开头点击之前的页面）
    // 注意：不是所有click都会导致页面跳转，所以回退步数是近似值
    // 采用策略：先回退preClickCount步，然后逐步额外回退直到找到下载链接或到上限
    let goBackSteps = Math.min(Math.max(preClickCount, 1), 8);
    for (let i = 0; i < goBackSteps; i++) {
      if (!(await goBackGuarded(500))) break;
    }
    // 等待页面稳定
    await new Promise(r => setTimeout(r, 1500));

    // 步骤3：获取页面上所有可下载链接
    let allLinks: Array<{ url: string; text: string; filename?: string }> = [];
    try {
      // 先在当前回退后的页面扫描
      let linksResult = await window.electronAPI?.viewGetDownloadableLinks(side);
      if (linksResult?.ok && linksResult.links) {
        allLinks = allLinks.concat(linksResult.links);
      }
      // 如果链接太少，继续往前回退扫描（最多额外回退4页）
      let extraBack = 0;
      while (allLinks.length < 2 && extraBack < 4) {
        if (!(await goBackGuarded(800))) break;
        linksResult = await window.electronAPI?.viewGetDownloadableLinks(side);
        if (linksResult?.ok && linksResult.links) {
          allLinks = allLinks.concat(linksResult.links);
        }
        extraBack++;
        if (allLinks.length >= 3) break;
      }
    } catch (e) {
      rlog(`[fallback] 获取下载链接失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 去重链接
    const seenUrls = new Set<string>();
    const uniqueLinks = allLinks.filter(l => {
      if (seenUrls.has(l.url)) return false;
      seenUrls.add(l.url);
      return true;
    });

    rlog(`[fallback] 找到 ${uniqueLinks.length} 个可下载链接`);

    if (uniqueLinks.length === 0) {
      setDocWebStatus({ phase: "error", message: "保底机制：未找到任何可下载文件" });
      await restorePage();
      throw new Error("保底机制失败：未找到任何可下载文件");
    }

    // 步骤4：批量下载候选文件（限 5 个：页面附件链接往往含导航/头像/图标等噪音，
    // 全量下载既慢又让每个候选文件的 dataUrl 驻留内存——假死/反复触发时是内存堆积主因）
    const downloadCandidates = uniqueLinks.slice(0, 5);
    setDocWebStatus({ phase: "fallback-downloading", total: downloadCandidates.length, current: 0 });
    updateLiveStepDetail(`保底机制：批量下载 ${downloadCandidates.length} 个候选文件…`);
    
    const downloadResult = await window.electronAPI?.viewBatchDownloadUrls(side, downloadCandidates.map(l => l.url), 30000);
    
    if (!downloadResult?.ok || !downloadResult.files || downloadResult.files.length === 0) {
      setDocWebStatus({ phase: "error", message: "保底机制：所有文件下载失败" });
      await restorePage();
      throw new Error("保底机制失败：所有文件下载失败");
    }

    const files = downloadResult.files;
    rlog(`[fallback] 成功下载 ${files.length} 个文件`);

    // 步骤5：获取记录关键词并尝试匹配
    const recordKey = record.fields["name"] || record.fields["student_id"] || record.record_id;
    const keywords = getRecordMatchKeywords(record);
    rlog(`[fallback] 记录关键词: ${keywords.join(", ")}`);

    // 5.1 首先尝试文件名匹配
    const filesWithMatch = files.map(f => ({
      ...f,
      matched: filenameMatchesRecord(f.filename, keywords),
    }));

    // 文件名匹配的文件
    const filenameMatches = filesWithMatch.filter(f => f.matched);
    
    if (filenameMatches.length === 1) {
      // 精确匹配到一个文件，直接使用（不设置success状态，由后续OCR流程设置）
      rlog(`[fallback] 文件名精确匹配: ${filenameMatches[0].filename}`);
      // 关键：保底成功也要把页面前进恢复回原页面，否则 LOOP 停留在回退后的页面（白屏/列表页），后续收尾点击全部找不到元素
      await restorePage();
      await new Promise(r => setTimeout(r, 800));
      return filenameMatches[0];
    } else if (filenameMatches.length > 1) {
      // 多个文件名匹配，无法确定哪个是正确的，进入人工审查
      rlog(`[fallback] 找到 ${filenameMatches.length} 个文件名匹配，进入人工审查`);
      // 不直接返回，落入下方人工审查逻辑
    }

    // 5.2 文件名没匹配到，尝试快速OCR内容匹配（前几个文件）
    setDocWebStatus({ phase: "fallback-downloading", total: files.length, current: files.length, currentFile: "正在OCR匹配文件内容..." });
    updateLiveStepDetail("保底机制：OCR 匹配候选文件内容…");
    
    const filesToPreview = files.slice(0, Math.min(files.length, 8)); // 最多预览前8个
    for (let i = 0; i < filesToPreview.length; i++) {
      const f = filesToPreview[i];
      const isMatch = await quickPreviewForMatch(f.dataUrl, f.filename, keywords);
      if (isMatch) {
        rlog(`[fallback] OCR内容匹配: ${f.filename}`);
        filesWithMatch.find(fwm => fwm.filename === f.filename)!.matched = true;
        // 同样：成功匹配后先前进恢复页面再返回
        await restorePage();
        await new Promise(r => setTimeout(r, 800));
        return f;
      }
    }

    // 步骤6：所有自动匹配都失败，进入人工审查模式
    rlog(`[fallback] 自动匹配失败，进入人工审查模式，共 ${files.length} 个文件`);
    updateLiveStepDetail("⚠️ 请在下方「文件处理」面板人工选择正确文件…");
    // 人工审查前也先把页面前进恢复原页面（审查 UI 是 HTML 浮层，不依赖被回退的页面）
    await restorePage();
    await new Promise(r => setTimeout(r, 800));
    const reviewFiles = filesWithMatch.map((f, idx) => ({ ...f, selected: idx === 0 }));
    setDocWebStatus({
      phase: "fallback-review",
      files: reviewFiles,
      side,
      recordKey,
      recordName: record.fields["name"] || record.record_id,
    });

    // 返回特殊标记，表示需要人工选择
    return "manual-review";
  }, [getRecordMatchKeywords, filenameMatchesRecord, quickPreviewForMatch, updateLiveStepDetail]);

  // 保底人工审查：选择一个文件继续
  const selectFallbackFile = useCallback((filename: string) => {
    const status = docWebStatusRef.current;
    if (status.phase !== "fallback-review") return;
    const file = status.files.find(f => f.filename === filename);
    if (!file) return;
    
    // 更新选中状态
    setDocWebStatus({
      ...status,
      files: status.files.map(f => ({ ...f, selected: f.filename === filename })),
    });
  }, []);

  // 保底人工审查：确认选择的文件，继续流程
  const confirmFallbackFile = useCallback((): { filename: string; dataUrl: string; size: number; mime: string } | null => {
    const status = docWebStatusRef.current;
    if (status.phase !== "fallback-review") return null;
    const selected = status.files.find(f => f.selected);
    if (!selected) return null;
    
    rlog(`[fallback] 人工选择文件: ${selected.filename}`);
    setDocWebStatus({ phase: "success", filename: selected.filename, size: selected.size });
    
    const fileData = {
      filename: selected.filename,
      dataUrl: selected.dataUrl,
      size: selected.size,
      mime: selected.mime,
    };
    
    // 如果有等待中的LOOP执行Promise，resolve它
    if (fallbackWaitResolveRef.current) {
      const resolve = fallbackWaitResolveRef.current;
      fallbackWaitResolveRef.current = null;
      resolve(fileData);
    }
    
    return fileData;
  }, []);

  // ============ LOOP 执行期 OCR：单次调用后端提取 ============
  // 后端 extract_document 内部已含完整回退链（MRZ → 本地正则 → VIZ 看图 + 文本 LLM 并行），
  // 前端不再二次重跑 Vision（之前"UMI 缺字段自动转 Vision 重试"会把整条 Vision 管线
  // 重跑一遍，白等 20~240 秒且命中率极低，是 LOOP 变慢的主因）。
  const extractFileWithVisionFallback = useCallback(async (file: File, targetFields: string[], engine?: string) => {
    // engine 显式传参：档位切换后重跑，用点击档位时快照的引擎，不依赖后端全局设置同步
    return api.extractDocumentFile(file, targetFields, engine);
  }, []);

  /** URL 版：同上，单次调用 */
  const extractUrlWithVisionFallback = useCallback(async (url: string, targetFields: string[], filename: string, engine?: string) => {
    return api.extractDocumentUrl(url, targetFields, filename, engine);
  }, []);

  // ============ 在单个 view 上执行一个 mark（带变量替换） ============
  const executeMark = useCallback(async (
    mark: PickedMark,
    record: ApplicantRecord
  ): Promise<void> => {
    if (!window.electronAPI) {
      console.warn("[executeMark] electronAPI 不可用");
      return;
    }
    const side: ViewSide = mark.side === "left" ? "left" : "right";
    // 文件处理按钮记录步骤：仅作流程展示，配置阶段已生效，执行时直接跳过
    if (mark.fileOp) {
      rlog(`[executeMark] 文件处理记录步骤（no-op）: ${mark.label}`);
      return;
    }
    // 弹窗内元素：JS 执行路由到弹窗 BrowserView（弹窗由前序点击步骤打开）
    const inPopup = !!mark.inPopup;
    const execJS = (script: string) => inPopup
      ? window.electronAPI!.popupExecuteJS(side, script)
      : window.electronAPI!.viewExecuteJS(side, script);

    // 计算变量替换后的值
    let resolvedValue = mark.value || "";
    if (mark.variableField) {
      const docFields = getRecordDocFields(record.record_id);
      const v = record.fields[mark.variableField] ?? record.passport_fields?.[mark.variableField] ?? docFields[mark.variableField] ?? "";
      resolvedValue = String(v ?? "").trim();
      rlog(`[executeMark] Excel取值: field=${mark.variableField}, raw=${JSON.stringify(record.fields[mark.variableField])}, resolved="${resolvedValue}"`);
    }

    // input 动作：把值填入目标输入框（与 commitInput/绑定输入框 逻辑保持一致）
    if (mark.action === "input" && mark.inputTarget) {
      // 1. 如果来源是左网页，先从左侧网页读取值（dataSource 步骤已导航到对应页面）
      if (mark.sourceSelector) {
        rlog(`[executeMark] 左网页取值: sourceSelector=${mark.sourceSelector}`);
        // 先等待左网页元素出现
        const leftAppeared = await waitElementAppear("left", mark.sourceSelector, 6000);
        if (!leftAppeared) {
          throw new Error(`左网页来源元素未找到: ${mark.sourceSelector}`);
        }
        const readScript = `
          ${DEEP_QUERY_HELPER}
          (function() {
            var el = null;
            try { el = __cinsideDeepQuery(${JSON.stringify(sanitizeSelector(mark.sourceSelector))}); } catch(e) { el = null; }
            if (!el) return { ok: false, reason: 'not_found' };
            var val = '';
            try {
              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
                val = el.value || '';
              } else if (el.contentEditable === 'true') {
                val = el.textContent || '';
              } else {
                val = el.textContent || el.innerText || '';
              }
            } catch(e) { val = el.textContent || ''; }
            return { ok: true, value: val.trim() };
          })();
        `;
        const readRes = await window.electronAPI.viewExecuteJS("left", readScript) as { ok: boolean; value?: string; reason?: string } | null;
        if (readRes?.ok && readRes.value) {
          resolvedValue = readRes.value;
          rlog(`[executeMark] 从左网页读取到值: "${resolvedValue}"`);
        } else {
          rlog(`[executeMark] 左网页读取失败: ${readRes?.reason || '未知'}`);
        }
      }

      // 控件映射：点击展开型控件（选项/日历）用专用脚本设定值，而非普通填值
      if (mark.widget) {
        const w = mark.widget;
        if (!resolvedValue) {
          throw new Error(`控件取值失败: 左侧值为空 (${w.triggerLabel || w.triggerSelector})`);
        }
        // 等待触发框出现（SPA 页面可能需要时间渲染）
        const triggerAppeared = await waitElementAppear(side, w.triggerSelector, 8000, inPopup);
        if (!triggerAppeared) {
          throw new Error(`控件触发框未出现: ${w.triggerSelector}`);
        }
        if (w.kind === "option") {
          let wres: OptionSelectResult | null;
          if (w.inline) {
            wres = (await execJS(buildInlineOptionSelectScript(w, resolvedValue))) as OptionSelectResult | null;
          } else {
            wres = (await execJS(buildOptionSelectScript(w, resolvedValue))) as OptionSelectResult | null;
          }
          rlog(`[executeMark] 选项控件结果:`, wres);
          if (!wres?.ok) {
            throw new Error(`选项控件未匹配「${resolvedValue}」: ${wres?.reason || "未知"}${wres?.options?.length ? `（可选项：${wres.options.slice(0, 8).join("/")}）` : ""}`);
          }
        } else {
          const cands = parseDateCandidates(resolvedValue);
          if (!cands.length) {
            throw new Error(`日历控件取值失败: 「${resolvedValue}」不是可识别的日期 (${w.triggerLabel || w.triggerSelector})`);
          }
          const [yy, mm, dd] = cands[0].split("-").map(Number);
          const wres = (await execJS(buildCalendarSetScript(w, yy, mm, dd))) as CalendarSetResult | null;
          rlog(`[executeMark] 日历控件结果:`, wres);
          if (wres?.log && Array.isArray(wres.log)) {
            for (const line of wres.log) rlog(`[calSet] ${line}`);
          }
          if (!wres?.ok) {
            throw new Error(`日历控件设定失败: ${wres?.reason || "未知"} (${w.triggerSelector})`);
          }
        }
        return;
      }

      rlog(`[executeMark] INPUT side=${side}, target=${mark.inputTarget}, value="${resolvedValue}", variableField=${mark.variableField || "(none)"}, sourceSelector=${mark.sourceSelector || "(none)"}`);

      // 2. 先停止拾取模式，避免拾取脚本干扰填值（与 commitInput 一致）
      try {
        await window.electronAPI?.viewStopPicking("left");
        await window.electronAPI?.viewStopPicking("right");
      } catch (e) {
        console.warn("[executeMark] viewStopPicking 失败", e);
      }
      // 短暂等待，让网页从拾取状态恢复
      await new Promise((r) => setTimeout(r, 150));

      // 3. 等待目标输入框出现（SPA 页面可能需要时间渲染）
      const targetAppeared = await waitElementAppear(side, mark.inputTarget, 8000, inPopup);
      if (!targetAppeared) {
        throw new Error(`目标输入框未出现: ${mark.inputTarget}`);
      }

      // 4. 执行填值
      let result = await performInputValue(side, mark.inputTarget, resolvedValue, inPopup);
      rlog(`[executeMark] performInputValue 结果:`, result);

      // 5. 如果失败，兜底重试一次（等待更长时间后重试）
      if (!result?.ok) {
        rlog(`[executeMark] 首次填入失败(${result?.reason})，等待后重试...`);
        await new Promise((r) => setTimeout(r, 1000));
        await waitElementAppear(side, mark.inputTarget, 5000, inPopup);
        result = await performInputValue(side, mark.inputTarget, resolvedValue, inPopup);
        rlog(`[executeMark] 重试结果:`, result);
      }
      if (!result?.ok) {
        throw new Error(`输入失败: ${result?.reason || "未知原因"} (${mark.inputTarget})`);
      }
      return;
    }

    // click 动作：真实点击
    if (mark.action === "click") {
      // === 面板动作：文件提取配置面板的「录入提取」按钮（非网页元素，直接调用前端提取逻辑提交文件字段） ===
      if (mark.panelAction === "doc-web-extract") {
        rlog(`[executeMark] 面板动作: 录入提取（提交文件字段到当前记录 ${record.record_id}）`);
        triggerWebExtract(record.record_id);
        return;
      }
      // === 文件上传步骤：从运行时槽位取文件 → 可选压缩/转格式 → DataTransfer 填入 file input ===
      if (mark.docUpload) {
        console.log(`[executeMark] DOC-UPLOAD side=${side}, selector=${mark.selector}, sourceMarkId=${mark.uploadSourceMarkId || "last"}`);
        // 1. 取文件：优先绑定的槽位，兜底最近一次提取
        const slot = (mark.uploadSourceMarkId && docRuntimeFileSlotsRef.current[mark.uploadSourceMarkId]) || null;
        const lastFile = lastDocRuntimeFileRef.current;
        let dataUrl = slot?.dataUrl || "";
        let filename = slot?.filename || lastFile?.filename || "upload.bin";
        // URL 直提模式：文件在远端，先调后端下载（顺带可按需压缩）
        const remoteUrl = slot?.url || (!dataUrl ? lastFile?.url : "") || "";
        if (!dataUrl && remoteUrl) {
          rlog(`[executeMark] 上传文件为远端 URL，后端下载: ${remoteUrl}`);
          const conv = await api.convertDocument("", filename, mark.uploadFormat || "original", mark.uploadCompressKb || 0, remoteUrl);
          dataUrl = `data:${conv.mime};base64,${conv.data_b64}`;
          filename = filename.replace(/\.[^.]+$/, "") + "." + conv.ext;
        } else if (!dataUrl && lastFile?.dataUrl) {
          dataUrl = lastFile.dataUrl;
          filename = filename || lastFile.filename;
        }
        if (!dataUrl) {
          throw new Error("上传失败: 无可用文件（文件提取步骤未执行或未产出文件）");
        }
        // 2. 可选：上传前压缩/转格式（URL 模式已在下载时处理过则跳过）
        if (mark.uploadCompressKb && mark.uploadCompressKb > 0 && !remoteUrl) {
          rlog(`[executeMark] 上传前压缩: 目标 ${mark.uploadCompressKb}KB, 格式 ${mark.uploadFormat || "original"}`);
          const conv = await api.convertDocument(dataUrl, filename, mark.uploadFormat || "original", mark.uploadCompressKb);
          dataUrl = `data:${conv.mime};base64,${conv.data_b64}`;
          filename = filename.replace(/\.[^.]+$/, "") + "." + conv.ext;
          rlog(`[executeMark] 压缩完成: ${conv.size} bytes (${conv.reached ? "已达标" : "压到极限"})`);
        }
        // 3. 等待上传框出现
        await waitElementAppear(side, mark.selector, 6000, inPopup).catch(() => {});
        // 4. DataTransfer 填入 file input（分块传输 base64，避免超大文件单次注入失败）
        const commaIdx = dataUrl.indexOf(",");
        const mime = (dataUrl.slice(5, commaIdx).split(";")[0]) || "application/octet-stream";
        const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
        await execJS("window.__cinsideUploadB64='';'init'");
        const CHUNK = 2 * 1024 * 1024;
        for (let i = 0; i < b64.length; i += CHUNK) {
          const part = b64.slice(i, i + CHUNK);
          await execJS(`window.__cinsideUploadB64+=${JSON.stringify(part)};'ok'`);
        }
        const fillScript = `
          ${DEEP_QUERY_HELPER}
          (function() {
            var el = null;
            try { el = __cinsideDeepQuery(${JSON.stringify(sanitizeSelector(mark.selector))}); } catch(e) { el = null; }
            if (!el) return { ok: false, reason: 'not_found' };
            try {
              var bstr = atob(window.__cinsideUploadB64 || '');
              var n = bstr.length;
              var u8 = new Uint8Array(n);
              for (var i = 0; i < n; i++) u8[i] = bstr.charCodeAt(i);
              var file = new File([u8], ${JSON.stringify(filename)}, { type: ${JSON.stringify(mime)} });
              var dt = new DataTransfer();
              dt.items.add(file);
              el.files = dt.files;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              window.__cinsideUploadB64 = '';
              return { ok: true, name: file.name, size: file.size };
            } catch (e) {
              return { ok: false, reason: String(e) };
            }
          })();
        `;
        const fillRes = await execJS(fillScript) as { ok: boolean; name?: string; size?: number; reason?: string } | null;
        if (!fillRes?.ok) {
          throw new Error(`上传填入失败: ${fillRes?.reason || "未知原因"} (${mark.selector})`);
        }
        rlog(`[executeMark] 上传填入成功: ${fillRes.name} (${fillRes.size} bytes)`);
        return;
      }
      // 文件提取步骤
      if (mark.docExtract) {
        // === local 模式（目录模式）：按路径模板 + 字段值拼路径，自动尝试多扩展名 → 读取文件 → OCR ===
        if (mark.docSource === "local" && mark.docLocalRootPath && mark.docLocalPattern) {
          console.log(`[executeMark] DOC-LOCAL side=${side}, pattern=${mark.docLocalPattern}, field=${mark.docFileField}`);
          // 1. 取当前记录的字段值（如学号 123456）
          const fieldValue = String(record.fields?.[mark.docFileField || ""] ?? "").trim();
          if (!fieldValue) {
            rlog(`[executeMark] 本地文件提取失败: 记录缺少字段「${mark.docFileField}」的值`);
            return;
          }
          // 2. 替换模板中的 {field} 占位符
          const basePath = mark.docLocalPattern.replace(/\{[^}]+\}/g, fieldValue);
          // 3. 按扩展名顺序尝试读取文件
          const tryExts = [".jpg", ".jpeg", ".png", ".pdf", ".webp", ".bmp", ".gif", ".tif", ".tiff",
            ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"];
          let readResult: { ok: boolean; dataUrl?: string; filename?: string; mime?: string; size?: number; error?: string } | null = null;
          for (const ext of tryExts) {
            const tryPath = basePath + ext;
            const existsRes = await window.electronAPI?.checkLocalFileExists(mark.docLocalRootPath, tryPath);
            if (existsRes?.exists) {
              readResult = await window.electronAPI?.readLocalDocFile(mark.docLocalRootPath, tryPath) || null;
              if (readResult?.ok) {
                rlog(`[executeMark] 本地文件命中: ${tryPath}`);
                break;
              }
            }
          }
          if (!readResult || !readResult.ok || !readResult.dataUrl) {
            rlog(`[executeMark] 本地文件提取失败: 路径模板「${basePath}」所有扩展名均未找到文件`);
            return;
          }
          // 3.5 存入运行时文件槽位（供后续上传步骤取文件）
          docRuntimeFileSlotsRef.current[mark.id] = { dataUrl: readResult.dataUrl, filename: readResult.filename || "local-doc" };
          lastDocRuntimeFileRef.current = { dataUrl: readResult.dataUrl, filename: readResult.filename || "local-doc", markId: mark.id };
          // 4. 调 OCR 提取（后端会自动做图像预处理：EXIF 旋转 + 裁白边 + AI 转正放大）
          const file = dataUrlToFile(readResult.dataUrl, readResult.filename || "local-doc");
          // 目标字段：优先只提取「提取元素」面板绑定 Excel 列的元素（未绑定的不提取，省 LLM/VIZ 时间）
          const targetFields = computeDocTargetFields(mappings);
          try {
            const result = await extractFileWithVisionFallback(file, targetFields);
            // 同步写入 docExtractsByRecord：LOOP 运行时字段对比（提取值 vs Excel 绑定列）与提取元素面板都按当前记录从这里读取
            // 内存保护：有裁剪图(processed_image)时抛弃原始大图 base64——面板预览只用裁剪图，
            // file_url 退化为文件名（供去重/类型判断），避免每文件两份几 MB base64 堆积导致渲染进程 OOM
            const hasProcessed = !!result.processed_image;
            const localExtract: DocExtractState = {
              filename: result.filename,
              method: result.method,
            ocr_backend: result.ocr_backend,
              text: result.text,
              fields: result.fields,
              entries: [],
              source: hasProcessed ? (readResult.filename || result.filename) : readResult.dataUrl,
              file_url: hasProcessed ? (readResult.filename || result.filename) : readResult.dataUrl,
              processed_image: result.processed_image,
              mrz_warnings: result.mrz_warnings,
              fallback: result.fallback,
            };
            const localRid = record?.record_id || "_default";
            setDocExtractsByRecord((prev) => {
              const arr = prev[localRid] || [];
              const filtered = arr.filter((e) => e.file_url !== localExtract.file_url);
              return { ...prev, [localRid]: [...filtered, localExtract] };
            });
            setActiveDocIndex(999);
            setDocSignal((s) => s + 1);
            // LOOP 运行期不弹浮动审查面板（停止后会残留飘出）
            if (!isAnyRunningRef.current) {
              setDocExtractPanel({
                imageUrl: toPreviewImageUrl(readResult.dataUrl, result.processed_image),
                filename: result.filename,
                method: result.method,
                ocr_backend: result.ocr_backend,
                text: result.text,
                fields: result.fields,
                side,
                workflow: side === "left" ? "entry" : "review",
                fallback: result.fallback,
                sourceDataUrl: readResult.dataUrl,
                targetFields,
                altResult: null,
              });
              setDocExtractActiveTab("primary");
            }
          } catch (e) {
            rlog(`[executeMark] 本地文件 OCR 失败: ${e instanceof Error ? e.message : String(e)}`);
          }
          return;
        }
        // === web-download 模式：多步点击触发下载 → 捕获文件 → OCR ===
        if (mark.docSource === "web-download") {
          console.log(`[executeMark] DOC-DOWNLOAD side=${side}, selector=${mark.selector}`);
          // 1. 开启下载捕获
          await window.electronAPI.setDownloadCapture(side, true);
          // 1.5 关键：点击前先注册下载完成监听。下载可能在几百毫秒内完成，
          // 若等 grabDirectPreviewFile 的 1.5s 检测完再注册，会错过 download-captured 事件
          // → 白等30s超时 → 误触保底机制连续回退页面 → 网页白屏
          const downloadPromise = waitForDownload(side, 30000);
          // 直览页场景会放弃等待该 Promise，提前挂静默 catch 避免未处理拒绝
          downloadPromise.catch(() => {});
          updateLiveStepDetail("点击触发下载，等待文件…");
          // 2. 真实点击触发下载
          let clickResult = await performRealClick(side, mark.selector, inPopup);
          if (clickResult && typeof clickResult === "object" && "ok" in clickResult && clickResult.ok === false) {
            await waitElementAppear(side, mark.selector, 6000, inPopup);
            clickResult = await performRealClick(side, mark.selector, inPopup);
          }
          // 诊断：记录点击结果与点击后页面状态（排查"点击了但没触发下载"）
          try {
            const diagScript = `(function(){ return JSON.stringify({ href: location.href.slice(0,200), ct: (document.contentType||''), title: (document.title||'').slice(0,80) }); })()`;
            const diagRaw = inPopup
              ? await window.electronAPI.popupExecuteJS(side, diagScript)
              : await window.electronAPI.viewExecuteJS(side, diagScript);
            rlog(`[executeMark] DOC-DOWNLOAD 点击后状态: click=${JSON.stringify(clickResult)} page=${diagRaw}`);
          } catch { /* 诊断失败不影响主流程 */ }
          
          // 下载完成后：先开预览，后台同时OCR提取
          // showPreviewAndBgOcr: 立即开预览（轻量）+ 后台启动OCR（重量），返回OCR文字供校验
          // 高速模式下不等待 OCR：返回 null，OCR 在后台落定并写入缓存/面板，浏览器步骤继续跑；
          // 文件一致性校验由调用方延后到记录末尾 join 点执行
          const showPreviewAndBgOcr = async (fileData: { filename: string; dataUrl: string; size: number }): Promise<string | null> => {
            // 存入运行时文件槽位
            docRuntimeFileSlotsRef.current[mark.id] = { dataUrl: fileData.dataUrl, filename: fileData.filename };
            lastDocRuntimeFileRef.current = { dataUrl: fileData.dataUrl, filename: fileData.filename, markId: mark.id };

            // 暂存原始文件数据（供后续triggerWebExtract复用）
            pendingWebFileRef.current = { dataUrl: fileData.dataUrl, filename: fileData.filename, size: fileData.size, side };

            const file = dataUrlToFile(fileData.dataUrl, fileData.filename);

            // 1. 轻量预览 + 完整OCR 同时启动（并行，互不阻塞）
            // 目标字段：优先只提取「提取元素」面板绑定 Excel 列的元素（未绑定的不提取，省 LLM/VIZ 时间）
            const targetFields = computeDocTargetFields(mappings);

            // 先启动轻量预览（快速显示文件内容给用户看）
            setDocWebStatus({ phase: "preview", filename: fileData.filename, size: fileData.size });
            api.previewDocumentFile(file)
              .then((previewResult) => {
                // 显示源文件预览（不影响后台OCR进行中）
                setDocSourcePreview({
                  imageUrl: `data:image/jpeg;base64,${previewResult.processed_image}`,
                  filename: previewResult.filename,
                  method: previewResult.method,
                });
                // 裁切图先行：不等 OCR+LLM 完整管线，preview 返回即把裁切预览回填
                // 文件处理面板（带 pending 标记，正式提取完成后按 file_url 覆盖
                // 为完整结果）——LOOP 开始时面板不用干等整条提取管线跑完才见到图
                if (previewResult.processed_image) {
                  const rid0 = record?.record_id || selected?.record_id || "_default";
                  setDocExtractsByRecord((prev) => {
                    const arr = prev[rid0] || [];
                    // 已有完整结果（缓存热/跑得快）时不降级回 pending 占位（file_url 可能是文件名或 dataUrl，双匹配）
                    if (arr.some((e) => (e.file_url === fileData.dataUrl || e.file_url === fileData.filename) && !e.pending)) return prev;
                    const filtered = arr.filter((e) => e.file_url !== fileData.dataUrl && e.file_url !== fileData.filename);
                    return {
                      ...prev,
                      [rid0]: [
                        ...filtered,
                        {
                          filename: previewResult.filename || fileData.filename,
                          method: previewResult.method || "image",
                          text: "",
                          fields: {},
                          entries: [],
                          // 内存保护：有裁剪图占位时 source/file_url 只存文件名，不存原图 dataUrl
                          source: fileData.filename || previewResult.filename || fileData.dataUrl,
                          file_url: fileData.filename || previewResult.filename || fileData.dataUrl,
                          processed_image: previewResult.processed_image,
                          pending: true,
                        },
                      ],
                    };
                  });
                  setActiveDocIndex(999);
                }
              })
              .catch((e) => {
                rlog(`[executeMark] 轻量预览失败（不影响OCR）: ${e instanceof Error ? e.message : String(e)}`);
              });

            // 2. 后台启动完整OCR提取（同时进行）
            setDocWebStatus({ phase: "ocr", filename: fileData.filename });
            updateLiveStepDetail(`OCR 识别中：${fileData.filename}`);
            rlog(`[executeMark] 预览已开启，后台开始OCR: ${fileData.filename}`);
            // 用 ref 快照读引擎，避免 useCallback 闭包里的 settings 过期（引擎中途切换后缓存标记错会导致复用错引擎的结果）
            const ocrEngineNow = settingsRef.current.ocr_engine || "vision";
            const ocrPromise = extractFileWithVisionFallback(file, targetFields, ocrEngineNow);

            // OCR 落定后的统一处理：同步缓存结果 + 写 docExtractsByRecord + 更新面板/状态
            const settledPromise = ocrPromise.then((result) => {
              // 3. 缓存OCR结果（供triggerWebExtract复用，避免重复提取；记录引擎以便切换引擎后缓存失效）
              if (bgOcrResultRef.current && bgOcrResultRef.current.promise === settledPromise) {
                bgOcrResultRef.current.result = result;
              }

              // 3.5 同步写入 docExtractsByRecord，让文件处理面板和提取元素面板实时显示
              //（LOOP运行期间不弹浮动审查面板，但下方面板要能看到内容）
              // 内存保护：有裁剪图时 source/file_url 只存文件名（去重/类型判断用），不存原图 dataUrl
              const newExtract: DocExtractState = {
                filename: result.filename,
                method: result.method,
                ocr_backend: result.ocr_backend,
                text: result.text,
                fields: result.fields,
                entries: [],
                source: result.processed_image ? (fileData.filename || result.filename) : fileData.dataUrl,
                file_url: result.processed_image ? (fileData.filename || result.filename) : fileData.dataUrl,
                processed_image: result.processed_image,
                mrz_warnings: result.mrz_warnings,
                fallback: result.fallback,
              };
              const rid = record?.record_id || selected?.record_id || "_default";
              setDocExtractsByRecord((prev) => {
                const arr = prev[rid] || [];
                const filtered = arr.filter((e) => e.file_url !== newExtract.file_url);
                return { ...prev, [rid]: [...filtered, newExtract] };
              });
              setActiveDocIndex(999);
              setDocSignal((s) => s + 1);

              // 4. 设置提取面板（OCR结果就绪，非运行期才弹浮动审查面板）
              if (!isAnyRunningRef.current) {
                setDocExtractPanel({
                  imageUrl: toPreviewImageUrl(fileData.dataUrl, result.processed_image),
                  filename: result.filename,
                  method: result.method,
                  ocr_backend: result.ocr_backend,
                  text: result.text,
                  fields: result.fields,
                  side,
                  workflow: side === "left" ? "entry" : "review",
                  fallback: result.fallback,
                  sourceDataUrl: fileData.dataUrl,
                  targetFields,
                  altResult: null,
                });
                setDocExtractActiveTab("primary");
              }
              setDocWebStatus({ phase: "success", filename: result.filename, size: fileData.size });
              updateLiveStepDetail(`文件提取完成：${result.filename}`);
              return result;
            });
            // 静默兜底拒绝（高速模式不 await 该 promise 时，避免未处理拒绝警告；join 时会再拿到错误）
            settledPromise.catch(() => {
              // OCR 失败：清掉 preview 先行回填的 pending 占位（避免面板永远显示「识别中」）
              const ridFail = record?.record_id || selected?.record_id || "_default";
              setDocExtractsByRecord((prev) => {
                const arr = prev[ridFail];
                if (!arr || !arr.some((e) => (e.file_url === fileData.dataUrl || e.file_url === fileData.filename) && e.pending)) return prev;
                return { ...prev, [ridFail]: arr.filter((e) => !((e.file_url === fileData.dataUrl || e.file_url === fileData.filename) && e.pending)) };
              });
            });

            // 立即登记缓存（result 待落定后回填），高速/普通模式都登记：triggerWebExtract 复用 + join 等待
            bgOcrResultRef.current = { dataUrl: fileData.dataUrl, engine: ocrEngineNow, promise: settledPromise };

            // 高速模式 或 两遍式 pass1：OCR 完全后台化，浏览器步骤不等它——
            // pass1 的并行语义不依赖高速开关（任何档位下 AI 管线都必须与浏览器步骤并行）
            if ((settingsRef.current.high_speed_mode === true || passDeferActiveRef.current) && isAnyRunningRef.current) {
              const ocrRid = record?.record_id || selected?.record_id || "_default";
              const arr = bgOcrPromisesRef.current.get(ocrRid) || [];
              arr.push(settledPromise);
              bgOcrPromisesRef.current.set(ocrRid, arr);
              rlog(`[executeMark] ${passDeferActiveRef.current ? "两遍式pass1" : "高速模式"}：OCR 后台并行，浏览器步骤继续`);
              return null;
            }

            // 普通模式：保持原有同步语义（等 OCR 完成返回全文供立即校验）
            const result = await settledPromise;
            return result.text || "";
          };

          // 文件一致性校验：检查OCR提取的文字是否包含该学生的关键信息
          const verifyFileMatchesRecord = (ocrText: string, record: ApplicantRecord): boolean => {
            const keywords = getRecordMatchKeywords(record);
            if (keywords.length === 0) return true; // 没有关键词可匹配，默认通过
            const text = ocrText.toLowerCase();
            for (const kw of keywords) {
              if (text.includes(kw)) return true;
            }
            return false;
          };

          // 保底机制执行函数（提取出来避免重复代码）
          const runFallbackAndWait = async (): Promise<boolean> => {
            try {
              const preClickCount = currentPreClickCountRef.current;
              const fallbackResult = await runDocExtractFallback(side, record, preClickCount);
              
              if (fallbackResult === "manual-review") {
                // 判断该文件提取步骤是否设了断点：设了断点 → 停下等人；未设断点 → 自动跳过，跑完标记需人工
                const hasBreakpoint = mark.breakpoint === "always" || mark.breakpoint === "on-error";
                if (!hasBreakpoint) {
                  // 自动跳过：保留保底下载的文件供事后查看，标记该记录需人工，恢复页面继续跑
                  const reviewStatus = docWebStatusRef.current;
                  const stashFiles = reviewStatus.phase === "fallback-review" ? reviewStatus.files : [];
                  if (stashFiles.length) {
                    // 内存保护：该状态未被任何组件读取，只保留文件名/元数据，丢弃整页截图 dataUrl
                    setFallbackFilesByRecord((prev) => ({
                      ...prev,
                      [record.record_id]: stashFiles.map((f) => ({ ...f, dataUrl: "" })),
                    }));
                  }
                  needsManualRef.current.add(record.record_id);
                  rlog(`[executeMark] 保底自动跳过（该步骤未设断点），保留 ${stashFiles.length} 个文件，本记录标记需人工`);
                  return false;
                }

                // 需要人工审查，等待用户选择
                rlog(`[executeMark] 等待人工选择文件...`);
                updateLiveStepDetail("⚠️ 自动匹配失败，请在下方「文件处理」面板选择正确文件…");
                const manualFile = await new Promise<{ filename: string; dataUrl: string; size: number; mime: string } | null>((resolve) => {
                  fallbackWaitResolveRef.current = resolve;
                  // 超时保护：10分钟后自动超时
                  setTimeout(() => {
                    if (fallbackWaitResolveRef.current === resolve) {
                      fallbackWaitResolveRef.current = null;
                      resolve(null);
                    }
                  }, 10 * 60 * 1000);
                });
                
                if (manualFile) {
                  rlog(`[executeMark] 人工选择文件: ${manualFile.filename}`);
                  await showPreviewAndBgOcr(manualFile);
                  return true;
                } else {
                  rlog(`[executeMark] 人工取消保底，跳过该文件`);
                  needsManualRef.current.add(record.record_id);
                  return false;
                }
              } else {
                // 自动匹配成功
                rlog(`[executeMark] 保底自动匹配文件: ${fallbackResult.filename}`);
                await showPreviewAndBgOcr(fallbackResult);
                return true;
              }
            } catch (fallbackErr) {
              rlog(`[executeMark] 保底机制失败: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
              return false;
            }
          };

          // 高速模式：文件一致性校验延后到记录末尾（join 点）执行——
          // OCR 在后台跑，浏览器步骤不等它；下错文件（罕见）的保底此时才触发，
          // 回退步数用提取时刻捕获的值（记录末尾时 ref 已被后续步骤覆盖）
          const deferFileVerifyToJoin = (
            record: ApplicantRecord,
            ocrPromise: Promise<Awaited<ReturnType<typeof api.extractDocumentFile>>> | undefined
          ) => {
            const preClicksAtExtract = currentPreClickCountRef.current;
            // 按 record_id 暂存：两遍式流水线下 pass1 连续跑多人，join 在 pass2 逐人执行
            pendingFileVerifyRef.current.set(record.record_id, async () => {
              pendingFileVerifyRef.current.delete(record.record_id);
              if (!ocrPromise) return;
              let ocrText = "";
              try {
                const result = await ocrPromise;
                ocrText = result?.text || "";
              } catch {
                return; // OCR 已失败：保底扫描同样靠关键词匹配，OCR 文本缺失时不重复触发
              }
              if (!verifyFileMatchesRecord(ocrText, record)) {
                rlog(`[executeMark] 高速模式延后校验：文件与该记录不匹配，触发保底机制`);
                setDocWebStatus({ phase: "fallback-scanning", message: "下载的文件与该学生不匹配，启动保底机制..." });
                // 保底回退需要"提取时刻"的步数；临时换入再恢复，复用整段保底逻辑
                const saved = currentPreClickCountRef.current;
                currentPreClickCountRef.current = preClicksAtExtract;
                try {
                  await runFallbackAndWait();
                } finally {
                  currentPreClickCountRef.current = saved;
                }
              }
            });
          };

          // 3. 等待下载完成（先检测图片直览页：点击后直接预览图片、无下载按钮的场景）
          let downloadData: { filename: string; dataUrl: string; size: number; mime: string } | null = null;
          try {
            const directFile = await grabDirectPreviewFile(side);
            if (directFile) {
              rlog(`[executeMark] 检测到图片预览页，直接抓取下载: ${directFile.filename}`);
              const directOcrText = await showPreviewAndBgOcr(directFile);
              if (directOcrText === null) {
                // 高速模式：OCR 后台跑，一致性校验延后到记录末尾 join 点
                deferFileVerifyToJoin(record, bgOcrResultRef.current?.promise);
              } else if (!verifyFileMatchesRecord(directOcrText, record)) {
                rlog(`[executeMark] 抓取的图片与该记录不匹配，触发保底机制`);
                setDocWebStatus({ phase: "fallback-scanning", message: "抓取的图片与该学生不匹配，启动保底机制..." });
                await runFallbackAndWait();
              }
              window.electronAPI?.setDownloadCapture(side, false).catch(() => {});
              return;
            }
            downloadData = await downloadPromise;
            rlog(`[executeMark] 下载完成: ${downloadData.filename} (${downloadData.size} bytes)`);
            updateLiveStepDetail(`下载完成：${downloadData.filename}`);
            // 4. 立即开预览 + 后台OCR提取
            const ocrText = await showPreviewAndBgOcr(downloadData);

            // 5. 校验：下载的文件是否真的是该学生的（防止下错文件）
            if (ocrText === null) {
              // 高速模式：OCR 后台跑，一致性校验延后到记录末尾 join 点
              deferFileVerifyToJoin(record, bgOcrResultRef.current?.promise);
            } else if (!verifyFileMatchesRecord(ocrText, record)) {
              rlog(`[executeMark] 文件内容与该记录不匹配，触发保底机制`);
              setDocWebStatus({ phase: "fallback-scanning", message: "下载的文件与该学生不匹配，启动保底机制..." });
              await runFallbackAndWait();
            }
          } catch (e) {
            rlog(`[executeMark] 下载捕获失败: ${e instanceof Error ? e.message : String(e)}，触发保底机制`);
            // 关闭下载捕获
            window.electronAPI?.setDownloadCapture(side, false).catch(() => {});
            // === 保底机制 ===
            await runFallbackAndWait();
          } finally {
            // 确保关闭下载捕获
            window.electronAPI?.setDownloadCapture(side, false).catch(() => {});
          }
          return;
        }
        // === web 模式（原有）：按 selector 重新读取图片/PDF URL → OCR 提取 ===
        console.log(`[executeMark] DOC-EXTRACT side=${side}, selector=${mark.selector}`);
        const readScript = `
          ${DEEP_QUERY_HELPER}
          (function() {
            var el = null;
            try { el = __cinsideDeepQuery(${JSON.stringify(sanitizeSelector(mark.selector))}); } catch(e) { el = null; }
            if (!el) return { ok: false, reason: 'not_found' };
            el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
            var linkEl = (el.closest && el.closest('a')) || (el.tagName === 'A' ? el : null);
            var imgEl = (el.tagName === 'IMG') ? el : (el.querySelector ? el.querySelector('img') : null);
            var url = '';
            try { url = (imgEl && (imgEl.currentSrc || imgEl.src)) || (linkEl && linkEl.href) || ''; } catch(e) {}
            return { ok: !!url, url: url, reason: url ? '' : 'no_url' };
          })();
        `;
        const readRes = await execJS(readScript) as { ok: boolean; url?: string; reason?: string } | null;
        const docUrl = readRes?.url || mark.docUrl || "";
        if (!docUrl) {
          throw new Error(`文件提取失败: 元素未找到或无文件地址 (${mark.selector})`);
        }
        // 存入运行时文件槽位（URL 模式：上传时由后端下载）；文件名从 URL 推断
        const urlName = (() => {
          try {
            const p = decodeURIComponent(new URL(docUrl).pathname);
            const n = p.split("/").filter(Boolean).pop() || "";
            return n.includes(".") ? n : "document.pdf";
          } catch { return "document.pdf"; }
        })();
        docRuntimeFileSlotsRef.current[mark.id] = { url: docUrl, filename: urlName };
        lastDocRuntimeFileRef.current = { url: docUrl, filename: urlName, markId: mark.id };
        // 调后端提取并弹审查面板（异步不阻塞批量循环，面板自动覆盖上一条）
        // 目标字段：优先只提取「提取元素」面板绑定 Excel 列的元素（未绑定的不提取，省 LLM/VIZ 时间）
        const targetFields = computeDocTargetFields(mappings);
        extractUrlWithVisionFallback(docUrl, targetFields, urlName, settingsRef.current.ocr_engine || "vision")
          .then((result) => {
            // LOOP 运行期不设置浮动审查面板状态（否则停止后面板会残留飘出）
            if (isAnyRunningRef.current) return;
            setDocExtractPanel({
              imageUrl: toPreviewImageUrl(docUrl, result.processed_image),
              filename: result.filename,
              method: result.method,
            ocr_backend: result.ocr_backend,
              text: result.text,
              fields: result.fields,
              side,
              workflow: side === "left" ? "entry" : "review",
              fallback: result.fallback,
              sourceDataUrl: docUrl,
              targetFields,
              altResult: null,
            });
            setDocExtractActiveTab("primary");
          })
          .catch((e) => {
            rlog(`[executeMark] 文件提取失败: ${e instanceof Error ? e.message : String(e)}`);
          });
        return;
      }
      console.log(`[executeMark] CLICK side=${side}, selector=${mark.selector}, label=${mark.label}`);
      let result = await performRealClick(side, mark.selector, inPopup);
      // 收尾点击（clickPhase=post）是清理动作，目标常不存在（弹窗已关/本就无需关），
      // 长等待纯浪费（实测每行白等 ~7s）→ 压缩到 1.5s 且不做兜底重试；失败由上层"视为已闭环跳过"
      const isPostClick = mark.clickPhase === "post" || !!mark.docExtractClick;
      // 页面慢渲染/弹窗延迟加载时元素可能还没出现，轮询等待最多 6s
      if (result && typeof result === "object" && "ok" in result && result.ok === false) {
        rlog(`[executeMark] 元素未出现，等待加载: ${mark.selector}`);
        await waitElementAppear(side, mark.selector, isPostClick ? 1500 : 6000, inPopup);
        result = await performRealClick(side, mark.selector, inPopup);
      }
      // 再兜底重试一次（收尾点击不重试，直接走上层跳过逻辑）
      if (!isPostClick && result && typeof result === "object" && "ok" in result && result.ok === false) {
        await new Promise((r) => setTimeout(r, 800));
        result = await performRealClick(side, mark.selector, inPopup);
      }
      if (result && typeof result === "object" && "ok" in result && result.ok === false) {
        throw new Error(`点击失败: 元素未找到 (${mark.selector})`);
      }
      return;
    }

    // pick 动作（默认）：滚动到元素 + 高亮（用于头像重截等）
    if (mark.source === "avatar" && mark.rect && mark.recordId) {
      const result = await window.electronAPI.viewCaptureElement("left", mark.rect);
      if (result?.ok && result.dataUrl) {
        const base64 = result.dataUrl.split(",", 2)[1] || result.dataUrl;
        await api.updateAvatar(record.record_id, base64);
      }
      return;
    }

    // 普通 pick：仅滚动到元素
    const script = `
      ${DEEP_QUERY_HELPER}
      (function() {
        var el = null;
        try { el = __cinsideDeepQuery(${JSON.stringify(sanitizeSelector(mark.selector))}); } catch(e) { el = null; }
        if (!el) return { ok: false, reason: 'not_found' };
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        return { ok: true };
      })();
    `;
    await window.electronAPI.viewExecuteJS(side, script);
  }, [performInputValue, performRealClick, mappings, waitElementAppear, getRecordDocFields, waitForDownload, triggerWebExtract, grabDirectPreviewFile, runDocExtractFallback, updateLiveStepDetail, computeDocTargetFields]);

  // ============ 前端字段比对：执行完workflow后，直接从右侧BrowserView读取字段值与期望比对 ============
  // 不调用后端 startConfigurableVerify（它会通过Playwright重新导航页面，破坏LOOP当前状态）
  // 而是通过 viewExecuteJS 在当前已打开的页面上直接读取mapping对应的值，做前端比对
  /**
   * 文件提取条目（source="doc" 且绑定 Excel 列）的运行时对比：
   * 左=「提取元素」面板字段的运行时 OCR 提取值，右=该条目绑定 Excel 列的当前行值
   */
  const compareDocBindEntries = useCallback((
    entries: CustomTextEntry[],
    record: ApplicantRecord,
  ): { label: string; fieldKey: string; excelField: string; ocrVal: string; excelVal: string; match: FieldMatch }[] => {
    const rows: { label: string; fieldKey: string; excelField: string; ocrVal: string; excelVal: string; match: FieldMatch }[] = [];
    const extracts = docExtractsByRecordRef.current[record.record_id] || [];
    for (const e of entries) {
      if (e.source !== "doc" || !e.excelField) continue;
      // 解析 OCR 字段 key：docField 属性 → id 尾段（ct-ts-rand-field 格式）→ FIELD_LABELS 反查 name → name 原样
      const fk = resolveDocFieldKey(e);
      let ocrVal = "";
      for (const d of extracts) {
        const v = d.fields?.[fk];
        if (v && String(v).trim()) { ocrVal = String(v).trim(); break; }
      }
      const excelVal = String(record.fields[e.excelField] ?? "").trim();
      let match: FieldMatch;
      if (!ocrVal) match = "missing";
      else if (!excelVal) match = "unknown";
      else match = valuesEquivalent(fk, ocrVal, excelVal) ? "match" : "mismatch";
      rows.push({ label: e.name || FIELD_LABELS[fk] || fk, fieldKey: fk, excelField: e.excelField, ocrVal, excelVal, match });
    }
    return rows;
  }, [resolveDocFieldKey]);

  const compareFieldsForRecord = useCallback(async (
    record: ApplicantRecord,
    recordIndex: number,
    mappingsOverride?: FieldMapping[],
    docEntriesOverride?: CustomTextEntry[],
  ): Promise<{ comparisons: FieldComparison[]; overall: "match" | "mismatch" }> => {
    const comparisons: FieldComparison[] = [];
    // 优先使用模板自带的 mappings（复用已保存 LOOP 模板时，会话 mappings 可能为空或不匹配）
    const effectiveMappings = mappingsOverride && mappingsOverride.length > 0 ? mappingsOverride : mappings;
    // 文件提取条目的 Excel 绑定列对比（左=提取值，右=绑定列值）
    const docBindRows = compareDocBindEntries(docEntriesOverride || customTextEntriesRef.current, record);
    if (!window.electronAPI || (effectiveMappings.length === 0 && docBindRows.length === 0)) {
      // 比对根本没跑：不能静默当作"一致"返回，否则最终报告会出现 0/0 的真空通过
      rlog(`[batch] 第 ${recordIndex + 1} 行字段比对未执行：字段映射为空（模板未保存映射且无法从步骤推导）`);
      setSteps((prev) => [
        ...prev,
        {
          step: prev.length + 1,
          action: "error",
          description: `LOOP [${recordIndex + 1}] 字段比对未执行：无字段映射`,
          success: false,
          detail: "模板未保存字段映射，且无法从审查步骤推导。请重新设置字段对比（审查映射）后重新保存 LOOP",
          timestamp: new Date().toISOString(),
        },
      ]);
      return { comparisons, overall: "mismatch" };
    }

    // 进入逐字段审查阶段
    setExecPhase("verify");
    setReviewFieldResults({});

    // 等待页面稳定，让数据渲染出来（仅网页映射需要读页面；纯文件提取对比是
    // 内存字符串比较，无需等页面。高速模式缩短——点击步已各自等过页面加载）
    const hs = settingsRef.current.high_speed_mode === true;
    if (effectiveMappings.length > 0) {
      await new Promise((r) => setTimeout(r, hs ? 500 : 1200));
    }

    let allMatch = true;

    // 通用读取元素值的JS脚本工厂（清洗选择器中的 cinside-* 临时类）
    const makeReadScript = (selector: string) => `
      ${DEEP_QUERY_HELPER}
      (function() {
        var el = null;
        try { el = __cinsideDeepQuery(${JSON.stringify(sanitizeSelector(selector))}); } catch(e) { el = null; }
        if (!el) return { found: false, value: '' };
        var tag = el.tagName;
        var val = '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          val = el.value || '';
        } else if (tag === 'IMG') {
          val = el.src || '';
        } else {
          val = (el.textContent || '').trim();
        }
        return { found: true, value: val };
      })();
    `;

    // 先清空两侧高亮
    window.electronAPI?.viewClearHighlight("right").catch(() => {});
    window.electronAPI?.viewClearHighlight("left").catch(() => {});

    for (let fi = 0; fi < effectiveMappings.length; fi++) {
      if (batchStopRef.current) break;
      const mp = effectiveMappings[fi];
      // 网页侧来源：目标元素所在面板侧（右侧Excel作数据源时为 left）
      const webSide: "left" | "right" = mp.web_side || "right";
      // 更新当前审查字段索引（触发UI光标移动）
      setVerifyFieldIdx(fi);
      // 逐对填卡：先推入 pending 对（标签就位，左右值随后逐格填入）
      const pairLabel = mp.right_label || mp.left_field;
      setLivePairs((prev) => prev.recordId === record.record_id
        ? { ...prev, pairs: [...prev.pairs, { label: pairLabel, leftValue: "", rightValue: "", status: "pending", kind: "compare" }] }
        : prev);

      // 1. 先pending高亮当前字段（目标网页元素）
      const pendingLabel = `${mp.right_label || mp.left_field}：比对中…`;
      window.electronAPI?.viewHighlightBoxes(webSide, [{
        selector: mp.right_selector,
        status: "pending",
        label: pendingLabel,
      }]).catch(() => {});
      // 如果左侧是database源，也pending高亮左侧
      if (mp.left_source === "database") {
        window.electronAPI?.viewHighlightBoxes("left", [{
          selector: mp.left_field,
          status: "pending",
          label: `${mp.right_label || mp.left_field}：比对中…`,
        }]).catch(() => {});
      }

      // 给用户视觉感知时间，再读取值（避免闪烁太快；高速模式只留高亮渲染一帧的量）
      await new Promise((r) => setTimeout(r, hs ? 80 : 350));

      let leftValue = "";
      let leftFound = true;

      if (mp.left_source === "passport") {
        const docFields = getRecordDocFields(record.record_id);
        leftValue = record.passport_fields?.[mp.left_field] || docFields[mp.left_field] || "";
      } else if (mp.left_source === "manual") {
        leftValue = mp.left_field;
      } else if (mp.left_source === "database") {
        try {
          const leftResult = await window.electronAPI.viewExecuteJS("left", makeReadScript(mp.left_field)) as { found: boolean; value: string } | null;
          if (leftResult && typeof leftResult === "object" && leftResult.found) {
            leftValue = leftResult.value || "";
          } else {
            leftFound = false;
          }
        } catch {
          leftFound = false;
        }
      } else {
        leftValue = record.fields[mp.left_field] || "";
      }

      // 逐对填卡：左侧（提取/Excel）值先填入
      const lv0 = (leftValue || "").trim();
      setLivePairs((prev) => {
        if (prev.recordId !== record.record_id) return prev;
        const pairs = [...prev.pairs];
        const idx = pairs.findIndex((p) => p.kind === "compare" && p.label === pairLabel && p.status === "pending");
        if (idx >= 0) pairs[idx] = { ...pairs[idx], leftValue: leftFound ? lv0 : "（未找到）" };
        return { ...prev, pairs };
      });

      let websiteValue = "";
      let rightFound = false;
      try {
        if (mp.widget) {
          // 控件映射：读触发框显示值（选项控件额外找面板选中态）
          const readSide = mp.widget.side || webSide;
          const result = await window.electronAPI.viewExecuteJS(readSide, buildWidgetReadScript(mp.widget)) as WidgetReadResult | null;
          if (result && typeof result === "object" && result.found) {
            rightFound = true;
            websiteValue = result.value || "";
          }
        } else {
          const result = await window.electronAPI.viewExecuteJS(webSide, makeReadScript(mp.right_selector)) as { found: boolean; value: string } | null;
          if (result && typeof result === "object" && result.found) {
            rightFound = true;
            websiteValue = result.value || "";
          }
        }
      } catch {
        websiteValue = "";
      }

      const found = leftFound && rightFound;
      const lv = (leftValue || "").trim();
      const wv = (websiteValue || "").trim();
      // 选项控件：左侧值命中某选项别名时，按该选项的显示文字核对（选项文字≠左侧值的情形）
      let compareLv = lv;
      if (mp.widget?.kind === "option" && mp.widget.options) {
        const hit = mp.widget.options.find((o) => o.alias && normalizeText(o.alias) === normalizeText(lv));
        if (hit) compareLv = hit.text;
      }
      let match: FieldMatch = "match";
      if (!found) {
        match = "missing";
        allMatch = false;
      } else if (mp.verify_method === "smart") {
        const fieldHint = mp.left_source === "database" ? (mp.right_label || "") : mp.left_field;
        match = valuesEquivalent(fieldHint, compareLv, wv) ? "match" : "mismatch";
        if (match === "mismatch") allMatch = false;
      } else {
        const fieldHint = mp.left_source === "database" ? (mp.right_label || "") : mp.left_field;
        match = valuesEquivalent(fieldHint, compareLv, wv) ? "match" : "mismatch";
        if (match === "mismatch") allMatch = false;
      }

      comparisons.push({
        field: mp.left_source === "database" ? (mp.right_label || mp.left_field) : mp.left_field,
        excel_value: mp.left_source === "passport" ? "" : lv,
        passport_value: mp.left_source === "passport" ? lv : "",
        website_value: wv,
        match,
        website_label: mp.right_label,
        selector_hint: mp.right_selector,
        evidence_source: mp.left_source === "passport" ? "passport" : mp.left_source === "database" ? "web" : mp.left_source === "manual" ? "manual" : "excel",
      });

      // 2. 用结果颜色高亮当前字段（match=绿, mismatch=红, missing=黄灰）
      const resultStatus = match === "match" ? "match" : match === "mismatch" ? "mismatch" : "missing";
      const resultLabel = `${mp.right_label || mp.left_field}: ${wv || "—"}${match === "match" ? " ✓" : match === "mismatch" ? " ✗" : " ?"}`;
      window.electronAPI?.viewHighlightBoxes(webSide, [{
        selector: mp.right_selector,
        status: resultStatus,
        label: resultLabel,
      }]).catch(() => {});
      if (mp.left_source === "database") {
        window.electronAPI?.viewHighlightBoxes("left", [{
          selector: mp.left_field,
          status: resultStatus,
          label: `${mp.right_label || ""}: ${lv || "—"}${match === "match" ? " ✓" : " ✗"}`,
        }]).catch(() => {});
      }
      // 记录结果到state（供UI显示颜色）
      setReviewFieldResults((prev) => ({ ...prev, [fi]: match }));
      // 逐对填卡：右侧（网页/审查）值 + 比对结果填入，完成这一对
      setLivePairs((prev) => {
        if (prev.recordId !== record.record_id) return prev;
        const pairs = [...prev.pairs];
        const idx = pairs.findIndex((p) => p.kind === "compare" && p.label === pairLabel && p.status === "pending");
        if (idx >= 0) pairs[idx] = { ...pairs[idx], rightValue: rightFound ? wv : "（未找到）", status: match === "match" ? "match" : match === "mismatch" ? "mismatch" : "missing" };
        return { ...prev, pairs };
      });

      // 字段间短暂停留（高速模式压缩到光标可感知的间隔）
      await new Promise((r) => setTimeout(r, hs ? 120 : 400));
    }

    // 文件提取字段 ↔ Excel 绑定列：左=「提取元素」面板运行时 OCR 值，右=绑定 Excel 列当前行值（一对一对填入卡片）
    for (const row of docBindRows) {
      if (batchStopRef.current) break;
      // 同一 Excel 列已被 mappings 覆盖对比过的跳过，避免重复行
      if (effectiveMappings.some((m) => m.left_source === "excel" && m.left_field === row.excelField)) continue;
      const pairLabel = row.label;
      setLivePairs((prev) => prev.recordId === record.record_id
        ? { ...prev, pairs: [...prev.pairs, { label: pairLabel, leftValue: "", rightValue: "", status: "pending", kind: "compare" }] }
        : prev);
      // 纯内存比较（提取值↔Excel 值都在内存，无页面交互）：只需留给卡片逐对
      // 填入动画可感知的间隔，不再长等
      await new Promise((r) => setTimeout(r, hs ? 40 : 150));
      comparisons.push({
        field: row.label,
        excel_value: row.excelVal,
        passport_value: row.ocrVal,
        website_value: "",
        match: row.match,
        website_label: `${row.label}（Excel·${row.excelField}）`,
        selector_hint: "",
        evidence_source: "passport",
      });
      if (row.match === "mismatch" || row.match === "missing") allMatch = false;
      const pairStatus = row.match === "match" ? "match" : row.match === "mismatch" ? "mismatch" : "missing";
      setLivePairs((prev) => {
        if (prev.recordId !== record.record_id) return prev;
        const pairs = [...prev.pairs];
        const idx = pairs.findIndex((p) => p.kind === "compare" && p.label === pairLabel && p.status === "pending");
        if (idx >= 0) pairs[idx] = { ...pairs[idx], leftValue: row.ocrVal || "（未找到）", rightValue: row.excelVal || "（未找到）", status: pairStatus };
        return { ...prev, pairs };
      });
      await new Promise((r) => setTimeout(r, hs ? 40 : 100));
    }

    // 审查阶段结束
    setExecPhase("done");

    // 记录比对步骤到操作日志
    const matchCount = comparisons.filter((c) => c.match === "match").length;
    const mismatchCount = comparisons.filter((c) => c.match === "mismatch").length;
    const missingCount = comparisons.filter((c) => c.match === "missing").length;
    setSteps((prev) => [
      ...prev,
      {
        step: prev.length + 1,
        action: "final",
        description: `LOOP [${recordIndex + 1}] 字段比对完成：${matchCount} 匹配${mismatchCount > 0 ? `，${mismatchCount} 不匹配` : ""}${missingCount > 0 ? `，${missingCount} 未找到` : ""}`,
        success: allMatch,
        detail: `记录 ${record.record_id} · 共比对 ${comparisons.length} 个字段`,
        timestamp: new Date().toISOString(),
      },
    ]);

    return { comparisons, overall: allMatch ? "match" : "mismatch" };
  }, [mappings, getRecordDocFields, compareDocBindEntries]);

  // ============ 对单张卡片执行整个模板 ============
  // 执行流程：先按顺序执行所有 marks（填入搜索词→点搜索→点人物→点附加按钮），
  // 所有步骤完成后再做一次字段比对（compareFieldsForRecord），形成完整闭环。
  /** 高速模式 join：等待记录所有后台 OCR 落定（含状态写入），并执行延后的文件一致性校验。
   *  传 record_id 只等该人（两遍式 pass2 逐人）；不传等全部并清空（兼容旧调用点）。
   *  在字段对比/断点检查前调用，保证并行执行的数据就绪且不会串到下一张卡片 */
  const joinBgOcrForRecord = useCallback(async (recordId?: string) => {
    let ps: Array<Promise<unknown>> = [];
    if (recordId) {
      ps = bgOcrPromisesRef.current.get(recordId) || [];
      bgOcrPromisesRef.current.delete(recordId);
    } else {
      ps = Array.from(bgOcrPromisesRef.current.values()).flat();
      bgOcrPromisesRef.current.clear();
    }
    if (ps.length > 0) {
      rlog(`[high-speed] join：等待 ${ps.length} 个后台 OCR 完成（字段对比前）`);
      await Promise.allSettled(ps);
    }
    if (recordId) {
      const verify = pendingFileVerifyRef.current.get(recordId);
      pendingFileVerifyRef.current.delete(recordId);
      if (verify) await verify();
    } else {
      const verifies = Array.from(pendingFileVerifyRef.current.values());
      pendingFileVerifyRef.current.clear();
      for (const v of verifies) await v();
    }
  }, []);

  const executeTemplateForRecord = useCallback(async (
    tpl: WorkflowTemplate,
    record: ApplicantRecord,
    recordIndex: number,
    onStepStart?: (recordIndex: number, mark: PickedMark) => void,
    options?: { wrapWithVerify?: boolean; skipSubmit?: boolean; preOnly?: boolean; postThenPre?: boolean; entryReview?: boolean; deferCompare?: boolean; onStepFail?: (recordIndex: number, mark: PickedMark, error: string) => void; onStepSkip?: (recordIndex: number, mark: PickedMark, note: string) => void }
  ): Promise<{ success: boolean; failedOrder?: number; error?: string; comparisons?: FieldComparison[]; verifyOverall?: "match" | "mismatch"; skippedErrors?: string[]; fills?: { label: string; field: string; value: string }[]; hasOnErrorBreakpoint?: boolean }> => {
    // 根据模板模式选择执行哪一段 marks
    // - entry 模式：只执行录入流（填表+提交）
    // - review 模式：只执行审查流（搜索+对比）
    // - loop 模式：分三段执行：pre(搜索输入+前置点击) → body(审查/录入步骤) → post(收尾点击)
    // - postThenPre 模式（查看卡片）：先执行post(收尾返回)，再执行pre(搜索+前置点击)
    // - entryReview 模式（录入模式查看卡片）：只回放右侧网页的搜索定位步骤（不执行左侧录入/提交）
    let allMarks: PickedMark[];
    let postThenPreBoundary = 0; // postThenPre/entryReview模式下，post段结束的索引，之后需要等待页面加载
    if (tpl.mode === "entry") {
      if (options?.entryReview) {
        // 录入模式回访查看：右侧网页的界面和步骤与审查模式完全不同，
        // 只回放右侧网页步骤（搜索输入+确认人物）和前置/收尾点击，跳过左侧录入表单和提交
        const pool = [...tpl.dataSourceMarks, ...tpl.reviewMarks, ...tpl.entryMarks]
          .filter((m) => m.side === "right" || m.clickPhase === "pre" || m.clickPhase === "mid" || m.clickPhase === "post")
          .filter((m) => m.action === "input" || m.action === "click");
        const postClicks = pool.filter((m) => m.action === "click" && m.clickPhase === "post");
        const restMarks = pool
          .filter((m) => !(m.action === "click" && m.clickPhase === "post"))
          .sort((a, b) => a.order - b.order);
        allMarks = [...postClicks, ...restMarks];
        postThenPreBoundary = postClicks.length; // post结束后等待页面加载
      } else {
        allMarks = options?.preOnly ? [] : [...tpl.entryMarks];
      }
    } else if (tpl.mode === "review") {
      allMarks = [...tpl.dataSourceMarks, ...tpl.reviewMarks];
      if (options?.preOnly || options?.postThenPre) {
        // preOnly/postThenPre模式：只执行搜索输入+前置点击，不执行审查步骤
        const preClicks = allMarks.filter(m => m.action === "click" && m.clickPhase === "pre");
        const inputs = allMarks.filter(m => m.action === "input"); // 搜索输入
        allMarks = [...inputs, ...preClicks].sort((a, b) => a.order - b.order);
      }
    } else {
      // loop 全流程模式：分三段
      const allClickMarks = [...tpl.dataSourceMarks, ...tpl.reviewMarks, ...tpl.entryMarks].filter(m => m.action === "click");
      const preClickMarks = allClickMarks.filter(m => m.clickPhase === "pre");
      const midClickMarks = allClickMarks.filter(m => m.clickPhase === "mid");
      const postClickMarks = allClickMarks.filter(m => m.clickPhase === "post");
      const dataSourceInputs = tpl.dataSourceMarks.filter(m => m.action !== "click" || !m.clickPhase);
      if (options?.postThenPre) {
        // 查看卡片模式：先收尾点击(返回搜索页)，再搜索输入+前置点击(定位到新卡片)
        const preMarks = [...dataSourceInputs, ...preClickMarks].sort((a, b) => a.order - b.order);
        allMarks = [...postClickMarks, ...preMarks];
        postThenPreBoundary = postClickMarks.length; // post结束后等待页面加载
      } else if (options?.preOnly) {
        // preOnly模式：只执行搜索输入+前置点击（定位到卡片页面），不执行body和post
        allMarks = [...dataSourceInputs, ...preClickMarks].sort((a, b) => a.order - b.order);
      } else {
        const bodyMarks = [...tpl.reviewMarks, ...tpl.entryMarks].filter(m => {
          if (m.action !== "click") return true;
          // 收尾点击单独放到最后；过程点击(mid)与审查/录入步骤一起按序执行
          return m.clickPhase !== "post";
        });
        allMarks = [
          ...dataSourceInputs,
          ...preClickMarks,
          ...midClickMarks,
          ...bodyMarks,
          ...postClickMarks,
        ];
        allMarks = allMarks.sort((a, b) => a.order - b.order);
      }
    }
    if (!options?.preOnly && !options?.postThenPre && !options?.entryReview) {
      allMarks = allMarks.sort((a, b) => a.order - b.order);
    }
    // 单卡导航模式（功能3）：跳过提交类点击，避免重复提交表单
    if (options?.skipSubmit) {
      allMarks = allMarks.filter(
        (m) => !(m.action === "click" && /提交|保存|submit|save/i.test(m.label || ""))
      );
    }
    // 过滤掉文件提取的收尾点击(docExtractClickPhase==="post")，这些在所有记录处理完后统一执行
    allMarks = allMarks.filter(
      (m) => !(m.docExtractClick && m.docExtractClickPhase === "post")
    );
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // 通用recordKey查找：优先name字段，再找第一个非空字段，最后用record_id
    const fieldKeys = Object.keys(record.fields);
    const recordKey = record.fields["name"]
      || record.fields["student_id"]
      || fieldKeys.map((k) => record.fields[k]).find((v) => v && String(v).trim())
      || record.record_id;
    rlog(`[batch] 开始执行第 ${recordIndex + 1} 行: ${recordKey}, marks=${allMarks.length}`);

    // 每张卡片执行前清空文件运行时槽位（避免跨卡片串文件）
    docRuntimeFileSlotsRef.current = {};
    lastDocRuntimeFileRef.current = null;
    // 高速模式：清掉本卡片自己可能残留的后台 OCR 队列与延后校验（正常路径 join 后已为空，双保险防串行）。
    // 只清当前人：两遍式流水线下前一人后台 OCR 可能还在途，全清会让 pass2 join 误判已就绪
    bgOcrPromisesRef.current.delete(record.record_id);
    pendingFileVerifyRef.current.delete(record.record_id);
    // 两遍式 pass1 标记：marks 执行期间文件提取 OCR 无条件后台化（每次进入都重置，
    // 非 defer 调用自动置回 false，防止上一轮 pass1 中途停止后残留在 true）
    passDeferActiveRef.current = options?.deferCompare === true;

    // 进入marks执行阶段（触发UI光标动画）
    setExecPhase("marks");
    setVerifyFieldIdx(-1);
    setReviewFieldResults({});
    // 重置本记录的逐对填卡数据（一对一对填入卡片对比效果）；上一人的对比归档进历史
    archiveLivePairs();
    setLivePairs({ recordId: record.record_id, pairs: [] });

    // 本记录实际填入的值（供录入流报告卡片展示一左一右内容，不再空白）
    const fills: { label: string; field: string; value: string }[] = [];
    // 本记录被跳过/吞掉的失败步骤（收尾点击失败、断点人工跳过）——必须体现在最终报告里
    const skippedErrors: string[] = [];

    for (let mi = 0; mi < allMarks.length; mi++) {
      if (batchStopRef.current) {
        return { success: false, error: "用户已停止批量执行" };
      }
      const mark = allMarks[mi];
      const markSide: ViewSide = mark.side === "left" ? "left" : "right";
      try {
        // 计算当前mark之前已经执行了多少个pre-click步骤（供保底机制回退页面用）
        // 统计从0到mi之间，action==="click"且不是docExtractClick的pre-click数量
        let executedPreClicks = 0;
        for (let pi = 0; pi < mi; pi++) {
          const pm = allMarks[pi];
          if (pm.action === "click" && pm.clickPhase === "pre" && !pm.docExtractClick) {
            executedPreClicks++;
          }
          // 数据源输入也会导致页面变化，额外+1
          if (pm.action === "input" && pm.workflow === "data-source") {
            executedPreClicks++;
          }
        }
        // 如果当前mark是doc web-download，额外加上开头点击步骤数（docExtractClickPhase !== "post"的）
        // 排除 panelAction 标记（「录入提取」是面板动作，不会导致网页导航，不计入回退页数）
        if (mark.docSource === "web-download") {
          const docPreClicks = allMarks.filter(
            (m, idx) => idx < mi && m.docExtractClick && m.docExtractClickPhase !== "post" && !m.panelAction
          ).length;
          executedPreClicks += docPreClicks;
        }
        currentPreClickCountRef.current = executedPreClicks;

        // 断网容错：步骤执行前检测网络，断网则等待恢复（最多30s）
        if (!(await checkViewOnline(markSide))) {
          rlog(`[batch] 第 ${recordIndex + 1} 行检测到断网，等待网络恢复...`);
          const restored = await waitNetworkRestore(markSide, 30000);
          if (!restored) {
            return {
              success: false,
              failedOrder: mark.order,
              error: "网络断开且 30 秒内未恢复",
            };
          }
          rlog(`[batch] 网络已恢复，继续执行第 ${recordIndex + 1} 行`);
          // 网络恢复后页面可能需要重新稳定
          await waitPageSettled(markSide, 3000);
        }
        // 步骤开始前通知外层，用于高亮/日志/动画
        onStepStart?.(recordIndex, mark);
        await executeMark(mark, record);
        // 记录填入值（录入流报告卡片的一左一右内容：左=来源值，右=填入的网页字段）
        if (mark.action === "input") {
          const docFields = getRecordDocFields(record.record_id);
          const v = mark.variableField
            ? (record.fields[mark.variableField] ?? record.passport_fields?.[mark.variableField] ?? docFields[mark.variableField] ?? "")
            : (mark.value || "");
          fills.push({
            label: markDisplayLabel(mark),
            field: mark.variableField || "",
            value: String(v ?? "").trim(),
          });
          // 逐对填入卡片：录入值作为一对（左=来源字段值，右=填入的网页字段）
          const fillPair: LivePair = {
            label: markDisplayLabel(mark),
            leftValue: String(v ?? "").trim(),
            rightValue: "",
            status: "match",
            kind: "fill",
          };
          setLivePairs((prev) => prev.recordId === record.record_id
            ? { ...prev, pairs: [...prev.pairs, fillPair] }
            : prev);
        }
        // 根据动作类型等待页面响应（高速模式压缩固定等待，页面稳定检测照常兜底）
        if (mark.action === "click") {
          // 点击按钮/链接后等待页面加载/跳转（智能等待页面稳定，替代纯固定延时）
          const isSubmitOrSearch = /搜索|查询|submit|search|确认|进入|查看|登录|提交|保存/i.test(mark.label);
          const hsClick = settingsRef.current.high_speed_mode === true;
          const maxWait = isSubmitOrSearch ? (hsClick ? 1800 : 2500) : (hsClick ? 900 : 1500);
          await Promise.race([waitPageSettled(markSide, maxWait + 1000), sleep(maxWait)]);
        } else if (mark.action === "input") {
          // 输入后等待较短时间让框架感知
          await sleep(settingsRef.current.high_speed_mode === true ? 300 : 600);
        } else {
          await sleep(settingsRef.current.high_speed_mode === true ? 200 : 400);
        }
        // postThenPre模式：post段结束后额外等待页面稳定（收尾点击后页面跳转回搜索页）
        if (postThenPreBoundary > 0 && mi === postThenPreBoundary - 1) {
          await sleep(800);
          await Promise.race([waitPageSettled("left", 3000), waitPageSettled("right", 3000), sleep(2000)]);
        }

        // ---- 断点检查（步骤成功执行后） ----
        // 高速模式：文件提取步骤设了断点 → 先等后台 OCR 落定再检查（停下时文件内容已可见、警告已产生）
        if (mark.docExtract && mark.breakpoint && settingsRef.current.high_speed_mode === true) {
          await joinBgOcrForRecord();
        }
        const markLabel = mark.label
          ? markDisplayLabel(mark)
          : mark.action === "click" ? "点击" : mark.action === "input" ? (mark.workflow === "entry" ? "录入" : "审查") : "提取";
        if (mark.breakpoint === "always") {
          rlog(`[batch] 断点（强制）触发：第 ${recordIndex + 1} 行步骤「${markLabel}」，等待人工继续`);
          await waitForBreakpointRef.current({
            recordName: String(recordKey),
            recordIndex: recordIndex + 1,
            stepLabel: markLabel,
            type: "always",
          });
        } else if (mark.breakpoint === "on-error") {
          // 条件断点：检查文件提取是否有警告（MRZ 警告、降级引擎等）
          let docWarn: string | undefined;
          if (mark.docExtract) {
            const extracts = docExtractsByRecordRef.current[record.record_id] || [];
            const latest = extracts[extracts.length - 1];
            if (latest) {
              const warnings: string[] = [];
              if (latest.mrz_warnings?.length) warnings.push(...latest.mrz_warnings);
              if (latest.fallback) warnings.push(`所选引擎 ${extractMethodLabel(latest.fallback.from)} 失败，已自动切换 ${extractMethodLabel(latest.fallback.to)}：${latest.fallback.reason || "未知错误"}`);
              if (warnings.length > 0) docWarn = warnings.join("; ");
            }
          }
          if (docWarn) {
            rlog(`[batch] 断点（条件-文件警告）触发：${docWarn}`);
            await waitForBreakpointRef.current({
              recordName: String(recordKey),
              recordIndex: recordIndex + 1,
              stepLabel: markLabel,
              type: "on-error",
              error: `文件提取可能有问题：${docWarn}`,
            });
          }
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        rlog(`[batch] 第 ${recordIndex + 1} 行步骤 ${mark.order} 失败:`, e);
        // 收尾点击是清理动作（关弹窗/回主页），失败不中断本记录剩余步骤——
        // 否则"回到主页"还没跑记录就结束了，页面残留在详情页
        if (mark.action === "click" && (mark.clickPhase === "post" || mark.docExtractClick)) {
          // 目标已不存在 = 闭环目的已达成（弹窗已自行关闭/页面已在主页）：
          // 标记为"跳过"而非失败，避免实时卡片误红、最终报告误绿的两头矛盾
          if (/元素未找到|元素未出现|not.?found|不存在/i.test(errMsg)) {
            rlog(`[batch] 第 ${recordIndex + 1} 行收尾点击目标不存在，视为已闭环跳过: ${mark.label || mark.selector}`);
            options?.onStepSkip?.(recordIndex, mark, "目标已不存在，视为已闭环");
          } else {
            // 真正的收尾失败：步骤标红 + 记入 skippedErrors，最终报告必须体现
            options?.onStepFail?.(recordIndex, mark, errMsg);
            skippedErrors.push(`收尾点击「${mark.label || mark.selector}」失败：${errMsg}`);
            rlog(`[batch] 第 ${recordIndex + 1} 行收尾点击失败，继续执行剩余收尾步骤: ${errMsg}`);
          }
          continue;
        }
        // 步骤行标记为失败（onStepStart 时已乐观打勾，这里纠正为失败态）
        options?.onStepFail?.(recordIndex, mark, errMsg);
        // 条件断点：步骤执行出错时暂停，让人工干预后继续（而非直接失败返回）
        if (mark.breakpoint === "on-error") {
          const markLabel = mark.label || `步骤${mark.order}`;
          rlog(`[batch] 断点（条件-执行错误）触发：${errMsg}，等待人工干预`);
          await waitForBreakpointRef.current({
            recordName: String(recordKey),
            recordIndex: recordIndex + 1,
            stepLabel: markLabel,
            type: "on-error",
            error: `执行出错：${errMsg}`,
          });
          // 人工点继续后，跳过当前失败步骤继续执行下一个——但要记入报告，不能装没事
          skippedErrors.push(`步骤${mark.order}「${markLabel}」执行出错，人工选择跳过：${errMsg}`);
          continue;
        }
        return {
          success: false,
          failedOrder: mark.order,
          error: errMsg,
        };
      }
    }
    // === 两遍式流水线：pass1 只跑浏览器步骤（deferCompare），join+比对延到 pass2 统一做 ===
    // AI 管线（OCR+DeepSeek）在后台按人堆积并行，pass2 逐人 join 时大概率零等待
    if (options?.deferCompare) {
      return {
        success: true,
        comparisons: [],
        verifyOverall: "match",
        skippedErrors,
        fills,
        hasOnErrorBreakpoint: allMarks.some((m) => m.breakpoint === "on-error"),
      };
    }

    // === 高速模式 join：等待本记录后台 OCR 全部落定（浏览器步骤已并行执行完毕）===
    // 字段对比/报告依赖 OCR 结果，此处统一收口；正常情况下浏览器步骤耗时已覆盖大半 OCR 时长
    await joinBgOcrForRecord(record.record_id);

    // 每条记录workflow步骤执行完后等待，让页面稳定（高速模式减半）
    await sleep(settingsRef.current.high_speed_mode === true ? 400 : 800);

    // 所有 marks 执行完毕，进行字段比对（审查机制）
    let comparisons: FieldComparison[] = [];
    let verifyOverall: "match" | "mismatch" = "match";
    if (options?.wrapWithVerify) {
      // 模板未保存 mappings 时从审查 marks 兜底推导，保证字段对比有数据
      const cmp = await compareFieldsForRecord(record, recordIndex, getTemplateMappings(tpl), tpl.customTextEntries);
      comparisons = cmp.comparisons;
      verifyOverall = cmp.overall;
      // 条件断点：字段比对发现不匹配，且本次执行的 marks 中有 on-error 断点
      // （比对未执行/无比对条目时不触发，避免"0 个字段不匹配"的空断点）
      if (verifyOverall === "mismatch" && comparisons.length > 0 && allMarks.some((m) => m.breakpoint === "on-error")) {
        const mismatchFields = comparisons.filter((c) => c.match === "mismatch" || c.match === "error");
        const detail = mismatchFields.map((c) => `${c.field}: 「${c.excel_value}」vs「${c.website_value}」`).join("; ");
        rlog(`[batch] 断点（条件-字段不匹配）触发：${mismatchFields.length} 个字段不匹配`);
        await waitForBreakpointRef.current({
          recordName: String(recordKey),
          recordIndex: recordIndex + 1,
          stepLabel: "字段比对（审查）",
          type: "on-error",
          error: `${mismatchFields.length} 个字段不匹配：${detail}`,
        });
      }
    }

    return { success: true, comparisons, verifyOverall, skippedErrors, fills };
  }, [executeMark, compareFieldsForRecord, checkViewOnline, waitNetworkRestore, waitPageSettled, getRecordDocFields, joinBgOcrForRecord]);

  // ============ 执行分析：LOOP 运行中问题卡片实时追加 + 结束后总结段（球体进入处理态表明 AI 正在工作） ============
  /** 分段 upsert：card 分段已存在则原位更新（重新生成），不存在时插到总结段之前，总结段始终沉底 */
  const upsertAnalysisSegment = useCallback((seg: AnalysisSegment) => {
    setAnalysisSegments((prev) => {
      const idx = prev.findIndex((s) => s.key === seg.key);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = seg;
        return next;
      }
      if (seg.kind === "card") {
        const sIdx = prev.findIndex((s) => s.kind === "summary");
        if (sIdx >= 0) {
          const next = prev.slice();
          next.splice(sIdx, 0, seg);
          return next;
        }
      }
      return [...prev, seg];
    });
  }, []);

  /** 报告 → 分析 API 的 cards 载荷（与后端 LoopAnalysisCard 对齐） */
  const buildAnalysisCardPayload = useCallback((r: VerificationReport) => ({
    name: r.record_name || r.record_id,
    overall: r.overall,
    summary: r.summary || "",
    mismatches: r.entries
      .filter((e) => e.match === "mismatch" || e.match === "error" || e.match === "missing")
      .slice(0, 10)
      .map((e) => ({
        label: e.right_label || e.left_field || "字段",
        source_value: (e.left_value || "").slice(0, 60),
        target_value: (e.right_value || "").slice(0, 60),
        match: e.match,
        reasoning: (e.reasoning || "").slice(0, 120),
      })),
    mrz_warnings: r.mrz_warnings || [],
  }), []);

  /** 单卡即时分析：LOOP 运行中问题卡片完成即调用，结果实时追加为独立分段（不阻塞主循环） */
  const appendCardAnalysis = useCallback(async (report: VerificationReport) => {
    const key = report.record_id;
    const title = report.record_name || report.record_id;
    setAnalysisAvailable(true);
    upsertAnalysisSegment({ key, title, kind: "card", text: "", loading: true, overall: report.overall });
    try {
      const res = await api.loopAnalysis({ cards: [buildAnalysisCardPayload(report)], mode: "card" });
      upsertAnalysisSegment({ key, title, kind: "card", text: res.text, loading: false, overall: report.overall });
    } catch (e) {
      upsertAnalysisSegment({
        key, title, kind: "card", loading: false, overall: report.overall,
        text: `分析生成失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }, [upsertAnalysisSegment, buildAnalysisCardPayload]);

  /** 整轮总结：LOOP 全部结束后（或手动重新生成）写入「执行总结」分段，始终排在最后 */
  const generateLoopAnalysis = useCallback(async (reports: VerificationReport[], elapsedMs?: number) => {
    // 审查与录入提取流程的报告都纳入分析（录入流程同样有 提取值 vs Excel 的不一致项）
    const reviewReports = reports;
    if (reviewReports.length === 0) return;
    const seq = ++analysisSeqRef.current;
    setAnalysisAvailable(true);
    setAnalysisOpen(true); // 自动把卡片区域切换为分析文本框

    // 执行统计：处理卡片数 / 用时 / 通过 / 有问题 / 需检查（缺件）
    const pass = reviewReports.filter((r) => r.overall === "pass").length;
    const review = reviewReports.filter((r) => r.overall === "review").length;
    const fail = reviewReports.filter((r) => r.overall === "fail").length;
    let ms = elapsedMs;
    if (ms == null) {
      // 手动重新生成等场景：从各报告的起止时间推导整轮用时
      const starts = reviewReports.map((r) => (r.started_at ? Date.parse(r.started_at) : NaN)).filter((t) => !Number.isNaN(t));
      const ends = reviewReports.map((r) => (r.finished_at ? Date.parse(r.finished_at) : NaN)).filter((t) => !Number.isNaN(t));
      if (starts.length && ends.length) ms = Math.max(...ends) - Math.min(...starts);
    }
    let duration = "—";
    if (ms != null && ms >= 0) {
      const s = Math.max(1, Math.round(ms / 1000));
      duration = s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
    }
    const stats = { total: reviewReports.length, duration, pass, review, fail };

    upsertAnalysisSegment({ key: "summary", title: "执行总结", kind: "summary", text: "", loading: true, stats });
    try {
      const res = await api.loopAnalysis({
        cards: reviewReports.map((r) => buildAnalysisCardPayload(r)),
        duration_ms: ms != null && ms >= 0 ? Math.round(ms) : undefined,
      });
      if (seq !== analysisSeqRef.current) return; // 已有更新的总结请求在跑
      upsertAnalysisSegment({ key: "summary", title: "执行总结", kind: "summary", text: res.text, loading: false, stats });
    } catch (e) {
      if (seq !== analysisSeqRef.current) return;
      upsertAnalysisSegment({
        key: "summary", title: "执行总结", kind: "summary", loading: false, stats,
        text: `分析生成失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }, [upsertAnalysisSegment, buildAnalysisCardPayload]);

  // ============ 单人即时分析：点击已完成卡片的「查看」→ 更新/追加该卡的独立分析分段 ============
  const generateSingleCardAnalysis = useCallback(async (recordId: string, recordName: string) => {
    const rep = loopReportsRef.current.find((r) => r.record_id === recordId);
    if (!rep) return;
    setAnalysisOpen(true);
    void appendCardAnalysis(rep);
  }, [appendCardAnalysis]);

  // 点击已完成卡片的「查看」：定位该记录 + AI 即时指出该人哪些字段不对
  const handleViewLiveCard = useCallback((recordId: string) => {
    handleSelectCard(recordId);
    const rec = records.find((r) => r.record_id === recordId);
    generateSingleCardAnalysis(recordId, rec?.fields?.name || "");
  }, [handleSelectCard, records, generateSingleCardAnalysis]);

  const runBatch = useCallback(async (tplOverride?: WorkflowTemplate, targetIds?: string[]) => {
    // 防重入：已有 LOOP 在执行时忽略重复触发（双击/effect 重放/IPC 重复投递），杜绝"结束后自己又跑一遍"
    if (runBatchInFlightRef.current) {
      console.warn("[runBatch] ⚠️ 已有 LOOP 正在执行，忽略重复触发");
      rlog("[runBatch] 已有 LOOP 正在执行，忽略重复触发");
      return;
    }
    runBatchInFlightRef.current = true;
    const tpl = tplOverride ?? workflowTemplateRef.current ?? lastTemplateRef.current;
    console.log("[runBatch] 🚀 开始执行，tpl=", !!tpl, "records.length=", records.length, "selectedId=", selectedId, "targetIds=", targetIds?.length);
    if (!tpl) {
      console.warn("[runBatch] ❌ 无 workflowTemplate，退出");
      runBatchInFlightRef.current = false;
      return;
    }
    // 持久化保存当前使用的模板
    lastTemplateRef.current = tpl;
    if (cardRecords.length === 0) {
      console.warn("[runBatch] ❌ cardRecords 为空（未框选生成卡片），退出");
      runBatchInFlightRef.current = false;
      setError("请先在 Excel 视图框选 LOOP 行范围并点击「一键生成卡片」");
      return;
    }

    // 自动切换到底部面板的执行日志tab
    setLogSignal((s) => s + 1);

    const dataSourceCount = tpl.dataSourceMarks.length;
    const reviewCount = tpl.reviewMarks.length;
    const entryCount = tpl.entryMarks.length;
    console.log(`[runBatch] 📋 marks统计: dataSource=${dataSourceCount}, review=${reviewCount}, entry=${entryCount}, mode=${tpl.mode}`);
    rlog(`[runBatch] 🚀 启动，共 ${cardRecords.length} 条记录，marks: dataSource=${dataSourceCount}, review=${reviewCount}, entry=${entryCount}`);

    batchStopRef.current = false;
    setBatchRunning(true);
    setHasRunOnce(true); // 跑完 LOOP 后「日志」按钮需要 hasRunOnce 才显示
    setBatchResults({});
    setBatchMarkCursor(null);
    setError(null);
    setSteps([]);
    setReport(null);
    setLoopReports([]);
    setVerifyStatus("idle");
    setResult(null);
    // 清掉教学期残留的文件提取浮动面板，防止运行结束后残留飘出
    setDocExtractPanel(null);
    // 清空上一轮/教学期残留的文件提取缓存：每张卡片的字段对比只许用本次新鲜提取，杜绝串行（列对行错、拿别人的信息检查当前卡）
    setDocExtractsByRecord({});
    // 清空上一轮保底机制残留的整页下载文件缓存（全文件无清空点、跨轮次累积；跑完到下一轮之间保留供人工回看）
    setFallbackFilesByRecord({});
    needsManualRef.current = new Set();
    // 高速模式：同步清掉上一轮残留的后台 OCR 队列/缓存/延后校验，防止上一轮的 OCR 写进新一轮的卡片
    bgOcrResultRef.current = null;
    bgOcrPromisesRef.current.clear();
    pendingFileVerifyRef.current.clear();
    setLivePairsHistory({}); // 清上一轮历史（不归档旧数据）
    setLivePairs({ recordId: "", pairs: [] });
    // 重置执行阶段状态
    setExecPhase("idle");
    setVerifyFieldIdx(-1);
    setReviewFieldResults({});
    setExecRecordId(null);

    // 执行前退出选择/编辑模式（手动退出，不调用exitSelectMode以避免清空workflowTemplate）
    if (selectMode) {
      setSelectMode(false);
      setPickTarget(null);
      setRightPicked(null);
      setLeftPicked(null);
    }
    if (avatarMode) exitAvatarMode();
    setPendingAction("none");
    setBindInputSide(null);
    setNextClickLabel(null);
    setAddingStepMode(null);
    setAddingClickMode(false);

    window.electronAPI?.viewClearHighlight("left").catch(() => {});
    window.electronAPI?.viewClearHighlight("right").catch(() => {});

    // 非勾选模式：跳过第一张示范卡（教学时已录入过），从第二张开始按原顺序执行
    // 勾选模式：只执行勾选的卡片，按原列表顺序排列
    const skipFirst = !targetIds || targetIds.length === 0;
    const pool = skipFirst ? cardRecords.slice(1) : cardRecords;
    const targets = targetIds && targetIds.length > 0
      ? cardRecords.filter((r) => targetIds.includes(r.record_id))
      : pool;
    if (targets.length === 0) {
      console.warn("[runBatch] ⚠️ 待执行卡片为空（已全部跳过示范卡）");
      setBatchRunning(false);
      runBatchInFlightRef.current = false;
      return;
    }
    setBatchTargets(targets);
    breakpointTotalRef.current = targets.length;

    // 快照教学时左右网页的 URL：每条 LOOP 开始前重置回这个搜索页，
    // 保证每条记录都从同一个初始页面状态开始（搜索框存在、无残留详情页）
    const baseLeftUrl = leftUrl;
    const baseRightUrl = rightUrl;

    // 计算本次执行实际会用到哪些侧的网页（只重置用到的，避免无谓刷新）
    const hasReviewSteps = tpl.reviewMarks.length > 0;
    const hasEntrySteps = tpl.entryMarks.length > 0;
    const execMarks = tpl.mode === "entry"
      ? tpl.entryMarks
      : tpl.mode === "review"
      ? [...tpl.dataSourceMarks, ...tpl.reviewMarks]
      : [...tpl.dataSourceMarks, ...tpl.reviewMarks, ...tpl.entryMarks];
    // 回填本次 LOOP 的步骤与字段映射到会话面板：运行已保存 LOOP 时，
    // 「字段对比」区域的步骤条和审查字段列表也能看到内容（否则面板空跑）
    setPickedMarks(execMarks);
    setMappings(getTemplateMappings(tpl));
    // 提取元素面板条目（含文件提取字段的 Excel 列绑定）回填：运行时对比与表头绑定高亮都依赖它
    if ((tpl.customTextEntries?.length ?? 0) > 0) setCustomTextEntries(tpl.customTextEntries!);
    // 只重置右侧网页（目标网站），不重置左侧网页（数据源），
    // 避免左侧网页侧边栏等状态因重新加载而丢失。
    // 录入步骤从左网页读取值时也不重置左侧（左网页状态由用户控制）。
    const usedSides = new Set<ViewSide>();
    usedSides.add("right"); // 右侧（目标网站）始终重置

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const startedAt = new Date().toISOString();
    let successCount = 0;
    let failCount = 0;
    let matchCount = 0;
    let mismatchCount = 0;
    const allEntries: VerificationReportEntry[] = [];
    const allComparisons: FieldComparison[] = [];
    // 本次执行的人物报告累积：供结束后 AI 执行分析使用（state 异步，finally 里读不到最新值）
    const collectedReports: VerificationReport[] = [];
    // 新一轮执行：清空上一轮分析分段，运行中即切换到执行分析视图——
    // 问题卡片完成后 AI 分析实时逐段追加，不等全部跑完
    setAnalysisSegments([]);
    setAnalysisAvailable(true);
    setAnalysisOpen(true);

    // 首条日志同步写入，让用户点击后立刻看到 LOOP 已启动
    rlog(`[batch] 开始LOOP执行，共 ${targets.length} 条${skipFirst ? "（已跳过示范卡，从第二张开始）" : "（勾选模式）"}`);
    setSteps([
      {
        step: 1,
        action: "log",
        description: `LOOP 启动：共 ${targets.length} 条记录，从当前选中卡片（${targets[0]?.fields.name || targets[0]?.record_id}）开始执行`,
        success: true,
        timestamp: new Date().toISOString(),
      },
    ]);

    await sleep(400);

    const onStepStart = (recordIndex: number, mark: PickedMark) => {
      setBatchMarkCursor({ recordIndex, markOrder: mark.order });
      // 记录当前步骤日志前缀，供文件提取等长耗时阶段实时回写 detail 进展
      liveStepPrefixRef.current = `LOOP [${recordIndex + 1}/${targets.length}] 步骤 ${mark.order}:`;
      const side: ViewSide = mark.side === "left" ? "left" : "right";
      const selector = mark.action === "input" && mark.inputTarget ? mark.inputTarget : mark.selector;
      const label = `${mark.order} · ${markDisplayLabel(mark)}`;
      window.electronAPI?.viewClearHighlight(side).catch(() => {});
      window.electronAPI?.viewHighlightBoxes(side, [{ selector, status: "pending", label }]).catch(() => {});
      setSteps((prev) => [
        ...prev,
        {
          step: prev.length + 1,
          action: mark.action || "pick",
          description: `LOOP [${recordIndex + 1}/${targets.length}] 步骤 ${mark.order}: ${markDisplayLabel(mark)}`,
          success: true,
          detail: mark.action === "input"
            ? `${mark.workflow === "entry" ? "填入" : "定位"}: ${mark.variableField ? `[${mark.variableField}]` : (mark.value || "")}`
            : undefined,
          timestamp: new Date().toISOString(),
        },
      ]);
    };

    const onStepFail = (recordIndex: number, mark: PickedMark, error: string) => {
      // 找到该步骤对应的行（从后往前找该记录内最后一条匹配），把乐观的绿勾纠正为失败红叉
      const prefix = `LOOP [${recordIndex + 1}/${targets.length}] 步骤 ${mark.order}:`;
      setSteps((prev) => {
        for (let k = prev.length - 1; k >= 0; k--) {
          const s = prev[k];
          if (s.description?.startsWith(prefix)) {
            const next = [...prev];
            next[k] = { ...s, success: false, detail: error };
            return next;
          }
        }
        return prev;
      });
    };

    // 良性跳过（如收尾点击的目标已不存在）：保持绿勾，只补一句跳过说明，不标红
    const onStepSkip = (recordIndex: number, mark: PickedMark, note: string) => {
      const prefix = `LOOP [${recordIndex + 1}/${targets.length}] 步骤 ${mark.order}:`;
      setSteps((prev) => {
        for (let k = prev.length - 1; k >= 0; k--) {
          const s = prev[k];
          if (s.description?.startsWith(prefix)) {
            const next = [...prev];
            next[k] = { ...s, success: true, detail: note };
            return next;
          }
        }
        return prev;
      });
    };

    try {
      // ============ 两遍式流水线 pass1：先跑完所有人的浏览器步骤，AI 管线后台堆积并行 ============
      // 必须保持旧逐人时序的只有「审查步骤+网页字段映射」的 LOOP——compareFieldsForRecord
      // 用 viewExecuteJS 实时读当前页，浏览器翻页后读到的是别人的页面。
      // 注意不能用 getTemplateMappings(tpl).length>0 单独判断：它对任何带步骤的模板都会
      // 从 marks 反推出非空映射（恒 true）。录入+文件提取型 LOOP（hasReviewSteps=false）
      // 的比对是纯内存（fills+提取值vsExcel），延后安全。
      const tplHasWebMappings = hasReviewSteps && getTemplateMappings(tpl).length > 0;
      const passResults: Array<{ record: ApplicantRecord; i: number; result: Awaited<ReturnType<typeof executeTemplateForRecord>> }> = [];
      if (!tplHasWebMappings) {
        for (let i = 0; i < targets.length; i++) {
          if (batchStopRef.current) break;
          const record = targets[i];
          setBatchCursor(i);
          setSelectedId(record.record_id);
          setExecRecordId(record.record_id);
          setBatchResults((prev) => ({
            ...prev,
            [record.record_id]: { recordId: record.record_id, status: "running", startedAt: Date.now() },
          }));
          setSteps((prev) => [
            ...prev,
            {
              step: prev.length + 1,
              action: "record",
              description: `处理记录：${record.fields.name || record.record_id}`,
              success: true,
              timestamp: new Date().toISOString(),
              isRecordStart: true,
              recordName: record.fields.name || record.record_id,
              recordId: record.record_id,
              recordIndex: i + 1,
              recordTotal: targets.length,
            },
          ]);
          window.electronAPI?.viewClearHighlight("left").catch(() => {});
          window.electronAPI?.viewClearHighlight("right").catch(() => {});
          for (const side of usedSides) {
            const baseUrl = side === "left" ? baseLeftUrl : baseRightUrl;
            if (!baseUrl || !window.electronAPI) continue;
            setSteps((prev) => [
              ...prev,
              {
                step: prev.length + 1,
                action: "navigate",
                description: `LOOP [${i + 1}/${targets.length}] 重置${side === "left" ? "左" : "右"}侧网页到搜索页`,
                success: true,
                timestamp: new Date().toISOString(),
              },
            ]);
            await window.electronAPI.viewLoad(side, baseUrl);
            await waitViewReady(side);
            if (batchStopRef.current) break;
          }
          await sleep(300);
          const r1 = await executeTemplateForRecord(tpl, record, i, onStepStart, {
            wrapWithVerify: hasReviewSteps,
            deferCompare: true,
            onStepFail,
            onStepSkip,
          });
          passResults.push({ record, i, result: r1 });
          rlog(`[batch] pass1 浏览器步骤完成 [${i + 1}/${targets.length}]: ${record.fields.name || record.record_id}（AI 后台排版中）`);
          setSteps((prev) => [
            ...prev,
            {
              step: prev.length + 1,
              action: "record",
              description: `LOOP [${i + 1}/${targets.length}] 浏览器步骤完成：${record.fields.name || record.record_id}（AI 后台排版中）`,
              success: true,
              timestamp: new Date().toISOString(),
            },
          ]);
        }
      }

      for (let i = 0; i < targets.length; i++) {
        if (batchStopRef.current) {
          setSteps((prev) => [
            ...prev,
            {
              step: prev.length + 1,
              action: "error",
              description: "LOOP 被用户停止",
              success: false,
              timestamp: new Date().toISOString(),
            },
          ]);
          break;
        }
        const record = targets[i];
        let result: Awaited<ReturnType<typeof executeTemplateForRecord>>;
        if (tplHasWebMappings) {
          // 网页字段映射：保持旧逐人时序（比对实时读当前页，不能延后）
          setBatchCursor(i);
          setSelectedId(record.record_id);
          setExecRecordId(record.record_id);
          setBatchResults((prev) => ({
            ...prev,
            [record.record_id]: {
              recordId: record.record_id,
              status: "running",
              startedAt: Date.now(),
            },
          }));

          setSteps((prev) => [
            ...prev,
            {
              step: prev.length + 1,
              action: "record",
              description: `处理记录：${record.fields.name || record.record_id}`,
              success: true,
              timestamp: new Date().toISOString(),
              isRecordStart: true,
              recordName: record.fields.name || record.record_id,
              recordId: record.record_id,
              recordIndex: i + 1,
              recordTotal: targets.length,
            },
          ]);

          window.electronAPI?.viewClearHighlight("left").catch(() => {});
          window.electronAPI?.viewClearHighlight("right").catch(() => {});

          // 每条 LOOP 开始前，把用到的网页重置回教学时的搜索页，并等待加载完成。
          // 这样每条记录都从同一初始状态开始：搜索框存在、无上一条记录的详情页残留。
          for (const side of usedSides) {
            const baseUrl = side === "left" ? baseLeftUrl : baseRightUrl;
            if (!baseUrl || !window.electronAPI) continue;
            setSteps((prev) => [
              ...prev,
              {
                step: prev.length + 1,
                action: "navigate",
                description: `LOOP [${i + 1}/${targets.length}] 重置${side === "left" ? "左" : "右"}侧网页到搜索页`,
                success: true,
                timestamp: new Date().toISOString(),
              },
            ]);
            await window.electronAPI.viewLoad(side, baseUrl);
            await waitViewReady(side);
            if (batchStopRef.current) break;
          }

          await sleep(300);

          result = await executeTemplateForRecord(tpl, record, i, onStepStart, {
            wrapWithVerify: hasReviewSteps,
            onStepFail,
            onStepSkip,
          });
        } else {
          // pass2：该人浏览器步骤已在 pass1 跑完，join 后台 AI 管线（OCR+排版已堆积）后构建报告
          const pr = passResults[i];
          if (!pr) break; // pass1 中途被停止
          setBatchCursor(i);
          setSelectedId(record.record_id);
          setExecRecordId(record.record_id);
          await joinBgOcrForRecord(record.record_id);
          await sleep(settingsRef.current.high_speed_mode === true ? 400 : 800);
          // 纯文件提取对比（无网页映射）：compareFieldsForRecord 只做内存比对（提取值 vs Excel），
          // 不读页面，pass2 调用安全；网页稳定等待也被跳过（effectiveMappings 为空）
          let comparisons: FieldComparison[] = [];
          let verifyOverall: "match" | "mismatch" = "match";
          if (hasReviewSteps && pr.result.success) {
            const cmp = await compareFieldsForRecord(record, i, getTemplateMappings(tpl), tpl.customTextEntries);
            comparisons = cmp.comparisons;
            verifyOverall = cmp.overall;
            // 条件断点：字段不匹配 + pass1 的 marks 带 on-error 断点
            if (verifyOverall === "mismatch" && comparisons.length > 0 && pr.result.hasOnErrorBreakpoint) {
              const mismatchFields = comparisons.filter((c) => c.match === "mismatch" || c.match === "error");
              const detail = mismatchFields.map((c) => `${c.field}: 「${c.excel_value}」vs「${c.website_value}」`).join("; ");
              rlog(`[batch] 断点（条件-字段不匹配）触发：${mismatchFields.length} 个字段不匹配`);
              await waitForBreakpointRef.current({
                recordName: String(getRecordDisplayName(record)),
                recordIndex: i + 1,
                stepLabel: "字段比对（审查）",
                type: "on-error",
                error: `${mismatchFields.length} 个字段不匹配：${detail}`,
              });
            }
          }
          result = { ...pr.result, comparisons, verifyOverall };
        }

        const recordName = getRecordDisplayName(record);
        // 本条记录的比对条目（用于按人物拆分报告）
        const currentRecordEntries: VerificationReportEntry[] = [];
        // 审查流程但比对未产出任何条目（映射为空/比对未真正执行）——不能算通过
        let compareEmpty = false;

        if (!result.success) {
          failCount++;
          console.warn(`[batch] 第 ${i + 1} 行 (${record.record_id}) 失败：${result.error}`);
          setSteps((prev) => [
            ...prev,
            {
              step: prev.length + 1,
              action: "error",
              description: `LOOP [${i + 1}/${targets.length}] 失败: ${result.error || "未知错误"}`,
              success: false,
              detail: `失败步骤: ${result.failedOrder || "-"} · 记录: ${recordName}`,
              timestamp: new Date().toISOString(),
            },
          ]);
          const failEntry: VerificationReportEntry = {
            right_selector: record.record_id,
            right_label: recordName,
            left_source: "excel",
            left_field: "",
            right_value: "ERROR",
            left_value: "",
            match: "mismatch",
            reasoning: result.error,
            timestamp: new Date().toISOString(),
          };
          allEntries.push(failEntry);
          currentRecordEntries.push(failEntry);
        } else {
          if (hasReviewSteps) {
            // 有审查步骤：根据比对结果统计
            if (result.verifyOverall === "match") {
              successCount++;
              matchCount++;
            } else {
              failCount++;
              mismatchCount++;
            }
            if (result.comparisons) {
              allComparisons.push(...result.comparisons);
              for (const c of result.comparisons) {
                // 文件提取 vs Excel 绑定列的对比（无网页值）：左=提取值，右=Excel 绑定列值
                const docVsExcel = c.evidence_source === "passport" && !c.website_value && !!c.excel_value;
                const entry: VerificationReportEntry = {
                  right_selector: c.selector_hint || "",
                  right_label: c.website_label || c.field,
                  left_source: c.evidence_source || "excel",
                  left_field: c.field,
                  right_value: docVsExcel ? c.excel_value : c.website_value,
                  left_value: docVsExcel ? c.passport_value : (c.excel_value || c.passport_value),
                  match: c.match,
                  timestamp: new Date().toISOString(),
                };
                allEntries.push(entry);
                currentRecordEntries.push(entry);
              }
            }
            // 比对跑了但一个条目都没有：放一行说明性条目，让报告卡片展开能看到原因，
            // 同时让 hasMismatch 生效（overall 判 fail），避免 0/0 真空通过
            if (currentRecordEntries.length === 0) {
              compareEmpty = true;
              const noteEntry: VerificationReportEntry = {
                right_selector: "",
                right_label: "字段比对",
                left_source: "excel",
                left_field: "",
                right_value: "未执行",
                left_value: "",
                match: "error",
                reasoning: "字段比对未执行：模板未保存字段映射，且无法从审查步骤推导。请重新设置字段对比（审查映射）后重新保存 LOOP",
                timestamp: new Date().toISOString(),
              };
              allEntries.push(noteEntry);
              currentRecordEntries.push(noteEntry);
            }
            rlog(`[batch] 第 ${i + 1} 行完成: ${recordName}, 比对结果: ${result.verifyOverall}`);
          } else {
            // 纯录入/提取流程：步骤执行成功即算成功。
            // 把"填入值"和"文件提取字段"写成一左一右的报告行，卡片不再是 0/0 空白
            successCount++;
            for (const f of result.fills || []) {
              const entry: VerificationReportEntry = {
                right_selector: "",
                right_label: `${f.label}（填入）`,
                left_source: "excel",
                left_field: f.field,
                left_value: f.value,
                right_value: f.value,
                match: "match",
                timestamp: new Date().toISOString(),
              };
              allEntries.push(entry);
              currentRecordEntries.push(entry);
            }
            // 文件提取字段：左=Excel/记录值，右=提取值（与教学时提取面板的对比口径一致）
            // 只放入"用上的"字段（一一对照录入/填入用到的），OCR 全量字段里没被引用的不放入报告
            const usedExtractFields = new Set<string>();
            for (const m of getTemplateMappings(tpl)) {
              if (m.left_field) usedExtractFields.add(m.left_field);
            }
            for (const mk of [...tpl.dataSourceMarks, ...tpl.reviewMarks, ...tpl.entryMarks]) {
              if (mk.variableField) usedExtractFields.add(mk.variableField);
              if (mk.excelField) usedExtractFields.add(mk.excelField);
            }
            for (const f of result.fills || []) usedExtractFields.add(f.field);
            const recordExtracts = docExtractsByRecordRef.current[record.record_id] || [];
            const seenExtractFields = new Set<string>();
            let skippedUnusedFields = 0;
            // 「提取元素」面板文件提取条目的 Excel 绑定列：按绑定关系逐字段对比（左=运行时提取值，右=绑定 Excel 列当前行值）
            for (const row of compareDocBindEntries(tpl.customTextEntries || customTextEntriesRef.current, record)) {
              seenExtractFields.add(row.fieldKey); // 绑定条目已覆盖的 OCR 字段不再进下面的通用循环
              const bPairStatus = row.match === "match" ? "match" : row.match === "mismatch" ? "mismatch" : "missing";
              setLivePairs((prev) => prev.recordId === record.record_id
                ? { ...prev, pairs: [...prev.pairs, { label: row.label, leftValue: row.ocrVal || "（未找到）", rightValue: row.excelVal || "（未找到）", status: bPairStatus, kind: "compare" }] }
                : prev);
              const bindEntry: VerificationReportEntry = {
                right_selector: "",
                // 标签带上绑定的 Excel 列名：「以来源为准修正」按此定位要更新的列
                right_label: `${row.label}（文件提取·${row.excelField}）`,
                left_source: "passport",
                left_field: row.fieldKey,
                left_value: row.ocrVal,
                right_value: row.excelVal,
                match: row.match,
                timestamp: new Date().toISOString(),
              };
              allEntries.push(bindEntry);
              currentRecordEntries.push(bindEntry);
            }
            for (const d of recordExtracts) {
              for (const [f, rightValRaw] of Object.entries(d.fields || {})) {
                if (seenExtractFields.has(f)) continue;
                // 未被任何映射/步骤引用的提取字段：跳过，不进报告
                if (!usedExtractFields.has(f)) {
                  skippedUnusedFields++;
                  continue;
                }
                seenExtractFields.add(f);
                const leftVal = String(record.fields[f] ?? record.passport_fields?.[f] ?? "");
                const rightVal = String(rightValRaw ?? "");
                let m: FieldMatch = "mismatch";
                if (!rightVal) m = "missing";
                else if (!leftVal) m = "unknown";
                else if (valuesEquivalent(f, leftVal, rightVal)) m = "match";
                else if (leftVal.toLowerCase().includes(rightVal.toLowerCase()) || rightVal.toLowerCase().includes(leftVal.toLowerCase())) m = "partial";
                const entry: VerificationReportEntry = {
                  right_selector: "",
                  // 标签带上对应 Excel 列名（=记录字段 key）：「以来源为准修正」按此定位要更新的列
                  right_label: `${FIELD_LABELS[f] || f}（文件提取·${f}）`,
                  left_source: "passport",
                  left_field: f,
                  left_value: rightVal,
                  right_value: leftVal,
                  match: m,
                  timestamp: new Date().toISOString(),
                };
                allEntries.push(entry);
                currentRecordEntries.push(entry);
              }
            }
            rlog(`[batch] 第 ${i + 1} 行录入完成: ${recordName}, 填入${(result.fills || []).length}项, 提取${seenExtractFields.size}字段${skippedUnusedFields > 0 ? `（${skippedUnusedFields}个未引用字段已略过）` : ""}`);
          }
        }

        // 被跳过/吞掉的失败步骤必须体现在报告里（运行时红了，最终就不能装绿）
        if (result.success) {
          for (const se of result.skippedErrors || []) {
            const entry: VerificationReportEntry = {
              right_selector: "",
              right_label: "步骤跳过",
              left_source: "excel",
              left_field: "",
              left_value: "",
              right_value: "失败已跳过",
              match: "error",
              reasoning: se,
              timestamp: new Date().toISOString(),
            };
            allEntries.push(entry);
            currentRecordEntries.push(entry);
          }
          // 兜底：执行成功但卡片无任何内容（纯点击流），放一行执行说明，杜绝 0/0 空白卡片
          if (currentRecordEntries.length === 0) {
            const entry: VerificationReportEntry = {
              right_selector: "",
              right_label: "LOOP 步骤",
              left_source: "excel",
              left_field: "",
              left_value: "",
              right_value: "全部步骤执行完成",
              match: "match",
              timestamp: new Date().toISOString(),
            };
            allEntries.push(entry);
            currentRecordEntries.push(entry);
          }
        }

        // 构建本条记录的按人物报告并累加到 loopReports
        // missing（页面/文件没读到值）也算不一致：字段明明配置了却读不到，不能判通过
        const badEntries = currentRecordEntries.filter((e) => e.match === "mismatch" || e.match === "error" || e.match === "missing");
        const goodEntries = currentRecordEntries.filter((e) => e.match === "match");
        const hasMismatch = badEntries.length > 0;
        // 聚合该记录所有文档的MRZ警告
        const recordDocExtracts = docExtractsByRecordRef.current[record.record_id] || [];
        const allMrzWarnings = recordDocExtracts.flatMap((d) => d.mrz_warnings || []);
        // 三态语义：
        //   pass(绿)   = 完全没问题（所有对照项一致）
        //   review(黄) = 部分对部分错（有好有坏，或MRZ警告）
        //   fail(红)   = 执行失败 / 找不到文件 / 缺项严重 / 没有一个正确
        const effectiveOverall: Overall = !result.success
          ? "fail"
          : !hasMismatch
          ? allMrzWarnings.length > 0
            ? "review"
            : "pass"
          : goodEntries.length === 0
          ? "fail"
          : "review";
        const personReport: VerificationReport = {
          task_id: `loop-${record.record_id}-${Date.now()}`,
          record_id: record.record_id,
          record_name: recordName,
          university_url: rightUrl,
          entries: currentRecordEntries,
          overall: effectiveOverall,
          flow: hasReviewSteps ? "review" : "entry",
          summary: !result.success
            ? `执行失败：${result.error || "未知错误"}`
            : compareEmpty
            ? "字段比对未执行：模板缺少字段映射，请重新设置字段对比后保存 LOOP"
            : effectiveOverall === "fail"
            ? "无一字段一致 / 缺项严重，需检查"
            : effectiveOverall === "review"
            ? allMrzWarnings.length > 0 && !hasMismatch
              ? `MRZ交叉验证发现${allMrzWarnings.length}处姓名等字段不一致，已以MRZ为准，请人工复核`
              : `${goodEntries.length} 项一致，${badEntries.length} 项不一致`
            : hasReviewSteps
            ? "全部一致"
            : "录入完成",
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          mrz_warnings: allMrzWarnings.length > 0 ? allMrzWarnings : undefined,
        };
        setLoopReports((prev) => [...prev, personReport]);
        collectedReports.push(personReport);
        // 实时分析：问题卡片（review/fail）一完成就触发 AI 即时分析并追加到执行分析面板，
        // 运行中即可看到每张卡哪里有问题（void 不阻塞主循环，AI 慢不影响下一张卡执行）
        if (effectiveOverall !== "pass") {
          void appendCardAnalysis(personReport);
        }
        // 同步到卡片三态着色（通过=绿 / 有问题=黄 / 需检查=红）
        setRecordResults((prev) => ({ ...prev, [record.record_id]: effectiveOverall }));

        setBatchResults((prev) => ({
          ...prev,
          [record.record_id]: {
            recordId: record.record_id,
            // 状态与报告结论保持一致：报告判 fail 这里就 failed，不再两张皮
            status: !result.success || effectiveOverall === "fail"
              ? "failed"
              : effectiveOverall === "review"
              ? "review"
              : "success",
            startedAt: prev[record.record_id]?.startedAt,
            finishedAt: Date.now(),
            error: !result.success
              ? result.error
              : compareEmpty
              ? "字段比对未执行：模板缺少字段映射"
              : effectiveOverall === "fail"
              ? "无一字段一致 / 缺项严重"
              : effectiveOverall === "review"
              ? `${goodEntries.length} 项一致，${badEntries.length} 项不一致`
              : undefined,
            failedOrder: result.failedOrder,
          },
        }));

        // 行之间等待，让用户能看清结果（高速模式缩短，仍保留可辨识的节奏）
        if (i < targets.length - 1) {
          await sleep(settingsRef.current.high_speed_mode === true ? 800 : 1500);
        }
      }

      // 所有记录处理完后，执行文件提取的收尾点击（闭环操作）
      if (!batchStopRef.current) {
        const docPostClicks = pickedMarksRef.current.filter(
          (m) => m.docExtractClick && m.docExtractClickPhase === "post"
        ).sort((a, b) => a.order - b.order);
        if (docPostClicks.length > 0) {
          rlog(`[batch] 开始执行文件提取收尾点击，共 ${docPostClicks.length} 步`);
          setSteps((prev) => [
            ...prev,
            {
              step: prev.length + 1,
              action: "final",
              description: `执行收尾点击（${docPostClicks.length} 步）...`,
              success: true,
              timestamp: new Date().toISOString(),
            },
          ]);
          for (const pm of docPostClicks) {
            if (batchStopRef.current) break;
            try {
              const side = pm.side;
              rlog(`[batch] 收尾点击: ${pm.label} (${pm.selector})`);
              let clickRes = await performRealClick(side, pm.selector, pm.inPopup);
              if (clickRes && typeof clickRes === "object" && "ok" in clickRes && clickRes.ok === false) {
                // 元素可能还没出现，等待后重试
                await sleep(1500);
                clickRes = await performRealClick(side, pm.selector, pm.inPopup);
              }
              await sleep(800);
            } catch (e) {
              rlog(`[batch] 收尾点击失败: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          await sleep(500);
        }
      }
    } catch (loopErr) {
      // try 原本只有 finally：pass1/pass2 任何一环抛异常都会静默终止（0/0 结束且无日志），
      // 与「用户手动停止」无法区分——必须留痕并提示
      const errMsg = loopErr instanceof Error ? loopErr.message : String(loopErr);
      rlog(`[batch] LOOP 异常终止: ${errMsg}`);
      console.error("[runBatch] LOOP 异常终止:", loopErr);
      setError(`LOOP 异常终止: ${errMsg}`);
      setSteps((prev) => [
        ...prev,
        {
          step: prev.length + 1,
          action: "error",
          description: `LOOP 异常终止: ${errMsg}`,
          success: false,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      runBatchInFlightRef.current = false;
      setBatchRunning(false);
      setBatchCursor(-1);
      setBatchMarkCursor(null);
      liveStepPrefixRef.current = null;
      // 最后一人的对比归档进历史（运行结束后卡片仍可回看）
      archiveLivePairs();
      // 保持execPhase="done"让用户看到最终结果，不重置verifyFieldIdx/reviewFieldResults（方便查看最终状态）

      const total = successCount + failCount;
      const overall: Overall = failCount === 0 ? "pass" : "fail";
      const summary = hasReviewSteps
        ? `LOOP 执行完成：${successCount}/${total} 成功，${failCount} 失败，${matchCount} 匹配，${mismatchCount} 不匹配`
        : `录入完成：${successCount}/${total} 成功，${failCount} 失败`;

      setSteps((prev) => [
        ...prev,
        {
          step: prev.length + 1,
          action: "final",
          description: summary,
          success: overall === "pass",
          timestamp: new Date().toISOString(),
        },
      ]);

      const report: VerificationReport = {
        task_id: `batch-${Date.now()}`,
        record_id: tpl.sourceRecordId || "batch",
        record_name: "LOOP 批量执行汇总",
        university_url: rightUrl,
        entries: allEntries,
        overall,
        summary,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      };
      setReport(report);

      // 设置result供applyHighlightsFromResult使用（最后一条记录的高亮会保留）
      if (allComparisons.length > 0) {
        setResult({
          task_id: report.task_id,
          record_id: report.record_id,
          university_url: rightUrl,
          steps: [],
          started_at: startedAt,
          finished_at: report.finished_at,
          comparisons: allComparisons,
          overall,
        });
        const hasMismatch = allComparisons.some((c) => c.match === "mismatch");
        setVerifyStatus(hasMismatch ? "mismatch" : "match");
      }

      window.electronAPI?.viewClearHighlight("left").catch(() => {});
      rlog("[batch] LOOP 执行结束:", summary);

      // 内存回收：跑完即释放每张卡提取结果中的原图 base64（source/file_url，每张 1~4MB，百张卡合计数百 MB），
      // 只保留缩略图 processed_image + 识别文本/字段供跑后回看，避免几百 MB 字符串常驻渲染进程导致卡顿。
      // （预览逻辑优先用 processed_image，PDF 本就走图标占位，置空不影响文件处理面板的显示）
      setDocExtractsByRecord((prev) => {
        let changed = false;
        const stripped: Record<string, DocExtractState[]> = {};
        for (const [rid, arr] of Object.entries(prev)) {
          stripped[rid] = arr.map((e) => {
            if (!e.source && !e.file_url) return e;
            changed = true;
            return { ...e, source: "", file_url: undefined };
          });
        }
        return changed ? stripped : prev;
      });
      // 运行期残留的下载数据/后台 OCR 队列/延后校验一并释放（此前只在下一轮开始时清空）
      bgOcrResultRef.current = null;
      bgOcrPromisesRef.current.clear();
      pendingFileVerifyRef.current.clear();
      pendingWebFileRef.current = null;
      passDeferActiveRef.current = false;

      // 执行结束：追加「执行总结」分段（统计行 + 总体结论/高频字段，排在所有单卡分析之后）
      if (collectedReports.length > 0) {
        void generateLoopAnalysis(collectedReports, Date.now() - Date.parse(startedAt));
      }
    }
  }, [workflowTemplate, records, cardRecords, selectedId, executeTemplateForRecord, selectMode, avatarMode, exitSelectMode, exitAvatarMode, rightUrl, leftUrl, waitViewReady, generateLoopAnalysis, appendCardAnalysis, joinBgOcrForRecord, compareFieldsForRecord]);
  // 始终把最新版本的 runBatch 写入 ref，供 finishTeachingAndRunBatch 直接调用
  runBatchRef.current = runBatch;

  // ============ 任务队列执行：按顺序执行队列中的所有任务 ============
  // 每个任务：切换到对应网页 URL → 导航 → 批量执行该组卡片
  const runQueue = useCallback(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    if (taskQueue.length === 0) {
      setError("队列为空，请先添加任务");
      return;
    }
    if (queueRunning) return;

    console.log("[runQueue] 🚀 开始执行队列，共", taskQueue.length, "个任务");
    rlog(`[runQueue] 🚀 启动，共 ${taskQueue.length} 个任务`);

    queueStopRef.current = false;
    setQueueRunning(true);
    setQueueCursor(-1);
    setHasRunOnce(true); // 跑完 LOOP 后「日志」按钮需要 hasRunOnce 才显示
    setLogSignal((s) => s + 1); // 自动切换到执行日志tab

    // 重置所有任务状态
    setTaskQueue((prev) => prev.map((t) => ({ ...t, status: "pending", error: undefined, successCount: 0, failCount: 0 })));

    for (let ti = 0; ti < taskQueue.length; ti++) {
      if (queueStopRef.current) {
        rlog("[runQueue] 用户停止队列");
        setTaskQueue((prev) => prev.map((t, i) => (i === ti ? { ...t, status: "stopped" } : t)));
        break;
      }

      const task = taskQueue[ti];
      setQueueCursor(ti);
      setTaskQueue((prev) => prev.map((t, i) => (i === ti ? { ...t, status: "running" } : t)));

      // 记录任务开始的大标题步骤（比recordStart更高层级）
      setSteps((prev) => [
        ...prev,
        {
          step: prev.length + 1,
          action: "task",
          description: `开始任务：${task.name}`,
          success: true,
          timestamp: new Date().toISOString(),
          isTaskStart: true,
          taskName: task.name,
          taskIndex: ti + 1,
          taskTotal: taskQueue.length,
          taskRecordCount: task.cardRecords.length,
        },
      ]);

      try {
        // 1. 切换到该任务的网页 URL
        rlog(`[runQueue] 任务 ${ti + 1}: 切换网页 left=${task.leftUrl} right=${task.rightUrl}`);
        setLeftUrl(task.leftUrl);
        setRightUrl(task.rightUrl);

        // 等待 URL 状态生效并导航
        await sleep(100);
        if (window.electronAPI) {
          if (task.leftUrl) {
            await window.electronAPI.viewLoad("left", task.leftUrl);
          }
          if (task.rightUrl) {
            await window.electronAPI.viewLoad("right", task.rightUrl);
          }
          // 等待页面加载
          if (task.leftUrl) await waitViewReady("left");
          if (task.rightUrl) await waitViewReady("right");
        }

        // 2. 批量执行该组所有卡片（复用现有 executeTemplateForRecord 逻辑）
        const targets = task.cardRecords;
        // 回填该任务 LOOP 的步骤与字段映射到会话面板（字段对比区域可见）
        setPickedMarks([...task.workflowTemplate.dataSourceMarks, ...task.workflowTemplate.reviewMarks, ...task.workflowTemplate.entryMarks]);
        setMappings(getTemplateMappings(task.workflowTemplate));
        // 提取元素面板条目（含文件提取字段的 Excel 列绑定）回填
        if ((task.workflowTemplate.customTextEntries?.length ?? 0) > 0) setCustomTextEntries(task.workflowTemplate.customTextEntries!);
        setDocExtractPanel(null);
        // 清空上一任务/教学期残留的文件提取缓存，防止字段对比串行（拿别人的信息检查当前卡）
        setDocExtractsByRecord({});
        // 高速模式：同步清掉上一任务残留的后台 OCR 队列/缓存/延后校验
        bgOcrResultRef.current = null;
        bgOcrPromisesRef.current.clear();
        pendingFileVerifyRef.current.clear();
        // 清空本次 LOOP 的"保底需人工"标记（跨任务不残留）
        needsManualRef.current = new Set();
        breakpointTotalRef.current = targets.length;
        let successCount = 0;
        let failCount = 0;
        const errors: string[] = [];
        // 两遍式流水线：pass1 逐人浏览器步骤（AI 后台堆积），pass2 逐人 join+比对。
        // 仅「审查步骤+网页字段映射」的 LOOP 必须旧时序（比对实时读当前页，翻页后读到别人的页面）；
        // getTemplateMappings 会从 marks 反推恒非空，必须叠加 hasReviewSteps 判断（见 runBatch 同款注释）
        const tplHasWebMappingsQ = task.workflowTemplate.reviewMarks.length > 0 && getTemplateMappings(task.workflowTemplate).length > 0;
        const passResults: Array<Awaited<ReturnType<typeof executeTemplateForRecord>>> = [];

        for (let ri = 0; ri < targets.length; ri++) {
          if (queueStopRef.current || batchStopRef.current) break;

          const record = targets[ri];
          setSelectedId(record.record_id);
          setExecRecordId(record.record_id);
          setBatchCursor(ri);
          setBatchResults((prev) => ({
            ...prev,
            [record.record_id]: { recordId: record.record_id, status: "running", startedAt: Date.now() },
          }));

          // 记录人物卡片开始
          setSteps((prev) => [
            ...prev,
            {
              step: prev.length + 1,
              action: "record",
              description: `处理记录：${record.fields.name || record.record_id}`,
              success: true,
              timestamp: new Date().toISOString(),
              isRecordStart: true,
              recordName: record.fields.name || record.record_id,
              recordId: record.record_id,
              recordIndex: ri + 1,
              recordTotal: targets.length,
            },
          ]);

          window.electronAPI?.viewClearHighlight("left").catch(() => {});
          window.electronAPI?.viewClearHighlight("right").catch(() => {});

          // 重置网页到搜索页（只重置右侧目标网站，不重置左侧数据源）
          // 避免左侧网页侧边栏等状态因重新加载而丢失
          const hasReviewSteps = task.workflowTemplate.reviewMarks.length > 0;
          // 只重置右侧（目标网站），左侧（数据源）由用户控制，不重置
          const usedSides = new Set<ViewSide>(["right"]);
          for (const side of usedSides) {
            const baseUrl = side === "left" ? task.leftUrl : task.rightUrl;
            if (!baseUrl || !window.electronAPI) continue;
            setSteps((prev) => [
              ...prev,
              {
                step: prev.length + 1,
                action: "navigate",
                description: `LOOP [${ri + 1}/${targets.length}] 重置${side === "left" ? "左" : "右"}侧网页到搜索页`,
                success: true,
                timestamp: new Date().toISOString(),
              },
            ]);
            await window.electronAPI.viewLoad(side, baseUrl);
            await waitViewReady(side);
            if (queueStopRef.current || batchStopRef.current) break;
          }
          await sleep(300);

          // 执行该记录的步骤
          const result = await executeTemplateForRecord(task.workflowTemplate, record, ri, (recordIndex, mark) => {
            setBatchMarkCursor({ recordIndex, markOrder: mark.order });
            const side: ViewSide = mark.side === "left" ? "left" : "right";
            const selector = mark.action === "input" ? (mark.inputTarget || mark.selector) : mark.selector;
            const label = markDisplayLabel(mark);
            window.electronAPI?.viewClearHighlight(side).catch(() => {});
            window.electronAPI?.viewHighlightBoxes(side, [{ selector, status: "pending", label }]).catch(() => {});
            setSteps((prev) => [
              ...prev,
              {
                step: prev.length + 1,
                action: mark.action || "pick",
                description: `LOOP [${ri + 1}/${targets.length}] 步骤 ${mark.order}: ${markDisplayLabel(mark)}`,
                success: true,
                detail: mark.action === "input"
                  ? `${mark.workflow === "entry" ? "填入" : "定位"}: ${mark.variableField ? `[${mark.variableField}]` : (mark.value || "")}`
                  : undefined,
                timestamp: new Date().toISOString(),
              },
            ]);
          }, { wrapWithVerify: hasReviewSteps, deferCompare: !tplHasWebMappingsQ });
          passResults.push(result);
          // pass1 完成提示：AI 管线（OCR+排版）在后台堆积并行，比对在 pass2 统一做
          setSteps((prev) => [
            ...prev,
            {
              step: prev.length + 1,
              action: "record",
              description: `LOOP [${ri + 1}/${targets.length}] 浏览器步骤完成：${record.fields.name || record.record_id}（AI 后台排版中）`,
              success: true,
              timestamp: new Date().toISOString(),
            },
          ]);
        }

        // 所有记录处理完后，执行文件提取的收尾点击（闭环操作）
        if (!queueStopRef.current && !batchStopRef.current) {
          const docPostClicks = pickedMarksRef.current.filter(
            (m) => m.docExtractClick && m.docExtractClickPhase === "post"
          ).sort((a, b) => a.order - b.order);
          if (docPostClicks.length > 0) {
            rlog(`[runQueue] 开始执行文件提取收尾点击，共 ${docPostClicks.length} 步`);
            setSteps((prev) => [
              ...prev,
              {
                step: prev.length + 1,
                action: "final",
                description: `执行收尾点击（${docPostClicks.length} 步）...`,
                success: true,
                timestamp: new Date().toISOString(),
              },
            ]);
            for (const pm of docPostClicks) {
              if (queueStopRef.current || batchStopRef.current) break;
              try {
                const side = pm.side;
                rlog(`[runQueue] 收尾点击: ${pm.label} (${pm.selector})`);
                let clickRes = await performRealClick(side, pm.selector, pm.inPopup);
                if (clickRes && typeof clickRes === "object" && "ok" in clickRes && clickRes.ok === false) {
                  await sleep(1500);
                  clickRes = await performRealClick(side, pm.selector, pm.inPopup);
                }
                await sleep(800);
              } catch (e) {
                rlog(`[runQueue] 收尾点击失败: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            await sleep(500);
          }
        }

        // ============ pass2：逐人 join 后台 AI 管线 + 字段比对 + 三态判定 ============
        // 此时 AI 管线（OCR+DeepSeek 排版）已在 pass1 期间后台并行堆积完毕，逐人 join 大概率零等待
        const hasReviewStepsP2 = task.workflowTemplate.reviewMarks.length > 0;
        for (let ri = 0; ri < targets.length; ri++) {
          if (queueStopRef.current || batchStopRef.current) break;
          const record = targets[ri];
          const result = passResults[ri] || { success: false, error: "pass1 未执行（已中断）" } as Awaited<ReturnType<typeof executeTemplateForRecord>>;

          // 选中该人（UI 联动：字段对比实时卡片/文件面板跟随切换）
          setSelectedId(record.record_id);
          setExecRecordId(record.record_id);
          setBatchCursor(ri);

          // join：等该人后台 OCR+排版落定，并执行延后的文件一致性校验
          await joinBgOcrForRecord(record.record_id);
          await sleep(settingsRef.current.high_speed_mode === true ? 400 : 800);

          // 字段比对（pass1 deferCompare 延后的部分在此执行；pass1 执行失败的人跳过比对）
          let comparisons: FieldComparison[] = [];
          let verifyOverall: "match" | "mismatch" = "match";
          if (hasReviewStepsP2 && result.success) {
            if (tplHasWebMappingsQ) {
              // 网页映射 LOOP：pass1 未延后（executeTemplateForRecord 已在当人页面内联完成比对+断点），直接沿用
              comparisons = result.comparisons || [];
              verifyOverall = result.verifyOverall || "match";
            } else {
            const cmp = await compareFieldsForRecord(record, ri, getTemplateMappings(task.workflowTemplate), task.workflowTemplate.customTextEntries);
            comparisons = cmp.comparisons;
            verifyOverall = cmp.overall;
            // 条件断点：字段比对发现不匹配且 pass1 的 marks 中有 on-error 断点
            if (verifyOverall === "mismatch" && comparisons.length > 0 && result.hasOnErrorBreakpoint) {
              const mismatchFields = comparisons.filter((c) => c.match === "mismatch" || c.match === "error");
              const detail = mismatchFields.map((c) => `${c.field}: 「${c.excel_value}」vs「${c.website_value}」`).join("; ");
              rlog(`[batch] 断点（条件-字段不匹配）触发：${mismatchFields.length} 个字段不匹配`);
              await waitForBreakpointRef.current({
                recordName: String(record.fields.name || record.record_id),
                recordIndex: ri + 1,
                stepLabel: "字段比对（审查）",
                type: "on-error",
                error: `${mismatchFields.length} 个字段不匹配：${detail}`,
              });
            }
            }
          }
          const merged = { ...result, comparisons, verifyOverall };

          // 三态判定：pass=全部一致 / review=部分对部分错 / fail=执行失败·缺项严重·无一正确
          // 保底自动跳过需人工的记录：无论执行结果如何都标为 review（需人工检查）
          const needsManual = needsManualRef.current.has(record.record_id);
          const verifyFailed = hasReviewStepsP2 && merged.success && merged.verifyOverall === "mismatch";
          const qCmps = merged.comparisons || [];
          const qGood = qCmps.filter((c) => c.match === "match").length;
          const qBad = qCmps.length - qGood;
          const qOverall: Overall = needsManual
            ? "review"
            : !merged.success
            ? "fail"
            : !verifyFailed
            ? "pass"
            : qGood === 0
            ? "fail"
            : "review";
          setRecordResults((prev) => ({ ...prev, [record.record_id]: qOverall }));
          if (qOverall === "pass") {
            successCount++;
            setBatchResults((prev) => ({
              ...prev,
              [record.record_id]: { recordId: record.record_id, status: "success", finishedAt: Date.now() },
            }));
            setSteps((prev) => [
              ...prev,
              {
                step: prev.length + 1,
                action: "complete",
                description: `LOOP [${ri + 1}/${targets.length}] 完成：${record.fields.name || record.record_id}`,
                success: true,
                timestamp: new Date().toISOString(),
              },
            ]);
          } else if (qOverall === "review") {
            // 部分一致：执行层面成功，但标黄提示复核
            successCount++;
            const reviewReason = `${qGood} 项一致，${qBad} 项不一致`;
            setBatchResults((prev) => ({
              ...prev,
              [record.record_id]: { recordId: record.record_id, status: "review", finishedAt: Date.now(), error: reviewReason },
            }));
            setSteps((prev) => [
              ...prev,
              {
                step: prev.length + 1,
                action: "complete",
                description: `LOOP [${ri + 1}/${targets.length}] 有问题：${record.fields.name || record.record_id} — ${reviewReason}`,
                success: true,
                timestamp: new Date().toISOString(),
              },
            ]);
          } else {
            failCount++;
            const failReason = verifyFailed
              ? (qCmps.length > 0 ? "无一字段一致，需检查" : "字段比对未执行：模板缺少字段映射")
              : (merged.error || "未知错误");
            errors.push(failReason);
            setBatchResults((prev) => ({
              ...prev,
              [record.record_id]: { recordId: record.record_id, status: "failed", finishedAt: Date.now(), error: failReason },
            }));
            setSteps((prev) => [
              ...prev,
              {
                step: prev.length + 1,
                action: "error",
                description: `LOOP [${ri + 1}/${targets.length}] 需检查：${record.fields.name || record.record_id} — ${failReason}`,
                success: false,
                timestamp: new Date().toISOString(),
              },
            ]);
          }
        }

        // 任务完成
        setTaskQueue((prev) => prev.map((t, i) => (i === ti ? { ...t, status: "success", successCount, failCount } : t)));
        setSteps((prev) => [
          ...prev,
          {
            step: prev.length + 1,
            action: "task-done",
            description: `任务完成：${task.name}（成功 ${successCount}，失败 ${failCount}）`,
            success: failCount === 0,
            timestamp: new Date().toISOString(),
          },
        ]);
        rlog(`[runQueue] 任务 ${ti + 1} 完成: 成功 ${successCount}, 失败 ${failCount}`);

      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        rlog(`[runQueue] 任务 ${ti + 1} 失败:`, errMsg);
        setTaskQueue((prev) => prev.map((t, i) => (i === ti ? { ...t, status: "failed", error: errMsg } : t)));
        setSteps((prev) => [
          ...prev,
          {
            step: prev.length + 1,
            action: "task-error",
            description: `任务失败：${task.name} — ${errMsg}`,
            success: false,
            timestamp: new Date().toISOString(),
          },
        ]);
        // 继续执行下一个任务，不中断整个队列
      }
    }

    setQueueRunning(false);
    setQueueCursor(-1);
    setBatchCursor(-1);
    setBatchMarkCursor(null);
    rlog("[runQueue] 🏁 队列执行完毕");
  }, [taskQueue, queueRunning, executeTemplateForRecord, waitViewReady, joinBgOcrForRecord, compareFieldsForRecord]);

  // 始终把最新版本的 runQueue 写入 ref
  runQueueRef.current = runQueue;

  // ============ 功能1：网页文档提取 → 左右对比 ============
  // 本地规范化对比（与后端规则一致：trim/lower/去空白，包含视为近似）
  const docNorm = (s: string) => (s || "").trim().toLowerCase().replace(/\s+/g, "");
  const docCompareVal = useCallback((left: string, right: string): FieldMatch => {
    const l = docNorm(left);
    const r = docNorm(right);
    if (!r) return "missing";       // 文档中未提取到该字段
    if (!l) return "unknown";       // 左侧无基准值，只展示提取结果
    if (l === r) return "match";
    if (l.includes(r) || r.includes(l)) return "partial";
    return "mismatch";
  }, []);

  /** 根据提取字段 + 当前映射 + 选中记录，构建左右对比条目 */
  const buildDocEntries = useCallback(
    (extractedFields: Record<string, string>, targetFields: string[]): DocCompareEntry[] => {
      return targetFields.map((f) => {
        const leftVal = selected?.fields?.[f] || "";
        const rightVal = extractedFields[f] || "";
        return {
          field: f,
          label: FIELD_LABELS[f] || f,
          left_value: leftVal,
          right_value: rightVal,
          match: docCompareVal(leftVal, rightVal),
        };
      });
    },
    [selected, docCompareVal]
  );

  /** 功能1 主流程：下载网页文档 URL → OCR/文档解析 → 生成对比 → 切到文档tab */
  const runDocExtractFromUrl = useCallback(
    async (url: string) => {
      setDocExtracting(true);
      setDocSignal((s) => s + 1);
      setError(null);
      try {
        const targetFields = Array.from(
          new Set(mappings.map((m) => m.left_field).filter(Boolean))
        );
        const result = await api.extractDocumentUrl(url, targetFields);
        const entries = buildDocEntries(result.fields, targetFields);
        // 追加到当前卡片的文件列表（支持多文件 TAB 切换）
        // 内存保护：有裁剪图时 source/file_url 只存文件名（去重/类型判断用），不存原图 dataUrl
        const hasProc = !!result.processed_image;
        const newExtract: DocExtractState = {
          filename: result.filename,
          method: result.method,
          text: result.text,
          fields: result.fields,
          entries,
          source: hasProc ? (result.filename || url) : url,
          file_url: hasProc ? (result.filename || url) : url,
          processed_image: result.processed_image,
          mrz_warnings: result.mrz_warnings,
          fallback: result.fallback,
        };
        const rid = selected?.record_id || "_default";
        setDocExtractsByRecord((prev) => {
          const arr = prev[rid] || [];
          const filtered = arr.filter((e) => e.file_url !== newExtract.file_url || e.filename !== newExtract.filename);
          return { ...prev, [rid]: [...filtered, newExtract] };
        });
        setActiveDocIndex(999);
        rlog(`[doc] 提取完成: ${result.filename} (${result.method})，${result.text.length} 字符`);
        setSuccessToast(`文档提取完成：${result.filename}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`文档提取失败: ${msg}`);
      } finally {
        setDocExtracting(false);
      }
    },
    [mappings, buildDocEntries, setError, setSuccessToast, selected]
  );

  /** 切换文档拾取模式：开启后点击右侧网页的 PDF 链接/图片即触发提取 */
  const toggleDocPickMode = useCallback(() => {
    if (docPickMode) {
      setDocPickMode(false);
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      return;
    }
    // 退出其他冲突模式
    if (selectMode) exitSelectMode();
    if (avatarMode) exitAvatarMode();
    setPendingAction("none");
    setBindInputSide(null);
    setDocPickMode(true);
    window.electronAPI?.viewStartPicking("right").catch(() => {});
    setSuccessToast("请点击右侧网页中的 PDF 链接或图片进行提取");
  }, [docPickMode, selectMode, avatarMode, exitSelectMode, exitAvatarMode, setSuccessToast]);

  // ============ 功能2：本地文件提取 → 人工审核 → 填入右侧网页 ============
  /** 录入步骤子步骤：触发本地文件选择（图片/PDF/Office）→ 提取 → 勾选字段填入右侧 */
  const docEntryFileInputRef = useRef<HTMLInputElement>(null);
  const requestDocFileExtract = useCallback(() => {
    docEntryFileInputRef.current?.click();
  }, []);
  /** 选择本地文件（图片/PDF/Office）→ 提取字段 → 弹出审核弹窗 */
  const handleDocFilePick = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const targetFields = Array.from(
          new Set(mappings.map((m) => m.left_field).filter(Boolean))
        );
        const result = await api.extractDocumentFile(file, targetFields);
        setDocFillData({
          filename: result.filename,
          method: result.method,
          text: result.text,
          fields: result.fields,
          fallback: result.fallback,
        });
        rlog(`[doc-fill] 文件提取完成: ${result.filename} (${result.method})，${Object.keys(result.fields).length} 个字段`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`文件提取失败: ${msg}`);
      }
    },
    [mappings, setError]
  );

  /** 审核确认后：把字段值逐个填入右侧网页对应输入框 */
  const confirmDocFill = useCallback(
    async (items: { field: string; value: string; selector: string }[]) => {
      // 先关闭审核弹窗并等待 BrowserView 恢复可见，让用户看到逐个填入的过程
      setDocFillData(null);
      setDocFilling(true);
      await new Promise((res) => setTimeout(res, 400));
      let ok = 0;
      let fail = 0;
      for (const it of items) {
        if (!it.value.trim()) continue;
        try {
          const r = await performInputValue("right", it.selector, it.value);
          if ((r as { ok?: boolean } | null)?.ok) ok++;
          else fail++;
        } catch {
          fail++;
        }
        await new Promise((res) => setTimeout(res, 400));
      }
      setDocFilling(false);
      if (fail === 0) {
        setSuccessToast(`已填入 ${ok} 个字段到右侧网页`);
      } else {
        setError(`填入完成：${ok} 个成功，${fail} 个失败`);
      }
    },
    [performInputValue, setError, setSuccessToast]
  );

  // ============ 功能3：点击「查看」按钮 → 执行步骤5(收尾)→步骤2+3(搜索+前置点击)，定位到该卡片页面 ============
  const runSingleRecord = useCallback(
    async (recordId: string) => {
      breakpointTotalRef.current = 1;
      // 优先使用 ref 中的 workflowTemplate（避免 setState 异步导致的旧值），再回退到持久化模板
      let tpl = workflowTemplateRef.current || workflowTemplate || lastTemplateRef.current;
      // 如果当前没有活动模板，查找该卡片所属的已保存批次模板
      if (!tpl) {
        const loopInfo = cardLoopMap[recordId];
        if (loopInfo) {
          tpl = getSkillById(loopInfo.loopId);
        }
      }
      if (!tpl) {
        // 未保存模板时，从当前 pickedMarks 构建临时模板（智能分类，不严格依赖workflow字段）
        const allMarks = pickedMarksRef.current.filter((m) => m.action === "click" || m.action === "input");
        // 智能分类：带clickPhase的点击归入dataSource，其余按原workflow分类
        const dataSourceMarks = allMarks.filter((m) => m.clickPhase === "pre" || m.clickPhase === "mid" || m.clickPhase === "post" || m.workflow === "data-source");
        const reviewMarks = allMarks.filter((m) => !m.clickPhase && m.workflow === "review");
        const entryMarks = allMarks.filter((m) => !m.clickPhase && m.workflow === "entry");
        if (dataSourceMarks.length === 0 && reviewMarks.length === 0 && entryMarks.length === 0) {
          setError("尚未配置任何步骤，无法定位到该卡片");
          return;
        }
        tpl = {
          id: `tpl-temp-${Date.now()}`,
          name: "临时模板",
          createdAt: Date.now(),
          sourceRecordId: selected?.record_id,
          mode: appMode,
          dataSourceMarks,
          reviewMarks,
          entryMarks,
          hasSearchSteps: dataSourceMarks.some((m) => m.action === "input" && !!m.variableField),
          hasSubmitStep: entryMarks.some((m) => m.action === "click"),
        };
        // 持久化临时构建的模板，防止后续切换记录丢失
        lastTemplateRef.current = tpl;
      } else {
        // 模板存在时，也要确保带clickPhase的点击在dataSourceMarks中（修复旧模板分类问题）
        const allMarks = [...tpl.dataSourceMarks, ...tpl.reviewMarks, ...tpl.entryMarks];
        const prePostClicks = allMarks.filter((m) => m.action === "click" && (m.clickPhase === "pre" || m.clickPhase === "mid" || m.clickPhase === "post"));
        if (prePostClicks.length > 0) {
          // 把pre/post点击合并到dataSourceMarks中（去重）
          const existingIds = new Set(tpl.dataSourceMarks.map((m) => m.id || m.order));
          const missingClicks = prePostClicks.filter((m) => !(m.id || m.order) || !existingIds.has(m.id || m.order));
          if (missingClicks.length > 0) {
            tpl = { ...tpl, dataSourceMarks: [...tpl.dataSourceMarks, ...missingClicks] };
          }
        }
        // 确保使用的模板持久化保存
        lastTemplateRef.current = tpl;
      }
      // 回填模板步骤/映射到会话面板（单卡查看时字段对比区域也能看到该 LOOP 的配置）
      setPickedMarks([...tpl.dataSourceMarks, ...tpl.reviewMarks, ...tpl.entryMarks]);
      setMappings(getTemplateMappings(tpl));
      setDocExtractPanel(null);
      if (batchRunning || singleRunning) return;
      // 从 cardPool 查找记录（cardPool 包含所有已生成的卡片，records 在重新导入 Excel 时会被替换）
      const recordIndex = cardPool.findIndex((r) => r.record_id === recordId);
      if (recordIndex < 0) return;
      const record = cardPool[recordIndex];
      const recordName = getRecordDisplayName(record);

      setSelectedId(recordId);
      setExecRecordId(recordId);
      setHasRunOnce(true);
      setSingleRunning(true);
      setLogSignal((s) => s + 1);
      setError(null);
      // 手动退出选择模式，不调用exitSelectMode以避免清空workflowTemplate
      if (selectMode) {
        setSelectMode(false);
        setPickTarget(null);
        setRightPicked(null);
        setLeftPicked(null);
      }
      if (avatarMode) exitAvatarMode();
      if (docPickMode) {
        setDocPickMode(false);
        window.electronAPI?.viewStopPicking("right").catch(() => {});
      }
      window.electronAPI?.viewClearHighlight("left").catch(() => {});
      window.electronAPI?.viewClearHighlight("right").catch(() => {});

      const onStepStart = (ri: number, mark: PickedMark) => {
        setBatchMarkCursor({ recordIndex: ri, markOrder: mark.order });
        liveStepPrefixRef.current = `定位步骤 ${mark.order}:`;
        const side: ViewSide = mark.side === "left" ? "left" : "right";
        const selector = mark.action === "input" && mark.inputTarget ? mark.inputTarget : mark.selector;
        const label = `${mark.order} · ${markDisplayLabel(mark)}`;
        window.electronAPI?.viewClearHighlight(side).catch(() => {});
        window.electronAPI?.viewHighlightBoxes(side, [{ selector, status: "pending", label }]).catch(() => {});
        setSteps((prev) => [
          ...prev,
          {
            step: prev.length + 1,
            action: mark.action || "pick",
            description: `定位步骤 ${mark.order}: ${markDisplayLabel(mark)}`,
            success: true,
            detail: mark.action === "input"
              ? `${mark.workflow === "entry" ? "填入" : "定位"}: ${mark.variableField ? `[${mark.variableField}]` : (mark.value || "")}`
              : undefined,
            timestamp: new Date().toISOString(),
          },
        ]);
      };

      setSteps((prev) => [
        ...prev,
        {
          step: prev.length + 1,
          action: "start",
          description: `开始查看「${recordName}」（先返回搜索页→再搜索定位）`,
          success: true,
          timestamp: new Date().toISOString(),
        },
      ]);

      try {
        // 录入模式：右侧网页的查看界面/步骤与审查模式完全不同，走 entryReview 回放已录制的右侧查看步骤
        // 审查/LOOP模式：postThenPre 先执行收尾点击(返回搜索页)，再执行搜索输入+前置点击(定位到卡片)
        const isEntryTpl = tpl.mode === "entry";
        if (isEntryTpl) {
          const revisitCount = [...tpl.dataSourceMarks, ...tpl.reviewMarks, ...tpl.entryMarks]
            .filter((m) => (m.side === "right" || m.clickPhase === "pre" || m.clickPhase === "mid" || m.clickPhase === "post") && (m.action === "input" || m.action === "click"))
            .length;
          if (revisitCount === 0) {
            setError("录入模式下尚未录制右侧网页的查看步骤：请在「录入流 · 步骤配置」中通过搜索输入/前置点击/收尾点击，录制右侧网页搜索→确认人物的查看流程");
            return;
          }
        }
        const result = await executeTemplateForRecord(tpl, record, 0, onStepStart,
          isEntryTpl ? { entryReview: true } : { postThenPre: true }
        );
        if (result.success) {
          setSteps((prev) => [
            ...prev,
            {
              step: prev.length + 1,
              action: "done",
              description: `已定位到「${recordName}」的卡片页面`,
              success: true,
              timestamp: new Date().toISOString(),
            },
          ]);
          setSuccessToast(`已定位到「${recordName}」的页面`);
        } else {
          setSteps((prev) => [
            ...prev,
            {
              step: prev.length + 1,
              action: "error",
              description: `定位失败: ${result.error || "未知错误"}`,
              success: false,
              timestamp: new Date().toISOString(),
            },
          ]);
          setError(`定位失败: ${result.error || "未知错误"}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`定位失败: ${msg}`);
      } finally {
        setSingleRunning(false);
        setBatchMarkCursor(null);
        window.electronAPI?.viewClearHighlight("left").catch(() => {});
        window.electronAPI?.viewClearHighlight("right").catch(() => {});
      }
    },
    [workflowTemplate, appMode, batchRunning, singleRunning, cardPool, cardLoopMap, selectMode, avatarMode, docPickMode, exitSelectMode, exitAvatarMode, executeTemplateForRecord, setError, setSuccessToast]
  );

  // ============ 审查修正：人工确认来源字段正确后，一键把来源值写入被审查字段（网页/Excel），并可重新审查 ============
  const [fixingFieldKey, setFixingFieldKey] = useState<string | null>(null);
  const [fixRerunRecordId, setFixRerunRecordId] = useState<string | null>(null);
  const [confirmingRecordId, setConfirmingRecordId] = useState<string | null>(null);

  /** 判断报告条目是否可一键修正（被审查侧是网页元素或 Excel 绑定列，且来源值非空） */
  const isFixableEntry = (e: VerificationReportEntry): boolean =>
    (e.match === "mismatch" || e.match === "error") &&
    !!(e.left_value || "").trim() &&
    (!!e.right_selector || /（(?:Excel|文件提取)·.+）$/.test(e.right_label || ""));

  /** 查找卡片对应的 LOOP 模板（活动模板 → 持久化模板 → 卡片所属批次模板） */
  const findTemplateForRecord = (recordId: string): WorkflowTemplate | null => {
    let tpl = workflowTemplateRef.current || workflowTemplate || lastTemplateRef.current;
    if (!tpl) {
      const loopInfo = cardLoopMap[recordId];
      if (loopInfo) tpl = getSkillById(loopInfo.loopId);
    }
    return tpl || null;
  };

  /** 卡片 record_id 形如「原ID__随机后缀」（generateCards 防冲突加的）：后端 records 存储用的是原 ID，调后端接口前需剥掉后缀 */
  const toBaseRecordId = (id: string) => id.split("__")[0];

  /**
   * 把来源值写入被审查字段：
   * - 网页元素（right_selector 非空）：普通输入框走 performInputValue；选项/日历控件走控件脚本
   * - Excel 绑定列（right_label 形如「姓名（Excel·列名）」）：更新后端记录字段 + 前端卡片数据
   * 返回 { ok, error?, excelField? }，excelField 非空表示改的是本地 Excel 字段
   */
  const applySourceToTarget = useCallback(async (
    record: ApplicantRecord,
    entry: VerificationReportEntry,
    tpl?: WorkflowTemplate | null,
  ): Promise<{ ok: boolean; error?: string; excelField?: string }> => {
    const sourceValue = (entry.left_value || "").trim();
    if (!sourceValue) return { ok: false, error: "来源值为空" };
    const label = entry.right_label || entry.left_field || "字段";

    // 找映射（取 widget / web_side 信息）：优先模板映射，回退会话映射
    const mappingsAll = tpl ? getTemplateMappings(tpl) : mappings;
    const mp = entry.right_selector
      ? mappingsAll.find((m) => m.right_selector === entry.right_selector)
      : undefined;

    // A. 被审查侧是网页元素
    if (entry.right_selector) {
      if (!window.electronAPI) return { ok: false, error: "electronAPI 不可用" };
      const side: ViewSide = mp?.web_side || "right";
      if (mp?.widget) {
        const w = mp.widget;
        const wgSide = w.side || side;
        if (w.kind === "option") {
          const wres = (await window.electronAPI.viewExecuteJS(
            wgSide,
            w.inline ? buildInlineOptionSelectScript(w, sourceValue) : buildOptionSelectScript(w, sourceValue)
          )) as OptionSelectResult | null;
          if (!wres?.ok) return { ok: false, error: `选项控件未匹配「${sourceValue}」: ${wres?.reason || "未知"}` };
        } else {
          const cands = parseDateCandidates(sourceValue);
          if (!cands.length) return { ok: false, error: `「${sourceValue}」不是可识别的日期` };
          const [yy, mm, dd] = cands[0].split("-").map(Number);
          const wres = (await window.electronAPI.viewExecuteJS(wgSide, buildCalendarSetScript(w, yy, mm, dd))) as CalendarSetResult | null;
          if (!wres?.ok) return { ok: false, error: `日历控件设定失败: ${wres?.reason || "未知"}` };
        }
      } else {
        await waitElementAppear(side, entry.right_selector, 4000).catch(() => {});
        const res = await performInputValue(side, entry.right_selector, sourceValue);
        if (!res?.ok) return { ok: false, error: `网页填入失败: ${res?.reason || "未知原因"}` };
      }
      // 绿色高亮确认修正位置
      window.electronAPI?.viewHighlightBoxes(side, [{
        selector: entry.right_selector,
        status: "match",
        label: `${label}: 已以来源为准修正 ✓`,
      }]).catch(() => {});
      return { ok: true };
    }

    // B. 被审查侧是 Excel 绑定列（文件提取 vs Excel 对比行）
    const mExcel = /（(?:Excel|文件提取)·(.+)）$/.exec(entry.right_label || "");
    if (mExcel) {
      const excelField = mExcel[1];
      const baseId = toBaseRecordId(record.record_id);
      // 先更新前端状态（用户立刻看到 Excel 变化），后端同步放在后头
      setCardPool((prev) => prev.map((r) => (r.record_id === record.record_id ? { ...r, fields: { ...r.fields, [excelField]: sourceValue } } : r)));
      setRecords((prev) => prev.map((r) => (r.record_id === baseId ? { ...r, fields: { ...r.fields, [excelField]: sourceValue } } : r)));
      setRightRecords((prev) => prev.map((r) => (r.record_id === baseId ? { ...r, fields: { ...r.fields, [excelField]: sourceValue } } : r)));
      try {
        await api.updateRecordFields(baseId, { [excelField]: sourceValue });
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        if (/404|not found/i.test(err)) return { ok: true, excelField };
        return { ok: false, error: `Excel 更新失败: ${err}` };
      }
      return { ok: true, excelField };
    }

    // C. 兜底：无 selector、无 Excel 标签——左值直接写回 record.fields[left_field]
    //    用于 passport-vs-Excel 通用条目（未走提取元素面板绑定 Excel 列的条目）
    const fallbackField = entry.left_field;
    if (fallbackField && typeof fallbackField === "string" && fallbackField.trim()) {
      const baseId = toBaseRecordId(record.record_id);
      // 先更新前端状态（用户立刻看到 Excel 变化），后端同步放在后头
      setCardPool((prev) => prev.map((r) => (r.record_id === record.record_id ? { ...r, fields: { ...r.fields, [fallbackField]: sourceValue } } : r)));
      setRecords((prev) => prev.map((r) => (r.record_id === baseId ? { ...r, fields: { ...r.fields, [fallbackField]: sourceValue } } : r)));
      setRightRecords((prev) => prev.map((r) => (r.record_id === baseId ? { ...r, fields: { ...r.fields, [fallbackField]: sourceValue } } : r)));
      // 后端同步：允许 404（记录未在 store.records，如只上传了护照），不算失败
      try {
        await api.updateRecordFields(baseId, { [fallbackField]: sourceValue });
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        // 404 不算失败：说明 Excel 数据在前端（cardPool/rightRecords）但后端 store.records 空（例如只上传了护照）
        if (/404|not found/i.test(err)) {
          return { ok: true, excelField: fallbackField };
        }
        return { ok: false, error: `Excel 更新失败（字段 ${fallbackField}）: ${err}` };
      }
      return { ok: true, excelField: fallbackField };
    }

    return { ok: false, error: `字段「${label}」不支持一键修正：无网页元素 selector、无 Excel 绑定列、且 left_field 为空` };
  }, [mappings, performInputValue, waitElementAppear]);

  /** 单字段修正（不重新审查）：返回是否成功；成功后就地更新报告条目为一致并重算卡片三态 */
  const handleFixField = useCallback(async (recordId: string, entry: VerificationReportEntry, rowKey: string): Promise<boolean> => {
    if (batchRunning || singleRunning || queueRunning || fixingFieldKey) return false;
    const record = cardPool.find((r) => r.record_id === recordId) || records.find((r) => r.record_id === recordId);
    if (!record) { setError("找不到该卡片记录"); return false; }
    const tpl = findTemplateForRecord(recordId);
    setFixingFieldKey(rowKey);
    try {
      const r = await applySourceToTarget(record, entry, tpl);
      if (r.ok) {
        setSuccessToast(`已以来源值修正「${entry.right_label || entry.left_field}」`);
        setSteps((prev) => [...prev, {
          step: prev.length + 1,
          action: "fix",
          description: `修正字段「${entry.right_label || entry.left_field}」：以来源值「${(entry.left_value || "").trim()}」覆盖被审查值`,
          success: true,
          timestamp: new Date().toISOString(),
        }]);
        // 跨列同值连带修复：同一行其他字段含相同错误值的一并改为正确值（导出时一并黄色高亮）
        const erroneousValue = (entry.right_value || "").trim();
        const correctValue = (entry.left_value || "").trim();
        const crossFixedFields: string[] = [];
        if (erroneousValue && correctValue && erroneousValue !== correctValue) {
          const baseIdF = toBaseRecordId(record.record_id);
          const primaryField = r.excelField || entry.left_field || "";
          const latestRecord = cardPool.find((x) => x.record_id === record.record_id)
            || records.find((x) => x.record_id === baseIdF)
            || rightRecords.find((x) => x.record_id === baseIdF)
            || null;
          if (latestRecord) {
            for (const [field, val] of Object.entries(latestRecord.fields || {})) {
              if (field === primaryField) continue;
              if (String(val || "").trim() === erroneousValue) crossFixedFields.push(field);
            }
            if (crossFixedFields.length > 0) {
              const updates: Record<string, string> = {};
              crossFixedFields.forEach((f) => { updates[f] = correctValue; });
              try {
                await api.updateRecordFields(baseIdF, updates);
              } catch (e) {
                const err = e instanceof Error ? e.message : String(e);
                if (!/404|not found/i.test(err)) {
                  setSteps((prev) => [...prev, {
                    step: prev.length + 1,
                    action: "fix",
                    description: `跨列连带修正 ${crossFixedFields.join(", ")} 失败：${err}`,
                    success: false,
                    timestamp: new Date().toISOString(),
                  }]);
                }
              }
              setCardPool((prev) => prev.map((rr) => rr.record_id === record.record_id ? { ...rr, fields: { ...rr.fields, ...updates } } : rr));
              setRecords((prev) => prev.map((rr) => rr.record_id === baseIdF ? { ...rr, fields: { ...rr.fields, ...updates } } : rr));
              setRightRecords((prev) => prev.map((rr) => rr.record_id === baseIdF ? { ...rr, fields: { ...rr.fields, ...updates } } : rr));
              setSteps((prev) => [...prev, {
                step: prev.length + 1,
                action: "fix",
                description: `跨列连带修正：${crossFixedFields.join(", ")}（${erroneousValue} → ${correctValue}）`,
                success: true,
                timestamp: new Date().toISOString(),
              }]);
            }
          }
        }
        // 报告就地更新：该条目 + 连带修正的条目 一并转为一致，并重算卡片三态（全部不一致项修好 → 通过）
        const rep = loopReports.find((x) => x.record_id === recordId);
        if (rep) {
          let idx = rep.entries.indexOf(entry);
          if (idx < 0) {
            idx = rep.entries.findIndex((e) =>
              e.left_field === entry.left_field &&
              e.right_label === entry.right_label &&
              e.right_selector === entry.right_selector &&
              e.match === entry.match
            );
          }
          if (idx >= 0) {
            const oldEntry = rep.entries[idx];
            const newEntries = [...rep.entries];
            newEntries[idx] = {
              ...oldEntry,
              match: "match",
              right_value: (entry.left_value || "").trim(),
              reasoning: `已以来源为准修正（原被审查值：${(oldEntry.right_value || "").trim() || "空"}）`,
            };
            // 连带修正的条目同步转绿（导出 Excel 时一并黄色高亮）
            if (crossFixedFields.length > 0) {
              for (let ci = 0; ci < newEntries.length; ci++) {
                if (ci === idx) continue;
                const ce = newEntries[ci];
                if (ce.match !== "mismatch" && ce.match !== "error" && ce.match !== "missing" && ce.match !== "partial") continue;
                const mExcelCross = /（(?:Excel|文件提取)·(.+)）$/.exec(ce.right_label || "");
                const ceField = mExcelCross ? mExcelCross[1] : ce.left_field;
                if (ceField && crossFixedFields.includes(ceField)) {
                  newEntries[ci] = {
                    ...ce,
                    match: "match",
                    right_value: (ce.left_value || "").trim(),
                    reasoning: `已以来源为准修正（跨列连带：原值「${erroneousValue}」→「${correctValue}」）`,
                  };
                }
              }
            }
            const badCount = newEntries.filter((e) => e.match === "mismatch" || e.match === "error" || e.match === "missing").length;
            const goodCount = newEntries.filter((e) => e.match === "match").length;
            const hasMrz = (rep.mrz_warnings?.length ?? 0) > 0;
            const overall: Overall = badCount === 0 ? (hasMrz ? "review" : "pass") : goodCount === 0 ? "fail" : "review";
            const summary = badCount === 0
              ? hasMrz
                ? rep.summary
                : rep.flow === "review"
                ? "全部一致"
                : "录入完成"
              : `${goodCount} 项一致，${badCount} 项不一致`;
            const newRep: VerificationReport = { ...rep, entries: newEntries, overall, summary };
            setLoopReports((prev) => prev.map((x) => (x.record_id === recordId ? newRep : x)));
            // 同步卡片三态着色与批次状态
            setRecordResults((prev) => ({ ...prev, [recordId]: overall }));
            setBatchResults((prev) => prev[recordId]
              ? {
                  ...prev,
                  [recordId]: {
                    ...prev[recordId],
                    status: overall === "pass" ? "success" : overall === "review" ? "review" : "failed",
                    error: overall === "pass" ? undefined : prev[recordId].error,
                  },
                }
              : prev
            );
          }
        }
        return true;
      }
      setError(`修正失败：${r.error || "未知原因"}`);
      return false;
    } finally {
      setFixingFieldKey(null);
    }
  }, [batchRunning, singleRunning, queueRunning, fixingFieldKey, cardPool, records, loopReports, cardLoopMap, workflowTemplate, applySourceToTarget, setError, setSuccessToast]);

  // ===== 从「提取结果」面板批量编辑 OCR 字段值（图1 🔧 → 校正）：同步到 docExtractsByRecord + loopReports 左值 =====
  // 修正后点「修复」时，applySourceToTarget 会取到修正后的值同步到右侧/Excel
  const handleEditExtractFields = useCallback((recordId: string, fieldValueMap: Record<string, string>) => {
    if (Object.keys(fieldValueMap).length === 0) return;
    // 更新到原始提取数据，保证报告重建后修正值仍在
    setDocExtractsByRecord((prev) => {
      const extracts = prev[recordId] || [];
      if (extracts.length === 0) return prev;
      const updated = extracts.map((e) => {
        const merged: Record<string, string> = { ...e.fields };
        for (const [field, value] of Object.entries(fieldValueMap)) merged[field] = String(value || "").trim();
        return { ...e, fields: merged };
      });
      return { ...prev, [recordId]: updated };
    });
    // 更新到当前报告条目，即时反映到卡片
    setLoopReports((prev) => {
      return prev.map((rep) => {
        if (rep.record_id !== recordId) return rep;
        const newEntries = rep.entries.map((e) => {
          const newLValue = fieldValueMap[e.left_field];
          if (newLValue === undefined) return e;
          const lv = String(newLValue || "").trim();
          const rv = (e.right_value || "").trim();
          let match: FieldMatch = "mismatch";
          if (!rv) match = "missing";
          else if (!lv) match = "unknown";
          else if (valuesEquivalent(e.left_field, lv, rv)) match = "match";
          else if (lv.toLowerCase().includes(rv.toLowerCase()) || rv.toLowerCase().includes(lv.toLowerCase())) match = "partial";
          return { ...e, left_value: lv, match };
        });
        const goodCount = newEntries.filter((x) => x.match === "match" || x.match === "partial").length;
        const badCount = newEntries.filter((x) => x.match === "mismatch" || x.match === "error").length;
        const overall: Overall = badCount === 0 ? (rep.mrz_warnings && rep.mrz_warnings.length > 0 ? "review" : "pass") : goodCount === 0 ? "fail" : "review";
        const summary = badCount === 0
          ? rep.flow === "review"
            ? "全部一致"
            : "录入完成"
          : `${goodCount} 项一致，${badCount} 项不一致`;
        return { ...rep, entries: newEntries, overall, summary };
      });
    });
    const fieldNames = Object.keys(fieldValueMap).join("、");
    setSuccessToast(`已校正 OCR 值（${fieldNames}）`);
  }, [setDocExtractsByRecord, setLoopReports, setSuccessToast]);
  const handleConfirmFixes = useCallback(async (
    recordId: string,
    fixKeys: Set<string>,
    confirmKeys: Set<string>,
    _entries: VerificationReportEntry[],
  ) => {
    if (batchRunning || singleRunning || queueRunning || confirmingRecordId) return;
    const record = cardPool.find((r) => r.record_id === recordId) || records.find((r) => r.record_id === recordId);
    if (!record) { setError("找不到该卡片记录"); return; }
    const tpl = findTemplateForRecord(recordId);
    const rep = loopReports.find((x) => x.record_id === recordId);
    if (!rep) { setError("找不到该卡片的核验报告"); return; }
    const baseId = toBaseRecordId(recordId);

    // 定位条目索引：key 形如 `${left_field||right_label||"field"}-${idx}`，尾部 -N 即 entries 索引
    const fixIdxSet = new Set(fixKeys);
    const confirmIdxSet = new Set(confirmKeys);
    const fixIndices = [...fixKeys].map((k) => {
      const m = /-(\d+)$/.exec(k);
      return m ? parseInt(m[1], 10) : -1;
    }).filter((i) => i >= 0 && i < rep.entries.length);
    const confirmIndices = [...confirmKeys].map((k) => {
      const m = /-(\d+)$/.exec(k);
      return m ? parseInt(m[1], 10) : -1;
    }).filter((i) => i >= 0 && i < rep.entries.length);

    setConfirmingRecordId(recordId);
    let applied = 0;
    let failed = 0;
    // 逐 entry 记录写回结果（key → 是否成功），失败项留原文档以待重试
    const writeResults = new Map<string, { ok: boolean; error?: string; excelField?: string }>();
    // 跨列连带修正的字段集合：报告条目同步标记（导出 Excel 一并黄色高亮）
    const crossFixedAll: Array<{ fields: string[]; wrong: string; right: string }> = [];
    try {
      // 1) 左对：以左值写回右侧（复用 applySourceToTarget 的三条写回路径）
      const failedErrors: string[] = [];
      const crossColumnDetails: string[] = [];
      for (const idx of fixIndices) {
        const entry = rep.entries[idx];
        const key = `${entry.left_field || entry.right_label || "field"}-${idx}`;
        const r = await applySourceToTarget(record, entry, tpl);
        if (r.ok) {
          applied++;
          // 跨列同值修复：同一行其他字段含相同错误值的一并改为正确值
          const erroneousValue = (entry.right_value || "").trim();
          const correctValue = (entry.left_value || "").trim();
          if (erroneousValue && correctValue && erroneousValue !== correctValue) {
            const baseId = toBaseRecordId(record.record_id);
            const primaryField = r.excelField || entry.left_field || "";
            // 从当前前端状态读最新记录（applySourceToTarget 已同步）
            const latestRecord = cardPool.find((x) => x.record_id === record.record_id)
              || records.find((x) => x.record_id === baseId)
              || rightRecords.find((x) => x.record_id === baseId)
              || null;
            if (latestRecord) {
              const otherFields: string[] = [];
              for (const [field, val] of Object.entries(latestRecord.fields || {})) {
                if (field === primaryField) continue;
                if (String(val || "").trim() === erroneousValue) otherFields.push(field);
              }
              if (otherFields.length > 0) {
                const updates: Record<string, string> = {};
                otherFields.forEach((f) => { updates[f] = correctValue; });
                try {
                  await api.updateRecordFields(baseId, updates);
                } catch (e) {
                  const err = e instanceof Error ? e.message : String(e);
                  if (!/404|not found/i.test(err)) {
                    failedErrors.push(`跨列修正 ${otherFields.join(", ")} 失败：${err}`);
                  }
                }
                // 同步前端状态
                setCardPool((prev) => prev.map((rr) =>
                  rr.record_id === record.record_id
                    ? { ...rr, fields: { ...rr.fields, ...updates } }
                    : rr
                ));
                setRecords((prev) => prev.map((rr) =>
                  rr.record_id === baseId
                    ? { ...rr, fields: { ...rr.fields, ...updates } }
                    : rr
                ));
                setRightRecords((prev) => prev.map((rr) =>
                  rr.record_id === baseId
                    ? { ...rr, fields: { ...rr.fields, ...updates } }
                    : rr
                ));
                crossColumnDetails.push(`${entry.left_field || "字段"} → 连修 ${otherFields.join(", ")}（${erroneousValue} → ${correctValue}）`);
                crossFixedAll.push({ fields: otherFields, wrong: erroneousValue, right: correctValue });
              }
            }
          }
        } else {
          failed++;
          failedErrors.push(`${entry.left_field || entry.right_label || "字段"}: ${r.error || "未知"}`);
        }
        writeResults.set(key, r);
      }
      // 2) 右对：就地改报告条目为 match（以右侧值为准，不写值）
      for (const idx of confirmIndices) {
        const entry = rep.entries[idx];
        const key = `${entry.left_field || entry.right_label || "field"}-${idx}`;
        if (!((entry.right_value || "").trim())) { failed++; writeResults.set(key, { ok: false, error: "右侧值为空" }); continue; }
        writeResults.set(key, { ok: true });
        applied++;
      }

      // 3) 批量更新报告条目：仅对写回成功的条目改 match；失败项保持 mismatch 并留"写入失败"提示
      const newEntries = rep.entries.map((e, idx) => {
        const key = `${e.left_field || e.right_label || "field"}-${idx}`;
        const fixHit = fixIdxSet.has(key);
        const confirmHit = confirmIdxSet.has(key);
        if (fixHit) {
          const wr = writeResults.get(key);
          if (wr && wr.ok) {
            return { ...e, match: "match" as const, right_value: (e.left_value || "").trim(), reasoning: `已以来源为准修正（原被审查值：${(e.right_value || "").trim() || "空"}）` };
          }
          // 写回失败：不标 match，保留原 right_value，reasoning 提示失败原因，让用户能重试
          return { ...e, match: "error" as const, reasoning: `写入失败：${wr?.error || "未知原因"}（点击修复可重试）` };
        }
        if (confirmHit) {
          const wr = writeResults.get(key);
          if (wr && wr.ok) {
            return { ...e, match: "match" as const, reasoning: `人工确认：以右侧值为准（右侧正确）` };
          }
          return { ...e, match: "error" as const, reasoning: `确认失败：${wr?.error || "右侧值为空"}` };
        }
        // 跨列连带修正的条目：同步转绿（导出 Excel 时一并黄色高亮）
        if (crossFixedAll.length > 0 && (e.match === "mismatch" || e.match === "error" || e.match === "missing" || e.match === "partial")) {
          const mExcelCross = /（(?:Excel|文件提取)·(.+)）$/.exec(e.right_label || "");
          const ceField = mExcelCross ? mExcelCross[1] : e.left_field;
          if (ceField) {
            const hitCross = crossFixedAll.find((c) => c.fields.includes(ceField));
            if (hitCross) {
              return { ...e, match: "match" as const, right_value: (e.left_value || "").trim(), reasoning: `已以来源为准修正（跨列连带：原值「${hitCross.wrong}」→「${hitCross.right}」）` };
            }
          }
        }
        return e;
      });

      // 4) 重算卡片三态
      const badCount = newEntries.filter((e) => e.match === "mismatch" || e.match === "error" || e.match === "missing").length;
      const goodCount = newEntries.filter((e) => e.match === "match").length;
      const hasMrz = (rep.mrz_warnings?.length ?? 0) > 0;
      const overall: Overall = badCount === 0 ? (hasMrz ? "review" : "pass") : goodCount === 0 ? "fail" : "review";
      const summary = badCount === 0
        ? hasMrz
          ? rep.summary
          : rep.flow === "review" ? "全部一致" : "录入完成"
        : `${goodCount} 项一致，${badCount} 项不一致`;
      const newRep: VerificationReport = { ...rep, entries: newEntries, overall, summary };

      // 5) 同步 loopReports / recordResults / batchResults
      setLoopReports((prev) => prev.map((x) => (x.record_id === recordId ? newRep : x)));
      setRecordResults((prev) => ({ ...prev, [recordId]: overall }));
      setBatchResults((prev) => prev[recordId]
        ? { ...prev, [recordId]: {
            ...prev[recordId],
            status: overall === "pass" ? "success" : overall === "review" ? "review" : "failed",
            error: overall === "pass" ? undefined : prev[recordId].error,
          } }
        : prev
      );

      // 6) 图2 分析卡片同步刷新状态（推理文本保留，只更新卡片 overall 与徽标；summary 段重算三态计数）
      setAnalysisSegments((current) => {
        let updated = current.map((seg) => {
          if (seg.kind === "card" && seg.key === recordId) {
            return { ...seg, overall };
          }
          return seg;
        });
        // 从更新后的所有 card 段重算三态计数
        let newPass = 0, newReview = 0, newFail = 0;
        for (const seg of updated) {
          if (seg.kind === "card") {
            if (seg.overall === "pass") newPass++;
            else if (seg.overall === "review") newReview++;
            else if (seg.overall === "fail") newFail++;
          }
        }
        return updated.map((seg) => {
          if (seg.kind === "summary" && seg.stats) {
            return { ...seg, stats: { ...seg.stats, pass: newPass, review: newReview, fail: newFail } };
          }
          return seg;
        });
      });

      setSuccessToast(`已确认修正 ${applied} 项${failed > 0 ? `（${failed} 项写入失败：${failedErrors.join("；") || "未知原因"}）` : ""}：${overall === "pass" ? "全部一致" : overall === "review" ? "仍有需复核项" : "需检查"}`);
      setSteps((prev) => [...prev, {
        step: prev.length + 1,
        action: "fix",
        description: `确认修正：${applied} 项已应用（左对写回 ${fixIndices.length} 项 / 右对改match ${confirmIndices.length} 项）${failed > 0 ? `，${failed} 项失败` : ""}；卡片三态 → ${overall}`,
        success: applied > 0,
        timestamp: new Date().toISOString(),
      }]);

      // 返回已成功应用的 key 集合，供 ResultsPanel 精确迁入 fixedKeys
      const appliedKeys = new Set<string>(fixKeys.filter((k) => {
        const wr = writeResults.get(k);
        return wr && wr.ok;
      }));
      for (const k of confirmKeys) {
        const wr = writeResults.get(k);
        if (wr && wr.ok) appliedKeys.add(k);
      }
      return appliedKeys;
    } finally {
      setConfirmingRecordId(null);
    }
  }, [batchRunning, singleRunning, queueRunning, confirmingRecordId, cardPool, records, loopReports, cardLoopMap, workflowTemplate, analysisSegments, applySourceToTarget, setError, setSuccessToast, setSteps]);

  /** 一键修正该卡片全部不一致字段（以来源为准），然后重新审查该卡片并替换报告 */
  const handleFixAllAndRerun = useCallback(async (recordId: string, entries: VerificationReportEntry[]) => {
    if (batchRunning || singleRunning || queueRunning) return;
    const tpl = findTemplateForRecord(recordId);
    if (!tpl) { setError("找不到该卡片的 LOOP 模板，无法重新审查"); return; }
    const record = cardPool.find((r) => r.record_id === recordId) || records.find((r) => r.record_id === recordId);
    if (!record) { setError("找不到该卡片记录"); return; }
    const recordName = getRecordDisplayName(record);

    setSelectedId(recordId);
    setExecRecordId(recordId);
    setHasRunOnce(true);
    setSingleRunning(true);
    setFixRerunRecordId(recordId);
    setError(null);
    setLogSignal((s) => s + 1);
    const startedAt = new Date().toISOString();

    try {
      // 1. 逐条以来源值修正不一致字段
      let fixedRecord = record;
      let fixedCount = 0;
      let fixFailCount = 0;
      for (let idx = 0; idx < entries.length; idx++) {
        const e = entries[idx];
        if (!isFixableEntry(e)) continue;
        const rowKey = `${e.left_field || e.right_label || "field"}-${idx}`;
        setFixingFieldKey(rowKey);
        const r = await applySourceToTarget(fixedRecord, e, tpl);
        if (r.ok) {
          fixedCount++;
          if (r.excelField) {
            fixedRecord = { ...fixedRecord, fields: { ...fixedRecord.fields, [r.excelField]: (e.left_value || "").trim() } };
          }
          setSteps((prev) => [...prev, {
            step: prev.length + 1,
            action: "fix",
            description: `修正字段「${e.right_label || e.left_field}」：以来源值「${(e.left_value || "").trim()}」覆盖被审查值`,
            success: true,
            timestamp: new Date().toISOString(),
          }]);
        } else {
          fixFailCount++;
          setSteps((prev) => [...prev, {
            step: prev.length + 1,
            action: "fix",
            description: `修正字段「${e.right_label || e.left_field}」失败：${r.error || "未知原因"}`,
            success: false,
            timestamp: new Date().toISOString(),
          }]);
        }
        await new Promise((res) => setTimeout(res, 400));
      }
      setFixingFieldKey(null);

      // 2. 重新审查该卡片（与批量执行同一口径：审查模板走字段比对，录入提取模板走填入+提取对比）
      setSteps((prev) => [...prev, {
        step: prev.length + 1,
        action: "start",
        description: `修正完成（${fixedCount} 项${fixFailCount > 0 ? `，${fixFailCount} 项失败` : ""}），重新审查「${recordName}」...`,
        success: true,
        timestamp: new Date().toISOString(),
      }]);
      const tplHasReview = tpl.reviewMarks.length > 0;
      const result = await executeTemplateForRecord(tpl, fixedRecord, 0, undefined, { wrapWithVerify: tplHasReview });

      // 3. 用最新结果重建该卡片报告（替换旧报告）
      const currentRecordEntries: VerificationReportEntry[] = [];
      let compareEmpty = false;
      if (!result.success) {
        currentRecordEntries.push({
          right_selector: recordId,
          right_label: recordName,
          left_source: "excel",
          left_field: "",
          right_value: "ERROR",
          left_value: "",
          match: "mismatch",
          reasoning: result.error,
          timestamp: new Date().toISOString(),
        });
      } else if (tplHasReview) {
        // 审查流程：网页/Excel 字段比对结果
        for (const c of result.comparisons || []) {
          // 文件提取 vs Excel 绑定列的对比（无网页值）：左=提取值，右=Excel 绑定列值
          const docVsExcel = c.evidence_source === "passport" && !c.website_value && !!c.excel_value;
          currentRecordEntries.push({
            right_selector: c.selector_hint || "",
            right_label: c.website_label || c.field,
            left_source: c.evidence_source || "excel",
            left_field: c.field,
            right_value: docVsExcel ? c.excel_value : c.website_value,
            left_value: docVsExcel ? c.passport_value : (c.excel_value || c.passport_value),
            match: c.match,
            timestamp: new Date().toISOString(),
          });
        }
        if (currentRecordEntries.length === 0) {
          compareEmpty = true;
          currentRecordEntries.push({
            right_selector: "",
            right_label: "字段比对",
            left_source: "excel",
            left_field: "",
            right_value: "未执行",
            left_value: "",
            match: "error",
            reasoning: "字段比对未执行：模板未保存字段映射，且无法从审查步骤推导",
            timestamp: new Date().toISOString(),
          });
        }
        for (const se of result.skippedErrors || []) {
          currentRecordEntries.push({
            right_selector: "",
            right_label: "步骤跳过",
            left_source: "excel",
            left_field: "",
            left_value: "",
            right_value: "失败已跳过",
            match: "error",
            reasoning: se,
            timestamp: new Date().toISOString(),
          });
        }
      } else {
        // 录入/提取流程：填入行 + 文件提取 vs Excel 对比行（与批量执行同一口径）
        for (const f of result.fills || []) {
          currentRecordEntries.push({
            right_selector: "",
            right_label: `${f.label}（填入）`,
            left_source: "excel",
            left_field: f.field,
            left_value: f.value,
            right_value: f.value,
            match: "match",
            timestamp: new Date().toISOString(),
          });
        }
        // 绑定 Excel 列的提取条目：左=提取值，右=绑定列当前值（修正后已是新值）
        const seenExtractFields = new Set<string>();
        for (const row of compareDocBindEntries(tpl.customTextEntries || customTextEntriesRef.current, fixedRecord)) {
          seenExtractFields.add(row.fieldKey);
          currentRecordEntries.push({
            right_selector: "",
            right_label: `${row.label}（文件提取·${row.excelField}）`,
            left_source: "passport",
            left_field: row.fieldKey,
            left_value: row.ocrVal,
            right_value: row.excelVal,
            match: row.match,
            timestamp: new Date().toISOString(),
          });
        }
        // 未绑定但被引用的提取字段（通用对比，口径同批量执行）
        const usedExtractFields = new Set<string>();
        for (const m of getTemplateMappings(tpl)) {
          if (m.left_field) usedExtractFields.add(m.left_field);
        }
        for (const mk of [...tpl.dataSourceMarks, ...tpl.reviewMarks, ...tpl.entryMarks]) {
          if (mk.variableField) usedExtractFields.add(mk.variableField);
          if (mk.excelField) usedExtractFields.add(mk.excelField);
        }
        for (const f of result.fills || []) usedExtractFields.add(f.field);
        const recordExtracts = docExtractsByRecordRef.current[recordId] || [];
        for (const d of recordExtracts) {
          for (const [f, rightValRaw] of Object.entries(d.fields || {})) {
            if (seenExtractFields.has(f)) continue;
            if (!usedExtractFields.has(f)) continue;
            seenExtractFields.add(f);
            const leftVal = String(fixedRecord.fields[f] ?? fixedRecord.passport_fields?.[f] ?? "");
            const rightVal = String(rightValRaw ?? "");
            let m: FieldMatch = "mismatch";
            if (!rightVal) m = "missing";
            else if (!leftVal) m = "unknown";
            else if (valuesEquivalent(f, leftVal, rightVal)) m = "match";
            else if (leftVal.toLowerCase().includes(rightVal.toLowerCase()) || rightVal.toLowerCase().includes(leftVal.toLowerCase())) m = "partial";
            currentRecordEntries.push({
              right_selector: "",
              right_label: `${FIELD_LABELS[f] || f}（文件提取·${f}）`,
              left_source: "passport",
              left_field: f,
              left_value: rightVal,
              right_value: leftVal,
              match: m,
              timestamp: new Date().toISOString(),
            });
          }
        }
        if (currentRecordEntries.length === 0) {
          currentRecordEntries.push({
            right_selector: "",
            right_label: "LOOP 步骤",
            left_source: "excel",
            left_field: "",
            left_value: "",
            right_value: "全部步骤执行完成",
            match: "match",
            timestamp: new Date().toISOString(),
          });
        }
      }
      const badEntries = currentRecordEntries.filter((e) => e.match === "mismatch" || e.match === "error" || e.match === "missing");
      const goodEntries = currentRecordEntries.filter((e) => e.match === "match");
      const hasMismatch = badEntries.length > 0;
      const recordDocExtracts = docExtractsByRecordRef.current[recordId] || [];
      const allMrzWarnings = recordDocExtracts.flatMap((d) => d.mrz_warnings || []);
      const effectiveOverall: Overall = !result.success
        ? "fail"
        : !hasMismatch
        ? allMrzWarnings.length > 0 ? "review" : "pass"
        : goodEntries.length === 0
        ? "fail"
        : "review";
      const personReport: VerificationReport = {
        task_id: `loop-${recordId}-${Date.now()}`,
        record_id: recordId,
        record_name: recordName,
        university_url: rightUrl,
        entries: currentRecordEntries,
        overall: effectiveOverall,
        flow: tplHasReview ? "review" : "entry",
        summary: !result.success
          ? `执行失败：${result.error || "未知错误"}`
          : compareEmpty
          ? "字段比对未执行：模板缺少字段映射，请重新设置字段对比后保存 LOOP"
          : effectiveOverall === "fail"
          ? "无一字段一致 / 缺项严重，需检查"
          : effectiveOverall === "review"
          ? allMrzWarnings.length > 0 && !hasMismatch
            ? `MRZ交叉验证发现${allMrzWarnings.length}处姓名等字段不一致，已以MRZ为准，请人工复核`
            : `${goodEntries.length} 项一致，${badEntries.length} 项不一致`
          : tplHasReview
          ? "全部一致"
          : "录入完成",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        mrz_warnings: allMrzWarnings.length > 0 ? allMrzWarnings : undefined,
      };
      // 替换该记录旧报告（保持卡片位置不变）
      setLoopReports((prev) => {
        const ri = prev.findIndex((r) => r.record_id === recordId);
        if (ri >= 0) {
          const next = [...prev];
          next[ri] = personReport;
          return next;
        }
        return [...prev, personReport];
      });
      // 同步卡片三态着色
      setRecordResults((prev) => ({ ...prev, [recordId]: effectiveOverall }));
      setBatchResults((prev) => ({
        ...prev,
        [recordId]: {
          recordId,
          status: !result.success || effectiveOverall === "fail"
            ? "failed"
            : effectiveOverall === "review"
            ? "review"
            : "success",
          startedAt: prev[recordId]?.startedAt,
          finishedAt: Date.now(),
          error: !result.success
            ? result.error
            : compareEmpty
            ? "字段比对未执行：模板缺少字段映射"
            : effectiveOverall === "fail"
            ? "无一字段一致 / 缺项严重"
            : effectiveOverall === "review"
            ? `${goodEntries.length} 项一致，${badEntries.length} 项不一致`
            : undefined,
          failedOrder: result.failedOrder,
        },
      }));
      if (result.success) {
        setSuccessToast(effectiveOverall === "pass"
          ? `「${recordName}」修正 ${fixedCount} 项，重新审查全部一致`
          : `「${recordName}」修正 ${fixedCount} 项，重新审查仍有 ${badEntries.length} 项不一致`);
      } else {
        setError(`重新审查失败: ${result.error || "未知错误"}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`修正并重新审查失败: ${msg}`);
    } finally {
      setSingleRunning(false);
      setFixRerunRecordId(null);
      setFixingFieldKey(null);
      setBatchMarkCursor(null);
      window.electronAPI?.viewClearHighlight("left").catch(() => {});
      window.electronAPI?.viewClearHighlight("right").catch(() => {});
    }
  }, [batchRunning, singleRunning, queueRunning, cardPool, records, cardLoopMap, workflowTemplate, applySourceToTarget, executeTemplateForRecord, compareDocBindEntries, rightUrl, setError, setSuccessToast]);

  // ============ 导出 Excel：把内存中（修正后）的数据写回文件（本地路径原地写回，否则下载副本） ============
  // 运行结束后点击导出：带上字段对比结果，有问题的单元格在导出文件里高亮（红=不一致/错误，琥珀=缺失）
  const [exportingExcel, setExportingExcel] = useState(false);
  const handleExportExcel = useCallback(async () => {
    if (exportingExcel) return;
    // 卡片池来源侧：右侧 Excel 生成的卡片导右侧，否则导左侧
    const side: "left" | "right" = rightCardsGenerated ? "right" : "left";
    // 收集需要高亮的字段：只含真正有问题的格子（红/琥珀）+ 用户修好的格子（绿）
    // 始终正确的格子（reasoning 不含"已以来源为准修正"或"人工确认"）不传入高亮 → 不填色
    const highlightSignalRe = /已以来源为准修正|人工确认：/;
    const highlights = loopReportsRef.current
      .map((rep) => ({
        // 卡片 record_id 带「__随机后缀」，后端 store 用原 ID——必须剥掉否则高亮永远对不上
        record_id: toBaseRecordId(rep.record_id),
        fields: Object.fromEntries(
          rep.entries
            .filter((e) =>
              e.match === "mismatch" || e.match === "error" || e.match === "missing" || e.match === "partial"
              || (e.match === "match" && highlightSignalRe.test(e.reasoning || ""))
            )
            .map((e) => [e.left_field, /已以来源为准修正|人工确认：/.test(e.reasoning || "") ? "fixed" : e.match])
        ),
      }))
      .filter((h) => Object.keys(h.fields).length > 0);
    // 诊断：导出时打印高亮收集情况（排查"导出无红色"问题）
    const allEntries = loopReportsRef.current.flatMap((rep) => rep.entries);
    const matchDist = allEntries.reduce<Record<string, number>>((acc, e) => {
      acc[e.match] = (acc[e.match] || 0) + 1;
      return acc;
    }, {});
    rlog(`[export-hl] 报告数=${loopReportsRef.current.length} 条目分布=${JSON.stringify(matchDist)} 高亮记录数=${highlights.length} side=${side} 样本=${highlights.slice(0, 2).map((h) => `${h.record_id}:${Object.keys(h.fields).join(",")}`).join(" | ")}`);
    console.log("[export-hl]", { reports: loopReportsRef.current.length, matchDist, highlights: highlights.length, side, sample: highlights.slice(0, 2) });
    setExportingExcel(true);
    try {
      const r = highlights.length > 0
        ? await api.exportExcelHighlighted(side, highlights)
        : await api.exportExcel(side);
      if (r.mode === "inplace") {
        // 后端统一导出到「下载」文件夹 <原名>_审核结果.xlsx，原文件不动
        setSuccessToast((highlights.length > 0 ? `已高亮 ${highlights.length} 条记录 · ` : "") + (r.note ? r.note : `已导出到：${r.path}`));
      } else {
        const a = document.createElement("a");
        a.href = r.path!;
        a.download = r.filename!;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(r.path!), 5000);
        setSuccessToast(highlights.length > 0 ? `已导出 Excel 副本（${highlights.length} 条记录的问题单元格已高亮）` : "已导出 Excel 副本（无问题记录，未高亮）");
      }
    } catch (e) {
      setError(`导出 Excel 失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExportingExcel(false);
    }
  }, [exportingExcel, rightCardsGenerated, setError, setSuccessToast]);

  // ============ SKILL 拖拽到人物卡片：加载 SKILL 并在指定记录上单卡执行 ============
  const runSkillOnRecord = useCallback(
    async (skillId: string, recordId: string) => {
      breakpointTotalRef.current = 1;
      const tpl = getSkillById(skillId);
      if (!tpl) {
        setError("SKILL 不存在或已被删除");
        return;
      }
      if (batchRunning || singleRunning) {
        setError("当前有任务正在执行，请等待完成");
        return;
      }
      const recordIndex = cardPool.findIndex((r) => r.record_id === recordId);
      if (recordIndex < 0) return;
      const record = cardPool[recordIndex];
      const recordName = getRecordDisplayName(record);

      setSelectedId(recordId);
      setWorkflowTemplate(tpl);
      workflowTemplateRef.current = tpl; // 同步更新 ref
      lastTemplateRef.current = tpl; // 持久化保存
      setTeachingPhase("done");
      setShowSkillPanel(false);
      setHasRunOnce(true);
      setSingleRunning(true);
      setLogSignal((s) => s + 1);
      setError(null);
      // 手动退出选择模式，不调用exitSelectMode以避免清空workflowTemplate
      if (selectMode) {
        setSelectMode(false);
        setPickTarget(null);
        setRightPicked(null);
        setLeftPicked(null);
      }
      if (avatarMode) exitAvatarMode();
      if (docPickMode) {
        setDocPickMode(false);
        window.electronAPI?.viewStopPicking("right").catch(() => {});
      }
      window.electronAPI?.viewClearHighlight("left").catch(() => {});
      window.electronAPI?.viewClearHighlight("right").catch(() => {});

      const onStepStart = (ri: number, mark: PickedMark) => {
        setBatchMarkCursor({ recordIndex: ri, markOrder: mark.order });
        liveStepPrefixRef.current = `[${tpl.icon || "🔍"}${tpl.name}] 步骤 ${mark.order}:`;
        const side: ViewSide = mark.side === "left" ? "left" : "right";
        const selector = mark.action === "input" && mark.inputTarget ? mark.inputTarget : mark.selector;
        const label = `${mark.order} · ${markDisplayLabel(mark)}`;
        window.electronAPI?.viewClearHighlight(side).catch(() => {});
        window.electronAPI?.viewHighlightBoxes(side, [{ selector, status: "pending", label }]).catch(() => {});
        setSteps((prev) => [
          ...prev,
          {
            step: prev.length + 1,
            action: mark.action || "pick",
            description: `[${tpl.icon || "🔍"}${tpl.name}] 步骤 ${mark.order}: ${markDisplayLabel(mark)}`,
            success: true,
            detail: mark.action === "input"
              ? `${mark.workflow === "entry" ? "填入" : "定位"}: ${mark.variableField ? `[${mark.variableField}]` : (mark.value || "")}`
              : undefined,
            timestamp: new Date().toISOString(),
          },
        ]);
      };

      setSteps((prev) => [
        ...prev,
        {
          step: prev.length + 1,
          action: "start",
          description: `🎯 SKILL「${tpl.icon || "🔍"} ${tpl.name}」执行：${recordName}`,
          success: true,
          timestamp: new Date().toISOString(),
        },
      ]);

      try {
        const result = await executeTemplateForRecord(tpl, record, 0, onStepStart, {
          wrapWithVerify: false,
          skipSubmit: tpl.mode === "entry",
        });
        if (result.success) {
          setSteps((prev) => [
            ...prev,
            {
              step: prev.length + 1,
              action: "done",
              description: `SKILL 执行完成：已导航到「${recordName}」的页面`,
              success: true,
              timestamp: new Date().toISOString(),
            },
          ]);
          setSuccessToast(`🎯 SKILL「${tpl.name}」已应用到「${recordName}」`);
        } else {
          setSteps((prev) => [
            ...prev,
            {
              step: prev.length + 1,
              action: "error",
              description: `SKILL 执行失败: ${result.error || "未知错误"}`,
              success: false,
              timestamp: new Date().toISOString(),
            },
          ]);
          setError(`SKILL 执行失败: ${result.error || "未知错误"}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`SKILL 执行失败: ${msg}`);
      } finally {
        setSingleRunning(false);
        setBatchMarkCursor(null);
        window.electronAPI?.viewClearHighlight("left").catch(() => {});
        window.electronAPI?.viewClearHighlight("right").catch(() => {});
      }
    },
    [batchRunning, singleRunning, cardPool, selectMode, avatarMode, docPickMode, exitSelectMode, exitAvatarMode, executeTemplateForRecord, setError, setSuccessToast]
  );

  // 用户在左侧浏览器点击了头像元素
  const onAvatarPicked = useCallback(async (info: PickedElementInfo) => {
    setAvatarPicked(info);
    setAvatarMode(false); // 退出拾取
    // 记录拾取标记（头像提取）
    addPickedMark({
      side: "left",
      source: "avatar",
      selector: info.selector,
      label: `头像 · ${info.label || info.selector}`,
      value: info.value,
      workflow: "data-source",
      recordId: selected?.record_id,
      rect: info.rect,
      tag: info.tag,
      type: info.type,
    });
    if (!selected || !info.rect) return;
    setAvatarBusy(true);
    try {
      // 调用 Electron 截图该元素区域
      const result = await window.electronAPI?.viewCaptureElement("left", info.rect);
      if (result?.ok && result.dataUrl) {
        // 去掉 data:image/png;base64, 前缀
        const base64 = result.dataUrl.split(",", 2)[1] || result.dataUrl;
        // 保存到后端
        await api.updateAvatar(selected.record_id, base64);
        // 更新本地记录
        setRecords((prev) =>
          prev.map((r) =>
            r.record_id === selected.record_id ? { ...r, avatar: base64 } : r
          )
        );
      }
    } catch (e) {
      console.error("提取头像失败", e);
      setError(`提取头像失败: ${e}`);
    } finally {
      setAvatarBusy(false);
    }
  }, [selected, addPickedMark]);

  // ============ 键盘快捷键：S（输入）/ 空格（点击）/ R（撤销） ============
  // 用 ref 持有最新的状态和回调，handler 只在挂载时注册一次，
  // 避免状态变化时频繁 add/remove listener 导致按键"丢失"
  const toggleWidgetExtractRef = useRef<() => void>(() => {});
  const kbStateRef = useRef({
    pickedMarks, avatarMode, selectMode, pendingAction,
    showSettings, replaying, addingClickMode, nextClickLabel: null as string | null,
    fieldPanelActive: false, addingStepMode: null as "entry" | "review" | null,
    addingDocExtractMode: false, bindInputSide: null as null | "left" | "right" | "both",
    customTextMode: false,
    removePickedMark, enterSelectMode, exitAvatarMode, exitSelectMode,
    setError, setInputTarget, setPendingAction, setPickTarget,
    setPendingInputValue, setPendingInputField,
    setBindInputSide, setNextClickLabel, setAddingClickMode,
    setAddingDocExtractMode: (_v: boolean) => {}, setDocExtractSource: (_v: any) => {},
    setDocLocalFiles: (_v: any) => {}, setDocFileBindField: (_v: any) => {},
    setRightPicked: (_v: any) => {}, setLeftPicked: (_v: any) => {},
    commitInput, undoLastStep: () => {},
    startAddingEntrySteps: () => {}, startAddingReviewSteps: () => {},
    toggleCustomText: () => {}, startAddDocExtract: () => {},
    addCustomTextEntry: () => {},
    startAddClickStepPost: () => {}, startAddClickStepPhase: (_p: "pre" | "mid" | "post") => {}, toggleWidgetExtract: () => {},
    toggleFieldSetup: () => {},
    undoDocExtractClick: async () => {}, docExtractGoBack: async () => {},
  });
  kbStateRef.current = {
    pickedMarks, avatarMode, selectMode, pendingAction,
    showSettings, replaying, addingClickMode, nextClickLabel,
    fieldPanelActive, addingStepMode,
    addingDocExtractMode, bindInputSide,
    customTextMode,
    removePickedMark, enterSelectMode, exitAvatarMode, exitSelectMode,
    setError, setInputTarget, setPendingAction, setPickTarget,
    setPendingInputValue, setPendingInputField,
    setBindInputSide, setNextClickLabel, setAddingClickMode,
    setAddingDocExtractMode, setDocExtractSource, setDocLocalFiles, setDocFileBindField,
    setRightPicked, setLeftPicked,
    commitInput, undoLastStep,
    startAddingEntrySteps, startAddingReviewSteps,
    toggleCustomText, startAddDocExtract,
    addCustomTextEntry,
    startAddClickStepPost: () => startAddClickStep("post"), startAddClickStepPhase: (p) => startAddClickStep(p), toggleWidgetExtract: () => toggleWidgetExtractRef.current(),
    toggleFieldSetup: () => setFieldSetupToggleSignal((v) => v + 1),
    undoDocExtractClick, docExtractGoBack,
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const s = kbStateRef.current;
      if (s.showSettings) return;
      if (s.replaying) return;
      const key = e.key;
      // 表单字段中：不拦截字母键，保证正常输入
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      // 步骤设置快捷键：进入步骤设置模式（selectMode）或点击过字段面板后即可用。
      // 放在按钮检查之前，确保焦点在面板按钮上时也能响应。
      if (s.selectMode || s.fieldPanelActive) {
        if (key === "l" || key === "L") { e.preventDefault(); s.toggleFieldSetup(); return; }
        if (key === "q" || key === "Q") { e.preventDefault(); const inStepMode = s.addingStepMode === "entry" || s.addingStepMode === "review"; s.startAddClickStepPhase(inStepMode ? "mid" : "pre"); return; }
        if (key === "w" || key === "W") { e.preventDefault(); s.startAddingEntrySteps(); return; }
        if (key === "r" || key === "R") { e.preventDefault(); s.startAddingReviewSteps(); return; }
        if (key === "t" || key === "T") {
          e.preventDefault();
          if (!s.customTextMode) {
            s.toggleCustomText();
          } else {
            s.addCustomTextEntry();
          }
          return;
        }
        if (key === "f" || key === "F") { e.preventDefault(); s.startAddDocExtract(); return; }
        if (key === "e" || key === "E") { e.preventDefault(); s.startAddClickStepPost(); return; }
        if (key === "g" || key === "G") { e.preventDefault(); s.toggleWidgetExtract(); return; }
      }
      // 焦点在按钮上：忽略 S/Space 等通用快捷键（避免与按钮交互冲突）
      if (t && t.tagName === "BUTTON") return;
      if (key === "s" || key === "S") {
        e.preventDefault();
        // S 输入模式：先点 Excel/网页取值，再点右侧目标输入框，最后 Enter 完成
        if (s.avatarMode) s.exitAvatarMode();
        if (!s.selectMode) s.enterSelectMode();
        s.setPickTarget("left");
        s.setPendingAction("input");
        s.setInputTarget(null);
        s.setPendingInputValue(null);
        s.setPendingInputField(null);
        s.setBindInputSide(null);
        s.setNextClickLabel(null);
        // 显式激活左侧 picker 并关闭右侧 picker：
        // 用 pickTarget 管理切换时，若当前已是 left，useEffect 不会重新触发 startPicking，
        // 但上一次拾取后 picker 已被局部停用，需要手动重新激活。
        window.electronAPI?.viewStopPicking("right");
        window.electronAPI?.viewStartPicking("left");
        // 不再用顶部 Toast 提示，只靠页面浮标反馈
      } else if (key === " ") {
        e.preventDefault();
        if (s.pendingAction === "click") {
          // 教学模式"搜索"阶段：按空格跳过搜索，直接进入确认人物
          if (s.nextClickLabel === "搜索") {
            s.setNextClickLabel("确认人物");
            return;
          }
          s.setPendingAction("none");
          s.setBindInputSide(null);
          s.setNextClickLabel(null);
          s.setAddingClickMode(false);
          return;
        }
        if (s.avatarMode) s.exitAvatarMode();
        if (s.selectMode) s.exitSelectMode();
        s.setBindInputSide(null);
        s.setNextClickLabel(null);
        s.setAddingClickMode(false);
        s.setPendingAction("click");
      } else if (s.addingDocExtractMode && docExtractSourceRef.current === "web") {
        // 文件提取网页模式专用快捷键（Ctrl+Z撤销/Backspace返回/任意键恢复光标）
        const curPhase = docWebStatusRef.current?.phase;
        let handled = false;
        if ((e.ctrlKey || e.metaKey) && (key === "z" || key === "Z")) {
          e.preventDefault();
          s.undoDocExtractClick();
          handled = true;
        } else if (key === "Backspace" || (e.altKey && key === "ArrowLeft")) {
          e.preventDefault();
          s.docExtractGoBack();
          handled = true;
        } else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey &&
                   (curPhase === "idle" || curPhase === "post-click")) {
          // 光标消失时按任意普通键尝试恢复picking
          window.electronAPI?.viewStartPicking("left").catch(() => {});
          window.electronAPI?.viewStartPicking("right").catch(() => {});
          handled = true;
        }
        if (handled) return;
        // 未处理的键（如Escape）继续往下走
      } else if ((e.ctrlKey || e.metaKey) && (key === "z" || key === "Z")) {
        // Ctrl+Z：全局撤销（文件提取网页模式内的 Ctrl+Z 优先由上方分支处理）
        e.preventDefault();
        s.undoLastStep();
      }
      if (key === "Escape") {
        // 两级退出（与 Enter 等价）：
        // 1. 文件提取配置模式 → 退出文件提取配置
        // 2. S 输入模式 → 完成填入并回到"搭建节点"状态（保持 selectMode）
        // 3. 教学"搜索"阶段 → 跳过搜索进入确认人物
        // 4. 点击模式 → 退出点击模式
        // 5. 绑定输入框子模式 → 退出绑定模式
        // 6. selectMode/avatarMode → 完全退出
        if (s.addingDocExtractMode) {
          // 如果当前在收尾点击阶段，ESC 先退回到提取成功状态（而非直接退出配置）
          if (docWebStatusRef.current?.phase === "post-click") {
            const lastFilename = docWebStatusRef.current.filename || "";
            // 查找最近一个成功的提取结果大小（通过 pendingWebFileRef 或 docSourcePreview 获取）
            setDocWebStatus({ phase: "success", filename: lastFilename, size: 0 });
            window.electronAPI?.viewStopPicking("left").catch(() => {});
            window.electronAPI?.viewStopPicking("right").catch(() => {});
            window.electronAPI?.popupStopPicking("left").catch(() => {});
            window.electronAPI?.popupStopPicking("right").catch(() => {});
            setSuccessToast("已结束收尾点击添加，可继续添加开头点击或完成提取");
            return;
          }
          s.setAddingDocExtractMode(false);
          s.setDocExtractSource(null);
          s.setDocLocalFiles([]);
          s.setDocFileBindField(null);
          window.electronAPI?.viewStopPicking("left").catch(() => {});
          window.electronAPI?.viewStopPicking("right").catch(() => {});
          window.electronAPI?.popupStopPicking("left").catch(() => {});
          window.electronAPI?.popupStopPicking("right").catch(() => {});
          window.electronAPI?.viewClearHighlight("left").catch(() => {});
          window.electronAPI?.viewClearHighlight("right").catch(() => {});
          window.electronAPI?.setDownloadCapture("left", false).catch(() => {});
          window.electronAPI?.setDownloadCapture("right", false).catch(() => {});
          return;
        }
        // ESC 退出一键直传模式
        if (quickUploadModeRef.current) {
          cancelQuickUpload();
          return;
        }
        if (s.bindInputSide) {
          s.setBindInputSide(null);
          s.setPendingAction("none");
          s.setRightPicked(null);
          s.setLeftPicked(null);
          window.electronAPI?.viewStopPicking("left").catch(() => {});
          window.electronAPI?.viewStopPicking("right").catch(() => {});
          window.electronAPI?.viewClearHighlight("left").catch(() => {});
          window.electronAPI?.viewClearHighlight("right").catch(() => {});
          return;
        }
        if (s.pendingAction === "input") {
          s.commitInput();
          return;
        }
        if (s.pendingAction === "click" && s.nextClickLabel === "搜索") {
          s.setNextClickLabel("确认人物");
          return;
        }
        if (s.pendingAction === "click") {
          s.setPendingAction("none");
          s.setNextClickLabel(null);
          s.setAddingClickMode(false);
          return;
        }
        if (s.selectMode) {
          s.exitSelectMode();
          return;
        }
        if (s.avatarMode) {
          s.exitAvatarMode();
          return;
        }
      } else if (key === "Enter") {
        // 快捷键优先级：
        // 0. 映射配置中双侧已选好 → Enter 直接保存映射（最高优先）
        // 1. 文件提取配置模式 → 退出文件提取配置
        // 2. S 输入模式 → 完成填入并回到"搭建节点"状态（保持 selectMode）
        // 3. 教学"搜索"阶段 → 跳过搜索进入确认人物
        // 4. 点击模式 → 退出点击模式
        // 5. selectMode/avatarMode → 完全退出
        e.preventDefault();
        if (mappingSaveTriggerRef.current) {
          const fn = mappingSaveTriggerRef.current;
          mappingSaveTriggerRef.current = null;
          fn();
          return;
        }
        if (s.addingDocExtractMode) {
          s.setAddingDocExtractMode(false);
          s.setDocExtractSource(null);
          s.setDocLocalFiles([]);
          s.setDocFileBindField(null);
          window.electronAPI?.viewStopPicking("left").catch(() => {});
          window.electronAPI?.viewStopPicking("right").catch(() => {});
          window.electronAPI?.viewClearHighlight("left").catch(() => {});
          window.electronAPI?.viewClearHighlight("right").catch(() => {});
          window.electronAPI?.setDownloadCapture("left", false).catch(() => {});
          window.electronAPI?.setDownloadCapture("right", false).catch(() => {});
          return;
        }
        if (s.pendingAction === "input") {
          s.commitInput();
          return;
        }
        if (s.pendingAction === "click" && s.nextClickLabel === "搜索") {
          s.setNextClickLabel("确认人物");
          return;
        }
        if (s.pendingAction === "click") {
          s.setPendingAction("none");
          s.setNextClickLabel(null);
          s.setAddingClickMode(false);
          return;
        }
        if (s.selectMode) {
          s.exitSelectMode();
          return;
        }
        if (s.avatarMode) {
          s.exitAvatarMode();
          return;
        }
      }
    };
    // capture=true：在事件冒泡前捕获，避免被网页元素或其他 handler 拦截
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // BrowserView 中的 Enter 键无法冒泡到主窗口，需通过 view-message relay 接收
  useEffect(() => {
    if (!window.electronAPI) return;
    const off = window.electronAPI.onViewMessage((msg) => {
      if (msg.payload?.kind !== "enter-pressed") return;
      // 映射配置中双侧已选好 → Enter 直接保存映射（最高优先，与主窗口 Enter 一致）
      if (mappingSaveTriggerRef.current) {
        const fn = mappingSaveTriggerRef.current;
        mappingSaveTriggerRef.current = null;
        fn();
        return;
      }
      // click 模式下按 Enter：搜索阶段→跳过，其他→退出；input 模式下 commitInput
      if (pendingActionRef.current === "click") {
        if (nextClickLabelRef.current === "搜索") {
          setNextClickLabel("确认人物");
        } else {
          setPendingAction("none");
          setNextClickLabel(null);
          setAddingClickMode(false);
        }
      } else {
        commitInput();
      }
    });
    return () => off?.();
  }, [commitInput]);

  // ============ 右键菜单：绑定输入时右键点输入框 → 选择 Excel 列 ============
  // picker 脚本右键点输入框 → 发 context-menu-request → 前端回传列列表
  // 用户点选列 → 发 context-menu-select → 前端更新 input mark 的 variableField
  useEffect(() => {
    if (!window.electronAPI) return;
    const off = window.electronAPI.onViewMessage((msg) => {
      const kind = msg.payload?.kind;
      if (kind === "context-menu-request") {
        // 右键菜单请求：回传当前卡片的所有 Excel 列名
        const p = msg.payload as { kind: string; selector: string; label: string };
        const side = msg.side;
        // 获取当前选中卡片的所有字段名
        const currentSelected = selected;
        if (!currentSelected) {
          window.electronAPI?.viewCtxMenuResponse(side, [], "");
          return;
        }
        const columns = Object.keys(currentSelected.fields).filter((k) => {
          const v = currentSelected.fields[k];
          return v && String(v).trim();
        });
        // 当前绑定的字段（查找该 selector 对应的 input mark）
        const currentMark = pickedMarksRef.current.find(
          (m) => m.action === "input" && m.inputTarget === p.selector && m.side === side
        );
        const currentField = currentMark?.variableField || currentMark?.excelField || "";
        window.electronAPI?.viewCtxMenuResponse(side, columns, currentField);
      } else if (kind === "context-menu-select") {
        // 用户选择了某列：更新对应 input mark 的 variableField
        const p = msg.payload as { kind: string; selector: string; field: string };
        const side = msg.side;
        // 更新 pickedMarks 中该 selector 的 input mark
        setPickedMarks((prev) =>
          prev.map((m) => {
            if (m.action === "input" && m.inputTarget === p.selector && m.side === side) {
              const newValue = selected?.fields?.[p.field] || m.value || "";
              return {
                ...m,
                variableField: p.field,
                excelField: p.field,
                value: newValue,
                label: `${m.workflow === "entry" ? "录入" : "审查"}「${newValue.slice(0, 18)}${newValue.length > 18 ? "…" : ""}」← Excel「${p.field}」`,
              };
            }
            return m;
          })
        );
        // 同时更新 inputTarget 状态（如果该 mark 是当前目标）
        if (inputTargetRef.current?.selector === p.selector && inputTargetRef.current?.side === side) {
          setPendingInputField(p.field);
          pendingInputFieldRef.current = p.field;
          const newValue = selected?.fields?.[p.field] || "";
          setPendingInputValue(newValue);
          pendingInputValueRef.current = newValue;
        }
        // 如果该输入框已有内容，重新填入新值
        if (selected?.fields?.[p.field]) {
          performInputValue(side, p.selector, selected.fields[p.field]).catch(() => {});
        }
        setSuccessToast(`已切换输入源为「${p.field}」`);
      }
    });
    return () => off?.();
  }, [selected, performInputValue, setSuccessToast]);

  // === 元素屏蔽功能 ===
  // 应用屏蔽规则到指定 side（从 localStorage 读取该 host 的规则 + 自动侧边栏折叠规则，发送到主进程）
  const applyBlockRulesForUrl = useCallback((side: ViewSide, url: string) => {
    if (!window.electronAPI) return;
    const host = getHost(url);
    const userRules = getBlockRules(host);
    const autoCollapse = getSidebarAutoCollapse(host);
    // 同步勾选状态到 React state（用于按钮显示）
    setSidebarAutoCollapseState((prev) => {
      const key = `${side}:${host}`;
      return prev[key] === autoCollapse ? prev : { ...prev, [key]: autoCollapse };
    });
    // 合并用户规则 + 自动侧边栏折叠规则
    const allRules: BlockRule[] = [...userRules];
    if (autoCollapse) {
      SIDEBAR_AUTO_SELECTORS.forEach((sel) => {
        if (!allRules.some((r) => r.selector === sel)) {
          allRules.push({ selector: sel, label: "侧边栏(自动)", createdAt: Date.now(), mode: "collapse" });
        }
      });
    }
    setBlockRulesState((prev) => ({ ...prev, [`${side}:${host}`]: allRules }));
    window.electronAPI.viewSetBlockRules(side, allRules.map((r) => ({ selector: r.selector, mode: r.mode }))).catch(() => {});
  }, []);

  // 屏蔽元素拾取回调（hide 模式：完全隐藏）
  const onBlockElementPicked = useCallback((side: ViewSide, info: PickedElementInfo) => {
    const url = side === "left" ? leftUrl : rightUrl;
    const host = getHost(url);
    const label = info.label || info.text || info.tag || info.selector.slice(0, 40);
    const rules = addBlockRule(host, info.selector, label, "hide");
    setBlockRulesState((prev) => ({ ...prev, [`${side}:${host}`]: rules }));
    window.electronAPI?.viewSetBlockRules(side, rules.map((r) => ({ selector: r.selector, mode: r.mode }))).catch(() => {});
    setBlockPickingSide(null);
  }, [leftUrl, rightUrl]);

  // 切换自动侧边栏折叠开关（持久化，立即应用到当前页面）
  const toggleSidebarAutoCollapse = useCallback((side: ViewSide) => {
    const url = side === "left" ? leftUrl : rightUrl;
    if (!url) return;
    const host = getHost(url);
    const next = !getSidebarAutoCollapse(host);
    setSidebarAutoCollapse(host, next);
    setSidebarAutoCollapseState((prev) => ({ ...prev, [`${side}:${host}`]: next }));
    // 重新应用规则（合并用户规则 + 自动折叠规则）
    const userRules = getBlockRules(host);
    const allRules: BlockRule[] = [...userRules];
    if (next) {
      SIDEBAR_AUTO_SELECTORS.forEach((sel) => {
        if (!allRules.some((r) => r.selector === sel)) {
          allRules.push({ selector: sel, label: "侧边栏(自动)", createdAt: Date.now(), mode: "collapse" });
        }
      });
    }
    setBlockRulesState((prev) => ({ ...prev, [`${side}:${host}`]: allRules }));
    window.electronAPI?.viewSetBlockRules(side, allRules.map((r) => ({ selector: r.selector, mode: r.mode }))).catch(() => {});
  }, [leftUrl, rightUrl]);

  // 删除一条屏蔽规则
  const handleRemoveBlockRule = useCallback((side: ViewSide, host: string, selector: string) => {
    // 不允许删除自动侧边栏规则（由开关控制）
    if (SIDEBAR_AUTO_SELECTORS.includes(selector)) return;
    const rules = removeBlockRule(host, selector);
    // 重新合并自动折叠规则
    const autoCollapse = getSidebarAutoCollapse(host);
    const allRules: BlockRule[] = [...rules];
    if (autoCollapse) {
      SIDEBAR_AUTO_SELECTORS.forEach((sel) => {
        if (!allRules.some((r) => r.selector === sel)) {
          allRules.push({ selector: sel, label: "侧边栏(自动)", createdAt: Date.now(), mode: "collapse" });
        }
      });
    }
    setBlockRulesState((prev) => ({ ...prev, [`${side}:${host}`]: allRules }));
    window.electronAPI?.viewSetBlockRules(side, allRules.map((r) => ({ selector: r.selector, mode: r.mode }))).catch(() => {});
  }, []);

  // === 账号密码凭证 ===
  const handleAddCredential = useCallback((data: { host: string; name: string; username: string; password: string; note?: string }) => {
    const all = addCredential(data);
    setCredentials(all);
  }, []);

  const handleRemoveCredential = useCallback((id: string) => {
    const all = removeCredential(id);
    setCredentials(all);
    if (activePasteId === id) {
      setActivePasteId(null);
      setPasteStep(0);
      window.electronAPI?.cancelTwoStepPaste().catch(() => {});
    }
  }, [activePasteId]);

  // 点击 COPY 按钮：激活两段式粘贴
  const handleCopyCredential = useCallback((side: ViewSide, cred: Credential) => {
    // 再次点击同一个凭证：取消
    if (activePasteId === cred.id) {
      setActivePasteId(null);
      setPasteStep(0);
      window.electronAPI?.cancelTwoStepPaste().catch(() => {});
      return;
    }
    setActivePasteId(cred.id);
    setPasteStep(0);
    window.electronAPI?.startTwoStepPaste(side, cred.username, cred.password).catch(() => {});
  }, [activePasteId]);

  // 取消两段式粘贴
  const handleCancelPaste = useCallback(() => {
    setActivePasteId(null);
    setPasteStep(0);
    window.electronAPI?.cancelTwoStepPaste().catch(() => {});
  }, []);

  // 监听主进程的两段式粘贴进度通知
  useEffect(() => {
    if (!window.electronAPI?.onTwoStepPasteProgress) return;
    const off = window.electronAPI.onTwoStepPasteProgress((data) => {
      if (data.done) {
        setActivePasteId(null);
        setPasteStep(0);
      } else {
        setPasteStep(data.step);
      }
    });
    return off;
  }, []);

  // URL 变化时自动应用屏蔽规则
  useEffect(() => {
    if (rightUrl) applyBlockRulesForUrl("right", rightUrl);
  }, [rightUrl, applyBlockRulesForUrl]);
  useEffect(() => {
    if (leftUrl) applyBlockRulesForUrl("left", leftUrl);
  }, [leftUrl, applyBlockRulesForUrl]);

  /** 根据 picking key 解析控件所属侧（draft 从 widgetDraft 取，saved 从 mappings 取） */
  const getWidgetSideByKey = useCallback((fullKey: string): "left" | "right" => {
    // key 格式: "draft:role" 或 "saved:<selector>:role" 或 "draft:option:idx" 或 "saved:<selector>:option:idx"
    const isDraft = fullKey.startsWith("draft:");
    if (isDraft) {
      return widgetDraftRef.current?.side || "right";
    }
    const savedMatch = fullKey.match(/^saved:(.+?)(?::(?:dayCell|prevMonth|nextMonth|header|prevYear|nextYear|option:\d+))?$/);
    if (savedMatch) {
      const selector = savedMatch[1];
      const found = mappingsRef.current.find((m) => m.right_selector === selector && m.widget);
      return found?.widget?.side || "right";
    }
    return "right";
  }, []);

  /** 控件日历角色重选/引导式拾取：处理点选结果 */
  const handleWidgetRolePicked = useCallback(async (side: "left" | "right", info: PickedElementInfo) => {
    const fullKey = widgetRolePickingKeyRef.current;
    if (!fullKey) return;
    setWidgetRolePickingKey(null);
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    const sep = fullKey.lastIndexOf(":");
    const cardKey = fullKey.slice(0, sep);
    const role = fullKey.slice(sep + 1);
    // 引导式拾取：校验点选元素是否符合角色要求，不合格则提示并重新拾取当前步
    if (calPickStepIdxRef.current !== null) {
      const txt = (info.text || info.label || info.value || "").trim();
      let rejectMsg: string | null = null;
      if (role === "dayCell") {
        if (!/^([1-9]|[12]\d|3[01])$/.test(txt)) {
          rejectMsg = `点选的不是日格子（应为 1-31 的数字，当前：「${txt.slice(0, 12) || "空"}」），请重新点选`;
        }
      } else if (role === "header") {
        if (!containsYearMonthText(txt)) {
          rejectMsg = "点选的区域未包含年月文本（如 2024年1月 / 2024-01）。若年月分开放置，请点选它们外侧的整个标题栏";
        }
      }
      if (rejectMsg) {
        setWidgetSnapshotError(rejectMsg);
        setWidgetRolePickingKey(fullKey);
        const isDayCellReject = role === "dayCell";
        void (async () => {
          const w = cardKey === "draft"
            ? widgetDraftRef.current
            : mappings.find((m) => m.right_selector === cardKey.replace(/^saved:/, ""))?.widget;
          if (w) {
            try {
              await window.electronAPI?.viewExecuteJS(w.side || side, buildWidgetEnsureOpenScript(w.triggerSelector, w.panelSelector));
            } catch { /* ignore */ }
          }
          setTimeout(() => {
            if (widgetRolePickingKeyRef.current) {
              window.electronAPI?.viewStartPicking(w?.side || side).then(() => {
                if (isDayCellReject) {
                  window.electronAPI?.viewSetMarqueeMode?.(w?.side || side, true);
                }
              }).catch(() => {});
            }
          }, 200);
        })();
        return;
      }
      setWidgetSnapshotError(null);
      if (role === "dayCell") {
        const sel0 = generalizeDayCellSelector(info.selector);
        const txt0 = (info.text || info.label || info.value || "").trim();
        setCalDayCellPicks((prev) => (prev.some((p) => p.selector === sel0 && p.text === txt0) ? prev : [...prev, { text: txt0, selector: sel0 }]));
        setWidgetRolePickingKey(fullKey);
        setTimeout(() => {
          if (widgetRolePickingKeyRef.current) {
            const w = cardKey === "draft"
              ? widgetDraftRef.current
              : mappings.find((m) => m.right_selector === cardKey.replace(/^saved:/, ""))?.widget;
            window.electronAPI?.viewStartPicking(w?.side || side).then(() => {
              window.electronAPI?.viewSetMarqueeMode?.(w?.side || side, true);
            }).catch(() => {});
          }
        }, 200);
        return;
      }
    }
    const field = WIDGET_ROLE_TO_FIELD[role];
    if (field) {
      const sel = role === "dayCell" ? generalizeDayCellSelector(info.selector) : info.selector;
      const rectField = `${field.replace(/Selector$/, "")}Rect`;
      const applyRole = (w: WidgetDef): WidgetDef => ({
        ...w,
        calendar: { ...(w.calendar || {}), [field]: sel },
      });
      const commit = (fn: (w: WidgetDef) => WidgetDef) => {
        if (cardKey === "draft") {
          setWidgetDraft((prev) => (prev ? fn(prev) : prev));
        } else {
          const rightSelector = cardKey.replace(/^saved:/, "");
          setMappings((prev) => prev.map((m) => (m.right_selector === rightSelector && m.widget ? { ...m, widget: fn(m.widget) } : m)));
          setPickedMarks((prev) => prev.map((mk) => (mk.selector === rightSelector && mk.widget ? { ...mk, widget: fn(mk.widget) } : mk)));
        }
      };
      commit(applyRole);
      if (role !== "dayCell" && info.rect) {
        const widget = cardKey === "draft"
          ? widgetDraftRef.current
          : mappings.find((m) => m.right_selector === cardKey.replace(/^saved:/, ""))?.widget;
        const panelSel = widget?.calendar?.panelSelector || widget?.panelSelector;
        const wgSide = widget?.side || side;
        if (panelSel && window.electronAPI) {
          const rectScript = `
            ${DEEP_QUERY_HELPER}
            (function(){
              var el = null;
              try { el = __cinsideDeepQuery(${JSON.stringify(panelSel)}); } catch(e) {}
              if (!el) return null;
              var r = el.getBoundingClientRect();
              return { x: r.left, y: r.top };
            })();
          `;
          window.electronAPI.viewExecuteJS(wgSide, rectScript).then((_raw) => {
            const pr = _raw as { x: number; y: number } | null;
            if (pr && typeof pr.x === "number") {
              commit((w) => ({
                ...w,
                calendar: { ...(w.calendar || {}), [rectField]: { dx: Math.round(info.rect!.x + info.rect!.width / 2 - pr.x), dy: Math.round(info.rect!.y + info.rect!.height / 2 - pr.y) } },
              }));
            }
          }).catch(() => {});
        }
      }
      if (role === "dayCell") {
        const baseWidget = cardKey === "draft"
          ? widgetDraftRef.current
          : mappings.find((m) => m.right_selector === cardKey.replace(/^saved:/, ""))?.widget;
        if (baseWidget) {
          const updatedWidget: WidgetDef = { ...baseWidget, calendar: { ...(baseWidget.calendar || {}), [field]: sel } };
          void collectDayCells(updatedWidget, cardKey);
        }
      }
      if (calPickStepIdxRef.current !== null) {
        void advanceCalendarGuide(calPickStepIdxRef.current);
      }
    }
  }, []);

  /** 控件选项按钮重选：把点到的元素记录为对应选项的选择器 */
  const handleWidgetOptionPicked = useCallback((_side: "left" | "right", info: PickedElementInfo) => {
    const fullKey = widgetOptionPickingKeyRef.current;
    if (!fullKey) return;
    setWidgetOptionPickingKey(null);
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    const optionSep = fullKey.lastIndexOf(":option:");
    if (optionSep >= 0) {
      const cardKey = fullKey.slice(0, optionSep);
      const optIdx = parseInt(fullKey.slice(optionSep + 8), 10);
      const applyOption = (w: WidgetDef): WidgetDef => {
        const opts = [...(w.options || [])];
        if (opts[optIdx]) {
          opts[optIdx] = { ...opts[optIdx], selector: info.selector };
        }
        return { ...w, options: opts };
      };
      if (cardKey === "draft") {
        setWidgetDraft((prev) => (prev ? applyOption(prev) : prev));
      } else {
        const rightSelector = cardKey.replace(/^saved:/, "");
        setMappings((prev) => prev.map((m) => (m.right_selector === rightSelector && m.widget ? { ...m, widget: applyOption(m.widget) } : m)));
        setPickedMarks((prev) => prev.map((mk) => (mk.selector === rightSelector && mk.widget ? { ...mk, widget: applyOption(mk.widget) } : mk)));
      }
    }
  }, []);

  const onRightPicked = useCallback(async (info: PickedElementInfo) => {
    // 用 ref 读取最新状态，避免 React 批量更新/闭包延迟
    const currentPendingAction = pendingActionRef.current;
    const currentPendingInputValue = pendingInputValueRef.current;
    const currentBindInputSide = bindInputSideRef.current;
    const currentExcelCol = selectedExcelColumnRef.current || rightSelectedColumnRef.current;
    rlog("[onRightPicked]", { tag: info.tag, selector: info.selector, bindSide: currentBindInputSide, excelCol: currentExcelCol, pendingAction: currentPendingAction });
    // 记录拾取来源（弹窗/主 view），addPickedMark 据此打 inPopup 标记
    pickFromPopupRef.current.right = !!info.fromPopup;
    // 一键直传模式：优先级最高（点 file input/上传按钮 → 立即填入文件）
    if (quickUploadModeRef.current) {
      handleQuickUploadPick("right", info);
      return;
    }
    // 绑定上传模式：优先于一切分支（点 file input/上传按钮 → 弹确认对话框）
    if (uploadBindModeRef.current) {
      handleUploadBindPick("right", info);
      return;
    }
    // 自定义文本拾取模式：优先于其他分支（仅次于文件提取）
    if (customTextModeRef.current && customTextPickingIdRef.current) {
      const id = customTextPickingIdRef.current;
      const entry = customTextEntriesRef.current.find((e) => e.id === id);
      setCustomTextEntries((prev) => prev.map((e) =>
        e.id === id
          ? { ...e, selector: info.selector, label: info.label || info.tag || info.selector, side: "right", tag: info.tag, type: info.type }
          : e
      ));
      setCustomTextPickingId(null);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      // 录入模式：拾取到输入框后立即把文本值填进去（参考「绑定输入框」逻辑）
      // 使用条目自身的 workflow，未设置时跟随全局 currentLoopStepType
      const entryWorkflow = entry?.workflow || currentLoopStepTypeRef.current;
      const isInputLike = /^(input|textarea|select)$/i.test(info.tag || "") || !!info.isContentEditable || /^(text|search|email|tel|url|number|password)$/i.test(info.type || "") || /^(textbox|searchbox|combobox|spinbutton)$/i.test(info.role || "");
      const isEntry = entryWorkflow === "entry";
      const fillValue = (entry?.text || "").trim();
      if (isEntry && isInputLike && fillValue) {
        rlog("[onRightPicked] 自定义文本拾取后立即填入:", { selector: info.selector, value: fillValue });
        setTimeout(() => {
          performInputValue("right", info.selector, fillValue).catch((e) => {
            console.error("[onRightPicked] 自定义文本填入失败", e);
          });
        }, 350);
      }
      return;
    }
    // 日历手动面板点选兜底：快照未检测到面板时，用户点选日历面板内元素（右侧）
    if (calPanelPickModeRef.current === "picking" && calFailTriggerRef.current?.side !== "left") {
      void handleCalPanelPicked(info.selector, "right");
      return;
    }
    // 控件提取：拾取触发框 → 自动快照（右侧网页）
    if (widgetPickKindRef.current) {
      const kind = widgetPickKindRef.current;
      setWidgetPickKind(null);
      void runWidgetSnapshot(info.selector, info.label || info.tag || info.selector, kind, "right");
      return;
    }
    // 控件日历角色重选：仅处理右侧控件（左侧控件由 onLeftPicked 处理）
    if (widgetRolePickingKeyRef.current) {
      const wgSide = getWidgetSideByKey(widgetRolePickingKeyRef.current);
      if (wgSide === "right") {
        void handleWidgetRolePicked("right", info);
        return;
      }
    }
    // 控件选项按钮重选：仅处理右侧控件（左侧控件由 onLeftPicked 处理）
    if (widgetOptionPickingKeyRef.current) {
      const wgSide = getWidgetSideByKey(widgetOptionPickingKeyRef.current);
      if (wgSide === "right") {
        handleWidgetOptionPicked("right", info);
        return;
      }
    }
    // 文件提取模式（步骤4）：优先于一切分支
    if (addingDocExtractModeRef.current) {
      if (docExtractSourceRef.current === "web") {
        // 网页提取 = 多步点击 + 下载捕获：记录点击步骤，等待下载触发
        handleDocExtractClick("right", info);
      } else {
        handleDocExtractPick("right", info);
      }
      return;
    }
    // 功能1：文档提取模式 —— 点击 PDF 链接/图片 → 下载提取 → 文档对比（优先于其他所有分支）
    if (docPickModeRef.current) {
      setDocPickMode(false);
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      const docUrl = (info.href || info.src || "").trim();
      rlog("[onRightPicked] 文档提取模式, href=", info.href, "src=", info.src);
      if (!docUrl) {
        setError("该元素没有可下载的文件链接，请点击 PDF 链接或图片元素");
        return;
      }
      void runDocExtractFromUrl(docUrl);
      return;
    }
    // 回收节点：再次点击已放置的相同元素时删除对应 mark
    // addingStepMode 下跳过回收，允许用户重复选同一元素添加多对映射
    if (!addingStepModeRef.current && recyclePickedMark("right", info.selector)) return;
    // pendingAction=click：右侧点击 = 真实点击元素
    // 绑定模式下跳过本分支（点击输入框应绑定填充，避免残留的 pendingAction=click 拦截填值）
    if (currentPendingAction === "click" && !currentBindInputSide) {
      const clickLabel = nextClickLabelRef.current;
      const currentPhase = addingClickPhaseRef.current;
      rlog("[onRightPicked] click模式, nextClickLabel=", clickLabel, "addingClickMode=", addingClickModeRef.current, "phase=", currentPhase);
      addPickedMark({
        side: "right",
        source: "web",
        selector: info.selector,
        label: clickLabel ? `${clickLabel} · ${info.label || info.tag || info.selector}` : `点击 · ${info.label || info.tag || info.selector}`,
        value: info.value,
        workflow: currentPhase ? "data-source" : (teachingPhase === "data-source" ? "data-source" : teachingPhase === "entry" ? "entry" : "review"),
        action: "click",
        clickPhase: currentPhase || undefined,
        recordId: selected?.record_id,
        rect: info.rect,
        tag: info.tag,
        type: info.type,
      });
      // 触发真实点击：picker 的 pointerdown 已 preventDefault，click 事件不会自动发生，
      // 必须显式 el.click() 网页才会响应（导航/打开面板）。拿不到所选元素时跳过。
      // ⚠️ 必须 await：performRealClick 内部 el.click() 产生的合成 click 事件，
      // 若此时 viewStartPicking 已重新注入 picker（__cinsidePickerActive=true），
      // 合成 click 会被 picker 的 onPick 拦截导致点击失效。
      if (info.selector) await performRealClick("right", info.selector, !!info.fromPopup);
      // 判断点击后的行为：添加点击按钮模式/教学搜索→确认人物/完成
      if (addingClickModeRef.current) {
        // 连续添加点击按钮模式：保持点击状态，使用对应phase的标签
        setNextClickLabel(currentPhase === "post" ? "收尾点击" : currentPhase === "mid" ? "过程点击" : "前置点击");
        setPendingAction("click");
        setPickTarget(null);
        // 等 performRealClick 完成后再重新激活拾取，避免合成 click 被 picker 拦截
        setTimeout(() => {
          if (addingClickModeRef.current) {
            window.electronAPI?.viewStartPicking("left");
            window.electronAPI?.viewStartPicking("right");
          }
        }, 100);
      } else if (clickLabel === "搜索") {
        // 教学模式：刚点完搜索按钮，继续等待点击确认人物按钮
        rlog("[onRightPicked] 搜索按钮已点击，等待确认人物");
        setNextClickLabel("确认人物");
        setPendingAction("click");
        setPickTarget(null);
        // 搜索后等待稍长时间让页面加载再重新激活拾取
        setTimeout(() => {
          window.electronAPI?.viewStartPicking("left");
          window.electronAPI?.viewStartPicking("right");
        }, 500);
      } else {
        // 确认人物点击完成，退出点击模式
        setPendingAction("none");
        setNextClickLabel(null);
        setPickTarget(null);
        window.electronAPI?.viewStopPicking("left").catch(() => {});
        window.electronAPI?.viewStopPicking("right").catch(() => {});
      }
      return;
    }
    // pendingAction=input：右侧点击 = 指定目标输入框并直接填入（无需再按 Enter）
    if (currentPendingAction === "input") {
      const targetMark: PickedMark = {
        id: "temp",
        order: 0,
        side: "right",
        source: "web",
        selector: info.selector,
        label: info.label || info.selector,
        value: info.value,
        workflow: teachingPhase === "data-source" ? "data-source" : teachingPhase === "entry" ? "entry" : "review",
        createdAt: Date.now(),
        rect: info.rect,
        tag: info.tag,
        type: info.type,
      };
      setInputTarget(targetMark);
      inputTargetRef.current = targetMark;
      // 目标已确定，直接填入（commitInput 读取 ref 中的目标与待填值，无需再按 Enter）
      setPickTarget(null);
      void commitInput();
      return;
    }
    // 教学模式向导：连续绑定右侧输入框
    // ⚠️ 绑定流程检查必须在 setRightPicked/setPickTarget 之前，否则会干扰绑定流程的状态
    const currentNextClickLabel = nextClickLabelRef.current;
    // 放宽输入框判断：标准 input/textarea/select + contenteditable + role=textbox/searchbox + input type 兜底
    const isInputLike = /^(input|textarea|select)$/i.test(info.tag || "") || !!info.isContentEditable || /^(text|search|email|tel|url|number|password)$/i.test(info.type || "") || /^(textbox|searchbox|combobox|spinbutton)$/i.test(info.role || "");
    // ⚠️ 右侧是填入目标，不在此处捕获来源字段值——来源值只在左侧 (onLeftPicked) 捕获，
    // 否则点击右侧按钮/链接等非输入元素会覆盖左侧已捕获的来源值，导致填入按钮文字而非字段值。
    // addingStepMode 下走普通映射流程，不触发教学模式直接创建 mark
    const activePhase = (teachingPhase === "data-source" || teachingPhase === "review" || teachingPhase === "entry") && !addingStepModeRef.current ? teachingPhase : null;

    if (currentBindInputSide) {
      // 灵活绑定模式：右侧点输入框 = 绑定 Excel 列并真实填入第一行值；点其他元素 = 真实点击
      // 右侧网页可用「右侧取列」选择器指定同行其他列（如护照号），未设置时跟随 LOOP 列
      const rightCol = rightBindColumnRef.current || currentExcelCol;
      if (rightCol && isInputLike) {
        rlog("[onRightPicked] ✅ 绑定右侧输入框, excelCol=", rightCol, "previewValue=", selected?.fields?.[rightCol]);
        console.log("[onRightPicked] 绑定输入框:", { excelCol: rightCol, selected, previewValue: selected?.fields?.[rightCol] });
        addPickedMark({
          side: "right",
          source: "web",
          selector: info.selector,
          label: `${activePhase === "entry" ? "录入" : "审查"} · ${info.label || info.selector} ← Excel「${rightCol}」`,
          value: info.value,
          workflow: activePhase || "data-source",
          action: "input",
          inputTarget: info.selector,
          inputTargetLabel: info.label || info.selector,
          variableField: rightCol,
          excelField: rightCol,
          recordId: selected?.record_id,
          rect: info.rect,
          tag: info.tag,
          type: info.type,
        });
        // 只填入右侧被绑定的那个输入框（info.selector），而不是无差别塞两侧的第一个输入框。
        // 这样用户点哪个框，就只填那个框，之后用户继续点搜索/确认人物跳转页面。
        // 优先使用「第一次点击的字段值」（录入流复制语义），无来源字段时回退到 Excel 列值
        const previewValue = ((sourceFieldValueRef.current || selected?.fields?.[rightCol]) || "").trim();
        if (previewValue) {
          console.log("[onRightPicked] 执行填入:", { side: "right", selector: info.selector, previewValue });
          setTimeout(() => {
            performInputValue("right", info.selector, previewValue).then((result) => {
              console.log("[onRightPicked] 填入结果:", result);
            }).catch((e) => {
              console.error("[onRightPicked] 填入失败", e);
            });
          }, 350);
        } else {
          console.warn("[onRightPicked] previewValue 为空，无法填入", { selected, rightCol });
        }
        // 保持绑定模式，继续拾取左右两侧：用户可继续点右侧/其他输入框绑定填入，直到点「完成」。
        // 绑定左侧后不退出，否则再点右侧输入框时已脱离绑定模式，无法立即填入。
        setTimeout(() => {
          if (bindInputSideRef.current) {
            window.electronAPI?.viewStartPicking("left");
            window.electronAPI?.viewStartPicking("right");
          }
        }, 300);
      } else {
        // 非输入框：真实点击并记录为前置点击步骤
        rlog("[onRightPicked] ✅ 绑定模式真实点击右侧元素:", info.selector);
        await performRealClick("right", info.selector);
        addPickedMark({
          side: "right",
          source: "web",
          selector: info.selector,
          label: `点击 · ${info.label || info.tag || info.selector}`,
          value: info.value,
          workflow: activePhase || "data-source",
          action: "click",
          clickPhase: "pre",
          recordId: selected?.record_id,
          rect: info.rect,
          tag: info.tag,
          type: info.type,
        });
        // 保持绑定模式：继续拾取左右两侧，直到用户点「完成」
        setTimeout(() => {
          if (bindInputSideRef.current) {
            window.electronAPI?.viewStartPicking("left");
            window.electronAPI?.viewStartPicking("right");
          }
        }, 500);
      }
      return;
    }

    // 教学模式向导：确认人物等特殊点击
    if (currentNextClickLabel && activePhase) {
      addPickedMark({
        side: "right",
        source: "web",
        selector: info.selector,
        label: `${currentNextClickLabel} · ${info.label || info.tag || info.selector}`,
        value: info.value,
        workflow: activePhase,
        action: "click",
        recordId: selected?.record_id,
        rect: info.rect,
        tag: info.tag,
        type: info.type,
      });
      // 添加点击按钮模式下：继续保持点击状态，等待用户点击下一个按钮
      if (addingClickModeRef.current) {
        const currentPhase = addingClickPhaseRef.current;
        setNextClickLabel(currentPhase === "post" ? "收尾点击" : currentPhase === "mid" ? "过程点击" : "前置点击");
        setPendingAction("click");
        setPickTarget("right");
        setTimeout(() => {
          if (addingClickModeRef.current) {
            window.electronAPI?.viewStartPicking("right");
          }
        }, 200);
      } else {
        setNextClickLabel(null);
        setPendingAction("none");
        setPickTarget(null);
      }
      return;
    }

    // 教学模式：点输入框 → 直接记录为“输入”动作并绑定选中的 Excel 列；其他元素 → 点击动作
    // 右侧网页同样优先使用「右侧取列」选择器指定的列（如护照号）
    // 录入流：即使没有 Excel 列，只要来源字段值已捕获，也应当填入输入框
    const rightTeachCol = rightBindColumnRef.current || currentExcelCol;
    if (activePhase && isInputLike && (rightTeachCol || sourceFieldValueRef.current)) {
      addPickedMark({
        side: "right",
        source: "web",
        selector: info.selector,
        label: rightTeachCol
          ? `${activePhase === "entry" ? "录入" : "审查"} · ${info.label || info.selector} ← Excel「${rightTeachCol}」`
          : `${activePhase === "entry" ? "录入" : "审查"} · ${info.label || info.selector} ← 来源字段`,
        value: info.value,
        workflow: activePhase,
        action: "input",
        inputTarget: info.selector,
        inputTargetLabel: info.label || info.selector,
        variableField: rightTeachCol || undefined,
        excelField: rightTeachCol || undefined,
        recordId: selected?.record_id,
        rect: info.rect,
        tag: info.tag,
        type: info.type,
      });
      // 录入流：把来源字段值（优先）或当前 Excel 记录对应列的值填入框内
      const previewValue = ((sourceFieldValueRef.current || (rightTeachCol ? selected?.fields?.[rightTeachCol] : "")) || "").trim();
      if (previewValue) {
        console.log("[onRightPicked] activePhase填入:", { selector: info.selector, previewValue, source: sourceFieldValueRef.current ? "来源字段" : "Excel列" });
        setTimeout(() => {
          performInputValue("right", info.selector, previewValue).then((result) => {
            console.log("[onRightPicked] activePhase填入结果:", result);
          }).catch((e) => {
            console.error("[onRightPicked] activePhase填入失败", e);
          });
        }, 350);
        // 填入后恢复拾取状态，让用户继续操作
        setTimeout(() => {
          window.electronAPI?.viewStartPicking("right");
        }, 500);
      }
      return;
    }
    if (activePhase) {
      addPickedMark({
        side: "right",
        source: "web",
        selector: info.selector,
        label: `点击 · ${info.label || info.tag || info.selector}`,
        value: info.value,
        workflow: activePhase,
        action: "click",
        recordId: selected?.record_id,
        rect: info.rect,
        tag: info.tag,
        type: info.type,
      });
      return;
    }

    // 普通映射流程：记录右侧拾取标记
    setRightPicked(info);
    rightPickedSideRef.current = "right";
    // 审查模式（先右后左）：右侧拾取完成后切到左侧拾取来源；录入模式（先左后右）：两侧已完成，等待保存
    setPickTarget(currentLoopStepTypeRef.current === "review" ? "left" : null);
    // 录入/映射流程：点击右侧输入框时立即填入来源字段值（优先）或 Excel 列值
    // 参考「绑定搜索」逻辑：即使没有选中 Excel 列，只要来源字段值已捕获就填入；延迟 350ms 确保元素就绪
    const ordinaryFillCol = rightBindColumnRef.current || currentExcelCol;
    if (isInputLike && (sourceFieldValueRef.current || ordinaryFillCol)) {
      const previewValue = ((sourceFieldValueRef.current || (ordinaryFillCol ? selected?.fields?.[ordinaryFillCol] : "")) || "").trim();
      if (previewValue) {
        console.log("[onRightPicked] 普通映射填入:", { selector: info.selector, previewValue, source: sourceFieldValueRef.current ? "来源字段" : "Excel列" });
        setTimeout(() => {
          performInputValue("right", info.selector, previewValue).then((result) => {
            console.log("[onRightPicked] 普通映射填入结果:", result);
          }).catch((e) => {
            console.error("[onRightPicked] 普通映射填入失败", e);
          });
        }, 350);
        // 填入后恢复拾取状态（与绑定搜索一致），避免 setRightPicked/setPickTarget 导致拾取中断
        setTimeout(() => {
          window.electronAPI?.viewStartPicking("right");
        }, 500);
      }
    }
    // addingStepMode 下不添加 pick mark，保存映射时才添加 input mark
    if (!addingStepModeRef.current) {
      addPickedMark({
        side: "right",
        source: "web",
        selector: info.selector,
        label: info.label || info.selector,
        value: info.value,
        workflow: "review",
        action: "pick",
        recordId: selected?.record_id,
        rect: info.rect,
        tag: info.tag,
        type: info.type,
      });
    }
    // 自动进入下一步：选择左侧来源（默认提示用户选网页或 Excel）
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleCalPanelPicked 声明在后且为稳定引用，闭包延迟读取安全
  }, [addPickedMark, selected, performRealClick, performInputValue, teachingPhase, recyclePickedMark, handleUploadBindPick]);

  const onLeftPicked = useCallback(async (info: PickedElementInfo) => {
    // 用 ref 读取最新状态，避免 React 批量更新/闭包延迟
    const currentPendingAction = pendingActionRef.current;
    const currentInputTarget = inputTargetRef.current;
    const currentBindInputSide = bindInputSideRef.current;
    const currentExcelCol = selectedExcelColumnRef.current || rightSelectedColumnRef.current;
    rlog("[onLeftPicked]", { tag: info.tag, selector: info.selector, bindSide: currentBindInputSide, excelCol: currentExcelCol, pendingAction: currentPendingAction });
    // 记录拾取来源（弹窗/主 view），addPickedMark 据此打 inPopup 标记
    pickFromPopupRef.current.left = !!info.fromPopup;
    // 一键直传模式：优先级最高（点 file input/上传按钮 → 立即填入文件）
    if (quickUploadModeRef.current) {
      handleQuickUploadPick("left", info);
      return;
    }
    // 绑定上传模式：优先于一切分支（点 file input/上传按钮 → 弹确认对话框）
    if (uploadBindModeRef.current) {
      handleUploadBindPick("left", info);
      return;
    }
    // 自定义文本拾取模式：优先于其他分支（仅次于文件提取）
    if (customTextModeRef.current && customTextPickingIdRef.current) {
      const id = customTextPickingIdRef.current;
      const entry = customTextEntriesRef.current.find((e) => e.id === id);
      setCustomTextEntries((prev) => prev.map((e) =>
        e.id === id
          ? { ...e, selector: info.selector, label: info.label || info.tag || info.selector, side: "left", tag: info.tag, type: info.type }
          : e
      ));
      setCustomTextPickingId(null);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      // 录入模式：拾取到输入框后立即把文本值填进去（参考「绑定输入框」逻辑）
      // 使用条目自身的 workflow，未设置时跟随全局 currentLoopStepType
      const entryWorkflow = entry?.workflow || currentLoopStepTypeRef.current;
      const isInputLike = /^(input|textarea|select)$/i.test(info.tag || "") || !!info.isContentEditable || /^(text|search|email|tel|url|number|password)$/i.test(info.type || "") || /^(textbox|searchbox|combobox|spinbutton)$/i.test(info.role || "");
      const isEntry = entryWorkflow === "entry";
      const fillValue = (entry?.text || "").trim();
      if (isEntry && isInputLike && fillValue) {
        rlog("[onLeftPicked] 自定义文本拾取后立即填入:", { selector: info.selector, value: fillValue });
        setTimeout(() => {
          performInputValue("left", info.selector, fillValue).catch((e) => {
            console.error("[onLeftPicked] 自定义文本填入失败", e);
          });
        }, 350);
      }
      return;
    }
    // 日历手动面板点选兜底：快照未检测到面板时，用户点选日历面板内元素（左侧）
    if (calPanelPickModeRef.current === "picking" && calFailTriggerRef.current?.side === "left") {
      void handleCalPanelPicked(info.selector, "left");
      return;
    }
    // 控件提取：拾取触发框 → 自动快照（左侧网页）
    if (widgetPickKindRef.current) {
      const kind = widgetPickKindRef.current;
      setWidgetPickKind(null);
      void runWidgetSnapshot(info.selector, info.label || info.tag || info.selector, kind, "left");
      return;
    }
    // 控件日历角色重选（左侧网页）
    if (widgetRolePickingKeyRef.current) {
      const widgetSide = getWidgetSideByKey(widgetRolePickingKeyRef.current);
      if (widgetSide === "left") {
        void handleWidgetRolePicked("left", info);
        return;
      }
    }
    // 控件选项按钮重选（左侧网页）
    if (widgetOptionPickingKeyRef.current) {
      const widgetSide = getWidgetSideByKey(widgetOptionPickingKeyRef.current);
      if (widgetSide === "left") {
        void handleWidgetOptionPicked("left", info);
        return;
      }
    }
    // 控件来源拾取：把控件绑定到左侧网页元素（运行时从左网页读值）
    if (widgetLeftPickingKeyRef.current) {
      const key = widgetLeftPickingKeyRef.current;
      setWidgetLeftPickingKey(null);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      const binding: WidgetBinding = {
        leftSource: "database",
        leftField: info.selector,
        leftLabel: info.label || info.tag || info.selector,
      };
      if (key === "draft") {
        setWidgetDraftBinding((prev) => ({ ...prev, ...binding }));
      } else {
        updateSavedWidgetBinding(key.replace(/^saved:/, ""), binding);
      }
      // 拾取完成后自动试跑，延迟一小段时间等待状态更新
      setTimeout(() => {
        if (key === "draft" && widgetDraftRef.current) {
          testWidget("draft", widgetDraftRef.current, binding);
        } else {
          const savedKey = key.replace(/^saved:/, "");
          const found = mappingsRef.current.find(m => m.right_selector === savedKey && m.widget);
          if (found?.widget) {
            testWidget(key, found.widget, binding);
          }
        }
      }, 200);
      return;
    }
    // 文件提取模式：优先于一切分支
    if (addingDocExtractModeRef.current) {
      if (docExtractSourceRef.current === "web") {
        handleDocExtractClick("left", info);
      } else {
        handleDocExtractPick("left", info);
      }
      return;
    }
    // 回收节点：再次点击已放置的相同元素时删除对应 mark
    // addingStepMode 下跳过回收，允许用户重复选同一元素添加多对映射
    if (!addingStepModeRef.current && recyclePickedMark("left", info.selector)) return;
    // pendingAction=click：左侧点击 = 真实点击元素
    // 绑定模式下跳过本分支（点击输入框应绑定填充，避免残留的 pendingAction=click 拦截填值）
    if (currentPendingAction === "click" && !currentBindInputSide) {
      const clickLabel = nextClickLabelRef.current;
      const currentPhase = addingClickPhaseRef.current;
      rlog("[onLeftPicked] click模式, nextClickLabel=", clickLabel, "addingClickMode=", addingClickModeRef.current, "phase=", currentPhase);
      addPickedMark({
        side: "left",
        source: "web",
        selector: info.selector,
        label: clickLabel ? `${clickLabel} · ${info.label || info.tag || info.selector}` : `点击 · ${info.label || info.tag || info.selector}`,
        value: info.value,
        workflow: currentPhase ? "data-source" : (teachingPhase === "data-source" ? "data-source" : teachingPhase === "entry" ? "entry" : "review"),
        action: "click",
        clickPhase: currentPhase || undefined,
        recordId: selected?.record_id,
        rect: info.rect,
        tag: info.tag,
        type: info.type,
      });
      // 触发真实点击：picker 的 pointerdown 已 preventDefault，click 事件不会自动发生，
      // 必须显式 el.click() 网页才会响应（导航/打开面板）。拿不到所选元素时跳过。
      // ⚠️ 必须 await：performRealClick 内部 el.click() 产生的合成 click 事件，
      // 若此时 viewStartPicking 已重新注入 picker（__cinsidePickerActive=true），
      // 合成 click 会被 picker 的 onPick 拦截导致点击失效。
      if (info.selector) await performRealClick("left", info.selector, !!info.fromPopup);
      // 判断点击后的行为：添加点击按钮模式/教学搜索→确认人物/完成
      if (addingClickModeRef.current) {
        // 连续添加点击按钮模式：保持点击状态，使用对应phase的标签
        setNextClickLabel(currentPhase === "post" ? "收尾点击" : currentPhase === "mid" ? "过程点击" : "前置点击");
        setPendingAction("click");
        setPickTarget(null);
        // 等 performRealClick 完成后再重新激活拾取，避免合成 click 被 picker 拦截
        setTimeout(() => {
          if (addingClickModeRef.current) {
            window.electronAPI?.viewStartPicking("left");
            window.electronAPI?.viewStartPicking("right");
          }
        }, 100);
      } else if (clickLabel === "搜索") {
        // 教学模式：刚点完搜索按钮，继续等待点击确认人物按钮
        rlog("[onLeftPicked] 搜索按钮已点击，等待确认人物");
        setNextClickLabel("确认人物");
        setPendingAction("click");
        setPickTarget(null);
        setTimeout(() => {
          window.electronAPI?.viewStartPicking("left");
          window.electronAPI?.viewStartPicking("right");
        }, 500); // 搜索后等待稍长时间让页面加载
      } else {
        // 确认人物点击完成，退出点击模式
        setPendingAction("none");
        setNextClickLabel(null);
        setPickTarget(null);
        window.electronAPI?.viewStopPicking("left").catch(() => {});
        window.electronAPI?.viewStopPicking("right").catch(() => {});
      }
      return;
    }
    // pendingAction=input：左侧点击 = 取该元素的值作为输入源（记录待填入值，等 Enter 执行）
    if (currentPendingAction === "input") {
      const value = info.value || info.text || "";
      // 变量识别：若 value 等于当前卡片某字段值，标记为变量
      const variableField = detectVariableField(value);
      // 记录待填入的值，不立即执行，等用户按 Enter 时才填入（同时同步 ref）
      setPendingInputValue(value);
      pendingInputValueRef.current = value;
      setPendingInputField(variableField || null);
      pendingInputFieldRef.current = variableField || null;
      // 源已确定，切换到右侧目标拾取
      setPickTarget("right");
      window.electronAPI?.viewStopPicking("left");
      window.electronAPI?.viewStartPicking("right");
      // 不再用顶部 Toast，靠页面浮标反馈
      return;
    }
    // 教学模式向导：连续绑定左侧输入框
    // ⚠️ 绑定流程检查必须在 setLeftPicked/setPickTarget 之前，否则会干扰绑定流程的状态
    const currentNextClickLabel = nextClickLabelRef.current;
    // 放宽输入框判断：标准 input/textarea/select + contenteditable + role=textbox + input type 兜底
    const isInputLike = /^(input|textarea|select)$/i.test(info.tag || "") || !!info.isContentEditable || /^(text|search|email|tel|url|number|password)$/i.test(info.type || "");
    // 录入流来源字段：点击非输入字段时捕获其值，供之后点击输入框时复制填入
    // 非输入元素（表格单元格等）的 value 为空，文本在 info.text 中，需取 value || text
    // ⚠️ 绑定模式下不捕获：此时点按钮/链接是记录真实点击步骤，若捕获其文字，
    //    下一次点输入框会把按钮文字（如"搜索"）当成来源值填入，覆盖 Excel 字段值
    if (!currentBindInputSide && !isInputLike && (info.value || info.text)) {
      sourceFieldValueRef.current = String(info.value || info.text).trim();
      sourceFieldLabelRef.current = info.label || info.selector || "";
    }
    // addingStepMode 下走普通映射流程，不触发教学模式直接创建 mark
    const activePhase = (teachingPhase === "data-source" || teachingPhase === "review" || teachingPhase === "entry") && !addingStepModeRef.current ? teachingPhase : null;

    if (currentBindInputSide) {
      // 灵活绑定模式：左侧点输入框 = 绑定 Excel 列并真实填入第一行值；点其他元素 = 真实点击
      if (currentExcelCol && isInputLike) {
        rlog("[onLeftPicked] ✅ 绑定左侧输入框, excelCol=", currentExcelCol, "previewValue=", selected?.fields?.[currentExcelCol]);
        addPickedMark({
          side: "left",
          source: "web",
          selector: info.selector,
          label: `${activePhase === "entry" ? "录入" : "审查"} · ${info.label || info.selector} ← Excel「${currentExcelCol}」`,
          value: info.value,
          workflow: activePhase || "data-source",
          action: "input",
          inputTarget: info.selector,
          inputTargetLabel: info.label || info.selector,
          variableField: currentExcelCol,
          excelField: currentExcelCol,
          recordId: selected?.record_id,
          rect: info.rect,
          tag: info.tag,
          type: info.type,
        });
        // 只填入左侧被绑定的那个输入框（info.selector），而不是无差别塞两侧的第一个输入框。
        // 这样用户点哪个框，就只填那个框，之后用户继续点搜索/确认人物跳转页面。
        // 优先使用「第一次点击的字段值」（录入流复制语义），无来源字段时回退到 Excel 列值
        const previewValue = ((sourceFieldValueRef.current || selected?.fields?.[currentExcelCol]) || "").trim();
        if (previewValue) {
          setTimeout(() => {
            performInputValue("left", info.selector, previewValue).catch(() => {});
          }, 150);
        }
        // 保持绑定模式，继续拾取左右两侧：用户可继续点右侧/其他输入框绑定填入，直到点「完成」。
        // 绑定左侧后不退出，否则再点右侧输入框时已脱离绑定模式，无法立即填入。
        setTimeout(() => {
          if (bindInputSideRef.current) {
            window.electronAPI?.viewStartPicking("left");
            window.electronAPI?.viewStartPicking("right");
          }
        }, 300);
      } else {
        // 非输入框：真实点击并记录为前置点击步骤
        rlog("[onLeftPicked] ✅ 绑定模式真实点击左侧元素:", info.selector);
        performRealClick("left", info.selector);
        addPickedMark({
          side: "left",
          source: "web",
          selector: info.selector,
          label: `点击 · ${info.label || info.tag || info.selector}`,
          value: info.value,
          workflow: activePhase || "data-source",
          action: "click",
          clickPhase: "pre",
          recordId: selected?.record_id,
          rect: info.rect,
          tag: info.tag,
          type: info.type,
        });
        // 保持绑定模式：继续拾取左右两侧，直到用户点「完成」
        setTimeout(() => {
          if (bindInputSideRef.current) {
            window.electronAPI?.viewStartPicking("left");
            window.electronAPI?.viewStartPicking("right");
          }
        }, 500);
      }
      return;
    }

    // 教学模式向导：确认人物等特殊点击
    if (currentNextClickLabel && activePhase) {
      addPickedMark({
        side: "left",
        source: "web",
        selector: info.selector,
        label: `${currentNextClickLabel} · ${info.label || info.tag || info.selector}`,
        value: info.value,
        workflow: activePhase,
        action: "click",
        recordId: selected?.record_id,
        rect: info.rect,
        tag: info.tag,
        type: info.type,
      });
      // 添加点击按钮模式下：继续保持点击状态，等待用户点击下一个按钮
      if (addingClickModeRef.current) {
        const currentPhase = addingClickPhaseRef.current;
        setNextClickLabel(currentPhase === "post" ? "收尾点击" : currentPhase === "mid" ? "过程点击" : "前置点击");
        setPendingAction("click");
        setPickTarget("left");
        setTimeout(() => {
          if (addingClickModeRef.current) {
            window.electronAPI?.viewStartPicking("left");
          }
        }, 200);
      } else {
        setNextClickLabel(null);
        setPendingAction("none");
        setPickTarget(null);
      }
      return;
    }

    // 教学模式：点输入框 → 直接记录为“输入”动作并绑定选中的 Excel 列；其他元素 → 点击动作
    if (activePhase && isInputLike && currentExcelCol) {
      addPickedMark({
        side: "left",
        source: "web",
        selector: info.selector,
        label: `${activePhase === "entry" ? "录入" : "审查"} · ${info.label || info.selector} ← Excel「${currentExcelCol}」`,
        value: info.value,
        workflow: activePhase,
        action: "input",
        inputTarget: info.selector,
        inputTargetLabel: info.label || info.selector,
        variableField: currentExcelCol,
        excelField: currentExcelCol,
        recordId: selected?.record_id,
        rect: info.rect,
        tag: info.tag,
        type: info.type,
      });
      // 与「搜索绑定/绑定输入框」一致：点击左侧输入框时，把来源字段值（或当前 Excel 记录对应列的值）直接填入框内
      const previewValue = ((sourceFieldValueRef.current || selected?.fields?.[currentExcelCol]) || "").trim();
      if (previewValue) {
        setTimeout(() => {
          performInputValue("left", info.selector, previewValue).catch(() => {});
        }, 150);
      }
      return;
    }
    if (activePhase) {
      addPickedMark({
        side: "left",
        source: "web",
        selector: info.selector,
        label: `点击 · ${info.label || info.tag || info.selector}`,
        value: info.value,
        workflow: activePhase,
        action: "click",
        recordId: selected?.record_id,
        rect: info.rect,
        tag: info.tag,
        type: info.type,
      });
      return;
    }

// 普通映射流程：记录左侧拾取标记
// 右侧 Excel 数据源模式：左网页是学校系统（比对目标），占 rightPicked 槽位
if (rightExcelModeRef.current) {
setRightPicked(info);
rightPickedSideRef.current = "left";
} else {
setLeftPicked(info);
}
// 录入流来源字段：第一次点击网页字段时捕获其值，供之后点击输入框时复制填入
// 非输入元素（表格单元格等）的 value 为空，文本在 info.text 中，需取 value || text
if (info.value || info.text) {
  sourceFieldValueRef.current = String(info.value || info.text).trim();
  sourceFieldLabelRef.current = info.label || info.selector || "";
}
// 审查模式（先右后左）：两侧已完成，等待保存；录入模式（先左后右）：左源拾取完成后继续拾取右侧元素
// 右侧 Excel 模式：审查=继续点右侧 Excel 来源字段；录入=两侧完成
setPickTarget(
  rightExcelModeRef.current
    ? (currentLoopStepTypeRef.current === "entry" ? null : "right")
    : (currentLoopStepTypeRef.current === "entry" ? "right" : null)
);
// addingStepMode 下不添加 pick mark，保存映射时才添加 input mark
if (!addingStepModeRef.current) {
addPickedMark({
side: "left",
source: "web",
selector: info.selector,
label: info.label || info.selector,
value: info.value,
workflow: "data-source",
action: "pick",
recordId: selected?.record_id,
rect: info.rect,
tag: info.tag,
type: info.type,
});
}
  }, [addPickedMark, selected, pendingAction, inputTarget, performRealClick, performInputValue, detectVariableField, teachingPhase, setSuccessToast, recyclePickedMark, runDocExtractFromUrl, handleUploadBindPick]);

  // 审查/录入模式下，点击「提取元素」面板中的字段卡片 → 注入为左侧来源（合成拾取值）
  // 提取值天然是「来源/真值」，因此始终填充 leftPicked，不区分当前 pickTarget
  // 合成 PickedElementInfo 的 tag="doc-extract"，selector=字段名，value=提取值
  // ElementSelectBar 保存时识别 tag="doc-extract" → left_source="passport"
  // compareFieldsForRecord 比对时从 record.passport_fields 或 docExtract.fields 读取
  const onPickExtractedField = useCallback((_side: "left" | "right", field: string, value: string) => {
    const label = FIELD_LABELS[field] || field;
    const info: PickedElementInfo = {
      selector: field,
      label: `${label} · ${value}`,
      value,
      tag: "doc-extract",
      type: "text",
      text: value,
      rect: { x: 0, y: 0, width: 0, height: 0 },
    };
    rlog("[onPickExtractedField]", { field, value });
    setLeftPicked(info);
    // 录入流：把提取字段值写入来源字段 ref，选右侧输入框时立即填入（与「绑定输入框」一致）
    sourceFieldValueRef.current = String(value || "").trim();
    sourceFieldLabelRef.current = label;
    // 审查模式：若右侧已选则两侧完成（等待保存）；否则切到右侧选核对元素
    // 录入模式：左侧来源已选，切到右侧选要填入的输入框
    const alreadyHasRight = !!rightPickedRef.current;
    setPickTarget(alreadyHasRight ? null : "right");
    // 停止左侧网页拾取（合成值不需要网页点击）
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    // 若右侧还没选，启动右侧拾取光标，让用户可以在 BrowserPane 中点选元素
    if (!alreadyHasRight) {
      setTimeout(() => {
        window.electronAPI?.viewStopPicking("left").catch(() => {});
        window.electronAPI?.viewStartPicking("right");
      }, 200);
    }
  }, []);

  const saveMapping = (m: FieldMapping) => {
    // 网页侧来源：显式传入优先；否则跟随本轮 rightPicked 槽位元素的实际所在侧
    const webSide: "left" | "right" = m.web_side ?? rightPickedSideRef.current ?? "right";
    const mappingToSave: FieldMapping = { ...m, web_side: webSide };
    setMappings((prev) => [
      ...prev.filter((x) => x.right_selector !== m.right_selector),
      mappingToSave,
    ]);
    // 如果正在添加审查/录入步骤，把映射转化为 pickedMark
    const stepType = currentLoopStepTypeRef.current;
    if (addingStepMode) {
      const isEntry = stepType === "entry";
      const isExcelSource = m.left_source === "excel";
      const isManualSource = m.left_source === "manual";
      const isPassportSource = m.left_source === "passport";
      // 来源是左网页时，m.left_field 是左网页元素的 selector，需要运行时读取
      const leftWebSelector = (!isExcelSource && !isManualSource && !isPassportSource) ? m.left_field : undefined;
      // label中的来源描述
      const sourceLabel = isExcelSource ? "Excel" : isManualSource ? "固定值" : isPassportSource ? "护照提取" : "左网页";
      addPickedMark({
        side: webSide,
        source: isExcelSource ? "excel" : isPassportSource ? "passport" : "web",
        selector: m.right_selector,
        label: `${stepType === "review" ? "审查" : "录入"} · ${m.right_label || m.right_selector} ← ${sourceLabel}「${isManualSource ? (selected?.fields?.[m.left_field] || m.left_field) : m.left_field}」`,
        value: isManualSource ? m.left_field : "",
        workflow: stepType,
        action: isEntry ? "input" : "pick",
        recordId: selected?.record_id,
        rect: undefined,
        tag: "",
        type: "",
        inputTarget: isEntry ? m.right_selector : undefined,
        inputTargetLabel: isEntry ? (m.right_label || m.right_selector) : undefined,
        // Excel来源：从record.fields按字段名取值；护照来源：从docExtract.fields取值；左网页/固定值：不设variableField
        variableField: isEntry && (isExcelSource || isPassportSource) ? m.left_field : undefined,
        excelField: isExcelSource ? m.left_field : undefined,
        sourceSelector: isEntry ? leftWebSelector : undefined,
        // 点击展开型控件：执行时走控件脚本（选项选择/日历设定）而非普通填值
        widget: m.widget || undefined,
      });
      rlog(`[saveMapping] 添加${stepType}步骤: ${m.right_selector} ← ${sourceLabel}(${m.left_field}), isEntry=${isEntry}, variableField=${isEntry && isExcelSource ? m.left_field : "none"}`);
    }
    // 控件映射从面板保存，不进入下一轮拾取（用户未处于拾取流程）
    if (m.widget) return;
    // 重置一轮，继续拾取下一个（审查模式回到核对元素侧，录入模式回到来源侧）
    setRightPicked(null);
    setLeftPicked(null);
    rightPickedSideRef.current = "right";
    // 标准：审查→右网页目标 / 录入→左侧来源；右侧Excel模式：审查→左网页目标 / 录入→右侧Excel来源
    const nextTarget: PickTarget = rightExcelModeRef.current
      ? (currentLoopStepTypeRef.current === "entry" ? "right" : "left")
      : (currentLoopStepTypeRef.current === "entry" ? "left" : "right");
    setPickTarget(nextTarget);
    setTimeout(() => {
      // 只在对应侧显示网页时才启动 webview 拾取（显示 Excel 时靠单元格点击拾取）
      if (nextTarget === "left") {
        window.electronAPI?.viewStopPicking("right").catch(() => {});
        if (leftViewMode === "web") window.electronAPI?.viewStartPicking("left");
      } else {
        window.electronAPI?.viewStopPicking("left").catch(() => {});
        if (rightViewMode === "web") window.electronAPI?.viewStartPicking("right");
      }
    }, 200);
    // 给被选网页元素加个临时高亮提示已保存
    if (window.electronAPI) {
      window.electronAPI.viewHighlightBoxes(webSide, [
        { selector: m.right_selector, status: "pending", label: m.right_label || "已映射" },
      ]);
      setTimeout(() => window.electronAPI?.viewClearHighlight(webSide), 1200);
    }
  };

  const removeMapping = (index: number) => {
    setMappings((prev) => prev.filter((_, i) => i !== index));
  };

  // 非新手模式（字段对比面板直接拾取）：ElementSelectBar 不渲染，无法驱动 onCanSaveChange /
  // mappingSaveTriggerRef，因此在此根据两侧拾取状态计算 canSaveMapping 并挂载保存触发器，
  // 确保"确定映射"按钮及 Enter 快捷键在映射完成后可用。
  useEffect(() => {
    if (settings.beginner_mode !== false) return; // 新手模式由 ElementSelectBar 自行驱动
    const canSave = Boolean(rightPicked && leftPicked);
    setCanSaveMapping(canSave);
    if (canSave && rightPicked) {
      mappingSaveTriggerRef.current = () => {
        saveMapping({
          right_selector: rightPicked.selector,
          right_label: rightPicked.label || rightPicked.selector,
          left_source: leftPicked?.tag === "excel-cell" ? "excel"
            : leftPicked?.tag === "doc-extract" ? "passport"
            : "database",
          left_field: leftPicked?.selector || "",
          verify_method: undefined,
          web_side: rightPickedSideRef.current,
        });
      };
    } else {
      mappingSaveTriggerRef.current = null;
    }
    return () => {
      mappingSaveTriggerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.beginner_mode, rightPicked, leftPicked]);

  // 删除提取元素步骤：根据 kind 和 id 路由到对应的数据源
  const removeExtractStep = useCallback((id: string, kind: "doc" | "custom" | "widget") => {
    if (kind === "widget") {
      // 控件：id 格式为 widget-${right_selector}，需删除 mapping 和关联的 pickedMark
      const rightSelector = id.replace(/^widget-/, "");
      setMappings((prev) => prev.filter((m) => m.right_selector !== rightSelector));
      const mark = pickedMarksRef.current.find((mk) => mk.selector === rightSelector && mk.widget);
      if (mark) removePickedMark(mark.id);
      return;
    }
    // doc: 文件提取步骤/文件处理记录（pickedMark）/ 文件字段（customTextEntry）
    // custom: 自定义文本（customTextEntry）
    // 先尝试删除 pickedMark（文件提取/文件处理步骤 id 来自 mark.id）
    const mark = pickedMarksRef.current.find((mk) => mk.id === id && (mk.docExtract || mk.fileOp));
    if (mark) {
      removePickedMark(id);
      return;
    }
    // 否则按 customTextEntry 删除
    removeCustomTextEntry(id);
  }, [removePickedMark, removeCustomTextEntry]);

  // ============ 控件提取模式（点击展开型控件：选项 / 日历） ============
  // 一步到位：直接启动选项控件拾取（与绿色按钮等效），无需先开分配再点击
  const toggleWidgetExtract = useCallback(() => {
    // toggle：已在控件提取模式 → 退出；否则直接启动拾取
    if (widgetExtractModeRef.current) {
      exitAllSetupModes();
      return;
    }
    startWidgetPick("option");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  toggleWidgetExtractRef.current = toggleWidgetExtract;

  /**
   * 将控件草稿提交到 mappings 列表（使其出现在「已保存控件」中）。
   * @param createMark 是否同步创建 pickedMark（供 LOOP 执行）——绑定时为 true，未绑定时为 false（绑定时再补建）
   */
  const commitWidgetDraft = useCallback((draft: WidgetDef, binding: WidgetBinding, opts: { createMark: boolean }) => {
    const stepType = currentLoopStepTypeRef.current;
    const isEntry = stepType === "entry";
    const isExcelSource = binding.leftSource === "excel";
    const isManualSource = binding.leftSource === "manual";
    const isPassportSource = binding.leftSource === "passport";
    const leftWebSelector = (!isExcelSource && !isManualSource && !isPassportSource) ? binding.leftField : undefined;
    const sourceLabel = isExcelSource ? "Excel" : isManualSource ? "固定值" : isPassportSource ? "护照提取" : "左网页";
    const leftFieldTrimmed = binding.leftField.trim();

    // 1. 写入 mappings（无论是否有绑定都保存，以便在卡片上继续配置）
    setMappings((prev) => [
      ...prev.filter((x) => x.right_selector !== draft.triggerSelector),
      {
        right_selector: draft.triggerSelector,
        right_label: draft.triggerLabel || draft.triggerSelector,
        right_input_type: "widget",
        left_source: binding.leftSource,
        left_field: leftFieldTrimmed,
        left_record_key: binding.leftLabel || null,
        verify_method: "smart" as const,
        widget: draft,
      },
    ]);

    // 2. 仅当有绑定且正在添加步骤模式时，才创建 pickedMark（无绑定时不创建，避免 LOOP 执行时空值报错）
    if (opts.createMark && leftFieldTrimmed && addingStepModeRef.current) {
      const wgSide = draft.side || "right";
      // 日历控件：先记录一个「打开日历」点击步骤（LOOP 时先真实点开日历，设值步骤检测到已打开则跳过重复点击）
      if (draft.kind === "calendar") {
        addPickedMark({
          side: wgSide,
          source: "web",
          selector: draft.triggerSelector,
          label: `点击 · 打开日历「${draft.triggerLabel || draft.triggerSelector}」`,
          value: "",
          workflow: stepType || "review",
          action: "click",
          rect: undefined,
          tag: "",
          type: "",
        });
      }
      addPickedMark({
        side: wgSide,
        source: isExcelSource ? "excel" : isPassportSource ? "passport" : "web",
        selector: draft.triggerSelector,
        label: `${isEntry ? "录入" : "审查"} · ${draft.triggerLabel || draft.triggerSelector} ← ${sourceLabel}「${isManualSource ? binding.leftField : leftFieldTrimmed}」`,
        value: isManualSource ? binding.leftField : "",
        workflow: stepType || "review",
        action: isEntry ? "input" : "pick",
        rect: undefined,
        tag: "",
        type: "",
        inputTarget: isEntry ? draft.triggerSelector : undefined,
        inputTargetLabel: isEntry ? (draft.triggerLabel || draft.triggerSelector) : undefined,
        variableField: isEntry && (isExcelSource || isPassportSource) ? leftFieldTrimmed : undefined,
        excelField: isExcelSource ? leftFieldTrimmed : undefined,
        sourceSelector: isEntry ? leftWebSelector : undefined,
        widget: draft,
      });
      rlog(`[commitWidgetDraft] 添加${stepType}步骤(控件): ${draft.triggerSelector} ← ${sourceLabel}(${leftFieldTrimmed})`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 开始拾取控件触发框（左右两侧网页均可），不 toggle —— 始终启动新一轮拾取 */
  const startWidgetPick = useCallback((kind: "option" | "calendar") => {
    // 若日历引导式拾取进行中，先取消并丢弃不完整 draft（引导未完成不应保存）
    const wasInSplitView = docExtractSplitViewRef.current;
    if (wasInSplitView) {
      // 从「文件处理+提取元素」分屏中添加控件：保持分屏，让控件在提取元素面板内分栏出现
      preserveSplitViewRef.current = true;
    }
    if (calPickStepIdxRef.current !== null) {
      exitAllSetupModes();
      setCalPickStepIdx(null);
      setWidgetRolePickingKey(null);
      setCalDayCellPicks([]);
      window.electronAPI?.viewSetMarqueeMode?.("right", false);
      window.electronAPI?.viewSetMarqueeMode?.("left", false);
      setWidgetDraft(null);
      setWidgetDraftBinding({ leftSource: "excel", leftField: "" });
    } else {
      // 如果有未保存的草稿，先自动保存（避免添加新控件时丢失前一个）
      const existingDraft = widgetDraftRef.current;
      exitAllSetupModes();
      if (existingDraft) {
        commitWidgetDraft(existingDraft, widgetDraftBindingRef.current, { createMark: !!widgetDraftBindingRef.current.leftField.trim() });
      }
      setWidgetDraft(null);
      setWidgetDraftBinding({ leftSource: "excel", leftField: "" });
    }
    // 分屏模式下恢复分屏状态（exitAllSetupModes 会清除 addingDocExtractMode，但我们要保持文件处理面板可见）
    if (wasInSplitView) {
      setDocExtractSplitView(true);
    }
    // 停止当前拾取（重新开始）
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    setWidgetSnapshotError(null);
    setWidgetPickKind(kind);
    // 清理手动面板点选兜底状态（新一轮提取）
    setCalPanelPickFailed(false);
    setCalPanelPickMode("idle");
    setPanelPickKind(null);
    calFailTriggerRef.current = null;
    // 切换到网页视图以确保用户可以看到光标
    setLeftViewMode("web");
    setTimeout(() => {
      window.electronAPI?.viewStartPicking("left").catch(() => {});
      window.electronAPI?.viewStartPicking("right").catch(() => {});
    }, 100);
    // 确保提取元素面板展开、widget TAB 在 FIFO 顺序中
    requestExtractTab("widget");
    setWidgetExtractMode(true);
    // 分屏模式下自动触发提取元素面板内部左右分栏（左侧文件字段，右侧控件提取）
    if (wasInSplitView) {
      setSplitWidgetRequest(Date.now());
      // 重置分屏保持标记：若 addingDocExtractMode 未发生变化（已经是 false），
      // 监听 addingDocExtractMode 的 useEffect 不会触发；用 setTimeout 确保
      // 在该 effect 执行之后再清除标记，避免误重置分屏
      setTimeout(() => { preserveSplitViewRef.current = false; }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exitAllSetupModes]);

  const cancelWidgetPick = useCallback(() => {
    setWidgetPickKind(null);
    setWidgetLeftPickingKey(null);
    setWidgetPassportPickingKey(null);
    setCalPanelPickMode("idle");
    setCalPanelPickFailed(false);
    setPanelPickKind(null);
    calFailTriggerRef.current = null;
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
  }, []);
  cancelWidgetPickRef.current = cancelWidgetPick;

  /** 拾取到触发框后：执行快照脚本（点击展开 → 识别面板结构 → 关闭） */
  const runWidgetSnapshot = useCallback(async (triggerSelector: string, triggerLabel: string, kind: "option" | "calendar", side: "left" | "right" = "right") => {
    if (!window.electronAPI) return;
    setWidgetSnapshotBusy(true);
    setWidgetSnapshotError(null);
    try {
      let res: WidgetSnapshotResult | null = null;
      if (kind === "option") {
        // 选项控件：先尝试下拉展开模式，失败则尝试 inline 直接选项组模式
        res = (await window.electronAPI.viewExecuteJS(side, buildWidgetSnapshotScript(triggerSelector, kind))) as WidgetSnapshotResult | null;
        if (!res?.ok) {
          // 下拉模式失败，尝试 inline 模式（直接在页面上的选项组，如男/女按钮）
          const inlineRes = (await window.electronAPI.viewExecuteJS(side, buildInlineOptionSnapshotScript(triggerSelector))) as (WidgetSnapshotResult & { inline?: boolean }) | null;
          if (inlineRes?.ok) {
            res = inlineRes;
          }
        }
      } else {
        res = (await window.electronAPI.viewExecuteJS(side, buildWidgetSnapshotScript(triggerSelector, kind))) as WidgetSnapshotResult | null;
      }
      if (res && res.ok) {
        const isInline = (res as { inline?: boolean }).inline;
        // 防护：若快照完成时仍有旧草稿（理论上 startWidgetPick 已经提交过），先提交旧草稿再替换
        const oldDraft = widgetDraftRef.current;
        if (oldDraft && oldDraft.triggerSelector !== triggerSelector) {
          commitWidgetDraft(oldDraft, widgetDraftBindingRef.current, { createMark: !!widgetDraftBindingRef.current.leftField.trim() });
          setWidgetDraftBinding({ leftSource: "excel", leftField: "" });
        }
        // 日历控件：引导式手动拾取各按钮位置（snapshot 已打开面板并保持，不自动识别、不套用模板）
        const calendarData = kind === "calendar" ? (res.calendar || {}) : undefined;
        const newWgId = `wg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setWidgetDraft({
          id: newWgId,
          kind,
          side,
          inline: isInline,
          triggerSelector,
          triggerLabel,
          panelSelector: res.panelSelector,
          options: kind === "option" ? res.options || [] : undefined,
          calendar: calendarData,
          createdAt: Date.now(),
        });
        // 自动滚动到新添加的控件 TAB
        setTimeout(() => {
          requestExtractTab("widget", `widget:draft:${newWgId}`);
        }, 150);
        // 日历控件：启动引导式拾取第 0 步（面板已打开，进入拾取模式让用户标注第一个按钮）
        if (kind === "calendar") {
          setCalPickStepIdx(0);
          setWidgetRolePickingKey(`draft:${CALENDAR_GUIDE_STEPS[0].role}`);
          setTimeout(() => {
            window.electronAPI?.viewStartPicking(side).catch(() => {});
          }, 300);
        }
        // 快照成功：停止另一侧的拾取
        const otherSide = side === "left" ? "right" : "left";
        window.electronAPI?.viewStopPicking(otherSide).catch(() => {});
        // 清掉手动面板点选兜底状态
        setCalPanelPickFailed(false);
        setCalPanelPickMode("idle");
        setPanelPickKind(null);
        calFailTriggerRef.current = null;
      } else {
        const reason = res?.reason || "unknown";
        setWidgetSnapshotError(WIDGET_SNAPSHOT_REASONS[reason] || `快照失败：${reason}`);
        // 面板检测失败兜底：日历 panel_not_found / 选项控件 panel_not_found|options_empty
        // → 记录触发框，允许用户手动点开面板后点选其中的元素（覆盖程序化点击未展开 / 面板无 popup 特征的场景）
        const enableFallback =
          (kind === "calendar" && reason === "panel_not_found") ||
          (kind === "option" && (reason === "panel_not_found" || reason === "options_empty"));
        if (enableFallback) {
          calFailTriggerRef.current = { selector: triggerSelector, label: triggerLabel, kind, side };
          setPanelPickKind(kind);
          setCalPanelPickFailed(true);
          setCalPanelPickMode("await-open");
        } else {
          setCalPanelPickFailed(false);
          setCalPanelPickMode("idle");
          setPanelPickKind(null);
          calFailTriggerRef.current = null;
        }
      }
    } catch (e) {
      console.warn("[widget] snapshot failed", e);
      setWidgetSnapshotError("快照脚本执行失败，请重试");
    } finally {
      setWidgetSnapshotBusy(false);
    }
  }, []);

  /** 请求重选日历角色：先确保面板打开（已开则不重复点击，避免被点关），再进入拾取 */
  const pickWidgetRole = useCallback((key: string, role: CalendarRole) => {
    const widget = key === "draft"
      ? widgetDraftRef.current
      : mappings.find((m) => m.right_selector === key.replace(/^saved:/, ""))?.widget;
    if (!widget) return;
    const wgSide = widget.side || "right";
    // 先执行 ensure-open（此时拾取器未激活，脚本里的程序化点击不会被拦截），完成后再设置拾取 key 激活拾取
    void (async () => {
      try {
        await window.electronAPI?.viewExecuteJS(wgSide, buildWidgetEnsureOpenScript(widget.triggerSelector, widget.panelSelector));
      } catch { /* ignore */ }
      setWidgetRolePickingKey(`${key}:${role}`);
      setTimeout(() => {
        if (widgetRolePickingKeyRef.current) {
          window.electronAPI?.viewStartPicking(wgSide).catch(() => {});
        }
      }, 250);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappings]);

  /** 引导式拾取：推进到下一步（确保面板打开→设置下一步角色→进入拾取） */
  const advanceCalendarGuide = useCallback(async (currentIdx: number) => {
    const widget = widgetDraftRef.current;
    const wgSide = widget?.side || "right";
    // 离开日格子步骤时关闭框选模式
    if (CALENDAR_GUIDE_STEPS[currentIdx]?.role === "dayCell") {
      window.electronAPI?.viewSetMarqueeMode?.(wgSide, false);
    }
    const nextIdx = currentIdx + 1;
    if (nextIdx >= CALENDAR_GUIDE_STEPS.length) {
      // 引导结束：面板保持打开供镜像测试
      setCalPickStepIdx(null);
      setWidgetRolePickingKey(null);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      // 明确完成反馈：引导条消失后用户能在草稿卡片看到下一步指引
      setWidgetTestResults((prev) => ({
        ...prev,
        draft: { ok: true, message: "✓ 标注完成！点下方模拟面板的翻页/日期测试与网页联动，确认无误后绑定左侧来源并保存" },
      }));
      return;
    }
    const nextRole = CALENDAR_GUIDE_STEPS[nextIdx].role;
    // 进入日格子步骤：清空多选累积，重新开始点选
    if (nextRole === "dayCell") setCalDayCellPicks([]);
    // 确保面板打开（上一步拾取点击可能触发关闭）
    if (widget) {
      try {
        await window.electronAPI?.viewExecuteJS(wgSide, buildWidgetEnsureOpenScript(widget.triggerSelector, widget.panelSelector));
      } catch { /* ignore */ }
    }
    setCalPickStepIdx(nextIdx);
    setWidgetRolePickingKey(`draft:${nextRole}`);
    setTimeout(() => {
      window.electronAPI?.viewStartPicking(wgSide).catch(() => {});
      // 日格子步骤：启用框选模式（拖拽矩形批量选中日格子）
      if (nextRole === "dayCell") {
        setTimeout(() => {
          window.electronAPI?.viewSetMarqueeMode?.(wgSide, true);
        }, 120);
      }
    }, 200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 引导式拾取：跳过当前可选步骤（仅 prevYear/nextYear 可跳过） */
  const skipCalendarGuideStep = useCallback(() => {
    const idx = calPickStepIdxRef.current;
    if (idx === null) return;
    if (CALENDAR_GUIDE_STEPS[idx].required) return; // 必选步不可跳过
    void advanceCalendarGuide(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 日格子多选完成：合并所有点选种子的泛化选择器（去重）→ 收集全部日格子坐标 → 推进引导 */
  const finishCalDayCellPicks = useCallback((extraPicks?: Array<{ text: string; selector: string }>) => {
    const idx = calPickStepIdxRef.current;
    if (idx === null) return;
    if (CALENDAR_GUIDE_STEPS[idx]?.role !== "dayCell") return;
    const basePicks = calDayCellPicksRef.current;
    const picks = extraPicks && extraPicks.length ? [...basePicks, ...extraPicks] : basePicks;
    if (!picks.length) {
      setWidgetSnapshotError(`请先在${widgetDraftRef.current?.side === "left" ? "左侧" : "右侧"}网页日历上点选至少一个日格子`);
      return;
    }
    const sels = Array.from(new Set(picks.map((p) => p.selector).filter(Boolean)));
    const combined = sels.join(", ");
    // 合并选择器写入草稿（覆盖不同结构/区域的日格子，执行时按文本匹配目标日）
    const applySel = (w: WidgetDef): WidgetDef => ({ ...w, calendar: { ...(w.calendar || {}), dayCellSelector: combined } });
    setWidgetDraft((prev) => (prev ? applySel(prev) : prev));
    const w0 = widgetDraftRef.current;
    if (w0) {
      const updated: WidgetDef = { ...w0, calendar: { ...(w0.calendar || {}), dayCellSelector: combined } };
      void collectDayCells(updated, "draft", sels);
    }
    setWidgetSnapshotError(null);
    setCalDayCellPicks([]);
    void advanceCalendarGuide(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 右侧框选批量拾取回调（日格子步骤专用）：批量写入 calDayCellPicks 后自动完成 */
  const onRightMultiPicked = useCallback((infos: PickedElementInfo[]) => {
    const idx = calPickStepIdxRef.current;
    if (idx === null || CALENDAR_GUIDE_STEPS[idx]?.role !== "dayCell") return;
    if (!infos.length) return;
    const existing = calDayCellPicksRef.current;
    const existingKeys = new Set(existing.map((p) => `${p.selector}|${p.text}`));
    const toAdd: Array<{ text: string; selector: string }> = [];
    for (const info of infos) {
      const sel = generalizeDayCellSelector(info.selector);
      const txt = (info.text || info.label || info.value || "").trim();
      const key = `${sel}|${txt}`;
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        toAdd.push({ text: txt, selector: sel });
      }
    }
    if (toAdd.length) {
      setCalDayCellPicks((prev) => [...prev, ...toAdd]);
    }
    // 框选属于明确的多选操作，用户松开鼠标时即完成本次框选 → 自动推进
    // 直接把 toAdd 作为 extraPicks 传入，避免依赖 React state/ref 更新时序
    finishCalDayCellPicks(toAdd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 右侧拾取警告（框选无结果等）→ 显示在 snapshotError 区域 */
  const onRightPickWarning = useCallback((message: string) => {
    setWidgetSnapshotError(message);
  }, []);

  /** 引导式拾取：取消（用户放弃标注，退出引导并关掉网页面板，保持网页干净） */
  const cancelCalendarGuide = useCallback(() => {
    const widget = widgetDraftRef.current;
    const wgSide = widget?.side || "right";
    setCalPickStepIdx(null);
    setWidgetRolePickingKey(null);
    setCalDayCellPicks([]);
    window.electronAPI?.viewSetMarqueeMode?.(wgSide, false);
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    if (widget) {
      window.electronAPI?.viewExecuteJS(wgSide, buildWidgetCloseScript(widget.triggerSelector, widget.panelSelector)).catch(() => {});
    }
  }, []);

  /** 手动面板点选：用户已手动点开日历，开始点选面板 */
  const armCalPanelPick = useCallback(() => {
    const wgSide = calFailTriggerRef.current?.side || "right";
    setCalPanelPickMode("picking");
    setWidgetSnapshotError(null);
    window.electronAPI?.viewStopPicking(wgSide === "left" ? "right" : "left").catch(() => {});
    window.electronAPI?.viewStartPicking(wgSide).catch(() => {});
  }, []);

  /** 手动面板点选：取消 */
  const cancelCalPanelPick = useCallback(() => {
    setCalPanelPickMode("idle");
    setCalPanelPickFailed(false);
    setPanelPickKind(null);
    calFailTriggerRef.current = null;
    setWidgetSnapshotError(null);
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
  }, []);

  /** 放弃草稿：若引导式拾取/手动面板点选仍在进行，一并退出，避免残留拾取态 */
  const discardWidgetDraft = useCallback(() => {
    setWidgetDraft(null);
    setWidgetDraftBinding({ leftSource: "excel", leftField: "" });
    if (calPickStepIdxRef.current !== null) {
      setCalPickStepIdx(null);
      setWidgetRolePickingKey(null);
      setCalDayCellPicks([]);
      window.electronAPI?.viewSetMarqueeMode?.("left", false);
      window.electronAPI?.viewSetMarqueeMode?.("right", false);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
    }
    if (calPanelPickModeRef.current !== "idle") {
      setCalPanelPickMode("idle");
      setCalPanelPickFailed(false);
      setPanelPickKind(null);
      calFailTriggerRef.current = null;
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
    }
  }, []);

  /** 手动面板点选：用户点选了面板内元素 → 按 kind 分支识别面板 → 建草稿（日历进引导式拾取，选项直接完成） */
  const handleCalPanelPicked = useCallback(async (seedSelector: string, side: "left" | "right" = "right") => {
    setCalPanelPickMode("idle");
    window.electronAPI?.viewStopPicking(side).catch(() => {});
    const otherSide = side === "left" ? "right" : "left";
    window.electronAPI?.viewStopPicking(otherSide).catch(() => {});
    const trig = calFailTriggerRef.current;
    if (!trig || !window.electronAPI) return;
    const wgSide = trig.side || side;
    try {
      if (trig.kind === "option") {
        // 选项控件：从种子向上找选项面板 → 收集选项 → 建草稿（无需引导式拾取）
        const res = (await window.electronAPI.viewExecuteJS(wgSide, buildOptionPanelFromSeedScript(seedSelector, trig.selector))) as { ok: boolean; panelSelector?: string; options?: Array<{ text: string; selector: string }>; reason?: string } | null;
        if (res?.ok && res.panelSelector && res.options && res.options.length > 0) {
          const newWgId = `wg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          setWidgetDraft({
            id: newWgId,
            kind: "option",
            side: wgSide,
            triggerSelector: trig.selector,
            triggerLabel: trig.label,
            panelSelector: res.panelSelector,
            options: res.options,
            createdAt: Date.now(),
          });
          calFailTriggerRef.current = null;
          setCalPanelPickFailed(false);
          setPanelPickKind(null);
          setWidgetSnapshotError(null);
          setTimeout(() => {
            requestExtractTab("widget", `widget:draft:${newWgId}`);
          }, 150);
        } else {
          // 点选无效：提示并允许重新点选
          setWidgetSnapshotError(WIDGET_SNAPSHOT_REASONS[res?.reason || ""] || "未识别到选项面板，请点选下拉面板内的选项");
          setCalPanelPickMode("picking");
          window.electronAPI?.viewStartPicking(wgSide).catch(() => {});
        }
        return;
      }
      // 日历控件：从种子向上找日历容器 → 建草稿并进入引导式拾取
      const res = (await window.electronAPI.viewExecuteJS(wgSide, buildCalendarPanelFromSeedScript(seedSelector))) as { ok: boolean; panelSelector?: string; upgraded?: boolean; reason?: string } | null;
      if (res?.ok && res.panelSelector) {
        const newWgId = `wg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setWidgetDraft({
          id: newWgId,
          kind: "calendar",
          side: wgSide,
          triggerSelector: trig.selector,
          triggerLabel: trig.label,
          panelSelector: res.panelSelector,
          calendar: {},
          createdAt: Date.now(),
        });
        calFailTriggerRef.current = null;
        setCalPanelPickFailed(false);
        setPanelPickKind(null);
        setWidgetSnapshotError(null);
        setTimeout(() => {
          requestExtractTab("widget", `widget:draft:${newWgId}`);
        }, 150);
        // 启动引导式拾取（面板已打开）
        setCalPickStepIdx(0);
        setWidgetRolePickingKey(`draft:${CALENDAR_GUIDE_STEPS[0].role}`);
        setTimeout(() => {
          window.electronAPI?.viewStartPicking(wgSide).catch(() => {});
        }, 300);
      } else {
        // 点选无效：提示并允许重新点选（not_calendar = 点的位置不属于任何日历结构）
        setWidgetSnapshotError(
          res?.reason === "not_calendar"
            ? "点的位置不是日历，请点日历面板上的日格子或年月区（若日历已收起，请先点开再点选）"
            : "未识别到日历结构，请点选日历面板内的元素（如日格子、年月区）"
        );
        setCalPanelPickMode("picking");
        window.electronAPI?.viewStartPicking(wgSide).catch(() => {});
      }
    } catch {
      setWidgetSnapshotError("面板识别失败，请重试");
      setCalPanelPickMode("picking");
      window.electronAPI?.viewStartPicking(wgSide).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 收集日格子坐标：用户拾取日格子种子（可多选）后，用公共选择器收集面板内所有日格子的文本+投影坐标 */
  const collectDayCells = useCallback(async (widget: WidgetDef, cardKey: string, dayCellSelectors?: string[]) => {
    const sels = dayCellSelectors && dayCellSelectors.length
      ? dayCellSelectors
      : (widget?.calendar?.dayCellSelector ? [widget.calendar.dayCellSelector] : []);
    if (!sels.length || !widget?.panelSelector || !window.electronAPI) return;
    const wgSide = widget.side || "right";
    try {
      const res = (await window.electronAPI.viewExecuteJS(wgSide, buildDayCellCollectScript(widget.panelSelector, sels))) as { ok: boolean; dayCells?: { text: string; dx: number; dy: number }[]; count?: number } | null;
      if (res?.ok && res.dayCells && res.dayCells.length > 0) {
        const dayCells = res.dayCells;
        if (cardKey === "draft") {
          setWidgetDraft((prev) => (prev ? { ...prev, calendar: { ...(prev.calendar || {}), dayCells } } : prev));
        } else {
          const rightSelector = cardKey.replace(/^saved:/, "");
          setMappings((prev) => prev.map((m) => (m.right_selector === rightSelector && m.widget ? { ...m, widget: { ...m.widget, calendar: { ...(m.widget.calendar || {}), dayCells } } } : m)));
          setPickedMarks((prev) => prev.map((mk) => (mk.selector === rightSelector && mk.widget ? { ...mk, widget: { ...mk.widget, calendar: { ...(mk.widget.calendar || {}), dayCells } } } : mk)));
        }
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 请求从左侧网页拾取来源元素 */
  const pickWidgetLeftWeb = useCallback((key: string) => {
    setWidgetLeftPickingKey(key);
    // 自动进入左右分栏：右侧保留控件面板，左侧显示字段卡片（可选）并可直接点击左侧网页取值，
    // 避免取值时把控件界面切走而需要手动点「分栏」
    setSplitWidgetRequest(Date.now());
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    window.electronAPI?.viewStartPicking("left").catch(() => {});
  }, []);

  /** 请求从「提取结果」面板拾取护照字段（光标可点选） */
  const pickWidgetPassportField = useCallback((key: string) => {
    setWidgetPassportPickingKey(key);
    // 确保文件处理面板可见（两栏分屏）
    setDocExtractSplitView(true);
    setBottomPanelOpen(true);
  }, []);

  /** 请求重选单个选项按钮（inline 选项用）：直接在右侧网页拾取对应按钮元素 */
  const pickWidgetOption = useCallback((key: string, optionIndex: number) => {
    const widget = key === "draft"
      ? widgetDraftRef.current
      : mappings.find((m) => m.right_selector === key.replace(/^saved:/, ""))?.widget;
    const wgSide = widget?.side || "right";
    const otherSide = wgSide === "left" ? "right" : "left";
    setWidgetOptionPickingKey(`${key}:option:${optionIndex}`);
    window.electronAPI?.viewStopPicking(otherSide).catch(() => {});
    window.electronAPI?.viewStartPicking(wgSide).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappings]);

  /** 保存草稿控件为字段映射（走 commitWidgetDraft，自动生成 LOOP 步骤 mark） */
  const saveWidgetDraft = useCallback(() => {
    const draft = widgetDraftRef.current;
    const binding = widgetDraftBindingRef.current;
    if (!draft || !binding.leftField.trim()) return;
    commitWidgetDraft(draft, binding, { createMark: true });
    setWidgetDraft(null);
    setWidgetDraftBinding({ leftSource: "excel", leftField: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 更新已保存控件（角色重选/选项别名） */
  const updateSavedWidget = useCallback((rightSelector: string, widget: WidgetDef) => {
    setMappings((prev) => prev.map((m) => (m.right_selector === rightSelector ? { ...m, widget } : m)));
    // 同步更新已生成的 pickedMark（LOOP 执行以 mark 为准）
    setPickedMarks((prev) => prev.map((mk) => (mk.selector === rightSelector && mk.widget ? { ...mk, widget } : mk)));
  }, []);

  /** 更新已保存控件的左侧绑定 */
  const updateSavedWidgetBinding = useCallback((rightSelector: string, binding: WidgetBinding) => {
    setMappings((prev) => prev.map((m) => (m.right_selector === rightSelector
      ? { ...m, left_source: binding.leftSource, left_field: binding.leftField, left_record_key: binding.leftLabel || null }
      : m)));
    // 同步 mark 的取值字段；若之前未绑定（无 mark）且现在绑定有效且在步骤模式，则补建 mark
    const leftFieldTrimmed = binding.leftField.trim();
    setPickedMarks((prev) => {
      const existing = prev.find((mk) => mk.selector === rightSelector && mk.widget);
      if (existing) {
        // 更新已有 mark
        return prev.map((mk) => {
          if (mk.selector !== rightSelector || !mk.widget) return mk;
          const isEntry = mk.action === "input";
          const isExcel = binding.leftSource === "excel";
          const isPassport = binding.leftSource === "passport";
          const isManual = binding.leftSource === "manual";
          return {
            ...mk,
            source: isExcel ? "excel" : isPassport ? "passport" : "web",
            excelField: isExcel ? binding.leftField : undefined,
            variableField: isEntry && (isExcel || isPassport) ? binding.leftField : undefined,
            sourceSelector: isEntry && !isExcel && !isPassport && !isManual ? binding.leftField : undefined,
            value: isManual ? binding.leftField : mk.value,
          };
        });
      }
      // 无已有 mark：若绑定有效且在步骤添加模式，补建一个
      if (leftFieldTrimmed && addingStepModeRef.current) {
        const mapping = mappingsRef.current.find((m) => m.right_selector === rightSelector);
        const w = mapping?.widget;
        if (w) {
          const stepType = currentLoopStepTypeRef.current;
          const isEntry = stepType === "entry";
          const isExcel = binding.leftSource === "excel";
          const isPassport = binding.leftSource === "passport";
          const isManual = binding.leftSource === "manual";
          const sourceLabel = isExcel ? "Excel" : isManual ? "固定值" : isPassport ? "护照提取" : "左网页";
          const leftWebSelector = (!isExcel && !isManual && !isPassport) ? binding.leftField : undefined;
          const order = prev.length + 1;
          const newMark: PickedMark = {
            id: `mk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            side: "right",
            source: isExcel ? "excel" : isPassport ? "passport" : "web",
            selector: rightSelector,
            label: `${isEntry ? "录入" : "审查"} · ${w.triggerLabel || rightSelector} ← ${sourceLabel}「${isManual ? binding.leftField : leftFieldTrimmed}」`,
            value: isManual ? binding.leftField : "",
            workflow: stepType || "review",
            action: isEntry ? "input" : "pick",
            rect: undefined,
            tag: "",
            type: "",
            order,
            createdAt: Date.now(),
            inputTarget: isEntry ? rightSelector : undefined,
            inputTargetLabel: isEntry ? (w.triggerLabel || rightSelector) : undefined,
            variableField: isEntry && (isExcel || isPassport) ? leftFieldTrimmed : undefined,
            excelField: isExcel ? leftFieldTrimmed : undefined,
            sourceSelector: isEntry ? leftWebSelector : undefined,
            widget: w,
          };
          rlog(`[updateSavedWidgetBinding] 补建控件步骤mark: ${rightSelector} ← ${sourceLabel}(${leftFieldTrimmed})`);
          // 日历控件：同时补建「打开日历」点击步骤（排在设值步骤前）
          if (w.kind === "calendar") {
            const openMark: PickedMark = {
              id: `mk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              side: "right",
              source: "web",
              selector: rightSelector,
              label: `点击 · 打开日历「${w.triggerLabel || rightSelector}」`,
              value: "",
              workflow: stepType || "review",
              action: "click",
              rect: undefined,
              tag: "",
              type: "",
              order,
              createdAt: Date.now(),
            };
            return [...prev, openMark, { ...newMark, order: order + 1 }];
          }
          return [...prev, newMark];
        }
      }
      return prev;
    });
  }, []);

  /** 删除已保存控件映射 */
  const removeSavedWidget = useCallback((rightSelector: string) => {
    setMappings((prev) => prev.filter((m) => m.right_selector !== rightSelector));
    setPickedMarks((prev) => {
      // 同选择器下：控件设值 mark + 自动补建的「打开日历」点击 mark 一并移除
      const filtered = prev.filter((mk) => !(mk.selector === rightSelector && (mk.widget || mk.label.startsWith("点击 · 打开日历"))));
      return filtered.map((m, i) => ({ ...m, order: i + 1 }));
    });
  }, []);

  /** 试跑：用当前卡片的左侧值在右侧网页真实演练一遍 */
  const testWidget = useCallback(async (testKey: string, widget: WidgetDef, binding: WidgetBinding) => {
    if (!window.electronAPI) return;
    setWidgetTestBusyKey(testKey);
    const wgSide = widget.side || "right";
    const setResult = (r: WidgetTestResult) => setWidgetTestResults((prev) => ({ ...prev, [testKey]: r }));
    try {
      // 1. 解析左侧值
      let value = "";
      if (binding.leftSource === "excel") {
        value = String(selected?.fields?.[binding.leftField] ?? "").trim();
      } else if (binding.leftSource === "passport") {
        const docFields = selected ? getRecordDocFields(selected.record_id) : {};
        value = String(selected?.passport_fields?.[binding.leftField] || docFields[binding.leftField] || "").trim();
      } else if (binding.leftSource === "manual") {
        value = binding.leftField.trim();
      } else {
        // database：从左侧网页实时读取
        const readScript = `
          ${DEEP_QUERY_HELPER}
          (function() {
            var el = null;
            try { el = __cinsideDeepQuery(${JSON.stringify(sanitizeSelector(binding.leftField))}); } catch(e) { el = null; }
            if (!el) return { ok: false, reason: 'not_found' };
            var val = '';
            try {
              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') val = el.value || '';
              else val = (el.textContent || el.innerText || '').trim();
            } catch(e) { val = el.textContent || ''; }
            return { ok: true, value: String(val || '').trim() };
          })();
        `;
        const r = (await window.electronAPI.viewExecuteJS("left", readScript)) as { ok: boolean; value?: string } | null;
        if (r?.ok && r.value) value = r.value.trim();
      }
      if (!value) {
        setResult({ ok: false, message: "左侧值为空：请先选中一张有数据的卡片，或检查绑定字段" });
        return;
      }
      // 2. 执行控件脚本
      if (widget.kind === "option") {
        let res: OptionSelectResult | null;
        if (widget.inline) {
          res = (await window.electronAPI.viewExecuteJS(wgSide, buildInlineOptionSelectScript(widget, value))) as OptionSelectResult | null;
        } else {
          res = (await window.electronAPI.viewExecuteJS(wgSide, buildOptionSelectScript(widget, value))) as OptionSelectResult | null;
        }
        if (res?.ok) {
          setResult({ ok: true, message: `已自动选择「${res.clickedText}」（左侧值：${value}）` });
        } else {
          const avail = res?.options?.length ? `；可选项：${res.options.slice(0, 6).join(" / ")}${res.options.length > 6 ? "…" : ""}` : "";
          setResult({ ok: false, message: `未匹配到「${value}」${avail}${widget.inline ? "" : "——可点击选项芯片标注别名"}` });
        }
      } else {
        const cands = parseDateCandidates(value);
        if (!cands.length) {
          setResult({ ok: false, message: `「${value}」不是可识别的日期（支持 2026/3/11、2026-03-11、2026年3月11日）` });
          return;
        }
        const [yy, mm, dd] = cands[0].split("-").map(Number);
        const res = (await window.electronAPI.viewExecuteJS(wgSide, buildCalendarSetScript(widget, yy, mm, dd))) as CalendarSetResult | null;
        if (res?.ok) {
          setResult({ ok: true, message: `已翻页并点选 ${cands[0]}${res.value ? `（框内显示：${res.value}）` : ""}` });
        } else {
          const reasonMap: Record<string, string> = {
            panel_not_open: "日历面板未展开",
            header_parse_fail: "年月显示读取失败，可用「重选」修正",
            nav_button_missing: "翻页按钮失效，可用「重选」修正",
            navigate_timeout: "翻页次数过多仍未到达目标年月",
            day_not_found: "目标日格子未找到，可用「重选」修正日格子",
          };
          setResult({ ok: false, message: `日历设定失败：${reasonMap[res?.reason || ""] || res?.reason || "未知"}` });
        }
      }
    } catch (e) {
      console.warn("[widget] test failed", e);
      setResult({ ok: false, message: "试跑脚本执行失败，请重试" });
    } finally {
      setWidgetTestBusyKey(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, getRecordDocFields]);

  /** 用户在「提取结果」面板点击了某个护照字段 → 完成控件绑定 */
  const resolveWidgetPassportField = useCallback((fieldKey: string) => {
    const key = widgetPassportPickingKeyRef.current;
    if (!key) return;
    setWidgetPassportPickingKey(null);
    const binding: WidgetBinding = {
      leftSource: "passport",
      leftField: fieldKey,
    };
    if (key === "draft") {
      setWidgetDraftBinding((prev) => ({ ...prev, ...binding }));
    } else {
      updateSavedWidgetBinding(key.replace(/^saved:/, ""), binding);
    }
    // 拾取完成后自动试跑
    setTimeout(() => {
      if (key === "draft" && widgetDraftRef.current) {
        testWidget("draft", widgetDraftRef.current, { ...widgetDraftBinding, ...binding });
      } else {
        const savedKey = key.replace(/^saved:/, "");
        const found = mappingsRef.current.find(m => m.right_selector === savedKey && m.widget);
        if (found?.widget) {
          testWidget(key, found.widget, binding);
        }
      }
    }, 200);
  }, [widgetDraftBinding, testWidget, updateSavedWidgetBinding]);

  /** 把控件绑定到「提取元素」面板中的自定义文本/文件字段条目（点击字段卡片取值） */
  const onWidgetPickExtractEntry = useCallback((entry: CustomTextEntry) => {
    const key = widgetLeftPickingKeyRef.current;
    if (!key) return;
    setWidgetLeftPickingKey(null);
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    const binding: WidgetBinding = {
      leftSource: "manual",
      leftField: entry.text,
      leftLabel: entry.name || entry.text.slice(0, 20),
    };
    if (key === "draft") {
      setWidgetDraftBinding((prev) => ({ ...prev, ...binding }));
    } else {
      updateSavedWidgetBinding(key.replace(/^saved:/, ""), binding);
    }
    // 拾取完成后自动试跑
    setTimeout(() => {
      if (key === "draft" && widgetDraftRef.current) {
        testWidget("draft", widgetDraftRef.current, { ...widgetDraftBindingRef.current, ...binding });
      } else {
        const savedKey = key.replace(/^saved:/, "");
        const found = mappingsRef.current.find(m => m.right_selector === savedKey && m.widget);
        if (found?.widget) {
          testWidget(key, found.widget, binding);
        }
      }
    }, 200);
  }, [updateSavedWidgetBinding, testWidget]);
  // 同步到 ref，供上方 content useMemos 中的 wrapper 使用
  onWidgetPickExtractEntryRef.current = onWidgetPickExtractEntry;

  /** 日历镜像操作：点击面板按钮 → 真实点网页对应按钮 → 刷新面板年月 */
  const handleCalendarMirrorClick = useCallback(async (mirrorKey: string, widget: WidgetDef, action: CalendarMirrorAction) => {
    if (!window.electronAPI) return;
    setWidgetCalendarBusyKey(mirrorKey);
    const wgSide = widget.side || "right";
    rlog(`[widgetMirror] 开始镜像操作, key=${mirrorKey}, action=${JSON.stringify(action)}, widget=${widget.triggerLabel || widget.triggerSelector}`);
    try {
      // 先执行 open 动作，确保面板已打开并读取当前年月
      const openRes = (await window.electronAPI.viewExecuteJS(wgSide, buildWidgetCalendarMirrorScript(widget, { type: "open" }))) as { ok: boolean; year?: number; month?: number; reason?: string } | null;
      if (openRes?.ok && typeof openRes.year === "number" && typeof openRes.month === "number") {
        const y = openRes.year as number;
        const m = openRes.month as number;
        rlog(`[widgetMirror] open 成功, 当前年月=${y}-${m}`);
        // 模拟面板按 JS 0 基月份渲染（new Date(y, m, 1) / monthNames[m]），脚本返回 1 基月份，存 0 基
        setWidgetCalendarState((prev) => ({ ...prev, [mirrorKey]: { year: y, month: m - 1 } }));
      } else {
        rlog(`[widgetMirror] open 失败, reason=${openRes?.reason || '未知'}`);
        // open 失败：给用户可见反馈（之前仅写日志，用户点了没反应）
        setWidgetTestResults((prev) => ({
          ...prev,
          [mirrorKey]: { ok: false, message: "网页日历未能展开：请先在网页手动点开日历再试；若反复失败，请重新提取该控件" },
        }));
        return;
      }

      // 如果用户点击的是 open 动作，直接返回
      if (action.type === "open") {
        return;
      }

      // 执行用户点击的动作（翻页/点日期）
      const res = (await window.electronAPI.viewExecuteJS(wgSide, buildWidgetCalendarMirrorScript(widget, action))) as { ok: boolean; year?: number; month?: number; reason?: string } | null;
      if (res?.ok && typeof res.year === "number" && typeof res.month === "number") {
        const y = res.year as number;
        const m = res.month as number;
        rlog(`[widgetMirror] 动作成功, 结果年月=${y}-${m}, action=${JSON.stringify(action)}`);
        // 存 0 基月份（同上）
        setWidgetCalendarState((prev) => ({ ...prev, [mirrorKey]: { year: y, month: m - 1 } }));
        if (action.type === "day") {
          setWidgetTestResults((prev) => ({
            ...prev,
            [mirrorKey]: { ok: true, message: `已在网页点选 ${y}年${m}月${action.day}日` },
          }));
        }
      } else {
        rlog(`[widgetMirror] 动作失败, reason=${res?.reason || '未知'}, action=${JSON.stringify(action)}`);
        // 失败不更新状态，但给用户可见反馈和下一步指引
        const reasonMap: Record<string, string> = {
          nav_button_missing: "翻页按钮点不到：请点该按钮的「重选」在网页日历上重新标注",
          day_not_found: "该日格子点不到：请「重选」日格子（点任意一个日格子即可自动推导全部）",
          header_parse_fail: "年月读取失败：请「重选」年月显示区",
          panel_not_open: "网页日历未展开：请在网页手动点开后重试",
          trigger_not_found: "网页上的日历框框找不到了：请重新提取该控件",
        };
        setWidgetTestResults((prev) => ({
          ...prev,
          [mirrorKey]: { ok: false, message: reasonMap[res?.reason || ""] || `镜像操作失败（${res?.reason || "未知"}）：可尝试重新标注对应按钮` },
        }));
      }
    } catch (e) {
      rlog(`[widgetMirror] 异常: ${e instanceof Error ? e.message : String(e)}`);
      console.warn("[widgetMirror] action failed", e);
    } finally {
      setWidgetCalendarBusyKey(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============ 面板脱离 ============
  const detachPanel = async (side: "left" | "bottom" | "browser-left" | "browser-right" | "browser-excel") => {
    if (!window.electronAPI) return;
    try {
      const ok = await window.electronAPI.panelDetach(side);
      if (ok) {
        if (side === "left") setLeftDetached(true);
        else if (side === "bottom") setBottomDetached(true);
        else if (side === "browser-left") {
          setBrowserLeftDetached(true);
          // 脱离后主窗口切到 Excel 视图，避免左侧空着
          if (!excelDetached) setLeftViewMode("excel");
        }
        else if (side === "browser-right") setBrowserRightDetached(true);
        else if (side === "browser-excel") {
          setExcelDetached(true);
          // 脱离后主窗口切回网页视图，避免左侧空着
          if (!browserLeftDetached) setLeftViewMode("web");
        }
      }
    } catch (e) {
      console.warn("panelDetach failed", e);
    }
  };

  // 脱离窗口关闭时，恢复主窗口对应面板的渲染
  useEffect(() => {
    if (!window.electronAPI) return;
    const off = window.electronAPI.onPanelReattached((side) => {
      if (side === "left") setLeftDetached(false);
      else if (side === "bottom") setBottomDetached(false);
      else if (side === "browser-left") setBrowserLeftDetached(false);
      else if (side === "browser-right") setBrowserRightDetached(false);
      else if (side === "browser-excel") setExcelDetached(false);
    });
    return off;
  }, []);

  // 监听弹窗（window.open 拦截）创建/关闭
  useEffect(() => {
    if (!window.electronAPI) return;
    const offCreated = window.electronAPI.onPopupCreated((data) => {
      setPopupSide(data.parentSide);
    });
    const offClosed = window.electronAPI.onPopupClosed(() => {
      setPopupSide(null);
    });
    return () => {
      offCreated();
      offClosed();
    };
  }, []);

  // 接收脱离窗口发来的操作
  // 注意：onExcelPicked 等通过 ref 调用，避免闭包陷阱（脱离窗口的 IPC handler
  // 只在挂载时注册一次，直接调用会捕获首次渲染的 stale state）
  const onExcelPickedRef = useRef<(info: ExcelPickedField) => void>(() => {});
  const onLeftPickedRef = useRef<(info: PickedElementInfo) => void>(() => {});
  const onRightPickedRef = useRef<(info: PickedElementInfo) => void>(() => {});
  useEffect(() => {
    if (!window.electronAPI) return;
    const off = window.electronAPI.onPanelAction((action, payload) => {
      switch (action) {
        case "select-record":
          if (typeof payload === "string") handleSelectCard(payload);
          break;
        case "refresh-records":
          refreshRecords();
          break;
        case "clear-records":
          clearRecords();
          break;
        case "remove-mapping":
          if (typeof payload === "number") removeMapping(payload);
          break;
        case "remove-picked-mark":
          if (typeof payload === "string") removePickedMark(payload);
          break;
        case "clear-picked-marks":
          clearPickedMarks();
          window.electronAPI?.viewClearHighlight("left").catch(() => {});
          window.electronAPI?.viewClearHighlight("right").catch(() => {});
          if (popupSide === "left") window.electronAPI?.popupClearHighlight("left").catch(() => {});
          if (popupSide === "right") window.electronAPI?.popupClearHighlight("right").catch(() => {});
          break;
        case "replay-picked-marks":
          replayAll();
          break;
        case "stop-replay-picked-marks":
          stopReplay();
          break;
        case "set-url": {
          const p = payload as { side?: string; url?: string } | null;
          if (p && p.side && typeof p.url === "string") {
            if (p.side === "left") setLeftUrl(p.url);
            else if (p.side === "right") setRightUrl(p.url);
          }
          break;
        }
        case "excel-picked-field": {
          // 从脱离的 Excel 窗口收到拾取字段：通过 ref 调用最新版本
          const p = payload as ExcelPickedField | null;
          if (p && p.field) {
            onExcelPickedRef.current(p);
          }
          break;
        }
        case "excel-select-column": {
          const field = typeof payload === "string" ? payload : null;
          setSelectedExcelColumn(field);
          break;
        }
        case "detached-element-picked": {
          // 从脱离的浏览器窗口收到拾取元素：转发给对应的拾取回调
          const p = payload as { side?: string; info?: PickedElementInfo } | null;
          if (p && p.info) {
            if (p.side === "left") onLeftPickedRef.current?.(p.info);
            else if (p.side === "right") onRightPickedRef.current?.(p.info);
          }
          break;
        }
        case "teaching-advance":
          advanceToReviewPhase();
          break;
        case "teaching-finish":
          finishTeachingAndRunBatch();
          break;
        case "teaching-abort":
          abortTeaching();
          break;
        case "save-skill":
          setSaveSkillRunAfter(false);
          setShowSaveSkill(true);
          break;
        case "quick-save-loop":
          handleQuickSaveLoop();
          break;
        case "direct-run":
          finishTeachingAndRunBatch();
          break;
        case "refresh-workspace":
          refreshWorkspace();
          break;
        case "teaching-back":
          goBackTeachingPhase();
          break;
        // ===== ElementSelectBar 回调（由脱离的下面板转发） =====
        case "pick-left-from-web":
          pickLeftFromWeb();
          break;
        case "pick-left-from-excel":
          pickLeftFromExcel();
          break;
        case "reset-round":
          resetMappingRound();
          break;
        case "save-mapping":
          saveMapping(payload as FieldMapping);
          break;
        case "start-bind-inputs":
          startBindBothInputs();
          break;
        case "set-right-bind-column":
          setRightBindColumn((payload as string | null) ?? null);
          break;
        case "exit-bind-inputs":
          exitBindInputs();
          break;
        case "start-confirm-person":
          startConfirmPerson();
          break;
        case "start-add-review-steps":
          startAddingReviewSteps();
          break;
        case "start-add-entry-steps":
          startAddingEntrySteps();
          break;
        case "exit-adding-step-mode":
          exitAddingStepMode();
          break;
        case "start-add-pre-click":
          startAddClickStep("pre");
          break;
        case "start-add-process-click":
          startAddClickStep("mid");
          break;
        case "start-add-post-click":
          startAddClickStep("post");
          break;
        case "exit-add-click-mode":
          exitAddClickMode();
          break;
        case "swap-side":
          setTeachingPanelSide((s) => (s === "left" ? "right" : "left"));
          break;
        case "undo":
          undoLastStep();
          break;
        case "start-add-doc-extract":
          startAddDocExtract();
          break;
        case "exit-add-doc-extract-mode":
          exitAddDocExtractMode();
          break;
        case "doc-file-extract":
          requestDocFileExtract();
          break;
        case "exit-select-mode":
          exitSelectMode();
          break;
        case "save-to-batch":
          handleSaveToBatch();
          break;
        case "request-state": {
          // 分离窗口 mount 后主动请求当前状态（解决广播早于监听注册的时序竞态）
          const reqSide = typeof payload === "string" ? payload : "";
          if (reqSide === "browser-left" && browserLeftDetached) {
            const picking = (selectMode && pickTarget === "left") || avatarMode || pendingAction === "click" || teachingPhase !== "idle";
            window.electronAPI?.panelBroadcastState("browser-left", { url: leftUrl, picking });
          } else if (reqSide === "browser-right" && browserRightDetached) {
            const picking = (selectMode && pickTarget === "right") || pendingAction === "click" || teachingPhase !== "idle";
            window.electronAPI?.panelBroadcastState("browser-right", { url: rightUrl, picking });
          } else if (reqSide === "bottom" && bottomDetached) {
            window.electronAPI?.panelBroadcastState("bottom", {
              record: selected,
              mappings,
              comparisons: result?.comparisons || [],
              resultPresent: !!result,
              report,
              loopReports,
              steps,
              shots,
              running,
              pickedMarks,
              replaying,
              replayCursor,
              teachingPhase,
              appMode,
              selectMode,
              hasSearchSteps: pickedMarks.some((m) => m.action === "input" && !!m.variableField),
              hasSubmitStep: pickedMarks.some((m) => m.action === "click" && m.workflow === "entry"),
              dataSourceCount: pickedMarks.filter((m) => m.workflow === "data-source").length,
              reviewCount: pickedMarks.filter((m) => m.workflow === "review").length,
              entryCount: pickedMarks.filter((m) => m.workflow === "entry").length,
              // ElementSelectBar 所需状态
              pickTarget,
              rightPicked,
              leftPicked,
              excelFields: selected ? Object.keys(selected.fields) : [],
              mappingCount: mappings.length,
              pendingAction,
              selectedExcelColumn,
              rightBindColumn,
              bindInputSide,
              nextClickLabel,
              addingStepMode,
              addingClickMode,
              addingClickPhase,
              addingDocExtractMode,
              bindStepCount: pickedMarks.filter((m) => m.action === "input" || m.action === "click").length,
              preClickCount: pickedMarks.filter((m) => m.action === "click" && m.clickPhase === "pre").length,
              processClickCount: pickedMarks.filter((m) => m.action === "click" && m.clickPhase === "mid").length,
              postClickCount: pickedMarks.filter((m) => m.action === "click" && m.clickPhase === "post").length,
              docExtractStepCount: pickedMarks.filter((m) => m.docExtract).length,
              hasBoundInputs: pickedMarks.some((m) => m.action === "input" && !!m.variableField),
              hasConfirmClick: pickedMarks.some((m) => m.action === "click" && m.label.startsWith("确认人物")),
              cardsGenerated,
              hasCheckedBatch: checkedIds.size > 0,
              beginnerMode: settings.beginner_mode !== false,
            });
          }
          break;
        }
      }
    });
    return off;
  }, [refreshRecords, clearRecords, removeMapping, removePickedMark, clearPickedMarks, replayAll, stopReplay, advanceToReviewPhase, abortTeaching, goBackTeachingPhase, browserLeftDetached, browserRightDetached, bottomDetached, leftUrl, rightUrl, selectMode, pickTarget, avatarMode, pendingAction, teachingPhase, selected, mappings, result, report, loopReports, steps, shots, running, pickedMarks, replaying, replayCursor, rightPicked, leftPicked, selectedExcelColumn, bindInputSide, nextClickLabel, addingStepMode, addingClickMode, addingDocExtractMode, cardsGenerated, pickLeftFromWeb, pickLeftFromExcel, resetMappingRound, saveMapping, startBindBothInputs, exitBindInputs, startConfirmPerson, startAddingReviewSteps, startAddingEntrySteps, exitAddingStepMode, handleSelectCard, startAddClickStep, exitAddClickMode, undoLastStep, startAddDocExtract, exitAddDocExtractMode, requestDocFileExtract, exitSelectMode, setShowSaveSkill, setSaveSkillRunAfter, handleQuickSaveLoop, handleSaveToBatch]);

  // Excel 拾取：把字段包装成 PickedElementInfo，并打 tag 区分来源
  const onExcelPicked = (info: ExcelPickedField) => {
    // 用 ref 读取最新状态，避免 React 批量更新/闭包延迟导致 pendingAction 还是旧值
    const currentPendingAction = pendingActionRef.current;
    const currentInputTarget = inputTargetRef.current;
    console.log("[onExcelPicked] 收到 Excel 点击", { info, currentPendingAction, currentInputTarget });
    // 提取元素条目绑定态：点击的列绑定到该条目（LOOP 时按每张卡片该列取值）
    if (excelBindEntryIdRef.current) {
      const id = excelBindEntryIdRef.current;
      setCustomTextEntries((prev) => prev.map((e) => (e.id === id ? { ...e, excelField: info.field } : e)));
      setExcelBindEntryId(null);
      excelBindEntryIdRef.current = null;
      setSuccessToast(`已绑定 Excel 列「${info.field}」：跑 LOOP 时每张卡片取该行该列的值`);
      return;
    }
    // pendingAction=input：记录待填入的值，等用户按 Enter 时才真正填入网页框
    // 用户规定流程：S → 先点 Excel/网页取值 → 再点右侧输入框作为目标 → Enter 完成
    if (currentPendingAction === "input") {
      const value = info.value || "";
      // 记录待填入的值和 Excel 字段名，不立即执行（同时同步 ref，避免按 Enter 时读到旧值）
      setPendingInputValue(value);
      pendingInputValueRef.current = value;
      setPendingInputField(info.field);
      pendingInputFieldRef.current = info.field;
      // 源已确定，切换到右侧目标拾取
      setPickTarget("right");
      window.electronAPI?.viewStopPicking("left");
      window.electronAPI?.viewStartPicking("right");
      // 不再用顶部 Toast，靠页面浮标反馈
      return;
    }
    setLeftPicked({
      selector: info.field,
      label: info.field,
      value: info.value,
      tag: "excel-cell",
      type: "text",
      text: info.value,
      rect: { x: 0, y: 0, width: 0, height: 0 },
    });
    // 录入流来源字段：从 Excel 点击字段时捕获其值，供之后点击右侧输入框时复制填入
    if (info.value) {
      sourceFieldValueRef.current = String(info.value).trim();
      sourceFieldLabelRef.current = info.field || "";
    }
    // 录入模式（先左后右）：Excel 来源确定后激活右侧拾取光标；审查模式（先右后左）：等待保存
    const isEntry = addingStepModeRef.current === "entry" || currentLoopStepTypeRef.current === "entry";
    setPickTarget(isEntry ? "right" : null);
    if (isEntry) {
      // 激活右侧网页拾取光标
      window.electronAPI?.viewStartPicking("right");
    }
    // addingStepMode 下不添加 pick mark，保存映射时才添加 input mark
    if (addingStepModeRef.current) return;
    // 记录拾取标记（Excel 单元格）
    addPickedMark({
      side: "left",
      source: "excel",
      selector: info.field,
      label: info.field,
      value: info.value,
      workflow: teachingPhase === "data-source" ? "data-source" : teachingPhase === "entry" ? "entry" : "review",
      action: "pick",
      recordId: selected?.record_id,
      excelField: info.field,
      excelRecordId: info.record_id,
    });
  };
  // 始终把最新版本的 onExcelPicked 写入 ref，供脱离 Excel 窗口的 IPC handler 调用
  onExcelPickedRef.current = onExcelPicked;

  // 右侧 Excel 拾取：右侧 Excel 作为数据源（左网页=学校系统，为比对目标）。
  // 与 onExcelPicked 对称：Excel 字段始终占 leftPicked 槽位（来源），区别仅在配对目标来自左网页。
  const onRightExcelPicked = (info: ExcelPickedField) => {
    const currentPendingAction = pendingActionRef.current;
    console.log("[onRightExcelPicked] 收到右侧 Excel 点击", { info, currentPendingAction });
    // 提取元素条目绑定态：点击的列绑定到该条目（LOOP 时按每张卡片该列取值）
    if (excelBindEntryIdRef.current) {
      const id = excelBindEntryIdRef.current;
      setCustomTextEntries((prev) => prev.map((e) => (e.id === id ? { ...e, excelField: info.field } : e)));
      setExcelBindEntryId(null);
      excelBindEntryIdRef.current = null;
      setSuccessToast(`已绑定 Excel 列「${info.field}」：跑 LOOP 时每张卡片取该行该列的值`);
      return;
    }
    // S 输入模式：记录待填入的值，目标框在左网页
    if (currentPendingAction === "input") {
      const value = info.value || "";
      setPendingInputValue(value);
      pendingInputValueRef.current = value;
      setPendingInputField(info.field);
      pendingInputFieldRef.current = info.field;
      setPickTarget("left");
      if (leftViewMode === "web") {
        window.electronAPI?.viewStartPicking("left");
      }
      return;
    }
    setLeftPicked({
      selector: info.field,
      label: info.field,
      value: info.value,
      tag: "excel-cell",
      type: "text",
      text: info.value,
      rect: { x: 0, y: 0, width: 0, height: 0 },
    });
    if (info.value) {
      sourceFieldValueRef.current = String(info.value).trim();
      sourceFieldLabelRef.current = info.field || "";
    }
    // 录入流：来源确定后切到左网页选目标输入框；审查流：等待保存映射
    const isEntry = addingStepModeRef.current === "entry" || currentLoopStepTypeRef.current === "entry";
    setPickTarget(isEntry ? "left" : null);
    if (isEntry && leftViewMode === "web") {
      window.electronAPI?.viewStartPicking("left");
    }
    if (addingStepModeRef.current) return;
    // 记录拾取标记（Excel 单元格，side=right 表示来自右侧 Excel）
    addPickedMark({
      side: "right",
      source: "excel",
      selector: info.field,
      label: info.field,
      value: info.value,
      workflow: teachingPhase === "data-source" ? "data-source" : teachingPhase === "entry" ? "entry" : "review",
      action: "pick",
      recordId: selected?.record_id,
      excelField: info.field,
      excelRecordId: info.record_id,
    });
  };

  // 同理，把 onLeftPicked / onRightPicked 写入 ref，供脱离浏览器窗口的 IPC handler 调用
  onLeftPickedRef.current = onLeftPicked;
  onRightPickedRef.current = onRightPicked;

  // 教学模式向导：完成教学后自动开始 LOOP 批量执行
  useEffect(() => {
    if (!startBatchAfterTeaching || !workflowTemplate) return;
    setStartBatchAfterTeaching(false);
    runBatch();
  }, [startBatchAfterTeaching, workflowTemplate, runBatch]);

  // 左侧脱离时，向脱离窗口广播 records 和 selectedId
  useEffect(() => {
    if (!leftDetached || !window.electronAPI) return;
    window.electronAPI.panelBroadcastState("left", { selectedId, records: cardRecords });
  }, [leftDetached, selectedId, cardRecords]);

  // Excel 脱离时，向脱离窗口广播 records、selectedId、pickedMarks 和选中列
  useEffect(() => {
    if (!excelDetached || !window.electronAPI) return;
    window.electronAPI.panelBroadcastState("browser-excel", { selectedId, records, pickedMarks, selectedExcelColumn });
  }, [excelDetached, selectedId, records, pickedMarks, selectedExcelColumn]);

  // 底部脱离时，向脱离窗口广播核验相关状态 + 教学步骤面板状态
  useEffect(() => {
    if (!bottomDetached || !window.electronAPI) return;
    window.electronAPI.panelBroadcastState("bottom", {
      record: selected,
      mappings,
      comparisons: result?.comparisons || [],
      resultPresent: !!result,
      report,
      loopReports,
      steps,
      shots,
      running,
      pickedMarks,
      replaying,
      replayCursor,
      // 教学步骤面板状态：让分离窗口能渲染 TeachingGuide
      teachingPhase,
      appMode,
      selectMode,
      hasSearchSteps: pickedMarks.some((m) => m.action === "input" && !!m.variableField),
      hasSubmitStep: pickedMarks.some((m) => m.action === "click" && m.workflow === "entry"),
      dataSourceCount: pickedMarks.filter((m) => m.workflow === "data-source").length,
      reviewCount: pickedMarks.filter((m) => m.workflow === "review").length,
      entryCount: pickedMarks.filter((m) => m.workflow === "entry").length,
      hasCheckedBatch: checkedIds.size > 0,
      beginnerMode: settings.beginner_mode !== false,
    });
  }, [bottomDetached, selected, mappings, result, report, loopReports, steps, shots, running, pickedMarks, replaying, replayCursor, teachingPhase, appMode, selectMode, checkedIds, settings.beginner_mode]);

  // 浏览器面板脱离时，广播 URL 和 picking 状态
  useEffect(() => {
    if (browserLeftDetached && window.electronAPI) {
      const picking = (selectMode && pickTarget === "left") || avatarMode || pendingAction === "click" || teachingPhase !== "idle";
      window.electronAPI.panelBroadcastState("browser-left", { url: leftUrl, picking });
    }
  }, [browserLeftDetached, leftUrl, selectMode, pickTarget, avatarMode, pendingAction, teachingPhase]);

  useEffect(() => {
    if (browserRightDetached && window.electronAPI) {
      const picking = (selectMode && pickTarget === "right") || pendingAction === "click" || teachingPhase !== "idle";
      window.electronAPI.panelBroadcastState("browser-right", { url: rightUrl, picking });
    }
  }, [browserRightDetached, rightUrl, selectMode, pickTarget, pendingAction, teachingPhase]);

  // 模态弹窗打开时通过主进程彻底隐藏所有原生 BrowserView（left/right/弹窗/脱离面板/dock），根治穿模
  // 使用 modalOverlayEnter/Exit 引用计数支持多层模态嵌套
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    const anyModalOpen = showSettings || !!docFillData || showSaveSkill || showSkillPanel || showApplyLoop || !!showCredentialsPanel || !!showBlockPanel;
    if (anyModalOpen) {
      api.modalOverlayEnter();
      return () => {
        api.modalOverlayExit();
      };
    }
  }, [showSettings, docFillData, showSaveSkill, showSkillPanel, showApplyLoop, showCredentialsPanel, showBlockPanel]);

  // ============ 核验 ============
  const start = async () => {
    const canRunWithoutRecord = mappings.length > 0 && mappings.every((m) => m.left_source === "database");
    let currentSelected = selected;
    // 未选择记录时自动选第一条（避免后端返回 record None not found）
    if (!currentSelected && !canRunWithoutRecord && records.length > 0) {
      currentSelected = records[0];
      setSelectedId(currentSelected.record_id);
    }
    if (!currentSelected && !canRunWithoutRecord) return;
    setHasRunOnce(true);
    setRunning(true);
    setSteps([]);
    setShots([]);
    setResult(null);
    setReport(null);
    setError(null);
    setWaitingManual(false);
    setVerifyStatus("scanning");
    try {
      // 无 Excel/护照记录时，从左侧网页提取期望值
      let expectedFields: Record<string, string> | undefined;
      if (!currentSelected && canRunWithoutRecord) {
        const dbMappings = mappings.filter((m) => m.left_source === "database");
        const script = `
          ${DEEP_QUERY_HELPER}
          (function() {
            const result = {};
            ${dbMappings
              .map(
                (m) => `
            try {
              const el = __cinsideDeepQuery(${JSON.stringify(m.left_field)});
              result[${JSON.stringify(m.left_field)}] = el ? (el.value || el.textContent || '') : '';
            } catch (e) {
              result[${JSON.stringify(m.left_field)}] = '';
            }`
              )
              .join("\n")}
            return result;
          })()
        `;
        try {
          const raw = await window.electronAPI?.viewExecuteJS("left", script);
          expectedFields = (raw as Record<string, string>) || {};
        } catch (e) {
          console.error("[start] 提取左侧网页值失败", e);
          expectedFields = {};
        }
      }

      const workflow: WorkflowStep[] = [
        { action: "manual", description: "人工登录：在右侧浏览器完成登录" },
        { action: "wait", wait_seconds: 1, description: "等待页面稳定" },
        { action: "screenshot", description: "截图用于字段映射" },
      ];
      const cfg: WorkflowConfig = {
        record_id: currentSelected?.record_id,
        university_url: rightUrl,
        workflow,
        mappings,
        use_vision_verify: true,
        expected_fields: expectedFields,
      };
      const { task_id } = await api.startConfigurableVerify(cfg);
      taskIdRef.current = task_id;
      wsRef.current = subscribeTask(
        task_id,
        (e) => {
          if (e.type === "step") {
            setSteps((prev) => [...prev, e.data]);
            if (e.data.action === "manual") setWaitingManual(true);
            if (e.data.action === "final" || e.data.action === "error") {
              setRunning(false);
              setWaitingManual(false);
              api.getReport(task_id).then((rep) => {
                setReport(rep);
                if (rep?.record_id && rep.overall) {
                  setRecordResults((prev) => ({ ...prev, [rep.record_id]: rep.overall }));
                }
              }).catch(console.error);
            }
          } else if (e.type === "screenshot") {
            setShots((prev) => [...prev, e.data]);
          } else if (e.type === "done") {
            setResult(e.data);
            setRunning(false);
            applyHighlightsFromResult(e.data);
          } else if (e.type === "error") {
            setError(e.data.message);
            setRunning(false);
            setVerifyStatus("idle");
          }
        },
        undefined,
        () => {
          if (running) setRunning(false);
        }
      );
    } catch (e: any) {
      setError(e.message);
      setRunning(false);
      setVerifyStatus("idle");
    }
  };

  // 核验完成后：把比对结果注入到右侧 BrowserView 的高亮
  const applyHighlightsFromResult = (r: VerificationResult) => {
    if (!window.electronAPI) return;
    const boxes = (r.comparisons || [])
      .map((c: FieldComparison) => {
        const sel = c.selector_hint;
        if (!sel) return null;
        const status =
          c.match === "match" ? "match" :
          c.match === "mismatch" ? "mismatch" :
          c.match === "missing" ? "missing" :
          c.match === "partial" ? "partial" : "unknown";
        return {
          selector: sel,
          status: status as "match" | "mismatch" | "missing" | "partial" | "unknown",
          label: `${c.field}: ${c.website_value || "—"}`,
        };
      })
      .filter(Boolean) as { selector: string; status: "match" | "mismatch" | "missing" | "partial" | "unknown"; label: string }[];

    if (boxes.length > 0) {
      window.electronAPI.viewHighlightBoxes("right", boxes);
    }
    const hasMismatch = (r.comparisons || []).some((c) => c.match === "mismatch");
    setVerifyStatus(hasMismatch ? "mismatch" : "match");
  };

  const continueManual = async () => {
    try {
      await api.continueManualStep(taskIdRef.current);
      setWaitingManual(false);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const overall = result?.overall;

  const excelFields = useMemo(() => {
    if (!selected) return [];
    return Object.keys(selected.fields);
  }, [selected]);

  // 已保存的控件映射（mappings 中带 widget 的）
  const savedWidgets = useMemo(
    () => mappings.filter((m) => m.widget).map((m) => ({ mapping: m, widget: m.widget as WidgetDef })),
    [mappings]
  );

  // 控件提取结果字段：解析每个已保存控件的绑定值，用于在文件处理面板「提取结果」中统一展示
  const widgetResultFields = useMemo(() => {
    const fields: Array<{ key: string; label: string; value: string; kind: "option" | "calendar" }> = [];
    for (const { mapping, widget } of savedWidgets) {
      const label = widget.triggerLabel || mapping.right_label || (widget.kind === "option" ? "选项控件" : "日历控件");
      let value = "";
      switch (mapping.left_source) {
        case "manual":
          value = mapping.left_field || "";
          break;
        case "excel":
          value = (selected?.fields as Record<string, string> | undefined)?.[mapping.left_field] || "";
          break;
        case "database":
          value = mapping.left_field || "";
          break;
        case "passport":
          value = currentDocExtract?.fields?.[mapping.left_field] || "";
          break;
      }
      if (value && String(value).trim()) {
        fields.push({
          key: `widget_${mapping.right_selector}`,
          label,
          value: String(value),
          kind: widget.kind,
        });
      }
    }
    return fields;
  }, [savedWidgets, selected, currentDocExtract]);

  // 控件提取面板内容（渲染在 ResultsPanel 的「提取元素」卡片设置模式中）
  const widgetExtractContent = useMemo(() => {
    if (!widgetExtractMode && !widgetDraft && savedWidgets.length === 0) return null;
    return (
      <WidgetExtractPanel
        pickingKind={widgetPickKind}
        snapshotBusy={widgetSnapshotBusy}
        snapshotError={widgetSnapshotError}
        draft={widgetDraft}
        draftBinding={widgetDraftBinding}
        savedWidgets={savedWidgets}
        excelFields={excelFields}
        recordFields={(selected?.fields || {}) as Record<string, string>}
        rolePickingKey={widgetRolePickingKey}
        optionPickingKey={widgetOptionPickingKey}
        leftPickingKey={widgetLeftPickingKey}
        testResults={widgetTestResults}
        testBusyKey={widgetTestBusyKey}
        onStartPick={startWidgetPick}
        onCancelPick={cancelWidgetPick}
        onDraftChange={setWidgetDraft}
        onDraftBindingChange={setWidgetDraftBinding}
        onSaveDraft={saveWidgetDraft}
        onDiscardDraft={discardWidgetDraft}
        onUpdateSaved={updateSavedWidget}
        onUpdateSavedBinding={updateSavedWidgetBinding}
        onRemoveSaved={removeSavedWidget}
        onPickRole={pickWidgetRole}
        onPickOption={pickWidgetOption}
        onPickLeftWeb={pickWidgetLeftWeb}
        passportPickingKey={widgetPassportPickingKey}
        onPickPassportField={pickWidgetPassportField}
        onTest={testWidget}
        calendarState={widgetCalendarState}
        calendarBusyKey={widgetCalendarBusyKey}
        onCalendarMirror={handleCalendarMirrorClick}
        calGuide={calPickStepIdx !== null ? {
          stepIdx: calPickStepIdx,
          total: CALENDAR_GUIDE_STEPS.length,
          role: CALENDAR_GUIDE_STEPS[calPickStepIdx].role,
          label: CALENDAR_GUIDE_STEPS[calPickStepIdx].label,
          required: CALENDAR_GUIDE_STEPS[calPickStepIdx].required,
        } : null}
        calDayCellCount={calDayCellPicks.length}
        onFinishDayCells={finishCalDayCellPicks}
        onSkipGuideStep={skipCalendarGuideStep}
        onCancelGuide={cancelCalendarGuide}
        calPanelPickFailed={calPanelPickFailed}
        calPanelPickMode={calPanelPickMode}
        panelPickKind={panelPickKind}
        onCalPanelPickArm={armCalPanelPick}
        onCalPanelPickCancel={cancelCalPanelPick}
      />
    );
  }, [
    widgetExtractMode, widgetDraft, savedWidgets, widgetPickKind, widgetSnapshotBusy, widgetSnapshotError,
    widgetDraftBinding, excelFields, selected, widgetRolePickingKey, widgetOptionPickingKey, widgetLeftPickingKey,
    widgetTestResults, widgetTestBusyKey,
    startWidgetPick, cancelWidgetPick, saveWidgetDraft, updateSavedWidget, updateSavedWidgetBinding,
    removeSavedWidget, pickWidgetRole, pickWidgetOption, pickWidgetLeftWeb, testWidget,
    widgetCalendarState, widgetCalendarBusyKey, handleCalendarMirrorClick,
    calPickStepIdx, calDayCellPicks, finishCalDayCellPicks, skipCalendarGuideStep, cancelCalendarGuide,
    calPanelPickFailed, calPanelPickMode, panelPickKind, armCalPanelPick, cancelCalPanelPick, discardWidgetDraft,
  ]);

  // 控件 TAB 列表（浏览器标签页风格：每个控件一个 TAB）
  const widgetTabs = useMemo(() => {
    const tabs: Array<{ id: string; label: string; kind: "option" | "calendar"; isDraft?: boolean; isBound?: boolean }> = [];
    // 已保存控件按顺序
    for (const { mapping, widget } of savedWidgets) {
      tabs.push({
        id: `widget:saved:${mapping.right_selector}`,
        label: widget.triggerLabel || mapping.right_label || (widget.kind === "option" ? "选项" : "日历"),
        kind: widget.kind,
        isBound: !!mapping.left_field?.trim(),
      });
    }
    // 草稿控件（当前正在编辑的）放最后
    if (widgetDraft) {
      tabs.push({
        id: `widget:draft:${widgetDraft.id}`,
        label: widgetDraft.triggerLabel || (widgetDraft.kind === "option" ? "新选项" : "新日历"),
        kind: widgetDraft.kind,
        isDraft: true,
      });
    }
    return tabs;
  }, [savedWidgets, widgetDraft]);

  // 脱离模式：根据 URL query param 渲染独立面板窗口
  const detachMode = getDetachMode();
  if (detachMode === "left") return <DetachedLeftPanel />;
  if (detachMode === "bottom") return <DetachedBottomPanel onFieldPanelActive={() => setFieldPanelActive(true)} fieldSetupToggleSignal={fieldSetupToggleSignal} />;
  if (detachMode === "browser-left") return <DetachedBrowserPanel detachSide="browser-left" />;
  if (detachMode === "browser-right") return <DetachedBrowserPanel detachSide="browser-right" />;
  if (detachMode === "browser-excel") return <DetachedExcelPanel />;

  // 任务选择页
  if (taskType === "select") {
    return (
      <>
        <TaskSelector onSelect={handleTaskSelect} checking={officecliChecking} />
        {officecliModalOpen && (
          <OfficecliRequiredModal
            onClose={() => setOfficecliModalOpen(false)}
            onInstalled={() => {
              setOfficecliModalOpen(false);
              switchTaskType("ppt");
            }}
          />
        )}
      </>
    );
  }

  // 设置弹窗（web 与 ppt 两种全屏视图下都可弹出，故在早返回前提取为变量复用）
  const settingsModal = showSettings ? (
    <SettingsModal
      initial={{ ...settings, ui_scale: uiScale }}
      onClose={() => {
        // 关闭时取消未执行的 rAF，避免拖拽回调在弹窗关闭后才触发
        if (brightnessRafRef.current) { cancelAnimationFrame(brightnessRafRef.current); brightnessRafRef.current = 0; }
        if (scaleRafRef.current) { cancelAnimationFrame(scaleRafRef.current); scaleRafRef.current = 0; }
        setShowSettings(false);
      }}
      onScaleChange={(scale) => {
        // rAF 节流：拖拽滑块时每帧最多应用一次 zoom，避免高频 setZoomFactor + resize 卡顿
        pendingScaleRef.current = scale;
        if (scaleRafRef.current) return;
        scaleRafRef.current = requestAnimationFrame(() => {
          scaleRafRef.current = 0;
          const s = pendingScaleRef.current;
          setUiScale(s);
          uiScaleRef.current = s;
          try { localStorage.setItem("cinside-ui-scale", s.toString()); } catch {}
          window.dispatchEvent(new Event("resize"));
        });
      }}
      onAppearanceChange={(theme, accent) => {
        // 即时生效：直接写入 DOM，不等待保存
        // 临时禁用所有过渡，避免数百个 transition-all 元素同时动画导致卡顿
        const root = document.documentElement;
        root.classList.add("no-transitions");
        root.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
        root.setAttribute("data-accent", accent || "indigo");
        // 强制重排后下一帧恢复过渡
        void root.offsetWidth;
        requestAnimationFrame(() => root.classList.remove("no-transitions"));
      }}
      onBrightnessChange={(val) => {
        // rAF 节流 + 直接 IPC：拖拽时每帧最多调用一次，不经过 setSettings 避免整个 App 树重渲染
        pendingBrightnessRef.current = val;
        if (brightnessRafRef.current) return;
        brightnessRafRef.current = requestAnimationFrame(() => {
          brightnessRafRef.current = 0;
          const v = pendingBrightnessRef.current;
          window.electronAPI?.viewSetBrightness?.("left", v);
          window.electronAPI?.viewSetBrightness?.("right", v);
        });
      }}
      onSaved={(s) => {
        setSettings(s);
        if (typeof s.ui_scale === "number") {
          setUiScale(s.ui_scale);
          uiScaleRef.current = s.ui_scale;
          try { localStorage.setItem("cinside-ui-scale", s.ui_scale.toString()); } catch {}
          window.dispatchEvent(new Event("resize"));
        }
        setConfig((c) =>
          c
            ? {
                ...c,
                settings: s,
                agent_backend: s.agent_backend,
                vision_configured: Boolean(s.vision_api_key),
                browser_use_configured: Boolean(s.browser_use_llm_key),
              }
            : c
        );
        setShowSettings(false);
      }}
    />
  ) : null;

  // 幻灯片任务模式：全屏渲染 PPT 工作流
  if (taskType === "ppt") {
    return (
      <>
        <PPTWorkflowPanel
          onBack={() => switchTaskType("select")}
          onOpenSettings={() => setShowSettings(true)}
        />
        {settingsModal}
      </>
    );
  }

  // 协作任务模式：Cowork Studio（人工协作 / AI 协作）
  if (taskType === "cowork") {
    return (
      <>
        <CoworkStudio onBack={() => switchTaskType("select")} />
        {settingsModal}
      </>
    );
  }

  // 是否有模态/覆盖面板打开（此时需要隐藏 BrowserView，显示毛玻璃背景）
  const anyModalOpen = showSettings || !!docFillData || showSaveSkill || showSkillPanel || showApplyLoop || !!showCredentialsPanel || !!showBlockPanel;

  return (
    <div className="flex h-full flex-col">
      {/* ============ 屏幕调试面板（仅开发环境后台日志可见） ============ */}
      {teachingPhase !== "idle" && (() => {
        // 屏蔽前端可见的 DEBUG STATE 面板，仅输出到后台调试日志
        const dbg = { bindInputSide, pendingAction, pickTarget, nextClickLabel, selectedExcelColumn, pickedMarks: pickedMarks.length, teachingPhase, leftViewMode };
        if (typeof window !== "undefined" && window.electronAPI?.rendererLog) {
          window.electronAPI.rendererLog(`[debug-state] ${JSON.stringify(dbg)}`);
        }
        return null;
      })()}
      {/* ============ 自定义标题栏（无边框窗口） ============ */}
      <div
        className="flex shrink-0 items-center justify-between border-b border-slate-200/60 bg-white/80 px-3 py-1"
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
            onClick={() => switchTaskType("select")}
            className="flex items-center justify-center w-7 h-7 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition-colors"
            title="切换任务类型"
          >
            <LayoutGrid size={18} />
          </button>
        </div>
        {/* UPDATER */}
        <div className="flex items-center gap-2" style={{WebkitAppRegion:"no-drag"}as React.CSSProperties}>
          {updateStatus==="available"&&updateInfo&&(
            <div className="flex items-center gap-2 rounded-lg bg-indigo-50 px-2 py-1 text-[11px] text-indigo-700 border border-indigo-200">
              <span className="font-semibold">发现新版本 v{updateInfo.version}</span>
              <button onClick={()=>{window.electronAPI?.updateDownloadUpdate();setUpdateStatus("downloading");setUpdateProgress(0);}} className="rounded bg-indigo-600 px-2 py-0.5 text-white hover:bg-indigo-700 text-[11px] font-medium">立即下载</button>
            </div>
          )}
          {updateStatus==="downloading"&&(
            <div className="flex items-center gap-2 rounded-lg bg-violet-50 px-2 py-1 text-[11px] text-violet-700 border border-violet-200 min-w-[160px]">
              <Loader2 className="h-3 w-3 animate-spin"/>
              <span className="font-medium">下载中</span>
              <div className="flex-1 h-1.5 bg-violet-200 rounded-full overflow-hidden"><div className="h-full bg-violet-600 transition-all" style={{ width: `${updateProgress}%` }}/></div>
              <span className="text-violet-600 font-mono text-[10px]">{updateProgress}%</span>
            </div>
          )}
          {updateStatus==="downloaded"&&updateInfo&&(
            <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700 border border-emerald-200">
              <CheckCircle2 className="h-3.5 w-3.5"/>
              <span className="font-semibold">v{updateInfo.version} 已下载</span>
              <button onClick={()=>window.electronAPI?.updateQuitAndInstall()} className="rounded bg-emerald-600 px-2 py-0.5 text-white hover:bg-emerald-700 text-[11px] font-medium">立即重启安装</button>
            </div>
          )}
          {updateStatus==="error"&&updateError&&(
            <div className="flex items-center gap-1.5 rounded-lg bg-rose-50 px-2 py-1 text-[10px] text-rose-600 border border-rose-200" title={updateError}><AlertCircle className="h-3 w-3"/><span>更新失败</span></div>
          )}
          {appVersion&&updateStatus==="idle"&&(<span className="text-[10px] text-slate-400">v{appVersion}</span>)}
        </div>
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <button
            onClick={() => setLeftPanelOpen((v) => !v)}
            className={[
              "rounded p-1.5 transition-colors",
              leftPanelOpen
                ? "text-slate-700 hover:bg-slate-100"
                : "text-slate-400 hover:bg-slate-100 hover:text-slate-600",
            ].join(" ")}
            title={leftPanelOpen ? "隐藏左侧面板" : "显示左侧面板"}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => setBottomPanelOpen((v) => !v)}
            className={[
              "rounded p-1.5 transition-colors",
              bottomPanelOpen
                ? "text-slate-700 hover:bg-slate-100"
                : "text-slate-400 hover:bg-slate-100 hover:text-slate-600",
            ].join(" ")}
            title={bottomPanelOpen ? "隐藏下面板" : "显示下面板"}
          >
            <PanelBottom className="h-4 w-4" />
          </button>
          <button
            onClick={() => {
              if (!focusBottomMode) {
                setBottomPanelOpen(true);
                savedBottomHeightRef.current = bottomPanelHeight;
                setFocusBottomMode(true);
              } else {
                setFocusBottomMode(false);
              }
            }}
            className={[
              "flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-all",
              focusBottomMode
                ? "bg-brand-100 text-brand-700 ring-1 ring-brand-300"
                : "bg-white/70 text-slate-600 ring-1 ring-slate-200 hover:bg-white hover:text-slate-900",
            ].join(" ")}
            title={focusBottomMode ? "还原布局：恢复上方浏览器面板" : "聚焦下方：隐藏上方浏览器面板，下方审查面板铺满全屏"}
          >
            <PanelBottom className="h-3 w-3" />
            {focusBottomMode ? "还原" : "聚焦"}
          </button>
          <div className="mx-1 h-4 w-px bg-slate-200" />
          <button
            onClick={() => window.electronAPI?.windowMinimize()}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            title="最小化"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => window.electronAPI?.windowMaximize()}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            title="最大化/还原"
          >
            <Square className="h-3 w-3" />
          </button>
          <button
            onClick={() => window.electronAPI?.windowClose()}
            className="rounded p-1 text-slate-400 hover:bg-rose-100 hover:text-rose-600"
            title="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ============ 顶部工具栏 ============ */}
      <header className="z-20 flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 py-1">
        {/* SKILL 管理按钮 */}
        <button
          onClick={() => setShowSkillPanel(true)}
          className="flex shrink-0 items-center gap-1 rounded-md bg-white/70 px-2 py-0.5 text-[11px] font-medium text-slate-700 ring-1 ring-slate-200 transition-all hover:bg-slate-100 hover:text-slate-900"
          title="查看已保存的 Loop 模板并执行"
        >
          <BookMarked className="h-3 w-3 text-slate-400" />
          查看保存Loop
        </button>

        {/* 外挂插件开关 */}
        <button
          onClick={toggleDock}
          className={[
            "flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 transition-all",
            dockOpen
              ? "bg-slate-900 text-white ring-slate-900 hover:bg-slate-800"
              : "bg-white/70 text-slate-700 ring-slate-200 hover:bg-slate-100 hover:text-slate-900",
          ].join(" ")}
          title="站外循环：在屏幕边缘挂一个悬浮条，设置「提取源」和「操作页」后 AI 自主循环填写；数据痕迹见下方「站外循环记录」"
        >
          <Rotate3D className={`h-3 w-3 ${dockOpen ? "" : "text-slate-400"}`} />
          {dockOpen ? "站外循环已开" : "站外循环"}
        </button>

        {/* 中间空白区：错误/成功提示显示在工具栏同一行中央 */}
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
          {error && (
            <div className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-rose-50 px-2 py-0.5 text-[11px] text-rose-700 ring-1 ring-rose-200 animate-slide-up">
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span className="truncate">{error}</span>
              <button onClick={() => setError(null)} className="ml-0.5 shrink-0 text-rose-400 hover:text-rose-600">
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          {warn && (
            <div className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800 ring-1 ring-amber-200 animate-slide-up">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span className="truncate" title={warn}>{warn}</span>
              <button
                onClick={() => {
                  if (warnTimerRef.current != null) window.clearTimeout(warnTimerRef.current);
                  setWarn(null);
                }}
                className="ml-0.5 shrink-0 text-amber-400 hover:text-amber-600"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          {success && (
            <div className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700 ring-1 ring-emerald-200 animate-slide-up">
              <CheckCircle2 className="h-3 w-3 shrink-0" />
              <span className="truncate">{success}</span>
              <button
                onClick={() => {
                  if (successTimerRef.current != null) window.clearTimeout(successTimerRef.current);
                  setSuccess(null);
                }}
                className="ml-0.5 shrink-0 text-emerald-400 hover:text-emerald-600"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>

        {/* pendingAction 状态指示器（仅 S 输入模式显示；点击模式不显示提示） */}
        {pendingAction === "input" && (
          <div className={[
            "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium",
            pendingAction === "input"
              ? "bg-slate-800 text-white ring-1 ring-slate-600"
              : "bg-slate-800 text-white ring-1 ring-slate-600",
          ].join(" ")}>
            {pendingAction === "input" && (
              <kbd className="rounded bg-white/20 px-1 py-0.5 text-[9px] font-bold">
                S
              </kbd>
            )}
            <span>
              {pendingAction === "input"
                ? (pendingInputValue != null && inputTarget
                    ? `已选「${pendingInputField || "网页值"}」· 按 Enter 填入并记录`
                    : pendingInputValue != null
                    ? `已选源「${pendingInputField || "网页值"}」· 点击右侧目标输入框`
                    : inputTarget
                    ? `目标已锁定 · 点击 Excel/网页取值`
                    : "输入模式：先点 Excel/网页取值，再点右侧输入框")
                : "点击模式：下一次点击触发真实点击"}
            </span>
            <button
              onClick={() => {
                setPendingAction("none");
                setInputTarget(null);
                setPendingInputValue(null);
                setPendingInputField(null);
              }}
              className="ml-1 rounded p-0.5 hover:bg-white/20"
              title="取消（Esc）"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        )}

        {/* 教学模式 / 录入流操作开关（仅录入模式显示"录入流操作"，LOOP/审查模式显示"教学模式"） */}
        <button
          onClick={() => (selectMode ? exitSelectMode() : enterSelectMode())}
          className={[
            "flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-all",
            selectMode
              ? "bg-slate-200 text-slate-600 ring-1 ring-slate-300 hover:bg-slate-300"
              : "bg-white/70 text-slate-600 ring-1 ring-slate-200 hover:bg-white hover:text-slate-900",
          ].join(" ")}
          title={appMode === "entry"
            ? "录入流操作：点右侧表单输入框，再从左侧 Excel 选对应字段填入"
            : appMode === "loop"
              ? "循环操作：配置 LOOP 循环执行步骤"
              : "步骤设置：选中 Excel 列作为 LOOP 变量，依次配置输入、点击、审查、录入步骤"
          }
        >
          <MousePointerClick className="h-3 w-3" />
          {selectMode ? "退出选择" : (appMode === "entry" ? "录入流操作" : appMode === "loop" ? "循环操作" : "步骤设置")}
        </button>

        {/* ============ 教学完成后的批量执行按钮（仅 LOOP/录入模式显示） ============ */}
        {appMode !== "review" && teachingPhase === "done" && workflowTemplate && !batchRunning && records.length > 0 && (
          <button
            onClick={() => runBatch()}
            className={[
              "flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-all",
              "bg-slate-900 text-white shadow-sm ring-1 ring-slate-700 hover:bg-slate-800",
            ].join(" ")}
            title={`对所有 ${records.length} 张卡片批量执行模板${workflowTemplate.hasSearchSteps ? "（含搜索步骤）" : "（无搜索步骤，可能无法定位其他学生）"}`}
          >
            <Play className="h-3 w-3" />
            {appMode === "entry" ? "批量录入" : "批量执行"} ({records.length})
          </button>
        )}

        {appMode !== "review" && batchRunning && (
          <button
            onClick={stopBatch}
            className="flex items-center gap-1 rounded-md bg-rose-600 px-2 py-0.5 text-[11px] font-medium text-white shadow-sm ring-1 ring-rose-300 transition-all hover:bg-rose-700"
            title="停止批量执行"
          >
            <Square className="h-3 w-3" />
            停止 ({batchCursor + 1}/{batchTargets.length})
          </button>
        )}

        {/* 重新配置按钮：配置已完成但想重新设置（仅 LOOP/录入模式显示） */}
        {appMode !== "review" && teachingPhase === "done" && workflowTemplate && !batchRunning && (
          <button
            onClick={startTeaching}
            className="flex items-center gap-1 rounded-md bg-white/70 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 transition-all hover:bg-white hover:text-slate-900"
            title="重新配置步骤（清除现有模板）"
          >
            <Settings2 className="h-3 w-3" />
            重新配置
          </button>
        )}

        {/* 新 LOOP 按钮：完全重置所有 LOOP 状态，开始一个全新的 LOOP（仅 LOOP/录入模式显示） */}
        {appMode !== "review" && teachingPhase === "done" && workflowTemplate && !batchRunning && (
          <button
            onClick={startNewLoop}
            className="flex items-center gap-1 rounded-md bg-white/70 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 transition-all hover:bg-white hover:text-slate-900"
            title="开始新 LOOP（清空所有模板、结果、日志，保留 Excel 数据）"
          >
            <Repeat2 className="h-3 w-3" />
            新 LOOP
          </button>
        )}

        {/* 状态徽章 */}
        {overall && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-white ${OVERALL_STYLES[overall]}`}
          >
            {overall === "pass" ? <CheckCircle2 className="h-3 w-3" /> : overall === "fail" ? <XCircle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
            {OVERALL_LABELS[overall]}
          </span>
        )}

        {/* 开始按钮：教学进行中 = 保存SKILL并执行；教学已完成 = 批量执行；未教学 = 单条核验 */}
        {teachingPhase !== "idle" && teachingPhase !== "done" ? (() => {
          const dsCount = pickedMarks.filter((m) => m.workflow === "data-source").length;
          const rvCount = pickedMarks.filter((m) => m.workflow === "review").length;
          const enCount = pickedMarks.filter((m) => m.workflow === "entry").length;
          const stepCount = appMode === "entry" ? enCount : dsCount + rvCount;
          return (
            <button
              onClick={finishTeachingAndRunBatch}
              disabled={batchRunning || stepCount === 0}
              className={[
                "flex items-center gap-1.5 rounded-md px-3 py-0.5 text-[11px] font-medium text-white transition-all",
                batchRunning || stepCount === 0
                  ? "cursor-not-allowed bg-slate-400"
                  : "bg-slate-900 hover:bg-slate-800 active:scale-[.98] shadow-sm",
              ].join(" ")}
              title={
                stepCount === 0
                  ? appMode === "entry" ? "请先配置至少一个录入步骤" : "请先配置至少一个审查步骤"
                  : `立即批量${appMode === "loop" ? " LOOP" : appMode === "entry" ? "录入" : "审查"}（${stepCount} 步）`
              }
            >
              <Play className="h-3 w-3" />
              执行
            </button>
          );
        })() : (
          <button
            onClick={start}
            disabled={running || mappings.length === 0 || (!selected && !mappings.every((m) => m.left_source === "database"))}
            className={[
              "flex items-center gap-1.5 rounded-md px-3 py-0.5 text-[11px] font-medium text-white transition-all",
              running || singleRunning || batchRunning || mappings.length === 0 || (!selected && !mappings.every((m) => m.left_source === "database"))
                ? "cursor-not-allowed bg-slate-400"
                : "bg-slate-900 hover:bg-slate-800 active:scale-[.98] shadow-sm",
            ].join(" ")}
            title={
              running || singleRunning || batchRunning
                ? "核验/LOOP 执行中…"
                : mappings.length === 0
                ? `请先配置至少一条字段映射（已拾取 ${pickedMarks.length} 个节点，已保存 ${mappings.length} 条映射）`
                : !selected && !mappings.every((m) => m.left_source === "database")
                ? "未选择记录时，只能核验左侧来源全部为网页的映射"
                : `开始核验（${mappings.length} 条映射）`
            }
          >
            {(running || singleRunning || batchRunning) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {(running || singleRunning || batchRunning) ? "运行中" : "开始核验"}
          </button>
        )}
        {waitingManual && (
          <button
            onClick={continueManual}
            className="flex animate-pulse items-center gap-1 rounded-md bg-amber-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-amber-600"
          >
            <Play className="h-3 w-3" /> 已登录，继续
          </button>
        )}

        <button
          onClick={() => setShowSettings(true)}
          className="rounded-md p-1 text-slate-400 hover:bg-white/70 hover:text-slate-600"
          title="设置"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </button>
      </header>

      {/* ============ 主体：三列 + 底部 ============ */}
      <main
        className={[
          "relative grid min-h-0 flex-1 gap-2 overflow-hidden p-2",
          leftPanelOpen && !leftDetached ? "grid-cols-[260px_1fr]" : "grid-cols-1",
        ].join(" ")}
      >
        {/* 左侧数据面板 */}
        {leftPanelOpen && !leftDetached && (
          <aside className="relative min-h-0">
            <LeftPanel
              records={cardRecords}
              selectedId={selectedId}
              onSelect={handleSelectCard}
              onRefresh={refreshRecords}
              onClear={clearRecords}
              recordResults={recordResults}
              batchResults={batchResults}
              onDetach={() => detachPanel("left")}
              aiSphereState={aiSphereState}
              analysisOpen={analysisOpen}
              analysisAvailable={analysisAvailable}
              analysisSegments={analysisSegments}
              analysisLoading={analysisLoading}
              onToggleAnalysis={(open) => {
                setAnalysisOpen(open);
                if (open) setExecutionPanelOpen(false);
              }}
              onRegenerateAnalysis={() => void generateLoopAnalysis(loopReports)}
              onRunRecord={runSingleRecord}
              runDisabled={batchRunning || singleRunning}
              runningRecordId={singleRunning ? selectedId : null}
              onDropSkill={runSkillOnRecord}
              checkedIds={checkedIds}
              onCheckChange={setCheckedIds}
              onRunCheckedLoop={handleRunCheckedLoop}
              onAdaptLoopToChecked={handleAdaptLoopToChecked}
              onReorder={setCardPool}
              cardLoopMap={cardLoopMap}
              runCursor={runCursor}
              onRunCursorChange={setRunCursor}
              onRunLoopsWithCursor={handleRunLoopsWithCursor}
              onClearCardLoop={handleClearCardLoop}
              onClearAllCardLoops={handleClearAllCardLoops}
              cardImages={cardImages}
              onSetCardImage={setCardImage}
              onClearCardImage={clearCardImage}
              fieldColumnMap={fieldColumnMap}
              onFieldColumnMapChange={handleFieldColumnMapChange}
              detectedColumnMap={detectedColumnMap}
              execSteps={steps}
              execRunning={isAnyRunning}
              execPanelOpen={executionPanelOpen}
              execChipVisible={hasRunOnce && edgeButtonVisible && !executionPanelOpen}
              onOpenExecPanel={() => {
                setAnalysisOpen(false);
                setExecutionPanelOpen(true);
              }}
              onCloseExecPanel={() => {
                setExecutionPanelOpen(false);
                if (hasRunOnce && !isAnyRunning) setEdgeButtonVisible(true);
              }}
              logEndRef={logEndRef}
              onExecBubblesGone={() => {
                if (hasRunOnce) setEdgeButtonVisible(true);
              }}
              emptyHint={
                records.length > 0 && cardPool.length === 0
                  ? "已在 Excel 载入数据\n请在 Excel 视图点行号框选 LOOP 行范围\n然后点击「一键生成卡片」\n可多次框选不同段/不同Excel追加卡片"
                  : cardPool.length === 0
                  ? "上传 Excel/CSV 后这里会列出所有记录"
                  : undefined
              }
            />
            {loadingRecords && (
              <div className="absolute inset-0 rounded-xl bg-white/40 backdrop-blur-[1px]" />
            )}
          </aside>
        )}

        {/* 中右区域：上方两个浏览器并排，下方审查面板（教学模式时面板内部左右分栏：教学面板 | 结果面板） */}
        <section
          className="flex min-h-0 min-w-0 flex-col gap-0 overflow-hidden"
          onMouseMove={(e) => {
            if (vDraggingRef.current) {
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = ((e.clientY - rect.top) / rect.height) * 100;
              const bottomPct = Math.max(20, Math.min(80, 100 - pct));
              setBottomPanelHeight(bottomPct);
            }
          }}
          onMouseUp={() => {
            vDraggingRef.current = false;
            teachingDragRef.current = false;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
          }}
          onMouseLeave={() => {
            vDraggingRef.current = false;
            teachingDragRef.current = false;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
          }}
        >
          {/* 两个浏览器并排（脱离后对应位置留空或单列），可拖拽调整比例 */}
          <div
            className={[
              "min-h-0 min-w-0 gap-1 overflow-hidden",
              focusBottomMode ? "hidden" : "flex flex-1",
            ].join(" ")}
            onMouseMove={(e) => {
              if (!draggingRef.current) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = ((e.clientX - rect.left) / rect.width) * 100;
              setLeftPaneWidth(Math.max(20, Math.min(80, pct)));
            }}
            onMouseUp={() => {
              draggingRef.current = false;
              document.body.style.cursor = "";
              document.body.style.userSelect = "";
            }}
            onMouseLeave={() => {
              draggingRef.current = false;
              document.body.style.cursor = "";
              document.body.style.userSelect = "";
            }}
          >
            {/* 左侧：网页 / Excel 视图（通过BrowserPane内部viewMode切换，Web模式有URL Tabs，Excel模式显示ExcelView） */}
            {((leftViewMode === "web" && !browserLeftDetached) ||
              (leftViewMode === "excel" && !excelDetached)) ? (
              <div
                className="relative flex min-h-0 min-w-0 flex-col"
                style={{
                  width: browserRightDetached ? "100%" : `${leftPaneWidth}%`,
                  flexShrink: 0,
                }}
              >
                <BrowserPane
                  side="left"
                  title="数据源"
                  url={leftUrl}
                  onUrlChange={setLeftUrl}
                  overlayActive={anyModalOpen}
                  brightness={settings.browser_brightness ?? 1.0}
                  enableTabs={true}
                  enableViewSwitch={true}
                  viewMode={leftViewMode}
                  onViewModeChange={(mode) => {
                    if (avatarMode) exitAvatarMode();
                    setLeftViewMode(mode);
                  }}
                  excelTabTitle="数据源"
                  newTabTitle="CINSIDE SEARCH"
                  favoriteSites={leftFavoriteSites}
                  onAddFavoriteSite={handleAddFavoriteSite("left")}
                  onRemoveFavoriteSite={handleRemoveFavoriteSite("left")}
                  hasExcelData={records.length > 0 || leftBlankExcel}
                  onRequestAddExcel={() => browserExcelInputRef.current?.click()}
                  onNewBlankExcel={() => { setLeftBlankExcel(true); setLeftViewMode("excel"); }}
                  isBlankExcel={leftBlankExcel}
                  onExcelDrop={handleBrowserExcelUpload}
                  onCloseExcel={() => { if (leftBlankExcel) { setLeftBlankExcel(false); setLeftViewMode("web"); } else handleCloseLeftExcel(); }}
                  blockPicking={blockPickingSide === "left"}
                  onBlockElement={(info) => onBlockElementPicked("left", info)}
                  blockRuleCount={blockRulesState[`left:${getHost(leftUrl)}`]?.length || 0}
                  onManageBlocks={() => {
                    if (blockPickingSide === "left") {
                      setBlockPickingSide(null);
                    } else if (showBlockPanel === "left") {
                      setShowBlockPanel(null);
                    } else if (blockRulesState[`left:${getHost(leftUrl)}`]?.length) {
                      setShowBlockPanel("left");
                    } else {
                      setBlockPickingSide("left");
                    }
                  }}
                  sidebarCollapsed={!!sidebarAutoCollapse[`left:${getHost(leftUrl)}`]}
                  onToggleSidebarCollapse={() => toggleSidebarAutoCollapse("left")}
                  onOpenCredentials={() => setShowCredentialsPanel(showCredentialsPanel === "left" ? null : "left")}
                  credentialCount={credentials.filter((c) => c.host === getHost(leftUrl)).length}
                  picking={(selectMode && pickTarget === "left") || avatarMode || (pendingAction === "click" && (pickTarget === "left" || (teachingPhase !== "idle" && !!nextClickLabel) || addingClickMode)) || (pendingAction === "input" && pickTarget === "left") || !!bindInputSide || (teachingPhase !== "idle" && !!nextClickLabel && pickTarget === "left") || !!customTextPickingId || !!widgetLeftPickingKey || !!widgetPickKind || (!!widgetRolePickingKey && getWidgetSideByKey(widgetRolePickingKey) === "left") || (!!widgetOptionPickingKey && getWidgetSideByKey(widgetOptionPickingKey) === "left") || (calPanelPickMode === "picking" && calFailTriggerRef.current?.side === "left")}
                  onPickedElement={avatarMode ? onAvatarPicked : onLeftPicked}
                  verifyStatus="idle"
                  disabled={running}
                  popupActive={popupSide === "left"}
                  onClosePopup={() => window.electronAPI?.popupClose("left")}
                  emptyHint={
                    avatarMode ? "点击学生头像元素以提取"
                    : bindInputSide ? "👆 步骤拾取中：点输入框=绑定Excel列并填入第一行；点按钮/链接=真实点击（再点已选元素可回收）"
                    : pendingAction === "input" ? "S 输入模式：先点击此处的 Excel/网页取值"
                    : pendingAction === "click" ? "空格点击模式：点击元素触发真实点击"
                    : teachingPhase !== "idle" ? "LOOP 步骤配置中：点输入框自动绑定 Excel 列，点搜索/元素记录点击"
                    : "输入数据库 / 源数据 URL"
                  }
                  onDetach={() => detachPanel(leftViewMode === "excel" ? "browser-excel" : "browser-left")}
                  excelEmptyState={
                    <div
                      className="flex h-full w-full flex-col items-center justify-start gap-3 px-6 pb-8 pt-28 text-center"
                    >
                      {browserExcelUploading ? (
                        <>
                          <Loader2 className="h-10 w-10 animate-spin text-slate-400" />
                          <p className="text-xs text-slate-500">正在解析 Excel...</p>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => browserExcelInputRef.current?.click()}
                            className="group flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white/60 px-8 py-6 transition-all hover:border-slate-400 hover:bg-slate-50"
                          >
                            <FileSpreadsheet className="h-10 w-10 text-slate-300 transition-colors group-hover:text-slate-500" />
                            <div>
                              <p className="text-sm font-medium text-slate-600">Excel / CSV</p>
                              <p className="text-[11px] text-slate-400">点击或拖拽文件到此处上传</p>
                            </div>
                          </button>
                          <button
                            onClick={() => { setLeftBlankExcel(true); }}
                            className="text-[11px] font-medium text-slate-500 transition-colors hover:text-slate-700 hover:underline"
                          >
                            或新建空白表格
                          </button>
                        </>
                      )}
                    </div>
                  }
                >
                  {leftBlankExcel && leftViewMode === "excel" && (
                    <BlankExcel onClose={() => { setLeftBlankExcel(false); setLeftViewMode("web"); }} />
                  )}
                  {records.length > 0 && leftViewMode === "excel" && !leftBlankExcel && (
                    <ExcelView
                      embedded={true}
                      records={records}
                      selectedId={selectedId}
                      picking={(selectMode && pickTarget === "left") || pendingAction === "input" || excelBindEntryId != null}
                      onPickedField={onExcelPicked}
                      pickedMarks={pickedMarks}
                      selectedColumn={selectedExcelColumn}
                      onSelectColumn={setSelectedExcelColumn}
                      rowRange={rowRange}
                      cardsGenerated={cardsGenerated}
                      onGenerateCards={generateCards}
                      onResetCards={resetCards}
                      fieldColumnMap={fieldColumnMap}
                      onFieldColumnMapChange={handleFieldColumnMapChange}
                      detectedColumnMap={detectedColumnMap}
                      boundFields={boundExcelFields}
                      activeRecordId={execRecordId}
                      activeField={excelActiveField}
                      activeFieldStatus={excelActiveFieldStatus}
                      fieldResults={excelFieldResults}
                      side="left"
                    />
                  )}
                </BrowserPane>
                <input
                  ref={browserExcelInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleBrowserExcelUpload(f);
                    e.target.value = "";
                  }}
                />
              </div>
            ) : null}

            {/* 可拖拽分隔条 */}
            {!browserLeftDetached && !excelDetached && !browserRightDetached && (!browserLeftDetached || !excelDetached) && (
              <div
                className="relative z-10 w-1.5 shrink-0 cursor-col-resize select-none"
                onMouseDown={(e) => {
                  e.preventDefault();
                  draggingRef.current = true;
                  document.body.style.cursor = "col-resize";
                  document.body.style.userSelect = "none";
                }}
                title="拖拽调整左右面板比例"
              >
                <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-200 hover:bg-brand-300" />
              </div>
            )}

            {!browserRightDetached && (
              <div className="min-w-0 flex-1">
                <BrowserPane
                  side="right"
                  title="学校系统"
                  subtitle="待核验页面"
                  url={rightUrl}
                  onUrlChange={setRightUrl}
                  overlayActive={anyModalOpen}
                  brightness={settings.browser_brightness ?? 1.0}
                  enableTabs={true}
                  enableViewSwitch={true}
                  viewMode={rightViewMode}
                  onViewModeChange={(mode) => {
                    setRightViewMode(mode);
                  }}
                  excelTabTitle="参考Excel"
                  hasExcelData={rightRecords.length > 0 || rightBlankExcel}
                  onRequestAddExcel={() => rightExcelInputRef.current?.click()}
                  onNewBlankExcel={() => { setRightBlankExcel(true); setRightViewMode("excel"); }}
                  isBlankExcel={rightBlankExcel}
                  onExcelDrop={handleRightExcelUpload}
                  onCloseExcel={() => { if (rightBlankExcel) { setRightBlankExcel(false); setRightViewMode("web"); } else handleCloseRightExcel(); }}
                  newTabTitle="CINSIDE SEARCH"
                  favoriteSites={rightFavoriteSites}
                  onAddFavoriteSite={handleAddFavoriteSite("right")}
                  onRemoveFavoriteSite={handleRemoveFavoriteSite("right")}
                  blockPicking={blockPickingSide === "right"}
                  onBlockElement={(info) => onBlockElementPicked("right", info)}
                  blockRuleCount={blockRulesState[`right:${getHost(rightUrl)}`]?.length || 0}
                  onManageBlocks={() => {
                    if (blockPickingSide === "right") {
                      setBlockPickingSide(null);
                    } else if (showBlockPanel === "right") {
                      setShowBlockPanel(null);
                    } else if (blockRulesState[`right:${getHost(rightUrl)}`]?.length) {
                      setShowBlockPanel("right");
                    } else {
                      setBlockPickingSide("right");
                    }
                  }}
                  sidebarCollapsed={!!sidebarAutoCollapse[`right:${getHost(rightUrl)}`]}
                  onToggleSidebarCollapse={() => toggleSidebarAutoCollapse("right")}
                  onOpenCredentials={() => setShowCredentialsPanel(showCredentialsPanel === "right" ? null : "right")}
                  credentialCount={credentials.filter((c) => c.host === getHost(rightUrl)).length}
                  picking={(selectMode && pickTarget === "right") || (pendingAction === "click" && (pickTarget === "right" || (teachingPhase !== "idle" && !!nextClickLabel) || addingClickMode)) || (pendingAction === "input" && pickTarget === "right") || !!bindInputSide || (teachingPhase !== "idle" && !!nextClickLabel && pickTarget === "right") || !!customTextPickingId || !!widgetPickKind || (!!widgetRolePickingKey && getWidgetSideByKey(widgetRolePickingKey) === "right") || (!!widgetOptionPickingKey && getWidgetSideByKey(widgetOptionPickingKey) === "right") || (calPanelPickMode === "picking" && calFailTriggerRef.current?.side !== "left")}
                  onPickedElement={onRightPicked}
                  onMultiPickedElements={onRightMultiPicked}
                  onPickWarning={onRightPickWarning}
                  verifyStatus={verifyStatus}
                  disabled={running}
                  popupActive={popupSide === "right"}
                  onClosePopup={() => window.electronAPI?.popupClose("right")}
                  emptyHint={
                    bindInputSide ? "👆 步骤拾取中：点输入框=绑定Excel列并填入第一行；点按钮/链接=真实点击（再点已选元素可回收）"
                    : pendingAction === "input"
                      ? (pendingInputValue != null && inputTarget
                          ? `已选源「${pendingInputField || "网页值"}」，按 Enter 填入此框`
                          : pendingInputValue != null
                          ? `已选源「${pendingInputField || "网页值"}」，点击右侧输入框作为目标`
                          : inputTarget
                          ? `目标已锁定，点击左侧 Excel/网页取值`
                          : "S 输入模式：先点左侧 Excel/网页取值，再点右侧输入框")
                      : pendingAction === "click"
                      ? "空格点击模式：点击元素触发真实点击"
                      : teachingPhase !== "idle"
                      ? "LOOP 步骤配置中：先点上方「绑定输入框/点击」开始"
                      : "输入学校系统 URL，或切换到Excel模式上传参考数据"
                  }
                  onDetach={() => detachPanel("browser-right")}
                  excelEmptyState={
                    <div
                      className="flex h-full w-full flex-col items-center justify-start gap-3 px-6 pb-8 pt-28 text-center"
                    >
                      {rightExcelUploading ? (
                        <>
                          <Loader2 className="h-10 w-10 animate-spin text-slate-400" />
                          <p className="text-xs text-slate-500">正在解析 Excel...</p>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => rightExcelInputRef.current?.click()}
                            className="group flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white/60 px-8 py-6 transition-all hover:border-slate-400 hover:bg-slate-50"
                          >
                            <FileSpreadsheet className="h-10 w-10 text-slate-300 transition-colors group-hover:text-slate-500" />
                            <div>
                              <p className="text-sm font-medium text-slate-600">Excel / CSV</p>
                              <p className="text-[11px] text-slate-400">点击或拖拽文件到此处上传</p>
                            </div>
                          </button>
                        </>
                      )}
                    </div>
                  }
                  headerExtra={
                    <div className="flex items-center gap-0.5">
                      {rightViewMode === "web" && (
                        <>
                          <button
                            onClick={() => setRightUrl("http://localhost:8000/demo-review/")}
                            className="flex items-center rounded-md bg-white/70 px-1.5 py-0.5 text-[9px] font-medium text-slate-600 ring-1 ring-slate-200 transition-all hover:bg-slate-100 hover:text-slate-900"
                            title="审查流 DEMO：已提交申请表（含故意错误）"
                          >
                            审查DEMO
                          </button>
                          <button
                            onClick={() => setRightUrl("http://localhost:8000/demo-entry/")}
                            className="flex items-center rounded-md bg-white/70 px-1.5 py-0.5 text-[9px] font-medium text-slate-600 ring-1 ring-slate-200 transition-all hover:bg-slate-100 hover:text-slate-900"
                            title="录入流 DEMO：空白申请表单"
                          >
                            录入DEMO
                          </button>
                        </>
                      )}
                    </div>
                  }
                >
                  {rightBlankExcel && rightViewMode === "excel" && (
                    <BlankExcel onClose={() => { setRightBlankExcel(false); setRightViewMode("web"); }} />
                  )}
                  {rightRecords.length > 0 && rightViewMode === "excel" && !rightBlankExcel && (
                    <ExcelView
                      embedded={true}
                      records={rightRecords}
                      selectedId={selectedId}
                      picking={(selectMode && pickTarget === "right") || pendingAction === "input" || excelBindEntryId != null}
                      pickedMarks={pickedMarks}
                      selectedColumn={rightSelectedColumn}
                      onSelectColumn={setRightSelectedColumn}
                      rowRange={rightRowRange}
                      cardsGenerated={rightCardsGenerated}
                      onGenerateCards={generateRightCards}
                      onResetCards={resetRightCards}
                      onPickedField={onRightExcelPicked}
                      boundFields={boundExcelFields}
                      side="right"
                    />
                  )}
                </BrowserPane>
                <input
                  ref={rightExcelInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleRightExcelUpload(f);
                    e.target.value = "";
                  }}
                />
              </div>
            )}
            {browserLeftDetached && excelDetached && (
              <div className="flex h-full items-center justify-center text-xs text-slate-400">
                左侧网页与 Excel 都已脱离到独立窗口
              </div>
            )}
          </div>

          {/* 垂直可拖拽分隔条：仅在审查面板可见时显示；双击最大化/还原 */}
          {bottomPanelOpen && !bottomDetached && !focusBottomMode && (
            <div
              className="relative z-10 h-1.5 shrink-0 cursor-row-resize select-none"
              onMouseDown={(e) => {
                e.preventDefault();
                vDraggingRef.current = true;
                document.body.style.cursor = "row-resize";
                document.body.style.userSelect = "none";
              }}
              onDoubleClick={() => {
                if (prevBottomHeightRef.current !== null) {
                  setBottomPanelHeight(prevBottomHeightRef.current);
                  prevBottomHeightRef.current = null;
                } else {
                  prevBottomHeightRef.current = bottomPanelHeight;
                  setBottomPanelHeight(80);
                }
              }}
              title="拖拽调整高度，双击最大化/还原"
            >
              <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-slate-200 hover:bg-brand-300" />
            </div>
          )}

          {/* 审查/结果面板：新手模式教学时内部左右分栏（教学面板 | 结果），非新手模式/非教学时上下堆叠 */}
          {bottomPanelOpen && !bottomDetached && (
            <div
              className={[
                "flex min-h-0 gap-0 overflow-hidden",
                focusBottomMode ? "flex-1" : "shrink-0",
                (selectMode && settings.beginner_mode !== false && teachingPhase !== "idle") ? "flex-row" : "flex-col",
              ].join(" ")}
              style={{
                height: focusBottomMode ? undefined : `${bottomPanelHeight}%`,
                minHeight: selectMode ? "200px" : "280px",
              }}
              onMouseMove={(e) => {
                if (!teachingDragRef.current) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const pct = ((e.clientX - rect.left) / rect.width) * 100;
                const width = teachingPanelSide === "left" ? pct : 100 - pct;
                setTeachingPanelWidth(Math.max(25, Math.min(65, width)));
              }}
            >
              {/* ElementSelectBar 教学面板 —— 左侧（仅新手模式显示） */}
              {selectMode && settings.beginner_mode !== false && teachingPanelSide === "left" && (
                <div
                  className="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white/90 p-2 shadow-sm backdrop-blur-sm"
                  style={{ width: `${teachingPanelWidth}%` }}
                >
                  <ElementSelectBar
                    active={selectMode}
                    pickTarget={pickTarget}
                    rightPicked={rightPicked}
                    leftPicked={leftPicked}
                    excelFields={excelFields}
                    mappingCount={mappings.length}
                    onCancel={exitSelectMode}
                    onPickLeftFromWeb={pickLeftFromWeb}
                    onPickLeftFromExcel={pickLeftFromExcel}
                    onResetRound={resetMappingRound}
                    onSave={saveMapping}
                    teachingPhase={teachingPhase}
                    pendingAction={pendingAction}
                    appMode={appMode}
                    dataSourceCount={pickedMarks.filter((m) => m.workflow === "data-source").length}
                    reviewCount={pickedMarks.filter((m) => m.workflow === "review").length}
                    entryCount={pickedMarks.filter((m) => m.workflow === "entry").length}
                    hasBoundInputs={pickedMarks.some((m) => m.action === "input" && !!m.variableField)}
                    hasConfirmClick={pickedMarks.some((m) => m.action === "click" && m.label.startsWith("确认人物"))}
                    onAdvanceTeaching={advanceToReviewPhase}
                    onAbortTeaching={abortTeaching}
                    onRequestQuickSave={handleQuickSaveLoop}
                    onRequestSaveSkill={() => { setSaveSkillRunAfter(false); setShowSaveSkill(true); }}
                    onDirectRun={finishTeachingAndRunBatch}
                    selectedExcelColumn={selectedExcelColumn || rightSelectedColumn}
                    rightBindColumn={rightBindColumn}
                    onRightBindColumnChange={setRightBindColumn}
                    bindInputSide={bindInputSide}
                    nextClickLabel={nextClickLabel}
                    onStartBindInputs={startBindBothInputs}
                    onExitBindInputs={exitBindInputs}
                    bindStepCount={pickedMarks.filter((m) => m.action === "input" || m.action === "click").length}
                    onStartConfirmPerson={startConfirmPerson}
                    onStartAddReviewSteps={startAddingReviewSteps}
                    onStartAddEntrySteps={startAddingEntrySteps}
                    onExitAddingStepMode={exitAddingStepMode}
                    addingStepMode={addingStepMode}
                    currentStepType={currentLoopStepType}
                    onSwitchStepType={switchLoopStepType}
                    addingClickMode={addingClickMode}
                    addingClickPhase={addingClickPhase}
                    preClickCount={preClickCount}
                    processClickCount={processClickCount}
                    postClickCount={postClickCount}
                    onStartAddPreClick={() => startAddClickStep("pre")}
                    onStartAddProcessClick={() => startAddClickStep("mid")}
                    onStartAddPostClick={() => startAddClickStep("post")}
                    onExitAddClickMode={exitAddClickMode}
                    onSwapSide={() => setTeachingPanelSide((s) => (s === "left" ? "right" : "left"))}
                    onUndo={undoLastStep}
                    canUndo={pickedMarks.length > 0}
                    addingDocExtractMode={addingDocExtractMode}
                    docExtractSource={docExtractSource}
                    docExtractStepCount={pickedMarks.filter((m) => m.docExtract).length}
                    docUploadStepCount={pickedMarks.filter((m) => m.docUpload).length}
                    onStartAddDocExtract={startAddDocExtract}
                    onExitAddDocExtractMode={exitAddDocExtractMode}
                    onChooseDocExtractWeb={chooseDocExtractWeb}
                    onChooseDocExtractLocal={chooseDocExtractLocal}
                    onTriggerLocalFilePick={triggerDocLocalFilePick}
                    onLocalFilesSelected={handleDocLocalFilesSelected}
                    localFileInputRef={docLocalFileInputRef}
                    docLocalFiles={docLocalFiles.map((f) => ({ name: f.name, size: f.size }))}
                    onRemoveLocalFile={removeDocLocalFile}
                    docFileBindField={docFileBindField}
                    onSetDocFileBindField={setDocFileBindField}
                    onConfirmDocLocalExtract={confirmDocLocalExtract}
                    onPickLocalDirectory={pickLocalDirectory}
                    docLocalRootPath={docLocalRootPath}
                    docLocalDirFiles={docLocalDirFiles}
                    docLocalSamplePath={docLocalSamplePath}
                    docLocalPattern={docLocalPattern}
                    onSelectDocLocalSample={selectDocLocalSample}
                    onDocFileExtract={requestDocFileExtract}
                    cardsGenerated={cardsGenerated}
                    rowRange={rowRange}
                    customTextMode={customTextMode}
                    customTextEntries={customTextEntries}
                    customTextPickingId={customTextPickingId}
                    onToggleCustomText={toggleCustomText}
                    onAddCustomText={addCustomTextEntry}
                    onRemoveCustomText={removeCustomTextEntry}
                    onUpdateCustomText={updateCustomTextEntry}
                    onPickForCustomText={pickForCustomText}
                    onSaveCustomTextSteps={saveCustomTextSteps}
                    widgetExtractMode={widgetExtractMode}
                    widgetCount={savedWidgets.length}
                    onToggleWidgetExtract={toggleWidgetExtract}
                    saveTriggerRef={mappingSaveTriggerRef}
                    onCanSaveChange={setCanSaveMapping}
                  />
                </div>
              )}

              {/* 教学面板水平拖拽分隔条（左侧教学面板时，仅新手模式） */}
              {selectMode && settings.beginner_mode !== false && teachingPanelSide === "left" && (
                <div
                  className="relative z-10 flex w-2 shrink-0 cursor-col-resize items-center justify-center select-none bg-transparent"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    teachingDragRef.current = true;
                    document.body.style.cursor = "col-resize";
                    document.body.style.userSelect = "none";
                  }}
                  title="拖拽调整教学面板宽度"
                >
                  <div className="h-full w-px bg-slate-200 transition-colors hover:bg-brand-300" />
                </div>
              )}

              {/* 结果面板 ResultsPanel（验证报告三栏） */}
              <div className="min-h-0 min-w-0 flex-1">
                <ResultsPanel
                  comparisons={result?.comparisons || []}
                  resultPresent={!!result}
                  report={report}
                  loopReports={loopReports}
                  shots={shots}
                  steps={steps}
                  running={running || singleRunning || batchRunning || queueRunning}
                  execRunning={batchRunning || queueRunning}
                  livePairs={livePairs}
                  livePairsHistory={livePairsHistory}
                  onViewLiveCard={handleViewLiveCard}
                  appMode={appMode}
                  onFixField={handleFixField}
                  onFixAllAndRerun={handleFixAllAndRerun}
                  onEditExtractFields={handleEditExtractFields}
                  currentRecordId={currentRecordId}
                  onConfirmFixes={handleConfirmFixes}
                  confirmingRecordId={confirmingRecordId}
                  onExportExcel={handleExportExcel}
                  exportingExcel={exportingExcel}
                  fixingFieldKey={fixingFieldKey}
                  fixRerunRecordId={fixRerunRecordId}
                  onDetach={() => detachPanel("bottom")}
                  onClose={selectMode ? undefined : () => setBottomPanelOpen(false)}
                  docExtracts={currentDocExtracts}
                  activeDocIndex={safeDocIndex}
                  onSelectDocIndex={setActiveDocIndex}
                  docExtracting={docExtracting}
                  docLiveStatus={docWebStatus}
                  docLivePreview={docSourcePreview}
                  ocrEngine={settings.ocr_engine || "vision"}
                  onChangeOcrEngine={handleChangeOcrEngine}
                  igpuAcceleration={!!settings.igpu_acceleration}
                  docBreakpoint={docBreakpoint}
                  onToggleDocBreakpoint={toggleDocBreakpoint}
                  switchToDocSignal={docSignal}
                  addingStepMode={addingStepMode}
                  onFieldPanelActive={() => setFieldPanelActive(true)}
                  fieldSetupToggleSignal={fieldSetupToggleSignal}
                  onPickExtractedField={onPickExtractedField}
                  docLocalConfigContent={(addingDocExtractMode && (docExtractSource === "choose" || docExtractSource === "local" || docExtractSource === "web")) || docFallbackActive ? (
                    <DocLocalExtractConfig
                      // LOOP 执行期保底机制激活时强制以 web 模式渲染（人工审查界面在 web 分支内）
                      mode={docFallbackActive && !addingDocExtractMode ? "web" : (docExtractSource ?? "choose")}
                      hideHeader={docExtractSource === "choose"}
                      excelFields={excelFields}
                      selectedExcelColumn={selectedExcelColumn}
                      docFileBindField={docFileBindField}
                      onSetDocFileBindField={setDocFileBindField}
                      ocrEngine={(settings.ocr_engine as "vision" | "umi") || "vision"}
                      onChangeOcrEngine={handleChangeOcrEngine}
                      igpuAcceleration={!!settings.igpu_acceleration}
                      onChooseWeb={chooseDocExtractWeb}
                      onChooseLocal={chooseDocExtractLocal}
                      onExitChoose={exitAddDocExtractMode}
                      webStepCount={pickedMarks.filter((m) => m.docExtractClick && m.docExtractClickPhase !== "mid").length}
                      webPostStepCount={pickedMarks.filter((m) => m.docExtractClick && m.docExtractClickPhase === "mid").length}
                      onStartAddPostClicks={startDocExtractPostClicks}
                      onStartAddPreClicks={startDocExtractPreClicks}
                      onExitWebMode={exitAddDocExtractMode}
                      onUndoClick={undoDocExtractClick}
                      onGoBack={docExtractGoBack}
                      onResumePicking={forceResumeDocPicking}
                      webStatus={(docExtractSource === "web" || docFallbackActive) ? docWebStatus : undefined}
                      docLocalRootPath={docLocalRootPath}
                      docLocalDirFiles={docLocalDirFiles}
                      docLocalSamplePath={docLocalSamplePath}
                      docLocalPattern={docLocalPattern}
                      onPickLocalDirectory={pickLocalDirectory}
                      onSelectDocLocalSample={selectDocLocalSample}
                      onConfirm={confirmDocLocalExtract}
                      // 网页模式内嵌提取结果（替代外部弹窗）
                      webResult={docExtractSource === "web" ? docExtractPanel : null}
                      onCloseWebResult={() => { setDocExtractPanel(null); setSameNameImages(null); sourceFieldValueRef.current = ""; sourceFieldLabelRef.current = ""; setDocExtractActiveTab("primary"); setDocAltExtracting(false); }}
                      webSameNameImages={sameNameImages}
                      webFindingSameName={findingSameName}
                      onFindSameName={findSameNameImages}
                      onExtractFields={sendDocFieldsToExtractPanel}
                      onExportDoc={() => setDocExportOpen(true)}
                      onBindUploadDoc={startBindUpload}
                      onQuickUploadDoc={(fileData) => startQuickUpload(fileData)}
                      onToast={(msg) => setSuccessToast(msg)}
                      onError={(msg) => setError(msg)}
                      // 双引擎对比
                      webAltResult={docExtractSource === "web" ? docExtractPanel?.altResult ?? null : null}
                      webActiveTab={docExtractActiveTab}
                      onSwitchWebTab={setDocExtractActiveTab}
                      onReExtractAlt={reExtractWithAltEngine}
                      webAltExtracting={docAltExtracting}
                      // 源文件预览（字段送「提取元素」后仍保留显示）
                      sourcePreview={docSourcePreview}
                      onCloseSourcePreview={() => setDocSourcePreview(null)}
                      // 预览就绪后点击触发 OCR
                      onTriggerWebExtract={handleTriggerWebExtractClick}
                      // 提取失败后重试
                      onRetryWebExtract={retryWebExtract}
                      // 保底机制人工审查
                      onSelectFallbackFile={selectFallbackFile}
                      onConfirmFallbackFile={() => {
                        const file = confirmFallbackFile();
                        if (file) {
                          // LOOP模式：confirmFallbackFile内部已resolve Promise，doOcrExtract会被调用
                          // 非LOOP模式（手动触发保底）：设置pendingWebFileRef并触发triggerWebExtract
                          const status = docWebStatusRef.current;
                          const fallbackSide = status.phase === "fallback-review" ? status.side : "right";
                          if (!fallbackWaitResolveRef.current && !batchRunning) {
                            // 非LOOP模式，走手动提取流程 —— 先记录面板点击为过程点击
                            pendingWebFileRef.current = {
                              dataUrl: file.dataUrl,
                              filename: file.filename,
                              size: file.size,
                              side: fallbackSide,
                            };
                            const inNavClick = addingClickModeRef.current &&
                              (addingClickPhaseRef.current === "pre" || addingClickPhaseRef.current === "mid");
                            const workflow: "entry" | "review" = fallbackSide === "left" ? "entry" : "review";
                            addPickedMark({
                              side: fallbackSide,
                              source: "web",
                              selector: "panel://doc-web-extract-fallback",
                              label: `文件提取过程点击 · 确认选择并提取（${file.filename}）`,
                              workflow,
                              action: "click",
                              recordId: selected?.record_id,
                              docExtractClick: true,
                              docExtractClickPhase: "mid",
                              panelAction: "doc-web-extract",
                              clickPhase: inNavClick ? (addingClickPhaseRef.current as "pre" | "mid") : "mid",
                              inPopup: false,
                            });
                            setSuccessToast("已记录过程点击：确认选择并提取");
                            triggerWebExtract();
                          }
                        }
                      }}
                      onCancelFallback={() => {
                        setDocWebStatus({ phase: "error", message: "保底机制：已跳过该记录" });
                        // 如果有等待中的LOOP执行Promise，resolve null表示跳过
                        if (fallbackWaitResolveRef.current) {
                          const resolve = fallbackWaitResolveRef.current;
                          fallbackWaitResolveRef.current = null;
                          resolve(null);
                        }
                        // 保底取消，如果在批量执行中，2秒后重置状态继续
                        if (batchRunning) {
                          setTimeout(() => {
                            setDocWebStatus({ phase: "idle" });
                          }, 2000);
                        }
                      }}
                    />
                  ) : undefined}
                  focusPanel={
                    docExtractSplitView
                      ? null
                    : addingDocExtractMode ? (settings.beginner_mode === false ? null : (docExtractSource === "choose" ? "doc" as const : "field-doc" as const))
                    : customTextMode ? null
                    : widgetExtractMode ? null
                    : (settings.beginner_mode === false) ? null
                    : (addingStepMode || addingClickMode) ? "field" as const
                    : null
                  }
                  preClickMarks={pickedMarks.filter((m) => (m.action === "click" && m.clickPhase === "pre") || (m.action === "input" && m.workflow === "data-source"))}
                  processClickMarks={pickedMarks.filter((m) => m.action === "click" && m.clickPhase === "mid")}
                  postClickMarks={pickedMarks.filter((m) => m.action === "click" && m.clickPhase === "post")}
                  onStartAddPreClick={() => startAddClickStep("pre")}
                  onStartBindInputs={startBindBothInputs}
                  bindInputActive={!!bindInputSide}
                  bindStepCount={pickedMarks.filter((m) => m.action === "input" || (m.action === "click" && m.clickPhase === "pre")).length}
                  preClickActive={addingClickMode && addingClickPhase === "pre"}
                  onStartAddProcessClick={() => startAddClickStep("mid")}
                  processClickActive={addingClickMode && addingClickPhase === "mid"}
                  onStartAddPostClick={() => startAddClickStep("post")}
                  postClickActive={addingClickMode && addingClickPhase === "post"}
                  onStartAddDocExtract={startAddDocExtract}
                  onAutoOpenDocChoose={openDocChoosePanel}
                  onChooseDocWeb={chooseDocExtractWeb}
                  onChooseDocLocal={chooseDocExtractLocal}
                  docConfigChooseMode={addingDocExtractMode && docExtractSource === "choose"}
                  onExitDocChoose={exitAddDocExtractMode}
                  docExtractActive={addingDocExtractMode}
                  onSwitchStepMode={(mode) => {
                    if (addingStepModeRef.current === mode) {
                      rlog(`[onSwitchStepMode] 已在${mode}模式，退出所有设置模式`);
                      exitAllSetupModes();
                      return;
                    }
                    // 先退出所有其他模式（互斥），再走完整激活流程：
                    // startAdding* 会设置 selectMode/pickTarget/teachingPhase 并激活网页拾取光标
                    exitAllSetupModes();
                    if (mode === "entry") startAddingEntrySteps();
                    else startAddingReviewSteps();
                  }}
                  onExitAddingStepMode={exitAddingStepMode}
                  canSaveMapping={canSaveMapping}
                  onConfirmMapping={() => {
                    if (mappingSaveTriggerRef.current) {
                      const fn = mappingSaveTriggerRef.current;
                      mappingSaveTriggerRef.current = null;
                      fn();
                    }
                  }}
                  reviewMappings={mappings}
                  onRemoveMark={removePickedMark}
                  onRemoveMapping={removeMapping}
                  onRemoveExtractStep={removeExtractStep}
                  onPreviewMark={(mark) => {
                    // 在对应网页高亮显示元素位置：点击卡片 → 网页上弹出定位框
                    const side = mark.side || "right";
                    const selector = mark.selector;
                    if (!selector) return;
                    const label = markDisplayLabel(mark);
                    rlog(`[onPreviewMark] 在${side}侧网页高亮元素: ${selector}`);
                    window.electronAPI?.viewHighlightBoxes(side, [{ selector, status: "pending", label }]).catch(() => {});
                    // 2 秒后自动清除高亮
                    setTimeout(() => {
                      window.electronAPI?.viewHighlightBoxes(side, []).catch(() => {});
                    }, 2000);
                  }}
                  onSaveToBatch={handleSaveToBatch}
                  onRequestSaveLoop={() => { setSaveSkillRunAfter(false); setShowSaveSkill(true); }}
                  onRequestApplyLoop={() => setShowApplyLoop(true)}
                  onDirectRun={finishTeachingAndRunBatch}
                  onRefresh={refreshWorkspace}
                  canSaveLoop={pickedMarks.filter(m => m.action === "input" || m.action === "click").length > 0}
                  hasCheckedBatch={checkedIds.size > 0}
                  customTextContent={customTextContent}
                  customTextMode={customTextMode}
                  docFieldsContent={docFieldsContent}
                  unifiedFieldsContent={unifiedFieldsContent}
                  extractTabRequest={extractTabRequest}
                  extractTabOrder={extractTabOrder}
                  extractCounts={{
                    doc: docEntries.length,
                    custom: manualEntries.length,
                    widget: savedWidgets.length + (widgetDraft ? 1 : 0),
                  }}
                  extractStepSummary={extractStepSummary}
                  widgetExtractContent={widgetExtractContent}
                  widgetResultFields={widgetResultFields}
                  widgetPassportPickingKey={widgetPassportPickingKey}
                  onResolvePassportField={resolveWidgetPassportField}
                  onCancelPassportPicking={() => setWidgetPassportPickingKey(null)}
                  widgetTabs={widgetTabs}
                  onAddWidget={startWidgetPick}
                  onAddCustomText={toggleCustomText}
                  widgetSetupSignal={widgetExtractMode}
                  splitWidgetRequest={splitWidgetRequest}
                  docSplitView={docExtractSplitView}
                  records={cardPool.length > 0 ? cardPool : records}
                  fieldColumnMap={fieldColumnMap}
                  onSelectRecord={handleSelectCard}
                  execPhase={execPhase}
                  currentMarkOrder={batchMarkCursor?.markOrder ?? null}
                  activeVerifyIdx={verifyFieldIdx}
                  reviewFieldResults={reviewFieldResults}
                  allPickedMarks={[...pickedMarks].sort((a, b) => a.order - b.order)}
                  selectMode={selectMode}
                />
              </div>

              {/* 教学面板水平拖拽分隔条（右侧教学面板时，仅新手模式） */}
              {selectMode && settings.beginner_mode !== false && teachingPanelSide === "right" && (
                <div
                  className="relative z-10 flex w-2 shrink-0 cursor-col-resize items-center justify-center select-none bg-transparent"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    teachingDragRef.current = true;
                    document.body.style.cursor = "col-resize";
                    document.body.style.userSelect = "none";
                  }}
                  title="拖拽调整教学面板宽度"
                >
                  <div className="h-full w-px bg-slate-200 transition-colors hover:bg-brand-300" />
                </div>
              )}

              {/* ElementSelectBar 教学面板 —— 右侧（仅新手模式显示） */}
              {selectMode && settings.beginner_mode !== false && teachingPanelSide === "right" && (
                <div
                  className="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white/90 p-2 shadow-sm backdrop-blur-sm"
                  style={{ width: `${teachingPanelWidth}%` }}
                >
                  <ElementSelectBar
                    active={selectMode}
                    pickTarget={pickTarget}
                    rightPicked={rightPicked}
                    leftPicked={leftPicked}
                    excelFields={excelFields}
                    mappingCount={mappings.length}
                    onCancel={exitSelectMode}
                    onPickLeftFromWeb={pickLeftFromWeb}
                    onPickLeftFromExcel={pickLeftFromExcel}
                    onResetRound={resetMappingRound}
                    onSave={saveMapping}
                    teachingPhase={teachingPhase}
                    pendingAction={pendingAction}
                    appMode={appMode}
                    dataSourceCount={pickedMarks.filter((m) => m.workflow === "data-source").length}
                    reviewCount={pickedMarks.filter((m) => m.workflow === "review").length}
                    entryCount={pickedMarks.filter((m) => m.workflow === "entry").length}
                    hasBoundInputs={pickedMarks.some((m) => m.action === "input" && !!m.variableField)}
                    hasConfirmClick={pickedMarks.some((m) => m.action === "click" && m.label.startsWith("确认人物"))}
                    onAdvanceTeaching={advanceToReviewPhase}
                    onAbortTeaching={abortTeaching}
                    onRequestQuickSave={handleQuickSaveLoop}
                    onRequestSaveSkill={() => { setSaveSkillRunAfter(false); setShowSaveSkill(true); }}
                    onDirectRun={finishTeachingAndRunBatch}
                    selectedExcelColumn={selectedExcelColumn || rightSelectedColumn}
                    rightBindColumn={rightBindColumn}
                    onRightBindColumnChange={setRightBindColumn}
                    bindInputSide={bindInputSide}
                    nextClickLabel={nextClickLabel}
                    onStartBindInputs={startBindBothInputs}
                    onExitBindInputs={exitBindInputs}
                    bindStepCount={pickedMarks.filter((m) => m.action === "input" || m.action === "click").length}
                    onStartConfirmPerson={startConfirmPerson}
                    onStartAddReviewSteps={startAddingReviewSteps}
                    onStartAddEntrySteps={startAddingEntrySteps}
                    onExitAddingStepMode={exitAddingStepMode}
                    addingStepMode={addingStepMode}
                    currentStepType={currentLoopStepType}
                    onSwitchStepType={switchLoopStepType}
                    addingClickMode={addingClickMode}
                    addingClickPhase={addingClickPhase}
                    preClickCount={preClickCount}
                    processClickCount={processClickCount}
                    postClickCount={postClickCount}
                    onStartAddPreClick={() => startAddClickStep("pre")}
                    onStartAddProcessClick={() => startAddClickStep("mid")}
                    onStartAddPostClick={() => startAddClickStep("post")}
                    onExitAddClickMode={exitAddClickMode}
                    onSwapSide={() => setTeachingPanelSide((s) => (s === "left" ? "right" : "left"))}
                    onUndo={undoLastStep}
                    canUndo={pickedMarks.length > 0}
                    addingDocExtractMode={addingDocExtractMode}
                    docExtractSource={docExtractSource}
                    docExtractStepCount={pickedMarks.filter((m) => m.docExtract).length}
                    docUploadStepCount={pickedMarks.filter((m) => m.docUpload).length}
                    onStartAddDocExtract={startAddDocExtract}
                    onExitAddDocExtractMode={exitAddDocExtractMode}
                    onChooseDocExtractWeb={chooseDocExtractWeb}
                    onChooseDocExtractLocal={chooseDocExtractLocal}
                    onTriggerLocalFilePick={triggerDocLocalFilePick}
                    onLocalFilesSelected={handleDocLocalFilesSelected}
                    localFileInputRef={docLocalFileInputRef}
                    docLocalFiles={docLocalFiles.map((f) => ({ name: f.name, size: f.size }))}
                    onRemoveLocalFile={removeDocLocalFile}
                    docFileBindField={docFileBindField}
                    onSetDocFileBindField={setDocFileBindField}
                    onConfirmDocLocalExtract={confirmDocLocalExtract}
                    onPickLocalDirectory={pickLocalDirectory}
                    docLocalRootPath={docLocalRootPath}
                    docLocalDirFiles={docLocalDirFiles}
                    docLocalSamplePath={docLocalSamplePath}
                    docLocalPattern={docLocalPattern}
                    onSelectDocLocalSample={selectDocLocalSample}
                    onDocFileExtract={requestDocFileExtract}
                    cardsGenerated={cardsGenerated}
                    rowRange={rowRange}
                    customTextMode={customTextMode}
                    customTextEntries={customTextEntries}
                    customTextPickingId={customTextPickingId}
                    onToggleCustomText={toggleCustomText}
                    onAddCustomText={addCustomTextEntry}
                    onRemoveCustomText={removeCustomTextEntry}
                    onUpdateCustomText={updateCustomTextEntry}
                    onPickForCustomText={pickForCustomText}
                    onSaveCustomTextSteps={saveCustomTextSteps}
                    widgetExtractMode={widgetExtractMode}
                    widgetCount={savedWidgets.length}
                    onToggleWidgetExtract={toggleWidgetExtract}
                    saveTriggerRef={mappingSaveTriggerRef}
                    onCanSaveChange={setCanSaveMapping}
                  />
                </div>
              )}
            </div>
          )}

          {/* 元素选择条：下面板关闭或脱离但仍在教学模式时，底部仅显示工具条（悬浮/固定）（仅新手模式） */}
          {!bottomPanelOpen && selectMode && settings.beginner_mode !== false && (
            <div className="shrink-0 p-2">
              <ElementSelectBar
                active={selectMode}
                pickTarget={pickTarget}
                rightPicked={rightPicked}
                leftPicked={leftPicked}
                excelFields={excelFields}
                mappingCount={mappings.length}
                onCancel={exitSelectMode}
                onPickLeftFromWeb={pickLeftFromWeb}
                onPickLeftFromExcel={pickLeftFromExcel}
                onResetRound={resetMappingRound}
                onSave={saveMapping}
                teachingPhase={teachingPhase}
                pendingAction={pendingAction}
                appMode={appMode}
                dataSourceCount={pickedMarks.filter((m) => m.workflow === "data-source").length}
                reviewCount={pickedMarks.filter((m) => m.workflow === "review").length}
                entryCount={pickedMarks.filter((m) => m.workflow === "entry").length}
                hasBoundInputs={pickedMarks.some((m) => m.action === "input" && !!m.variableField)}
                hasConfirmClick={pickedMarks.some((m) => m.action === "click" && m.label.startsWith("确认人物"))}
                onAdvanceTeaching={advanceToReviewPhase}
                onAbortTeaching={abortTeaching}
                onRequestQuickSave={handleQuickSaveLoop}
                onRequestSaveSkill={() => { setSaveSkillRunAfter(false); setShowSaveSkill(true); }}
                onDirectRun={finishTeachingAndRunBatch}
                selectedExcelColumn={selectedExcelColumn || rightSelectedColumn}
                rightBindColumn={rightBindColumn}
                onRightBindColumnChange={setRightBindColumn}
                bindInputSide={bindInputSide}
                nextClickLabel={nextClickLabel}
                onStartBindInputs={startBindBothInputs}
                onExitBindInputs={exitBindInputs}
                bindStepCount={pickedMarks.filter((m) => m.action === "input" || m.action === "click").length}
                onStartConfirmPerson={startConfirmPerson}
                onStartAddReviewSteps={startAddingReviewSteps}
                onStartAddEntrySteps={startAddingEntrySteps}
                onExitAddingStepMode={exitAddingStepMode}
                addingStepMode={addingStepMode}
                currentStepType={currentLoopStepType}
                onSwitchStepType={switchLoopStepType}
                addingClickMode={addingClickMode}
                addingClickPhase={addingClickPhase}
                preClickCount={preClickCount}
                processClickCount={processClickCount}
                postClickCount={postClickCount}
                onStartAddPreClick={() => startAddClickStep("pre")}
                onStartAddProcessClick={() => startAddClickStep("mid")}
                onStartAddPostClick={() => startAddClickStep("post")}
                onExitAddClickMode={exitAddClickMode}
                onSwapSide={() => setTeachingPanelSide((s) => (s === "left" ? "right" : "left"))}
                onUndo={undoLastStep}
                canUndo={pickedMarks.length > 0}
                addingDocExtractMode={addingDocExtractMode}
                docExtractStepCount={pickedMarks.filter((m) => m.docExtract).length}
                docUploadStepCount={pickedMarks.filter((m) => m.docUpload).length}
                onStartAddDocExtract={startAddDocExtract}
                onExitAddDocExtractMode={exitAddDocExtractMode}
                onDocFileExtract={requestDocFileExtract}
                cardsGenerated={cardsGenerated}
                rowRange={rowRange}
                customTextMode={customTextMode}
                customTextEntries={customTextEntries}
                customTextPickingId={customTextPickingId}
                onToggleCustomText={toggleCustomText}
                onAddCustomText={addCustomTextEntry}
                onRemoveCustomText={removeCustomTextEntry}
                onUpdateCustomText={updateCustomTextEntry}
                onPickForCustomText={pickForCustomText}
                onSaveCustomTextSteps={saveCustomTextSteps}
                widgetExtractMode={widgetExtractMode}
                widgetCount={savedWidgets.length}
                onToggleWidgetExtract={toggleWidgetExtract}
                saveTriggerRef={mappingSaveTriggerRef}
                onCanSaveChange={setCanSaveMapping}
              />
            </div>
          )}
        </section>
      </main>

      {/* 设置弹窗（与 ppt 视图共用同一 settingsModal 变量） */}
      {settingsModal}

      {/* 功能2：本地文档提取审核弹窗（确认后填入右侧网页输入框） */}
      <input
        ref={docEntryFileInputRef}
        type="file"
        accept="image/*,.pdf,.doc,.docx,.xls,.xlsx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleDocFilePick(f);
          e.target.value = "";
        }}
      />
      {/* 文件提取步骤配置：本地文件上传（多文件） */}
      <input
        ref={docLocalFileInputRef}
        type="file"
        multiple
        accept=".jpg,.jpeg,.png,.pdf"
        className="hidden"
        onChange={handleDocLocalFilesSelected}
      />
      {docFillData && (
        <DocFillDialog
          data={docFillData}
          mappings={mappings}
          filling={docFilling}
          onConfirm={confirmDocFill}
          onCancel={() => setDocFillData(null)}
        />
      )}

      {/* ============ 教学引导浮层：宝宝式一步步指引（仅新手模式显示） ============ */}
      {settings.beginner_mode !== false && teachingPhase !== "idle" && !selectMode && !showSettings && !bottomDetached && (
        <TeachingGuide
          phase={teachingPhase}
          appMode={appMode}
          pickedMarks={pickedMarks}
          hasSearchSteps={pickedMarks.some((m) => m.action === "input" && !!m.variableField)}
          hasSubmitStep={pickedMarks.some((m) => m.action === "click" && m.workflow === "entry")}
          dataSourceCount={pickedMarks.filter((m) => m.workflow === "data-source").length}
          reviewCount={pickedMarks.filter((m) => m.workflow === "review").length}
          entryCount={pickedMarks.filter((m) => m.workflow === "entry").length}
          onAdvance={advanceToReviewPhase}
          onRequestSave={() => { setSaveSkillRunAfter(false); setShowSaveSkill(true); }}
          onAbort={abortTeaching}
          onBack={goBackTeachingPhase}
        />
      )}



      {/* ============ 文件提取审查面板：原图 + 提取字段框 + 同名图片对比 ============ */}
      {/* 网页下载模式下结果内嵌在下方「文件提取配置」面板内，不再弹窗；LOOP/批量执行期间同样不弹（结果存 docExtractsByRecord） */}
      {docExtractPanel && !isAnyRunning && !(addingDocExtractMode && docExtractSource === "web") && (
        <DocExtractReviewPanel
          panel={docExtractPanel}
          onClose={() => {
            setDocExtractPanel(null);
            setSameNameImages(null);
            sourceFieldValueRef.current = "";
            sourceFieldLabelRef.current = "";
          }}
          sameNameImages={sameNameImages}
          findingSameName={findingSameName}
          onFindSameName={findSameNameImages}
          onExtractFields={sendDocFieldsToExtractPanel}
          onExport={() => { recordFileOp("export", "导出文件（格式转换/压缩）"); setDocExportOpen(true); }}
          onBindUpload={startBindUpload}
        />
      )}

      {/* ============ 文件导出对话框：格式转换 + 压缩到指定大小 ============ */}
      {docExportOpen && docExtractPanel && (
        <DocExportDialog
          dataUrl={docExtractPanel.imageUrl}
          filename={docExtractPanel.filename}
          onClose={() => setDocExportOpen(false)}
          onToast={(msg) => setSuccessToast(msg)}
          onError={(msg) => setError(msg)}
        />
      )}

      {/* ============ 绑定上传：拾取中提示横幅 ============ */}
      {uploadBindMode && !uploadBindDraft && (
        <div className="fixed left-1/2 top-4 z-[9999] flex -translate-x-1/2 items-center gap-3 rounded-full bg-orange-500 px-4 py-2 text-xs font-medium text-white shadow-lg">
          <Upload className="h-3.5 w-3.5" />
          <span>绑定上传：点击网页上的文件上传框（或上传按钮）</span>
          <button
            onClick={cancelBindUpload}
            className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] hover:bg-white/30"
          >
            取消
          </button>
        </div>
      )}

      {/* ============ 一键直传：拾取中提示横幅 ============ */}
      {quickUploadMode && (
        <div className="fixed left-1/2 top-4 z-[9999] flex -translate-x-1/2 items-center gap-3 rounded-full bg-emerald-500 px-4 py-2 text-xs font-medium text-white shadow-lg">
          <Upload className="h-3.5 w-3.5" />
          <span>一键直传：点击网页上的文件上传框（或上传按钮）</span>
          <button
            onClick={cancelQuickUpload}
            className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] hover:bg-white/30"
          >
            取消
          </button>
        </div>
      )}

      {/* ============ 绑定上传确认对话框：格式 + 压缩设置 ============ */}
      {uploadBindDraft && (
        <UploadBindDialog
          draft={uploadBindDraft}
          onConfirm={confirmUploadBind}
          onCancel={cancelBindUpload}
        />
      )}

      {/* ============ SKILL 管理面板（含应用 LOOP 模式） ============ */}
      <SkillPanel
        open={showSkillPanel || showApplyLoop}
        applyMode={showApplyLoop && !showSkillPanel}
        onClose={() => { setShowSkillPanel(false); setShowApplyLoop(false); }}
        onRunSkill={(tpl) => { setShowSkillPanel(false); handleRunSkill(tpl); }}
        onApplySkill={handleApplyLoop}
        onEditFlow={(tpl) => { setEditingFlowTemplate(tpl); setShowSkillPanel(false); setShowApplyLoop(false); }}
        onSkillsChange={() => setSkillVersion((v) => v + 1)}
      />

      {/* ============ 流程图编辑器 ============ */}
      {editingFlowTemplate && (
        <LoopEditor
          template={editingFlowTemplate}
          allTemplates={loadSkills()}
          onClose={() => setEditingFlowTemplate(null)}
          onSave={(updated) => { setEditingFlowTemplate(null); setSkillVersion((v) => v + 1); void updated; }}
        />
      )}

      {/* ============ 断点暂停弹窗 ============ */}
      <BreakpointDialog info={breakpointState} onContinue={continueFromBreakpoint} />

      {/* ============ 保存 SKILL 弹窗 ============ */}
      <SaveSkillDialog
        open={showSaveSkill}
        defaultName={`${appMode === "entry" ? "录入" : appMode === "review" ? "审查" : "LOOP"}技能 ${new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })}`}
        onClose={() => { setShowSaveSkill(false); setSaveSkillRunAfter(false); }}
        onSave={(name, icon) => handleSaveSkill(name, icon, false)}
        onSaveAndRun={(name, icon) => handleSaveSkill(name, icon, true)}
      />

      {/* ============ 元素屏蔽：拾取中提示横幅 ============ */}
      {blockPickingSide && (
        <div className="fixed left-1/2 top-4 z-[9999] flex -translate-x-1/2 items-center gap-3 rounded-full bg-red-600 px-4 py-2 text-xs font-medium text-white shadow-lg">
          <EyeOff className="h-3.5 w-3.5" />
          <span>屏蔽模式：点击网页中要隐藏的元素</span>
          <button
            onClick={() => setBlockPickingSide(null)}
            className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] hover:bg-white/30"
          >
            取消
          </button>
        </div>
      )}

      {/* ============ 元素屏蔽：规则管理面板 ============ */}
      {showBlockPanel && (
        <BlockRulesPanel
          side={showBlockPanel}
          url={showBlockPanel === "left" ? leftUrl : rightUrl}
          rules={blockRulesState[`${showBlockPanel}:${getHost(showBlockPanel === "left" ? leftUrl : rightUrl)}`] || []}
          onClose={() => setShowBlockPanel(null)}
          onAddRule={() => {
            setBlockPickingSide(showBlockPanel);
            setShowBlockPanel(null);
          }}
          onRemoveRule={(selector) => {
            const host = getHost(showBlockPanel === "left" ? leftUrl : rightUrl);
            handleRemoveBlockRule(showBlockPanel, host, selector);
          }}
        />
      )}

      {/* ============ 账号密码管理面板 ============ */}
      {showCredentialsPanel && (
        <CredentialsPanel
          currentHost={getHost(showCredentialsPanel === "left" ? leftUrl : rightUrl)}
          credentials={credentials}
          activePasteId={activePasteId}
          pasteStep={pasteStep}
          onAdd={handleAddCredential}
          onRemove={handleRemoveCredential}
          onCopy={(cred) => handleCopyCredential(showCredentialsPanel, cred)}
          onCancelPaste={handleCancelPaste}
          onClose={() => setShowCredentialsPanel(null)}
        />
      )}

      {/* ============ 两段式粘贴激活提示横幅 ============ */}
      {activePasteId && (
        <div className="fixed left-1/2 top-4 z-[9999] flex -translate-x-1/2 items-center gap-3 rounded-full bg-amber-500 px-4 py-2 text-xs font-medium text-white shadow-lg">
          <KeyRound className="h-3.5 w-3.5" />
          <span>
            两段式粘贴已激活：第 {pasteStep + 1} 次Ctrl+V 粘贴{pasteStep === 0 ? "用户名" : "密码"}
          </span>
          <button
            onClick={handleCancelPaste}
            className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] hover:bg-white/30"
          >
            取消
          </button>
        </div>
      )}

      {/* ============ LOOP 执行气泡锚定左栏左下角（LeftPanel 内渲染，不挡卡片） ============ */}

      {/* ============ 「执行进度」视图已融入 LeftPanel 卡片区域（与执行分析同一位置） ============ */}

      {/* ============ 「执行进度」浮动按钮已融入左侧 AI 球体下方（LeftPanel 内渲染） ============ */}
    </div>
  );
}

// ============ 元素屏蔽规则管理面板 ============
function BlockRulesPanel({
  side: _side,
  url,
  rules,
  onClose,
  onAddRule,
  onRemoveRule,
}: {
  side: ViewSide;
  url: string;
  rules: BlockRule[];
  onClose: () => void;
  onAddRule: () => void;
  onRemoveRule: (selector: string) => void;
}) {
  const host = getHost(url);
  return (
    <div className="fixed right-4 top-12 z-[9998] w-72 rounded-lg border border-slate-200 bg-white shadow-xl">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <EyeOff className="h-3.5 w-3.5 text-red-500" />
          <span className="text-xs font-semibold text-slate-700">屏蔽规则</span>
          <span className="text-[10px] text-slate-400">{host}</span>
        </div>
        <button onClick={onClose} className="rounded p-0.5 text-slate-400 hover:bg-slate-100">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-60 overflow-y-auto px-3 py-2">
        {rules.length === 0 ? (
          <p className="py-4 text-center text-[11px] text-slate-400">
            当前网站暂无屏蔽规则
          </p>
        ) : (
          <ul className="space-y-1.5">
            {rules.map((rule) => (
              <li
                key={rule.selector}
                className="flex items-center gap-2 rounded-md bg-slate-50 px-2 py-1.5"
              >
                <div className="shrink-0">
                  {rule.mode === "collapse" ? (
                    <PanelLeftClose className="h-3 w-3 text-indigo-500" />
                  ) : (
                    <EyeOff className="h-3 w-3 text-red-400" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-medium text-slate-600">
                    {rule.label}
                  </p>
                  <p className="truncate text-[9px] text-slate-400" title={rule.selector}>
                    {rule.selector}
                  </p>
                </div>
                <button
                  onClick={() => onRemoveRule(rule.selector)}
                  className="shrink-0 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-500"
                  title="取消屏蔽"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex gap-2 border-t border-slate-100 px-3 py-2">
        <button
          onClick={() => onAddRule()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-red-50 py-1.5 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-100"
        >
          <Plus className="h-3 w-3" />
          隐藏元素
        </button>
      </div>
    </div>
  );
}

// ============ 绑定上传确认对话框组件 ============
// 拾取到 file input 后弹出：显示来源文件槽位 + 目标上传框，可选格式转换 + 压缩到指定大小
function UploadBindDialog({
  draft,
  onConfirm,
  onCancel,
}: {
  draft: {
    side: "left" | "right";
    selector: string;
    clickedSelector: string;
    label: string;
    accept: string;
    sourceMarkId: string | null;
    sourceLabel: string;
  };
  onConfirm: (opts: { compressKb: number; format: string }) => void;
  onCancel: () => void;
}) {
  const [format, setFormat] = useState<string>("original");
  const [compressOn, setCompressOn] = useState(false);
  const [sizeVal, setSizeVal] = useState("500");
  const [sizeUnit, setSizeUnit] = useState<"KB" | "MB">("KB");
  const formats = [
    { key: "original", label: "原格式" },
    { key: "jpg", label: "JPG" },
    { key: "png", label: "PNG" },
    { key: "pdf", label: "PDF" },
  ];
  const handleConfirm = () => {
    let kb = 0;
    if (compressOn) {
      const n = parseFloat(sizeVal);
      if (isFinite(n) && n > 0) kb = Math.round(sizeUnit === "MB" ? n * 1024 : n);
    }
    onConfirm({ compressKb: kb, format });
  };
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/30 backdrop-blur-[2px]" onClick={onCancel}>
      <div
        className="w-[360px] rounded-xl border border-orange-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b border-orange-100 bg-gradient-to-r from-orange-50 to-amber-50 px-3 py-2">
          <Upload className="h-3.5 w-3.5 text-orange-600" />
          <span className="text-[11px] font-semibold text-orange-900">绑定文件上传</span>
          <button
            onClick={onCancel}
            className="ml-auto rounded-md p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
            title="取消"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-3 p-3">
          {/* 来源 → 目标 */}
          <div className="space-y-1.5 rounded-lg bg-slate-50 px-2.5 py-2 text-[10px]">
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 text-slate-400">文件来源</span>
              <span className="min-w-0 flex-1 truncate font-medium text-teal-700" title={draft.sourceLabel}>
                {draft.sourceLabel}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 text-slate-400">上传到</span>
              <span className="min-w-0 flex-1 truncate font-medium text-orange-700" title={draft.selector}>
                {draft.label}（{draft.side === "left" ? "左网页" : "右网页"}）
              </span>
            </div>
            {draft.accept && (
              <div className="flex items-center gap-1.5">
                <span className="shrink-0 text-slate-400">接受格式</span>
                <span className="min-w-0 flex-1 truncate text-slate-600" title={draft.accept}>{draft.accept}</span>
              </div>
            )}
            {draft.clickedSelector !== draft.selector && (
              <div className="text-[9px] text-slate-400">已自动定位隐藏的文件上传框</div>
            )}
          </div>

          {/* 格式选择 */}
          <div>
            <div className="mb-1 text-[10px] font-medium text-slate-500">上传前转换格式</div>
            <div className="grid grid-cols-4 gap-1">
              {formats.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setFormat(opt.key)}
                  className={`rounded-lg border px-1 py-1.5 text-[10px] font-medium transition-all ${
                    format === opt.key
                      ? "border-orange-400 bg-orange-50 text-orange-700 ring-1 ring-orange-200"
                      : "border-slate-200 bg-white text-slate-500 hover:border-orange-200 hover:bg-orange-50/50"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* 压缩设置 */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-medium text-slate-500">上传前压缩到指定大小</span>
              <button
                onClick={() => setCompressOn((v) => !v)}
                className={`relative h-4 w-7 rounded-full transition-colors ${compressOn ? "bg-orange-500" : "bg-slate-300"}`}
                title={compressOn ? "关闭压缩" : "开启压缩"}
              >
                <span
                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${
                    compressOn ? "left-3.5" : "left-0.5"
                  }`}
                />
              </button>
            </div>
            {compressOn && (
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  value={sizeVal}
                  onChange={(e) => setSizeVal(e.target.value)}
                  className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-[11px] text-slate-700 outline-none focus:border-orange-400"
                  placeholder="目标大小"
                />
                <div className="flex overflow-hidden rounded-lg border border-slate-200">
                  {(["KB", "MB"] as const).map((u) => (
                    <button
                      key={u}
                      onClick={() => setSizeUnit(u)}
                      className={`px-2 py-1.5 text-[10px] font-medium transition-colors ${
                        sizeUnit === u ? "bg-orange-500 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                      }`}
                    >
                      {u}
                    </button>
                  ))}
                </div>
                <span className="text-[9px] text-slate-400">自动降质量/缩尺寸</span>
              </div>
            )}
          </div>

          {/* 确认按钮 */}
          <button
            onClick={handleConfirm}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-500 px-2 py-2 text-[11px] font-semibold text-white transition-all hover:bg-orange-600"
          >
            <Check className="h-3.5 w-3.5" />
            确认添加上传步骤
          </button>
        </div>
      </div>
    </div>
  );
}

// ============ 文件提取审查面板组件 ============
// 定位右侧（right-4），避免遮挡左侧 Excel/记录面板，方便左审查
// 关键证件字段（姓/名/办证地点/护照号等）用带色边框卡片框出
const DOC_KEY_FIELDS = ["surname", "given_name", "name", "passport_no", "birth_date", "issue_place", "nationality", "gender", "passport_issue", "passport_expiry", "issue_authority"];
/** 护照号字段：OCR 常把数字 0/1 误识别为 O/I，或把 3 误识别为 NO，归一化时剥离非数字字符 */
const PASSPORT_NO_KEYS = new Set(["passport_no", "passportnumber", "passport_number", "passno", "pass_num", "passport", "护照号", "护照号码", "护照", "pass"]);
function DocExtractReviewPanel({
  panel,
  onClose,
  sameNameImages,
  findingSameName,
  onFindSameName,
  onExtractFields,
  onExport,
  onBindUpload,
}: {
  panel: {
    imageUrl: string;
    filename: string;
    method: string;
    text: string;
    fields: Record<string, string>;
    side: "left" | "right";
    workflow: "entry" | "review";
  };
  onClose: () => void;
  sameNameImages: { left: string[]; right: string[] } | null;
  findingSameName: boolean;
  onFindSameName: () => void;
  /** 勾选字段送到「提取元素」面板 */
  onExtractFields?: (fields: Record<string, string>) => void;
  /** 打开导出对话框 */
  onExport?: () => void;
  /** 绑定上传：把该文件填入网页 file input（生成上传步骤） */
  onBindUpload?: () => void;
}) {
  const [showRawText, setShowRawText] = useState(false);
  // 字段勾选：默认全部勾选（仅勾有值的字段）
  const [checkedFields, setCheckedFields] = useState<Set<string>>(
    () => new Set(Object.entries(panel.fields || {}).filter(([, v]) => v).map(([f]) => f))
  );
  const isImage = /\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/i.test(panel.imageUrl) || panel.method === "vision_ocr";
  const fieldEntries = Object.entries(panel.fields || {});
  const keyEntries = fieldEntries.filter(([f]) => DOC_KEY_FIELDS.includes(f));
  const otherEntries = fieldEntries.filter(([f]) => !DOC_KEY_FIELDS.includes(f));
  const toggleField = (f: string) => {
    setCheckedFields((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };
  const checkedCount = checkedFields.size;
  return (
    <div className="pointer-events-auto fixed right-4 top-16 z-50 w-[440px] max-h-[82vh] overflow-y-auto rounded-xl border border-teal-200 bg-white/97 shadow-2xl backdrop-blur-xl">
      {/* 头部 */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-teal-100 bg-gradient-to-r from-teal-50 to-cyan-50 px-3 py-2">
        <span className="text-[11px] font-semibold text-teal-900">文件提取</span>
        <span className={[
          "rounded-full px-1.5 py-0.5 text-[9px] font-bold",
          panel.workflow === "entry" ? "bg-violet-100 text-violet-700" : "bg-sky-100 text-sky-700",
        ].join(" ")}>
          {panel.workflow === "entry" ? "录入提取" : "审查提取"}
        </span>
        <span className="max-w-[140px] truncate text-[10px] text-slate-400" title={panel.filename}>
          {panel.filename}
        </span>
        <button
          onClick={onClose}
          className="ml-auto rounded-md p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
          title="关闭面板"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-2.5 p-3">
        {/* 原图 */}
        {isImage && (
          <div>
            <div className="mb-1 text-[10px] font-medium text-slate-500">原图</div>
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
              <img src={panel.imageUrl} alt={panel.filename} className="max-h-52 w-full object-contain" />
            </div>
          </div>
        )}

        {/* 提取字段：关键字段用带色边框卡片框出，可勾选后送到「提取元素」面板 */}
        {fieldEntries.length > 0 ? (
          <div>
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-slate-500">
              提取信息（{fieldEntries.length} 个字段）
              <span className="text-[9px] font-normal text-slate-400">勾选后可送到「提取元素」面板</span>
              <button
                onClick={() =>
                  setCheckedFields((prev) =>
                    prev.size === fieldEntries.length ? new Set() : new Set(fieldEntries.map(([f]) => f))
                  )
                }
                className="ml-auto rounded px-1 py-0.5 text-[9px] text-teal-600 hover:bg-teal-50"
              >
                {checkedFields.size === fieldEntries.length ? "全不选" : "全选"}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {keyEntries.map(([f, v]) => (
                <div
                  key={f}
                  onClick={() => v && toggleField(f)}
                  className={[
                    "relative cursor-pointer rounded-lg border-2 px-2 py-1 transition-all",
                    checkedFields.has(f)
                      ? "border-teal-400 bg-teal-50/60"
                      : v
                      ? "border-slate-200 bg-white opacity-60"
                      : "border-dashed border-slate-200 bg-slate-50/50 opacity-60",
                  ].join(" ")}
                  title={v ? (checkedFields.has(f) ? "点击取消勾选" : "点击勾选") : "未提取到"}
                >
                  <div className="flex items-center gap-1 text-[9px] font-medium text-teal-700">
                    <span
                      className={`inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-sm border ${
                        checkedFields.has(f) ? "border-teal-500 bg-teal-500 text-white" : "border-slate-300 bg-white"
                      }`}
                    >
                      {checkedFields.has(f) && <Check className="h-2 w-2" />}
                    </span>
                    {FIELD_LABELS[f] || f}
                  </div>
                  <div className={["truncate text-[11px] font-semibold", v ? "text-slate-800" : "text-slate-300"].join(" ")} title={v}>
                    {v || "未提取到"}
                  </div>
                </div>
              ))}
              {otherEntries.map(([f, v]) => (
                <div
                  key={f}
                  onClick={() => v && toggleField(f)}
                  className={[
                    "relative cursor-pointer rounded-lg border px-2 py-1 transition-all",
                    checkedFields.has(f) ? "border-teal-300 bg-teal-50/40" : "border-slate-200 bg-white",
                    !v && "opacity-60",
                  ].join(" ")}
                  title={v ? (checkedFields.has(f) ? "点击取消勾选" : "点击勾选") : "未提取到"}
                >
                  <div className="flex items-center gap-1 text-[9px] font-medium text-slate-500">
                    <span
                      className={`inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-sm border ${
                        checkedFields.has(f) ? "border-teal-500 bg-teal-500 text-white" : "border-slate-300 bg-white"
                      }`}
                    >
                      {checkedFields.has(f) && <Check className="h-2 w-2" />}
                    </span>
                    {FIELD_LABELS[f] || f}
                  </div>
                  <div className={["truncate text-[11px]", v ? "text-slate-700" : "text-slate-300"].join(" ")} title={v}>
                    {v || "—"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-lg bg-amber-50 px-2 py-1.5 text-[10px] text-amber-700">
            未提取到结构化字段，可查看下方原始文字
          </div>
        )}

        {/* 操作按钮：提取元素（勾选字段送「提取元素」面板）+ 导出（格式转换+压缩）+ 绑定上传（填入网页上传框） */}
        {(onExtractFields || onExport || onBindUpload) && (
          <div className="flex items-center gap-1.5">
            {onExtractFields && (
              <button
                onClick={() => {
                  const picked: Record<string, string> = {};
                  for (const [f, v] of fieldEntries) {
                    if (checkedFields.has(f) && v) picked[f] = v;
                  }
                  if (Object.keys(picked).length === 0) return;
                  onExtractFields(picked);
                }}
                disabled={checkedCount === 0}
                className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-all ${
                  checkedCount === 0
                    ? "cursor-not-allowed bg-slate-100 text-slate-400"
                    : "bg-violet-600 text-white hover:bg-violet-700"
                }`}
                title={checkedCount === 0 ? "请先勾选字段" : `把勾选的 ${checkedCount} 个字段送到「提取元素」面板`}
              >
                <Database className="h-3 w-3" />
                提取元素{checkedCount > 0 ? ` (${checkedCount})` : ""}
              </button>
            )}
            {onExport && (
              <button
                onClick={onExport}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-teal-600 px-2 py-1.5 text-[11px] font-medium text-white transition-all hover:bg-teal-700"
                title="导出文件：可选格式转换 + 压缩到指定大小"
              >
                <FileDown className="h-3 w-3" />
                导出
              </button>
            )}
            {onBindUpload && (
              <button
                onClick={onBindUpload}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-orange-500 px-2 py-1.5 text-[11px] font-medium text-white transition-all hover:bg-orange-600"
                title="绑定上传：点击网页上的文件上传框，LOOP 执行时自动把该文件填入"
              >
                <Upload className="h-3 w-3" />
                绑定上传
              </button>
            )}
          </div>
        )}

        {/* 原始提取文字（折叠） */}
        {panel.text && (
          <div>
            <button
              onClick={() => setShowRawText((s) => !s)}
              className="text-[10px] font-medium text-slate-500 hover:text-teal-700"
            >
              {showRawText ? "▾ 收起原始文字" : "▸ 查看原始提取文字"}
            </button>
            {showRawText && (
              <pre className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-600">
                {panel.text.slice(0, 3000)}
              </pre>
            )}
          </div>
        )}

        {/* 查找同名图片左右对比 */}
        <div className="border-t border-slate-100 pt-2">
          <button
            onClick={onFindSameName}
            disabled={findingSameName}
            className={[
              "flex w-full items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-all",
              findingSameName ? "cursor-wait bg-slate-100 text-slate-400" : "bg-indigo-600 text-white hover:bg-indigo-700",
            ].join(" ")}
          >
            {findingSameName ? "正在左右网页查找同名图片…" : "查找同名图片 · 左右对比"}
          </button>
          {sameNameImages && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {/* 左侧网页找到的图片 */}
              <div>
                <div className="mb-1 text-center text-[9px] font-medium text-slate-500">
                  左侧网页 · {sameNameImages.left.length} 张
                </div>
                {sameNameImages.left.length > 0 ? (
                  <div className="space-y-1">
                    {sameNameImages.left.slice(0, 3).map((src) => (
                      <img key={src} src={src} alt="左侧同名图" className="h-20 w-full rounded-md border border-violet-200 object-contain bg-slate-50" />
                    ))}
                  </div>
                ) : (
                  <div className="flex h-20 items-center justify-center rounded-md border border-dashed border-slate-200 text-[9px] text-slate-400">
                    未找到同名图片
                  </div>
                )}
              </div>
              {/* 右侧网页找到的图片 */}
              <div>
                <div className="mb-1 text-center text-[9px] font-medium text-slate-500">
                  右侧网页 · {sameNameImages.right.length} 张
                </div>
                {sameNameImages.right.length > 0 ? (
                  <div className="space-y-1">
                    {sameNameImages.right.slice(0, 3).map((src) => (
                      <img key={src} src={src} alt="右侧同名图" className="h-20 w-full rounded-md border border-sky-200 object-contain bg-slate-50" />
                    ))}
                  </div>
                ) : (
                  <div className="flex h-20 items-center justify-center rounded-md border border-dashed border-slate-200 text-[9px] text-slate-400">
                    未找到同名图片
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============ 教学引导浮层组件 ============
function TeachingGuide({
  phase,
  appMode,
  pickedMarks,
  hasSearchSteps,
  hasSubmitStep,
  dataSourceCount,
  reviewCount,
  entryCount,
  onAdvance,
  onRequestSave,
  onAbort,
  onBack,
}: {
  phase: TeachingPhase;
  appMode: AppMode;
  pickedMarks: PickedMark[];
  hasSearchSteps: boolean;
  hasSubmitStep: boolean;
  dataSourceCount: number;
  reviewCount: number;
  entryCount: number;
  onAdvance: () => void;
  onRequestSave: () => void;
  onAbort: () => void;
  onBack: () => void;
}) {
  // 当前阶段步骤定义
  // review 模式使用统一的 LOOP 流程步骤（灵活绑定：左右侧、次数均不限）
  const loopSteps = [
    { n: 1, title: "选中 Excel LOOP 列", desc: "在左侧 Excel 视图点击一列表头，将其作为 LOOP 变量（如学号/姓名）", done: pickedMarks.some((m) => m.action === "input" && !!m.variableField) },
    { n: 2, title: "点「绑定输入框/点击」，再点任意侧输入框", desc: "点左或右侧网页的搜索输入框，自动绑定 Excel 列并真实填入第一行值", done: pickedMarks.some((m) => m.action === "input" && !!m.variableField) },
    { n: 3, title: "自由配置：输入框=填入，按钮=真实点击", desc: "左右侧不限、次数不限：点输入框继续绑定填入，点搜索/人物等按钮记录真实点击；点错可再点同一元素回收", done: pickedMarks.some((m) => m.action === "click") },
    { n: 4, title: "保存为 SKILL", desc: "全部设置完后点「保存为 SKILL」，命名选图标后即可复用", done: false },
  ];
  // 录入流步骤：打开新增表单 → 逐字段填入 → 提交
  const entrySteps = [
    { n: 1, title: "打开学校网站新增表单", desc: "在右侧 BrowserPane 打开学校网站的「新增学生」表单页面", done: true },
    { n: 2, title: "配置第一个字段：点表单输入框 → 按 S → 点 Excel 字段", desc: "点击右侧表单第一个输入框，按 S，再切到左侧 Excel 点对应字段。系统将学会这个字段的填法", done: entryCount >= 1 },
    { n: 3, title: "继续配置其他字段", desc: "对表单里每个字段重复：点输入框 → 按 S → 点 Excel 字段。配置所有需要填的字段", done: entryCount >= 3 },
    { n: 4, title: "配置点击保存/提交按钮", desc: "全部字段填完后，按空格键进入点击模式，点击表单的保存/提交按钮", done: pickedMarks.some((m) => m.action === "click" && m.workflow === "entry") },
    { n: 5, title: "保存为 SKILL", desc: "全部配置完点「保存为 SKILL」，命名选图标后即可复用", done: false },
  ];

  const steps = appMode === "entry" ? entrySteps : loopSteps;
  const currentStep = steps.find((s) => !s.done) || steps[steps.length - 1];
  const completedCount = steps.filter((s) => s.done).length;
  const progress = Math.round((completedCount / steps.length) * 100);

  const phaseTitle = appMode === "entry" ? "步骤配置 · 录入流：把数据填入学校网站" : "步骤配置 · LOOP 流程";

  return (
    <div className="pointer-events-auto fixed bottom-4 left-1/2 z-40 w-[min(560px,calc(100vw-2rem))] -translate-x-1/2">
      <div className="overflow-hidden rounded-xl border border-indigo-200 bg-white/95 shadow-2xl backdrop-blur-xl">
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b border-indigo-100 bg-gradient-to-r from-indigo-50 to-violet-50 px-4 py-2">
          <ListChecks className="h-4 w-4 text-indigo-600" />
          <span className="text-[12px] font-semibold text-indigo-900">
            {phaseTitle}
          </span>
          <span className="ml-auto text-[10px] text-indigo-700">
            {completedCount}/{steps.length} 步
          </span>
          <button
            onClick={onAbort}
            className="rounded p-0.5 text-indigo-400 hover:bg-indigo-100 hover:text-rose-600"
            title="取消配置"
          >
            <X className="h-3 w-3" />
          </button>
        </div>

        {/* 进度条 */}
        <div className="h-1 bg-indigo-100">
          <div
            className="h-full bg-indigo-500 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* 当前步骤高亮 */}
        <div className="px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-500 text-[10px] font-bold text-white">
              {currentStep.n}
            </span>
            <span className="text-[12px] font-semibold text-slate-800">{currentStep.title}</span>
          </div>
          <p className="pl-7 text-[11px] leading-relaxed text-slate-600">{currentStep.desc}</p>

          {/* 快捷键提示卡 */}
          <div className="mt-3 grid grid-cols-2 gap-1.5 pl-7 text-[10px]">
            <div className="flex items-center gap-1 rounded bg-slate-50 px-1.5 py-1">
              <kbd className="rounded bg-blue-100 px-1 font-mono text-[9px] text-blue-700">S</kbd>
              <span className="text-slate-600">输入模式</span>
            </div>
            <div className="flex items-center gap-1 rounded bg-slate-50 px-1.5 py-1">
              <kbd className="rounded bg-emerald-100 px-1 font-mono text-[9px] text-emerald-700">Space</kbd>
              <span className="text-slate-600">点击模式</span>
            </div>
            <div className="flex items-center gap-1 rounded bg-slate-50 px-1.5 py-1">
              <kbd className="rounded bg-slate-200 px-1 font-mono text-[9px]">R</kbd>
              <span className="text-slate-600">撤销上一步</span>
            </div>
            <div className="flex items-center gap-1 rounded bg-slate-50 px-1.5 py-1">
              <kbd className="rounded bg-emerald-200 px-1 font-mono text-[9px] text-emerald-700">Enter</kbd>
              <span className="text-slate-600">完成本段</span>
            </div>
          </div>
        </div>

        {/* 步骤清单 */}
        <details className="border-t border-indigo-100">
          <summary className="cursor-pointer px-4 py-1.5 text-[10px] text-indigo-700 hover:bg-indigo-50">
            查看所有步骤 ▾
          </summary>
          <ol className="px-4 pb-3">
            {steps.map((s) => (
              <li key={s.n} className="flex items-start gap-2 py-0.5 text-[11px]">
                <span
                  className={[
                    "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[8px] font-bold",
                    s.done ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-500",
                  ].join(" ")}
                >
                  {s.done ? "✓" : s.n}
                </span>
                <span className={s.done ? "text-slate-400 line-through" : "text-slate-700"}>
                  <span className="font-medium">{s.title}</span>
                  <span className="ml-1 text-slate-400">— {s.desc}</span>
                </span>
              </li>
            ))}
          </ol>
        </details>

        {/* 底部行动按钮 */}
        <div className="flex items-center gap-2 border-t border-indigo-100 bg-indigo-50/50 px-4 py-2">
          {/* 上一步：回退到前一阶段 */}
          <button
            onClick={onBack}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-slate-600 transition-all hover:bg-slate-100 hover:text-slate-800"
            title="回退到上一步（清除当前阶段的拾取）"
          >
            <ArrowLeft className="h-3 w-3" />
            上一步
          </button>
          {appMode !== "entry" && phase === "data-source" && (
            <button
              onClick={onAdvance}
              disabled={dataSourceCount === 0}
              className={[
                "rounded-md px-2 py-1 text-[11px] font-medium transition-all",
                dataSourceCount === 0
                  ? "cursor-not-allowed text-slate-400"
                  : "text-indigo-700 hover:bg-indigo-100",
              ].join(" ")}
              title="添加审查步骤（可选）"
            >
              添加审查步骤 →
            </button>
          )}
          <button
            onClick={onRequestSave}
            disabled={appMode === "entry" ? entryCount === 0 : dataSourceCount + reviewCount === 0}
            className={[
              "ml-auto flex items-center gap-1 rounded-md px-3 py-1 text-[11px] font-medium transition-all",
              (appMode === "entry" ? entryCount === 0 : dataSourceCount + reviewCount === 0)
                ? "bg-slate-200 text-slate-400 cursor-not-allowed"
                : "bg-emerald-600 text-white hover:bg-emerald-700",
            ].join(" ")}
            title="保存为 SKILL 模板"
          >
            <Sparkles className="h-3 w-3" />
            保存为 SKILL
          </button>
        </div>

        {/* 警告：审查流未检测到搜索步骤 */}
        {appMode !== "entry" && !hasSearchSteps && (
          <div className="border-t border-rose-100 bg-rose-50/70 px-4 py-1.5 text-[10px] text-rose-700">
            ⚠ 未检测到 LOOP 搜索步骤，批量执行时可能无法定位其他学生
          </div>
        )}
        {/* 警告：录入流未检测到提交步骤 */}
        {phase === "entry" && !hasSubmitStep && entryCount > 0 && (
          <div className="border-t border-rose-100 bg-rose-50/70 px-4 py-1.5 text-[10px] text-rose-700">
            ⚠ 未检测到点击保存/提交按钮，批量执行时不会自动提交
          </div>
        )}
      </div>
    </div>
  );
}

// ============ 批量执行进度（内联横排，嵌入顶部工具栏中央空白区） ============
function BatchProgressInline({
  cursor,
  total,
  results,
  records,
  onStop,
}: {
  cursor: number;
  total: number;
  results: Record<string, BatchResult>;
  records: ApplicantRecord[];
  onStop: () => void;
}) {
  const successCount = Object.values(results).filter((r) => r.status === "success").length;
  const failedCount = Object.values(results).filter((r) => r.status === "failed").length;
  const progress = total > 0 ? Math.round(((cursor + 1) / total) * 100) : 0;
  const currentName = cursor >= 0 && cursor < records.length
    ? (records[cursor].fields.name || records[cursor].record_id)
    : null;

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] ring-1 ring-emerald-200 animate-slide-up">
      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-emerald-600" />
      <span className="shrink-0 font-semibold text-emerald-900">批量执行</span>
      <span className="shrink-0 text-[10px] text-emerald-700">
        {cursor + 1}/{total}
      </span>
      {/* 进度条 */}
      <div className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-emerald-100">
        <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} />
      </div>
      {/* 统计横放 */}
      <span className="shrink-0 text-[10px] text-slate-500">
        <b className="text-emerald-600">{successCount}</b> 成功
      </span>
      <span className="shrink-0 text-[10px] text-slate-500">
        <b className="text-rose-600">{failedCount}</b> 失败
      </span>
      <span className="shrink-0 text-[10px] text-slate-500">
        <b className="text-slate-600">{total - successCount - failedCount}</b> 待执行
      </span>
      {currentName && (
        <span className="min-w-0 truncate text-[10px] text-slate-400">
          正在执行 <b className="font-medium text-slate-700">{currentName}</b>
        </span>
      )}
      {/* 停止按钮 */}
      <button
        onClick={onStop}
        className="ml-1 shrink-0 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 transition-colors hover:bg-rose-200"
        title="停止批量执行"
      >
        停止
      </button>
    </div>
  );
}
