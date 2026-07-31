import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Database,
  Eye,
  ExternalLink,
  FileText,
  Keyboard,
  Loader2,
  MinusCircle,
  MousePointerClick,
  MoveRight,
  PanelRightOpen,
  PanelRightClose,
  Save,
  Settings2,
  Table2,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import type {
  AppMode,
  DocExtractState,
  FieldComparison,
  FieldMapping,
  FieldMatch,
  PickedMark,
  ScreenshotEvent,
  VerificationReport,
  VerificationStep,
} from "../types";
import {
  FIELD_LABELS,
  MATCH_LABELS,
  OVERALL_LABELS,
} from "../types";

interface Props {
  comparisons: FieldComparison[];
  resultPresent: boolean;
  report: VerificationReport | null;
  loopReports?: VerificationReport[];
  shots: ScreenshotEvent[];
  steps?: VerificationStep[];
  running: boolean;
  appMode?: AppMode;
  onDetach?: () => void;
  onClose?: () => void;
  docExtracts?: DocExtractState[];
  activeDocIndex?: number;
  onSelectDocIndex?: (i: number) => void;
  docExtracting?: boolean;
  switchToDocSignal?: number;
  addingStepMode?: "review" | "entry" | null;
  onPickExtractedField?: (side: "left" | "right", field: string, value: string) => void;
  /** 本地文件提取配置内容（有值时"文件处理"卡片显示它，替代正常内容） */
  docLocalConfigContent?: React.ReactNode;
  /** 聚焦面板模式："field"=只显示字段对比，"doc"=只显示文件处理，null=三面板 */
  focusPanel?: "field" | "doc" | null;
  /** 字段对比设置模式数据：前置点击 marks */
  preClickMarks?: PickedMark[];
  /** 字段对比设置模式数据：收尾点击 marks */
  postClickMarks?: PickedMark[];
  /** 字段对比设置模式数据：已配置的审查映射 */
  reviewMappings?: FieldMapping[];
  /** 删除一个 picked mark（前置/收尾点击） */
  onRemoveMark?: (id: string) => void;
  /** 点击卡片预览：在对应网页高亮显示元素位置 */
  onPreviewMark?: (mark: PickedMark) => void;
  /** 保存当前步骤配置到这批勾选的卡片（分割批次用） */
  onSaveToBatch?: () => void;
  /** 当前是否有勾选的卡片（控制"保存到这批"按钮显隐） */
  hasCheckedBatch?: boolean;
}

export default function ResultsPanel({
  comparisons,
  resultPresent,
  report,
  loopReports = [],
  shots,
  steps = [],
  running,
  appMode = "loop",
  onDetach,
  onClose,
  docExtracts = [],
  activeDocIndex = 0,
  onSelectDocIndex,
  docExtracting = false,
  addingStepMode = null,
  onPickExtractedField,
  docLocalConfigContent,
  focusPanel = null,
  preClickMarks = [],
  postClickMarks = [],
  reviewMappings = [],
  onRemoveMark,
  onPreviewMark,
  onSaveToBatch,
  hasCheckedBatch = false,
}: Props) {
  return (
    <div className="glass-strong relative flex h-full flex-col overflow-hidden rounded-2xl">
      {/* 右上角悬浮按钮（脱离、关闭） */}
      <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5">
        {onDetach && (
          <button
            onClick={onDetach}
            className="rounded-md p-1 text-slate-400 opacity-60 transition-all hover:bg-white/80 hover:text-brand-600 hover:opacity-100"
            title="脱离到独立窗口"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
        {onClose && (
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 opacity-60 transition-all hover:bg-rose-50 hover:text-rose-500 hover:opacity-100"
            title="收起面板"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <ReportTab
          report={report}
          reports={loopReports}
          comparisons={comparisons}
          resultPresent={resultPresent}
          docExtracts={docExtracts}
          activeDocIndex={activeDocIndex}
          onSelectDocIndex={onSelectDocIndex}
          docExtracting={docExtracting}
          shots={shots}
          running={running}
          steps={steps}
          appMode={appMode}
          addingStepMode={addingStepMode}
          onPickExtractedField={onPickExtractedField}
          docLocalConfigContent={docLocalConfigContent}
          focusPanel={focusPanel}
          preClickMarks={preClickMarks}
          postClickMarks={postClickMarks}
          reviewMappings={reviewMappings}
          onRemoveMark={onRemoveMark}
          onPreviewMark={onPreviewMark}
          onSaveToBatch={onSaveToBatch}
          hasCheckedBatch={hasCheckedBatch}
        />
      </div>
    </div>
  );
}

// ============ 左右并排对比（把左右侧网页一左一右 COPY 到一起，逐项打勾/打叉） ============
interface SideCompareRow {
  key: string;
  leftLabel: string;
  leftValue: string;
  rightLabel: string;
  rightValue: string;
  match: FieldMatch;
  note?: string | null;
}

function MatchIcon({ match }: { match: FieldMatch }) {
  if (match === "match") return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
  if (match === "mismatch" || match === "error") return <XCircle className="h-5 w-5 text-rose-500" />;
  return <MinusCircle className="h-5 w-5 text-amber-400" />;
}

function SideBySideCompare({
  rows,
  appMode,
  leftHeader,
  rightHeader,
  hint,
}: {
  rows: SideCompareRow[];
  appMode: AppMode;
  /** 自定义左/右表头（默认：左侧网页/EXCEL、右侧网页） */
  leftHeader?: string;
  rightHeader?: string;
  /** 自定义方向指示（替换默认 LOOP/录入 提示） */
  hint?: React.ReactNode;
}) {
  const isReview = appMode !== "entry";
  const matchCount = rows.filter((r) => r.match === "match").length;
  return (
    <div>
      {/* 方向指示：LOOP/审查=右侧网页→左侧/EXCEL；录入=左侧EXCEL→右侧网页 */}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-600">
          {hint ?? (isReview ? (
            <>
              <span className="text-emerald-700">右侧网页</span>
              <MoveRight className="h-3 w-3 text-slate-400" />
              <span className="text-blue-700">左侧网页 / EXCEL</span>
              <span className="text-slate-400">（{appMode === "loop" ? "LOOP" : "审查"}：以左侧为基准核对右侧）</span>
            </>
          ) : (
            <>
              <span className="text-blue-700">左侧EXCEL</span>
              <MoveRight className="h-3 w-3 text-slate-400" />
              <span className="text-emerald-700">右侧网页</span>
              <span className="text-slate-400">（录入：把左侧数据填入右侧后核对）</span>
            </>
          ))}
        </span>
        <span className="text-slate-400">
          {matchCount}/{rows.length} 项一致
        </span>
      </div>

      {/* 并排 COPY 视图：左侧一份、右侧一份，中间打勾/打叉 */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-slate-200">
        {/* 表头 */}
        <div className="border-b border-slate-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700">
          {leftHeader ?? "左侧网页 / EXCEL"}
        </div>
        <div className="w-12 border-b border-x border-slate-200 bg-slate-50 px-1 py-2 text-center text-[10px] font-medium text-slate-400">
          对比
        </div>
        <div className="border-b border-slate-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
          {rightHeader ?? "右侧网页"}
        </div>

        {rows.map((r, i) => {
          const mismatch = r.match === "mismatch" || r.match === "error";
          const matched = r.match === "match";
          return (
            <Fragment key={r.key}>
              {/* 左侧 COPY */}
              <div
                className={[
                  "px-3 py-2",
                  i < rows.length - 1 ? "border-b border-slate-100" : "",
                  mismatch ? "bg-rose-50/50" : matched ? "bg-emerald-50/30" : "",
                ].join(" ")}
                title={r.note || ""}
              >
                <div className="text-[10px] leading-tight text-slate-400">{r.leftLabel}</div>
                <div className={`break-all font-mono text-xs ${mismatch ? "font-semibold text-rose-700" : "text-slate-800"}`}>
                  {r.leftValue || "—"}
                </div>
              </div>
              {/* 对比图标 */}
              <div
                className={[
                  "flex w-12 items-center justify-center border-x border-slate-100",
                  i < rows.length - 1 ? "border-b" : "",
                  mismatch ? "bg-rose-50/50" : matched ? "bg-emerald-50/30" : "",
                ].join(" ")}
                title={r.note || MATCH_LABELS[r.match]}
              >
                <MatchIcon match={r.match} />
              </div>
              {/* 右侧 COPY */}
              <div
                className={[
                  "px-3 py-2",
                  i < rows.length - 1 ? "border-b border-slate-100" : "",
                  mismatch ? "bg-rose-50/50" : matched ? "bg-emerald-50/30" : "",
                ].join(" ")}
                title={r.note || ""}
              >
                <div className="text-[10px] leading-tight text-slate-400">{r.rightLabel}</div>
                <div className={`break-all font-mono text-xs ${mismatch ? "font-semibold text-rose-700" : "text-slate-800"}`}>
                  {r.rightValue || "—"}
                </div>
                {r.note && <div className="mt-0.5 text-[10px] leading-tight text-slate-400">{r.note}</div>}
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

// ============ 字段比对 ============
function CompareTab({
  comparisons,
  empty,
  appMode,
}: {
  comparisons: FieldComparison[];
  empty: boolean;
  appMode: AppMode;
}) {
  if (empty || comparisons.length === 0) {
    return (
      <Empty
        icon={<Table2 className="h-10 w-10 text-slate-200" />}
        title="尚未核验"
        desc="配置好映射后点「开始核验」，这里会显示逐项比对结果。"
      />
    );
  }
  const rows: SideCompareRow[] = comparisons.map((c) => ({
    key: c.field,
    leftLabel: FIELD_LABELS[c.field] || c.field,
    leftValue: c.excel_value || c.passport_value || "",
    rightLabel: c.website_label || c.field,
    rightValue: c.website_value || "",
    match: c.match,
    note: c.note,
  }));
  return (
    <div className="p-3">
      <SideBySideCompare rows={rows} appMode={appMode} />
    </div>
  );
}

// ============ 文档对比（功能1：网页 PDF/图片 → MarkItDown/OCR → 左右对比） ============
function DocCompareTab({
  docExtract,
  extracting,
}: {
  docExtract: DocExtractState | null;
  extracting: boolean;
}) {
  const [showFullText, setShowFullText] = useState(false);

  if (extracting) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
        <p className="text-xs text-slate-500">
          正在提取文档文字…
          <br />
          <span className="text-[10px] text-slate-400">MarkItDown（PDF）/ Vision OCR（图片）</span>
        </p>
      </div>
    );
  }

  if (!docExtract) {
    return (
      <Empty
        icon={<FileText className="h-10 w-10 text-slate-200" />}
        title="尚未提取文档"
        desc="点击顶部「提取文档」按钮，在右侧网页点击 PDF 链接或图片，这里会显示提取出的文字与当前记录的左右对比。"
      />
    );
  }

  const methodBadge =
    docExtract.method === "vision_ocr" ? (
      <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700">
        Vision OCR
      </span>
    ) : (
      <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-700">
        MarkItDown
      </span>
    );

  const rows: SideCompareRow[] = docExtract.entries.map((e) => ({
    key: e.field,
    leftLabel: e.label,
    leftValue: e.left_value,
    rightLabel: e.label,
    rightValue: e.right_value,
    match: e.match,
  }));

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {/* 文件信息头 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
        <FileText className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700" title={docExtract.source}>
          {docExtract.filename}
        </span>
        {methodBadge}
      </div>

      {/* 左右对比 */}
      {rows.length > 0 ? (
        <SideBySideCompare
          rows={rows}
          appMode="review"
          leftHeader="左侧记录 / EXCEL"
          rightHeader="文档提取"
          hint={
            <>
              <span className="text-blue-700">左侧记录</span>
              <MoveRight className="h-3 w-3 text-slate-400" />
              <span className="text-emerald-700">文档提取</span>
              <span className="text-slate-400">（以左侧为基准核对文档内容）</span>
            </>
          }
        />
      ) : (
        <div className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-[11px] text-slate-400">
          未配置字段映射，仅显示提取全文（配置映射后可逐字段对比）
        </div>
      )}

      {/* 提取全文（可折叠） */}
      <div className="rounded-lg border border-slate-200">
        <button
          onClick={() => setShowFullText((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          <span>提取全文（{docExtract.text.length} 字符）</span>
          <span className="text-[10px] text-slate-400">{showFullText ? "收起 ▲" : "展开 ▼"}</span>
        </button>
        {showFullText && (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-slate-100 bg-slate-50/50 px-3 py-2 font-mono text-[10px] leading-relaxed text-slate-600">
            {docExtract.text}
          </pre>
        )}
      </div>
    </div>
  );
}
function ReportTab({
  report,
  reports,
  comparisons,
  resultPresent,
  docExtracts,
  activeDocIndex,
  onSelectDocIndex,
  docExtracting,
  shots,
  running,
  steps,
  appMode,
  addingStepMode,
  onPickExtractedField,
  docLocalConfigContent,
  focusPanel = null,
  preClickMarks = [],
  postClickMarks = [],
  reviewMappings = [],
  onRemoveMark,
  onPreviewMark,
  onSaveToBatch,
  hasCheckedBatch = false,
}: {
  report: VerificationReport | null;
  reports: VerificationReport[];
  comparisons: FieldComparison[];
  resultPresent: boolean;
  docExtracts: DocExtractState[];
  activeDocIndex: number;
  onSelectDocIndex?: (i: number) => void;
  docExtracting: boolean;
  shots: ScreenshotEvent[];
  running: boolean;
  steps: VerificationStep[];
  appMode: AppMode;
  addingStepMode?: "review" | "entry" | null;
  onPickExtractedField?: (side: "left" | "right", field: string, value: string) => void;
  /** 本地文件提取配置内容（有值时"文件处理"卡片显示它，替代正常内容） */
  docLocalConfigContent?: React.ReactNode;
  /** 聚焦面板模式："field"=只显示字段对比，"doc"=只显示文件处理，null=三面板 */
  focusPanel?: "field" | "doc" | null;
  /** 字段对比设置模式数据：前置点击 marks */
  preClickMarks?: PickedMark[];
  /** 字段对比设置模式数据：收尾点击 marks */
  postClickMarks?: PickedMark[];
  /** 字段对比设置模式数据：已配置的审查映射 */
  reviewMappings?: FieldMapping[];
  /** 删除一个 picked mark（前置/收尾点击） */
  onRemoveMark?: (id: string) => void;
  /** 点击卡片预览：在对应网页高亮显示元素位置 */
  onPreviewMark?: (mark: PickedMark) => void;
  /** 保存当前步骤配置到这批勾选的卡片（分割批次用） */
  onSaveToBatch?: () => void;
  /** 当前是否有勾选的卡片（控制"保存到这批"按钮显隐） */
  hasCheckedBatch?: boolean;
}) {
  const hasReports = reports && reports.length > 0;
  const hasCompare = resultPresent && comparisons.length > 0;
  const hasFieldData = hasReports || (report && report.entries.length > 0) || hasCompare;
  const [showSample, setShowSample] = useState(false);
  const [showDocSample, setShowDocSample] = useState(false);
  const [filter, setFilter] = useState<"all" | "pass" | "fail" | "review">("all");
  /** 提取元素面板开关：默认关闭，下栏右侧一般只显示「文件处理」+「字段对比」两个面板 */
  const [showExtractPanel, setShowExtractPanel] = useState(false);
  /** 字段对比面板模式开关：true=步骤设置版，false=结果显示版 */
  const [fieldSetupMode, setFieldSetupMode] = useState(false);
  /** 文件处理面板模式开关：true=步骤设置版，false=结果显示版 */
  const [docSetupMode, setDocSetupMode] = useState(false);

  // 聚焦字段对比面板时（用户正在添加前置/收尾点击或审查步骤），自动切换到设置模式
  useEffect(() => {
    if (focusPanel === "field") setFieldSetupMode(true);
  }, [focusPanel]);
  // 聚焦文件处理面板时（用户正在配置文件提取），自动切换到设置模式
  useEffect(() => {
    if (focusPanel === "doc") setDocSetupMode(true);
  }, [focusPanel]);

  // 三栏宽度（百分比）
  const [leftWidth, setLeftWidth] = useState(32);
  const [midWidth, setMidWidth] = useState(36);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<null | "left" | "right">(null);
  const liveScrollRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback((which: "left" | "right") => {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = which;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = Math.max(15, Math.min(70, (x / rect.width) * 100));
      if (dragRef.current === "left") {
        const newLeft = Math.max(15, Math.min(pct, 100 - midWidth - 15));
        setLeftWidth(newLeft);
      } else {
        const newMid = Math.max(15, Math.min(pct - leftWidth, 100 - leftWidth - 15));
        setMidWidth(newMid);
      }
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [leftWidth, midWidth]);

  // ============ LOOP 实时进度：将 steps 按 recordStart 分组 ============
  interface LiveRecord {
    name: string;
    index: number;
    total: number;
    fieldSteps: { label: string; detail?: string; action: string; done: boolean }[];
    status: "running" | "success" | "failed";
  }
  const liveRecords: LiveRecord[] = [];
  let cur: LiveRecord | null = null;
  for (const s of steps) {
    // 检测记录开始：isRecordStart 标记（批量LOOP）或 action="start"（单卡执行/SKILL）
    const isRecStart = s.isRecordStart || s.action === "start";
    if (isRecStart) {
      if (cur) {
        // 上一条记录被新记录打断，如果没出错则标记为成功
        if (cur.status === "running") cur.status = "success";
        liveRecords.push(cur);
      }
      // 从描述中提取人名：支持「recordName」或直接跟在描述后面
      let name = s.recordName || "";
      if (!name) {
        const m = s.description.match(/[「"']([^」"']+)[」"']/);
        if (m) name = m[1];
        else name = s.description.length > 20 ? s.description.slice(0, 20) + "…" : s.description;
      }
      cur = {
        name,
        index: s.recordIndex || 1,
        total: s.recordTotal || 1,
        fieldSteps: [],
        status: "running",
      };
    } else if (cur) {
      if (s.action === "error" || s.success === false) {
        cur.status = "failed";
      }
      // 提取步骤描述（格式："..."步骤 M: 标签"）
      const m = s.description.match(/步骤\s*\d+\s*[:：]\s*(.+)$/);
      if (m) {
        cur.fieldSteps.push({
          label: m[1].trim(),
          detail: s.detail || undefined,
          action: s.action || "",
          done: true,
        });
      }
      // 检测完成动作
      if (s.action === "done") {
        cur.status = "success";
      }
    }
  }
  if (cur) {
    if (!running && cur.status === "running") {
      const hasErr = steps.some((s) => s.action === "error" || s.success === false);
      cur.status = hasErr ? "failed" : "success";
    }
    if (cur.status === "running" && cur.fieldSteps.length > 0) {
      cur.fieldSteps[cur.fieldSteps.length - 1].done = false;
    }
    liveRecords.push(cur);
  }

  // 自动滚动到当前运行的卡片
  useEffect(() => {
    if (liveScrollRef.current) {
      const runningCard = liveScrollRef.current.querySelector("[data-running='true']");
      if (runningCard) {
        runningCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  }, [steps.length]);

  // 实时运行中：显示逐人卡片（展开当前运行的，已完成的折叠变色）
  const LiveRecordCard = ({ rec }: { rec: LiveRecord }) => {
    const isRunning = rec.status === "running";
    const isFailed = rec.status === "failed";
    const [expanded, setExpanded] = useState(isRunning);
    // 运行中自动展开当前卡片
    useEffect(() => {
      if (isRunning) setExpanded(true);
    }, [isRunning]);
    // 完成后延迟1秒自动折叠
    useEffect(() => {
      if (!isRunning) {
        const t = setTimeout(() => setExpanded(false), 1200);
        return () => clearTimeout(t);
      }
    }, [isRunning, rec.fieldSteps.length]);

    const doneCount = rec.fieldSteps.filter((f) => f.done).length;
    const accent = isFailed
      ? { head: "bg-rose-50/80 border-rose-200", text: "text-rose-700", badge: "bg-rose-500", badgeSoft: "bg-rose-100 text-rose-700", spin: "text-rose-500" }
      : isRunning
      ? { head: "bg-indigo-50/80 border-indigo-200", text: "text-indigo-700", badge: "bg-indigo-500", badgeSoft: "bg-indigo-100 text-indigo-700", spin: "text-indigo-500" }
      : { head: "bg-emerald-50/80 border-emerald-200", text: "text-emerald-700", badge: "bg-emerald-500", badgeSoft: "bg-emerald-100 text-emerald-700", spin: "text-emerald-500" };

    return (
      <div data-running={isRunning} className={`overflow-hidden rounded-md border shadow-sm transition-all ${accent.head}`}>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:brightness-[0.97]"
        >
          {isRunning ? (
            <Loader2 className={`h-3.5 w-3.5 shrink-0 animate-spin ${accent.spin}`} />
          ) : isFailed ? (
            <XCircle className={`h-3.5 w-3.5 shrink-0 ${accent.spin}`} />
          ) : (
            <CheckCircle2 className={`h-3.5 w-3.5 shrink-0 ${accent.spin}`} />
          )}
          <span className={`text-[12px] font-semibold ${accent.text}`}>{rec.name}</span>
          <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${accent.badgeSoft}`}>
            {rec.index}/{rec.total}
          </span>
          <span className={`ml-auto inline-flex items-center rounded-full ${accent.badge} px-2 py-0.5 text-[10px] font-semibold text-white`}>
            {isRunning ? `${doneCount}步` : isFailed ? "失败" : "通过"}
          </span>
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
        </button>
        {expanded && rec.fieldSteps.length > 0 && (
          <div className="border-t border-slate-200/60 bg-white/70 px-3 py-1.5">
            <ul className="space-y-1">
              {rec.fieldSteps.map((f, i) => {
                const isCurrent = !f.done && isRunning;
                return (
                  <li key={i} className="flex items-center gap-1.5 text-[11px]">
                    {isCurrent ? (
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-indigo-500" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
                    )}
                    <span className={isCurrent ? "font-medium text-indigo-700" : "text-slate-600"}>
                      {f.label}
                    </span>
                    {isCurrent && f.detail && (
                      <span className="ml-1 truncate rounded bg-indigo-50 px-1 py-0.5 font-mono text-[9px] text-indigo-500">
                        {f.detail.replace(/^填入:\s*/, "")}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    );
  };

  // DEMO示例数据
  const sampleReports: VerificationReport[] = [
    {
      task_id: "sample-1",
      record_id: "sample-1",
      record_name: "张三",
      university_url: "https://example.com",
      overall: "pass",
      summary: "全部一致",
      started_at: new Date().toISOString(),
      entries: [
        { left_field: "name", left_value: "张三", left_source: "excel", right_label: "姓名", right_value: "张三", right_selector: "#name", match: "match", timestamp: new Date().toISOString() },
        { left_field: "passport", left_value: "E12345678", left_source: "excel", right_label: "护照号", right_value: "E12345678", right_selector: "#passport", match: "match", timestamp: new Date().toISOString() },
        { left_field: "major", left_value: "计算机科学", left_source: "excel", right_label: "专业", right_value: "计算机科学", right_selector: "#major", match: "match", timestamp: new Date().toISOString() },
      ],
    },
    {
      task_id: "sample-2",
      record_id: "sample-2",
      record_name: "李四",
      university_url: "https://example.com",
      overall: "fail",
      summary: "存在问题",
      started_at: new Date().toISOString(),
      entries: [
        { left_field: "name", left_value: "李四", left_source: "excel", right_label: "姓名", right_value: "李四", right_selector: "#name", match: "match", timestamp: new Date().toISOString() },
        { left_field: "passport", left_value: "E98765431", left_source: "excel", right_label: "护照号", right_value: "E98765432", right_selector: "#passport", match: "mismatch", timestamp: new Date().toISOString() },
        { left_field: "enroll_year", left_value: "2023", left_source: "excel", right_label: "入学年份", right_value: "2024", right_selector: "#year", match: "mismatch", timestamp: new Date().toISOString() },
      ],
    },
  ];

  if (!hasFieldData && docExtracts.length === 0 && shots.length === 0 && !showSample) {
    // 空状态也渲染三卡片布局，每个卡片内部显示空状态+示例按钮
  }

  // 精美的人员对比卡片
  const PersonReportCard = ({ r }: { r: VerificationReport }) => {
    const [expanded, setExpanded] = useState(false);
    const isEntry = appMode === "entry";
    const rows: SideCompareRow[] = r.entries.map((e, i) => ({
      key: `${e.left_field || e.right_label || "field"}-${i}`,
      leftLabel: FIELD_LABELS[e.left_field] || e.left_field || "左侧来源",
      leftValue: e.left_value || "",
      rightLabel: e.right_label || "右侧元素",
      rightValue: e.right_value || "",
      match: e.match,
      note: e.reasoning,
    }));
    const mc = rows.filter((x) => x.match === "match").length;
    const mmc = rows.filter((x) => x.match === "mismatch" || x.match === "error").length;
    const isPass = r.overall === "pass";
    const isReview = r.overall === "review";

    // 状态色系
    const accent = isPass
      ? { headerBg: "bg-emerald-50/50", badge: "bg-emerald-500", badgeSoft: "bg-emerald-100 text-emerald-700", footer: "bg-slate-50 text-emerald-700" }
      : isReview
      ? { headerBg: "bg-amber-50/50", badge: "bg-amber-500", badgeSoft: "bg-amber-100 text-amber-700", footer: "bg-slate-50 text-amber-700" }
      : { headerBg: "bg-rose-50/50", badge: "bg-rose-500", badgeSoft: "bg-rose-100 text-rose-700", footer: "bg-slate-50 text-rose-700" };

    // 中间状态图标 —— 录入=箭头，审查=✓/✗/−
    const StatusIcon = ({ match }: { match: FieldMatch }) => {
      if (isEntry) {
        return (
          <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 ring-1 ring-indigo-200">
            <MoveRight className="h-4 w-4 text-indigo-600" />
          </div>
        );
      }
      if (match === "match")
        return <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 ring-1 ring-emerald-200"><CheckCircle2 className="h-5 w-5 text-emerald-600" /></div>;
      if (match === "mismatch" || match === "error")
        return <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-lg bg-rose-100 ring-1 ring-rose-200"><XCircle className="h-5 w-5 text-rose-600" /></div>;
      return <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 ring-1 ring-amber-200"><MinusCircle className="h-5 w-5 text-amber-600" /></div>;
    };

    return (
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md">
        {/* 头部 */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${accent.headerBg} hover:brightness-[0.97]`}
        >
          <span className="text-sm font-semibold text-slate-800">{r.record_name || "人物卡片"}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${accent.badgeSoft}`}>
            {mc}/{rows.length}
          </span>
          <span className={`ml-auto inline-flex items-center rounded-full ${accent.badge} px-2.5 py-0.5 text-[11px] font-semibold text-white`}>
            {OVERALL_LABELS[r.overall]}
          </span>
          <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
        </button>

        {/* 展开内容 */}
        {expanded && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                {/* 表头 */}
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="w-[42%] bg-slate-50/60 px-4 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      {isEntry ? "EXCEL / 来源" : "左侧 / EXCEL"}
                    </th>
                    <th className="w-[16%] px-0 py-2"></th>
                    <th className="w-[42%] bg-slate-50/60 px-4 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      {isEntry ? "右侧网页（填入）" : "右侧网页"}
                    </th>
                  </tr>
                </thead>
                {/* 数据行 */}
                <tbody>
                  {rows.map((row) => {
                    const isMismatch = row.match === "mismatch" || row.match === "error";
                    return (
                      <tr key={row.key} className={`border-b border-slate-50 last:border-0 ${isMismatch && !isEntry ? "bg-rose-50/20" : ""}`}>
                        {/* 左侧值 */}
                        <td className="px-4 py-2.5 align-top">
                          <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{row.leftLabel}</div>
                          <div className={`mt-1 text-[13px] leading-relaxed ${isMismatch && !isEntry ? "font-semibold text-rose-600" : "text-slate-700"}`}>
                            {row.leftValue || <span className="text-slate-300">—</span>}
                          </div>
                        </td>
                        {/* 中间状态图标 */}
                        <td className="px-0 py-2.5 text-center align-middle">
                          <StatusIcon match={row.match} />
                        </td>
                        {/* 右侧值 */}
                        <td className="px-4 py-2.5 align-top">
                          <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{row.rightLabel}</div>
                          <div className={`mt-1 text-[13px] leading-relaxed ${isMismatch && !isEntry ? "font-semibold text-rose-600" : "text-slate-700"}`}>
                            {row.rightValue || <span className="text-slate-300">—</span>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 底部统计条 */}
            <div className={`border-t border-slate-100 px-4 py-2 text-xs font-medium ${accent.footer}`}>
              {mc}/{rows.length} 项{isEntry ? "已填入" : "一致"}{mmc === 0 ? (isEntry ? " · 全部完成" : " · 全部一致") : (isEntry ? ` · ${mmc} 项待处理` : ` · ${mmc} 处不一致`)}
            </div>
          </>
        )}
      </div>
    );
  };

  // 单人简洁对比表格
  const SingleCompareTable = ({ rows }: { rows: SideCompareRow[] }) => {
    const isEntry = appMode === "entry";
    return (
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-100">
              <th className="w-[42%] bg-slate-50/60 px-4 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
                {isEntry ? "EXCEL / 来源" : "左侧 / EXCEL"}
              </th>
              <th className="w-[16%] px-0 py-2"></th>
              <th className="w-[42%] bg-slate-50/60 px-4 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
                {isEntry ? "右侧网页（填入）" : "右侧网页"}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isMismatch = row.match === "mismatch" || row.match === "error";
              return (
                <tr key={row.key} className={`border-b border-slate-50 last:border-0 ${isMismatch && !isEntry ? "bg-rose-50/20" : ""}`}>
                  <td className="px-4 py-2.5 align-top">
                    <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{row.leftLabel}</div>
                    <div className={`mt-1 text-[13px] leading-relaxed ${isMismatch && !isEntry ? "font-semibold text-rose-600" : "text-slate-700"}`}>
                      {row.leftValue || <span className="text-slate-300">—</span>}
                    </div>
                  </td>
                  <td className="px-0 py-2.5 text-center align-middle">
                    {isEntry ? (
                      <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 ring-1 ring-indigo-200">
                        <MoveRight className="h-4 w-4 text-indigo-600" />
                      </div>
                    ) : row.match === "match" ? (
                      <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 ring-1 ring-emerald-200"><CheckCircle2 className="h-5 w-5 text-emerald-600" /></div>
                    ) : isMismatch ? (
                      <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-lg bg-rose-100 ring-1 ring-rose-200"><XCircle className="h-5 w-5 text-rose-600" /></div>
                    ) : (
                      <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 ring-1 ring-amber-200"><MinusCircle className="h-5 w-5 text-amber-600" /></div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{row.rightLabel}</div>
                    <div className={`mt-1 text-[13px] leading-relaxed ${isMismatch && !isEntry ? "font-semibold text-rose-600" : "text-slate-700"}`}>
                      {row.rightValue || <span className="text-slate-300">—</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  // 构建字段对比内容
  let fieldContent: React.ReactNode;
  let summaryBar: React.ReactNode = null;

  // 运行中或刚结束（有实时记录但还没有最终报告）：显示逐人可视化卡片
  if (liveRecords.length > 0 && (!hasReports || running)) {
    const passCount = liveRecords.filter((r) => r.status === "success").length;
    const failCount = liveRecords.filter((r) => r.status === "failed").length;
    const runCount = liveRecords.filter((r) => r.status === "running").length;
    summaryBar = (
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-[10px] font-medium text-white">
          {running ? "执行中" : "执行完成"}
        </span>
        {passCount > 0 && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">✓ {passCount}</span>}
        {failCount > 0 && <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-700">✗ {failCount}</span>}
        {runCount > 0 && <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
          <Loader2 className="mr-0.5 inline h-2.5 w-2.5 animate-spin" />{runCount}
        </span>}
      </div>
    );
    fieldContent = <div className="space-y-1.5">{liveRecords.map((r, i) => <LiveRecordCard key={`${r.index}-${i}`} rec={r} />)}</div>;
  } else if (hasReports) {
    const passCount = reports.filter((r) => r.overall === "pass").length;
    const failCount = reports.filter((r) => r.overall === "fail").length;
    const reviewCount = reports.filter((r) => r.overall === "review").length;
    const filtered = filter === "all" ? reports : reports.filter((r) => r.overall === filter);

    const FilterChip = ({ target, label, activeBg, inactiveBg, activeText, inactiveText, activeRing }: { target: typeof filter; label: string; activeBg: string; inactiveBg: string; activeText: string; inactiveText: string; activeRing: string }) => (
      <button onClick={() => setFilter(target)} className={["rounded-full px-2.5 py-1 text-[11px] font-medium transition-all", filter === target ? `${activeBg} ${activeText} ring-2 ${activeRing} shadow-sm` : `${inactiveBg} ${inactiveText} ring-1 ring-transparent hover:ring-slate-300`].join(" ")}>
        {label}
      </button>
    );

    summaryBar = (
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
        <FilterChip target="all" label={`共 ${reports.length} 人`} activeBg="bg-slate-800" inactiveBg="bg-slate-200" activeText="text-white" inactiveText="text-slate-600" activeRing="ring-slate-500" />
        {passCount > 0 && <FilterChip target="pass" label={`✓ 通过 ${passCount}`} activeBg="bg-emerald-500" inactiveBg="bg-emerald-100" activeText="text-white" inactiveText="text-emerald-700" activeRing="ring-emerald-300" />}
        {failCount > 0 && <FilterChip target="fail" label={`✗ 问题 ${failCount}`} activeBg="bg-rose-500" inactiveBg="bg-rose-100" activeText="text-white" inactiveText="text-rose-700" activeRing="ring-rose-300" />}
        {reviewCount > 0 && <FilterChip target="review" label={`⚠ 复核 ${reviewCount}`} activeBg="bg-amber-500" inactiveBg="bg-amber-100" activeText="text-white" inactiveText="text-amber-700" activeRing="ring-amber-300" />}
      </div>
    );
    fieldContent = <div className="space-y-3">{filtered.map((r) => <PersonReportCard key={r.task_id || r.record_id} r={r} />)}</div>;
  } else if (showSample) {
    const passCount = sampleReports.filter((r) => r.overall === "pass").length;
    const failCount = sampleReports.filter((r) => r.overall === "fail").length;
    const filtered = filter === "all" ? sampleReports : sampleReports.filter((r) => r.overall === filter);

    const FilterChip = ({ target, label, activeBg, inactiveBg, activeText, inactiveText, activeRing }: { target: typeof filter; label: string; activeBg: string; inactiveBg: string; activeText: string; inactiveText: string; activeRing: string }) => (
      <button onClick={() => setFilter(target)} className={["rounded-full px-2.5 py-1 text-[11px] font-medium transition-all", filter === target ? `${activeBg} ${activeText} ring-2 ${activeRing} shadow-sm` : `${inactiveBg} ${inactiveText} ring-1 ring-transparent hover:ring-slate-300`].join(" ")}>
        {label}
      </button>
    );

    summaryBar = (
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
        <FilterChip target="all" label={`共 ${sampleReports.length} 人`} activeBg="bg-slate-800" inactiveBg="bg-slate-200" activeText="text-white" inactiveText="text-slate-600" activeRing="ring-slate-500" />
        <FilterChip target="pass" label={`✓ 通过 ${passCount}`} activeBg="bg-emerald-500" inactiveBg="bg-emerald-100" activeText="text-white" inactiveText="text-emerald-700" activeRing="ring-emerald-300" />
        <FilterChip target="fail" label={`✗ 问题 ${failCount}`} activeBg="bg-rose-500" inactiveBg="bg-rose-100" activeText="text-white" inactiveText="text-rose-700" activeRing="ring-rose-300" />
        <button
          onClick={() => { setShowSample(false); setFilter("all"); }}
          className="ml-auto rounded-md bg-slate-100 px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-200"
        >
          关闭
        </button>
      </div>
    );
    fieldContent = <div className="space-y-3">{filtered.map((r) => <PersonReportCard key={r.task_id} r={r} />)}</div>;
  } else if (report && report.entries.length > 0) {
    const rows: SideCompareRow[] = report.entries.map((e, i) => ({
      key: `${e.left_field || e.right_label || "field"}-${i}`,
      leftLabel: FIELD_LABELS[e.left_field] || e.left_field || "左侧来源",
      leftValue: e.left_value || "",
      rightLabel: e.right_label || "右侧元素",
      rightValue: e.right_value || "",
      match: e.match,
      note: e.reasoning,
    }));
    const mc = rows.filter((x) => x.match === "match").length;
    summaryBar = (
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-white">{report.summary || OVERALL_LABELS[report.overall || "review"]}</span>
        <span className="text-xs text-slate-500">{mc}/{rows.length} 一致</span>
      </div>
    );
    fieldContent = <SingleCompareTable rows={rows} />;
  } else if (hasCompare) {
    const rows: SideCompareRow[] = comparisons.map((c) => ({
      key: c.field,
      leftLabel: FIELD_LABELS[c.field] || c.field,
      leftValue: c.excel_value || c.passport_value || "",
      rightLabel: c.website_label || c.field,
      rightValue: c.website_value || "",
      match: c.match,
      note: c.note,
    }));
    fieldContent = <SingleCompareTable rows={rows} />;
  } else {
    fieldContent = (
      <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 text-[11px] text-slate-400">
        <Table2 className="h-8 w-8 text-slate-300" />
        <div>完成核验后显示字段对比</div>
        <button
          onClick={() => setShowSample(true)}
          className="mt-1 flex items-center gap-1 rounded-lg bg-indigo-50 px-3 py-1.5 text-[11px] font-medium text-indigo-600 ring-1 ring-indigo-200 transition-colors hover:bg-indigo-100"
        >
          <Eye className="h-3.5 w-3.5" />
          查看DEMO
        </button>
      </div>
    );
  }

  // 当前激活的提取文件（支持多文件 TAB 切换）
  const safeDocIdx = docExtracts.length > 0 ? Math.min(activeDocIndex, docExtracts.length - 1) : 0;
  const docExtract = docExtracts[safeDocIdx] || null;

  // 文件处理内容：放置从网页下载的 PDF / JPG / JPEG 文件
  // 点击「+文件提取」→ 点击网页下载按钮 → 文件下载到此处 → 自动旋转到正面 + 裁剪白边 → OCR 提取
  let fileProcessContent: React.ReactNode;
  if (docExtracting) {
    fileProcessContent = (
      <div className="flex h-full min-h-[100px] flex-col items-center justify-center gap-2 text-[11px] text-slate-400">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
        <div>正在下载并处理文件…</div>
        <div className="text-[10px] text-slate-400">自动旋转到正面 · 裁剪白边 · OCR 识别</div>
      </div>
    );
  } else if (showDocSample) {
    // DEMO 示例：模拟一张护照 JPG 图片被下载、预处理、OCR 识别后的文件处理面板
    const sampleCompare = [
      { field: "name", label: "姓名", left_value: "张三", right_value: "张三", match: "match" as FieldMatch },
      { field: "passport_no", label: "护照号", left_value: "E12345678", right_value: "E12345678", match: "match" as FieldMatch },
      { field: "birth_date", label: "出生日期", left_value: "1995-03-15", right_value: "1995-03-15", match: "match" as FieldMatch },
      { field: "passport_expiry", label: "护照有效期", left_value: "2030-08-20", right_value: "2030-08-22", match: "mismatch" as FieldMatch },
    ];
    fileProcessContent = (
      <div className="flex h-full flex-col">
        {/* 文件信息条 */}
        <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50/60 px-2 py-1.5">
          <FileText className="h-3.5 w-3.5 shrink-0 text-slate-500" />
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-slate-700">passport_zhangsan.jpg</span>
          <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-medium text-violet-700">Vision OCR</span>
        </div>
        {/* 预处理后的图片占位（DEMO 用彩色块示意） */}
        <div className="mb-2">
          <div className="mb-1 flex items-center gap-1 text-[9px] font-medium text-emerald-600">
            <CheckCircle2 className="h-3 w-3" />
            已处理：自动旋转到正面 + 裁剪白边
          </div>
          <div className="overflow-hidden rounded-md border border-slate-200 bg-gradient-to-br from-slate-100 via-sky-50 to-indigo-50">
            <div className="flex h-32 flex-col items-center justify-center gap-1 text-center">
              <div className="rounded-md bg-white/80 px-3 py-1.5 shadow-sm ring-1 ring-slate-200">
                <div className="text-[10px] font-bold text-slate-700">护照 · 张三</div>
                <div className="text-[9px] text-slate-400">E12345678 · 1995-03-15</div>
              </div>
              <div className="text-[9px] text-slate-400">DEMO 图片预览</div>
            </div>
          </div>
        </div>
        {/* 对比条目 */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700">存在差异</span>
            <span className="text-[10px] text-slate-400">4 项对比</span>
          </div>
          {sampleCompare.map((e, i) => (
            <div key={i} className="rounded border border-slate-100 p-1.5 text-xs">
              <div className="mb-1 flex items-center gap-1.5">
                <span className={[
                  "rounded-full px-1.5 py-0.5 text-[9px] font-medium",
                  e.match === "match" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700",
                ].join(" ")}>
                  {MATCH_LABELS[e.match] || e.match}
                </span>
                <span className="font-medium text-slate-700">{e.label}</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                <div>
                  <div className="text-slate-400">提取</div>
                  <div className="text-slate-700 break-all">{e.right_value}</div>
                </div>
                <div>
                  <div className="text-slate-400">期望</div>
                  <div className="text-slate-700 break-all">{e.left_value}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
        {/* 关闭 DEMO 按钮 */}
        <button
          onClick={() => setShowDocSample(false)}
          className="mt-2 self-end rounded-md bg-slate-100 px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-200"
        >
          关闭 DEMO
        </button>
      </div>
    );
  } else {
    // 判断文件类型
    const fileUrl = docExtract?.file_url || docExtract?.source || "";
    const isImageFile = /\.(png|jpe?g|webp|gif|bmp|tiff?)(\?|#|$)/i.test(fileUrl) || docExtract?.method === "vision_ocr";
    const isPdfFile = /\.pdf(\?|#|$)/i.test(fileUrl) || (!isImageFile && docExtract?.method === "markitdown");

    // 文件预览区：优先显示预处理后的图片（base64），其次显示原始图片 URL，PDF 显示图标占位
    let filePreview: React.ReactNode = null;
    if (docExtract) {
      if (docExtract.processed_image) {
        // 预处理后的图片（已自动旋转 + 裁剪白边）- 填充可用空间
        filePreview = (
          <div className="mb-2 flex min-h-0 flex-1 flex-col">
            <div className="mb-1 flex items-center gap-1 text-[9px] font-medium text-emerald-600">
              <CheckCircle2 className="h-3 w-3" />
              已处理：自动旋转到正面 + 裁剪白边
            </div>
            <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-slate-200 bg-slate-50">
              <img
                src={`data:image/jpeg;base64,${docExtract.processed_image}`}
                alt={docExtract.filename}
                className="h-full w-full object-contain"
              />
            </div>
          </div>
        );
      } else if (isImageFile && fileUrl) {
        // 原始图片 URL（未预处理或预处理失败）
        filePreview = (
          <div className="mb-2 flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-slate-200 bg-slate-50">
              <img
                src={fileUrl}
                alt={docExtract.filename}
                className="h-full w-full object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            </div>
          </div>
        );
      } else if (isPdfFile) {
        // PDF 文件：显示 PDF 图标 + 文件名 + 可点击链接
        filePreview = (
          <div className="mb-2">
            <a
              href={fileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-md border border-slate-200 bg-rose-50/50 px-2.5 py-2 text-xs transition-colors hover:bg-rose-50"
            >
              <FileText className="h-8 w-8 shrink-0 text-rose-500" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-slate-700">{docExtract.filename}</div>
                <div className="text-[10px] text-slate-400">PDF 文档 · 点击打开</div>
              </div>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            </a>
          </div>
        );
      }
    }

    // 顶部文件信息条
    const fileInfo = docExtract ? (
      <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50/60 px-2 py-1.5">
        <FileText className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-slate-700" title={docExtract.source}>
          {docExtract.filename}
        </span>
        <span className={[
          "rounded-full px-1.5 py-0.5 text-[9px] font-medium",
          docExtract.method === "vision_ocr"
            ? "bg-violet-100 text-violet-700"
            : "bg-sky-100 text-sky-700",
        ].join(" ")}>
          {docExtract.method === "vision_ocr" ? "Vision OCR" : "MarkItDown"}
        </span>
      </div>
    ) : null;

    // 文件对比条目（如有）
    const compareBlock = docExtract && docExtract.entries.length > 0 ? (
      <div className="mb-2 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <span className={[
            "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            docExtract.entries.every((e) => e.match === "match")
              ? "bg-emerald-100 text-emerald-700"
              : "bg-rose-100 text-rose-700",
          ].join(" ")}>
            {docExtract.entries.every((e) => e.match === "match") ? "全部一致" : "存在差异"}
          </span>
          <span className="text-[10px] text-slate-400">{docExtract.entries.length} 项对比</span>
        </div>
        {docExtract.entries.map((e, i) => (
          <div key={i} className="rounded border border-slate-100 p-1.5 text-xs">
            <div className="mb-1 flex items-center gap-1.5">
              <span className={[
                "rounded-full px-1.5 py-0.5 text-[9px] font-medium",
                e.match === "match" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700",
              ].join(" ")}>
                {MATCH_LABELS[e.match] || e.match}
              </span>
              <span className="font-medium text-slate-700">{e.label || e.field}</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 text-[10px]">
              <div>
                <div className="text-slate-400">提取</div>
                <div className="text-slate-700 break-all">{e.left_value || "—"}</div>
              </div>
              <div>
                <div className="text-slate-400">期望</div>
                <div className="text-slate-700 break-all">{e.right_value || "—"}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    ) : null;

    // AI视野截图网格
    const shotsBlock = shots.length > 0 ? (
      <div>
        <div className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-slate-500">
          <Eye className="h-3 w-3" />
          AI 视野（{shots.length}）
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {shots.map((s, i) => (
            <div key={`${s.step}-${i}`} className="overflow-hidden rounded-md border border-slate-200 bg-slate-900">
              <div className="flex items-center justify-between bg-black/40 px-1.5 py-0.5 text-[9px] text-white">
                <span>Step {s.step}</span>
                {s.boxes && s.boxes.length > 0 && <span className="rounded bg-brand-600 px-1">{s.boxes.length}框</span>}
              </div>
              <img src={`data:image/png;base64,${s.screenshot}`} alt={`step ${s.step}`} className="h-20 w-full object-cover" />
            </div>
          ))}
        </div>
      </div>
    ) : running ? (
      <div className="flex h-full min-h-[60px] items-center justify-center text-[11px] text-slate-400">等待 AI 截图…</div>
    ) : null;

    fileProcessContent = (
      <div className="flex h-full min-h-0 flex-col">
        {fileInfo}
        {filePreview}
        {(compareBlock || shotsBlock) && (
          <div className={`shrink-0 ${filePreview ? "max-h-[35%] overflow-auto" : ""}`}>
            {compareBlock}
            {shotsBlock}
          </div>
        )}
        {!fileInfo && !compareBlock && !shotsBlock && (
          <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 text-center text-[11px] text-slate-400">
            <FileText className="h-8 w-8 text-slate-200" />
            <div>点击「+文件提取」后下载的</div>
            <div className="text-[10px] text-slate-400">PDF / JPG / JPEG 文件会放到这里</div>
            <button
              onClick={() => setShowDocSample(true)}
              className="mt-1 flex items-center gap-1 rounded-lg bg-emerald-50 px-3 py-1.5 text-[11px] font-medium text-emerald-600 ring-1 ring-emerald-200 transition-colors hover:bg-emerald-100"
            >
              <Eye className="h-3.5 w-3.5" />
              查看 DEMO
            </button>
          </div>
        )}
      </div>
    );
  }

  // 提取元素内容（原 AI视野 位置 → 改为显示从文件/图片中识别出的元素）
  // 审查/录入模式下，点击字段卡片可注入为合成拾取值（作为左侧来源）
  const canPickExtract = !!addingStepMode && !!onPickExtractedField;
  // 拾取提示条：审查/录入模式下提示用户可点击字段卡片作为来源值
  const pickHint = canPickExtract ? (
    <div className="mb-1.5 flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
      <MousePointerClick className="h-3 w-3" />
      点击字段卡片作为来源值（{addingStepMode === "review" ? "审查" : "录入"}）
    </div>
  ) : null;
  // 渲染单个字段卡片（DEMO 和真实数据共用）
  const renderFieldCard = (field: string, value: string) => {
    const label = FIELD_LABELS[field] || field;
    const isKeyField = ["name", "passport_no", "birth_date", "passport_issue", "passport_expiry"].includes(field);
    return (
      <div
        key={field}
        onClick={canPickExtract ? () => onPickExtractedField!("left", field, value) : undefined}
        className={[
          "rounded-md border px-2 py-1.5 transition-colors",
          isKeyField
            ? "border-indigo-200 bg-indigo-50/40"
            : "border-slate-200 bg-white",
          canPickExtract ? "cursor-pointer hover:border-brand-300 hover:bg-brand-50/60 hover:shadow-sm" : "",
        ].join(" ")}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="select-none text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            {label}
          </span>
          {isKeyField && (
            <span className="select-none rounded bg-indigo-100 px-1 py-0.5 text-[8px] font-medium text-indigo-600">
              关键
            </span>
          )}
        </div>
        <div className="mt-0.5 select-text break-all font-mono text-[12px] font-medium text-slate-800">
          {value || "—"}
        </div>
      </div>
    );
  };
  let extractedContent: React.ReactNode;
  if (docExtracting) {
    extractedContent = (
      <div className="flex h-full min-h-[100px] items-center justify-center gap-2 text-[11px] text-slate-400">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
        提取中…
      </div>
    );
  } else if (showDocSample) {
    // DEMO 示例：模拟从护照图片中提取出的元素
    const sampleFields: Record<string, string> = {
      surname: "ZHANG",
      given_name: "SAN",
      name: "ZHANG SAN",
      passport_no: "E12345678",
      nationality: "CHINESE",
      birth_date: "1995-03-15",
      gender: "M",
      passport_issue: "2020-08-20",
      passport_expiry: "2030-08-22",
      issue_place: "BEIJING",
    };
    const fieldOrder = ["name", "surname", "given_name", "passport_no", "nationality", "birth_date", "gender", "passport_issue", "passport_expiry", "issue_place", "email", "phone"];
    const fieldEntries = Object.entries(sampleFields)
      .filter(([, v]) => v && String(v).trim())
      .sort((a, b) => {
        const ia = fieldOrder.indexOf(a[0]);
        const ib = fieldOrder.indexOf(b[0]);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      });
    extractedContent = (
      <div className="space-y-1.5">
        {pickHint}
        <div className="mb-1 flex items-center gap-1 text-[10px] text-slate-500">
          <Database className="h-3 w-3" />
          共提取 {fieldEntries.length} 项元素
        </div>
        {fieldEntries.map(([field, value]) => renderFieldCard(field, String(value)))}
      </div>
    );
  } else if (docExtract && docExtract.fields && Object.keys(docExtract.fields).length > 0) {
    // 按字段顺序展示提取出的元素（姓名、护照号、日期等）
    const fieldOrder = ["name", "passport_no", "nationality", "birth_date", "gender", "passport_issue", "passport_expiry", "email", "phone"];
    const fieldEntries = Object.entries(docExtract.fields)
      .filter(([, v]) => v && String(v).trim())
      .sort((a, b) => {
        const ia = fieldOrder.indexOf(a[0]);
        const ib = fieldOrder.indexOf(b[0]);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      });
    extractedContent = (
      <div className="space-y-1.5">
        {pickHint}
        <div className="mb-1 flex items-center gap-1 text-[10px] text-slate-500">
          <Database className="h-3 w-3" />
          共提取 {fieldEntries.length} 项元素
        </div>
        {fieldEntries.map(([field, value]) => renderFieldCard(field, String(value)))}
      </div>
    );
  } else {
    extractedContent = (
      <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 text-center text-[11px] text-slate-400">
        <Database className="h-8 w-8 text-slate-200" />
        <div>识别文件后显示提取的</div>
        <div className="text-[10px] text-slate-400">姓名 / 护照号 / 日期 等元素</div>
        <button
          onClick={() => setShowDocSample(true)}
          className="mt-1 flex items-center gap-1 rounded-lg bg-violet-50 px-3 py-1.5 text-[11px] font-medium text-violet-600 ring-1 ring-violet-200 transition-colors hover:bg-violet-100"
        >
          <Eye className="h-3.5 w-3.5" />
          查看 DEMO
        </button>
      </div>
    );
  }

  // 聚焦模式计算：focusPanel 为 null 时全部显示，否则只显示对应面板
  const isFieldFocus = focusPanel === "field";
  const isDocFocus = focusPanel === "doc";
  const isAll = !focusPanel;
  // 提取元素面板显示逻辑：
  // - 非步骤设置模式（结果查看）：始终显示（三栏布局）
  // - 步骤设置模式：按用户手动开关控制（默认隐藏，给步骤卡片更多空间，可手动展开）
  const isSetupMode = fieldSetupMode || docSetupMode;
  const showExtract = isAll && (!isSetupMode || showExtractPanel);

  // 横向滚动容器的滚轮处理：垂直滚轮 → 水平滚动
  const handleHorizontalWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    // 只有当容器有水平溢出时才转换滚轮方向
    if (target.scrollWidth > target.clientWidth) {
      e.preventDefault();
      target.scrollLeft += e.deltaY;
    }
  }, []);

  // 字段对比设置模式内容：三大分组纵向排列，每组内部元素横向排列成玻璃质感小卡片
  const fieldSetupContent = (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-1.5">
      {/* 前置设置分组 —— 小卡片从左到右排列（含步骤2绑定输入框 + 步骤3前置点击） */}
      <div className="shrink-0">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold text-indigo-700">
          <MousePointerClick className="h-3.5 w-3.5" />
          前置设置
          <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[9px] font-semibold text-indigo-600">{preClickMarks.length}</span>
        </div>
        {preClickMarks.length === 0 ? (
          <div className="flex gap-2 pt-1.5">
            <div className="flex shrink-0 min-w-[80px] max-w-[150px] items-start gap-1.5 rounded-xl border-2 border-dashed border-indigo-200/60 bg-indigo-50/20 pl-2 pr-7 py-1.5 opacity-50">
              <div className="flex shrink-0 flex-col items-center gap-0.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-slate-200/60 text-[11px] font-black text-slate-400">
                  ?
                </span>
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-200/60">
                  <MousePointerClick className="h-2.5 w-2.5 text-slate-400" />
                </span>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[9px] font-bold uppercase tracking-wide text-slate-300">点击</span>
                <span className="text-[10px] font-medium leading-tight text-slate-300">点击搜索按钮等…</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="scrollbar-tiny flex gap-2 overflow-x-auto pb-0.5 pt-1.5" onWheel={handleHorizontalWheel}>
            {preClickMarks.map((m) => {
              const isInput = m.action === "input";
              return (
                <div
                  key={m.id}
                  onClick={() => onPreviewMark?.(m)}
                  className={[
                    "group relative flex shrink-0 min-w-[80px] max-w-[150px] cursor-pointer items-start gap-1.5 rounded-xl pl-2 pr-7 py-1.5 transition-all hover:-translate-y-0.5 hover:shadow-lg",
                    isInput
                      ? "border-2 border-sky-200 bg-gradient-to-br from-sky-50 to-white hover:border-sky-300 hover:from-sky-100/80"
                      : "border-2 border-indigo-200 bg-gradient-to-br from-indigo-50 to-white hover:border-indigo-300 hover:from-indigo-100/80",
                  ].join(" ")}
                  title={`${isInput ? "输入" : "点击"} · ${m.label}（点击在网页定位）`}
                >
                  {/* 序号 + 类型图标 */}
                  <div className="flex shrink-0 flex-col items-center gap-0.5">
                    <span className={[
                      "flex h-6 w-6 items-center justify-center rounded-lg text-[11px] font-black text-white shadow-md",
                      isInput
                        ? "bg-gradient-to-br from-sky-500 to-blue-600"
                        : "bg-gradient-to-br from-indigo-500 to-violet-600",
                    ].join(" ")}>
                      {m.order}
                    </span>
                    <span className={[
                      "flex h-4 w-4 items-center justify-center rounded-full text-white shadow-sm",
                      isInput ? "bg-sky-400" : "bg-indigo-400",
                    ].join(" ")}>
                      {isInput ? <Keyboard className="h-2.5 w-2.5" /> : <MousePointerClick className="h-2.5 w-2.5" />}
                    </span>
                  </div>
                  {/* 文字内容 */}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={[
                      "text-[9px] font-bold uppercase tracking-wide",
                      isInput ? "text-sky-600" : "text-indigo-600",
                    ].join(" ")}>
                      {isInput ? "输入" : "点击"}
                    </span>
                    <span className="line-clamp-2 text-[10px] font-medium leading-tight text-slate-700">{m.label}</span>
                  </div>
                  {onRemoveMark && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`确定要删除这个${isInput ? "输入" : "点击"}步骤吗？`)) {
                          onRemoveMark(m.id);
                        }
                      }}
                      className="absolute right-0 top-1/2 -translate-y-1/2 flex h-8 w-5 items-center justify-center rounded-l-md bg-rose-100/60 text-rose-400 opacity-70 transition-all hover:bg-rose-200 hover:text-rose-600 hover:opacity-100"
                      title="删除"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 审查映射分组 —— 小卡片从左到右排列 */}
      <div className="shrink-0">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold text-emerald-700">
          <Table2 className="h-3.5 w-3.5" />
          审查映射
          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-600">{reviewMappings.length}</span>
        </div>
        {reviewMappings.length === 0 ? (
          <div className="flex gap-2 pt-1.5">
            <div className="flex shrink-0 min-w-[90px] max-w-[160px] items-center gap-2 rounded-xl border-2 border-dashed border-emerald-200/60 bg-emerald-50/20 px-2 py-2.5 opacity-50">
              <div className="flex shrink-0 flex-col items-center justify-center gap-0.5 self-stretch">
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-slate-200/60 text-[11px] font-black text-slate-400">?</span>
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-200/60">
                  <ArrowLeft className="h-2.5 w-2.5 text-slate-400" />
                </span>
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[9px] font-bold uppercase tracking-wide text-slate-300">对比</span>
                <div className="truncate py-0.5 text-[10px] font-medium leading-tight text-slate-300">左侧字段</div>
                <div className="flex items-center justify-center py-2">
                  <ArrowLeft className="h-3.5 w-3.5 text-slate-300" />
                </div>
                <div className="line-clamp-2 py-0.5 text-[10px] font-medium leading-tight text-slate-300">右侧字段</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="scrollbar-tiny flex gap-2 overflow-x-auto pb-0.5 pt-1.5" onWheel={handleHorizontalWheel}>
            {reviewMappings.map((mp, i) => {
              const isEntry = appMode === "entry";
              return (
                <div
                  key={i}
                  onClick={() => onPreviewMark?.({ id: `mapping-${i}`, order: i + 1, side: "right", source: "web", selector: mp.right_selector, label: mp.right_label || mp.right_selector, workflow: "review", createdAt: 0 })}
                  className="group relative flex shrink-0 min-w-[90px] max-w-[160px] cursor-pointer items-center gap-2 rounded-xl border-2 border-emerald-200 bg-gradient-to-br from-emerald-50 to-white px-2 py-2.5 transition-all hover:-translate-y-0.5 hover:border-emerald-300 hover:from-emerald-100/80 hover:shadow-lg"
                  title={`${mp.left_field || "—"} ${isEntry ? "→" : "←"} ${mp.right_label || mp.right_selector}（点击在网页定位）`}
                >
                  <div className="flex shrink-0 flex-col items-center justify-center gap-0.5 self-stretch">
                    <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-[11px] font-black text-white shadow-md">
                      {i + 1}
                    </span>
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-400 text-white shadow-sm">
                      {isEntry ? <MoveRight className="h-2.5 w-2.5" /> : <ArrowLeft className="h-2.5 w-2.5" />}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[9px] font-bold uppercase tracking-wide text-emerald-600">{isEntry ? "填入" : "对比"}</span>
                    <div className="truncate py-0.5 text-[10px] font-medium leading-tight text-slate-500">{mp.left_field || "—"}</div>
                    <div className="flex items-center justify-center py-2">
                      {isEntry ? (
                        <MoveRight className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <ArrowLeft className="h-3.5 w-3.5 text-emerald-500" />
                      )}
                    </div>
                    <div className="line-clamp-2 py-0.5 text-[10px] font-medium leading-tight text-slate-700">{mp.right_label || mp.right_selector}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 收尾点击分组 —— 小卡片从左到右排列 */}
      <div className="shrink-0">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold text-amber-700">
          <MousePointerClick className="h-3.5 w-3.5" />
          收尾点击
          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-600">{postClickMarks.length}</span>
        </div>
        {postClickMarks.length === 0 ? (
          <div className="flex gap-2 pt-1.5">
            <div className="flex shrink-0 min-w-[80px] max-w-[150px] items-start gap-1.5 rounded-xl border-2 border-dashed border-amber-200/60 bg-amber-50/20 pl-2 pr-7 py-1.5 opacity-50">
              <div className="flex shrink-0 flex-col items-center gap-0.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-slate-200/60 text-[11px] font-black text-slate-400">?</span>
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-200/60">
                  <MousePointerClick className="h-2.5 w-2.5 text-slate-400" />
                </span>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[9px] font-bold uppercase tracking-wide text-slate-300">点击</span>
                <span className="text-[10px] font-medium leading-tight text-slate-300">点击提交按钮等…</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="scrollbar-tiny flex gap-2 overflow-x-auto pb-0.5 pt-1.5" onWheel={handleHorizontalWheel}>
            {postClickMarks.map((m) => (
              <div
                key={m.id}
                onClick={() => onPreviewMark?.(m)}
                className="group relative flex shrink-0 min-w-[80px] max-w-[150px] cursor-pointer items-start gap-1.5 rounded-xl border-2 border-amber-200 bg-gradient-to-br from-amber-50 to-white pl-2 pr-7 py-1.5 transition-all hover:-translate-y-0.5 hover:border-amber-300 hover:from-amber-100/80 hover:shadow-lg"
                title={`点击 · ${m.label}（点击在网页定位）`}
              >
                <div className="flex shrink-0 flex-col items-center gap-0.5">
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 text-[11px] font-black text-white shadow-md">{m.order}</span>
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-white shadow-sm">
                    <MousePointerClick className="h-2.5 w-2.5" />
                  </span>
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[9px] font-bold uppercase tracking-wide text-amber-600">点击</span>
                  <span className="line-clamp-2 text-[10px] font-medium leading-tight text-slate-700">{m.label}</span>
                </div>
                {onRemoveMark && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm("确定要删除这个点击步骤吗？")) {
                        onRemoveMark(m.id);
                      }
                    }}
                    className="absolute right-0 top-1/2 -translate-y-1/2 flex h-8 w-5 items-center justify-center rounded-l-md bg-rose-100/60 text-rose-400 opacity-70 transition-all hover:bg-rose-200 hover:text-rose-600 hover:opacity-100"
                    title="删除"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-full flex-col p-1.5" ref={containerRef}>
      {/* 大屏：可拖拽三栏；小屏：垂直堆叠。聚焦模式通过 flex-grow + opacity 过渡实现丝滑动画 */}
      <div className="min-h-0 flex-1 flex flex-col gap-1.5 lg:flex-row lg:gap-0 lg:h-full">
        {/* 字段对比卡片 —— 最左侧，向右展开/向左回收（纯 flex-basis 过渡，max-w-0 不可过渡会 snap） */}
        <div
          className={[
            "flex max-h-[55vh] flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm lg:h-full",
            "transition-all duration-500 ease-in-out",
            isFieldFocus ? "flex-1" : isAll ? "" : "lg:border-0 lg:px-0 lg:mx-0",
          ].join(" ")}
          style={{ flexBasis: isFieldFocus ? undefined : (isAll ? `${leftWidth}%` : "0%"), flexShrink: 0, flexGrow: isFieldFocus ? 1 : 0 }}
        >
          <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-200 bg-slate-50/80 px-2 py-1 text-[11px] font-semibold text-slate-700">
            <Table2 className="h-3.5 w-3.5 text-slate-500 shrink-0" />
            <span className="shrink-0">字段对比</span>
            {onSaveToBatch && (
              <button
                onClick={onSaveToBatch}
                className={[
                  "ml-1 flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold transition-all",
                  hasCheckedBatch
                    ? "bg-emerald-500 text-white hover:bg-emerald-600 shadow-sm"
                    : "bg-slate-200 text-slate-500 hover:bg-slate-300",
                ].join(" ")}
                title={hasCheckedBatch ? "保存当前步骤配置到这批勾选的卡片" : "请先在左侧勾选一批卡片（点第一张定起点，点第二张定范围）"}
              >
                <Save className="h-2.5 w-2.5" />
                保存这批
              </button>
            )}
            <button
              onClick={() => setFieldSetupMode((v) => !v)}
              className={[
                "ml-auto flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium transition-colors",
                fieldSetupMode
                  ? "bg-indigo-100 text-indigo-700"
                  : "text-slate-400 hover:bg-slate-100 hover:text-slate-600",
              ].join(" ")}
              title={fieldSetupMode ? "切换到结果显示" : "切换到步骤设置"}
            >
              {fieldSetupMode ? <Settings2 className="h-3 w-3" /> : <Table2 className="h-3 w-3" />}
              {fieldSetupMode ? "设置" : "结果"}
            </button>
          </div>
          {fieldSetupMode ? (
            <div className="min-h-0 flex-1 min-w-[200px] overflow-y-auto overflow-x-hidden">{fieldSetupContent}</div>
          ) : (
            <>
              {summaryBar && <div className="shrink-0 px-1.5 pt-1.5">{summaryBar}</div>}
              <div ref={liveScrollRef} className="min-h-0 flex-1 min-w-[200px] overflow-y-auto overflow-x-hidden p-1.5">{fieldContent}</div>
            </>
          )}
        </div>

        {/* 左/中 拖拽分隔条 —— 聚焦模式下隐藏 */}
        <div
          className={[
            "group relative hidden shrink-0 cursor-col-resize items-center justify-center lg:flex",
            "transition-opacity duration-300",
            isAll ? "opacity-100" : "opacity-0 lg:w-0 lg:px-0",
          ].join(" ")}
          style={{ width: isAll ? 6 : 0 }}
          onMouseDown={onMouseDown("left")}
        >
          <div className="h-full w-px bg-slate-200 transition-colors group-hover:bg-brand-400" />
          <div className="absolute h-8 w-1 rounded-full bg-slate-300 opacity-0 transition-opacity group-hover:opacity-100" />
        </div>

        {/* 文件处理卡片 —— 2面板时在右半向左展开/向右回收；3面板时在中间左右展开/向中心回收 */}
        <div
          className={[
            "relative flex max-h-[55vh] flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm lg:h-full",
            "transition-all duration-500 ease-in-out",
            isDocFocus ? "flex-1" : isAll ? "" : "lg:border-0 lg:px-0 lg:mx-0",
          ].join(" ")}
          style={{
            flexBasis: showExtract ? `${midWidth}%` : "0%",
            flexShrink: 0,
            flexGrow: (isDocFocus || (isAll && !showExtract)) ? 1 : 0,
          }}
        >
          {/* 展开/收起「提取元素」面板按钮 —— 仅步骤设置模式下显示（结果模式始终展开三栏），贴在文件处理面板右边缘外侧 */}
          {isAll && isSetupMode && (
            <button
              onClick={() => setShowExtractPanel((v) => !v)}
              className={[
                "absolute top-1/2 z-20 flex -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-l-md border border-r-0 py-1 transition-all",
                showExtractPanel
                  ? "border-violet-200 bg-violet-100 text-violet-700 hover:bg-violet-200"
                  : "border-emerald-200 bg-emerald-50 text-emerald-600 hover:bg-emerald-100",
              ].join(" ")}
              style={{ right: 0 }}
              title={showExtractPanel ? "收起「提取元素」面板" : "展开「提取元素」面板"}
            >
              {showExtractPanel ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}
            </button>
          )}
          {docLocalConfigContent ? (
            /* 配置模式：直接渲染配置内容（组件自带标题条和底部按钮） */
            <div className="flex min-h-0 flex-1 min-w-[200px] flex-col overflow-hidden">{docLocalConfigContent}</div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-1.5 border-b border-emerald-200 bg-emerald-50/60 px-2 py-1 text-[11px] font-semibold text-emerald-800">
                <FileText className="h-3.5 w-3.5 text-emerald-600" />
                文件处理
                {docExtracts.length > 0 && (
                  <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700">
                    {docExtracts.length} 个文件
                  </span>
                )}
                <button
                  onClick={() => setDocSetupMode((v) => !v)}
                  className={[
                    "ml-auto flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium transition-colors",
                    docSetupMode
                      ? "bg-emerald-200 text-emerald-700"
                      : "text-emerald-500/70 hover:bg-emerald-100 hover:text-emerald-700",
                  ].join(" ")}
                  title={docSetupMode ? "切换到结果显示" : "切换到步骤设置"}
                >
                  {docSetupMode ? <Settings2 className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
                  {docSetupMode ? "设置" : "结果"}
                </button>
              </div>
              {/* 多文件 TAB 切换栏 */}
              {docExtracts.length > 1 && onSelectDocIndex && (
                <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-slate-100 bg-slate-50/50 px-1 py-0.5">
                  {docExtracts.map((ext, i) => (
                    <button
                      key={i}
                      onClick={() => onSelectDocIndex(i)}
                      className={[
                        "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-all",
                        i === safeDocIdx
                          ? "bg-emerald-600 text-white shadow-sm"
                          : "bg-white text-slate-500 ring-1 ring-slate-200 hover:bg-emerald-50 hover:text-emerald-700",
                      ].join(" ")}
                      title={ext.filename}
                    >
                      {ext.method === "vision_ocr" ? <Eye className="h-2.5 w-2.5" /> : <FileText className="h-2.5 w-2.5" />}
                      <span className="max-w-[80px] truncate">{ext.filename}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="min-h-0 flex-1 min-w-[200px] overflow-y-auto overflow-x-hidden p-1.5">
                {docSetupMode && !docLocalConfigContent ? (
                  <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 text-center text-[11px] text-slate-400">
                    <Settings2 className="h-8 w-8 text-slate-200" />
                    <span>点击「+文件提取」开始配置文件提取步骤</span>
                  </div>
                ) : fileProcessContent}
              </div>
            </>
          )}
        </div>

        {/* 中/右 拖拽分隔条 —— 仅三栏模式（showExtract）下显示 */}
        <div
          className={[
            "group relative hidden shrink-0 cursor-col-resize items-center justify-center lg:flex",
            "transition-opacity duration-300",
            showExtract ? "opacity-100" : "opacity-0 lg:w-0 lg:px-0",
          ].join(" ")}
          style={{ width: showExtract ? 6 : 0 }}
          onMouseDown={onMouseDown("right")}
        >
          <div className="h-full w-px bg-slate-200 transition-colors group-hover:bg-brand-400" />
          <div className="absolute h-8 w-1 rounded-full bg-slate-300 opacity-0 transition-opacity group-hover:opacity-100" />
        </div>

        {/* 提取元素卡片 —— 最右侧，向左展开/向右回收（默认隐藏，通过文件处理面板左侧按钮开启） */}
        <div
          className={[
            "flex max-h-[55vh] min-w-0 flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm lg:h-full",
            "transition-all duration-500 ease-in-out",
            showExtract ? "flex-1" : "lg:border-0 lg:px-0 lg:mx-0",
          ].join(" ")}
          style={{ flexBasis: showExtract ? "30%" : "0%", flexShrink: 0, flexGrow: showExtract ? 1 : 0 }}
        >
          <div className="flex shrink-0 items-center gap-1.5 border-b border-violet-200 bg-violet-50/60 px-2 py-1 text-[11px] font-semibold text-violet-800">
            <Database className="h-3.5 w-3.5 text-violet-600" />
            提取元素
            {docExtract && (
              <span className="max-w-[120px] truncate rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-normal text-violet-600" title={docExtract.filename}>
                {docExtract.filename}
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 min-w-[200px] overflow-y-auto overflow-x-hidden p-1.5">{extractedContent}</div>
        </div>
      </div>
    </div>
  );
}

function Empty({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center text-slate-400">
      {icon}
      <p className="text-sm font-medium text-slate-500">{title}</p>
      <p className="text-xs">{desc}</p>
    </div>
  );
}
