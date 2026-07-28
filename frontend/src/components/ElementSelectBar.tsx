import { useEffect, useState } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  Check,
  CheckCircle2,
  Database,
  FileSpreadsheet,
  Globe,
  ListChecks,
  MousePointerClick,
  Play,
  Plus,
  Repeat2,
  RotateCcw,
  Users,
  X,
} from "lucide-react";
import type { AppMode, FieldMapping, LeftSource, TeachingPhase, VerifyMethod } from "../types";
import type { PickedElementInfo } from "./BrowserPane";

export type PickTarget = "right" | "left" | null;

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
  /** 是否处于添加点击按钮模式 */
  addingClickMode?: boolean;
  /** 已添加的点击按钮数量（确认人物之后） */
  clickStepCount?: number;
  /** 开始添加点击按钮 */
  onStartAddClickStep?: () => void;
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
  /** 已添加的文件提取步骤数 */
  docExtractStepCount?: number;
  /** 开始添加文件提取步骤（审查：右侧网页拾取） */
  onStartAddDocExtract?: () => void;
  /** 退出文件提取模式 */
  onExitAddDocExtractMode?: () => void;
  /** 录入步骤子步骤：本地文件提取（上传图片 → 勾选字段 → 填入右侧网页） */
  onDocFileExtract?: () => void;
  /** 人物卡片是否已生成 */
  cardsGenerated?: boolean;
  /** LOOP 行范围框选（0-based 闭区间） */
  rowRange?: { start: number; end: number } | null;
  /** 打开保存 SKILL 弹窗 */
  onRequestSaveSkill?: () => void;
  /** 打开保存 SKILL 弹窗并立即执行 */
  onRequestSaveSkillAndRun?: () => void;
}

export default function ElementSelectBar({
  active,
  pickTarget,
  rightPicked,
  leftPicked,
  excelFields,
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
addingClickMode = false,
clickStepCount = 0,
onStartAddClickStep,
onExitAddClickMode,
onSwapSide,
onUndo,
canUndo = false,
addingDocExtractMode = false,
docExtractStepCount = 0,
onStartAddDocExtract,
onExitAddDocExtractMode,
onDocFileExtract,
cardsGenerated = false,
rowRange = null,
onRequestSaveSkill,
onRequestSaveSkillAndRun,
}: Props) {
  const [leftSource, setLeftSource] = useState<LeftSource>("database");
  const [excelField, setExcelField] = useState<string>("");
  const [method, setMethod] = useState<VerifyMethod>("smart");

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

  if (!active) return null;

  // 步骤判定（审查模式：先右侧元素 → 后左侧来源；录入模式：先左侧来源 → 后右侧输入框，顺序相反）
  const isEntryMode = addingStepMode === "entry";
  const leftDone = !!leftPicked || (leftSource === "excel" && !!excelField) || leftSource === "manual";
  const step = isEntryMode
    ? (leftDone ? (rightPicked ? 3 : 2) : 1)
    : (rightPicked ? (leftDone ? 3 : 2) : 1);

  const canSave = Boolean(rightPicked && (leftPicked || (leftSource === "excel" && excelField) || leftSource === "manual"));

  // 当前左侧来源是否处于网页/Excel 激活态（避免 TS 在 JSX 里对 pickTarget 做多余窄化报错）
  const webSourceActive = pickTarget === "left" || (pickTarget == null && leftSource === "database");
  const excelSourceActive = leftSource === "excel" && pickTarget == null;

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
                ? "border-brand-400 bg-brand-50 text-brand-700 ring-1 ring-brand-300 animate-glow-pulse"
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
    <div className="flex h-full w-full flex-col rounded-lg bg-white px-3 py-2">
      {/* 顶部：标题 + 步骤指示 + 取消 */}
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-indigo-600" />
          <span className="text-sm font-semibold text-slate-800">
            {addingStepMode === "review" ? "添加审查步骤 · 选择映射" : addingStepMode === "entry" ? "添加录入步骤 · 选择映射" : "步骤设置 · 元素选择"}
          </span>
          <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-medium text-brand-700">
            已配 {mappingCount} 项
          </span>
          {/* 完成按钮组：保存为 SKILL / 保存并执行 */}
          {onRequestSaveSkill && teachingPhase !== "idle" && (
            <button
              onClick={onRequestSaveSkill}
              disabled={
                (teachingPhase === "data-source" ? dataSourceCount : teachingPhase === "entry" ? entryCount : reviewCount) === 0
              }
              className={[
                "flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                (teachingPhase === "data-source" ? dataSourceCount : teachingPhase === "entry" ? entryCount : reviewCount) === 0
                  ? "cursor-not-allowed bg-slate-200 text-slate-400"
                  : "bg-emerald-600 text-white hover:bg-emerald-700",
              ].join(" ")}
            >
              <CheckCircle2 className="h-3 w-3" />
              保存为 SKILL
            </button>
          )}
          {onRequestSaveSkillAndRun && appMode !== "review" && teachingPhase !== "idle" && (
            <button
              onClick={onRequestSaveSkillAndRun}
              disabled={(appMode === "entry" ? entryCount : dataSourceCount + reviewCount) === 0}
              className={[
                "flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                (appMode === "entry" ? entryCount : dataSourceCount + reviewCount) === 0
                  ? "cursor-not-allowed bg-slate-200 text-slate-400"
                  : "bg-brand-600 text-white hover:bg-brand-700",
              ].join(" ")}
            >
              <Play className="h-3 w-3" />
              保存并执行
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
                      ? "bg-indigo-600 text-white animate-glow-pulse"
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
          {onUndo && (
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
      <div className={[
        "flex-1 overflow-y-auto pr-1",
        addingStepMode ? "mt-1.5 space-y-1.5 rounded-xl border-2 border-indigo-200 bg-gradient-to-br from-indigo-50/70 to-violet-50/40 px-2.5 py-2 shadow-sm" : "space-y-2.5",
        teachingPhase !== "idle" && !addingStepMode ? "mt-1.5 space-y-1.5 rounded-xl border-2 border-indigo-200 bg-gradient-to-br from-indigo-50/70 to-violet-50/40 px-2.5 py-2 shadow-sm" : "",
        "order-2",
      ].join(" ")}>
        {/* LOOP流程中，在子面板顶部显示步骤指示器（与 LOOP 向导同款紧凑风格） */}
        {teachingPhase !== "idle" && (
          <div className="mb-1 flex items-center gap-1.5 border-b border-indigo-100 pb-1.5">
            <Repeat2 className="h-3 w-3 text-indigo-600" />
            <span className="text-[10px] font-bold text-indigo-800">映射配置</span>
            <div className="ml-auto flex items-center gap-1">
              {[1, 2, 3].map((n) => (
                <span
                  key={n}
                  className={[
                    "flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold transition-all",
                    n < step
                      ? "bg-emerald-500 text-white"
                      : n === step
                      ? "bg-indigo-600 text-white animate-glow-pulse"
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

      {/* LOOP 步骤配置向导（主流程面板，固定在上方） */}
      {teachingPhase !== "idle" && (
        <div className="shrink-0 order-1 mb-1 rounded-xl border-2 border-indigo-200 bg-gradient-to-br from-indigo-50/70 to-violet-50/40 px-3 py-2 shadow-sm">
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
            <p className="text-[11px] leading-relaxed text-slate-600">
              录入流 LOOP：点击右侧表单输入框 → 按 S → 点击左侧 Excel 对应字段，重复配置所有字段，最后按空格点击保存/提交按钮。
            </p>
          ) : (
            <div className="space-y-1.5">
              {/* Step 1 */}
              <div className="flex items-center gap-2 text-[11px]">
                <span className={[
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                  selectedExcelColumn ? "bg-emerald-500" : "bg-slate-300",
                ].join(" ")}>
                  {selectedExcelColumn ? <Check className="h-2.5 w-2.5" /> : 1}
                </span>
                <div className={`flex flex-1 flex-wrap items-center gap-1.5 rounded-md ${selectedExcelColumn ? "picking-breath" : ""}`}>
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
                        <span className="text-indigo-700 font-medium animate-glow-pulse">
                          → 到 Excel 视图点行号框选范围，再点「一键生成卡片」
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-brand-700 font-medium animate-glow-pulse">
                      在 Excel 视图点击一列表头选中 LOOP 列
                    </span>
                  )}
                </div>
              </div>

              {/* Step 2（可选）：仅当 LOOP 列需要填入输入框或做前置点击时才配置 */}
              <div className="flex items-center gap-2 text-[11px]">
                <span className={[
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                  bindInputSide ? "bg-brand-600 animate-glow-pulse" : hasBoundInputs ? "bg-emerald-500" : "bg-slate-300",
                ].join(" ")}>
                  {hasBoundInputs && !bindInputSide ? <Check className="h-2.5 w-2.5" /> : 2}
                </span>
                <div className="flex flex-1 flex-wrap items-center gap-1.5">
                  <span className="rounded bg-slate-100 px-1 py-0.5 text-[9px] font-medium text-slate-500">可选</span>
                  {bindInputSide ? (
                    <>
                      <span className="text-brand-700 font-medium animate-glow-pulse">
                        教学拾取中 — 点任意侧输入框=绑定「{selectedExcelColumn}」并填入第一行；点按钮/链接=真实点击（已 {bindStepCount} 步）
                      </span>
                      {onExitBindInputs && (
                        <button
                          onClick={onExitBindInputs}
                          className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-300"
                        >
                          完成
                        </button>
                      )}
                    </>
                  ) : hasBoundInputs ? (
                    <>
                      <span className="text-emerald-700 font-medium">✓ 已绑定输入框/点击 <span className="text-slate-400 font-normal">（点击已选元素可回收重选）</span></span>
                      {onStartBindInputs && (
                        <button
                          onClick={onStartBindInputs}
                          disabled={!selectedExcelColumn || pendingAction === "click"}
                          className={[
                            "flex items-center gap-0.5 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                            selectedExcelColumn && pendingAction !== "click"
                              ? "bg-brand-600 text-white hover:bg-brand-700"
                              : "cursor-not-allowed bg-slate-200 text-slate-400",
                          ].join(" ")}
                        >
                          <Plus className="h-2.5 w-2.5" />
                          继续绑定
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        onClick={onStartBindInputs}
                        disabled={!selectedExcelColumn || pendingAction === "click"}
                        className={[
                          "rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                          selectedExcelColumn && pendingAction !== "click"
                            ? "bg-brand-600 text-white hover:bg-brand-700"
                            : "cursor-not-allowed bg-slate-200 text-slate-400",
                        ].join(" ")}
                      >
                        搜索输入
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Step 3 — 点击任务（支持单侧网页点击，可添加多个） */}
              <div className="flex items-center gap-2 text-[11px]">
                <span className={[
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                  pendingAction === "click" && addingClickMode ? "bg-orange-500 animate-glow-pulse" :
                  clickStepCount > 0 ? "bg-emerald-500" : "bg-slate-300",
                ].join(" ")}>
                  {clickStepCount > 0 && !(pendingAction === "click" && addingClickMode) ? <Check className="h-2.5 w-2.5" /> : 3}
                </span>
                <div className="flex flex-1 flex-wrap items-center gap-1.5">
                  {pendingAction === "click" && addingClickMode ? (
                    <>
                      <span className="text-orange-700 font-medium animate-glow-pulse">
                        正在添加点击任务 — 点击任意侧网页上的元素（已添加 {clickStepCount} 个）
                      </span>
                      {onExitAddClickMode && (
                        <button
                          onClick={onExitAddClickMode}
                          className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-300"
                        >
                          完成添加
                        </button>
                      )}
                    </>
                  ) : clickStepCount > 0 ? (
                    <>
                      <span className="text-emerald-700 font-medium">✓ 已添加 {clickStepCount} 个点击任务</span>
                      {onStartAddClickStep && !addingStepMode && (
                        <button
                          onClick={onStartAddClickStep}
                          disabled={!!bindInputSide}
                          className={[
                            "flex items-center gap-0.5 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                            bindInputSide
                              ? "cursor-not-allowed bg-slate-200 text-slate-400"
                              : "bg-orange-500 text-white hover:bg-orange-600",
                          ].join(" ")}
                        >
                          <Plus className="h-2.5 w-2.5" />
                          继续添加
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="text-slate-500">点击任意侧网页元素（可添加多个）</span>
                      <button
                        onClick={onStartAddClickStep}
                        disabled={!!bindInputSide}
                        className={[
                          "rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                          bindInputSide
                            ? "cursor-not-allowed bg-slate-200 text-slate-400"
                            : "bg-brand-600 text-white hover:bg-brand-700",
                        ].join(" ")}
                      >
                        点击任务
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Step 4 — 添加循环体内容 */}
              <div className="flex items-start gap-2 text-[11px]">
                <span className={[
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                  addingStepMode ? "bg-brand-600 animate-glow-pulse" : reviewCount + entryCount > 0 ? "bg-emerald-500" : "bg-slate-300",
                ].join(" ")}>
                  {reviewCount + entryCount > 0 && !addingStepMode ? <Check className="h-2.5 w-2.5" /> : 4}
                </span>
                <div className="flex flex-1 flex-wrap items-center gap-1.5">
                  {/* 活跃模式：正在添加审查/录入步骤 */}
                  {addingStepMode ? (
                    <>
                      <span className="text-brand-700 font-medium animate-glow-pulse">
                        正在添加{addingStepMode === "review" ? "审查" : "录入"}步骤 — {addingStepMode === "review" ? "在下方配置映射：选择右侧元素 → 左侧来源 → 保存" : "在下方配置映射：选择左侧来源 → 右侧输入框 → 保存"}
                      </span>
                      {/* 文件提取子步骤：审查=点击右侧网页下载按钮/图片；录入=上传本地图片勾选字段 */}
                      {addingStepMode === "review" && onStartAddDocExtract && !addingDocExtractMode && (
                        <button
                          onClick={onStartAddDocExtract}
                          className="flex items-center gap-0.5 rounded-md bg-teal-600 px-2 py-0.5 text-[10px] font-medium text-white transition-all hover:bg-teal-700"
                          title="点击右侧网页上的下载按钮/图片/PDF 进行文字提取"
                        >
                          <Plus className="h-2.5 w-2.5" />
                          文件提取{docExtractStepCount > 0 ? ` (${docExtractStepCount})` : ""}
                        </button>
                      )}
                      {addingStepMode === "entry" && onDocFileExtract && (
                        <button
                          onClick={onDocFileExtract}
                          className="flex items-center gap-0.5 rounded-md bg-teal-600 px-2 py-0.5 text-[10px] font-medium text-white transition-all hover:bg-teal-700"
                          title="上传本地图片/PDF，勾选提取的字段后填入右侧网页"
                        >
                          <Plus className="h-2.5 w-2.5" />
                          文件提取
                        </button>
                      )}
                      {addingDocExtractMode && (
                        <>
                          <span className="text-teal-700 font-medium animate-glow-pulse">
                            文件提取中 — 请点击右侧网页的下载按钮 / 图片 / PDF
                            {docExtractStepCount > 0 ? `（已 ${docExtractStepCount} 个）` : ""}
                          </span>
                          {onExitAddDocExtractMode && (
                            <button
                              onClick={onExitAddDocExtractMode}
                              className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-300"
                            >
                              退出提取
                            </button>
                          )}
                        </>
                      )}
                      {onExitAddingStepMode && (
                        <button
                          onClick={onExitAddingStepMode}
                          className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-300"
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
                        <span className="text-emerald-700 font-medium">
                          ✓ LOOP 内已配置 {reviewCount + entryCount} 个步骤
                          {reviewCount > 0 && <span className="ml-1 rounded bg-sky-100 px-1 text-sky-700">审查 {reviewCount}</span>}
                          {entryCount > 0 && <span className="ml-1 rounded bg-violet-100 px-1 text-violet-700">录入 {entryCount}</span>}
                        </span>
                      ) : (
                        <span className="text-slate-500">
                          LOOP 循环体内添加步骤：
                        </span>
                      )}
                      {onStartAddReviewSteps && (
                        <button
                          onClick={onStartAddReviewSteps}
                          disabled={!!bindInputSide || pendingAction === "click"}
                          className={[
                            "flex items-center gap-0.5 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                            bindInputSide || pendingAction === "click"
                              ? "cursor-not-allowed bg-slate-200 text-slate-400"
                              : "bg-sky-600 text-white hover:bg-sky-700",
                          ].join(" ")}
                        >
                          <Plus className="h-2.5 w-2.5" />
                          审查步骤
                        </button>
                      )}
                      {onStartAddEntrySteps && (
                        <button
                          onClick={onStartAddEntrySteps}
                          disabled={!!bindInputSide || pendingAction === "click"}
                          className={[
                            "flex items-center gap-0.5 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                            bindInputSide || pendingAction === "click"
                              ? "cursor-not-allowed bg-slate-200 text-slate-400"
                              : "bg-violet-600 text-white hover:bg-violet-700",
                          ].join(" ")}
                        >
                          <Plus className="h-2.5 w-2.5" />
                          录入步骤
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Step 5 — 末尾点击任务（收尾：保存/提交/返回等） */}
              {(reviewCount > 0 || entryCount > 0) && (
                <div className="flex items-start gap-2 text-[11px]">
                  <span className={[
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                    addingClickMode ? "bg-orange-500 animate-glow-pulse" : clickStepCount > 0 ? "bg-emerald-500" : "bg-slate-300",
                  ].join(" ")}>
                    {clickStepCount > 0 && !addingClickMode ? <Check className="h-2.5 w-2.5" /> : 5}
                  </span>
                  <div className="flex flex-1 flex-wrap items-center gap-1.5">
                    {addingClickMode ? (
                      <>
                        <span className="text-orange-700 font-medium animate-glow-pulse">
                          正在添加点击任务 — 点击任意侧网页上的按钮/链接（保存、提交、返回等，已 {clickStepCount} 个）
                        </span>
                        {onExitAddClickMode && (
                          <button
                            onClick={onExitAddClickMode}
                            className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-300"
                          >
                            完成点击
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        {clickStepCount > 0 ? (
                          <span className="text-emerald-700 font-medium">✓ 已加 {clickStepCount} 个收尾点击</span>
                        ) : (
                          <span className="text-slate-500">末尾添加点击任务（保存/提交/返回等）：</span>
                        )}
                        {onStartAddClickStep && !addingStepMode && (
                          <button
                            onClick={onStartAddClickStep}
                            disabled={!!bindInputSide}
                            className={[
                              "flex items-center gap-0.5 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                              bindInputSide
                                ? "cursor-not-allowed bg-slate-200 text-slate-400"
                                : "bg-orange-500 text-white hover:bg-orange-600",
                            ].join(" ")}
                          >
                            <Plus className="h-2.5 w-2.5" />
                            {clickStepCount > 0 ? "继续添加" : "添加点击任务"}
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
