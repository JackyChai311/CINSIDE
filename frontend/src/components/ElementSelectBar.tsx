import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Database,
  FileSpreadsheet,
  FolderOpen,
  Globe,
  ListChecks,
  MousePointerClick,
  Play,
  Plus,
  Repeat2,
  RotateCcw,
  Save,
  Type,
  Upload,
  Users,
  X,
} from "lucide-react";
import type { AppMode, FieldMapping, LeftSource, TeachingPhase, VerifyMethod } from "../types";
import type { PickedElementInfo } from "./BrowserPane";

export type PickTarget = "right" | "left" | null;

/** 自定义文本条目：用户手动输入的临时内容，可关联网页元素用于审查/录入 */
export interface CustomTextEntry {
  id: string;
  /** 框框名字（仅显示，方便理解功能，不参与数据对比/录入） */
  name: string;
  /** 实际内容值（参与审查对比/录入填入） */
  text: string;
  selector?: string;
  label?: string;
  side?: "left" | "right";
  tag?: string;
  type?: string;
  /** 是否已保存为映射步骤 */
  saved?: boolean;
}

interface Props {
  /** 当前是否处于选择模式 */
  active: boolean;
  /** 当前应该拾取哪一侧：先右后左 */
  pickTarget: PickTarget;
  /** 右侧已拾取的元素 */
  rightPicked: PickedElementInfo | null;
  /** 左侧已拾取的元素（来自网页） */
  leftPicked: PickedElementInfo | null;
  /** 当前记录的所有 Excel 字段 */
  excelFields: string[];
  /** 已配置的映射数量 */
  mappingCount: number;
  /** 取消整个选择模式 */
  onCancel: () => void;
  /** 用户选择从左侧网页拾取（切到拾取左侧） */
  onPickLeftFromWeb: () => void;
  /** 用户选择从 Excel 字段选（切到 Excel 选择） */
  onPickLeftFromExcel: () => void;
  /** 重置当前一轮（保留选择模式） */
  onResetRound: () => void;
  /** 保存映射 */
  onSave: (mapping: FieldMapping) => void;
  /** 教学模式阶段（idle 表示未在教学） */
  teachingPhase?: TeachingPhase;
  /** 当前快捷键动作状态 */
  pendingAction?: "none" | "input" | "click";
  /** 应用模式 */
  appMode?: AppMode;
  /** 数据源/审查流/录入流节点数量 */
  dataSourceCount?: number;
  reviewCount?: number;
  entryCount?: number;
  /** 步骤2是否已完成（有绑定的输入框） */
  hasBoundInputs?: boolean;
  /** 步骤3是否已完成（有确认人物点击） */
  hasConfirmClick?: boolean;
  /** 教学阶段推进：data-source → review */
  onAdvanceTeaching?: () => void;
  /** 中止教学 */
  onAbortTeaching?: () => void;
  /** 教学模式中选中的 Excel LOOP 列 */
  selectedExcelColumn?: string | null;
  /** 当前绑定输入框的侧（both = 左右侧皆可的灵活绑定模式） */
  bindInputSide?: "left" | "right" | "both" | null;
  /** 下一次 click 动作的特殊标签 */
  nextClickLabel?: string | null;
  /** 开始灵活绑定输入框/点击 */
  onStartBindInputs?: () => void;
  /** 退出灵活绑定模式 */
  onExitBindInputs?: () => void;
  /** 灵活绑定模式下已添加的步骤数（输入+点击） */
  bindStepCount?: number;
  /** 开始“确认人物”点击步骤 */
  onStartConfirmPerson?: () => void;
  /** 添加审查步骤到 LOOP 循环体 */
  onStartAddReviewSteps?: () => void;
  /** 添加录入步骤到 LOOP 循环体 */
  onStartAddEntrySteps?: () => void;
  /** 退出添加步骤模式 */
  onExitAddingStepMode?: () => void;
  /** 当前添加步骤模式 */
  addingStepMode?: "review" | "entry" | null;
  /** 当前配置的步骤类型（用于映射配置面板切换） */
  currentStepType?: "review" | "entry";
  /** 切换步骤类型（审查/录入） */
  onSwitchStepType?: (type: "review" | "entry") => void;
  /** 是否处于添加点击按钮模式 */
  addingClickMode?: boolean;
  /** 当前添加的点击阶段：pre=前置(搜索/进入)，post=收尾(保存/返回) */
  addingClickPhase?: "pre" | "post" | null;
  /** 已添加的前置点击数量（步骤3：搜索/进入） */
  preClickCount?: number;
  /** 已添加的收尾点击数量（步骤5：保存/返回） */
  postClickCount?: number;
  /** 开始添加前置点击（步骤3） */
  onStartAddPreClick?: () => void;
  /** 开始添加收尾点击（步骤5） */
  onStartAddPostClick?: () => void;
  /** 退出添加点击按钮模式 */
  onExitAddClickMode?: () => void;
  /** 交换教学面板与浏览器区域的左右位置 */
  onSwapSide?: () => void;
  /** 撤销最后一步（删除最后一个 mark） */
  onUndo?: () => void;
  /** 是否可撤销（有 mark 可删） */
  canUndo?: boolean;
  /** 文件提取模式：审查步骤子步骤，点击右侧网页图片/PDF → OCR 提取 */
  addingDocExtractMode?: boolean;
  /** 文件提取来源选择阶段 */
  docExtractSource?: null | "choose" | "web" | "local";
  /** 已添加的文件提取步骤数 */
  docExtractStepCount?: number;
  /** 已绑定的文件上传步骤数（绑定上传 mark） */
  docUploadStepCount?: number;
  /** 开始添加文件提取步骤（审查：右侧网页拾取） */
  onStartAddDocExtract?: () => void;
  /** 退出文件提取模式 */
  onExitAddDocExtractMode?: () => void;
  /** 选择网页提取来源 */
  onChooseDocExtractWeb?: () => void;
  /** 选择本地文件提取来源 */
  onChooseDocExtractLocal?: () => void;
  /** 触发本地文件选择对话框 */
  onTriggerLocalFilePick?: () => void;
  /** 本地文件选择变化处理 */
  onLocalFilesSelected?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** 本地文件 ref（用于绑定隐藏 input） */
  localFileInputRef?: React.RefObject<HTMLInputElement>;
  /** 已上传的本地文件列表 */
  docLocalFiles?: Array<{ name: string; size?: number }>;
  /** 删除一个本地文件 */
  onRemoveLocalFile?: (name: string) => void;
  /** 绑定的文件名匹配字段 */
  docFileBindField?: string | null;
  /** 设置绑定字段 */
  onSetDocFileBindField?: (field: string) => void;
  /** 确认本地文件提取配置 */
  onConfirmDocLocalExtract?: () => void;
  /** 目录模式：选择本地文件夹 */
  onPickLocalDirectory?: () => void;
  /** 目录模式：根目录绝对路径 */
  docLocalRootPath?: string | null;
  /** 目录模式：目录内文件列表 */
  docLocalDirFiles?: Array<{ relativePath: string; name: string; size: number; ext: string }>;
  /** 目录模式：用户点选的样本文件相对路径 */
  docLocalSamplePath?: string | null;
  /** 目录模式：推断出的路径模板 */
  docLocalPattern?: string | null;
  /** 目录模式：点选样本文件 */
  onSelectDocLocalSample?: (relativePath: string) => void;
  /** 录入步骤子步骤：本地文件提取（上传图片 → 勾选字段 → 填入右侧网页） */
  onDocFileExtract?: () => void;
  /** 自定义文本模式：在步骤4中添加用户自定义文本框，配合录入/审核 */
  customTextMode?: boolean;
  /** 自定义文本条目列表 */
  customTextEntries?: CustomTextEntry[];
  /** 当前正在拾取的自定义文本条目 ID */
  customTextPickingId?: string | null;
  /** 切换自定义文本模式 */
  onToggleCustomText?: () => void;
  /** 添加一个自定义文本框 */
  onAddCustomText?: () => void;
  /** 删除一个自定义文本框 */
  onRemoveCustomText?: (id: string) => void;
  /** 更新自定义文本内容 */
  onUpdateCustomText?: (id: string, text: string) => void;
  /** 为某个文本框拾取网页元素 */
  onPickForCustomText?: (id: string) => void;
  /** 将所有已配置的文本框保存为审查/录入步骤 */
  onSaveCustomTextSteps?: () => void;
  /** 控件提取模式：提取点击展开型控件（下拉选项/日历）到「提取元素」面板 */
  widgetExtractMode?: boolean;
  /** 已保存的控件数量 */
  widgetCount?: number;
  /** 切换控件提取模式 */
  onToggleWidgetExtract?: () => void;
  /** 人物卡片是否已生成 */
  cardsGenerated?: boolean;
  /** LOOP 行范围框选（0-based 闭区间） */
  rowRange?: { start: number; end: number } | null;
  /** 快速保存 Loop（不弹窗，自动命名） */
  onRequestQuickSave?: () => void;
  /** 打开保存 LOOP 弹窗（命名保存） */
  onRequestSaveSkill?: () => void;
  /** 直接执行当前配置（不保存弹窗，临时运行） */
  onDirectRun?: () => void;
  /** 右侧网页绑定输入框时取的 Excel 列（null=跟随 LOOP 列） */
  rightBindColumn?: string | null;
  /** 设置右侧绑定列 */
  onRightBindColumnChange?: (col: string | null) => void;
}

export default function ElementSelectBar({
  active,
  pickTarget,
  rightPicked,
  leftPicked,
  excelFields = [],
  mappingCount,
  onCancel,
  onPickLeftFromWeb,
  onPickLeftFromExcel,
  onResetRound,
  onSave,
  teachingPhase = "idle",
  pendingAction = "none",
  appMode = "loop",
  dataSourceCount = 0,
  reviewCount = 0,
entryCount = 0,
hasBoundInputs = false,
hasConfirmClick = false,
onAdvanceTeaching,
  onAbortTeaching,
  selectedExcelColumn,
  bindInputSide,
  nextClickLabel,
  onStartBindInputs,
onExitBindInputs,
bindStepCount = 0,
onStartConfirmPerson,
onStartAddReviewSteps,
onStartAddEntrySteps,
onExitAddingStepMode,
addingStepMode,
currentStepType = "review",
onSwitchStepType,
addingClickMode = false,
addingClickPhase = null,
preClickCount = 0,
postClickCount = 0,
onStartAddPreClick,
onStartAddPostClick,
onExitAddClickMode,
onSwapSide,
onUndo,
canUndo = false,
addingDocExtractMode = false,
docExtractSource = null,
docExtractStepCount = 0,
docUploadStepCount = 0,
onStartAddDocExtract,
onExitAddDocExtractMode,
onChooseDocExtractWeb,
onChooseDocExtractLocal,
onTriggerLocalFilePick,
onLocalFilesSelected,
localFileInputRef,
docLocalFiles = [],
onRemoveLocalFile,
docFileBindField = null,
onSetDocFileBindField,
onConfirmDocLocalExtract,
onPickLocalDirectory,
docLocalRootPath = null,
docLocalDirFiles = [],
docLocalSamplePath = null,
docLocalPattern = null,
onSelectDocLocalSample,
onDocFileExtract,
  customTextMode = false,
  customTextEntries = [],
  customTextPickingId = null,
  onToggleCustomText,
  onAddCustomText,
  onRemoveCustomText,
  onUpdateCustomText,
  onPickForCustomText,
  onSaveCustomTextSteps,
  widgetExtractMode = false,
  widgetCount = 0,
  onToggleWidgetExtract,
  cardsGenerated = false,
rowRange = null,
onRequestQuickSave,
onRequestSaveSkill,
onDirectRun,
rightBindColumn = null,
onRightBindColumnChange,
}: Props) {
  const [leftSource, setLeftSource] = useState<LeftSource>("database");
  const [excelField, setExcelField] = useState<string>("");
  const [method, setMethod] = useState<VerifyMethod>("smart");

  // 顶部标题：宽度充足时显示完整标题，宽度不足时切换为简短标题，避免长标题换行把面板撑高
  const fullTitle =
    addingStepMode === "review" ? "添加审查步骤 · 选择映射"
    : addingStepMode === "entry" ? "添加录入步骤 · 选择映射"
    : "步骤仪表";
  const shortTitle =
    addingStepMode === "review" ? "审查映射"
    : addingStepMode === "entry" ? "录入映射"
    : "步骤仪表";
  const leftHeaderRef = useRef<HTMLDivElement>(null);
  const [compactTitle, setCompactTitle] = useState(false);
  useEffect(() => {
    const el = leftHeaderRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      // 阈值参考：完整标题约需 280px，简短标题约需 100px
      setCompactTitle(el.clientWidth < 280);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (excelFields.length > 0 && !excelField) {
      setExcelField(excelFields[0]);
    }
  }, [excelFields, excelField]);

  // 按 Tab 在「网页 / Excel」两种来源之间快速切换
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      setLeftSource((prev) => {
        const next = prev === "excel" ? "database" : "excel";
        if (next === "database") {
          onPickLeftFromWeb();
        } else {
          onPickLeftFromExcel();
        }
        return next;
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, onPickLeftFromWeb, onPickLeftFromExcel]);

  // 右侧取列下拉：文档流内展开，点击外部自动收起
  const [rightBindDropdownOpen, setRightBindDropdownOpen] = useState(false);
  const rightBindDropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!rightBindDropdownOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (rightBindDropdownRef.current && !rightBindDropdownRef.current.contains(e.target as Node)) {
        setRightBindDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [rightBindDropdownOpen]);

  if (!active) return null;

  // 步骤判定（审查模式：先右侧元素 → 后左侧来源；录入模式：先左侧来源 → 后右侧输入框，顺序相反）
  const isEntryMode = currentStepType === "entry";
  const leftDone = !!leftPicked || (leftSource === "excel" && !!excelField) || leftSource === "manual";
  const step = isEntryMode
    ? (leftDone ? (rightPicked ? 3 : 2) : 1)
    : (rightPicked ? (leftDone ? 3 : 2) : 1);

  const canSave = Boolean(rightPicked && (leftPicked || (leftSource === "excel" && excelField) || leftSource === "manual"));

  // 当前左侧来源是否处于网页/Excel 激活态（避免 TS 在 JSX 里对 pickTarget 做多余窄化报错）
  const webSourceActive = pickTarget === "left" || (pickTarget == null && leftSource === "database");
  const excelSourceActive = leftSource === "excel" && pickTarget == null;

  // 右侧取列选择器：指定右侧网页输入框绑定时取哪一列（默认跟随 LOOP 列）。
  // 自定义下拉（非原生 select），文档流内展开，避免被 overflow 裁切 / iframe 覆盖。
  const rightBindPicker = onRightBindColumnChange ? (
    <div className="relative shrink-0" ref={rightBindDropdownRef}>
      <button
        onClick={() => setRightBindDropdownOpen((v) => !v)}
        disabled={!excelFields.length}
        title="右侧网页输入框绑定时取哪一列（默认跟随 LOOP 列）"
        className={[
          "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-all",
          rightBindColumn
            ? "border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
            : excelFields.length
              ? "border-slate-300 bg-white text-slate-600 hover:border-slate-400 hover:bg-slate-50"
              : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400",
        ].join(" ")}
      >
        <span className="max-w-32 truncate">
          {rightBindColumn ? `右侧取列「${rightBindColumn}」` : "右侧取列"}
        </span>
        <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${rightBindDropdownOpen ? "rotate-180" : ""}`} />
      </button>
      {rightBindDropdownOpen && (
        <div className="mt-0.5 max-h-40 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
          <button
            onClick={() => {
              onRightBindColumnChange(null);
              setRightBindDropdownOpen(false);
            }}
            className={[
              "flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] transition-colors",
              !rightBindColumn ? "bg-indigo-100 font-semibold text-indigo-800" : "text-slate-700 hover:bg-indigo-50",
            ].join(" ")}
          >
            {!rightBindColumn && <Check className="h-2.5 w-2.5 shrink-0 text-indigo-600" />}
            <span className="min-w-0 flex-1 truncate">跟随 LOOP 列{selectedExcelColumn ? `「${selectedExcelColumn}」` : ""}</span>
          </button>
          {excelFields.map((f) => {
            const isSel = rightBindColumn === f;
            const isLoop = f === selectedExcelColumn;
            return (
              <button
                key={f}
                onClick={() => {
                  onRightBindColumnChange(isLoop ? null : f);
                  setRightBindDropdownOpen(false);
                }}
                className={[
                  "flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] transition-colors",
                  isSel ? "bg-indigo-100 font-semibold text-indigo-800" : "text-slate-700 hover:bg-indigo-50",
                ].join(" ")}
              >
                {isSel && <Check className="h-2.5 w-2.5 shrink-0 text-indigo-600" />}
                <span className="min-w-0 flex-1 truncate">{f}</span>
                {isLoop && (
                  <span className="shrink-0 rounded bg-amber-200 px-1 text-[8px] font-medium text-amber-700">LOOP</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  ) : null;

  const handleSave = () => {
    if (!rightPicked) return;
    let leftField = "";
    let source: LeftSource = leftSource;
    if (leftPicked) {
      if (leftPicked.tag === "excel-cell") {
        // 来自 Excel 视图的单元格拾取
        source = "excel";
        leftField = leftPicked.selector; // 字段名
      } else if (leftPicked.tag === "doc-extract") {
        // 来自「提取元素」面板的文档提取值 → 护照来源，left_field = 字段名
        source = "passport";
        leftField = leftPicked.selector; // 字段名（name / passport_no / birth_date …）
      } else {
        // 用左侧网页拾取的元素
        source = "database";
        leftField = leftPicked.selector;
      }
    } else if (leftSource === "excel") {
      leftField = excelField;
    }
    onSave({
      right_selector: rightPicked.selector,
      right_label: rightPicked.label || rightPicked.selector,
      left_source: source,
      left_field: leftField,
      verify_method: method,
    });
  };

  // 右侧拾取行（审查模式=第1步；录入模式=第2步，需先完成左侧来源）
  const rightPickRow = (
    <StepRow
      active={isEntryMode ? step === 2 : step === 1}
      done={!!rightPicked}
      icon={<Globe className="h-3.5 w-3.5" />}
      label={isEntryMode ? "选择右侧网页中要填入的输入框" : "选择右侧网页中要核对的元素"}
      highlight={pickTarget === "right"}
    >
      {isEntryMode && !leftDone ? (
        <span className="text-[10px] text-slate-400">先完成上一步</span>
      ) : rightPicked ? (
        <PickedChip
          label={rightPicked.label || rightPicked.selector}
          sub={`<${rightPicked.tag}> ${rightPicked.selector}`}
          tone="right"
        />
      ) : (
        <span className="text-[10px] text-slate-500">
          {pickTarget === "right"
            ? isEntryMode
              ? "现在到右侧网页点击要填入的输入框…"
              : "现在到右侧网页点击任意输入框 / 文本元素…"
            : "等待启动"}
        </span>
      )}
    </StepRow>
  );

  // 左侧来源行（录入模式=第1步，直接可选；审查模式=第2步，需先完成右侧拾取）
  const leftSourceRow = (
    <StepRow
      active={isEntryMode ? step === 1 : step === 2}
      done={leftDone}
      icon={<ArrowRight className="h-3.5 w-3.5" />}
      label={isEntryMode ? "选择左侧来源（网页元素或 Excel 字段）" : "选择对应的左侧来源"}
      highlight={pickTarget === "left"}
    >
      {!isEntryMode && !rightPicked ? (
        <span className="text-[10px] text-slate-400">先完成上一步</span>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={onPickLeftFromWeb}
            className={[
              "flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-all",
              webSourceActive
                ? "border-amber-400 bg-amber-50 text-amber-700 ring-1 ring-amber-300"
                : "border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:bg-brand-50/50",
            ].join(" ")}
          >
            <Globe className="h-3 w-3" />
            {pickTarget === "left" ? "点击左侧网页元素…" : "从左侧网页拾取"}
          </button>
          <span className="text-[10px] text-slate-400">或按 Tab</span>
          <button
            onClick={onPickLeftFromExcel}
            className={[
              "flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-all",
              excelSourceActive
                ? "border-blue-400 bg-blue-50 text-blue-700 ring-1 ring-blue-300"
                : "border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:bg-blue-50/50",
            ].join(" ")}
          >
            <FileSpreadsheet className="h-3 w-3" />
            从 Excel 选字段
          </button>

          {leftPicked && (
            <PickedChip
              label={leftPicked.label || leftPicked.selector}
              sub={`<${leftPicked.tag}> ${leftPicked.selector}`}
              tone="left"
            />
          )}
        </div>
      )}
    </StepRow>
  );

  return (
    <div className={[
      "flex h-full w-full flex-col rounded-lg bg-white px-3 py-2",
      teachingPhase !== "idle" ? "overflow-y-auto" : "overflow-hidden",
    ].join(" ")}>
      {/* 顶部：标题 + 步骤指示 + 取消 */}
      <div className="mb-2.5 flex shrink-0 items-center justify-between gap-2">
        <div ref={leftHeaderRef} className="flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 truncate text-sm font-semibold text-slate-800"
            title={fullTitle}
          >
            {compactTitle ? shortTitle : fullTitle}
          </span>
          {/* 完成按钮组：保存Loop / 适配LOOP / 执行 */}
          {/* 当卡片已生成且有任何步骤（审查/录入/点击）时显示按钮，允许空LOOP测试卡片定位 */}
          {onRequestQuickSave && (teachingPhase !== "idle" || (cardsGenerated && (reviewCount + entryCount + preClickCount + postClickCount > 0))) && (
            <button
              onClick={onRequestQuickSave}
              disabled={reviewCount + entryCount + preClickCount + postClickCount === 0}
              className={[
                "flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                reviewCount + entryCount + preClickCount + postClickCount === 0
                  ? "cursor-not-allowed bg-slate-200 text-slate-400"
                  : "bg-slate-600 text-white hover:bg-slate-700",
              ].join(" ")}
              title="快速保存 Loop（自动命名）"
            >
              <Save className="h-3 w-3" />
              保存Loop
            </button>
          )}
          {onRequestSaveSkill && (teachingPhase !== "idle" || (cardsGenerated && (reviewCount + entryCount + preClickCount + postClickCount > 0))) && (
            <button
              onClick={onRequestSaveSkill}
              disabled={reviewCount + entryCount + preClickCount + postClickCount === 0}
              className={[
                "flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                reviewCount + entryCount + preClickCount + postClickCount === 0
                  ? "cursor-not-allowed bg-slate-200 text-slate-400"
                  : "bg-emerald-600 text-white hover:bg-emerald-700",
              ].join(" ")}
              title="命名保存为 LOOP 模板"
            >
              <CheckCircle2 className="h-3 w-3" />
              适配LOOP
            </button>
          )}
          {onDirectRun && appMode !== "review" && (teachingPhase !== "idle" || (cardsGenerated && (reviewCount + entryCount + preClickCount + postClickCount > 0))) && (
            <button
              onClick={onDirectRun}
              disabled={reviewCount + entryCount + preClickCount + postClickCount === 0}
              className={[
                "flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                reviewCount + entryCount + preClickCount + postClickCount === 0
                  ? "cursor-not-allowed bg-slate-200 text-slate-400"
                  : "bg-brand-600 text-white hover:bg-brand-700",
              ].join(" ")}
            >
              <Play className="h-3 w-3" />
              执行
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* LOOP流程中步骤指示器移到子面板顶部 */}
          {teachingPhase === "idle" && (
            <div className="flex items-center gap-1 text-[11px]">
              {[1, 2, 3].map((n) => (
                <span
                  key={n}
                  className={[
                    "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold transition-all",
                    n < step
                      ? "bg-emerald-500 text-white"
                      : n === step
                      ? "bg-amber-500 text-white ring-2 ring-amber-300"
                      : "bg-slate-200 text-slate-500",
                  ].join(" ")}
                >
                  {n < step ? <Check className="h-3 w-3" /> : n}
                </span>
              ))}
            </div>
          )}
          {onSwapSide && (
            <button
              onClick={onSwapSide}
              className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-indigo-600"
              title="交换配置面板与浏览器的左右位置"
            >
              <ArrowLeftRight className="h-4 w-4" />
            </button>
          )}
          {onUndo && !compactTitle && (
            <button
              onClick={onUndo}
              disabled={!canUndo}
              className={[
                "rounded-md p-1 transition-colors",
                canUndo ? "text-slate-500 hover:bg-amber-50 hover:text-amber-600" : "cursor-not-allowed text-slate-200",
              ].join(" ")}
              title="撤销最后一步 (R)"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={onCancel}
            className="rounded-md p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
            title="退出选择模式"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 步骤内容：addingStepMode时显示为子面板（LOOP步骤4展开的映射配置） */}
      {/* 当 LOOP 步骤配置面板同时存在时（teachingPhase !== "idle"），映射配置按内容自适应高度，由外层容器统一滚动 */}
      <div className={[
        "pr-1 transition-all",
        teachingPhase !== "idle"
          ? "shrink-0"
          : "flex-1 overflow-y-auto",
        addingStepMode ? "mt-1.5 space-y-1.5 rounded-xl border-2 border-indigo-200 bg-gradient-to-br from-indigo-50/70 to-violet-50/40 px-2.5 py-2 shadow-sm" : "space-y-2.5",
        teachingPhase !== "idle" && !addingStepMode ? "mt-1.5 space-y-1.5 rounded-xl border-2 border-indigo-200 bg-gradient-to-br from-indigo-50/70 to-violet-50/40 px-2.5 py-2 shadow-sm" : "",
        addingStepMode ? "order-1" : "order-2",
      ].join(" ")}>
        {/* LOOP流程中，在子面板顶部显示步骤指示器（与 LOOP 向导同款紧凑风格） */}
        {teachingPhase !== "idle" && (
          <div className="mb-1 flex items-center gap-1.5 border-b border-indigo-100 pb-1.5">
            <Repeat2 className="h-3 w-3 text-indigo-600" />
            <span className="text-[10px] font-bold text-indigo-800">映射配置</span>
            {/* 审查/录入模式切换按钮（带滑动滑块动画） */}
            {onSwitchStepType && (
              <div className="relative ml-1 flex items-stretch rounded-lg bg-slate-200/60 p-0.5">
                {/* 滑动滑块 */}
                <div
                  className={[
                    "absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded-md shadow-sm transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
                    currentStepType === "review"
                      ? "left-0.5 bg-sky-500"
                      : "left-[calc(50%+1.5px)] bg-violet-500",
                  ].join(" ")}
                />
                <button
                  onClick={() => onSwitchStepType("review")}
                  className={[
                    "relative z-10 flex w-14 items-center justify-center gap-0.5 rounded-md py-0.5 text-[9px] font-semibold transition-colors duration-200",
                    currentStepType === "review" ? "text-white" : "text-slate-500 hover:text-slate-700",
                  ].join(" ")}
                >
                  <ListChecks className="h-2.5 w-2.5" />
                  审查
                </button>
                <button
                  onClick={() => onSwitchStepType("entry")}
                  className={[
                    "relative z-10 flex w-14 items-center justify-center gap-0.5 rounded-md py-0.5 text-[9px] font-semibold transition-colors duration-200",
                    currentStepType === "entry" ? "text-white" : "text-slate-500 hover:text-slate-700",
                  ].join(" ")}
                >
                  <MousePointerClick className="h-2.5 w-2.5" />
                  录入
                </button>
              </div>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {/* 添加步骤模式下显示完成按钮 */}
              {addingStepMode && onExitAddingStepMode && (
                <button
                  onClick={onExitAddingStepMode}
                  className="flex items-center gap-1 rounded-md bg-emerald-500 px-2 py-0.5 text-[9px] font-semibold text-white shadow-sm transition-all hover:bg-emerald-600 active:scale-95"
                >
                  <CheckCircle2 className="h-2.5 w-2.5" />
                  完成
                </button>
              )}
              {[1, 2, 3].map((n) => (
                <span
                  key={n}
                  className={[
                    "flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold transition-all",
                    n < step
                      ? "bg-emerald-500 text-white"
                      : n === step
                      ? "bg-amber-500 text-white ring-2 ring-amber-300"
                      : "bg-slate-200 text-slate-500",
                  ].join(" ")}
                >
                  {n < step ? <Check className="h-2.5 w-2.5" /> : n}
                </span>
              ))}
            </div>
          </div>
        )}
        {/* 录入模式：左侧来源 → 右侧输入框；审查模式：右侧元素 → 左侧来源 */}
        {isEntryMode ? leftSourceRow : rightPickRow}
        {isEntryMode ? rightPickRow : leftSourceRow}

        {/* Step 3: 确认 + 保存 */}
        <StepRow
          active={step === 3}
          done={false}
          icon={<Check className="h-3.5 w-3.5" />}
          label="确认映射并保存"
          highlight={false}
        >
          {rightPicked && (leftPicked || leftSource) ? (
            <div className="flex flex-wrap items-center gap-1">
              {/* 右侧已选 */}
              <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                右: {rightPicked.label || rightPicked.selector}
              </span>
              <ArrowRight className="h-2.5 w-2.5 text-slate-400" />
              {/* 左侧来源 + 字段 */}
              {leftPicked ? (
                <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 ring-1 ring-blue-200">
                  {leftPicked.tag === "excel-cell" ? "Excel" : leftPicked.tag === "doc-extract" ? "护照提取" : "左网页"}: {leftPicked.label || leftPicked.selector}
                </span>
              ) : (
                <>
                  <select
                    value={leftSource}
                    onChange={(e) => setLeftSource(e.target.value as LeftSource)}
                    className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px] outline-none"
                  >
                    <option value="excel">Excel</option>
                    <option value="database">数据库</option>
                    <option value="passport">护照 OCR</option>
                    <option value="manual">手动</option>
                  </select>
                  {leftSource === "excel" && (
                    <select
                      value={excelField}
                      onChange={(e) => setExcelField(e.target.value)}
                      className="max-w-[140px] rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px] outline-none"
                    >
                      {excelFields.length === 0 && <option value="">无字段</option>}
                      {excelFields.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  )}
                </>
              )}
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as VerifyMethod)}
                className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px] outline-none"
                title="验证方式"
              >
                <option value="smart">智能</option>
                <option value="exact">精确</option>
              </select>
              <button
                onClick={handleSave}
                disabled={!canSave}
                className="flex items-center gap-0.5 rounded bg-brand-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                <Check className="h-2.5 w-2.5" /> 保存
              </button>
              <button
                onClick={onResetRound}
                className="rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                重选
              </button>
            </div>
          ) : (
            <span className="text-[10px] text-slate-400">
              {isEntryMode ? "先完成左侧来源选择" : "先完成右侧元素选择"}
            </span>
          )}
        </StepRow>
      </div>

      {/* LOOP 步骤配置向导（主流程面板，固定在上方；添加步骤时让映射配置在上） */}
      {teachingPhase !== "idle" && (
        <div className={[
          "shrink-0 mb-1 rounded-xl border-2 border-indigo-200 bg-gradient-to-br from-indigo-50/70 to-violet-50/40 px-3 py-2 shadow-sm transition-all",
          addingStepMode ? "order-2" : "order-1",
        ].join(" ")}>
          <div className="mb-1.5 flex items-center gap-1.5">
            <Repeat2 className="h-3.5 w-3.5 text-indigo-600" />
            <span className="text-[11px] font-bold text-indigo-800">
              {pendingAction === "input" ? "S 输入模式" : pendingAction === "click" ? "空格点击模式" : (appMode === "entry" || addingStepMode === "entry") ? "录入流 · 步骤配置" : "LOOP 步骤配置"}
            </span>
            {appMode === "loop" && (
              <span className="ml-auto flex items-center gap-1 text-[9px] text-indigo-500">
                <span className={["rounded px-1 py-0.5", reviewCount > 0 ? "bg-sky-100 text-sky-700 font-semibold" : "bg-slate-100 text-slate-400"].join(" ")}>审查 {reviewCount}</span>
                <span className={["rounded px-1 py-0.5", entryCount > 0 ? "bg-violet-100 text-violet-700 font-semibold" : "bg-slate-100 text-slate-400"].join(" ")}>录入 {entryCount}</span>
              </span>
            )}
          </div>

          {appMode === "entry" ? (
            <div className="space-y-1.5">
              <p className="text-[11px] leading-relaxed text-slate-600">
                录入流 LOOP：点击右侧表单输入框 → 按 S → 点击左侧 Excel 对应字段，重复配置所有字段，最后按空格点击保存/提交按钮。
              </p>
              {/* 回访查看步骤（右侧网页）：录入模式的查看界面/步骤与审查模式不同，需单独录制搜索定位流程 */}
              <div className="flex items-center gap-2 text-[11px]">
                <span className={[
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                  hasBoundInputs || preClickCount > 0 || postClickCount > 0 ? "bg-emerald-500" : "bg-amber-500",
                ].join(" ")}>
                  {hasBoundInputs || preClickCount > 0 || postClickCount > 0 ? <Check className="h-2.5 w-2.5" /> : "查"}
                </span>
                <div className="flex flex-1 flex-wrap items-center gap-1.5">
                  {bindInputSide ? (
                    <>
                      <span className="step-highlight" key="entry-revisit-bind">
                        回访录制中 — 点右侧搜索输入框绑定「{rightBindColumn || selectedExcelColumn}」，点按钮/链接=真实点击（已 {bindStepCount} 步）
                      </span>
                      {rightBindPicker}
                      {onExitBindInputs && (
                        <button
                          onClick={onExitBindInputs}
                          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-slate-200 px-2.5 text-[11px] font-medium text-slate-700 transition-all hover:bg-slate-300"
                        >
                          完成
                        </button>
                      )}
                    </>
                  ) : pendingAction === "click" && addingClickMode ? (
                    <>
                      <span className="step-highlight" key="entry-revisit-click">
                        正在添加{addingClickPhase === "post" ? "收尾" : "前置"}点击 — 点击右侧网页的搜索/确认人物/返回等按钮
                      </span>
                      {onExitAddClickMode && (
                        <button
                          onClick={onExitAddClickMode}
                          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-slate-200 px-2.5 text-[11px] font-medium text-slate-700 transition-all hover:bg-slate-300"
                        >
                          完成
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="text-slate-500">回访查看（右侧网页搜索→确认人物）：</span>
                      {hasBoundInputs && <span className="rounded bg-emerald-100 px-1 text-emerald-700">输入✓</span>}
                      {preClickCount > 0 && <span className="rounded bg-sky-100 px-1 text-sky-700">前置 {preClickCount}</span>}
                      {postClickCount > 0 && <span className="rounded bg-amber-100 px-1 text-amber-700">收尾 {postClickCount}</span>}
                      {onStartBindInputs && !addingStepMode && (
                        <button
                          onClick={() => {
                            if (onExitAddClickMode) onExitAddClickMode();
                            onStartBindInputs();
                          }}
                          disabled={!selectedExcelColumn}
                          className={[
                            "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition-all",
                            selectedExcelColumn
                              ? "bg-brand-600 text-white hover:bg-brand-700"
                              : "cursor-not-allowed bg-slate-200 text-slate-400",
                          ].join(" ")}
                        >
                          <Plus className="h-3 w-3" />
                          搜索输入
                        </button>
                      )}
                      {rightBindPicker}
                      {onStartAddPreClick && !addingStepMode && (
                        <button
                          onClick={onStartAddPreClick}
                          disabled={!!bindInputSide}
                          className={[
                            "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition-all",
                            bindInputSide
                              ? "cursor-not-allowed bg-slate-200 text-slate-400"
                              : "bg-sky-600 text-white hover:bg-sky-700",
                          ].join(" ")}
                        >
                          <Plus className="h-3 w-3" />
                          前置点击
                        </button>
                      )}
                      {onStartAddPostClick && !addingStepMode && (
                        <button
                          onClick={onStartAddPostClick}
                          disabled={!!bindInputSide}
                          className={[
                            "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition-all",
                            bindInputSide
                              ? "cursor-not-allowed bg-slate-200 text-slate-400"
                              : "bg-amber-500 text-white hover:bg-amber-600",
                          ].join(" ")}
                        >
                          <Plus className="h-3 w-3" />
                          收尾点击
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              {/* Step 1 */}
              <div className="flex items-center gap-2 text-[11px]">
                <span className={[
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                  selectedExcelColumn ? "bg-emerald-500" : "bg-amber-500",
                ].join(" ")}>
                  {selectedExcelColumn ? <Check className="h-2.5 w-2.5" /> : 1}
                </span>
                <div className="flex flex-1 flex-wrap items-center gap-1.5">
                  {selectedExcelColumn ? (
                    <>
                      <span className="text-emerald-700 font-medium">
                        ✓ LOOP 列「{selectedExcelColumn}」
                      </span>
                      {cardsGenerated ? (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700">
                          <Users className="h-2.5 w-2.5" />
                          已生成 {rowRange ? rowRange.end - rowRange.start + 1 : 0} 张卡片
                        </span>
                      ) : (
                        <>
                          <ArrowRight className="h-3 w-3 text-amber-500 shrink-0" />
                          <span className="step-highlight" key={selectedExcelColumn || "step1b"}>
                            在 LOOP 列内选中具体卡片，然后点击「一键生成卡片」
                          </span>
                        </>
                      )}
                    </>
                  ) : (
                    <span className="step-highlight" key="step1a">
                      在 Excel 视图点击一列表头选中 LOOP 列
                    </span>
                  )}
                </div>
              </div>

              {/* Step 2（可选）：仅当 LOOP 列需要填入输入框或做前置点击时才配置 */}
              <div className="flex items-center gap-2 text-[11px]">
                <span className={[
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                  bindInputSide ? "bg-amber-500" : hasBoundInputs ? "bg-emerald-500" : cardsGenerated ? "bg-amber-500" : "bg-slate-300",
                ].join(" ")}>
                  {hasBoundInputs && !bindInputSide ? <Check className="h-2.5 w-2.5" /> : 2}
                </span>
                <div className="flex flex-1 flex-wrap items-center gap-1.5">
                  {bindInputSide ? (
                    <>
                      <span className="step-highlight" key="step2-active">
                        教学拾取中 — 点任意侧输入框绑定「{selectedExcelColumn}」，点按钮/链接=真实点击（已 {bindStepCount} 步）
                      </span>
                      {rightBindPicker}
                      {onExitBindInputs && (
                        <button
                          onClick={onExitBindInputs}
                          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-slate-200 px-2.5 text-[11px] font-medium text-slate-700 transition-all hover:bg-slate-300"
                        >
                          完成
                        </button>
                      )}
                    </>
                  ) : hasBoundInputs ? (
                    <>
                      <span className="text-emerald-700 font-medium">✓ 已绑定输入框/点击 <span className="text-slate-400 font-normal">（点击已选元素可回收重选）</span></span>
                      {onStartBindInputs && !addingStepMode && (
                        <button
                          onClick={() => {
                            if (onExitAddClickMode) onExitAddClickMode();
                            onStartBindInputs();
                          }}
                          disabled={!selectedExcelColumn}
                          className={[
                            "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition-all",
                            selectedExcelColumn
                              ? "bg-brand-600 text-white hover:bg-brand-700"
                              : "cursor-not-allowed bg-slate-200 text-slate-400",
                          ].join(" ")}
                        >
                          <Plus className="h-3 w-3" />
                          继续绑定
                        </button>
                      )}
                      {rightBindPicker}
                    </>
                  ) : cardsGenerated ? (
                    <>
                      <ArrowRight className="h-3 w-3 text-amber-500 shrink-0" />
                      <span className="step-highlight" key="step2-idle">
                        如需搜索定位人物，点击「搜索输入」
                      </span>
                      <button
                        onClick={() => {
                          if (onExitAddClickMode) onExitAddClickMode();
                          onStartBindInputs?.();
                        }}
                        disabled={!selectedExcelColumn}
                        className={[
                          "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition-all",
                          selectedExcelColumn
                            ? "bg-brand-600 text-white hover:bg-brand-700"
                            : "cursor-not-allowed bg-slate-200 text-slate-400",
                        ].join(" ")}
                      >
                        搜索输入
                      </button>
                      {rightBindPicker}
                    </>
                  ) : (
                    <span className="text-slate-400">搜索输入（生成卡片后可配置）</span>
                  )}
                </div>
              </div>

              {/* Step 3 — 前置点击任务（搜索/进入卡片页面，支持多个） */}
              <div className="flex items-center gap-2 text-[11px]">
                <span className={[
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                  pendingAction === "click" && addingClickMode && addingClickPhase === "pre" ? "bg-amber-500" :
                  preClickCount > 0 ? "bg-emerald-500" :
                  (reviewCount + entryCount + postClickCount === 0 && !addingStepMode && cardsGenerated && !bindInputSide && !(pendingAction === "click" && addingClickMode && addingClickPhase === "post")) ? "bg-amber-500" : "bg-slate-300",
                ].join(" ")}>
                  {preClickCount > 0 && !(pendingAction === "click" && addingClickMode && addingClickPhase === "pre") ? <Check className="h-2.5 w-2.5" /> : 3}
                </span>
                <div className="flex flex-1 flex-wrap items-center gap-1.5">
                  {pendingAction === "click" && addingClickMode && addingClickPhase === "pre" ? (
                    <>
                      <span className="step-highlight" key="step3-active">
                        正在添加前置点击（搜索/进入）— 点击任意侧网页上的元素（已添加 {preClickCount} 个）
                      </span>
                      {onExitAddClickMode && (
                        <button
                          onClick={onExitAddClickMode}
                          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-slate-200 px-2.5 text-[11px] font-medium text-slate-700 transition-all hover:bg-slate-300"
                        >
                          完成添加
                        </button>
                      )}
                    </>
                  ) : preClickCount > 0 ? (
                    <>
                      <span className="text-emerald-700 font-medium">✓ 已添加 {preClickCount} 个前置点击</span>
                      {onStartAddPreClick && !addingStepMode && !(pendingAction === "click" && addingClickMode && addingClickPhase === "post") && (
                        <button
                          onClick={onStartAddPreClick}
                          disabled={!!bindInputSide}
                          className={[
                            "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition-all",
                            bindInputSide
                              ? "cursor-not-allowed bg-slate-200 text-slate-400"
                              : "bg-orange-500 text-white hover:bg-orange-600",
                          ].join(" ")}
                        >
                          <Plus className="h-3 w-3" />
                          继续添加
                        </button>
                      )}
                    </>
                  ) : (reviewCount + entryCount + postClickCount === 0 && !addingStepMode && cardsGenerated && !bindInputSide) ? (
                    <>
                      <ArrowRight className="h-3 w-3 text-amber-500 shrink-0" />
                      <span className="step-highlight" key="step3-idle">
                        前置点击（搜索/进入卡片页面，如搜索按钮等）：
                      </span>
                      {onStartAddPreClick && (
                        <button
                          onClick={onStartAddPreClick}
                          disabled={!!bindInputSide}
                          className={[
                            "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition-all",
                            bindInputSide
                              ? "cursor-not-allowed bg-slate-200 text-slate-400"
                              : "bg-orange-500 text-white hover:bg-orange-600",
                          ].join(" ")}
                        >
                          <Plus className="h-3 w-3" />
                          添加前置点击
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      {onStartAddPreClick && !addingStepMode && !(pendingAction === "click" && addingClickMode && addingClickPhase === "post") && (
                        <button
                          onClick={onStartAddPreClick}
                          disabled={!!bindInputSide}
                          className={[
                            "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition-all",
                            bindInputSide
                              ? "cursor-not-allowed bg-slate-200 text-slate-400"
                              : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                          ].join(" ")}
                        >
                          <Plus className="h-3 w-3" />
                          添加前置点击
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Step 4 — 添加循环体内容 */}
              <div className="flex items-center gap-2 text-[11px]">
                <span className={[
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                  addingStepMode ? "bg-amber-500" :
                  (reviewCount + entryCount > 0) ? "bg-emerald-500" :
                  (postClickCount > 0 && !addingStepMode && !(pendingAction === "click" && addingClickMode && addingClickPhase === "post")) ? "bg-emerald-500" :
                  (cardsGenerated && !bindInputSide && !addingStepMode &&
                    !(pendingAction === "click" && addingClickMode && addingClickPhase === "pre") &&
                    (preClickCount > 0 || hasBoundInputs) &&
                    reviewCount + entryCount === 0 && postClickCount === 0) ? "bg-amber-500" : "bg-slate-300",
                ].join(" ")}>
                  {(reviewCount + entryCount > 0 || (postClickCount > 0 && !addingStepMode && !(pendingAction === "click" && addingClickMode && addingClickPhase === "post"))) ? <Check className="h-2.5 w-2.5" /> : 4}
                </span>
                <div className="flex flex-1 flex-wrap items-center gap-1.5">
                  {/* 活跃模式：正在添加审查/录入步骤 */}
                  {addingStepMode ? (
                    <>
                      <span className="step-highlight" key="step4-active">
                        正在添加{addingStepMode === "review" ? "审查" : "录入"}步骤 — {addingStepMode === "review" ? "选右侧元素 → 左侧来源 → 保存" : "选左侧来源 → 右侧输入框 → 保存"}
                      </span>
                      {/* 文件提取子步骤 */}
                      {addingStepMode && onStartAddDocExtract && !addingDocExtractMode && (
                        <button
                          onClick={onStartAddDocExtract}
                          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-teal-600 px-2.5 text-[11px] font-medium text-white transition-all hover:bg-teal-700"
                          title="添加文件提取步骤：支持本地上传按文件名匹配，或点击网页图片/PDF 自动下载提取"
                        >
                          <Plus className="h-3 w-3" />
                          文件提取{docExtractStepCount > 0 ? ` (${docExtractStepCount})` : ""}
                        </button>
                      )}
                      {/* 已绑定的文件上传步骤指示 */}
                      {docUploadStepCount > 0 && (
                        <span
                          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-orange-100 px-2 text-[11px] font-medium text-orange-700 ring-1 ring-orange-200"
                          title={`已绑定 ${docUploadStepCount} 个文件上传步骤：LOOP 执行时自动把提取的文件填入网页上传框`}
                        >
                          <Upload className="h-3 w-3" />
                          文件上传 ({docUploadStepCount})
                        </span>
                      )}
                      {addingDocExtractMode && docExtractSource === "choose" && (
                        <>
                          <span className="step-highlight" key="step4-docchoose">
                            文件提取 — 请在「文件处理」面板选择来源（网页 / 本地）
                          </span>
                          {onExitAddDocExtractMode && (
                            <button
                              onClick={onExitAddDocExtractMode}
                              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-slate-200 px-2.5 text-[11px] font-medium text-slate-700 transition-all hover:bg-slate-300"
                            >
                              取消
                            </button>
                          )}
                        </>
                      )}
                      {addingDocExtractMode && docExtractSource === "web" && (
                        <>
                          <span className="step-highlight" key="step4-docweb">
                            网页提取中 — 请在右侧网页点击元素
                            {docExtractStepCount > 0 ? `（已记录 ${docExtractStepCount} 步）` : ""}
                            ，详细配置见「文件处理」面板
                          </span>
                          {onExitAddDocExtractMode && (
                            <button
                              onClick={onExitAddDocExtractMode}
                              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-slate-200 px-2.5 text-[11px] font-medium text-slate-700 transition-all hover:bg-slate-300"
                            >
                              完成提取
                            </button>
                          )}
                        </>
                      )}
                      {addingDocExtractMode && docExtractSource === "local" && (
                        <div className="w-full rounded-lg border-2 border-teal-200 bg-teal-50/60 p-2">
                          <div className="mb-1 flex items-center gap-1.5">
                            <FolderOpen className="h-3 w-3 text-teal-700" />
                            <span className="text-[10px] font-bold text-teal-800">本地文件提取（目录模式）</span>
                            {onExitAddDocExtractMode && (
                              <button
                                onClick={onExitAddDocExtractMode}
                                className="ml-auto rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                          {docLocalPattern ? (
                            <div className="mb-1 rounded-md border border-teal-300 bg-teal-50 px-2 py-1">
                              <p className="font-mono text-[10px] font-bold text-teal-900">
                                {docLocalPattern}.<span className="text-teal-500">[jpg|png|pdf…]</span>
                              </p>
                              <p className="mt-0.5 text-[8px] text-teal-600">
                                字段「{docFileBindField}」· {docLocalDirFiles.length} 个文件
                              </p>
                            </div>
                          ) : (
                            <p className="mb-1 text-[9px] text-slate-500">
                              请在下方「文件处理」面板中配置：选择文件名 LOOP 字段 → 根文件夹 → 点选样本文件
                            </p>
                          )}
                        </div>
                      )}
                      {/* 自定义文本子步骤 */}
                      {addingStepMode && onToggleCustomText && !addingDocExtractMode && (
                        <button
                          onClick={onToggleCustomText}
                          className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition-all ${
                            customTextMode
                              ? "bg-violet-600 text-white hover:bg-violet-700"
                              : "bg-violet-100 text-violet-700 hover:bg-violet-200"
                          }`}
                          title="添加自定义文本框：手动输入临时内容，关联网页元素后可用于审查/录入"
                        >
                          <Type className="h-3 w-3" />
                          自定义文本{customTextEntries.length > 0 ? ` (${customTextEntries.length})` : ""}
                        </button>
                      )}
                      {customTextMode && (
                        <span className="step-highlight" key="step4-customtext">
                          自定义文本 — 请在右侧「提取元素」面板中添加文本框并拾取网页元素
                        </span>
                      )}
                      {/* 控件提取子步骤：点击展开型控件（下拉选项/日历） */}
                      {addingStepMode && onToggleWidgetExtract && !addingDocExtractMode && (
                        <button
                          onClick={onToggleWidgetExtract}
                          className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition-all ${
                            widgetExtractMode
                              ? "bg-fuchsia-600 text-white hover:bg-fuchsia-700"
                              : "bg-fuchsia-100 text-fuchsia-700 hover:bg-fuchsia-200"
                          }`}
                          title="提取点击展开型控件：下拉选项框 / 日历选择器，配置后可自动选择选项或设置日期"
                        >
                          <ListChecks className="h-3 w-3" />
                          控件提取{widgetCount > 0 ? ` (${widgetCount})` : ""}
                        </button>
                      )}
                      {widgetExtractMode && (
                        <span className="step-highlight" key="step4-widgetextract">
                          控件提取 — 请在右侧「提取元素」面板中选择控件类型并拾取网页元素
                        </span>
                      )}
                      {onExitAddingStepMode && (
                        <button
                          onClick={onExitAddingStepMode}
                          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-slate-200 px-2.5 text-[11px] font-medium text-slate-700 transition-all hover:bg-slate-300"
                        >
                          完成添加
                        </button>
                      )}
                      {reviewCount + entryCount > 0 && (
                        <span className="text-[10px] text-slate-400">
                          已有 {reviewCount + entryCount} 步
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      {reviewCount + entryCount > 0 ? (
                        <>
                          <span className="text-emerald-700 font-medium">
                            ✓ LOOP 内已配置 {reviewCount + entryCount} 个步骤
                            {reviewCount > 0 && <span className="ml-1 rounded bg-sky-100 px-1 text-sky-700">审查 {reviewCount}</span>}
                            {entryCount > 0 && <span className="ml-1 rounded bg-violet-100 px-1 text-violet-700">录入 {entryCount}</span>}
                          </span>
                        </>
                      ) : postClickCount > 0 ? (
                        <span className="text-slate-400">（已跳过循环体步骤）</span>
                      ) : (
                        cardsGenerated && !bindInputSide && !(pendingAction === "click" && addingClickMode && addingClickPhase === "post") ? (
                          <>
                            <ArrowRight className="h-3 w-3 text-amber-500 shrink-0" />
                            <span className="step-highlight" key="step4-idle">
                              LOOP 循环体内添加步骤：
                            </span>
                          </>
                        ) : (
                          <span className="text-slate-400">LOOP 循环体内添加步骤：</span>
                        )
                      )}
                      {onStartAddReviewSteps && (
                        <button
                          onClick={onStartAddReviewSteps}
                          disabled={!!bindInputSide || pendingAction === "click"}
                          className={[
                            "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition-all",
                            bindInputSide || pendingAction === "click"
                              ? "cursor-not-allowed bg-slate-200 text-slate-400"
                              : "bg-sky-600 text-white hover:bg-sky-700",
                          ].join(" ")}
                        >
                          <Plus className="h-3 w-3" />
                          审查步骤
                        </button>
                      )}
                      {onStartAddEntrySteps && (
                        <button
                          onClick={onStartAddEntrySteps}
                          disabled={!!bindInputSide || pendingAction === "click"}
                          className={[
                            "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition-all",
                            bindInputSide || pendingAction === "click"
                              ? "cursor-not-allowed bg-slate-200 text-slate-400"
                              : "bg-violet-600 text-white hover:bg-violet-700",
                          ].join(" ")}
                        >
                          <Plus className="h-3 w-3" />
                          录入步骤
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Step 5 — 收尾点击任务（保存/提交/返回，收尾本次 Loop） */}
              {cardsGenerated && (
                <div className="flex items-center gap-2 text-[11px]">
                  <span className={[
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                    addingClickMode && addingClickPhase === "post" ? "bg-amber-500" : postClickCount > 0 ? "bg-emerald-500" :
                    !addingStepMode && !bindInputSide && !(pendingAction === "click" && addingClickMode && addingClickPhase === "pre") ? "bg-amber-500" : "bg-slate-300",
                  ].join(" ")}>
                    {postClickCount > 0 && !(addingClickMode && addingClickPhase === "post") ? <Check className="h-2.5 w-2.5" /> : 5}
                  </span>
                  <div className="flex flex-1 flex-wrap items-center gap-1.5">
                    {addingClickMode && addingClickPhase === "post" ? (
                      <>
                        <span className="step-highlight" key="step5-active">
                          正在添加收尾点击（保存/返回）— 点击保存/提交/返回等按钮（已 {postClickCount} 个）
                        </span>
                        {onExitAddClickMode && (
                          <button
                            onClick={onExitAddClickMode}
                            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-slate-200 px-2.5 text-[11px] font-medium text-slate-700 transition-all hover:bg-slate-300"
                          >
                            完成点击
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        {postClickCount > 0 ? (
                          <span className="text-emerald-700 font-medium">✓ 已加 {postClickCount} 个收尾点击</span>
                        ) : (
                          !addingStepMode && !bindInputSide ? (
                            <>
                              <ArrowRight className="h-3 w-3 text-amber-500 shrink-0" />
                              <span className="step-highlight" key="step5-idle">
                                末尾可添加保存/提交/返回等收尾点击：
                              </span>
                            </>
                          ) : (
                            <span className="text-slate-400">末尾添加收尾点击（保存/提交/返回等）：</span>
                          )
                        )}
                        {onStartAddPostClick && !addingStepMode && !(addingClickMode && addingClickPhase === "pre") && (
                          <button
                            onClick={onStartAddPostClick}
                            disabled={!!bindInputSide}
                            className={[
                              "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium transition-all",
                              bindInputSide
                                ? "cursor-not-allowed bg-slate-200 text-slate-400"
                                : "bg-rose-500 text-white hover:bg-rose-600",
                            ].join(" ")}
                          >
                            <Plus className="h-3 w-3" />
                            {postClickCount > 0 ? "继续添加" : "添加收尾点击"}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepRow({
  active,
  done,
  icon,
  label,
  highlight,
  children,
}: {
  active: boolean;
  done: boolean;
  icon: React.ReactNode;
  label: string;
  highlight: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={[
        "flex items-start gap-1.5 rounded-lg px-2 py-1.5 transition-all",
        active ? "bg-white/70" : "bg-white/30",
        highlight ? "ring-1 ring-brand-300" : "",
      ].join(" ")}
    >
      <span
        className={[
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
          done
            ? "bg-emerald-500 text-white"
            : active
            ? "bg-brand-600 text-white"
            : "bg-slate-200 text-slate-500",
        ].join(" ")}
      >
        {done ? <Check className="h-2.5 w-2.5" /> : icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 text-[10px] font-medium text-slate-700">{label}</div>
        <div className="flex flex-wrap items-center gap-1.5">{children}</div>
      </div>
    </div>
  );
}

function PickedChip({
  label,
  sub,
  tone,
}: {
  label: string;
  sub: string;
  tone: "left" | "right";
}) {
  const cls = tone === "right"
    ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
    : "bg-blue-50 text-blue-700 ring-blue-200";
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium ring-1 ${cls}`}>
      <Database className="h-2.5 w-2.5" />
      <span className="font-sans font-medium">{label}</span>
      <code className="font-mono text-[9px] opacity-60">{sub}</code>
    </span>
  );
}
