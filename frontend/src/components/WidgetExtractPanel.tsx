/**
 * 控件提取面板：点击展开型控件（选项控件 / 日历控件）的提取、标注与绑定
 *
 * 布局：提取入口按钮行 → 草稿卡片（快照后待保存）→ 已保存控件卡片列表
 * 人类交互：
 *  - 选项控件：选项以芯片呈现，点击芯片标注「别名」（= 左侧值），智能匹配失败时用别名兜底
 *  - 日历控件：自动识别的角色（年月显示/翻页/日格子）逐行展示，识别错误的可「重选」
 *  - 每个卡片可绑定左侧来源（Excel / 左网页 / 护照 / 固定值）并「试跑」验证
 */
import { useState } from "react";
import {
  CalendarDays,
  Check,
  Crosshair,
  Database,
  FileSpreadsheet,
  Globe,
  List,
  Loader2,
  Play,
  Plus,
  Save,
  Tag,
  Trash2,
  Type,
  X,
} from "lucide-react";
import type { CalendarRole, FieldMapping, LeftSource, WidgetDef } from "../types";

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
  /** 正在从左侧网页拾取来源的 key（"draft" 或 "saved:<selector>"） */
  leftPickingKey: string | null;
  /** 试跑结果（key：草稿="draft"，已保存="saved:<selector>"） */
  testResults: Record<string, WidgetTestResult>;
  /** 试跑执行中 */
  testBusyKey: string | null;
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
  /** 请求从左侧网页拾取来源元素 */
  onPickLeftWeb: (key: string) => void;
  /** 试跑（App 端解析左侧值并执行控件脚本） */
  onTest: (testKey: string, widget: WidgetDef, binding: WidgetBinding) => void;
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
        title="当左侧值与选项文字不同时，在这里填左侧的值（如选项是「本科(学士)」，左侧是「本科」）"
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
      title={alias ? `别名「${alias}」— 点击修改` : "点击标注别名（左侧值与选项文字不同时使用）"}
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
  onChange,
  onPickLeftWeb,
}: {
  binding: WidgetBinding;
  excelFields: string[];
  recordFields: Record<string, string>;
  pickKey: string;
  leftPickingKey: string | null;
  onChange: (b: WidgetBinding) => void;
  onPickLeftWeb: (key: string) => void;
}) {
  const pickingThis = leftPickingKey === pickKey;
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
          {binding.leftField && !pickingThis && (
            <span className="truncate text-[9px] text-emerald-600" title={binding.leftField}>
              {binding.leftLabel || binding.leftField}
            </span>
          )}
        </div>
      )}
      {binding.leftSource === "passport" && (
        <div className="flex items-center gap-1 pl-1">
          <input
            value={binding.leftField}
            onChange={(e) => onChange({ ...binding, leftField: e.target.value })}
            placeholder="护照提取字段名（如 birth_date）"
            className="h-5 flex-1 rounded border border-slate-200 bg-white px-1 text-[9px] text-slate-600 outline-none"
          />
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
        <span className="inline-flex max-w-[90px] items-center gap-0.5 truncate rounded bg-emerald-50 px-1 py-0.5 text-[8px] text-emerald-700 ring-1 ring-emerald-100" title="已自动识别">
          <Check className="h-2 w-2 shrink-0" />
          <span className="truncate">{displayText}</span>
        </span>
      ) : (
        <span className={`rounded px-1 py-0.5 text-[8px] ${missing ? "bg-amber-50 text-amber-600 ring-1 ring-amber-100" : "text-slate-300"}`}>
          {missing ? "未识别·需重选" : "无"}
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

/** 控件卡片主体（草稿与已保存共用渲染） */
function WidgetCardBody({
  widget,
  cardKey,
  rolePickingKey,
  onWidgetChange,
  onPickRole,
}: {
  widget: WidgetDef;
  cardKey: string;
  rolePickingKey: string | null;
  onWidgetChange: (w: WidgetDef) => void;
  onPickRole: (key: string, role: CalendarRole) => void;
}) {
  if (widget.kind === "option") {
    const options = widget.options || [];
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1 text-[9px] text-slate-400">
          展开选项（{options.length}）
          <span className="text-[8px] text-slate-300">点击芯片标注别名</span>
        </div>
        <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto rounded border border-slate-100 bg-slate-50/50 p-1">
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
    );
  }
  // 日历控件：角色列表
  const cal = widget.calendar || {};
  const getSel = (role: string) => (cal as unknown as Record<string, string | undefined>)[ROLE_FIELD[role]];
  const roles: CalendarRole[] = cal.headerSelector
    ? ["header", "prevMonth", "nextMonth", "prevYear", "nextYear", "dayCell"]
    : ["year", "month", "prevMonth", "nextMonth", "prevYear", "nextYear", "dayCell"];
  // 识别值显示文本
  const detectedDisplay = (role: CalendarRole): string | undefined => {
    const sel = getSel(role);
    if (!sel) return undefined;
    if (role === "dayCell") return "已识别";
    return "已识别";
  };
  return (
    <div className="flex flex-col gap-0.5 rounded border border-slate-100 bg-slate-50/50 p-1.5">
      {roles.map((role) => (
        <CalendarRoleRow
          key={role}
          role={role}
          displayText={detectedDisplay(role)}
          missing={!getSel(role) && (role === "prevMonth" || role === "nextMonth" || role === "dayCell" || role === "header" || role === "year" || role === "month")}
          picking={rolePickingKey === `${cardKey}:${role}`}
          onPick={() => onPickRole(cardKey, role)}
        />
      ))}
      <div className="mt-0.5 text-[8px] leading-tight text-slate-300">
        执行时按左侧日期自动翻页并点选；上一年/下一年缺失时逐月翻页
      </div>
    </div>
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
    onPickLeftWeb,
    onTest,
  } = props;

  const draftReady = draftBinding.leftField.trim().length > 0;

  return (
    <div className="flex flex-col gap-2 px-2 py-1.5">
      {/* 标题 + 提取入口 */}
      <div className="flex items-center gap-1 text-[10px] font-bold text-violet-800">
        <List className="h-3 w-3 text-violet-700" />
        控件提取 — 点击展开型的框框（选项卡 / 日历）
      </div>
      <div className="flex items-center gap-1.5">
        {pickingKind ? (
          <button
            onClick={onCancelPick}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-violet-500 px-2 py-1 text-[10px] font-medium text-white animate-pulse"
          >
            <Crosshair className="h-3 w-3" />
            请在右侧网页点击{pickingKind === "option" ? "可展开选项的框框" : "日历框框"}…（点击取消）
          </button>
        ) : (
          <>
            <button
              onClick={() => onStartPick("option")}
              disabled={snapshotBusy}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-violet-600 px-2 py-1 text-[10px] font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-40"
              title="提取点击后展开选项列表的控件（下拉框/展开卡片）"
            >
              <Plus className="h-3 w-3" />
              选项控件
            </button>
            <button
              onClick={() => onStartPick("calendar")}
              disabled={snapshotBusy}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-violet-600 px-2 py-1 text-[10px] font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-40"
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
      {snapshotError && (
        <div className="rounded bg-rose-50 px-2 py-1 text-[9px] leading-snug text-rose-600 ring-1 ring-rose-100">
          {snapshotError}
        </div>
      )}

      {/* 草稿卡片：快照完成，待绑定保存 */}
      {draft && (
        <div className="flex flex-col gap-1.5 rounded-lg border-2 border-violet-300 bg-violet-50/60 px-2 py-1.5 ring-1 ring-violet-200">
          <div className="flex items-center gap-1">
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
          <WidgetCardBody
            widget={draft}
            cardKey="draft"
            rolePickingKey={rolePickingKey}
            onWidgetChange={onDraftChange}
            onPickRole={onPickRole}
          />
          <BindingRow
            binding={draftBinding}
            excelFields={excelFields}
            recordFields={recordFields}
            pickKey="draft"
            leftPickingKey={leftPickingKey}
            onChange={onDraftBindingChange}
            onPickLeftWeb={onPickLeftWeb}
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
              title="用当前卡片的值在右侧网页真实演练一遍"
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

      {/* 已保存控件卡片 */}
      {savedWidgets.map(({ mapping, widget }) => {
        const key = `saved:${mapping.right_selector}`;
        const binding: WidgetBinding = {
          leftSource: mapping.left_source,
          leftField: mapping.left_field,
          leftLabel: mapping.left_record_key || undefined,
        };
        const tr = testResults[key];
        return (
          <div
            key={key}
            className="flex flex-col gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50/40 px-2 py-1.5"
          >
            <div className="flex items-center gap-1">
              {widget.kind === "option" ? (
                <List className="h-3 w-3 shrink-0 text-emerald-600" />
              ) : (
                <CalendarDays className="h-3 w-3 shrink-0 text-emerald-600" />
              )}
              <span className="max-w-[130px] truncate text-[10px] font-bold text-emerald-800" title={widget.triggerSelector}>
                {widget.triggerLabel || mapping.right_label || "控件"}
              </span>
              <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[8px] text-emerald-700 ring-1 ring-emerald-200">
                {widget.kind === "option" ? "选项" : "日历"}·已保存
              </span>
              <button
                onClick={() => onRemoveSaved(mapping.right_selector)}
                className="ml-auto rounded p-0.5 text-slate-400 hover:bg-rose-100 hover:text-rose-500"
                title="删除此控件映射"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
            <WidgetCardBody
              widget={widget}
              cardKey={key}
              rolePickingKey={rolePickingKey}
              onWidgetChange={(w) => onUpdateSaved(mapping.right_selector, w)}
              onPickRole={onPickRole}
            />
            <BindingRow
              binding={binding}
              excelFields={excelFields}
              recordFields={recordFields}
              pickKey={key}
              leftPickingKey={leftPickingKey}
              onChange={(b) => onUpdateSavedBinding(mapping.right_selector, b)}
              onPickLeftWeb={onPickLeftWeb}
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
                title="用当前卡片的值在右侧网页真实演练一遍"
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
