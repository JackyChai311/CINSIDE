import { useEffect, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  Download,
  Globe,
  Loader2,
  Play,
  Square,
  Trash2,
  XCircle,
} from "lucide-react";
import type { PluginRecord, PluginStatus } from "../types";
import { api } from "../api/client";

const STATUS_STYLE: Record<PluginRecord["status"], { label: string; cls: string }> = {
  success: { label: "成功", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  partial: { label: "部分填写", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  failed: { label: "失败", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
};

/** 站外循环「站外循环记录」面板：展示站外循环的状态与全部数据痕迹 */
export default function PluginPanel() {
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [records, setRecords] = useState<PluginRecord[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const timerRef = useRef<number | null>(null);
  const runningRef = useRef(false);

  const refresh = async () => {
    try {
      const [s, r] = await Promise.all([api.pluginStatus(), api.pluginRecords()]);
      setStatus(s);
      setRecords(r.records);
      setOffline(false);
      runningRef.current = !!s.running;
      // 自适应轮询：运行中 2s，空闲 6s
      if (timerRef.current != null) window.clearInterval(timerRef.current);
      timerRef.current = window.setInterval(refresh, s.running ? 2000 : 6000);
    } catch {
      setOffline(true);
    }
  };

  useEffect(() => {
    refresh();
    return () => {
      if (timerRef.current != null) window.clearInterval(timerRef.current);
    };
  }, []);

  const toggleRun = async () => {
    if (!status) return;
    setBusy(true);
    try {
      if (status.running) await api.pluginStop();
      else await api.pluginStart();
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    if (!confirm("确定清空全部站外循环记录？")) return;
    await api.pluginClearRecords();
    await refresh();
  };

  const exportCsv = () => {
    const rows: string[][] = [["时间", "来源页面", "来源URL", "字段", "提取值", "填写结果", "状态", "错误"]];
    for (const r of records) {
      const keys = Object.keys(r.fields);
      if (!keys.length) {
        rows.push([r.time, r.source.title, r.source.url, "", "", "", r.status, r.error || ""]);
        continue;
      }
      for (const k of keys) {
        const filledVal = r.filled?.[k];
        rows.push([
          r.time,
          r.source.title,
          r.source.url,
          k,
          r.fields[k] ?? "",
          filledVal !== undefined ? filledVal : r.missing?.includes(k) ? "未匹配" : "",
          r.status,
          r.error || "",
        ]);
      }
    }
    const csv = "﻿" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `站外循环记录_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const dotCls = status?.last_error
    ? "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.6)]"
    : status?.running
      ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)] animate-pulse"
      : "bg-slate-300";

  // 统计
  const stats = records.length
    ? {
        success: records.filter((r) => r.status === "success").length,
        partial: records.filter((r) => r.status === "partial").length,
        failed: records.filter((r) => r.status === "failed").length,
      }
    : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 状态栏 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-100 bg-gradient-to-r from-slate-50/80 to-white px-3 py-2">
        <span className={`h-2.5 w-2.5 rounded-full ${dotCls}`} />
        <span className="text-xs font-semibold text-slate-700">
          {offline ? "后端未连接" : status?.running ? "体外循环运行中" : "待机"}
        </span>
        {status?.current_action && (
          <span className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
            <Loader2 className="h-3 w-3 animate-spin text-brand-500" />
            {status.current_action}
          </span>
        )}
        {status && (
          <span className="text-[11px] text-slate-400">
            提取源 <span className="font-medium text-slate-500">{status.sources.length}</span> · 操作页 {status.target ? status.target.title : "未设置"}
          </span>
        )}
        {stats && (
          <span className="flex items-center gap-1.5 text-[11px]">
            <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-600">{stats.success} 成功</span>
            <span className="rounded-full bg-amber-50 px-1.5 py-0.5 font-medium text-amber-600">{stats.partial} 部分</span>
            <span className="rounded-full bg-rose-50 px-1.5 py-0.5 font-medium text-rose-600">{stats.failed} 失败</span>
          </span>
        )}
        {status?.last_error && (
          <span className="max-w-[30%] truncate text-[11px] text-rose-600" title={status.last_error}>
            {status.last_error}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={toggleRun}
          disabled={busy || offline}
          className={[
            "flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-white shadow-sm transition-all disabled:opacity-50",
            status?.running
              ? "bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700"
              : "bg-gradient-to-r from-brand-500 to-brand-600 hover:from-brand-600 hover:to-brand-700",
          ].join(" ")}
          title={status?.running ? "停止体外循环" : "启动体外循环（也可在屏幕边缘的悬浮条上操作）"}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : status?.running ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          {status?.running ? "停止" : "开始"}
        </button>
        <button
          onClick={exportCsv}
          disabled={!records.length}
          className="flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 transition-all hover:bg-slate-50 hover:ring-slate-300 disabled:opacity-50"
          title="导出全部记录为 CSV（可用 Excel 打开）"
        >
          <Download className="h-3 w-3" /> 导出
        </button>
        <button
          onClick={clearAll}
          disabled={!records.length}
          className="flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 transition-all hover:bg-rose-50 hover:text-rose-600 hover:ring-rose-200 disabled:opacity-50"
          title="清空全部站外循环记录"
        >
          <Trash2 className="h-3 w-3" /> 清空
        </button>
      </div>

      {/* 记录列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!records.length && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-300">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-50 to-slate-100">
              <Bot className="h-8 w-8 text-slate-300" />
            </div>
            <p className="max-w-[220px] text-center text-xs leading-relaxed text-slate-400">
              暂无记录。在屏幕边缘的悬浮条上设置「提取源」和「操作页」并点击开始，AI 体外循环的每条数据痕迹都会留在这里。
            </p>
          </div>
        )}
        <div className="space-y-2">
          {records.map((r) => {
            const st = STATUS_STYLE[r.status] || STATUS_STYLE.failed;
            const open = !!expanded[r.id];
            const fieldKeys = Object.keys(r.fields || {});
            return (
              <div key={r.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-all hover:shadow-md">
                {/* 卡片标题栏 */}
                <div className="flex items-center gap-2 border-b border-slate-100 bg-gradient-to-r from-slate-50/50 to-transparent px-3 py-1.5">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${st.cls}`}>{st.label}</span>
                  <span className="text-[11px] text-slate-400">{r.time}</span>
                  <span className="flex min-w-0 items-center gap-1 text-[11px] text-slate-500" title={r.source.url}>
                    <Globe className="h-3 w-3 shrink-0 text-slate-400" />
                    <span className="truncate">{r.source.title}</span>
                  </span>
                  <div className="flex-1" />
                  {r.error && (
                    <span className="flex max-w-[30%] items-center gap-1 truncate text-[11px] text-rose-600" title={r.error}>
                      <XCircle className="h-3 w-3 shrink-0" />
                      {r.error}
                    </span>
                  )}
                  <button
                    onClick={() => setExpanded((m) => ({ ...m, [r.id]: !m[r.id] }))}
                    className="rounded p-0.5 text-slate-400 transition-colors hover:bg-slate-100"
                    title={open ? "收起日志" : "展开日志"}
                  >
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
                  </button>
                </div>
                {/* 字段表 */}
                {fieldKeys.length > 0 && (
                  <table className="w-full text-[11px]">
                    <tbody>
                      {fieldKeys.map((k) => {
                        const filledVal = r.filled?.[k];
                        const isMissing = r.missing?.includes(k);
                        return (
                          <tr key={k} className="border-b border-slate-50 transition-colors last:border-0 hover:bg-slate-50/50">
                            <td className="w-[28%] select-none px-3 py-1 font-medium text-slate-500">{k}</td>
                            <td className="select-text px-2 py-1 text-slate-700">{r.fields[k]}</td>
                            <td className="w-[22%] px-3 py-1 text-right">
                              {filledVal !== undefined ? (
                                <span className="inline-flex items-center gap-1 text-emerald-600">
                                  <CheckCircle2 className="h-3 w-3" /> 已填写
                                </span>
                              ) : isMissing ? (
                                <span className="text-amber-600">未匹配</span>
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {/* 日志 */}
                {open && r.log?.length > 0 && (
                  <div className="border-t border-slate-100 bg-slate-50/60 px-3 py-2">
                    {r.log.map((line, i) => (
                      <p key={i} className="select-text border-l-2 border-slate-200 py-0.5 pl-2 text-[10px] leading-4 text-slate-500">
                        {line}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
