import { useState, useRef, useEffect } from "react";
import { FolderOpen, FileText, Check, Globe, KeyRound, ListChecks, ChevronDown, Eye, Loader2, Upload, X } from "lucide-react";

interface Props {
  /** 当前提取来源模式：choose=选择来源阶段，web=网页提取，local=本地文件 */
  mode: "choose" | "web" | "local";
  /** Excel 字段列表 */
  excelFields: string[];
  /** LOOP 列（当前选中的 Excel 字段） */
  selectedExcelColumn?: string | null;
  /** 已绑定的文件名 LOOP 字段（EXCEL 头） */
  docFileBindField: string | null;
  onSetDocFileBindField: (field: string) => void;

  // ===== choose 模式 =====
  /** 选择网页提取来源 */
  onChooseWeb?: () => void;
  /** 选择本地文件提取来源 */
  onChooseLocal?: () => void;
  /** 退出文件提取模式（choose 阶段取消） */
  onExitChoose?: () => void;

  // ===== 网页提取模式 =====
  /** 网页提取已记录的点击步骤数 */
  webStepCount?: number;
  /** 退出网页提取模式（完成提取） */
  onExitWebMode?: () => void;

  // ===== 本地文件提取模式 =====
  docLocalRootPath?: string | null;
  docLocalDirFiles?: Array<{ relativePath: string; name: string; size: number; ext: string }>;
  docLocalSamplePath?: string | null;
  docLocalPattern?: string | null;
  onPickLocalDirectory?: () => void;
  onSelectDocLocalSample?: (relativePath: string) => void;
  onConfirm?: () => void;
}

/**
 * 文件提取控制面板（渲染在"文件处理"卡片内部）
 * 统一管理网页提取 / 本地上传两种来源的配置流程。
 * 最上方为"文件名 LOOP 字段"选择器（自定义下拉，避免 overflow 裁切）。
 */
export default function DocLocalExtractConfig({
  mode,
  excelFields,
  selectedExcelColumn,
  docFileBindField,
  onSetDocFileBindField,
  onChooseWeb,
  onChooseLocal,
  onExitChoose,
  webStepCount = 0,
  onExitWebMode,
  docLocalRootPath = null,
  docLocalDirFiles = [],
  docLocalSamplePath = null,
  docLocalPattern = null,
  onPickLocalDirectory,
  onSelectDocLocalSample,
  onConfirm,
}: Props) {
  const isChoose = mode === "choose";
  const isWeb = mode === "web";
  const canConfirmLocal = docLocalRootPath && docLocalPattern && docFileBindField;

  // 自定义字段下拉（避免原生 select 被 overflow-hidden 裁切）
  const [fieldDropdownOpen, setFieldDropdownOpen] = useState(false);
  const fieldDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!fieldDropdownOpen) return;
    const onClick = (e: MouseEvent) => {
      if (fieldDropdownRef.current && !fieldDropdownRef.current.contains(e.target as Node)) {
        setFieldDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [fieldDropdownOpen]);

  // 构建字段列表：LOOP 列置顶
  const allFields: Array<{ key: string; label: string; isLoop?: boolean }> = [];
  if (selectedExcelColumn) {
    allFields.push({ key: selectedExcelColumn, label: selectedExcelColumn, isLoop: true });
  }
  excelFields.filter((f) => f !== selectedExcelColumn).forEach((f) => {
    allFields.push({ key: f, label: f });
  });

  const selectedFieldLabel = docFileBindField
    ? (selectedExcelColumn === docFileBindField ? `${docFileBindField}（LOOP 列）` : docFileBindField)
    : null;

  // ===== 文件预览：点击文件后加载并显示预览 =====
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // 预览文件：通过 IPC 读取本地文件内容
  const loadPreview = async (relativePath: string) => {
    if (!docLocalRootPath) return;
    setPreviewPath(relativePath);
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewDataUrl(null);
    try {
      const result = await window.electronAPI?.readLocalDocFile?.(docLocalRootPath, relativePath);
      if (result?.ok && result.dataUrl) {
        setPreviewDataUrl(result.dataUrl);
      } else {
        setPreviewError(result?.error || "无法读取该文件");
      }
    } catch (e: any) {
      setPreviewError(e?.message || "读取文件失败");
    } finally {
      setPreviewLoading(false);
    }
  };

  // 切换根目录时重置预览
  useEffect(() => {
    setPreviewPath(null);
    setPreviewDataUrl(null);
    setPreviewError(null);
    setPreviewLoading(false);
  }, [docLocalRootPath]);

  // 判断预览文件是否为图片
  const previewExt = previewPath ? previewPath.split(".").pop()?.toLowerCase() : "";
  const isImagePreview = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif"].includes(previewExt || "");
  const isPdfPreview = previewExt === "pdf";

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      {/* 标题条 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-teal-200 bg-teal-50/60 px-2 py-1">
        {isChoose ? <FileText className="h-3 w-3 text-teal-700" /> : isWeb ? <Globe className="h-3 w-3 text-teal-700" /> : <FolderOpen className="h-3 w-3 text-teal-700" />}
        <span className="text-[10px] font-bold text-teal-800">
          {isChoose ? "选择文件提取来源" : isWeb ? "文件提取配置（网页模式）" : "文件提取配置（目录模式）"}
        </span>
        {isChoose && onExitChoose && (
          <button
            onClick={onExitChoose}
            className="ml-auto rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
            title="退出文件提取"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* 内容区 */}
      <div className="min-h-0 flex-1 flex flex-col overflow-auto p-2">
        {/* ===== choose 模式：选择来源 ===== */}
        {isChoose && (
          <div className="flex flex-1 flex-col gap-2">
            <div className="rounded-md border border-sky-100 bg-sky-50/50 px-2 py-1.5 text-[9px] leading-relaxed text-sky-700">
              请选择文件提取的来源方式：
            </div>
            <div className="grid flex-1 grid-cols-2 gap-2">
              <button
                onClick={onChooseWeb}
                className="flex flex-col items-center justify-center gap-1.5 rounded-md border-2 border-teal-200 bg-white px-2 py-3 text-center transition-all hover:border-teal-400 hover:bg-teal-50"
              >
                <Globe className="h-6 w-6 text-teal-600" />
                <span className="text-[11px] font-semibold text-slate-700">网页提取</span>
                <span className="text-[9px] leading-tight text-slate-500">点击网页图片/PDF<br/>LOOP 自动下载提取</span>
              </button>
              <button
                onClick={onChooseLocal}
                className="flex flex-col items-center justify-center gap-1.5 rounded-md border-2 border-teal-200 bg-white px-2 py-3 text-center transition-all hover:border-teal-400 hover:bg-teal-50"
              >
                <Upload className="h-6 w-6 text-teal-600" />
                <span className="text-[11px] font-semibold text-slate-700">本地文件</span>
                <span className="text-[9px] leading-tight text-slate-500">选择文件夹按字段匹配<br/>如学号.jpg/pdf/png</span>
              </button>
            </div>
          </div>
        )}

        {/* ★ 顶部：文件名 LOOP 字段选择器（自定义下拉，不被 overflow 裁切）—— choose 模式不显示 */}
        {!isChoose && (
        <div className="mb-2 shrink-0 rounded-md border-2 border-amber-300 bg-amber-50/80 p-1.5">
          <div className="mb-1 flex items-center gap-1">
            <KeyRound className="h-3 w-3 text-amber-600" />
            <span className="text-[10px] font-bold text-amber-800">文件名 LOOP 字段</span>
          </div>
          {/* 自定义下拉按钮 */}
          <div className="relative" ref={fieldDropdownRef}>
            <button
              onClick={() => setFieldDropdownOpen((v) => !v)}
              className="flex w-full items-center justify-between rounded border border-amber-300 bg-white px-1.5 py-1 text-[10px] font-medium outline-none transition-colors hover:border-amber-500"
            >
              <span className={selectedFieldLabel ? "text-slate-800" : "text-slate-400"}>
                {selectedFieldLabel || "-- 选择 EXCEL 头作为文件名 LOOP --"}
              </span>
              <ChevronDown className={`h-3 w-3 shrink-0 text-slate-400 transition-transform ${fieldDropdownOpen ? "rotate-180" : ""}`} />
            </button>
            {/* 下拉列表：在文档流中展开，不使用 absolute 避免被裁切 */}
            {fieldDropdownOpen && (
              <div className="mt-0.5 max-h-40 overflow-y-auto rounded border border-amber-300 bg-white shadow-sm">
                {allFields.length === 0 && (
                  <div className="px-2 py-1.5 text-[10px] text-slate-400">暂无字段</div>
                )}
                {allFields.map((f) => {
                  const isSelected = docFileBindField === f.key;
                  return (
                    <button
                      key={f.key}
                      onClick={() => {
                        onSetDocFileBindField(f.key);
                        setFieldDropdownOpen(false);
                      }}
                      className={[
                        "flex w-full items-center gap-1 px-2 py-1 text-left text-[10px] transition-colors",
                        isSelected
                          ? "bg-amber-100 font-semibold text-amber-800"
                          : "text-slate-700 hover:bg-amber-50",
                      ].join(" ")}
                    >
                      {isSelected && <Check className="h-2.5 w-2.5 shrink-0 text-amber-600" />}
                      <span className="min-w-0 flex-1 truncate">{f.label}</span>
                      {f.isLoop && (
                        <span className="shrink-0 rounded bg-amber-200 px-1 text-[8px] font-medium text-amber-700">LOOP</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <p className="mt-0.5 text-[9px] leading-tight text-amber-700">
            LOOP 执行时，按此字段的值在{isWeb ? "网页下载文件" : "本地文件夹"}中匹配对应人员的文件。
          </p>
        </div>
        )}

        {/* ===== 网页模式专属内容 ===== */}
        {isWeb && (
          <div className="flex shrink-0 flex-col gap-2">
            <div className="rounded border border-sky-100 bg-sky-50/50 px-2 py-1.5 text-[9px] leading-relaxed text-sky-700">
              <p className="mb-0.5 font-semibold">操作流程：</p>
              1. 在上方选择文件名 LOOP 字段<br />
              2. 在右侧网页中依次点击元素导航到下载按钮<br />
              3. 触发下载后系统自动捕获并 OCR 提取<br />
              4. 完成后点底部「完成提取」
            </div>

            {/* 已记录点击步骤 */}
            <div className="rounded-md border border-slate-200 bg-white px-2 py-1.5">
              <div className="flex items-center gap-1">
                <ListChecks className="h-3 w-3 text-slate-500" />
                <span className="text-[10px] font-semibold text-slate-700">已记录点击步骤</span>
                <span className={[
                  "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                  webStepCount > 0 ? "bg-teal-100 text-teal-700" : "bg-slate-100 text-slate-400",
                ].join(" ")}>
                  {webStepCount} 步
                </span>
              </div>
              {webStepCount === 0 && (
                <p className="mt-1 text-[9px] text-slate-400">请在右侧网页点击元素以记录导航步骤…</p>
              )}
              {docFileBindField && webStepCount > 0 && (
                <p className="mt-1 text-[9px] text-teal-600">✓ 字段已绑定，可继续点击或完成提取</p>
              )}
            </div>

            {!docFileBindField && (
              <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[9px] text-rose-600">
                ⚠ 请先选择「文件名 LOOP 字段」
              </div>
            )}
          </div>
        )}

        {/* ===== 本地模式专属内容 ===== */}
        {!isWeb && (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            {/* 步骤1：选择文件夹 */}
            <div className="shrink-0">
              <label className="mb-0.5 block text-[9px] font-medium text-slate-600">
                选择根文件夹
              </label>
              <button
                onClick={onPickLocalDirectory}
                className="flex w-full items-center justify-center gap-1 rounded-md border-2 border-dashed border-teal-300 bg-white py-1.5 text-[10px] font-medium text-teal-700 transition-all hover:border-teal-500 hover:bg-teal-50"
              >
                <FolderOpen className="h-3 w-3" />
                {docLocalRootPath ? "重新选择文件夹" : "选择文件夹"}
              </button>
              {docLocalRootPath && (
                <p className="mt-0.5 truncate text-[9px] text-slate-500" title={docLocalRootPath}>
                  📁 {docLocalRootPath}（{docLocalDirFiles.length} 个文件）
                </p>
              )}
            </div>

            {/* 步骤2：点选样本文件 + 预览（flex 填充剩余空间） */}
            {docLocalRootPath && docFileBindField && (
              <div className="flex min-h-24 flex-1 flex-col">
                <label className="mb-0.5 shrink-0 block text-[9px] font-medium text-slate-600">
                  点选样本文件（自动推断路径模板）· 点击 <Eye className="inline h-2.5 w-2.5 align-middle" /> 预览
                </label>
                {/* 文件列表（固定高度，可滚动） */}
                <div className="shrink-0 max-h-28 space-y-0.5 overflow-y-auto rounded border border-slate-200 bg-white p-1">
                  {docLocalDirFiles.slice(0, 200).map((f) => {
                    const isSample = docLocalSamplePath === f.relativePath;
                    const isPreviewing = previewPath === f.relativePath;
                    return (
                      <div
                        key={f.relativePath}
                        className={[
                          "flex w-full items-center gap-1 rounded px-1 py-0.5 text-left transition-colors",
                          isSample ? "bg-teal-100 ring-1 ring-teal-400" : "hover:bg-slate-50",
                          isPreviewing && !isSample ? "bg-sky-50 ring-1 ring-sky-300" : "",
                        ].join(" ")}
                        title={f.relativePath}
                      >
                        <button
                          onClick={() => onSelectDocLocalSample?.(f.relativePath)}
                          className="flex min-w-0 flex-1 items-center gap-1 text-left"
                        >
                          {isSample
                            ? <Check className="h-2.5 w-2.5 shrink-0 text-teal-600" />
                            : <FileText className="h-2.5 w-2.5 shrink-0 text-slate-400" />}
                          <span className="min-w-0 flex-1 truncate text-[10px] text-slate-700">
                            {f.relativePath}
                          </span>
                          <span className="shrink-0 text-[8px] text-slate-400">{f.ext}</span>
                        </button>
                        {/* 预览按钮 */}
                        <button
                          onClick={() => loadPreview(f.relativePath)}
                          className={[
                            "shrink-0 rounded p-0.5 transition-colors",
                            isPreviewing
                              ? "bg-sky-200 text-sky-700"
                              : "text-slate-400 hover:bg-sky-100 hover:text-sky-600",
                          ].join(" ")}
                          title="预览此文件"
                        >
                          <Eye className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    );
                  })}
                  {docLocalDirFiles.length > 200 && (
                    <p className="px-1 py-0.5 text-[9px] text-slate-400">
                      …还有 {docLocalDirFiles.length - 200} 个文件未显示
                    </p>
                  )}
                </div>

                {/* 预览区域（flex 填充剩余空间） */}
                {previewPath && (
                  <div className="mt-1 flex min-h-32 flex-1 flex-col rounded border border-sky-200 bg-slate-50">
                    {/* 预览头部 */}
                    <div className="flex shrink-0 items-center gap-1 border-b border-sky-200 bg-sky-50/60 px-1.5 py-0.5">
                      <Eye className="h-2.5 w-2.5 shrink-0 text-sky-600" />
                      <span className="min-w-0 flex-1 truncate text-[9px] font-medium text-sky-700" title={previewPath}>
                        {previewPath}
                      </span>
                      <button
                        onClick={() => { setPreviewPath(null); setPreviewDataUrl(null); setPreviewError(null); }}
                        className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                        title="关闭预览"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                    {/* 预览内容 */}
                    <div className="min-h-0 flex-1 overflow-auto p-1">
                      {previewLoading && (
                        <div className="flex h-full flex-col items-center justify-center gap-1 text-[10px] text-slate-400">
                          <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
                          <span>加载预览中…</span>
                        </div>
                      )}
                      {previewError && !previewLoading && (
                        <div className="flex h-full flex-col items-center justify-center gap-1 px-2 text-center text-[10px] text-rose-500">
                          <FileText className="h-6 w-6 text-rose-300" />
                          <span>无法预览：{previewError}</span>
                        </div>
                      )}
                      {previewDataUrl && !previewLoading && (
                        isImagePreview ? (
                          <img
                            src={previewDataUrl}
                            alt={previewPath}
                            className="h-full w-full object-contain"
                            onError={() => setPreviewError("图片加载失败")}
                          />
                        ) : isPdfPreview ? (
                          <embed
                            src={previewDataUrl}
                            type="application/pdf"
                            className="h-full w-full"
                          />
                        ) : (
                          <div className="flex h-full flex-col items-center justify-center gap-1 text-[10px] text-slate-500">
                            <FileText className="h-6 w-6 text-slate-300" />
                            <span>该格式不支持预览（.{previewExt}）</span>
                          </div>
                        )
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {!docFileBindField && (
              <div className="shrink-0 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[9px] text-rose-600">
                ⚠ 请先选择「文件名 LOOP 字段」
              </div>
            )}

            {/* 路径模板预览 */}
            {docLocalPattern && (
              <div className="shrink-0 rounded-md border border-teal-300 bg-teal-50 px-2 py-1">
                <p className="text-[9px] font-medium text-teal-700">推断的路径模板：</p>
                <p className="font-mono text-[10px] font-bold text-teal-900">
                  {docLocalPattern}.<span className="text-teal-500">[jpg|png|pdf…]</span>
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部按钮区 —— choose 模式不显示 */}
      {!isChoose && (
      <div className="flex shrink-0 items-center justify-between border-t border-slate-100 bg-slate-50/60 px-2 py-1">
        {isWeb ? (
          <>
            <span className="text-[9px] text-slate-400">
              {docFileBindField
                ? webStepCount > 0 ? `✓ 已记录 ${webStepCount} 步，可继续或完成` : "请在网页点击元素"
                : "请先选文件名 LOOP 字段"}
            </span>
            <button
              onClick={onExitWebMode}
              disabled={webStepCount === 0}
              className={[
                "rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                webStepCount > 0
                  ? "bg-teal-600 text-white hover:bg-teal-700"
                  : "cursor-not-allowed bg-slate-200 text-slate-400",
              ].join(" ")}
            >
              完成提取
            </button>
          </>
        ) : (
          <>
            <span className="text-[9px] text-slate-400">
              {canConfirmLocal
                ? "✓ 模板已就绪"
                : docLocalRootPath
                ? docFileBindField
                  ? "请点选样本文件"
                  : "请选文件名 LOOP 字段"
                : "请选择文件夹"}
            </span>
            <button
              onClick={onConfirm}
              disabled={!canConfirmLocal}
              className={[
                "rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                canConfirmLocal
                  ? "bg-teal-600 text-white hover:bg-teal-700"
                  : "cursor-not-allowed bg-slate-200 text-slate-400",
              ].join(" ")}
            >
              确认添加
            </button>
          </>
        )}
      </div>
      )}
    </div>
  );
}
