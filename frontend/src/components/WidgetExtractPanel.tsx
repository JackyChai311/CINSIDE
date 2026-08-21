/**
 * 控件提取面板：点击展开型控件（选项控件 / 日历控件）的提取、标注与绑定
 *
 * 布局：提取入口按钮行 → 草稿卡片（快照后待保存）→ 已保存控件卡片列表
 * 人类交互：
 *  - 选项控件：以可视化模拟显示（触发框 + 展开选项面板），点击选项可标注别名
 *  - 日历控件：以可视化模拟显示（触发框 + 模拟日历面板），各角色元素高亮标注
 *  - 每个卡片可绑定左侧来源（Excel / 左网页 / 护照 / 固定值）并「试跑」验证
 */
import { useState } from "react";
import {
  CalendarDays,
  Check,
  ChevronDown,
  Crosshair,
  Database,
  FileSpreadsheet,
  Globe,
  List,
  Loader2,
  Lock,
  Play,
  Plus,
  Save,
  Tag,
  Trash2,
  Type,
  X,
} from "lucide-react";
import type { CalendarRole, FieldMapping, LeftSource, WidgetDef } from "../types";
import type { CalendarMirrorAction } from "../lib/widgetScripts";

/** 试跑结果 */
export interface WidgetTestResult {
  ok: boolean;
  message: string;
}

/** 控件左侧绑定（草稿卡片用，保存时写入 FieldMapping） */
export interface WidgetBinding {
  leftSource: LeftSource;
  leftField: string;
  /** 左网页拾取时的元素标签（显示用） */
  leftLabel?: string;
}

interface Props {
  /** 正在拾取触发框的控件类型（null=未在拾取） */
  pickingKind: "option" | "calendar" | null;
  /** 快照脚本执行中 */
  snapshotBusy: boolean;
  /** 快照失败提示（显示一会儿） */
  snapshotError?: string | null;
  /** 草稿控件（刚快照完，待绑定保存） */
  draft: WidgetDef | null;
  /** 草稿卡片的左侧绑定 */
  draftBinding: WidgetBinding;
  /** 已保存的控件映射（mappings 中带 widget 的） */
  savedWidgets: Array<{ mapping: FieldMapping; widget: WidgetDef }>;
  /** 当前记录的 Excel 字段列表 */
  excelFields: string[];
  /** 当前选中记录的字段值（试跑取值预览） */
  recordFields: Record<string, string>;
  /** 正在重选角色的 key（"draft:prevMonth" 或 "saved:<selector>:prevMonth"） */
  rolePickingKey: string | null;
  /** 正在重选单个选项的 key（"draft:option:0" 或 "saved:<selector>:option:2"） */
  optionPickingKey: string | null;
  /** 正在从左侧网页拾取来源的 key（"draft" 或 "saved:<selector>"） */
  leftPickingKey: string | null;
  /** 试跑结果（key：草稿="draft"，已保存="saved:<selector>"） */
  testResults: Record<string, WidgetTestResult>;
  /** 试跑执行中 */
  testBusyKey: string | null;
  /** 日历引导式拾取状态（null=未在引导中） */
  calGuide: { stepIdx: number; total: number; role: CalendarRole; label: string; required: boolean } | null;
  /** 日格子多选：当前已点选的日格子数量 */
  calDayCellCount: number;
  /** 日格子多选：完成点选（统一收集全部日格子并推进引导） */
  onFinishDayCells: () => void;
  /** 跳过当前可选步骤 */
  onSkipGuideStep: () => void;
  /** 取消引导式拾取 */
  onCancelGuide: () => void;
  /** 日历快照未检测到面板（可手动点选面板兜底） */
  calPanelPickFailed: boolean;
  /** 手动面板点选模式：idle=未启用 / await-open=等待用户手动点开日历 / picking=点选面板中 */
  calPanelPickMode: "idle" | "await-open" | "picking";
  /** 手动面板兜底当前针对的控件类型（UI 文案/图标分支用） */
  panelPickKind?: "option" | "calendar" | null;
  /** 用户已手动点开日历 → 开始点选面板 */
  onCalPanelPickArm: () => void;
  /** 取消手动面板点选 */
  onCalPanelPickCancel: () => void;
  onStartPick: (kind: "option" | "calendar") => void;
  onCancelPick: () => void;
  onDraftChange: (widget: WidgetDef) => void;
  onDraftBindingChange: (binding: WidgetBinding) => void;
  onSaveDraft: () => void;
  onDiscardDraft: () => void;
  onUpdateSaved: (rightSelector: string, widget: WidgetDef) => void;
  onUpdateSavedBinding: (rightSelector: string, binding: WidgetBinding) => void;
  onRemoveSaved: (rightSelector: string) => void;
  /** 请求重选角色（App 端打开面板并进入拾取） */
  onPickRole: (key: string, role: CalendarRole) => void;
  /** 请求重选单个选项元素 */
  onPickOption: (key: string, optionIndex: number) => void;
  /** 请求从左侧网页拾取来源元素 */
  onPickLeftWeb: (key: string) => void;
  /** 正在从「提取结果」拾取护照字段的 key */
  passportPickingKey: string | null;
  /** 请求从「提取结果」面板拾取护照字段 */
  onPickPassportField: (key: string) => void;
  /** 试跑（App 端解析左侧值并执行控件脚本） */
  onTest: (testKey: string, widget: WidgetDef, binding: WidgetBinding) => void;
  /** 日历镜像：每个卡片当前显示的年月（与网页真实日历同步） */
  calendarState: Record<string, { year: number; month: number } | null>;
  /** 日历镜像操作执行中 */
  calendarBusyKey: string | null;
  /** 日历镜像操作：点击面板按钮 → 真实点网页对应按钮 → 刷新年月 */
  onCalendarMirror: (mirrorKey: string, widget: WidgetDef, action: CalendarMirrorAction) => void;
}

/** 日历角色显示名 */
const ROLE_LABELS: Record<string, string> = {
  header: "年月显示",
  year: "年显示",
  month: "月显示",
  prevYear: "上一年",
  nextYear: "下一年",
  prevMonth: "上一月",
  nextMonth: "下一月",
  dayCell: "日格子",
};

/** 角色对应的 CalendarControls 字段 */
const ROLE_FIELD: Record<string, string> = {
  header: "headerSelector",
  year: "yearSelector",
  month: "monthSelector",
  prevYear: "prevYearSelector",
  nextYear: "nextYearSelector",
  prevMonth: "prevMonthSelector",
  nextMonth: "nextMonthSelector",
  dayCell: "dayCellSelector",
};

/** 来源类型选项 */
const SOURCE_OPTIONS: Array<{ value: LeftSource; label: string; icon: React.ReactNode }> = [
  { value: "excel", label: "Excel", icon: <FileSpreadsheet className="h-2.5 w-2.5" /> },
  { value: "database", label: "左网页", icon: <Globe className="h-2.5 w-2.5" /> },
  { value: "passport", label: "护照", icon: <Database className="h-2.5 w-2.5" /> },
  { value: "manual", label: "固定值", icon: <Type className="h-2.5 w-2.5" /> },
];

/** 选项芯片：点击标注别名 */
function OptionChip({
  text,
  alias,
  onAliasChange,
}: {
  text: string;
  alias?: string;
  onAliasChange: (alias: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(alias || "");
  if (editing) {
    return (
      <input
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => {
          onAliasChange(val.trim());
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onAliasChange(val.trim());
            setEditing(false);
          } else if (e.key === "Escape") {
            setVal(alias || "");
            setEditing(false);
          }
        }}
        placeholder="别名=左侧值"
        className="w-24 rounded border border-violet-400 bg-white px-1 py-0.5 text-[9px] text-violet-700 outline-none"
        title="当左侧值与选项文字不同时，在这里填触发词，多个用斜杠分隔（如 FEMALE/F/woman，任一命中即可；大小写不区分)"
      />
    );
  }
  return (
    <button
      onClick={() => {
        setVal(alias || "");
        setEditing(true);
      }}
      className={`inline-flex max-w-[140px] items-center gap-0.5 truncate rounded border px-1.5 py-0.5 text-[9px] transition-colors ${
        alias
          ? "border-violet-300 bg-violet-100 text-violet-700 ring-1 ring-violet-200"
          : "border-slate-200 bg-slate-50 text-slate-600 hover:border-violet-200 hover:bg-violet-50"
      }`}
      title={alias ? `触发词「${alias}」— 点击修改（多个用斜杠分隔，大小写不区分）` : "点击标注触发词（左侧值与选项文字不同时使用，多个用斜杠分隔）"}
    >
      <span className="truncate">{text}</span>
      {alias && (
        <span className="ml-0.5 inline-flex shrink-0 items-center gap-0.5 rounded bg-violet-200/70 px-0.5 text-[8px] text-violet-800">
          <Tag className="h-2 w-2" />
          {alias}
        </span>
      )}
    </button>
  );
}

/** 来源绑定行（草稿/已保存共用） */
function BindingRow({
  binding,
  excelFields,
  recordFields,
  pickKey,
  leftPickingKey,
  passportPickingKey,
  onChange,
  onPickLeftWeb,
  onPickPassportField,
}: {
  binding: WidgetBinding;
  excelFields: string[];
  recordFields: Record<string, string>;
  pickKey: string;
  leftPickingKey: string | null;
  passportPickingKey: string | null;
  onChange: (b: WidgetBinding) => void;
  onPickLeftWeb: (key: string) => void;
  onPickPassportField: (key: string) => void;
}) {
  const pickingThis = leftPickingKey === pickKey;
  const passportPickingThis = passportPickingKey === pickKey;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <span className="shrink-0 text-[9px] text-slate-400">左侧来源</span>
        <div className="flex flex-1 items-center gap-0.5">
          {SOURCE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                const next: WidgetBinding = { ...binding, leftSource: opt.value };
                // 切换来源时给出默认字段
                if (opt.value === "excel" && !excelFields.includes(binding.leftField)) {
                  next.leftField = excelFields[0] || "";
                } else if (opt.value === "manual" && binding.leftSource !== "manual") {
                  next.leftField = "";
                }
                onChange(next);
              }}
              className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] transition-colors ${
                binding.leftSource === opt.value
                  ? "bg-indigo-100 font-medium text-indigo-700 ring-1 ring-indigo-200"
                  : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              }`}
            >
              {opt.icon}
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      {/* 字段选择区 */}
      {binding.leftSource === "excel" && (
        <div className="flex items-center gap-1 pl-1">
          <select
            value={binding.leftField}
            onChange={(e) => onChange({ ...binding, leftField: e.target.value })}
            className="h-5 max-w-[130px] flex-1 rounded border border-slate-200 bg-white px-1 text-[9px] text-slate-600 outline-none"
          >
            {excelFields.length === 0 && <option value="">（无 Excel 字段）</option>}
            {excelFields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          {binding.leftField && recordFields[binding.leftField] !== undefined && (
            <span className="truncate text-[9px] text-indigo-500" title="当前卡片该字段的值（试跑时用它）">
              = {recordFields[binding.leftField] || "（空）"}
            </span>
          )}
        </div>
      )}
      {binding.leftSource === "database" && (
        <div className="flex items-center gap-1 pl-1">
          <button
            onClick={() => onPickLeftWeb(pickKey)}
            className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] transition-colors ${
              pickingThis
                ? "animate-pulse bg-violet-500 text-white"
                : binding.leftField
                ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                : "bg-slate-200 text-slate-600 hover:bg-slate-300"
            }`}
          >
            <Crosshair className="h-2.5 w-2.5" />
            {pickingThis ? "点击左侧网页元素…" : binding.leftField ? "重选左网页元素" : "拾取左网页元素"}
          </button>
          {/* 左网页来源也支持直接从「提取结果」选字段（选定后来源自动转为护照取值，LOOP 从提取结果读取） */}
          <button
            onClick={() => onPickPassportField(pickKey)}
            className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] transition-colors ${
              passportPickingThis
                ? "animate-pulse bg-violet-500 text-white"
                : "bg-slate-100 text-slate-500 hover:bg-slate-200"
            }`}
            title="从文件处理面板「提取结果」里选一个字段作为来源值"
          >
            <Database className="h-2.5 w-2.5" />
            {passportPickingThis ? "点击提取结果字段…" : "从提取结果选"}
          </button>
          {binding.leftField && !pickingThis && (
            <span className="truncate text-[9px] text-emerald-600" title={binding.leftField}>
              {binding.leftLabel || binding.leftField}
            </span>
          )}
        </div>
      )}
      {binding.leftSource === "passport" && (
        <div className="flex items-center gap-1 pl-1">
          <button
            onClick={() => onPickPassportField(pickKey)}
            className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] transition-colors ${
              passportPickingThis
                ? "animate-pulse bg-violet-500 text-white"
                : binding.leftField
                ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                : "bg-slate-200 text-slate-600 hover:bg-slate-300"
            }`}
          >
            <Crosshair className="h-2.5 w-2.5" />
            {passportPickingThis ? "点击提取结果字段…" : binding.leftField ? "重选提取字段" : "拾取提取字段"}
          </button>
          {binding.leftField && !passportPickingThis && (
            <span className="truncate text-[9px] text-emerald-600" title={binding.leftField}>
              {binding.leftField}
            </span>
          )}
        </div>
      )}
      {binding.leftSource === "manual" && (
        <div className="flex items-center gap-1 pl-1">
          <input
            value={binding.leftField}
            onChange={(e) => onChange({ ...binding, leftField: e.target.value })}
            placeholder="固定值（每次执行都用它，如 本科 / 2026/3/11）"
            className="h-5 flex-1 rounded border border-slate-200 bg-white px-1 text-[9px] text-slate-600 outline-none"
          />
        </div>
      )}
    </div>
  );
}

/** 日历角色行 */
function CalendarRoleRow({
  role,
  displayText,
  missing,
  picking,
  onPick,
}: {
  role: CalendarRole;
  displayText?: string;
  missing?: boolean;
  picking?: boolean;
  onPick: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="w-12 shrink-0 text-[9px] text-slate-500">{ROLE_LABELS[role]}</span>
      {displayText ? (
        <span className="inline-flex max-w-[90px] items-center gap-0.5 truncate rounded bg-emerald-50 px-1 py-0.5 text-[8px] text-emerald-700 ring-1 ring-emerald-100" title="已标注">
          <Check className="h-2 w-2 shrink-0" />
          <span className="truncate">{displayText}</span>
        </span>
      ) : (
        <span className={`rounded px-1 py-0.5 text-[8px] ${missing ? "bg-amber-50 text-amber-600 ring-1 ring-amber-100" : "text-slate-300"}`}>
          {missing ? "未标注·需点选" : "无"}
        </span>
      )}
      <button
        onClick={onPick}
        className={`ml-auto inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[8px] transition-colors ${
          picking
            ? "animate-pulse bg-violet-500 text-white"
            : "text-slate-400 hover:bg-violet-50 hover:text-violet-600"
        }`}
        title="重新指定：点击后在网页日历上点选该元素"
      >
        <Crosshair className="h-2.5 w-2.5" />
        {picking ? "点网页元素…" : "重选"}
      </button>
    </div>
  );
}

// ============ 可视化模拟组件 ============

/** 模拟触发框（选项控件/日历控件通用） */
function MockTriggerBox({ label, icon }: { label: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between rounded border border-slate-300 bg-white px-2 py-1.5">
      <span className="truncate text-[10px] text-slate-700">{label}</span>
      <span className="text-slate-400">{icon || <ChevronDown className="h-3 w-3" />}</span>
    </div>
  );
}

/** 模拟选项控件（下拉展开式 或 直接显示按钮组） */
function MockOptionWidget({
  widget,
  cardKey,
  optionPickingKey,
  onWidgetChange,
  onPickOption,
}: {
  widget: WidgetDef;
  cardKey: string;
  optionPickingKey: string | null;
  onWidgetChange: (w: WidgetDef) => void;
  onPickOption: (key: string, idx: number) => void;
}) {
  const options = widget.options || [];
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [newOptionText, setNewOptionText] = useState("");
  const [showAddInput, setShowAddInput] = useState(false);
  const triggerLabel = widget.triggerLabel || "请选择";
  const isInline = widget.inline;

  const addOption = () => {
    const text = newOptionText.trim();
    if (!text) return;
    onWidgetChange({ ...widget, options: [...options, { text, selector: "" }] });
    setNewOptionText("");
  };

  const removeOption = (idx: number) => {
    onWidgetChange({ ...widget, options: options.filter((_, i) => i !== idx) });
  };

  // inline 模式：直接显示选项按钮组
  if (isInline) {
    return (
      <div className="mock-option-widget flex flex-col gap-1.5">
        <div className="text-[9px] text-slate-400">
          直接选项组（{options.length} 个选项，匹配左侧值自动点击）
        </div>
        {/* 选项按钮行 + 内联添加按钮/输入框 */}
        <div className="flex flex-wrap items-center gap-1.5">
          {options.map((opt, i) => {
            const isPicking = optionPickingKey === `${cardKey}:option:${i}`;
            return (
              <div key={`${opt.text}-${i}`} className="group relative">
                <button
                  onClick={() => setSelectedIdx(i === selectedIdx ? null : i)}
                  className={`relative inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[10px] transition-all ${
                    selectedIdx === i
                      ? "border-violet-400 bg-violet-100 text-violet-700 font-medium shadow-sm"
                      : isPicking
                      ? "animate-pulse border-violet-500 bg-violet-500 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:border-violet-300 hover:bg-violet-50"
                  }`}
                >
                  {opt.text}
                  {/* 选项拾取按钮 */}
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      onPickOption(cardKey, i);
                    }}
                    className={`inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors ${
                      opt.selector
                        ? "text-emerald-500 hover:bg-emerald-100"
                        : "text-amber-500 hover:bg-amber-100"
                    }`}
                    title={opt.selector ? "重选网页元素" : "拾取网页按钮元素"}
                  >
                    <Crosshair className="h-2.5 w-2.5" />
                  </span>
                  {/* 删除按钮 */}
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      removeOption(i);
                    }}
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full text-rose-400 opacity-0 transition-all hover:bg-rose-100 group-hover:opacity-100"
                    title="删除选项"
                  >
                    <X className="h-2.5 w-2.5" />
                  </span>
                </button>
              </div>
            );
          })}
          {/* 内联添加：显示 + 按钮或输入框 */}
          {showAddInput ? (
            <div className="inline-flex items-center gap-1">
              <input
                autoFocus
                value={newOptionText}
                onChange={(e) => setNewOptionText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { addOption(); setShowAddInput(false); }
                  else if (e.key === "Escape") { setNewOptionText(""); setShowAddInput(false); }
                }}
                onBlur={() => {
                  if (newOptionText.trim()) addOption();
                  setShowAddInput(false);
                }}
                placeholder="新选项..."
                className="h-8 w-20 rounded-lg border border-violet-300 bg-white px-2 text-[10px] text-slate-700 outline-none ring-2 ring-violet-100 focus:w-28 focus:border-violet-400"
              />
            </div>
          ) : (
            <button
              onClick={() => setShowAddInput(true)}
              className="inline-flex h-8 items-center gap-1 rounded-lg border-2 border-dashed border-violet-300 px-2.5 text-[10px] font-medium text-violet-500 transition-colors hover:border-violet-400 hover:bg-violet-50 hover:text-violet-600"
              title="添加新选项"
            >
              <Plus className="h-3 w-3" />
              添加
            </button>
          )}
        </div>
        {/* 选中选项的别名/重选编辑 */}
        {selectedIdx !== null && options[selectedIdx] && (
          <div className="rounded bg-slate-50 p-1.5">
            <div className="mb-1 flex items-center gap-1">
              <span className="text-[9px] text-slate-500">选项「{options[selectedIdx].text}」：</span>
              <button
                onClick={() => onPickOption(cardKey, selectedIdx)}
                className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[8px] ${
                  optionPickingKey === `${cardKey}:option:${selectedIdx}`
                    ? "animate-pulse bg-violet-500 text-white"
                    : options[selectedIdx].selector
                    ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                    : "bg-amber-100 text-amber-700 hover:bg-amber-200"
                }`}
              >
                <Crosshair className="h-2.5 w-2.5" />
                {optionPickingKey === `${cardKey}:option:${selectedIdx}` ? "点击网页按钮…" : options[selectedIdx].selector ? "重选按钮" : "拾取按钮"}
              </button>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[8px] text-slate-400">别名（左侧值与此不同时填）：</span>
              <input
                value={options[selectedIdx].alias || ""}
                onChange={(e) => {
                  const alias = e.target.value || undefined;
                  const next = options.map((o, j) => (j === selectedIdx ? { ...o, alias } : o));
                  onWidgetChange({ ...widget, options: next });
                }}
                placeholder="如：M / 男性"
                className="h-5 flex-1 rounded border border-slate-200 bg-white px-1 text-[9px] text-slate-600 outline-none"
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // 下拉展开模式
  return (
    <div className="mock-option-widget flex flex-col gap-1">
      <div className="text-[9px] text-slate-400">模拟预览（点击选项标注别名）</div>
      {/* 触发框 */}
      <MockTriggerBox label={selectedIdx !== null ? options[selectedIdx]?.text || triggerLabel : triggerLabel} />
      {/* 展开面板 */}
      <div className="rounded border border-slate-200 bg-white shadow-lg">
        <div className="max-h-40 overflow-y-auto p-1">
          {options.map((opt, i) => (
            <div
              key={`${opt.text}-${i}`}
              onClick={() => setSelectedIdx(i)}
              className={`flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-[10px] transition-colors ${
                selectedIdx === i
                  ? "bg-violet-100 text-violet-700 font-medium"
                  : "text-slate-600 hover:bg-violet-50"
              }`}
            >
              <span className="truncate">{opt.text}</span>
              {opt.alias && (
                <span className="ml-1 inline-flex shrink-0 items-center gap-0.5 rounded bg-violet-200/70 px-1 text-[8px] text-violet-800">
                  <Tag className="h-2 w-2" />
                  {opt.alias}
                </span>
              )}
            </div>
          ))}
        </div>
        {options.length === 0 && (
          <div className="px-3 py-4 text-center text-[9px] text-slate-400">（无选项）</div>
        )}
      </div>
      {/* 别名标注区 */}
      <div className="mt-1 flex flex-col gap-1 rounded bg-slate-50 p-1.5">
        <div className="text-[8px] text-slate-400">点击选项设置别名（左侧值与选项文字不同时用）：</div>
        <div className="flex flex-wrap gap-1">
          {options.map((opt, i) => (
            <OptionChip
              key={`${opt.text}-${i}`}
              text={opt.text}
              alias={opt.alias}
              onAliasChange={(alias) => {
                const next = options.map((o, j) => (j === i ? { ...o, alias: alias || undefined } : o));
                onWidgetChange({ ...widget, options: next });
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** localStorage key for saving calendar role template */
const CALENDAR_TEMPLATE_KEY = "cinside-calendar-role-template";

/** 读取已保存的日历角色模板 */
function loadCalendarTemplate(): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(CALENDAR_TEMPLATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

/** 保存日历角色模板（只保存有 selector 的角色） */
function saveCalendarTemplate(cal: Record<string, string | undefined>): Record<string, string> {
  const tpl: Record<string, string> = {};
  for (const key of Object.keys(ROLE_FIELD)) {
    const sel = cal[ROLE_FIELD[key]];
    if (sel) tpl[key] = sel;
  }
  localStorage.setItem(CALENDAR_TEMPLATE_KEY, JSON.stringify(tpl));
  return tpl;
}

/** 模拟日历控件 */
function MockCalendarWidget({
  widget,
  cardKey,
  rolePickingKey,
  onPickRole,
  onWidgetChange,
  calendarState,
  calendarBusy,
  onCalendarMirror,
}: {
  widget: WidgetDef;
  cardKey: string;
  rolePickingKey: string | null;
  onPickRole: (key: string, role: CalendarRole) => void;
  onWidgetChange: (w: WidgetDef) => void;
  /** 日历镜像：当前显示的年月（与网页真实日历同步） */
  calendarState: { year: number; month: number } | null;
  /** 日历镜像操作执行中 */
  calendarBusy: boolean;
  /** 日历镜像操作：点击面板按钮 → 真实点网页对应按钮 → 刷新年月 */
  onCalendarMirror: (action: CalendarMirrorAction) => void;
}) {
  const cal = widget.calendar || {};
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const triggerLabel = widget.triggerLabel || "选择日期";
  const savedTpl = loadCalendarTemplate();

  // 检查角色是否已识别
  const getRole = (role: string) => (cal as unknown as Record<string, string | undefined>)[ROLE_FIELD[role]];
  const hasHeader = !!getRole("header");
  const hasYear = !!getRole("year");
  const hasMonth = !!getRole("month");
  const hasPrevYear = !!getRole("prevYear");
  const hasNextYear = !!getRole("nextYear");
  const hasPrevMonth = !!getRole("prevMonth");
  const hasNextMonth = !!getRole("nextMonth");
  const hasDayCell = !!getRole("dayCell");
  // 检查是否有投影坐标（说明支持镜像点击）
  // 镜像可用判定与执行脚本一致：选择器 或 投影坐标 任一存在即可点（脚本先选择器、失败后坐标兜底）
  const mirrorArmed = !!(
    cal.prevMonthSelector || cal.prevMonthRect || cal.nextMonthSelector || cal.nextMonthRect ||
    cal.prevYearSelector || cal.prevYearRect || cal.nextYearSelector || cal.nextYearRect ||
    cal.dayCellSelector || (cal.dayCells && cal.dayCells.length > 0)
  );

  const roleStatus = [
    { role: "header" as CalendarRole, label: "年月显示", has: hasHeader || hasYear || hasMonth, required: true },
    { role: "prevMonth" as CalendarRole, label: "上一月 ◀", has: hasPrevMonth, required: true },
    { role: "nextMonth" as CalendarRole, label: "下一月 ▶", has: hasNextMonth, required: true },
    { role: "dayCell" as CalendarRole, label: "日格子", has: hasDayCell, required: true },
    { role: "prevYear" as CalendarRole, label: "上一年 ◀◀", has: hasPrevYear, required: false },
    { role: "nextYear" as CalendarRole, label: "下一年 ▶▶", has: hasNextYear, required: false },
  ];
  const allSet = roleStatus.filter((r) => r.required).every((r) => r.has);
  const identifiedCount = roleStatus.filter((r) => r.has).length;
  const requiredCount = roleStatus.filter((r) => r.required).length;

  // 角色高亮状态
  const isPicking = (role: CalendarRole) => rolePickingKey === `${cardKey}:${role}`;

  /** 应用已保存模板（只填补空缺的 selector） */
  const applyTemplate = () => {
    if (!savedTpl) return;
    const next = { ...cal };
    for (const [role, sel] of Object.entries(savedTpl)) {
      const field = ROLE_FIELD[role];
      if (field && !next[field as keyof typeof next]) {
        (next as Record<string, string>)[field] = sel;
      }
    }
    onWidgetChange({ ...widget, calendar: next });
  };

  /** 保存当前配置为模板 */
  const pinAsTemplate = () => {
    saveCalendarTemplate(cal as unknown as Record<string, string | undefined>);
    // 触发重渲染
    onWidgetChange({ ...widget });
  };

  // 使用镜像状态的年月，若无则用当前时间
  const now = new Date();
  const displayYear = calendarState?.year ?? now.getFullYear();
  const displayMonth = calendarState?.month ?? now.getMonth();
  const firstDay = new Date(displayYear, displayMonth, 1).getDay();
  const daysInMonth = new Date(displayYear, displayMonth + 1, 0).getDate();
  const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

  // 生成日历格子
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let i = 1; i <= daysInMonth; i++) cells.push(i);

  // 是否可镜像点击：有选择器或投影坐标，且当前不忙
  const canMirrorNav = (role: "prevYear" | "nextYear" | "prevMonth" | "nextMonth") => {
    if (calendarBusy) return false;
    const selKey = `${role}Selector` as keyof typeof cal;
    const rectKey = `${role}Rect` as keyof typeof cal;
    return !!(cal[selKey] || cal[rectKey]);
  };
  const canMirrorDay = () => {
    return !calendarBusy && !!(cal.dayCellSelector || (cal.dayCells && cal.dayCells.length > 0));
  };

  return (
    <div className="mock-calendar-widget flex flex-col gap-1">
      {/* 触发框 */}
      <MockTriggerBox label={selectedDay ? `${displayYear}-${String(displayMonth + 1).padStart(2, '0')}-${String(selectedDay).padStart(2, '0')}` : triggerLabel} icon={<CalendarDays className="h-3 w-3" />} />
      {/* 日历面板 */}
      <div className="rounded border border-slate-200 bg-white p-2 shadow-lg">
        {/* 头部：年月 + 翻页 */}
        <div className="mb-2 flex items-center justify-between">
          {hasPrevYear ? (
            <button
              onClick={() => (canMirrorNav("prevYear") ? onCalendarMirror({ type: "nav", role: "prevYear" }) : onPickRole(cardKey, "prevYear"))}
              disabled={calendarBusy}
              className={`rounded p-1 text-[10px] transition-colors ${
                calendarBusy ? "opacity-50 cursor-not-allowed" : canMirrorNav("prevYear") ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200" : "bg-amber-100 text-amber-600 hover:bg-amber-200"
              }`}
              title={canMirrorNav("prevYear") ? "点击→网页上一年" : "无坐标·点击重新标注"}
            >
              «
            </button>
          ) : (
            <button
              onClick={() => onPickRole(cardKey, "prevYear")}
              className={`rounded p-1 text-[10px] transition-colors ${
                isPicking("prevYear")
                  ? "animate-pulse bg-violet-500 text-white"
                  : "bg-amber-100 text-amber-600 hover:bg-amber-200"
              }`}
              title="未标注·点击点选"
            >
              «
            </button>
          )}
          {hasPrevMonth ? (
            <button
              onClick={() => (canMirrorNav("prevMonth") ? onCalendarMirror({ type: "nav", role: "prevMonth" }) : onPickRole(cardKey, "prevMonth"))}
              disabled={calendarBusy}
              className={`rounded p-1 text-[10px] transition-colors ${
                calendarBusy ? "opacity-50 cursor-not-allowed" : canMirrorNav("prevMonth") ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200" : "bg-amber-100 text-amber-600 hover:bg-amber-200"
              }`}
              title={canMirrorNav("prevMonth") ? "点击→网页上一月" : "无坐标·点击重新标注"}
            >
              ‹
            </button>
          ) : (
            <button
              onClick={() => onPickRole(cardKey, "prevMonth")}
              className={`rounded p-1 text-[10px] transition-colors ${
                isPicking("prevMonth")
                  ? "animate-pulse bg-violet-500 text-white"
                  : "bg-amber-100 text-amber-600 hover:bg-amber-200"
              }`}
              title="未标注·点击点选"
            >
              ‹
            </button>
          )}
          <button
            onClick={() => onPickRole(cardKey, hasHeader ? "header" : hasYear ? "year" : "month")}
            className={`rounded px-2 py-1 text-[10px] font-medium transition-colors ${
              isPicking(hasHeader ? "header" : hasYear ? "year" : "month")
                ? "animate-pulse bg-violet-500 text-white"
                : hasHeader || hasYear || hasMonth
                ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                : "bg-amber-100 text-amber-600 hover:bg-amber-200"
            }`}
            title={hasHeader ? `已标注·年月：${getRole("header")}` : "未标注·点击重选"}
          >
            {displayYear}年 {monthNames[displayMonth]}
            {calendarBusy && <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />}
          </button>
          {hasNextMonth ? (
            <button
              onClick={() => (canMirrorNav("nextMonth") ? onCalendarMirror({ type: "nav", role: "nextMonth" }) : onPickRole(cardKey, "nextMonth"))}
              disabled={calendarBusy}
              className={`rounded p-1 text-[10px] transition-colors ${
                calendarBusy ? "opacity-50 cursor-not-allowed" : canMirrorNav("nextMonth") ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200" : "bg-amber-100 text-amber-600 hover:bg-amber-200"
              }`}
              title={canMirrorNav("nextMonth") ? "点击→网页下一月" : "无坐标·点击重新标注"}
            >
              ›
            </button>
          ) : (
            <button
              onClick={() => onPickRole(cardKey, "nextMonth")}
              className={`rounded p-1 text-[10px] transition-colors ${
                isPicking("nextMonth")
                  ? "animate-pulse bg-violet-500 text-white"
                  : "bg-amber-100 text-amber-600 hover:bg-amber-200"
              }`}
              title="未标注·点击点选"
            >
              ›
            </button>
          )}
          {hasNextYear ? (
            <button
              onClick={() => (canMirrorNav("nextYear") ? onCalendarMirror({ type: "nav", role: "nextYear" }) : onPickRole(cardKey, "nextYear"))}
              disabled={calendarBusy}
              className={`rounded p-1 text-[10px] transition-colors ${
                calendarBusy ? "opacity-50 cursor-not-allowed" : canMirrorNav("nextYear") ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200" : "bg-amber-100 text-amber-600 hover:bg-amber-200"
              }`}
              title={canMirrorNav("nextYear") ? "点击→网页下一年" : "无坐标·点击重新标注"}
            >
              »
            </button>
          ) : (
            <button
              onClick={() => onPickRole(cardKey, "nextYear")}
              className={`rounded p-1 text-[10px] transition-colors ${
                isPicking("nextYear")
                  ? "animate-pulse bg-violet-500 text-white"
                  : "bg-amber-100 text-amber-600 hover:bg-amber-200"
              }`}
              title="未标注·点击点选"
            >
              »
            </button>
          )}
        </div>
        {/* 星期标题 */}
        <div className="mb-1 grid grid-cols-7 gap-0.5 text-center text-[8px] text-slate-400">
          {['日', '一', '二', '三', '四', '五', '六'].map((d) => (
            <div key={d} className="py-0.5">{d}</div>
          ))}
        </div>
        {/* 日格子 */}
        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((day, i) => (
            <div
              key={i}
              onClick={() => {
                if (day && canMirrorDay()) {
                  setSelectedDay(day);
                  onCalendarMirror({ type: "day", day });
                } else if (day) {
                  setSelectedDay(day);
                }
              }}
              className={`flex h-6 items-center justify-center rounded text-[9px] transition-colors ${
                day === null
                  ? "text-slate-300"
                  : selectedDay === day
                  ? "bg-violet-500 text-white font-medium cursor-pointer"
                  : canMirrorDay()
                  ? "bg-emerald-50 text-slate-600 hover:bg-emerald-100 cursor-pointer"
                  : hasDayCell
                  ? "bg-amber-50 text-amber-600 hover:bg-amber-100 cursor-pointer"
                  : "bg-slate-50 text-slate-400"
              }`}
              title={day ? (canMirrorDay() ? "点击→网页选择该日" : hasDayCell ? "无坐标·日格子需重新标注" : "未标注·需点选") : ""}
            >
              {day}
            </div>
          ))}
        </div>
      </div>
      {/* 角色标注状态 - 加大加粗，更显眼 */}
      <div className="mt-1.5 flex flex-col gap-1.5 rounded-lg bg-gradient-to-br from-slate-50 to-violet-50/30 p-2.5 ring-1 ring-slate-200">
        <div className="flex items-center gap-1.5">
          <span className={`inline-flex h-2 w-2 rounded-full ${identifiedCount >= 5 ? "bg-emerald-500" : identifiedCount >= 3 ? "bg-amber-400" : "bg-rose-400"}`} />
          <span className="text-[11px] font-semibold text-slate-700">
            角色标注 <span className="text-violet-600">{identifiedCount}/{roleStatus.length}</span>
            {allSet && <span className="ml-1 text-emerald-600">✓</span>}
          </span>
          <span className="text-[9px] text-slate-400">（必选{requiredCount}项；点「重选」修正，固定模板后下次自动套用）</span>
          {mirrorArmed && (
            <span className="ml-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[8px] text-emerald-700 ring-1 ring-emerald-200">
              镜像已激活 ✓
            </span>
          )}
          {/* 模板操作按钮 */}
          <div className="ml-auto flex items-center gap-1">
            {savedTpl && !allSet && (
              <button
                onClick={applyTemplate}
                className="inline-flex items-center gap-0.5 rounded-md bg-violet-100 px-1.5 py-0.5 text-[9px] font-medium text-violet-700 transition-colors hover:bg-violet-200"
                title="用上次固定的日历结构自动填补缺失角色"
              >
                <Save className="h-2.5 w-2.5" />
                应用固定模板
              </button>
            )}
            <button
              onClick={pinAsTemplate}
              className="inline-flex items-center gap-0.5 rounded-md bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 transition-colors hover:bg-amber-200"
              title="将当前日历的角色选择器固定为模板，下次提取日历时自动套用"
            >
              <Lock className="h-2.5 w-2.5" />
              {savedTpl ? "更新固定模板" : "固定为模板"}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
          {roleStatus.map(({ role, label, has }) => (
            <div key={role} className="flex items-center gap-1.5">
              <span className={`inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full text-[7px] font-bold text-white ${
                has ? "bg-emerald-500" : "bg-amber-400"
              }`}>
                {has ? "✓" : "!"}
              </span>
              <span className={`text-[10px] font-medium ${has ? "text-slate-700" : "text-amber-700"}`}>{label}</span>
              <button
                onClick={() => onPickRole(cardKey, role)}
                className={`ml-auto rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
                  isPicking(role)
                    ? "animate-pulse bg-violet-500 text-white"
                    : has
                    ? "bg-white text-slate-500 ring-1 ring-slate-200 hover:bg-violet-50 hover:text-violet-600 hover:ring-violet-200"
                    : "bg-amber-100 text-amber-700 ring-1 ring-amber-200 hover:bg-amber-200"
                }`}
              >
                {isPicking(role) ? "点网页…" : "重选"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 控件卡片主体（草稿与已保存共用渲染） */
function WidgetCardBody({
  widget,
  cardKey,
  rolePickingKey,
  optionPickingKey,
  onWidgetChange,
  onPickRole,
  onPickOption,
  calendarState,
  calendarBusyKey,
  onCalendarMirror,
}: {
  widget: WidgetDef;
  cardKey: string;
  rolePickingKey: string | null;
  optionPickingKey: string | null;
  onWidgetChange: (w: WidgetDef) => void;
  onPickRole: (key: string, role: CalendarRole) => void;
  onPickOption: (key: string, idx: number) => void;
  /** 日历镜像：当前显示的年月（与网页真实日历同步） */
  calendarState: Record<string, { year: number; month: number } | null>;
  /** 日历镜像操作执行中 */
  calendarBusyKey: string | null;
  /** 日历镜像操作：点击面板按钮 → 真实点网页对应按钮 → 刷新年月 */
  onCalendarMirror: (key: string, widget: WidgetDef, action: CalendarMirrorAction) => void;
}) {
  if (widget.kind === "option") {
    return <MockOptionWidget widget={widget} cardKey={cardKey} optionPickingKey={optionPickingKey} onWidgetChange={onWidgetChange} onPickOption={onPickOption} />;
  }
  // 日历控件
  return (
    <MockCalendarWidget
      widget={widget}
      cardKey={cardKey}
      rolePickingKey={rolePickingKey}
      onPickRole={onPickRole}
      onWidgetChange={onWidgetChange}
      calendarState={calendarState[cardKey] || null}
      calendarBusy={calendarBusyKey === cardKey}
      onCalendarMirror={(action) => onCalendarMirror(cardKey, widget, action)}
    />
  );
}

export default function WidgetExtractPanel(props: Props) {
  const {
    pickingKind,
    snapshotBusy,
    snapshotError,
    draft,
    draftBinding,
    savedWidgets,
    excelFields,
    recordFields,
    rolePickingKey,
    optionPickingKey,
    leftPickingKey,
    testResults,
    testBusyKey,
    onStartPick,
    onCancelPick,
    onDraftChange,
    onDraftBindingChange,
    onSaveDraft,
    onDiscardDraft,
    onUpdateSaved,
    onUpdateSavedBinding,
    onRemoveSaved,
    onPickRole,
    onPickOption,
    onPickLeftWeb,
    passportPickingKey,
    onPickPassportField,
    onTest,
    calendarState,
    calendarBusyKey,
    onCalendarMirror,
    calGuide,
    calDayCellCount,
    onFinishDayCells,
    onSkipGuideStep,
    onCancelGuide,
    calPanelPickFailed,
    calPanelPickMode,
    panelPickKind,
    onCalPanelPickArm,
    onCalPanelPickCancel,
  } = props;

  const draftReady = draftBinding.leftField.trim().length > 0;

  return (
    <div className="widget-extract-panel flex flex-col gap-2 px-1 py-1">
      {/* 日历引导式拾取提示条 */}
      {calGuide && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 ring-1 ring-amber-200">
          <span className="inline-flex h-5 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[9px] font-semibold text-white">
            {calGuide.stepIdx + 1}/{calGuide.total}
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-[9px] font-medium text-amber-800">
              请点选：{calGuide.label}
            </span>
            <span className="truncate text-[8px] text-amber-600/80">
              {calGuide.role === "dayCell"
                ? `已选 ${calDayCellCount} 个 · 鼠标拖拽框选一片日格子，或逐个点选，至少 1 个后点「完成」`
                : calGuide.required
                ? `必选 · 在${draft?.side === "left" ? "左侧" : "右侧"}网页日历上点选对应元素`
                : "可选 · 无该按钮时点「跳过」"}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {calGuide.role === "dayCell" && (
              <button
                onClick={onFinishDayCells}
                className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium ring-1 transition-colors ${
                  calDayCellCount > 0
                    ? "bg-emerald-500 text-white ring-emerald-500 hover:bg-emerald-600"
                    : "bg-white text-slate-400 ring-slate-200"
                }`}
                title={calDayCellCount > 0 ? `完成日格子点选（已选 ${calDayCellCount} 个种子，将自动收集全部日格子）` : "请先在网页日历上点选至少一个日格子"}
              >
                <Check className="h-2.5 w-2.5" />
                完成{calDayCellCount > 0 ? ` (${calDayCellCount})` : ""}
              </button>
            )}
            {!calGuide.required && (
              <button
                onClick={onSkipGuideStep}
                className="inline-flex items-center gap-0.5 rounded bg-white px-1.5 py-0.5 text-[9px] font-medium text-amber-700 ring-1 ring-amber-300 transition-colors hover:bg-amber-100"
                title="跳过当前可选步骤"
              >
                跳过
              </button>
            )}
            <button
              onClick={onCancelGuide}
              className="inline-flex items-center gap-0.5 rounded bg-white px-1.5 py-0.5 text-[9px] font-medium text-rose-600 ring-1 ring-rose-200 transition-colors hover:bg-rose-50"
              title="放弃本次引导式拾取"
            >
              <X className="h-2.5 w-2.5" />
              取消
            </button>
          </div>
        </div>
      )}
      {/* 提取入口：统一黑白胶囊按钮；点击一个进入对应布置模式，布置好（保存/放弃）后恢复未点击态，可接着布置下一个 */}
      <div className="flex items-center gap-1.5">
        {pickingKind ? (
          <button
            onClick={onCancelPick}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-full bg-slate-900 px-2.5 py-1 text-[10px] font-medium text-white ring-1 ring-slate-900 animate-pulse transition-all"
          >
            <Crosshair className="h-3 w-3" />
            请在网页上点击{pickingKind === "option" ? "可展开选项的框框" : "日历框框"}…（点击取消）
          </button>
        ) : (
          <>
            <button
              onClick={() => onStartPick("option")}
              disabled={snapshotBusy}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-full bg-white px-2.5 py-1 text-[10px] font-medium text-slate-800 ring-1 ring-slate-300 transition-all hover:bg-slate-100 hover:ring-slate-400 disabled:opacity-40"
              title="提取点击后展开选项列表的控件（下拉框/展开卡片）"
            >
              <Plus className="h-3 w-3" />
              选项控件
            </button>
            <button
              onClick={() => onStartPick("calendar")}
              disabled={snapshotBusy}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-full bg-white px-2.5 py-1 text-[10px] font-medium text-slate-800 ring-1 ring-slate-300 transition-all hover:bg-slate-100 hover:ring-slate-400 disabled:opacity-40"
              title="提取点击后展开日历的日期控件"
            >
              <CalendarDays className="h-3 w-3" />
              日历控件
            </button>
          </>
        )}
      </div>
      {snapshotBusy && (
        <div className="flex items-center gap-1.5 rounded bg-violet-50 px-2 py-1 text-[9px] text-violet-600">
          <Loader2 className="h-3 w-3 animate-spin" />
          正在打开控件并识别面板结构…
        </div>
      )}
      {snapshotError && calPanelPickMode === "idle" && (
        <div className="rounded bg-rose-50 px-2 py-1 text-[9px] leading-snug text-rose-600 ring-1 ring-rose-100">
          {snapshotError}
        </div>
      )}
      {/* 手动面板点选兜底：自动检测失败 → 引导用户手动点开面板并点选其中元素（选项/日历通用） */}
      {calPanelPickFailed && calPanelPickMode === "await-open" && (
        <div className="flex flex-col gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 ring-1 ring-amber-200">
          <div className="flex items-start gap-1.5">
            {panelPickKind === "option" ? (
              <List className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />
            ) : (
              <CalendarDays className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />
            )}
            <div className="flex-1">
              <div className="text-[9px] font-medium text-amber-800">
                未检测到展开的{panelPickKind === "option" ? "选项面板" : "日历"}，请手动指定面板：
              </div>
              <ol className="mt-0.5 list-decimal pl-3.5 text-[8px] leading-relaxed text-amber-700">
                {panelPickKind === "option" ? (
                  <>
                    <li>在网页上点击框框，手动点开下拉</li>
                    <li>下拉展开后，点下方「开始点选面板」</li>
                    <li>再点下拉面板上的任意选项</li>
                  </>
                ) : (
                  <>
                    <li>在网页上点击日期框框，手动点开日历</li>
                    <li>日历展开后，点下方「开始点选面板」</li>
                    <li>再点日历面板上的任意位置（日格子/年月区均可）</li>
                  </>
                )}
              </ol>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onCalPanelPickArm}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded bg-amber-500 px-2 py-1 text-[9px] font-medium text-white transition-colors hover:bg-amber-600"
            >
              <Crosshair className="h-2.5 w-2.5" />
              我已点开{panelPickKind === "option" ? "下拉" : "日历"}，开始点选面板
            </button>
            <button
              onClick={onCalPanelPickCancel}
              className="inline-flex items-center gap-0.5 rounded bg-white px-1.5 py-1 text-[9px] font-medium text-slate-500 ring-1 ring-slate-200 transition-colors hover:bg-slate-50"
            >
              <X className="h-2.5 w-2.5" />
              取消
            </button>
          </div>
        </div>
      )}
      {calPanelPickMode === "picking" && (
        <div className="flex flex-col gap-1">
          {snapshotError && (
            <div className="rounded bg-rose-50 px-2 py-1 text-[9px] leading-snug text-rose-600 ring-1 ring-rose-100">
              {snapshotError}
            </div>
          )}
          <div className="flex items-center gap-2 rounded-md border border-violet-300 bg-violet-50 px-2 py-1.5 ring-1 ring-violet-200">
            <Crosshair className="h-3 w-3 shrink-0 animate-pulse text-violet-600" />
            <span className="flex-1 text-[9px] text-violet-700">
              {panelPickKind === "option"
                ? "请点击网页下拉面板上的任意选项"
                : "请点击网页日历面板上的任意位置（日格子/年月区均可）"}
            </span>
            <button
              onClick={onCalPanelPickCancel}
              className="inline-flex shrink-0 items-center gap-0.5 rounded bg-white px-1.5 py-0.5 text-[9px] font-medium text-slate-500 ring-1 ring-slate-200 transition-colors hover:bg-slate-50"
            >
              <X className="h-2.5 w-2.5" />
              取消
            </button>
          </div>
        </div>
      )}

      {/* 草稿卡片：快照完成，待绑定保存 */}
      {draft && (
        <div
          data-widget-tab-id={`widget:draft:${draft.id}`}
          className="flex flex-col gap-1.5 rounded-lg border-2 border-violet-300 bg-violet-50/60 px-2 py-1.5 ring-1 ring-violet-200"
        >
          <div className="flex items-center gap-1">
            <span
              className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-violet-500 text-[8px] font-bold text-white animate-pulse"
              title={`正在提取第 ${savedWidgets.length + 1} 个控件`}
            >
              {savedWidgets.length + 1}
            </span>
            {draft.kind === "option" ? (
              <List className="h-3 w-3 shrink-0 text-violet-600" />
            ) : (
              <CalendarDays className="h-3 w-3 shrink-0 text-violet-600" />
            )}
            <span className="max-w-[140px] truncate text-[10px] font-bold text-violet-800" title={draft.triggerSelector}>
              {draft.triggerLabel || "未命名控件"}
            </span>
            <span className="shrink-0 rounded-full bg-violet-200 px-1.5 py-0.5 text-[8px] text-violet-700">
              {draft.kind === "option" ? "选项" : "日历"}·待保存
            </span>
            <button
              onClick={onDiscardDraft}
              className="ml-auto rounded p-0.5 text-slate-400 hover:bg-rose-100 hover:text-rose-500"
              title="放弃此控件"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <BindingRow
            binding={draftBinding}
            excelFields={excelFields}
            recordFields={recordFields}
            pickKey="draft"
            leftPickingKey={leftPickingKey}
            passportPickingKey={passportPickingKey}
            onChange={onDraftBindingChange}
            onPickLeftWeb={onPickLeftWeb}
            onPickPassportField={onPickPassportField}
          />
          <WidgetCardBody
            widget={draft}
            cardKey="draft"
            rolePickingKey={rolePickingKey}
            optionPickingKey={optionPickingKey}
            onWidgetChange={onDraftChange}
            onPickRole={onPickRole}
            onPickOption={onPickOption}
            calendarState={calendarState}
            calendarBusyKey={calendarBusyKey}
            onCalendarMirror={onCalendarMirror}
          />
          {/* 试跑结果 */}
          {testResults["draft"] && (
            <div
              className={`rounded px-1.5 py-1 text-[9px] leading-snug ring-1 ${
                testResults["draft"].ok
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
                  : "bg-rose-50 text-rose-600 ring-rose-100"
              }`}
            >
              {testResults["draft"].message}
            </div>
          )}
          <div className="flex items-center gap-1 pt-0.5">
            <button
              onClick={() => onTest("draft", draft, draftBinding)}
              disabled={!draftReady || testBusyKey === "draft"}
              className="inline-flex items-center gap-0.5 rounded-md bg-sky-500 px-2 py-0.5 text-[9px] font-medium text-white transition-colors hover:bg-sky-600 disabled:opacity-40"
              title={`用当前卡片的值在${draft?.side === "left" ? "左侧" : "右侧"}网页真实演练一遍`}
            >
              {testBusyKey === "draft" ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5" />}
              试跑
            </button>
            <button
              onClick={onSaveDraft}
              disabled={!draftReady}
              className="inline-flex items-center gap-0.5 rounded-md bg-brand-600 px-2 py-0.5 text-[9px] font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-40"
              title={draftReady ? "保存为映射步骤（LOOP 时自动执行）" : "先绑定左侧来源"}
            >
              <Save className="h-2.5 w-2.5" />
              保存映射
            </button>
          </div>
        </div>
      )}

      {/* 已保存控件卡片（按保存顺序编号 1,2,3…，先设置的先执行） */}
      {savedWidgets.map(({ mapping, widget }, widgetIdx) => {
        const key = `saved:${mapping.right_selector}`;
        const binding: WidgetBinding = {
          leftSource: mapping.left_source,
          leftField: mapping.left_field,
          leftLabel: mapping.left_record_key || undefined,
        };
        const tr = testResults[key];
        const isBound = !!binding.leftField.trim();
        const accent = isBound
          ? { border: "border-emerald-200", bg: "bg-emerald-50/40", num: "bg-emerald-500", icon: "text-emerald-600", title: "text-emerald-800", badgeBg: "bg-emerald-100", badgeText: "text-emerald-700", badgeRing: "ring-emerald-200" }
          : { border: "border-amber-200", bg: "bg-amber-50/40", num: "bg-amber-500", icon: "text-amber-600", title: "text-amber-800", badgeBg: "bg-amber-100", badgeText: "text-amber-700", badgeRing: "ring-amber-200" };
        return (
          <div
            key={key}
            data-widget-tab-id={`widget:saved:${mapping.right_selector}`}
            className={`flex flex-col gap-1.5 rounded-lg border ${accent.border} ${accent.bg} px-2 py-1.5`}
          >
            <div className="flex items-center gap-1">
              <span
                className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full ${accent.num} text-[8px] font-bold text-white`}
                title={`第 ${widgetIdx + 1} 个控件`}
              >
                {widgetIdx + 1}
              </span>
              {widget.kind === "option" ? (
                <List className={`h-3 w-3 shrink-0 ${accent.icon}`} />
              ) : (
                <CalendarDays className={`h-3 w-3 shrink-0 ${accent.icon}`} />
              )}
              <span className={`max-w-[130px] truncate text-[10px] font-bold ${accent.title}`} title={widget.triggerSelector}>
                {widget.triggerLabel || mapping.right_label || "控件"}
              </span>
              <span className={`shrink-0 rounded-full ${accent.badgeBg} px-1.5 py-0.5 text-[8px] ${accent.badgeText} ring-1 ${accent.badgeRing}`}>
                {widget.kind === "option" ? "选项" : "日历"}·{isBound ? "已保存" : "待绑定"}
              </span>
              <button
                onClick={() => onRemoveSaved(mapping.right_selector)}
                className="ml-auto rounded p-0.5 text-slate-400 hover:bg-rose-100 hover:text-rose-500"
                title="删除此控件"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            <BindingRow
              binding={binding}
              excelFields={excelFields}
              recordFields={recordFields}
              pickKey={key}
              leftPickingKey={leftPickingKey}
              passportPickingKey={passportPickingKey}
              onChange={(b) => onUpdateSavedBinding(mapping.right_selector, b)}
              onPickLeftWeb={onPickLeftWeb}
              onPickPassportField={onPickPassportField}
            />
            <WidgetCardBody
              widget={widget}
              cardKey={key}
              rolePickingKey={rolePickingKey}
              optionPickingKey={optionPickingKey}
              onWidgetChange={(w) => onUpdateSaved(mapping.right_selector, w)}
              onPickRole={onPickRole}
              onPickOption={onPickOption}
              calendarState={calendarState}
              calendarBusyKey={calendarBusyKey}
              onCalendarMirror={onCalendarMirror}
            />
            {tr && (
              <div
                className={`rounded px-1.5 py-1 text-[9px] leading-snug ring-1 ${
                  tr.ok ? "bg-emerald-50 text-emerald-700 ring-emerald-100" : "bg-rose-50 text-rose-600 ring-rose-100"
                }`}
              >
                {tr.message}
              </div>
            )}
            <div className="flex items-center gap-1 pt-0.5">
              <button
                onClick={() => onTest(key, widget, binding)}
                disabled={!binding.leftField || testBusyKey === key}
                className="inline-flex items-center gap-0.5 rounded-md bg-sky-500 px-2 py-0.5 text-[9px] font-medium text-white transition-colors hover:bg-sky-600 disabled:opacity-40"
                title={`用当前卡片的值在${widget?.side === "left" ? "左侧" : "右侧"}网页真实演练一遍`}
              >
                {testBusyKey === key ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5" />}
                试跑
              </button>
            </div>
          </div>
        );
      })}

      {/* 空状态 */}
      {!draft && savedWidgets.length === 0 && !pickingKind && !snapshotBusy && (
        <p className="text-[9px] leading-snug text-slate-400">
          适用于「点击展开再选择」的框框：提取后绑定左侧来源，LOOP 时按左侧值自动点选；日历则自动翻页到左侧日期并点选。
        </p>
      )}
    </div>
  );
}
