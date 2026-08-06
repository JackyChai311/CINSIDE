import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Plus, Trash2 } from "lucide-react";

interface Props {
  onClose?: () => void;
}

const ROW_H = 28;
const COL_W = 100;
const HEADER_H = 30;

/** 空白可编辑表格：非受控 input，输入不触发重渲染，导出时从 DOM 读取数据 */
export default function BlankExcel({ onClose }: Props) {
  const [colCount, setColCount] = useState(6);
  const [rowCount, setRowCount] = useState(20);
  const [colNames, setColNames] = useState<string[]>(["列1", "列2", "列3", "列4", "列5", "列6"]);
  const [editingHeader, setEditingHeader] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  // 版本号：每次增删行列时 +1，强制 input 重新挂载以同步 defaultValue
  const structureVersion = useRef(0);
  const [, forceTick] = useState(0);

  // 从 DOM 读取所有单元格数据（导出时调用）
  const readData = useCallback((): string[][] => {
    const table = tableRef.current;
    if (!table) return [];
    const trs = table.querySelectorAll("tbody tr");
    const data: string[][] = [];
    trs.forEach((tr) => {
      const inputs = tr.querySelectorAll("input[data-cell]");
      const row: string[] = [];
      inputs.forEach((inp) => row.push((inp as HTMLInputElement).value));
      data.push(row);
    });
    return data;
  }, []);

  // 根据容器尺寸自动补充行列
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ensureFill = () => {
      const h = el.clientHeight;
      const w = el.clientWidth;
      const needRows = Math.max(20, Math.ceil((h - HEADER_H) / ROW_H) + 2);
      const needCols = Math.max(6, Math.ceil(w / COL_W) + 1);
      if (needRows > rowCount) setRowCount(needRows);
      if (needCols > colCount) {
        setColCount(needCols);
        setColNames((prev) => {
          const add = needCols - prev.length;
          return add > 0 ? [...prev, ...Array.from({ length: add }, (_, i) => `列${prev.length + i + 1}`)] : prev;
        });
      }
    };
    ensureFill();
    const ro = new ResizeObserver(ensureFill);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowCount, colCount]);

  const addCol = () => {
    setColCount((c) => c + 1);
    setColNames((prev) => [...prev, `列${prev.length + 1}`]);
    structureVersion.current++;
    forceTick((t) => t + 1);
  };

  const delCol = (idx: number) => {
    if (colCount <= 1) return;
    setColCount((c) => c - 1);
    setColNames((prev) => prev.filter((_, i) => i !== idx));
    structureVersion.current++;
    forceTick((t) => t + 1);
  };

  const addRow = () => {
    setRowCount((r) => r + 1);
    structureVersion.current++;
    forceTick((t) => t + 1);
  };

  const delRow = (idx: number) => {
    if (rowCount <= 1) return;
    setRowCount((r) => r - 1);
    structureVersion.current++;
    forceTick((t) => t + 1);
  };

  const setColName = (idx: number, name: string) => {
    setColNames((prev) => {
      const next = [...prev];
      next[idx] = name;
      return next;
    });
  };

  const exportCsv = () => {
    const data = readData();
    const lines: string[] = [];
    lines.push(colNames.map((c) => `"${c.replace(/"/g, '""')}"`).join(","));
    for (const row of data) {
      if (row.some((v) => v.trim())) {
        lines.push(row.map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
      }
    }
    const csv = "\uFEFF" + lines.join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `空白表格_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // 用 version 作为 key 前缀，增删行列时强制重新挂载 input
  const vKey = structureVersion.current;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      {/* 工具栏 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-200/60 px-2 py-1">
        <button onClick={addCol} className="flex items-center gap-0.5 rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 transition-all hover:bg-slate-200" title="添加列">
          <Plus className="h-3 w-3" /> 列
        </button>
        <button onClick={addRow} className="flex items-center gap-0.5 rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 transition-all hover:bg-slate-200" title="添加行">
          <Plus className="h-3 w-3" /> 行
        </button>
        <div className="mx-0.5 h-4 w-px bg-slate-200" />
        <button onClick={exportCsv} className="flex items-center gap-0.5 rounded-md bg-emerald-500 px-2 py-0.5 text-[10px] font-medium text-white transition-all hover:bg-emerald-600" title="导出 CSV">
          <Download className="h-3 w-3" /> 导出
        </button>
        {onClose && (
          <button onClick={onClose} className="ml-auto rounded-md p-0.5 text-slate-400 transition-all hover:bg-rose-50 hover:text-rose-500" title="关闭空白表格">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* 表格 */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <table ref={tableRef} className="w-full border-collapse table-fixed text-[11px]">
          <colgroup>
            <col style={{ width: 36 }} />
            {Array.from({ length: colCount }, (_, ci) => (
              <col key={ci} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 border border-slate-200 bg-slate-100 px-1 py-0.5 text-center text-[9px] font-normal text-slate-400">#</th>
              {colNames.slice(0, colCount).map((col, ci) => (
                <th key={ci} className="group relative border border-slate-200 bg-slate-100 px-1 py-0.5" style={{ height: HEADER_H }}>
                  {editingHeader === ci ? (
                    <input
                      autoFocus
                      value={col}
                      onChange={(e) => setColName(ci, e.target.value)}
                      onBlur={() => setEditingHeader(null)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setEditingHeader(null); }}
                      className="w-full bg-transparent text-center text-[11px] font-semibold text-slate-700 outline-none ring-1 ring-emerald-300"
                    />
                  ) : (
                    <div onClick={() => setEditingHeader(ci)} className="cursor-text truncate text-center font-semibold text-slate-700" title="点击编辑列名">
                      {col}
                    </div>
                  )}
                  {colCount > 1 && (
                    <button onClick={() => delCol(ci)} className="absolute -top-0.5 -right-0.5 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-rose-400 text-white group-hover:flex hover:bg-rose-500" title="删除列">
                      <span className="text-[8px] leading-none">×</span>
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowCount }, (_, ri) => (
              <tr key={`${vKey}-${ri}`} className="group/hover" style={{ height: ROW_H }}>
                <td className="sticky left-0 z-10 border border-slate-200 bg-slate-50 px-1 py-0.5 text-center text-[9px] text-slate-400">
                  <div className="flex items-center justify-center gap-0.5">
                    {ri + 1}
                    {rowCount > 1 && (
                      <button onClick={() => delRow(ri)} className="hidden h-3.5 w-3.5 items-center justify-center rounded-full text-rose-400 hover:bg-rose-100 hover:text-rose-600 group-hover/hover:flex" title="删除行">
                        <span className="text-[8px] leading-none">×</span>
                      </button>
                    )}
                  </div>
                </td>
                {Array.from({ length: colCount }, (_, ci) => (
                  <td key={`${vKey}-${ri}-${ci}`} className="border border-slate-200 p-0">
                    <input
                      data-cell
                      type="text"
                      defaultValue=""
                      className="h-full w-full bg-transparent px-1.5 py-0.5 text-[11px] text-slate-700 outline-none focus:bg-emerald-50/50 focus:ring-1 focus:ring-inset focus:ring-emerald-300"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 底部状态条 */}
      <div className="flex shrink-0 items-center justify-between border-t border-slate-200/60 px-2 py-0.5 text-[10px] text-slate-400">
        <span>{rowCount} 行</span>
        <span>{colCount} 列</span>
      </div>
    </div>
  );
}
