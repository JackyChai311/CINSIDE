import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Square, X, Zap } from "lucide-react";
import { api } from "../api/client";
import type { HarnessPlanStep, HarnessQueueTask } from "../types";

const ACTION_LABEL: Record<HarnessPlanStep["action"], string> = {
  click: "点击",
  input: "输入",
  select: "选择",
  press: "按键",
  scroll: "滚动",
  navigate: "打开",
  extract: "抽取",
  write: "写入",
  verify: "核对",
  wait: "等待",
  render: "渲染画面",
  narrate: "生成配音",
  compose: "合成视频",
  export: "交付文件",
};

/**
 * 执行浮窗：任务在跑的时候，把「确认过的流程 + 当前走到第几步」钉在浏览器右侧。
 *
 * 为什么不复用侧边大面板：用户要的是「看着光标一步步走」——
 * 网页必须占住屏幕主体，这里只留一张窄卡片，够看步骤和停手，不挡视线。
 */
export default function HarnessHud({
  task,
  onClose,
}: {
  task: HarnessQueueTask;
  onClose: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const steps = task.plan?.steps || [];
  const current = Math.max(0, task.steps - 1);
  const lastAction = task.actions[task.actions.length - 1] || "";

  const pct = useMemo(() => {
    if (!steps.length) return 0;
    return Math.min(100, Math.round((task.steps / steps.length) * 100));
  }, [steps.length, task.steps]);

  const stop = async () => {
    try {
      await api.harnessQueueCancel(task.id);
    } catch {
      /* 刚好结束 */
    }
  };

  return (
    <div
      className="pointer-events-auto fixed bottom-3 right-3 z-30 w-[268px] overflow-hidden rounded-[16px] border border-sky-300/70 bg-white/85 shadow-[0_18px_50px_-24px_rgba(2,132,199,.55)] backdrop-blur-md dark:border-sky-400/30 dark:bg-slate-900/85"
      role="status"
      aria-live="polite"
    >
      {/* 头部 */}
      <div className="flex items-center gap-1.5 border-b border-slate-200/70 px-2 py-1.5 dark:border-white/10">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-gradient-to-br from-violet-500 to-indigo-600 text-white">
          <Zap className="h-2.5 w-2.5" />
        </span>
        <span className="text-[10.5px] font-semibold text-slate-800 dark:text-slate-100">HARNESS</span>
        <span className="flex items-center gap-1 rounded-full bg-sky-100 px-1.5 py-[1px] text-[9px] font-medium text-sky-700 dark:bg-sky-400/15 dark:text-sky-300">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          执行中
        </span>
        {steps.length > 0 && (
          <span className="text-[9px] text-slate-400">
            {Math.min(task.steps, steps.length)}/{steps.length}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10"
            title={collapsed ? "展开步骤" : "收起步骤"}
          >
            {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          <button
            onClick={onClose}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10"
            title="收起（任务继续跑）"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* 进度条 */}
      <div className="h-[3px] w-full bg-slate-200/70 dark:bg-white/10">
        <div className="h-full bg-sky-500 transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>

      {!collapsed && (
        <div className="max-h-[42vh] overflow-y-auto px-2 py-1.5">
          <div className="mb-1 line-clamp-2 text-[9.5px] leading-relaxed text-slate-500 dark:text-slate-400">
            {task.instruction}
          </div>
          {steps.length === 0 && (
            <div className="space-y-0.5">
              {(task.actions.length ? task.actions : ["开始观察对象…"]).slice(-6).map((a, i) => (
                <div key={i} className="truncate text-[9px] text-slate-500 dark:text-slate-400">
                  {a}
                </div>
              ))}
            </div>
          )}
          {steps.map((s, i) => {
            const done = i < current;
            const active = i === current;
            return (
              <div
                key={s.id || i}
                className={[
                  "flex items-start gap-1 rounded px-1 py-[2px] text-[9px] leading-relaxed",
                  active
                    ? "bg-sky-100/90 font-medium text-sky-900 dark:bg-sky-400/15 dark:text-sky-200"
                    : done
                      ? "text-slate-400 dark:text-slate-500"
                      : "text-slate-500 dark:text-slate-400",
                ].join(" ")}
              >
                <span
                  className={[
                    "mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full",
                    active ? "animate-pulse bg-sky-500" : done ? "bg-emerald-400" : "bg-slate-300 dark:bg-white/20",
                  ].join(" ")}
                />
                <span className="shrink-0 opacity-60">{i + 1}.</span>
                <span className="shrink-0 opacity-70">
                  {s.side === "excel" ? "表格" : "网页"}·{ACTION_LABEL[s.action]}
                </span>
                <span className={["min-w-0 break-words", done ? "line-through" : ""].join(" ")}>
                  {s.target}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* 当前动作 + 停止 */}
      <div className="flex items-center gap-1 border-t border-slate-200/70 px-2 py-1.5 dark:border-white/10">
        <span className="min-w-0 flex-1 truncate text-[9px] text-slate-500 dark:text-slate-400" title={lastAction}>
          {lastAction || "…"}
        </span>
        <button
          onClick={() => void stop()}
          className="flex shrink-0 items-center gap-1 rounded-full bg-rose-600 px-2 py-[2px] text-[9px] font-semibold text-white hover:bg-rose-700"
        >
          <Square className="h-2.5 w-2.5" />
          停止
        </button>
      </div>
    </div>
  );
}
