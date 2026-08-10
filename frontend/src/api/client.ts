import type {
  AppConfig,
  AppSettings,
  ApplicantRecord,
  DepsStatus,
  DocumentConvertResult,
  DocumentExtractResult,
  DocumentPreviewResult,
  PPTFileSlides,
  PPTProgressEvent,
  PPTSection,
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

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
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
}

export const api = {
  getConfig: () => jsonFetch<AppConfig>(`${BASE}/config`),

  getSettings: () => jsonFetch<AppSettings>(`${BASE}/config/settings`),

  saveSettings: (settings: AppSettings) =>
    jsonFetch<{ ok: boolean }>(`${BASE}/config/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    }),

  testVision: () =>
    jsonFetch<{ supports_images: boolean; message: string }>(`${BASE}/config/test-vision`, {
      method: "POST",
    }),

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
    jsonFetch<{ ok: boolean; message: string }>(`${BASE}/config/install-python-deps`, {
      method: "POST",
    }),
  downloadUmiOcr: () =>
    jsonFetch<{ ok: boolean; message: string; exe_path: string }>(`${BASE}/config/download-umi-ocr`, {
      method: "POST",
    }),
  installRemotion: () =>
    jsonFetch<{ ok: boolean; message: string }>(`${BASE}/config/install-remotion`, {
      method: "POST",
    }),
  installOfficecli: () =>
    jsonFetch<{ ok: boolean; message: string }>(`${BASE}/config/install-officecli`, {
      method: "POST",
    }),

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
