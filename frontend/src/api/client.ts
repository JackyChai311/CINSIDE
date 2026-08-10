import type {
  AppConfig,
  AppSettings,
  ApplicantRecord,
  DepsStatus,
  DocumentConvertResult,
  DocumentExtractResult,
  DocumentPreviewResult,
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
