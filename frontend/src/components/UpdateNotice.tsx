import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";

/** 应用更新状态（与 App.tsx 的 updateStatus 保持一致） */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

interface UpdateNoticeProps {
  status: UpdateStatus;
  updateInfo: { version: string } | null;
  updateProgress: number;
  updateError: string | null;
  onDownload: () => void;
  onInstall: () => void;
  /**
   * compact=true 时只显示"进行中 / 待处理"（下载中、已下载待重启、失败），
   * 隐藏空闲的"发现新版本可下载"，用于标题栏等全局角落；
   * 首页用完整模式（含"发现新版本"），让用户在入口就能主动下载。
   */
  compact?: boolean;
}

/**
 * 应用更新提示条：覆盖「发现新版本 → 下载中 → 已下载待安装 → 失败」全流程。
 * 首页（TaskSelector）与顶部标题栏共用同一组件，样式保持一致。
 */
export default function UpdateNotice({
  status,
  updateInfo,
  updateProgress,
  updateError,
  onDownload,
  onInstall,
  compact,
}: UpdateNoticeProps) {
  if (status === "idle" || status === "checking") return null;
  if (status === "available" && compact) return null;

  if (status === "available" && updateInfo) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-indigo-50 px-2 py-1 text-[11px] text-indigo-700 border border-indigo-200">
        <span className="font-semibold">发现新版本 v{updateInfo.version}</span>
        <button
          onClick={onDownload}
          className="rounded bg-indigo-600 px-2 py-0.5 text-white hover:bg-indigo-700 text-[11px] font-medium"
        >
          立即下载
        </button>
      </div>
    );
  }

  if (status === "downloading") {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-violet-50 px-2 py-1 text-[11px] text-violet-700 border border-violet-200 min-w-[160px]">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="font-medium">下载中</span>
        <div className="flex-1 h-1.5 bg-violet-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-violet-600 transition-all"
            style={{ width: `${updateProgress}%` }}
          />
        </div>
        <span className="text-violet-600 font-mono text-[10px]">{updateProgress}%</span>
      </div>
    );
  }

  if (status === "downloaded" && updateInfo) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700 border border-emerald-200">
        <CheckCircle2 className="h-3.5 w-3.5" />
        <span className="font-semibold">v{updateInfo.version} 已下载</span>
        <button
          onClick={onInstall}
          className="rounded bg-emerald-600 px-2 py-0.5 text-white hover:bg-emerald-700 text-[11px] font-medium"
        >
          立即重启安装
        </button>
      </div>
    );
  }

  if (status === "error" && updateError) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-lg bg-rose-50 px-2 py-1 text-[10px] text-rose-600 border border-rose-200"
        title={updateError}
      >
        <AlertCircle className="h-3 w-3" />
        <span>更新失败</span>
      </div>
    );
  }

  return null;
}