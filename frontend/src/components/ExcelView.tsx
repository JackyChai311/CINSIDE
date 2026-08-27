import { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Link2,
  MousePointerClick,
  Search,
  Users,
  User,
  CreditCard,
  GraduationCap,
  X,
} from "lucide-react";
import type { ApplicantRecord, PickedMark } from "../types";
import { api } from "../api/client";

export interface ExcelPickedField {
  /** 字段名（列名） */
  field: string;
  /** 当前选中记录该字段的值（用于预览） */
  value: string;
  /** 字段所在的行 record_id */
  record_id: string;
}

/** 标准字段定义：标准 key → 显示名 + 图标 */
const STANDARD_FIELDS: { key: string; label: string; Icon: typeof User }[] = [
  { key: "name", label: "姓名", Icon: User },
  { key: "passport_no", label: "护照号", Icon: CreditCard },
  { key: "student_id", label: "学号", Icon: GraduationCap },
];

/** 单行 props：全部为原始值或身份稳定引用（memo 浅比较有效） */
interface ExcelRowProps {
  record: ApplicantRecord;
  /** 在 filtered 中的序号（斑马纹用） */
  idx: number;
  /** 在完整 records 中的真实序号 */
  realIdx: number;
  columns: string[];
  isSelected: boolean;
  inRange: boolean;
  isAnchor: boolean;
  isActiveRow: boolean;
  /** 仅活动行传入，非活动行恒为 null（避免 LOOP 逐字段推进时全表重渲染） */
  activeField: string | null;
  activeFieldStatus: "pending" | "match" | "mismatch" | "missing" | null;
  /** 仅活动行传入，非活动行恒为 undefined */
  rowFieldResults: Record<string, "match" | "mismatch" | "missing"> | undefined;
  rangeSelecting: boolean;
  cardsGenerated: boolean;
  selectedColumn: string | null;
  picking: boolean;
  canPick: boolean;
  /** 本行的拾取标记（field → mark），身份经 reconcile 缓存保持稳定 */
  rowMarks: Map<string, PickedMark> | undefined;
  /** 录入/审查步骤已选列：这些列不打数字徽标，整列显示选中底色 */
  stepPickedColumns: Set<string> | undefined;
  onRowNumClick: (realIdx: number) => void;
  onLoopCellClick: (realIdx: number) => void;
  onLoopCellMouseDown: (e: React.MouseEvent, realIdx: number) => void;
  onPickedField: (info: ExcelPickedField) => void;
}

/**
 * Excel 行组件（memo 化）：框选/点选时只有 inRange/isAnchor 等真正变化的行重渲染，
 * 不再整表（百行×数十列）重渲染——这是 LOOP 列点击/长按多选卡顿的修复核心。
 */
const ExcelRow = memo(function ExcelRow({
  record: r,
  idx,
  realIdx,
  columns,
  isSelected,
  inRange,
  isAnchor,
  isActiveRow,
  activeField,
  activeFieldStatus,
  rowFieldResults,
  rangeSelecting,
  cardsGenerated,
  selectedColumn,
  picking,
  canPick,
  rowMarks,
  stepPickedColumns,
  onRowNumClick,
  onLoopCellClick,
  onLoopCellMouseDown,
  onPickedField,
}: ExcelRowProps) {
  return (
    <tr
      data-record-id={r.record_id}
      data-real-idx={realIdx}
      className={[
        "transition-colors",
        isActiveRow
          ? "bg-slate-200/50"
          : inRange
          ? cardsGenerated
            ? "bg-emerald-50/60"
            : "bg-indigo-50/70"
          : isSelected
          ? "bg-brand-50/60"
          : idx % 2 === 0
          ? "bg-white/40"
          : "bg-slate-50/30",
      ].join(" ")}
    >
      <td
        onClick={() => onRowNumClick(realIdx)}
        className={[
          "px-2 py-1 font-mono text-[10px] transition-colors",
          rangeSelecting ? "cursor-pointer select-none hover:bg-indigo-100" : "",
          inRange
            ? cardsGenerated
              ? "font-semibold text-emerald-600"
              : "font-semibold text-indigo-600"
            : "text-slate-400",
          isAnchor ? "bg-indigo-200 text-indigo-800" : "",
        ].join(" ")}
        title={rangeSelecting ? "点击设定 LOOP 起止行（先点起始行，再点结束行）" : undefined}
      >
        {realIdx + 1}
      </td>
      {columns.map((c) => {
        const v = r.fields[c] || "";
        const display = v || "—";
        // 录入/审查步骤列：抑制数字徽标，用整列选中底色表达
        const inStepCol = !!stepPickedColumns?.has(c);
        const mark = inStepCol ? undefined : rowMarks?.get(c);
        const justPicked = !!mark && Date.now() - mark.createdAt < 2500;
        const colSelected = selectedColumn === c;
        // 框选模式下，点击 LOOP 列单元格也能选择范围
        const isLoopCol = rangeSelecting && c === selectedColumn;
        // LOOP 审查期：该单元格的比对状态（当前比对中 / 已有结果）
        const isActiveCell = isActiveRow && !!activeField && c === activeField;
        const cellReviewResult = isActiveRow ? rowFieldResults?.[c] : undefined;
        const reviewCellCls = isActiveCell
          ? activeFieldStatus === "match"
            ? "bg-emerald-100 outline outline-2 outline-emerald-500 -outline-offset-1 shadow-[0_0_0_3px_rgba(16,185,129,0.22),0_0_14px_rgba(16,185,129,0.45)]"
            : activeFieldStatus === "mismatch"
            ? "bg-rose-100 outline outline-2 outline-rose-500 -outline-offset-1 shadow-[0_0_0_3px_rgba(244,63,94,0.22),0_0_14px_rgba(244,63,94,0.45)]"
            : activeFieldStatus === "missing"
            ? "bg-amber-100 outline outline-2 outline-amber-500 -outline-offset-1 shadow-[0_0_0_3px_rgba(245,158,11,0.22),0_0_14px_rgba(245,158,11,0.45)]"
            : "bg-indigo-100 outline outline-2 outline-indigo-500 -outline-offset-1 shadow-[0_0_0_3px_rgba(99,102,241,0.22),0_0_14px_rgba(99,102,241,0.45)] animate-glow-pulse"
          : cellReviewResult === "match"
          ? "bg-emerald-50/80 outline outline-1 outline-emerald-300 -outline-offset-1"
          : cellReviewResult === "mismatch"
          ? "bg-rose-50/80 outline outline-1 outline-rose-300 -outline-offset-1"
          : cellReviewResult === "missing"
          ? "bg-amber-50/80 outline outline-1 outline-amber-300 -outline-offset-1"
          : "";
        return (
          <td
            key={c}
            data-real-idx={realIdx}
            data-field={c}
            onClick={() => {
              if (isLoopCol) {
                onLoopCellClick(realIdx);
                return;
              }
              if (canPick) {
                console.log("[ExcelView] 单元格点击", { field: c, value: v, recordId: r.record_id, picking });
                onPickedField({ field: c, value: v, record_id: r.record_id });
              }
            }}
            onMouseDown={isLoopCol ? (e) => onLoopCellMouseDown(e, realIdx) : undefined}
            className={[
              "group relative border-b border-slate-100/60 px-2 py-1 align-top transition-all",
              isLoopCol
                ? "cursor-pointer hover:bg-indigo-100 hover:ring-1 hover:ring-indigo-300"
                : picking || canPick
                ? "cursor-pointer hover:bg-brand-100/70 hover:ring-1 hover:ring-brand-300"
                : "",
              mark
                ? "bg-blue-100/80 outline outline-2 outline-blue-500 -outline-offset-1 shadow-[0_0_0_3px_rgba(59,130,246,0.25),0_0_14px_rgba(59,130,246,0.55)]"
                : inStepCol && !isLoopCol && !reviewCellCls
                ? "bg-brand-50/70"
                : "",
              colSelected && !mark && !inStepCol && !isLoopCol ? "bg-brand-50/60" : "",
              isLoopCol && inRange ? "bg-indigo-50/70" : "",
              isLoopCol && isAnchor ? "bg-indigo-200" : "",
              justPicked ? "animate-glow-pulse" : "",
              // LOOP 审查期单元格着色优先级最高（覆盖拾取/列选色）
              reviewCellCls,
            ].join(" ")}
            title={
              isLoopCol
                ? "点击两格设定起止行（中间行自动框选）；按下鼠标拖拽可连续框选多行"
                : picking
                ? `点击拾取字段「${c}」`
                : mark
                ? `第 ${mark.order} 个拾取 · ${mark.label}`
                : inStepCol
                ? `已选为录入/审查来源列「${c}」`
                : display
            }
          >
            <span className={["block max-w-[200px] truncate", v ? "text-slate-700" : "text-slate-300"].join(" ")}>
              {display}
            </span>
            {mark && (
              <span
                className="pointer-events-none absolute -left-1 -top-2 z-20 flex h-5 min-w-[20px] items-center justify-center gap-0.5 rounded-sm bg-blue-600 px-1 text-[10px] font-bold text-white shadow-lg ring-1 ring-white whitespace-nowrap"
                title={`第 ${mark.order} 个拾取 · ${mark.label}`}
              >
                {mark.order}
                {mark.action === "input" && <span className="text-[8px] font-normal opacity-90">输入</span>}
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
});

/** 后端可能作为别名自动添加的标准字段 key 集合（用于过滤重复列） */
const STANDARD_ALIAS_KEYS = new Set([
  "name", "passport_no", "student_id", "nationality", "birth_date", "gender",
  "passport_issue", "passport_expiry", "email", "phone",
  "university_url", "university_name",
]);

interface Props {
  records: ApplicantRecord[];
  selectedId: string | null;
  /** 是否处于元素拾取模式 */
  picking?: boolean;
  /** 拾取字段回调 */
  onPickedField?: (info: ExcelPickedField) => void;
  /** 已拾取的元素标记（用于在单元格上显示顺序编号） */
  pickedMarks?: PickedMark[];
  /** 脱离到独立窗口 */
  onDetach?: () => void;
  /** 切换到网页视图的回调 */
  onSwitchToWeb?: () => void;
  /** 教学模式中选中的 Excel 列（作为 LOOP 变量） */
  selectedColumn?: string | null;
  /** 选中/取消选中列 */
  onSelectColumn?: (field: string | null) => void;
  /** 是否嵌入在外部容器（如BrowserPane）中，为true时隐藏自有头部/边框/圆角，仅渲染内容 */
  embedded?: boolean;
  /** 仅用于脱离/嵌入的只读视图：显示哪几行在框选范围内（不参与框选逻辑） */
  rowRange?: { start: number; end: number } | null;
  /** 人物卡片是否已按范围生成 */
  cardsGenerated?: boolean;
  /** 一键生成人物卡片：传入切片后（deep-copy + 唯一 record_id）的新卡片数组 */
  onGenerateCards?: (newCards: ApplicantRecord[]) => void;
  /** 清空卡片并重置框选（回到待选状态） */
  onResetCards?: () => void;
  /** 字段列映射：标准字段名 -> Excel 原始列 key（手动标记列用） */
  fieldColumnMap?: Record<string, string>;
  /** 字段列映射变化回调 */
  onFieldColumnMapChange?: (field: string, columnKey: string | null) => void;
  /** 后端自动识别的列映射：原始列名 -> 标准字段名（用于过滤重复的标准别名列） */
  detectedColumnMap?: Record<string, string>;
  /** 已绑定到提取元素条目/输入步骤的列名集合（高亮显示绑定状态） */
  boundFields?: Set<string>;
  /** LOOP 审查期：当前执行的记录 id（平滑滚动到该行并高亮） */
  activeRecordId?: string | null;
  /** LOOP 审查期：当前比对的 Excel 列名（平滑滚动到该单元格并聚焦） */
  activeField?: string | null;
  /** LOOP 审查期：当前比对单元格状态 pending=比对中, match/mismatch/missing=比对结果 */
  activeFieldStatus?: "pending" | "match" | "mismatch" | "missing" | null;
  /** LOOP 审查期：当前记录已完成比对的列→结果（保持单元格着色） */
  fieldResults?: Record<string, "match" | "mismatch" | "missing">;
  /** 步骤卡片悬停/点击定位的列名：变化时平滑滚动到该列表头并短暂高亮 */
  focusColumn?: string | null;
  /** 数据侧（left/right）：底部状态条显示「导出」按钮，把修正后的数据写回 Excel */
  side?: "left" | "right";
}

/**
 * Excel 表格视图：展示 records 的所有字段，支持点击单元格拾取字段。
 * 用于在数据源位置与 BrowserPane 切换显示。
 */
export default function ExcelView({
  records,
  selectedId,
  picking = false,
  onPickedField,
  pickedMarks = [],
  onDetach,
  onSwitchToWeb,
  selectedColumn,
  onSelectColumn,
  embedded = false,
  rowRange: parentRowRange,
  cardsGenerated = false,
  onGenerateCards,
  onResetCards,
  fieldColumnMap = {},
  onFieldColumnMapChange,
  detectedColumnMap = {},
  boundFields,
  activeRecordId = null,
  activeField = null,
  activeFieldStatus = null,
  fieldResults,
  focusColumn = null,
  side,
}: Props) {
  const [filter, setFilter] = useState("");
  // ===== 行范围框选（两格点选 / 拖拽）：状态完全留在 ExcelView 内部 =====
  // 之前把 rowRange 放在 App 根组件，而 App 里有个 200+ 行的长 effect 把 rowRange
  // 放进了依赖数组——每次点行号/鼠标移动都会触发 App 整棵树重渲染，这就是框选卡顿的根源。
  // 现在 ExcelView 自持行范围，框选只在组件内部重渲染（单表），App 零重渲染。
  const [rangeAnchor, setRangeAnchor] = useState<number | null>(null);
  const [localRange, setLocalRange] = useState<{ start: number; end: number } | null>(null);
  const localRangeRef = useRef(localRange);
  localRangeRef.current = localRange;
  // 行范围：脱离/嵌入的只读视图用父级传入的 rowRange，交互视图用内部 localRange
  const rowRange = localRange ?? parentRowRange;
  const setRowRange = useCallback((r: { start: number; end: number } | null) => setLocalRange(r), []);
  // 导出 Excel：把内存中（修正后）的数据写回文件
  const [exporting, setExporting] = useState(false);
  const handleExport = async () => {
    if (!side || exporting) return;
    setExporting(true);
    try {
      const r = await api.exportExcel(side);
      if (r.mode === "inplace") {
        console.log(`[ExcelView] 已原地写回原文件：${r.path}`);
      } else {
        const a = document.createElement("a");
        a.href = r.path!;
        a.download = r.filename!;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(r.path!), 5000);
      }
    } catch (e) {
      console.warn("[ExcelView] 导出失败", e);
      alert(`导出失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setExporting(false);
    }
  };

  // 表头右键菜单状态
  const [ctxMenu, setCtxMenu] = useState<{
    column: string;
    x: number;
    y: number;
  } | null>(null);

  // LOOP 列选择状态（点击两格框选 与 拖拽框选 并存）
  const [dragSelecting, setDragSelecting] = useState(false);
  const dragStartRef = useRef<number | null>(null);            // 按下时的起始行（records 索引）
  const dragStartYRef = useRef<number | null>(null);           // 按下时的 clientY，用于区分"点击"与"拖拽"
  const didDragRef = useRef(false);                            // 本次手势是否已超过阈值成为拖拽
  const suppressClickRef = useRef(false);                      // 拖拽结束后抑制紧随的 click（避免误触发两格框选）
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);

  // ===== LOOP 审查期：平滑滚动定位到当前执行行/比对单元格（与网页侧高亮一致的直观对比） =====
  // 记录切换时：平滑滚动到该行（垂直居中）
  useEffect(() => {
    if (!activeRecordId) return;
    const tbody = tbodyRef.current;
    if (!tbody) return;
    const tr = tbody.querySelector(`tr[data-record-id="${CSS.escape(activeRecordId)}"]`);
    if (tr) {
      tr.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    }
  }, [activeRecordId]);

  // 比对字段切换时：平滑滚动到该行的具体单元格（水平居中，让"哪里在对比"直观可见）
  useEffect(() => {
    if (!activeRecordId || !activeField) return;
    const tbody = tbodyRef.current;
    if (!tbody) return;
    const cell = tbody.querySelector(
      `tr[data-record-id="${CSS.escape(activeRecordId)}"] td[data-field="${CSS.escape(activeField)}"]`
    );
    if (cell) {
      cell.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [activeRecordId, activeField]);

  // ===== 步骤卡片悬停/点击定位：平滑滚动到指定列的表头并短暂高亮（brand 色闪烁） =====
  const [flashColumn, setFlashColumn] = useState<string | null>(null);
  useEffect(() => {
    if (!focusColumn) return;
    const table = tbodyRef.current?.closest("table");
    const th = table?.querySelector(`thead th[data-column="${CSS.escape(focusColumn)}"]`);
    if (!th) return;
    th.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    setFlashColumn(focusColumn);
    const timer = setTimeout(() => setFlashColumn(null), 1600);
    return () => clearTimeout(timer);
  }, [focusColumn]);

  // record_id → records 数组索引（行范围基于完整 records 顺序，与搜索过滤无关）
  const recordIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    records.forEach((r, i) => m.set(r.record_id, i));
    return m;
  }, [records]);

  // 反向：列 key -> 标准字段 key（用于在表头显示已标记的标签）
  const colToStandard = useMemo(() => {
    const m = new Map<string, string>();
    Object.entries(fieldColumnMap).forEach(([std, col]) => m.set(col, std));
    return m;
  }, [fieldColumnMap]);

  // 已绑定列集合（兜底空集合，避免每次渲染新建）
  const boundSet = useMemo(() => boundFields ?? new Set<string>(), [boundFields]);

  // 被detectedColumnMap映射到的标准字段集合（这些标准key是后端自动添加的别名，应过滤掉）
  const detectedStandardKeys = useMemo(() => {
    return new Set(Object.values(detectedColumnMap));
  }, [detectedColumnMap]);

  // 是否处于行范围框选状态（有生成卡片能力即允许框选；脱离/嵌入只读视图不允许）
  const rangeSelecting = !!onGenerateCards && records.length > 0;

  // ===== 稳定回调（供 memo 化的 ExcelRow 使用，避免每次渲染都换引用导致全表重渲染）=====
  const rangeAnchorRef = useRef<number | null>(null);
  rangeAnchorRef.current = rangeAnchor;
  const rangeSelectingRef = useRef(rangeSelecting);
  rangeSelectingRef.current = rangeSelecting;

  // 点击行号：第一次定起始行，第二次定结束行（自动排序）
  const handleRowNumClick = useCallback((realIdx: number) => {
    if (!rangeSelectingRef.current) return;
    const anchor = rangeAnchorRef.current;
    if (anchor == null) {
      rangeAnchorRef.current = realIdx;
      setRangeAnchor(realIdx);
      setLocalRange({ start: realIdx, end: realIdx });
    } else {
      rangeAnchorRef.current = null;
      setRangeAnchor(null);
      setLocalRange({ start: Math.min(anchor, realIdx), end: Math.max(anchor, realIdx) });
    }
  }, []);

  // LOOP 列单元格点击：先消化"拖拽结束后的抑制 click"，否则走两格框选
  const handleLoopCellClick = useCallback((realIdx: number) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    handleRowNumClick(realIdx);
  }, [handleRowNumClick]);

  // 拾取回调稳定化（App 侧回调引用可能随渲染变化，这里用 ref 兜底）
  const pickedFieldRef = useRef(onPickedField);
  pickedFieldRef.current = onPickedField;
  const stablePickedField = useCallback((info: ExcelPickedField) => {
    pickedFieldRef.current?.(info);
  }, []);

  // 收集所有字段名（保持出现顺序，过滤后端自动添加的标准别名列）
  const columns = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) {
      for (const k of Object.keys(r.fields)) {
        // 过滤掉后端自动添加的标准字段别名：如果k是标准字段名，且detectedColumnMap中有其他列映射到它，说明k是别名
        if (STANDARD_ALIAS_KEYS.has(k) && detectedStandardKeys.has(k)) {
          // 进一步确认：检查是否存在原始列名（即detectedColumnMap的key中有映射到k的）
          const hasOriginalCol = Object.entries(detectedColumnMap).some(([origCol, stdKey]) => stdKey === k && origCol !== k);
          if (hasOriginalCol) continue; // 跳过别名列
        }
        // 过滤掉_source_sheet等内部字段
        if (k.startsWith("_")) continue;
        set.add(k);
      }
    }
    return Array.from(set);
  }, [records, detectedStandardKeys, detectedColumnMap]);

  // 过滤
  const filtered = useMemo(() => {
    if (!filter.trim()) return records;
    const q = filter.trim().toLowerCase();
    return records.filter((r) => {
      if (r.record_id.toLowerCase().includes(q)) return true;
      for (const v of Object.values(r.fields)) {
        if (v && v.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [records, filter]);

  // 拾取标记索引：recordId → (字段名 → mark)。两层 Map 按记录分组，
  // 配合 reconcile 缓存复用未变化行的内层 Map 引用——memo 行的 rowMarks prop 身份稳定，
  // 新增一个拾取标记时只有目标行重渲染，其余行 memo 直接命中。
  const marksCacheRef = useRef(new Map<string, Map<string, PickedMark>>());
  const marksByRecord = useMemo(() => {
    const grouped = new Map<string, Map<string, PickedMark>>();
    for (const mk of pickedMarks) {
      if (mk.source === "excel" && mk.excelRecordId && mk.excelField) {
        let inner = grouped.get(mk.excelRecordId);
        if (!inner) {
          inner = new Map();
          grouped.set(mk.excelRecordId, inner);
        }
        inner.set(mk.excelField, mk);
      }
    }
    const prev = marksCacheRef.current;
    const reconciled = new Map<string, Map<string, PickedMark>>();
    grouped.forEach((inner, rid) => {
      const p = prev.get(rid);
      if (p && p.size === inner.size) {
        let same = true;
        inner.forEach((v, k) => {
          if (p.get(k) !== v) same = false;
        });
        if (same) {
          reconciled.set(rid, p);
          return;
        }
      }
      reconciled.set(rid, inner);
    });
    marksCacheRef.current = reconciled;
    return reconciled;
  }, [pickedMarks]);

  // 录入/审查步骤设置：Excel 来源字段不打数字徽标，改为整列选中效果（brand 底色）
  // data-source 教学流程仍保留序号徽标（表示拾取顺序）
  const stepPickedColumns = useMemo(() => {
    const s = new Set<string>();
    for (const mk of pickedMarks) {
      if (mk.source === "excel" && (mk.workflow === "entry" || mk.workflow === "review") && mk.excelField) {
        s.add(mk.excelField);
      }
    }
    return s;
  }, [pickedMarks]);

  // 表头右键菜单：阻止默认菜单，弹出自定义菜单
  const handleHeaderContextMenu = (e: React.MouseEvent, column: string) => {
    if (!onFieldColumnMapChange) return;
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ column, x: e.clientX, y: e.clientY });
  };

  // 点击页面其他地方关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("contextmenu", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [ctxMenu]);

  const handleMarkColumn = (stdKey: string) => {
    if (!ctxMenu) return;
    // 先清除其他列占用的同一标准字段（避免重复）
    const existingCol = fieldColumnMap[stdKey];
    if (onFieldColumnMapChange) {
      // 如果点的是已经标记的同一列，则取消标记
      if (existingCol === ctxMenu.column) {
        onFieldColumnMapChange(stdKey, null);
      } else {
        onFieldColumnMapChange(stdKey, ctxMenu.column);
      }
    }
    setCtxMenu(null);
  };

  const handleClearColumnMark = () => {
    if (!ctxMenu) return;
    const stdKey = colToStandard.get(ctxMenu.column);
    if (stdKey && onFieldColumnMapChange) {
      onFieldColumnMapChange(stdKey, null);
    }
    setCtxMenu(null);
  };

  // ===== LOOP 列选择：点击两格定起止行 与 拖拽框选 并存 =====
  // 按下：只记录起点与坐标，不立即提交范围、不设置锚点——
  // 松开时没有明显位移 → 当作一次点击（交给 click 走两格框选）；
  // 位移超过阈值 → 进入拖拽连续框选。
  const handleLoopCellMouseDown = useCallback((e: React.MouseEvent, realIdx: number) => {
    if (!rangeSelectingRef.current) return;
    if (e.button !== 0) return; // 仅左键
    e.preventDefault();
    setDragSelecting(true);
    dragStartRef.current = realIdx;
    dragStartYRef.current = e.clientY;
    didDragRef.current = false;
    suppressClickRef.current = false;
  }, []);

  // 在 document 上监听 mousemove/mouseup：位移超过阈值视为拖拽。
  // 拖拽期间零 React 渲染——直接操作 DOM class（loop-drag-preview）做预览，
  // 松手时才一次性用内部 setRowRange 提交最终范围：整场拖拽最多 2 次组件内渲染
  //（成为拖拽时清旧高亮 + 松手提交），App 根组件全程不参与。
  useEffect(() => {
    if (!dragSelecting) return;
    const tbody = tbodyRef.current;
    if (!tbody) return;

    const getRealIdxFromEvent = (e: MouseEvent): number | null => {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!el) return null;
      const td = el.closest("td[data-real-idx]") as HTMLElement | null;
      if (!td) return null;
      const idx = td.getAttribute("data-real-idx");
      return idx != null ? parseInt(idx, 10) : null;
    };

    let lastRange: { start: number; end: number } | null = null;
    // 直接 DOM 预览：遍历 tbody 的直接子 <tr>，读 tr 自身的 data-real-idx（跳过 querySelector 与嵌套 tbody），
    // 已带类的行是 no-op，不触发样式重算。比每行 querySelector("td...") 快一个数量级。
    const applyPreview = (start: number, end: number) => {
      let node: Node | null = tbody.firstChild;
      while (node) {
        if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "TR") {
          const el = node as HTMLElement;
          const idxAttr = el.getAttribute("data-real-idx");
          const idx = idxAttr != null ? parseInt(idxAttr, 10) : -1;
          if (idx >= start && idx <= end) el.classList.add("loop-drag-preview");
          else el.classList.remove("loop-drag-preview");
        }
        node = node.nextSibling;
      }
    };
    const clearPreview = () => {
      let node: Node | null = tbody.firstChild;
      while (node) {
        if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "TR") {
          (node as HTMLElement).classList.remove("loop-drag-preview");
        }
        node = node.nextSibling;
      }
    };

    const onMove = (e: MouseEvent) => {
      const start = dragStartRef.current;
      if (start == null) return;
      // 位移未超过阈值 → 仍视为点击，不进入拖拽
      if (!didDragRef.current) {
        const dy = Math.abs(e.clientY - (dragStartYRef.current ?? e.clientY));
        if (dy < 4) return;
        didDragRef.current = true;
        // 成为真拖拽：清掉旧范围高亮（一次组件内渲染），新范围由 DOM 预览接管
        if (localRangeRef.current) setRowRange(null);
      }
      const cur = getRealIdxFromEvent(e);
      if (cur == null) return;
      lastRange = { start: Math.min(start, cur), end: Math.max(start, cur) };
      applyPreview(lastRange.start, lastRange.end);
    };
    const onUp = () => {
      setDragSelecting(false);
      clearPreview();
      const wasDrag = didDragRef.current;
      dragStartRef.current = null;
      dragStartYRef.current = null;
      didDragRef.current = false;
      if (wasDrag) {
        // 拖拽是一次完整手势：抑制随后的 click，并清空锚点允许下次重新开始
        suppressClickRef.current = true;
        setRangeAnchor(null);
        // 松手一次性提交最终范围（拖拽期间唯一一次范围提交）
        if (lastRange) setRowRange(lastRange);
      }
      // 未成为拖拽（纯点击）：保持锚点，交给 click 做两格框选
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      clearPreview();
    };
  }, [dragSelecting]);

  // 一键生成人物卡片：在 ExcelView 内部完成行范围切片 + 深拷贝 + 唯一 record_id，
  // 把准备好的卡片数组交给 App（App 不再持有 rowRange，也不再切片，避免框选触发 App 重渲染）
  const handleGenerateCards = () => {
    if (!onGenerateCards || !rowRange || records.length === 0) return;
    const slice = records.slice(rowRange.start, rowRange.end + 1);
    const newCards: ApplicantRecord[] = slice.map((r) => ({
      ...r,
      fields: { ...r.fields },
      passport_fields: r.passport_fields ? { ...r.passport_fields } : undefined,
      record_id: `${r.record_id}__${Math.random().toString(36).slice(2, 8)}`,
    }));
    onGenerateCards(newCards);
  };

  const tableContent = (
    <>
      {/* 搜索栏（嵌入模式下也保留） */}
      <div className="flex shrink-0 items-center gap-1 border-b border-slate-200/60 bg-white/60 px-2 py-1">
        {picking && (
          <span className="mr-1 inline-flex shrink-0 items-center gap-0.5 rounded-full bg-brand-500/15 px-1.5 py-0.5 text-[9px] font-medium text-brand-700 animate-glow-pulse">
            <MousePointerClick className="h-2.5 w-2.5" />
            点击拾取
          </span>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-white/60 bg-white/80 px-1.5 py-0.5">
          <Search className="h-2.5 w-2.5 shrink-0 text-slate-400" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索任意字段…"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-slate-700 outline-none placeholder:text-slate-400"
          />
        </div>
        {/* LOOP 行范围框选 + 追加生成卡片（卡片池模式：始终允许框选新段追加） */}
        {rangeSelecting && (
          <span className="flex shrink-0 items-center gap-1">
            <span className={[
              "text-[9px]",
              rowRange ? "font-medium text-indigo-600" : "text-slate-400",
            ].join(" ")}>
              {rowRange
                ? `已选 第${rowRange.start + 1}–${rowRange.end + 1}行 (${rowRange.end - rowRange.start + 1}行)`
                : rangeAnchor != null
                ? "再点/拖一行定结束行"
                : "点行号/LOOP列两格框选，或拖拽"}
            </span>
            {rowRange && (
              <button
                onClick={handleGenerateCards}
                className={[
                  "flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[9px] font-medium text-white transition-all",
                  cardsGenerated ? "bg-emerald-600 hover:bg-emerald-700" : "btn-flash-attention",
                ].join(" ")}
                title="按框选的行范围追加人物卡片到左侧列表"
              >
                <Users className="h-2.5 w-2.5" />
                {cardsGenerated ? "追加卡片" : "一键生成卡片"}
              </button>
            )}
            {cardsGenerated && onResetCards && (
              <button
                onClick={() => { setRowRange(null); setRangeAnchor(null); onResetCards(); }}
                className="rounded-md bg-slate-200 px-1.5 py-0.5 text-[9px] font-medium text-slate-600 hover:bg-slate-300"
                title="清空所有卡片，重新开始"
              >
                清空卡片
              </button>
            )}
          </span>
        )}
      </div>
      {/* 表格区 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {records.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-slate-400">
            <FileSpreadsheet className="h-8 w-8 text-slate-300" />
            <p>暂无 Excel 数据<br />请先上传 Excel/CSV</p>
          </div>
        ) : (
          <table className="w-full border-collapse text-[11px]">
            <thead className="sticky top-0 z-10 bg-slate-50/95 backdrop-blur">
              <tr>
                <th className="border-b border-slate-200 px-2 py-1.5 text-left font-semibold text-slate-500">
                  #
                </th>
                {columns.map((c) => {
                  const isSelected = selectedColumn === c;
                  const isFlashed = flashColumn === c;
                  const stdKey = colToStandard.get(c);
                  const stdField = stdKey ? STANDARD_FIELDS.find((f) => f.key === stdKey) : null;
                  const isBound = boundSet.has(c);
                  const inStepCol = stepPickedColumns.has(c);
                  return (
                    <th
                      key={c}
                      data-column={c}
                      onClick={() => onSelectColumn?.(isSelected ? null : c)}
                      onContextMenu={(e) => handleHeaderContextMenu(e, c)}
                      className={[
                        "group border-b border-slate-200 px-2 py-1.5 text-left font-semibold whitespace-nowrap transition-all",
                        onSelectColumn || onFieldColumnMapChange ? "cursor-pointer" : "",
                        "hover:bg-slate-100",
                        isFlashed
                          ? "bg-brand-100 text-brand-700 ring-1 ring-brand-300"
                          : isSelected
                          ? "bg-brand-100 text-brand-700 ring-1 ring-brand-300"
                          : isBound
                          ? "bg-violet-100 text-violet-700 ring-1 ring-violet-300"
                          : inStepCol
                          ? "bg-brand-50/80 text-brand-700"
                          : stdField
                          ? "bg-emerald-50 text-emerald-700"
                          : "text-slate-500",
                      ].join(" ")}
                      title={
                        (isBound ? `已绑定到提取元素/输入步骤 · LOOP 时逐行取「${c}」列的值\n` : "") +
                        (inStepCol ? `已选为录入/审查来源列\n` : "") +
                        (onFieldColumnMapChange
                          ? `右键标记此列（姓名/护照/学号）${onSelectColumn ? "；左键点击选中为 LOOP 变量" : ""}`
                          : onSelectColumn ? (isSelected ? "点击取消选中该列" : "点击选中该列作为 LOOP 变量") : c)
                      }
                    >
                      <div className="flex items-center gap-1">
                        <span className="max-w-[150px] truncate">{c}</span>
                        {isBound && (
                          <span
                            className="inline-flex items-center gap-0.5 rounded-full bg-violet-500/15 px-1 py-0 text-[9px] font-bold text-violet-700"
                            title={`该列已绑定到提取元素/输入步骤：LOOP 时逐行取「${c}」列的值`}
                          >
                            <Link2 className="h-2.5 w-2.5" />
                            绑定
                          </span>
                        )}
                        {stdField && (
                          <span
                            className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1 py-0 text-[9px] font-bold text-emerald-700"
                            title={`已标记为「${stdField.label}」列 · 右键可修改`}
                          >
                            <stdField.Icon className="h-2.5 w-2.5" />
                            {stdField.label}
                          </span>
                        )}
                        {isSelected && (
                          <span className="rounded-full bg-brand-500 px-1 py-0 text-[9px] font-bold text-white">LOOP</span>
                        )}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            {/* select-none 提到 tbody（user-select 级联到所有单元格）：
                行组件不再依赖 dragSelecting，mousedown 起手拖拽时整表零行重渲染 */}
            <tbody ref={tbodyRef} className={dragSelecting ? "select-none" : ""}>
              {filtered.map((r, idx) => {
                const realIdx = recordIndexMap.get(r.record_id) ?? idx;
                // LOOP 审查期：当前执行行高亮（中性聚焦色，区别于框选/选中色）
                const isActiveRow = !!activeRecordId && r.record_id === activeRecordId;
                return (
                  <ExcelRow
                    key={r.record_id}
                    record={r}
                    idx={idx}
                    realIdx={realIdx}
                    columns={columns}
                    isSelected={r.record_id === selectedId}
                    inRange={!!rowRange && realIdx >= rowRange.start && realIdx <= rowRange.end}
                    isAnchor={rangeSelecting && rangeAnchor === realIdx}
                    isActiveRow={isActiveRow}
                    activeField={isActiveRow ? activeField : null}
                    activeFieldStatus={isActiveRow ? activeFieldStatus : null}
                    rowFieldResults={isActiveRow ? fieldResults : undefined}
                    rangeSelecting={rangeSelecting}
                    cardsGenerated={cardsGenerated}
                    selectedColumn={selectedColumn ?? null}
                    picking={picking}
                    canPick={!!onPickedField}
                    rowMarks={marksByRecord.get(r.record_id)}
                    stepPickedColumns={stepPickedColumns}
                    onRowNumClick={handleRowNumClick}
                    onLoopCellClick={handleLoopCellClick}
                    onLoopCellMouseDown={handleLoopCellMouseDown}
                    onPickedField={stablePickedField}
                  />
                );
              })}
              {filtered.length === 0 && records.length > 0 && (
                <tr>
                  <td
                    colSpan={columns.length + 1}
                    className="px-2 py-6 text-center text-[11px] text-slate-400"
                  >
                    没有匹配的记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* 表头右键菜单：通过 Portal 挂载到 body，避免父容器 transform/overflow 导致定位错位 */}
      {ctxMenu && typeof document !== "undefined" && createPortal(
        <div
          className="fixed z-[9999] min-w-[180px] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl"
          style={{
            left: Math.min(ctxMenu.x, (window.innerWidth || 1200) - 200),
            top: Math.min(ctxMenu.y, (window.innerHeight || 800) - 160),
          }}
        >
          <div className="border-b border-slate-100 px-3 py-1.5 text-[10px] font-medium text-slate-400">
            标记 <span className="font-semibold text-slate-600">「{ctxMenu.column}」</span> 为：
          </div>
          {STANDARD_FIELDS.map(({ key, label, Icon }) => {
            const isMarked = fieldColumnMap[key] === ctxMenu.column;
            const otherCol = fieldColumnMap[key];
            return (
              <button
                key={key}
                type="button"
                onClick={() => handleMarkColumn(key)}
                className={[
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors",
                  isMarked
                    ? "bg-emerald-50 text-emerald-700"
                    : "text-slate-700 hover:bg-slate-50",
                ].join(" ")}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">{label}</span>
                {isMarked ? (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-600">
                    <Check className="h-3 w-3" /> 已标记
                  </span>
                ) : otherCol ? (
                  <span className="text-[10px] text-slate-400" title={`当前标记在列「${otherCol}」，点击将切换至此列`}>
                    替换「{otherCol.length > 6 ? otherCol.slice(0, 6) + "…" : otherCol}」
                  </span>
                ) : null}
              </button>
            );
          })}
          {colToStandard.get(ctxMenu.column) && (
            <>
              <div className="my-1 border-t border-slate-100" />
              <button
                type="button"
                onClick={handleClearColumnMark}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-rose-600 hover:bg-rose-50"
              >
                <X className="h-3.5 w-3.5 shrink-0" />
                清除此列标记
              </button>
            </>
          )}
        </div>,
        document.body
      )}
    </>
  );

  if (embedded) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-white">
        {tableContent}
        {/* 底部状态条 */}
        <div className="flex shrink-0 items-center justify-between border-t border-slate-200/60 px-2 py-0.5 text-[10px] text-slate-400">
          <span>{filtered.length} / {records.length} 行</span>
          <span className="flex items-center gap-2">
            <span>{columns.length} 列</span>
            {side && (
              <button
                onClick={handleExport}
                disabled={exporting}
                className="flex items-center gap-0.5 rounded-md bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600 ring-1 ring-slate-300 transition-colors hover:bg-slate-200 hover:text-slate-800 disabled:opacity-50"
                title="把修正后的数据写回 Excel（本地文件原地写回，否则下载副本）"
              >
                <Download className="h-3 w-3" />
                {exporting ? "导出中…" : "导出"}
              </button>
            )}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl bg-white/40 backdrop-blur-xl ring-1 ring-slate-200/60">
      {/* 顶部：标题 + 切换 + 搜索 + 脱离 */}
      <div className="glass-frame flex shrink-0 items-center gap-2 border-b border-white/40 px-2 py-1">
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            onClick={onSwitchToWeb}
            className="flex items-center rounded bg-slate-100 px-1 py-0.5 text-[9px] font-medium text-slate-500 transition-all hover:bg-slate-200"
            title="切换到网页视图"
          >
            网页
          </button>
          <button
            className="flex items-center rounded bg-brand-600 px-1 py-0.5 text-[9px] font-medium text-white transition-all"
            title="当前为 Excel 视图"
          >
            Excel
          </button>
        </div>
        {onDetach && (
          <button
            onClick={onDetach}
            className="rounded p-0.5 text-slate-400 hover:bg-white/60 hover:text-brand-600"
            title="脱离到独立窗口"
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        )}
      </div>

      {tableContent}

      {/* 底部状态条 */}
      <div className="flex shrink-0 items-center justify-between border-t border-slate-200/60 px-2 py-0.5 text-[10px] text-slate-400">
        <span>{filtered.length} / {records.length} 行</span>
        <span>{columns.length} 列</span>
      </div>
    </div>
  );
}
