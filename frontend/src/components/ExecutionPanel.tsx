import { useState, useEffect, type RefObject } from "react";
import { Activity, Bot, CheckCircle2, Layers, UserCircle, X, XCircle } from "lucide-react";
import type { VerificationStep } from "../types";
import PluginPanel from "./PluginPanel";

interface Props {
  open: boolean;
  steps: VerificationStep[];
  logEndRef: RefObject<HTMLDivElement>;
  onClose: () => void;
}

type Tab = "steps" | "plugin";

export default function ExecutionPanel({ open, steps, logEndRef, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("steps");

  // 打开时默认切到"执行步骤"tab
  useEffect(() => {
    if (open) setActiveTab("steps");
  }, [open]);

  return (
    <>
      {/* 右侧面板 */}
      <div
        className={[
          "fixed right-0 top-0 z-[9999] flex h-full w-[360px] flex-col border-l border-slate-200 bg-white shadow-2xl transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "translate-x-full pointer-events-none",
        ].join(" ")}
      >
        {/* 面板头部 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 bg-gradient-to-r from-brand-50 to-white px-3 py-2">
          <Activity className="h-4 w-4 text-brand-600" />
          <span className="text-sm font-semibold text-slate-800">执行进度</span>
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
            {steps.length} 步
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={onClose}
              className="rounded-md p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-500 transition-colors"
              title="收起面板"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Tab 切换栏 */}
        <div className="flex shrink-0 border-b border-slate-100 bg-slate-50/40">
          <button
            onClick={() => setActiveTab("steps")}
            className={[
              "flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-medium transition-all",
              activeTab === "steps"
                ? "bg-white text-brand-700 shadow-[inset_0_-2px_0_0_var(--color-brand-600)]"
                : "text-slate-500 hover:text-slate-700 hover:bg-white/60",
            ].join(" ")}
          >
            <Activity className="h-3.5 w-3.5" />
            LOOP 执行步骤
          </button>
          <button
            onClick={() => setActiveTab("plugin")}
            className={[
              "flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-medium transition-all",
              activeTab === "plugin"
                ? "bg-white text-brand-700 shadow-[inset_0_-2px_0_0_var(--color-brand-600)]"
                : "text-slate-500 hover:text-slate-700 hover:bg-white/60",
            ].join(" ")}
          >
            <Bot className="h-3.5 w-3.5" />
            体外循环
          </button>
        </div>

        {/* Tab 内容 */}
        {activeTab === "steps" ? (
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {steps.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-[11px] text-slate-400">
                <Activity className="mb-1 h-8 w-8 text-slate-300" />
                执行时显示进度
              </div>
            ) : (
              <ul className="space-y-1.5">
                {steps.map((s) => {
                  if (s.isTaskStart) {
                    return (
                      <li key={`task-${s.step}`} className="-mx-2 my-2 first:mt-0">
                        <div className="flex items-center gap-2 rounded-lg border-2 border-indigo-300 bg-gradient-to-r from-indigo-600 to-violet-600 px-3 py-2 shadow-md">
                          <Layers className="h-4 w-4 shrink-0 text-white" />
                          <span className="text-[12px] font-bold text-white">{s.taskName || "任务"}</span>
                          <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold text-white">{s.taskIndex}/{s.taskTotal}</span>
                          <span className="ml-auto text-[10px] text-indigo-200">{s.taskRecordCount}张卡片</span>
                        </div>
                      </li>
                    );
                  }
                  if (s.isRecordStart) {
                    return (
                      <li key={`record-${s.step}`} className="-mx-1 my-1.5">
                        <div className="flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50/80 px-3 py-1.5 shadow-sm">
                          <UserCircle className="h-4 w-4 shrink-0 text-indigo-600" />
                          <span className="text-[11px] font-bold text-indigo-900">{s.recordName || "人物卡片"}</span>
                          <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white">{s.recordIndex}/{s.recordTotal}</span>
                        </div>
                      </li>
                    );
                  }
                  const icon = s.success
                    ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    : <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />;
                  return (
                    <li key={s.step} className="flex items-start gap-2 rounded px-2 py-1 hover:bg-slate-50/60">
                      {icon}
                      <span className="text-[11px] text-slate-600 leading-5">
                        {s.description}
                        {s.detail && <span className="ml-1 text-slate-400">— {s.detail}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <div ref={logEndRef} />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden">
            <PluginPanel />
          </div>
        )}
      </div>
    </>
  );
}
