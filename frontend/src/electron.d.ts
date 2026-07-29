export type ViewSide = "left" | "right";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 元素选择时拾取到的元素信息 */
export interface PickedElement {
  selector: string;
  label: string;
  value: string;
  tag: string;
  type: string;
  rect: { x: number; y: number; width: number; height: number };
  text: string;
}

/** 来自 BrowserView 内部的消息 */
export interface ViewMessage {
  side: ViewSide;
  payload:
    | { kind: "element-picked"; [k: string]: unknown }
    | { kind: string; [k: string]: unknown };
}

/** 高亮框定义 */
export interface HighlightBox {
  selector: string;
  status: "match" | "mismatch" | "missing" | "partial" | "pending" | "unknown";
  label?: string;
}

/** 更新信息 */
export interface UpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string;
}

/** 更新下载进度 */
export interface UpdateDownloadProgress {
  bytesPerSecond: number;
  percent: number;
  transferred: number;
  total: number;
}

export interface ElectronAPI {
  backendStatus: () => Promise<boolean>;
  onBackendReady: (callback: () => void) => void;
  openExternal: (url: string) => void;

  // === 自动更新 ===
  updateCheckNow: () => Promise<{ ok: boolean; message?: string; result?: unknown }>;
  updateDownloadUpdate: () => Promise<{ ok: boolean; message?: string }>;
  updateQuitAndInstall: () => Promise<{ ok: boolean }>;
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateNotAvailable: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => () => void;
  onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateError: (callback: (error: { message: string }) => void) => () => void;
  getAppVersion: () => Promise<string>;

  // === 无边框窗口控制 ===
  windowMinimize: () => void;
  windowMaximize: () => void;
  windowClose: () => void;
  windowIsMaximized: () => Promise<boolean>;

  // === 防误关：通知主进程是否启用 ===
  setPreventClose: (enabled: boolean) => void;
  // 真正退出应用（绕过防误关拦截）
  quitApp: () => void;

  // === 双 BrowserView 控制 ===
  viewLoad: (side: ViewSide, url: string) => Promise<void>;
  viewShow: (side: ViewSide, bounds?: Bounds, url?: string | null) => Promise<void>;
  viewHide: (side: ViewSide) => Promise<void>;
  viewHideAll: () => Promise<void>;
  viewSetZoom: (side: ViewSide, factor: number) => Promise<void>;

  viewExecuteJS: (side: ViewSide, script: string) => Promise<unknown>;
  viewInsertCSS: (side: ViewSide, css: string) => Promise<unknown>;

  // 元素选择模式
  viewStartPicking: (side: ViewSide) => Promise<unknown>;
  viewStopPicking: (side: ViewSide) => Promise<unknown>;

  // 高亮
  viewHighlightBoxes: (side: ViewSide, boxes: HighlightBox[]) => Promise<unknown>;
  viewClearHighlight: (side: ViewSide) => Promise<unknown>;

  // 截图指定 view 中的元素区域（用于头像提取）
  viewCaptureElement: (side: ViewSide, rect: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;

  // === 下载捕获（文件提取模式） ===
  setDownloadCapture: (side: ViewSide, enabled: boolean) => Promise<{ ok: boolean }>;
  onDownloadCaptured: (callback: (data: { side: string; filename: string; dataUrl: string; size: number; mime: string; path: string }) => void) => () => void;
  onDownloadFailed: (callback: (data: { side: string; filename: string; error?: string; state?: string }) => void) => () => void;

  // 接收 BrowserView 内部消息
  onViewMessage: (callback: (msg: ViewMessage) => void) => () => void;

  // === 面板脱离（拖拽到其他屏幕） ===
  panelDetach: (side: "left" | "bottom" | "browser-left" | "browser-right" | "browser-excel") => Promise<boolean>;
  panelBroadcastState: (side: "left" | "bottom" | "browser-left" | "browser-right" | "browser-excel", state: unknown) => void;
  panelSendAction: (action: string, payload?: unknown) => void;
  rendererLog: (msg: string) => void;
  onPanelState: (callback: (state: unknown) => void) => () => void;
  onPanelAction: (callback: (action: string, payload?: unknown) => void) => () => void;
  onPanelReattached: (callback: (side: string) => void) => () => void;
  onDetachedViewReady: (callback: (side: string) => void) => () => void;

  // === 脱离的浏览器面板视图控制 ===
  detachedViewShow: (side: string, bounds: Bounds, url?: string | null) => Promise<void>;
  detachedViewHide: (side: string) => Promise<void>;
  detachedViewLoad: (side: string, url: string) => Promise<void>;
  detachedViewExecuteJS: (side: string, script: string) => Promise<unknown>;
  detachedViewStartPicking: (side: string) => Promise<unknown>;
  detachedViewStopPicking: (side: string) => Promise<unknown>;
  detachedViewHighlightBoxes: (side: string, boxes: HighlightBox[]) => Promise<unknown>;
  detachedViewClearHighlight: (side: string) => Promise<unknown>;
  detachedViewInsertCSS: (side: string, css: string) => Promise<unknown>;

  // === 兼容旧 API（指向 right view） ===
  loadBrowserViewUrl: (url: string) => Promise<void>;
  showBrowserView: (bounds: Bounds, url: string) => Promise<void>;
  hideBrowserView: () => Promise<void>;
  resizeBrowserView: (bounds: Bounds) => Promise<void>;

  // === 弹窗（window.open 拦截）控制 ===
  popupClose: (side: ViewSide) => Promise<void>;
  popupStartPicking: (side: ViewSide) => Promise<unknown>;
  popupStopPicking: (side: ViewSide) => Promise<unknown>;
  popupHighlightBoxes: (side: ViewSide, boxes: HighlightBox[]) => Promise<unknown>;
  popupClearHighlight: (side: ViewSide) => Promise<unknown>;
  popupExecuteJS: (side: ViewSide, script: string) => Promise<unknown>;
  onPopupCreated: (callback: (data: { parentSide: ViewSide; url: string }) => void) => () => void;
  onPopupClosed: (callback: (data: { parentSide: ViewSide }) => void) => () => void;

  // === 外挂插件：屏幕边缘悬浮条 ===
  dockToggle: () => Promise<{ open: boolean }>;
  dockIsOpen: () => Promise<boolean>;
  pluginApi: (path: string, method?: string, body?: unknown) => Promise<{ ok: boolean; status: number; data: unknown }>;
  onDockState: (callback: (data: { open: boolean }) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
