import { Fragment, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleStop,
  Database,
  Eye,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Globe,
  Layers,
  ListOrdered,
  Loader2,
  MinusCircle,
  MoveRight,
  Play,
  Plus,
  ScrollText,
  Settings2,
  ShieldCheck,
  Table2,
  Trash2,
  UserCircle,
  X,
  XCircle,
} from "lucide-react";
import type {
  AppMode,
  ApplicantRecord,
  DocExtractState,
  FieldComparison,
  FieldMapping,
  FieldMatch,
  PickedMark,
  QueuedTask,
  ScreenshotEvent,
  VerificationReport,
  VerificationStep,
} from "../types";
import {
  EVIDENCE_LABELS,
  EVIDENCE_STYLES,
  FIELD_LABELS,
  MATCH_LABELS,
  MATCH_STYLES,
  VERIFY_METHOD_LABELS,
} from "../types";

type Tab = "mappings" | "compare" | "report" | "log" | "vision" | "workflow" | "doc" | "queue";

interface Props {
  record: ApplicantRecord | null;
  mappings: FieldMapping[];
  comparisons: FieldComparison[];
  resultPresent: boolean;
  report: VerificationReport | null;
  steps: VerificationStep[];
  shots: ScreenshotEvent[];
  running: boolean;
  /** 应用模式：审查=右侧网页→左侧/EXCEL；录入=左侧EXCEL→右侧网页 */
  appMode?: AppMode;
  logEndRef: React.RefObject<HTMLDivElement>;
  onRemoveMapping: (index: number) => void;
  onDetach?: () => void;
  // 操作记录
  pickedMarks?: PickedMark[];
  onRemovePickedMark?: (id: string) => void;
  onClearPickedMarks?: () => void;
  onReplay?: () => void;
  replaying?: boolean;
  replayCursor?: number;
  onStopReplay?: () => void;
  // 切换到日志tab的触发值（每次变化时切到log）
  switchToLogSignal?: number;
  /** 文档提取结果（功能1：网页 PDF/图片 → MarkItDown/OCR → 左右对比） */
  docExtract?: DocExtractState | null;
  /** 文档提取进行中 */
  docExtracting?: boolean;
  /** 切换到文档tab的触发值 */
  switchToDocSignal?: number;
  // ============ 任务队列 ============
  taskQueue?: QueuedTask[];
  queueRunning?: boolean;
  queueCursor?: number;
  onAddToQueue?: () => void;
  onRemoveFromQueue?: (id: string) => void;
  onRenameQueueTask?: (id: string, name: string) => void;
  onClearQueue?: () => void;
  onRunQueue?: () => void;
  onStopQueue?: () => void;
  canAddToQueue?: boolean; // 当前是否可以添加到队列（有卡片+有模板）
  switchToQueueSignal?: number; // 递增触发切换到任务队列tab
}

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "mappings", label: "字段映射", icon: <Settings2 className="h-3.5 w-3.5" /> },
  { id: "compare", label: "字段比对", icon: <Table2 className="h-3.5 w-3.5" /> },
  { id: "doc", label: "文档对比", icon: <FileText className="h-3.5 w-3.5" /> },
  { id: "report", label: "验证报告", icon: <ShieldCheck className="h-3.5 w-3.5" /> },
  { id: "log", label: "执行日志", icon: <ScrollText className="h-3.5 w-3.5" /> },
  { id: "queue", label: "任务队列", icon: <Layers className="h-3.5 w-3.5" /> },
  { id: "vision", label: "AI 视野", icon: <Eye className="h-3.5 w-3.5" /> },
  { id: "workflow", label: "操作记录", icon: <ListOrdered className="h-3.5 w-3.5" /> },
];

export default function ResultsPanel({
  record,
  mappings,
  comparisons,
  resultPresent,
  report,
  steps,
  shots,
  running,
  appMode = "loop",
  logEndRef,
  onRemoveMapping,
  onDetach,
  pickedMarks = [],
  onRemovePickedMark,
  onClearPickedMarks,
  onReplay,
  replaying = false,
  replayCursor = 0,
  onStopReplay,
  switchToLogSignal = 0,
  docExtract = null,
  docExtracting = false,
  switchToDocSignal = 0,
  // 任务队列
  taskQueue = [],
  queueRunning = false,
  queueCursor = -1,
  onAddToQueue,
  onRemoveFromQueue,
  onRenameQueueTask,
  onClearQueue,
  onRunQueue,
  onStopQueue,
  canAddToQueue = false,
  switchToQueueSignal = 0,
}: Props) {
  const [tab, setTab] = useState<Tab>("mappings");

  // 当 switchToLogSignal 变化时，自动切换到执行日志tab
  useEffect(() => {
    if (switchToLogSignal > 0) {
      setTab("log");
    }
  }, [switchToLogSignal]);

  // 文档提取完成/进行中时，自动切换到文档对比tab
  useEffect(() => {
    if (switchToDocSignal > 0) {
      setTab("doc");
    }
  }, [switchToDocSignal]);

  // 切换到任务队列tab的触发值
  useEffect(() => {
    if (switchToQueueSignal > 0) {
      setTab("queue");
    }
  }, [switchToQueueSignal]);

  const counts: Partial<Record<Tab, number>> = {
    mappings: mappings.length,
    compare: comparisons.length,
    doc: docExtract?.entries.length || (docExtract ? 1 : 0),
    log: steps.length,
    queue: taskQueue.length,
    vision: shots.length,
    workflow: pickedMarks.length,
  };

  return (
    <div className="glass-strong flex h-full flex-col overflow-hidden rounded-2xl">
      {/* Tab 头 */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-white/40 px-2 py-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={[
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all",
              tab === t.id
                ? "bg-white/80 text-brand-700 shadow-sm ring-1 ring-brand-200/50"
                : "text-slate-500 hover:bg-white/40 hover:text-slate-700",
            ].join(" ")}
          >
            {t.icon}
            {t.label}
            {counts[t.id] ? (
              <span className="rounded-full bg-slate-200/70 px-1.5 py-0.5 text-[9px] text-slate-600">
                {counts[t.id]}
              </span>
            ) : null}
          </button>
        ))}
        <div className="flex-1" />
        {onDetach && (
          <button
            onClick={onDetach}
            className="rounded-md p-1 text-slate-400 hover:bg-white/60 hover:text-brand-600"
            title="脱离到独立窗口"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Tab 内容 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "mappings" && (
          <MappingsTab mappings={mappings} onRemove={onRemoveMapping} />
        )}
        {tab === "compare" && (
          <CompareTab comparisons={comparisons} empty={!resultPresent} appMode={appMode} />
        )}
        {tab === "doc" && (
          <DocCompareTab docExtract={docExtract} extracting={docExtracting} />
        )}
        {tab === "report" && <ReportTab report={report} appMode={appMode} />}
        {tab === "log" && <LogTab steps={steps} logEndRef={logEndRef} />}
        {tab === "queue" && (
          <QueueTab
            taskQueue={taskQueue}
            queueRunning={queueRunning}
            queueCursor={queueCursor}
            onAddToQueue={onAddToQueue}
            onRemoveFromQueue={onRemoveFromQueue}
            onRenameQueueTask={onRenameQueueTask}
            onClearQueue={onClearQueue}
            onRunQueue={onRunQueue}
            onStopQueue={onStopQueue}
            canAddToQueue={canAddToQueue}
          />
        )}
        {tab === "vision" && <VisionTab shots={shots} running={running} />}
        {tab === "workflow" && (
          <WorkflowTab
            marks={pickedMarks}
            onRemove={onRemovePickedMark}
            onClear={onClearPickedMarks}
            onReplay={onReplay}
            replaying={replaying}
            replayCursor={replayCursor}
            onStopReplay={onStopReplay}
          />
        )}
      </div>
    </div>
  );
}

// ============ 映射列表 ============
function MappingsTab({
  mappings,
  onRemove,
}: {
  mappings: FieldMapping[];
  onRemove: (i: number) => void;
}) {
  if (mappings.length === 0) {
    return (
      <Empty
        icon={<Settings2 className="h-10 w-10 text-slate-200" />}
        title="尚未配置字段映射"
        desc="点击顶部「元素选择模式」，先在右侧网页拾取元素，再从左侧网页或 Excel 选择对应字段。"
      />
    );
  }
  return (
    <div className="p-3">
      <div className="overflow-hidden rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">右侧元素</th>
              <th className="px-3 py-2 text-left font-medium">左侧来源</th>
              <th className="px-3 py-2 text-left font-medium">左侧字段</th>
              <th className="px-3 py-2 text-left font-medium">方式</th>
              <th className="px-3 py-2 text-center font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {mappings.map((m, i) => (
              <tr key={i} className="hover:bg-slate-50/60">
                <td className="px-3 py-2 align-top">
                  <div className="text-xs font-medium text-emerald-700">{m.right_label || "—"}</div>
                  <code className="font-mono text-[10px] text-slate-400">{m.right_selector}</code>
                </td>
                <td className="px-3 py-2 align-top">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                    {m.left_source}
                  </span>
                </td>
                <td className="px-3 py-2 align-top text-xs text-slate-700">
                  {FIELD_LABELS[m.left_field] || m.left_field}
                </td>
                <td className="px-3 py-2 align-top text-[10px] text-slate-500">
                  {VERIFY_METHOD_LABELS[m.verify_method || "smart"]}
                </td>
                <td className="px-3 py-2 text-center">
                  <button
                    onClick={() => onRemove(i)}
                    className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
function ReportTab({ report, appMode }: { report: VerificationReport | null; appMode: AppMode }) {
  if (!report) {
    return (
      <Empty
        icon={<ShieldCheck className="h-10 w-10 text-slate-200" />}
        title="暂无报告"
        desc="完成一次核验后，这里会显示结果并可下载 Excel。"
      />
    );
  }
  const rows: SideCompareRow[] = report.entries.map((e, i) => ({
    key: `${e.left_field || e.right_label || "field"}-${i}`,
    leftLabel: FIELD_LABELS[e.left_field] || e.left_field || "左侧来源",
    leftValue: e.left_value || "",
    rightLabel: e.right_label || "右侧元素",
    rightValue: e.right_value || "",
    match: e.match,
    note: e.reasoning,
  }));
  return (
    <div className="p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-white">
          {report.summary || report.overall}
        </span>
        <span className="text-xs text-slate-500">{report.entries.length} 条</span>
      </div>
      <SideBySideCompare rows={rows} appMode={appMode} />
    </div>
  );
}

// ============ 执行日志 ============
function LogTab({
  steps,
  logEndRef,
}: {
  steps: VerificationStep[];
  logEndRef: React.RefObject<HTMLDivElement>;
}) {
  if (steps.length === 0) {
    return (
      <Empty
        icon={<ScrollText className="h-10 w-10 text-slate-200" />}
        title="暂无日志"
        desc="Agent 执行步骤会实时显示在这里。"
      />
    );
  }
  return (
    <div className="p-3 font-mono text-xs">
      <ul className="space-y-1">
        {steps.map((s) => {
          // 任务分隔大标题：每个队列任务开始时的顶级标题
          if (s.isTaskStart) {
            return (
              <li key={`task-${s.step}`} className="animate-fade-in -mx-2 my-3 first:mt-0">
                <div className="flex items-center gap-3 rounded-xl border-2 border-indigo-400 bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-2.5 shadow-lg">
                  <Layers className="h-5 w-5 shrink-0 text-white" />
                  <div className="min-w-0 flex-1">
                    <span className="text-[13px] font-bold text-white">
                      {s.taskName || "任务"}
                    </span>
                    <span className="ml-2 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold text-white">
                      任务 {s.taskIndex}/{s.taskTotal}
                    </span>
                    <span className="ml-2 text-[10px] text-indigo-200">
                      {s.taskRecordCount} 张卡片
                    </span>
                  </div>
                  <span className="text-[10px] text-indigo-200">
                    {new Date(s.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              </li>
            );
          }
          // 人物卡片分隔块：每个record开始时的醒目标题
          if (s.isRecordStart) {
            return (
              <li key={`record-${s.step}`} className="animate-fade-in -mx-1 my-2 first:mt-0">
                <div className="flex items-center gap-2 rounded-lg border-2 border-indigo-200 bg-gradient-to-r from-indigo-50 to-violet-50 px-3 py-1.5 shadow-sm">
                  <UserCircle className="h-4 w-4 shrink-0 text-indigo-600" />
                  <span className="text-[11px] font-bold text-indigo-900">
                    {s.recordName || "人物卡片"}
                  </span>
                  <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                    {s.recordIndex}/{s.recordTotal}
                  </span>
                  <span className="ml-auto text-[9px] text-indigo-400">
                    {new Date(s.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              </li>
            );
          }
          // 普通步骤行
          return (
            <li
              key={s.step}
              className="flex items-start gap-2 animate-fade-in rounded px-2 py-1 hover:bg-white/40"
            >
              <span className="shrink-0 text-slate-400">[{String(s.step).padStart(2, "0")}]</span>
              <span className="shrink-0">
                {s.success ? "✓" : "✕"}
              </span>
              <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                {s.action}
              </span>
              <span className="text-slate-700">{s.description}</span>
              {s.detail && (
                <span className="ml-1 truncate text-slate-400" title={s.detail}>
                  · {s.detail}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div ref={logEndRef} />
    </div>
  );
}

// ============ AI 视野 ============
function VisionTab({
  shots,
  running,
}: {
  shots: ScreenshotEvent[];
  running: boolean;
}) {
  if (shots.length === 0) {
    return (
      <Empty
        icon={<Eye className="h-10 w-10 text-slate-200" />}
        title={running ? "等待 AI 截图…" : "暂无截图"}
        desc="核验过程中 AI 的截图会显示在这里。"
      />
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
      {shots.map((s, i) => (
        <div
          key={`${s.step}-${i}`}
          className="overflow-hidden rounded-lg border border-slate-200 bg-slate-900"
        >
          <div className="flex items-center justify-between bg-black/40 px-2 py-0.5 text-[10px] text-white">
            <span>Step {s.step}</span>
            {s.boxes && s.boxes.length > 0 && (
              <span className="rounded bg-brand-600 px-1">{s.boxes.length} 框</span>
            )}
          </div>
          <img
            src={`data:image/png;base64,${s.screenshot}`}
            alt={`step ${s.step}`}
            className="h-32 w-full object-cover"
          />
        </div>
      ))}
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

// ============ 操作记录（教学工作流节点） ============
function WorkflowTab({
  marks,
  onRemove,
  onClear,
  onReplay,
  replaying = false,
  replayCursor = 0,
  onStopReplay,
}: {
  marks: PickedMark[];
  onRemove?: (id: string) => void;
  onClear?: () => void;
  onReplay?: () => void;
  replaying?: boolean;
  replayCursor?: number;
  onStopReplay?: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "data-source" | "review">("all");

  // 回放中切换 filter 会让人困惑，强制显示 all
  useEffect(() => {
    if (replaying) setFilter("all");
  }, [replaying]);

  const filtered = useMemo(
    () => (filter === "all" ? marks : marks.filter((m) => m.workflow === filter)),
    [marks, filter]
  );

  const counts = useMemo(
    () => ({
      total: marks.length,
      dataSource: marks.filter((m) => m.workflow === "data-source").length,
      review: marks.filter((m) => m.workflow === "review").length,
    }),
    [marks]
  );

  if (marks.length === 0) {
    return (
      <Empty
        icon={<ListOrdered className="h-10 w-10 text-slate-200" />}
        title="尚未拾取任何节点"
        desc="点击顶部「教学模式」，选中 Excel 列作为 LOOP 变量，然后依次点击左右网页的输入框、搜索按钮和审查元素。"
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏：筛选 + 回放 */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/40 px-3 py-2">
        <div className="flex items-center gap-1">
          <FilterChip
            active={filter === "all"}
            onClick={() => setFilter("all")}
            label="全部"
            count={counts.total}
          />
          <FilterChip
            active={filter === "data-source"}
            onClick={() => setFilter("data-source")}
            label="数据源操作"
            count={counts.dataSource}
            tone="violet"
          />
          <FilterChip
            active={filter === "review"}
            onClick={() => setFilter("review")}
            label="审查流操作"
            count={counts.review}
            tone="brand"
          />
        </div>
        <div className="flex items-center gap-1">
          {replaying ? (
            <button
              onClick={() => onStopReplay?.()}
              className="flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-rose-700"
              title="停止回放"
            >
              <CircleStop className="h-3 w-3" />
              停止回放
            </button>
          ) : (
            <button
              onClick={onReplay}
              disabled={marks.length === 0}
              className={[
                "flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-all",
                marks.length === 0
                  ? "cursor-not-allowed bg-slate-200 text-slate-400"
                  : "bg-emerald-600 text-white hover:bg-emerald-700",
              ].join(" ")}
              title="按顺序回放所有操作节点"
            >
              <Play className="h-3 w-3" />
              回放全部
            </button>
          )}
          <button
            onClick={onClear}
            disabled={marks.length === 0 || replaying}
            className={[
              "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all",
              marks.length === 0 || replaying
                ? "cursor-not-allowed bg-white/40 text-slate-400"
                : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-rose-50 hover:text-rose-600",
            ].join(" ")}
            title="清空所有节点"
          >
            <Trash2 className="h-3 w-3" />
            清空
          </button>
        </div>
      </div>

      {/* 节点列表 */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-12 text-center text-xs text-slate-400">
            <ListOrdered className="h-8 w-8 text-slate-300" />
            <p>当前筛选条件下没有节点</p>
          </div>
        ) : (
          <ol className="space-y-1.5">
            {filtered.map((m) => {
              const isCurrent = replaying && m.order === replayCursor;
              const isPast = replaying && m.order < replayCursor;
              return (
                <li
                  key={m.id}
                  className={[
                    "flex items-start gap-3 rounded-lg border px-3 py-2 transition-all",
                    isCurrent
                      ? "border-emerald-300 bg-emerald-50/60 ring-1 ring-emerald-300 animate-glow-pulse"
                      : isPast
                      ? "border-slate-200 bg-slate-50/50 opacity-70"
                      : "border-slate-200 bg-white/70 hover:bg-white",
                  ].join(" ")}
                >
                  {/* 顺序编号 */}
                  <span
                    className={[
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
                      isCurrent
                        ? "bg-emerald-600 text-white"
                        : isPast
                        ? "bg-slate-400 text-white"
                        : "bg-brand-600 text-white",
                    ].join(" ")}
                  >
                    {m.order}
                  </span>

                  {/* 节点信息 */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <SourceIcon source={m.source} />
                      <span className="truncate text-xs font-medium text-slate-800" title={m.label}>
                        {m.label}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                      <span
                        className={[
                          "rounded px-1 py-0.5 font-medium",
                          m.workflow === "data-source"
                            ? "bg-violet-100 text-violet-700"
                            : "bg-brand-100 text-brand-700",
                        ].join(" ")}
                      >
                        {m.workflow === "data-source" ? "数据源" : "审查流"}
                      </span>
                      {/* 动作类型徽章 */}
                      {m.action && m.action !== "pick" && (
                        <span
                          className={[
                            "rounded px-1 py-0.5 font-medium",
                            m.action === "input"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-emerald-100 text-emerald-700",
                          ].join(" ")}
                        >
                          {m.action === "input" ? "输入" : "点击"}
                        </span>
                      )}
                      {/* 变量标记徽章：批量执行时按字段自动替换值 */}
                      {m.variableField && (
                        <span
                          className="rounded bg-amber-100 px-1 py-0.5 font-medium text-amber-700"
                          title={`批量执行时自动用每张卡片的「${m.variableField}」字段值替换`}
                        >
                          ⟳ {m.variableField}
                        </span>
                      )}
                      <span className="rounded bg-slate-100 px-1 py-0.5 text-slate-600">
                        {m.side === "left" ? "左侧" : "右侧"}
                      </span>
                      <span className="rounded bg-slate-100 px-1 py-0.5 text-slate-600">
                        {sourceLabel(m.source)}
                      </span>
                      {m.tag && (
                        <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[9px] text-slate-500">
                          &lt;{m.tag}&gt;
                        </code>
                      )}
                    </div>
                    {m.selector && (
                      <div
                        className="mt-1 truncate rounded bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-500"
                        title={m.selector}
                      >
                        {m.selector}
                      </div>
                    )}
                    {m.value && (
                      <div className="mt-0.5 truncate text-[10px] text-slate-400" title={m.value}>
                        值: {m.value}
                      </div>
                    )}
                  </div>

                  {/* 删除按钮（非回放中才显示） */}
                  {!replaying && (
                    <button
                      onClick={() => onRemove?.(m.id)}
                      className="shrink-0 rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                      title="删除此节点"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* 底部说明 */}
      <div className="shrink-0 border-t border-white/40 px-3 py-2 text-[10px] text-slate-500">
        {replaying
          ? `回放中… ${replayCursor}/${filtered.length}`
          : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>点击「回放全部」按顺序自动执行</span>
              <span className="text-brand-600">点错元素？再点一次即可回收节点</span>
              <span className="flex items-center gap-1">
                <kbd className="rounded bg-white/70 px-1 font-mono text-[9px]">S</kbd>输入
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded bg-white/70 px-1 font-mono text-[9px]">Space</kbd>点击
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded bg-white/70 px-1 font-mono text-[9px]">R</kbd>撤销
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded bg-emerald-100 px-1 font-mono text-[9px] text-emerald-700">Enter</kbd>完成本段
              </span>
            </div>
          )}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  count,
  tone = "slate",
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tone?: "slate" | "violet" | "brand";
}) {
  const activeCls =
    tone === "violet"
      ? "bg-violet-600 text-white"
      : tone === "brand"
      ? "bg-brand-600 text-white"
      : "bg-slate-700 text-white";
  return (
    <button
      onClick={onClick}
      className={[
        "flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-all",
        active
          ? activeCls
          : "bg-white/70 text-slate-600 ring-1 ring-slate-200 hover:bg-white",
      ].join(" ")}
    >
      {label}
      <span
        className={[
          "rounded-full px-1 text-[9px]",
          active ? "bg-white/20" : "bg-slate-100 text-slate-500",
        ].join(" ")}
      >
        {count}
      </span>
    </button>
  );
}

function SourceIcon({ source }: { source: PickedMark["source"] }) {
  if (source === "excel") return <FileSpreadsheet className="h-3 w-3 text-blue-500" />;
  if (source === "avatar") return <UserCircle className="h-3 w-3 text-violet-500" />;
  return <Globe className="h-3 w-3 text-brand-500" />;
}

function sourceLabel(source: PickedMark["source"]) {
  if (source === "excel") return "Excel";
  if (source === "avatar") return "头像";
  return "网页";
}

// 让 EVIDENCE_LABELS / EVIDENCE_STYLES 在某些场景下可用（保留导入避免 tree-shake）
void EVIDENCE_LABELS;
void EVIDENCE_STYLES;

// ============ 任务队列（多段批量执行） ============
function QueueTab({
  taskQueue,
  queueRunning,
  queueCursor,
  onAddToQueue,
  onRemoveFromQueue,
  onRenameQueueTask,
  onClearQueue,
  onRunQueue,
  onStopQueue,
  canAddToQueue,
}: {
  taskQueue: QueuedTask[];
  queueRunning: boolean;
  queueCursor: number;
  onAddToQueue?: () => void;
  onRemoveFromQueue?: (id: string) => void;
  onRenameQueueTask?: (id: string, name: string) => void;
  onClearQueue?: () => void;
  onRunQueue?: () => void;
  onStopQueue?: () => void;
  canAddToQueue: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const startRename = (task: QueuedTask) => {
    setEditingId(task.id);
    setEditingName(task.name);
  };

  const confirmRename = (id: string) => {
    if (editingName.trim()) {
      onRenameQueueTask?.(id, editingName.trim());
    }
    setEditingId(null);
  };

  const statusIcon = (status: QueuedTask["status"], index: number) => {
    switch (status) {
      case "running":
        return <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />;
      case "success":
        return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
      case "failed":
        return <XCircle className="h-4 w-4 text-red-500" />;
      case "stopped":
        return <CircleStop className="h-4 w-4 text-amber-500" />;
      default:
        return (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-500">
            {index + 1}
          </span>
        );
    }
  };

  return (
    <div className="flex h-full flex-col p-3">
      {/* 顶部操作栏 */}
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <button
          onClick={onAddToQueue}
          disabled={!canAddToQueue || queueRunning}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-all hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          title={canAddToQueue ? "把当前配置拍快照加入队列" : "请先框选LOOP行范围并生成卡片+完成教学流程配置"}
        >
          <Plus className="h-3.5 w-3.5" />
          添加当前任务到队列
        </button>
        {taskQueue.length > 0 && (
          <>
            {queueRunning ? (
              <button
                onClick={onStopQueue}
                className="flex items-center gap-1.5 rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition-all hover:bg-red-600"
              >
                <CircleStop className="h-3.5 w-3.5" />
                停止队列
              </button>
            ) : (
              <button
                onClick={onRunQueue}
                disabled={taskQueue.length === 0}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-all hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                <Play className="h-3.5 w-3.5" />
                执行队列（{taskQueue.length}）
              </button>
            )}
            <button
              onClick={onClearQueue}
              disabled={queueRunning}
              className="rounded-lg bg-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-all hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
              title="清空队列"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        <div className="flex-1" />
        {queueRunning && queueCursor >= 0 && (
          <span className="text-xs text-indigo-600">
            正在执行：{queueCursor + 1}/{taskQueue.length}
          </span>
        )}
      </div>

      {/* 队列列表 */}
      {taskQueue.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <Layers className="h-10 w-10 text-slate-200" />
          <div>
            <p className="text-sm font-medium text-slate-500">任务队列为空</p>
            <p className="mt-1 max-w-xs text-xs text-slate-400">
              配置好一个任务（加载Excel → 框选LOOP行范围 → 生成卡片 → 录步骤）后，点击「添加当前任务到队列」拍快照保存。可以添加多个任务，然后一键按顺序执行所有任务。
            </p>
          </div>
        </div>
      ) : (
        <ul className="flex-1 space-y-2 overflow-y-auto pr-1">
          {taskQueue.map((task, idx) => (
            <li
              key={task.id}
              className={[
                "animate-fade-in rounded-xl border-2 p-3 transition-all",
                task.status === "running"
                  ? "border-indigo-300 bg-indigo-50/50 shadow-md"
                  : task.status === "success"
                  ? "border-emerald-200 bg-emerald-50/30"
                  : task.status === "failed"
                  ? "border-red-200 bg-red-50/30"
                  : "border-slate-200 bg-white/50 hover:border-slate-300",
              ].join(" ")}
            >
              <div className="flex items-start gap-3">
                {/* 状态图标 */}
                <div className="mt-0.5 shrink-0">{statusIcon(task.status, idx)}</div>

                {/* 任务信息 */}
                <div className="min-w-0 flex-1">
                  {editingId === task.id ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") confirmRename(task.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        onBlur={() => confirmRename(task.id)}
                        autoFocus
                        className="flex-1 rounded border border-indigo-300 bg-white px-2 py-0.5 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    </div>
                  ) : (
                    <button
                      onClick={() => !queueRunning && startRename(task)}
                      disabled={queueRunning}
                      className="text-left text-sm font-semibold text-slate-800 hover:text-indigo-600 disabled:cursor-default"
                      title={queueRunning ? "执行中不可编辑" : "点击重命名"}
                    >
                      {task.name}
                    </button>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
                    <span>{task.cardRecords.length} 张卡片</span>
                    <span>{task.mode === "review" ? "审查流" : task.mode === "entry" ? "录入流" : "LOOP流"}</span>
                    {task.rightUrl && (
                      <span className="max-w-[200px] truncate" title={task.rightUrl}>
                        {task.rightUrl}
                      </span>
                    )}
                    {task.status === "success" && (
                      <span className="text-emerald-600">
                        成功 {task.successCount} / 失败 {task.failCount}
                      </span>
                    )}
                    {task.error && (
                      <span className="text-red-500">{task.error}</span>
                    )}
                  </div>
                </div>

                {/* 操作按钮 */}
                <div className="flex shrink-0 items-center gap-1">
                  {task.status === "running" && (
                    <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
                      执行中
                    </span>
                  )}
                  {!queueRunning && task.status !== "running" && (
                    <button
                      onClick={() => onRemoveFromQueue?.(task.id)}
                      className="rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-500"
                      title="从队列删除"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
