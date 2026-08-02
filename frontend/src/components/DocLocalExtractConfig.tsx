import { useState, useRef, useEffect } from "react";
import {
  FolderOpen, FileText, Check, Globe, KeyRound, ListChecks, ChevronDown, Eye, Loader2,
  Upload, X, Database, FileDown, Sparkles,
} from "lucide-react";
import { FIELD_LABELS } from "../types";

// 关键字段：排在前面，用带色边框突出
const DOC_KEY_FIELDS = [
  "surname", "given_name", "name", "passport_no", "birth_date",
  "issue_place", "nationality", "gender", "passport_issue", "passport_expiry",
];

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
  /** 网页下载/提取过程状态（供面板显示进度/错误/成功反馈） */
  webStatus?: {
    phase: "idle" | "downloading" | "preview" | "ocr" | "success" | "error";
    filename?: string;
    received?: number;
    total?: number;
    percent?: number;
    size?: number;
    message?: string;
  };

  // ===== 网页模式：提取结果（内嵌显示，替代外部弹窗）=====
  /** 提取完成后的结果（字段/原图/文字），有值则在面板内渲染 */
  webResult?: {
    imageUrl: string;
    filename: string;
    method: string;
    text: string;
    fields: Record<string, string>;
    side: "left" | "right";
    workflow: "entry" | "review";
  } | null;
  onCloseWebResult?: () => void;
  webSameNameImages?: { left: string[]; right: string[] } | null;
  webFindingSameName?: boolean;
  onFindSameName?: () => void;
  onExtractFields?: (fields: Record<string, string>) => void;
  onExportDoc?: () => void;
  onBindUploadDoc?: () => void;

  // ===== 源文件预览窗口（嵌套在面板内；字段送「提取元素」后仍保留显示）=====
  sourcePreview?: {
    imageUrl: string;
    filename: string;
    method: string;
  } | null;
  onCloseSourcePreview?: () => void;
  /** 预览就绪后点击触发 OCR 提取（网页模式） */
  onTriggerWebExtract?: () => void;

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
  webStatus,
  webResult = null,
  onCloseWebResult,
  webSameNameImages = null,
  webFindingSameName = false,
  onFindSameName,
  onExtractFields,
  onExportDoc,
  onBindUploadDoc,
  sourcePreview = null,
  onCloseSourcePreview,
  onTriggerWebExtract,
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

  // 字节大小格式化
  const fmtSize = (bytes?: number) => {
    if (bytes == null) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  // 自定义字段下拉（避免原生 select 被 overflow-hidden 裁切）
  const [fieldDropdownOpen, setFieldDropdownOpen] = useState(false);
  const fieldDropdownRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);

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

  // 预览窗口滚轮链式传递：滚到顶/底后继续滚动自动传递给外层容器
  const handlePreviewWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = previewScrollRef.current;
    const outer = contentScrollRef.current;
    if (!el || !outer) return;
    const { deltaY } = e;
    const atTop = el.scrollTop <= 0;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    // 向下滚且已到底部 → 传递给外层
    if (deltaY > 0 && atBottom) {
      e.preventDefault();
      outer.scrollTop += deltaY;
    }
    // 向上滚且已到顶部 → 传递给外层
    else if (deltaY < 0 && atTop) {
      e.preventDefault();
      outer.scrollTop += deltaY;
    }
  };

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

  // 源文件预览折叠状态
  const [sourcePreviewOpen, setSourcePreviewOpen] = useState(true);
  // 新预览到来时自动展开
  useEffect(() => {
    if (sourcePreview) setSourcePreviewOpen(true);
  }, [sourcePreview?.imageUrl, sourcePreview?.filename]);

  // 判断源文件类型
  const sourceIsPdf = sourcePreview
    ? /\.pdf(\?|#|$)/i.test(sourcePreview.filename) || sourcePreview.method === "pdf_ocr" || sourcePreview.method === "markitdown"
    : false;

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

      {/* 内容区：始终允许垂直滚动，预览窗口使用 max-height 限制高度，内部自行滚动 */}
      <div ref={contentScrollRef} className="min-h-0 flex-1 flex flex-col overflow-y-auto p-2">
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

        {/* ★ 顶部：文件名 LOOP 字段选择器（自定义下拉，不被 overflow 裁切）—— 仅本地目录模式显示（网页模式点击直接下载，无需按文件名匹配） */}
        {!isChoose && !isWeb && (
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
            LOOP 执行时，按此字段的值在本地文件夹中匹配对应人员的文件。
          </p>
        </div>
        )}

        {/* ===== 网页模式专属内容 ===== */}
        {isWeb && (
          <div className="flex flex-col gap-2 shrink-0">
            {/* 操作流程说明 —— 文件提取成功后隐藏，给预览区腾空间 */}
            {!sourcePreview && (
              <div className="rounded border border-sky-100 bg-sky-50/50 px-2 py-1.5 text-[9px] leading-relaxed text-sky-700 shrink-0">
                <p className="mb-0.5 font-semibold">操作流程：</p>
                1. 在右侧网页中依次点击元素导航到下载按钮<br />
                2. 触发下载后系统自动捕获并 OCR 提取<br />
                3. 完成后点底部「完成提取」
              </div>
            )}

            {/* 已记录点击步骤 —— 文件提取成功后隐藏，给预览区腾空间 */}
            {!sourcePreview && (
              <div className="rounded-md border border-slate-200 bg-white px-2 py-1.5 shrink-0">
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
                {webStepCount > 0 && (
                  <p className="mt-1 text-[9px] text-teal-600">✓ 已记录步骤，可继续点击或完成提取</p>
                )}
              </div>
            )}

            {/* ===== 源文件预览窗口（嵌套在已记录点击步骤与提取状态之间；字段送「提取元素」后仍保留）===== */}
            {sourcePreview && (
              <div
                className={[
                  "flex flex-col overflow-hidden rounded-md border border-slate-200 bg-white",
                  sourcePreviewOpen ? "max-h-[55vh]" : "shrink-0",
                ].join(" ")}
              >
                {/* 预览标题条 */}
                <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-2 py-1">
                  <Eye className="h-3 w-3 text-slate-500" />
                  <span className="text-[10px] font-semibold text-slate-700">源文件预览</span>
                  <span className="max-w-[50%] truncate text-[9px] font-mono text-slate-500" title={sourcePreview.filename}>
                    {sourcePreview.filename}
                  </span>
                  {sourceIsPdf && (
                    <span className="rounded bg-rose-100 px-1 text-[8px] font-semibold text-rose-600">PDF</span>
                  )}
                  <button
                    onClick={() => setSourcePreviewOpen((v) => !v)}
                    className="ml-auto rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                    title={sourcePreviewOpen ? "收起预览" : "展开预览"}
                  >
                    <ChevronDown className={`h-3 w-3 transition-transform ${sourcePreviewOpen ? "" : "-rotate-90"}`} />
                  </button>
                  {onCloseSourcePreview && (
                    <button
                      onClick={onCloseSourcePreview}
                      className="rounded p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                      title="关闭预览"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {/* 预览图片区域：展开时填满剩余空间，内部滚动查看大图；滚到边界后自动传递滚轮事件给外层容器 */}
                {sourcePreviewOpen && (
                  <div
                    ref={previewScrollRef}
                    onWheel={handlePreviewWheel}
                    className="min-h-0 flex-1 overflow-auto bg-slate-100/80 p-1.5"
                  >
                    <div className="flex min-h-[200px] items-start justify-center">
                      <img
                        src={sourcePreview.imageUrl}
                        alt={sourcePreview.filename}
                        className="max-w-full rounded border border-slate-200 bg-white object-contain shadow-sm"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ===== 下载/提取状态反馈（进度条、预览提示、OCR中、错误；成功不显示卡片，直接看下方结果面板）===== */}
            <div className="shrink-0">
            {webStatus && webStatus.phase !== "idle" && webStatus.phase !== "success" && (
              <div
                className={[
                  "rounded-md border px-2 py-1.5",
                  webStatus.phase === "downloading" ? "border-sky-200 bg-sky-50/70" : "",
                  webStatus.phase === "preview" ? "border-amber-200 bg-amber-50/70" : "",
                  webStatus.phase === "ocr" ? "border-indigo-200 bg-indigo-50/70" : "",
                  webStatus.phase === "error" ? "border-rose-200 bg-rose-50/70" : "",
                ].join(" ")}
              >
                <div className="flex items-center gap-1.5">
                  {webStatus.phase === "downloading" && (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-600" />
                  )}
                  {webStatus.phase === "preview" && (
                    <Eye className="h-3 w-3 shrink-0 text-amber-600" />
                  )}
                  {webStatus.phase === "ocr" && (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-indigo-600" />
                  )}
                  {webStatus.phase === "error" && (
                    <X className="h-3 w-3 shrink-0 text-rose-600" />
                  )}
                  <span
                    className={[
                      "text-[10px] font-semibold",
                      webStatus.phase === "downloading" ? "text-sky-700" : "",
                      webStatus.phase === "preview" ? "text-amber-700" : "",
                      webStatus.phase === "ocr" ? "text-indigo-700" : "",
                      webStatus.phase === "error" ? "text-rose-700" : "",
                    ].join(" ")}
                  >
                    {webStatus.phase === "downloading" && "正在下载文件…"}
                    {webStatus.phase === "preview" && "预览就绪"}
                    {webStatus.phase === "ocr" && "正在 OCR 提取文字…"}
                    {webStatus.phase === "error" && "提取失败"}
                  </span>
                  {webStatus.filename && (
                    <span
                      className="ml-1 max-w-[50%] truncate text-[9px] font-mono"
                      title={webStatus.filename}
                    >
                      {webStatus.filename}
                    </span>
                  )}
                  {webStatus.phase === "downloading" && webStatus.total != null && webStatus.total > 0 && (
                    <span className="ml-auto text-[9px] tabular-nums text-sky-600">
                      {webStatus.percent}% · {fmtSize(webStatus.received)}/{fmtSize(webStatus.total)}
                    </span>
                  )}
                  {webStatus.phase === "downloading" && webStatus.received != null && (!webStatus.total || webStatus.total <= 0) && webStatus.received > 0 && (
                    <span className="ml-auto text-[9px] tabular-nums text-sky-600">
                      {fmtSize(webStatus.received)}
                    </span>
                  )}
                  {webStatus.phase === "preview" && webStatus.size != null && (
                    <span className="ml-auto text-[9px] tabular-nums text-amber-600">
                      {fmtSize(webStatus.size)}
                    </span>
                  )}
                </div>

                {/* 进度条 */}
                {(webStatus.phase === "downloading" || webStatus.phase === "ocr") && (
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/70">
                    {webStatus.phase === "downloading" && webStatus.total && webStatus.total > 0 ? (
                      <div
                        className="h-full rounded-full bg-sky-500 transition-all duration-300"
                        style={{ width: `${Math.max(2, webStatus.percent || 0)}%` }}
                      />
                    ) : (
                      <div className="h-full w-full animate-pulse rounded-full bg-indigo-400/70" />
                    )}
                  </div>
                )}

                {/* 预览就绪：显示「录入提取」按钮 */}
                {webStatus.phase === "preview" && !webResult && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <p className="flex-1 text-[9px] text-amber-700">
                      确认文件无误后，点击右侧按钮开始识别提取。
                    </p>
                    {onTriggerWebExtract && (
                      <button
                        onClick={onTriggerWebExtract}
                        className="flex shrink-0 items-center gap-1 rounded-md bg-violet-600 px-2.5 py-1 text-[10px] font-semibold text-white shadow-sm transition-all hover:bg-violet-700 active:scale-95"
                      >
                        <Sparkles className="h-3 w-3" />
                        录入提取
                      </button>
                    )}
                  </div>
                )}

                {/* 错误详情 */}
                {webStatus.phase === "error" && webStatus.message && (
                  <p className="mt-1 break-words text-[9px] leading-tight text-rose-600">
                    {webStatus.message}
                  </p>
                )}
              </div>
            )}

            {/* 网页模式：提取结果（字段勾选网格）—— 同样放在底部滚动区 */}
            {webResult && (
              <WebExtractResultView
                result={webResult}
                onClose={onCloseWebResult}
                sameNameImages={webSameNameImages}
                findingSameName={webFindingSameName}
                onFindSameName={onFindSameName}
                onExtractFields={onExtractFields}
                onExport={onExportDoc}
                onBindUpload={onBindUploadDoc}
              />
            )}
            {/* 关闭状态/结果滚动包裹层 */}
            </div>
            {/* 关闭网页模式容器 */}
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
              {webStatus?.phase === "downloading"
                ? `下载中 ${webStatus.percent != null && webStatus.percent >= 0 ? `· ${webStatus.percent}%` : ""}`
                : webStatus?.phase === "preview"
                ? "预览就绪，点击「录入提取」开始识别"
                : webStatus?.phase === "ocr"
                ? "OCR 识别中…"
                : webStatus?.phase === "success"
                ? `✓ 已提取 ${webStatus.filename || ""}`
                : webStatus?.phase === "error"
                ? <span className="text-rose-500">✗ {webStatus.message || "提取失败"}</span>
                : webStepCount > 0
                  ? `✓ 已记录 ${webStepCount} 步，可继续或完成`
                  : "请在网页点击元素"}
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

/**
 * 网页下载模式下的提取结果视图（内嵌在文件提取配置面板中，替代外部浮动弹窗）。
 * 紧凑版：字段网格 + 操作按钮 + 原始文字 + 同名图片对比。
 */
function WebExtractResultView({
  result,
  onClose,
  sameNameImages,
  findingSameName,
  onFindSameName,
  onExtractFields,
  onExport,
  onBindUpload,
}: {
  result: {
    imageUrl: string;
    filename: string;
    method: string;
    text: string;
    fields: Record<string, string>;
    side: "left" | "right";
    workflow: "entry" | "review";
  };
  onClose?: () => void;
  sameNameImages?: { left: string[]; right: string[] } | null;
  findingSameName?: boolean;
  onFindSameName?: () => void;
  onExtractFields?: (fields: Record<string, string>) => void;
  onExport?: () => void;
  onBindUpload?: () => void;
}) {
  const [showRawText, setShowRawText] = useState(false);
  const [checkedFields, setCheckedFields] = useState<Set<string>>(
    () => new Set(Object.entries(result.fields || {}).filter(([, v]) => v).map(([f]) => f))
  );
  // 切换文件时重置勾选
  useEffect(() => {
    setCheckedFields(new Set(Object.entries(result.fields || {}).filter(([, v]) => v).map(([f]) => f)));
    setShowRawText(false);
  }, [result.filename, result.imageUrl]);

  const fieldEntries = Object.entries(result.fields || {});
  const keyEntries = fieldEntries.filter(([f]) => DOC_KEY_FIELDS.includes(f));
  const otherEntries = fieldEntries.filter(([f]) => !DOC_KEY_FIELDS.includes(f));
  const toggleField = (f: string) => {
    setCheckedFields((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };
  const checkedCount = Array.from(checkedFields).filter((f) => result.fields[f]).length;
  const allChecked = fieldEntries.length > 0 && checkedCount === fieldEntries.filter(([, v]) => v).length;

  return (
    <div className="shrink-0 rounded-lg border border-teal-200 bg-teal-50/40">
      {/* 标题条 */}
      <div className="flex items-center gap-1.5 border-b border-teal-100 bg-gradient-to-r from-teal-50 to-cyan-50 px-2 py-1">
        <span className="text-[10px] font-semibold text-teal-900">提取结果</span>
        <span className={[
          "rounded-full px-1.5 py-0.5 text-[8px] font-bold",
          result.workflow === "entry" ? "bg-violet-100 text-violet-700" : "bg-sky-100 text-sky-700",
        ].join(" ")}>
          {result.workflow === "entry" ? "录入提取" : "审查提取"}
        </span>
        <span className="max-w-[50%] truncate text-[9px] text-slate-500 font-mono" title={result.filename}>
          {result.filename}
        </span>
        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto rounded p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
            title="关闭结果"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="space-y-2 p-2">
        {/* 原图已在上方「源文件预览」窗口展示，此处不再重复缩略图 */}

        {/* 提取字段 */}
        {fieldEntries.length > 0 ? (
          <div>
            <div className="mb-1 flex items-center gap-1 text-[9px] font-medium text-slate-500">
              <span>提取信息（{fieldEntries.length} 字段）</span>
              <span className="text-slate-400">勾选后送「提取元素」</span>
              <button
                onClick={() =>
                  setCheckedFields(allChecked ? new Set() : new Set(fieldEntries.filter(([, v]) => v).map(([f]) => f)))
                }
                className="ml-auto rounded px-1 py-0.5 text-[9px] text-teal-600 hover:bg-teal-50"
              >
                {allChecked ? "全不选" : "全选"}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1">
              {keyEntries.map(([f, v]) => (
                <div
                  key={f}
                  onClick={() => v && toggleField(f)}
                  className={[
                    "relative cursor-pointer rounded-md border-2 px-1.5 py-0.5 transition-all",
                    checkedFields.has(f)
                      ? "border-teal-400 bg-teal-50/60"
                      : v
                      ? "border-slate-200 bg-white opacity-60"
                      : "border-dashed border-slate-200 bg-slate-50/50 opacity-60",
                  ].join(" ")}
                  title={v ? (checkedFields.has(f) ? "点击取消勾选" : "点击勾选") : "未提取到"}
                >
                  <div className="flex items-center gap-1 text-[8px] font-medium text-teal-700">
                    <span
                      className={`inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center rounded-sm border ${
                        checkedFields.has(f) ? "border-teal-500 bg-teal-500 text-white" : "border-slate-300 bg-white"
                      }`}
                    >
                      {checkedFields.has(f) && <Check className="h-1.5 w-1.5" />}
                    </span>
                    <span className="truncate">{FIELD_LABELS[f] || f}</span>
                  </div>
                  <div className={["truncate text-[10px] font-semibold", v ? "text-slate-800" : "text-slate-300"].join(" ")} title={v}>
                    {v || "未提取到"}
                  </div>
                </div>
              ))}
              {otherEntries.map(([f, v]) => (
                <div
                  key={f}
                  onClick={() => v && toggleField(f)}
                  className={[
                    "relative cursor-pointer rounded-md border px-1.5 py-0.5 transition-all",
                    checkedFields.has(f) ? "border-teal-300 bg-teal-50/40" : "border-slate-200 bg-white",
                    !v && "opacity-60",
                  ].join(" ")}
                  title={v ? (checkedFields.has(f) ? "点击取消勾选" : "点击勾选") : "未提取到"}
                >
                  <div className="flex items-center gap-1 text-[8px] font-medium text-slate-500">
                    <span
                      className={`inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center rounded-sm border ${
                        checkedFields.has(f) ? "border-teal-500 bg-teal-500 text-white" : "border-slate-300 bg-white"
                      }`}
                    >
                      {checkedFields.has(f) && <Check className="h-1.5 w-1.5" />}
                    </span>
                    <span className="truncate">{FIELD_LABELS[f] || f}</span>
                  </div>
                  <div className={["truncate text-[10px]", v ? "text-slate-700" : "text-slate-300"].join(" ")} title={v}>
                    {v || "—"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-md bg-amber-50 px-2 py-1 text-[9px] text-amber-700">
            未提取到结构化字段，可查看原始文字
          </div>
        )}

        {/* 操作按钮 */}
        {(onExtractFields || onExport || onBindUpload) && (
          <div className="flex items-center gap-1">
            {onExtractFields && (
              <button
                onClick={() => {
                  const picked: Record<string, string> = {};
                  for (const [f, v] of fieldEntries) {
                    if (checkedFields.has(f) && v) picked[f] = v;
                  }
                  if (Object.keys(picked).length === 0) return;
                  onExtractFields(picked);
                }}
                disabled={checkedCount === 0}
                className={`flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium transition-all ${
                  checkedCount === 0
                    ? "cursor-not-allowed bg-slate-100 text-slate-400"
                    : "bg-violet-600 text-white hover:bg-violet-700"
                }`}
                title={checkedCount === 0 ? "请先勾选字段" : `把勾选的 ${checkedCount} 个字段送到「提取元素」面板`}
              >
                <Database className="h-2.5 w-2.5" />
                提取元素{checkedCount > 0 ? ` (${checkedCount})` : ""}
              </button>
            )}
            {onExport && (
              <button
                onClick={onExport}
                className="flex flex-1 items-center justify-center gap-1 rounded-md bg-teal-600 px-1.5 py-1 text-[10px] font-medium text-white transition-all hover:bg-teal-700"
                title="导出文件"
              >
                <FileDown className="h-2.5 w-2.5" />
                导出
              </button>
            )}
            {onBindUpload && (
              <button
                onClick={onBindUpload}
                className="flex flex-1 items-center justify-center gap-1 rounded-md bg-orange-500 px-1.5 py-1 text-[10px] font-medium text-white transition-all hover:bg-orange-600"
                title="绑定上传：点击网页上的文件上传框，LOOP 执行时自动填入该文件"
              >
                <Upload className="h-2.5 w-2.5" />
                绑定上传
              </button>
            )}
          </div>
        )}

        {/* 原始提取文字 */}
        {result.text && (
          <div>
            <button
              onClick={() => setShowRawText((s) => !s)}
              className="text-[9px] font-medium text-slate-500 hover:text-teal-700"
            >
              {showRawText ? "▾ 收起原始文字" : "▸ 查看原始提取文字"}
            </button>
            {showRawText && (
              <pre className="mt-0.5 max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md bg-slate-50 p-1.5 text-[8px] leading-snug text-slate-600">
                {result.text.slice(0, 2000)}
              </pre>
            )}
          </div>
        )}

        {/* 查找同名图片左右对比 */}
        {onFindSameName && (
          <div className="border-t border-slate-100 pt-1.5">
            <button
              onClick={onFindSameName}
              disabled={findingSameName}
              className={[
                "flex w-full items-center justify-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium transition-all",
                findingSameName ? "cursor-wait bg-slate-100 text-slate-400" : "bg-indigo-600 text-white hover:bg-indigo-700",
              ].join(" ")}
            >
              {findingSameName ? "正在左右网页查找同名图片…" : "查找同名图片 · 左右对比"}
            </button>
            {sameNameImages && (
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                <div>
                  <div className="mb-0.5 text-center text-[8px] font-medium text-slate-500">
                    左侧网页 · {sameNameImages.left.length} 张
                  </div>
                  {sameNameImages.left.length > 0 ? (
                    <div className="space-y-0.5">
                      {sameNameImages.left.slice(0, 2).map((src) => (
                        <img key={src} src={src} alt="左侧同名图" className="h-16 w-full rounded border border-violet-200 object-contain bg-slate-50" />
                      ))}
                    </div>
                  ) : (
                    <div className="flex h-16 items-center justify-center rounded border border-dashed border-slate-200 text-[8px] text-slate-400">
                      未找到
                    </div>
                  )}
                </div>
                <div>
                  <div className="mb-0.5 text-center text-[8px] font-medium text-slate-500">
                    右侧网页 · {sameNameImages.right.length} 张
                  </div>
                  {sameNameImages.right.length > 0 ? (
                    <div className="space-y-0.5">
                      {sameNameImages.right.slice(0, 2).map((src) => (
                        <img key={src} src={src} alt="右侧同名图" className="h-16 w-full rounded border border-sky-200 object-contain bg-slate-50" />
                      ))}
                    </div>
                  ) : (
                    <div className="flex h-16 items-center justify-center rounded border border-dashed border-slate-200 text-[8px] text-slate-400">
                      未找到
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
