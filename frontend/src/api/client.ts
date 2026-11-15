import type {
  AppConfig,
  AppSettings,
  ApplicantRecord,
  ArchivePayload,
  CoworkClient,
  CoworkDispatchEvent,
  CoworkSkill,
  DepsStatus,
  DocumentConvertResult,
  DocumentExtractResult,
  DocumentPreviewResult,
  GpuInfo,
  HarnessEvent,
  HarnessExcelSource,
  HarnessPage,
  HarnessPlan,
  HarnessQueueTask,
  HarnessStatus,
  HumanCoworkTask,
  PPTFileSlides,
  PPTOutlineSlide,
  PPTProgressEvent,
  PPTSlideElement,
  PPTStreamEvent,
  PPTSection,
  PPTStyleProfile,
  PPTTextPatch,
  PluginRecord,
  PluginStatus,
  ScreenshotEvent,
  VerificationReport,
  VerificationResult,
  VerificationStep,
  WorkflowConfig,
} from "../types";

// Electron 生产环境从 file:// 加载，需要用绝对地址访问后端
const API_HOST =
  typeof window !== "undefined" && window.electronAPI && !window.location.hostname
    ? "http://localhost:8000"
    : "";
const BASE = `${API_HOST}/api`;

/**
 * 进程间接口令牌。
 *
 * 后端的 /api 与 /ws 要求带一个只有自家进程才知道的令牌：渲染进程里的
 * BrowserView 用 webSecurity:false 加载第三方学校网站，该设置会让页面绕过 CORS，
 * 因此 CORS 白名单挡不住第三方页面直连本机后端（能读到 API Key 与护照数据）。
 * 令牌由 Electron 主进程随机生成，经 preload 注入到这里；
 * 第三方网页所在的 BrowserView 没有 preload，所以拿不到。
 *
 * 普通浏览器里为空字符串 —— 后端在未配置令牌时完全放行，故不受影响。
 */
function apiToken(): string {
  if (typeof window === "undefined") return "";
  return window.electronAPI?.apiToken || "";
}

/** 把令牌并进请求头；必须与调用方已有的头合并，不能覆盖 Content-Type。 */
function withAuth(headers?: HeadersInit): HeadersInit {
  const token = apiToken();
  if (!token) return headers ?? {};
  const merged: Record<string, string> = {};
  if (headers) {
    if (Array.isArray(headers)) {
      for (const [k, v] of headers) merged[k] = v;
    } else if (typeof Headers !== "undefined" && headers instanceof Headers) {
      headers.forEach((v, k) => {
        merged[k] = v;
      });
    } else {
      Object.assign(merged, headers as Record<string, string>);
    }
  }
  merged["X-CINSIDE-Token"] = token;
  return merged;
}

/**
 * 所有后端 HTTP 请求的统一出口：自动附带令牌。
 *
 * 新增调用后端的地方请一律用 apiFetch，不要直接用 fetch ——
 * 漏带令牌会在生产（enforce）下拿到 403。WebSocket 无法自定义请求头，
 * 见下方 subscribeTask 改用 ?token= 查询串。
 */
function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, headers: withAuth(init?.headers) });
}

async function jsonFetch<T>(url: string, init?: RequestInit, timeoutMs = 30000): Promise<T> {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const resp = await apiFetch(url, { ...init, signal: controller.signal });
    if (!resp.ok) {
      // 只读一次 body：先拿 text，再尝试解析成 JSON 提取 detail/message
      // （避免先 json() 失败再 text() 触发 "body stream already read"）
      const text = await resp.text().catch(() => "");
      let msg = `${resp.status}`;
      if (text) {
        try {
          const j = JSON.parse(text);
          msg = j.detail || j.message || text;
        } catch {
          msg = text;
        }
      }
      throw new Error(msg);
    }
    return resp.json() as Promise<T>;
  } catch (e: any) {
    if (e.name === "AbortError") {
      throw new Error(`请求超时（${timeoutMs / 1000}s），后端可能未启动或被代理拦截`);
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 文档/OCR 接口超时：AI Vision 处理扫描件/图片（JPG/PDF/PNG 都可能慢）时，
// 30s 默认超时会被强制中断 → 误判"识别不到字段"→ 触发保底 → 跳过换下一位。
// 统一给足 240s（4 分钟），提升容错；网络/服务端稍慢也不会被误杀。
function docTimeout(_filename?: string): number {
  return 240000;
}

/** 目标字段清洗：滤掉明显是 CSS 选择器的"字段名"（提取元素面板历史数据里，
 *  doc 条目的 name 可能存成了控件 selector，后端会把它当字段名让 LLM 匹配 → 全部落空）。
 *  含空格/>/. /#/: /[ /( /* 或超长的一律视为 selector，不下发给后端。 */
function sanitizeTargetFields(fields?: string[]): string[] | undefined {
  if (!fields || fields.length === 0) return fields;
  const looksLikeSelector = (s: string) => /[ >.#:[(*]/.test(s) || s.length > 40;
  const clean = fields.filter((f) => f && !looksLikeSelector(f));
  return clean;
}

/** OCR 引擎回退通知：提取结果带 fallback（所选引擎失败自动切换另一引擎）时
 * 派发全局事件，App 层监听后弹琥珀色警告提示（引擎选择必须让用户知晓） */
function notifyEngineFallback<T extends { fallback?: { from: string; to: string; reason: string } | null }>(res: T): T {
  if (res?.fallback) {
    try {
      window.dispatchEvent(new CustomEvent("cinside:ocr-fallback", { detail: res.fallback }));
    } catch {
      /* 非浏览器环境忽略 */
    }
  }
  return res;
}

/** Excel 导出响应解析：JSON=inplace 原地写回（返回路径），blob=副本下载 */
async function _parseExcelExportResp(resp: Response): Promise<{ mode: "inplace" | "download"; path?: string; filename?: string; note?: string }> {
  if (!resp.ok) {
    let msg = "导出失败";
    try { const j = await resp.json(); msg = j.detail || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await resp.json();
    return { mode: "inplace", path: j.path, note: j.note };
  }
  const blob = await resp.blob();
  const cd = resp.headers.get("content-disposition") || "";
  const m = /filename=([^;]+)/.exec(cd);
  const filename = m ? m[1].trim().replace(/^"|"$/g, "") : "data_updated.xlsx";
  return { mode: "download", filename, path: URL.createObjectURL(blob) };
}

export const api = {
  getConfig: () => jsonFetch<AppConfig>(`${BASE}/config`),

  getSettings: () => jsonFetch<AppSettings>(`${BASE}/config/settings`, undefined, 10000),

  saveSettings: (settings: Partial<AppSettings>) =>
    jsonFetch<{ ok: boolean; error?: string }>(
      `${BASE}/config/settings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      },
      15000
    ),

  testVision: () =>
    jsonFetch<{ supports_images: boolean; message: string }>(
      `${BASE}/config/test-vision`,
      {
        method: "POST",
      },
      30000
    ),

  /** 识别端点可用模型：填好 Base URL + Key 后调 {base}/models 拉取模型列表，
   *  设置面板据此展示可选项，不再手输模型名 */
  listModels: (payload: { api_base: string; api_key: string }) =>
    jsonFetch<{ ok: boolean; models?: string[]; error?: string }>(
      `${BASE}/config/list-models`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      20000
    ),

  /** 测试全局分析模型：按面板填写（留空项按已保存配置继承）发极小 chat 请求验证可用 */
  testAnalysis: (payload: { api_base?: string; api_key?: string; model?: string }) =>
    jsonFetch<{ ok: boolean; message: string }>(
      `${BASE}/config/test-analysis`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      30000
    ),

  /** 测试生图模型：核对型号在端点 /models 中是否存在（不实际生图） */
  testImagegen: (payload: { api_base?: string; api_key?: string; model?: string }) =>
    jsonFetch<{ ok: boolean; message: string }>(
      `${BASE}/config/test-imagegen`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      20000
    ),

  testUmiOcr: () =>
    jsonFetch<{ ok: boolean; message: string; host: string; port: number }>(`${BASE}/config/test-umi-ocr`, {
      method: "POST",
    }),
  /** 一键启动 UMI-OCR：后端会拉起进程并等 HTTP 就绪（首次加载模型可达 120s），前端需放长超时 */
  launchUmiOcr: () =>
    jsonFetch<{ ok: boolean; message: string; exe_path: string }>(`${BASE}/config/launch-umi-ocr`, {
      method: "POST",
    }, 130000),
  browseUmiOcr: () =>
    jsonFetch<{ ok: boolean; message: string; path: string }>(`${BASE}/config/browse-umi-ocr`, {
      method: "POST",
    }),
  openUmiOcrFolder: () =>
    jsonFetch<{ ok: boolean; message: string; exe_path: string }>(`${BASE}/config/open-umi-ocr-folder`, {
      method: "POST",
    }),
  testMarkitdown: () =>
    jsonFetch<{ ok: boolean; message: string }>(`${BASE}/config/test-markitdown`, {
      method: "POST",
    }),

  // ===== 依赖与工具管理 =====
  getDepsStatus: () =>
    jsonFetch<DepsStatus>(`${BASE}/config/deps-status`),
  /** 显卡/核显检测（refresh=true 强制重新查询硬件） */
  getGpuInfo: (refresh = false) =>
    jsonFetch<GpuInfo>(`${BASE}/config/gpu-info${refresh ? "?refresh=true" : ""}`, undefined, 30000),
  /** 手动触发内置 OCR 引擎 GPU 自检（返回最新引擎状态） */
  runGpuSelftest: () =>
    jsonFetch<{ ok: boolean; engine: GpuInfo["local_engine"] }>(`${BASE}/config/gpu-selftest`, { method: "POST" }, 120000),
  installPythonDeps: () =>
    jsonFetch<{ ok: boolean; message: string }>(
      `${BASE}/config/install-python-deps`,
      { method: "POST" },
      300000
    ),
  installOcrEngineDeps: () =>
    jsonFetch<{ ok: boolean; message: string }>(
      `${BASE}/config/install-ocr-engine-deps`,
      { method: "POST" },
      1900000
    ),
  downloadUmiOcr: () =>
    jsonFetch<{ ok: boolean; message: string; exe_path: string }>(
      `${BASE}/config/download-umi-ocr`,
      { method: "POST" },
      300000
    ),
  installRemotion: () =>
    jsonFetch<{ ok: boolean; message: string }>(
      `${BASE}/config/install-remotion`,
      { method: "POST" },
      300000
    ),
  installOfficecli: () =>
    jsonFetch<{ ok: boolean; message: string }>(
      `${BASE}/config/install-officecli`,
      { method: "POST" },
      300000
    ),

  uploadExcel: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return jsonFetch<{ count: number; records: ApplicantRecord[]; detected_column_map: Record<string, string> }>(
      `${BASE}/upload/excel`,
      { method: "POST", body: fd },
      60000
    );
  },

  uploadExcelRight: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return jsonFetch<{ count: number; records: ApplicantRecord[]; detected_column_map: Record<string, string> }>(
      `${BASE}/upload/excel-right`,
      { method: "POST", body: fd },
      60000
    );
  },

  listRightRecords: () =>
    jsonFetch<{ records: ApplicantRecord[] }>(`${BASE}/records-right`),

  clearRightRecords: () =>
    jsonFetch<{ ok: boolean }>(`${BASE}/records-right`, { method: "DELETE" }),

  uploadPassport: (recordId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return jsonFetch<{ record_id: string; fields: Record<string, string>; raw_response?: string }>(
      `${BASE}/upload/passport/${recordId}`,
      { method: "POST", body: fd }
    );
  },

  listRecords: () =>
    jsonFetch<{ records: ApplicantRecord[] }>(`${BASE}/records`),

  clearRecords: () =>
    jsonFetch<{ ok: boolean }>(`${BASE}/records`, { method: "DELETE" }),

  updateAvatar: (recordId: string, avatar: string) =>
    jsonFetch<{ ok: boolean; record_id: string }>(
      `${BASE}/records/${recordId}/avatar`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatar }),
      }
    ),

  updateRecordFields: (recordId: string, fields: Record<string, string>) =>
    jsonFetch<{ ok: boolean; record_id: string; updated: string[] }>(
      `${BASE}/records/${recordId}/fields`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      }
    ),

  /** LOOP 执行分析：AI 总结各卡片错误、高频错误字段与可能原因（LLM 未配置时后端返回本地统计摘要）
   *  mode=card：运行中单张问题卡片完成后的即时分析（实时追加），cards 只放 1 张 */
  loopAnalysis: (payload: {
    cards: Array<{
      name: string;
      overall: string;
      summary: string;
      mismatches: Array<{
        label: string;
        source_value: string;
        target_value: string;
        match: string;
        reasoning: string;
      }>;
      mrz_warnings: string[];
    }>;
    mode?: "batch" | "card";
    /** 整轮总用时（毫秒）：batch 模式下 AI 总结与本地兜底会包含总用时/平均用时 */
    duration_ms?: number;
  }) =>
    jsonFetch<{ text: string; source: "ai" | "local" }>(`${BASE}/verify/analysis/loop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),

  startVerify: (recordId: string, universityUrl?: string) =>
    jsonFetch<{ task_id: string; record_id: string }>(`${BASE}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ record_id: recordId, university_url: universityUrl || null }),
    }),

  getTask: (taskId: string) =>
    jsonFetch<VerificationResult>(`${BASE}/verify/${taskId}`),

  startConfigurableVerify: (config: WorkflowConfig) =>
    jsonFetch<{ task_id: string; record_id: string; mode: string }>(
      `${BASE}/verify/configurable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      }
    ),

  getReport: (taskId: string) =>
    jsonFetch<VerificationReport>(`${BASE}/verify/report/${taskId}`),

  downloadExcel: (taskId: string) => {
    const url = `${BASE}/verify/report/${taskId}/excel`;
    return apiFetch(url).then((resp) => {
      if (!resp.ok) throw new Error("下载失败");
      return resp.blob();
    });
  },

  /** 登记 Excel 本地路径（Electron webUtils.getPathForFile）：导出时可原地写回原文件 */
  setExcelSource: (side: "left" | "right", path: string, filename: string) =>
    jsonFetch<{ ok: boolean; mode: string }>(`${BASE}/upload/excel-source`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side, path, filename }),
    }),

  /** 导出 Excel：把内存中（修正后）的字段值写回文件；本地路径=原地写回，否则下载副本 */
  exportExcel: async (side: "left" | "right"): Promise<{ mode: "inplace" | "download"; path?: string; filename?: string; note?: string }> => {
    const resp = await apiFetch(`${BASE}/upload/excel-export?side=${side}`);
    return _parseExcelExportResp(resp);
  },

  /** 导出 Excel（带问题高亮）：运行结束后把字段对比状态一起传上，
   *  有问题的单元格在导出文件里填色——mismatch/error=红底深红字，missing/partial=琥珀 */
  exportExcelHighlighted: async (
    side: "left" | "right",
    highlights: Array<{ record_id: string; fields: Record<string, string> }>
  ): Promise<{ mode: "inplace" | "download"; path?: string; filename?: string; note?: string }> => {
    const resp = await apiFetch(`${BASE}/upload/excel-export-hl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side, highlights }),
    });
    return _parseExcelExportResp(resp);
  },

  continueManualStep: (taskId: string) =>
    jsonFetch<{ ok: boolean; task_id: string }>(
      `${BASE}/verify/${taskId}/continue`,
      { method: "POST" }
    ),

  // ========== 文档提取（功能1/2） ==========

  /** 上传本地文件（图片/PDF/Office）仅生成预览图（不跑 OCR，极快） */
  previewDocumentFile: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return jsonFetch<DocumentPreviewResult>(`${BASE}/document/preview`, {
      method: "POST",
      body: fd,
    }, docTimeout(file.name));
  },

  /** 上传本地文件（图片/PDF/Office）提取文字 + 字段；engine 可临时指定 "umi" 或 "vision"；forceAiOrient 强制 Vision 精判转正；forceViz 强制识图AI缺字段补提 */
  extractDocumentFile: (file: File, fields?: string[], engine?: string, forceAiOrient?: boolean, forceViz?: boolean) => {
    const fd = new FormData();
    fd.append("file", file);
    const clean = sanitizeTargetFields(fields);
    if (clean && clean.length > 0) fd.append("fields", clean.join(","));
    if (engine) fd.append("engine", engine);
    if (forceAiOrient) fd.append("force_ai_orient", "true");
    if (forceViz) fd.append("force_viz", "true");
    return jsonFetch<DocumentExtractResult>(`${BASE}/document/extract`, {
      method: "POST",
      body: fd,
    }, docTimeout(file.name)).then(notifyEngineFallback);
  },

  /** 框选区域文字识别：裁好的小图 → 纯 OCR → 单行文本（不过 LLM）；engine 可临时指定引擎 */
  ocrRegion: (file: File, engine?: string) => {
    const fd = new FormData();
    fd.append("file", file);
    if (engine) fd.append("engine", engine);
    return jsonFetch<{ text: string; raw_text: string; fallback?: { from: string; to: string; reason: string } | null }>(
      `${BASE}/document/ocr-region`,
      { method: "POST", body: fd },
      docTimeout(file.name),
    ).then(notifyEngineFallback);
  },

  /** 从网页 URL 下载 PDF/图片并提取文字 + 字段；engine 可临时指定 "umi" 或 "vision"；forceAiOrient 强制 Vision 精判转正；forceViz 强制识图AI缺字段补提 */
  extractDocumentUrl: (url: string, fields?: string[], filename?: string, engine?: string, forceAiOrient?: boolean, forceViz?: boolean) => {
    const clean = sanitizeTargetFields(fields);
    return jsonFetch<DocumentExtractResult>(`${BASE}/document/extract-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        filename: filename || null,
        fields: clean && clean.length > 0 ? clean.join(",") : null,
        engine: engine || null,
        force_ai_orient: forceAiOrient || false,
        force_viz: forceViz || false,
      }),
    }, docTimeout(filename)).then(notifyEngineFallback);
  },

  /** 文件格式转换 + 压缩到目标大小（文件处理面板「导出」用）；sourceUrl 为远端文件时后端先下载再转换 */
  convertDocument: (dataB64: string, filename: string, targetFormat: string, targetKb: number, sourceUrl?: string) =>
    jsonFetch<DocumentConvertResult>(`${BASE}/document/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data_b64: dataB64,
        filename,
        target_format: targetFormat,
        target_kb: targetKb,
        source_url: sourceUrl || null,
      }),
    }, docTimeout(filename)),

  // ========== 外挂插件（体外循环） ==========

  pluginStatus: () => jsonFetch<PluginStatus>(`${BASE}/plugin/status`),

  pluginRecords: () => jsonFetch<{ records: PluginRecord[] }>(`${BASE}/plugin/records`),

  pluginClearRecords: () =>
    jsonFetch<{ ok: boolean }>(`${BASE}/plugin/records`, { method: "DELETE" }),

  pluginStart: () =>
    jsonFetch<PluginStatus>(`${BASE}/plugin/start`, { method: "POST" }),

  pluginStop: () =>
    jsonFetch<PluginStatus>(`${BASE}/plugin/stop`, { method: "POST" }),

  // ========== LOOP 卡片分享（GitHub Gist）==========

  /** 创建 GitHub Gist 联网分享，返回短码 */
  createShare: (template: unknown) =>
    jsonFetch<{ ok: boolean; code?: string; id?: string; error?: string }>(
      `${BASE}/config/share/create`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template }),
      }
    ),

  /** 根据分享码获取 LOOP 卡片模板 */
  fetchShare: (code: string) =>
    jsonFetch<{ ok: boolean; template?: unknown; error?: string }>(
      `${BASE}/config/share/fetch?code=${encodeURIComponent(code)}`
    ),

  // ========== 幻灯片任务（PPT Section 拆并） ==========

  /** 检查 OfficeCLI 状态 */
  pptStatus: () =>
    jsonFetch<{ available: boolean; bin_path: string | null; version: string | null }>(
      `${BASE}/ppt/status`
    ),

  /** 导入本地 PPT 文件（支持目录扫描） */
  pptImportLocal: (filePaths: string[], directory?: string) =>
    jsonFetch<{ files: Array<{ file_path: string; file_name: string; size: number }>; count: number }>(
      `${BASE}/ppt/import-local`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_paths: filePaths, directory: directory || "" }),
      }
    ),

  /** 解析 PPT 幻灯片及文本节点 */
  pptAnalyze: (filePaths: string[]) =>
    jsonFetch<{ files: PPTFileSlides[] }>(`${BASE}/ppt/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_paths: filePaths }),
    }),

  /** AI 识别 section */
  pptDetectSections: (files: PPTFileSlides[], instruction?: string) =>
    jsonFetch<{ sections: PPTSection[]; readingScript: string }>(`${BASE}/ppt/detect-sections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files, instruction: instruction || "" }),
    }),

  /** 合并 section 为总览 PPT */
  pptMerge: (sections: PPTSection[]) =>
    jsonFetch<{ file_path: string; file_name: string; total_slides: number }>(`${BASE}/ppt/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sections }),
    }),

  /** AI 统一修改内容 */
  pptModify: (sections: PPTSection[], instruction: string) =>
    jsonFetch<{ patches: PPTTextPatch[]; count: number }>(`${BASE}/ppt/modify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sections, instruction }),
    }),

  /** 一键回填到原始 PPT */
  pptApply: (patches: PPTTextPatch[]) =>
    jsonFetch<{ applied: number; failed: number; errors: string[] }>(`${BASE}/ppt/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patches }),
    }),

  /** 根据文字生成一份新 PPT */
  pptCreateFromText: (text: string) =>
    jsonFetch<{ file_path: string; file_name: string; total_slides: number }>(
      `${BASE}/ppt/create-from-text`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }
    ),

  /** AI 仅生成 PPT 大纲（含 section/summary/bullets），不创建文件 */
  pptDraftOutline: (text: string) =>
    jsonFetch<{ style: string; slides: PPTOutlineSlide[] }>(`${BASE}/ppt/draft-outline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),

  /** SSE 流式生成大纲：逐 token 推送，完成后给出结构化 slides */
  pptDraftOutlineStream: async (
    text: string,
    onEvent: (ev:
      | { type: "token"; text: string }
      | { type: "done"; style: string; slides: PPTOutlineSlide[] }
      | { type: "error"; message: string }
    ) => void
  ): Promise<void> => {
    const resp = await apiFetch(`${BASE}/ppt/draft-outline-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`大纲生成失败: HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          if (ev.type === "done") {
            onEvent({ type: "done", style: ev.style, slides: ev.slides });
            return;
          }
          if (ev.type === "error") throw new Error(ev.message || "大纲生成失败");
          if (ev.type === "token") onEvent({ type: "token", text: ev.text });
        } catch (e) {
          if (e instanceof Error && e.message !== "Unexpected end of JSON input") throw e;
        }
      }
    }
  },

  /** SSE 流式按文字新建 PPT，逐条推送 AI 放置文字的过程；style 为参考风格（可选），slides 为用户确认的大纲（可选） */
  pptCreateFromTextStream: async (
    text: string,
    onEvent: (ev: PPTStreamEvent) => void,
    style?: PPTStyleProfile | null,
    slides?: PPTOutlineSlide[] | null,
    addBackground?: boolean
  ): Promise<{ file_path: string; file_name: string; total_slides: number } | void> => {
    const resp = await apiFetch(`${BASE}/ppt/create-from-text-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, style: style ?? null, slides: slides ?? null, add_background: addBackground ?? false }),
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`生成 PPT 失败: HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          if (ev.type === "done") return ev.result as { file_path: string; file_name: string; total_slides: number };
          if (ev.type === "error") throw new Error(ev.message || "生成失败");
          onEvent(ev as PPTStreamEvent);
        } catch (e) {
          if (e instanceof Error && e.message !== "Unexpected end of JSON input") throw e;
        }
      }
    }
    throw new Error("生成流意外结束");
  },

  /** SSE 流式解析 PPT，实时进度回调 */
  pptAnalyzeStream: async (
    filePaths: string[],
    onProgress: (ev: PPTProgressEvent) => void
  ): Promise<PPTFileSlides[]> => {
    const resp = await apiFetch(`${BASE}/ppt/analyze-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_paths: filePaths }),
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`解析失败: HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          if (ev.type === "done") return ev.files as PPTFileSlides[];
          if (ev.type === "error") throw new Error(ev.message || "解析失败");
          onProgress(ev as PPTProgressEvent);
        } catch (e) {
          if (e instanceof Error && e.message !== "Unexpected end of JSON input") throw e;
        }
      }
    }
    throw new Error("解析流意外结束");
  },

  /** 获取 PPT 任务使用的 AI 配置（与网页任务共用） */
  pptAiInfo: () =>
    jsonFetch<{ shared: boolean; provider: string; model: string; configured: boolean }>(
      `${BASE}/ppt/ai-info`
    ),

  /** 为 PPT 指定页生成截图，返回 base64 data URL */
  pptScreenshot: (filePath: string, page: number) =>
    jsonFetch<{ image_data: string; image_path: string }>(`${BASE}/ppt/screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_path: filePath, page }),
    }),

  /** 获取参考文件页数（PPT / PDF） */
  pptPageCount: (filePath: string) =>
    jsonFetch<{ page_count: number }>(`${BASE}/ppt/page-count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_path: filePath }),
    }),

  /** 列出全部预制教育风格 */
  pptStylePresets: () =>
    jsonFetch<{ presets: PPTStyleProfile[] }>(`${BASE}/ppt/style-presets`),

  /** 拆解参考 PPT 的视觉风格（截图 → 识图 AI → StyleProfile） */
  pptAnalyzeStyle: (filePath: string) =>
    jsonFetch<{ style: PPTStyleProfile }>(`${BASE}/ppt/analyze-style`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_path: filePath }),
    }),

  /** 获取某页全部元素（供拖拽编辑） */
  pptSlideElements: (filePath: string, slide: number) =>
    jsonFetch<{ slide: number; elements: PPTSlideElement[] }>(
      `${BASE}/ppt/slide-elements`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_path: filePath, slide }),
      }
    ),

  /** 批量更新某页元素属性（拖拽位置 / 改文字），返回最新截图 */
  pptUpdateElements: (
    filePath: string,
    slide: number,
    updates: { path: string; props: Record<string, string> }[]
  ) =>
    jsonFetch<{ applied: number; errors: string[]; image_data?: string }>(
      `${BASE}/ppt/update-elements`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_path: filePath, slide, updates }),
      }
    ),

  /** AI 指令只改某一页，返回最新截图 */
  pptRefineSlide: (filePath: string, slide: number, instruction: string) =>
    jsonFetch<{ applied: number; image_data: string }>(`${BASE}/ppt/refine-slide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_path: filePath, slide, instruction }),
    }),

  // ============ Cowork Studio ============

  /** 列出技能库 */
  coworkListSkills: () =>
    jsonFetch<{ skills: CoworkSkill[] }>(`${BASE}/cowork/skills`),

  /** 保存（新增/更新）技能 */
  coworkSaveSkill: (skill: Partial<CoworkSkill>) =>
    jsonFetch<{ skill: CoworkSkill }>(`${BASE}/cowork/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(skill),
    }),

  /** 删除技能 */
  coworkDeleteSkill: (id: string) =>
    jsonFetch<{ ok: boolean }>(`${BASE}/cowork/skills/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }),

  /** 检测本机编码客户端 */
  coworkDetectClients: () =>
    jsonFetch<{ clients: CoworkClient[] }>(`${BASE}/cowork/clients`),

  /** 设置/清除客户端可执行文件位置（path 为空恢复自动检测），返回最新客户端列表 */
  coworkSetClientPath: (clientId: string, path: string) =>
    jsonFetch<{ ok: boolean; clients: CoworkClient[] }>(`${BASE}/cowork/clients/path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, path }),
    }),

  /** 读取用户风格画像 */
  coworkGetProfile: () =>
    jsonFetch<{ profile: string }>(`${BASE}/cowork/profile`),

  /** 更新用户风格画像（append 非空则追加，否则整体覆盖） */
  coworkUpdateProfile: (text: string, append = false) =>
    jsonFetch<{ profile: string }>(`${BASE}/cowork/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(append ? { append: text } : { text }),
    }),

  /** SSE 派发任务，逐条推送品控进度 */
  coworkDispatch: async (
    params: {
      instruction: string;
      skill_ids: string[];
      client_ids: string[];
      max_rounds?: number;
      timeout?: number;
    },
    onEvent: (ev: CoworkDispatchEvent) => void
  ): Promise<void> => {
    const resp = await apiFetch(`${BASE}/cowork/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`派发失败: HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          if (ev.type === "error") throw new Error(ev.message || "任务失败");
          if (ev.type === "done") return;
          onEvent(ev as CoworkDispatchEvent);
        } catch (e) {
          if (e instanceof Error && e.message !== "Unexpected end of JSON input") throw e;
        }
      }
    }
  },

  /** 历史任务列表 */
  coworkListTasks: (limit = 20) =>
    jsonFetch<{ tasks: { id: string; mtime: number; has_final: boolean; final_preview: string }[] }>(
      `${BASE}/cowork/tasks?limit=${limit}`
    ),

  /** 任务详情 */
  coworkGetTask: (taskId: string) =>
    jsonFetch<{ id: string; dir: string; files: string[]; final: string }>(
      `${BASE}/cowork/tasks/${taskId}`
    ),

  // ============ 人工协作（看板 + 指定本地文件提取） ============

  /** 人工协作任务列表 */
  coworkHumanListTasks: () =>
    jsonFetch<{ tasks: HumanCoworkTask[] }>(`${BASE}/cowork/human/tasks`),

  /** 保存（新增/更新）人工协作任务 */
  coworkHumanSaveTask: (task: Partial<HumanCoworkTask>) =>
    jsonFetch<{ task: HumanCoworkTask }>(`${BASE}/cowork/human/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task),
    }),

  /** 删除人工协作任务 */
  coworkHumanDeleteTask: (id: string) =>
    jsonFetch<{ ok: boolean }>(`${BASE}/cowork/human/tasks/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }),

  /** 按任务里指定的本机文件路径执行提取，结果回填任务 */
  coworkHumanExtract: (taskId: string) =>
    jsonFetch<{ task: HumanCoworkTask }>(`${BASE}/cowork/human/tasks/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId }),
    }),

  // ============ 任务归档（一键导出 ZIP / 导入还原） ============

  /** 导出：全部卡片 + 进度 + 报告 + 图片 → ZIP 下载 */
  archiveExport: async (payload: ArchivePayload): Promise<void> => {
    const resp = await apiFetch(`${BASE}/archive/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      let msg = "导出失败";
      try { const j = await resp.json(); msg = j.detail || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const blob = await resp.blob();
    const cd = resp.headers.get("content-disposition") || "";
    const m = /filename=([^;]+)/.exec(cd);
    const filename = m ? decodeURIComponent(m[1].trim().replace(/^"|"$/g, "")) : "任务归档.zip";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  },

  /** 导入：上传 ZIP → 还原 payload（图片重新内联 base64） */
  archiveImport: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return jsonFetch<ArchivePayload>(`${BASE}/archive/import`, {
      method: "POST",
      body: fd,
    }, 120000);
  },

  // ============ HARNESS（双对象 Computer Use） ============

  /** 运行前自检：LLM 是否可用、CDP 是否连得上 */
  harnessStatus: () => jsonFetch<HarnessStatus>(`${BASE}/harness/status`),

  /** 可绑定的对象清单（网页页面 + Excel 数据源） */
  harnessTargets: () =>
    jsonFetch<{
      pages: HarnessPage[];
      all_pages: HarnessPage[];
      cdp_error: string;
      excel_sources: HarnessExcelSource[];
    }>(`${BASE}/harness/targets`),

  /** 绑定前预览 Excel 结构 */
  harnessInspectExcel: (path: string) =>
    jsonFetch<{ summary: { file: string; sheets: Array<{ name: string; headers: string[]; rows: number; cols: number }> } }>(
      `${BASE}/harness/excel/inspect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      },
      60000
    ),

  /**
   * 启动 HARNESS 任务并流式接收事件。
   * 返回 stop()：中止读取流（后端会在下一次决策边界感知到停止请求）。
   */
  harnessRun: async (
    params: {
      instruction: string;
      web?: { url: string; label?: string; exclude_urls?: string[] } | null;
      excel?: { path: string; label?: string } | null;
      max_steps?: number;
      vision?: boolean;
    },
    onEvent: (ev: HarnessEvent) => void
  ): Promise<{ taskId: string; abort: () => void }> => {
    const controller = new AbortController();
    const resp = await apiFetch(`${BASE}/harness/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    if (!resp.ok || !resp.body) {
      let msg = `启动失败: HTTP ${resp.status}`;
      try {
        const j = await resp.json();
        msg = j.detail || msg;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    let taskId = "";
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const pump = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          for (const part of parts) {
            const line = part.trim();
            if (!line || line.startsWith(":")) continue; // SSE 心跳
            if (!line.startsWith("data:")) continue;
            try {
              const ev = JSON.parse(line.slice(5).trim()) as HarnessEvent;
              if (ev.type === "accepted") taskId = ev.taskId;
              onEvent(ev);
            } catch (e) {
              if (!(e instanceof Error) || e.message !== "Unexpected end of JSON input") {
                console.warn("harness event parse error", e, line.slice(0, 200));
              }
            }
          }
        }
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          onEvent({ type: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();

    return {
      get taskId() {
        return taskId;
      },
      abort: () => {
        controller.abort();
        pump.catch(() => {});
      },
    } as { taskId: string; abort: () => void };
  },

  /** 回答 ask_user 提出的问题 */
  harnessAnswer: (taskId: string, answer: string) =>
    jsonFetch<{ ok: boolean }>(`${BASE}/harness/${taskId}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    }),

  /** 停止任务 */
  harnessStop: (taskId: string) =>
    jsonFetch<{ ok: boolean; message?: string }>(`${BASE}/harness/${taskId}/stop`, { method: "POST" }),

  /** 最近任务 */
  harnessTasks: (limit = 20) =>
    jsonFetch<{ tasks: Array<Record<string, unknown>> }>(`${BASE}/harness/tasks?limit=${limit}`),

  // ---------- 先出流程（可核对 / 可修改） ----------

  /** 让 HARNESS 先出流程：观察真实页面与表格结构后返回步骤清单（不执行） */
  harnessPlan: (params: {
    instruction: string;
    web?: { url: string; label?: string; exclude_urls?: string[] } | null;
    excel?: { path: string; label?: string } | null;
  }) =>
    jsonFetch<{ ok: boolean; plan: HarnessPlan }>(`${BASE}/harness/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }, 120000),

  /** 让 HARNESS 按意见改流程 */
  harnessPlanRevise: (params: {
    plan: HarnessPlan;
    request: string;
    instruction?: string;
    web?: { url: string; label?: string; exclude_urls?: string[] } | null;
    excel?: { path: string; label?: string } | null;
  }) =>
    jsonFetch<{ ok: boolean; plan: HarnessPlan }>(`${BASE}/harness/plan/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }, 120000),

  // ---------- 任务队列（桌面待执行卡片） ----------

  /** 安排一个任务：立刻变成一张待执行卡片，按顺序自动执行 */
  harnessEnqueue: (params: {
    instruction: string;
    web?: { url: string; label?: string; exclude_urls?: string[] } | null;
    excel?: { path: string; label?: string } | null;
    max_steps?: number;
    vision?: boolean;
    plan?: HarnessPlan | null;
  }) =>
    jsonFetch<{ ok: boolean; task: HarnessQueueTask }>(`${BASE}/harness/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }),

  /** 队列里的全部卡片 */
  harnessQueue: () => jsonFetch<{ tasks: HarnessQueueTask[] }>(`${BASE}/harness/queue`),

  /** 取消（排队中→直接作废；运行中→请求停止） */
  harnessQueueCancel: (id: string) =>
    jsonFetch<{ ok: boolean; status?: string; message?: string }>(
      `${BASE}/harness/queue/${id}/cancel`,
      { method: "POST" }
    ),

  /** 回答卡片上的追问 */
  harnessQueueAnswer: (id: string, answer: string) =>
    jsonFetch<{ ok: boolean; message?: string }>(`${BASE}/harness/queue/${id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    }),

  /** 从桌面移除卡片 */
  harnessQueueDiscard: (id: string) =>
    jsonFetch<{ ok: boolean; message?: string }>(`${BASE}/harness/queue/${id}`, { method: "DELETE" }),

  /** 清掉已结束的卡片 */
  harnessQueueClear: () =>
    jsonFetch<{ ok: boolean; removed: number }>(`${BASE}/harness/queue/clear`, { method: "POST" }),

  /** 让队列重新跑起来（应用重启后手工恢复） */
  harnessQueueResume: () =>
    jsonFetch<{ ok: boolean }>(`${BASE}/harness/queue/resume`, { method: "POST" }),
};

export type VerifyEvent =
  | { type: "step"; data: VerificationStep }
  | { type: "screenshot"; data: ScreenshotEvent }
  | { type: "done"; data: VerificationResult }
  | { type: "ping" }
  | { type: "error"; data: { message: string } };

export function subscribeTask(
  taskId: string,
  onEvent: (e: VerifyEvent) => void,
  onOpen?: () => void,
  onClose?: () => void
): WebSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const host = API_HOST ? "localhost:8000" : location.host;
  // WebSocket 的浏览器 API 不支持自定义请求头，令牌只能走查询串。
  // 后端 auth.extract_token 会依次看 X-CINSIDE-Token 与 ?token=。
  const token = apiToken();
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  const ws = new WebSocket(`${proto}://${host}/ws/verify/${taskId}${qs}`);
  ws.onopen = () => onOpen?.();
  ws.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data));
    } catch (e) {
      console.warn("ws parse error", e);
    }
  };
  ws.onclose = () => onClose?.();
  ws.onerror = () => onClose?.();
  return ws;
}
