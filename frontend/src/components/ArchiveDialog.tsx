import { useRef, useState } from "react";
import {
  Archive,
  CheckCircle2,
  FileSpreadsheet,
  FolderOpen,
  Image,
  Loader2,
  PackageOpen,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { api } from "../api/client";
import type { ArchivePayload } from "../types";

interface Props {
  /** 导出统计（展示用） */
  stats: { cards: number; done: number; files: number; reports: number };
  /** 收集导出数据（App 内组装，含图片 base64） */
  buildPayload: () => Promise<ArchivePayload>;
  /** 导入还原（App 内恢复各状态） */
  onImported: (payload: ArchivePayload) => void;
  onClose: () => void;
}

export default function ArchiveDialog({ stats, buildPayload, onImported, onClose }: Props) {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    setMsg(null);
    try {
      const payload = await buildPayload();
      await api.archiveExport(payload);
      setMsg({ ok: true, text: `已导出 ${payload.records.length} 张卡片的完整归档（ZIP 已开始下载）` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "导出失败" });
    } finally {
      setExporting(false);
    }
  };

  const handleImportFile = async (file: File) => {
    if (importing) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setMsg({ ok: false, text: "请选择 CINSIDE 导出的 .zip 归档文件" });
      return;
    }
    setImporting(true);
    setMsg(null);
    try {
      const payload = await api.archiveImport(file);
      if (!payload.records?.length) throw new Error("归档内没有卡片数据");
      onImported(payload);
      setMsg({
        ok: true,
        text: `已还原「${payload.task_name}」：${payload.records.length} 张卡片、${payload.reports?.length || 0} 份报告、导出于 ${payload.exported_at || "未知时间"}`,
      });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "导入失败" });
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
        {/* 标题栏 */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2 text-slate-800">
            <Archive className="h-4 w-4 text-brand-500" />
            <span className="text-sm font-semibold">任务归档</span>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* 当前数据概览 */}
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: "卡片", value: stats.cards, icon: FolderOpen },
              { label: "已判定", value: stats.done, icon: CheckCircle2 },
              { label: "提取文件", value: stats.files, icon: Image },
              { label: "报告", value: stats.reports, icon: FileSpreadsheet },
            ].map(({ label, value, icon: Icon }) => (
              <div key={label} className="rounded-lg border border-slate-200 bg-slate-50/60 px-2 py-2.5 text-center">
                <Icon className="mx-auto mb-1 h-3.5 w-3.5 text-slate-400" />
                <div className="text-base font-semibold tabular-nums text-slate-700">{value}</div>
                <div className="text-[10px] text-slate-400">{label}</div>
              </div>
            ))}
          </div>

          {/* 导出 */}
          <button
            onClick={handleExport}
            disabled={exporting || stats.cards === 0}
            className={[
              "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
              exporting || stats.cards === 0
                ? "cursor-not-allowed border-slate-200 bg-slate-50 opacity-60"
                : "border-brand-200 bg-brand-50/60 hover:bg-brand-50",
            ].join(" ")}
          >
            {exporting ? (
              <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-500" />
            ) : (
              <PackageOpen className="h-5 w-5 shrink-0 text-brand-500" />
            )}
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-slate-700">
                {exporting ? "正在打包…" : "一键导出全部为 ZIP"}
              </div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                汇总 Excel（一人一行 + 字段对比明细）+ 按人分类的资料文件夹（资料信息 / 卡片图片 / 提取文件图片与全文）
              </div>
            </div>
          </button>

          {/* 导入 */}
          <button
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            className="flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3 text-left transition-colors hover:bg-slate-100/70 disabled:opacity-60"
          >
            {importing ? (
              <Loader2 className="h-5 w-5 shrink-0 animate-spin text-slate-500" />
            ) : (
              <Upload className="h-5 w-5 shrink-0 text-slate-500" />
            )}
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-slate-700">
                {importing ? "正在读取归档…" : "导入 ZIP 还原任务"}
              </div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                选择之前导出的归档，恢复当时的全部人物卡片、LOOP 设置、执行进度、字段对比报告与提取文件
              </div>
            </div>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImportFile(f);
            }}
          />

          {/* 提示 */}
          {msg && (
            <div
              className={[
                "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[11.5px] leading-relaxed",
                msg.ok
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-rose-200 bg-rose-50 text-rose-600",
              ].join(" ")}
            >
              {msg.ok ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : (
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              <span className="break-all">{msg.text}</span>
            </div>
          )}

          <p className="text-[10.5px] leading-relaxed text-slate-400">
            归档与 Excel 一样可脱离 CINSIDE 使用：manifest.json 记录完整进度，资料文件夹按「序号_姓名」模板分类，汇总表可直接打印留档。
          </p>
        </div>
      </div>
    </div>
  );
}
