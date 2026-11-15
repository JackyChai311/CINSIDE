import { X, Palette, ShieldCheck, MonitorCheck, MonitorOff, Globe } from "lucide-react";
import ApiConfigSection from "./ApiConfigSection";
import type { AppSettings } from "../types";

interface PersonalPanelProps {
  open: boolean;
  onClose: () => void;
  /** AI 配置（识图 / 文本 / 全局分析 / PPT 配图） */
  settings: AppSettings;
  /** 字段变更：即时保存到后端并同步父级状态 */
  onSettingsChange: (patch: Partial<AppSettings>) => void;
  /** 防误关：开启后点关闭按钮最小化到系统托盘 */
  preventAccidentalClose: boolean;
  /** 切换防误关 */
  onPreventAccidentalCloseChange: (v: boolean) => void;
  /** LOOP 运行不息屏：执行期间阻止电脑息屏/休眠 */
  loopKeepAwake: boolean;
  /** 切换 LOOP 不息屏 */
  onLoopKeepAwakeChange: (v: boolean) => void;
}

export default function PersonalPanel({
  open,
  onClose,
  settings,
  onSettingsChange,
  preventAccidentalClose,
  onPreventAccidentalCloseChange,
  loopKeepAwake,
  onLoopKeepAwakeChange,
}: PersonalPanelProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(15,23,42,0.4)" }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-4 py-2.5">
          <Palette className="h-4 w-4 text-brand-600" />
          <span className="text-sm font-semibold text-slate-800">PERSONAL</span>
          <span className="text-[10px] text-slate-400">AI 配置 · 系统开关</span>
          <button
            onClick={onClose}
            className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* body：可滚动 */}
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {/* 防误关 + LOOP 不息屏：系统级开关 */}
          <div className="space-y-2">
            <button
              type="button"
              role="switch"
              aria-checked={preventAccidentalClose}
              onClick={() => onPreventAccidentalCloseChange(!preventAccidentalClose)}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 text-left transition-colors hover:bg-slate-100/70"
            >
              <ShieldCheck className={preventAccidentalClose ? "h-4 w-4 shrink-0 text-emerald-600" : "h-4 w-4 shrink-0 text-slate-400"} />
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-medium text-slate-700">防误关保护</span>
                <span className="block text-[10px] leading-tight text-slate-500">点关闭最小化到托盘，不真正退出</span>
              </span>
              <span className={[
                "relative inline-flex h-4.5 w-8 shrink-0 items-center rounded-full transition-colors",
                preventAccidentalClose ? "bg-emerald-500" : "bg-slate-300",
              ].join(" ")}>
                <span className={[
                  "inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform",
                  preventAccidentalClose ? "translate-x-[17px]" : "translate-x-0.5",
                ].join(" ")} />
              </span>
            </button>

            <button
              type="button"
              role="switch"
              aria-checked={loopKeepAwake}
              onClick={() => onLoopKeepAwakeChange(!loopKeepAwake)}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 text-left transition-colors hover:bg-slate-100/70"
            >
              {loopKeepAwake ? <MonitorCheck className="h-4 w-4 shrink-0 text-emerald-600" /> : <MonitorOff className="h-4 w-4 shrink-0 text-slate-400" />}
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-medium text-slate-700">LOOP 运行不息屏</span>
                <span className="block text-[10px] leading-tight text-slate-500">执行期间阻止息屏，结束后自动恢复</span>
              </span>
              <span className={[
                "relative inline-flex h-4.5 w-8 shrink-0 items-center rounded-full transition-colors",
                loopKeepAwake ? "bg-emerald-500" : "bg-slate-300",
              ].join(" ")}>
                <span className={[
                  "inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform",
                  loopKeepAwake ? "translate-x-[17px]" : "translate-x-0.5",
                ].join(" ")} />
              </span>
            </button>

            {/* 模拟网页：右侧网页默认载入内置 DEMO 演示站点 */}
            <button
              type="button"
              role="switch"
              aria-checked={settings.demo_site_enabled === true}
              onClick={() => onSettingsChange({ demo_site_enabled: settings.demo_site_enabled !== true })}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 text-left transition-colors hover:bg-slate-100/70"
            >
              <Globe className={settings.demo_site_enabled === true ? "h-4 w-4 shrink-0 text-brand-600" : "h-4 w-4 shrink-0 text-slate-400"} />
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-medium text-slate-700">模拟网页</span>
                <span className="block text-[10px] leading-tight text-slate-500">右侧默认载入内置学校系统 DEMO 站</span>
              </span>
              <span className={[
                "relative inline-flex h-4.5 w-8 shrink-0 items-center rounded-full transition-colors",
                settings.demo_site_enabled === true ? "bg-brand-500" : "bg-slate-300",
              ].join(" ")}>
                <span className={[
                  "inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform",
                  settings.demo_site_enabled === true ? "translate-x-[17px]" : "translate-x-0.5",
                ].join(" ")} />
              </span>
            </button>
          </div>

          {/* AI 配置区（识图 / 文本 / 全局分析 / PPT 配图） */}
          <ApiConfigSection settings={settings} onChange={onSettingsChange} />
        </div>
      </div>
    </div>
  );
}
