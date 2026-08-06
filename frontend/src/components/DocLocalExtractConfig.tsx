import { useState, useRef, useEffect, useMemo } from "react";
import {
  FolderOpen, FileText, Check, Globe, KeyRound, ListChecks, ChevronDown, Eye, Loader2,
  Upload, X, Database, FileDown, Sparkles, Crop, Download, Copy, Sigma, Wand2, Eraser, RotateCcw, MousePointer2,
} from "lucide-react";
import { FIELD_LABELS } from "../types";
import { api } from "../api/client";

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
  /** 网页提取已记录的开头导航点击步骤数（下载前） */
  webStepCount?: number;
  /** 网页提取已记录的收尾点击步骤数（提取完成后） */
  webPostStepCount?: number;
  /** 退出网页提取模式（完成提取） */
  onExitWebMode?: () => void;
  /** 开始添加入口导航点击（回到下载前的点击模式） */
  onStartAddPreClicks?: () => void;
  /** 开始添加收尾点击（提取成功后，点击元素记录收尾步骤） */
  onStartAddPostClicks?: () => void;
  /** 网页下载/提取过程状态（供面板显示进度/错误/成功反馈） */
  webStatus?: {
    phase: "idle" | "downloading" | "preview" | "ocr" | "success" | "post-click" | "error"
      | "fallback-scanning" | "fallback-downloading" | "fallback-review";
    filename?: string;
    received?: number;
    total?: number;
    percent?: number;
    size?: number;
    message?: string;
    // fallback-downloading
    current?: number;
    currentFile?: string;
    // fallback-review
    files?: Array<{ filename: string; dataUrl: string; size: number; mime: string; matched: boolean; selected?: boolean }>;
    side?: "left" | "right";
    recordKey?: string;
    recordName?: string;
  };

  // ===== 保底机制人工审查 =====
  /** 选择保底文件 */
  onSelectFallbackFile?: (filename: string) => void;
  /** 确认选择保底文件并继续 */
  onConfirmFallbackFile?: () => void;
  /** 取消保底（跳过该记录） */
  onCancelFallback?: () => void;

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
  onQuickUploadDoc?: (fileData: { dataUrl: string; filename: string }) => void;
  onToast?: (msg: string) => void;
  onError?: (msg: string) => void;

  // ===== 源文件预览窗口（嵌套在面板内；字段送「提取元素」后仍保留显示）=====
  sourcePreview?: {
    imageUrl: string;
    filename: string;
    method: string;
  } | null;
  onCloseSourcePreview?: () => void;
  /** 预览就绪后点击触发 OCR 提取（网页模式） */
  onTriggerWebExtract?: () => void;

  // ===== 网页提取撤销/回退 =====
  /** 撤销最后一次点击（删除步骤 + 浏览器回退） */
  onUndoClick?: () => void;
  /** 浏览器回退一页（不删除步骤） */
  onGoBack?: () => void;
  /** 强制恢复拾取光标（光标消失时手动点击恢复） */
  onResumePicking?: () => void;

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
  webPostStepCount = 0,
  onExitWebMode,
  onStartAddPreClicks,
  onStartAddPostClicks,
  webStatus,
  webResult = null,
  onCloseWebResult,
  webSameNameImages = null,
  webFindingSameName = false,
  onFindSameName,
  onExtractFields,
  onExportDoc,
  onBindUploadDoc,
  onQuickUploadDoc,
  onToast,
  onError,
  sourcePreview = null,
  onCloseSourcePreview,
  onTriggerWebExtract,
  onUndoClick,
  onGoBack,
  onResumePicking,
  onSelectFallbackFile,
  onConfirmFallbackFile,
  onCancelFallback,
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
  const previewImgRef = useRef<HTMLImageElement>(null);
  const cropOverlayRef = useRef<HTMLDivElement>(null);

  // ===== 签名截取状态 =====
  const [cropMode, setCropMode] = useState(false);
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [cropStart, setCropStart] = useState<{ x: number; y: number } | null>(null);
  const [signaturePng, setSignaturePng] = useState<string | null>(null); // data URL of transparent PNG
  const [signatureProcessing, setSignatureProcessing] = useState(false);
  const [signatureOptimizing, setSignatureOptimizing] = useState(false);
  const [eraserMode, setEraserMode] = useState(false);
  const [eraserSize] = useState(12);
  const signatureCanvasRef = useRef<HTMLCanvasElement>(null);
  const sigHistoryRef = useRef<string[]>([]); // undo stack of data URLs
  const erasingRef = useRef(false);
  const sigLastPointRef = useRef<{ x: number; y: number } | null>(null);

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
    if (deltaY > 0 && atBottom) {
      e.preventDefault();
      outer.scrollTop += deltaY;
    } else if (deltaY < 0 && atTop) {
      e.preventDefault();
      outer.scrollTop += deltaY;
    }
  };

  // ===== 签名截取：鼠标框选 =====
  // 计算 object-contain 下图片实际渲染区域（去除 letterbox 留白）
  const getImgContentRect = (img: HTMLImageElement) => {
    const rect = img.getBoundingClientRect();
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) return { x: 0, y: 0, w: rect.width, h: rect.height, scale: 1 };
    const scale = Math.min(rect.width / nw, rect.height / nh);
    const renderedW = nw * scale;
    const renderedH = nh * scale;
    return {
      x: (rect.width - renderedW) / 2,
      y: (rect.height - renderedH) / 2,
      w: renderedW,
      h: renderedH,
      scale,
    };
  };

  const getCropLocalPos = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const img = previewImgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    const content = getImgContentRect(img);
    const x = clientX - rect.left - content.x;
    const y = clientY - rect.top - content.y;
    return { x: Math.max(0, Math.min(x, content.w)), y: Math.max(0, Math.min(y, content.h)) };
  };

  const handleCropMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!cropMode) return;
    e.preventDefault();
    const pos = getCropLocalPos(e.clientX, e.clientY);
    if (!pos) return;
    setCropStart(pos);
    setCropRect({ x: pos.x, y: pos.y, w: 0, h: 0 });
  };

  useEffect(() => {
    if (!cropMode || !cropStart) return;
    const onMove = (e: MouseEvent) => {
      const pos = getCropLocalPos(e.clientX, e.clientY);
      if (!pos) return;
      const x = Math.min(cropStart.x, pos.x);
      const y = Math.min(cropStart.y, pos.y);
      const w = Math.abs(pos.x - cropStart.x);
      const h = Math.abs(pos.y - cropStart.y);
      setCropRect({ x, y, w, h });
    };
    const onUp = () => {
      setCropRect((prev) => {
        if (!prev || !cropStart) return null;
        if (prev.w < 8 || prev.h < 8) return null;
        // 使用最新 rect 执行抠图
        setTimeout(() => extractSignatureFromRect(prev), 0);
        return prev;
      });
      setCropMode(false);
      setCropStart(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [cropMode, cropStart]);

  const exitCropMode = () => {
    setCropMode(false);
    setCropStart(null);
    setCropRect(null);
  };

  // Canvas 抠图：从原图截取选区，去除白色/浅色背景生成透明 PNG
  const extractSignatureFromRect = (rect: { x: number; y: number; w: number; h: number }) => {
    const img = previewImgRef.current;
    if (!img) return;
    setSignatureProcessing(true);

    const content = getImgContentRect(img);
    // 选区坐标是相对「图片实际渲染区域」的，需要转成原始像素坐标
    const toNaturalX = (displayX: number) => Math.round((displayX / content.scale));
    const toNaturalY = (displayY: number) => Math.round((displayY / content.scale));

    const sx = toNaturalX(rect.x);
    const sy = toNaturalY(rect.y);
    const sw = Math.max(1, toNaturalX(rect.w));
    const sh = Math.max(1, toNaturalY(rect.h));
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;

    // 创建 canvas 加载原图
    const fullCanvas = document.createElement("canvas");
    fullCanvas.width = nw;
    fullCanvas.height = nh;
    const fullCtx = fullCanvas.getContext("2d");
    if (!fullCtx) { setSignatureProcessing(false); return; }
    fullCtx.drawImage(img, 0, 0, nw, nh);

    // 裁剪到临时 canvas（添加少量 padding 避免切到笔迹边缘）
    const pad = 2;
    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = sw + pad * 2;
    cropCanvas.height = sh + pad * 2;
    const cropCtx = cropCanvas.getContext("2d");
    if (!cropCtx) { setSignatureProcessing(false); return; }
    const psx = Math.max(0, sx - pad);
    const psy = Math.max(0, sy - pad);
    const psw = Math.min(sw + pad * 2, nw - psx);
    const psh = Math.min(sh + pad * 2, nh - psy);
    cropCtx.drawImage(fullCanvas, psx, psy, psw, psh, 0, 0, psw, psh);

    // 取出像素数据进行背景去除
    const imageData = cropCtx.getImageData(0, 0, psw, psh);
    const data = imageData.data;

    // 采样边缘像素估计背景色
    let bgR = 0, bgG = 0, bgB = 0, bgCount = 0;
    const samplePixel = (px: number, py: number) => {
      const idx = (py * psw + px) * 4;
      bgR += data[idx];
      bgG += data[idx + 1];
      bgB += data[idx + 2];
      bgCount++;
    };
    const sampleStep = Math.max(4, Math.floor(Math.min(psw, psh) / 20));
    for (let x = 0; x < psw; x += sampleStep) { samplePixel(x, 0); samplePixel(x, psh - 1); }
    for (let y = 0; y < psh; y += sampleStep) { samplePixel(0, y); samplePixel(psw - 1, y); }
    const avgBgR = bgR / bgCount;
    const avgBgG = bgG / bgCount;
    const avgBgB = bgB / bgCount;

    // 阈值与过渡带（初始抠图稍微严格一点，减少噪点，后续可手动擦除/一键优化）
    const THRESHOLD = 55;
    const FEATHER = 25;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const dr = r - avgBgR;
      const dg = g - avgBgG;
      const db = b - avgBgB;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);

      // 过滤彩色噪点（印章/彩色杂色，饱和度高但非深色墨迹）
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const sat = maxC > 0 ? (maxC - minC) / maxC : 0;
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      const isColorNoise = sat > 0.35 && luminance > avgBgR * 0.5;

      let alpha: number;
      if (isColorNoise || dist < THRESHOLD) {
        alpha = 0;
      } else if (dist < THRESHOLD + FEATHER) {
        alpha = ((dist - THRESHOLD) / FEATHER) * 255;
      } else {
        alpha = 255;
      }
      data[i + 3] = Math.round(alpha);
    }

    cropCtx.putImageData(imageData, 0, 0);
    const pngUrl = cropCanvas.toDataURL("image/png");
    setSignaturePng(pngUrl);
    setSignatureProcessing(false);
    setCropRect(null);
    // 抠图完成后，将图片加载到编辑 canvas 供橡皮擦/优化使用
    setTimeout(() => loadSignatureToCanvas(pngUrl), 50);
  };

  // ===== 签名编辑：将 PNG 加载到 canvas，支持橡皮擦和一键优化 =====

  const loadSignatureToCanvas = (pngUrl: string) => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      sigHistoryRef.current = [pngUrl];
    };
    img.src = pngUrl;
  };

  const saveCanvasToSignature = () => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL("image/png");
    setSignaturePng(url);
    // 保存到撤销栈
    sigHistoryRef.current.push(url);
    if (sigHistoryRef.current.length > 20) sigHistoryRef.current.shift();
  };

  // 橡皮擦：在 canvas 上擦除圆形区域
  const getCanvasPos = (e: React.MouseEvent<HTMLCanvasElement> | MouseEvent): { x: number; y: number } | null => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: ((e as MouseEvent).clientX - rect.left) * scaleX,
      y: ((e as MouseEvent).clientY - rect.top) * scaleY,
    };
  };

  const eraseAt = (x: number, y: number, prevX?: number, prevY?: number) => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = eraserSize * (canvas.width / canvas.getBoundingClientRect().width);
    ctx.beginPath();
    if (prevX != null && prevY != null) {
      ctx.moveTo(prevX, prevY);
      ctx.lineTo(x, y);
    } else {
      ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.restore();
  };

  const handleEraserDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!eraserMode) return;
    e.preventDefault();
    erasingRef.current = true;
    const pos = getCanvasPos(e);
    if (!pos) return;
    sigLastPointRef.current = pos;
    eraseAt(pos.x, pos.y);
    // 绑定全局事件（允许拖出 canvas 继续擦除）
    window.addEventListener("mousemove", handleEraserWindowMove);
    window.addEventListener("mouseup", handleEraserWindowUp);
  };

  const handleEraserWindowMove = (e: MouseEvent) => {
    if (!erasingRef.current) return;
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // 将窗口坐标转换为 canvas 像素坐标
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.max(0, Math.min(canvas.width, (e.clientX - rect.left) * scaleX));
    const y = Math.max(0, Math.min(canvas.height, (e.clientY - rect.top) * scaleY));
    const prev = sigLastPointRef.current;
    if (prev) {
      eraseAt(x, y, prev.x, prev.y);
    } else {
      eraseAt(x, y);
    }
    sigLastPointRef.current = { x, y };
  };

  const handleEraserWindowUp = () => {
    erasingRef.current = false;
    sigLastPointRef.current = null;
    window.removeEventListener("mousemove", handleEraserWindowMove);
    window.removeEventListener("mouseup", handleEraserWindowUp);
    // 擦除完成后保存状态
    saveCanvasToSignature();
  };

  const handleEraserMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // 已有全局 mousemove 处理，这里留空（React 事件在 canvas 内也会触发，但全局已覆盖）
    void e;
  };

  const handleEraserUp = () => {
    // mouseup 由全局事件处理（在 handleEraserDown 中绑定）
  };

  // 撤销
  const handleUndoEraser = () => {
    if (sigHistoryRef.current.length <= 1) return;
    sigHistoryRef.current.pop(); // 移除当前状态
    const prevUrl = sigHistoryRef.current[sigHistoryRef.current.length - 1];
    setSignaturePng(prevUrl);
    loadSignatureToCanvas(prevUrl);
  };

  // 一键优化：形态学开运算 + 连通域去噪 + 彩色噪点去除
  const handleOptimizeSignature = () => {
    if (!signaturePng) return;
    setSignatureOptimizing(true);

    // 确保 canvas 已加载当前签名
    const runOptimize = () => {
      try {
        const canvas = signatureCanvasRef.current;
        if (!canvas) { setSignatureOptimizing(false); return; }
        const w = canvas.width;
        const h = canvas.height;
        if (w === 0 || h === 0) { setSignatureOptimizing(false); return; }
        const ctx = canvas.getContext("2d");
        if (!ctx) { setSignatureOptimizing(false); return; }

        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;

        // Step 1: 二值化 —— 先将 alpha 通道归 0 或 255，同时过滤彩色像素（印章等非墨迹颜色）
        const alpha = new Uint8Array(w * h);
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a < 30) { alpha[p] = 0; continue; }
          // 检测彩色像素（饱和度高且非深色），视为噪点/印章，设为透明
          const maxC = Math.max(r, g, b);
          const minC = Math.min(r, g, b);
          const sat = maxC > 0 ? (maxC - minC) / maxC : 0;
          const luminance = (0.299 * r + 0.587 * g + 0.114 * b);
          if (sat > 0.4 && luminance > 80) {
            alpha[p] = 0; // 彩色且不够深 → 去除
            continue;
          }
          alpha[p] = a > 128 ? 1 : 0; // 前景=1，背景=0
        }

        // Step 2: 形态学腐蚀（去掉小颗粒）—— 3x3 kernel，仅当8邻域全为1时保留
        const eroded = new Uint8Array(w * h);
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const idx = y * w + x;
            let allOne = true;
            for (let dy = -1; dy <= 1 && allOne; dy++) {
              for (let dx = -1; dx <= 1 && allOne; dx++) {
                if (alpha[(y + dy) * w + (x + dx)] !== 1) allOne = false;
              }
            }
            eroded[idx] = allOne ? 1 : 0;
          }
        }

        // Step 3: 形态学膨胀（恢复主体笔画粗细）—— 3x3 kernel，任意邻居为1则设为1
        const opened = new Uint8Array(w * h);
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const idx = y * w + x;
            let anyOne = false;
            for (let dy = -1; dy <= 1 && !anyOne; dy++) {
              for (let dx = -1; dx <= 1 && !anyOne; dx++) {
                if (eroded[(y + dy) * w + (x + dx)] === 1) anyOne = true;
              }
            }
            opened[idx] = anyOne ? 1 : 0;
          }
        }

        // Step 4: 连通域分析 —— 去除孤立的小像素块
        const visited = new Uint8Array(w * h);
        const labels = new Int32Array(w * h).fill(-1);
        let label = 0;
        const regions: Array<{ pixels: number[]; size: number }> = [];
        const queue: number[] = [];

        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            if (opened[idx] === 1 && !visited[idx]) {
              queue.length = 0;
              queue.push(idx);
              visited[idx] = 1;
              const pixels: number[] = [];
              while (queue.length > 0) {
                const cur = queue.shift()!;
                pixels.push(cur);
                const cx = cur % w;
                const cy = (cur - cx) / w;
                // 8邻域
                for (let dy = -1; dy <= 1; dy++) {
                  for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = cx + dx, ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                    const nIdx = ny * w + nx;
                    if (opened[nIdx] === 1 && !visited[nIdx]) {
                      visited[nIdx] = 1;
                      queue.push(nIdx);
                    }
                  }
                }
              }
              regions.push({ pixels, size: pixels.length });
              for (const p of pixels) labels[p] = label;
              label++;
            }
          }
        }

        // 找出最大连通域（通常是主体签名）
        let maxSize = 0;
        for (const r of regions) if (r.size > maxSize) maxSize = r.size;
        // 保留最大域 + 大于阈值（maxSize * 0.02）的域（签名可能有多笔画）
        const minRegionSize = Math.max(15, Math.floor(maxSize * 0.015));
        const keepLabels = new Set<number>();
        regions.forEach((r, i) => {
          if (r.size >= minRegionSize) keepLabels.add(i);
        });

        // Step 5: 写回像素 —— 黑色墨水 + 透明背景
        for (let p = 0; p < w * h; p++) {
          const i = p * 4;
          const lbl = labels[p];
          if (opened[p] === 1 && lbl >= 0 && keepLabels.has(lbl)) {
            data[i] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
            data[i + 3] = 255;
          } else {
            data[i + 3] = 0; // 透明
          }
        }

        // 裁剪透明边缘（tight crop）
        let minX = w, minY = h, maxX = 0, maxY = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > 0) {
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX > minX && maxY > minY) {
          const pad = 4;
          const cw = maxX - minX + 1 + pad * 2;
          const ch = maxY - minY + 1 + pad * 2;
          const croppedData = ctx.createImageData(cw, ch);
          for (let y = 0; y < ch; y++) {
            for (let x = 0; x < cw; x++) {
              const sx = minX - pad + x;
              const sy = minY - pad + y;
              const di = (y * cw + x) * 4;
              if (sx >= 0 && sy >= 0 && sx < w && sy < h) {
                const si = (sy * w + sx) * 4;
                croppedData.data[di] = data[si];
                croppedData.data[di + 1] = data[si + 1];
                croppedData.data[di + 2] = data[si + 2];
                croppedData.data[di + 3] = data[si + 3];
              } else {
                croppedData.data[di + 3] = 0;
              }
            }
          }
          canvas.width = cw;
          canvas.height = ch;
          ctx.putImageData(croppedData, 0, 0);
        } else {
          ctx.putImageData(imgData, 0, 0);
        }

        saveCanvasToSignature();
      } catch (e) {
        console.error("Optimize failed:", e);
      }
      setSignatureOptimizing(false);
    };

    // 如果 canvas 已有内容（之前进入过橡皮擦或刚抠图），直接优化；否则先加载图片
    const canvas = signatureCanvasRef.current;
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      setTimeout(runOptimize, 30);
    } else {
      const img = new Image();
      img.onload = () => {
        const c = signatureCanvasRef.current;
        if (!c) { setSignatureOptimizing(false); return; }
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        if (!ctx) { setSignatureOptimizing(false); return; }
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0);
        sigHistoryRef.current = [signaturePng!];
        setTimeout(runOptimize, 30);
      };
      img.src = signaturePng;
    }
  };

  const [copySuccess, setCopySuccess] = useState(false);

  // dataURL → Blob
  const dataUrlToBlob = (dataUrl: string): Blob => {
    const arr = dataUrl.split(",");
    const mime = arr[0].match(/:(.*?);/)?.[1] || "image/png";
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8 = new Uint8Array(n);
    while (n--) u8[n] = bstr.charCodeAt(n);
    return new Blob([u8], { type: mime });
  };

  const handleDownloadSignature = () => {
    if (!signaturePng) return;
    try {
      const blob = dataUrlToBlob(signaturePng);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `signature_${Date.now()}.png`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    } catch (e) {
      // Fallback: 直接用 data URL
      const a = document.createElement("a");
      a.href = signaturePng;
      a.download = `signature_${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  const handleCopySignature = async () => {
    if (!signaturePng) return;
    try {
      const blob = dataUrlToBlob(signaturePng);
      // 优先使用 Clipboard API 写图片（Electron/Chromium 支持）
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ]);
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 1500);
        return;
      }
      // Fallback: 复制为文本 data URL
      await navigator.clipboard.writeText(signaturePng);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 1500);
    } catch {
      setCopySuccess(false);
    }
  };

  const clearSignature = () => {
    setSignaturePng(null);
    setEraserMode(false);
    sigHistoryRef.current = [];
    const canvas = signatureCanvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  };

  // 切换文件时重置签名
  useEffect(() => {
    setSignaturePng(null);
    exitCropMode();
    setEraserMode(false);
  }, [sourcePreview?.imageUrl]);

  // 橡皮擦模式激活时加载签名到 canvas（canvas 始终挂载）
  useEffect(() => {
    if (eraserMode && signaturePng) {
      requestAnimationFrame(() => {
        const canvas = signatureCanvasRef.current;
        if (!canvas) return;
        if (canvas.width === 0 || canvas.height === 0) {
          loadSignatureToCanvas(signaturePng);
        }
      });
    }
  }, [eraserMode, signaturePng]);

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

  // ===== 源文件预览内嵌导出状态 =====
  const [previewShowExport, setPreviewShowExport] = useState(false);
  const [previewExportFormat, setPreviewExportFormat] = useState<"original" | "jpg" | "png" | "pdf">("original");
  const [previewExportCompress, setPreviewExportCompress] = useState(true);
  const [previewExportSizeVal, setPreviewExportSizeVal] = useState("500");
  const [previewExportSizeUnit, setPreviewExportSizeUnit] = useState<"KB" | "MB">("KB");
  const [previewExportBusy, setPreviewExportBusy] = useState(false);
  const [previewExportResult, setPreviewExportResult] = useState<{ size: number; reached: boolean; warnings: string[] } | null>(null);

  // 源文件变化时重置导出面板
  useEffect(() => {
    setPreviewShowExport(false);
    setPreviewExportResult(null);
  }, [sourcePreview?.imageUrl, sourcePreview?.filename]);

  const previewOrigSize = useMemo(() => {
    if (!sourcePreview) return 0;
    const url = sourcePreview.imageUrl;
    const idx = url.indexOf(",");
    if (idx < 0) return 0;
    return Math.floor((url.slice(idx + 1).length * 3) / 4);
  }, [sourcePreview]);

  const doPreviewExport = async () => {
    if (!sourcePreview || previewExportBusy) return;
    setPreviewExportBusy(true);
    setPreviewExportResult(null);
    try {
      let targetKb = 0;
      if (previewExportCompress) {
        const n = parseFloat(previewExportSizeVal);
        if (!isFinite(n) || n <= 0) {
          onError?.("请填写有效的目标大小");
          setPreviewExportBusy(false);
          return;
        }
        targetKb = Math.round(previewExportSizeUnit === "MB" ? n * 1024 : n);
      }
      const res = await api.convertDocument(sourcePreview.imageUrl, sourcePreview.filename, previewExportFormat, targetKb);
      const stem = sourcePreview.filename.replace(/\.[^.]+$/, "") || "export";
      const outName = `${stem}.${res.ext}`;
      const saved = await window.electronAPI?.saveExportedFile(outName, res.data_b64);
      if (!saved) {
        onError?.("当前环境不支持保存对话框");
      } else if (saved.canceled) {
        // 用户取消
      } else if (saved.ok) {
        setPreviewExportResult({ size: res.size, reached: res.reached, warnings: res.warnings || [] });
        onToast?.(`已导出：${outName}（${fmtSize(res.size)}）`);
      } else {
        onError?.(`保存失败: ${saved.error || "未知错误"}`);
      }
    } catch (e) {
      onError?.(`导出失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPreviewExportBusy(false);
    }
  };

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
                1. 在右侧网页中依次点击元素导航到下载按钮（开头点击）<br />
                2. 触发下载后系统自动捕获并 OCR 提取<br />
                3. 提取成功后可添加过程点击（提取后的中间步骤）<br />
                4. 完成后点底部「完成提取」
                <p className="mt-1 text-[8px] text-sky-500">快捷键：Ctrl+Z 撤销 · Backspace 返回 · 任意键恢复光标</p>
              </div>
            )}

            {/* 已记录点击步骤 —— 文件提取成功后隐藏，给预览区腾空间 */}
            {!sourcePreview && (
              <div className="rounded-md border border-slate-200 bg-white px-2 py-1.5 shrink-0">
                <div className="flex items-center gap-1">
                  <ListChecks className="h-3 w-3 text-slate-500" />
                  <span className="text-[10px] font-semibold text-slate-700">已记录点击步骤</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className={[
                    "rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                    webStepCount > 0 ? "bg-sky-100 text-sky-700" : "bg-slate-100 text-slate-400",
                  ].join(" ")}>
                    开头 {webStepCount} 步
                  </span>
                  {webPostStepCount > 0 && (
                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                      收尾 {webPostStepCount} 步
                    </span>
                  )}
                </div>
                {webStepCount === 0 && webPostStepCount === 0 && (
                  <p className="mt-1 text-[9px] text-slate-400">请在右侧网页点击元素以记录导航步骤…</p>
                )}
                {webStepCount > 0 && webPostStepCount === 0 && (
                  <p className="mt-1 text-[9px] text-sky-600">✓ 已记录开头导航步骤，点击触发下载后可继续添加过程点击</p>
                )}
                {webPostStepCount > 0 && (
                  <p className="mt-1 text-[9px] text-amber-600">✓ 已记录过程点击步骤，可继续点击或完成提取</p>
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
                  <span className="max-w-[40%] truncate text-[9px] font-mono text-slate-500" title={sourcePreview.filename}>
                    {sourcePreview.filename}
                  </span>
                  {sourceIsPdf && (
                    <span className="rounded bg-rose-100 px-1 text-[8px] font-semibold text-rose-600">PDF</span>
                  )}
                  {/* 截取签名按钮 */}
                  <button
                    onClick={() => {
                      if (!sourcePreviewOpen) setSourcePreviewOpen(true);
                      if (cropMode) {
                        exitCropMode();
                      } else {
                        setCropMode(true);
                        setCropRect(null);
                        setCropStart(null);
                      }
                    }}
                    className={[
                      "ml-1 flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium transition-all",
                      cropMode
                        ? "bg-violet-600 text-white shadow-sm"
                        : "bg-violet-50 text-violet-600 hover:bg-violet-100",
                    ].join(" ")}
                    title="截取签名：在图片上拖拽框选签名区域，自动去除白色背景生成透明PNG"
                  >
                    <Crop className="h-2.5 w-2.5" />
                    {cropMode ? "取消框选" : "截取签名"}
                  </button>
                  {/* 导出按钮（源文件预览阶段即可导出）*/}
                  {onExportDoc && (
                    <button
                      onClick={() => {
                        if (!sourcePreviewOpen) setSourcePreviewOpen(true);
                        setPreviewShowExport((v) => !v);
                      }}
                      className={[
                        "ml-0.5 flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium transition-all",
                        previewShowExport
                          ? "bg-teal-600 text-white shadow-sm"
                          : "bg-teal-50 text-teal-600 hover:bg-teal-100",
                      ].join(" ")}
                      title="导出文件（格式转换/压缩）"
                    >
                      <FileDown className="h-2.5 w-2.5" />
                      {previewShowExport ? "收起" : "导出"}
                    </button>
                  )}
                  {/* 一键直传：直接上传到网页上传框 */}
                  {onQuickUploadDoc && sourcePreview && (
                    <button
                      onClick={() => {
                        onQuickUploadDoc({ dataUrl: sourcePreview.imageUrl, filename: sourcePreview.filename });
                      }}
                      className="ml-0.5 flex items-center gap-0.5 rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] font-medium text-emerald-600 transition-all hover:bg-emerald-100"
                      title="一键直传：点击后光标变十字，再点击网页上的上传按钮即可直接上传该文件，不弹额外对话框"
                    >
                      <Upload className="h-2.5 w-2.5" />
                      直传
                    </button>
                  )}
                  <div className="ml-auto flex items-center gap-0.5">
                    <button
                      onClick={() => setSourcePreviewOpen((v) => !v)}
                      className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
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
                </div>
                {/* 截取模式提示条 */}
                {cropMode && (
                  <div className="flex shrink-0 items-center gap-1 bg-violet-50 px-2 py-1 text-[9px] text-violet-700">
                    <Sigma className="h-2.5 w-2.5" />
                    <span>在图片上拖拽鼠标框选签名区域，松开后自动扣除白色背景</span>
                    <button
                      onClick={exitCropMode}
                      className="ml-auto rounded px-1 py-0.5 text-[8px] font-medium text-violet-500 hover:bg-violet-100"
                    >
                      取消
                    </button>
                  </div>
                )}
                {/* 预览图片区域：展开时填满剩余空间，内部滚动查看大图；滚到边界后自动传递滚轮事件给外层容器 */}
                {sourcePreviewOpen && (
                  <div
                    ref={previewScrollRef}
                    onWheel={handlePreviewWheel}
                    className="min-h-0 flex-1 overflow-auto bg-slate-100/80 p-1.5"
                  >
                    <div className="relative flex min-h-[200px] items-start justify-center">
                      <img
                        ref={previewImgRef}
                        src={sourcePreview.imageUrl}
                        alt={sourcePreview.filename}
                        className={[
                          "max-w-full rounded border shadow-sm",
                          cropMode ? "border-violet-300 bg-white object-contain select-none" : "border-slate-200 bg-white object-contain",
                        ].join(" ")}
                        draggable={false}
                        onMouseDown={handleCropMouseDown}
                        style={cropMode ? { cursor: "crosshair" } : undefined}
                      />
                      {/* 框选遮罩层：在裁剪模式下显示半透明遮罩和选区矩形 */}
                      {cropMode && cropRect && (
                        <div
                          className="pointer-events-none absolute inset-0"
                          style={{ zIndex: 10 }}
                        >
                          {/* 用一个 SVG 或者 div 画选区矩形，考虑到 object-contain 的 letterbox 偏移 */}
                          <SelectionOverlay rect={cropRect} imgRef={previewImgRef} getImgContentRect={getImgContentRect} />
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {/* 源文件预览内嵌导出面板 */}
                {previewShowExport && sourcePreview && (
                  <div className="shrink-0 border-t border-teal-100 bg-white p-2 space-y-2">
                    <div className="flex items-center justify-between rounded bg-slate-50 px-2 py-1 text-[9px] text-slate-500">
                      <span>原始大小</span>
                      <span className="font-semibold text-slate-700">{fmtSize(previewOrigSize)}</span>
                    </div>
                    <div>
                      <div className="mb-1 text-[9px] font-medium text-slate-500">导出格式</div>
                      <div className="grid grid-cols-4 gap-1">
                        {([
                          { key: "original", label: "原格式" },
                          { key: "jpg", label: "JPG" },
                          { key: "png", label: "PNG" },
                          { key: "pdf", label: "PDF" },
                        ] as const).map((opt) => (
                          <button
                            key={opt.key}
                            onClick={() => setPreviewExportFormat(opt.key)}
                            className={`rounded border px-1 py-1 text-[9px] font-medium transition-all ${
                              previewExportFormat === opt.key
                                ? "border-teal-500 bg-teal-50 text-teal-700 ring-1 ring-teal-200"
                                : "border-slate-200 bg-white text-slate-500 hover:border-teal-200 hover:bg-teal-50/50"
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      {sourceIsPdf && (previewExportFormat === "jpg" || previewExportFormat === "png") && (
                        <p className="mt-0.5 text-[8px] text-amber-600">多页 PDF 转图片仅导出第 1 页</p>
                      )}
                    </div>
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-[9px] font-medium text-slate-500">压缩到指定大小</span>
                        <button
                          onClick={() => setPreviewExportCompress((v) => !v)}
                          className={`relative h-3.5 w-6 rounded-full transition-colors ${previewExportCompress ? "bg-teal-500" : "bg-slate-300"}`}
                        >
                          <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-all ${previewExportCompress ? "left-3" : "left-0.5"}`} />
                        </button>
                      </div>
                      {previewExportCompress && (
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={1}
                            value={previewExportSizeVal}
                            onChange={(e) => setPreviewExportSizeVal(e.target.value)}
                            className="w-16 rounded border border-slate-200 px-1.5 py-1 text-[10px] text-slate-700 outline-none focus:border-teal-400"
                          />
                          <div className="flex overflow-hidden rounded border border-slate-200">
                            {(["KB", "MB"] as const).map((u) => (
                              <button
                                key={u}
                                onClick={() => setPreviewExportSizeUnit(u)}
                                className={`px-1.5 py-1 text-[9px] font-medium transition-colors ${
                                  previewExportSizeUnit === u ? "bg-teal-500 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                                }`}
                              >
                                {u}
                              </button>
                            ))}
                          </div>
                          <span className="text-[8px] text-slate-400">自动降质/缩尺寸</span>
                        </div>
                      )}
                    </div>
                    {previewExportResult && (
                      <div className={`rounded px-2 py-1 text-[9px] ${previewExportResult.reached ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                        导出大小：<span className="font-bold">{fmtSize(previewExportResult.size)}</span>
                        {previewExportResult.reached ? "（已达标）" : "（已压到极限仍超目标）"}
                        {previewExportResult.warnings.map((w, i) => (
                          <div key={i} className="mt-0.5 text-[8px] opacity-80">{w}</div>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={doPreviewExport}
                      disabled={previewExportBusy}
                      className={`flex w-full items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[10px] font-semibold transition-all ${
                        previewExportBusy ? "cursor-wait bg-slate-100 text-slate-400" : "bg-teal-600 text-white hover:bg-teal-700"
                      }`}
                    >
                      {previewExportBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                      {previewExportBusy ? "正在转换…" : "选择保存位置并导出"}
                    </button>
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
                  webStatus.phase === "fallback-scanning" ? "border-orange-200 bg-orange-50/70" : "",
                  webStatus.phase === "fallback-downloading" ? "border-orange-200 bg-orange-50/70" : "",
                  webStatus.phase === "fallback-review" ? "border-yellow-300 bg-yellow-50" : "",
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
                  {webStatus.phase === "fallback-scanning" && (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-orange-600" />
                  )}
                  {webStatus.phase === "fallback-downloading" && (
                    <FileDown className="h-3 w-3 shrink-0 animate-bounce text-orange-600" />
                  )}
                  {webStatus.phase === "fallback-review" && (
                    <ListChecks className="h-3 w-3 shrink-0 text-yellow-700" />
                  )}
                  <span
                    className={[
                      "text-[10px] font-semibold",
                      webStatus.phase === "downloading" ? "text-sky-700" : "",
                      webStatus.phase === "preview" ? "text-amber-700" : "",
                      webStatus.phase === "ocr" ? "text-indigo-700" : "",
                      webStatus.phase === "error" ? "text-rose-700" : "",
                      webStatus.phase === "fallback-scanning" ? "text-orange-700" : "",
                      webStatus.phase === "fallback-downloading" ? "text-orange-700" : "",
                      webStatus.phase === "fallback-review" ? "text-yellow-800" : "",
                    ].join(" ")}
                  >
                    {webStatus.phase === "downloading" && "正在下载文件…"}
                    {webStatus.phase === "preview" && "预览就绪"}
                    {webStatus.phase === "ocr" && "正在 OCR 提取文字…"}
                    {webStatus.phase === "error" && "提取失败"}
                    {webStatus.phase === "fallback-scanning" && (webStatus.message || "保底机制：回退页面扫描中…")}
                    {webStatus.phase === "fallback-downloading" && `保底下载：${webStatus.current || 0}/${webStatus.total || 0}${webStatus.currentFile ? ` · ${webStatus.currentFile}` : ""}`}
                    {webStatus.phase === "fallback-review" && "⚠️ 人工审查：请选择正确的文件"}
                  </span>
                  {webStatus.filename && webStatus.phase !== "fallback-review" && (
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
                  {webStatus.phase === "fallback-review" && webStatus.recordName && (
                    <span className="ml-auto text-[9px] font-medium text-yellow-700">
                      记录：{webStatus.recordName}
                    </span>
                  )}
                </div>

                {/* 进度条 */}
                {(webStatus.phase === "downloading" || webStatus.phase === "ocr" || webStatus.phase === "fallback-scanning" || webStatus.phase === "fallback-downloading") && (
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/70">
                    {webStatus.phase === "downloading" && webStatus.total && webStatus.total > 0 ? (
                      <div
                        className="h-full rounded-full bg-sky-500 transition-all duration-300"
                        style={{ width: `${Math.max(2, webStatus.percent || 0)}%` }}
                      />
                    ) : webStatus.phase === "fallback-downloading" && webStatus.total ? (
                      <div
                        className="h-full rounded-full bg-orange-500 transition-all duration-300"
                        style={{ width: `${Math.max(2, ((webStatus.current || 0) / webStatus.total) * 100)}%` }}
                      />
                    ) : (
                      <div className="h-full w-full animate-pulse rounded-full bg-orange-400/70" />
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

                {/* 保底机制：人工审查文件列表（折叠预览） */}
                {webStatus.phase === "fallback-review" && webStatus.files && webStatus.files.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    <p className="text-[9px] text-yellow-700">
                      自动匹配失败，已下载页面所有可下载文件，请人工选择对应文件：
                    </p>
                    {/* 文件列表（可折叠展开） */}
                    <FallbackFileList
                      files={webStatus.files}
                      onSelectFile={onSelectFallbackFile}
                    />
                    {/* 操作按钮 */}
                    <div className="flex items-center gap-2 pt-1">
                      {onCancelFallback && (
                        <button
                          onClick={onCancelFallback}
                          className="flex shrink-0 items-center gap-1 rounded-md border border-rose-200 bg-white px-2 py-1 text-[10px] font-medium text-rose-600 transition-all hover:bg-rose-50 active:scale-95"
                        >
                          <X className="h-3 w-3" />
                          跳过
                        </button>
                      )}
                      {onConfirmFallbackFile && (
                        <button
                          onClick={onConfirmFallbackFile}
                          className="flex shrink-0 items-center gap-1 rounded-md bg-yellow-600 px-2.5 py-1 text-[10px] font-semibold text-white shadow-sm transition-all hover:bg-yellow-700 active:scale-95"
                        >
                          <Check className="h-3 w-3" />
                          确认选择并提取
                        </button>
                      )}
                    </div>
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
                onToast={onToast}
                onError={onError}
              />
            )}

            {/* ===== 签名截取结果：透明背景PNG + 编辑工具 ===== */}
            {(signaturePng || signatureProcessing) && (
              <div className="shrink-0 rounded-lg border border-violet-200 bg-violet-50/40">
                <div className="flex items-center gap-1.5 border-b border-violet-100 bg-gradient-to-r from-violet-50 to-fuchsia-50 px-2 py-1">
                  <Crop className="h-3 w-3 text-violet-600" />
                  <span className="text-[10px] font-semibold text-violet-900">签名截图</span>
                  {signatureProcessing && (
                    <span className="flex items-center gap-1 text-[8px] text-violet-500">
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      正在扣除背景…
                    </span>
                  )}
                  {signatureOptimizing && (
                    <span className="flex items-center gap-1 text-[8px] text-amber-600">
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      优化中…
                    </span>
                  )}
                  {eraserMode && !signatureProcessing && !signatureOptimizing && (
                    <span className="rounded bg-violet-600 px-1.5 py-0.5 text-[8px] font-medium text-white">
                      橡皮擦模式
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-0.5">
                    {/* 编辑工具栏 */}
                    {signaturePng && !signatureProcessing && (
                      <>
                        <button
                          onClick={handleOptimizeSignature}
                          disabled={signatureOptimizing}
                          className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[8px] font-medium text-amber-600 hover:bg-amber-50 disabled:opacity-40"
                          title="一键优化：自动去除周围小颗粒、印章彩色噪点"
                        >
                          <Wand2 className="h-2.5 w-2.5" />
                          一键优化
                        </button>
                        <button
                          onClick={() => { setEraserMode((v) => !v); }}
                          className={[
                            "flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[8px] font-medium transition-colors",
                            eraserMode ? "bg-violet-600 text-white" : "text-violet-600 hover:bg-violet-100",
                          ].join(" ")}
                          title="橡皮擦：涂抹擦除多余小颗粒"
                        >
                          <Eraser className="h-2.5 w-2.5" />
                          擦除
                        </button>
                        <button
                          onClick={handleUndoEraser}
                          disabled={sigHistoryRef.current.length <= 1}
                          className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30"
                          title="撤销"
                        >
                          <RotateCcw className="h-2.5 w-2.5" />
                        </button>
                      </>
                    )}
                    <button
                      onClick={clearSignature}
                      className="rounded p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                      title="清除签名"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                {signaturePng && !signatureProcessing && (
                  <div className="p-2">
                    {/* 签名图片区域（棋盘格透明背景） */}
                    <div
                      className={[
                        "mx-auto flex max-h-[200px] items-center justify-center overflow-auto rounded border p-2",
                        eraserMode ? "border-violet-400 border-2 ring-2 ring-violet-200" : "border-violet-100",
                      ].join(" ")}
                      style={{
                        backgroundImage:
                          "linear-gradient(45deg, #e5e7eb 25%, transparent 25%), linear-gradient(-45deg, #e5e7eb 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e7eb 75%), linear-gradient(-45deg, transparent 75%, #e5e7eb 75%)",
                        backgroundSize: "10px 10px",
                        backgroundPosition: "0 0, 0 5px, 5px -5px, -5px 0px",
                        backgroundColor: "#f9fafb",
                      }}
                    >
                      {/* 始终渲染 canvas（优化/撤销需要操作它），仅在橡皮擦模式下可见可交互 */}
                      <canvas
                        ref={signatureCanvasRef}
                        className={eraserMode ? "max-h-[180px] max-w-full object-contain" : "hidden"}
                        style={eraserMode ? { cursor: "cell", display: "block" } : undefined}
                        onMouseDown={handleEraserDown}
                        onMouseMove={handleEraserMove}
                        onMouseUp={handleEraserUp}
                        onMouseLeave={handleEraserUp}
                      />
                      {/* 预览模式：显示静态图片 */}
                      {!eraserMode && (
                        <img src={signaturePng} alt="signature" className="max-h-[180px] max-w-full object-contain" />
                      )}
                    </div>
                    {/* 橡皮擦提示 */}
                    {eraserMode && (
                      <p className="mt-1 text-center text-[8px] text-violet-500">
                        在签名上涂抹擦除多余颗粒，松开自动保存
                      </p>
                    )}
                    <div className="mt-2 flex gap-1.5">
                      <button
                        onClick={handleDownloadSignature}
                        className="flex flex-1 items-center justify-center gap-1 rounded-md bg-violet-600 px-2 py-1 text-[10px] font-semibold text-white shadow-sm transition-all hover:bg-violet-700 active:scale-95"
                      >
                        <Download className="h-3 w-3" />
                        下载PNG
                      </button>
                      <button
                        onClick={handleCopySignature}
                        className={[
                          "flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold shadow-sm transition-all active:scale-95",
                          copySuccess
                            ? "bg-emerald-500 text-white"
                            : "bg-white text-violet-600 border border-violet-200 hover:bg-violet-50",
                        ].join(" ")}
                      >
                        <Copy className="h-3 w-3" />
                        {copySuccess ? "已复制!" : "COPY"}
                      </button>
                      <button
                        onClick={() => { setCropMode(true); setSignaturePng(null); exitCropMode(); setEraserMode(false); }}
                        className="flex items-center gap-1 rounded-md border border-violet-200 bg-white px-2 py-1 text-[10px] font-medium text-violet-600 transition-all hover:bg-violet-50 active:scale-95"
                      >
                        <Crop className="h-3 w-3" />
                        重截
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* 关闭状态/结果滚动包裹层 */}
            </div>
            {/* 关闭网页模式容器 */}
          </div>
        )}

        {/* ===== 本地模式专属内容 ===== */}
        {!isChoose && !isWeb && (
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
                ? `✓ 已提取 ${webStatus.filename || ""}${webPostStepCount > 0 ? ` · 过程${webPostStepCount}步` : ""}`
                : webStatus?.phase === "post-click"
                ? `过程点击模式 — 点击网页元素${webPostStepCount > 0 ? `（已记录${webPostStepCount}步）` : ""}`
                : webStatus?.phase === "error"
                ? <span className="text-rose-500">✗ {webStatus.message || "提取失败"}</span>
                : webStepCount > 0 || webPostStepCount > 0
                  ? `✓ 开头${webStepCount}步${webPostStepCount > 0 ? ` · 过程${webPostStepCount}步` : ""}，可继续或完成`
                  : "请在网页点击元素（开头导航点击）"}
            </span>
            <div className="flex items-center gap-1">
              {/* 撤销和返回按钮（开头点击/收尾点击阶段可用） */}
              {(webStatus?.phase === "idle" || webStatus?.phase === "post-click") && (webStepCount > 0 || webPostStepCount > 0) && onUndoClick && (
                <button
                  onClick={onUndoClick}
                  className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 transition-all hover:bg-rose-100 hover:text-rose-600"
                  title="撤销上一步点击（删除该步骤并浏览器回退）快捷键 Ctrl+Z"
                >
                  ↶ 撤销
                </button>
              )}
              {(webStatus?.phase === "idle" || webStatus?.phase === "post-click") && onGoBack && (
                <button
                  onClick={onGoBack}
                  className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 transition-all hover:bg-slate-200"
                  title="返回上一页（不撤销步骤，用于页面跳转错了想回去）快捷键 Backspace / Alt+←"
                >
                  ← 返回
                </button>
              )}
              {/* 光标消失时手动恢复按钮：在点击阶段始终可用 */}
              {(webStatus?.phase === "idle" || webStatus?.phase === "post-click") && onResumePicking && (
                <button
                  onClick={onResumePicking}
                  className="flex items-center gap-0.5 rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 transition-all hover:bg-indigo-100"
                  title="光标消失了？点这里强制恢复拾取光标（也可以按任意字母键恢复）"
                >
                  <MousePointer2 className="h-2.5 w-2.5" />
                  光标
                </button>
              )}
              {webStatus?.phase === "success" && onStartAddPostClicks && (
                <button
                  onClick={onStartAddPostClicks}
                  className="rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 transition-all hover:bg-amber-200"
                  title="添加过程点击：提取完成后，点击网页上的元素作为中间步骤（如翻页、继续下载下一个等）"
                >
                  + 过程点击
                </button>
              )}
              <button
                onClick={onExitWebMode}
                disabled={webStepCount === 0 && webPostStepCount === 0}
                className={[
                  "rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                  webStepCount > 0 || webPostStepCount > 0
                    ? "bg-teal-600 text-white hover:bg-teal-700"
                    : "cursor-not-allowed bg-slate-200 text-slate-400",
                ].join(" ")}
              >
                完成提取
              </button>
            </div>
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
  onToast,
  onError,
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
  onToast?: (msg: string) => void;
  onError?: (msg: string) => void;
}) {
  const [showRawText, setShowRawText] = useState(false);
  const [checkedFields, setCheckedFields] = useState<Set<string>>(
    () => new Set(Object.entries(result.fields || {}).filter(([, v]) => v).map(([f]) => f))
  );
  // 切换文件时重置勾选
  useEffect(() => {
    setCheckedFields(new Set(Object.entries(result.fields || {}).filter(([, v]) => v).map(([f]) => f)));
    setShowRawText(false);
    setShowExport(false);
  }, [result.filename, result.imageUrl]);

  // ===== 内嵌导出面板状态 =====
  const [showExport, setShowExport] = useState(false);
  const [exportFormat, setExportFormat] = useState<"original" | "jpg" | "png" | "pdf">("original");
  const [exportCompress, setExportCompress] = useState(true);
  const [exportSizeVal, setExportSizeVal] = useState("500");
  const [exportSizeUnit, setExportSizeUnit] = useState<"KB" | "MB">("KB");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportResult, setExportResult] = useState<{ size: number; reached: boolean; warnings: string[] } | null>(null);

  const isPdf = /\.pdf(\?|#|$)/i.test(result.filename) || result.imageUrl.startsWith("data:application/pdf");
  const origSize = useMemo(() => {
    const idx = result.imageUrl.indexOf(",");
    if (idx < 0) return 0;
    return Math.floor((result.imageUrl.slice(idx + 1).length * 3) / 4);
  }, [result.imageUrl]);

  const fmtSize = (bytes: number): string => {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  };

  const doExport = async () => {
    if (exportBusy) return;
    setExportBusy(true);
    setExportResult(null);
    try {
      let targetKb = 0;
      if (exportCompress) {
        const n = parseFloat(exportSizeVal);
        if (!isFinite(n) || n <= 0) {
          onError?.("请填写有效的目标大小");
          setExportBusy(false);
          return;
        }
        targetKb = Math.round(exportSizeUnit === "MB" ? n * 1024 : n);
      }
      const res = await api.convertDocument(result.imageUrl, result.filename, exportFormat, targetKb);
      const stem = result.filename.replace(/\.[^.]+$/, "") || "export";
      const outName = `${stem}.${res.ext}`;
      const saved = await window.electronAPI?.saveExportedFile(outName, res.data_b64);
      if (!saved) {
        onError?.("当前环境不支持保存对话框");
      } else if (saved.canceled) {
        // 用户取消
      } else if (saved.ok) {
        setExportResult({ size: res.size, reached: res.reached, warnings: res.warnings || [] });
        onToast?.(`已导出：${outName}（${fmtSize(res.size)}）`);
      } else {
        onError?.(`保存失败: ${saved.error || "未知错误"}`);
      }
    } catch (e) {
      onError?.(`导出失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExportBusy(false);
    }
  };

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
                onClick={() => setShowExport((v) => !v)}
                className={[
                  "flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-white transition-all",
                  showExport ? "bg-teal-700 ring-2 ring-teal-300" : "bg-teal-600 hover:bg-teal-700",
                ].join(" ")}
                title="导出文件"
              >
                <FileDown className="h-2.5 w-2.5" />
                {showExport ? "收起导出" : "导出"}
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

        {/* 内嵌导出面板 */}
        {showExport && (
          <div className="rounded-lg border border-teal-200 bg-white p-2 space-y-2">
            {/* 原始大小 */}
            <div className="flex items-center justify-between rounded bg-slate-50 px-2 py-1 text-[9px] text-slate-500">
              <span>原始大小</span>
              <span className="font-semibold text-slate-700">{fmtSize(origSize)}</span>
            </div>
            {/* 格式选择 */}
            <div>
              <div className="mb-1 text-[9px] font-medium text-slate-500">导出格式</div>
              <div className="grid grid-cols-4 gap-1">
                {([
                  { key: "original", label: "原格式" },
                  { key: "jpg", label: "JPG" },
                  { key: "png", label: "PNG" },
                  { key: "pdf", label: "PDF" },
                ] as const).map((opt) => (
                  <button
                    key={opt.key}
                    onClick={() => setExportFormat(opt.key)}
                    className={`rounded border px-1 py-1 text-[9px] font-medium transition-all ${
                      exportFormat === opt.key
                        ? "border-teal-500 bg-teal-50 text-teal-700 ring-1 ring-teal-200"
                        : "border-slate-200 bg-white text-slate-500 hover:border-teal-200 hover:bg-teal-50/50"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {isPdf && (exportFormat === "jpg" || exportFormat === "png") && (
                <p className="mt-0.5 text-[8px] text-amber-600">多页 PDF 转图片仅导出第 1 页</p>
              )}
            </div>
            {/* 压缩设置 */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[9px] font-medium text-slate-500">压缩到指定大小</span>
                <button
                  onClick={() => setExportCompress((v) => !v)}
                  className={`relative h-3.5 w-6 rounded-full transition-colors ${exportCompress ? "bg-teal-500" : "bg-slate-300"}`}
                >
                  <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-all ${exportCompress ? "left-3" : "left-0.5"}`} />
                </button>
              </div>
              {exportCompress && (
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={1}
                    value={exportSizeVal}
                    onChange={(e) => setExportSizeVal(e.target.value)}
                    className="w-16 rounded border border-slate-200 px-1.5 py-1 text-[10px] text-slate-700 outline-none focus:border-teal-400"
                  />
                  <div className="flex overflow-hidden rounded border border-slate-200">
                    {(["KB", "MB"] as const).map((u) => (
                      <button
                        key={u}
                        onClick={() => setExportSizeUnit(u)}
                        className={`px-1.5 py-1 text-[9px] font-medium transition-colors ${
                          exportSizeUnit === u ? "bg-teal-500 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                        }`}
                      >
                        {u}
                      </button>
                    ))}
                  </div>
                  <span className="text-[8px] text-slate-400">自动降质/缩尺寸</span>
                </div>
              )}
            </div>
            {/* 结果反馈 */}
            {exportResult && (
              <div className={`rounded px-2 py-1 text-[9px] ${exportResult.reached ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                导出大小：<span className="font-bold">{fmtSize(exportResult.size)}</span>
                {exportResult.reached ? "（已达标）" : "（已压到极限仍超目标）"}
                {exportResult.warnings.map((w, i) => (
                  <div key={i} className="mt-0.5 text-[8px] opacity-80">{w}</div>
                ))}
              </div>
            )}
            {/* 导出按钮 */}
            <button
              onClick={doExport}
              disabled={exportBusy}
              className={`flex w-full items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[10px] font-semibold transition-all ${
                exportBusy ? "cursor-wait bg-slate-100 text-slate-400" : "bg-teal-600 text-white hover:bg-teal-700"
              }`}
            >
              {exportBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
              {exportBusy ? "正在转换…" : "选择保存位置并导出"}
            </button>
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

/**
 * 框选矩形覆盖层：在预览图片上方显示拖拽选区
 * 通过测量 img 元素位置和 object-contain 的 letterbox 偏移来精确定位
 */
function SelectionOverlay({
  rect,
  imgRef,
  getImgContentRect,
}: {
  rect: { x: number; y: number; w: number; h: number } | null;
  imgRef: React.RefObject<HTMLImageElement>;
  getImgContentRect: (img: HTMLImageElement) => { x: number; y: number; w: number; h: number; scale: number };
}) {
  const [pos, setPos] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  useEffect(() => {
    const img = imgRef.current;
    const parent = img?.parentElement;
    if (!img || !parent || !rect) { setPos(null); return; }

    const measure = () => {
      const imgRect = img.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      const content = getImgContentRect(img);
      setPos({
        left: imgRect.left - parentRect.left + content.x + rect.x,
        top: imgRect.top - parentRect.top + content.y + rect.y,
        width: rect.w,
        height: rect.h,
      });
    };

    measure();
    // 监听窗口大小变化重新测量
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [rect, imgRef, getImgContentRect]);

  if (!pos || !rect || rect.w < 1 || rect.h < 1) return null;

  return (
    <>
      {/* 选区边框 */}
      <div
        className="absolute pointer-events-none"
        style={{
          left: pos.left,
          top: pos.top,
          width: pos.width,
          height: pos.height,
          border: "1.5px solid #7c3aed",
          backgroundColor: "rgba(124, 58, 237, 0.1)",
          boxSizing: "border-box",
          zIndex: 20,
        }}
      >
        {/* 四角标记 */}
        <span className="absolute -top-0.5 -left-0.5 h-2 w-2 border-t-2 border-l-2 border-violet-600" />
        <span className="absolute -top-0.5 -right-0.5 h-2 w-2 border-t-2 border-r-2 border-violet-600" />
        <span className="absolute -bottom-0.5 -left-0.5 h-2 w-2 border-b-2 border-l-2 border-violet-600" />
        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 border-b-2 border-r-2 border-violet-600" />
      </div>
      {/* 尺寸标签 */}
      <div
        className="absolute pointer-events-none rounded bg-violet-600 px-1 py-0.5 text-[8px] font-mono text-white"
        style={{
          left: pos.left,
          top: Math.max(0, pos.top - 16),
          zIndex: 21,
        }}
      >
        {Math.round(rect.w)} × {Math.round(rect.h)}
      </div>
    </>
  );
}

// ============ 保底机制：折叠式文件列表（人工审查选择）============
interface FallbackFileListProps {
  files: Array<{ filename: string; dataUrl: string; size: number; mime: string; matched: boolean; selected?: boolean }>;
  onSelectFile?: (filename: string) => void;
}
function FallbackFileList({ files, onSelectFile }: FallbackFileListProps) {
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const fmtSize = (bytes?: number) => {
    if (bytes == null) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="max-h-[280px] space-y-1 overflow-y-auto rounded border border-yellow-200 bg-white/60 p-1">
      {files.map((file) => {
        const isExpanded = expandedFile === file.filename;
        const isImage = file.dataUrl.startsWith("data:image/");
        const isPdf = file.dataUrl.startsWith("data:application/pdf");
        return (
          <div
            key={file.filename}
            className={[
              "rounded-md border transition-all",
              file.selected ? "border-yellow-500 bg-yellow-100/70 ring-1 ring-yellow-400" : "border-slate-200 bg-white hover:border-yellow-300",
            ].join(" ")}
          >
            {/* 文件标题行：可点击展开/折叠 */}
            <div
              className="flex cursor-pointer items-center gap-1.5 px-1.5 py-1"
              onClick={() => {
                if (isExpanded) {
                  setExpandedFile(null);
                } else {
                  setExpandedFile(file.filename);
                  onSelectFile?.(file.filename);
                }
              }}
            >
              {/* 选中标记 */}
              <span className={[
                "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
                file.selected ? "border-yellow-600 bg-yellow-500 text-white" : "border-slate-300 bg-white",
              ].join(" ")}>
                {file.selected && <Check className="h-2.5 w-2.5" />}
              </span>
              {/* 文件名匹配标记 */}
              {file.matched && (
                <span className="shrink-0 rounded bg-green-100 px-1 text-[8px] font-semibold text-green-700">
                  匹配
                </span>
              )}
              <FileText className={[
                "h-3 w-3 shrink-0",
                file.selected ? "text-yellow-600" : "text-slate-400",
              ].join(" ")} />
              <span
                className="flex-1 truncate text-[9px] font-medium"
                title={file.filename}
              >
                {file.filename}
              </span>
              <span className="shrink-0 text-[8px] text-slate-400 tabular-nums">
                {fmtSize(file.size)}
              </span>
              <ChevronDown className={[
                "h-3 w-3 shrink-0 transition-transform",
                isExpanded ? "rotate-180 text-yellow-600" : "text-slate-400",
              ].join(" ")} />
            </div>
            {/* 展开的预览区域 */}
            {isExpanded && (
              <div className="border-t border-slate-100 bg-slate-50/50 p-1.5">
                {isImage ? (
                  <img
                    src={file.dataUrl}
                    alt={file.filename}
                    className="mx-auto max-h-[180px] max-w-full rounded object-contain"
                  />
                ) : isPdf ? (
                  <iframe
                    src={file.dataUrl}
                    className="mx-auto h-[200px] w-full rounded border"
                    title={file.filename}
                  />
                ) : (
                  <div className="flex h-[80px] items-center justify-center rounded bg-white text-[9px] text-slate-400">
                    <FileText className="mr-1 h-4 w-4" />
                    该文件类型暂不支持在线预览，请确认文件名后选择
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
