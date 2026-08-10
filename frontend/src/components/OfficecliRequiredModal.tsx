import { useState } from "react";
import { Presentation, Download, Loader2, ShieldCheck, AlertCircle, X } from "lucide-react";
import { api } from "../api/client";

interface OfficecliRequiredModalProps {
  onClose: () => void;
  onInstalled: () => void;
}

export default function OfficecliRequiredModal({ onClose, onInstalled }: OfficecliRequiredModalProps) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleInstall = async () => {
    setInstalling(true);
    setError(null);
    try {
      const res = await api.installOfficecli();
      if (res.ok) {
        setSuccess(true);
        setTimeout(() => onInstalled(), 800);
      } else {
        setError(res.message || "安装失败，请重试");
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "安装失败，请检查网络后重试");
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-[440px] max-w-[92vw] rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-slate-200"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "officecli-modal-in .2s cubic-bezier(.22,1,.36,1) both" }}
      >
        {/* 关闭按钮 */}
        <button
          onClick={onClose}
          disabled={installing}
          className="absolute right-4 top-4 rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
        >
          <X className="h-4 w-4" />
        </button>

        {/* 图标 */}
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-violet-50 ring-1 ring-violet-100">
          <Presentation className="h-6 w-6 text-violet-600" />
        </div>

        {/* 标题 */}
        <h2 className="mb-1.5 text-lg font-bold text-slate-900">
          {success ? "OfficeCLI 安装成功" : "需要先安装 OfficeCLI"}
        </h2>
        <p className="mb-5 text-sm leading-relaxed text-slate-500">
          {success
            ? "正在进入幻灯片任务…"
            : "幻灯片任务需要 OfficeCLI 来读取和修改 PPT 文件。这是一个文档操作命令行工具，点击下方按钮即可一键下载安装。"}
        </p>

        {/* 错误提示 */}
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-xs text-red-700 ring-1 ring-red-100">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-pre-wrap">{error}</span>
          </div>
        )}

        {/* 成功提示 */}
        {success && (
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-xs font-medium text-emerald-700 ring-1 ring-emerald-100">
            <ShieldCheck className="h-4 w-4" />
            安装完成，即将进入幻灯片任务
          </div>
        )}

        {/* 按钮区 */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleInstall}
            disabled={installing || success}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-violet-700 active:scale-[.98] disabled:opacity-60"
          >
            {installing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                正在安装，请稍候…
              </>
            ) : success ? (
              <>
                <ShieldCheck className="h-4 w-4" />
                已安装
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                一键下载安装
              </>
            )}
          </button>
          {!success && (
            <button
              onClick={onClose}
              disabled={installing}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
            >
              取消
            </button>
          )}
        </div>

        <p className="mt-3 text-center text-[11px] text-slate-400">
          通过 npm 安装 · 约需数十秒至数分钟（取决于网络）
        </p>
      </div>

      <style>{`
        @keyframes officecli-modal-in {
          from { opacity: 0; transform: translateY(8px) scale(.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
