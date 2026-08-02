import { useMemo, useState } from "react";
import { Download, FileDown, Loader2, X } from "lucide-react";
import { api } from "../api/client";

export type ExportFormat = "original" | "jpg" | "png" | "pdf";

interface Props {
  /** 源文件 dataUrl（data:xxx;base64,...） */
  dataUrl: string;
  filename: string;
  onClose: () => void;
  onToast?: (msg: string) => void;
  onError?: (msg: string) => void;
}

const FORMAT_OPTIONS: { key: ExportFormat; label: string }[] = [
  { key: "original", label: "原格式" },
  { key: "jpg", label: "JPG" },
  { key: "png", label: "PNG" },
  { key: "pdf", label: "PDF" },
];

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** 从 dataUrl 估算原始字节数 */
function dataUrlSize(dataUrl: string): number {
  const idx = dataUrl.indexOf(",");
  if (idx < 0) return 0;
  const b64 = dataUrl.slice(idx + 1);
  return Math.floor((b64.length * 3) / 4);
}

/** 文件导出对话框：格式转换 + 压缩到指定大小 */
export default function DocExportDialog({ dataUrl, filename, onClose, onToast, onError }: Props) {
  const [format, setFormat] = useState<ExportFormat>("original");
  const [compressOn, setCompressOn] = useState(true);
  const [sizeVal, setSizeVal] = useState("500");
  const [sizeUnit, setSizeUnit] = useState<"KB" | "MB">("KB");
  const [busy, setBusy] = useState(false);
  const [resultInfo, setResultInfo] = useState<{ size: number; reached: boolean; warnings: string[] } | null>(null);

  const origSize = useMemo(() => dataUrlSize(dataUrl), [dataUrl]);
  const isPdf = /\.pdf(\?|#|$)/i.test(filename) || dataUrl.startsWith("data:application/pdf");

  const doExport = async () => {
    if (busy) return;
    setBusy(true);
    setResultInfo(null);
    try {
      let targetKb = 0;
      if (compressOn) {
        const n = parseFloat(sizeVal);
        if (!isFinite(n) || n <= 0) {
          onError?.("请填写有效的目标大小");
          setBusy(false);
          return;
        }
        targetKb = Math.round(sizeUnit === "MB" ? n * 1024 : n);
      }
      const res = await api.convertDocument(dataUrl, filename, format, targetKb);
      // 组装导出文件名：原名去扩展名 + 新扩展名
      const stem = filename.replace(/\.[^.]+$/, "") || "export";
      const outName = `${stem}.${res.ext}`;
      const saved = await window.electronAPI?.saveExportedFile(outName, res.data_b64);
      if (!saved) {
        onError?.("当前环境不支持保存对话框");
      } else if (saved.canceled) {
        // 用户取消，不算错误
      } else if (saved.ok) {
        setResultInfo({ size: res.size, reached: res.reached, warnings: res.warnings || [] });
        onToast?.(`已导出：${outName}（${fmtSize(res.size)}）`);
      } else {
        onError?.(`保存失败: ${saved.error || "未知错误"}`);
      }
    } catch (e) {
      onError?.(`导出失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/30 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className="w-[340px] rounded-xl border border-teal-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b border-teal-100 bg-gradient-to-r from-teal-50 to-cyan-50 px-3 py-2">
          <FileDown className="h-3.5 w-3.5 text-teal-700" />
          <span className="text-[11px] font-semibold text-teal-900">导出文件</span>
          <span className="max-w-[150px] truncate text-[10px] text-slate-400" title={filename}>
            {filename}
          </span>
          <button
            onClick={onClose}
            className="ml-auto rounded-md p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
            title="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-3 p-3">
          {/* 原始信息 */}
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-2.5 py-1.5 text-[10px] text-slate-500">
            <span>原始大小</span>
            <span className="font-semibold text-slate-700">{fmtSize(origSize)}</span>
          </div>

          {/* 格式选择 */}
          <div>
            <div className="mb-1 text-[10px] font-medium text-slate-500">导出格式</div>
            <div className="grid grid-cols-4 gap-1">
              {FORMAT_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setFormat(opt.key)}
                  className={`rounded-lg border px-1 py-1.5 text-[10px] font-medium transition-all ${
                    format === opt.key
                      ? "border-teal-500 bg-teal-50 text-teal-700 ring-1 ring-teal-200"
                      : "border-slate-200 bg-white text-slate-500 hover:border-teal-200 hover:bg-teal-50/50"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {isPdf && (format === "jpg" || format === "png") && (
              <p className="mt-1 text-[9px] text-amber-600">多页 PDF 转图片仅导出第 1 页</p>
            )}
          </div>

          {/* 压缩设置 */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-medium text-slate-500">压缩到指定大小</span>
              <button
                onClick={() => setCompressOn((v) => !v)}
                className={`relative h-4 w-7 rounded-full transition-colors ${compressOn ? "bg-teal-500" : "bg-slate-300"}`}
                title={compressOn ? "关闭压缩" : "开启压缩"}
              >
                <span
                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${
                    compressOn ? "left-3.5" : "left-0.5"
                  }`}
                />
              </button>
            </div>
            {compressOn && (
              <div className="flex items-center gap-1.5">
              <input
                  type="number"
                  min={1}
                  value={sizeVal}
                  onChange={(e) => setSizeVal(e.target.value)}
                  className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-[11px] text-slate-700 outline-none focus:border-teal-400"
                  placeholder="目标大小"
                />
                <div className="flex overflow-hidden rounded-lg border border-slate-200">
                  {(["KB", "MB"] as const).map((u) => (
                    <button
                      key={u}
                      onClick={() => setSizeUnit(u)}
                      className={`px-2 py-1.5 text-[10px] font-medium transition-colors ${
                        sizeUnit === u ? "bg-teal-500 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                      }`}
                    >
                      {u}
                    </button>
                  ))}
                </div>
                <span className="text-[9px] text-slate-400">自动降质量/缩尺寸</span>
              </div>
            )}
          </div>

          {/* 结果反馈 */}
          {resultInfo && (
            <div
              className={`rounded-lg px-2.5 py-1.5 text-[10px] ${
                resultInfo.reached ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
              }`}
            >
              导出后大小：<span className="font-bold">{fmtSize(resultInfo.size)}</span>
              {resultInfo.reached ? "（已达标）" : "（已压到极限仍超目标）"}
              {resultInfo.warnings.map((w, i) => (
                <div key={i} className="mt-0.5 text-[9px] opacity-80">{w}</div>
              ))}
            </div>
          )}

          {/* 导出按钮 */}
          <button
            onClick={doExport}
            disabled={busy}
            className={`flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-semibold transition-all ${
              busy ? "cursor-wait bg-slate-100 text-slate-400" : "bg-teal-600 text-white hover:bg-teal-700"
            }`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {busy ? "正在转换…" : "选择保存位置并导出"}
          </button>
        </div>
      </div>
    </div>
  );
}
