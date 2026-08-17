import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CirclePause,
  AlertOctagon,
  Columns2,
  Crop,
  Crosshair,
  Database,
  Download,
  Eye,
  ExternalLink,
  FileText,
  Globe,
  Keyboard,
  Layers,
  List,
  Loader2,
  MinusCircle,
  MousePointerClick,
  MoveRight,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Save,
  ScanLine,
  ScanSearch,
  Settings2,
  Table2,
  Trash2,
  Type,
  Upload,
  Wrench,
  X,
  XCircle,
  FolderOpen,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  AppMode,
  ApplicantRecord,
  DocExtractState,
  FieldComparison,
  FieldMapping,
  FieldMatch,
  LivePair,
  PickedMark,
  ScreenshotEvent,
  VerificationReport,
  VerificationReportEntry,
  VerificationStep,
} from "../types";
import { api } from "../api/client";
import {
  FIELD_LABELS,
  MATCH_LABELS,
  OVERALL_LABELS,
} from "../types";
import { extractMethodLabel, isUmiMethod, isVisionMethod } from "../utils/formatNormalize";

/** 报告卡片展开状态的模块级缓存（key=record_id）：组件因查看定位/报告替换重挂载后保持展开 */
const personCardExpandedCache = new Map<string, boolean>();

/** 提取元素汇总项：字段对比设置态「提取元素」小卡片（文件提取步骤 + 自定义文本 + 控件，按设置时间 FIFO） */
export interface ExtractSummaryItem {
  id: string;
  kind: "doc" | "custom" | "widget";
  /** 类别名：本地文件 / 网页下载 / 文件字段 / 自定义文本 / 选项控件 / 日历控件 */
  name: string;
  /** 详情描述（标签/内容预览） */
  detail: string;
  /** 是否已保存为 LOOP 步骤 */
  saved: boolean;
  /** 设置时间戳（FIFO 排序用） */
  ts: number;
  /** 关联的网页元素选择器（点击卡片定位预览用，可空） */
  selector?: string;
  side?: "left" | "right";
}

/** 执行步骤项：统一表达前置点击/输入/审查字段/收尾点击 */
export interface ExecStepItem {
  /** 唯一id，用于DOM定位 */
  id: string;
  /** 步骤分组：pre=前置点击/输入, review=审查/录入字段, post=收尾点击 */
  group: "pre" | "review" | "post";
  /** 分组内序号（1-based） */
  orderInGroup: number;
  /** 显示标签 */
  label: string;
  /** 动作类型 */
  action: "click" | "input" | "compare" | "fill";
  /** 对应的PickedMark.order 或 reviewMapping索引 */
  sourceOrder?: number;
  /** 对应mark的id（用于DOM元素定位） */
  markId?: string;
}

interface Props {
  comparisons: FieldComparison[];
  resultPresent: boolean;
  report: VerificationReport | null;
  loopReports?: VerificationReport[];
  shots: ScreenshotEvent[];
  steps?: VerificationStep[];
  running: boolean;
  /** 真实 LOOP 执行中（批量/队列运行）；「查看」定位不算 —— 决定实时卡片是否接管报告区，缺省回退为 running */
  execRunning?: boolean;
  /** LOOP 运行期：当前记录逐对填入的字段对比/录入数据（一对一对填入卡片效果） */
  livePairs?: { recordId: string; pairs: LivePair[] };
  appMode?: AppMode;
  onDetach?: () => void;
  onClose?: () => void;
  docExtracts?: DocExtractState[];
  activeDocIndex?: number;
  onSelectDocIndex?: (i: number) => void;
  docExtracting?: boolean;
  /** 文件/护照 OCR 引擎：vision=识图AI，umi=本地 OCR */
  ocrEngine?: string;
  /** 切换 OCR 引擎（识图AI ↔ 本地 OCR） */
  onChangeOcrEngine?: (engine: "vision" | "umi") => void;
  /** 核显加速开关（本地 OCR 走内置加速引擎，不依赖 UMI 在线） */
  igpuAcceleration?: boolean;
  /** 文件提取步骤的断点状态：undefined=无断点，"always"=强制断点，"on-error"=条件断点 */
  docBreakpoint?: "always" | "on-error";
  /** 循环切换文件提取步骤的断点：无→强制→条件→无 */
  onToggleDocBreakpoint?: () => void;
  switchToDocSignal?: number;
  /** 外部信号：递增时切换字段对比面板的「步骤设置/结果显示」模式（L 快捷键） */
  fieldSetupToggleSignal?: number;
  addingStepMode?: "review" | "entry" | null;
  onPickExtractedField?: (side: "left" | "right", field: string, value: string) => void;
  /** 本地文件提取配置内容（有值时"文件处理"卡片显示它，替代正常内容） */
  docLocalConfigContent?: React.ReactNode;
  /** LOOP 执行期文件下载/OCR 实时状态（驱动文件处理/提取元素面板的实时进度显示） */
  docLiveStatus?: { phase: string; filename?: string; size?: number } | null;
  /** LOOP 执行期已下载文件的预览图 */
  docLivePreview?: { imageUrl: string; filename: string; method?: string } | null;
  /** 文件配置是否处于"选择来源"阶段（choose 模式下保留外层"文件处理"头部） */
  docConfigChooseMode?: boolean;
  /** 退出文件来源选择（choose 模式下外层头部的关闭按钮） */
  onExitDocChoose?: () => void;
  /** 聚焦面板模式："field"=只显示字段对比，"doc"=只显示文件处理，"doc-extract"=文件处理+提取元素两栏，"field-doc"=字段对比+文件处理两栏，null=三面板 */
  focusPanel?: "field" | "doc" | "doc-extract" | "field-doc" | null;
  /** 字段对比设置模式数据：前置点击 marks */
  preClickMarks?: PickedMark[];
  /** 字段对比设置模式数据：过程点击 marks（点击NEXT等中间步骤） */
  processClickMarks?: PickedMark[];
  /** 字段对比设置模式数据：收尾点击 marks */
  postClickMarks?: PickedMark[];
  /** 开始添加前置点击 */
  onStartAddPreClick?: () => void;
  /** 开始绑定输入框 */
  onStartBindInputs?: () => void;
  /** 是否正在绑定输入框模式中（用于高亮按钮） */
  bindInputActive?: boolean;
  /** 已绑定的输入/点击步数（用于数量徽章） */
  bindStepCount?: number;
  /** 是否正在添加前置点击 */
  preClickActive?: boolean;
  /** 开始添加过程点击（点击NEXT等中间步骤） */
  onStartAddProcessClick?: () => void;
  /** 是否正在添加过程点击 */
  processClickActive?: boolean;
  /** 开始添加收尾点击（提交按钮等） */
  onStartAddPostClick?: () => void;
  /** 是否正在添加收尾点击 */
  postClickActive?: boolean;
  /** 开始添加文件提取步骤 */
  onStartAddDocExtract?: () => void;
  /** 轻量打开文件提取来源选择面板（不退出其他设置模式，用于空面板自动展示） */
  onAutoOpenDocChoose?: () => void;
  /** 直接选择网页提取来源 */
  onChooseDocWeb?: () => void;
  /** 直接选择本地文件提取来源 */
  onChooseDocLocal?: () => void;
  /** 是否正在文件提取模式 */
  docExtractActive?: boolean;
  /** 切换提取步骤的录入/审核模式（用于文件提取和自定义文本面板） */
  onSwitchStepMode?: (mode: "review" | "entry") => void;
  /** 退出添加步骤模式（完成录入/审核步骤设置） */
  onExitAddingStepMode?: () => void;
  /** 点击字段对比面板时触发（激活仅面板内可用的快捷键） */
  onFieldPanelActive?: () => void;
  /** 当前双侧元素已选好、可以保存映射 */
  canSaveMapping?: boolean;
  /** 确认保存当前映射（ENTER 快捷键） */
  onConfirmMapping?: () => void;
  /** 字段对比设置模式数据：已配置的审查映射 */
  reviewMappings?: FieldMapping[];
  /** 删除一个 picked mark（前置/收尾点击） */
  onRemoveMark?: (id: string) => void;
  /** 删除一个审查映射（按索引） */
  onRemoveMapping?: (index: number) => void;
  /** 删除一个提取元素步骤（按 id 和 kind） */
  onRemoveExtractStep?: (id: string, kind: "doc" | "custom" | "widget") => void;
  /** 点击卡片预览：在对应网页高亮显示元素位置 */
  onPreviewMark?: (mark: PickedMark) => void;
  /** 保存当前步骤配置到这批勾选的卡片（分割批次用） */
  onSaveToBatch?: () => void;
  /** 命名保存为 LOOP 模板 */
  onRequestSaveLoop?: () => void;
  /** 应用已保存的 LOOP 模板 */
  onRequestApplyLoop?: () => void;
  /** 直接执行当前配置（临时运行，不保存） */
  onDirectRun?: () => void;
  /** 刷新工作区：清空光标、步骤设置和字段对比 */
  onRefresh?: () => void;
  /** 是否有可保存/执行的步骤（控制按钮禁用态） */
  canSaveLoop?: boolean;
  /** 当前是否有勾选的卡片（控制"保存到这批"按钮显隐） */
  hasCheckedBatch?: boolean;
  /** 自定义文本面板内容（有值时"提取元素"卡片显示它，替代正常内容） */
  customTextContent?: React.ReactNode;
  /** 外部信号：当为 true 时，自动切换"提取元素"面板到设置模式 */
  customTextMode?: boolean;
  /** 文件提取字段内容（从文件/图片识别出来送到面板的字段） */
  docFieldsContent?: React.ReactNode;
  /** 统一字段面板内容（文件提取+自定义文本合并，紫色/蓝色区分来源） */
  unifiedFieldsContent?: React.ReactNode;
  /** 提取元素面板 TAB 切换请求：ts 变化时自动切到对应 TAB（widgetTabId 指定具体控件） */
  extractTabRequest?: { tab: "doc" | "custom" | "widget"; widgetTabId?: string; ts: number } | null;
  /** 提取元素面板 TAB 顺序（FIFO：先设置的功能排前面） */
  extractTabOrder?: Array<"doc" | "custom" | "widget">;
  /** 各 TAB 条目数量角标 */
  extractCounts?: { doc: number; custom: number; widget: number };
  /** 提取元素汇总（字段对比设置态「提取元素」小卡片，按设置时间 FIFO） */
  extractStepSummary?: ExtractSummaryItem[];
  /** 控件提取面板内容（点击展开选项/日历控件，有值时优先于自定义文本显示） */
  widgetExtractContent?: React.ReactNode;
  /** 控件提取结果字段（已保存控件解析出的绑定值，显示在文件处理面板「提取结果」中） */
  widgetResultFields?: Array<{ key: string; label: string; value: string; kind: "option" | "calendar" }>;
  /** 正在从「提取结果」拾取护照字段的 key（非空时字段卡片可点击） */
  widgetPassportPickingKey?: string | null;
  /** 用户在「提取结果」点击某个护照字段 → 完成控件绑定 */
  onResolvePassportField?: (fieldKey: string) => void;
  /** 取消护照字段拾取 */
  onCancelPassportPicking?: () => void;
  /** 控件 TAB 列表：每个控件一个 TAB（浏览器标签页风格） */
  widgetTabs?: Array<{ id: string; label: string; kind: "option" | "calendar"; isDraft?: boolean; isBound?: boolean }>;
  /** 添加控件回调（TAB 栏 + 按钮） */
  onAddWidget?: (kind: "option" | "calendar") => void;
  /** 添加自定义文本字段 */
  onAddCustomText?: () => void;
  /** 外部信号：当为 true 时，自动切换"提取元素"面板到设置模式（控件提取） */
  widgetSetupSignal?: boolean;
  /** 外部信号：递增/变化时自动进入左右分栏模式（控件绑定左网页取值时保持控件面板可见） */
  splitWidgetRequest?: number;
  /** 文件处理分屏模式：为 true 时控件提取不隐藏文件处理面板，三栏同时可见 */
  docSplitView?: boolean;
  /** 数据源记录（用于卡片显示名字+学号） */
  records?: ApplicantRecord[];
  /** 字段列映射：标准字段名 -> Excel 原始列 key（卡片姓名/学号解析用） */
  fieldColumnMap?: Record<string, string>;
  /** 点击人物卡片跳转到该记录 */
  onSelectRecord?: (recordId: string) => void;
  /** 逐人比对历史：已完成的实时卡片展开时回看对比结果（livePairs 只保留当前人） */
  livePairsHistory?: Record<string, LivePair[]>;
  /** 点击已完成卡片的「查看」：定位记录 + AI 即时指出该人哪些字段不对 */
  onViewLiveCard?: (recordId: string) => void;
  /** 审查修正：把来源值写入被审查字段（网页填值/Excel列更新），返回是否成功 */
  onFixField?: (recordId: string, entry: VerificationReportEntry, rowKey: string) => Promise<boolean>;
  /** 审查修正：一键修正全部不一致字段并重新审查该卡片 */
  onFixAllAndRerun?: (recordId: string, entries: VerificationReportEntry[]) => void;
  /** 审查修正：确认后批量执行待标记项（fixKeys=左对右错写回，confirmKeys=右对左错就地改match），返回 Promise */
  onConfirmFixes?: (recordId: string, fixKeys: Set<string>, confirmKeys: Set<string>, entries: VerificationReportEntry[]) => Promise<Set<string>>;
  /** 从提取结果面板编辑 OCR 字段值后提交（同步到 docExtractsByRecord + loopReports 左值） */
  onEditExtractFields?: (recordId: string, fieldValueMap: Record<string, string>) => void;
  /** 当前正在查看的记录 id（用于将提取结果面板的字段编辑关联到正确的卡片） */
  currentRecordId?: string;
  /** LOOP 配置的文件提取字段清单：即便识别不到也把字段框摆出来（空白供人工补录） */
  expectedDocFields?: string[];
  /** 手动重提取：预览转正后点「提取」按当前旋转角重新提取并重算比对 */
  onReextractDoc?: (recordId: string, docIndex: number, rotation: number) => void;
  /** 手动重提取进行中 */
  docReextracting?: boolean;
  /** 框选区域识别：预览图上拖框 → 裁图纯 OCR → 填入字段（rect 为相对显示图的 0~1 比例） */
  onRegionOcr?: (recordId: string, docIndex: number, field: string, rect: { x: number; y: number; w: number; h: number }, rotation: number) => void;
  /** 正在做区域识别的字段（字段框上的加载态） */
  regionOcrField?: string | null;
  /** 正在确认批量修正的记录 id（卡片级加载态） */
  confirmingRecordId?: string | null;
  /** 导出修正后的 Excel（按钮显示在「字段对比」标题行，仅结果显示模式） */
  onExportExcel?: () => void;
  /** 导出 Excel 进行中 */
  exportingExcel?: boolean;
  /** 正在修正的字段行 key（行级加载态） */
  fixingFieldKey?: string | null;
  /** 正在修正并重新审查的记录 id（卡片级加载态） */
  fixRerunRecordId?: string | null;
  // ============ 执行时光标动画相关 ============
  /** 执行阶段：idle=未执行，marks=执行点击/输入，verify=逐字段审查，done=完成 */
  execPhase?: "idle" | "marks" | "verify" | "done";
  /** 当前正在执行的mark.order（marks阶段有效） */
  currentMarkOrder?: number | null;
  /** 当前正在审查的字段索引（reviewMappings中的位置，verify阶段有效，-1=未在审查） */
  activeVerifyIdx?: number;
  /** 审查字段比对结果（key = reviewMappings 中的索引 i） */
  reviewFieldResults?: Record<number, FieldMatch>;
  /** 所有已选marks（按order升序），用于执行步骤进度条 */
  allPickedMarks?: PickedMark[];
  /** 步骤选择模式：true时所有面板自动切到"设置"态 */
  selectMode?: boolean;
}

export default function ResultsPanel({
  comparisons,
  resultPresent,
  report,
  loopReports = [],
  shots,
  steps = [],
  running,
  execRunning,
  livePairs,
  appMode = "loop",
  onDetach,
  onClose,
  docExtracts = [],
  activeDocIndex = 0,
  onSelectDocIndex,
  docExtracting = false,
  ocrEngine = "vision",
  onChangeOcrEngine,
  igpuAcceleration = false,
  docBreakpoint,
  onToggleDocBreakpoint,
  addingStepMode = null,
  onPickExtractedField,
  docLocalConfigContent,
  docLiveStatus = null,
  docLivePreview = null,
  docConfigChooseMode = false,
  onExitDocChoose,
  focusPanel = null,
  preClickMarks = [],
  processClickMarks = [],
  postClickMarks = [],
  reviewMappings = [],
  onRemoveMark,
  onRemoveMapping,
  onRemoveExtractStep,
  onPreviewMark,
  onStartAddPreClick,
  onStartBindInputs,
  bindInputActive = false,
  bindStepCount = 0,
  preClickActive = false,
  onStartAddProcessClick,
  processClickActive = false,
  onStartAddPostClick,
  postClickActive = false,
  onStartAddDocExtract,
  onAutoOpenDocChoose,
  onChooseDocWeb,
  onChooseDocLocal,
  docExtractActive = false,
  onSwitchStepMode,
  onExitAddingStepMode,
  onFieldPanelActive,
  canSaveMapping = false,
  onConfirmMapping,
  onSaveToBatch,
  onRequestSaveLoop,
  onRequestApplyLoop,
  onDirectRun,
  onRefresh,
  canSaveLoop = false,
  hasCheckedBatch = false,
  customTextContent,
  customTextMode = false,
  docFieldsContent,
  unifiedFieldsContent,
  extractTabRequest = null,
  extractTabOrder = [],
  extractCounts,
  extractStepSummary = [],
  widgetExtractContent,
  widgetResultFields = [],
  widgetPassportPickingKey = null,
  onResolvePassportField,
  onCancelPassportPicking,
  widgetTabs = [],
  onAddWidget,
  onAddCustomText,
  widgetSetupSignal = false,
  splitWidgetRequest = 0,
  docSplitView = false,
  records = [],
  fieldColumnMap = {},
  onSelectRecord,
  livePairsHistory = {},
  onViewLiveCard,
  onFixField,
  onFixAllAndRerun,
  onEditExtractFields,
  currentRecordId = "",
  expectedDocFields = [],
  onReextractDoc,
  docReextracting = false,
  onRegionOcr,
  regionOcrField = null,
  onConfirmFixes,
  confirmingRecordId = null,
  onExportExcel,
  exportingExcel = false,
  fixingFieldKey = null,
  fixRerunRecordId = null,
  switchToDocSignal,
  fieldSetupToggleSignal,
  execPhase = "idle",
  currentMarkOrder = null,
  activeVerifyIdx = -1,
  reviewFieldResults,
  allPickedMarks = [],
  selectMode = false,
}: Props) {
  return (
    <div className="glass-strong relative flex h-full flex-col overflow-hidden rounded-2xl">
      {/* 右下角悬浮按钮（脱离、关闭） */}
      <div className="absolute bottom-1.5 right-1.5 z-10 flex items-center gap-0.5">
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
          ocrEngine={ocrEngine}
          onChangeOcrEngine={onChangeOcrEngine}
          igpuAcceleration={igpuAcceleration}
          docBreakpoint={docBreakpoint}
          onToggleDocBreakpoint={onToggleDocBreakpoint}
          shots={shots}
          running={running}
          execRunning={execRunning}
          steps={steps}
          livePairs={livePairs}
          appMode={appMode}
          addingStepMode={addingStepMode}
          onPickExtractedField={onPickExtractedField}
          docLocalConfigContent={docLocalConfigContent}
          docLiveStatus={docLiveStatus}
          docLivePreview={docLivePreview}
          docConfigChooseMode={docConfigChooseMode}
          onExitDocChoose={onExitDocChoose}
          focusPanel={focusPanel}
          preClickMarks={preClickMarks}
          processClickMarks={processClickMarks}
          postClickMarks={postClickMarks}
          reviewMappings={reviewMappings}
          onRemoveMark={onRemoveMark}
          onRemoveMapping={onRemoveMapping}
          onRemoveExtractStep={onRemoveExtractStep}
          onPreviewMark={onPreviewMark}
          onStartAddPreClick={onStartAddPreClick}
          onStartBindInputs={onStartBindInputs}
          bindInputActive={bindInputActive}
          bindStepCount={bindStepCount}
          preClickActive={preClickActive}
          onStartAddProcessClick={onStartAddProcessClick}
          processClickActive={processClickActive}
          onStartAddPostClick={onStartAddPostClick}
          postClickActive={postClickActive}
          onStartAddDocExtract={onStartAddDocExtract}
          docExtractActive={docExtractActive}
          onAutoOpenDocChoose={onAutoOpenDocChoose}
          onChooseDocWeb={onChooseDocWeb}
          onChooseDocLocal={onChooseDocLocal}
          onSwitchStepMode={onSwitchStepMode}
          onExitAddingStepMode={onExitAddingStepMode}
          onFieldPanelActive={onFieldPanelActive}
          canSaveMapping={canSaveMapping}
          onConfirmMapping={onConfirmMapping}
          onSaveToBatch={onSaveToBatch}
          onRequestSaveLoop={onRequestSaveLoop}
          onRequestApplyLoop={onRequestApplyLoop}
          onDirectRun={onDirectRun}
          onRefresh={onRefresh}
          canSaveLoop={canSaveLoop}
          hasCheckedBatch={hasCheckedBatch}
          customTextContent={customTextContent}
          customTextMode={customTextMode}
          docFieldsContent={docFieldsContent}
          unifiedFieldsContent={unifiedFieldsContent}
          extractTabRequest={extractTabRequest}
          extractTabOrder={extractTabOrder}
          extractCounts={extractCounts}
          extractStepSummary={extractStepSummary}
          widgetExtractContent={widgetExtractContent}
          widgetResultFields={widgetResultFields}
          widgetPassportPickingKey={widgetPassportPickingKey}
          onResolvePassportField={onResolvePassportField}
          onCancelPassportPicking={onCancelPassportPicking}
          widgetTabs={widgetTabs}
          onAddWidget={onAddWidget}
          onAddCustomText={onAddCustomText}
          widgetSetupSignal={widgetSetupSignal}
          splitWidgetRequest={splitWidgetRequest}
          docSplitView={docSplitView}
          records={records}
          fieldColumnMap={fieldColumnMap}
          onSelectRecord={onSelectRecord}
          livePairsHistory={livePairsHistory}
          onViewLiveCard={onViewLiveCard}
          onFixField={onFixField}
          onFixAllAndRerun={onFixAllAndRerun}
          onEditExtractFields={onEditExtractFields}
          currentRecordId={currentRecordId}
          expectedDocFields={expectedDocFields}
          onReextractDoc={onReextractDoc}
          docReextracting={docReextracting}
          onRegionOcr={onRegionOcr}
          regionOcrField={regionOcrField}
          onConfirmFixes={onConfirmFixes}
          confirmingRecordId={confirmingRecordId}
          onExportExcel={onExportExcel}
          exportingExcel={exportingExcel}
          fixingFieldKey={fixingFieldKey}
          fixRerunRecordId={fixRerunRecordId}
          switchToDocSignal={switchToDocSignal}
          fieldSetupToggleSignal={fieldSetupToggleSignal}
          execPhase={execPhase}
          currentMarkOrder={currentMarkOrder}
          activeVerifyIdx={activeVerifyIdx}
          reviewFieldResults={reviewFieldResults}
          allPickedMarks={allPickedMarks}
          selectMode={selectMode}
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
  /** 原始报告条目（审查修正功能用） */
  entry?: VerificationReportEntry;
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

// ============ 文档对比（功能1：网页 PDF/图片 → OCR/文档解析 → 左右对比） ============
function DocCompareTab({
  docExtract,
  extracting,
  ocrEngine = "vision",
}: {
  docExtract: DocExtractState | null;
  extracting: boolean;
  ocrEngine?: string;
}) {
  const [showFullText, setShowFullText] = useState(false);
  const engineLabel = ocrEngine === "umi" ? "OCR" : "AI Vision";

  if (extracting) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
        <p className="text-xs text-slate-500">
          正在使用 {engineLabel} 识别文档文字…
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

  const methodBadge = (() => {
    const m = docExtract.method;
    const label = extractMethodLabel(m);
    const cls = isVisionMethod(m)
      ? "bg-violet-100 text-violet-700"
      : isUmiMethod(m)
      ? "bg-emerald-100 text-emerald-700"
      : "bg-sky-100 text-sky-700";
    return (
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>
        {label}
      </span>
    );
  })();

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
        <div className="rounded-lg bg-slate-50/60 px-3 py-4 text-center text-[11px] text-slate-400">
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
  ocrEngine = "vision",
  onChangeOcrEngine,
  igpuAcceleration = false,
  docBreakpoint,
  onToggleDocBreakpoint,
  shots,
  running,
  execRunning,
  steps,
  livePairs,
  appMode,
  addingStepMode,
  onPickExtractedField,
  docLocalConfigContent,
  docLiveStatus = null,
  docLivePreview = null,
  docConfigChooseMode = false,
  onExitDocChoose,
  focusPanel = null,
  preClickMarks = [],
  processClickMarks = [],
  postClickMarks = [],
  reviewMappings = [],
  onRemoveMark,
  onRemoveMapping,
  onRemoveExtractStep,
  onPreviewMark,
  onStartAddPreClick,
  onStartBindInputs,
  bindInputActive = false,
  bindStepCount = 0,
  preClickActive = false,
  onStartAddProcessClick,
  processClickActive = false,
  onStartAddPostClick,
  postClickActive = false,
  onStartAddDocExtract,
  onAutoOpenDocChoose,
  onChooseDocWeb,
  onChooseDocLocal,
  docExtractActive = false,
  onSwitchStepMode,
  onExitAddingStepMode,
  onFieldPanelActive,
  canSaveMapping = false,
  onConfirmMapping,
  onSaveToBatch,
  onRequestSaveLoop,
  onRequestApplyLoop,
  onDirectRun,
  onRefresh,
  canSaveLoop = false,
  hasCheckedBatch = false,
  customTextContent,
  customTextMode = false,
  docFieldsContent,
  unifiedFieldsContent,
  extractTabRequest = null,
  extractTabOrder = [],
  extractCounts,
  extractStepSummary = [],
  widgetExtractContent,
  widgetResultFields = [],
  widgetPassportPickingKey = null,
  onResolvePassportField,
  onCancelPassportPicking,
  widgetTabs = [],
  onAddWidget,
  onAddCustomText,
  widgetSetupSignal = false,
  splitWidgetRequest = 0,
  docSplitView = false,
  records = [],
  fieldColumnMap = {},
  onSelectRecord,
  livePairsHistory = {},
  onViewLiveCard,
  onFixField,
  onFixAllAndRerun,
  onEditExtractFields,
  currentRecordId = "",
  expectedDocFields = [],
  onReextractDoc,
  docReextracting = false,
  onRegionOcr,
  regionOcrField = null,
  onConfirmFixes,
  confirmingRecordId = null,
  onExportExcel,
  exportingExcel = false,
  fixingFieldKey = null,
  fixRerunRecordId = null,
  switchToDocSignal,
  fieldSetupToggleSignal,
  execPhase = "idle",
  currentMarkOrder = null,
  activeVerifyIdx = -1,
  reviewFieldResults = {},
  allPickedMarks = [],
  selectMode = false,
}: {
  report: VerificationReport | null;
  reports: VerificationReport[];
  comparisons: FieldComparison[];
  resultPresent: boolean;
  docExtracts: DocExtractState[];
  activeDocIndex: number;
  onSelectDocIndex?: (i: number) => void;
  docExtracting: boolean;
  /** 文件/护照 OCR 引擎：vision=识图AI，umi=本地 OCR */
  ocrEngine?: string;
  /** 切换 OCR 引擎（识图AI ↔ 本地 OCR） */
  onChangeOcrEngine?: (engine: "vision" | "umi") => void;
  /** 核显加速开关（本地 OCR 走内置加速引擎，不依赖 UMI 在线） */
  igpuAcceleration?: boolean;
  /** 文件提取步骤的断点状态 */
  docBreakpoint?: "always" | "on-error";
  /** 循环切换文件提取步骤的断点 */
  onToggleDocBreakpoint?: () => void;
  shots: ScreenshotEvent[];
  running: boolean;
  /** 真实 LOOP 执行中（批量/队列运行）；「查看」定位不算 —— 决定实时卡片是否接管报告区，缺省回退为 running */
  execRunning?: boolean;
  steps: VerificationStep[];
  /** LOOP 运行期逐对填入卡片的字段对比/录入数据（一对一对填入效果） */
  livePairs?: { recordId: string; pairs: LivePair[] };
  appMode: AppMode;
  addingStepMode?: "review" | "entry" | null;
  onPickExtractedField?: (side: "left" | "right", field: string, value: string) => void;
  /** 本地文件提取配置内容（有值时"文件处理"卡片显示它，替代正常内容） */
  docLocalConfigContent?: React.ReactNode;
  /** LOOP 执行期文件下载/OCR 实时状态（驱动文件处理/提取元素面板的实时进度显示） */
  docLiveStatus?: { phase: string; filename?: string; size?: number } | null;
  /** LOOP 执行期已下载文件的预览图 */
  docLivePreview?: { imageUrl: string; filename: string; method?: string } | null;
  /** 文件配置是否处于"选择来源"阶段（choose 模式下保留外层"文件处理"头部） */
  docConfigChooseMode?: boolean;
  /** 退出文件来源选择（choose 模式下外层头部的关闭按钮） */
  onExitDocChoose?: () => void;
  /** 聚焦面板模式："field"=只显示字段对比，"doc"=只显示文件处理，"doc-extract"=文件处理+提取元素两栏，"field-doc"=字段对比+文件处理两栏，null=三面板 */
  focusPanel?: "field" | "doc" | "doc-extract" | "field-doc" | null;
  /** 字段对比设置模式数据：前置点击 marks */
  preClickMarks?: PickedMark[];
  /** 字段对比设置模式数据：过程点击 marks（点击NEXT等中间步骤） */
  processClickMarks?: PickedMark[];
  /** 字段对比设置模式数据：收尾点击 marks */
  postClickMarks?: PickedMark[];
  /** 开始添加前置点击 */
  onStartAddPreClick?: () => void;
  /** 开始绑定输入框 */
  onStartBindInputs?: () => void;
  /** 是否正在绑定输入框模式中（用于高亮按钮） */
  bindInputActive?: boolean;
  /** 已绑定的输入/点击步数（用于数量徽章） */
  bindStepCount?: number;
  /** 是否正在添加前置点击 */
  preClickActive?: boolean;
  /** 开始添加过程点击（点击NEXT等中间步骤） */
  onStartAddProcessClick?: () => void;
  /** 是否正在添加过程点击 */
  processClickActive?: boolean;
  /** 开始添加收尾点击（提交按钮等） */
  onStartAddPostClick?: () => void;
  /** 是否正在添加收尾点击 */
  postClickActive?: boolean;
  /** 开始添加文件提取步骤 */
  onStartAddDocExtract?: () => void;
  /** 轻量打开文件提取来源选择面板（不退出其他设置模式，用于空面板自动展示） */
  onAutoOpenDocChoose?: () => void;
  /** 直接选择网页提取来源 */
  onChooseDocWeb?: () => void;
  /** 直接选择本地文件提取来源 */
  onChooseDocLocal?: () => void;
  /** 是否正在文件提取模式 */
  docExtractActive?: boolean;
  /** 切换提取步骤的录入/审核模式（用于文件提取和自定义文本面板） */
  onSwitchStepMode?: (mode: "review" | "entry") => void;
  /** 退出添加步骤模式（完成录入/审核步骤设置） */
  onExitAddingStepMode?: () => void;
  /** 点击字段对比面板时触发（激活仅面板内可用的快捷键） */
  onFieldPanelActive?: () => void;
  /** 当前双侧元素已选好、可以保存映射 */
  canSaveMapping?: boolean;
  /** 确认保存当前映射（ENTER 快捷键） */
  onConfirmMapping?: () => void;
  /** 字段对比设置模式数据：已配置的审查映射 */
  reviewMappings?: FieldMapping[];
  /** 删除一个 picked mark（前置/收尾点击） */
  onRemoveMark?: (id: string) => void;
  /** 删除一个审查映射（按索引） */
  onRemoveMapping?: (index: number) => void;
  /** 删除一个提取元素步骤（按 id 和 kind） */
  onRemoveExtractStep?: (id: string, kind: "doc" | "custom" | "widget") => void;
  /** 点击卡片预览：在对应网页高亮显示元素位置 */
  onPreviewMark?: (mark: PickedMark) => void;
  /** 保存当前步骤配置到这批勾选的卡片（分割批次用） */
  onSaveToBatch?: () => void;
  /** 命名保存为 LOOP 模板 */
  onRequestSaveLoop?: () => void;
  /** 应用已保存的 LOOP 模板 */
  onRequestApplyLoop?: () => void;
  /** 直接执行当前配置（临时运行，不保存） */
  onDirectRun?: () => void;
  /** 刷新工作区：清空光标、步骤设置和字段对比 */
  onRefresh?: () => void;
  /** 是否有可保存/执行的步骤（控制按钮禁用态） */
  canSaveLoop?: boolean;
  /** 当前是否有勾选的卡片（控制"保存到这批"按钮显隐） */
  hasCheckedBatch?: boolean;
  /** 自定义文本面板内容（有值时"提取元素"卡片显示它，替代正常内容） */
  customTextContent?: React.ReactNode;
  /** 外部信号：当为 true 时，自动切换"提取元素"面板到设置模式 */
  customTextMode?: boolean;
  /** 文件提取字段内容（从文件/图片识别出来送到面板的字段） */
  docFieldsContent?: React.ReactNode;
  /** 统一字段面板内容（文件提取+自定义文本合并，紫色/蓝色区分来源） */
  unifiedFieldsContent?: React.ReactNode;
  /** 提取元素面板 TAB 切换请求：ts 变化时自动切到对应 TAB（widgetTabId 指定具体控件） */
  extractTabRequest?: { tab: "doc" | "custom" | "widget"; widgetTabId?: string; ts: number } | null;
  /** 提取元素面板 TAB 顺序（FIFO：先设置的功能排前面） */
  extractTabOrder?: Array<"doc" | "custom" | "widget">;
  /** 各 TAB 条目数量角标 */
  extractCounts?: { doc: number; custom: number; widget: number };
  /** 提取元素汇总（字段对比设置态「提取元素」小卡片，按设置时间 FIFO） */
  extractStepSummary?: ExtractSummaryItem[];
  /** 控件提取面板内容（点击展开选项/日历控件，有值时优先于自定义文本显示） */
  widgetExtractContent?: React.ReactNode;
  /** 控件提取结果字段（已保存控件解析出的绑定值，显示在文件处理面板「提取结果」中） */
  widgetResultFields?: Array<{ key: string; label: string; value: string; kind: "option" | "calendar" }>;
  /** 正在从「提取结果」拾取护照字段的 key（非空时字段卡片可点击） */
  widgetPassportPickingKey?: string | null;
  /** 用户在「提取结果」点击某个护照字段 → 完成控件绑定 */
  onResolvePassportField?: (fieldKey: string) => void;
  /** 取消护照字段拾取 */
  onCancelPassportPicking?: () => void;
  /** 控件 TAB 列表：每个控件一个 TAB（浏览器标签页风格） */
  widgetTabs?: Array<{ id: string; label: string; kind: "option" | "calendar"; isDraft?: boolean; isBound?: boolean }>;
  /** 添加控件回调（TAB 栏 + 按钮） */
  onAddWidget?: (kind: "option" | "calendar") => void;
  /** 添加自定义文本字段 */
  onAddCustomText?: () => void;
  /** 外部信号：当为 true 时，自动切换"提取元素"面板到设置模式（控件提取） */
  widgetSetupSignal?: boolean;
  /** 外部信号：递增/变化时自动进入左右分栏模式（控件绑定左网页取值时保持控件面板可见） */
  splitWidgetRequest?: number;
  /** 文件处理分屏模式：为 true 时控件提取不隐藏文件处理面板，三栏同时可见 */
  docSplitView?: boolean;
  /** 数据源记录（用于卡片显示名字+学号） */
  records?: ApplicantRecord[];
  /** 字段列映射：标准字段名 -> Excel 原始列 key（卡片姓名/学号解析用） */
  fieldColumnMap?: Record<string, string>;
  /** 点击人物卡片跳转到该记录 */
  onSelectRecord?: (recordId: string) => void;
  /** 逐人比对历史：已完成的实时卡片展开时回看对比结果（livePairs 只保留当前人） */
  livePairsHistory?: Record<string, LivePair[]>;
  /** 点击已完成卡片的「查看」：定位记录 + AI 即时指出该人哪些字段不对 */
  onViewLiveCard?: (recordId: string) => void;
  /** 审查修正：把来源值写入被审查字段（网页填值/Excel列更新），返回是否成功 */
  onFixField?: (recordId: string, entry: VerificationReportEntry, rowKey: string) => Promise<boolean>;
  /** 审查修正：一键修正全部不一致字段并重新审查该卡片 */
  onFixAllAndRerun?: (recordId: string, entries: VerificationReportEntry[]) => void;
  /** 审查修正：确认后批量执行待标记项（fixKeys=左对右错写回，confirmKeys=右对左错就地改match），返回 Promise */
  onConfirmFixes?: (recordId: string, fixKeys: Set<string>, confirmKeys: Set<string>, entries: VerificationReportEntry[]) => Promise<Set<string>>;
  /** 从提取结果面板编辑 OCR 字段值后提交（同步到 docExtractsByRecord + loopReports 左值） */
  onEditExtractFields?: (recordId: string, fieldValueMap: Record<string, string>) => void;
  /** 当前正在查看的记录 id（用于将提取结果面板的字段编辑关联到正确的卡片） */
  currentRecordId?: string;
  /** LOOP 配置的文件提取字段清单：即便识别不到也把字段框摆出来（空白供人工补录） */
  expectedDocFields?: string[];
  /** 手动重提取：预览转正后点「提取」按当前旋转角重新提取并重算比对 */
  onReextractDoc?: (recordId: string, docIndex: number, rotation: number) => void;
  /** 手动重提取进行中 */
  docReextracting?: boolean;
  /** 框选区域识别：预览图上拖框 → 裁图纯 OCR → 填入字段（rect 为相对显示图的 0~1 比例） */
  onRegionOcr?: (recordId: string, docIndex: number, field: string, rect: { x: number; y: number; w: number; h: number }, rotation: number) => void;
  /** 正在做区域识别的字段（字段框上的加载态） */
  regionOcrField?: string | null;
  /** 正在确认批量修正的记录 id（卡片级加载态） */
  confirmingRecordId?: string | null;
  /** 导出修正后的 Excel（按钮显示在「字段对比」标题行，仅结果显示模式） */
  onExportExcel?: () => void;
  /** 导出 Excel 进行中 */
  exportingExcel?: boolean;
  /** 正在修正的字段行 key（行级加载态） */
  fixingFieldKey?: string | null;
  /** 正在修正并重新审查的记录 id（卡片级加载态） */
  fixRerunRecordId?: string | null;
  /** 外部信号：递增时切换到文件处理面板的结果模式（显示已提取文件） */
  switchToDocSignal?: number;
  /** 外部信号：递增时切换字段对比面板的「步骤设置/结果显示」模式（L 快捷键） */
  fieldSetupToggleSignal?: number;
  // ============ 执行时光标动画相关 ============
  /** 执行阶段：idle=未执行，marks=执行点击/输入，verify=逐字段审查，done=完成 */
  execPhase?: "idle" | "marks" | "verify" | "done";
  /** 当前正在执行的mark.order（marks阶段有效） */
  currentMarkOrder?: number | null;
  /** 当前正在审查的字段索引（reviewMappings中的位置，verify阶段有效，-1=未在审查） */
  activeVerifyIdx?: number;
  /** 审查字段比对结果（key = reviewMappings 中的索引 i） */
  reviewFieldResults?: Record<number, FieldMatch>;
  /** 所有已选marks（按order升序），用于执行步骤进度条 */
  allPickedMarks?: PickedMark[];
  /** 步骤选择模式：true时所有面板自动切到"设置"态 */
  selectMode?: boolean;
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
  /** 文件处理面板中提取结果展开/收起（默认展开，方便二审查看提取的字段和全文） */
  const [showExtractResult, setShowExtractResult] = useState(true);
  /** 护照字段拾取时自动展开提取结果 */
  useEffect(() => {
    if (widgetPassportPickingKey) setShowExtractResult(true);
  }, [widgetPassportPickingKey]);
  /** 提取全文展开/收起 */
  const [showFullText, setShowFullText] = useState(false);
  /** 提取结果字段值编辑模式（点击🔧开启，可手动修正 OCR 错读后点「校正」） */
  const [editExtractMode, setEditExtractMode] = useState(false);
  const [editedExtractValues, setEditedExtractValues] = useState<Record<string, string>>({});
  const updateEditedExtractValue = (field: string, value: string) => {
    setEditedExtractValues((prev) => ({ ...prev, [field]: value }));
  };
  /** 内嵌文件预览的旋转和缩放（切换文件时重置） */
  const [filePreviewRotation, setFilePreviewRotation] = useState(0);
  const [filePreviewZoom, setFilePreviewZoom] = useState(1);
  /** 框选区域识别：当前正在框选的字段（非 null 时预览图进入框选模式） */
  const [regionPickField, setRegionPickField] = useState<string | null>(null);
  /** 框选橡皮筋（client 坐标） */
  const [regionRect, setRegionRect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const regionStartRef = useRef<{ x: number; y: number } | null>(null);
  const filePreviewImgRef = useRef<HTMLImageElement | null>(null);
  /** 预览平移偏移（拖拽移动 / 滚轮缩放时围绕鼠标位置同步调整） */
  const [filePreviewPan, setFilePreviewPan] = useState({ x: 0, y: 0 });
  const [filePreviewDragging, setFilePreviewDragging] = useState(false);
  const filePreviewBoxRef = useRef<HTMLDivElement | null>(null);
  const filePreviewDragRef = useRef<{ id: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const filePreviewZoomRef = useRef(1);
  /** UMI-OCR 连通性状态 */
  const [umiStatus, setUmiStatus] = useState<"idle" | "checking" | "available" | "unavailable">("idle");
  const [umiStatusMsg, setUmiStatusMsg] = useState("");
  const [umiLaunching, setUmiLaunching] = useState(false);
  /** 已定位到的 Umi-OCR.exe 路径（供显示与「打开所在文件夹」使用） */
  const [umiExePath, setUmiExePath] = useState("");

  // 切换 OCR 引擎时自动检测 UMI-OCR 连通性
  const checkUmiStatus = async () => {
    setUmiStatus("checking");
    setUmiStatusMsg("正在检测 UMI-OCR…");
    try {
      const res = await api.testUmiOcr();
      if (res.ok) {
        setUmiStatus("available");
        setUmiStatusMsg(res.message || "UMI-OCR 可用");
      } else {
        setUmiStatus("unavailable");
        setUmiStatusMsg(res.message || "UMI-OCR 不可用");
      }
    } catch {
      setUmiStatus("unavailable");
      setUmiStatusMsg("检测请求失败，请确认后端已启动");
    }
  };

  // 挂载时如果默认引擎就是 umi，自动验证在线状态
  useEffect(() => {
    if (ocrEngine === "umi" && umiStatus === "idle") {
      checkUmiStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocrEngine]);

  const handleOcrEngineSwitch = async (engine: "vision" | "umi") => {
    onChangeOcrEngine?.(engine);
    if (engine === "umi") {
      checkUmiStatus();
    } else {
      setUmiStatus("idle");
      setUmiStatusMsg("");
    }
  };

  // 一键启动 UMI-OCR
  const handleLaunchUmi = async () => {
    setUmiLaunching(true);
    setUmiStatusMsg("正在启动 UMI-OCR…");
    try {
      const res = await api.launchUmiOcr();
      if (res.exe_path) setUmiExePath(res.exe_path);
      if (res.ok) {
        setUmiStatus("available");
        setUmiStatusMsg(res.message || "UMI-OCR 已启动");
      } else {
        setUmiStatus("unavailable");
        setUmiStatusMsg(res.message || "启动失败");
      }
    } catch {
      setUmiStatus("unavailable");
      setUmiStatusMsg("启动请求失败，请确认后端已启动");
    } finally {
      setUmiLaunching(false);
    }
  };

  // 打开 UMI-OCR 所在文件夹（供用户手动双击启动）
  const handleOpenUmiFolder = async () => {
    try {
      const res = await api.openUmiOcrFolder();
      if (res.exe_path) setUmiExePath(res.exe_path);
      setUmiStatusMsg(res.message || "已打开所在文件夹");
    } catch {
      setUmiStatusMsg("打开文件夹请求失败，请确认后端已启动");
    }
  };
  /** 提取元素面板模式开关：true=设置（自定义字段），false=结果（提取内容/DEMO） */
  const [extractSetupMode, setExtractSetupMode] = useState(false);
  /** 提取元素面板当前激活的大分类：doc=文件提取 / custom=自定义文本 / widget=控件提取（切换显示，不滚动） */
  const [activeCategory, setActiveCategory] = useState<"doc" | "custom" | "widget">("custom");
  /** 控件提取内部当前激活的控件 TAB id（用于 scroll spy 高亮 + 滚动定位） */
  const [activeWidgetTabId, setActiveWidgetTabId] = useState<string | null>(null);
  /** 提取元素面板左右分栏模式：true=左半显示文件/自定义文本，右半显示控件提取 */
  const [splitWidgetMode, setSplitWidgetMode] = useState(false);
  /** 用户主动点击「控件提取」按钮时强制显示控件面板（即使暂无控件内容，也显示空状态以引导添加） */
  const [forceWidgetView, setForceWidgetView] = useState(false);
  /** 左右分栏时左侧宽度百分比（默认 50%） */
  const [splitLeftPct, setSplitLeftPct] = useState(50);
  /** 控件提取模式下手动展开文件处理面板（docSplitView 由外部控制，此状态为用户在面板内手动展开） */
  const [filePanelManuallyOpen, setFilePanelManuallyOpen] = useState(false);
  /** 提取元素滚动容器 ref + widget节 ref（用于控件子TAB滚动定位） */
  const extractScrollRef = useRef<HTMLDivElement | null>(null);
  const extractSectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  /** 左右分栏拖拽相关 ref */
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const splitDraggingRef = useRef(false);

  // 两侧是否有实际内容：文件/自定义字段、控件提取
  const fieldCount = (extractCounts?.doc ?? 0) + (extractCounts?.custom ?? 0);
  const hasFields = fieldCount > 0;
  const hasWidget = !!(widgetExtractContent || widgetTabs.length > 0 || widgetSetupSignal);
  // 真正进入左右分栏的前提：两侧都有内容；否则即使请求了分栏也回退为单栏
  const effectiveSplit = splitWidgetMode && hasFields && hasWidget;

  // 外部 docSplitView 为 true 时同步展开文件面板（保证分屏中控件提取时文件面板可见）
  // 用户可在面板内手动收起/展开，filePanelManuallyOpen 作为唯一控制面板可见性的状态
  useEffect(() => {
    if (docSplitView) setFilePanelManuallyOpen(true);
  }, [docSplitView]);

  // 文件处理面板是否实际可见（手动展开状态）
  const filePanelVisible = filePanelManuallyOpen;

  // 确定当前实际显示的大分类：
  // - 用户明确切到 widget 且有控件内容（或强制查看控件面板）→ widget
  // - 其它情况遵循 activeCategory（默认 custom）
  const currentCategory = useMemo<"doc" | "custom" | "widget">(() => {
    const hw = !!(widgetExtractContent || widgetTabs.length > 0 || widgetSetupSignal);
    if (activeCategory === "widget" && (hw || forceWidgetView)) return "widget";
    return "custom";
  }, [activeCategory, widgetExtractContent, widgetTabs.length, widgetSetupSignal, forceWidgetView]);
  // 控件面板是否可见（分栏时右侧始终可见；单栏时取决于 currentCategory）
  const widgetVisible = effectiveSplit || currentCategory === "widget";

  // 记录用户是否手动切换过分类（手动切换后不再自动跳回 widget）
  const userPickedCategoryRef = useRef(false);

  /**
   * 标题栏「控件提取」按钮的切换逻辑：
   * - 分栏中 → 收起分栏，回到文本面板
   * - 控件单栏 → 切回文本面板
   * - 文本单栏 + 两侧都有内容 → 进入分栏
   * - 文本单栏 + 仅一侧有内容（或都没有）→ 切到控件面板（空状态也显示，引导添加）
   */
  const toggleWidgetPanel = useCallback(() => {
    userPickedCategoryRef.current = true;
    if (effectiveSplit) {
      setSplitWidgetMode(false);
      setActiveCategory("custom");
      setForceWidgetView(false);
    } else if (currentCategory === "widget") {
      setActiveCategory("custom");
      setForceWidgetView(false);
    } else {
      // 当前在文本面板
      setShowExtractPanel(true);
      setExtractSetupMode(true);
      if (hasFields && hasWidget) {
        // 两侧都有实际内容 → 分栏
        setSplitWidgetMode(true);
      } else {
        // 仅一侧有内容或都没有 → 切到控件单栏（forceWidgetView 允许空状态显示）
        setActiveCategory("widget");
        setForceWidgetView(true);
        const container = extractScrollRef.current;
        if (container) container.scrollTo({ top: 0, behavior: "auto" });
      }
    }
  }, [effectiveSplit, currentCategory, hasFields, hasWidget]);

  // 当没有字段内容但出现了控件内容时，自动切到 widget 单栏（避免空面板占位）；
  // 用户手动切回 custom（如想添加文本）后不再自动跳回
  useEffect(() => {
    if (hasWidget && !hasFields && !userPickedCategoryRef.current) {
      setActiveCategory("widget");
    }
  }, [hasWidget, hasFields]);

  /** 点击控件子 TAB 时平滑滚动到对应控件卡片 */
  const scrollToWidgetTab = useCallback((tabId: string) => {
    setActiveWidgetTabId(tabId);
    const container = extractScrollRef.current;
    const widgetSection = extractSectionRefs.current["widget"];
    if (!container || !widgetSection) return;
    const targetEl = widgetSection.querySelector<HTMLElement>(`[data-widget-tab-id="${tabId}"]`);
    if (!targetEl) return;
    const cRect = container.getBoundingClientRect();
    const tRect = targetEl.getBoundingClientRect();
    const delta = tRect.top - cRect.top - 4;
    container.scrollTo({ top: container.scrollTop + delta, behavior: "smooth" });
  }, []);

  /** 左右分栏拖拽分隔条 */
  const onSplitDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    splitDraggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const container = splitContainerRef.current;
    if (!container) return;
    const startX = e.clientX;
    const startPct = splitLeftPct;
    const rect = container.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      if (!splitDraggingRef.current) return;
      const dx = ev.clientX - startX;
      const pctDelta = (dx / rect.width) * 100;
      const newPct = Math.min(80, Math.max(20, startPct + pctDelta));
      setSplitLeftPct(newPct);
    };
    const onUp = () => {
      splitDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [splitLeftPct]);

  // 进入左右分栏模式时，如果当前在 widget 分类，自动将左侧切到 doc 或 custom
  useEffect(() => {
    if (effectiveSplit && activeCategory === "widget") {
      if (docFieldsContent !== undefined) setActiveCategory("doc");
      else if (customTextContent !== undefined) setActiveCategory("custom");
    }
  }, [effectiveSplit, activeCategory, docFieldsContent, customTextContent]);
  // 聚焦字段对比面板时（用户正在添加前置/收尾点击或审查步骤），自动切换到设置模式
  useEffect(() => {
    if (focusPanel === "field" || focusPanel === "field-doc") setFieldSetupMode(true);
  }, [focusPanel]);
  // 聚焦文件处理面板时（用户正在配置文件提取），自动切换到设置模式
  useEffect(() => {
    if (focusPanel === "doc" || focusPanel === "doc-extract" || focusPanel === "field-doc") setDocSetupMode(true);
  }, [focusPanel]);
  // choose 来源选择模式激活时，自动切到"设置"态（选择来源卡片即为设置页）
  useEffect(() => {
    if (docConfigChooseMode) setDocSetupMode(true);
  }, [docConfigChooseMode]);
  // doc-extract 模式自动展开提取元素面板到设置态
  useEffect(() => {
    if (focusPanel === "doc-extract") {
      setShowExtractPanel(true);
      setExtractSetupMode(true);
    }
  }, [focusPanel]);
  // 外部激活自定义文本时，自动切换提取元素面板到设置模式
  useEffect(() => {
    if (customTextMode) setExtractSetupMode(true);
  }, [customTextMode]);
  // 外部激活控件提取时，自动切换提取元素面板到设置模式
  useEffect(() => {
    if (widgetSetupSignal) setExtractSetupMode(true);
  }, [widgetSetupSignal]);
  // 外部请求进入左右分栏（控件绑定左网页取值时）：仅当两侧都有内容时才分栏；
  // 若文件/自定义没有内容，则只切到控件单栏，避免留一个空白面板
  useEffect(() => {
    if (!splitWidgetRequest) return;
    setShowExtractPanel(true);
    setExtractSetupMode(true);
    const fieldsHasContent = (extractCounts?.doc ?? 0) + (extractCounts?.custom ?? 0) > 0;
    const widgetHasContent = widgetTabs.length > 0 || !!widgetSetupSignal;
    if (fieldsHasContent && widgetHasContent) {
      setSplitWidgetMode(true);
    } else {
      setSplitWidgetMode(false);
      setActiveCategory("widget");
    }
  }, [splitWidgetRequest, extractCounts, widgetTabs.length, widgetSetupSignal]);
  // 外部请求切换提取元素 TAB/控件：切换分类，若指定控件则滚动定位
  useEffect(() => {
    if (!extractTabRequest) return;
    setShowExtractPanel(true);
    setExtractSetupMode(true);
    setActiveCategory(extractTabRequest.tab);
    if (extractTabRequest.widgetTabId) {
      setActiveWidgetTabId(extractTabRequest.widgetTabId);
      const t = setTimeout(() => scrollToWidgetTab(extractTabRequest.widgetTabId!), 150);
      return () => clearTimeout(t);
    }
  }, [extractTabRequest, scrollToWidgetTab]);
  // 外部信号：切换到文件处理面板的结果模式（点击学生卡片"查看"时触发）
  useEffect(() => {
    if (switchToDocSignal != null && switchToDocSignal > 0) {
      setDocSetupMode(false);
      setFieldSetupMode(false);
    }
  }, [switchToDocSignal]);
  // 外部信号：L 快捷键切换字段对比面板的「步骤设置/结果显示」模式
  useEffect(() => {
    if (fieldSetupToggleSignal != null && fieldSetupToggleSignal > 0) {
      setFieldSetupMode((v) => !v);
    }
  }, [fieldSetupToggleSignal]);
  // 运行开始时，自动将所有面板切到"结果"态
  useEffect(() => {
    if (running) {
      setFieldSetupMode(false);
      setDocSetupMode(false);
      setExtractSetupMode(false);
    }
  }, [running]);
  // 步骤选择模式开启时，所有面板自动切到"设置"态，并展开提取元素面板
  useEffect(() => {
    if (selectMode) {
      setFieldSetupMode(true);
      setDocSetupMode(true);
      setExtractSetupMode(true);
      setShowExtractPanel(true);
    }
  }, [selectMode]);

  /** Scroll spy：仅在控件分类下监听控件卡片可见性，自动高亮当前控件 TAB */
  useEffect(() => {
    if (!extractSetupMode || currentCategory !== "widget") return;
    const container = extractScrollRef.current;
    const widgetSection = extractSectionRefs.current["widget"];
    if (!container || !widgetSection) return;

    const widgetCards = Array.from(widgetSection.querySelectorAll<HTMLElement>("[data-widget-tab-id]"));
    if (widgetCards.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .map((e) => e.target as HTMLElement);
        if (visible.length === 0) return;
        visible.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        const topEl = visible[0];
        const id = topEl.getAttribute("data-widget-tab-id");
        if (id) setActiveWidgetTabId(id);
      },
      { root: container, threshold: [0.1, 0.3, 0.6], rootMargin: "-20px 0px -70% 0px" }
    );
    widgetCards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [extractSetupMode, currentCategory, widgetTabs, widgetExtractContent]);

  // ============ 执行步骤进度条：构建扁平步骤列表 + FLIP光标动画 ============
  // 步骤顺序：所有marks（按order升序，包含前置/中间/收尾的点击和输入）→ reviewMappings（审查字段）
  const flatSteps = useMemo(() => {
    type StepItem = {
      key: string;
      label: string;
      type: "mark" | "review";
      mark?: PickedMark;
      reviewIdx?: number;
      side?: "left" | "right";
    };
    const items: StepItem[] = [];
    // 所有marks按order升序排列
    for (const m of allPickedMarks) {
      items.push({
        key: `mark:${m.order}`,
        label: (m.label || "").replace(/^输入/, m.workflow === "entry" ? "录入" : "审查") || (m.action === "input" ? (m.workflow === "entry" ? "录入" : "审查") : "点击"),
        type: "mark",
        mark: m,
        side: m.side,
      });
    }
    for (let i = 0; i < reviewMappings.length; i++) {
      const mp = reviewMappings[i];
      items.push({
        key: `review:${i}`,
        label: mp.right_label || mp.left_field || `字段${i + 1}`,
        type: "review",
        reviewIdx: i,
        side: "right",
      });
    }
    return items;
  }, [allPickedMarks, reviewMappings]);

  // 计算当前活动步骤在 flatSteps 中的索引
  const activeStepIndex = useMemo(() => {
    if (execPhase === "idle" || execPhase === "done") return -1;
    if (execPhase === "marks" && currentMarkOrder != null) {
      return flatSteps.findIndex((s) => s.type === "mark" && s.mark?.order === currentMarkOrder);
    }
    if (execPhase === "verify" && activeVerifyIdx >= 0) {
      return flatSteps.findIndex((s) => s.type === "review" && s.reviewIdx === activeVerifyIdx);
    }
    return -1;
  }, [execPhase, currentMarkOrder, activeVerifyIdx, flatSteps]);

  // FLIP 动画：光标平滑移动到当前活动步骤
  const stepItemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const cursorRef = useRef<HTMLDivElement>(null);
  const stepBarRef = useRef<HTMLDivElement>(null);
  // 上一次光标DOM矩形，用于FLIP
  const lastCursorRect = useRef<{ left: number; top: number; width: number; height: number } | null>(null);

  useEffect(() => {
    const cursor = cursorRef.current;
    if (!cursor) return;
    if (activeStepIndex < 0 || !stepItemRefs.current[activeStepIndex]) {
      // 无活动步骤时隐藏光标
      cursor.style.opacity = "0";
      lastCursorRect.current = null;
      return;
    }
    const target = stepItemRefs.current[activeStepIndex]!;
    const bar = stepBarRef.current;
    if (!bar) return;
    const barRect = bar.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();

    // 相对于bar容器的目标位置
    const nextLeft = targetRect.left - barRect.left;
    const nextTop = targetRect.top - barRect.top;
    const nextWidth = targetRect.width;
    const nextHeight = targetRect.height;

    if (!lastCursorRect.current) {
      // 第一次出现，直接定位
      cursor.style.transition = "none";
      cursor.style.transform = `translate(${nextLeft}px, ${nextTop}px)`;
      cursor.style.width = `${nextWidth}px`;
      cursor.style.height = `${nextHeight}px`;
      cursor.style.opacity = "1";
      // 强制reflow
      cursor.getBoundingClientRect();
    } else {
      // FLIP: First(记录上一位置), Last(新位置), Invert(先放回旧位置), Play(transition到新位置)
      const prev = lastCursorRect.current;
      const deltaX = prev.left - nextLeft;
      const deltaY = prev.top - nextTop;
      const scaleX = prev.width / nextWidth;
      const scaleY = prev.height / nextHeight;
      // 先invert（无transition），从当前位置"反向"补偿到上一帧视觉位置
      cursor.style.transition = "none";
      cursor.style.transform = `translate(${nextLeft + deltaX}px, ${nextTop + deltaY}px) scale(${scaleX}, ${scaleY})`;
      cursor.style.width = `${nextWidth}px`;
      cursor.style.height = `${nextHeight}px`;
      cursor.style.opacity = "1";
      // 强制reflow让invert生效
      cursor.getBoundingClientRect();
      // 再play（有transition）回到新位置
      cursor.style.transition = "transform 280ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms";
      cursor.style.transform = `translate(${nextLeft}px, ${nextTop}px) scale(1, 1)`;
    }
    lastCursorRect.current = { left: nextLeft, top: nextTop, width: nextWidth, height: nextHeight };
  }, [activeStepIndex, flatSteps.length]);

  // 窗口大小变化时重置光标位置
  useEffect(() => {
    const onResize = () => { lastCursorRect.current = null; };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** 判断某个步骤项的状态：'active' | 'done' | 'fail' | 'pending' */
  const getStepStatus = useCallback((s: typeof flatSteps[number]): "active" | "done" | "fail" | "pending" => {
    if (s.type === "mark") {
      const order = s.mark?.order;
      if (order == null) return "pending";
      if (execPhase === "marks" && currentMarkOrder === order) return "active";
      if (execPhase === "verify" || execPhase === "done") {
        // marks阶段已过；若当前mark.order < 正在执行或已审查的起点，视作完成
        // 简单处理：所有mark在verify/done阶段都视为已完成（成功）
        return "done";
      }
      return "pending";
    } else {
      // review step
      const idx = s.reviewIdx!;
      if (execPhase === "verify" && activeVerifyIdx === idx) return "active";
      if (reviewFieldResults[idx]) {
        return reviewFieldResults[idx] === "match" ? "done" : "fail";
      }
      if (execPhase === "done" && reviewFieldResults[idx]) {
        return reviewFieldResults[idx] === "match" ? "done" : "fail";
      }
      // done阶段但没有结果（理论上都有了），默认pending
      if (execPhase === "done") return "done";
      return "pending";
    }
  }, [execPhase, currentMarkOrder, activeVerifyIdx, reviewFieldResults]);

  // 三栏宽度（百分比）
  const [leftWidth, setLeftWidth] = useState(32);
  const [midWidth, setMidWidth] = useState(36);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<null | "left" | "right">(null);
  const liveScrollRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback((which: "left" | "right") => {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = which;
      setDragging(true);
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
      setDragging(false);
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
  // 用 recordMap 快速查找记录信息（姓名/学号）；卡片 record_id 带「__随机后缀」，同时按原始 id 建索引
  const recordMap = useMemo(() => {
    const m = new Map<string, ApplicantRecord>();
    records.forEach((r) => {
      m.set(r.record_id, r);
      const base = r.record_id.split("__")[0];
      if (!m.has(base)) m.set(base, r);
    });
    return m;
  }, [records]);

  /** 按 record_id（可带后缀）查找记录 */
  const findRecord = (rid: string | undefined): ApplicantRecord | undefined => {
    if (!rid) return undefined;
    return recordMap.get(rid) || recordMap.get(rid.split("__")[0]);
  };

  // 辅助：按标准字段取值（优先标准字段，其次 fieldColumnMap 手动映射的原始列）
  const getMappedField = (rec: ApplicantRecord | undefined, field: "name" | "passport_no" | "student_id"): string => {
    if (!rec) return "";
    const direct = rec.fields[field];
    if (direct && direct.trim()) return direct.trim();
    const mapped = fieldColumnMap[field];
    if (mapped) {
      const v = rec.fields[mapped];
      if (v && v.trim()) return v.trim();
    }
    return "";
  };
  // 辅助：从 record 中获取学号（兼容标准字段、手动映射列和常见别名）
  const getStudentId = (rec: ApplicantRecord | undefined): string => {
    if (!rec) return "";
    return getMappedField(rec, "student_id") || rec.fields.student_no || rec.fields.sid || rec.fields.id || rec.fields.学号 || "";
  };
  // 辅助：从 record 中获取姓名（优先标准字段/手动映射列，其次 fullname 别名）
  const getDisplayName = (rec: ApplicantRecord | undefined, fallback: string): string => {
    if (!rec) return fallback;
    return getMappedField(rec, "name") || (rec.fields.fullname || "").trim() || fallback;
  };

  interface LiveRecord {
    name: string;
    studentId: string;
    recordId: string;
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
      // 从records中查找补充姓名和学号
      const rid = s.recordId || "";
      const rec = findRecord(rid);
      cur = {
        name: getDisplayName(rec, name),
        studentId: getStudentId(rec),
        recordId: rid,
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
    // 用户手动展开/收起过后，不再自动折叠——跑批途中回看已完成卡片不被强制关上
    const userToggledRef = useRef(false);
    const toggleExpanded = () => {
      userToggledRef.current = true;
      // 手动展开时右侧文件处理面板跟着切到该人物（自动展开不触发，避免跑批途中抢焦点）
      if (!expanded && onSelectRecord && rec.recordId) onSelectRecord(rec.recordId);
      setExpanded((v) => !v);
    };
    // 运行中自动展开当前卡片
    useEffect(() => {
      if (isRunning) setExpanded(true);
    }, [isRunning]);
    // 刚完成时延迟1秒自动折叠（有问题的卡片保持展开；用户点开过的不动它）
    useEffect(() => {
      if (!isRunning && !isFailed && !userToggledRef.current) {
        const t = setTimeout(() => {
          if (!userToggledRef.current) setExpanded(false);
        }, 1200);
        return () => clearTimeout(t);
      }
    }, [isRunning, isFailed, rec.fieldSteps.length]);

    const doneCount = rec.fieldSteps.filter((f) => f.done).length;
    // 逐对填卡数据：当前记录有 livePairs 时用实时数据；已完成的卡片回退到历史对比（随时可回看）
    const cardPairs = livePairs && livePairs.recordId === rec.recordId
      ? livePairs.pairs
      : (livePairsHistory[rec.recordId] || []);
    // 状态色系：执行中=无色系（中性灰），已完成=天蓝（只代表跑完，不代表通过——
    // 通过与否要看字段明细，绿色留给最终报告的"通过"判定，避免误会），需检查=红
    // 状态用散发的颜色区分（无文字徽标/圆点）：glow=卡片外圈柔光
    const accent = isFailed
      ? { head: "bg-rose-50/80 border-rose-200", text: "text-rose-700", spin: "text-rose-500", glow: "shadow-[0_2px_14px_-4px_rgba(244,63,94,0.35)]" }
      : isRunning
      ? { head: "bg-white border-slate-200", text: "text-slate-700", spin: "text-slate-400", glow: "shadow-sm" }
      : { head: "bg-sky-50/80 border-sky-200", text: "text-sky-700", spin: "text-sky-500", glow: "shadow-[0_2px_14px_-4px_rgba(14,165,233,0.3)]" };

    return (
      <div data-running={isRunning} className={`overflow-hidden rounded-md border transition-all ${accent.glow} ${accent.head}`}>
        <div className="flex w-full items-center gap-2 px-3 py-1.5">
          <button
            onClick={toggleExpanded}
            className="flex flex-1 items-center gap-2 text-left transition-colors hover:brightness-[0.97]"
          >
            {isRunning ? (
              <Loader2 className={`h-3.5 w-3.5 shrink-0 animate-spin ${accent.spin}`} />
            ) : isFailed ? (
              <XCircle className={`h-3.5 w-3.5 shrink-0 ${accent.spin}`} />
            ) : (
              <CheckCircle2 className={`h-3.5 w-3.5 shrink-0 ${accent.spin}`} />
            )}
            <div className="min-w-0 flex-1">
              <span className={`block truncate text-[12px] font-semibold leading-tight ${accent.text}`}>{rec.name || "未命名"}</span>
              {rec.studentId && (
                <span className="block truncate font-mono text-[9px] leading-tight text-slate-400">{rec.studentId}</span>
              )}
            </div>
          </button>
          {onSelectRecord && rec.recordId && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                userToggledRef.current = true; // 手动查看后保持展开，不被自动折叠关上
                setExpanded(true); // 点击后保持展开，回看该人对比结果
                (onViewLiveCard || onSelectRecord)(rec.recordId);
              }}
              className="shrink-0 rounded px-1.5 py-0.5 text-[9px] text-slate-400 transition-colors hover:bg-slate-200/60 hover:text-slate-600"
              title="查看该人对比结果，AI 指出哪些字段不对"
            >
              查看
            </button>
          )}
          {isRunning && (
            <span className="shrink-0 font-mono text-[10px] text-slate-400">{doneCount}步</span>
          )}
          <button
            onClick={toggleExpanded}
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-slate-200/50"
          >
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
          </button>
        </div>
        {expanded && cardPairs.length > 0 ? (
          /* 字段对比态：一对一对填入（左=提取/Excel值，右=网页/审查值） */
          <div className="border-t border-slate-200/60 bg-white/70 px-3 py-1.5">
            <ul className="space-y-1">
              {cardPairs.map((p, i) => (
                <li
                  key={i}
                  className={[
                    "flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px]",
                    p.status === "mismatch" ? "bg-rose-50/80" : p.status === "missing" ? "bg-amber-50/80" : "",
                  ].join(" ")}
                >
                  {p.status === "pending" ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-amber-500" />
                  ) : p.status === "match" ? (
                    <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
                  ) : p.status === "mismatch" ? (
                    <XCircle className="h-3 w-3 shrink-0 text-rose-500" />
                  ) : (
                    <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
                  )}
                  <span className="shrink-0 font-medium text-slate-700">{p.label}</span>
                  {p.kind === "compare" ? (
                    <span className="flex min-w-0 flex-1 items-center gap-1 font-mono text-[10px]">
                      <span
                        className={`truncate rounded px-1 py-0.5 ${p.status === "pending" && !p.leftValue ? "text-slate-400" : "bg-indigo-50/80 text-indigo-700"}`}
                        title={p.leftValue}
                      >
                        {p.leftValue || (p.status === "pending" ? "读取中…" : "—")}
                      </span>
                      <MoveRight className="h-3 w-3 shrink-0 text-slate-400" />
                      <span
                        className={[
                          "truncate rounded px-1 py-0.5",
                          p.status === "pending"
                            ? "text-slate-400"
                            : p.status === "match"
                            ? "bg-emerald-50/80 text-emerald-700"
                            : p.status === "mismatch"
                            ? "bg-rose-100/80 font-semibold text-rose-700"
                            : "bg-amber-100/80 text-amber-700",
                        ].join(" ")}
                        title={p.rightValue}
                      >
                        {p.rightValue || (p.status === "pending" ? "比对中…" : "—")}
                      </span>
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1 truncate rounded bg-sky-50/80 px-1 py-0.5 font-mono text-[10px] text-sky-700" title={p.leftValue}>
                      {p.leftValue || "—"}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : expanded && rec.fieldSteps.length > 0 ? (
          <div className="border-t border-slate-200/60 bg-white/70 px-3 py-1.5">
            <ul className="space-y-1">
              {rec.fieldSteps.map((f, i) => {
                const isCurrent = !f.done && isRunning;
                return (
                  <li key={i} className="flex items-center gap-1.5 text-[11px]">
                    {isCurrent ? (
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-slate-400" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
                    )}
                    <span className={isCurrent ? "font-medium text-slate-700" : "text-slate-600"}>
                      {f.label}
                    </span>
                    {isCurrent && f.detail && (
                      <span className="ml-1 truncate rounded bg-slate-100 px-1 py-0.5 font-mono text-[9px] text-slate-500">
                        {f.detail.replace(/^填入:\s*/, "")}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
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
    // 展开状态按 record_id 写入模块级缓存：查看定位/修正重跑导致组件重挂载后，卡片保持展开不自己收起
    const expandKey = r.record_id || r.task_id || "";
    const [expandedState, setExpandedState] = useState(() => personCardExpandedCache.get(expandKey) ?? false);
    const setExpanded = (v: boolean | ((p: boolean) => boolean)) => {
      setExpandedState((prev) => {
        const next = typeof v === "function" ? v(prev) : v;
        personCardExpandedCache.set(expandKey, next);
        return next;
      });
    };
    const expanded = expandedState;
    // 展开/收起切换：展开的同时让右侧文件处理面板自动切到该人物那一套，无需再点「查看」
    const toggleExpanded = () => {
      setExpanded((v) => !v);
    };
    /** 已应用的字段行 key（确认执行成功后迁入，重新审查生成新报告后自动重置） */
    const [fixedKeys, setFixedKeys] = useState<Set<string>>(new Set());
    // ===== 两阶段修正：先标记方向，再统一确认执行 =====
    /** 扳手标记：左侧对、右侧错（确认时以左值写回右侧） */
    const [fixStageKeys, setFixStageKeys] = useState<Set<string>>(new Set());
    /** 圈勾标记：右侧对、左侧错（确认时不写值，就地改报告为 match，以右侧为准） */
    const [confirmStageKeys, setConfirmStageKeys] = useState<Set<string>>(new Set());
    /** 标记方向：扳手 vs 圈勾互斥——同一行点其一会清掉另一个 */
    const stageMarkFix = (key: string) => {
      setFixStageKeys((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
      setConfirmStageKeys((prev) => { const next = new Set(prev); next.delete(key); return next; });
    };
    const stageMarkConfirm = (key: string) => {
      setConfirmStageKeys((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
      setFixStageKeys((prev) => { const next = new Set(prev); next.delete(key); return next; });
    };
    const isEntry = appMode === "entry";
    const rows: SideCompareRow[] = r.entries.map((e, i) => ({
      key: `${e.left_field || e.right_label || "field"}-${i}`,
      leftLabel: FIELD_LABELS[e.left_field] || e.left_field || "左侧来源",
      leftValue: e.left_value || "",
      rightLabel: e.right_label || "右侧元素",
      rightValue: e.right_value || "",
      match: e.match,
      note: e.reasoning,
      entry: e,
    }));
    /** 该行是否可一键修正：不一致 + 来源值非空 + 被审查侧可写（网页元素/Excel绑定列/文件提取绑定列）；录入模式同样支持（提取值→Excel列） */
    const canFixRow = (row: SideCompareRow): boolean => {
      const e = row.entry;
      if (!e || !onFixField) return false;
      if (e.match !== "mismatch" && e.match !== "error") return false;
      if (!(e.left_value || "").trim()) return false;
      return !!e.right_selector || /（(?:Excel|文件提取)·.+）$/.test(e.right_label || "");
    };
    /** 可修正的不一致行数（决定卡片级按钮显隐） */
    const fixableRows = rows.filter(canFixRow);
    const isFixRerunning = fixRerunRecordId === r.record_id;
    /** 底部「确认」：一次性执行全部待标记项（左对写回 / 右对改match），仅成功项迁入已修正，失败项保留待标记供重试 */
    const stagedCount = fixStageKeys.size + confirmStageKeys.size;
    const handleConfirm = async () => {
      if (!onConfirmFixes || !r.record_id) return;
      const fixKeysAtCall = new Set(fixStageKeys);
      const confirmKeysAtCall = new Set(confirmStageKeys);
      const appliedKeys = await onConfirmFixes(r.record_id, fixKeysAtCall, confirmKeysAtCall, r.entries) || new Set();
      // 仅从待标记集合中移除成功项，失败项保留以显示红标并允许重试
      setFixStageKeys((prev) => {
        const next = new Set(prev);
        for (const k of fixKeysAtCall) if (appliedKeys.has(k)) next.delete(k);
        return next;
      });
      setConfirmStageKeys((prev) => {
        const next = new Set(prev);
        for (const k of confirmKeysAtCall) if (appliedKeys.has(k)) next.delete(k);
        return next;
      });
      setFixedKeys((prev) => {
        const next = new Set(prev);
        for (const k of appliedKeys) next.add(k);
        return next;
      });
    };
    const mc = rows.filter((x) => x.match === "match").length;
    const mmc = rows.filter((x) => x.match === "mismatch" || x.match === "error").length;
    const hasMrzWarning = (r.mrz_warnings?.length ?? 0) > 0;
    const isPass = r.overall === "pass" && !hasMrzWarning;
    const isReview = r.overall === "review" || hasMrzWarning;

    // 状态色系（MRZ警告时强制amber黄色系）——沿用运行时卡片的紧凑设计：
    // 通过=emerald绿 / 需检查=amber黄 / 有问题=rose红，只靠头部底色+外圈柔光散发区分，无文字徽标
    const accent = isPass
      ? { head: "bg-emerald-50/80 border-emerald-200", badgeSoft: "bg-emerald-100 text-emerald-700", footer: "text-emerald-700", text: "text-emerald-700", icon: "text-emerald-500", glow: "shadow-[0_2px_14px_-4px_rgba(16,185,129,0.35)]" }
      : isReview
      ? { head: "bg-amber-50/80 border-amber-200", badgeSoft: "bg-amber-100 text-amber-700", footer: "text-amber-700", text: "text-amber-700", icon: "text-amber-500", glow: "shadow-[0_2px_14px_-4px_rgba(245,158,11,0.35)]" }
      : { head: "bg-rose-50/80 border-rose-200", badgeSoft: "bg-rose-100 text-rose-700", footer: "text-rose-700", text: "text-rose-700", icon: "text-rose-500", glow: "shadow-[0_2px_14px_-4px_rgba(244,63,94,0.35)]" };
    const OverallIcon = isPass ? CheckCircle2 : isReview ? AlertTriangle : XCircle;

    // 从 records 中补充学号信息（如果后端没返回 student_id）
    const srcRec = findRecord(r.record_id);
    // 姓名显示：优先报告内烘焙的名字；若为空或是 REC 编号样式（早期映射缺失时生成），则从记录实时解析（含手动映射列）
    const bakedName = (r.record_name || "").trim();
    const isIdLikeName = !bakedName || bakedName === r.record_id || /^rec[-_]/i.test(bakedName);
    const displayName = !isIdLikeName
      ? bakedName
      : getMappedField(srcRec, "name") || (srcRec?.fields.fullname || "").trim() || getMappedField(srcRec, "passport_no") || bakedName || "人物卡片";
    const studentId = r.student_id || getStudentId(srcRec);

    return (
      <div className={`overflow-hidden rounded-md border transition-all ${accent.glow} ${accent.head}`}>
        {/* 头部（沿用运行时卡片：紧凑单行——状态图标+姓名+学号+统计徽标+查看+折叠） */}
        <div className="flex w-full items-center gap-2 px-3 py-1.5">
          <button
            onClick={toggleExpanded}
            className="flex flex-1 items-center gap-2 text-left transition-colors hover:brightness-[0.97]"
          >
            <OverallIcon className={`h-3.5 w-3.5 shrink-0 ${accent.icon}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className={`truncate text-[12px] font-semibold leading-tight ${accent.text}`}>{displayName}</span>
                {hasMrzWarning && (
                  <span
                    className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-700"
                    title="护照MRZ交叉验证发现不一致，已以MRZ为准，请人工复核"
                  >
                    <AlertTriangle className="h-2.5 w-2.5" />
                    MRZ
                  </span>
                )}
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${accent.badgeSoft}`}>
                  {mc}/{rows.length}
                </span>
              </div>
              {studentId && (
                <span className="block truncate font-mono text-[9px] leading-tight text-slate-400">{studentId}</span>
              )}
            </div>
          </button>
          {onSelectRecord && r.record_id && (
            <button
              onClick={(e) => { e.stopPropagation(); onSelectRecord(r.record_id); }}
              className="shrink-0 rounded px-1.5 py-0.5 text-[9px] text-slate-400 transition-colors hover:bg-slate-200/60 hover:text-slate-600"
              title="跳转到该记录"
            >
              查看
            </button>
          )}
          <button
            onClick={toggleExpanded}
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-slate-200/50"
          >
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
          </button>
        </div>

        {/* 展开内容 */}
        {expanded && (
          <>
            {/* MRZ交叉验证警告（紧凑版） */}
            {hasMrzWarning && (
              <div className="border-t border-amber-200/70 bg-amber-50/80 px-3 py-1.5">
                <div className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-semibold text-amber-800">MRZ交叉验证提示（已以MRZ为准修正，请人工复核）</div>
                    <div className="mt-0.5 space-y-0.5">
                      {r.mrz_warnings?.map((w, wi) => (
                        <div key={wi} className="text-[10px] leading-relaxed text-amber-700">• {w}</div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
            {/* 字段对比行（沿用运行时的一对一填卡：状态图标+标签+左chip→右chip） */}
            <div className="border-t border-slate-200/60 bg-white/70 px-3 py-1.5">
              <ul className="space-y-1">
                {rows.map((row) => {
                  const isMismatch = row.match === "mismatch" || row.match === "error";
                  const isMatch = row.match === "match";
                  return (
                    <li
                      key={row.key}
                      className={[
                        "flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px]",
                        isMismatch ? "bg-rose-50/80" : row.match === "missing" ? "bg-amber-50/80" : "",
                      ].join(" ")}
                    >
                      {/* 行首状态图标：录入=箭头（填入语义），审查=✓/✗/⚠ */}
                      {isEntry ? (
                        <MoveRight className="h-3 w-3 shrink-0 text-indigo-500" />
                      ) : isMatch ? (
                        <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
                      ) : isMismatch ? (
                        <XCircle className="h-3 w-3 shrink-0 text-rose-500" />
                      ) : (
                        <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
                      )}
                      <span
                        className="shrink-0 font-medium text-slate-700"
                        title={row.leftLabel === row.rightLabel ? row.leftLabel : `${row.leftLabel} → ${row.rightLabel}`}
                      >
                        {row.leftLabel}
                      </span>
                      <span className="flex min-w-0 flex-1 items-center gap-1 font-mono text-[10px]">
                        <span
                          className="truncate rounded bg-indigo-50/80 px-1 py-0.5 text-indigo-700"
                          title={row.leftValue}
                        >
                          {row.leftValue || "—"}
                        </span>
                        <MoveRight className="h-3 w-3 shrink-0 text-slate-400" />
                        <span
                          className={[
                            "truncate rounded px-1 py-0.5",
                            isEntry
                              ? "bg-sky-50/80 text-sky-700"
                              : isMatch
                              ? "bg-emerald-50/80 text-emerald-700"
                              : isMismatch
                              ? "bg-rose-100/80 font-semibold text-rose-700"
                              : "bg-amber-100/80 text-amber-700",
                          ].join(" ")}
                          title={row.rightValue}
                        >
                          {row.rightValue || "—"}
                        </span>
                      </span>
                      {/* 两阶段修正：扳手=左对右错 / 圈勾=右对左错，点标记后等底部「确认」统一执行；互斥，已应用则显示"已修正" */}
                      {canFixRow(row) && r.record_id && (
                        <span className="flex shrink-0 items-center gap-1">
                          {fixedKeys.has(row.key) ? (
                            <span className="inline-flex items-center gap-0.5 rounded bg-emerald-100/80 px-1 py-0.5 text-[9px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                              <CheckCircle2 className="h-2.5 w-2.5" />
                              已修正
                            </span>
                          ) : fixStageKeys.has(row.key) ? (
                            <button
                              onClick={() => stageMarkFix(row.key)}
                              disabled={running || confirmingRecordId !== null}
                              className="inline-flex items-center gap-0.5 rounded bg-indigo-100 px-1 py-0.5 text-[9px] font-medium text-indigo-700 ring-1 ring-indigo-300 transition-colors hover:bg-indigo-200 disabled:opacity-50"
                              title="左值对、右值错：点「确认」时以左值写回右侧（点击取消标记）"
                            >
                              <Wrench className="h-2.5 w-2.5" />
                              <span className="text-indigo-500">待</span>
                            </button>
                          ) : confirmStageKeys.has(row.key) ? (
                            <button
                              onClick={() => stageMarkConfirm(row.key)}
                              disabled={running || confirmingRecordId !== null}
                              className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-700 ring-1 ring-amber-300 transition-colors hover:bg-amber-200 disabled:opacity-50"
                              title="右值对、左值错（接受右侧）：点「确认」时以右侧为准、不写值（点击取消标记）"
                            >
                              <CheckCircle2 className="h-2.5 w-2.5" />
                              <span className="text-amber-500">待</span>
                            </button>
                          ) : (
                            <span className="inline-flex items-center gap-0.5">
                              <button
                                onClick={() => stageMarkFix(row.key)}
                                disabled={running || confirmingRecordId !== null}
                                className="inline-flex items-center gap-0.5 rounded bg-white px-1 py-0.5 text-[9px] font-medium text-slate-600 ring-1 ring-slate-300 transition-colors hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                                title="标记：左值对、右值错（下一步点底部「确认」统一执行）"
                              >
                                <Wrench className="h-2.5 w-2.5" />
                              </button>
                              <button
                                onClick={() => stageMarkConfirm(row.key)}
                                disabled={running || confirmingRecordId !== null}
                                className="inline-flex items-center rounded p-0.5 text-slate-300 transition-colors hover:text-emerald-600 disabled:opacity-50"
                                title="标记：右值对、左值错（接受右侧值，不写值）"
                              >
                                <Circle className="h-3 w-3" />
                              </button>
                            </span>
                          )}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>

              {/* 底部统计条（紧凑单行：统计 + 修正全部并重新审查） */}
              <div className={`mt-1.5 flex items-center justify-between gap-2 border-t border-slate-200/60 px-1 pt-1.5 text-[10px] font-medium ${accent.footer}`}>
                <span>
                  {mc}/{rows.length} 项{isEntry ? "已填入" : "一致"}{mmc === 0 ? (isEntry ? " · 全部完成" : " · 全部一致") : (isEntry ? ` · ${mmc} 项待处理` : ` · ${mmc} 处不一致`)}{stagedCount > 0 ? ` · ${stagedCount} 项待确认` : ""}
                </span>
                <span className="inline-flex shrink-0 items-center gap-1">
                  {/* 主按钮：确认后执行全部待标记项（左对写回 / 右对改match），完成后字段变绿、卡片变绿 */}
                  {stagedCount > 0 && onConfirmFixes && r.record_id && (
                    <button
                      onClick={handleConfirm}
                      disabled={running || confirmingRecordId !== null || fixRerunRecordId !== null}
                      className="inline-flex items-center gap-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[9px] font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                      title="确认：左对项以左值写回右侧，右对项以右侧为准（不写值），全部执行后字段变绿"
                    >
                      {confirmingRecordId === r.record_id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <CheckCircle2 className="h-2.5 w-2.5" />}
                      确认（{stagedCount}）
                    </button>
                  )}
                  {/* 次级：一键修正全部不一致字段并重新审查该卡片（面向需要完整重跑的场景） */}
                  {fixableRows.length > 0 && onFixAllAndRerun && r.record_id && (
                    <button
                      onClick={() => onFixAllAndRerun(r.record_id!, r.entries)}
                      disabled={running || fixingFieldKey !== null || fixRerunRecordId !== null}
                      className="inline-flex items-center gap-1 rounded bg-white px-1.5 py-0.5 text-[9px] font-medium text-slate-500 ring-1 ring-slate-200 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                      title="把全部不一致字段以来源值覆盖被审查字段，然后重新审查该卡片"
                    >
                      {isFixRerunning ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Wrench className="h-2.5 w-2.5" />}
                      {isFixRerunning ? "重审中…" : `修正重审（${fixableRows.length}）`}
                    </button>
                  )}
                </span>
              </div>
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
  // 执行状态徽标（执行中/✓通过/✗失败/◐运行中）：渲染在「字段对比」标题行内
  let headerBadges: React.ReactNode = null;

  // 运行中或刚结束（有实时记录但还没有最终报告）：显示逐人可视化卡片
  // 注意用 execRunning（批量/队列执行）判断：「查看」定位卡片只是 singleRunning，不应把报告区切走
  if (liveRecords.length > 0 && (!hasReports || (execRunning ?? running))) {
    const passCount = liveRecords.filter((r) => r.status === "success").length;
    const failCount = liveRecords.filter((r) => r.status === "failed").length;
    const runCount = liveRecords.filter((r) => r.status === "running").length;
    headerBadges = (
      <>
        <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-[10px] font-medium text-white">
          {running ? "执行中" : "执行完成"}
        </span>
        {/* 跑完≠通过：天蓝只代表执行完毕，字段对没对要看卡片明细（绿色留给最终报告"通过"） */}
        {passCount > 0 && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-700">完成 {passCount}</span>}
        {failCount > 0 && <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-700">✗ {failCount}</span>}
        {runCount > 0 && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-600">
          <Loader2 className="mr-0.5 inline h-2.5 w-2.5 animate-spin" />{runCount}
        </span>}
      </>
    );
    fieldContent = <div className="space-y-1.5">{liveRecords.map((r, i) => <LiveRecordCard key={`${r.index}-${i}`} rec={r} />)}</div>;
  } else if (hasReports) {
    const passCount = reports.filter((r) => r.overall === "pass").length;
    const failCount = reports.filter((r) => r.overall === "fail").length;
    const reviewCount = reports.filter((r) => r.overall === "review").length;
    const filtered = filter === "all" ? reports : reports.filter((r) => r.overall === filter);

    // 紧凑版筛选 chip：渲染在「字段对比」标题行内（与运行中徽标同一行，跑完不掉下来）
    // 数量内嵌为「N/总数」，不再单独占一个「共N人」chip；点击已激活 chip 取消筛选回到全部
    const FilterChip = ({ target, label, activeBg, inactiveBg, activeText, inactiveText, activeRing }: { target: typeof filter; label: string; activeBg: string; inactiveBg: string; activeText: string; inactiveText: string; activeRing: string }) => (
      <button onClick={() => setFilter(filter === target ? "all" : target)} className={["shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-all", filter === target ? `${activeBg} ${activeText} ring-2 ${activeRing} shadow-sm` : `${inactiveBg} ${inactiveText} ring-1 ring-transparent hover:ring-slate-300`].join(" ")}>
        {label}
      </button>
    );

    headerBadges = (
      <>
        {(passCount > 0 || filter === "pass") && <FilterChip target="pass" label={`${passCount}/${reports.length} 通过`} activeBg="bg-emerald-500" inactiveBg="bg-emerald-100" activeText="text-white" inactiveText="text-emerald-700" activeRing="ring-emerald-300" />}
        {(reviewCount > 0 || filter === "review") && <FilterChip target="review" label={`${reviewCount}/${reports.length} 问题`} activeBg="bg-amber-500" inactiveBg="bg-amber-100" activeText="text-white" inactiveText="text-amber-700" activeRing="ring-amber-300" />}
        {(failCount > 0 || filter === "fail") && <FilterChip target="fail" label={`${failCount}/${reports.length} 需检查`} activeBg="bg-rose-500" inactiveBg="bg-rose-100" activeText="text-white" inactiveText="text-rose-700" activeRing="ring-rose-300" />}
      </>
    );
    fieldContent = <div className="space-y-1.5">{filtered.map((r) => <PersonReportCard key={r.task_id || r.record_id} r={r} />)}</div>;
  } else if (showSample) {
    const passCount = sampleReports.filter((r) => r.overall === "pass").length;
    const failCount = sampleReports.filter((r) => r.overall === "fail").length;
    const filtered = filter === "all" ? sampleReports : sampleReports.filter((r) => r.overall === filter);

    const FilterChip = ({ target, label, activeBg, inactiveBg, activeText, inactiveText, activeRing }: { target: typeof filter; label: string; activeBg: string; inactiveBg: string; activeText: string; inactiveText: string; activeRing: string }) => (
      <button onClick={() => setFilter(filter === target ? "all" : target)} className={["rounded-full px-2.5 py-1 text-[11px] font-medium transition-all", filter === target ? `${activeBg} ${activeText} ring-2 ${activeRing} shadow-sm` : `${inactiveBg} ${inactiveText} ring-1 ring-transparent hover:ring-slate-300`].join(" ")}>
        {label}
      </button>
    );

    summaryBar = (
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
        {(passCount > 0 || filter === "pass") && <FilterChip target="pass" label={`${passCount}/${sampleReports.length} 通过`} activeBg="bg-emerald-500" inactiveBg="bg-emerald-100" activeText="text-white" inactiveText="text-emerald-700" activeRing="ring-emerald-300" />}
        {(failCount > 0 || filter === "fail") && <FilterChip target="fail" label={`${failCount}/${sampleReports.length} 需检查`} activeBg="bg-rose-500" inactiveBg="bg-rose-100" activeText="text-white" inactiveText="text-rose-700" activeRing="ring-rose-300" />}
        <button
          onClick={() => { setShowSample(false); setFilter("all"); }}
          className="ml-auto rounded-md bg-slate-100 px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-200"
        >
          关闭
        </button>
      </div>
    );
    fieldContent = <div className="space-y-1.5">{filtered.map((r) => <PersonReportCard key={r.task_id} r={r} />)}</div>;
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
          className="mt-1 flex items-center gap-1 rounded-lg bg-white/70 px-3 py-1.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-100 hover:text-slate-900"
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

  // 切换文件时重置预览旋转、缩放和平移（并退出框选模式）
  useEffect(() => {
    setFilePreviewRotation(0);
    setFilePreviewZoom(1);
    setFilePreviewPan({ x: 0, y: 0 });
    setRegionPickField(null);
    setRegionRect(null);
  }, [docExtract?.file_url, docExtract?.filename]);

  // 预览区滚轮缩放：以鼠标位置为中心（原生监听，passive:false 才能阻止页面滚动）
  useEffect(() => {
    const el = filePreviewBoxRef.current;
    if (!el) return;
    filePreviewZoomRef.current = filePreviewZoom;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const z = filePreviewZoomRef.current;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const nz = Math.min(5, Math.max(0.25, +(z * factor).toFixed(3)));
      if (nz === z) return;
      // 保持鼠标下的图像点不动：pan' = c - (nz/z)·(c - pan)，与旋转角度无关（旋转与标量可交换）
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const ratio = nz / z;
      filePreviewZoomRef.current = nz;
      setFilePreviewPan((p) => ({ x: cx - ratio * (cx - p.x), y: cy - ratio * (cy - p.y) }));
      setFilePreviewZoom(nz);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // 文件处理内容：放置从网页下载的 PDF / JPG / JPEG 文件
  // 点击「+文件提取」→ 点击网页下载按钮 → 文件下载到此处 → 自动旋转到正面 + 裁剪白边 → OCR 提取
  let fileProcessContent: React.ReactNode;
  // LOOP 执行期实时进度：下载完成→预览→OCR 各阶段都显示内容，不再空白等待
  const docLiveActive = running && docLiveStatus
    && (docLiveStatus.phase === "downloading" || docLiveStatus.phase === "preview" || docLiveStatus.phase === "ocr");
  if (docLiveActive) {
    const isOcr = docLiveStatus!.phase === "ocr";
    const engineLabel = ocrEngine === "umi" ? "OCR" : "AI Vision";
    // 预览图仅在与当前处理文件同名时显示，避免短暂展示上一条记录的旧图
    const liveImg = docLivePreview && docLivePreview.filename === docLiveStatus!.filename
      ? docLivePreview.imageUrl : null;
    fileProcessContent = (
      <div className="flex h-full min-h-[100px] flex-col items-center justify-center gap-2 p-2 text-[11px] text-slate-400">
        {liveImg && (
          <div className="max-h-60 min-h-0 overflow-hidden rounded-md border border-slate-200">
            <img src={liveImg} alt={docLiveStatus!.filename || "文件预览"} className="h-full w-full object-contain" />
          </div>
        )}
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
          <span className="max-w-[180px] truncate text-slate-500">{docLiveStatus!.filename || "下载的文件"}</span>
        </div>
        <div>{isOcr ? `${engineLabel} 识别提取中…` : "文件已下载，生成预览…"}</div>
      </div>
    );
  } else if (docExtracting) {
    const engineLabel = ocrEngine === "umi" ? "OCR" : "AI Vision";
    fileProcessContent = (
      <div className="flex h-full min-h-[100px] flex-col items-center justify-center gap-2 text-[11px] text-slate-400">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
        <div>正在使用 {engineLabel} 识别…</div>
        <div className="text-[10px] text-slate-400">自动旋转到正面 · 裁剪白边 · {engineLabel}</div>
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
          <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-medium text-violet-700">AI Vision</span>
        </div>
        {/* 预处理后的图片占位（DEMO 用彩色块示意） */}
        <div className="mb-2">
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
    const isImageFile = /\.(png|jpe?g|webp|gif|bmp|tiff?)(\?|#|$)/i.test(fileUrl)
      || (!!docExtract?.method && docExtract.method !== "markitdown" && docExtract.method !== "pdf_ocr" && docExtract.method !== "pdf_umi_ocr");
    const isPdfFile = /\.pdf(\?|#|$)/i.test(fileUrl) || docExtract?.method === "pdf_ocr" || docExtract?.method === "pdf_umi_ocr" || (!isImageFile && docExtract?.method === "markitdown");

    // 文件预览区：优先显示预处理后的图片（写入 state 时已转 blob URL；裸 base64 为旧路径兼容），其次显示原始图片 URL，PDF 显示图标占位
    let filePreview: React.ReactNode = null;
    const previewImgSrc = docExtract?.processed_image
      ? (/^(blob:|data:|https?:)/.test(docExtract.processed_image) ? docExtract.processed_image : `data:image/jpeg;base64,${docExtract.processed_image}`)
      : (isImageFile && fileUrl) ? fileUrl : null;
    if (docExtract) {
      if (previewImgSrc) {
        // 图片预览（预处理后或原始图片）：支持旋转和缩放
        const isRotated = filePreviewRotation === 90 || filePreviewRotation === 270;
        filePreview = (
          <div className="mb-2 flex min-h-[300px] flex-1 flex-col">
            <div className="mb-1 flex items-center gap-0.5 self-end rounded bg-slate-100/80 p-0.5">
              <button
                onClick={() => setFilePreviewRotation((r) => (r - 90 + 360) % 360)}
                className="rounded p-0.5 text-slate-500 hover:bg-white hover:text-slate-700"
                title="向左旋转 90°"
              >
                <RotateCcw className="h-3 w-3" />
              </button>
              <button
                onClick={() => setFilePreviewRotation((r) => (r + 90) % 360)}
                className="rounded p-0.5 text-slate-500 hover:bg-white hover:text-slate-700"
                title="向右旋转 90°"
              >
                <RotateCw className="h-3 w-3" />
              </button>
              <div className="mx-0.5 h-3 w-px bg-slate-300" />
              <button
                onClick={() => {
                  const nz = Math.max(0.25, +(filePreviewZoom - 0.25).toFixed(2));
                  const ratio = nz / filePreviewZoom;
                  setFilePreviewPan((p) => ({ x: p.x * ratio, y: p.y * ratio }));
                  setFilePreviewZoom(nz);
                }}
                className="rounded p-0.5 text-slate-500 hover:bg-white hover:text-slate-700"
                title="缩小"
              >
                <ZoomOut className="h-3 w-3" />
              </button>
              <button
                onClick={() => { setFilePreviewZoom(1); setFilePreviewRotation(0); setFilePreviewPan({ x: 0, y: 0 }); }}
                className="rounded px-1 text-[9px] font-medium text-slate-500 hover:bg-white hover:text-slate-700"
                title="重置缩放和旋转"
              >
                {Math.round(filePreviewZoom * 100)}%
              </button>
              <button
                onClick={() => {
                  const nz = Math.min(5, +(filePreviewZoom + 0.25).toFixed(2));
                  const ratio = nz / filePreviewZoom;
                  setFilePreviewPan((p) => ({ x: p.x * ratio, y: p.y * ratio }));
                  setFilePreviewZoom(nz);
                }}
                className="rounded p-0.5 text-slate-500 hover:bg-white hover:text-slate-700"
                title="放大"
              >
                <ZoomIn className="h-3 w-3" />
              </button>
              {onReextractDoc && currentRecordId && (
                <>
                  <div className="mx-0.5 h-3 w-px bg-slate-300" />
                  <button
                    onClick={() => onReextractDoc(currentRecordId, safeDocIdx, filePreviewRotation)}
                    disabled={docReextracting}
                    className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium text-slate-600 hover:bg-white hover:text-slate-800 disabled:opacity-50"
                    title="按当前转正角度重新识别全部字段并重算比对（先把图片旋转到正向再点）"
                  >
                    {docReextracting ? <Loader2 className="h-3 w-3 animate-spin" /> : <ScanSearch className="h-3 w-3" />}
                    提取
                  </button>
                </>
              )}
            </div>
            <div
              ref={filePreviewBoxRef}
              className={[
                "relative min-h-0 flex-1 touch-none select-none overflow-hidden rounded-md border bg-slate-50 p-1",
                regionPickField ? "border-brand-300 cursor-crosshair" : "border-slate-200",
                !regionPickField && (filePreviewDragging ? "cursor-grabbing" : "cursor-grab"),
              ].join(" ")}
              title={regionPickField ? `框选「${FIELD_LABELS[regionPickField] || regionPickField}」所在区域` : "滚轮缩放 · 按住拖拽平移"}
              onPointerDown={(e) => {
                if (regionPickField) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                filePreviewDragRef.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, panX: filePreviewPan.x, panY: filePreviewPan.y };
                setFilePreviewDragging(true);
              }}
              onPointerMove={(e) => {
                if (regionPickField) return;
                const d = filePreviewDragRef.current;
                if (!d || d.id !== e.pointerId) return;
                setFilePreviewPan({ x: d.panX + (e.clientX - d.startX), y: d.panY + (e.clientY - d.startY) });
              }}
              onPointerUp={() => { filePreviewDragRef.current = null; setFilePreviewDragging(false); }}
              onPointerCancel={() => { filePreviewDragRef.current = null; setFilePreviewDragging(false); }}
            >
              <div className="flex h-full min-h-[220px] items-center justify-center">
                <img
                  ref={filePreviewImgRef}
                  src={previewImgSrc}
                  alt={docExtract.filename}
                  draggable={false}
                  className={[
                    "max-w-full rounded object-contain transition-transform duration-150",
                    isRotated ? "max-h-none" : "max-h-full",
                    filePreviewDragging ? "transition-none" : "",
                  ].join(" ")}
                  style={{
                    transform: `translate(${filePreviewPan.x}px, ${filePreviewPan.y}px) rotate(${filePreviewRotation}deg) scale(${filePreviewZoom})`,
                    transformOrigin: "center center",
                  }}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              </div>
              {/* 框选区域识别覆盖层：拖框后按比例换算到显示图坐标（含旋转/缩放/平移），交给上层裁图 OCR */}
              {regionPickField && (
                <div
                  className="absolute inset-0 z-20 cursor-crosshair"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    regionStartRef.current = { x: e.clientX, y: e.clientY };
                    setRegionRect({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY });
                  }}
                  onPointerMove={(e) => {
                    const s = regionStartRef.current;
                    if (!s) return;
                    setRegionRect({ x1: s.x, y1: s.y, x2: e.clientX, y2: e.clientY });
                  }}
                  onPointerUp={(e) => {
                    const s = regionStartRef.current;
                    regionStartRef.current = null;
                    const rr = regionRect;
                    setRegionRect(null);
                    if (!s || !rr || !regionPickField) return;
                    const imgBox = filePreviewImgRef.current?.getBoundingClientRect();
                    if (!imgBox || imgBox.width < 4 || imgBox.height < 4) { setRegionPickField(null); return; }
                    const cx1 = Math.min(rr.x1, rr.x2), cx2 = Math.max(rr.x1, rr.x2);
                    const cy1 = Math.min(rr.y1, rr.y2), cy2 = Math.max(rr.y1, rr.y2);
                    // 显示图（getBoundingClientRect 已含全部 transform）→ 0~1 比例
                    const fx = (cx1 - imgBox.left) / imgBox.width;
                    const fy = (cy1 - imgBox.top) / imgBox.height;
                    const fw = (cx2 - cx1) / imgBox.width;
                    const fh = (cy2 - cy1) / imgBox.height;
                    const field = regionPickField;
                    setRegionPickField(null);
                    // 太小视为误触（<8px），不出识别请求
                    if (cx2 - cx1 < 8 || cy2 - cy1 < 8) return;
                    onRegionOcr?.(currentRecordId, safeDocIdx, field, {
                      x: Math.max(0, Math.min(1, fx)),
                      y: Math.max(0, Math.min(1, fy)),
                      w: Math.max(0.01, Math.min(1, fw)),
                      h: Math.max(0.01, Math.min(1, fh)),
                    }, filePreviewRotation);
                  }}
                  onPointerCancel={() => { regionStartRef.current = null; setRegionRect(null); }}
                >
                  {regionRect && (() => {
                    const box = filePreviewBoxRef.current?.getBoundingClientRect();
                    if (!box) return null;
                    const rx = Math.min(regionRect.x1, regionRect.x2) - box.left;
                    const ry = Math.min(regionRect.y1, regionRect.y2) - box.top;
                    const rw = Math.abs(regionRect.x2 - regionRect.x1);
                    const rh = Math.abs(regionRect.y2 - regionRect.y1);
                    return (
                      <div
                        className="pointer-events-none absolute border-2 border-brand-500 bg-brand-400/15"
                        style={{ left: rx, top: ry, width: rw, height: rh }}
                      />
                    );
                  })()}
                  <div className="pointer-events-none absolute left-1 top-1 rounded bg-slate-900/75 px-1.5 py-0.5 text-[10px] text-white">
                    框选「{FIELD_LABELS[regionPickField] || regionPickField}」区域 · 再点字段框上的框选钮取消
                  </div>
                </div>
              )}
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
      <div className="mb-2">
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50/60 px-2 py-1.5">
          <FileText className="h-3.5 w-3.5 shrink-0 text-slate-500" />
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-slate-700" title={docExtract.source}>
            {docExtract.filename}
          </span>
          <span className={[
            "rounded-full px-1.5 py-0.5 text-[9px] font-medium",
            isVisionMethod(docExtract.method)
              ? "bg-violet-100 text-violet-700"
              : isUmiMethod(docExtract.method)
              ? "bg-emerald-100 text-emerald-700"
              : "bg-sky-100 text-sky-700",
          ].join(" ")}>
            {extractMethodLabel(docExtract.method, docExtract.ocr_backend)}
          </span>
          {docExtract.pending && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[9px] font-medium text-indigo-700">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              识别中
            </span>
          )}
          {docExtract.ai_retry_pending && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-medium text-violet-700" title="高速OCR无有效文字，后台AI转正后重试中（比对轮拿到最终结果）">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              AI转正重试中
            </span>
          )}
        </div>
        {docExtract.fallback && (
          <div className="mt-1 flex items-start gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[9px] leading-relaxed text-amber-800">
            <AlertTriangle className="mt-0.5 h-2.5 w-2.5 shrink-0" />
            <div>
              <span className="font-semibold">{extractMethodLabel(docExtract.fallback.from)}</span>
              {" 失败"}{docExtract.fallback.reason ? `：${docExtract.fallback.reason}` : ""}
              {" → 已自动切换至 "}
              <span className="font-semibold">{extractMethodLabel(docExtract.fallback.to)}</span>
            </div>
          </div>
        )}
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

    // 提取结果（文件字段 + 控件字段 + 全文）：可展开/收起，始终绑定在文件预览下方
    // 字段固定排序（护照字段在前），已提取值与缺失空白框共用同一套顺序
    const FIELD_ORDER = ["name", "passport_no", "nationality", "birth_date", "gender", "passport_issue", "passport_expiry", "issue_authority", "email", "phone"];
    const byFieldOrder = (a: string, b: string) => {
      const ia = FIELD_ORDER.indexOf(a);
      const ib = FIELD_ORDER.indexOf(b);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    };
    const extractFields = docExtract?.fields
      ? Object.entries(docExtract.fields)
          .filter(([, v]) => v && String(v).trim())
          .sort((a, b) => byFieldOrder(a[0], b[0]))
      : [];
    // 请求了但没识别到的字段：也放出来（空白框），方便后期人工手写补录
    // 字段清单 = 本次提取请求回显 ∪ LOOP 配置的提取字段（即便提取请求没带上字段，7 项也照摆空白框）
    const expectedAll = Array.from(new Set([...(docExtract?.requested_fields || []), ...expectedDocFields]));
    const missingFields = expectedAll
      .filter((f) => !String(docExtract?.fields?.[f] || "").trim())
      .sort(byFieldOrder);
    const widgetFields = widgetResultFields.filter((w) => w.value && String(w.value).trim());
    const hasExtractText = !!(docExtract?.text && docExtract.text.trim().length > 0);
    const totalFieldCount = extractFields.length + widgetFields.length;
    const hasExtractResult = docExtract ? (extractFields.length > 0 || hasExtractText || missingFields.length > 0) : widgetFields.length > 0;
    // 字段框上的「框选识别」小按钮：点击后预览图进入框选模式，拖框裁图 OCR 后自动填入该字段
    const regionPickBtn = (field: string) => (onRegionOcr && currentRecordId) ? (
      <button
        onClick={(ev) => { ev.stopPropagation(); setRegionPickField((cur) => (cur === field ? null : field)); }}
        className={[
          "shrink-0 rounded p-0.5 transition-colors",
          regionPickField === field ? "bg-brand-100 text-brand-600" : "text-slate-300 hover:bg-slate-100 hover:text-slate-500",
        ].join(" ")}
        title="在图片上框选该字段区域，识别后自动填入"
      >
        {regionOcrField === field ? <Loader2 className="h-2.5 w-2.5 animate-spin text-brand-500" /> : <Crop className="h-2.5 w-2.5" />}
      </button>
    ) : null;
    const extractResultBlock = hasExtractResult ? (
      <div className="mb-2 rounded-md border border-violet-200 bg-violet-50/30">
        <button
          onClick={() => setShowExtractResult((v) => !v)}
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-semibold text-violet-700 hover:bg-violet-100/50 rounded-t-md"
        >
          <Database className="h-3 w-3 shrink-0" />
          <span>提取结果</span>
          {totalFieldCount > 0 && (
            <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-medium text-violet-600">
              {totalFieldCount} 项
            </span>
          )}
          {missingFields.length > 0 && (
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500" title="请求了但未识别到的字段，点「编辑」可手动补录">
              缺 {missingFields.length} 项
            </span>
          )}
          {widgetFields.length > 0 && (
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-600">
              控件 {widgetFields.length}
            </span>
          )}
          {hasExtractText && (
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500">
              {docExtract.text!.length} 字
            </span>
          )}
          <span
              role="button"
              onClick={(ev) => {
                ev.stopPropagation();
                if (editExtractMode) {
                  // 关闭编辑模式 → 提交更改（含缺失字段的手写补录值）
                  const changes: Record<string, string> = {};
                  for (const f of [...extractFields.map(([k]) => k), ...missingFields]) {
                    const oldVal = String(docExtract?.fields?.[f] ?? "");
                    const newVal = String(editedExtractValues[f] ?? "");
                    if (newVal !== oldVal) changes[f] = newVal;
                  }
                  onEditExtractFields?.(currentRecordId, changes);
                  setEditExtractMode(false);
                  setEditedExtractValues({});
                } else {
                  const initial: Record<string, string> = {};
                  for (const [f, v] of extractFields) initial[f] = String(v);
                  for (const f of missingFields) initial[f] = "";
                  setEditedExtractValues(initial);
                  setEditExtractMode(true);
                }
              }}
              className={[
                "flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium",
                editExtractMode
                  ? "bg-brand-100 text-brand-700 ring-1 ring-brand-200"
                  : "text-slate-400 hover:bg-slate-100 hover:text-slate-600",
              ].join(" ")}
              title={editExtractMode ? "点击关闭编辑并保存" : "点击扳手编辑提取的字段值"}
            >
              <Wrench className="h-2.5 w-2.5" />
              {editExtractMode ? "校正" : "编辑"}
            </span>
          <ChevronDown className={`ml-auto h-3 w-3 shrink-0 transition-transform ${showExtractResult ? "" : "-rotate-90"}`} />
        </button>
        {showExtractResult && (
          <div className="space-y-1.5 border-t border-violet-100 px-2 py-1.5">
            {widgetPassportPickingKey && (
              <div className="flex items-center gap-1 rounded border border-violet-300 bg-violet-50 px-1.5 py-1 text-[9px] text-violet-600">
                <Crosshair className="h-3 w-3 shrink-0 animate-pulse" />
                <span className="flex-1">点击下方字段以绑定到控件</span>
                <button
                  onClick={onCancelPassportPicking}
                  className="rounded px-1 text-violet-400 hover:bg-violet-100 hover:text-violet-600"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
            {(totalFieldCount > 0 || missingFields.length > 0) && (
              <div className="grid grid-cols-2 gap-1.5">
                {extractFields.map(([field, value]) => (
                  <div
                    key={field}
                    onClick={widgetPassportPickingKey ? () => onResolvePassportField?.(field) : undefined}
                    className={[
                      "rounded border bg-white px-1.5 py-1",
                      widgetPassportPickingKey
                        ? "cursor-pointer border-violet-300 ring-1 ring-violet-200 transition-colors hover:border-violet-400 hover:bg-violet-50 hover:ring-violet-300"
                        : editExtractMode ? "border-brand-300 ring-1 ring-brand-100" : "border-slate-200",
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between gap-0.5 text-[9px] font-medium text-slate-400">
                      <span className="truncate">{FIELD_LABELS[field] || field}</span>
                      {regionPickBtn(field)}
                    </div>
                    {editExtractMode ? (
                      <input
                        type="text"
                        value={editedExtractValues[field] ?? String(value)}
                        onChange={(ev) => { updateEditedExtractValue(field, ev.target.value); }}
                        className="min-w-[60px] flex-1 truncate rounded border border-brand-200 bg-white px-1 py-0 text-[11px] font-medium font-mono text-slate-700 outline-none focus:border-brand-400"
                      />
                    ) : (
                      <div className="truncate text-[11px] font-medium text-slate-700" title={String(value)}>{String(value)}</div>
                    )}
                  </div>
                ))}
                {missingFields.map((field) => (
                  <div
                    key={field}
                    className={[
                      "rounded border border-dashed bg-white px-1.5 py-1",
                      editExtractMode ? "border-brand-300 ring-1 ring-brand-100" : "border-slate-300",
                    ].join(" ")}
                    title="未识别到该字段，点「编辑」可手动补录"
                  >
                    <div className="flex items-center justify-between gap-0.5 text-[9px] font-medium text-slate-400">
                      <span className="truncate">{FIELD_LABELS[field] || field}</span>
                      {regionPickBtn(field)}
                    </div>
                    {editExtractMode ? (
                      <input
                        type="text"
                        value={editedExtractValues[field] ?? ""}
                        onChange={(ev) => { updateEditedExtractValue(field, ev.target.value); }}
                        placeholder="手动补录"
                        className="min-w-[60px] flex-1 truncate rounded border border-brand-200 bg-white px-1 py-0 text-[11px] font-medium font-mono text-slate-700 outline-none focus:border-brand-400"
                      />
                    ) : (
                      <div className="min-h-[16px] truncate text-[11px] font-medium text-slate-700" />
                    )}
                  </div>
                ))}
                {widgetFields.map((w) => (
                  <div key={w.key} className="rounded border border-amber-200 bg-amber-50/40 px-1.5 py-1">
                    <div className="flex items-center gap-0.5 text-[9px] font-medium text-amber-600">
                      {w.kind === "calendar" ? <CalendarDays className="h-2.5 w-2.5 shrink-0" /> : <List className="h-2.5 w-2.5 shrink-0" />}
                      <span className="truncate">{w.label}</span>
                    </div>
                    <div className="truncate text-[11px] font-medium text-slate-700" title={w.value}>{w.value}</div>
                  </div>
                ))}
              </div>
            )}
            {hasExtractText && (
              <div className="rounded border border-slate-200 bg-white">
                <button
                  onClick={() => setShowFullText((v) => !v)}
                  className="flex w-full items-center justify-between px-2 py-1 text-left text-[10px] font-medium text-slate-500 hover:bg-slate-50"
                >
                  <span>提取全文（{docExtract.text!.length} 字符）</span>
                  <ChevronDown className={`h-3 w-3 transition-transform ${showFullText ? "" : "-rotate-90"}`} />
                </button>
                {showFullText && (
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all border-t border-slate-100 bg-slate-50/50 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-slate-600">
                    {docExtract.text}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
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
    ) : null;

    fileProcessContent = (
      <div className="flex h-full min-h-0 flex-col">
        {fileInfo}
        {filePreview}
        {(extractResultBlock || compareBlock || shotsBlock) && (
          <div className={`shrink-0 space-y-2 ${filePreview ? "max-h-[45%] overflow-auto" : ""}`}>
            {extractResultBlock}
            {compareBlock}
            {shotsBlock}
          </div>
        )}
        {!fileInfo && !extractResultBlock && !compareBlock && !shotsBlock && (
          <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 text-center text-[11px] text-slate-400">
            <FileText className="h-8 w-8 text-slate-200" />
            <div>点击「+文件提取」后下载的</div>
            <div className="text-[10px] text-slate-400">PDF / JPG / JPEG 文件会放到这里</div>
            <button
              onClick={() => setShowDocSample(true)}
              className="mt-1 flex items-center gap-1 rounded-lg bg-white/70 px-3 py-1.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-100 hover:text-slate-900"
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
  // LOOP 执行期实时进度：OCR 进行中显示等待态，字段一出即切换到字段卡片
  if (docLiveActive) {
    const engineLabel = ocrEngine === "umi" ? "OCR" : "AI Vision";
    extractedContent = (
      <div className="flex h-full min-h-[100px] flex-col items-center justify-center gap-2 text-[11px] text-slate-400">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
        <div>{docLiveStatus!.phase === "ocr" ? `${engineLabel} 识别中，字段即将出现…` : "文件下载完成，等待识别…"}</div>
      </div>
    );
  } else if (docExtracting) {
    const engineLabel = ocrEngine === "umi" ? "OCR" : "AI Vision";
    extractedContent = (
      <div className="flex h-full min-h-[100px] items-center justify-center gap-2 text-[11px] text-slate-400">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
        {engineLabel} 识别中…
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
          className="mt-1 flex items-center gap-1 rounded-lg bg-white/70 px-3 py-1.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-100 hover:text-slate-900"
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
  const isDocExtractFocus = focusPanel === "doc-extract";
  const isFieldDocFocus = focusPanel === "field-doc";
  const isAll = !focusPanel;
  // 控件提取模式：处于控件提取激活态（widgetSetupSignal=widgetExtractMode）时隐藏文件处理面板，
  // 只显示字段对比+提取元素两栏。仅保存过控件（widgetExtractContent 非空）但不在提取模式时，
  // 文件处理面板应正常显示，避免面板开启后变成空白区域
  const isWidgetMode = !!widgetSetupSignal;
  // 提取元素面板显示逻辑：
  // - 非步骤设置模式（结果查看）：始终显示（三栏布局）
  // - 步骤设置模式：按用户手动开关控制（默认隐藏，给步骤卡片更多空间，可手动展开）
  // - 自定义文本/控件提取模式：强制显示
  // - doc-extract 聚焦模式：强制显示（文件处理+提取元素两栏）
  // - field-doc 聚焦模式：隐藏（字段对比+文件处理两栏）
  const isSetupMode = fieldSetupMode || docSetupMode || extractSetupMode;
  const showExtract = isAll
    ? (!isSetupMode || showExtractPanel || !!customTextContent || !!widgetExtractContent || !!docFieldsContent || extractSetupMode)
    : isDocExtractFocus;

  // 文件处理面板在布局中是否实际可见（综合 focus 状态、三栏模式、控件模式、手动展开）
  const filePanelActuallyVisible = isDocFocus || isDocExtractFocus || isFieldDocFocus
    || (isAll && !(isWidgetMode && !isDocExtractFocus && !filePanelVisible));

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
        <div className="mb-0 flex items-center gap-1.5 border-b-2 border-slate-200 pb-1.5 text-[11px] font-bold text-slate-700">
          <MousePointerClick className="h-3.5 w-3.5 text-slate-500" />
          前置设置
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">{preClickMarks.length}</span>
          {fieldSetupMode && onStartBindInputs && !running && (
            <button
              onClick={(e) => { e.stopPropagation(); onStartBindInputs(); }}
              className={[
                "ml-1 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[9px] font-semibold transition-all",
                bindInputActive
                  ? "bg-red-600 text-white shadow-md ring-2 ring-red-300"
                  : "bg-white/70 text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 hover:text-slate-900",
              ].join(" ")}
              title={bindInputActive ? "绑定输入框/点击进行中（再次点击关闭）" : "开始绑定输入框/点击（点输入框自动绑定Excel列并填入第一行值）"}
            >
              {bindInputActive ? (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
                </span>
              ) : (
                <Keyboard className="h-2.5 w-2.5" />
              )}
              {bindInputActive ? "绑定中" : "绑定输入框"}
              {bindStepCount > 0 && (
                <span className={bindInputActive ? "rounded bg-white/30 px-1 text-[8px] leading-tight" : "rounded bg-slate-200 px-1 text-[8px] leading-tight"}>{bindStepCount}</span>
              )}
            </button>
          )}
          {fieldSetupMode && onStartAddPreClick && !running && (
            <button
              onClick={(e) => { e.stopPropagation(); onStartAddPreClick(); }}
              className={[
                "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[9px] font-semibold transition-all",
                preClickActive
                  ? "bg-red-600 text-white shadow-md ring-2 ring-red-300"
                  : "bg-white/70 text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 hover:text-slate-900",
              ].join(" ")}
              title={preClickActive ? "前置点击添加中（再次点击关闭）" : "添加前置点击（搜索按钮、开始按钮等）"}
            >
              {preClickActive ? (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
                </span>
              ) : (
                <Plus className="h-2.5 w-2.5" />
              )}
              {preClickActive ? "前置点击中" : "添加前置点击"}
            </button>
          )}
        </div>
        {preClickMarks.length === 0 ? (
          <div className="flex gap-2 pt-1.5">
            <div className="flex shrink-0 min-w-[120px] max-w-[180px] items-start gap-2 rounded-2xl bg-slate-50/60 px-2.5 py-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-[13px] font-bold text-slate-400">
                ?
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[11px] font-bold text-slate-500">点击</span>
                <span className="line-clamp-2 text-[12px] font-medium leading-tight text-slate-400">点击搜索按钮等…</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="scrollbar-tiny flex gap-2 overflow-x-auto pb-0.5 pt-1.5" onWheel={handleHorizontalWheel}>
            {preClickMarks.map((m) => {
              const isInput = m.action === "input";
              const actionWord = isInput ? (m.workflow === "entry" ? "录入" : "审查") : "点击";
              const displayLabel = (m.label || "").replace(/^输入/, m.workflow === "entry" ? "录入" : "审查");
              return (
                <div
                  key={m.id}
                  onClick={() => onPreviewMark?.(m)}
                  className="group relative flex shrink-0 min-w-[120px] max-w-[180px] cursor-pointer items-start gap-2 rounded-2xl bg-slate-50 px-2.5 py-2 transition-all hover:-translate-y-0.5 hover:bg-slate-100 hover:shadow-sm"
                  title={`${actionWord} · ${displayLabel}（点击在网页定位）`}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-[12px] font-bold text-white shadow-sm">
                    {m.order}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 pr-5">
                    <span className="text-[10px] font-bold text-slate-500">
                      {actionWord}
                    </span>
                    <span className="line-clamp-2 text-[11px] font-medium leading-tight text-slate-700">{displayLabel}</span>
                  </div>
                  {onRemoveMark && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`确定要删除这个${actionWord}步骤吗？`)) {
                          onRemoveMark(m.id);
                        }
                      }}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-6 w-5 items-center justify-center rounded text-rose-400 opacity-0 transition-all hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
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
        <div className="mb-0 flex flex-wrap items-center gap-1.5 border-b-2 border-slate-200 pb-1.5 text-[11px] font-bold text-slate-700">
          <Table2 className="h-3.5 w-3.5 text-slate-500" />
          审查映射
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">{reviewMappings.length}</span>
          {fieldSetupMode && !running && (
            <>
              {onSwitchStepMode && (
                <div className="ml-1 flex shrink-0 items-center gap-0 rounded-md bg-slate-100 p-0.5 ring-1 ring-slate-200">
                  <button
                    onClick={(e) => { e.stopPropagation(); onSwitchStepMode("review"); }}
                    className={[
                      "flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium transition-all",
                      addingStepMode === "review"
                        ? "bg-red-500 text-white shadow-sm animate-pulse"
                        : "text-slate-500 hover:bg-white/60",
                    ].join(" ")}
                    title={addingStepMode === "review" ? "审核模式激活中（再次点击关闭）" : "审核模式：字段用于右侧网页与左侧Excel核对"}
                  >
                    <ArrowLeft className="h-2.5 w-2.5" />
                    审核
                  </button>
                  <div className="h-3.5 w-px bg-slate-300" />
                  <button
                    onClick={(e) => { e.stopPropagation(); onSwitchStepMode("entry"); }}
                    className={[
                      "flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium transition-all",
                      addingStepMode === "entry"
                        ? "bg-red-500 text-white shadow-sm animate-pulse"
                        : "text-slate-500 hover:bg-white/60",
                    ].join(" ")}
                    title={addingStepMode === "entry" ? "录入模式激活中（再次点击关闭）" : "录入模式：字段用于从左侧Excel填入右侧网页"}
                  >
                    <MoveRight className="h-2.5 w-2.5" />
                    录入
                  </button>
                </div>
              )}
              {/* 确定映射：匹配好一对即可确认（未匹配时禁用） */}
              {!running && onConfirmMapping && (
                <button
                  onClick={(e) => { e.stopPropagation(); if (canSaveMapping) onConfirmMapping(); }}
                  disabled={!canSaveMapping}
                  className={[
                    "ml-1 inline-flex items-center gap-1 rounded-md px-2.5 py-0.5 text-[10px] font-bold transition-all",
                    canSaveMapping
                      ? "bg-slate-900 text-white shadow-sm hover:bg-slate-700 active:scale-95 animate-pulse"
                      : "cursor-not-allowed bg-slate-100 text-slate-300",
                  ].join(" ")}
                  title={canSaveMapping ? "确认保存当前映射（快捷键：Enter）" : "请先匹配左侧字段与右侧字段"}
                >
                  <CheckCircle2 className="h-3 w-3" />
                  确定映射
                  <kbd className="ml-0.5 rounded bg-white/25 px-1 py-px text-[8px] font-mono">Enter</kbd>
                </button>
              )}
              {addingStepMode && onExitAddingStepMode && (
                <button
                  onClick={(e) => { e.stopPropagation(); onExitAddingStepMode(); }}
                  className="ml-auto inline-flex items-center gap-0.5 rounded-md bg-slate-900 px-2 py-0.5 text-[9px] font-bold text-white shadow-sm transition-all hover:bg-slate-700 active:scale-95"
                  title="完成步骤设置，退出拾取模式"
                >
                  <CheckCircle2 className="h-2.5 w-2.5" />
                  完成
                </button>
              )}
            </>
          )}
        </div>
        {reviewMappings.length === 0 ? (
          <div className="flex gap-2 pt-1.5">
            <div className="flex shrink-0 min-w-[100px] max-w-[160px] items-start gap-2 rounded-2xl bg-slate-50/60 px-2.5 py-2">
              <div className="flex shrink-0 flex-col items-center gap-1">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-[13px] font-bold text-slate-400">?</span>
                <ArrowLeft className="h-3.5 w-3.5 text-slate-300" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[11px] font-bold text-slate-500">对比</span>
                <div className="truncate py-0.5 text-[11px] font-medium leading-tight text-slate-400">左侧字段</div>
                <div className="truncate py-0.5 text-[12px] font-medium leading-tight text-slate-400">右侧字段</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="scrollbar-tiny flex gap-2 overflow-x-auto pb-0.5 pt-1.5" onWheel={handleHorizontalWheel}>
            {reviewMappings.map((mp, i) => {
              const isEntry = appMode === "entry";
              const webSide = mp.web_side || "right";
              return (
                <div
                  key={i}
                  onClick={() => onPreviewMark?.({ id: `mapping-${i}`, order: i + 1, side: webSide, source: "web", selector: mp.right_selector, label: mp.right_label || mp.right_selector, workflow: "review", createdAt: 0 })}
                  className="group relative flex shrink-0 min-w-[100px] max-w-[160px] cursor-pointer items-start gap-2 rounded-2xl bg-slate-50 px-2.5 py-2 transition-all hover:-translate-y-0.5 hover:bg-slate-100 hover:shadow-sm"
                  title={`${mp.left_field || "—"} ${isEntry ? "→" : "←"} ${mp.right_label || mp.right_selector}（${webSide === "left" ? "左" : "右"}侧网页，点击定位）`}
                >
                  <div className="flex shrink-0 flex-col items-center gap-1">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-900 text-[12px] font-bold text-white shadow-sm">
                      {i + 1}
                    </span>
                    {isEntry ? (
                      <MoveRight className="h-3 w-3 text-slate-400" />
                    ) : (
                      <ArrowLeft className="h-3 w-3 text-slate-400" />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col pr-5">
                    <span className="text-[10px] font-bold text-slate-500">
                      {isEntry ? "填入" : "对比"}
                      {webSide === "left" && (
                        <span className="ml-1 rounded bg-slate-200/80 px-1 py-px text-[8px] font-semibold text-slate-500">左网页</span>
                      )}
                    </span>
                    <div className="truncate py-0.5 text-[10px] font-medium leading-tight text-slate-500">{mp.left_field || "—"}</div>
                    <div className="line-clamp-2 text-[11px] font-medium leading-tight text-slate-700">{mp.right_label || mp.right_selector}</div>
                  </div>
                  {onRemoveMapping && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm("确定要删除这个映射吗？")) {
                          onRemoveMapping(i);
                        }
                      }}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-6 w-5 items-center justify-center rounded text-rose-400 opacity-0 transition-all hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
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

      {/* 过程点击分组 —— 点击NEXT等中间步骤，位于审查映射与收尾点击之间 */}
      <div className="shrink-0">
        <div className="mb-0 flex items-center gap-1.5 border-b-2 border-slate-200 pb-1.5 text-[11px] font-bold text-slate-700">
          <MousePointerClick className="h-3.5 w-3.5 text-slate-500" />
          过程点击
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">{processClickMarks.length}</span>
          {fieldSetupMode && onStartAddProcessClick && !running && (
            <button
              onClick={(e) => { e.stopPropagation(); onStartAddProcessClick(); }}
              className={[
                "ml-1 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[9px] font-semibold transition-all",
                processClickActive
                  ? "bg-red-600 text-white shadow-md ring-2 ring-red-300"
                  : "bg-white/70 text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 hover:text-slate-900",
              ].join(" ")}
              title={processClickActive ? "过程点击添加中（再次点击关闭）" : "添加过程点击（NEXT、下一步等中间步骤）"}
            >
              {processClickActive ? (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
                </span>
              ) : (
                <Plus className="h-2.5 w-2.5" />
              )}
              {processClickActive ? "过程点击中" : "添加过程点击"}
            </button>
          )}
        </div>
        {processClickMarks.length === 0 ? (
          <div className="flex gap-2 pt-1.5">
            <div className="flex shrink-0 min-w-[120px] max-w-[180px] items-start gap-2 rounded-2xl bg-slate-50/60 px-2.5 py-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-[13px] font-bold text-slate-400">?</span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[11px] font-bold text-slate-500">点击</span>
                <span className="line-clamp-2 text-[12px] font-medium leading-tight text-slate-400">点击 NEXT 等中间步骤…</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="scrollbar-tiny flex gap-2 overflow-x-auto pb-0.5 pt-1.5" onWheel={handleHorizontalWheel}>
            {processClickMarks.map((m) => (
              <div
                key={m.id}
                onClick={() => onPreviewMark?.(m)}
                className="group relative flex shrink-0 min-w-[120px] max-w-[180px] cursor-pointer items-start gap-2 rounded-2xl bg-slate-50 px-2.5 py-2 transition-all hover:-translate-y-0.5 hover:bg-slate-100 hover:shadow-sm"
                title={`点击 · ${m.label}（点击在网页定位）`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-[12px] font-bold text-white shadow-sm">{m.order}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 pr-5">
                  <span className="text-[10px] font-bold text-slate-500">点击</span>
                  <span className="line-clamp-2 text-[11px] font-medium leading-tight text-slate-700">{m.label}</span>
                </div>
                {onRemoveMark && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm("确定要删除这个过程点击吗？")) {
                        onRemoveMark(m.id);
                      }
                    }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-6 w-5 items-center justify-center rounded text-rose-400 opacity-0 transition-all hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
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

      {/* 提取元素分组 —— 文件提取/自定义文本/控件小卡片，按设置先后 FIFO 排列（全局观察） */}
      <div className="shrink-0">
        <div className="mb-0 flex flex-wrap items-center gap-1.5 border-b-2 border-slate-200 pb-1.5 text-[11px] font-bold text-slate-700">
          <Eye className="h-3.5 w-3.5 text-slate-500" />
          提取元素
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">{extractStepSummary.length}</span>
          {fieldSetupMode && !running && extractStepSummary.length > 0 && (
            <span className="ml-1 text-[9px] font-normal text-slate-400">点击卡片可定位预览</span>
          )}
        </div>
        {extractStepSummary.length === 0 ? (
          <div className="flex gap-2 pt-1.5">
            <div className="flex shrink-0 min-w-[120px] max-w-[180px] items-start gap-2 rounded-2xl bg-slate-50/60 px-2.5 py-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-[13px] font-bold text-slate-400">?</span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[11px] font-bold text-slate-500">提取</span>
                <span className="line-clamp-2 text-[12px] font-medium leading-tight text-slate-400">文件提取/自定义文本/控件…</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="scrollbar-tiny flex gap-2 overflow-x-auto pb-0.5 pt-1.5" onWheel={handleHorizontalWheel}>
            {extractStepSummary.map((item, idx) => {
              let typeLabel = "提取";
              if (item.kind === "doc") {
                typeLabel = "文件";
              } else if (item.kind === "custom") {
                typeLabel = "文本";
              } else if (item.kind === "widget") {
                if (item.name.includes("日历")) {
                  typeLabel = "日历";
                } else if (item.name.includes("选项")) {
                  typeLabel = "选项";
                } else {
                  typeLabel = "控件";
                }
              }
              return (
                <div
                  key={item.id}
                  onClick={() => {
                    if (item.selector) {
                      onPreviewMark?.({
                        id: item.id,
                        order: idx + 1,
                        side: item.side || "right",
                        source: "web",
                        selector: item.selector,
                        label: item.detail,
                        workflow: "review",
                        createdAt: 0,
                      });
                    }
                  }}
                  className={[
                    "group relative flex shrink-0 min-w-[120px] max-w-[180px] items-start gap-2 rounded-2xl bg-slate-50 px-2.5 py-2 transition-all",
                    item.selector ? "cursor-pointer hover:-translate-y-0.5 hover:bg-slate-100 hover:shadow-sm" : "",
                  ].join(" ")}
                  title={`${item.name} · ${item.detail}${item.selector ? "（点击在网页定位）" : ""}`}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-[12px] font-bold text-white shadow-sm">
                    {idx + 1}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 pr-5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-slate-500">{typeLabel}</span>
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          item.saved ? "bg-emerald-400" : "bg-amber-400"
                        }`}
                      />
                    </div>
                    <span className="line-clamp-2 text-[11px] font-medium leading-tight text-slate-700">{item.detail}</span>
                  </div>
                  {onRemoveExtractStep && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`确定要删除这个${typeLabel}步骤吗？`)) {
                          onRemoveExtractStep(item.id, item.kind);
                        }
                      }}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-6 w-5 items-center justify-center rounded text-rose-400 opacity-0 transition-all hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
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

      {/* 收尾点击分组 —— 小卡片从左到右排列 */}
      <div className="shrink-0">
        <div className="mb-0 flex items-center gap-1.5 border-b-2 border-slate-200 pb-1.5 text-[11px] font-bold text-slate-700">
          <MousePointerClick className="h-3.5 w-3.5 text-slate-500" />
          收尾点击
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">{postClickMarks.length}</span>
          {fieldSetupMode && onStartAddPostClick && !running && (
            <button
              onClick={(e) => { e.stopPropagation(); onStartAddPostClick(); }}
              className={[
                "ml-1 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[9px] font-semibold transition-all",
                postClickActive
                  ? "bg-red-600 text-white shadow-md ring-2 ring-red-300"
                  : "bg-white/70 text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 hover:text-slate-900",
              ].join(" ")}
              title={postClickActive ? "收尾点击添加中（再次点击关闭）" : "添加收尾点击（提交按钮等）"}
            >
              {postClickActive ? (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
                </span>
              ) : (
                <Plus className="h-2.5 w-2.5" />
              )}
              {postClickActive ? "收尾点击中" : "添加收尾点击"}
            </button>
          )}
        </div>
        {postClickMarks.length === 0 ? (
          <div className="flex gap-2 pt-1.5">
            <div className="flex shrink-0 min-w-[120px] max-w-[180px] items-start gap-2 rounded-2xl bg-slate-50/60 px-2.5 py-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-[13px] font-bold text-slate-400">?</span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[11px] font-bold text-slate-500">点击</span>
                <span className="line-clamp-2 text-[12px] font-medium leading-tight text-slate-400">点击提交按钮等…</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="scrollbar-tiny flex gap-2 overflow-x-auto pb-0.5 pt-1.5" onWheel={handleHorizontalWheel}>
            {postClickMarks.map((m) => (
              <div
                key={m.id}
                onClick={() => onPreviewMark?.(m)}
                className="group relative flex shrink-0 min-w-[120px] max-w-[180px] cursor-pointer items-start gap-2 rounded-2xl bg-slate-50 px-2.5 py-2 transition-all hover:-translate-y-0.5 hover:bg-slate-100 hover:shadow-sm"
                title={`点击 · ${m.label}（点击在网页定位）`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-[12px] font-bold text-white shadow-sm">{m.order}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 pr-5">
                  <span className="text-[10px] font-bold text-slate-500">点击</span>
                  <span className="line-clamp-2 text-[11px] font-medium leading-tight text-slate-700">{m.label}</span>
                </div>
                {onRemoveMark && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm("确定要删除这个点击步骤吗？")) {
                        onRemoveMark(m.id);
                      }
                    }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-6 w-5 items-center justify-center rounded text-rose-400 opacity-0 transition-all hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
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
        {/* 字段对比卡片 —— 最左侧，向右展开/向左回收 */}
        <div
          onClick={() => onFieldPanelActive?.()}
          onFocusCapture={() => onFieldPanelActive?.()}
          className={[
            "flex min-w-0 max-h-[55vh] flex-col overflow-hidden bg-white lg:h-full lg:max-h-none",
            dragging ? "" : "transition-[flex-basis,opacity,max-width,flex-grow] duration-300 ease-out",
            isFieldFocus ? "flex-1" : (isAll || isFieldDocFocus) ? "" : "lg:border-0 lg:px-0 lg:mx-0",
          ].join(" ")}
          style={{
            flexBasis: isFieldFocus ? undefined : (isAll || isFieldDocFocus) ? `${leftWidth}%` : "0%",
            flexShrink: 0,
            flexGrow: isFieldFocus ? 1 : 0,
            opacity: (isDocFocus || isDocExtractFocus) ? 0 : 1,
            maxWidth: isDocExtractFocus ? 0 : undefined,
            pointerEvents: isDocExtractFocus ? "none" : undefined,
            willChange: "opacity, max-width",
            contain: "layout style",
          }}
        >
          <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700">
            <Table2 className="h-3.5 w-3.5 text-slate-500 shrink-0" />
            <span className="shrink-0">字段对比</span>
            {!fieldSetupMode && headerBadges && (
              <span className="ml-1 flex shrink-0 items-center gap-1">{headerBadges}</span>
            )}
            {onSaveToBatch && fieldSetupMode && (
              <button
                onClick={() => { if (!running) onSaveToBatch?.(); }}
                disabled={running}
                className={[
                  "ml-1 flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold transition-all",
                  running
                    ? "cursor-not-allowed bg-slate-200 text-slate-400"
                    : hasCheckedBatch
                    ? "bg-slate-900 text-white hover:bg-slate-700 shadow-sm"
                    : "bg-white/70 text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 hover:text-slate-900",
                ].join(" ")}
                title={running ? "运行中…" : hasCheckedBatch ? "保存当前步骤配置到这批勾选的卡片" : "请先在左侧勾选一批卡片（点第一张定起点，点第二张定范围）"}
              >
                <CheckCircle2 className="h-2.5 w-2.5" />
                设置卡片流
              </button>
            )}
            {onRequestApplyLoop && fieldSetupMode && (
              <button
                onClick={() => { if (!running) onRequestApplyLoop?.(); }}
                disabled={running}
                className={[
                  "ml-auto flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold transition-all",
                  running
                    ? "cursor-not-allowed bg-slate-200 text-slate-400"
                    : "bg-white/70 text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 hover:text-slate-900 shadow-sm",
                ].join(" ")}
                title="应用已保存的 LOOP 模板，加载其所有步骤"
              >
                <Layers className="h-2.5 w-2.5" />
                应用LOOP
              </button>
            )}
            {onRequestSaveLoop && fieldSetupMode && (
              <button
                onClick={() => { if (!running) onRequestSaveLoop?.(); }}
                disabled={running || !canSaveLoop}
                className={[
                  onRequestApplyLoop ? "ml-1" : "ml-auto",
                  "flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold transition-all",
                  (running || !canSaveLoop)
                    ? "cursor-not-allowed bg-slate-200 text-slate-400"
                    : "bg-white/70 text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 hover:text-slate-900 shadow-sm",
                ].join(" ")}
                title="命名保存为 LOOP 模板"
              >
                <Save className="h-2.5 w-2.5" />
                保存为LOOP
              </button>
            )}
            {onDirectRun && fieldSetupMode && (
              <button
                onClick={() => { if (!running) onDirectRun?.(); }}
                disabled={running || !canSaveLoop}
                className={[
                  "ml-1 flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold transition-all",
                  (running || !canSaveLoop)
                    ? "cursor-not-allowed bg-slate-200 text-slate-400"
                    : "bg-slate-900 text-white hover:bg-slate-700 shadow-sm",
                ].join(" ")}
                title="直接执行当前配置（临时运行，不保存）"
              >
                <Play className="h-2.5 w-2.5" />
                执行
              </button>
            )}
            {onExportExcel && !fieldSetupMode && (
              <button
                onClick={(e) => { e.stopPropagation(); if (!exportingExcel) onExportExcel(); }}
                disabled={exportingExcel}
                className="ml-auto flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold text-slate-600 ring-1 ring-slate-300 transition-all hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
                title="把修正后的数据导出为 Excel（本地文件原地写回，否则下载副本）"
              >
                {exportingExcel ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                导出Excel
              </button>
            )}
            <button
              onClick={() => setFieldSetupMode((v) => !v)}
              className={[
                "flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium transition-colors",
                fieldSetupMode ? "ml-1" : onExportExcel ? "ml-0" : "ml-auto",
                fieldSetupMode
                  ? "bg-slate-200 text-slate-700"
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

        {/* 左/中 拖拽分隔条 —— 聚焦模式或控件提取模式下隐藏（文件面板可见时仍显示） */}
        <div
          className={[
            "group relative hidden shrink-0 cursor-col-resize items-center justify-center lg:flex",
            "transition-opacity duration-200",
            ((isAll && (!isWidgetMode || filePanelVisible)) || isFieldDocFocus) ? "opacity-100" : "opacity-0 lg:w-0 lg:px-0",
          ].join(" ")}
          style={{ width: ((isAll && (!isWidgetMode || filePanelVisible)) || isFieldDocFocus) ? 6 : 0 }}
          onMouseDown={onMouseDown("left")}
        >
          <div className="panel-divider h-full w-px" />
          <div className="absolute h-8 w-1 rounded-full bg-slate-400 opacity-0 transition-opacity group-hover:opacity-100" />
        </div>

        {/* 控件模式下文件面板收起时的展开按钮 */}
        {isWidgetMode && !isDocExtractFocus && !filePanelVisible && (
          <button
            onClick={() => setFilePanelManuallyOpen(true)}
            className="group relative z-20 flex shrink-0 cursor-pointer items-center justify-center lg:flex"
            style={{ width: 10 }}
            title="展开文件处理面板"
          >
            <div className="h-full w-px bg-slate-200 transition-colors group-hover:bg-slate-400" />
            <div className="absolute flex h-10 w-4 items-center justify-center rounded-r bg-slate-100 text-slate-500 opacity-60 shadow-sm ring-1 ring-slate-200 transition-all group-hover:opacity-100">
              <ChevronRight className="h-3 w-3" />
            </div>
          </button>
        )}

        {/* 文件处理卡片 —— 2面板时在右半向左展开/向右回收；3面板时在中间左右展开/向中心回收；控件提取模式下隐藏（手动展开或doc-extract分屏中除外） */}
        <div
          className={[
            "relative flex min-w-0 max-h-[55vh] flex-col overflow-hidden bg-white lg:h-full lg:max-h-none",
            dragging ? "" : "transition-[flex-basis,opacity,max-width] duration-300 ease-out",
            (isDocFocus || isDocExtractFocus || isFieldDocFocus) ? "flex-1" : (isAll && !(isWidgetMode && !isDocExtractFocus && !filePanelVisible)) ? "" : "lg:border-0 lg:px-0 lg:mx-0",
          ].join(" ")}
          style={{
            flexBasis: isFieldFocus || (isWidgetMode && !isDocExtractFocus && !filePanelVisible)
              ? "0%"
              : isDocFocus
                ? undefined
                : isDocExtractFocus
                  ? "50%"
                  : isFieldDocFocus
                    ? undefined
                    : isAll
                      ? (showExtract ? `${midWidth}%` : undefined)
                      : "0%",
            flexShrink: 0,
            flexGrow: (isDocFocus || isDocExtractFocus || isFieldDocFocus || (isAll && !(isWidgetMode && !isDocExtractFocus && !filePanelVisible) && !showExtract)) ? 1 : 0,
            opacity: (isWidgetMode && !isDocExtractFocus && !filePanelVisible) ? 0 : 1,
            maxWidth: (isWidgetMode && !isDocExtractFocus && !filePanelVisible) ? 0 : undefined,
            pointerEvents: (isWidgetMode && !isDocExtractFocus && !filePanelVisible) ? "none" : undefined,
            willChange: "opacity, max-width",
            contain: "layout style",
          }}
        >
          {docLocalConfigContent && !docConfigChooseMode ? (
            /* 配置模式（web/local）：直接渲染配置内容（组件自带标题条和底部按钮） */
            <div className="flex min-h-0 flex-1 min-w-[200px] flex-col overflow-hidden">{docLocalConfigContent}</div>
          ) : (
            <>
              {/* 文件处理标题栏：choose 模式和普通模式共用 */}
              <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700">
                <FileText className="h-3.5 w-3.5 text-slate-500" />
                文件处理
                {docExtracts.length > 0 && (
                  <span className="rounded-full bg-slate-200/70 px-1.5 py-0.5 text-[9px] font-medium text-slate-600">
                    {docExtracts.length} 个文件
                  </span>
                )}
                {/* OCR 识别引擎切换：识图AI（Vision LLM） ↔ 本地 OCR（内置加速引擎/UMI） */}
                {onChangeOcrEngine && (
                  <div className="ml-1 flex shrink-0 items-center gap-1">
                    <div
                      className="flex items-center gap-0 rounded-md bg-slate-100/80 p-0.5 ring-1 ring-slate-200"
                      title="护照/图片识别引擎：识图AI（在线Vision）或本地 OCR（核显加速开=内置加速引擎，关=UMI-OCR）"
                    >
                      {([["vision", "识图AI"], ["umi", "OCR"]] as const).map(([val, label]) => (
                        <button
                          key={val}
                          onClick={(e) => { e.stopPropagation(); if (ocrEngine !== val) handleOcrEngineSwitch(val); }}
                          className={[
                            "flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-semibold transition-all",
                            ocrEngine === val
                              ? "bg-slate-900 text-white shadow-sm"
                              : "text-slate-500 hover:bg-white/70 hover:text-slate-700",
                          ].join(" ")}
                        >
                          {val === "vision" ? <Eye className="h-2.5 w-2.5" /> : <ScanLine className="h-2.5 w-2.5" />}
                          {label}
                        </button>
                      ))}
                    </div>
                    {/* UMI 状态指示灯（核显加速开启时内置引擎不依赖 UMI，不显示） */}
                    {ocrEngine === "umi" && !igpuAcceleration && umiStatus !== "idle" && (
                      umiStatus === "unavailable" ? (
                        <span className="flex items-center gap-0.5">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleLaunchUmi(); }}
                            disabled={umiLaunching}
                            className="flex items-center gap-0.5 rounded bg-rose-600 px-1 py-0.5 text-[8px] font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
                            title={(umiExePath ? "路径：" + umiExePath + "\n" : "") + umiStatusMsg + "（点击一键启动；若无效可点文件夹图标手动打开 Umi-OCR.exe）"}
                          >
                            {umiLaunching ? <Loader2 className="h-2 w-2 animate-spin" /> : <Play className="h-2 w-2" />}
                            {umiLaunching ? "启动中" : "启动"}
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleOpenUmiFolder(); }}
                            className="flex items-center gap-0.5 rounded border border-rose-300 bg-white px-1 py-0.5 text-[8px] font-medium text-rose-700 transition-colors hover:bg-rose-100"
                            title="打开 UMI-OCR 所在文件夹，可手动双击 Umi-OCR.exe 启动"
                          >
                            <FolderOpen className="h-2 w-2" />
                            手动打开
                          </button>
                        </span>
                      ) : (
                        <span
                          className={[
                            "flex items-center gap-0.5 rounded px-1 py-0.5 text-[8px] font-medium",
                            umiStatus === "checking" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700",
                          ].join(" ")}
                          title={umiStatusMsg}
                        >
                          {umiStatus === "checking" && <Loader2 className="h-2 w-2 animate-spin" />}
                          {umiStatus === "available" && <CheckCircle2 className="h-2 w-2" />}
                          {umiStatus === "checking" ? "检测中" : "在线"}
                        </span>
                      )
                    )}
                  </div>
                )}
                {/* 断点切换：无 → 强制断点 → 条件断点 → 无 */}
                {onToggleDocBreakpoint && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggleDocBreakpoint(); }}
                    className={[
                      "flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-semibold transition-all",
                      docBreakpoint === "always"
                        ? "bg-rose-500 text-white shadow-sm"
                        : docBreakpoint === "on-error"
                        ? "bg-amber-500 text-white shadow-sm"
                        : "text-slate-400 hover:bg-slate-100 hover:text-slate-600",
                    ].join(" ")}
                    title={
                      docBreakpoint === "always"
                        ? "强制断点：每次 LOOP 跑到此文件处理步骤都会暂停，等人操作后继续（点击切换为条件断点）"
                        : docBreakpoint === "on-error"
                        ? "条件断点：AI 检测到文件提取错误/字段不匹配时暂停等人干预（点击取消断点）"
                        : "断点：LOOP 跑到此文件处理步骤时暂停等人操作（点击设置强制断点）"
                    }
                  >
                    {docBreakpoint === "on-error" ? <AlertOctagon className="h-2.5 w-2.5" /> : <CirclePause className="h-2.5 w-2.5" />}
                    {docBreakpoint === "always" ? "强制断点" : docBreakpoint === "on-error" ? "条件断点" : "断点"}
                  </button>
                )}
                {/* 控件提取模式下手动收起文件处理面板（非choose模式） */}
                {isWidgetMode && !isDocExtractFocus && filePanelManuallyOpen && !docConfigChooseMode && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setFilePanelManuallyOpen(false); }}
                    className="ml-auto flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                    title="收起文件处理面板"
                  >
                    <ChevronLeft className="h-3 w-3" />
                    收起
                  </button>
                )}
                {/* 设置/结果切换按钮：choose 模式和普通模式都显示 */}
                <button
                  onClick={() => setDocSetupMode((v) => !v)}
                  className={[
                    (isWidgetMode && !isDocExtractFocus && filePanelManuallyOpen && !docConfigChooseMode) ? "" : "ml-auto",
                    "flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium transition-colors",
                    docSetupMode
                      ? "bg-slate-200 text-slate-700"
                      : "text-slate-400 hover:bg-slate-100 hover:text-slate-600",
                  ].join(" ")}
                  title={docSetupMode ? "切换到结果显示" : "切换到步骤设置"}
                >
                  {docSetupMode ? <Settings2 className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
                  {docSetupMode ? "设置" : "结果"}
                </button>
                {/* choose 模式：设置/结果按钮后显示关闭按钮 */}
                {docConfigChooseMode && onExitDocChoose && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onExitDocChoose(); }}
                    className="rounded p-0.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                    title="退出文件提取"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {/* choose 模式且处于"设置"态：显示来源选择卡片（隐藏了自带标题栏）；点击"结果"则切换到下方普通视图 */}
              {docLocalConfigContent && docConfigChooseMode && docSetupMode ? (
                <div className="flex min-h-0 flex-1 min-w-[200px] flex-col overflow-hidden">{docLocalConfigContent}</div>
              ) : (
                <>
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
                          ? "bg-slate-900 text-white shadow-sm"
                          : "bg-white text-slate-500 ring-1 ring-slate-200 hover:bg-slate-100 hover:text-slate-700",
                      ].join(" ")}
                      title={ext.filename}
                    >
                      {ext.pending ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : ext.method === "vision_ocr" ? <Eye className="h-2.5 w-2.5" /> : <FileText className="h-2.5 w-2.5" />}
                      <span className="max-w-[80px] truncate">{ext.filename}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="min-h-0 flex-1 min-w-[200px] overflow-y-auto overflow-x-hidden p-1.5">
                {docSetupMode && !docLocalConfigContent ? (
                  <div className="flex h-full min-h-[140px] flex-col gap-2">
                    <div className="rounded-md border border-slate-200 bg-slate-50/60 px-2 py-1 text-[9px] leading-relaxed text-slate-500">
                      请选择文件提取的来源方式：
                    </div>
                    <div className="grid flex-1 grid-cols-2 gap-2">
                      <button
                        onClick={() => onChooseDocWeb?.()}
                        className="flex flex-col items-center justify-center gap-1.5 rounded-xl bg-slate-50/60 px-2 py-3 text-center transition-all hover:bg-slate-100"
                      >
                        <Globe className="h-6 w-6 text-slate-400" />
                        <span className="text-[11px] font-semibold text-slate-700">网页提取</span>
                        <span className="text-[9px] leading-tight text-slate-500">点击网页图片/PDF<br/>LOOP 自动下载提取</span>
                      </button>
                      <button
                        onClick={() => onChooseDocLocal?.()}
                        className="flex flex-col items-center justify-center gap-1.5 rounded-xl bg-slate-50/60 px-2 py-3 text-center transition-all hover:bg-slate-100"
                      >
                        <Upload className="h-6 w-6 text-slate-400" />
                        <span className="text-[11px] font-semibold text-slate-700">本地文件</span>
                        <span className="text-[9px] leading-tight text-slate-500">选择文件夹按字段匹配<br/>如学号.jpg/pdf/png</span>
                      </button>
                    </div>
                  </div>
                ) : fileProcessContent}
              </div>
                </>
              )}
            </>
          )}
        </div>

        {/* 中/右 拖拽分隔条 —— 仅三栏模式（showExtract且非doc-extract聚焦、非控件提取模式）下显示；文件面板可见时控件提取也显示 */}
        <div
          className={[
            "group relative hidden shrink-0 cursor-col-resize items-center justify-center lg:flex",
            "transition-opacity duration-200",
            (showExtract && isAll && (!isWidgetMode || filePanelVisible)) ? "opacity-100" : "opacity-0 lg:w-0 lg:px-0",
          ].join(" ")}
          style={{ width: (showExtract && isAll && (!isWidgetMode || filePanelVisible)) ? 6 : 0 }}
          onMouseDown={onMouseDown("right")}
        >
          <div className="panel-divider h-full w-px" />
          <div className="absolute h-8 w-1 rounded-full bg-slate-400 opacity-0 transition-opacity group-hover:opacity-100" />
        </div>

        {/* 提取元素卡片 —— 最右侧，向左展开/向右回收（默认隐藏，通过文件处理面板左侧按钮开启）；控件提取模式下和字段对比平分空间 */}
        <div
          className={[
            "flex max-h-[55vh] min-w-0 flex-col overflow-hidden bg-white lg:h-full lg:max-h-none",
            dragging ? "" : "transition-[flex-basis,opacity,max-width] duration-300 ease-out",
            showExtract ? "flex-1" : "lg:border-0 lg:px-0 lg:mx-0",
          ].join(" ")}
          style={{
            flexBasis: isFieldFocus
              ? "0%"
              : isDocFocus
                ? "0%"
                : isDocExtractFocus
                  ? "50%"
                  : (isWidgetMode && !filePanelVisible)
                    ? (showExtract ? "50%" : "0%")
                    : showExtract ? "30%" : "0%",
            flexShrink: 0,
            flexGrow: showExtract ? 1 : 0,
            willChange: "opacity, max-width",
            contain: "layout style",
          }}
        >
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-slate-100 px-1.5 py-1 text-[11px] font-semibold text-slate-700">
            <Database className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            <span className="shrink-0">提取元素</span>
            {extractSetupMode && (
              <div className="ml-1 flex shrink-0 items-center gap-1">
                {/* 控件提取切换按钮：始终显示，点击切换面板；两侧都有内容时进入分屏 */}
                <button
                  onClick={toggleWidgetPanel}
                  className={[
                    "flex items-center gap-0.5 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                    currentCategory === "widget" || effectiveSplit
                      ? "bg-slate-900 text-white shadow-sm"
                      : "bg-white/80 text-slate-600 hover:bg-white ring-1 ring-slate-200",
                  ].join(" ")}
                  title={
                    effectiveSplit
                      ? "收起分栏，回到文本面板"
                      : currentCategory === "widget"
                        ? "切换回文件/自定义字段"
                        : hasFields && hasWidget
                          ? "切换到控件提取（两侧有内容，将分屏显示）"
                          : "切换到控件提取"
                  }
                >
                  <MousePointerClick className="h-3 w-3 shrink-0" />
                  <span className="truncate">控件提取</span>
                  {widgetTabs.length > 0 && (
                    <span
                      className={`ml-0.5 inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-full px-0.5 text-[8px] font-bold ${
                        currentCategory === "widget" || effectiveSplit
                          ? "bg-white text-slate-700"
                          : "bg-slate-200 text-slate-600"
                      }`}
                    >
                      {widgetTabs.length}
                    </span>
                  )}
                </button>
              </div>
            )}
            {extractSetupMode && !effectiveSplit && onSwitchStepMode && (
              <div className="ml-2 flex shrink-0 items-center gap-0 rounded-md bg-slate-100 p-0.5 ring-1 ring-slate-200">
                <button
                  onClick={() => onSwitchStepMode("review")}
                  className={[
                    "flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium transition-all",
                    addingStepMode === "review"
                      ? "bg-red-500 text-white shadow-sm animate-pulse"
                      : "text-slate-500 hover:bg-white/60",
                  ].join(" ")}
                  title={addingStepMode === "review" ? "审核模式激活中（再次点击关闭）" : "审核模式：字段用于右侧网页与左侧Excel核对"}
                >
                  <ArrowLeft className="h-2.5 w-2.5" />
                  审核
                </button>
                <div className="h-3.5 w-px bg-slate-300" />
                <button
                  onClick={() => onSwitchStepMode("entry")}
                  className={[
                    "flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium transition-all",
                    addingStepMode === "entry"
                      ? "bg-red-500 text-white shadow-sm animate-pulse"
                      : "text-slate-500 hover:bg-white/60",
                  ].join(" ")}
                  title={addingStepMode === "entry" ? "录入模式激活中（再次点击关闭）" : "录入模式：字段用于从左侧Excel填入右侧网页"}
                >
                  <MoveRight className="h-2.5 w-2.5" />
                  录入
                </button>
              </div>
            )}
            {extractSetupMode && hasFields && hasWidget && (
              <button
                onClick={() => setSplitWidgetMode((v) => !v)}
                className={[
                  "ml-1 flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors",
                  effectiveSplit
                    ? "bg-red-500 text-white shadow-sm animate-pulse"
                    : "text-slate-400 hover:bg-slate-100 hover:text-slate-600",
                ].join(" ")}
                title={effectiveSplit ? "取消左右分栏" : "左右分栏：左侧显示文件/自定义文本，右侧显示控件提取"}
              >
                <Columns2 className="h-3 w-3" />
                {effectiveSplit ? "合并" : "分栏"}
              </button>
            )}
            <button
              onClick={() => setExtractSetupMode((v) => !v)}
              className={[
                "ml-auto flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium transition-colors",
                extractSetupMode
                  ? "bg-slate-200 text-slate-700"
                  : "text-slate-400 hover:bg-slate-100 hover:text-slate-600",
              ].join(" ")}
              title={extractSetupMode ? "切换到结果显示" : "切换到自定义字段设置"}
            >
              {extractSetupMode ? <Settings2 className="h-3 w-3" /> : <Database className="h-3 w-3" />}
              {extractSetupMode ? "设置" : "结果"}
            </button>
          </div>
          <div
            ref={splitContainerRef}
            className="min-h-0 flex-1 flex min-w-[200px] overflow-hidden"
          >
            {extractSetupMode ? (
              effectiveSplit ? (
                /* ===== 左右分栏模式：左侧文件/自定义文本，右侧控件提取 ===== */
                <>
                  {/* 左侧：统一字段面板（文件提取紫色 + 自定义文本蓝色，不再切换 TAB） */}
                  <div
                    className="flex min-h-0 min-w-0 flex-col overflow-hidden"
                    style={{ width: `${splitLeftPct}%` }}
                  >
                    <div className="min-h-0 flex-1 overflow-hidden">
                      {unifiedFieldsContent}
                    </div>
                  </div>
                  {/* 拖拽分隔条 */}
                  <div
                    className="group relative flex w-1.5 shrink-0 cursor-col-resize items-center justify-center"
                    onMouseDown={onSplitDividerMouseDown}
                  >
                    <div className="h-full w-px bg-slate-200 transition-colors group-hover:bg-slate-300" />
                    <div className="absolute h-8 w-1 rounded-full bg-slate-300 opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  {/* 右侧：控件提取 */}
                  <div
                    className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l border-slate-100"
                  >
                    <div className="flex shrink-0 items-center gap-1 border-b border-slate-100 bg-slate-50/60 px-1 py-0.5">
                      <span className="flex items-center gap-0.5 rounded bg-slate-900 px-1.5 py-0.5 text-[9px] font-medium text-white shadow-sm">
                        <MousePointerClick className="h-2.5 w-2.5 shrink-0" />
                        控件提取
                        {widgetTabs.length > 0 && (
                          <span className="ml-0.5 inline-flex h-3 min-w-3 shrink-0 items-center justify-center rounded-full bg-white/25 px-0.5 text-[8px] font-bold text-white">
                            {widgetTabs.length}
                          </span>
                        )}
                      </span>
                    </div>
                    <div
                      ref={(el) => { extractSectionRefs.current["widget"] = el; extractScrollRef.current = el; }}
                      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-1.5 scroll-smooth"
                    >
                      <div className="flex flex-col gap-1.5">
                        {widgetTabs.length > 0 && (
                          <div className="flex shrink-0 items-center gap-1 overflow-x-auto rounded-md bg-slate-50 px-1 py-1">
                            {widgetTabs.map((wt, wtIdx) => {
                              const active = activeWidgetTabId === wt.id;
                              const WidgetIcon = wt.kind === "calendar" ? CalendarDays : List;
                              const dotColor = wt.isBound
                                ? "bg-emerald-500 text-white"
                                : wt.isDraft
                                  ? "bg-violet-500 text-white animate-pulse"
                                  : "bg-violet-200 text-violet-700";
                              return (
                                <button
                                  key={wt.id}
                                  onClick={() => scrollToWidgetTab(wt.id)}
                                  className={[
                                    "flex min-w-0 shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-all",
                                    active
                                      ? "bg-violet-600 text-white shadow-sm"
                                      : wt.isDraft
                                        ? "bg-violet-100 text-violet-700 hover:bg-violet-200 ring-1 ring-violet-300"
                                        : "bg-white text-violet-600 hover:bg-violet-100",
                                  ].join(" ")}
                                  title={`${wt.kind === "calendar" ? "日历控件" : "选项控件"}：${wt.label}`}
                                >
                                  <span
                                    className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[8px] font-bold ${
                                      active ? "bg-white/25 text-white" : dotColor
                                    }`}
                                  >
                                    {wtIdx + 1}
                                  </span>
                                  <WidgetIcon className="h-3 w-3 shrink-0" />
                                  <span className="truncate max-w-[80px]">{wt.label}</span>
                                  {wt.isDraft && (
                                    <span className="text-[8px] opacity-70">·新</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {widgetExtractContent || (
                          <div className="flex min-h-[100px] flex-col items-center justify-center gap-1 rounded-2xl bg-slate-50/60 py-4 text-center text-[10px] text-slate-400">
                            <MousePointerClick className="h-5 w-5 text-slate-300" />
                            <div className="text-slate-500">暂无提取的控件</div>
                            {onAddWidget ? (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => onAddWidget("option")}
                                  className="rounded bg-slate-900 px-2 py-0.5 text-[9px] font-medium text-white transition-colors hover:bg-slate-700"
                                >
                                  + 选项控件
                                </button>
                                <button
                                  onClick={() => onAddWidget("calendar")}
                                  className="rounded bg-white/70 px-2 py-0.5 text-[9px] font-medium text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-100 hover:text-slate-900"
                                >
                                  + 日历控件
                                </button>
                              </div>
                            ) : (
                              <div>点击上方「+ 选项控件」或「日历控件」快照</div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                /* ===== 普通模式：非控件时显示统一字段面板，控件模式时显示控件提取 ===== */
                <div
                  ref={extractScrollRef}
                  className={`min-h-0 flex-1 overflow-x-hidden scroll-smooth ${currentCategory === "widget" ? "overflow-y-auto" : "overflow-hidden"}`}
                >
                  {currentCategory === "widget" ? (
                    <div className="p-1.5">
                      {(widgetExtractContent || widgetTabs.length > 0) ? (
                        <div
                          ref={(el) => { extractSectionRefs.current["widget"] = el; }}
                          className="flex flex-col gap-1.5"
                        >
                          <div className="flex shrink-0 items-center gap-1 overflow-x-auto rounded-md bg-slate-50 px-1 py-1">
                            {widgetTabs.map((wt, wtIdx) => {
                              const active = activeWidgetTabId === wt.id;
                              const WidgetIcon = wt.kind === "calendar" ? CalendarDays : List;
                              const dotColor = wt.isBound
                                ? "bg-emerald-500 text-white"
                                : wt.isDraft
                                  ? "bg-violet-500 text-white animate-pulse"
                                  : "bg-violet-200 text-violet-700";
                              return (
                                <button
                                  key={wt.id}
                                  onClick={() => scrollToWidgetTab(wt.id)}
                                  className={[
                                    "flex min-w-0 shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-all",
                                    active
                                      ? "bg-violet-600 text-white shadow-sm"
                                      : wt.isDraft
                                        ? "bg-violet-100 text-violet-700 hover:bg-violet-200 ring-1 ring-violet-300"
                                        : "bg-white text-violet-600 hover:bg-violet-100",
                                  ].join(" ")}
                                  title={`${wt.kind === "calendar" ? "日历控件" : "选项控件"}：${wt.label}`}
                                >
                                  <span
                                    className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[8px] font-bold ${
                                      active ? "bg-white/25 text-white" : dotColor
                                    }`}
                                  >
                                    {wtIdx + 1}
                                  </span>
                                  <WidgetIcon className="h-3 w-3 shrink-0" />
                                  <span className="truncate max-w-[80px]">{wt.label}</span>
                                  {wt.isDraft && (
                                    <span className="text-[8px] opacity-70">·新</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                          {widgetExtractContent || (
                            <div className="flex min-h-[100px] flex-col items-center justify-center gap-1 rounded-2xl bg-slate-50/60 py-4 text-center text-[10px] text-slate-400">
                              <MousePointerClick className="h-5 w-5 text-slate-300" />
                              <div className="text-slate-500">暂无提取的控件</div>
                              {onAddWidget ? (
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => onAddWidget("option")}
                                    className="rounded bg-slate-900 px-2 py-0.5 text-[9px] font-medium text-white transition-colors hover:bg-slate-700"
                                  >
                                    + 选项控件
                                  </button>
                                  <button
                                    onClick={() => onAddWidget("calendar")}
                                    className="rounded bg-white/70 px-2 py-0.5 text-[9px] font-medium text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-100 hover:text-slate-900"
                                  >
                                    + 日历控件
                                  </button>
                                </div>
                              ) : (
                                <div>点击上方「+ 选项控件」或「日历控件」快照</div>
                              )}
                            </div>
                          )}
                        </div>
                      ) : forceWidgetView ? (
                        /* 用户主动点击「控件提取」但尚无控件内容：显示空状态引导 */
                        <div className="flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-2xl bg-slate-50/60 py-6 text-center">
                          <MousePointerClick className="h-8 w-8 text-slate-300" />
                          <div className="text-xs font-medium text-slate-500">控件提取</div>
                          <div className="text-[10px] text-slate-400">提取网页中的下拉选项、日历等展开型控件</div>
                          {onAddWidget && (
                            <div className="mt-1 flex items-center gap-1.5">
                              <button
                                onClick={() => onAddWidget("option")}
                                className="rounded-md bg-slate-900 px-3 py-1 text-[10px] font-medium text-white transition-colors hover:bg-slate-700"
                              >
                                + 选项控件
                              </button>
                              <button
                                onClick={() => onAddWidget("calendar")}
                                className="rounded-md bg-white/70 px-3 py-1 text-[10px] font-medium text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-100 hover:text-slate-900"
                              >
                                + 日历控件
                              </button>
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    /* 非控件模式：显示统一字段面板（文件+自定义文本） */
                    unifiedFieldsContent
                  )}
                </div>
              )
            ) : (
              <div
                ref={extractScrollRef}
                className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-1.5 scroll-smooth"
              >
                {extractedContent}
              </div>
            )}
          </div>
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
