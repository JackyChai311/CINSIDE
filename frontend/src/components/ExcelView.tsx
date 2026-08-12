import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
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
  /** LOOP 行范围框选（0-based 闭区间，基于 records 数组顺序） */
  rowRange?: { start: number; end: number } | null;
  /** 更新行范围框选 */
  onRowRangeChange?: (range: { start: number; end: number } | null) => void;
  /** 人物卡片是否已按范围生成 */
  cardsGenerated?: boolean;
  /** 一键生成人物卡片 */
  onGenerateCards?: () => void;
  /** 重新框选（清除已生成卡片） */
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
  rowRange = null,
  onRowRangeChange,
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
}: Props) {
  const [filter, setFilter] = useState("");
  // 行范围框选的锚点行（第一次点击的行号，0-based records 索引）
  const [rangeAnchor, setRangeAnchor] = useState<number | null>(null);

  // 表头右键菜单状态
  const [ctxMenu, setCtxMenu] = useState<{
    column: string;
    x: number;
    y: number;
  } | null>(null);

  // LOOP 列拖拽选择状态
  const [dragSelecting, setDragSelecting] = useState(false);
  const dragStartRef = useRef<number | null>(null);
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

  // 是否处于行范围框选状态（卡片池模式下始终允许框选新段）
  const rangeSelecting = !!onRowRangeChange;

  // 点击行号：第一次定起始行，第二次定结束行（自动排序）
  const handleRowNumClick = (realIdx: number) => {
    if (!rangeSelecting || !onRowRangeChange) return;
    if (rangeAnchor == null) {
      setRangeAnchor(realIdx);
      onRowRangeChange({ start: realIdx, end: realIdx });
    } else {
      onRowRangeChange({ start: Math.min(rangeAnchor, realIdx), end: Math.max(rangeAnchor, realIdx) });
      setRangeAnchor(null);
    }
  };

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

  // ===== LOOP 列拖拽选择（长按/按下鼠标往下拖即选择范围） =====
  const handleLoopCellMouseDown = (e: React.MouseEvent, realIdx: number) => {
    if (!rangeSelecting || !onRowRangeChange) return;
    if (e.button !== 0) return; // 仅左键
    e.preventDefault();
    setDragSelecting(true);
    dragStartRef.current = realIdx;
    setRangeAnchor(realIdx);
    onRowRangeChange({ start: realIdx, end: realIdx });
  };

  // 在 tbody 上监听 mousemove/mouseup，避免快速拖拽漏事件
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

    const onMove = (e: MouseEvent) => {
      const start = dragStartRef.current;
      if (start == null || !onRowRangeChange) return;
      const cur = getRealIdxFromEvent(e);
      if (cur == null) return;
      onRowRangeChange({ start: Math.min(start, cur), end: Math.max(start, cur) });
    };
    const onUp = () => {
      setDragSelecting(false);
      dragStartRef.current = null;
      // 注意：不清除 rangeAnchor——保持锚点状态和点击选择一致；
      // 但是拖拽完成相当于已经选定了一个范围，所以清除锚点允许下次重新开始
      setRangeAnchor(null);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragSelecting, onRowRangeChange]);

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
        {onRowRangeChange && records.length > 0 && (
          <span className="flex shrink-0 items-center gap-1">
            <span className={[
              "text-[9px]",
              rowRange ? "font-medium text-indigo-600" : "text-slate-400",
            ].join(" ")}>
              {rowRange
                ? `已选 第${rowRange.start + 1}–${rowRange.end + 1}行 (${rowRange.end - rowRange.start + 1}行)`
                : rangeAnchor != null
                ? "再点/拖一行定结束行"
                : "点行号/拖LOOP列框选"}
            </span>
            {rowRange && onGenerateCards && (
              <button
                onClick={onGenerateCards}
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
                onClick={onResetCards}
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
                  const stdKey = colToStandard.get(c);
                  const stdField = stdKey ? STANDARD_FIELDS.find((f) => f.key === stdKey) : null;
                  const isBound = boundSet.has(c);
                  return (
                    <th
                      key={c}
                      onClick={() => onSelectColumn?.(isSelected ? null : c)}
                      onContextMenu={(e) => handleHeaderContextMenu(e, c)}
                      className={[
                        "group border-b border-slate-200 px-2 py-1.5 text-left font-semibold whitespace-nowrap transition-all",
                        onSelectColumn || onFieldColumnMapChange ? "cursor-pointer" : "",
                        "hover:bg-slate-100",
                        isSelected
                          ? "bg-brand-100 text-brand-700 ring-1 ring-brand-300"
                          : isBound
                          ? "bg-violet-100 text-violet-700 ring-1 ring-violet-300"
                          : stdField
                          ? "bg-emerald-50 text-emerald-700"
                          : "text-slate-500",
                      ].join(" ")}
                      title={
                        (isBound ? `已绑定到提取元素/输入步骤 · LOOP 时逐行取「${c}」列的值\n` : "") +
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
            <tbody ref={tbodyRef}>
              {filtered.map((r, idx) => {
                const isSelected = r.record_id === selectedId;
                const realIdx = recordIndexMap.get(r.record_id) ?? idx;
                const inRange = !!rowRange && realIdx >= rowRange.start && realIdx <= rowRange.end;
                const isAnchor = rangeSelecting && rangeAnchor === realIdx;
                // LOOP 审查期：当前执行行高亮（中性聚焦色，区别于框选/选中色）
                const isActiveRow = !!activeRecordId && r.record_id === activeRecordId;
                return (
                  <tr
                    key={r.record_id}
                    data-record-id={r.record_id}
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
                      dragSelecting ? "select-none" : "",
                    ].join(" ")}
                  >
                    <td
                      onClick={() => handleRowNumClick(realIdx)}
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
                      title={rangeSelecting ? (rangeAnchor == null ? "点击设为 LOOP 起始行" : "点击设为 LOOP 结束行") : undefined}
                    >
                      {realIdx + 1}
                    </td>
                    {columns.map((c) => {
                      const v = r.fields[c] || "";
                      const display = v || "—";
                      const mark = pickedMarks.find(
                        (m) => m.source === "excel" && m.excelRecordId === r.record_id && m.excelField === c
                      );
                      const justPicked = !!mark && Date.now() - mark.createdAt < 2500;
                      const colSelected = selectedColumn === c;
                      // 框选模式下，点击 LOOP 列单元格也能选择范围
                      const isLoopCol = rangeSelecting && c === selectedColumn;
                      // LOOP 审查期：该单元格的比对状态（当前比对中 / 已有结果）
                      const isActiveCell = isActiveRow && !!activeField && c === activeField;
                      const cellReviewResult = isActiveRow ? fieldResults?.[c] : undefined;
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
                              handleRowNumClick(realIdx);
                              return;
                            }
                            if (onPickedField) {
                              console.log("[ExcelView] 单元格点击", { field: c, value: v, recordId: r.record_id, picking });
                              onPickedField({ field: c, value: v, record_id: r.record_id });
                            }
                          }}
                          onMouseDown={isLoopCol ? (e) => handleLoopCellMouseDown(e, realIdx) : undefined}
                          className={[
                            "group relative border-b border-slate-100/60 px-2 py-1 align-top transition-all",
                            isLoopCol
                              ? "cursor-pointer hover:bg-indigo-100 hover:ring-1 hover:ring-indigo-300"
                              : (picking || onPickedField)
                              ? "cursor-pointer hover:bg-brand-100/70 hover:ring-1 hover:ring-brand-300"
                              : "",
                            mark
                              ? "bg-blue-100/80 outline outline-2 outline-blue-500 -outline-offset-1 shadow-[0_0_0_3px_rgba(59,130,246,0.25),0_0_14px_rgba(59,130,246,0.55)]"
                              : "",
                            colSelected && !mark && !isLoopCol ? "bg-brand-50/60" : "",
                            isLoopCol && inRange ? "bg-indigo-50/70" : "",
                            isLoopCol && isAnchor ? "bg-indigo-200" : "",
                            justPicked ? "animate-glow-pulse" : "",
                            // LOOP 审查期单元格着色优先级最高（覆盖拾取/列选色）
                            reviewCellCls,
                          ].join(" ")}
                          title={
                            isLoopCol
                              ? "按下鼠标向下拖拽即可框选多行；点击可设置起止行"
                              : (picking ? `点击拾取字段「${c}」` : (mark ? `第 ${mark.order} 个拾取 · ${mark.label}` : display))
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
          <span>{columns.length} 列</span>
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
