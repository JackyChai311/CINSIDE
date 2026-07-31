import { useMemo, useState } from "react";
import {
  Check,
  ExternalLink,
  FileSpreadsheet,
  MousePointerClick,
  Search,
  Users,
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
}: Props) {
  const [filter, setFilter] = useState("");
  // 行范围框选的锚点行（第一次点击的行号，0-based records 索引）
  const [rangeAnchor, setRangeAnchor] = useState<number | null>(null);

  // record_id → records 数组索引（行范围基于完整 records 顺序，与搜索过滤无关）
  const recordIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    records.forEach((r, i) => m.set(r.record_id, i));
    return m;
  }, [records]);

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

  // 收集所有字段名（保持出现顺序）
  const columns = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) {
      for (const k of Object.keys(r.fields)) set.add(k);
    }
    return Array.from(set);
  }, [records]);

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
                ? "再点一行定结束行"
                : "点行号框选范围"}
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
                  return (
                    <th
                      key={c}
                      onClick={() => onSelectColumn?.(isSelected ? null : c)}
                      className={[
                        "border-b border-slate-200 px-2 py-1.5 text-left font-semibold whitespace-nowrap transition-all",
                        onSelectColumn ? "cursor-pointer hover:bg-slate-100" : "",
                        isSelected
                          ? "bg-brand-100 text-brand-700 ring-1 ring-brand-300"
                          : "text-slate-500",
                      ].join(" ")}
                      title={onSelectColumn ? (isSelected ? "点击取消选中该列" : "点击选中该列作为 LOOP 变量") : c}
                    >
                      <div className="flex items-center gap-1">
                        {c}
                        {isSelected && (
                          <span className="rounded-full bg-brand-500 px-1 py-0 text-[9px] font-bold text-white">LOOP</span>
                        )}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, idx) => {
                const isSelected = r.record_id === selectedId;
                const realIdx = recordIndexMap.get(r.record_id) ?? idx;
                const inRange = !!rowRange && realIdx >= rowRange.start && realIdx <= rowRange.end;
                const isAnchor = rangeSelecting && rangeAnchor === realIdx;
                return (
                  <tr
                    key={r.record_id}
                    className={[
                      "transition-colors",
                      inRange
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
                      return (
                        <td
                          key={c}
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
                          ].join(" ")}
                          title={isLoopCol ? (rangeAnchor == null ? "点击设为 LOOP 起始行" : "点击设为 LOOP 结束行") : (picking ? `点击拾取字段「${c}」` : (mark ? `第 ${mark.order} 个拾取 · ${mark.label}` : display))}
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
