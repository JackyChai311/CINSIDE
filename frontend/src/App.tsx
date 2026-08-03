import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Activity,
  ArrowLeft,
  ArrowLeftRight,
  Bot,
  Check,
  CheckCircle2,
  ClipboardCheck,
  ClipboardEdit,
  Clock,
  Database,
  EyeOff,
  FileDown,
  FileSpreadsheet,
  Globe,
  GraduationCap,
  KeyRound,
  ListChecks,
  Loader2,
  Minus,
  MousePointerClick,
  PanelBottom,
  PanelLeft,
  PanelLeftClose,
  Play,
  Plus,
  Repeat2,
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
  X,
  XCircle,
} from "lucide-react";
import { api, subscribeTask } from "./api/client";
import appIconPng from "./assets/app-icon.png";
import DocExportDialog from "./components/DocExportDialog";
import splashSvg from "./assets/splash.svg";
import type {
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
import { normalizeText, parseDateCandidates, valuesEquivalent } from "./utils/formatNormalize";
import WidgetExtractPanel, { type WidgetBinding, type WidgetTestResult } from "./components/WidgetExtractPanel";
import {
  buildCalendarSetScript,
  buildOptionSelectScript,
  buildWidgetCloseScript,
  buildWidgetOpenScript,
  buildWidgetReadScript,
  buildWidgetSnapshotScript,
  type CalendarSetResult,
  type OptionSelectResult,
  type WidgetReadResult,
  type WidgetSnapshotResult,
} from "./lib/widgetScripts";
import LeftPanel from "./components/LeftPanel";
import BrowserPane, { type PickedElementInfo } from "./components/BrowserPane";
import ExcelView, { type ExcelPickedField } from "./components/ExcelView";
import ElementSelectBar, { type PickTarget, type CustomTextEntry } from "./components/ElementSelectBar";
import ResultsPanel from "./components/ResultsPanel";
import SettingsModal from "./components/SettingsModal";
import DocFillDialog from "./components/DocFillDialog";
import SkillPanel from "./components/SkillPanel";
import SaveSkillDialog from "./components/SaveSkillDialog";
import CredentialsPanel from "./components/CredentialsPanel";
import DocLocalExtractConfig from "./components/DocLocalExtractConfig";
import ExecutionBubbles from "./components/ExecutionBubbles";
import ExecutionPanel from "./components/ExecutionPanel";
import { saveSkill, getSkillById } from "./lib/skills";
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
const sanitizeSelector = (sel: string): string =>
  (sel || "").replace(/\.cinside-[a-z0-9_-]+/gi, "");

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

/** 控件快照失败原因 → 人类可读提示 */
const WIDGET_SNAPSHOT_REASONS: Record<string, string> = {
  trigger_not_found: "未在网页中找到该元素，请重新拾取",
  panel_not_found: "点击后未检测到展开的面板，请确认点的是「可展开的框框」",
  options_empty: "面板展开后未识别到选项，请确认这是点击展开选项的控件",
  calendar_header_not_found: "未识别到日历的年月显示，请确认点的是日历控件",
  calendar_nav_not_found: "未识别到日历的翻页按钮（上一月/下一月）",
  calendar_days_not_found: "未识别到日历的日期格子",
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

const DEFAULT_SETTINGS: AppSettings = {
  agent_backend: "browser_use",
  vision_api_base: "",
  vision_api_key: "",
  vision_model: "",
  browser_use_llm_base: "",
  browser_use_llm_key: "",
  browser_use_llm_model: "",
  prevent_accidental_close: false,
};

type VerifyStatus = "idle" | "scanning" | "match" | "mismatch";

function getDetachMode(): string | null {
  const params = new URLSearchParams(window.location.search);
  const d = params.get("detach");
  return d || null;
}

// ============ 脱离模式：左侧数据源面板 ============
function DetachedLeftPanel() {
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
function DetachedBottomPanel() {
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
  const [addingClickPhase, setAddingClickPhaseState] = useState<"pre" | "post" | null>(null);
  const [addingDocExtractMode, setAddingDocExtractMode] = useState(false);
  const [bindStepCount, setBindStepCount] = useState(0);
  const [preClickCount, setPreClickCount] = useState(0);
  const [postClickCount, setPostClickCount] = useState(0);
  const [docExtractStepCount, setDocExtractStepCount] = useState(0);
  const [hasBoundInputs, setHasBoundInputs] = useState(false);
  const [hasConfirmClick, setHasConfirmClick] = useState(false);
  const [cardsGenerated, setCardsGenerated] = useState(false);
  const [rowRange, setRowRange] = useState<{ start: number; end: number } | null>(null);
  const [hasCheckedBatch, setHasCheckedBatch] = useState(false);

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
        addingClickPhase?: "pre" | "post" | null;
        addingDocExtractMode?: boolean;
        bindStepCount?: number;
        preClickCount?: number;
        postClickCount?: number;
        docExtractStepCount?: number;
        hasBoundInputs?: boolean;
        hasConfirmClick?: boolean;
        cardsGenerated?: boolean;
        rowRange?: { start: number; end: number } | null;
        hasCheckedBatch?: boolean;
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
      if ("postClickCount" in s) setPostClickCount(Number(s.postClickCount ?? 0));
      if ("docExtractStepCount" in s) setDocExtractStepCount(Number(s.docExtractStepCount ?? 0));
      if ("hasBoundInputs" in s) setHasBoundInputs(Boolean(s.hasBoundInputs));
      if ("hasConfirmClick" in s) setHasConfirmClick(Boolean(s.hasConfirmClick));
      if ("cardsGenerated" in s) setCardsGenerated(Boolean(s.cardsGenerated));
      if ("rowRange" in s) setRowRange(s.rowRange ?? null);
      if ("hasCheckedBatch" in s) setHasCheckedBatch(Boolean(s.hasCheckedBatch));
    });
    // 主动请求主窗口广播当前状态（解决广播早于监听注册的时序竞态）
    window.electronAPI?.panelSendAction("request-state", "bottom");
    return off;
  }, []);

  const handleRemoveMapping = (index: number) => {
    window.electronAPI?.panelSendAction("remove-mapping", index);
  };

  // 脱离小窗口：步骤设置模式下，默认显示「步骤设置·元素选择」，点切换看「字段映射」
  const [bottomView, setBottomView] = useState<"steps" | "results">("steps");
  useEffect(() => {
    if (selectMode) setBottomView("steps");
  }, [selectMode]);

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex shrink-0 items-center gap-2 border-b border-slate-200/60 bg-white/80 px-3 py-1"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <span className="text-xs font-medium text-slate-600">核验结果</span>
        {selectMode && (
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
        {/* 步骤设置模式下：默认全屏显示 ElementSelectBar；切换才看 ResultsPanel */}
        {selectMode && bottomView === "steps" ? (
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
              postClickCount={postClickCount}
              onStartAddPreClick={() => window.electronAPI?.panelSendAction("start-add-pre-click", undefined)}
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
            />
            {/* 步骤设置面板：下面板分离后，TeachingGuide 在此渲染（而非主窗口） */}
            {teachingPhase !== "idle" && !selectMode && (
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
  const [url, setUrl] = useState<string>("");
  const [picking, setPicking] = useState(false);
  const [popupActive, setPopupActive] = useState(false);
  const side: ViewSide = detachSide === "browser-left" ? "left" : "right";
  const title = detachSide === "browser-left" ? "数据源网页" : "学校系统";

  useEffect(() => {
    document.title = title;
  }, [title]);

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
          enableTabs={detachSide === "browser-right"}
          onClosePopup={() => window.electronAPI?.popupClose(side)}
        />
      </div>
    </div>
  );
}

// ============ 脱离模式：Excel 视图面板 ============
function DetachedExcelPanel() {
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
  // LOOP 分段提取：Excel 行范围框选（0-based 闭区间）与人物卡片生成状态
  // 人物卡片只在用户框选好 LOOP 行范围后一键生成，而非上传 Excel 即全量生成
  const [rowRange, setRowRange] = useState<{ start: number; end: number } | null>(null);
  const [cardsGenerated, setCardsGenerated] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [backendReady, setBackendReady] = useState(!window.electronAPI);
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
  // Excel 视图脱离
  const [excelDetached, setExcelDetached] = useState(false);
  // 弹窗（window.open 拦截）：记录哪个 side 的弹窗处于激活状态
  const [popupSide, setPopupSide] = useState<ViewSide | null>(null);
  // 左侧视图模式：网页 / Excel
  const [leftViewMode, setLeftViewMode] = useState<"web" | "excel">("web");
  // 右侧视图模式：网页 / Excel
  const [rightViewMode, setRightViewMode] = useState<"web" | "excel">("web");
  // 右侧Excel数据
  const [rightRecords, setRightRecords] = useState<ApplicantRecord[]>([]);
  const [rightExcelUploading, setRightExcelUploading] = useState(false);
  const rightExcelInputRef = useRef<HTMLInputElement>(null);
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

  // 两个浏览器面板的宽度比例（左侧面板百分比）
  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(50);
  const draggingRef = useRef(false);

  // 底部审查面板的高度比例（百分比），审查流操作时自动收窄
  const [bottomPanelHeight, setBottomPanelHeight] = useState<number>(20);
  const vDraggingRef = useRef(false);

  // 教学侧边面板：宽度比例（百分比）和左右位置
  const [teachingPanelWidth, setTeachingPanelWidth] = useState<number>(33);
  const [teachingPanelSide, setTeachingPanelSide] = useState<"left" | "right">("left");
  const teachingDragRef = useRef(false);

  // 两个网页的 URL
  // 数据源网页默认 DEMO 地址（模拟原 admin 数据源站点）
  // 左侧默认打开 DEMO 数据源管理页面（后端静态服务）
  const [leftUrl, setLeftUrl] = useState<string>("");
  const [rightUrl, setRightUrl] = useState<string>("");

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
  const [pickTarget, setPickTarget] = useState<PickTarget>("right");
  const [rightPicked, setRightPicked] = useState<PickedElementInfo | null>(null);
  const [leftPicked, setLeftPicked] = useState<PickedElementInfo | null>(null);
  const rightPickedRef = useRef<PickedElementInfo | null>(null);
  rightPickedRef.current = rightPicked;
  const [mappings, setMappings] = useState<FieldMapping[]>([]);

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
// 当前添加的点击阶段：pre=前置点击(搜索/进入，步骤3)，post=收尾点击(保存/返回，步骤5)
const [addingClickPhase, setAddingClickPhase] = useState<"pre" | "post" | null>(null);
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
// 源文件预览（嵌套在文件提取配置面板里的持久预览窗口；字段送「提取元素」后仍保留）
const [docSourcePreview, setDocSourcePreview] = useState<{
  imageUrl: string;
  filename: string;
  method: string;
} | null>(null);
const docSourcePreviewRef = useRef(docSourcePreview);
docSourcePreviewRef.current = docSourcePreview;
// 退出文件提取模式时自动关闭两栏分屏并清空预览
useEffect(() => {
  if (!addingDocExtractMode) {
    setDocExtractSplitView(false);
    setDocSourcePreview(null);
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
// 暂存已下载但尚未触发 OCR 的文件数据（预览后点击「录入提取」才消费）
const pendingWebFileRef = useRef<{ dataUrl: string; filename: string; size: number; side: "left" | "right" } | null>(null);
// 后台OCR预提取结果缓存（LOOP模式下下载后立即开OCR，结果缓存供triggerWebExtract复用）
const bgOcrResultRef = useRef<{ dataUrl: string; result: Awaited<ReturnType<typeof api.extractDocumentFile>> } | null>(null);
// 保底机制：等待人工确认文件的 Promise resolve
const fallbackWaitResolveRef = useRef<((file: { filename: string; dataUrl: string; size: number; mime: string } | null) => void) | null>(null);
// LOOP执行时当前记录的开头点击步骤数（供保底机制回退页面用）
const currentPreClickCountRef = useRef(0);
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
const [customTextPickingId, setCustomTextPickingId] = useState<string | null>(null);
const customTextPickingIdRef = useRef<string | null>(null);
customTextPickingIdRef.current = customTextPickingId;
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
// 正在从左侧网页拾取来源的 key（"draft" 或 "saved:<selector>"）
const [widgetLeftPickingKey, setWidgetLeftPickingKey] = useState<string | null>(null);
const widgetLeftPickingKeyRef = useRef<string | null>(null);
widgetLeftPickingKeyRef.current = widgetLeftPickingKey;
// 控件试跑结果 / 执行中
const [widgetTestResults, setWidgetTestResults] = useState<Record<string, WidgetTestResult>>({});
const [widgetTestBusyKey, setWidgetTestBusyKey] = useState<string | null>(null);
// 文件提取审查面板数据（原图 + 提取字段框 + 同名图片对比）
const [docExtractPanel, setDocExtractPanel] = useState<{
  imageUrl: string;
  filename: string;
  method: string;
  text: string;
  fields: Record<string, string>;
  side: "left" | "right";
  workflow: "entry" | "review";
} | null>(null);
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
  // 收尾点击数量（步骤5：保存/返回）
  const postClickCount = useMemo(() => pickedMarks.filter((m) => m.action === "click" && m.clickPhase === "post").length, [pickedMarks]);
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
      setNextClickLabel(currentPhase === "post" ? "收尾点击" : "前置点击");
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
  const batchStopRef = useRef(false);
  const runBatchRef = useRef<((tplOverride?: WorkflowTemplate, targetIds?: string[]) => Promise<void>) | null>(null);
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
  const [showSaveSkill, setShowSaveSkill] = useState(false);
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

  // ============ 功能1：网页文档提取（PDF/图片 → MarkItDown/OCR → 左右对比） ============
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
  } | null>(null);
  const [docFileExtracting, setDocFileExtracting] = useState(false);
  const [docFilling, setDocFilling] = useState(false);

  // ============ 功能3：单卡 LOOP 执行（点击人物卡片 → 自动导航到该人页面） ============
  const [singleRunning, setSingleRunning] = useState(false);

  // 审查流操作时自动收窄底部面板，退出后恢复用户之前的高度；教学模式下自动打开面板
  const savedBottomHeightRef = useRef<number>(20);
  useEffect(() => {
    if (selectMode) {
      // 进入选择模式：自动打开面板，保存当前高度并收窄
      setBottomPanelOpen(true);
      savedBottomHeightRef.current = bottomPanelHeight;
      setBottomPanelHeight(34);
    } else {
      // 退出选择模式：恢复到用户之前的高度（而不是硬编码 55）
      setBottomPanelHeight(savedBottomHeightRef.current);
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
          var el = null;
          try { el = __cinsideDeepQuery(${JSON.stringify(sanitizeSelector(selector))}); } catch(e) { el = null; }
          if (!el) return { ok: false, reason: 'not_found' };
          try { el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }); } catch(e) {}
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
                el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
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
  useEffect(() => {
    if (isAnyRunning) setEdgeButtonVisible(false);
  }, [isAnyRunning]);

  const [steps, setSteps] = useState<VerificationStep[]>([]);
  const [shots, setShots] = useState<ScreenshotEvent[]>([]);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [report, setReport] = useState<VerificationReport | null>(null);
  // LOOP 批量执行时按人物拆分的报告（每人一个），用于验证报告 Tab 的卡片化展示
  const [loopReports, setLoopReports] = useState<VerificationReport[]>([]);
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
  const [waitingManual, setWaitingManual] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<VerifyStatus>("idle");
  // 每条记录的核验结论：record_id -> overall（pass/fail/review）
  const [recordResults, setRecordResults] = useState<Record<string, Overall>>({});
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
        ? `输入「${valueToFill.slice(0, 18)}${valueToFill.length > 18 ? "…" : ""}」← Excel「${excelField}」 · 变量:${excelField}`
        : `输入「${valueToFill.slice(0, 18)}${valueToFill.length > 18 ? "…" : ""}」← 网页`,
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
    // 只清空验证/任务状态，保留 Excel 数据（records）和卡片池
    setSelectedId(null);
    setRowRange(null);
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
  /** 后端自动识别的列映射（原始列名 -> 标准字段名），用于过滤Excel表头中的别名列和自动初始化fieldColumnMap */
  const [detectedColumnMap, setDetectedColumnMap] = useState<Record<string, string>>({});

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

  // 一键生成人物卡片：按框选的行范围切片，追加到卡片池
  const generateCards = useCallback(() => {
    if (!rowRange || records.length === 0) return;
    const slice = records.slice(rowRange.start, rowRange.end + 1);
    // 深拷贝 + 生成唯一 record_id（避免不同 Excel 的 ID 冲突）
    const newCards: ApplicantRecord[] = slice.map((r) => ({
      ...r,
      fields: { ...r.fields },
      passport_fields: r.passport_fields ? { ...r.passport_fields } : undefined,
      // 生成唯一 ID：原 ID + 短随机后缀
      record_id: `${r.record_id}__${Math.random().toString(36).slice(2, 8)}`,
    }));
    setCardPool((prev) => [...prev, ...newCards]);
    setCardsGenerated(true);
    setSelectedId(newCards[0].record_id);
    setSuccessToast(`已追加 ${newCards.length} 张人物卡片（共 ${cardPool.length + newCards.length} 张）`);
  }, [rowRange, records, cardPool.length, setSuccessToast]);

  // 重新框选：清除已生成卡片池，回到框选状态
  const resetCards = useCallback(() => {
    setCardsGenerated(false);
    setRowRange(null);
    setCardPool([]);
    setCardLoopMap({});
    setRunCursor(null);
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
  }, []);

  // 从BrowserPane Excel模式上传文件
  const browserExcelInputRef = useRef<HTMLInputElement>(null);
  const [browserExcelUploading, setBrowserExcelUploading] = useState(false);
  const handleBrowserExcelUpload = async (file: File) => {
    setBrowserExcelUploading(true);
    try {
      const r = await api.uploadExcel(file);
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

  useEffect(() => {
    api.getConfig()
      .then((c) => {
        setConfig(c);
        setSettings(c.settings || DEFAULT_SETTINGS);
      })
      .catch(() => {});
    refreshRecords();

    if (window.electronAPI) {
      window.electronAPI.backendStatus().then(setBackendReady);
      window.electronAPI.onBackendReady(() => {
        setBackendReady(true);
        refreshRecords();
      });
    }

    // 兜底：轮询健康检查，防止 IPC 事件丢失或后端为上一实例残留
    const poll = setInterval(async () => {
      try {
        const res = await fetch("http://localhost:8000/api/health", { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          setBackendReady(true);
          clearInterval(poll);
        }
      } catch {
        /* 继续轮询 */
      }
    }, 2000);
    return () => clearInterval(poll);
  }, []);

  // 防误关设置变化时同步给主进程
  useEffect(() => {
    window.electronAPI?.setPreventClose(!!settings.prevent_accidental_close);
  }, [settings.prevent_accidental_close]);

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

  // 设置弹窗打开时隐藏 BrowserView，避免原生视图盖住弹窗
  useEffect(() => {
    if (!window.electronAPI) return;
    if (showSettings) {
      window.electronAPI.viewHide("left");
      window.electronAPI.viewHide("right");
    }
  }, [showSettings]);

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
      // 仅在文件提取教学模式中处理
      if (!addingDocExtractModeRef.current) return;
      rlog(`[download-captured] side=${data.side}, filename=${data.filename}, size=${data.size}`);

      // 将最后一个 开头点击(docExtractClick, phase=pre, 且尚未升级为docExtract) 标记升级为下载触发步骤
      setPickedMarks((prev) => {
        const marks = [...prev];
        for (let i = marks.length - 1; i >= 0; i--) {
          if (marks[i].docExtractClick && marks[i].docExtractClickPhase !== "post" && !marks[i].docExtract) {
            marks[i] = {
              ...marks[i],
              docExtract: true,
              docSource: "web-download",
              label: `文件下载提取 · ${data.filename}`,
            };
            break;
          }
        }
        return marks;
      });

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
    const initialTarget: PickTarget =
      appMode === "review" ? "right" : appMode === "entry" ? "left" : null;
    setPickTarget(initialTarget);
    // 已选中 LOOP 列时，进入步骤设置自动切到左侧网页视图，方便拾取网页元素
    if (selectedExcelColumnRef.current && leftViewMode === "excel") {
      setLeftViewMode("web");
      setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
    }
    // 进入元素选择模式即自动进入对应教学阶段
    if (teachingPhase === "idle" || teachingPhase === "done") {
      const phase: TeachingPhase =
        targetPhase || (appMode === "entry" ? "entry" : "data-source");
      setTeachingPhase(phase);
      setWorkflowTemplate(null);
      setBatchResults({});
      setError(null);
    }
    // 根据初始 pickTarget 启动对应侧的拾取脚本
    setTimeout(() => {
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      if (initialTarget === "left") {
        window.electronAPI?.viewStartPicking("left");
      } else if (initialTarget === "right") {
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

      // 2) 普通元素选择模式：右 pick + 左 pick 成对提取为映射
      const fromPicks: FieldMapping[] = [];
      let pendingRight: PickedMark | null = null;
      for (const m of pickedMarks) {
        if (m.action === "pick" && m.side === "right") {
          pendingRight = m;
        } else if (m.action === "pick" && m.side === "left" && pendingRight) {
          const isExcel = m.source === "excel" || m.tag === "excel-cell";
          fromPicks.push({
            right_selector: pendingRight.selector,
            right_label: pendingRight.label || pendingRight.selector,
            left_source: isExcel ? "excel" : "database",
            left_field: isExcel ? (m.excelField || m.selector) : m.selector,
            verify_method: "smart" as const,
          });
          pendingRight = null;
        } else if (m.action === "input" || m.action === "click") {
          // 遇到其他动作，清空未配对的右侧 pick
          pendingRight = null;
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

  // 教学模式向导：开始灵活绑定（左右侧皆可）
  // 进入「灵活绑定」模式后：点任意侧输入框 = 绑定选中的 Excel 列并真实填入第一行值；
  // 点其他元素 = 真实点击并记录为点击步骤；左右侧均可、次数不限，直到用户点「完成」。
  const startBindBothInputs = useCallback(() => {
    const col = selectedExcelColumnRef.current;
    rlog("[startBindBothInputs] 开始灵活绑定, selectedExcelColumn=", col);
    if (!col) {
      setError("请先选中 Excel 列作为 LOOP 变量");
      return;
    }
    // 必须切到网页视图，否则左侧网页被 Excel 视图遮挡，用户无法点击输入框
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
  }, [setError]);

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
    rlog("[startAddingReviewSteps] 进入审查步骤添加模式（先右后左）");
    setCurrentLoopStepType("review");
    setTeachingPhase("review");
    setAddingStepMode("review");
    setBindInputSide(null);
    setPendingAction("none");
    setInputTarget(null);
    setNextClickLabel(null);
    setPickTarget("right");
    setRightPicked(null);
    setLeftPicked(null);
    setError(null);
    if (!selectMode) setSelectMode(true);
    setTimeout(() => {
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStartPicking("right");
    }, 300);
  }, [setError, selectMode]);

  // 教学模式向导：添加录入步骤到 LOOP 循环体
  // 录入映射流程（先左后右）：左侧选来源（网页/Excel）→ 右侧选输入框 → 保存映射
  const startAddingEntrySteps = useCallback(() => {
    rlog("[startAddingEntrySteps] 进入录入步骤添加模式（先左后右）");
    setCurrentLoopStepType("entry");
    setTeachingPhase("entry");
    setAddingStepMode("entry");
    setBindInputSide(null);
    setPendingAction("none");
    setInputTarget(null);
    setNextClickLabel(null);
    setPickTarget("left");
    setRightPicked(null);
    setLeftPicked(null);
    setError(null);
    if (!selectMode) setSelectMode(true);
    setTimeout(() => {
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      window.electronAPI?.viewStartPicking("left");
    }, 300);
  }, [setError, selectMode]);

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
      setWidgetDraft(null);
      setWidgetSnapshotError(null);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
    }
    setPickTarget(null);
    setRightPicked(null);
    setLeftPicked(null);
  }, []);

  // === 自定义文本模式 ===
  const toggleCustomText = useCallback(() => {
    setCustomTextMode((prev) => {
      const next = !prev;
      if (!next) {
        setCustomTextPickingId(null);
        window.electronAPI?.viewStopPicking("left").catch(() => {});
        window.electronAPI?.viewStopPicking("right").catch(() => {});
      }
      return next;
    });
  }, []);

  const addCustomTextEntry = useCallback(() => {
    const id = `ct-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setCustomTextEntries((prev) => [...prev, { id, name: "", text: "" }]);
  }, []);

  /** 文件提取预览面板：勾选字段送到「提取元素」面板（转为自定义文本条目，沿用拾取关联/保存步骤机制） */
  const sendDocFieldsToExtractPanel = useCallback((fields: Record<string, string>) => {
    const entries = Object.entries(fields)
      .filter(([, v]) => v)
      .map(([f, v]) => ({
        id: `ct-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${f}`,
        name: FIELD_LABELS[f] || f,
        text: v,
      }));
    if (entries.length === 0) return;
    setCustomTextEntries((prev) => [...prev, ...entries]);
    setCustomTextMode(true);
    setDocExtractPanel(null);
    setSameNameImages(null);
    // 关闭内联结果视图，切换到「文件处理+提取元素」两栏分屏模式
    setDocExtractSplitView(true);
    setBottomPanelOpen(true);
    setSuccessToast(`已送 ${entries.length} 个字段到「提取元素」面板，请逐个拾取关联网页元素后保存为步骤`);
  }, [setSuccessToast]);

  /** 网页模式：预览就绪后用户点击「录入提取」触发 OCR 识别（若后台已预提取则直接复用） */
  const triggerWebExtract = useCallback(() => {
    const pending = pendingWebFileRef.current;
    if (!pending) return;
    // 进入 OCR 阶段
    setDocWebStatus({ phase: "ocr", filename: pending.filename });

    // 检查是否有后台预提取的OCR结果可以直接复用
    const cached = bgOcrResultRef.current;
    if (cached && cached.dataUrl === pending.dataUrl) {
      rlog(`[triggerWebExtract] 复用后台OCR缓存结果: ${pending.filename}`);
      const result = cached.result;
      const newExtract: DocExtractState = {
        filename: result.filename,
        method: result.method,
        text: result.text,
        fields: result.fields,
        entries: [],
        source: pending.dataUrl,
        file_url: pending.dataUrl,
        processed_image: result.processed_image,
        mrz_warnings: result.mrz_warnings,
      };
      const rid = selected?.record_id || "_default";
      setDocExtractsByRecord((prev) => {
        const arr = prev[rid] || [];
        const filtered = arr.filter((e) => e.file_url !== newExtract.file_url);
        return { ...prev, [rid]: [...filtered, newExtract] };
      });
      setActiveDocIndex(999);
      setDocSignal((s) => s + 1);
      setDocExtractPanel({
        imageUrl: toPreviewImageUrl(pending.dataUrl, result.processed_image),
        filename: result.filename,
        method: result.method,
        text: result.text,
        fields: result.fields,
        side: pending.side,
        workflow: pending.side === "left" ? "entry" : "review",
      });
      setDocWebStatus({ phase: "success", filename: result.filename, size: pending.size });
      setSuccessToast(`文件提取完成：${result.filename}`);
      pendingWebFileRef.current = null;
      bgOcrResultRef.current = null;
      return;
    }

    // 没有缓存，正常执行OCR
    const file = dataUrlToFile(pending.dataUrl, pending.filename);
    const mappedFields = Array.from(new Set(mappings.map((m) => m.left_field).filter(Boolean)));
    const targetFields = mappedFields.length > 0
      ? mappedFields
      : ["surname", "given_name", "name", "passport_no", "birth_date", "issue_place", "nationality", "gender"];
    api.extractDocumentFile(file, targetFields)
      .then((result) => {
        const newExtract: DocExtractState = {
          filename: result.filename,
          method: result.method,
          text: result.text,
          fields: result.fields,
          entries: [],
          source: pending.dataUrl,
          file_url: pending.dataUrl,
          processed_image: result.processed_image,
          mrz_warnings: result.mrz_warnings,
        };
        const rid = selected?.record_id || "_default";
        setDocExtractsByRecord((prev) => {
          const arr = prev[rid] || [];
          const filtered = arr.filter((e) => e.file_url !== newExtract.file_url);
          return { ...prev, [rid]: [...filtered, newExtract] };
        });
        setActiveDocIndex(999);
        setDocSignal((s) => s + 1);
        setDocExtractPanel({
          imageUrl: toPreviewImageUrl(pending.dataUrl, result.processed_image),
          filename: result.filename,
          method: result.method,
          text: result.text,
          fields: result.fields,
          side: pending.side,
          workflow: pending.side === "left" ? "entry" : "review",
        });
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
  }, [mappings, selected, setSuccessToast, setError]);

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

  const pickForCustomText = useCallback((id: string) => {
    setCustomTextPickingId(id);
    window.electronAPI?.viewStartPicking("left").catch(() => {});
    window.electronAPI?.viewStartPicking("right").catch(() => {});
  }, []);

  const saveCustomTextSteps = useCallback(() => {
    const stepType = currentLoopStepTypeRef.current;
    const isEntry = stepType === "entry";
    let saved = 0;
    const newlySavedIds: string[] = [];
    customTextEntries.forEach((entry) => {
      if (!entry.text || !entry.selector || entry.saved) return;
      // right_label 只用拾取到的元素标签；框框名字（entry.name）不参与保存，仅在 UI 显示
      saveMapping({
        right_selector: entry.selector,
        right_label: entry.label || entry.selector,
        right_input_type: entry.type || null,
        left_source: "manual",
        left_field: entry.text,
        verify_method: "smart",
      });
      newlySavedIds.push(entry.id);
      saved++;
    });
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

  // 自定义文本面板内容（渲染在 ResultsPanel 的「提取元素」卡片中）
  const customTextContent = useMemo(() => {
    // 有条目时始终可渲染（由 ResultsPanel 的 设置/结果 开关控制显隐）
    if (!customTextMode && customTextEntries.length === 0) return null;
    return (
      <div className="flex h-full flex-col gap-2 overflow-y-auto px-2 py-1.5">
        <div className="mb-0.5 flex items-center gap-1 text-[10px] font-bold text-violet-800">
          <Type className="h-3 w-3 text-violet-700" />
          自定义文本 — 补充 Excel 和数据源网页上都没有的信息
        </div>
        {customTextEntries.length === 0 && (
          <p className="text-[9px] text-slate-500">
            点击下方「添加」创建文本框：上方输入框是框框名字（仅显示），下方是实际内容（参与审查/录入）
          </p>
        )}
        {customTextEntries.map((entry) => (
          <div
            key={entry.id}
            className={`relative w-full rounded-lg border-2 px-2.5 py-2 transition-all ${
              customTextPickingId === entry.id
                ? "border-violet-400 bg-violet-100/80 ring-1 ring-violet-300 animate-pulse"
                : entry.selector
                ? "border-indigo-200 bg-indigo-50/60"
                : "border-indigo-100 bg-indigo-50/30"
            }`}
          >
            {/* 右上角徽章：已拾取 / 拾取中 */}
            <div className="absolute right-1.5 top-1.5 flex shrink-0 items-center gap-1">
              {entry.saved && !customTextPickingId && (
                <span
                  className="inline-flex items-center rounded-md bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700 ring-1 ring-emerald-200 max-w-[130px] truncate"
                  title="已保存为步骤"
                >
                  已保存
                </span>
              )}
              {entry.selector && !entry.saved && customTextPickingId !== entry.id && (
                <span
                  className="inline-flex items-center rounded-md bg-indigo-100 px-1.5 py-0.5 text-[9px] font-medium text-indigo-700 ring-1 ring-indigo-200 max-w-[130px] truncate"
                  title={`${entry.side === "left" ? "左" : "右"}侧：${entry.label || entry.selector}`}
                >
                  关联
                </span>
              )}
            </div>
            {/* 第一行：框框名字（仅用于理解，不参与数据） */}
            <div className="mb-1 flex items-center gap-1 pr-16">
              <input
                value={entry.name}
                onChange={(e) => renameCustomTextEntry(entry.id, e.target.value)}
                placeholder="框框名字…（仅显示，不参与录入/审查）"
                className="w-full bg-transparent px-0.5 py-0.5 text-[11px] font-bold text-indigo-500 outline-none placeholder:text-indigo-300"
              />
            </div>
            {/* 分隔线：名字与内容之间的细横线（模仿截图） */}
            <div className="mb-1 h-px w-full bg-indigo-100/80" />
            {/* 第二行：实际内容值（参与审查/录入） */}
            <textarea
              value={entry.text}
              onChange={(e) => updateCustomTextEntry(entry.id, e.target.value)}
              placeholder="输入实际内容…（用于审查对比或录入填入）"
              rows={2}
              className="w-full resize-none bg-transparent px-0.5 py-0.5 text-[11px] leading-snug text-slate-700 outline-none placeholder:text-slate-300"
            />
            {/* 拾取提示 / 关联详情 */}
            <div className="mt-0.5">
              {customTextPickingId === entry.id ? (
                <span className="text-[9px] text-violet-600 animate-pulse">
                  请在网页中点击目标元素…
                </span>
              ) : entry.selector ? (
                <span
                  className="text-[9px] text-indigo-500/80 truncate block"
                  title={`${entry.side === "left" ? "左" : "右"}侧网页：${entry.label || entry.selector}`}
                >
                  {entry.side === "left" ? "左" : "右"}侧元素：{entry.label || entry.selector}
                </span>
              ) : null}
            </div>
            {/* 底部一排操作按钮：拾取 / 删除 */}
            <div className="mt-1.5 flex items-center gap-1">
              <button
                onClick={() => pickForCustomText(entry.id)}
                disabled={!!customTextPickingId && customTextPickingId !== entry.id}
                className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
                  customTextPickingId === entry.id
                    ? "bg-violet-500 text-white"
                    : entry.selector
                    ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                    : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                } disabled:opacity-40`}
                title={entry.selector ? "重新选择关联元素" : "点击后在网页中拾取目标元素"}
              >
                <MousePointerClick className="h-2.5 w-2.5" />
                {entry.selector ? "重选" : "拾取"}
              </button>
              <button
                onClick={() => removeCustomTextEntry(entry.id)}
                className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium text-slate-400 transition-colors hover:bg-rose-100 hover:text-rose-600"
                title="删除此文本框"
              >
                <Trash2 className="h-2.5 w-2.5" />
                删除
              </button>
            </div>
          </div>
        ))}
        <div className="mt-auto flex shrink-0 items-center gap-1.5 pt-1">
          <button
            onClick={addCustomTextEntry}
            className="inline-flex items-center gap-0.5 rounded-md bg-violet-600 px-2 py-0.5 text-[10px] font-medium text-white transition-all hover:bg-violet-700"
          >
            <Plus className="h-2.5 w-2.5" />
            添加
          </button>
          {customTextEntries.some((e) => e.text && e.selector && !e.saved) && (
            <button
              onClick={saveCustomTextSteps}
              className="inline-flex items-center gap-0.5 rounded-md bg-brand-600 px-2 py-0.5 text-[10px] font-medium text-white transition-all hover:bg-brand-700"
            >
              <Save className="h-2.5 w-2.5" />
              保存为{addingStepMode === "review" ? "审查" : "录入"}步骤
            </button>
          )}
          <span className="ml-auto text-[9px] text-slate-400">
            {customTextEntries.filter((e) => e.text && e.selector && !e.saved).length}/{customTextEntries.length} 已就绪
          </span>
        </div>
      </div>
    );
  }, [customTextMode, customTextEntries, customTextPickingId, addingStepMode, renameCustomTextEntry, updateCustomTextEntry, pickForCustomText, removeCustomTextEntry, addCustomTextEntry, saveCustomTextSteps]);

  // 重置当前映射选择轮次：根据当前步骤模式回到初始拾取侧
  // 审查模式（先右后左）：回到 right；录入模式（先左后右）：回到 left
  const resetMappingRound = useCallback(() => {
    setRightPicked(null);
    setLeftPicked(null);
    const isEntry = currentLoopStepTypeRef.current === "entry";
    const target = isEntry ? "left" : "right";
    setPickTarget(target as PickTarget);
    setTimeout(() => {
      if (isEntry) {
        window.electronAPI?.viewStopPicking("right").catch(() => {});
        window.electronAPI?.viewStartPicking("left");
      } else {
        window.electronAPI?.viewStopPicking("left").catch(() => {});
        window.electronAPI?.viewStartPicking("right");
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
  const startAddDocExtract = useCallback(() => {
    rlog("[startAddDocExtract] 打开文件提取来源选择");
    setAddingDocExtractMode(true);
    setDocExtractSource("choose");
    setDocLocalFiles([]);
    setDocFileBindField(selectedExcelColumn || null);
    setPendingAction("none");
    setPickTarget(null);
    setBindInputSide(null);
    setNextClickLabel(null);
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
  }, [selectedExcelColumn]);

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
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    window.electronAPI?.popupStopPicking("left").catch(() => {});
    window.electronAPI?.popupStopPicking("right").catch(() => {});
    // 关闭下载捕获
    window.electronAPI?.setDownloadCapture("left", false).catch(() => {});
    window.electronAPI?.setDownloadCapture("right", false).catch(() => {});
  }, []);

  /** 网页提取成功后，开始添加收尾点击（所有人处理完后闭环） */
  const startDocExtractPostClicks = useCallback(() => {
    const lastStatus = docWebStatusRef.current;
    if (lastStatus.phase !== "success") return;
    setDocWebStatus({ phase: "post-click", filename: lastStatus.filename || "" });
    // 收尾点击阶段关闭下载捕获，避免误触发下载
    window.electronAPI?.setDownloadCapture("left", false).catch(() => {});
    window.electronAPI?.setDownloadCapture("right", false).catch(() => {});
    setSuccessToast("收尾点击模式：请点击网页上的元素作为所有记录处理完后的闭环操作（如关闭弹窗、返回列表），ESC 退出");
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
  const handleDocExtractClick = useCallback((side: "left" | "right", info: PickedElementInfo) => {
    const curPhase = docWebStatusRef.current?.phase;
    const isPostPhase = curPhase === "post-click";
    rlog(`[docExtractClick] side=${side}, tag=${info.tag}, selector=${info.selector}, phase=${isPostPhase ? "post" : "pre"}`);
    const workflow: "entry" | "review" = side === "left" ? "entry" : "review";
    addPickedMark({
      side,
      source: "web",
      selector: info.selector,
      label: isPostPhase
        ? `文件提取收尾 · ${info.label || info.tag || "元素"}`
        : `文件提取点击 · ${info.label || info.tag || "元素"}`,
      workflow,
      action: "click",
      recordId: selected?.record_id,
      rect: info.rect,
      tag: info.tag,
      type: info.type,
      docExtractClick: true,
      docExtractClickPhase: isPostPhase ? "post" : "pre",
      inPopup: !!info.fromPopup,
    });
    // 真实点击该元素（让网页导航/响应）
    performRealClick(side, info.selector, !!info.fromPopup);
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
    // 目标字段：优先 mappings 的 left_field，否则用默认证件字段
    const mappedFields = Array.from(new Set(mappings.map((m) => m.left_field).filter(Boolean)));
    const targetFields = mappedFields.length > 0
      ? mappedFields
      : ["surname", "given_name", "name", "passport_no", "birth_date", "issue_place", "nationality", "gender"];
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
        const newExtract: DocExtractState = {
          filename: result.filename,
          method: result.method,
          text: result.text,
          fields: result.fields,
          entries,
          source: url,
          file_url: url,
          processed_image: result.processed_image,
          mrz_warnings: result.mrz_warnings,
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
        });
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
  }, [mappings, selected, addPickedMark, setError]);

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

  // 开始添加点击按钮：phase=pre(前置点击/搜索进入，步骤3) 或 post(收尾点击/保存返回，步骤5)
  const startAddClickStep = useCallback((phase: "pre" | "post" = "pre", side?: "left" | "right" | "both") => {
    rlog(`[startAddClickStep] 激活添加${phase === "pre" ? "前置" : "收尾"}点击按钮模式（两侧皆可）`);
    setAddingClickMode(true);
    setAddingClickPhase(phase);
    setNextClickLabel(phase === "pre" ? "前置点击" : "收尾点击");
    setPendingAction("click");
    setPickTarget(null);
    setBindInputSide(null);
    setTimeout(() => {
      if (addingClickModeRef.current) {
        // 默认两侧都激活，用户想点哪侧就点哪侧；若显式传 side 则只激活那一侧
        if (!side || side === "both" || side === "left") window.electronAPI?.viewStartPicking("left");
        if (!side || side === "both" || side === "right") window.electronAPI?.viewStartPicking("right");
      }
    }, 300);
  }, []);

  // 退出添加点击按钮模式
  const exitAddClickMode = useCallback(() => {
    setAddingClickMode(false);
    setAddingClickPhase(null);
    setNextClickLabel(null);
    setPendingAction("none");
    setPickTarget(null);
  }, []);

  // 教学完成：把 pickedMarks 按当前 appMode 保存为模板
  const finishTeaching = useCallback(() => {
    // 智能分类：带clickPhase(pre/post)的点击归入dataSource，其余按workflow字段分类
    const dataSourceMarks = pickedMarks.filter((m) =>
      (m.action === "click" || m.action === "input") &&
      (m.clickPhase === "pre" || m.clickPhase === "post" || m.workflow === "data-source")
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
    if (pickedMarks.length === 0) {
      setError("请先配置至少一个步骤再保存");
      return;
    }
    // 构建模板（复用 buildTemplateFromMarks 的分类逻辑）
    const dataSourceMarks = pickedMarks.filter((m) =>
      (m.action === "click" || m.action === "input") &&
      (m.clickPhase === "pre" || m.clickPhase === "post" || m.workflow === "data-source")
    );
    const reviewMarks = pickedMarks.filter((m) => !m.clickPhase && m.workflow === "review");
    const entryMarks = pickedMarks.filter((m) => !m.clickPhase && m.workflow === "entry");
    const hasSearchSteps = pickedMarks.some((m) => m.action === "input" && !!m.variableField);
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
      hasSearchSteps,
      hasSubmitStep,
    };
    // 持久化保存 tpl（确保游标运行时 getSkillById 能找到）
    saveSkill(tpl);
    setSkillVersion((v) => v + 1);
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
  }, [checkedIds, pickedMarks, cardLoopMap, selected, appMode, setError, setSuccessToast]);

  // ============ SKILL 保存与执行 ============
  const buildTemplateFromMarks = useCallback((name: string, icon?: string): WorkflowTemplate => {
    // 智能分类：带clickPhase(pre/post)的点击归入dataSource，其余按workflow字段分类
    const dataSourceMarks = pickedMarks.filter((m) =>
      (m.action === "click" || m.action === "input") &&
      (m.clickPhase === "pre" || m.clickPhase === "post" || m.workflow === "data-source")
    );
    const reviewMarks = pickedMarks.filter((m) => !m.clickPhase && m.workflow === "review");
    const entryMarks = pickedMarks.filter((m) => !m.clickPhase && m.workflow === "entry");
    const hasSearchSteps = pickedMarks.some((m) => m.action === "input" && !!m.variableField);
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
      hasSearchSteps,
      hasSubmitStep,
    };
  }, [pickedMarks, selected, appMode]);

  const handleSaveSkill = useCallback((name: string, icon: string, runAfter?: boolean) => {
    const tpl = buildTemplateFromMarks(name, icon);
    const saved = saveSkill(tpl);
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
  }, [buildTemplateFromMarks, selectMode, avatarMode, exitSelectMode, exitAvatarMode, saveSkillRunAfter]);

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
    batchStopRef.current = true;
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

  /** 等待下载完成（LOOP 执行时用）：开启捕获 → 等待 download-captured 事件 → 返回文件数据 */
  const waitForDownload = useCallback(async (side: "left" | "right", timeoutMs = 30000): Promise<{ filename: string; dataUrl: string; size: number; mime: string }> => {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        removeCaptured?.();
        removeFailed?.();
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
      const removeCaptured = window.electronAPI?.onDownloadCaptured(onCaptured);
      const removeFailed = window.electronAPI?.onDownloadFailed(onFailed);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("下载超时（30s内未检测到下载）"));
      }, timeoutMs);
      // 确保下载捕获已开启
      window.electronAPI?.setDownloadCapture(side, true).catch(() => {});
    });
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

  // 保底下载：回退到前置页面，扫描所有可下载链接，批量下载，尝试匹配
  const runDocExtractFallback = useCallback(async (
    side: "left" | "right",
    record: ApplicantRecord,
    preClickCount: number
  ): Promise<{ filename: string; dataUrl: string; size: number; mime: string } | "manual-review"> => {
    rlog(`[fallback] 启动文件提取保底机制, side=${side}, preClickCount=${preClickCount}`);
    
    // 步骤1：更新UI状态为扫描中
    setDocWebStatus({ phase: "fallback-scanning", message: "保底机制：回退页面并扫描可下载文件..." });

    // 步骤2：回退页面（回到开头点击之前的页面）
    // 注意：不是所有click都会导致页面跳转，所以回退步数是近似值
    // 采用策略：先回退preClickCount步，然后逐步额外回退直到找到下载链接或到上限
    let goBackSteps = Math.min(Math.max(preClickCount, 1), 8);
    for (let i = 0; i < goBackSteps; i++) {
      try {
        const res = await window.electronAPI?.viewGoBack(side);
        if (!res?.ok) break;
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        break;
      }
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
        const backRes = await window.electronAPI?.viewGoBack(side);
        if (!backRes?.ok) break;
        await new Promise(r => setTimeout(r, 800));
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
      throw new Error("保底机制失败：未找到任何可下载文件");
    }

    // 步骤4：批量下载所有文件
    setDocWebStatus({ phase: "fallback-downloading", total: uniqueLinks.length, current: 0 });
    
    const downloadResult = await window.electronAPI?.viewBatchDownloadUrls(side, uniqueLinks.map(l => l.url), 30000);
    
    if (!downloadResult?.ok || !downloadResult.files || downloadResult.files.length === 0) {
      setDocWebStatus({ phase: "error", message: "保底机制：所有文件下载失败" });
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
      return filenameMatches[0];
    } else if (filenameMatches.length > 1) {
      // 多个文件名匹配，无法确定哪个是正确的，进入人工审查
      rlog(`[fallback] 找到 ${filenameMatches.length} 个文件名匹配，进入人工审查`);
      // 不直接返回，落入下方人工审查逻辑
    }

    // 5.2 文件名没匹配到，尝试快速OCR内容匹配（前几个文件）
    setDocWebStatus({ phase: "fallback-downloading", total: files.length, current: files.length, currentFile: "正在OCR匹配文件内容..." });
    
    const filesToPreview = files.slice(0, Math.min(files.length, 8)); // 最多预览前8个
    for (let i = 0; i < filesToPreview.length; i++) {
      const f = filesToPreview[i];
      const isMatch = await quickPreviewForMatch(f.dataUrl, f.filename, keywords);
      if (isMatch) {
        rlog(`[fallback] OCR内容匹配: ${f.filename}`);
        filesWithMatch.find(fwm => fwm.filename === f.filename)!.matched = true;
        return f;
      }
    }

    // 步骤6：所有自动匹配都失败，进入人工审查模式
    rlog(`[fallback] 自动匹配失败，进入人工审查模式，共 ${files.length} 个文件`);
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
  }, [getRecordMatchKeywords, filenameMatchesRecord, quickPreviewForMatch]);

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
          const wres = (await execJS(buildOptionSelectScript(w, resolvedValue))) as OptionSelectResult | null;
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
          // 4. 调 OCR 提取（后端会自动做图像预处理：EXIF 旋转 + 裁白边）
          const file = dataUrlToFile(readResult.dataUrl, readResult.filename || "local-doc");
          const mappedFields = Array.from(new Set(mappings.map((m) => m.left_field).filter(Boolean)));
          const targetFields = mappedFields.length > 0
            ? mappedFields
            : ["surname", "given_name", "name", "passport_no", "birth_date", "issue_place", "nationality", "gender"];
          try {
            const result = await api.extractDocumentFile(file, targetFields);
            setDocExtractPanel({
              imageUrl: toPreviewImageUrl(readResult.dataUrl, result.processed_image),
              filename: result.filename,
              method: result.method,
              text: result.text,
              fields: result.fields,
              side,
              workflow: side === "left" ? "entry" : "review",
            });
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
          // 2. 真实点击触发下载
          let clickResult = await performRealClick(side, mark.selector, inPopup);
          if (clickResult && typeof clickResult === "object" && "ok" in clickResult && clickResult.ok === false) {
            await waitElementAppear(side, mark.selector, 6000, inPopup);
            clickResult = await performRealClick(side, mark.selector, inPopup);
          }
          
          // 下载完成后：先开预览，后台同时OCR提取
          // showPreviewAndBgOcr: 立即开预览（轻量）+ 后台启动OCR（重量），返回OCR文字供校验
          const showPreviewAndBgOcr = async (fileData: { filename: string; dataUrl: string; size: number }): Promise<string> => {
            // 存入运行时文件槽位
            docRuntimeFileSlotsRef.current[mark.id] = { dataUrl: fileData.dataUrl, filename: fileData.filename };
            lastDocRuntimeFileRef.current = { dataUrl: fileData.dataUrl, filename: fileData.filename, markId: mark.id };

            // 暂存原始文件数据（供后续triggerWebExtract复用）
            pendingWebFileRef.current = { dataUrl: fileData.dataUrl, filename: fileData.filename, size: fileData.size, side };

            const file = dataUrlToFile(fileData.dataUrl, fileData.filename);

            // 1. 轻量预览 + 完整OCR 同时启动（并行，互不阻塞）
            const mappedFields = Array.from(new Set(mappings.map((m) => m.left_field).filter(Boolean)));
            const targetFields = mappedFields.length > 0
              ? mappedFields
              : ["surname", "given_name", "name", "passport_no", "birth_date", "issue_place", "nationality", "gender"];

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
              })
              .catch((e) => {
                rlog(`[executeMark] 轻量预览失败（不影响OCR）: ${e instanceof Error ? e.message : String(e)}`);
              });

            // 2. 后台启动完整OCR提取（同时进行）
            setDocWebStatus({ phase: "ocr", filename: fileData.filename });
            rlog(`[executeMark] 预览已开启，后台开始OCR: ${fileData.filename}`);
            const result = await api.extractDocumentFile(file, targetFields);

            // 3. 缓存OCR结果（供triggerWebExtract复用，避免重复提取）
            bgOcrResultRef.current = { dataUrl: fileData.dataUrl, result };

            // 4. 设置提取面板（OCR结果就绪）
            setDocExtractPanel({
              imageUrl: toPreviewImageUrl(fileData.dataUrl, result.processed_image),
              filename: result.filename,
              method: result.method,
              text: result.text,
              fields: result.fields,
              side,
              workflow: side === "left" ? "entry" : "review",
            });
            setDocWebStatus({ phase: "success", filename: result.filename, size: fileData.size });
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
                // 需要人工审查，等待用户选择
                rlog(`[executeMark] 等待人工选择文件...`);
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

          // 3. 等待下载完成
          let downloadData: { filename: string; dataUrl: string; size: number; mime: string } | null = null;
          try {
            downloadData = await waitForDownload(side, 30000);
            rlog(`[executeMark] 下载完成: ${downloadData.filename} (${downloadData.size} bytes)`);
            // 4. 立即开预览 + 后台OCR提取
            const ocrText = await showPreviewAndBgOcr(downloadData);
            
            // 5. 校验：下载的文件是否真的是该学生的（防止下错文件）
            if (!verifyFileMatchesRecord(ocrText, record)) {
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
            el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
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
        const mappedFields = Array.from(new Set(mappings.map((m) => m.left_field).filter(Boolean)));
        const targetFields = mappedFields.length > 0
          ? mappedFields
          : ["surname", "given_name", "name", "passport_no", "birth_date", "issue_place", "nationality", "gender"];
        api.extractDocumentUrl(docUrl, targetFields)
          .then((result) => {
            setDocExtractPanel({
              imageUrl: toPreviewImageUrl(docUrl, result.processed_image),
              filename: result.filename,
              method: result.method,
              text: result.text,
              fields: result.fields,
              side,
              workflow: side === "left" ? "entry" : "review",
            });
          })
          .catch((e) => {
            rlog(`[executeMark] 文件提取失败: ${e instanceof Error ? e.message : String(e)}`);
          });
        return;
      }
      console.log(`[executeMark] CLICK side=${side}, selector=${mark.selector}, label=${mark.label}`);
      let result = await performRealClick(side, mark.selector, inPopup);
      // 页面慢渲染/弹窗延迟加载时元素可能还没出现，轮询等待最多 6s
      if (result && typeof result === "object" && "ok" in result && result.ok === false) {
        rlog(`[executeMark] 元素未出现，等待加载: ${mark.selector}`);
        await waitElementAppear(side, mark.selector, 6000, inPopup);
        result = await performRealClick(side, mark.selector, inPopup);
      }
      // 再兜底重试一次
      if (result && typeof result === "object" && "ok" in result && result.ok === false) {
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
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        return { ok: true };
      })();
    `;
    await window.electronAPI.viewExecuteJS(side, script);
  }, [performInputValue, performRealClick, mappings, waitElementAppear, getRecordDocFields, waitForDownload]);

  // ============ 前端字段比对：执行完workflow后，直接从右侧BrowserView读取字段值与期望比对 ============
  // 不调用后端 startConfigurableVerify（它会通过Playwright重新导航页面，破坏LOOP当前状态）
  // 而是通过 viewExecuteJS 在当前已打开的页面上直接读取mapping对应的值，做前端比对
  const compareFieldsForRecord = useCallback(async (
    record: ApplicantRecord,
    recordIndex: number,
  ): Promise<{ comparisons: FieldComparison[]; overall: "match" | "mismatch" }> => {
    const comparisons: FieldComparison[] = [];
    if (!window.electronAPI || mappings.length === 0) {
      return { comparisons, overall: "match" };
    }

    // 进入逐字段审查阶段
    setExecPhase("verify");
    setReviewFieldResults({});

    // 等待页面稳定，让数据渲染出来
    await new Promise((r) => setTimeout(r, 1200));

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

    for (let fi = 0; fi < mappings.length; fi++) {
      if (batchStopRef.current) break;
      const mp = mappings[fi];
      // 更新当前审查字段索引（触发UI光标移动）
      setVerifyFieldIdx(fi);

      // 1. 先pending高亮当前字段（右侧目标元素）
      const pendingLabel = `${mp.right_label || mp.left_field}：比对中…`;
      window.electronAPI?.viewHighlightBoxes("right", [{
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

      // 给用户视觉感知时间，再读取值（避免闪烁太快）
      await new Promise((r) => setTimeout(r, 350));

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

      let websiteValue = "";
      let rightFound = false;
      try {
        if (mp.widget) {
          // 控件映射：读触发框显示值（选项控件额外找面板选中态）
          const result = await window.electronAPI.viewExecuteJS("right", buildWidgetReadScript(mp.widget)) as WidgetReadResult | null;
          if (result && typeof result === "object" && result.found) {
            rightFound = true;
            websiteValue = result.value || "";
          }
        } else {
          const result = await window.electronAPI.viewExecuteJS("right", makeReadScript(mp.right_selector)) as { found: boolean; value: string } | null;
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
      window.electronAPI?.viewHighlightBoxes("right", [{
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

      // 字段间短暂停留
      await new Promise((r) => setTimeout(r, 400));
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
  }, [mappings, getRecordDocFields]);

  // ============ 对单张卡片执行整个模板 ============
  // 执行流程：先按顺序执行所有 marks（填入搜索词→点搜索→点人物→点附加按钮），
  // 所有步骤完成后再做一次字段比对（compareFieldsForRecord），形成完整闭环。
  const executeTemplateForRecord = useCallback(async (
    tpl: WorkflowTemplate,
    record: ApplicantRecord,
    recordIndex: number,
    onStepStart?: (recordIndex: number, mark: PickedMark) => void,
    options?: { wrapWithVerify?: boolean; skipSubmit?: boolean; preOnly?: boolean; postThenPre?: boolean; entryReview?: boolean }
  ): Promise<{ success: boolean; failedOrder?: number; error?: string; comparisons?: FieldComparison[]; verifyOverall?: "match" | "mismatch" }> => {
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
          .filter((m) => m.side === "right" || m.clickPhase === "pre" || m.clickPhase === "post")
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
          return !m.clickPhase;
        });
        allMarks = [
          ...dataSourceInputs,
          ...preClickMarks,
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

    // 进入marks执行阶段（触发UI光标动画）
    setExecPhase("marks");
    setVerifyFieldIdx(-1);
    setReviewFieldResults({});

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
        if (mark.docSource === "web-download") {
          const docPreClicks = allMarks.filter(
            (m, idx) => idx < mi && m.docExtractClick && m.docExtractClickPhase !== "post"
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
        // 根据动作类型等待页面响应
        if (mark.action === "click") {
          // 点击按钮/链接后等待页面加载/跳转（智能等待页面稳定，替代纯固定延时）
          const isSubmitOrSearch = /搜索|查询|submit|search|确认|进入|查看|登录|提交|保存/i.test(mark.label);
          const maxWait = isSubmitOrSearch ? 2500 : 1500;
          await Promise.race([waitPageSettled(markSide, maxWait + 1000), sleep(maxWait)]);
        } else if (mark.action === "input") {
          // 输入后等待较短时间让框架感知
          await sleep(600);
        } else {
          await sleep(400);
        }
        // postThenPre模式：post段结束后额外等待页面稳定（收尾点击后页面跳转回搜索页）
        if (postThenPreBoundary > 0 && mi === postThenPreBoundary - 1) {
          await sleep(800);
          await Promise.race([waitPageSettled("left", 3000), waitPageSettled("right", 3000), sleep(2000)]);
        }
      } catch (e) {
        rlog(`[batch] 第 ${recordIndex + 1} 行步骤 ${mark.order} 失败:`, e);
        return {
          success: false,
          failedOrder: mark.order,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
    // 每条记录workflow步骤执行完后等待，让页面稳定
    await sleep(800);

    // 所有 marks 执行完毕，进行字段比对（审查机制）
    let comparisons: FieldComparison[] = [];
    let verifyOverall: "match" | "mismatch" = "match";
    if (options?.wrapWithVerify) {
      const cmp = await compareFieldsForRecord(record, recordIndex);
      comparisons = cmp.comparisons;
      verifyOverall = cmp.overall;
    }

    return { success: true, comparisons, verifyOverall };
  }, [executeMark, compareFieldsForRecord, checkViewOnline, waitNetworkRestore, waitPageSettled]);

  // ============ 批量执行：对所有卡片按模板执行，从当前选中卡片开始 ============
  const runBatch = useCallback(async (tplOverride?: WorkflowTemplate, targetIds?: string[]) => {
    const tpl = tplOverride ?? workflowTemplateRef.current ?? lastTemplateRef.current;
    console.log("[runBatch] 🚀 开始执行，tpl=", !!tpl, "records.length=", records.length, "selectedId=", selectedId, "targetIds=", targetIds?.length);
    if (!tpl) {
      console.warn("[runBatch] ❌ 无 workflowTemplate，退出");
      return;
    }
    // 持久化保存当前使用的模板
    lastTemplateRef.current = tpl;
    if (cardRecords.length === 0) {
      console.warn("[runBatch] ❌ cardRecords 为空（未框选生成卡片），退出");
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
    setBatchResults({});
    setBatchMarkCursor(null);
    setError(null);
    setSteps([]);
    setReport(null);
    setLoopReports([]);
    setVerifyStatus("idle");
    setResult(null);
    // 重置执行阶段状态
    setExecPhase("idle");
    setVerifyFieldIdx(-1);
    setReviewFieldResults({});

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

    // 从当前选中的卡片开始排序（第一条LOOP = 当前选中卡片）
    // 若传入了 targetIds（勾选模式），则只执行勾选的卡片，按原列表顺序排列
    const selectedIdx = cardRecords.findIndex((r) => r.record_id === selectedId);
    const startIdx = selectedIdx >= 0 ? selectedIdx : 0;
    const allTargets = [
      ...cardRecords.slice(startIdx),
      ...cardRecords.slice(0, startIdx),
    ];
    const targets = targetIds && targetIds.length > 0
      ? allTargets.filter((r) => targetIds.includes(r.record_id))
      : allTargets;
    setBatchTargets(targets);

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

    // 首条日志同步写入，让用户点击后立刻看到 LOOP 已启动
    rlog(`[batch] 开始LOOP执行，共 ${targets.length} 条，从第 ${startIdx + 1} 条（选中卡片）开始`);
    setSteps([
      {
        step: 1,
        action: "start",
        description: `LOOP 启动：共 ${targets.length} 条记录，从当前选中卡片（${targets[0]?.fields.name || targets[0]?.record_id}）开始执行`,
        success: true,
        timestamp: new Date().toISOString(),
      },
    ]);

    await sleep(400);

    const onStepStart = (recordIndex: number, mark: PickedMark) => {
      setBatchMarkCursor({ recordIndex, markOrder: mark.order });
      const side: ViewSide = mark.side === "left" ? "left" : "right";
      const selector = mark.action === "input" && mark.inputTarget ? mark.inputTarget : mark.selector;
      const label = `${mark.order} · ${mark.label || selector}`;
      window.electronAPI?.viewClearHighlight(side).catch(() => {});
      window.electronAPI?.viewHighlightBoxes(side, [{ selector, status: "pending", label }]).catch(() => {});
      setSteps((prev) => [
        ...prev,
        {
          step: prev.length + 1,
          action: mark.action || "pick",
          description: `LOOP [${recordIndex + 1}/${targets.length}] 步骤 ${mark.order}: ${mark.label || selector}`,
          success: true,
          detail: mark.action === "input"
            ? `填入: ${mark.variableField ? `[${mark.variableField}]` : (mark.value || "")}`
            : undefined,
          timestamp: new Date().toISOString(),
        },
      ]);
    };

    try {
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
        setBatchCursor(i);
        setSelectedId(record.record_id);
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

        const result = await executeTemplateForRecord(tpl, record, i, onStepStart, {
          wrapWithVerify: hasReviewSteps,
        });

        const recordName = record.fields.name || record.record_id;
        // 本条记录的比对条目（用于按人物拆分报告）
        const currentRecordEntries: VerificationReportEntry[] = [];

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
                const entry: VerificationReportEntry = {
                  right_selector: c.selector_hint || "",
                  right_label: c.website_label || c.field,
                  left_source: c.evidence_source || "excel",
                  left_field: c.field,
                  right_value: c.website_value,
                  left_value: c.excel_value || c.passport_value,
                  match: c.match,
                  timestamp: new Date().toISOString(),
                };
                allEntries.push(entry);
                currentRecordEntries.push(entry);
              }
            }
            rlog(`[batch] 第 ${i + 1} 行完成: ${recordName}, 比对结果: ${result.verifyOverall}`);
          } else {
            // 纯录入流程：步骤执行成功即算成功，无比对
            successCount++;
            rlog(`[batch] 第 ${i + 1} 行录入完成: ${recordName}`);
          }
        }

        // 构建本条记录的按人物报告并累加到 loopReports
        {
          const hasMismatch = currentRecordEntries.some((e) => e.match === "mismatch" || e.match === "error");
          // 聚合该记录所有文档的MRZ警告
          const recordDocExtracts = docExtractsByRecordRef.current[record.record_id] || [];
          const allMrzWarnings = recordDocExtracts.flatMap((d) => d.mrz_warnings || []);
          // 如果有MRZ警告，将overall从pass提升为review（需要人工检查）
          const effectiveOverall: Overall = !result.success
            ? "fail"
            : hasReviewSteps
            ? (hasMismatch ? "fail" : allMrzWarnings.length > 0 ? "review" : "pass")
            : (allMrzWarnings.length > 0 ? "review" : "pass");
          const personReport: VerificationReport = {
            task_id: `loop-${record.record_id}-${Date.now()}`,
            record_id: record.record_id,
            record_name: recordName,
            university_url: rightUrl,
            entries: currentRecordEntries,
            overall: effectiveOverall,
            summary: !result.success
              ? `执行失败：${result.error || "未知错误"}`
              : allMrzWarnings.length > 0
              ? `MRZ交叉验证发现${allMrzWarnings.length}处姓名等字段不一致，已以MRZ为准，请人工复核`
              : hasReviewSteps
              ? (hasMismatch ? "存在不一致" : "全部一致")
              : "录入完成",
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            mrz_warnings: allMrzWarnings.length > 0 ? allMrzWarnings : undefined,
          };
          setLoopReports((prev) => [...prev, personReport]);
        }

        setBatchResults((prev) => ({
          ...prev,
          [record.record_id]: {
            recordId: record.record_id,
            // 纯录入流程：步骤执行成功即算成功；审查流程：步骤成功且字段比对一致才算成功
            status: !result.success
              ? "failed"
              : hasReviewSteps && result.verifyOverall === "mismatch"
              ? "failed"
              : "success",
            startedAt: prev[record.record_id]?.startedAt,
            finishedAt: Date.now(),
            error: !result.success
              ? result.error
              : hasReviewSteps && result.verifyOverall === "mismatch"
              ? "字段比对不一致"
              : undefined,
            failedOrder: result.failedOrder,
          },
        }));

        // 行之间等待，让用户能看清结果
        if (i < targets.length - 1) {
          await sleep(1500);
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
    } finally {
      setBatchRunning(false);
      setBatchCursor(-1);
      setBatchMarkCursor(null);
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
    }
  }, [workflowTemplate, records, cardRecords, selectedId, executeTemplateForRecord, selectMode, avatarMode, exitSelectMode, exitAvatarMode, rightUrl, leftUrl, waitViewReady]);
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
        let successCount = 0;
        let failCount = 0;
        const errors: string[] = [];

        for (let ri = 0; ri < targets.length; ri++) {
          if (queueStopRef.current || batchStopRef.current) break;

          const record = targets[ri];
          setSelectedId(record.record_id);
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
            const label = mark.label || mark.selector;
            window.electronAPI?.viewClearHighlight(side).catch(() => {});
            window.electronAPI?.viewHighlightBoxes(side, [{ selector, status: "pending", label }]).catch(() => {});
            setSteps((prev) => [
              ...prev,
              {
                step: prev.length + 1,
                action: mark.action || "pick",
                description: `LOOP [${ri + 1}/${targets.length}] 步骤 ${mark.order}: ${mark.label || selector}`,
                success: true,
                detail: mark.action === "input"
                  ? `填入: ${mark.variableField ? `[${mark.variableField}]` : (mark.value || "")}`
                  : undefined,
                timestamp: new Date().toISOString(),
              },
            ]);
          }, { wrapWithVerify: hasReviewSteps });

          if (result.success) {
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
          } else {
            failCount++;
            errors.push(result.error || "未知错误");
            setBatchResults((prev) => ({
              ...prev,
              [record.record_id]: { recordId: record.record_id, status: "failed", finishedAt: Date.now(), error: result.error },
            }));
            setSteps((prev) => [
              ...prev,
              {
                step: prev.length + 1,
                action: "error",
                description: `LOOP [${ri + 1}/${targets.length}] 失败：${record.fields.name || record.record_id} — ${result.error}`,
                success: false,
                timestamp: new Date().toISOString(),
              },
            ]);
          }
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
  }, [taskQueue, queueRunning, executeTemplateForRecord, waitViewReady]);

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

  /** 功能1 主流程：下载网页文档 URL → MarkItDown/OCR → 生成对比 → 切到文档tab */
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
        const newExtract: DocExtractState = {
          filename: result.filename,
          method: result.method,
          text: result.text,
          fields: result.fields,
          entries,
          source: url,
          file_url: url,
          processed_image: result.processed_image,
          mrz_warnings: result.mrz_warnings,
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
      setDocFileExtracting(true);
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
        });
        rlog(`[doc-fill] 文件提取完成: ${result.filename} (${result.method})，${Object.keys(result.fields).length} 个字段`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`文件提取失败: ${msg}`);
      } finally {
        setDocFileExtracting(false);
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
        const dataSourceMarks = allMarks.filter((m) => m.clickPhase === "pre" || m.clickPhase === "post" || m.workflow === "data-source");
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
        const prePostClicks = allMarks.filter((m) => m.action === "click" && (m.clickPhase === "pre" || m.clickPhase === "post"));
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
      if (batchRunning || singleRunning) return;
      // 从 cardPool 查找记录（cardPool 包含所有已生成的卡片，records 在重新导入 Excel 时会被替换）
      const recordIndex = cardPool.findIndex((r) => r.record_id === recordId);
      if (recordIndex < 0) return;
      const record = cardPool[recordIndex];
      const recordName = record.fields.name || record.fields.fullname || record.fields.passport_no || record.fields.student_id || record.record_id;

      setSelectedId(recordId);
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
        const side: ViewSide = mark.side === "left" ? "left" : "right";
        const selector = mark.action === "input" && mark.inputTarget ? mark.inputTarget : mark.selector;
        const label = `${mark.order} · ${mark.label || selector}`;
        window.electronAPI?.viewClearHighlight(side).catch(() => {});
        window.electronAPI?.viewHighlightBoxes(side, [{ selector, status: "pending", label }]).catch(() => {});
        setSteps((prev) => [
          ...prev,
          {
            step: prev.length + 1,
            action: mark.action || "pick",
            description: `定位步骤 ${mark.order}: ${mark.label || selector}`,
            success: true,
            detail: mark.action === "input"
              ? `填入: ${mark.variableField ? `[${mark.variableField}]` : (mark.value || "")}`
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
            .filter((m) => (m.side === "right" || m.clickPhase === "pre" || m.clickPhase === "post") && (m.action === "input" || m.action === "click"))
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

  // ============ SKILL 拖拽到人物卡片：加载 SKILL 并在指定记录上单卡执行 ============
  const runSkillOnRecord = useCallback(
    async (skillId: string, recordId: string) => {
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
      const recordName = record.fields.name || record.fields.fullname || record.fields.passport_no || record.fields.student_id || record.record_id;

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
        const side: ViewSide = mark.side === "left" ? "left" : "right";
        const selector = mark.action === "input" && mark.inputTarget ? mark.inputTarget : mark.selector;
        const label = `${mark.order} · ${mark.label || selector}`;
        window.electronAPI?.viewClearHighlight(side).catch(() => {});
        window.electronAPI?.viewHighlightBoxes(side, [{ selector, status: "pending", label }]).catch(() => {});
        setSteps((prev) => [
          ...prev,
          {
            step: prev.length + 1,
            action: mark.action || "pick",
            description: `[${tpl.icon || "🔍"}${tpl.name}] 步骤 ${mark.order}: ${mark.label || selector}`,
            success: true,
            detail: mark.action === "input"
              ? `填入: ${mark.variableField ? `[${mark.variableField}]` : (mark.value || "")}`
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
  const kbStateRef = useRef({
    pickedMarks, avatarMode, selectMode, pendingAction,
    showSettings, replaying, addingClickMode, nextClickLabel: null as string | null,
    addingDocExtractMode: false, bindInputSide: null as null | "left" | "right" | "both",
    removePickedMark, enterSelectMode, exitAvatarMode, exitSelectMode,
    setError, setInputTarget, setPendingAction, setPickTarget,
    setPendingInputValue, setPendingInputField,
    setBindInputSide, setNextClickLabel, setAddingClickMode,
    setAddingDocExtractMode: (_v: boolean) => {}, setDocExtractSource: (_v: any) => {},
    setDocLocalFiles: (_v: any) => {}, setDocFileBindField: (_v: any) => {},
    setRightPicked: (_v: any) => {}, setLeftPicked: (_v: any) => {},
    commitInput, undoLastStep: () => {},
    undoDocExtractClick: async () => {}, docExtractGoBack: async () => {},
  });
  kbStateRef.current = {
    pickedMarks, avatarMode, selectMode, pendingAction,
    showSettings, replaying, addingClickMode, nextClickLabel,
    addingDocExtractMode, bindInputSide,
    removePickedMark, enterSelectMode, exitAvatarMode, exitSelectMode,
    setError, setInputTarget, setPendingAction, setPickTarget,
    setPendingInputValue, setPendingInputField,
    setBindInputSide, setNextClickLabel, setAddingClickMode,
    setAddingDocExtractMode, setDocExtractSource, setDocLocalFiles, setDocFileBindField,
    setRightPicked, setLeftPicked,
    commitInput, undoLastStep,
    undoDocExtractClick, docExtractGoBack,
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const s = kbStateRef.current;
      if (s.showSettings) return;
      if (s.replaying) return;

      const key = e.key;
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
      } else if (key === "r" || key === "R") {
        e.preventDefault();
        s.undoLastStep();
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
        // 两级退出（与 Esc 等价）：
        // 1. 文件提取配置模式 → 退出文件提取配置
        // 2. S 输入模式 → 完成填入并回到"搭建节点"状态（保持 selectMode）
        // 3. 教学"搜索"阶段 → 跳过搜索进入确认人物
        // 4. 点击模式 → 退出点击模式
        // 5. selectMode/avatarMode → 完全退出
        e.preventDefault();
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
                label: `输入「${newValue.slice(0, 18)}${newValue.length > 18 ? "…" : ""}」← Excel「${p.field}」`,
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

  const onRightPicked = useCallback(async (info: PickedElementInfo) => {
    // 用 ref 读取最新状态，避免 React 批量更新/闭包延迟
    const currentPendingAction = pendingActionRef.current;
    const currentPendingInputValue = pendingInputValueRef.current;
    const currentBindInputSide = bindInputSideRef.current;
    const currentExcelCol = selectedExcelColumnRef.current;
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
      setCustomTextEntries((prev) => prev.map((e) =>
        e.id === id
          ? { ...e, selector: info.selector, label: info.label || info.tag || info.selector, side: "right", tag: info.tag, type: info.type }
          : e
      ));
      setCustomTextPickingId(null);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      return;
    }
    // 控件提取：拾取触发框 → 自动快照（点击展开 → 识别面板 → 关闭）
    if (widgetPickKindRef.current) {
      const kind = widgetPickKindRef.current;
      setWidgetPickKind(null);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      void runWidgetSnapshot(info.selector, info.label || info.tag || info.selector, kind);
      return;
    }
    // 控件日历角色重选：把点到的元素记录为对应角色的选择器
    if (widgetRolePickingKeyRef.current) {
      const fullKey = widgetRolePickingKeyRef.current;
      setWidgetRolePickingKey(null);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      const sep = fullKey.lastIndexOf(":");
      const cardKey = fullKey.slice(0, sep);
      const role = fullKey.slice(sep + 1);
      const field = WIDGET_ROLE_TO_FIELD[role];
      if (field) {
        const sel = role === "dayCell" ? generalizeDayCellSelector(info.selector) : info.selector;
        const applyRole = (w: WidgetDef): WidgetDef => ({
          ...w,
          calendar: { ...(w.calendar || {}), [field]: sel },
        });
        if (cardKey === "draft") {
          setWidgetDraft((prev) => (prev ? applyRole(prev) : prev));
        } else {
          const rightSelector = cardKey.replace(/^saved:/, "");
          setMappings((prev) => prev.map((m) => (m.right_selector === rightSelector && m.widget ? { ...m, widget: applyRole(m.widget) } : m)));
          setPickedMarks((prev) => prev.map((mk) => (mk.selector === rightSelector && mk.widget ? { ...mk, widget: applyRole(mk.widget) } : mk)));
        }
      }
      return;
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
    if (currentPendingAction === "click") {
      const clickLabel = nextClickLabelRef.current;
      const currentPhase = addingClickPhaseRef.current;
      rlog("[onRightPicked] click模式, nextClickLabel=", clickLabel, "addingClickMode=", addingClickModeRef.current, "phase=", currentPhase);
      // 不调用 performRealClick：picker 的 pointerdown 拦截后物理 click 仍会触发元素，
      // 再调 el.click() 会导致点击两次。物理点击已经完成。
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
      // 判断点击后的行为：添加点击按钮模式/教学搜索→确认人物/完成
      if (addingClickModeRef.current) {
        // 连续添加点击按钮模式：保持点击状态，使用对应phase的标签
        setNextClickLabel(currentPhase === "post" ? "收尾点击" : "前置点击");
        setPendingAction("click");
        setPickTarget(null);
        setTimeout(() => {
          if (addingClickModeRef.current) {
            window.electronAPI?.viewStartPicking("left");
            window.electronAPI?.viewStartPicking("right");
          }
        }, 200);
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
    // pendingAction=input：右侧点击 = 指定目标输入框（更新 inputTarget）
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
      // 加入 pickedMarks，便于后续 R 撤销
      addPickedMark({
        ...targetMark,
        action: "pick",
      });
      // 目标已确定，停止拾取，等待用户按 Enter 执行填入
      setPickTarget(null);
      window.electronAPI?.viewStopPicking("right");
      // 不再用顶部 Toast，靠页面浮标反馈
      return;
    }
    // 教学模式向导：连续绑定右侧输入框
    // ⚠️ 绑定流程检查必须在 setRightPicked/setPickTarget 之前，否则会干扰绑定流程的状态
    const currentNextClickLabel = nextClickLabelRef.current;
    // 放宽输入框判断：标准 input/textarea/select + contenteditable + role=textbox
    const isInputLike = /^(input|textarea|select)$/i.test(info.tag || "") || !!info.isContentEditable || /^(text|search|email|tel|url|number|password)$/i.test(info.type || "");
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
          label: `输入 · ${info.label || info.selector} ← Excel「${rightCol}」`,
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
        const previewValue = (selected?.fields?.[rightCol] || "").trim();
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
        // 绑定完输入框后退出绑定模式，用户可继续点搜索/确认人物进行页面跳转
        setBindInputSide(null);
        window.electronAPI?.viewStopPicking("left").catch(() => {});
        window.electronAPI?.viewStopPicking("right").catch(() => {});
      } else {
        // 非输入框：真实点击并记录为点击步骤
        rlog("[onRightPicked] ✅ 绑定模式真实点击右侧元素:", info.selector);
        performRealClick("right", info.selector);
        addPickedMark({
          side: "right",
          source: "web",
          selector: info.selector,
          label: `点击 · ${info.label || info.tag || info.selector}`,
          value: info.value,
          workflow: activePhase || "data-source",
          action: "click",
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
        setNextClickLabel(currentPhase === "post" ? "收尾点击" : "前置点击");
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
    const rightTeachCol = rightBindColumnRef.current || currentExcelCol;
    if (activePhase && isInputLike && rightTeachCol) {
      addPickedMark({
        side: "right",
        source: "web",
        selector: info.selector,
        label: `输入 · ${info.label || info.selector} ← Excel「${rightTeachCol}」`,
        value: info.value,
        workflow: activePhase,
        action: "input",
        inputTarget: info.selector,
        inputTargetLabel: info.label || info.selector,
        variableField: rightTeachCol,
        excelField: rightTeachCol,
        recordId: selected?.record_id,
        rect: info.rect,
        tag: info.tag,
        type: info.type,
      });
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
    // 审查模式（先右后左）：右侧拾取完成后切到左侧拾取来源；录入模式（先左后右）：两侧已完成，等待保存
    setPickTarget(currentLoopStepTypeRef.current === "review" ? "left" : null);
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
  }, [addPickedMark, selected, performRealClick, performInputValue, teachingPhase, recyclePickedMark, handleUploadBindPick]);

  const onLeftPicked = useCallback(async (info: PickedElementInfo) => {
    // 用 ref 读取最新状态，避免 React 批量更新/闭包延迟
    const currentPendingAction = pendingActionRef.current;
    const currentInputTarget = inputTargetRef.current;
    const currentBindInputSide = bindInputSideRef.current;
    const currentExcelCol = selectedExcelColumnRef.current;
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
      setCustomTextEntries((prev) => prev.map((e) =>
        e.id === id
          ? { ...e, selector: info.selector, label: info.label || info.tag || info.selector, side: "left", tag: info.tag, type: info.type }
          : e
      ));
      setCustomTextPickingId(null);
      window.electronAPI?.viewStopPicking("left").catch(() => {});
      window.electronAPI?.viewStopPicking("right").catch(() => {});
      return;
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
    if (currentPendingAction === "click") {
      const clickLabel = nextClickLabelRef.current;
      const currentPhase = addingClickPhaseRef.current;
      rlog("[onLeftPicked] click模式, nextClickLabel=", clickLabel, "addingClickMode=", addingClickModeRef.current, "phase=", currentPhase);
      // 不调用 performRealClick：picker 的 pointerdown 拦截后物理 click 仍会触发元素，
      // 再调 el.click() 会导致点击两次。物理点击已经完成。
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
      // 判断点击后的行为：添加点击按钮模式/教学搜索→确认人物/完成
      if (addingClickModeRef.current) {
        // 连续添加点击按钮模式：保持点击状态，使用对应phase的标签
        setNextClickLabel(currentPhase === "post" ? "收尾点击" : "前置点击");
        setPendingAction("click");
        setPickTarget(null);
        setTimeout(() => {
          if (addingClickModeRef.current) {
            window.electronAPI?.viewStartPicking("left");
            window.electronAPI?.viewStartPicking("right");
          }
        }, 200);
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
          label: `输入 · ${info.label || info.selector} ← Excel「${currentExcelCol}」`,
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
        const previewValue = (selected?.fields?.[currentExcelCol] || "").trim();
        if (previewValue) {
          setTimeout(() => {
            performInputValue("left", info.selector, previewValue).catch(() => {});
          }, 150);
        }
        // 绑定完输入框后退出绑定模式，用户可继续点搜索/确认人物进行页面跳转
        setBindInputSide(null);
        window.electronAPI?.viewStopPicking("left").catch(() => {});
        window.electronAPI?.viewStopPicking("right").catch(() => {});
      } else {
        // 非输入框：真实点击并记录为点击步骤
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
        setNextClickLabel(currentPhase === "post" ? "收尾点击" : "前置点击");
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
        label: `输入 · ${info.label || info.selector} ← Excel「${currentExcelCol}」`,
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
setLeftPicked(info);
// 审查模式（先右后左）：两侧已完成，等待保存；录入模式（先左后右）：左源拾取完成后继续拾取右侧元素
setPickTarget(currentLoopStepTypeRef.current === "entry" ? "right" : null);
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
    // 审查模式：若右侧已选则两侧完成（等待保存）；否则切到右侧选核对元素
    // 录入模式：左侧来源已选，切到右侧选要填入的输入框
    setPickTarget((prev) => {
      if (prev === "right" && rightPickedRef.current) return null; // 审查模式右侧已选 → 完成
      return "right"; // 其他情况 → 切到右侧
    });
    // 停止左侧网页拾取（合成值不需要网页点击）
    window.electronAPI?.viewStopPicking("left").catch(() => {});
  }, []);

  const saveMapping = (m: FieldMapping) => {
    setMappings((prev) => [
      ...prev.filter((x) => x.right_selector !== m.right_selector),
      m,
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
        side: "right",
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
    // 重置一轮，继续拾取下一个（审查模式回到右侧核对元素，录入模式回到左侧来源）
    setRightPicked(null);
    setLeftPicked(null);
    const nextTarget = currentLoopStepTypeRef.current === "entry" ? "left" : "right";
    setPickTarget(nextTarget as PickTarget);
    setTimeout(() => {
      if (nextTarget === "left") {
        window.electronAPI?.viewStopPicking("right").catch(() => {});
        window.electronAPI?.viewStartPicking("left");
      } else {
        window.electronAPI?.viewStopPicking("left").catch(() => {});
        window.electronAPI?.viewStartPicking("right");
      }
    }, 200);
    // 给右侧被选元素加个临时高亮提示已保存
    if (window.electronAPI) {
      window.electronAPI.viewHighlightBoxes("right", [
        { selector: m.right_selector, status: "pending", label: m.right_label || "已映射" },
      ]);
      setTimeout(() => window.electronAPI?.viewClearHighlight("right"), 1200);
    }
  };

  const removeMapping = (index: number) => {
    setMappings((prev) => prev.filter((_, i) => i !== index));
  };

  // ============ 控件提取模式（点击展开型控件：选项 / 日历） ============
  const toggleWidgetExtract = useCallback(() => {
    setWidgetExtractMode((prev) => {
      const next = !prev;
      if (!next) {
        // 退出时清理所有拾取状态（草稿与已保存映射保留）
        setWidgetPickKind(null);
        setWidgetRolePickingKey(null);
        setWidgetLeftPickingKey(null);
        setWidgetSnapshotError(null);
        window.electronAPI?.viewStopPicking("left").catch(() => {});
        window.electronAPI?.viewStopPicking("right").catch(() => {});
      }
      return next;
    });
  }, []);

  /** 开始拾取控件触发框（右侧网页） */
  const startWidgetPick = useCallback((kind: "option" | "calendar") => {
    setWidgetSnapshotError(null);
    setWidgetPickKind(kind);
    window.electronAPI?.viewStopPicking("left").catch(() => {});
    window.electronAPI?.viewStartPicking("right").catch(() => {});
  }, []);

  const cancelWidgetPick = useCallback(() => {
    setWidgetPickKind(null);
    window.electronAPI?.viewStopPicking("right").catch(() => {});
  }, []);

  /** 拾取到触发框后：执行快照脚本（点击展开 → 识别面板结构 → 关闭） */
  const runWidgetSnapshot = useCallback(async (triggerSelector: string, triggerLabel: string, kind: "option" | "calendar") => {
    if (!window.electronAPI) return;
    setWidgetSnapshotBusy(true);
    setWidgetSnapshotError(null);
    try {
      const res = (await window.electronAPI.viewExecuteJS("right", buildWidgetSnapshotScript(triggerSelector, kind))) as WidgetSnapshotResult | null;
      if (res && res.ok) {
        setWidgetDraft({
          id: `wg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          kind,
          triggerSelector,
          triggerLabel,
          panelSelector: res.panelSelector,
          options: kind === "option" ? res.options || [] : undefined,
          calendar: kind === "calendar" ? res.calendar || {} : undefined,
          createdAt: Date.now(),
        });
      } else {
        const reason = res?.reason || "unknown";
        setWidgetSnapshotError(WIDGET_SNAPSHOT_REASONS[reason] || `快照失败：${reason}`);
      }
    } catch (e) {
      console.warn("[widget] snapshot failed", e);
      setWidgetSnapshotError("快照脚本执行失败，请重试");
    } finally {
      setWidgetSnapshotBusy(false);
    }
  }, []);

  /** 请求重选日历角色：先脚本打开面板，再进入拾取 */
  const pickWidgetRole = useCallback((key: string, role: CalendarRole) => {
    const widget = key === "draft"
      ? widgetDraftRef.current
      : mappings.find((m) => m.right_selector === key.replace(/^saved:/, ""))?.widget;
    if (!widget) return;
    setWidgetRolePickingKey(`${key}:${role}`);
    // 拾取模式会拦截点击，所以用脚本打开面板
    window.electronAPI?.viewExecuteJS("right", buildWidgetOpenScript(widget.triggerSelector)).catch(() => {});
    setTimeout(() => {
      if (widgetRolePickingKeyRef.current) {
        window.electronAPI?.viewStartPicking("right").catch(() => {});
      }
    }, 450);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappings]);

  /** 请求从左侧网页拾取来源元素 */
  const pickWidgetLeftWeb = useCallback((key: string) => {
    setWidgetLeftPickingKey(key);
    window.electronAPI?.viewStopPicking("right").catch(() => {});
    window.electronAPI?.viewStartPicking("left").catch(() => {});
  }, []);

  /** 保存草稿控件为字段映射（走 saveMapping，自动生成 LOOP 步骤 mark） */
  const saveWidgetDraft = useCallback(() => {
    const draft = widgetDraftRef.current;
    const binding = widgetDraftBindingRef.current;
    if (!draft || !binding.leftField.trim()) return;
    saveMapping({
      right_selector: draft.triggerSelector,
      right_label: draft.triggerLabel || draft.triggerSelector,
      right_input_type: "widget",
      left_source: binding.leftSource,
      left_field: binding.leftField.trim(),
      left_record_key: binding.leftLabel || null,
      verify_method: "smart",
      widget: draft,
    });
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
    // 同步 mark 的取值字段（与 saveMapping 的规则一致）
    setPickedMarks((prev) => prev.map((mk) => {
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
    }));
  }, []);

  /** 删除已保存控件映射 */
  const removeSavedWidget = useCallback((rightSelector: string) => {
    setMappings((prev) => prev.filter((m) => m.right_selector !== rightSelector));
    setPickedMarks((prev) => {
      const filtered = prev.filter((mk) => !(mk.selector === rightSelector && mk.widget));
      return filtered.map((m, i) => ({ ...m, order: i + 1 }));
    });
  }, []);

  /** 试跑：用当前卡片的左侧值在右侧网页真实演练一遍 */
  const testWidget = useCallback(async (testKey: string, widget: WidgetDef, binding: WidgetBinding) => {
    if (!window.electronAPI) return;
    setWidgetTestBusyKey(testKey);
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
        const res = (await window.electronAPI.viewExecuteJS("right", buildOptionSelectScript(widget, value))) as OptionSelectResult | null;
        if (res?.ok) {
          setResult({ ok: true, message: `已自动选择「${res.clickedText}」（左侧值：${value}）` });
        } else {
          const avail = res?.options?.length ? `；面板选项：${res.options.slice(0, 6).join(" / ")}${res.options.length > 6 ? "…" : ""}` : "";
          setResult({ ok: false, message: `未匹配到「${value}」${avail}——可点击选项芯片标注别名` });
        }
      } else {
        const cands = parseDateCandidates(value);
        if (!cands.length) {
          setResult({ ok: false, message: `「${value}」不是可识别的日期（支持 2026/3/11、2026-03-11、2026年3月11日）` });
          return;
        }
        const [yy, mm, dd] = cands[0].split("-").map(Number);
        const res = (await window.electronAPI.viewExecuteJS("right", buildCalendarSetScript(widget, yy, mm, dd))) as CalendarSetResult | null;
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
          if (typeof payload === "string") setSelectedId(payload);
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
              postClickCount: pickedMarks.filter((m) => m.action === "click" && m.clickPhase === "post").length,
              docExtractStepCount: pickedMarks.filter((m) => m.docExtract).length,
              hasBoundInputs: pickedMarks.some((m) => m.action === "input" && !!m.variableField),
              hasConfirmClick: pickedMarks.some((m) => m.action === "click" && m.label.startsWith("确认人物")),
              cardsGenerated,
              rowRange,
              hasCheckedBatch: checkedIds.size > 0,
            });
          }
          break;
        }
      }
    });
    return off;
  }, [refreshRecords, clearRecords, removeMapping, removePickedMark, clearPickedMarks, replayAll, stopReplay, advanceToReviewPhase, abortTeaching, goBackTeachingPhase, browserLeftDetached, browserRightDetached, bottomDetached, leftUrl, rightUrl, selectMode, pickTarget, avatarMode, pendingAction, teachingPhase, selected, mappings, result, report, loopReports, steps, shots, running, pickedMarks, replaying, replayCursor, rightPicked, leftPicked, selectedExcelColumn, bindInputSide, nextClickLabel, addingStepMode, addingClickMode, addingDocExtractMode, cardsGenerated, rowRange, pickLeftFromWeb, pickLeftFromExcel, resetMappingRound, saveMapping, startBindBothInputs, exitBindInputs, startConfirmPerson, startAddingReviewSteps, startAddingEntrySteps, exitAddingStepMode, startAddClickStep, exitAddClickMode, undoLastStep, startAddDocExtract, exitAddDocExtractMode, requestDocFileExtract, exitSelectMode, setShowSaveSkill, setSaveSkillRunAfter, handleQuickSaveLoop, handleSaveToBatch]);

  // Excel 拾取：把字段包装成 PickedElementInfo，并打 tag 区分来源
  const onExcelPicked = (info: ExcelPickedField) => {
    // 用 ref 读取最新状态，避免 React 批量更新/闭包延迟导致 pendingAction 还是旧值
    const currentPendingAction = pendingActionRef.current;
    const currentInputTarget = inputTargetRef.current;
    console.log("[onExcelPicked] 收到 Excel 点击", { info, currentPendingAction, currentInputTarget });
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
    // 审查模式（左先右后）：Excel 来源确定后继续拾取右侧元素；录入模式（右先左后）：等待保存
    setPickTarget(addingStepModeRef.current === "entry" ? null : "right");
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
    });
  }, [bottomDetached, selected, mappings, result, report, loopReports, steps, shots, running, pickedMarks, replaying, replayCursor, teachingPhase, appMode, selectMode, checkedIds]);

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

  // 模态弹窗打开时隐藏主窗口 BrowserView，避免原生视图覆盖 HTML 弹窗
  useEffect(() => {
    if (!window.electronAPI) return;
    const anyModalOpen = showSettings || !!docFillData || showSaveSkill || showSkillPanel;
    if (anyModalOpen) {
      if (!browserLeftDetached && leftViewMode === "web") window.electronAPI.viewHide("left");
      if (!browserRightDetached) window.electronAPI.viewHide("right");
    } else {
      // 弹窗关闭后不要直接把 BrowserView 设成全屏，否则一旦同步延迟，
      // 原生视图会盖住整个窗口导致所有按钮无法点击。交给 BrowserPane 的
      // IntersectionObserver + sync() 在容器重绘后恢复正确 bounds。
      const timer = setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
      return () => clearTimeout(timer);
    }
  }, [showSettings, docFillData, showSaveSkill, showSkillPanel, browserLeftDetached, browserRightDetached, leftViewMode]);

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
        leftPickingKey={widgetLeftPickingKey}
        testResults={widgetTestResults}
        testBusyKey={widgetTestBusyKey}
        onStartPick={startWidgetPick}
        onCancelPick={cancelWidgetPick}
        onDraftChange={setWidgetDraft}
        onDraftBindingChange={setWidgetDraftBinding}
        onSaveDraft={saveWidgetDraft}
        onDiscardDraft={() => setWidgetDraft(null)}
        onUpdateSaved={updateSavedWidget}
        onUpdateSavedBinding={updateSavedWidgetBinding}
        onRemoveSaved={removeSavedWidget}
        onPickRole={pickWidgetRole}
        onPickLeftWeb={pickWidgetLeftWeb}
        onTest={testWidget}
      />
    );
  }, [
    widgetExtractMode, widgetDraft, savedWidgets, widgetPickKind, widgetSnapshotBusy, widgetSnapshotError,
    widgetDraftBinding, excelFields, selected, widgetRolePickingKey, widgetLeftPickingKey,
    widgetTestResults, widgetTestBusyKey,
    startWidgetPick, cancelWidgetPick, saveWidgetDraft, updateSavedWidget, updateSavedWidgetBinding,
    removeSavedWidget, pickWidgetRole, pickWidgetLeftWeb, testWidget,
  ]);

  // 脱离模式：根据 URL query param 渲染独立面板窗口
  const detachMode = getDetachMode();
  if (detachMode === "left") return <DetachedLeftPanel />;
  if (detachMode === "bottom") return <DetachedBottomPanel />;
  if (detachMode === "browser-left") return <DetachedBrowserPanel detachSide="browser-left" />;
  if (detachMode === "browser-right") return <DetachedBrowserPanel detachSide="browser-right" />;
  if (detachMode === "browser-excel") return <DetachedExcelPanel />;

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
          <img
            src={splashSvg}
            alt="CINSIDE"
            className="h-5"
          />
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
      <header className="glass-frame z-20 flex shrink-0 items-center gap-2 border-b border-white/40 px-3 py-1">
        {/* SKILL 管理按钮 */}
        <button
          onClick={() => setShowSkillPanel(true)}
          className="flex shrink-0 items-center gap-1 rounded-md bg-white/70 px-2 py-0.5 text-[11px] font-medium text-indigo-600 ring-1 ring-indigo-200 transition-all hover:bg-indigo-50 hover:text-indigo-700"
          title="查看已保存的 Loop 模板并执行"
        >
          <Sparkles className="h-3 w-3" />
          查看保存Loop
        </button>

        {/* 外挂插件开关 */}
        <button
          onClick={toggleDock}
          className={[
            "flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 transition-all",
            dockOpen
              ? "bg-emerald-600 text-white ring-emerald-500 hover:bg-emerald-700"
              : "bg-white/70 text-emerald-700 ring-emerald-200 hover:bg-emerald-50",
          ].join(" ")}
          title="站外循环：在屏幕边缘挂一个悬浮条，设置「提取源」和「操作页」后 AI 自主循环填写；数据痕迹见下方「站外循环记录」"
        >
          <Bot className="h-3 w-3" />
          {dockOpen ? "站外循环已开" : "站外循环"}
        </button>

        <div className="flex-1" />

        {/* pendingAction 状态指示器（S 输入 / 空格点击） */}
        {pendingAction !== "none" && (
          <div className={[
            "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium animate-glow-pulse",
            pendingAction === "input"
              ? "bg-blue-600 text-white ring-1 ring-blue-300"
              : "bg-emerald-600 text-white ring-1 ring-emerald-300",
          ].join(" ")}>
            <kbd className="rounded bg-white/20 px-1 py-0.5 text-[9px] font-bold">
              {pendingAction === "input" ? "S" : "Space"}
            </kbd>
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

        {/* 快捷键提示：空闲时显示 S/Space/R/Enter 帮助 */}
        {!replaying && (
          pickedMarks.length > 0 ? (
            <div className="hidden shrink-0 items-center gap-1 text-[10px] text-slate-400 lg:flex">
              <kbd className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[9px]">S</kbd>
              <span>输入</span>
              <kbd className="ml-1 rounded bg-slate-100 px-1 py-0.5 font-mono text-[9px]">Space</kbd>
              <span>点击</span>
              <kbd className="ml-1 rounded bg-slate-100 px-1 py-0.5 font-mono text-[9px]">R</kbd>
              <span>撤销</span>
              <kbd className="ml-1 rounded bg-slate-100 px-1 py-0.5 font-mono text-[9px]">Enter</kbd>
              <span>完成</span>
            </div>
          ) : null
        )}

        {/* 教学模式 / 录入流操作开关（仅录入模式显示"录入流操作"，LOOP/审查模式显示"教学模式"） */}
        <button
          onClick={() => (selectMode ? exitSelectMode() : enterSelectMode())}
          className={[
            "flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-all",
            selectMode
              ? "bg-slate-200 text-slate-600 ring-1 ring-slate-300 hover:bg-slate-300"
              : "bg-white/70 text-slate-600 ring-1 ring-slate-200 hover:bg-white hover:text-brand-700",
          ].join(" ")}
          title={appMode === "entry"
            ? "录入流操作：点右侧表单输入框，再从左侧 Excel 选对应字段填入"
            : "步骤设置：选中 Excel 列作为 LOOP 变量，依次配置输入、点击、审查、录入步骤"
          }
        >
          <MousePointerClick className="h-3 w-3" />
          {selectMode ? "退出选择" : (appMode === "entry" ? "录入流操作" : "步骤设置")}
        </button>

        {/* ============ 模式切换：LOOP 母容器，审查/录入/全流程 为内部切换键 ============ */}
        <div className="flex shrink-0 items-stretch overflow-hidden rounded-md ring-1 ring-slate-300 bg-slate-50">
          {/* LOOP 母标签：中性灰色，与内部切换键区分 */}
          <div className="flex items-center gap-1 bg-slate-200/80 px-2 py-0.5 text-[10px] font-bold tracking-wide text-slate-600">
            <Repeat2 className="h-3 w-3" />
            LOOP
          </div>
          {/* 内部切换键：审查 / 录入 / 全流程 */}
          <div className="flex items-center gap-0 bg-white/70 px-1 py-0.5">
            <button
              onClick={() => {
                if (teachingPhase !== "idle" || batchRunning) return;
                setAppMode("review");
                setWorkflowTemplate(null);
                if (selectMode) {
                  setPickTarget("right");
                  setRightPicked(null);
                  setLeftPicked(null);
                  setAddingStepMode(null);
                  setAddingClickMode(false);
                  setTimeout(() => {
                    window.electronAPI?.viewStopPicking("left").catch(() => {});
                    window.electronAPI?.viewStartPicking("right");
                  }, 200);
                }
              }}
              disabled={teachingPhase !== "idle" || batchRunning}
              className={[
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-all",
                appMode === "review"
                  ? "bg-sky-500 text-white shadow-sm"
                  : "text-slate-500 hover:bg-sky-50 hover:text-sky-700",
                (teachingPhase !== "idle" || batchRunning) ? "cursor-not-allowed opacity-60" : "",
              ].join(" ")}
              title="包含审查步骤：对页面字段进行核对校验"
            >
              <ShieldCheck className="h-2.5 w-2.5" />
              审查
            </button>
            <button
              onClick={() => {
                if (teachingPhase !== "idle" || batchRunning) return;
                setAppMode("entry");
                setWorkflowTemplate(null);
                if (selectMode) {
                  setPickTarget("left");
                  setRightPicked(null);
                  setLeftPicked(null);
                  setAddingStepMode(null);
                  setAddingClickMode(false);
                  setTimeout(() => {
                    window.electronAPI?.viewStopPicking("right").catch(() => {});
                    window.electronAPI?.viewStartPicking("left");
                  }, 200);
                }
              }}
              disabled={teachingPhase !== "idle" || batchRunning}
              className={[
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-all",
                appMode === "entry"
                  ? "bg-violet-500 text-white shadow-sm"
                  : "text-slate-500 hover:bg-violet-50 hover:text-violet-700",
                (teachingPhase !== "idle" || batchRunning) ? "cursor-not-allowed opacity-60" : "",
              ].join(" ")}
              title="包含录入步骤：把 Excel 数据批量填入表单"
            >
              <ClipboardEdit className="h-2.5 w-2.5" />
              录入
            </button>
            <button
              onClick={() => {
                if (teachingPhase !== "idle" || batchRunning) return;
                setAppMode("loop");
                setWorkflowTemplate(null);
                if (selectMode) {
                  setPickTarget(null);
                  setRightPicked(null);
                  setLeftPicked(null);
                  setAddingStepMode(null);
                  setAddingClickMode(false);
                  window.electronAPI?.viewStopPicking("left").catch(() => {});
                  window.electronAPI?.viewStopPicking("right").catch(() => {});
                }
              }}
              disabled={teachingPhase !== "idle" || batchRunning}
              className={[
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-all",
                appMode === "loop"
                  ? "bg-indigo-500 text-white shadow-sm"
                  : "text-slate-500 hover:bg-indigo-50 hover:text-indigo-700",
                (teachingPhase !== "idle" || batchRunning) ? "cursor-not-allowed opacity-60" : "",
              ].join(" ")}
              title="完整 LOOP：审查 + 录入 全部步骤"
            >
              全流程
            </button>
          </div>
        </div>

        {/* ============ 教学完成后的批量执行按钮（仅 LOOP/录入模式显示） ============ */}
        {appMode !== "review" && teachingPhase === "done" && workflowTemplate && !batchRunning && (
          <button
            onClick={() => runBatch()}
            disabled={records.length === 0}
            className={[
              "flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-all",
              records.length === 0
                ? "bg-white/40 text-slate-300 ring-1 ring-slate-200 cursor-not-allowed"
                : "bg-emerald-600 text-white shadow-sm ring-1 ring-emerald-300 hover:bg-emerald-700",
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
            className="flex items-center gap-1 rounded-md bg-rose-600 px-2 py-0.5 text-[11px] font-medium text-white shadow-sm ring-1 ring-rose-300 transition-all hover:bg-rose-700 animate-glow-pulse"
            title="停止批量执行"
          >
            <Square className="h-3 w-3" />
            停止 ({batchCursor + 1}/{records.length})
          </button>
        )}

        {/* 重新配置按钮：配置已完成但想重新设置（仅 LOOP/录入模式显示） */}
        {appMode !== "review" && teachingPhase === "done" && workflowTemplate && !batchRunning && (
          <button
            onClick={startTeaching}
            className="flex items-center gap-1 rounded-md bg-white/70 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 transition-all hover:bg-white hover:text-amber-700"
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
            className="flex items-center gap-1 rounded-md bg-white/70 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 transition-all hover:bg-white hover:text-indigo-700"
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
                  : "bg-brand-600 hover:bg-brand-700 active:scale-[.98] shadow-sm",
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
              running || mappings.length === 0 || (!selected && !mappings.every((m) => m.left_source === "database"))
                ? "cursor-not-allowed bg-slate-400"
                : "bg-brand-600 hover:bg-brand-700 active:scale-[.98] shadow-sm",
            ].join(" ")}
            title={
              running
                ? "核验进行中…"
                : mappings.length === 0
                ? `请先配置至少一条字段映射（已拾取 ${pickedMarks.length} 个节点，已保存 ${mappings.length} 条映射）`
                : !selected && !mappings.every((m) => m.left_source === "database")
                ? "未选择记录时，只能核验左侧来源全部为网页的映射"
                : `开始核验（${mappings.length} 条映射）`
            }
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {running ? "核验中…" : "开始核验"}
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

      {/* 错误提示 */}
      {error && (
        <div className="mx-4 mt-2 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 animate-slide-up">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-rose-400 hover:text-rose-600">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {/* 成功提示（绿色，2.5 秒后自动收回） */}
      {success && (
        <div className="mx-4 mt-2 flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700 animate-slide-up ring-1 ring-emerald-200">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{success}</span>
          <button
            onClick={() => {
              if (successTimerRef.current != null) window.clearTimeout(successTimerRef.current);
              setSuccess(null);
            }}
            className="ml-auto text-emerald-400 hover:text-emerald-600"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

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
              onSelect={setSelectedId}
              onRefresh={refreshRecords}
              onClear={clearRecords}
              recordResults={recordResults}
              batchResults={batchResults}
              onDetach={() => detachPanel("left")}
              onRunRecord={runSingleRecord}
              runDisabled={batchRunning || singleRunning}
              runningRecordId={singleRunning ? selectedId : null}
              onPickDocument={handleDocFilePick}
              docExtracting={docFileExtracting}
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
              onExcelUploaded={(map) => {
                setDetectedColumnMap(map);
                const autoMap: Record<string, string> = {};
                Object.entries(map).forEach(([origCol, stdField]) => { autoMap[stdField] = origCol; });
                setFieldColumnMap((prev) => ({ ...autoMap, ...prev }));
              }}
              detectedColumnMap={detectedColumnMap}
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
            className={`flex min-h-0 min-w-0 flex-1 gap-1 overflow-hidden transition-[padding] duration-500 ${executionPanelOpen ? "pr-[360px]" : edgeButtonVisible ? "pr-12" : ""}`}
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
                  hasExcelData={records.length > 0}
                  onRequestAddExcel={() => browserExcelInputRef.current?.click()}
                  onExcelDrop={handleBrowserExcelUpload}
                  onCloseExcel={handleCloseLeftExcel}
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
                  picking={(selectMode && pickTarget === "left") || avatarMode || (pendingAction === "click" && (pickTarget === "left" || (teachingPhase !== "idle" && !!nextClickLabel) || addingClickMode)) || (pendingAction === "input" && pickTarget === "left") || !!bindInputSide || (teachingPhase !== "idle" && !!nextClickLabel && pickTarget === "left") || !!customTextPickingId}
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
                      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const f = e.dataTransfer.files?.[0];
                        if (f) handleBrowserExcelUpload(f);
                      }}
                    >
                      {browserExcelUploading ? (
                        <>
                          <Loader2 className="h-10 w-10 animate-spin text-emerald-500" />
                          <p className="text-xs text-slate-500">正在解析 Excel...</p>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => browserExcelInputRef.current?.click()}
                            className="group flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50/80 px-8 py-6 transition-all hover:border-emerald-400 hover:bg-emerald-50/50"
                          >
                            <FileSpreadsheet className="h-10 w-10 text-slate-400 transition-colors group-hover:text-emerald-500" />
                            <div>
                              <p className="text-sm font-medium text-slate-600 group-hover:text-emerald-700">Excel / CSV</p>
                              <p className="text-[11px] text-slate-400">点击或拖拽文件到此处上传</p>
                            </div>
                          </button>
                        </>
                      )}
                    </div>
                  }
                >
                  {records.length > 0 && leftViewMode === "excel" && (
                    <ExcelView
                      embedded={true}
                      records={records}
                      selectedId={selectedId}
                      picking={(selectMode && pickTarget === "left") || pendingAction === "input"}
                      onPickedField={onExcelPicked}
                      pickedMarks={pickedMarks}
                      selectedColumn={selectedExcelColumn}
                      onSelectColumn={setSelectedExcelColumn}
                      rowRange={rowRange}
                      onRowRangeChange={setRowRange}
                      cardsGenerated={cardsGenerated}
                      onGenerateCards={generateCards}
                      onResetCards={resetCards}
                      fieldColumnMap={fieldColumnMap}
                      onFieldColumnMapChange={handleFieldColumnMapChange}
                      detectedColumnMap={detectedColumnMap}
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
                  enableTabs={true}
                  enableViewSwitch={true}
                  viewMode={rightViewMode}
                  onViewModeChange={(mode) => {
                    setRightViewMode(mode);
                  }}
                  excelTabTitle="参考Excel"
                  hasExcelData={rightRecords.length > 0}
                  onRequestAddExcel={() => rightExcelInputRef.current?.click()}
                  onExcelDrop={handleRightExcelUpload}
                  onCloseExcel={handleCloseRightExcel}
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
                  picking={(selectMode && pickTarget === "right") || (pendingAction === "click" && (pickTarget === "right" || (teachingPhase !== "idle" && !!nextClickLabel) || addingClickMode)) || (pendingAction === "input" && pickTarget === "right") || !!bindInputSide || (teachingPhase !== "idle" && !!nextClickLabel && pickTarget === "right") || !!customTextPickingId}
                  onPickedElement={onRightPicked}
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
                      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const f = e.dataTransfer.files?.[0];
                        if (f) handleRightExcelUpload(f);
                      }}
                    >
                      {rightExcelUploading ? (
                        <>
                          <Loader2 className="h-10 w-10 animate-spin text-emerald-500" />
                          <p className="text-xs text-slate-500">正在解析 Excel...</p>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => rightExcelInputRef.current?.click()}
                            className="group flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50/80 px-8 py-6 transition-all hover:border-sky-400 hover:bg-sky-50/50"
                          >
                            <FileSpreadsheet className="h-10 w-10 text-slate-400 transition-colors group-hover:text-sky-500" />
                            <div>
                              <p className="text-sm font-medium text-slate-600 group-hover:text-sky-700">Excel / CSV</p>
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
                            className="flex items-center rounded bg-indigo-600 px-1.5 py-0.5 text-[9px] font-medium text-white transition-all hover:bg-indigo-700"
                            title="审查流 DEMO：已提交申请表（含故意错误）"
                          >
                            审查DEMO
                          </button>
                          <button
                            onClick={() => setRightUrl("http://localhost:8000/demo-entry/")}
                            className="flex items-center rounded bg-emerald-600 px-1.5 py-0.5 text-[9px] font-medium text-white transition-all hover:bg-emerald-700"
                            title="录入流 DEMO：空白申请表单"
                          >
                            录入DEMO
                          </button>
                        </>
                      )}
                    </div>
                  }
                >
                  {rightRecords.length > 0 && rightViewMode === "excel" && (
                    <ExcelView
                      embedded={true}
                      records={rightRecords}
                      selectedId={null}
                      picking={false}
                      pickedMarks={[]}
                      selectedColumn={null}
                      onSelectColumn={() => {}}
                      rowRange={null}
                      onRowRangeChange={() => {}}
                      cardsGenerated={false}
                      onGenerateCards={() => {}}
                      onResetCards={() => {}}
                      onPickedField={() => {}}
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

          {/* 垂直可拖拽分隔条：仅在审查面板可见时显示 */}
          {bottomPanelOpen && !bottomDetached && (
            <div
              className="relative z-10 h-1.5 shrink-0 cursor-row-resize select-none"
              onMouseDown={(e) => {
                e.preventDefault();
                vDraggingRef.current = true;
                document.body.style.cursor = "row-resize";
                document.body.style.userSelect = "none";
              }}
              title="拖拽调整审查面板高度"
            >
              <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-slate-200 hover:bg-brand-300" />
            </div>
          )}

          {/* 审查/结果面板：教学模式开启时内部左右分栏（教学面板 | 结果），否则上下堆叠 */}
          {bottomPanelOpen && !bottomDetached && (
            <div
              className={[
                "flex min-h-0 shrink-0 gap-0 overflow-hidden",
                selectMode ? "flex-row" : "flex-col",
              ].join(" ")}
              style={{
                height: `${bottomPanelHeight}%`,
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
              {/* ElementSelectBar 教学面板 —— 左侧 */}
              {selectMode && teachingPanelSide === "left" && (
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
                    selectedExcelColumn={selectedExcelColumn}
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
                    postClickCount={postClickCount}
                    onStartAddPreClick={() => startAddClickStep("pre")}
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
                  />
                </div>
              )}

              {/* 教学面板水平拖拽分隔条（左侧教学面板时） */}
              {selectMode && teachingPanelSide === "left" && (
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
                  appMode={appMode}
                  onDetach={() => detachPanel("bottom")}
                  onClose={selectMode ? undefined : () => setBottomPanelOpen(false)}
                  docExtracts={currentDocExtracts}
                  activeDocIndex={safeDocIndex}
                  onSelectDocIndex={setActiveDocIndex}
                  docExtracting={docExtracting}
                  switchToDocSignal={docSignal}
                  addingStepMode={addingStepMode}
                  onPickExtractedField={onPickExtractedField}
                  docLocalConfigContent={addingDocExtractMode && (docExtractSource === "choose" || docExtractSource === "local" || docExtractSource === "web") ? (
                    <DocLocalExtractConfig
                      mode={docExtractSource}
                      excelFields={excelFields}
                      selectedExcelColumn={selectedExcelColumn}
                      docFileBindField={docFileBindField}
                      onSetDocFileBindField={setDocFileBindField}
                      onChooseWeb={chooseDocExtractWeb}
                      onChooseLocal={chooseDocExtractLocal}
                      onExitChoose={exitAddDocExtractMode}
                      webStepCount={pickedMarks.filter((m) => m.docExtractClick && m.docExtractClickPhase !== "post").length}
                      webPostStepCount={pickedMarks.filter((m) => m.docExtractClick && m.docExtractClickPhase === "post").length}
                      onStartAddPostClicks={startDocExtractPostClicks}
                      onStartAddPreClicks={startDocExtractPreClicks}
                      onExitWebMode={exitAddDocExtractMode}
                      onUndoClick={undoDocExtractClick}
                      onGoBack={docExtractGoBack}
                      onResumePicking={forceResumeDocPicking}
                      webStatus={docExtractSource === "web" ? docWebStatus : undefined}
                      docLocalRootPath={docLocalRootPath}
                      docLocalDirFiles={docLocalDirFiles}
                      docLocalSamplePath={docLocalSamplePath}
                      docLocalPattern={docLocalPattern}
                      onPickLocalDirectory={pickLocalDirectory}
                      onSelectDocLocalSample={selectDocLocalSample}
                      onConfirm={confirmDocLocalExtract}
                      // 网页模式内嵌提取结果（替代外部弹窗）
                      webResult={docExtractSource === "web" ? docExtractPanel : null}
                      onCloseWebResult={() => { setDocExtractPanel(null); setSameNameImages(null); }}
                      webSameNameImages={sameNameImages}
                      webFindingSameName={findingSameName}
                      onFindSameName={findSameNameImages}
                      onExtractFields={sendDocFieldsToExtractPanel}
                      onExportDoc={() => setDocExportOpen(true)}
                      onBindUploadDoc={startBindUpload}
                      onQuickUploadDoc={(fileData) => startQuickUpload(fileData)}
                      onToast={(msg) => setSuccessToast(msg)}
                      onError={(msg) => setError(msg)}
                      // 源文件预览（字段送「提取元素」后仍保留显示）
                      sourcePreview={docSourcePreview}
                      onCloseSourcePreview={() => setDocSourcePreview(null)}
                      // 预览就绪后点击触发 OCR
                      onTriggerWebExtract={triggerWebExtract}
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
                            // 非LOOP模式，走手动提取流程
                            pendingWebFileRef.current = {
                              dataUrl: file.dataUrl,
                              filename: file.filename,
                              size: file.size,
                              side: fallbackSide,
                            };
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
                    docExtractSplitView ? "doc-extract" as const
                    : addingDocExtractMode ? "doc" as const
                    : customTextMode ? null
                    : widgetExtractMode ? null
                    : (addingStepMode || addingClickMode) ? "field" as const
                    : null
                  }
                  preClickMarks={pickedMarks.filter((m) => (m.action === "click" && m.clickPhase === "pre") || (m.action === "input" && m.workflow === "data-source"))}
                  postClickMarks={pickedMarks.filter((m) => m.action === "click" && m.clickPhase === "post")}
                  reviewMappings={mappings}
                  onRemoveMark={removePickedMark}
                  onPreviewMark={(mark) => {
                    // 在对应网页高亮显示元素位置：点击卡片 → 网页上弹出定位框
                    const side = mark.side || "right";
                    const selector = mark.selector;
                    if (!selector) return;
                    const label = mark.label || "";
                    rlog(`[onPreviewMark] 在${side}侧网页高亮元素: ${selector}`);
                    window.electronAPI?.viewHighlightBoxes(side, [{ selector, status: "pending", label }]).catch(() => {});
                    // 2 秒后自动清除高亮
                    setTimeout(() => {
                      window.electronAPI?.viewHighlightBoxes(side, []).catch(() => {});
                    }, 2000);
                  }}
                  onSaveToBatch={handleSaveToBatch}
                  hasCheckedBatch={checkedIds.size > 0}
                  customTextContent={customTextContent}
                  customTextMode={customTextMode}
                  widgetExtractContent={widgetExtractContent}
                  widgetSetupSignal={widgetExtractMode}
                  records={records}
                  onSelectRecord={(id) => {
                    setSelectedId(id);
                    setBottomPanelOpen(true);
                    exitAddingStepMode();
                    setDocExtractSplitView(false);
                    setDocSignal((s) => s + 1);
                  }}
                  execPhase={execPhase}
                  currentMarkOrder={batchMarkCursor?.markOrder ?? null}
                  activeVerifyIdx={verifyFieldIdx}
                  reviewFieldResults={reviewFieldResults}
                  allPickedMarks={[...pickedMarks].sort((a, b) => a.order - b.order)}
                />
              </div>

              {/* 教学面板水平拖拽分隔条（右侧教学面板时） */}
              {selectMode && teachingPanelSide === "right" && (
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

              {/* ElementSelectBar 教学面板 —— 右侧 */}
              {selectMode && teachingPanelSide === "right" && (
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
                    selectedExcelColumn={selectedExcelColumn}
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
                    postClickCount={postClickCount}
                    onStartAddPreClick={() => startAddClickStep("pre")}
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
                  />
                </div>
              )}
            </div>
          )}

          {/* 元素选择条：下面板关闭或脱离但仍在教学模式时，底部仅显示工具条（悬浮/固定） */}
          {!bottomPanelOpen && selectMode && (
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
                selectedExcelColumn={selectedExcelColumn}
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
                postClickCount={postClickCount}
                onStartAddPreClick={() => startAddClickStep("pre")}
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
              />
            </div>
          )}
        </section>
      </main>

      {/* 设置弹窗 */}
      {showSettings && (
        <SettingsModal
          initial={settings}
          onClose={() => setShowSettings(false)}
          onSaved={(s) => {
            setSettings(s);
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
      )}

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

      {/* ============ 教学引导浮层：宝宝式一步步指引（未进入元素选择模式时显示） ============ */}
      {teachingPhase !== "idle" && !selectMode && !showSettings && !bottomDetached && (
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


      {/* ============ 批量执行进度浮层 ============ */}
      {batchRunning && (
        <BatchProgress
          cursor={batchCursor}
          total={batchTargets.length || cardRecords.length}
          results={batchResults}
          records={batchTargets.length > 0 ? batchTargets : cardRecords}
          onStop={stopBatch}
          positionClass={leftPanelOpen && !leftDetached ? "left-3 top-14" : "right-4 top-12"}
        />
      )}

      {/* ============ 文件提取审查面板：原图 + 提取字段框 + 同名图片对比 ============ */}
      {/* 网页下载模式下结果内嵌在下方「文件提取配置」面板内，不再弹窗 */}
      {docExtractPanel && !(addingDocExtractMode && docExtractSource === "web") && (
        <DocExtractReviewPanel
          panel={docExtractPanel}
          onClose={() => {
            setDocExtractPanel(null);
            setSameNameImages(null);
          }}
          sameNameImages={sameNameImages}
          findingSameName={findingSameName}
          onFindSameName={findSameNameImages}
          onExtractFields={sendDocFieldsToExtractPanel}
          onExport={() => setDocExportOpen(true)}
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

      {/* ============ SKILL 管理面板 ============ */}
      <SkillPanel
        open={showSkillPanel}
        onClose={() => setShowSkillPanel(false)}
        onRunSkill={handleRunSkill}
        onSkillsChange={() => setSkillVersion((v) => v + 1)}
      />

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

      {/* ============ LOOP 执行气泡通知（运行时从右侧冒出，面板打开时隐藏） ============ */}
      {!executionPanelOpen && (
        <ExecutionBubbles
          steps={steps}
          running={running || singleRunning || batchRunning || queueRunning}
          onAllGone={() => {
            if (hasRunOnce) setEdgeButtonVisible(true);
          }}
        />
      )}

      {/* ============ 右侧独立「执行进度」面板 ============ */}
      <ExecutionPanel
        open={executionPanelOpen}
        steps={steps}
        logEndRef={logEndRef}
        onClose={() => {
          setExecutionPanelOpen(false);
          if (hasRunOnce && !isAnyRunning) setEdgeButtonVisible(true);
        }}
      />

      {/* ============ 右侧边缘「执行进度」浮动按钮（气泡消失后显示，面板打开时隐藏） ============ */}
      {hasRunOnce && edgeButtonVisible && !selectMode && !executionPanelOpen && (
        <button
          onClick={() => setExecutionPanelOpen(true)}
          className={[
            "fixed right-0 top-1/2 z-[9996] -translate-y-1/2 transition-all duration-500",
            "flex items-center gap-2 rounded-l-xl px-3 py-4 shadow-lg backdrop-blur-sm",
            "border border-r-0 border-slate-200 bg-white/90 hover:bg-white",
            "animate-slide-in-right",
          ].join(" ")}
          title="查看执行进度"
        >
          <div className="flex flex-col items-center gap-1">
            <Activity className="h-4 w-4 text-brand-600" />
            <span className="[writing-mode:vertical-rl] text-[11px] font-semibold tracking-wider text-slate-700">
              执行进度
            </span>
          </div>
        </button>
      )}
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
const DOC_KEY_FIELDS = ["surname", "given_name", "name", "passport_no", "birth_date", "issue_place", "nationality", "gender", "passport_issue", "passport_expiry"];
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

// ============ 批量执行进度浮层组件 ============
function BatchProgress({
  cursor,
  total,
  results,
  records,
  onStop,
  positionClass = "left-3 top-14",
}: {
  cursor: number;
  total: number;
  results: Record<string, BatchResult>;
  records: ApplicantRecord[];
  onStop: () => void;
  /** 浮层位置类：默认锚定左侧人物卡片区（React 层），避免被右侧原生 BrowserView 覆盖（z-index 对原生视图无效） */
  positionClass?: string;
}) {
  const successCount = Object.values(results).filter((r) => r.status === "success").length;
  const failedCount = Object.values(results).filter((r) => r.status === "failed").length;
  const progress = total > 0 ? Math.round(((cursor + 1) / total) * 100) : 0;

  return (
    <div className={`pointer-events-auto fixed ${positionClass} z-50 w-[244px]`}>
      <div className="overflow-hidden rounded-xl border border-emerald-200 bg-white/95 shadow-2xl backdrop-blur-xl">
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b border-emerald-100 bg-gradient-to-r from-emerald-50 to-teal-50 px-3 py-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-600" />
          <span className="text-[11px] font-semibold text-emerald-900">批量执行中</span>
          <span className="ml-auto text-[10px] text-emerald-700">
            {cursor + 1}/{total}
          </span>
        </div>

        {/* 进度条 */}
        <div className="h-1 bg-emerald-100">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* 统计 */}
        <div className="grid grid-cols-3 gap-2 px-3 py-2 text-center">
          <div>
            <div className="text-[14px] font-bold text-emerald-600">{successCount}</div>
            <div className="text-[9px] text-slate-500">成功</div>
          </div>
          <div>
            <div className="text-[14px] font-bold text-rose-600">{failedCount}</div>
            <div className="text-[9px] text-slate-500">失败</div>
          </div>
          <div>
            <div className="text-[14px] font-bold text-slate-600">{total - successCount - failedCount}</div>
            <div className="text-[9px] text-slate-500">待执行</div>
          </div>
        </div>

        {/* 当前卡片 */}
        {cursor >= 0 && cursor < records.length && (
          <div className="border-t border-slate-100 px-3 py-1.5">
            <div className="text-[9px] text-slate-400">正在执行</div>
            <div className="truncate text-[11px] font-medium text-slate-700">
              {records[cursor].fields.name || records[cursor].record_id}
            </div>
          </div>
        )}

        {/* 最近失败 */}
        {Object.values(results).filter((r) => r.status === "failed").slice(-2).map((r) => (
          <div key={r.recordId} className="border-t border-rose-100 bg-rose-50/50 px-3 py-1 text-[10px] text-rose-700">
            <div className="font-medium">✗ {records.find((x) => x.record_id === r.recordId)?.fields.name || r.recordId}</div>
            {r.error && <div className="truncate text-rose-500">{r.error}</div>}
          </div>
        ))}

        {/* 停止按钮 */}
        <button
          onClick={onStop}
          className="w-full border-t border-slate-100 bg-rose-50 py-1.5 text-[11px] font-medium text-rose-700 hover:bg-rose-100"
        >
          停止批量执行
        </button>
      </div>
    </div>
  );
}
