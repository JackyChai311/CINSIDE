import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
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
  MousePointerClick,
  MoveRight,
  PauseCircle,
  Play,
  PlayCircle,
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
  OVERALL_LABELS,
  VERIFY_METHOD_LABELS,
} from "../types";

import PluginPanel from "./PluginPanel";

type Tab = "mappings" | "report" | "execution" | "plugin";

interface Props {
  record: ApplicantRecord | null;
  mappings: FieldMapping[];
  comparisons: FieldComparison[];
  resultPresent: boolean;
  report: VerificationReport | null;
  loopReports?: VerificationReport[];
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
  /** 文档提取结果列表（当前卡片的多份文件，TAB切换） */
  docExtracts?: DocExtractState[];
  /** 当前激活的文件索引 */
  activeDocIndex?: number;
  /** 切换激活文件 */
  onSelectDocIndex?: (i: number) => void;
  /** 文档提取进行中 */
  docExtracting?: boolean;
  /** 切换到文档tab的触发值 */
  switchToDocSignal?: number;
  /** 当前拾取目标侧（审查/录入模式下的光标） */
  pickTarget?: "left" | "right" | null;
  /** 当前步骤模式：审查/录入 */
  addingStepMode?: "review" | "entry" | null;
  /** 点击「提取元素」字段卡片时回调（注入为合成拾取值） */
  onPickExtractedField?: (side: "left" | "right", field: string, value: string) => void;
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
  { id: "report", label: "验证报告", icon: <ShieldCheck className="h-3.5 w-3.5" /> },
  { id: "execution", label: "执行面板", icon: <Layers className="h-3.5 w-3.5" /> },
  { id: "plugin", label: "站外循环记录", icon: <Bot className="h-3.5 w-3.5" /> },
];

export default function ResultsPanel({
  record,
  mappings,
  comparisons,
  resultPresent,
  report,
  loopReports = [],
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
  docExtracts = [],
  activeDocIndex = 0,
  onSelectDocIndex,
  docExtracting = false,
  switchToDocSignal = 0,
  pickTarget = null,
  addingStepMode = null,
  onPickExtractedField,
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

  // 当 switchToLogSignal 变化时，自动切换到执行面板tab
  useEffect(() => {
    if (switchToLogSignal > 0) {
      setTab("execution");
    }
  }, [switchToLogSignal]);

  // 文档提取完成/进行中时，自动切换到验证报告tab
  useEffect(() => {
    if (switchToDocSignal > 0) {
      setTab("report");
    }
  }, [switchToDocSignal]);

  // 切换到任务队列：自动切换到执行面板tab
  useEffect(() => {
    if (switchToQueueSignal > 0) {
      setTab("execution");
    }
  }, [switchToQueueSignal]);

  const counts: Partial<Record<Tab, number>> = {
    mappings: mappings.length,
    report: (loopReports?.length || 0) + (report ? 1 : 0),
    execution: steps.length,
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
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "mappings" && (
          <div className="h-full overflow-auto">
            <MappingsTab mappings={mappings} onRemove={onRemoveMapping} />
          </div>
        )}
        {tab === "report" && (
          <div className="h-full overflow-auto">
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
              appMode={appMode}
              addingStepMode={addingStepMode}
              onPickExtractedField={onPickExtractedField}
            />
          </div>
        )}
        {tab === "execution" && (
          <ExecutionTab
            steps={steps}
            logEndRef={logEndRef}
            marks={pickedMarks}
            onRemoveMark={onRemovePickedMark}
            onClearMarks={onClearPickedMarks}
            onReplay={onReplay}
            replaying={replaying}
            replayCursor={replayCursor}
            onStopReplay={onStopReplay}
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
        {tab === "plugin" && (
          <div className="h-full overflow-hidden">
            <PluginPanel />
          </div>
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
  appMode,
  addingStepMode,
  onPickExtractedField,
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
  appMode: AppMode;
  addingStepMode?: "review" | "entry" | null;
  onPickExtractedField?: (side: "left" | "right", field: string, value: string) => void;
}) {
  const hasReports = reports && reports.length > 0;
  const hasCompare = resultPresent && comparisons.length > 0;
  const hasFieldData = hasReports || (report && report.entries.length > 0) || hasCompare;
  const [showSample, setShowSample] = useState(false);
  const [showDocSample, setShowDocSample] = useState(false);
  const [filter, setFilter] = useState<"all" | "pass" | "fail" | "review">("all");

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

  if (hasReports) {
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
        // 预处理后的图片（已自动旋转 + 裁剪白边）
        filePreview = (
          <div className="mb-2">
            <div className="mb-1 flex items-center gap-1 text-[9px] font-medium text-emerald-600">
              <CheckCircle2 className="h-3 w-3" />
              已处理：自动旋转到正面 + 裁剪白边
            </div>
            <div className="overflow-hidden rounded-md border border-slate-200 bg-slate-50">
              <img
                src={`data:image/jpeg;base64,${docExtract.processed_image}`}
                alt={docExtract.filename}
                className="max-h-48 w-full object-contain"
              />
            </div>
          </div>
        );
      } else if (isImageFile && fileUrl) {
        // 原始图片 URL（未预处理或预处理失败）
        filePreview = (
          <div className="mb-2">
            <div className="overflow-hidden rounded-md border border-slate-200 bg-slate-50">
              <img
                src={fileUrl}
                alt={docExtract.filename}
                className="max-h-48 w-full object-contain"
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
      <div className="flex h-full flex-col">
        {fileInfo}
        {filePreview}
        {compareBlock}
        {shotsBlock}
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

  return (
    <div className="flex h-full flex-col p-3">
      <div className="min-h-0 flex-1 grid grid-cols-1 gap-3 lg:grid-cols-3 lg:h-full">
        {/* 字段对比卡片 */}
        <div className="flex max-h-[55vh] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm lg:max-h-full">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-200 bg-slate-50/80 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700">
            <Table2 className="h-3.5 w-3.5 text-slate-500" />
            字段对比
          </div>
          {summaryBar && <div className="shrink-0 px-2 pt-2">{summaryBar}</div>}
          <div className="min-h-0 flex-1 overflow-auto p-2">{fieldContent}</div>
        </div>

        {/* 文件处理卡片（合并：文件对比 + AI视野） */}
        <div className="flex max-h-[55vh] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm lg:max-h-full">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-emerald-200 bg-emerald-50/60 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-800">
            <FileText className="h-3.5 w-3.5 text-emerald-600" />
            文件处理
            {docExtracts.length > 0 && (
              <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700">
                {docExtracts.length} 个文件
              </span>
            )}
            <span className="ml-auto text-[9px] font-normal text-emerald-600/70">PDF / JPG / JPEG</span>
          </div>
          {/* 多文件 TAB 切换栏 */}
          {docExtracts.length > 1 && onSelectDocIndex && (
            <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-slate-100 bg-slate-50/50 px-1.5 py-1">
              {docExtracts.map((ext, i) => (
                <button
                  key={i}
                  onClick={() => onSelectDocIndex(i)}
                  className={[
                    "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium transition-all",
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
          <div className="min-h-0 flex-1 overflow-auto p-2">{fileProcessContent}</div>
        </div>

        {/* 提取元素卡片（原 AI视野 位置） */}
        <div className="flex max-h-[55vh] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm lg:max-h-full">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-violet-200 bg-violet-50/60 px-2.5 py-1.5 text-[11px] font-semibold text-violet-800">
            <Database className="h-3.5 w-3.5 text-violet-600" />
            提取元素
            {docExtract && (
              <span className="max-w-[120px] truncate rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-normal text-violet-600" title={docExtract.filename}>
                {docExtract.filename}
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">{extractedContent}</div>
        </div>
      </div>
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

// ============ 执行面板：任务队列 + 操作记录 + 简化日志 ============
function ExecutionTab({
  steps,
  logEndRef,
  marks,
  onRemoveMark,
  onClearMarks,
  onReplay,
  replaying,
  replayCursor,
  onStopReplay,
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
  steps: VerificationStep[];
  logEndRef: React.RefObject<HTMLDivElement>;
  marks: PickedMark[];
  onRemoveMark?: (id: string) => void;
  onClearMarks?: () => void;
  onReplay?: () => void;
  replaying?: boolean;
  replayCursor?: number;
  onStopReplay?: () => void;
  taskQueue: QueuedTask[];
  queueRunning?: boolean;
  queueCursor?: number;
  onAddToQueue?: () => void;
  onRemoveFromQueue?: (id: string) => void;
  onRenameQueueTask?: (id: string, name: string) => void;
  onClearQueue?: () => void;
  onRunQueue?: () => void;
  onStopQueue?: () => void;
  canAddToQueue?: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      {/* 上半区：任务队列 + 操作记录，左右并排 */}
      <div className="flex shrink-0 flex-col gap-3 border-b border-slate-200/60 p-3 lg:h-[45%] lg:flex-row lg:min-h-[200px]">
        {/* 任务队列 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white/60">
          <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-slate-50/80 px-3 py-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
              <Layers className="h-3.5 w-3.5 text-indigo-600" />
              任务队列
              {taskQueue.length > 0 && (
                <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700">{taskQueue.length}</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {onAddToQueue && (
                <button
                  onClick={onAddToQueue}
                  disabled={!canAddToQueue}
                  className="rounded-md bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
                >
                  + 添加
                </button>
              )}
              {queueRunning && onStopQueue ? (
                <button onClick={onStopQueue} className="rounded-md bg-rose-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-rose-700">停止</button>
              ) : onRunQueue && taskQueue.length > 0 ? (
                <button onClick={onRunQueue} className="rounded-md bg-emerald-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-700">执行全部</button>
              ) : null}
              {onClearQueue && taskQueue.length > 0 && !queueRunning && (
                <button onClick={onClearQueue} className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><Trash2 className="h-3 w-3" /></button>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {taskQueue.length === 0 ? (
              <div className="flex h-full min-h-[80px] flex-col items-center justify-center text-[11px] text-slate-400">
                <Layers className="mb-1 h-6 w-6 text-slate-300" />
                暂无排队任务
              </div>
            ) : (
              <ul className="space-y-1.5">
                {taskQueue.map((task, i) => {
                  const isCurrent = queueRunning && i === queueCursor;
                  const name = task.name && task.name !== "未命名任务" ? task.name : `任务 ${i + 1}`;
                  const record = task.cardRecords.length;
                  return (
                    <li key={task.id} className={["flex items-center gap-2 rounded-lg border px-2.5 py-1.5", isCurrent ? "border-indigo-300 bg-indigo-50 shadow-sm" : "border-slate-200 bg-white hover:bg-slate-50"].join(" ")}>
                      {isCurrent ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-indigo-600" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
                      <span className="flex-1 truncate text-xs font-medium text-slate-700">{name}</span>
                      <span className="text-[10px] text-slate-400">{record}人</span>
                      {!queueRunning && (
                        <button onClick={() => onRemoveFromQueue?.(task.id)} className="rounded p-0.5 text-slate-300 hover:bg-rose-50 hover:text-rose-500"><X className="h-3 w-3" /></button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* 操作记录 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white/60">
          <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-slate-50/80 px-3 py-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
              <ListOrdered className="h-3.5 w-3.5 text-violet-600" />
              操作记录
              {marks.length > 0 && (
                <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700">{marks.length}</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {onReplay && marks.length >= 3 && !replaying && (
                <button onClick={onReplay} className="flex items-center gap-0.5 rounded-md bg-violet-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-violet-700">
                  <PlayCircle className="h-3 w-3" /> 回放
                </button>
              )}
              {replaying && onStopReplay && (
                <button onClick={onStopReplay} className="flex items-center gap-0.5 rounded-md bg-rose-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-rose-700">
                  <PauseCircle className="h-3 w-3" /> 暂停
                </button>
              )}
              {onClearMarks && marks.length > 0 && !replaying && (
                <button onClick={onClearMarks} className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><Trash2 className="h-3 w-3" /></button>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {marks.length === 0 ? (
              <div className="flex h-full min-h-[80px] flex-col items-center justify-center text-[11px] text-slate-400">
                <MousePointerClick className="mb-1 h-6 w-6 text-slate-300" />
                选择模式下点击页面元素
              </div>
            ) : (
              <ul className="space-y-1">
                {marks.map((m, idx) => {
                  const isPlaying = replaying && idx === replayCursor;
                  const wfLabel = m.workflow === "data-source" ? "数据源" : m.workflow === "review" ? "审查" : "录入";
                  return (
                    <li key={m.id} className={["flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs", isPlaying ? "border-violet-300 bg-violet-50 shadow-sm ring-1 ring-violet-200" : "border-slate-200 bg-white/70 hover:bg-white"].join(" ")}>
                      <span className={["flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold", isPlaying ? "bg-violet-600 text-white" : "bg-slate-200 text-slate-600"].join(" ")}>{m.order}</span>
                      <span className="shrink-0 text-[10px] text-slate-400">{wfLabel}</span>
                      <span className="flex-1 truncate text-slate-700" title={m.selector}>{m.label || m.selector}</span>
                      <span className={["rounded px-1.5 py-0.5 text-[9px] font-medium", m.side === "right" ? "bg-emerald-100 text-emerald-700" : "bg-sky-100 text-sky-700"].join(" ")}>{m.side === "right" ? "右" : "左"}</span>
                      {onRemoveMark && !replaying && (
                        <button onClick={() => onRemoveMark(m.id)} className="rounded p-0.5 text-slate-300 hover:bg-rose-50 hover:text-rose-500"><X className="h-3 w-3" /></button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* 下半区：简化执行日志 */}
      <div className="min-h-0 flex-1 flex flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-200/60 bg-slate-50/40 px-3 py-1.5 text-[11px] font-semibold text-slate-600">
          <Activity className="h-3.5 w-3.5 text-slate-500" />
          执行进度
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {steps.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-[11px] text-slate-400">
              <Activity className="mb-1 h-8 w-8 text-slate-300" />
              执行时显示进度
            </div>
          ) : (
            <ul className="space-y-1.5">
              {steps.map((s) => {
                // 任务大标题
                if (s.isTaskStart) {
                  return (
                    <li key={`task-${s.step}`} className="-mx-2 my-2 first:mt-0">
                      <div className="flex items-center gap-2 rounded-lg border-2 border-indigo-300 bg-gradient-to-r from-indigo-600 to-violet-600 px-3 py-2 shadow-md">
                        <Layers className="h-4 w-4 shrink-0 text-white" />
                        <span className="text-[12px] font-bold text-white">{s.taskName || "任务"}</span>
                        <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold text-white">{s.taskIndex}/{s.taskTotal}</span>
                        <span className="ml-auto text-[10px] text-indigo-200">{s.taskRecordCount}张卡片</span>
                      </div>
                    </li>
                  );
                }
                // 人物分隔
                if (s.isRecordStart) {
                  return (
                    <li key={`record-${s.step}`} className="-mx-1 my-1.5">
                      <div className="flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50/80 px-3 py-1.5 shadow-sm">
                        <UserCircle className="h-4 w-4 shrink-0 text-indigo-600" />
                        <span className="text-[11px] font-bold text-indigo-900">{s.recordName || "人物卡片"}</span>
                        <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white">{s.recordIndex}/{s.recordTotal}</span>
                      </div>
                    </li>
                  );
                }
                // 普通步骤：人类可读简化版
                const icon = s.success
                  ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  : <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />;
                return (
                  <li key={s.step} className="flex items-start gap-2 rounded px-2 py-1 animate-fade-in hover:bg-slate-50/60">
                    {icon}
                    <span className="text-[11px] text-slate-600 leading-5">
                      {s.description}
                      {s.detail && <span className="ml-1 text-slate-400">— {s.detail}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}
