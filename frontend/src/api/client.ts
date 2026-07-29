import type {
  AppConfig,
  AppSettings,
  ApplicantRecord,
  DocumentExtractResult,
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
    let msg = `${resp.status}`;
    try {
      const j = await resp.json();
      msg = j.detail || j.message || JSON.stringify(j);
    } catch {
      msg = await resp.text();
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

  uploadExcel: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return jsonFetch<{ count: number; records: ApplicantRecord[] }>(
      `${BASE}/upload/excel`,
      { method: "POST", body: fd }
    );
  },

  uploadExcelRight: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return jsonFetch<{ count: number; records: ApplicantRecord[] }>(
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

  /** 上传本地文件（图片/PDF/Office）提取文字 + 字段 */
  extractDocumentFile: (file: File, fields?: string[]) => {
    const fd = new FormData();
    fd.append("file", file);
    if (fields && fields.length > 0) fd.append("fields", fields.join(","));
    return jsonFetch<DocumentExtractResult>(`${BASE}/document/extract`, {
      method: "POST",
      body: fd,
    });
  },

  /** 从网页 URL 下载 PDF/图片并提取文字 + 字段 */
  extractDocumentUrl: (url: string, fields?: string[], filename?: string) =>
    jsonFetch<DocumentExtractResult>(`${BASE}/document/extract-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        filename: filename || null,
        fields: fields && fields.length > 0 ? fields.join(",") : null,
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
