import type {
  AppConfig,
  AppSettings,
  ApplicantRecord,
  CoworkClient,
  CoworkDispatchEvent,
  CoworkSkill,
  DepsStatus,
  DocumentConvertResult,
  DocumentExtractResult,
  DocumentPreviewResult,
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

async function jsonFetch<T>(url: string, init?: RequestInit, timeoutMs = 30000): Promise<T> {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
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

export const api = {
  getConfig: () => jsonFetch<AppConfig>(`${BASE}/config`),

  getSettings: () => jsonFetch<AppSettings>(`${BASE}/config/settings`, undefined, 10000),

  saveSettings: (settings: AppSettings) =>
    jsonFetch<{ ok: boolean }>(
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

  testUmiOcr: () =>
    jsonFetch<{ ok: boolean; message: string; host: string; port: number }>(`${BASE}/config/test-umi-ocr`, {
      method: "POST",
    }),
  launchUmiOcr: () =>
    jsonFetch<{ ok: boolean; message: string; exe_path: string }>(`${BASE}/config/launch-umi-ocr`, {
      method: "POST",
    }),
  browseUmiOcr: () =>
    jsonFetch<{ ok: boolean; message: string; path: string }>(`${BASE}/config/browse-umi-ocr`, {
      method: "POST",
    }),
  testMarkitdown: () =>
    jsonFetch<{ ok: boolean; message: string }>(`${BASE}/config/test-markitdown`, {
      method: "POST",
    }),

  // ===== 依赖与工具管理 =====
  getDepsStatus: () =>
    jsonFetch<DepsStatus>(`${BASE}/config/deps-status`),
  installPythonDeps: () =>
    jsonFetch<{ ok: boolean; message: string }>(
      `${BASE}/config/install-python-deps`,
      { method: "POST" },
      300000
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
      { method: "POST", body: fd }
    );
  },

  uploadExcelRight: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return jsonFetch<{ count: number; records: ApplicantRecord[]; detected_column_map: Record<string, string> }>(
      `${BASE}/upload/excel-right`,
      { method: "POST", body: fd }
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

  /** LOOP 执行分析：AI 总结各卡片错误、高频错误字段与可能原因（LLM 未配置时后端返回本地统计摘要） */
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
    return fetch(url).then((resp) => {
      if (!resp.ok) throw new Error("下载失败");
      return resp.blob();
    });
  },

  /** 登记 Excel 本地路径（Electron File.path）：导出时可原地写回原文件 */
  setExcelSource: (side: "left" | "right", path: string, filename: string) =>
    jsonFetch<{ ok: boolean; mode: string }>(`${BASE}/upload/excel-source`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side, path, filename }),
    }),

  /** 导出 Excel：把内存中（修正后）的字段值写回文件；本地路径=原地写回，否则下载副本 */
  exportExcel: async (side: "left" | "right"): Promise<{ mode: "inplace" | "download"; path?: string; filename?: string }> => {
    const resp = await fetch(`${BASE}/upload/excel-export?side=${side}`);
    if (!resp.ok) {
      let msg = "导出失败";
      try { const j = await resp.json(); msg = j.detail || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j = await resp.json();
      return { mode: "inplace", path: j.path };
    }
    const blob = await resp.blob();
    const cd = resp.headers.get("content-disposition") || "";
    const m = /filename=([^;]+)/.exec(cd);
    const filename = m ? m[1].trim().replace(/^"|"$/g, "") : "data_updated.xlsx";
    return { mode: "download", filename, path: URL.createObjectURL(blob) };
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
    });
  },

  /** 上传本地文件（图片/PDF/Office）提取文字 + 字段；engine 可临时指定 "umi" 或 "vision" */
  extractDocumentFile: (file: File, fields?: string[], engine?: string) => {
    const fd = new FormData();
    fd.append("file", file);
    if (fields && fields.length > 0) fd.append("fields", fields.join(","));
    if (engine) fd.append("engine", engine);
    return jsonFetch<DocumentExtractResult>(`${BASE}/document/extract`, {
      method: "POST",
      body: fd,
    });
  },

  /** 从网页 URL 下载 PDF/图片并提取文字 + 字段；engine 可临时指定 "umi" 或 "vision" */
  extractDocumentUrl: (url: string, fields?: string[], filename?: string, engine?: string) =>
    jsonFetch<DocumentExtractResult>(`${BASE}/document/extract-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        filename: filename || null,
        fields: fields && fields.length > 0 ? fields.join(",") : null,
        engine: engine || null,
      }),
    }),

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
    }),

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
    const resp = await fetch(`${BASE}/ppt/draft-outline-stream`, {
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
    const resp = await fetch(`${BASE}/ppt/create-from-text-stream`, {
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
    const resp = await fetch(`${BASE}/ppt/analyze-stream`, {
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
    const resp = await fetch(`${BASE}/cowork/dispatch`, {
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
  const ws = new WebSocket(`${proto}://${host}/ws/verify/${taskId}`);
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
