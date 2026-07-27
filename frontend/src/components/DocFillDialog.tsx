import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Loader2, MoveRight, X } from "lucide-react";
import type { FieldMapping } from "../types";
import { FIELD_LABELS } from "../types";

export interface DocFillItem {
  field: string;
  value: string;
  selector: string;
}

interface Props {
  data: {
    filename: string;
    method: string;
    text: string;
    fields: Record<string, string>;
  };
  /** 当前字段映射：通过 left_field 找到右侧网页输入框 */
  mappings: FieldMapping[];
  /** 正在填入（显示加载态） */
  filling: boolean;
  onConfirm: (items: DocFillItem[]) => void;
  onCancel: () => void;
}

/** 功能2 审核弹窗：本地文件（护照等）提取字段 → 人工审核/修改 → 确认填入右侧网页输入框 */
export default function DocFillDialog({ data, mappings, filling, onConfirm, onCancel }: Props) {
  const [showText, setShowText] = useState(false);

  // 每个提取字段 → 右侧网页输入框映射（按 left_field 匹配）
  const rows = useMemo(
    () =>
      Object.entries(data.fields).map(([field, value]) => {
        const mapping = mappings.find((m) => m.left_field === field && m.right_selector);
        return {
          field,
          label: FIELD_LABELS[field] || field,
          value,
          selector: mapping?.right_selector || "",
          rightLabel: mapping?.right_label || "",
          fillable: Boolean(mapping?.right_selector),
        };
      }),
    [data.fields, mappings]
  );

  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(rows.filter((r) => r.fillable).map((r) => [r.field, true]))
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((r) => [r.field, r.value]))
  );

  const selectedItems: DocFillItem[] = rows
    .filter((r) => r.fillable && checked[r.field] && (values[r.field] || "").trim())
    .map((r) => ({ field: r.field, value: (values[r.field] || "").trim(), selector: r.selector }));

  const methodLabel =
    data.method === "vision_ocr" ? "Vision OCR（图片）" : data.method === "markitdown" ? "MarkItDown" : data.method;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* 头部 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-4 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
            <FileText className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-slate-800" title={data.filename}>
              {data.filename}
            </div>
            <div className="text-[10px] text-slate-400">{methodLabel} · 请审核提取结果，确认后填入右侧网页</div>
          </div>
          <button
            onClick={onCancel}
            disabled={filling}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 字段列表（可编辑） */}
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {rows.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              未提取到结构化字段
              <br />
              <span className="text-[10px]">请先在「字段映射」中配置映射，或查看下方原始文字</span>
            </div>
          ) : (
            <div className="space-y-2">
              {rows.map((r) => (
                <div
                  key={r.field}
                  className={[
                    "flex items-center gap-2 rounded-lg border px-2.5 py-2",
                    r.fillable ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50/60 opacity-70",
                  ].join(" ")}
                >
                  <input
                    type="checkbox"
                    checked={Boolean(checked[r.field])}
                    disabled={!r.fillable || filling}
                    onChange={(e) => setChecked((c) => ({ ...c, [r.field]: e.target.checked }))}
                    className="h-3.5 w-3.5 shrink-0 accent-indigo-600"
                    title={r.fillable ? "填入该字段" : "该字段没有对应的右侧输入框映射"}
                  />
                  <div className="w-20 shrink-0">
                    <div className="text-xs font-medium text-slate-700">{r.label}</div>
                    {r.fillable ? (
                      <div className="flex items-center gap-0.5 text-[9px] text-emerald-600" title={r.selector}>
                        <MoveRight className="h-2.5 w-2.5" />
                        <span className="truncate">{r.rightLabel || "右侧输入框"}</span>
                      </div>
                    ) : (
                      <div className="text-[9px] text-slate-400">无映射</div>
                    )}
                  </div>
                  <input
                    type="text"
                    value={values[r.field] ?? ""}
                    disabled={!r.fillable || filling}
                    onChange={(e) => setValues((v) => ({ ...v, [r.field]: e.target.value }))}
                    className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 font-mono text-xs text-slate-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-200 disabled:bg-slate-50"
                    placeholder="（空）"
                  />
                </div>
              ))}
            </div>
          )}

          {/* 原始提取文字（可折叠） */}
          {data.text && (
            <div className="mt-3">
              <button
                onClick={() => setShowText((v) => !v)}
                className="flex items-center gap-1 text-[10px] font-medium text-slate-500 hover:text-slate-700"
              >
                {showText ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                原始提取文字（{data.text.length} 字符）
              </button>
              {showText && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-100 bg-slate-50 p-2 font-mono text-[10px] leading-relaxed text-slate-600">
                  {data.text}
                </pre>
              )}
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-100 px-4 py-3">
          <span className="text-[10px] text-slate-400">
            已选 {selectedItems.length}/{rows.filter((r) => r.fillable).length} 个可填入字段
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              disabled={filling}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              取消
            </button>
            <button
              onClick={() => onConfirm(selectedItems)}
              disabled={filling || selectedItems.length === 0}
              className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
            >
              {filling && <Loader2 className="h-3 w-3 animate-spin" />}
              {filling ? "填入中…" : `确认填入右侧网页（${selectedItems.length}）`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
